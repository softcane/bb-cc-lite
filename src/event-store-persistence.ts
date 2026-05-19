import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { eventStorePath } from "./paths.js";
import type { EventStoreData, StoredDecision, StoredHookEvent } from "./types.js";

export const STORE_LIMIT = 100;
export const HOOK_STORE_LIMIT = 500;

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

export async function writeStore(store: EventStoreData, storePath: string): Promise<void> {
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
