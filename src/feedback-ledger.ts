import type { StoredFeedbackOutcome } from "./types.js";

// Coach/guard feedback-outcome ledger rendering (branch J1). Moved out of the retired `why`
// command into a shared module so audit section 1 can show "feedback -> what Claude did ->
// resolved/ignored" using derived metadata only. No raw prompts, commands, or paths.

const RESET = "[0m";
const BOLD = "[1m";
const DIM = "[2m";
const OUTCOME_COLORS: Record<StoredFeedbackOutcome["outcome"], string> = {
  pending: DIM,
  followed: "[36m",
  ignored: "[33m",
  resolved: "[32m",
  superseded: DIM
};

export interface FeedbackLedgerOptions {
  color?: boolean;
  label?: string;
}

export function formatFeedbackLedger(outcomes: StoredFeedbackOutcome[], options: FeedbackLedgerOptions = {}): string | undefined {
  const color = options.color === true;
  const label = options.label ?? "Recent ccverdict loop";
  const outcome = outcomes.filter((candidate) => candidate.kind === "feedback_outcome").at(-1);
  if (!outcome) {
    return undefined;
  }
  const steps = feedbackLedgerSteps(outcome, color);
  if (steps.length === 0) {
    return undefined;
  }
  return [`${colorLabel(label, color)}:`, ...steps.map((step, index) => `${index + 1}. ${step}`)].join("\n");
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
    case "compaction_goal_preservation":
      return `${action} feedback: restate goal after compaction.`;
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

function colorOutcome(outcome: StoredFeedbackOutcome["outcome"], enabled: boolean): string {
  return enabled ? `${OUTCOME_COLORS[outcome]}${outcome}${RESET}` : outcome;
}

function colorLabel(label: string, enabled: boolean): string {
  return enabled ? `${BOLD}${label}${RESET}` : label;
}
