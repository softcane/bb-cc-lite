import type { DecisionState, FindingSeverity, GaugeLight, StoredDecision } from "./types.js";

// Legacy-state mapping (PRD-03, grill F1). The decide() advisor was deleted; this module is the
// ONE place the retired Healthy/Careful/Stop vocabulary may appear. It exists only to read
// historical records (which still carry advisor fields) and to translate gauge severity for the
// few consumers that still speak the old contract: coach/guard feedback and audit section 2.
// New code reads gauge light + finding category directly and never imports this module to write.

export function legacyStateFromLight(light: GaugeLight | undefined): DecisionState {
  switch (light) {
    case "red":
      return "Stop";
    case "blue":
    case "gray":
      return "Careful";
    default:
      return "Healthy";
  }
}

export function severityFromState(state: DecisionState): FindingSeverity {
  if (state === "Stop") {
    return "red";
  }
  if (state === "Careful") {
    return "blue";
  }
  return "info";
}

export function severityWord(severity: FindingSeverity): string {
  if (severity === "red") {
    return "red";
  }
  if (severity === "blue") {
    return "blue";
  }
  return "green";
}

export interface LegacyDecisionView {
  state: DecisionState;
  reasonCode?: string;
  primaryEvidence?: string;
  confidence?: StoredDecision["confidence"];
}

// Reads a stored decision through the old contract. Historical records keep their advisor `state`
// and `reasonCode`; gauge-era records (which dropped those fields) are read through `light` and
// their top finding category instead.
export function legacyDecisionView(decision: StoredDecision | undefined): LegacyDecisionView | undefined {
  if (!decision) {
    return undefined;
  }
  const topFinding = decision.findings?.[0];
  return {
    state: decision.state ?? legacyStateFromLight(decision.light),
    reasonCode: decision.reasonCode ?? topFinding?.category,
    primaryEvidence: decision.primaryEvidence ?? topFinding?.evidence,
    confidence: decision.confidence ?? topFinding?.confidence
  };
}
