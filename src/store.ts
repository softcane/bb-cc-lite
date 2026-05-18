import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { eventStorePath } from "./paths.js";
import type { Decision, DerivedHookEvent, EventStoreData, StoredDecision, StoredHookEvent, ToolFailureSummary } from "./types.js";

const STORE_LIMIT = 100;
const HOOK_STORE_LIMIT = 500;

export async function readStore(storePath = eventStorePath()): Promise<EventStoreData> {
  try {
    const parsed = JSON.parse(await readFile(storePath, "utf8")) as Partial<EventStoreData>;
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions.filter(isStoredDecision).slice(-STORE_LIMIT) : [],
      hookEvents: Array.isArray(parsed.hookEvents) ? parsed.hookEvents.filter(isStoredHookEvent).slice(-HOOK_STORE_LIMIT) : []
    };
  } catch {
    return { version: 1, updatedAt: new Date(0).toISOString(), decisions: [], hookEvents: [] };
  }
}

export async function recordDecision(decision: Decision, storePath = eventStorePath()): Promise<StoredDecision> {
  const store = await readStore(storePath);
  const stored: StoredDecision = {
    ...decision,
    id: randomUUID()
  };
  store.decisions.push(stored);
  store.decisions = store.decisions.slice(-STORE_LIMIT);
  store.updatedAt = new Date().toISOString();
  await writeStore(store, storePath);
  return stored;
}

export async function recordHookEvent(event: DerivedHookEvent, storePath = eventStorePath()): Promise<StoredHookEvent> {
  const store = await readStore(storePath);
  const stored: StoredHookEvent = {
    ...event,
    id: randomUUID()
  };
  store.hookEvents.push(stored);
  store.hookEvents = store.hookEvents.slice(-HOOK_STORE_LIMIT);
  store.updatedAt = new Date().toISOString();
  await writeStore(store, storePath);
  return stored;
}

export async function latestDecision(sessionKey?: string, storePath = eventStorePath()): Promise<StoredDecision | undefined> {
  const store = await readStore(storePath);
  const decisions = sessionKey ? store.decisions.filter((decision) => decision.sessionKey === sessionKey) : store.decisions;
  return decisions.at(-1);
}

export async function hookSummary(
  sessionKey: string | undefined,
  storePath = eventStorePath()
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

async function writeStore(store: EventStoreData, storePath: string): Promise<void> {
  await mkdir(dirname(storePath), { recursive: true, mode: 0o700 });
  const tempPath = `${storePath}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(tempPath, 0o600);
  await rename(tempPath, storePath);
}

function isStoredDecision(value: unknown): value is StoredDecision {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.state === "string" && typeof record.action === "string";
}

function isStoredHookEvent(value: unknown): value is StoredHookEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.kind === "string" && typeof record.timestamp === "string";
}
