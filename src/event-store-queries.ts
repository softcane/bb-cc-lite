import { readStore } from "./event-store-persistence.js";
import type { StoredDecision, ToolFailureSummary } from "./types.js";

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
  repeatedFailures: ToolFailureSummary[];
  latestTimestamp?: string;
}> {
  const store = await readStore(storePath);
  const events = store.hookEvents.filter((event) => !sessionKey || event.sessionKey === sessionKey);
  const failures = new Map<string, ToolFailureSummary>();
  let failedToolResults = 0;
  let toolCalls = 0;
  let compactionEvents = 0;
  let latestTimestamp: string | undefined;

  for (const event of events) {
    latestTimestamp = !latestTimestamp || event.timestamp > latestTimestamp ? event.timestamp : latestTimestamp;
    if (event.kind === "tool_failure") {
      failedToolResults += 1;
      toolCalls += 1;
      const toolName = event.toolName || "tool";
      const key = `${toolName}:${event.purpose || ""}`;
      const existing = failures.get(key);
      failures.set(key, {
        toolName,
        purpose: event.purpose,
        count: (existing?.count || 0) + 1
      });
    } else if (event.kind === "tool_success") {
      toolCalls += 1;
    } else if (event.kind === "tool_batch") {
      toolCalls += event.toolCount || 0;
    } else if (event.kind === "compaction") {
      compactionEvents += 1;
    }
  }

  return {
    failedToolResults,
    toolCalls,
    compactionEvents,
    repeatedFailures: [...failures.values()].filter((failure) => failure.count >= 2),
    latestTimestamp
  };
}
