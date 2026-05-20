import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { eventStorePath } from "./paths.js";
import type { DecisionEvidence, DecisionState, EventStoreData, HookEventKind, StoredDecision, StoredHookEvent } from "./types.js";

export const STORE_LIMIT = 100;
export const HOOK_STORE_LIMIT = 500;

export async function readStore(storePath = eventStorePath()): Promise<EventStoreData> {
  try {
    const parsed = JSON.parse(await readFile(storePath, "utf8")) as Partial<EventStoreData>;
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      decisions: Array.isArray(parsed.decisions)
        ? parsed.decisions.flatMap((decision) => sanitizeStoredDecision(decision) ?? []).slice(-STORE_LIMIT)
        : [],
      hookEvents: Array.isArray(parsed.hookEvents)
        ? parsed.hookEvents.flatMap((event) => sanitizeStoredHookEvent(event) ?? []).slice(-HOOK_STORE_LIMIT)
        : []
    };
  } catch {
    return { version: 1, updatedAt: new Date(0).toISOString(), decisions: [], hookEvents: [] };
  }
}

export async function writeStore(store: EventStoreData, storePath: string): Promise<void> {
  await mkdir(dirname(storePath), { recursive: true, mode: 0o700 });
  const tempPath = `${storePath}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(tempPath, 0o600);
  await rename(tempPath, storePath);
}

function sanitizeStoredDecision(value: unknown): StoredDecision | undefined {
  const record = asRecord(value);
  if (!record || containsForbiddenRawDataKey(record) || containsRawMcpName(record)) {
    return undefined;
  }
  const id = stringField(record.id);
  const state = decisionState(record.state);
  const action = stringField(record.action);
  if (!id || !state || !action) {
    return undefined;
  }
  return {
    id,
    state,
    reasonCode: stringField(record.reasonCode) || "unknown",
    diagnosisCode: stringField(record.diagnosisCode),
    diagnosis: stringField(record.diagnosis),
    confidence: confidence(record.confidence),
    baselineNote: stringField(record.baselineNote),
    primaryEvidence: stringField(record.primaryEvidence) || "stored decision",
    evidence: sanitizeEvidence(record.evidence),
    impact: stringField(record.impact) || "",
    action,
    costUsd: numberField(record.costUsd),
    costSource: costSource(record.costSource),
    contextPercent: numberField(record.contextPercent),
    rateLimitPercent: numberField(record.rateLimitPercent),
    sessionKey: stringField(record.sessionKey),
    createdAt: stringField(record.createdAt) || new Date(0).toISOString()
  };
}

function sanitizeStoredHookEvent(value: unknown): StoredHookEvent | undefined {
  const record = asRecord(value);
  if (!record || containsForbiddenRawDataKey(record) || containsRawMcpName(record)) {
    return undefined;
  }
  const id = stringField(record.id);
  const kind = hookKind(record.kind);
  const timestamp = stringField(record.timestamp);
  if (!id || !kind || !timestamp) {
    return undefined;
  }
  return {
    id,
    kind,
    timestamp,
    hookEventName: stringField(record.hookEventName) || "unknown",
    sessionKey: stringField(record.sessionKey),
    toolName: stringField(record.toolName),
    purpose: stringField(record.purpose),
    category: hookCategory(record.category),
    identityHash: stringField(record.identityHash),
    toolCount: numberField(record.toolCount)
  };
}

function sanitizeEvidence(value: unknown): DecisionEvidence[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const record = asRecord(item);
    const label = stringField(record?.label);
    if (!record || containsForbiddenRawDataKey(record) || containsRawMcpName(record) || !label) {
      return [];
    }
    const detail = stringField(record.detail);
    return detail ? [{ label, detail }] : [{ label }];
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function decisionState(value: unknown): DecisionState | undefined {
  return value === "Healthy" || value === "Careful" || value === "Stop" ? value : undefined;
}

function confidence(value: unknown): StoredDecision["confidence"] {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

function costSource(value: unknown): StoredDecision["costSource"] {
  return value === "claude" || value === "estimated" ? value : undefined;
}

function hookKind(value: unknown): HookEventKind | undefined {
  return value === "tool_success" ||
    value === "tool_failure" ||
    value === "tool_batch" ||
    value === "compaction" ||
    value === "stop" ||
    value === "session_end"
    ? value
    : undefined;
}

function hookCategory(value: unknown): StoredHookEvent["category"] {
  return value === "MCP" ? value : undefined;
}

function containsForbiddenRawDataKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsForbiddenRawDataKey(item));
  }
  const record = asRecord(value);
  if (!record) {
    return false;
  }
  for (const [key, child] of Object.entries(record)) {
    if (FORBIDDEN_RAW_DATA_KEYS_NORMALIZED.has(normalizeKey(key)) || containsForbiddenRawDataKey(child)) {
      return true;
    }
  }
  return false;
}

function containsRawMcpName(value: unknown): boolean {
  if (typeof value === "string") {
    return /\bmcp__/u.test(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsRawMcpName(item));
  }
  const record = asRecord(value);
  if (!record) {
    return false;
  }
  return Object.entries(record).some(([key, child]) => /\bmcp__/u.test(key) || containsRawMcpName(child));
}

const FORBIDDEN_RAW_DATA_KEYS_NORMALIZED = new Set(
  [
    "assistantText",
    "command",
    "commands",
    "cwd",
    "cwds",
    "fileContent",
    "fileContents",
    "prompt",
    "prompts",
    "promptText",
    "rawCommand",
    "rawCommands",
    "rawPrompt",
    "rawPrompts",
    "rawSessionId",
    "rawSessionIds",
    "rawToolOutput",
    "rawToolOutputs",
    "sessionId",
    "sessionIds",
    "toolOutput",
    "toolOutputs",
    "transcriptPath",
    "transcriptPaths",
    "workspacePath",
    "workspacePaths"
  ].map(normalizeKey)
);

function normalizeKey(value: string): string {
  return value.replaceAll(/[_-]/gu, "").toLowerCase();
}
