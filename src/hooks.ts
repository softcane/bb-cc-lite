import { hashValue } from "./paths.js";
import { asRecord, numberField, stringField } from "./status-input.js";
import type { DerivedHookEvent, TranscriptSummary } from "./types.js";

const TEST_COMMAND_RE =
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|vitest|jest)|\b(vitest|jest|mocha|pytest|cargo\s+test|go\s+test|rspec|playwright\s+test)\b/i;

export const SAFE_HOOK_EVENTS = [
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "PreCompact",
  "PostCompact",
  "Stop",
  "SessionEnd"
] as const;

export function parseHookPayload(raw: string, fallbackEventName?: string): DerivedHookEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim() || "{}");
  } catch {
    return undefined;
  }
  const root = asRecord(parsed);
  if (!root) {
    return undefined;
  }

  const hookEventName = stringField(root.hook_event_name) || stringField(root.event) || fallbackEventName || "unknown";
  const sessionId = stringField(root.session_id) || stringField(root.sessionId);
  const base = {
    timestamp: stringField(root.timestamp) || new Date().toISOString(),
    hookEventName,
    sessionKey: hashValue(sessionId)
  };

  if (hookEventName === "PostToolUseFailure") {
    const toolName = safeToolName(stringField(root.tool_name) || stringField(root.toolName));
    return {
      ...base,
      kind: "tool_failure",
      toolName,
      purpose: classifyToolPurpose(toolName, root.tool_input ?? root.toolInput)
    };
  }

  if (hookEventName === "PostToolUse") {
    const toolName = safeToolName(stringField(root.tool_name) || stringField(root.toolName));
    return {
      ...base,
      kind: "tool_success",
      toolName,
      purpose: classifyToolPurpose(toolName, root.tool_input ?? root.toolInput)
    };
  }

  if (hookEventName === "PostToolBatch") {
    return {
      ...base,
      kind: "tool_batch",
      toolCount: countBatchTools(root)
    };
  }

  if (hookEventName === "PreCompact" || hookEventName === "PostCompact") {
    return {
      ...base,
      kind: "compaction"
    };
  }

  if (hookEventName === "Stop" || hookEventName === "StopFailure") {
    return {
      ...base,
      kind: "stop"
    };
  }

  if (hookEventName === "SessionEnd") {
    return {
      ...base,
      kind: "session_end"
    };
  }

  return undefined;
}

export function mergeHookSummary(
  transcript: TranscriptSummary,
  hookData: {
    failedToolResults: number;
    toolCalls: number;
    compactionEvents: number;
    repeatedFailures: Array<{ toolName: string; count: number; purpose?: string }>;
    latestTimestamp?: string;
  }
): TranscriptSummary {
  const repeatedFailures = new Map<string, { toolName: string; count: number; purpose?: string }>();
  for (const failure of [...transcript.repeatedFailures, ...hookData.repeatedFailures]) {
    const key = `${failure.toolName}:${failure.purpose || ""}`;
    const existing = repeatedFailures.get(key);
    repeatedFailures.set(key, {
      toolName: failure.toolName,
      purpose: failure.purpose,
      count: Math.max(existing?.count || 0, failure.count)
    });
  }

  return {
    ...transcript,
    toolCalls: Math.max(transcript.toolCalls, hookData.toolCalls),
    failedToolResults: Math.max(transcript.failedToolResults, hookData.failedToolResults),
    repeatedFailures: [...repeatedFailures.values()].filter((failure) => failure.count >= 2),
    compactionEvents: Math.max(transcript.compactionEvents, hookData.compactionEvents),
    latestTimestamp:
      transcript.latestTimestamp && hookData.latestTimestamp
        ? transcript.latestTimestamp > hookData.latestTimestamp
          ? transcript.latestTimestamp
          : hookData.latestTimestamp
        : transcript.latestTimestamp || hookData.latestTimestamp
  };
}

function classifyToolPurpose(toolName: string, input: unknown): string | undefined {
  if (toolName !== "Bash") {
    return undefined;
  }
  const command = stringField(asRecord(input)?.command);
  return command && TEST_COMMAND_RE.test(command) ? "tests" : undefined;
}

function countBatchTools(root: Record<string, unknown>): number {
  const values = [root.tools, root.tool_uses, root.toolUses, root.results, root.tool_results, root.toolResults];
  for (const value of values) {
    if (Array.isArray(value)) {
      return value.length;
    }
    const count = numberField(value);
    if (count !== undefined) {
      return Math.max(0, Math.floor(count));
    }
  }
  return 0;
}

function safeToolName(toolName: string | undefined): string {
  if (!toolName) {
    return "tool";
  }
  return /^[A-Za-z][A-Za-z0-9_-]{0,32}$/u.test(toolName) ? toolName : "tool";
}
