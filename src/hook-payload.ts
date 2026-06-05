import { hashValue } from "./paths.js";
import { fileIdentityFromToolInput, readKindFromInput } from "./file-identity.js";
import type { ProjectConfig } from "./project-config.js";
import { asRecord, numberField, stringField } from "./status-input.js";
import { classifyToolIdentity } from "./tool-metadata.js";
import type { DerivedHookEvent } from "./types.js";

export const SAFE_HOOK_EVENTS = [
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "PreCompact",
  "PostCompact",
  "SessionStart",
  "Stop",
  "SessionEnd"
] as const;

export function parseHookPayload(
  raw: string,
  fallbackEventName?: string,
  options: { projectConfig?: ProjectConfig } = {}
): DerivedHookEvent | undefined {
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
    const toolInput = root.tool_input ?? root.toolInput;
    const identity = classifyToolIdentity(stringField(root.tool_name) || stringField(root.toolName), root.tool_input ?? root.toolInput, {
      projectConfig: options.projectConfig
    });
    return {
      ...base,
      kind: "tool_failure",
      toolName: identity.displayName,
      purpose: identity.purpose,
      category: identity.category,
      identityHash: identity.identityHash,
      ...(identity.displayName === "Read" ? { readKind: readKindFromInput(toolInput) } : {})
    };
  }

  if (hookEventName === "PostToolUse") {
    const toolInput = root.tool_input ?? root.toolInput;
    const identity = classifyToolIdentity(stringField(root.tool_name) || stringField(root.toolName), toolInput, {
      projectConfig: options.projectConfig
    });
    const fileIdentity = fileIdentityFromToolInput(identity.displayName, toolInput);
    return {
      ...base,
      kind: "tool_success",
      toolName: identity.displayName,
      purpose: identity.purpose,
      category: identity.category,
      identityHash: identity.identityHash,
      fileIdentityHash: fileIdentity?.fileIdentityHash,
      ...(identity.displayName === "Read" ? { readKind: readKindFromInput(toolInput) } : {})
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
      kind: "compaction",
      compactionStage: hookEventName === "PreCompact" ? "pre" : "post"
    };
  }

  if (hookEventName === "SessionStart") {
    return {
      ...base,
      kind: "session_start",
      lifecycleSource: sessionStartSource(stringField(root.source) || stringField(root.session_start_source))
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

function sessionStartSource(value: string | undefined): DerivedHookEvent["lifecycleSource"] {
  return value === "startup" || value === "resume" || value === "clear" || value === "compact" ? value : "unknown";
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
