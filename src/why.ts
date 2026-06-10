import { formatFeedbackLedger } from "./feedback-ledger.js";
import type { Decision, StoredDecision, StoredFeedbackOutcome } from "./types.js";

// `why` the command is retired (folded into `audit`); these pure formatters survive because the
// parallel decide() layer (PRD-01) and its characterization tests still render decisions through
// them. The feedback-outcome ledger now lives in ./feedback-ledger.ts and renders in audit.

interface FormatWhyOptions {
  feedbackOutcomes?: StoredFeedbackOutcome[];
  color?: boolean;
}

const RESET = "[0m";
const BOLD = "[1m";
const STATE_COLORS: Record<Decision["state"], string> = {
  Healthy: "[32m",
  Careful: "[33m",
  Stop: "[1;31m"
};

export function formatWhy(decision: Decision, options: FormatWhyOptions = {}): string {
  const color = options.color === true;
  const cost =
    decision.costUsd === undefined
      ? ""
      : `\nCost evidence: ${decision.costSource === "estimated" ? "estimated " : ""}$${decision.costUsd.toFixed(4)}.`;
  const baseline = baselineWhyLine(decision);
  const feedbackLedger = formatFeedbackLedger(options.feedbackOutcomes || [], { color });
  return [
    `Last decision: ${colorState(decision.state, color)}.`,
    `${colorLabel("Reason", color)}: ${decision.primaryEvidence}. ${decision.impact}.`,
    baseline,
    feedbackLedger,
    `${colorLabel("Next action", color)}: ${decision.action}.${cost}`
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatWhyJson(decision: StoredDecision | Decision, feedbackOutcomes: StoredFeedbackOutcome[] = []): Decision & {
  feedbackOutcomes: StoredFeedbackOutcome[];
} {
  return {
    ...decision,
    feedbackOutcomes
  };
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

export function shouldColorWhy(env: NodeJS.ProcessEnv = process.env, isTty = Boolean(process.stdout.isTTY)): boolean {
  return isTty && !env.NO_COLOR && env.BB_CC_LITE_COLOR !== "0";
}

function colorState(state: Decision["state"], enabled: boolean): string {
  return enabled ? `${STATE_COLORS[state]}${state}${RESET}` : state;
}

function colorLabel(label: string, enabled: boolean): string {
  return enabled ? `${BOLD}${label}${RESET}` : label;
}
