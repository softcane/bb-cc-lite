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
  const baseline = baselineWhyLine(decision);
  return [
    `Last decision: ${decision.state}.`,
    `Reason: ${decision.primaryEvidence}. ${decision.impact}.`,
    baseline,
    `Next action: ${decision.action}.${cost}`
  ]
    .filter(Boolean)
    .join("\n");
}

function baselineWhyLine(decision: Decision): string | undefined {
  if (!decision.baselineNote) {
    return undefined;
  }
  if (decision.diagnosisCode === "read_heavy_debugging") {
    return "Baseline: similar research-heavy sessions usually ended OK.";
  }
  return `Baseline: ${decision.baselineNote}.`;
}
