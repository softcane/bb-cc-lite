import { randomUUID } from "node:crypto";
import {
  HOOK_STORE_LIMIT,
  STORE_LIMIT,
  readStore,
  updateStore
} from "./event-store-persistence.js";
import type { RecentFeedback } from "./feedback-policy.js";
import { eventStorePath } from "./paths.js";
import type { Decision, DerivedHookEvent, StoredDecision, StoredHookEvent } from "./types.js";

export { readStore } from "./event-store-persistence.js";
export { hookSummary, latestDecision } from "./event-store-queries.js";

export async function recordDecision(decision: Decision, storePath = eventStorePath()): Promise<StoredDecision> {
  return updateStore(storePath, (store) => {
    const stored: StoredDecision = {
      ...decision,
      id: randomUUID()
    };
    store.decisions.push(stored);
    store.decisions = store.decisions.slice(-STORE_LIMIT);
    store.updatedAt = new Date().toISOString();
    return { store, result: stored };
  });
}

export async function recordHookEvent(event: DerivedHookEvent, storePath = eventStorePath()): Promise<StoredHookEvent> {
  return updateStore(storePath, (store) => {
    const stored: StoredHookEvent = {
      ...event,
      id: randomUUID()
    };
    store.hookEvents.push(stored);
    store.hookEvents = store.hookEvents.slice(-HOOK_STORE_LIMIT);
    store.updatedAt = new Date().toISOString();
    return { store, result: stored };
  });
}

export async function recordFeedbackEvent(
  event: {
    sessionKey?: string;
    hookEventName: string;
    feedbackAction: "coach" | "guard";
    cooldownKey: string;
    timestamp?: string;
  },
  storePath = eventStorePath()
): Promise<StoredHookEvent> {
  return recordHookEvent(
    {
      kind: "feedback",
      sessionKey: event.sessionKey,
      timestamp: event.timestamp || new Date().toISOString(),
      hookEventName: event.hookEventName,
      feedbackAction: event.feedbackAction,
      cooldownKey: event.cooldownKey
    },
    storePath
  );
}

export async function recentFeedbackEvents(sessionKey: string | undefined, storePath = eventStorePath()): Promise<RecentFeedback[]> {
  if (!sessionKey) {
    return [];
  }
  const store = await readStore(storePath);
  return store.hookEvents
    .filter(
      (event) =>
        event.kind === "feedback" &&
        event.sessionKey === sessionKey &&
        event.cooldownKey &&
        (event.feedbackAction === "coach" || event.feedbackAction === "guard")
    )
    .map((event) => ({
      cooldownKey: event.cooldownKey as string,
      action: event.feedbackAction as "coach" | "guard",
      timestamp: event.timestamp
    }));
}
