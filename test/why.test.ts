import { describe, expect, it } from "vitest";
import { formatWhy, formatWhyJson, shouldColorWhy } from "../src/why.js";
import type { Decision, StoredFeedbackOutcome } from "../src/types.js";

describe("why feedback ledger", () => {
  it("shows a compact feedback loop for resolved coach feedback", () => {
    const rendered = formatWhy(decision({ state: "Healthy", reasonCode: "validation_recovered" }), {
      feedbackOutcomes: [
        outcome({
          feedbackAction: "coach",
          reasonCode: "edit_without_validation",
          safeCategory: "tests",
          expectedAction: "run_validation",
          outcome: "resolved"
        })
      ],
      color: false
    });

    expect(rendered).toContain("Last decision: Healthy.");
    expect(rendered).toContain("Recent bb loop:");
    expect(rendered).toContain("1. Coach feedback: edits needed validation.");
    expect(rendered).toContain("2. Claude ran tests.");
    expect(rendered).toContain("3. Tests passed.");
    expect(rendered).toContain("4. Outcome: resolved.");
  });

  it("shows ignored repeated validation feedback without raw details", () => {
    const rawCommand = "make test --private-arg";
    const rawPath = "/tmp/bb-cc-lite/private/project/src/secret.ts";
    const rendered = formatWhy(decision({ state: "Stop", reasonCode: "blind_retry_loop" }), {
      feedbackOutcomes: [
        outcome({
          feedbackAction: "coach",
          reasonCode: "validation_repeated",
          safeCategory: "tests",
          expectedAction: "intervene_before_retry",
          outcome: "ignored"
        })
      ],
      color: false
    });

    expect(rendered).toContain("Coach feedback: inspect before retrying tests.");
    expect(rendered).toContain("Claude retried tests without an intervention.");
    expect(rendered).toContain("Outcome: ignored.");
    expect(rendered).not.toContain(rawCommand);
    expect(rendered).not.toContain(rawPath);
  });

  it("uses restrained ANSI color only when requested", () => {
    const colored = formatWhy(decision({ state: "Healthy" }), {
      feedbackOutcomes: [outcome({ outcome: "resolved" })],
      color: true
    });
    const plain = formatWhy(decision({ state: "Healthy" }), {
      feedbackOutcomes: [outcome({ outcome: "resolved" })],
      color: false
    });

    expect(colored).toContain("\u001b[32mHealthy\u001b[0m");
    expect(colored).toContain("\u001b[32mresolved\u001b[0m");
    expect(plain).not.toContain("\u001b[");
    expect(plain).toContain("Last decision: Healthy.");
  });

  it("enables interactive color only for TTY output without color opt-outs", () => {
    expect(shouldColorWhy({}, true)).toBe(true);
    expect(shouldColorWhy({ NO_COLOR: "1" }, true)).toBe(false);
    expect(shouldColorWhy({ BB_CC_LITE_COLOR: "0" }, true)).toBe(false);
    expect(shouldColorWhy({}, false)).toBe(false);
  });

  it("keeps why --json structured and never colorized", () => {
    const json = formatWhyJson(decision({ state: "Healthy" }), [outcome({ outcome: "resolved" })]);
    const serialized = JSON.stringify(json);

    expect(json).toMatchObject({
      state: "Healthy",
      feedbackOutcomes: [{ outcome: "resolved", safeCategory: "tests" }]
    });
    expect(serialized).not.toContain("\u001b[");
  });

  it("remains helpful when no feedback outcomes exist", () => {
    const rendered = formatWhy(decision({ state: "Careful", reasonCode: "context_high" }), {
      feedbackOutcomes: [],
      color: false
    });

    expect(rendered).toContain("Last decision: Careful.");
    expect(rendered).toContain("Next action: continue normally.");
    expect(rendered).not.toContain("Recent bb loop:");
  });
});

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    state: "Healthy",
    reasonCode: "healthy",
    primaryEvidence: "no stop-level findings",
    evidence: [{ label: "no stop-level findings" }],
    impact: "session stable",
    action: "continue normally",
    createdAt: "2026-05-25T10:00:00.000Z",
    ...overrides
  };
}

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
