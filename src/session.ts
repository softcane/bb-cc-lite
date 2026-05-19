import { hashValue } from "./paths.js";
import { latestDecision } from "./store.js";
import type { StoredDecision } from "./types.js";

export function sessionKeyFromId(sessionId: string | undefined): string | undefined {
  return hashValue(sessionId);
}

export async function latestDecisionForSession(sessionId: string | undefined): Promise<StoredDecision | undefined> {
  return latestDecision(sessionKeyFromId(sessionId));
}
