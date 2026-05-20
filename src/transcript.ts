import { asRecord, extractUsage, mergeUsage, stringField } from "./status-input.js";
import { extractFailureEpisodesFromTranscriptLines, summarizeBlindRetry } from "./failure-episodes.js";
import { classifyResultPurpose, classifyToolIdentity } from "./tool-metadata.js";
import { readTranscriptTail, type ReadTranscriptTailOptions } from "./transcript-reader.js";
import type { ToolFailureSummary, TokenUsage, TranscriptSummary } from "./types.js";

export type ParseTranscriptOptions = ReadTranscriptTailOptions;

interface ToolMeta {
  name: string;
  purpose?: string;
  category?: "MCP";
  identityHash?: string;
  isEdit: boolean;
  isReadSearch: boolean;
}

export async function parseTranscriptTail(
  transcriptPath: string | undefined,
  options: ParseTranscriptOptions = {}
): Promise<TranscriptSummary> {
  const tail = await readTranscriptTail(transcriptPath, options);
  if (!tail.pathReadable) {
    return emptySummary(false);
  }
  return parseTranscriptLines(tail.lines, tail.bytesRead);
}

export function parseTranscriptLines(lines: string[], bytesRead = Buffer.byteLength(lines.join("\n"))): TranscriptSummary {
  const failureEpisodes = extractFailureEpisodesFromTranscriptLines(lines);
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
  let toolCalls = 0;
  let readToolCalls = 0;
  let failedToolResults = 0;
  let malformedLines = 0;
  let compactionEvents = 0;
  let postCompactionActivity = 0;
  let usage: TokenUsage = {};
  let latestUsage: TokenUsage | undefined;
  let latestUsageTimestamp: string | undefined;
  let latestTimestamp: string | undefined;
  let latestCompactionTimestamp: string | undefined;

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

    const entryTimestamp = stringField(entry.timestamp);
    latestTimestamp = entryTimestamp || latestTimestamp;
    const entryUsage = mergeUsage(extractUsage(entry), extractUsage(asRecord(entry.message)));
    usage = mergeUsage(usage, entryUsage);
    if (hasUsage(entryUsage)) {
      latestUsage = entryUsage;
      latestUsageTimestamp = entryTimestamp || latestUsageTimestamp;
    }
    const toolUses = extractToolUses(entry);
    const toolResults = extractToolResults(entry);

    if (isCompactionEvent(entry)) {
      compactionEvents += 1;
      postCompactionActivity = 0;
      latestCompactionTimestamp = entryTimestamp || latestCompactionTimestamp;
    } else if (compactionEvents > 0 && isPostCompactionActivity(entry, toolUses, toolResults)) {
      postCompactionActivity += 1;
    }

    for (const toolUse of toolUses) {
      toolCalls += 1;
      const identity = classifyToolIdentity(toolUse.name, toolUse.input, { basenameOnly: true });
      if (identity.isReadSearch) {
        readToolCalls += 1;
      }
      if (toolUse.id) {
        toolById.set(toolUse.id, {
          name: identity.displayName,
          purpose: identity.purpose,
          category: identity.category,
          identityHash: identity.identityHash,
          isEdit: identity.isEdit,
          isReadSearch: identity.isReadSearch
        });
      }
      if (identity.isEdit) {
        recentEditBeforeTest = true;
      }
    }

    for (const toolResult of toolResults) {
      toolResultStep += 1;
      const meta =
        (toolResult.toolUseId ? toolById.get(toolResult.toolUseId) : undefined) ||
        (toolResult.toolName
          ? metaFromToolName(toolResult.toolName)
          : undefined) ||
        { name: "tool", purpose: undefined, isEdit: false, isReadSearch: false };
      const purpose = meta.name === "Bash" ? toolResult.purpose || meta.purpose : meta.purpose;
      const key = failureKey(meta, purpose);
      const isValidation = meta.name === "Bash" && isValidationPurpose(purpose);
      if (!toolResult.isError) {
        failureCounts.delete(key);
        if (meta.isEdit) {
          hasUnvalidatedEdits = true;
          unvalidatedEditStep = toolResultStep;
        } else if (isValidation) {
          if (validationFailedSinceSuccess) {
            validationRecovered = true;
          }
          validationFailedSinceSuccess = false;
          editTestLoopFailures = 0;
          recentEditBeforeTest = false;
          hasUnvalidatedEdits = false;
          unvalidatedEditStep = undefined;
        }
        continue;
      }
      failedToolResults += 1;
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
    linesRead: lines.length,
    malformedLines,
    toolCalls,
    readToolCalls,
    failedToolResults,
    repeatedFailures: [...failureCounts.values()].filter((item) => item.count >= 2),
    failureEpisodes,
    blindRetry,
    editTestLoopFailures,
    hasUnvalidatedEdits,
    unvalidatedEditToolSteps:
      hasUnvalidatedEdits && unvalidatedEditStep !== undefined ? toolResultStep - unvalidatedEditStep : undefined,
    validationRecovered,
    compactionEvents,
    postCompactionActivity,
    usage,
    latestUsage,
    latestUsageTimestamp,
    latestTimestamp,
    latestCompactionTimestamp
  };
}

function emptySummary(pathReadable: boolean): TranscriptSummary {
  return {
    pathReadable,
    bytesRead: 0,
    linesRead: 0,
    malformedLines: 0,
    toolCalls: 0,
    readToolCalls: 0,
    failedToolResults: 0,
    repeatedFailures: [],
    editTestLoopFailures: 0,
    hasUnvalidatedEdits: false,
    validationRecovered: false,
    compactionEvents: 0,
    postCompactionActivity: 0,
    usage: {}
  };
}

function isValidationPurpose(purpose: string | undefined): boolean {
  return purpose === "tests" || purpose === "lint" || purpose === "typecheck" || purpose === "build";
}

function metaFromToolName(toolName: string): ToolMeta {
  const identity = classifyToolIdentity(toolName, undefined, { basenameOnly: true });
  return {
    name: identity.displayName,
    purpose: identity.purpose,
    category: identity.category,
    identityHash: identity.identityHash,
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

function hasUsage(usage: TokenUsage): boolean {
  return (
    usage.inputTokens !== undefined ||
    usage.outputTokens !== undefined ||
    usage.cacheCreationInputTokens !== undefined ||
    usage.cacheReadInputTokens !== undefined ||
    usage.totalTokens !== undefined
  );
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
  purpose?: string;
}> {
  const result: Array<{ toolUseId?: string; toolName?: string; isError: boolean; purpose?: string }> = [];
  for (const part of contentParts(entry)) {
    if (part.type === "tool_result") {
      result.push({
        toolUseId: stringField(part.tool_use_id) || stringField(part.toolUseId),
        toolName: stringField(part.name) || stringField(part.tool_name),
        isError: truthyError(part),
        purpose: classifyResultPurpose(part)
      });
    }
  }

  if (entry.type === "tool_result" || entry.type === "tool_result_delta") {
    result.push({
      toolUseId: stringField(entry.tool_use_id) || stringField(entry.toolUseId),
      toolName: stringField(entry.name) || stringField(entry.tool_name) || stringField(entry.toolName),
      isError: truthyError(entry),
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
