import { describe, expect, it } from "vitest";
import { renderStatusLine } from "../src/renderer.js";
import { decide } from "../src/signals.js";
import { formatWhy } from "../src/why.js";
import type { StatusLineInput, TranscriptSummary } from "../src/types.js";

function input(overrides: Partial<StatusLineInput> = {}): StatusLineInput {
  return {
    rawValid: true,
    sessionId: "session-alpha",
    model: { id: "claude-sonnet-4-5" },
    usage: {},
    ...overrides
  };
}

function transcript(overrides: Partial<TranscriptSummary> = {}): TranscriptSummary {
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
    usage: {},
    ...overrides
  };
}

function visibleLength(value: string): number {
  // Test helper mirrors renderer ANSI stripping.
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;]*m/gu, "").length;
}

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;]*m/gu, "");
}

describe("signals and renderer", () => {
  it("stops on repeated Bash test failures with a concrete next action", () => {
    const decision = decide(
      input({ contextPercent: 42 }),
      transcript({
        failedToolResults: 3,
        repeatedFailures: [{ toolName: "Bash", purpose: "tests", count: 3 }]
      })
    );

    expect(decision).toMatchObject({
      state: "Stop",
      reasonCode: "repeated_tool_failure",
      diagnosisCode: "validation_command_loop",
      diagnosis: "test loop: failed 3x",
      primaryEvidence: "Bash failed 3x running tests",
      action: "inspect first failure"
    });
    const rendered = renderStatusLine(decision, 180);
    expect(rendered).toContain("why: test loop: failed 3x");
    expect(rendered).toContain("do: inspect first failure");
  });

  it("warns on two repeated Bash test failures before escalating to Stop", () => {
    const decision = decide(
      input({ contextPercent: 42 }),
      transcript({
        failedToolResults: 2,
        repeatedFailures: [{ toolName: "Bash", purpose: "tests", count: 2 }]
      })
    );

    expect(decision).toMatchObject({
      state: "Careful",
      reasonCode: "tool_failure_repeated",
      primaryEvidence: "Bash failed 2x running tests",
      action: "pause and inspect the failing test before another retry"
    });
  });

  it("warns when edits have not been validated yet", () => {
    const decision = decide(
      input({ contextPercent: 42 }),
      transcript({ hasUnvalidatedEdits: true })
    );

    expect(decision).toMatchObject({
      state: "Careful",
      reasonCode: "edit_without_validation",
      diagnosisCode: "edit_without_validation",
      diagnosis: "edits not checked yet",
      action: "run focused check"
    });
    expect(renderStatusLine(decision, 120)).toContain("edits not checked yet");
  });

  it("renders validation recovery as healthy", () => {
    const decision = decide(input({ contextPercent: 42 }), transcript({ validationRecovered: true }));

    expect(decision).toMatchObject({
      state: "Healthy",
      reasonCode: "validation_recovered",
      diagnosisCode: "validation_recovered",
      diagnosis: "validation recovered",
      action: "continue"
    });
    expect(renderStatusLine(decision, 120)).toContain("validation recovered");
  });

  it("uses the baseline to render read-heavy research as usually normal", () => {
    const decision = decide(
      input({ contextPercent: 42 }),
      transcript({ toolCalls: 8, readToolCalls: 7 }),
      {
        baseline: {
          scenarios: {
            read_heavy_debugging: { seen: 16, confidence: "medium" }
          },
          outcomes: {
            healthyLike: { readHeavyNoFailure: 16 }
          }
        }
      }
    );

    expect(decision).toMatchObject({
      state: "Healthy",
      reasonCode: "read_heavy_debugging",
      diagnosisCode: "read_heavy_debugging",
      diagnosis: "research phase: usually normal for you",
      baselineNote: "usually Healthy-like for you",
      action: "continue"
    });
    expect(renderStatusLine(decision, 140)).toContain("research phase: usually normal for you");
  });

  it("lets Stop-like baseline history strengthen wording without overriding hard Stop", () => {
    const decision = decide(
      input({ contextPercent: 42 }),
      transcript({
        failedToolResults: 3,
        repeatedFailures: [{ toolName: "Bash", purpose: "tests", count: 3 }]
      }),
      {
        baseline: {
          scenarios: {
            validation_command_loop: { seen: 8, confidence: "high" }
          },
          outcomes: {
            stopLike: { validationLoopUnrecovered: 8 }
          }
        }
      }
    );

    expect(decision).toMatchObject({
      state: "Stop",
      reasonCode: "repeated_tool_failure",
      diagnosisCode: "validation_command_loop",
      diagnosis: "test loop: past runs ended badly",
      baselineNote: "usually Stop-like for you"
    });
    expect(renderStatusLine(decision, 120)).toContain("why: test loop: past runs ended badly");
  });

  it("explains baseline influence in why without raw details", () => {
    const decision = decide(
      input({ contextPercent: 42 }),
      transcript({ toolCalls: 8, readToolCalls: 7 }),
      {
        baseline: {
          scenarios: {
            read_heavy_debugging: { seen: 16, confidence: "medium" }
          },
          outcomes: {
            healthyLike: { readHeavyNoFailure: 16 }
          }
        }
      }
    );

    const why = formatWhy(decision);

    expect(why).toContain("Baseline: read-heavy sessions were usually Healthy-like for you.");
    expect(why).not.toContain("16");
  });

  it("warns on compaction and cache-write risk before healthy fallback", () => {
    const compaction = decide(input(), transcript({ compactionEvents: 1 }));
    expect(compaction).toMatchObject({
      state: "Careful",
      reasonCode: "compaction_boundary",
      action: "ask Claude to restate current goal and next 3 steps"
    });

    const cacheRisk = decide(
      input({
        usage: {
          cacheCreationInputTokens: 50_000,
          cacheReadInputTokens: 100
        }
      }),
      transcript()
    );
    expect(cacheRisk).toMatchObject({
      state: "Careful",
      reasonCode: "cache_writes_high",
      primaryEvidence: "cache writes high"
    });
  });

  it("handles invalid statusline stdin as a careful doctor action", () => {
    const decision = decide(input({ rawValid: false, parseError: "bad JSON" }), transcript());

    expect(decision).toMatchObject({
      state: "Careful",
      reasonCode: "statusline_input_unavailable",
      action: "run bb-cc-lite doctor and check Claude Code settings"
    });
  });

  it("renders long, medium, and narrow status lines within the requested width", () => {
    const decision = decide(input({ contextPercent: 81 }), transcript());

    expect(decision.state).toBe("Careful");
    expect(decision.reasonCode).toBe("context_high");

    const wide = renderStatusLine(decision, 120);
    expect(visibleLength(wide)).toBeLessThanOrEqual(120);
    expect(stripAnsi(wide)).toContain("bb: Careful");
    expect(wide).toContain("ctx 81%");
    expect(wide).toContain("Context is getting tight");
    expect(wide).toContain("ask Claude for a 6-bullet handoff before more work");

    const medium = renderStatusLine(decision, 80);
    expect(visibleLength(medium)).toBeLessThanOrEqual(80);
    expect(medium).toContain("ctx 81%");
    expect(medium).toContain("ask Claude for a 6-bullet handoff before more work");
    expect(medium).not.toContain("Context is getting tight");

    const narrow = renderStatusLine(decision, 55);
    expect(visibleLength(narrow)).toBeLessThanOrEqual(55);
    expect(stripAnsi(narrow)).toContain("bb: Careful");
    expect(narrow).toContain("ctx 81%");
    expect(narrow).not.toContain("ask Claude for a 6-bullet handoff before more work");
  });

  it("colors the state segment without changing visible width", () => {
    const previousNoColor = process.env.NO_COLOR;
    const previousBbColor = process.env.BB_CC_LITE_COLOR;
    delete process.env.NO_COLOR;
    delete process.env.BB_CC_LITE_COLOR;
    try {
      const stop = decide(
        input({ contextPercent: 42 }),
        transcript({
          failedToolResults: 3,
          repeatedFailures: [{ toolName: "Bash", purpose: "tests", count: 3 }]
        })
      );
      const careful = decide(input({ contextPercent: 81 }), transcript());
      const healthy = decide(input({ contextPercent: 20 }), transcript());

      const renderedStop = renderStatusLine(stop, 140);
      const renderedCareful = renderStatusLine(careful, 140);
      const renderedHealthy = renderStatusLine(healthy, 140);

      expect(renderedStop).toContain("\u001b[1;31mbb: Stop\u001b[0m");
      expect(renderedCareful).toContain("\u001b[33mbb: Careful\u001b[0m");
      expect(renderedHealthy).toContain("\u001b[32mbb: Healthy\u001b[0m");
      expect(stripAnsi(renderedStop)).toContain("bb: Stop");
      expect(visibleLength(renderedStop)).toBe(stripAnsi(renderedStop).length);
    } finally {
      if (previousNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = previousNoColor;
      }
      if (previousBbColor === undefined) {
        delete process.env.BB_CC_LITE_COLOR;
      } else {
        process.env.BB_CC_LITE_COLOR = previousBbColor;
      }
    }
  });

  it("keeps a labeled stop reason visible when width is tight", () => {
    const decision = decide(
      input({ contextPercent: 42 }),
      transcript({
        failedToolResults: 3,
        repeatedFailures: [{ toolName: "Bash", purpose: "tests", count: 3 }]
      })
    );

    const rendered = renderStatusLine(decision, 44);

    expect(visibleLength(rendered)).toBeLessThanOrEqual(44);
    expect(stripAnsi(rendered)).toContain("bb: Stop");
    expect(rendered).toContain("why: test loop: failed 3x");
    expect(rendered).not.toContain("do:");
  });

  it("keeps rendered output to one line even when evidence contains control characters", () => {
    const rendered = renderStatusLine(
      {
        ...decide(input(), transcript()),
        evidence: [{ label: "line one\nline two" }]
      },
      200
    );

    expect(rendered).not.toContain("\n");
    expect(rendered).not.toContain("\r");
  });
});
