import type { Decision, DecisionEvidence, DecisionState } from "./types.js";

export interface DecisionPresentation {
  state: DecisionState;
  primaryEvidence: string;
  evidence: DecisionEvidence[];
  impact: string;
  action: string;
}

export function toDecisionPresentation(decision: Decision): DecisionPresentation {
  return {
    state: decision.state,
    primaryEvidence: decision.primaryEvidence,
    evidence: decision.evidence,
    impact: decision.impact,
    action: decision.action
  };
}
