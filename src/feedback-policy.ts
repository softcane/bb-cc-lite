import type { LegacyDecisionView } from "./legacy-state.js";
import type { DecisionConfidence, ReadKind, TranscriptSummary } from "./types.js";

export type FeedbackMode = "observe" | "coach" | "guard";
export type FeedbackDelivery = "additional_context" | "stop_block";
export type FeedbackSafeCategory = "tests" | "lint" | "typecheck" | "build" | "tool" | "mcp" | "edit" | "budget" | "activity" | "finish";

export interface RecentFeedback {
  cooldownKey: string;
  action: "coach" | "guard";
  timestamp: string;
}

export interface CurrentHookTool {
  toolName: string;
  purpose?: string;
  fileIdentityHash?: string;
  readKind?: ReadKind;
}

export interface FeedbackPolicyInput {
  mode: FeedbackMode;
  hookEventName: string;
  // Read through the legacy-state mapping: gauge-era records lack advisor reasonCode/primaryEvidence,
  // so those fields are optional here. The only place old vocabulary still enters this consumer.
  decision?: LegacyDecisionView;
  summary: TranscriptSummary;
  currentTool?: CurrentHookTool;
  recentFeedback: RecentFeedback[];
  stopHookActive?: boolean;
}

export type FeedbackDecision =
  | { kind: "none" }
  | {
      kind: "coach";
      delivery: FeedbackDelivery;
      reasonCode: string;
      safeCategory: FeedbackSafeCategory;
      confidence: DecisionConfidence;
      messageKey: string;
      cooldownKey: string;
      message: string;
    }
  | {
      kind: "guard";
      reasonCode: string;
      safeCategory: FeedbackSafeCategory;
      confidence: "high";
      messageKey: string;
      cooldownKey: string;
      message: string;
    };

const VALIDATION_PURPOSES = new Set(["tests", "lint", "typecheck", "build"]);

export function decideFeedback(input: FeedbackPolicyInput): FeedbackDecision {
  if (input.mode === "observe") {
    return { kind: "none" };
  }

  if (input.hookEventName === "Stop") {
    return stopFeedback(input);
  }

  if (input.hookEventName === "PreCompact") {
    return { kind: "none" };
  }

  const compactionGoalPreservation = postCompactionGoalPreservationFeedback(input);
  if (compactionGoalPreservation) {
    return compactionGoalPreservation;
  }

  const readRepeat = redundantReadFeedback(input);
  if (readRepeat) {
    return readRepeat;
  }

  const coachRetryWarning = coachValidationRetryWarning(input);
  if (coachRetryWarning) {
    return coachRetryWarning;
  }

  if (input.mode === "guard" && input.hookEventName === "PreToolUse") {
    const guard = guardFeedback(input);
    if (guard.kind !== "none") {
      return guard;
    }
    if (!isValidationTool(input.currentTool)) {
      return { kind: "none" };
    }
  }

  if (input.decision?.state === "Healthy" || hasFreshValidationSuccess(input.summary)) {
    return { kind: "none" };
  }

  const risk = strongestRisk(input);
  if (!risk) {
    return { kind: "none" };
  }
  const cooldownKey = `coach:${risk.reasonCode}:${risk.safeCategory}`;
  if (hasRecentCooldown(input.recentFeedback, cooldownKey)) {
    return { kind: "none" };
  }
  return {
    kind: "coach",
    delivery: "additional_context",
    reasonCode: risk.reasonCode,
    safeCategory: risk.safeCategory,
    confidence: risk.confidence,
    messageKey: risk.messageKey,
    cooldownKey,
    message: messageFor(risk.messageKey)
  };
}

function postCompactionGoalPreservationFeedback(input: FeedbackPolicyInput): FeedbackDecision | undefined {
  if (input.hookEventName !== "PostCompact" || input.summary.compactionEvents <= 0) {
    return undefined;
  }
  const cooldownKey = `coach:compaction_goal_preservation:${input.summary.latestCompactionTimestamp || "current"}`;
  if (hasRecentCooldown(input.recentFeedback, cooldownKey)) {
    return undefined;
  }
  return {
    kind: "coach",
    delivery: "additional_context",
    reasonCode: "compaction_goal_preservation",
    safeCategory: "activity",
    confidence: "medium",
    messageKey: "compaction_goal_preservation",
    cooldownKey,
    message: messageFor("compaction_goal_preservation")
  };
}

function guardFeedback(input: FeedbackPolicyInput): FeedbackDecision {
  const readGuard = redundantReadGuardFeedback(input);
  if (readGuard) {
    return readGuard;
  }

  const currentCategory = validationCategory(input.currentTool?.purpose);
  if (!currentCategory || input.currentTool?.toolName !== "Bash") {
    return { kind: "none" };
  }
  const blindRetry = input.summary.blindRetry;
  const repeated = strongestRepeatedValidationFailure(input.summary);
  const isHighConfidenceRetry =
    !input.summary.hasUnvalidatedEdits &&
    ((blindRetry?.category === currentCategory && blindRetry.blindRetryFailureCount >= 3) ||
      (repeated?.safeCategory === currentCategory && repeated.count >= 3));
  if (!isHighConfidenceRetry) {
    return { kind: "none" };
  }

  const cooldownKey = `guard:guard_validation_retry:${currentCategory}`;
  return {
    kind: "guard",
    reasonCode: "guard_validation_retry",
    safeCategory: currentCategory,
    confidence: "high",
    messageKey: "guard_validation_retry",
    cooldownKey,
    message: messageFor("guard_validation_retry")
  };
}

function redundantReadFeedback(input: FeedbackPolicyInput): FeedbackDecision | undefined {
  if (input.hookEventName !== "PreToolUse" || input.currentTool?.toolName !== "Read") {
    return undefined;
  }
  if (input.mode === "guard") {
    return redundantReadGuardFeedback(input);
  }
  if (input.mode !== "coach") {
    return undefined;
  }
  const repeat = repeatedFullFileReadForCurrentTool(input);
  if (!repeat) {
    return undefined;
  }
  const cooldownKey = `coach:redundant_read:${repeat.fileIdentityHash}`;
  if (hasRecentCooldown(input.recentFeedback, cooldownKey)) {
    return undefined;
  }
  return {
    kind: "coach",
    delivery: "additional_context",
    reasonCode: "redundant_read",
    safeCategory: "tool",
    confidence: "medium",
    messageKey: "redundant_read",
    cooldownKey,
    message: messageFor("redundant_read")
  };
}

function redundantReadGuardFeedback(input: FeedbackPolicyInput): FeedbackDecision | undefined {
  const repeat = repeatedFullFileReadForCurrentTool(input);
  if (!repeat) {
    return undefined;
  }
  return {
    kind: "guard",
    reasonCode: "guard_redundant_read",
    safeCategory: "tool",
    confidence: "high",
    messageKey: "guard_redundant_read",
    cooldownKey: `guard:guard_redundant_read:${repeat.fileIdentityHash}`,
    message: messageFor("guard_redundant_read")
  };
}

function repeatedFullFileReadForCurrentTool(input: FeedbackPolicyInput): { fileIdentityHash: string; count: number } | undefined {
  if (
    input.hookEventName !== "PreToolUse" ||
    input.currentTool?.toolName !== "Read" ||
    input.currentTool.readKind !== "full" ||
    !input.currentTool.fileIdentityHash
  ) {
    return undefined;
  }

  const match = input.summary.activeFullFileReads?.find(
    (read) => read.fileIdentityHash === input.currentTool?.fileIdentityHash && read.unchangedFullFileReadCount >= 1
  );
  return match
    ? {
        fileIdentityHash: match.fileIdentityHash,
        count: match.unchangedFullFileReadCount
      }
    : undefined;
}

function coachValidationRetryWarning(input: FeedbackPolicyInput): FeedbackDecision | undefined {
  if (input.mode !== "coach" || input.hookEventName !== "PreToolUse" || !isValidationTool(input.currentTool)) {
    return undefined;
  }
  const category = validationCategory(input.currentTool?.purpose);
  if (!category || input.summary.hasUnvalidatedEdits) {
    return undefined;
  }
  const blindRetry = input.summary.blindRetry;
  const repeated = strongestRepeatedValidationFailure(input.summary);
  const isRetryAfterFailure =
    (blindRetry?.category === category && blindRetry.blindRetryFailureCount >= 2) ||
    (repeated?.safeCategory === category && repeated.count >= 2);
  if (!isRetryAfterFailure) {
    return undefined;
  }
  const priorCoachWasIgnored = input.recentFeedback.some(
    (feedback) =>
      feedback.action === "coach" &&
      (feedback.cooldownKey === `coach:validation_repeated:${category}` ||
        feedback.cooldownKey === `coach:blind_retry_loop:${category}` ||
        feedback.cooldownKey === `coach:coach_validation_retry_after_feedback:${category}`)
  );
  if (!priorCoachWasIgnored) {
    return undefined;
  }
  return {
    kind: "coach",
    delivery: "additional_context",
    reasonCode: "coach_validation_retry_after_feedback",
    safeCategory: category,
    confidence: blindRetry && blindRetry.blindRetryFailureCount >= 3 ? "high" : "medium",
    messageKey: "coach_validation_retry_after_feedback",
    cooldownKey: `coach:coach_validation_retry_after_feedback:${category}`,
    message: messageFor("coach_validation_retry_after_feedback")
  };
}

function stopFeedback(input: FeedbackPolicyInput): FeedbackDecision {
  if (input.stopHookActive || input.decision?.state === "Healthy") {
    return { kind: "none" };
  }
  const hasUnresolvedRisk =
    input.decision?.state === "Stop" ||
    input.decision?.reasonCode === "blind_retry" ||
    input.decision?.reasonCode === "tool_failure_repeated" ||
    input.summary.hasUnvalidatedEdits ||
    Boolean(input.summary.blindRetry && input.summary.blindRetry.blindRetryFailureCount >= 2) ||
    Boolean(strongestRepeatedValidationFailure(input.summary));
  if (!hasUnresolvedRisk) {
    return { kind: "none" };
  }

  const cooldownKey = "coach:finish_with_unresolved_risk:finish";
  if (hasRecentCooldown(input.recentFeedback, cooldownKey)) {
    return { kind: "none" };
  }
  return {
    kind: "coach",
    delivery: "stop_block",
    reasonCode: "finish_with_unresolved_risk",
    safeCategory: "finish",
    confidence: "medium",
    messageKey: "finish_with_unresolved_risk",
    cooldownKey,
    message: messageFor("finish_with_unresolved_risk")
  };
}

function strongestRisk(input: FeedbackPolicyInput):
  | {
      reasonCode: string;
      safeCategory: FeedbackSafeCategory;
      confidence: DecisionConfidence;
      messageKey: string;
    }
  | undefined {
  const blindRetry = input.summary.blindRetry;
  if (blindRetry && blindRetry.blindRetryFailureCount >= 3) {
    return {
      reasonCode: "blind_retry_loop",
      safeCategory: safeCategoryForFailureCategory(blindRetry.category),
      confidence: "high",
      messageKey: "blind_retry_loop"
    };
  }

  if (blindRetry && blindRetry.blindRetryFailureCount >= 2) {
    return {
      reasonCode: "validation_repeated",
      safeCategory: safeCategoryForFailureCategory(blindRetry.category),
      confidence: "medium",
      messageKey: "validation_repeated"
    };
  }

  const repeated = strongestRepeatedValidationFailure(input.summary);
  if (repeated && repeated.count >= 2) {
    return {
      reasonCode: "validation_repeated",
      safeCategory: repeated.safeCategory,
      confidence: repeated.count >= 3 ? "high" : "medium",
      messageKey: "validation_repeated"
    };
  }

  if (input.summary.hasUnvalidatedEdits) {
    return {
      reasonCode: "edit_without_validation",
      safeCategory: "edit",
      confidence: "medium",
      messageKey: "edit_without_validation"
    };
  }

  if (input.decision?.reasonCode === "budget_busy_no_observed_progress") {
    return {
      reasonCode: "budget_busy_no_observed_progress",
      safeCategory: "budget",
      confidence: "medium",
      messageKey: "budget_busy_no_observed_progress"
    };
  }
  if (input.decision?.reasonCode === "cost_budget" || input.decision?.reasonCode === "duration_budget") {
    return {
      reasonCode: input.decision.reasonCode,
      safeCategory: "budget",
      confidence: "medium",
      messageKey: "budget_summary"
    };
  }
  if (input.decision?.reasonCode === "busy_no_observed_progress") {
    return {
      reasonCode: "busy_no_observed_progress",
      safeCategory: "activity",
      confidence: "medium",
      messageKey: "busy_no_observed_progress"
    };
  }

  return undefined;
}

function strongestRepeatedValidationFailure(
  summary: TranscriptSummary
): { safeCategory: Extract<FeedbackSafeCategory, "tests" | "lint" | "typecheck" | "build">; count: number } | undefined {
  return summary.repeatedFailures
    .flatMap((failure) => {
      const purpose = validationCategory(failure.purpose);
      return failure.toolName === "Bash" && purpose ? [{ safeCategory: purpose, count: failure.count }] : [];
    })
    .sort((left, right) => right.count - left.count)[0];
}

function hasFreshValidationSuccess(summary: TranscriptSummary): boolean {
  return summary.validationRecovered || (summary.validationSuccesses || 0) > 0;
}

function isValidationTool(tool: CurrentHookTool | undefined): boolean {
  return tool?.toolName === "Bash" && validationCategory(tool.purpose) !== undefined;
}

function validationCategory(value: string | undefined): Extract<FeedbackSafeCategory, "tests" | "lint" | "typecheck" | "build"> | undefined {
  return value && VALIDATION_PURPOSES.has(value)
    ? (value as Extract<FeedbackSafeCategory, "tests" | "lint" | "typecheck" | "build">)
    : undefined;
}

function safeCategoryForFailureCategory(category: string): FeedbackSafeCategory {
  if (category === "tests" || category === "lint" || category === "typecheck" || category === "build") {
    return category;
  }
  if (category === "mcp") {
    return "mcp";
  }
  return "tool";
}

function hasRecentCooldown(recentFeedback: RecentFeedback[], cooldownKey: string): boolean {
  return recentFeedback.some((feedback) => feedback.cooldownKey === cooldownKey);
}

function messageFor(messageKey: string): string {
  switch (messageKey) {
    case "blind_retry_loop":
      return "ccverdict: the same safe validation category has failed repeatedly without a fix. Inspect the first failure and change approach before retrying.";
    case "validation_repeated":
      return "ccverdict: validation has failed repeatedly without a passing check. Inspect the failure pattern, make one targeted fix, then run one focused check.";
    case "coach_validation_retry_after_feedback":
      return "ccverdict: do not run the same validation check again yet. First inspect the failure, change the approach, or summarize the blocker; only rerun after a targeted fix.";
    case "edit_without_validation":
      return "ccverdict: edits have not been validated yet; run one focused validation check before finishing or making more broad changes.";
    case "budget_busy_no_observed_progress":
      return "ccverdict: budget is high and no safe progress signal was observed. Narrow the scope or summarize the blocker before continuing.";
    case "budget_summary":
      return "ccverdict: budget is high for this session; summarize progress, name the next smallest check, and avoid broad retries.";
    case "busy_no_observed_progress":
      return "ccverdict: many tool calls have run without a safe progress signal. Pause, state what changed, and choose one focused next step.";
    case "compaction_goal_preservation":
      return "ccverdict: compaction just finished. Before continuing, restate the current goal, key constraints, and next three steps from existing context.";
    case "redundant_read":
      return "ccverdict: this file was already read recently and no edit/write was seen. Use existing context or read a specific range if needed.";
    case "guard_redundant_read":
      return "ccverdict denied this Read: this file was already read recently and no edit/write was seen. Read a specific range if needed.";
    case "guard_validation_retry":
      return "ccverdict denied this retry: the same validation category has failed repeatedly without an edit or passing check. Inspect before retrying.";
    case "finish_with_unresolved_risk":
      return "ccverdict: unresolved validation risk remains. Run one focused check or summarize the blocker before finishing.";
    default:
      return "ccverdict: inspect the latest safe risk signal before continuing.";
  }
}
