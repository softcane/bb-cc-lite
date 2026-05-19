import { latestDecisionForSession } from "./session.js";
import { latestDecision } from "./store.js";
import type { Decision, StoredDecision } from "./types.js";

interface WhyOptions {
  sessionId?: string;
}

export async function getWhyDecision(options: WhyOptions = {}): Promise<StoredDecision | undefined> {
  return options.sessionId ? latestDecisionForSession(options.sessionId) : latestDecision();
}

export function formatWhy(decision: Decision): string {
  const cost =
    decision.costUsd === undefined
      ? ""
      : `\nCost evidence: ${decision.costSource === "estimated" ? "estimated " : ""}$${decision.costUsd.toFixed(4)}.`;
  return [
    `Last decision: ${decision.state}.`,
    `Reason: ${decision.primaryEvidence}. ${decision.impact}.`,
    `Next action: ${decision.action}.${cost}`
  ].join("\n");
}
