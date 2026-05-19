import type { Decision, DecisionEvidence, DecisionState } from "./types.js";

export interface DecisionPresentation {
  state: DecisionState;
  diagnosis?: string;
  baselineNote?: string;
  primaryEvidence: string;
  evidence: DecisionEvidence[];
  impact: string;
  action: string;
}

export function toDecisionPresentation(decision: Decision): DecisionPresentation {
  return {
    state: decision.state,
    diagnosis: decision.diagnosis,
    baselineNote: decision.baselineNote,
    primaryEvidence: decision.primaryEvidence,
    evidence: decision.evidence,
    impact: decision.impact,
    action: decision.action
  };
}
