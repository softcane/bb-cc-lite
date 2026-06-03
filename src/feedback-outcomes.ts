import { updateStore } from "./event-store-persistence.js";
import { eventStorePath } from "./paths.js";
import { isEditTool, isReadSearchTool } from "./tool-metadata.js";
import type {
  FeedbackExpectedAction,
  FeedbackOutcomeRecord,
  FeedbackOutcomeSafeCategory,
  FeedbackOutcomeState,
  StoredFeedbackOutcome,
  StoredHookEvent
} from "./types.js";

export interface FeedbackOutcomeEvaluationOptions {
  hasUnvalidatedEdits?: boolean;
}

export type FeedbackOutcomeUpdate = Pick<FeedbackOutcomeRecord, "outcome" | "timestamp"> &
  Partial<Pick<FeedbackOutcomeRecord, "safeCategory" | "reasonCode" | "stateAfter">>;

const VALIDATION_CATEGORIES = new Set(["tests", "lint", "typecheck", "build"]);

export function expectedActionForFeedback(reasonCode: string): FeedbackExpectedAction {
  if (
    reasonCode === "validation_repeated" ||
    reasonCode === "blind_retry_loop" ||
    reasonCode === "coach_validation_retry_after_feedback"
  ) {
    return "intervene_before_retry";
  }
  if (reasonCode.startsWith("budget_") || reasonCode === "cost_budget" || reasonCode === "duration_budget") {
    return "summarize_or_narrow";
  }
  if (reasonCode === "compaction_goal_preservation") {
    return "summarize_or_narrow";
  }
  if (reasonCode === "finish_with_unresolved_risk") {
    return "validate_or_summarize";
  }
  return "run_validation";
}

export function evaluateFeedbackOutcome(
  feedback: StoredFeedbackOutcome,
  events: StoredHookEvent[],
  options: FeedbackOutcomeEvaluationOptions = {}
): FeedbackOutcomeUpdate | undefined {
  const laterEvents = events
    .filter((event) => event.timestamp > feedback.timestamp && event.kind !== "feedback")
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));

  if (feedback.expectedAction === "run_validation") {
    return evaluateValidationExpectation(feedback, laterEvents, options);
  }
  if (feedback.expectedAction === "intervene_before_retry") {
    return evaluateRetryExpectation(feedback, laterEvents);
  }
  if (feedback.expectedAction === "validate_or_summarize") {
    return evaluateValidationOrSummaryExpectation(feedback, laterEvents, options);
  }
  return undefined;
}

export async function refreshFeedbackOutcomesForSession(
  sessionKey: string | undefined,
  storePath = eventStorePath(),
  options: FeedbackOutcomeEvaluationOptions = {}
): Promise<void> {
  if (!sessionKey) {
    return;
  }
  await updateStore(storePath, (store) => {
    const events = store.hookEvents.filter((event) => event.sessionKey === sessionKey);
    let changed = false;
    store.feedbackOutcomes = store.feedbackOutcomes.map((outcome) => {
      if (outcome.sessionKey !== sessionKey || outcome.outcome === "resolved" || outcome.outcome === "superseded") {
        return outcome;
      }
      const update = evaluateFeedbackOutcome(outcome, events, options);
      if (!update || !shouldApplyUpdate(outcome, update.outcome)) {
        return outcome;
      }
      changed = true;
      return {
        ...outcome,
        ...update,
        reasonCode: update.reasonCode || outcome.reasonCode,
        safeCategory: update.safeCategory || outcome.safeCategory
      };
    });
    if (changed) {
      store.updatedAt = new Date().toISOString();
    }
    return { store, result: undefined };
  });
}

export function statuslineFeedbackNote(outcome: StoredFeedbackOutcome | undefined): string | undefined {
  if (!outcome) {
    return undefined;
  }
  if (outcome.outcome === "resolved") {
    return "validation resolved";
  }
  if (outcome.outcome === "followed") {
    return "feedback followed";
  }
  if (outcome.outcome === "ignored") {
    return "feedback ignored";
  }
  return undefined;
}

function evaluateValidationExpectation(
  feedback: StoredFeedbackOutcome,
  events: StoredHookEvent[],
  options: FeedbackOutcomeEvaluationOptions
): FeedbackOutcomeUpdate | undefined {
  for (const event of events) {
    const validation = validationEvent(event);
    if (validation) {
      return {
        outcome: event.kind === "tool_success" ? "resolved" : "followed",
        timestamp: event.timestamp,
        safeCategory: validation,
        stateAfter: event.kind === "tool_success" ? "Healthy" : "Careful"
      };
    }
    if ((event.kind === "stop" || event.kind === "session_end") && options.hasUnvalidatedEdits) {
      return {
        outcome: "ignored",
        timestamp: event.timestamp,
        stateAfter: "Careful"
      };
    }
  }
  return undefined;
}

function evaluateRetryExpectation(feedback: StoredFeedbackOutcome, events: StoredHookEvent[]): FeedbackOutcomeUpdate | undefined {
  const expectedCategory = validationCategory(feedback.safeCategory);
  let intervention: StoredHookEvent | undefined;

  for (const event of events) {
    const validation = validationEvent(event);
    if (validation && validation === expectedCategory) {
      if (event.kind === "tool_success") {
        return {
          outcome: "resolved",
          timestamp: event.timestamp,
          safeCategory: validation,
          stateAfter: "Healthy"
        };
      }
      if (intervention || feedback.outcome === "followed") {
        return {
          outcome: "followed",
          timestamp: intervention?.timestamp || event.timestamp,
          safeCategory: validation,
          stateAfter: "Careful"
        };
      }
      return {
        outcome: "ignored",
        timestamp: event.timestamp,
        safeCategory: validation,
        stateAfter: "Stop"
      };
    }
    if (isIntervention(event)) {
      intervention = intervention || event;
    }
  }

  if (intervention && feedback.outcome === "pending") {
    return {
      outcome: "followed",
      timestamp: intervention.timestamp,
      stateAfter: "Careful"
    };
  }
  return undefined;
}

function evaluateValidationOrSummaryExpectation(
  feedback: StoredFeedbackOutcome,
  events: StoredHookEvent[],
  options: FeedbackOutcomeEvaluationOptions
): FeedbackOutcomeUpdate | undefined {
  const validation = evaluateValidationExpectation(feedback, events, options);
  if (validation) {
    return validation;
  }
  const intervention = events.find(isIntervention);
  return intervention
    ? {
        outcome: "followed",
        timestamp: intervention.timestamp,
        stateAfter: "Careful"
      }
    : undefined;
}

function shouldApplyUpdate(current: StoredFeedbackOutcome, nextOutcome: FeedbackOutcomeState): boolean {
  if (current.outcome === nextOutcome) {
    return false;
  }
  if (current.outcome === "ignored" && nextOutcome !== "resolved") {
    return false;
  }
  if (current.outcome === "followed" && nextOutcome === "ignored") {
    return false;
  }
  return true;
}

function validationEvent(event: StoredHookEvent): Extract<FeedbackOutcomeSafeCategory, "tests" | "lint" | "typecheck" | "build"> | undefined {
  if ((event.kind !== "tool_success" && event.kind !== "tool_failure") || event.toolName !== "Bash") {
    return undefined;
  }
  return validationCategory(event.purpose);
}

function validationCategory(value: string | undefined): Extract<FeedbackOutcomeSafeCategory, "tests" | "lint" | "typecheck" | "build"> | undefined {
  return value && VALIDATION_CATEGORIES.has(value)
    ? (value as Extract<FeedbackOutcomeSafeCategory, "tests" | "lint" | "typecheck" | "build">)
    : undefined;
}

function isIntervention(event: StoredHookEvent): boolean {
  if (event.kind !== "tool_success" && event.kind !== "tool_failure") {
    return false;
  }
  if (event.kind !== "tool_success") {
    return false;
  }
  if (validationEvent(event)) {
    return false;
  }
  return isEditTool(event.toolName || "tool") || isReadSearchTool(event.toolName || "tool") || event.toolName !== "Bash";
}
