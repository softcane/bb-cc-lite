import type { FeedbackDecision } from "./feedback-policy.js";

export type HookResponse = Record<string, unknown>;

export function responseForFeedback(hookEventName: string, feedback: FeedbackDecision): HookResponse | undefined {
  if (feedback.kind === "none") {
    return undefined;
  }

  if (feedback.kind === "guard") {
    return {
      hookSpecificOutput: {
        hookEventName,
        permissionDecision: "deny",
        permissionDecisionReason: feedback.message
      }
    };
  }

  if (feedback.delivery === "stop_block") {
    return {
      decision: "block",
      reason: feedback.message
    };
  }

  return {
    hookSpecificOutput: {
      hookEventName,
      additionalContext: feedback.message
    }
  };
}
