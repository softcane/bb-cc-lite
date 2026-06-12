import { describe, expect, it } from "vitest";
import { formatFeedbackLedger } from "../src/feedback-ledger.js";
import type { StoredFeedbackOutcome } from "../src/types.js";

describe("feedback-outcome ledger", () => {
  it("shows a compact feedback loop for resolved coach feedback", () => {
    const rendered = formatFeedbackLedger(
      [
        outcome({
          feedbackAction: "coach",
          reasonCode: "edit_without_validation",
          safeCategory: "tests",
          expectedAction: "run_validation",
          outcome: "resolved"
        })
      ],
      { color: false }
    );

    expect(rendered).toContain("Recent ccverdict loop:");
    expect(rendered).toContain("1. Coach feedback: edits needed validation.");
    expect(rendered).toContain("2. Claude ran tests.");
    expect(rendered).toContain("3. Tests passed.");
    expect(rendered).toContain("4. Outcome: resolved.");
  });

  it("shows ignored repeated validation feedback without raw details", () => {
    const rawCommand = "make test --private-arg";
    const rawPath = "/tmp/ccverdict/private/project/src/secret.ts";
    const rendered = formatFeedbackLedger(
      [
        outcome({
          feedbackAction: "coach",
          reasonCode: "validation_repeated",
          safeCategory: "tests",
          expectedAction: "intervene_before_retry",
          outcome: "ignored"
        })
      ],
      { color: false }
    );

    expect(rendered).toContain("Coach feedback: inspect before retrying tests.");
    expect(rendered).toContain("Claude retried tests without an intervention.");
    expect(rendered).toContain("Outcome: ignored.");
    expect(rendered).not.toContain(rawCommand);
    expect(rendered).not.toContain(rawPath);
  });

  it("uses restrained ANSI color only when requested", () => {
    const colored = formatFeedbackLedger([outcome({ outcome: "resolved" })], { color: true });
    const plain = formatFeedbackLedger([outcome({ outcome: "resolved" })], { color: false });

    expect(colored).toContain("[32mresolved[0m");
    expect(plain).not.toContain("[");
    expect(plain).toContain("Outcome: resolved.");
  });

  it("returns undefined when there are no feedback outcomes", () => {
    expect(formatFeedbackLedger([])).toBeUndefined();
  });
});

function outcome(overrides: Partial<StoredFeedbackOutcome> = {}): StoredFeedbackOutcome {
  return {
    id: "feedback-outcome-1",
    kind: "feedback_outcome",
    sessionKey: "safe-session-key",
    feedbackAction: "coach",
    cooldownKey: "coach:edit_without_validation:edit",
    expectedAction: "run_validation",
    outcome: "resolved",
    timestamp: "2026-05-25T10:01:00.000Z",
    reasonCode: "edit_without_validation",
    safeCategory: "tests",
    ...overrides
  };
}
