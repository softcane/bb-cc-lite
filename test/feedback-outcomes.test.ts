import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateFeedbackOutcome,
  expectedActionForFeedback
} from "../src/feedback-outcomes.js";
import { hashValue } from "../src/paths.js";
import {
  FEEDBACK_OUTCOME_STORE_LIMIT,
  readStore,
  recentFeedbackOutcomes,
  recordFeedbackOutcome
} from "../src/store.js";
import type { StoredFeedbackOutcome, StoredHookEvent } from "../src/types.js";

const rawSentinels = [
  "BB_CC_LITE_RAW_COMMAND_SENTINEL",
  "BB_CC_LITE_RAW_PROMPT_SENTINEL",
  "BB_CC_LITE_RAW_OUTPUT_SENTINEL",
  "BB_CC_LITE_RAW_SESSION_SENTINEL",
  "/tmp/bb-cc-lite/private/project/src/secret.ts"
];

describe("feedback outcome data model", () => {
  it("stores feedback outcomes with only derived safe fields", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-feedback-outcome-"));
    try {
      const storePath = join(tempDir, "events.json");
      const rawSessionId = `session-${rawSentinels[3]}`;
      const stored = await recordFeedbackOutcome(
        {
          kind: "feedback_outcome",
          sessionKey: hashValue(rawSessionId),
          feedbackAction: "coach",
          cooldownKey: "coach:edit_without_validation:edit",
          expectedAction: "run_validation",
          outcome: "pending",
          timestamp: "2026-05-25T10:00:00.000Z",
          reasonCode: "edit_without_validation",
          safeCategory: "edit",
          rawCommand: rawSentinels[0],
          prompt: rawSentinels[1],
          rawToolOutput: rawSentinels[2],
          workspacePath: rawSentinels[4]
        } as never,
        storePath
      );

      expect(stored).toMatchObject({
        kind: "feedback_outcome",
        feedbackAction: "coach",
        cooldownKey: "coach:edit_without_validation:edit",
        expectedAction: "run_validation",
        outcome: "pending",
        reasonCode: "edit_without_validation",
        safeCategory: "edit"
      });

      const storeText = await readFile(storePath, "utf8");
      for (const sentinel of rawSentinels) {
        expect(storeText).not.toContain(sentinel);
      }
      expect(storeText).not.toContain(rawSessionId);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps feedback outcomes bounded and reads legacy stores without outcomes", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-feedback-outcome-limit-"));
    try {
      const legacyStorePath = join(tempDir, "legacy.json");
      await writeFile(
        legacyStorePath,
        `${JSON.stringify({ version: 1, updatedAt: "2026-05-25T00:00:00.000Z", decisions: [], hookEvents: [] })}\n`,
        "utf8"
      );
      await expect(readStore(legacyStorePath)).resolves.toMatchObject({ feedbackOutcomes: [] });

      const storePath = join(tempDir, "events.json");
      for (let index = 0; index < FEEDBACK_OUTCOME_STORE_LIMIT + 5; index += 1) {
        await recordFeedbackOutcome(
          {
            kind: "feedback_outcome",
            sessionKey: "safe-session-key",
            feedbackAction: "coach",
            cooldownKey: `coach:edit_without_validation:edit:${index}`,
            expectedAction: "run_validation",
            outcome: "pending",
            timestamp: `2026-05-25T10:00:${String(index).padStart(2, "0")}.000Z`,
            reasonCode: "edit_without_validation",
            safeCategory: "edit"
          },
          storePath
        );
      }

      const store = await readStore(storePath);
      expect(store.feedbackOutcomes).toHaveLength(FEEDBACK_OUTCOME_STORE_LIMIT);
      expect(store.feedbackOutcomes[0]?.cooldownKey).toBe("coach:edit_without_validation:edit:5");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("drops legacy feedback outcomes containing forbidden raw fields before why can read them", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-feedback-outcome-legacy-"));
    try {
      const storePath = join(tempDir, "events.json");
      await writeFile(
        storePath,
        `${JSON.stringify(
          {
            version: 1,
            updatedAt: "2026-05-25T00:00:00.000Z",
            decisions: [],
            hookEvents: [],
            feedbackOutcomes: [
              {
                id: "unsafe",
                kind: "feedback_outcome",
                sessionKey: "safe-session-key",
                feedbackAction: "coach",
                cooldownKey: "coach:edit_without_validation:edit",
                expectedAction: "run_validation",
                outcome: "pending",
                timestamp: "2026-05-25T10:00:00.000Z",
                rawCommand: rawSentinels[0]
              },
              {
                id: "safe",
                kind: "feedback_outcome",
                sessionKey: "safe-session-key",
                feedbackAction: "coach",
                cooldownKey: "coach:edit_without_validation:edit",
                expectedAction: "run_validation",
                outcome: "resolved",
                timestamp: "2026-05-25T10:01:00.000Z",
                reasonCode: "edit_without_validation",
                safeCategory: "tests"
              }
            ]
          },
          null,
          2
        )}\n`,
        "utf8"
      );

      const outcomes = await recentFeedbackOutcomes("safe-session-key", storePath);

      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]?.id).toBe("safe");
      expect(JSON.stringify(outcomes)).not.toContain(rawSentinels[0]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("feedback outcome policy", () => {
  it("marks edit_without_validation feedback resolved after recognized validation succeeds", () => {
    const outcome = evaluateFeedbackOutcome(
      pendingOutcome({
        reasonCode: "edit_without_validation",
        safeCategory: "edit",
        expectedAction: "run_validation"
      }),
      [hookEvent({ kind: "tool_success", toolName: "Bash", purpose: "tests", timestamp: "2026-05-25T10:01:00.000Z" })]
    );

    expect(outcome).toMatchObject({
      outcome: "resolved",
      safeCategory: "tests",
      stateAfter: "Healthy"
    });
  });

  it("marks edit_without_validation feedback followed, not resolved, after validation fails", () => {
    const outcome = evaluateFeedbackOutcome(
      pendingOutcome({
        reasonCode: "edit_without_validation",
        safeCategory: "edit",
        expectedAction: "run_validation"
      }),
      [hookEvent({ kind: "tool_failure", toolName: "Bash", purpose: "tests", timestamp: "2026-05-25T10:01:00.000Z" })]
    );

    expect(outcome).toMatchObject({
      outcome: "followed",
      safeCategory: "tests"
    });
  });

  it("marks edit_without_validation feedback ignored when the session stops with unresolved risk", () => {
    const outcome = evaluateFeedbackOutcome(
      pendingOutcome({
        reasonCode: "edit_without_validation",
        safeCategory: "edit",
        expectedAction: "run_validation"
      }),
      [hookEvent({ kind: "stop", timestamp: "2026-05-25T10:01:00.000Z" })],
      { hasUnvalidatedEdits: true }
    );

    expect(outcome).toMatchObject({
      outcome: "ignored",
      stateAfter: "Careful"
    });
  });

  it("marks repeated validation feedback followed after an intervention before retry", () => {
    const outcome = evaluateFeedbackOutcome(
      pendingOutcome({
        reasonCode: "validation_repeated",
        safeCategory: "tests",
        expectedAction: "intervene_before_retry"
      }),
      [
        hookEvent({ kind: "tool_success", toolName: "Read", timestamp: "2026-05-25T10:01:00.000Z" }),
        hookEvent({ kind: "tool_failure", toolName: "Bash", purpose: "tests", timestamp: "2026-05-25T10:02:00.000Z" })
      ]
    );

    expect(outcome).toMatchObject({
      outcome: "followed",
      safeCategory: "tests"
    });
  });

  it("marks repeated validation feedback ignored when the same validation is retried without intervention", () => {
    const outcome = evaluateFeedbackOutcome(
      pendingOutcome({
        reasonCode: "validation_repeated",
        safeCategory: "tests",
        expectedAction: "intervene_before_retry"
      }),
      [hookEvent({ kind: "tool_failure", toolName: "Bash", purpose: "tests", timestamp: "2026-05-25T10:01:00.000Z" })]
    );

    expect(outcome).toMatchObject({
      outcome: "ignored",
      safeCategory: "tests"
    });
  });

  it("marks repeated validation feedback resolved when validation later passes", () => {
    const outcome = evaluateFeedbackOutcome(
      pendingOutcome({
        reasonCode: "blind_retry_loop",
        safeCategory: "tests",
        expectedAction: "intervene_before_retry"
      }),
      [hookEvent({ kind: "tool_success", toolName: "Bash", purpose: "tests", timestamp: "2026-05-25T10:01:00.000Z" })]
    );

    expect(outcome).toMatchObject({
      outcome: "resolved",
      safeCategory: "tests",
      stateAfter: "Healthy"
    });
  });

  it("maps feedback reason codes to safe expected actions", () => {
    expect(expectedActionForFeedback("edit_without_validation")).toBe("run_validation");
    expect(expectedActionForFeedback("validation_repeated")).toBe("intervene_before_retry");
    expect(expectedActionForFeedback("blind_retry_loop")).toBe("intervene_before_retry");
    expect(expectedActionForFeedback("budget_busy_no_observed_progress")).toBe("summarize_or_narrow");
    expect(expectedActionForFeedback("compaction_goal_preservation")).toBe("summarize_or_narrow");
    expect(expectedActionForFeedback("finish_with_unresolved_risk")).toBe("validate_or_summarize");
  });
});

function pendingOutcome(overrides: Partial<StoredFeedbackOutcome>): StoredFeedbackOutcome {
  return {
    id: "outcome-1",
    kind: "feedback_outcome",
    sessionKey: "safe-session-key",
    feedbackAction: "coach",
    cooldownKey: "coach:validation_repeated:tests",
    expectedAction: "intervene_before_retry",
    outcome: "pending",
    timestamp: "2026-05-25T10:00:00.000Z",
    reasonCode: "validation_repeated",
    safeCategory: "tests",
    ...overrides
  };
}

function hookEvent(overrides: Partial<StoredHookEvent>): StoredHookEvent {
  return {
    id: "event-1",
    kind: "tool_success",
    sessionKey: "safe-session-key",
    timestamp: "2026-05-25T10:01:00.000Z",
    hookEventName: "PostToolUse",
    ...overrides
  } as StoredHookEvent;
}
