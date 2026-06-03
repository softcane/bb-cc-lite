import { describe, expect, it } from "vitest";
import { decideFeedback, type FeedbackPolicyInput } from "../src/feedback-policy.js";
import type { StoredDecision, TranscriptSummary } from "../src/types.js";

describe("feedback policy", () => {
  it("emits one coach note for repeated validation failure", () => {
    const feedback = decideFeedback(policyInput({ summary: repeatedTestFailureSummary(2) }));

    expect(feedback).toMatchObject({
      kind: "coach",
      delivery: "additional_context",
      reasonCode: "validation_repeated",
      safeCategory: "tests",
      cooldownKey: "coach:validation_repeated:tests"
    });
    expect(feedback.kind === "coach" ? feedback.message : "").toContain("validation has failed repeatedly");
  });

  it("emits no coach note for a healthy session", () => {
    const feedback = decideFeedback(policyInput({ decision: decision({ state: "Healthy", reasonCode: "healthy" }) }));

    expect(feedback).toEqual({ kind: "none" });
  });

  it("dedupes repeated coach notes by cooldown key", () => {
    const feedback = decideFeedback(
      policyInput({
        summary: repeatedTestFailureSummary(2),
        recentFeedback: [{ cooldownKey: "coach:validation_repeated:tests", action: "coach", timestamp: "2026-05-23T00:00:00.000Z" }]
      })
    );

    expect(feedback).toEqual({ kind: "none" });
  });

  it("escalates coach feedback before the next blind validation retry even after a prior coach note", () => {
    const feedback = decideFeedback(
      policyInput({
        hookEventName: "PreToolUse",
        currentTool: { toolName: "Bash", purpose: "tests" },
        summary: repeatedTestFailureSummary(2),
        recentFeedback: [{ cooldownKey: "coach:validation_repeated:tests", action: "coach", timestamp: "2026-05-23T00:00:00.000Z" }]
      })
    );

    expect(feedback).toMatchObject({
      kind: "coach",
      delivery: "additional_context",
      reasonCode: "coach_validation_retry_after_feedback",
      safeCategory: "tests",
      cooldownKey: "coach:coach_validation_retry_after_feedback:tests"
    });
    expect(feedback.kind === "coach" ? feedback.message : "").toContain("do not run the same validation check again yet");
  });

  it("emits stronger coach feedback for blind retry loops", () => {
    const feedback = decideFeedback(policyInput({ summary: repeatedTestFailureSummary(3) }));

    expect(feedback).toMatchObject({
      kind: "coach",
      reasonCode: "blind_retry_loop",
      safeCategory: "tests",
      confidence: "high",
      cooldownKey: "coach:blind_retry_loop:tests"
    });
    expect(feedback.kind === "coach" ? feedback.message : "").toContain("change approach before retrying");
  });

  it("emits coach feedback for edits without validation", () => {
    const feedback = decideFeedback(policyInput({ summary: transcriptSummary({ hasUnvalidatedEdits: true, successfulEditResults: 2 }) }));

    expect(feedback).toMatchObject({
      kind: "coach",
      reasonCode: "edit_without_validation",
      safeCategory: "edit"
    });
    expect(feedback.kind === "coach" ? feedback.message : "").toContain("run one focused validation check");
  });

  it("suppresses coach feedback after passing validation", () => {
    const feedback = decideFeedback(
      policyInput({
        summary: transcriptSummary({
          validationChecks: 3,
          validationSuccesses: 1,
          validationRecovered: true
        }),
        decision: decision({ state: "Healthy", reasonCode: "validation_recovered" })
      })
    );

    expect(feedback).toEqual({ kind: "none" });
  });

  it("emits generic fallback guidance after PostCompact", () => {
    const feedback = decideFeedback(
      policyInput({
        hookEventName: "PostCompact",
        decision: decision({ state: "Healthy", reasonCode: "healthy" }),
        summary: transcriptSummary({
          compactionEvents: 1,
          postCompactionActivity: 0,
          latestCompactionTimestamp: "2026-06-03T10:00:00.000Z"
        })
      })
    );

    expect(feedback).toMatchObject({
      kind: "coach",
      delivery: "additional_context",
      reasonCode: "compaction_goal_preservation",
      safeCategory: "activity",
      cooldownKey: "coach:compaction_goal_preservation:2026-06-03T10:00:00.000Z"
    });
    expect(feedback.kind === "coach" ? feedback.message : "").toContain("restate the current goal");
  });

  it("does not emit direct PreCompact guidance", () => {
    const feedback = decideFeedback(
      policyInput({
        hookEventName: "PreCompact",
        summary: transcriptSummary({
          compactionEvents: 1,
          latestCompactionTimestamp: "2026-06-03T10:00:00.000Z",
          hasUnvalidatedEdits: true,
          successfulEditResults: 1
        })
      })
    );

    expect(feedback).toEqual({ kind: "none" });
  });

  it("emits budget feedback only when a budget decision is already present", () => {
    const highCost = decideFeedback(
      policyInput({
        decision: decision({ state: "Careful", reasonCode: "cost_budget", primaryEvidence: "estimated cost $2.25" })
      })
    );
    const normal = decideFeedback(policyInput({ decision: decision({ state: "Healthy", reasonCode: "healthy" }) }));

    expect(highCost).toMatchObject({
      kind: "coach",
      reasonCode: "cost_budget",
      safeCategory: "budget"
    });
    expect(highCost.kind === "coach" ? highCost.message : "").toContain("summarize progress");
    expect(normal).toEqual({ kind: "none" });
  });

  it("denies only high-confidence repeated validation retries in guard mode", () => {
    const denied = decideFeedback(
      policyInput({
        mode: "guard",
        hookEventName: "PreToolUse",
        currentTool: { toolName: "Bash", purpose: "tests" },
        summary: repeatedTestFailureSummary(3)
      })
    );
    const readAllowed = decideFeedback(
      policyInput({
        mode: "guard",
        hookEventName: "PreToolUse",
        currentTool: { toolName: "Read" },
        summary: repeatedTestFailureSummary(3)
      })
    );
    const editAllowed = decideFeedback(
      policyInput({
        mode: "guard",
        hookEventName: "PreToolUse",
        currentTool: { toolName: "Edit" },
        summary: repeatedTestFailureSummary(3)
      })
    );

    expect(denied).toMatchObject({
      kind: "guard",
      reasonCode: "guard_validation_retry",
      safeCategory: "tests",
      cooldownKey: "guard:guard_validation_retry:tests"
    });
    expect(denied.kind === "guard" ? denied.message : "").toContain("denied this retry");
    expect(readAllowed).toEqual({ kind: "none" });
    expect(editAllowed).toEqual({ kind: "none" });
  });

  it("coaches before an unchanged repeated full-file Read", () => {
    const feedback = decideFeedback(
      policyInput({
        hookEventName: "PreToolUse",
        currentTool: { toolName: "Read", fileIdentityHash: "feedface00000000", readKind: "full" },
        summary: transcriptSummary({
          activeFullFileReads: [{ fileIdentityHash: "feedface00000000", unchangedFullFileReadCount: 1 }]
        })
      })
    );

    expect(feedback).toMatchObject({
      kind: "coach",
      delivery: "additional_context",
      reasonCode: "redundant_read",
      safeCategory: "tool",
      cooldownKey: "coach:redundant_read:feedface00000000"
    });
    expect(feedback.kind === "coach" ? feedback.message : "").toContain("already read recently");
  });

  it("denies unchanged repeated full-file Reads in guard mode but allows partial Reads", () => {
    const summary = transcriptSummary({
      activeFullFileReads: [{ fileIdentityHash: "feedface00000000", unchangedFullFileReadCount: 1 }]
    });
    const denied = decideFeedback(
      policyInput({
        mode: "guard",
        hookEventName: "PreToolUse",
        currentTool: { toolName: "Read", fileIdentityHash: "feedface00000000", readKind: "full" },
        summary
      })
    );
    const partial = decideFeedback(
      policyInput({
        mode: "guard",
        hookEventName: "PreToolUse",
        currentTool: { toolName: "Read", fileIdentityHash: "feedface00000000", readKind: "partial" },
        summary
      })
    );

    expect(denied).toMatchObject({
      kind: "guard",
      reasonCode: "guard_redundant_read",
      safeCategory: "tool",
      cooldownKey: "guard:guard_redundant_read:feedface00000000"
    });
    expect(denied.kind === "guard" ? denied.message : "").toContain("denied this Read");
    expect(partial).toEqual({ kind: "none" });
  });

  it("suppresses observe-only Read feedback", () => {
    const feedback = decideFeedback(
      policyInput({
        mode: "observe",
        hookEventName: "PreToolUse",
        currentTool: { toolName: "Read", fileIdentityHash: "feedface00000000", readKind: "full" },
        summary: transcriptSummary({
          activeFullFileReads: [{ fileIdentityHash: "feedface00000000", unchangedFullFileReadCount: 1 }]
        })
      })
    );

    expect(feedback).toEqual({ kind: "none" });
  });

  it("keeps denying repeated guard validation retries until there is an intervention", () => {
    const denied = decideFeedback(
      policyInput({
        mode: "guard",
        hookEventName: "PreToolUse",
        currentTool: { toolName: "Bash", purpose: "tests" },
        summary: repeatedTestFailureSummary(3),
        recentFeedback: [{ cooldownKey: "guard:guard_validation_retry:tests", action: "guard", timestamp: "2026-05-23T00:00:00.000Z" }]
      })
    );

    expect(denied).toMatchObject({
      kind: "guard",
      reasonCode: "guard_validation_retry",
      safeCategory: "tests"
    });
  });

  it("blocks an unsafe finish once and respects active stop-hook state", () => {
    const blocked = decideFeedback(
      policyInput({
        hookEventName: "Stop",
        decision: decision({ state: "Stop", reasonCode: "blind_retry_loop" }),
        summary: repeatedTestFailureSummary(3)
      })
    );
    const active = decideFeedback(
      policyInput({
        hookEventName: "Stop",
        stopHookActive: true,
        decision: decision({ state: "Stop", reasonCode: "blind_retry_loop" }),
        summary: repeatedTestFailureSummary(3)
      })
    );

    expect(blocked).toMatchObject({
      kind: "coach",
      delivery: "stop_block",
      reasonCode: "finish_with_unresolved_risk"
    });
    expect(active).toEqual({ kind: "none" });
  });
});

function policyInput(overrides: Partial<FeedbackPolicyInput> = {}): FeedbackPolicyInput {
  return {
    mode: "coach",
    hookEventName: "PostToolUseFailure",
    summary: transcriptSummary(),
    recentFeedback: [],
    ...overrides
  };
}

function transcriptSummary(overrides: Partial<TranscriptSummary> = {}): TranscriptSummary {
  return {
    pathReadable: true,
    bytesRead: 0,
    linesRead: 0,
    malformedLines: 0,
    toolCalls: 0,
    readToolCalls: 0,
    failedToolResults: 0,
    repeatedFailures: [],
    editTestLoopFailures: 0,
    hasUnvalidatedEdits: false,
    validationRecovered: false,
    compactionEvents: 0,
    postCompactionActivity: 0,
    usage: {},
    ...overrides
  };
}

function repeatedTestFailureSummary(count: number): TranscriptSummary {
  return transcriptSummary({
    toolCalls: count,
    failedToolResults: count,
    repeatedFailures: [
      {
        toolName: "Bash",
        purpose: "tests",
        count
      }
    ],
    blindRetry: {
      category: "tests",
      label: "test",
      attemptCount: count,
      recovered: false,
      activeEnded: true,
      blindRetryFailureCount: count
    }
  });
}

function decision(overrides: Partial<StoredDecision>): StoredDecision {
  return {
    id: "decision-1",
    state: "Careful",
    reasonCode: "tool_failure_repeated",
    primaryEvidence: "tests failed twice",
    evidence: [],
    impact: "Tests are failing repeatedly",
    action: "inspect first failure",
    createdAt: "2026-05-23T00:00:00.000Z",
    ...overrides
  };
}
