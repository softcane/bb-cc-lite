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
    postCompactionActivity: 0,
    usage: {},
    ...overrides
  };
}

function tokenJump(inputTokenDelta: number, toolResultCount: number, crossedThreshold = true): NonNullable<TranscriptSummary["latestInputTokenJump"]> {
  return {
    previousInputTokens: 1_000,
    currentInputTokens: 1_000 + inputTokenDelta,
    inputTokenDelta,
    toolResultCount,
    thresholdTokens: 8_000,
    crossedThreshold,
    timestamp: "2026-02-03T00:00:03.000Z"
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
      primaryEvidence: "tests failed 3x",
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
      primaryEvidence: "tests failed twice",
      action: "pause and inspect the failing test before another retry"
    });
  });

  it("warns on the second unchanged full-file Read with concise private-path-safe output", () => {
    const rawPath = "/tmp/bb-cc-lite/private/worktree/src/secret.ts";
    const decision = decide(
      input({ contextPercent: 42 }),
      transcript({
        toolCalls: 2,
        readToolCalls: 2,
        redundantRead: {
          fileIdentityHash: "safe-file-hash",
          unchangedFullFileReadCount: 2,
          latestState: "Careful",
          safeFileLabel: "secret.ts"
        }
      })
    );
    const rendered = stripAnsi(renderStatusLine(decision, 90));

    expect(decision).toMatchObject({
      state: "Careful",
      reasonCode: "redundant_read",
      diagnosisCode: "redundant_read_loop",
      diagnosis: "same file reread twice",
      primaryEvidence: "same file reread twice (secret.ts)",
      action: "ask Claude to use existing context before rereading"
    });
    expect(rendered).toContain("bb: Careful | same file reread twice");
    expect(visibleLength(rendered)).toBeLessThanOrEqual(90);
    expect(rendered).not.toContain(rawPath);
  });

  it("stops on the third unchanged full-file Read with short why wording", () => {
    const rawPath = "/tmp/bb-cc-lite/private/worktree/src/secret.ts";
    const decision = decide(
      input({ contextPercent: 42 }),
      transcript({
        toolCalls: 3,
        readToolCalls: 3,
        redundantRead: {
          fileIdentityHash: "safe-file-hash",
          unchangedFullFileReadCount: 3,
          latestState: "Stop",
          safeFileLabel: "secret.ts"
        }
      })
    );
    const rendered = stripAnsi(renderStatusLine(decision, 120));

    expect(decision).toMatchObject({
      state: "Stop",
      reasonCode: "redundant_read_loop",
      diagnosisCode: "redundant_read_loop",
      diagnosis: "same file reread 3x",
      primaryEvidence: "same file reread 3x (secret.ts)",
      impact: "Claude is rereading an unchanged file",
      action: "stop and ask why the same file is needed again"
    });
    expect(rendered).toContain("bb: Stop | why: same file reread 3x");
    expect(visibleLength(rendered)).toBeLessThanOrEqual(120);
    expect(rendered).not.toContain(rawPath);
  });

  it("prefers blind retry wording over generic repeated failure at Careful and Stop", () => {
    const careful = decide(
      input({ contextPercent: 42 }),
      transcript({
        failedToolResults: 2,
        repeatedFailures: [{ toolName: "Bash", purpose: "tests", count: 2 }],
        blindRetry: {
          category: "tests",
          label: "test",
          attemptCount: 2,
          recovered: false,
          activeEnded: true,
          blindRetryFailureCount: 2
        }
      })
    );

    expect(careful).toMatchObject({
      state: "Careful",
      reasonCode: "blind_retry",
      diagnosis: "same test failed twice without a fix",
      primaryEvidence: "same test failed twice without a fix",
      action: "inspect first failure"
    });
    expect(renderStatusLine(careful, 140)).toContain("same test failed twice without a fix");

    const stop = decide(
      input({ contextPercent: 42 }),
      transcript({
        failedToolResults: 3,
        repeatedFailures: [{ toolName: "Bash", purpose: "tests", count: 3 }],
        blindRetry: {
          category: "tests",
          label: "test",
          attemptCount: 3,
          recovered: false,
          activeEnded: true,
          blindRetryFailureCount: 3
        }
      })
    );

    expect(stop).toMatchObject({
      state: "Stop",
      reasonCode: "blind_retry_loop",
      diagnosis: "same failure retried 3x without a fix",
      primaryEvidence: "same test failed 3x without a fix",
      action: "stop and inspect first failure"
    });
    expect(renderStatusLine(stop, 160)).toContain("why: same failure retried 3x without a fix");
  });

  it("renders the required Careful MCP wording without raw tool names", () => {
    const rawMcpName = "mcp__privateServer__failingLookup";
    const decision = decide(
      input({ contextPercent: 42 }),
      transcript({
        failedToolResults: 2,
        repeatedFailures: [{ toolName: "MCP tool", category: "MCP", identityHash: "safehash", count: 2 }]
      })
    );

    expect(decision).toMatchObject({
      state: "Careful",
      reasonCode: "tool_failure_repeated",
      diagnosisCode: "mcp_tool_failure_repeated",
      diagnosis: "MCP tool failed 2x",
      primaryEvidence: "MCP tool failed 2x",
      action: "inspect the failing MCP step before another retry"
    });
    const rendered = renderStatusLine(decision, 140);
    expect(stripAnsi(rendered)).toContain("bb: Careful | MCP tool failed 2x | inspect the failing MCP step before another retry");
    expect(rendered).not.toContain(rawMcpName);
  });

  it("renders the required Stop MCP wording without raw tool names", () => {
    const rawMcpName = "mcp__privateServer__failingLookup";
    const decision = decide(
      input({ contextPercent: 42 }),
      transcript({
        failedToolResults: 3,
        repeatedFailures: [{ toolName: "MCP tool", category: "MCP", identityHash: "safehash", count: 3 }]
      })
    );

    expect(decision).toMatchObject({
      state: "Stop",
      reasonCode: "repeated_tool_failure",
      diagnosisCode: "mcp_tool_failure_repeated",
      diagnosis: "MCP tool failed 3x",
      primaryEvidence: "MCP tool failed 3x",
      impact: "Claude is retrying the same failing MCP tool",
      action: "inspect MCP server/tool config before more retries"
    });
    const rendered = renderStatusLine(decision, 180);
    expect(stripAnsi(rendered)).toContain(
      "bb: Stop | why: MCP tool failed 3x; Claude is retrying the same failing MCP tool | do: inspect MCP server/tool config before more retries"
    );
    expect(rendered).not.toContain(rawMcpName);
  });

  it("uses validation recovery history for a two-failure test streak without escalating to Stop", () => {
    const decision = decide(
      input({ contextPercent: 42 }),
      transcript({
        failedToolResults: 2,
        repeatedFailures: [{ toolName: "Bash", purpose: "tests", count: 2 }]
      }),
      {
        baseline: {
          validation: {
            tests: {
              calls: 24,
              failures: 10,
              failureRate: 0.4167,
              recovered: 9,
              unrecovered: 1,
              recoveryRate: 0.9,
              averageFailuresBeforeRecovery: 1,
              medianFailuresBeforeRecovery: 1,
              p75FailuresBeforeRecovery: 1,
              fivePlusFailuresBeforeRecovery: 0
            }
          }
        }
      }
    );

    expect(decision).toMatchObject({
      state: "Careful",
      reasonCode: "tool_failure_repeated",
      diagnosis: "tests failed twice; usually passes after one targeted fix",
      baselineNote: "test failures usually recovered after one targeted fix",
      action: "inspect first failure"
    });
    expect(renderStatusLine(decision, 140)).toContain("tests failed twice; usually passes after one targeted fix");
    expect(formatWhy(decision)).toContain("Baseline: test failures usually recovered after one targeted fix.");
  });

  it("uses category-specific recovery history for a two-failure typecheck streak", () => {
    const decision = decide(
      input({ contextPercent: 42 }),
      transcript({
        failedToolResults: 2,
        repeatedFailures: [{ toolName: "Bash", purpose: "typecheck", count: 2 }]
      }),
      {
        baseline: {
          validation: {
            typecheck: {
              calls: 12,
              failures: 6,
              failureRate: 0.5,
              recovered: 5,
              unrecovered: 1,
              recoveryRate: 0.8333,
              averageFailuresBeforeRecovery: 1,
              medianFailuresBeforeRecovery: 1,
              p75FailuresBeforeRecovery: 1,
              fivePlusFailuresBeforeRecovery: 0
            }
          }
        }
      }
    );

    expect(decision).toMatchObject({
      state: "Careful",
      reasonCode: "tool_failure_repeated",
      diagnosis: "typecheck failed twice; usually passes after one targeted fix",
      baselineNote: "typecheck failures usually recovered after one targeted fix",
      action: "inspect first failure"
    });
  });

  it("uses check-level wording for repeated typecheck failures without baseline history", () => {
    const decision = decide(
      input({ contextPercent: 42 }),
      transcript({
        failedToolResults: 2,
        repeatedFailures: [{ toolName: "Bash", purpose: "typecheck", count: 2 }]
      })
    );

    expect(decision).toMatchObject({
      state: "Careful",
      reasonCode: "tool_failure_repeated",
      primaryEvidence: "typecheck failed twice",
      impact: "typecheck is failing repeatedly",
      action: "pause and inspect the failing typecheck before another retry"
    });
    const rendered = renderStatusLine(decision, 140);
    expect(rendered).toContain("typecheck failed twice");
    expect(rendered).not.toContain("Bash failed");
    expect(rendered).not.toContain("Bash step");
  });

  it("uses read/search recovery history to soften hard Stop wording without changing state", () => {
    const decision = decide(
      input({ contextPercent: 42 }),
      transcript({
        failedToolResults: 3,
        repeatedFailures: [{ toolName: "Read", count: 3 }]
      }),
      {
        baseline: {
          failureRecovery: {
            read: {
              episodes: 10,
              recovered: 9,
              unrecovered: 1,
              activeEnded: 1,
              recoveryRate: 0.9,
              smoothedRecoveryRate: 0.8636,
              effectiveSamples: 11,
              medianAttemptsBeforeRecovery: 2,
              p75AttemptsBeforeRecovery: 3,
              blindRetryEpisodes: 4,
              blindRetryRecovered: 4,
              blindRetryUnrecovered: 0,
              confidence: "high"
            }
          },
          retryHazards: {
            read: {
              "3": {
                episodes: 8,
                recovered: 7,
                unrecovered: 1,
                recoveryRate: 0.875,
                smoothedRecoveryRate: 0.8333,
                effectiveSamples: 9,
                confidence: "medium"
              }
            }
          }
        }
      }
    );

    expect(decision).toMatchObject({
      state: "Stop",
      reasonCode: "repeated_tool_failure",
      confidence: "medium",
      primaryEvidence: "Read failed 3x",
      baselineNote: "read failures usually recovered after one targeted fix; fixed retry limit still says stop"
    });
    expect(formatWhy(decision)).toContain("fixed retry limit still says stop");
  });

  it("uses generic tool history for stronger repeated-tool Stop wording", () => {
    const decision = decide(
      input({ contextPercent: 42 }),
      transcript({
        failedToolResults: 3,
        repeatedFailures: [{ toolName: "WebFetch", count: 3 }]
      }),
      {
        baseline: {
          failureRecovery: {
            tool: {
              episodes: 12,
              recovered: 2,
              unrecovered: 10,
              activeEnded: 10,
              recoveryRate: 0.1667,
              smoothedRecoveryRate: 0.1923,
              effectiveSamples: 13,
              medianAttemptsBeforeRecovery: 2,
              p75AttemptsBeforeRecovery: 3,
              blindRetryEpisodes: 8,
              blindRetryRecovered: 1,
              blindRetryUnrecovered: 7,
              confidence: "high"
            }
          }
        }
      }
    );

    expect(decision).toMatchObject({
      state: "Stop",
      reasonCode: "repeated_tool_failure",
      diagnosis: "tool loop rarely recovered after 3 failures",
      baselineNote: "tool loops rarely recovered after 3 failures",
      action: "stop retrying and inspect first failure"
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
      diagnosis: "edits have not been checked yet",
      action: "ask Claude to run the smallest relevant check"
    });
    expect(renderStatusLine(decision, 120)).toContain("edits have not been checked yet");
  });

  it("warns carefully on a single-tool-result input-token jump without escalating to Stop", () => {
    const decision = decide(
      input({ contextPercent: 42 }),
      transcript({
        latestInputTokenJump: tokenJump(12_400, 1),
        largestInputTokenJump: tokenJump(12_400, 1)
      })
    );
    const rendered = stripAnsi(renderStatusLine(decision, 140));

    expect(decision).toMatchObject({
      state: "Careful",
      reasonCode: "tool_result_explosion",
      diagnosisCode: "tool_result_explosion",
      diagnosis: "single tool result added ~12,400 tokens",
      primaryEvidence: "single tool result added ~12,400 tokens",
      impact: "One tool result was the only local tool output before the jump",
      action: "compact or narrow the next step"
    });
    expect(decision.state).not.toBe("Stop");
    expect(rendered).toContain("bb: Careful | single tool result added ~12,400 tokens");
    expect(rendered).toContain("compact or narrow the next step");
    expect(formatWhy(decision)).toContain("Reason: single tool result added ~12,400 tokens.");
  });

  it("uses tool-output-batch wording for multiple tool results and stays width-aware", () => {
    const decision = decide(
      input({ contextPercent: 42 }),
      transcript({
        latestInputTokenJump: tokenJump(12_400, 2),
        largestInputTokenJump: tokenJump(12_400, 2)
      })
    );
    const rendered = stripAnsi(renderStatusLine(decision, 80));

    expect(decision).toMatchObject({
      state: "Careful",
      reasonCode: "tool_result_explosion",
      primaryEvidence: "context jumped by ~12,400 tokens after tool output batch",
      impact: "Token-jump heuristic from usage counters; recent tool output may be too broad"
    });
    expect(visibleLength(rendered)).toBeLessThanOrEqual(80);
    expect(rendered).toContain("context jumped by ~12,400 tokens after tool output batch");
    expect(rendered).not.toContain("single tool result");
  });

  it("does not blame a tool when a large input-token jump has no local tool result", () => {
    const decision = decide(
      input({ contextPercent: 42 }),
      transcript({
        latestInputTokenJump: tokenJump(12_400, 0),
        largestInputTokenJump: tokenJump(12_400, 0)
      })
    );
    const rendered = stripAnsi(renderStatusLine(decision, 70));

    expect(decision).toMatchObject({
      state: "Careful",
      reasonCode: "tool_result_explosion",
      primaryEvidence: "context jumped by ~12,400 tokens",
      impact: "Token-jump heuristic from usage counters; no local tool result was in that interval"
    });
    expect(visibleLength(rendered)).toBeLessThanOrEqual(70);
    expect(rendered).toContain("context jumped by ~12,400 tokens");
    expect(rendered).not.toContain("tool result");
    expect(rendered).not.toContain("tool output");
  });

  it("uses the largest crossed input-token jump when the latest jump is below threshold", () => {
    const decision = decide(
      input({ contextPercent: 42 }),
      transcript({
        latestInputTokenJump: tokenJump(900, 0, false),
        largestInputTokenJump: tokenJump(12_400, 3)
      })
    );

    expect(decision).toMatchObject({
      state: "Careful",
      reasonCode: "tool_result_explosion",
      primaryEvidence: "context jumped by ~12,400 tokens after tool output batch"
    });
  });

  it("keeps hard Stop rules ahead of the token-jump Careful signal", () => {
    const decision = decide(
      input({ contextPercent: 93 }),
      transcript({
        latestInputTokenJump: tokenJump(12_400, 1),
        largestInputTokenJump: tokenJump(12_400, 1)
      })
    );

    expect(decision).toMatchObject({
      state: "Stop",
      reasonCode: "context_critical"
    });
  });

  it("uses plain edit-check wording when an unvalidated edit is unusual", () => {
    const decision = decide(
      input({ contextPercent: 42 }),
      transcript({ hasUnvalidatedEdits: true, unvalidatedEditToolSteps: 7 }),
      {
        baseline: {
          editValidation: {
            editsFollowedByValidation: 12,
            editsWithoutValidation: 1,
            editWithoutValidationRate: 0.0769,
            medianToolStepsFromEditToValidation: 2,
            p75ToolStepsFromEditToValidation: 4
          }
        }
      }
    );

    expect(decision).toMatchObject({
      state: "Careful",
      reasonCode: "edit_without_validation",
      diagnosis: "edits have gone longer than usual without a check",
      baselineNote: "past sessions usually checked edits sooner",
      action: "ask Claude to run the smallest relevant check"
    });
    const rendered = renderStatusLine(decision, 120);
    expect(rendered).toContain("edits have gone longer than usual without a check");
    expect(rendered).toContain("ask Claude to run the smallest relevant check");
    expect(rendered).not.toContain("validation lag");
    expect(rendered).not.toContain("focused check");
    expect(formatWhy(decision)).toContain("Baseline: past sessions usually checked edits sooner.");
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

  it("warns when many non-read tool calls happen without progress", () => {
    const decision = decide(input({ contextPercent: 42 }), transcript({ toolCalls: 8, readToolCalls: 0 }));

    expect(decision).toMatchObject({
      state: "Careful",
      reasonCode: "busy_no_observed_progress",
      primaryEvidence: "8 tool calls, no check or recovery seen",
      impact: "Many safe activity signals were seen, but no observed progress signal was seen",
      action: "pause and ask Claude what changed"
    });
    expect(renderStatusLine(decision, 140)).toContain("8 tool calls, no check or recovery seen");
  });

  it("keeps busy sessions healthy after a validation check passes", () => {
    const decision = decide(
      input({ contextPercent: 42 }),
      transcript({ toolCalls: 8, readToolCalls: 0, validationSuccesses: 1, observedProgress: true })
    );

    expect(decision).toMatchObject({
      state: "Healthy",
      reasonCode: "healthy",
      action: "continue normally"
    });
  });

  it("keeps many reads healthy when there are no failures", () => {
    const decision = decide(input({ contextPercent: 42 }), transcript({ toolCalls: 12, readToolCalls: 12 }));

    expect(decision).toMatchObject({
      state: "Healthy",
      reasonCode: "healthy"
    });
  });

  it("keeps hard Stop decisions ahead of busy-no-progress activity", () => {
    const blindRetry = decide(
      input({ contextPercent: 42 }),
      transcript({
        toolCalls: 8,
        readToolCalls: 0,
        failedToolResults: 3,
        repeatedFailures: [{ toolName: "Bash", purpose: "tests", count: 3 }],
        blindRetry: {
          category: "tests",
          label: "test",
          attemptCount: 3,
          recovered: false,
          activeEnded: true,
          blindRetryFailureCount: 3
        }
      })
    );

    expect(blindRetry).toMatchObject({
      state: "Stop",
      reasonCode: "blind_retry_loop",
      action: "stop and inspect first failure"
    });

    const repeatedFailure = decide(
      input({ contextPercent: 42 }),
      transcript({
        toolCalls: 8,
        readToolCalls: 0,
        failedToolResults: 3,
        repeatedFailures: [{ toolName: "Bash", purpose: "tests", count: 3 }]
      })
    );

    expect(repeatedFailure).toMatchObject({
      state: "Stop",
      reasonCode: "repeated_tool_failure",
      action: "inspect first failure"
    });
  });

  it("keeps many edits without validation as Careful", () => {
    const decision = decide(
      input({ contextPercent: 42 }),
      transcript({ toolCalls: 8, readToolCalls: 0, successfulEditResults: 4, hasUnvalidatedEdits: true })
    );

    expect(decision).toMatchObject({
      state: "Careful",
      reasonCode: "edit_without_validation",
      action: "ask Claude to run the smallest relevant check"
    });
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
      diagnosis: "research-heavy session usually ended OK",
      baselineNote: "similar research-heavy sessions usually ended OK",
      action: "continue"
    });
    expect(renderStatusLine(decision, 140)).toContain("research-heavy session usually ended OK");
  });

  it("prefers recent read-heavy baseline evidence over stale all-time history", () => {
    const current = transcript({ toolCalls: 8, readToolCalls: 7 });
    const staleAllTime = decide(input({ contextPercent: 42 }), current, {
      baseline: {
        recent: {
          windowKind: "newest_files",
          windowSize: 100,
          transcriptFilesScanned: 20,
          sessionsSeen: 20
        },
        scenarios: {
          read_heavy_debugging: { seen: 16, recentSeen: 0, confidence: "medium" }
        },
        outcomes: {
          healthyLike: { readHeavyNoFailure: 16 }
        }
      }
    });

    expect(staleAllTime).toMatchObject({
      state: "Healthy",
      reasonCode: "healthy"
    });

    const recentHealthy = decide(input({ contextPercent: 42 }), current, {
      baseline: {
        recent: {
          windowKind: "newest_files",
          windowSize: 100,
          transcriptFilesScanned: 20,
          sessionsSeen: 20
        },
        scenarios: {
          read_heavy_debugging: { seen: 16, recentSeen: 4, confidence: "medium" }
        },
        outcomes: {
          healthyLike: { readHeavyNoFailure: 16 }
        }
      }
    });

    expect(recentHealthy).toMatchObject({
      state: "Healthy",
      reasonCode: "read_heavy_debugging",
      diagnosis: "research-heavy session usually ended OK"
    });
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
      baselineNote: "similar past loops usually needed intervention"
    });
    expect(renderStatusLine(decision, 120)).toContain("why: test loop: past runs ended badly");
  });

  it("uses unrecovered validation history for hard test-loop Stop wording", () => {
    const decision = decide(
      input({ contextPercent: 42 }),
      transcript({
        failedToolResults: 3,
        repeatedFailures: [{ toolName: "Bash", purpose: "tests", count: 3 }]
      }),
      {
        baseline: {
          scenarios: {
            validation_command_loop: { seen: 8, recentSeen: 6, confidence: "high" }
          },
          validation: {
            tests: {
              calls: 30,
              failures: 18,
              failureRate: 0.6,
              recovered: 2,
              unrecovered: 8,
              recoveryRate: 0.2,
              averageFailuresBeforeRecovery: 2,
              medianFailuresBeforeRecovery: 2,
              p75FailuresBeforeRecovery: 3,
              fivePlusFailuresBeforeRecovery: 0
            }
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
      diagnosis: "test loop rarely recovered after 3 failures",
      baselineNote: "test loops rarely recovered after 3 failures",
      action: "stop retrying and inspect first failure"
    });
    expect(renderStatusLine(decision, 140)).toContain("why: test loop rarely recovered after 3 failures");
    expect(formatWhy(decision)).toContain("Baseline: test loops rarely recovered after 3 failures.");
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

    expect(why).toContain("Baseline: similar research-heavy sessions usually ended OK.");
    expect(why).not.toContain("16");
  });

  it("warns on compaction and cache-write risk before healthy fallback", () => {
    const compaction = decide(input(), transcript({ compactionEvents: 1 }));
    expect(compaction).toMatchObject({
      state: "Careful",
      reasonCode: "compaction_boundary",
      action: "ask Claude to restate current goal and next 3 steps"
    });

    const completedCompaction = decide(input(), transcript({ compactionEvents: 1, postCompactionActivity: 1 }));
    expect(completedCompaction).toMatchObject({
      state: "Healthy",
      reasonCode: "healthy"
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

    const currentTranscriptCacheRisk = decide(
      input(),
      transcript({
        usage: {
          cacheCreationInputTokens: 50_000,
          cacheReadInputTokens: 100
        },
        latestUsage: {
          cacheCreationInputTokens: 50_000,
          cacheReadInputTokens: 100
        },
        latestUsageTimestamp: "2026-02-03T00:00:01.000Z",
        latestTimestamp: "2026-02-03T00:00:01.000Z"
      })
    );
    expect(currentTranscriptCacheRisk).toMatchObject({
      state: "Careful",
      reasonCode: "cache_writes_high"
    });

    const staleTranscriptCacheRisk = decide(
      input(),
      transcript({
        usage: {
          cacheCreationInputTokens: 50_000,
          cacheReadInputTokens: 100
        },
        latestUsage: {
          cacheCreationInputTokens: 50_000,
          cacheReadInputTokens: 100
        },
        latestUsageTimestamp: "2026-02-03T00:00:01.000Z",
        latestTimestamp: "2026-02-03T00:00:02.000Z"
      })
    );
    expect(staleTranscriptCacheRisk).toMatchObject({
      state: "Healthy",
      reasonCode: "healthy"
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

  it("warns when session duration crosses the budget threshold", () => {
    const decision = decide(input({ durationMs: 46 * 60_000 }), transcript());

    expect(decision).toMatchObject({
      state: "Careful",
      reasonCode: "duration_budget",
      primaryEvidence: "session ran 46m",
      action: "ask Claude to summarize progress before continuing"
    });
    expect(renderStatusLine(decision, 120)).toContain("session ran 46m");
    expect(formatWhy(decision)).toContain("Reason: session ran 46m.");
  });

  it("uses configured cost and duration budget thresholds", () => {
    const previous = {
      ...decide(input({ costUsd: 0.1, costSource: "claude" }), transcript()),
      costUsd: 0.1
    };

    const costDecision = decide(
      input({ costUsd: 0.2, costSource: "claude" }),
      transcript(),
      {
        previous,
        budgetThresholds: { costDeltaCarefulUsd: 0.05 }
      }
    );
    expect(costDecision).toMatchObject({
      state: "Careful",
      reasonCode: "cost_growth",
      primaryEvidence: "cost +$0.10"
    });

    const durationDecision = decide(
      input({ durationMs: 6 * 60_000 }),
      transcript(),
      {
        budgetThresholds: { durationCarefulMs: 5 * 60_000 }
      }
    );
    expect(durationDecision).toMatchObject({
      state: "Careful",
      reasonCode: "duration_budget",
      primaryEvidence: "session ran 6m"
    });
  });

  it("uses high cost plus repeated failure as Stop evidence", () => {
    const previous = {
      ...decide(input({ costUsd: 0.1, costSource: "claude" }), transcript()),
      costUsd: 0.1
    };
    const decision = decide(
      input({ costUsd: 1.2, costSource: "claude" }),
      transcript({
        failedToolResults: 2,
        repeatedFailures: [{ toolName: "Bash", purpose: "tests", count: 2 }]
      }),
      {
        previous,
        budgetThresholds: { costDeltaCarefulUsd: 0.5 }
      }
    );

    expect(decision).toMatchObject({
      state: "Stop",
      reasonCode: "budget_with_repeated_failure",
      primaryEvidence: "cost +$1.10 plus tests failed twice",
      action: "stop and inspect first failure"
    });
    expect(renderStatusLine(decision, 160)).toContain("high cost plus repeated failures");
  });

  it("uses a strong baseline to suppress normal project cost and duration", () => {
    const baseline = {
      budget: {
        costSamples: 6,
        durationSamples: 6,
        p75CostUsd: 2.5,
        p90CostUsd: 4,
        p75DurationMs: 60 * 60_000,
        p90DurationMs: 90 * 60_000,
        confidence: "medium" as const
      }
    };

    const costDecision = decide(input({ costUsd: 2.4, costSource: "claude" }), transcript(), { baseline });
    const durationDecision = decide(input({ durationMs: 60 * 60_000 }), transcript(), { baseline });

    expect(costDecision).toMatchObject({
      state: "Healthy",
      reasonCode: "healthy"
    });
    expect(durationDecision).toMatchObject({
      state: "Healthy",
      reasonCode: "healthy"
    });
  });

  it("keeps budget plus no observed progress as stronger Careful wording", () => {
    const decision = decide(
      input({ durationMs: 60 * 60_000 }),
      transcript({ toolCalls: 9, readToolCalls: 0 })
    );

    expect(decision).toMatchObject({
      state: "Careful",
      reasonCode: "budget_busy_no_observed_progress",
      primaryEvidence: "session ran 1h plus 9 tool calls, no check or recovery seen",
      impact: "Budget is high and no observed progress signal was seen",
      action: "pause and ask Claude what changed before continuing"
    });
  });

  it("warns on high session cost without escalating to Stop", () => {
    const decision = decide(input({ costUsd: 2.25, costSource: "claude" }), transcript());

    expect(decision).toMatchObject({
      state: "Careful",
      reasonCode: "cost_budget",
      primaryEvidence: "cost $2.25",
      action: "ask Claude to summarize progress before continuing"
    });
    expect(formatWhy(decision)).toContain("Cost evidence: $2.2500.");
  });

  it("warns when cost rises quickly since the previous statusline update", () => {
    const previous = {
      ...decide(input({ costUsd: 0.4, costSource: "claude" }), transcript()),
      id: "previous-decision",
      costUsd: 0.4
    };
    const decision = decide(input({ costUsd: 1, costSource: "claude" }), transcript(), { previous });

    expect(decision).toMatchObject({
      state: "Careful",
      reasonCode: "cost_growth",
      primaryEvidence: "cost +$0.60",
      action: "ask Claude to summarize progress before continuing"
    });
    expect(formatWhy(decision)).toContain("Reason: cost +$0.60.");
  });

  it("labels estimated budget cost in statusline and why output", () => {
    const decision = decide(input({ costUsd: 2.25, costSource: "estimated" }), transcript());

    expect(decision).toMatchObject({
      state: "Careful",
      reasonCode: "cost_budget",
      primaryEvidence: "estimated cost $2.25"
    });
    expect(renderStatusLine(decision, 140)).toContain("estimated cost $2.25");
    expect(formatWhy(decision)).toContain("Cost evidence: estimated $2.2500.");
  });

  it("keeps missing cost and duration data safe", () => {
    expect(() => decide(input({ costUsd: undefined, durationMs: undefined }), transcript())).not.toThrow();
    expect(decide(input({ costUsd: undefined, durationMs: undefined }), transcript())).toMatchObject({
      state: "Healthy",
      reasonCode: "healthy"
    });
  });

  it("honors configured cost and duration budget thresholds", () => {
    const costDecision = decide(input({ costUsd: 0.25, costSource: "claude" }), transcript(), {
      budgetThresholds: { costUsd: 0.2 }
    });
    const durationDecision = decide(input({ durationMs: 10_000 }), transcript(), {
      budgetThresholds: { durationMs: 10_000 }
    });

    expect(costDecision).toMatchObject({
      state: "Careful",
      reasonCode: "cost_budget",
      primaryEvidence: "cost $0.25"
    });
    expect(durationDecision).toMatchObject({
      state: "Careful",
      reasonCode: "duration_budget",
      primaryEvidence: "session ran 1m"
    });
  });

  it("uses high cost plus repeated failure as Stop evidence", () => {
    const decision = decide(
      input({ costUsd: 2.5, costSource: "claude" }),
      transcript({
        failedToolResults: 2,
        repeatedFailures: [{ toolName: "Bash", purpose: "tests", count: 2 }]
      })
    );

    expect(decision).toMatchObject({
      state: "Stop",
      reasonCode: "budget_with_repeated_failure",
      diagnosis: "high cost plus repeated failures",
      primaryEvidence: "cost $2.50 plus tests failed twice",
      action: "stop and inspect first failure"
    });
    expect(renderStatusLine(decision, 140)).toContain("why: high cost plus repeated failures");
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
