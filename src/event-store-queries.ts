import { readStore } from "./event-store-persistence.js";
import { safeToolResultEventFromHookEvent, summarizeBlindRetry, summarizeFailureEpisodes } from "./failure-episodes.js";
import type { BlindRetrySummary, StoredDecision, ToolFailureSummary } from "./types.js";

export async function latestDecision(sessionKey?: string, storePath?: string): Promise<StoredDecision | undefined> {
  const store = await readStore(storePath);
  const decisions = sessionKey ? store.decisions.filter((decision) => decision.sessionKey === sessionKey) : store.decisions;
  return decisions.at(-1);
}

export async function hookSummary(
  sessionKey: string | undefined,
  storePath?: string
): Promise<{
  failedToolResults: number;
  toolCalls: number;
  compactionEvents: number;
  postCompactionActivity: number;
  repeatedFailures: ToolFailureSummary[];
  blindRetry?: BlindRetrySummary;
  latestTimestamp?: string;
  latestCompactionTimestamp?: string;
}> {
  const store = await readStore(storePath);
  const events = store.hookEvents.filter((event) => !sessionKey || event.sessionKey === sessionKey);
  const safeEvents = events.flatMap((event) => safeToolResultEventFromHookEvent(event) ?? []);
  const failures = new Map<string, ToolFailureSummary>();
  let failedToolResults = 0;
  let toolCalls = 0;
  let compactionEvents = 0;
  let postCompactionActivity = 0;
  let latestTimestamp: string | undefined;
  let latestCompactionTimestamp: string | undefined;

  for (const event of events) {
    latestTimestamp = !latestTimestamp || event.timestamp > latestTimestamp ? event.timestamp : latestTimestamp;
    const isCompaction = event.kind === "compaction";
    if (event.kind === "tool_failure") {
      failedToolResults += 1;
      toolCalls += 1;
      const toolName = event.toolName || "tool";
      const key = failureKey(event);
      const existing = failures.get(key);
      failures.set(key, failureSummary(event, toolName, (existing?.count || 0) + 1));
    } else if (event.kind === "tool_success") {
      toolCalls += 1;
      failures.delete(failureKey(event));
    } else if (event.kind === "tool_batch") {
      toolCalls += event.toolCount || 0;
    } else if (isCompaction) {
      compactionEvents += 1;
      postCompactionActivity = 0;
      latestCompactionTimestamp = event.timestamp;
    }
    if (!isCompaction && compactionEvents > 0) {
      postCompactionActivity += 1;
    }
  }

  return {
    failedToolResults,
    toolCalls,
    compactionEvents,
    postCompactionActivity,
    repeatedFailures: [...failures.values()].filter((failure) => failure.count >= 2),
    blindRetry: summarizeBlindRetry(summarizeFailureEpisodes(safeEvents)),
    latestTimestamp,
    latestCompactionTimestamp
  };
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
