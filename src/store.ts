import { randomUUID } from "node:crypto";
import {
  HOOK_STORE_LIMIT,
  STORE_LIMIT,
  readStore,
  writeStore
} from "./event-store-persistence.js";
import { eventStorePath } from "./paths.js";
import type { Decision, DerivedHookEvent, StoredDecision, StoredHookEvent } from "./types.js";

export { readStore } from "./event-store-persistence.js";
export { hookSummary, latestDecision } from "./event-store-queries.js";

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
