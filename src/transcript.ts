import { asRecord, extractUsage, mergeUsage, stringField } from "./status-input.js";
import { cacheReadSharePoint, updateCacheReadShareSummary } from "./cache-efficiency.js";
import { buildEditLedger, type LedgerEvent } from "./edit-ledger.js";
import { extractFailureEpisodesFromTranscriptLines, summarizeBlindRetry } from "./failure-episodes.js";
import { fileBasenameFromToolInput, fileIdentityFromToolInput, isFullFileReadInput } from "./file-identity.js";
import { sessionKeyFromId } from "./session.js";
import { classifyResultPurpose, classifyToolIdentity, isPermissionDeclineResult } from "./tool-metadata.js";
import { readTranscriptTail, type ReadTranscriptTailOptions } from "./transcript-reader.js";
import type { ProjectConfig } from "./project-config.js";
import type {
  ActiveFullFileReadSummary,
  ActivityKind,
  CacheReadShareSummary,
  InputTokenJumpSummary,
  RedundantReadSummary,
  ToolFailureSummary,
  TokenUsage,
  TranscriptSummary
} from "./types.js";

export const TOOL_RESULT_EXPLOSION_THRESHOLD_TOKENS = 8_000;

export type ParseTranscriptOptions = ReadTranscriptTailOptions & {
  projectConfig?: ProjectConfig;
};

interface ToolMeta {
  name: string;
  purpose?: string;
  category?: "MCP";
  identityHash?: string;
  fileIdentityHash?: string;
  basename?: string;
  isEdit: boolean;
  isReadSearch: boolean;
}

interface FileReadState {
  count: number;
  lastSeenToolCall: number;
  basename?: string;
}

export async function parseTranscriptTail(
  transcriptPath: string | undefined,
  options: ParseTranscriptOptions = {}
): Promise<TranscriptSummary> {
  const tail = await readTranscriptTail(transcriptPath, options);
  if (!tail.pathReadable) {
    return emptySummary(false);
  }
  return parseTranscriptLines(tail.lines, tail.bytesRead, { projectConfig: options.projectConfig, tailTruncated: tail.tailTruncated });
}

export function parseTranscriptLines(
  lines: string[],
  bytesRead = Buffer.byteLength(lines.join("\n")),
  options: { projectConfig?: ProjectConfig; tailTruncated?: boolean } = {}
): TranscriptSummary {
  const failureEpisodes = extractFailureEpisodesFromTranscriptLines(lines, { projectConfig: options.projectConfig });
  const blindRetry = summarizeBlindRetry(failureEpisodes);
  const toolById = new Map<string, ToolMeta>();
  const failureCounts = new Map<string, ToolFailureSummary>();
  let recentEditBeforeTest = false;
  let hasUnvalidatedEdits = false;
  let unvalidatedEditStep: number | undefined;
  let validationFailedSinceSuccess = false;
  let validationRecovered = false;
  let editTestLoopFailures = 0;
  let toolResultStep = 0;
  let parseableLines = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  const transcriptSessionKeys = new Set<string>();
  let toolCalls = 0;
  let readToolCalls = 0;
  let successfulEditResults = 0;
  let failedEditResults = 0;
  let unvalidatedEditResultCount = 0;
  let workContinuedAfterFailedEdit = false;
  let latestFailedEditResultStep: number | undefined;
  let validationChecks = 0;
  let validationSuccesses = 0;
  let toolRecoveryEvents = 0;
  let failedToolResults = 0;
  let malformedLines = 0;
  let compactionEvents = 0;
  let postCompactionActivity = 0;
  let usage: TokenUsage = {};
  let latestUsage: TokenUsage | undefined;
  let latestUsageTimestamp: string | undefined;
  let cacheReadShare: CacheReadShareSummary | undefined;
  let latestTimestamp: string | undefined;
  let latestCompactionTimestamp: string | undefined;
  let terminalEvents = 0;
  let latestTerminalEvent: "stop" | "session_end" | undefined;
  let latestTerminalTimestamp: string | undefined;
  let previousAssistantInputTokens: number | undefined;
  let toolResultsSincePreviousAssistantUsage = 0;
  let resetBoundarySincePreviousAssistantUsage = false;
  let latestInputTokenJump: InputTokenJumpSummary | undefined;
  let largestInputTokenJump: InputTokenJumpSummary | undefined;
  const fullFileReadCounts = new Map<string, FileReadState>();
  let redundantRead: RedundantReadSummary | undefined;
  const changedFileIdentityHashes = new Set<string>();
  const unvalidatedChangedFileIdentityHashes = new Set<string>();
  const ledgerEvents: LedgerEvent[] = [];
  let latestActivityKind: ActivityKind | undefined;

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformedLines += 1;
      continue;
    }

    const entry = asRecord(parsed);
    if (!entry) {
      malformedLines += 1;
      continue;
    }

    parseableLines += 1;
    const entryTimestamp = stringField(entry.timestamp);
    latestTimestamp = entryTimestamp || latestTimestamp;
    const entrySessionKey = sessionKeyFromId(stringField(entry.sessionId) || stringField(entry.session_id));
    if (entrySessionKey) {
      transcriptSessionKeys.add(entrySessionKey);
    }
    const message = asRecord(entry.message);
    const role = stringField(message?.role) || stringField(entry.role) || stringField(entry.type);
    if (role === "user") {
      userMessages += 1;
    } else if (role === "assistant") {
      assistantMessages += 1;
    }
    const entryUsage = mergeUsage(extractUsage(entry), extractUsage(asRecord(entry.message)));
    usage = mergeUsage(usage, entryUsage);
    if (hasUsage(entryUsage)) {
      latestUsage = entryUsage;
      latestUsageTimestamp = entryTimestamp || latestUsageTimestamp;
    }
    const cacheReadPoint = cacheReadSharePoint(entryUsage, entryTimestamp);
    if (cacheReadPoint) {
      cacheReadShare = updateCacheReadShareSummary(cacheReadShare, cacheReadPoint);
    }
    const toolUses = extractToolUses(entry);
    const toolResults = extractToolResults(entry);

    if (isCompactionEvent(entry)) {
      compactionEvents += 1;
      postCompactionActivity = 0;
      latestCompactionTimestamp = entryTimestamp || latestCompactionTimestamp;
      resetBoundarySincePreviousAssistantUsage = true;
    } else if (compactionEvents > 0 && isPostCompactionActivity(entry, toolUses, toolResults)) {
      postCompactionActivity += 1;
    }
    const terminalEvent = terminalEventKind(entry);
    if (terminalEvent) {
      terminalEvents += 1;
      latestTerminalEvent = terminalEvent;
      latestTerminalTimestamp = entryTimestamp || latestTerminalTimestamp;
    }

    const assistantInputTokens = assistantMessageInputTokens(entry);
    if (assistantInputTokens !== undefined) {
      const jump = inputTokenJumpSummary({
        previousInputTokens: previousAssistantInputTokens,
        currentInputTokens: assistantInputTokens,
        toolResultCount: toolResultsSincePreviousAssistantUsage,
        resetBoundary: resetBoundarySincePreviousAssistantUsage,
        timestamp: entryTimestamp
      });
      if (jump) {
        latestInputTokenJump = jump;
        if (!largestInputTokenJump || jump.inputTokenDelta >= largestInputTokenJump.inputTokenDelta) {
          largestInputTokenJump = jump;
        }
      }
      previousAssistantInputTokens = assistantInputTokens;
      toolResultsSincePreviousAssistantUsage = 0;
      resetBoundarySincePreviousAssistantUsage = false;
    }

    for (const toolUse of toolUses) {
      if (latestFailedEditResultStep !== undefined) {
        workContinuedAfterFailedEdit = true;
      }
      toolCalls += 1;
      const identity = classifyToolIdentity(toolUse.name, toolUse.input, { basenameOnly: true, projectConfig: options.projectConfig });
      if (identity.isReadSearch) {
        readToolCalls += 1;
      }
      const fileIdentity = fileIdentityFromToolInput(identity.displayName, toolUse.input);
      if (identity.displayName === "Read" && fileIdentity && isFullFileReadInput(toolUse.input)) {
        const existing = fullFileReadCounts.get(fileIdentity.fileIdentityHash);
        fullFileReadCounts.set(fileIdentity.fileIdentityHash, {
          count: (existing?.count || 0) + 1,
          lastSeenToolCall: toolCalls,
          // Basename is display-safe (privacy: never a path); it rides the redundant-read summary
          // so the gauge can name the file at full width ("reread auth.ts 3x").
          basename: existing?.basename || fileBasenameFromToolInput(identity.displayName, toolUse.input)
        });
        redundantRead = strongestActiveRedundantRead(fullFileReadCounts);
      }
      const basename = identity.isEdit ? fileBasenameFromToolInput(identity.displayName, toolUse.input) : undefined;
      if (toolUse.id) {
        toolById.set(toolUse.id, {
          name: identity.displayName,
          purpose: identity.purpose,
          category: identity.category,
          identityHash: identity.identityHash,
          fileIdentityHash: fileIdentity?.fileIdentityHash,
          basename,
          isEdit: identity.isEdit,
          isReadSearch: identity.isReadSearch
        });
      }
      if (identity.isEdit) {
        recentEditBeforeTest = true;
      }
      latestActivityKind = activityKindFromIdentity(identity);
    }

    for (const toolResult of toolResults) {
      toolResultsSincePreviousAssistantUsage += 1;
      toolResultStep += 1;
      if (toolResult.declined) {
        // A permission-gate decline is the user's choice, not a tool failure or success: it must
        // not feed failure counts, validation checks, the edit-test loop, or recovery.
        continue;
      }
      const meta =
        (toolResult.toolUseId ? toolById.get(toolResult.toolUseId) : undefined) ||
        (toolResult.toolName
          ? metaFromToolName(toolResult.toolName, options.projectConfig)
          : undefined) ||
        { name: "tool", purpose: undefined, isEdit: false, isReadSearch: false };
      const purpose = meta.name === "Bash" ? toolResult.purpose || meta.purpose : meta.purpose;
      const key = failureKey(meta, purpose);
      const isValidation = meta.name === "Bash" && isValidationPurpose(purpose);
      if (isValidation) {
        validationChecks += 1;
      }
      if (!toolResult.isError) {
        if (failureCounts.has(key)) {
          toolRecoveryEvents += 1;
        }
        failureCounts.delete(key);
        if (meta.isEdit) {
          successfulEditResults += 1;
          unvalidatedEditResultCount += 1;
          if (meta.fileIdentityHash) {
            changedFileIdentityHashes.add(meta.fileIdentityHash);
            unvalidatedChangedFileIdentityHashes.add(meta.fileIdentityHash);
          }
          ledgerEvents.push({ kind: "edit", identityHash: meta.fileIdentityHash, basename: meta.basename });
          hasUnvalidatedEdits = true;
          unvalidatedEditStep = toolResultStep;
          if (meta.fileIdentityHash) {
            fullFileReadCounts.delete(meta.fileIdentityHash);
            redundantRead = strongestActiveRedundantRead(fullFileReadCounts);
          }
        } else if (isValidation) {
          validationSuccesses += 1;
          if (validationFailedSinceSuccess) {
            validationRecovered = true;
          }
          validationFailedSinceSuccess = false;
          editTestLoopFailures = 0;
          recentEditBeforeTest = false;
          hasUnvalidatedEdits = false;
          unvalidatedEditStep = undefined;
          unvalidatedEditResultCount = 0;
          unvalidatedChangedFileIdentityHashes.clear();
          ledgerEvents.push({ kind: "validation_pass" });
        }
        continue;
      }
      if (latestFailedEditResultStep !== undefined && toolResultStep > latestFailedEditResultStep) {
        workContinuedAfterFailedEdit = true;
      }
      failedToolResults += 1;
      if (meta.isEdit) {
        failedEditResults += 1;
        latestFailedEditResultStep = toolResultStep;
      }
      const existing = failureCounts.get(key);
      failureCounts.set(key, failureSummary(meta, purpose, (existing?.count || 0) + 1));
      if (meta.name === "Bash" && purpose === "tests" && recentEditBeforeTest) {
        editTestLoopFailures += 1;
        recentEditBeforeTest = false;
      }
      if (isValidation) {
        validationFailedSinceSuccess = true;
      }
    }
  }

  return {
    pathReadable: true,
    bytesRead,
    tailTruncated: Boolean(options.tailTruncated),
    linesRead: lines.length,
    malformedLines,
    parseableLines,
    userMessages,
    assistantMessages,
    transcriptHasSessionIds: transcriptSessionKeys.size > 0,
    transcriptSessionKeys: [...transcriptSessionKeys],
    transcriptSessionKeyCount: transcriptSessionKeys.size,
    toolCalls,
    readToolCalls,
    successfulEditResults,
    failedEditResults,
    unvalidatedEditResultCount,
    changedFileIdentityCount: changedFileIdentityHashes.size,
    unvalidatedChangedFileIdentityCount: unvalidatedChangedFileIdentityHashes.size,
    workContinuedAfterFailedEdit,
    validationChecks,
    validationSuccesses,
    toolRecoveryEvents,
    failedToolResults,
    repeatedFailures: [...failureCounts.values()].filter((item) => item.count >= 2),
    failureEpisodes,
    blindRetry,
    editTestLoopFailures,
    hasUnvalidatedEdits,
    unvalidatedEditToolSteps:
      hasUnvalidatedEdits && unvalidatedEditStep !== undefined ? toolResultStep - unvalidatedEditStep : undefined,
    validationRecovered,
    observedProgress: validationSuccesses > 0 || toolRecoveryEvents > 0,
    compactionEvents,
    postCompactionActivity,
    usage,
    latestUsage,
    latestUsageTimestamp,
    cacheReadShare,
    latestTimestamp,
    terminalEvents,
    latestTerminalEvent,
    latestTerminalTimestamp,
    latestCompactionTimestamp,
    redundantRead,
    activeFullFileReads: activeFullFileReadSummaries(fullFileReadCounts),
    latestInputTokenJump,
    largestInputTokenJump,
    ledger: buildEditLedger(ledgerEvents),
    latestActivityKind
  };
}

function activityKindFromIdentity(identity: {
  isEdit: boolean;
  isReadSearch: boolean;
  category?: "MCP";
  displayName: string;
  purpose?: string;
}): ActivityKind {
  if (identity.category === "MCP") {
    return "mcp";
  }
  if (identity.isEdit) {
    return "edit";
  }
  if (identity.displayName === "Bash" && isValidationPurpose(identity.purpose)) {
    return "validate";
  }
  if (identity.isReadSearch || identity.purpose === "read") {
    return "read";
  }
  if (identity.displayName === "Bash") {
    return "exec";
  }
  return "other";
}

function emptySummary(pathReadable: boolean): TranscriptSummary {
  return {
    pathReadable,
    bytesRead: 0,
    tailTruncated: false,
    linesRead: 0,
    malformedLines: 0,
    parseableLines: 0,
    userMessages: 0,
    assistantMessages: 0,
    transcriptHasSessionIds: false,
    transcriptSessionKeys: [],
    transcriptSessionKeyCount: 0,
    toolCalls: 0,
    readToolCalls: 0,
    successfulEditResults: 0,
    failedEditResults: 0,
    unvalidatedEditResultCount: 0,
    changedFileIdentityCount: 0,
    unvalidatedChangedFileIdentityCount: 0,
    workContinuedAfterFailedEdit: false,
    validationChecks: 0,
    validationSuccesses: 0,
    toolRecoveryEvents: 0,
    failedToolResults: 0,
    repeatedFailures: [],
    editTestLoopFailures: 0,
    hasUnvalidatedEdits: false,
    validationRecovered: false,
    observedProgress: false,
    compactionEvents: 0,
    postCompactionActivity: 0,
    usage: {}
  };
}

function isValidationPurpose(purpose: string | undefined): boolean {
  return purpose === "tests" || purpose === "lint" || purpose === "typecheck" || purpose === "build";
}

function metaFromToolName(toolName: string, projectConfig: ProjectConfig | undefined): ToolMeta {
  const identity = classifyToolIdentity(toolName, undefined, { basenameOnly: true, projectConfig });
  return {
    name: identity.displayName,
    purpose: identity.purpose,
    category: identity.category,
    identityHash: identity.identityHash,
    fileIdentityHash: undefined,
    isEdit: identity.isEdit,
    isReadSearch: identity.isReadSearch
  };
}

function failureKey(meta: Pick<ToolMeta, "name" | "purpose" | "category" | "identityHash">, purpose = meta.purpose): string {
  return meta.category === "MCP" && meta.identityHash ? `MCP:${meta.identityHash}` : `${meta.name}:${purpose || ""}`;
}

function failureSummary(meta: ToolMeta, purpose: string | undefined, count: number): ToolFailureSummary {
  const summary: ToolFailureSummary = {
    toolName: meta.name,
    count
  };
  if (purpose) {
    summary.purpose = purpose;
  }
  if (meta.category) {
    summary.category = meta.category;
  }
  if (meta.identityHash) {
    summary.identityHash = meta.identityHash;
  }
  return summary;
}

function strongestActiveRedundantRead(readCounts: Map<string, FileReadState>): RedundantReadSummary | undefined {
  let strongest: RedundantReadSummary | undefined;
  let strongestLastSeen = -1;
  for (const [fileIdentityHash, state] of readCounts) {
    if (state.count < 2) {
      continue;
    }
    if (
      !strongest ||
      state.count > strongest.unchangedFullFileReadCount ||
      (state.count === strongest.unchangedFullFileReadCount && state.lastSeenToolCall >= strongestLastSeen)
    ) {
      strongest = {
        fileIdentityHash,
        unchangedFullFileReadCount: state.count,
        latestState: state.count >= 3 ? "Stop" : "Careful",
        basename: state.basename
      };
      strongestLastSeen = state.lastSeenToolCall;
    }
  }
  return strongest;
}

function activeFullFileReadSummaries(readCounts: Map<string, FileReadState>): ActiveFullFileReadSummary[] {
  return [...readCounts.entries()].map(([fileIdentityHash, state]) => ({
    fileIdentityHash,
    unchangedFullFileReadCount: state.count
  }));
}

function hasUsage(usage: TokenUsage): boolean {
  return (
    usage.inputTokens !== undefined ||
    usage.outputTokens !== undefined ||
    usage.cacheCreationInputTokens !== undefined ||
    usage.cacheReadInputTokens !== undefined ||
    usage.totalTokens !== undefined
  );
}

function assistantMessageInputTokens(entry: Record<string, unknown>): number | undefined {
  const message = asRecord(entry.message);
  const role = stringField(message?.role) || stringField(entry.role) || stringField(entry.type);
  if (role !== "assistant") {
    return undefined;
  }
  return extractUsage(message).inputTokens;
}

function inputTokenJumpSummary(args: {
  previousInputTokens: number | undefined;
  currentInputTokens: number;
  toolResultCount: number;
  resetBoundary: boolean;
  timestamp?: string;
}): InputTokenJumpSummary | undefined {
  if (args.previousInputTokens === undefined || args.resetBoundary) {
    return undefined;
  }
  const inputTokenDelta = args.currentInputTokens - args.previousInputTokens;
  if (inputTokenDelta <= 0) {
    return undefined;
  }
  return {
    previousInputTokens: args.previousInputTokens,
    currentInputTokens: args.currentInputTokens,
    inputTokenDelta,
    toolResultCount: args.toolResultCount,
    thresholdTokens: TOOL_RESULT_EXPLOSION_THRESHOLD_TOKENS,
    crossedThreshold: inputTokenDelta >= TOOL_RESULT_EXPLOSION_THRESHOLD_TOKENS,
    timestamp: args.timestamp
  };
}

function extractToolUses(entry: Record<string, unknown>): Array<{ id?: string; name: string; input?: unknown }> {
  const result: Array<{ id?: string; name: string; input?: unknown }> = [];
  for (const part of contentParts(entry)) {
    if (part.type === "tool_use") {
      const name = stringField(part.name);
      if (name) {
        result.push({ id: stringField(part.id), name, input: part.input });
      }
    }
  }

  const toolUse = asRecord(entry.tool_use) || asRecord(entry.toolUse);
  const directName = stringField(toolUse?.name) || stringField(entry.tool_name) || stringField(entry.toolName);
  if (directName && (entry.type === "tool_use" || toolUse)) {
    result.push({ id: stringField(toolUse?.id) || stringField(entry.tool_use_id), name: directName, input: toolUse?.input });
  }
  return result;
}

function extractToolResults(entry: Record<string, unknown>): Array<{
  toolUseId?: string;
  toolName?: string;
  isError: boolean;
  declined: boolean;
  purpose?: string;
}> {
  const result: Array<{ toolUseId?: string; toolName?: string; isError: boolean; declined: boolean; purpose?: string }> = [];
  for (const part of contentParts(entry)) {
    if (part.type === "tool_result") {
      result.push({
        toolUseId: stringField(part.tool_use_id) || stringField(part.toolUseId),
        toolName: stringField(part.name) || stringField(part.tool_name),
        isError: truthyError(part),
        declined: isPermissionDeclineResult(part),
        purpose: classifyResultPurpose(part)
      });
    }
  }

  if (entry.type === "tool_result" || entry.type === "tool_result_delta") {
    result.push({
      toolUseId: stringField(entry.tool_use_id) || stringField(entry.toolUseId),
      toolName: stringField(entry.name) || stringField(entry.tool_name) || stringField(entry.toolName),
      isError: truthyError(entry),
      declined: isPermissionDeclineResult(entry),
      purpose: classifyResultPurpose(entry)
    });
  }
  return result;
}

function contentParts(entry: Record<string, unknown>): Record<string, unknown>[] {
  const message = asRecord(entry.message);
  const candidates = [entry.content, message?.content];
  const parts: Record<string, unknown>[] = [];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      parts.push(...candidate.flatMap((part) => (asRecord(part) ? [asRecord(part)!] : [])));
    } else if (asRecord(candidate)) {
      parts.push(asRecord(candidate)!);
    }
  }
  return parts;
}

function truthyError(value: Record<string, unknown>): boolean {
  if (value.is_error === true || value.isError === true || value.error === true) {
    return true;
  }
  const status = stringField(value.status) || stringField(value.result);
  if (status && /error|failed|failure/i.test(status)) {
    return true;
  }
  const exitCode = value.exit_code ?? value.exitCode;
  return typeof exitCode === "number" && exitCode !== 0;
}

function isCompactionEvent(entry: Record<string, unknown>): boolean {
  const event = stringField(entry.hook_event_name) || stringField(entry.event) || stringField(entry.type);
  if (event && /compact/i.test(event)) {
    return true;
  }
  const message = asRecord(entry.message);
  const role = stringField(message?.role) || stringField(entry.role);
  const content = typeof entry.content === "string" ? entry.content : typeof message?.content === "string" ? message.content : "";
  return role === "system" && /\b(compact|compaction)\b/i.test(content);
}

function terminalEventKind(entry: Record<string, unknown>): "stop" | "session_end" | undefined {
  const event = stringField(entry.hook_event_name) || stringField(entry.event) || stringField(entry.type);
  if (event === "Stop" || event === "StopFailure" || event === "stop") {
    return "stop";
  }
  if (event === "SessionEnd" || event === "session_end") {
    return "session_end";
  }
  return undefined;
}

function isPostCompactionActivity(
  entry: Record<string, unknown>,
  toolUses: Array<{ id?: string; name: string; input?: unknown }>,
  toolResults: Array<{ toolUseId?: string; toolName?: string; isError: boolean; purpose?: string }>
): boolean {
  if (toolUses.length > 0 || toolResults.length > 0) {
    return true;
  }
  const message = asRecord(entry.message);
  const role = stringField(message?.role) || stringField(entry.role);
  return (role === "assistant" || role === "user") && hasContent(entry.content ?? message?.content);
}

function hasContent(value: unknown): boolean {
  if (typeof value === "string") {
    return value.length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return Boolean(asRecord(value));
}
