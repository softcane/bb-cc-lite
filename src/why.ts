import { latestDecisionForSession } from "./session.js";
import { latestDecision, recentFeedbackOutcomes } from "./store.js";
import type { Decision, StoredDecision, StoredFeedbackOutcome } from "./types.js";

interface WhyOptions {
  sessionId?: string;
}

interface FormatWhyOptions {
  feedbackOutcomes?: StoredFeedbackOutcome[];
  color?: boolean;
}

export interface WhyContext {
  decision?: StoredDecision;
  feedbackOutcomes: StoredFeedbackOutcome[];
}

const RESET = "\u001b[0m";
const BOLD = "\u001b[1m";
const DIM = "\u001b[2m";
const STATE_COLORS: Record<Decision["state"], string> = {
  Healthy: "\u001b[32m",
  Careful: "\u001b[33m",
  Stop: "\u001b[1;31m"
};
const OUTCOME_COLORS: Record<StoredFeedbackOutcome["outcome"], string> = {
  pending: DIM,
  followed: "\u001b[36m",
  ignored: "\u001b[33m",
  resolved: "\u001b[32m",
  superseded: DIM
};

export async function getWhyDecision(options: WhyOptions = {}): Promise<StoredDecision | undefined> {
  return options.sessionId ? latestDecisionForSession(options.sessionId) : latestDecision();
}

export async function getWhyContext(options: WhyOptions = {}): Promise<WhyContext> {
  const decision = await getWhyDecision(options);
  return {
    decision,
    feedbackOutcomes: decision?.sessionKey ? await recentFeedbackOutcomes(decision.sessionKey) : []
  };
}

export function formatWhy(decision: Decision, options: FormatWhyOptions = {}): string {
  const color = options.color === true;
  const cost =
    decision.costUsd === undefined
      ? ""
      : `\nCost evidence: ${decision.costSource === "estimated" ? "estimated " : ""}$${decision.costUsd.toFixed(4)}.`;
  const baseline = baselineWhyLine(decision);
  const feedbackLedger = formatFeedbackLedger(options.feedbackOutcomes || [], color);
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

function formatFeedbackLedger(outcomes: StoredFeedbackOutcome[], color: boolean): string | undefined {
  const outcome = outcomes.filter((candidate) => candidate.kind === "feedback_outcome").at(-1);
  if (!outcome) {
    return undefined;
  }
  const steps = feedbackLedgerSteps(outcome, color);
  if (steps.length === 0) {
    return undefined;
  }
  return [`${colorLabel("Recent bb loop", color)}:`, ...steps.map((step, index) => `${index + 1}. ${step}`)].join("\n");
}

function feedbackLedgerSteps(outcome: StoredFeedbackOutcome, color: boolean): string[] {
  const action = outcome.feedbackAction === "guard" ? "Guard" : "Coach";
  const category = categoryLabel(outcome.safeCategory);
  const steps = [feedbackStep(action, outcome, category)];
  if (outcome.outcome === "resolved") {
    if (isValidationCategory(outcome.safeCategory)) {
      steps.push(`Claude ran ${category}.`);
      steps.push(`${sentenceCategory(outcome.safeCategory)} passed.`);
    } else {
      steps.push("State improved after feedback.");
    }
  } else if (outcome.outcome === "followed") {
    if (outcome.expectedAction === "run_validation" && isValidationCategory(outcome.safeCategory)) {
      steps.push(`Claude ran ${category}.`);
    } else {
      steps.push("Claude changed approach before retrying.");
    }
  } else if (outcome.outcome === "ignored") {
    if (isValidationCategory(outcome.safeCategory)) {
      steps.push(`Claude retried ${category} without an intervention.`);
    } else {
      steps.push("Claude continued the risky flow without the expected intervention.");
    }
  }
  steps.push(`Outcome: ${colorOutcome(outcome.outcome, color)}.`);
  return steps;
}

function feedbackStep(action: string, outcome: StoredFeedbackOutcome, category: string): string {
  switch (outcome.reasonCode) {
    case "edit_without_validation":
      return `${action} feedback: edits needed validation.`;
    case "validation_repeated":
    case "blind_retry_loop":
    case "coach_validation_retry_after_feedback":
      return `${action} feedback: inspect before retrying ${category}.`;
    case "finish_with_unresolved_risk":
      return `${action} feedback: resolve or summarize risk before finishing.`;
    default:
      return `${action} feedback: ${expectedActionLabel(outcome.expectedAction)}.`;
  }
}

function expectedActionLabel(expectedAction: StoredFeedbackOutcome["expectedAction"]): string {
  switch (expectedAction) {
    case "intervene_before_retry":
      return "change approach before retrying";
    case "summarize_or_narrow":
      return "summarize progress or narrow scope";
    case "validate_or_summarize":
      return "validate or summarize the blocker";
    case "run_validation":
      return "run focused validation";
  }
}

function categoryLabel(category: StoredFeedbackOutcome["safeCategory"]): string {
  if (category === "tests") {
    return "tests";
  }
  return category || "the check";
}

function sentenceCategory(category: StoredFeedbackOutcome["safeCategory"]): string {
  const label = categoryLabel(category);
  return `${label.slice(0, 1).toUpperCase()}${label.slice(1)}`;
}

function isValidationCategory(category: StoredFeedbackOutcome["safeCategory"]): boolean {
  return category === "tests" || category === "lint" || category === "typecheck" || category === "build";
}

function colorState(state: Decision["state"], enabled: boolean): string {
  return enabled ? `${STATE_COLORS[state]}${state}${RESET}` : state;
}

function colorOutcome(outcome: StoredFeedbackOutcome["outcome"], enabled: boolean): string {
  return enabled ? `${OUTCOME_COLORS[outcome]}${outcome}${RESET}` : outcome;
}

function colorLabel(label: string, enabled: boolean): string {
  return enabled ? `${BOLD}${label}${RESET}` : label;
}
