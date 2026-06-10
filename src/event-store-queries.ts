import { buildEditLedger, type EditLedger, type LedgerEvent } from "./edit-ledger.js";
import { readStore } from "./event-store-persistence.js";
import { safeToolResultEventFromHookEvent, summarizeBlindRetry, summarizeFailureEpisodes } from "./failure-episodes.js";
import type { SafeToolResultEvent } from "./failure-episodes.js";
import { isEditTool, isReadSearchTool } from "./tool-metadata.js";
import type {
  ActiveFullFileReadSummary,
  ActivityKind,
  BlindRetrySummary,
  RedundantReadSummary,
  SessionStartSource,
  StoredDecision,
  ToolFailureSummary
} from "./types.js";

interface FileReadState {
  count: number;
  lastSeenToolCall: number;
}

export async function latestDecision(sessionKey?: string, storePath?: string): Promise<StoredDecision | undefined> {
  const store = await readStore(storePath);
  const decisions = sessionKey ? store.decisions.filter((decision) => decision.sessionKey === sessionKey) : store.decisions;
  return decisions.at(-1);
}

// Project-scoped latest decision (PRD-01, branch G/H2). Two concurrent sessions in different
// repos must never read each other's latest decision.
export async function latestProjectDecision(projectKey: string | undefined, storePath?: string): Promise<StoredDecision | undefined> {
  if (!projectKey) {
    return undefined;
  }
  const store = await readStore(storePath);
  return store.decisions.filter((decision) => decision.projectKey === projectKey).at(-1);
}

export async function hookSummary(
  sessionKey: string | undefined,
  storePath?: string
): Promise<{
  failedToolResults: number;
  toolCalls: number;
  readToolCalls: number;
  successfulEditResults: number;
  failedEditResults: number;
  unvalidatedEditResultCount: number;
  changedFileIdentityCount: number;
  unvalidatedChangedFileIdentityCount: number;
  workContinuedAfterFailedEdit: boolean;
  validationChecks: number;
  validationSuccesses: number;
  validationRecovered: boolean;
  hasUnvalidatedEdits: boolean;
  unvalidatedEditToolSteps?: number;
  compactionEvents: number;
  postCompactionActivity: number;
  repeatedFailures: ToolFailureSummary[];
  blindRetry?: BlindRetrySummary;
  latestTimestamp?: string;
  latestLifecycleSource?: SessionStartSource;
  latestLifecycleTimestamp?: string;
  terminalEvents: number;
  latestTerminalEvent?: "stop" | "session_end";
  latestTerminalTimestamp?: string;
  latestCompactionTimestamp?: string;
  redundantRead?: RedundantReadSummary;
  activeFullFileReads: ActiveFullFileReadSummary[];
  ledger: EditLedger;
  latestActivityKind?: ActivityKind;
}> {
  const store = await readStore(storePath);
  const events = store.hookEvents
    .filter((event) => !sessionKey || event.sessionKey === sessionKey)
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  let safeEvents: SafeToolResultEvent[] = [];
  const failures = new Map<string, ToolFailureSummary>();
  let failedToolResults = 0;
  let toolCalls = 0;
  let readToolCalls = 0;
  let successfulEditResults = 0;
  let failedEditResults = 0;
  let unvalidatedEditResultCount = 0;
  let workContinuedAfterFailedEdit = false;
  let failedEditOpen = false;
  let validationChecks = 0;
  let validationSuccesses = 0;
  let validationRecovered = false;
  let hasOpenUnvalidatedEdit = false;
  let unvalidatedEditToolSteps: number | undefined;
  let validationFailureOpen = false;
  let compactionEvents = 0;
  let postCompactionActivity = 0;
  let latestTimestamp: string | undefined;
  let latestLifecycleSource: SessionStartSource | undefined;
  let latestLifecycleTimestamp: string | undefined;
  let terminalEvents = 0;
  let latestTerminalEvent: "stop" | "session_end" | undefined;
  let latestTerminalTimestamp: string | undefined;
  let latestCompactionTimestamp: string | undefined;
  const fullFileReadCounts = new Map<string, FileReadState>();
  let redundantRead: RedundantReadSummary | undefined;
  const changedFileIdentityHashes = new Set<string>();
  const unvalidatedChangedFileIdentityHashes = new Set<string>();
  const ledgerEvents: LedgerEvent[] = [];
  let latestActivityKind: ActivityKind | undefined;

  for (const event of events) {
    const isCompaction = event.kind === "compaction";
    const isLifecycle = event.kind === "session_start";
    const isTerminal = event.kind === "stop" || event.kind === "session_end";
    if (!isLifecycle) {
      latestTimestamp = !latestTimestamp || event.timestamp > latestTimestamp ? event.timestamp : latestTimestamp;
    }
    if (isLifecycle && (!latestLifecycleTimestamp || event.timestamp >= latestLifecycleTimestamp)) {
      latestLifecycleSource = event.lifecycleSource || "unknown";
      latestLifecycleTimestamp = event.timestamp;
    }
    if (isLifecycle && resetsOpenRisk(event.lifecycleSource)) {
      failedToolResults = 0;
      toolCalls = 0;
      readToolCalls = 0;
      successfulEditResults = 0;
      failedEditResults = 0;
      unvalidatedEditResultCount = 0;
      workContinuedAfterFailedEdit = false;
      failedEditOpen = false;
      validationChecks = 0;
      validationSuccesses = 0;
      validationRecovered = false;
      hasOpenUnvalidatedEdit = false;
      unvalidatedEditToolSteps = undefined;
      validationFailureOpen = false;
      failures.clear();
      fullFileReadCounts.clear();
      changedFileIdentityHashes.clear();
      unvalidatedChangedFileIdentityHashes.clear();
      redundantRead = undefined;
      safeEvents = [];
      ledgerEvents.push({ kind: "lifecycle_reset" });
    }
    if (isTerminal && (!latestTerminalTimestamp || event.timestamp >= latestTerminalTimestamp)) {
      terminalEvents += 1;
      latestTerminalEvent = event.kind === "stop" ? "stop" : "session_end";
      latestTerminalTimestamp = event.timestamp;
    }
    const safeEvent = safeToolResultEventFromHookEvent(event);
    if (safeEvent) {
      safeEvents.push(safeEvent);
    }
    if (event.kind === "tool_failure") {
      if (failedEditOpen) {
        workContinuedAfterFailedEdit = true;
      }
      failedToolResults += 1;
      toolCalls += 1;
      latestActivityKind = hookActivityKind(event);
      if (isReadActivity(event)) {
        readToolCalls += 1;
      }
      if (isValidationPurpose(event.purpose)) {
        validationChecks += 1;
        validationFailureOpen = true;
        ledgerEvents.push({ kind: "validation_fail" });
      }
      if (hasOpenUnvalidatedEdit) {
        unvalidatedEditToolSteps = (unvalidatedEditToolSteps || 0) + 1;
      }
      if (isEditTool(event.toolName || "tool")) {
        failedEditResults += 1;
        failedEditOpen = true;
      }
      const toolName = event.toolName || "tool";
      const key = failureKey(event);
      const existing = failures.get(key);
      failures.set(key, failureSummary(event, toolName, (existing?.count || 0) + 1));
    } else if (event.kind === "tool_success") {
      if (failedEditOpen) {
        workContinuedAfterFailedEdit = true;
      }
      toolCalls += 1;
      const toolName = event.toolName || "tool";
      latestActivityKind = hookActivityKind(event);
      if (isReadActivity(event)) {
        readToolCalls += 1;
      }
      if (isEditTool(toolName)) {
        successfulEditResults += 1;
        unvalidatedEditResultCount += 1;
        hasOpenUnvalidatedEdit = true;
        unvalidatedEditToolSteps = 0;
        ledgerEvents.push({ kind: "edit", identityHash: event.fileIdentityHash });
        if (event.fileIdentityHash) {
          changedFileIdentityHashes.add(event.fileIdentityHash);
          unvalidatedChangedFileIdentityHashes.add(event.fileIdentityHash);
          fullFileReadCounts.delete(event.fileIdentityHash);
          redundantRead = strongestActiveRedundantRead(fullFileReadCounts);
        }
      } else if (isValidationPurpose(event.purpose)) {
        validationChecks += 1;
        validationSuccesses += 1;
        validationRecovered = validationRecovered || validationFailureOpen;
        validationFailureOpen = false;
        hasOpenUnvalidatedEdit = false;
        unvalidatedEditToolSteps = undefined;
        unvalidatedEditResultCount = 0;
        unvalidatedChangedFileIdentityHashes.clear();
        ledgerEvents.push({ kind: "validation_pass" });
      } else if (hasOpenUnvalidatedEdit) {
        unvalidatedEditToolSteps = (unvalidatedEditToolSteps || 0) + 1;
      }
      failures.delete(failureKey(event));
    } else if (event.kind === "tool_batch") {
      toolCalls += event.toolCount || 0;
    } else if (isCompaction) {
      compactionEvents += 1;
      postCompactionActivity = 0;
      latestCompactionTimestamp = event.timestamp;
      fullFileReadCounts.clear();
      redundantRead = undefined;
      ledgerEvents.push({ kind: "compaction" });
    }
    if (event.kind === "tool_success" && event.toolName === "Read" && event.readKind === "full" && event.fileIdentityHash) {
      const existing = fullFileReadCounts.get(event.fileIdentityHash);
      fullFileReadCounts.set(event.fileIdentityHash, {
        count: (existing?.count || 0) + 1,
        lastSeenToolCall: toolCalls
      });
      redundantRead = strongestActiveRedundantRead(fullFileReadCounts);
    }
    if (!isCompaction && !isLifecycle && compactionEvents > 0) {
      postCompactionActivity += 1;
    }
  }

  return {
    failedToolResults,
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
    validationRecovered,
    hasUnvalidatedEdits: hasOpenUnvalidatedEdit,
    unvalidatedEditToolSteps,
    compactionEvents,
    postCompactionActivity,
    repeatedFailures: [...failures.values()].filter((failure) => failure.count >= 2),
    blindRetry: summarizeBlindRetry(summarizeFailureEpisodes(safeEvents)),
    latestTimestamp,
    latestLifecycleSource,
    latestLifecycleTimestamp,
    terminalEvents,
    latestTerminalEvent,
    latestTerminalTimestamp,
    latestCompactionTimestamp,
    redundantRead,
    activeFullFileReads: activeFullFileReadSummaries(fullFileReadCounts),
    ledger: buildEditLedger(ledgerEvents),
    latestActivityKind
  };
}

function hookActivityKind(event: { toolName?: string; purpose?: string; category?: "MCP" }): ActivityKind {
  if (event.category === "MCP" || event.toolName === "MCP tool") {
    return "mcp";
  }
  const toolName = event.toolName || "tool";
  if (isEditTool(toolName)) {
    return "edit";
  }
  if (toolName === "Bash" && isValidationPurpose(event.purpose)) {
    return "validate";
  }
  if (isReadActivity(event)) {
    return "read";
  }
  if (toolName === "Bash") {
    return "exec";
  }
  return "other";
}

function resetsOpenRisk(source: SessionStartSource | undefined): boolean {
  return source === "startup" || source === "clear" || source === "compact";
}

function isValidationPurpose(value: string | undefined): boolean {
  return value === "tests" || value === "lint" || value === "typecheck" || value === "build";
}

function isReadActivity(event: { toolName?: string; purpose?: string }): boolean {
  return event.purpose === "read" || isReadSearchTool(event.toolName || "tool");
}

function failureKey(event: { toolName?: string; purpose?: string; category?: "MCP"; identityHash?: string }): string {
  return event.category === "MCP" && event.identityHash
    ? `MCP:${event.identityHash}`
    : `${event.toolName || "tool"}:${event.purpose || ""}`;
}

function failureSummary(
  event: { purpose?: string; category?: "MCP"; identityHash?: string },
  toolName: string,
  count: number
): ToolFailureSummary {
  const summary: ToolFailureSummary = {
    toolName,
    count
  };
  if (event.purpose) {
    summary.purpose = event.purpose;
  }
  if (event.category) {
    summary.category = event.category;
  }
  if (event.identityHash) {
    summary.identityHash = event.identityHash;
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
        latestState: state.count >= 3 ? "Stop" : "Careful"
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
