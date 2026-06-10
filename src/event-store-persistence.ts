import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { eventStorePath } from "./paths.js";
import type {
  DecisionEvidence,
  DecisionState,
  EventStoreData,
  FeedbackExpectedAction,
  FeedbackOutcomeSafeCategory,
  FeedbackOutcomeState,
  HookEventKind,
  StoredDecision,
  StoredFeedbackOutcome,
  StoredHookEvent
} from "./types.js";

export const STORE_LIMIT = 100;
export const HOOK_STORE_LIMIT = 500;
export const FEEDBACK_OUTCOME_STORE_LIMIT = 500;

export async function readStore(storePath = eventStorePath()): Promise<EventStoreData> {
  try {
    const parsed = JSON.parse(await readFile(storePath, "utf8")) as Partial<EventStoreData>;
    return {
      version: parsed.version === 2 ? 2 : 1,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      decisions: Array.isArray(parsed.decisions)
        ? parsed.decisions.flatMap((decision) => sanitizeStoredDecision(decision) ?? []).slice(-STORE_LIMIT)
        : [],
      hookEvents: Array.isArray(parsed.hookEvents)
        ? parsed.hookEvents.flatMap((event) => sanitizeStoredHookEvent(event) ?? []).slice(-HOOK_STORE_LIMIT)
        : [],
      feedbackOutcomes: Array.isArray(parsed.feedbackOutcomes)
        ? parsed.feedbackOutcomes
            .flatMap((outcome) => sanitizeStoredFeedbackOutcome(outcome) ?? [])
            .slice(-FEEDBACK_OUTCOME_STORE_LIMIT)
        : []
    };
  } catch {
    return { version: 1, updatedAt: new Date(0).toISOString(), decisions: [], hookEvents: [], feedbackOutcomes: [] };
  }
}

export async function writeStore(store: EventStoreData, storePath: string): Promise<void> {
  await mkdir(dirname(storePath), { recursive: true, mode: 0o700 });
  const tempPath = `${storePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(tempPath, 0o600);
  await rename(tempPath, storePath);
}

export async function updateStore<T>(
  storePath: string,
  update: (store: EventStoreData) => { store: EventStoreData; result: T } | Promise<{ store: EventStoreData; result: T }>
): Promise<T> {
  const release = await acquireStoreLock(storePath);
  try {
    const current = await readStore(storePath);
    const { store, result } = await update(current);
    await writeStore(store, storePath);
    return result;
  } finally {
    await release();
  }
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
    createdAt: stringField(record.createdAt) || new Date(0).toISOString(),
    schemaVersion: record.schemaVersion === 2 ? 2 : undefined,
    projectKey: projectKey(record.projectKey),
    light: gaugeLight(record.light),
    activity: activityVerb(record.activity),
    findings: sanitizeFindings(record.findings),
    ledger: sanitizeLedger(record.ledger),
    files: sanitizeGaugeFiles(record.files)
  };
}

function projectKey(value: unknown): string | undefined {
  const text = stringField(value);
  return text && /^[a-f0-9]{64}$/u.test(text) ? text : undefined;
}

function gaugeLight(value: unknown): StoredDecision["light"] {
  return value === "green" || value === "blue" || value === "red" || value === "gray" ? value : undefined;
}

function activityVerb(value: unknown): StoredDecision["activity"] {
  return value === "retrying" || value === "testing" || value === "editing" || value === "exploring" || value === "idle"
    ? value
    : undefined;
}

function findingSeverity(value: unknown): "red" | "blue" | "info" | undefined {
  return value === "red" || value === "blue" || value === "info" ? value : undefined;
}

function sanitizeFindings(value: unknown): StoredDecision["findings"] {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const findings = value.flatMap((item) => {
    const record = asRecord(item);
    const category = stringField(record?.category);
    const severity = findingSeverity(record?.severity);
    const evidence = stringField(record?.evidence);
    if (!record || containsForbiddenRawDataKey(record) || containsRawMcpName(record) || !category || !severity || !evidence) {
      return [];
    }
    return [
      {
        category,
        severity,
        confidence: confidence(record.confidence) || "medium",
        evidence,
        fileHint: stringField(record.fileHint),
        note: stringField(record.note)
      }
    ];
  });
  return findings;
}

function sanitizeLedger(value: unknown): StoredDecision["ledger"] {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.flatMap((item) => {
    const record = asRecord(item);
    const identityHash = stringField(record?.identityHash);
    if (!record || containsForbiddenRawDataKey(record) || containsRawMcpName(record) || !identityHash) {
      return [];
    }
    return [
      {
        identityHash,
        basename: stringField(record.basename),
        edits: numberField(record.edits) ?? 0,
        unchecked: record.unchecked === true
      }
    ];
  });
}

function sanitizeGaugeFiles(value: unknown): StoredDecision["files"] {
  const record = asRecord(value);
  if (!record || containsForbiddenRawDataKey(record) || containsRawMcpName(record)) {
    return undefined;
  }
  return {
    edited: numberField(record.edited) ?? 0,
    unchecked: numberField(record.unchecked) ?? 0,
    latestUncheckedBasename: stringField(record.latestUncheckedBasename)
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
    lifecycleSource: lifecycleSource(record.lifecycleSource),
    compactionStage: compactionStage(record.compactionStage),
    toolName: stringField(record.toolName),
    purpose: stringField(record.purpose),
    category: hookCategory(record.category),
    identityHash: stringField(record.identityHash),
    fileIdentityHash: fileIdentityHash(record.fileIdentityHash),
    readKind: readKind(record.readKind),
    toolCount: numberField(record.toolCount),
    feedbackAction: feedbackAction(record.feedbackAction),
    cooldownKey: stringField(record.cooldownKey)
  };
}

function sanitizeStoredFeedbackOutcome(value: unknown): StoredFeedbackOutcome | undefined {
  const record = asRecord(value);
  if (!record || containsForbiddenRawDataKey(record) || containsRawMcpName(record)) {
    return undefined;
  }
  const id = stringField(record.id);
  const kind = record.kind === "feedback_outcome" ? "feedback_outcome" : undefined;
  const feedbackActionValue = feedbackAction(record.feedbackAction);
  const cooldownKey = stringField(record.cooldownKey);
  const expectedAction = feedbackExpectedAction(record.expectedAction);
  const outcome = feedbackOutcome(record.outcome);
  const timestamp = stringField(record.timestamp);
  if (!id || !kind || !feedbackActionValue || !cooldownKey || !expectedAction || !outcome || !timestamp) {
    return undefined;
  }
  return {
    id,
    kind,
    sessionKey: stringField(record.sessionKey),
    feedbackAction: feedbackActionValue,
    cooldownKey,
    expectedAction,
    outcome,
    timestamp,
    safeCategory: feedbackSafeCategory(record.safeCategory),
    reasonCode: stringField(record.reasonCode),
    stateBefore: decisionState(record.stateBefore),
    stateAfter: decisionState(record.stateAfter)
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
  return value === "session_start" ||
    value === "tool_success" ||
    value === "tool_failure" ||
    value === "tool_batch" ||
    value === "compaction" ||
    value === "stop" ||
    value === "session_end" ||
    value === "feedback"
    ? value
    : undefined;
}

function lifecycleSource(value: unknown): StoredHookEvent["lifecycleSource"] {
  return value === "startup" || value === "resume" || value === "clear" || value === "compact" || value === "unknown"
    ? value
    : undefined;
}

function hookCategory(value: unknown): StoredHookEvent["category"] {
  return value === "MCP" ? value : undefined;
}

function compactionStage(value: unknown): StoredHookEvent["compactionStage"] {
  return value === "pre" || value === "post" ? value : undefined;
}

function fileIdentityHash(value: unknown): string | undefined {
  const text = stringField(value);
  return text && /^[a-f0-9]{16}$/u.test(text) ? text : undefined;
}

function readKind(value: unknown): StoredHookEvent["readKind"] {
  return value === "full" || value === "partial" ? value : undefined;
}

function feedbackAction(value: unknown): StoredHookEvent["feedbackAction"] {
  return value === "coach" || value === "guard" ? value : undefined;
}

function feedbackExpectedAction(value: unknown): FeedbackExpectedAction | undefined {
  return value === "run_validation" ||
    value === "intervene_before_retry" ||
    value === "summarize_or_narrow" ||
    value === "validate_or_summarize"
    ? value
    : undefined;
}

function feedbackOutcome(value: unknown): FeedbackOutcomeState | undefined {
  return value === "pending" || value === "followed" || value === "ignored" || value === "resolved" || value === "superseded"
    ? value
    : undefined;
}

function feedbackSafeCategory(value: unknown): FeedbackOutcomeSafeCategory | undefined {
  return value === "tests" ||
    value === "lint" ||
    value === "typecheck" ||
    value === "build" ||
    value === "tool" ||
    value === "mcp" ||
    value === "edit" ||
    value === "budget" ||
    value === "activity" ||
    value === "finish"
    ? value
    : undefined;
}

async function acquireStoreLock(storePath: string): Promise<() => Promise<void>> {
  const lockPath = `${storePath}.lock`;
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      await writeFile(
        lockPath,
        `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
        {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx"
        }
      );
      await chmod(lockPath, 0o600);
      return async () => {
        await rm(lockPath, { force: true });
      };
    } catch (error) {
      if (!isErrno(error, "EEXIST")) {
        throw error;
      }
      if (await lockIsStale(lockPath)) {
        await rm(lockPath, { force: true });
        continue;
      }
      await wait(20);
    }
  }
  throw new Error("event store lock timed out");
}

async function lockIsStale(lockPath: string): Promise<boolean> {
  try {
    const lockStat = await stat(lockPath);
    return Date.now() - lockStat.mtimeMs > 5000;
  } catch {
    return true;
  }
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code;
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
