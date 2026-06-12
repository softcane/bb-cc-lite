import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildGauge } from "../src/gauge.js";
import { renderGauge } from "../src/gauge-renderer.js";
import { sessionKeyFromId } from "../src/session.js";
import { TOOL_RESULT_EXPLOSION_THRESHOLD_TOKENS, parseTranscriptLines, parseTranscriptTail } from "../src/transcript.js";
import type { StatusLineInput } from "../src/types.js";

const privacySentinels = [
  "CCVERDICT_RAW_PROMPT_SENTINEL",
  "CCVERDICT_TOOL_OUTPUT_SENTINEL",
  "CCVERDICT_API_KEY_SENTINEL",
  "CCVERDICT_RAW_PATH_SENTINEL",
  "CCVERDICT_FILE_CONTENT_SENTINEL"
];

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`./fixtures/transcripts/${name}`, import.meta.url));
}

function nonEmptyLines(raw: string): string[] {
  return raw.split(/\r?\n/u).filter(Boolean);
}

function expectNoPrivacySentinels(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const sentinel of privacySentinels) {
    expect(serialized).not.toContain(sentinel);
  }
}

function input(overrides: Partial<StatusLineInput> = {}): StatusLineInput {
  return {
    rawValid: true,
    sessionId: "session-alpha",
    model: { id: "claude-sonnet-4-5" },
    usage: {},
    ...overrides
  };
}

describe("parseTranscriptLines", () => {
  it("summarizes transcript events without retaining raw prompts or tool output", async () => {
    const raw = await readFile(fixturePath("mixed-events.jsonl"), "utf8");

    for (const sentinel of privacySentinels.slice(0, 3)) {
      expect(raw).toContain(sentinel);
    }

    const summary = parseTranscriptLines(nonEmptyLines(raw), Buffer.byteLength(raw));

    expect(summary).toMatchObject({
      pathReadable: true,
      bytesRead: Buffer.byteLength(raw),
      linesRead: 10,
      malformedLines: 1,
      toolCalls: 5,
      readToolCalls: 0,
      failedToolResults: 3,
      repeatedFailures: [{ toolName: "Bash", purpose: "tests", count: 2 }],
      editTestLoopFailures: 2,
      hasUnvalidatedEdits: false,
      validationRecovered: false,
      compactionEvents: 1,
      usage: {
        inputTokens: 150,
        outputTokens: 30,
        cacheCreationInputTokens: 10,
        cacheReadInputTokens: 90,
        totalTokens: 270
      },
      latestTimestamp: "2026-02-03T00:00:09.000Z"
    });
    expectNoPrivacySentinels(summary);
  });

  it("counts parseable user and assistant activity without storing message content", () => {
    const summary = parseTranscriptLines([
      JSON.stringify({
        timestamp: "2026-02-03T00:00:00.000Z",
        type: "user",
        message: {
          role: "user",
          content: privacySentinels[0]
        }
      }),
      JSON.stringify({
        timestamp: "2026-02-03T00:00:01.000Z",
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "assistant content is not retained" }]
        }
      }),
      "not-json"
    ]);

    expect(summary).toMatchObject({
      linesRead: 3,
      parseableLines: 2,
      malformedLines: 1,
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 0
    });
    expectNoPrivacySentinels(summary);
    expect(JSON.stringify(summary)).not.toContain("assistant content is not retained");
  });

  it("detects a second unchanged full-file Read without retaining the raw path or file contents", () => {
    const rawPath = `/Users/private/${privacySentinels[3]}/src/secret.ts`;
    const summary = parseTranscriptLines([
      ...readToolPair("read-1", rawPath),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: privacySentinels[0]
        }
      }),
      ...readToolPair("read-2", rawPath)
    ]);

    expect(summary.readToolCalls).toBe(2);
    expect(summary.redundantRead).toMatchObject({
      fileIdentityHash: expect.stringMatching(/^[a-f0-9]{16}$/u),
      unchangedFullFileReadCount: 2,
      latestState: "Careful",
      // Basename is display-safe and now rides the summary so the gauge can name the file (grill I3).
      basename: "secret.ts"
    });
    expect(JSON.stringify(summary)).not.toContain(rawPath);
    expectNoPrivacySentinels(summary);
  });

  it("detects a third unchanged full-file Read as a Stop-level transcript finding", () => {
    const rawPath = `/Users/private/${privacySentinels[3]}/src/secret.ts`;
    const summary = parseTranscriptLines([
      ...readToolPair("read-1", rawPath),
      ...readToolPair("read-2", rawPath),
      ...readToolPair("read-3", rawPath)
    ]);

    expect(summary.redundantRead).toMatchObject({
      unchangedFullFileReadCount: 3,
      latestState: "Stop",
      basename: "secret.ts"
    });
    expect(JSON.stringify(summary)).not.toContain(rawPath);
    expectNoPrivacySentinels(summary);
  });

  it("never counts permission-gate declines as tool failures", () => {
    const summary = parseTranscriptLines([
      ...deniedBashPair(1, "npm test"),
      ...deniedBashPair(2, "npm test")
    ]);

    expect(summary.failedToolResults).toBe(0);
    expect(summary.repeatedFailures).toEqual([]);
    expect(summary.blindRetry).toBeUndefined();
    expect(summary.editTestLoopFailures).toBe(0);
  });

  it("still counts genuine repeated failures (decline contrast)", () => {
    const summary = parseTranscriptLines([...failedBashTestPair(1), ...failedBashTestPair(2)]);

    expect(summary.failedToolResults).toBe(2);
    expect(summary.repeatedFailures.some((failure) => failure.count >= 2)).toBe(true);
  });

  it.each(["Edit", "Write", "MultiEdit", "NotebookEdit"] as const)(
    "resets unchanged full-file Read tracking after a successful same-file %s",
    (toolName) => {
      const rawPath = `/Users/private/${privacySentinels[3]}/src/secret.ts`;
      const summary = parseTranscriptLines([
        ...readToolPair("read-before", rawPath),
        ...mutationToolPair("mutation-1", toolName, rawPath),
        ...readToolPair("read-after", rawPath)
      ]);

      expect(summary.redundantRead).toBeUndefined();
      expect(summary.readToolCalls).toBe(2);
      expect(JSON.stringify(summary)).not.toContain(rawPath);
      expectNoPrivacySentinels(summary);
    }
  );

  it("does not let partial Reads trigger the redundant-read decision path", () => {
    const rawPath = `/Users/private/${privacySentinels[3]}/src/secret.ts`;
    const summary = parseTranscriptLines([
      ...readToolPair("partial-1", rawPath, { offset: 1 }),
      ...readToolPair("partial-2", rawPath, { limit: 50 }),
      ...readToolPair("partial-3", rawPath, { offset: 10, limit: 20 })
    ]);
    const gauge = buildGauge(input({ contextPercent: 42 }), summary);

    expect(summary.redundantRead).toBeUndefined();
    expect(gauge.light).toBe("green");
    expectNoPrivacySentinels(summary);
  });

  it("ignores malformed JSONL while tracking redundant Reads safely", () => {
    const rawPath = `/Users/private/${privacySentinels[3]}/src/secret.ts`;
    const summary = parseTranscriptLines([
      ...readToolPair("read-1", rawPath),
      `{"type":"assistant","message":${privacySentinels[0]}`,
      ...readToolPair("read-2", rawPath),
      ...readToolPair("read-3", rawPath)
    ]);

    expect(summary.malformedLines).toBe(1);
    expect(summary.redundantRead).toMatchObject({
      unchangedFullFileReadCount: 3,
      latestState: "Stop"
    });
    expect(JSON.stringify(summary)).not.toContain(rawPath);
    expectNoPrivacySentinels(summary);
  });

  it("clears repeated failure findings after the same tool purpose succeeds", () => {
    const lines = [
      ...failedBashTestPair(1),
      ...failedBashTestPair(2),
      ...failedBashTestPair(3),
      JSON.stringify({
        timestamp: "2026-02-03T00:00:07.000Z",
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "bash-test-success",
              name: "Bash",
              input: {
                command: "npm test"
              }
            }
          ]
        }
      }),
      JSON.stringify({
        timestamp: "2026-02-03T00:00:08.000Z",
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "bash-test-success",
              is_error: false,
              content: "tests passed"
            }
          ]
        }
      })
    ];

    const summary = parseTranscriptLines(lines);

    expect(summary.failedToolResults).toBe(3);
    expect(summary.toolCalls).toBe(4);
    expect(summary.repeatedFailures).toEqual([]);
  });

  it("marks successful edits as unvalidated until later validation succeeds", () => {
    const edited = parseTranscriptLines([
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "edit-1", name: "Edit", input: { file_path: "/secret/path.ts" } }]
        }
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "edit-1", is_error: false, content: "edited private file" }]
        }
      })
    ]);

    expect(edited.hasUnvalidatedEdits).toBe(true);

    const checked = parseTranscriptLines([
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "edit-1", name: "Edit", input: { file_path: "/secret/path.ts" } }]
        }
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "edit-1", is_error: false, content: "edited private file" }]
        }
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "test-1", name: "Bash", input: { command: "npm test" } }]
        }
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "test-1", is_error: false, content: "tests passed" }]
        }
      })
    ]);

    expect(checked.hasUnvalidatedEdits).toBe(false);
    expect(checked.unvalidatedEditResultCount).toBe(0);
    expect(checked.unvalidatedChangedFileIdentityCount).toBe(0);
    expectNoPrivacySentinels(checked);
  });

  it("tracks unvalidated edit counts, changed file identities, failed edits, and terminal events safely", () => {
    const firstPath = `/Users/private/${privacySentinels[3]}/src/first-secret.ts`;
    const secondPath = `/Users/private/${privacySentinels[3]}/src/second-secret.ts`;
    const summary = parseTranscriptLines([
      ...mutationToolPair("edit-1", "Edit", firstPath),
      ...mutationToolPair("write-1", "Write", secondPath),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "edit-failed", name: "Edit", input: { file_path: firstPath } }]
        }
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "edit-failed", is_error: true, content: privacySentinels[1] }]
        }
      }),
      ...readToolPair("read-after-failed-edit", firstPath),
      JSON.stringify({
        timestamp: "2026-02-03T00:00:10.000Z",
        hook_event_name: "SessionEnd"
      })
    ]);

    expect(summary).toMatchObject({
      successfulEditResults: 2,
      failedEditResults: 1,
      unvalidatedEditResultCount: 2,
      changedFileIdentityCount: 2,
      unvalidatedChangedFileIdentityCount: 2,
      workContinuedAfterFailedEdit: true,
      terminalEvents: 1,
      latestTerminalEvent: "session_end"
    });
    expect(JSON.stringify(summary)).not.toContain(firstPath);
    expect(JSON.stringify(summary)).not.toContain(secondPath);
    expectNoPrivacySentinels(summary);
  });

  it("treats successful lint, typecheck, and build commands as edit validation", () => {
    for (const command of ["npm run lint", "npm run typecheck", "npm run build"]) {
      const summary = parseTranscriptLines([
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "edit-1", name: "Edit", input: { file_path: "/secret/path.ts" } }]
          }
        }),
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "edit-1", is_error: false, content: "edited private file" }]
          }
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "check-1", name: "Bash", input: { command } }]
          }
        }),
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "check-1", is_error: false, content: "validation passed" }]
          }
        })
      ]);

      expect(summary.hasUnvalidatedEdits, command).toBe(false);
      expectNoPrivacySentinels(summary);
    }
  });

  it("tracks latest usage separately from max usage across the transcript tail", () => {
    const summary = parseTranscriptLines([
      JSON.stringify({
        timestamp: "2026-02-03T00:00:01.000Z",
        type: "assistant",
        usage: {
          cache_creation_input_tokens: 50_000,
          cache_read_input_tokens: 100
        }
      }),
      JSON.stringify({
        timestamp: "2026-02-03T00:00:02.000Z",
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "later normal activity" }]
        }
      })
    ]);

    expect(summary.usage).toMatchObject({
      cacheCreationInputTokens: 50_000,
      cacheReadInputTokens: 100
    });
    expect(summary.latestUsage).toMatchObject({
      cacheCreationInputTokens: 50_000,
      cacheReadInputTokens: 100
    });
    expect(summary.latestUsageTimestamp).toBe("2026-02-03T00:00:01.000Z");
    expect(summary.latestTimestamp).toBe("2026-02-03T00:00:02.000Z");
  });

  it("tracks cache read share with input, cache creation, and cache read tokens in the denominator", () => {
    const summary = parseTranscriptLines([
      assistantCacheUsageLine({
        inputTokens: 200,
        cacheCreationInputTokens: 100,
        cacheReadInputTokens: 700,
        timestamp: "2026-02-03T00:00:01.000Z"
      }),
      assistantCacheUsageLine({
        inputTokens: 700,
        cacheCreationInputTokens: 100,
        cacheReadInputTokens: 200,
        timestamp: "2026-02-03T00:00:02.000Z"
      })
    ]);

    expect(summary.cacheReadShare?.peak.totalInputTokens).toBe(1_000);
    expect(summary.cacheReadShare?.peak.ratio).toBeCloseTo(0.7);
    expect(summary.cacheReadShare?.current.totalInputTokens).toBe(1_000);
    expect(summary.cacheReadShare?.current.ratio).toBeCloseTo(0.2);
    expect(summary.cacheReadShare?.dropPercentagePoints).toBeCloseTo(50);
  });

  it("ignores cache read share samples when usage fields are missing or malformed", () => {
    const missingInput = parseTranscriptLines([
      JSON.stringify({
        timestamp: "2026-02-03T00:00:01.000Z",
        type: "assistant",
        message: {
          role: "assistant",
          usage: {
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: 700
          },
          content: [{ type: "text", text: privacySentinels[0] }]
        }
      })
    ]);
    const malformedUsage = parseTranscriptLines([
      JSON.stringify({
        timestamp: "2026-02-03T00:00:01.000Z",
        type: "assistant",
        message: {
          role: "assistant",
          usage: {
            input_tokens: 1_000,
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: -1
          },
          content: [{ type: "text", text: privacySentinels[0] }]
        }
      }),
      `{"type":"assistant","message":${privacySentinels[0]}`
    ]);

    expect(missingInput.cacheReadShare).toBeUndefined();
    expect(malformedUsage.malformedLines).toBe(1);
    expect(malformedUsage.cacheReadShare).toBeUndefined();
    expectNoPrivacySentinels(missingInput);
    expectNoPrivacySentinels(malformedUsage);
  });

  it("keeps cache read share summaries free of raw prompts, tool output, file contents, paths, and session ids", () => {
    const rawPath = `/tmp/${privacySentinels[3]}/private.ts`;
    const rawSessionId = `session-${privacySentinels[0]}`;
    const summary = parseTranscriptLines([
      JSON.stringify({
        timestamp: "2026-02-03T00:00:01.000Z",
        type: "assistant",
        session_id: rawSessionId,
        cwd: rawPath,
        message: {
          role: "assistant",
          usage: {
            input_tokens: 200,
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: 700
          },
          content: [{ type: "text", text: privacySentinels[0] }]
        }
      }),
      JSON.stringify({
        timestamp: "2026-02-03T00:00:02.000Z",
        type: "user",
        cwd: rawPath,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              is_error: false,
              content: `${privacySentinels[1]} ${privacySentinels[4]}`
            }
          ]
        }
      }),
      assistantCacheUsageLine({
        inputTokens: 700,
        cacheCreationInputTokens: 100,
        cacheReadInputTokens: 200,
        timestamp: "2026-02-03T00:00:03.000Z"
      })
    ]);

    expect(summary.cacheReadShare).toMatchObject({
      peak: {
        ratio: 0.7,
        totalInputTokens: 1_000
      },
      current: {
        ratio: 0.2,
        totalInputTokens: 1_000
      }
    });
    expect(JSON.stringify(summary)).not.toContain(rawPath);
    expect(JSON.stringify(summary)).not.toContain(rawSessionId);
    expectNoPrivacySentinels(summary);
  });

  it("extracts transcript session identity only as safe hashed keys", () => {
    const rawSessionId = `session-${privacySentinels[0]}`;
    const summary = parseTranscriptLines([
      JSON.stringify({
        timestamp: "2026-02-03T00:00:01.000Z",
        type: "user",
        sessionId: rawSessionId,
        message: {
          role: "user",
          content: privacySentinels[0]
        }
      }),
      JSON.stringify({
        timestamp: "2026-02-03T00:00:02.000Z",
        type: "assistant",
        session_id: rawSessionId,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "not retained" }]
        }
      })
    ]);

    expect(summary).toMatchObject({
      transcriptHasSessionIds: true,
      transcriptSessionKeyCount: 1,
      transcriptSessionKeys: [sessionKeyFromId(rawSessionId)]
    });
    expect(JSON.stringify(summary)).not.toContain(rawSessionId);
    expect(JSON.stringify(summary)).not.toContain("not retained");
    expectNoPrivacySentinels(summary);
  });

  it("tracks small assistant input-token jumps below the tool-result threshold", () => {
    const summary = parseTranscriptLines([
      assistantUsageLine(1_000, "2026-02-03T00:00:01.000Z"),
      toolResultLine("tool-1", "2026-02-03T00:00:02.000Z"),
      assistantUsageLine(4_900, "2026-02-03T00:00:03.000Z")
    ]);

    expect(summary.latestInputTokenJump).toEqual({
      previousInputTokens: 1_000,
      currentInputTokens: 4_900,
      inputTokenDelta: 3_900,
      toolResultCount: 1,
      thresholdTokens: TOOL_RESULT_EXPLOSION_THRESHOLD_TOKENS,
      crossedThreshold: false,
      timestamp: "2026-02-03T00:00:03.000Z"
    });
    expect(summary.largestInputTokenJump).toEqual(summary.latestInputTokenJump);
  });

  it("tracks input-token jumps above 8,000 tokens after one tool result", () => {
    const summary = parseTranscriptLines([
      assistantUsageLine(1_000, "2026-02-03T00:00:01.000Z"),
      toolResultLine("tool-1", "2026-02-03T00:00:02.000Z"),
      assistantUsageLine(13_400, "2026-02-03T00:00:03.000Z")
    ]);

    expect(summary.latestInputTokenJump).toMatchObject({
      previousInputTokens: 1_000,
      currentInputTokens: 13_400,
      inputTokenDelta: 12_400,
      toolResultCount: 1,
      thresholdTokens: 8_000,
      crossedThreshold: true
    });
    expect(summary.largestInputTokenJump).toEqual(summary.latestInputTokenJump);
  });

  it("tracks input-token jumps above 8,000 tokens after multiple tool results", () => {
    const summary = parseTranscriptLines([
      assistantUsageLine(2_000, "2026-02-03T00:00:01.000Z"),
      toolResultLine("tool-1", "2026-02-03T00:00:02.000Z"),
      toolResultLine("tool-2", "2026-02-03T00:00:03.000Z"),
      assistantUsageLine(15_000, "2026-02-03T00:00:04.000Z")
    ]);

    expect(summary.latestInputTokenJump).toMatchObject({
      inputTokenDelta: 13_000,
      toolResultCount: 2,
      crossedThreshold: true
    });
  });

  it("tracks large input-token jumps with no local tool result without blaming a tool", () => {
    const summary = parseTranscriptLines([
      assistantUsageLine(500, "2026-02-03T00:00:01.000Z"),
      userTextLine("2026-02-03T00:00:02.000Z"),
      assistantUsageLine(9_500, "2026-02-03T00:00:03.000Z")
    ]);
    expect(summary.latestInputTokenJump).toMatchObject({
      inputTokenDelta: 9_000,
      toolResultCount: 0,
      crossedThreshold: true
    });
    // Token jumps are tracked in the summary but are not a gauge detector (grill F2): light stays green.
    expect(buildGauge(input({ contextPercent: 42 }), summary).light).toBe("green");
  });

  it("skips assistant records with missing usage fields while keeping the next usage delta safe", () => {
    const missingPrevious = parseTranscriptLines([
      assistantWithoutUsageLine("2026-02-03T00:00:01.000Z"),
      toolResultLine("tool-1", "2026-02-03T00:00:02.000Z"),
      assistantUsageLine(12_000, "2026-02-03T00:00:03.000Z")
    ]);
    const skippedMiddle = parseTranscriptLines([
      assistantUsageLine(1_000, "2026-02-03T00:00:01.000Z"),
      assistantWithoutUsageLine("2026-02-03T00:00:02.000Z"),
      toolResultLine("tool-1", "2026-02-03T00:00:03.000Z"),
      assistantUsageLine(9_500, "2026-02-03T00:00:04.000Z")
    ]);

    expect(missingPrevious.latestInputTokenJump).toBeUndefined();
    expect(skippedMiddle.latestInputTokenJump).toMatchObject({
      previousInputTokens: 1_000,
      currentInputTokens: 9_500,
      inputTokenDelta: 8_500,
      toolResultCount: 1,
      crossedThreshold: true
    });
  });

  it("ignores negative input-token deltas and deltas across compaction boundaries", () => {
    const negativeDelta = parseTranscriptLines([
      assistantUsageLine(20_000, "2026-02-03T00:00:01.000Z"),
      toolResultLine("tool-1", "2026-02-03T00:00:02.000Z"),
      assistantUsageLine(12_000, "2026-02-03T00:00:03.000Z")
    ]);
    const compacted = parseTranscriptLines([
      assistantUsageLine(1_000, "2026-02-03T00:00:01.000Z"),
      toolResultLine("tool-1", "2026-02-03T00:00:02.000Z"),
      JSON.stringify({
        timestamp: "2026-02-03T00:00:03.000Z",
        type: "PostCompact"
      }),
      assistantUsageLine(12_000, "2026-02-03T00:00:04.000Z")
    ]);

    expect(negativeDelta.latestInputTokenJump).toBeUndefined();
    expect(compacted.compactionEvents).toBe(1);
    expect(compacted.latestInputTokenJump).toBeUndefined();
  });

  it("keeps token-jump detection resilient across malformed JSONL", () => {
    const summary = parseTranscriptLines([
      assistantUsageLine(1_000, "2026-02-03T00:00:01.000Z"),
      `{"type":"assistant","message":${privacySentinels[0]}`,
      toolResultLine("tool-1", "2026-02-03T00:00:02.000Z"),
      assistantUsageLine(10_000, "2026-02-03T00:00:03.000Z")
    ]);

    expect(summary.malformedLines).toBe(1);
    expect(summary.latestInputTokenJump).toMatchObject({
      inputTokenDelta: 9_000,
      toolResultCount: 1,
      crossedThreshold: true
    });
    expectNoPrivacySentinels(summary);
  });

  it("keeps token-jump summaries free of raw prompts, tool output, file contents, paths, and session ids", () => {
    const rawPath = `/tmp/${privacySentinels[3]}/private.ts`;
    const rawSessionId = `session-${privacySentinels[0]}`;
    const summary = parseTranscriptLines([
      JSON.stringify({
        timestamp: "2026-02-03T00:00:01.000Z",
        type: "assistant",
        session_id: rawSessionId,
        raw_path: rawPath,
        message: {
          role: "assistant",
          usage: { input_tokens: 1_000 },
          content: [{ type: "text", text: privacySentinels[0] }]
        }
      }),
      JSON.stringify({
        timestamp: "2026-02-03T00:00:02.000Z",
        type: "user",
        cwd: rawPath,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              is_error: false,
              content: `${privacySentinels[1]} ${privacySentinels[4]}`
            }
          ]
        }
      }),
      assistantUsageLine(13_400, "2026-02-03T00:00:03.000Z")
    ]);

    expect(summary.latestInputTokenJump).toMatchObject({
      inputTokenDelta: 12_400,
      toolResultCount: 1,
      crossedThreshold: true
    });
    expect(JSON.stringify(summary)).not.toContain(rawPath);
    expect(JSON.stringify(summary)).not.toContain(rawSessionId);
    expectNoPrivacySentinels(summary);
  });

  it("tracks safe tool-step lag after an unvalidated edit", () => {
    const summary = parseTranscriptLines([
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "edit-1", name: "Edit", input: { file_path: "/secret/path.ts" } }]
        }
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "edit-1", is_error: false, content: "edited private file" }]
        }
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: "/secret/path.ts" } }]
        }
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "read-1", is_error: false, content: "private content" }]
        }
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "grep-1", name: "Grep", input: { pattern: "private" } }]
        }
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "grep-1", is_error: false, content: "private match" }]
        }
      })
    ]);

    expect(summary.hasUnvalidatedEdits).toBe(true);
    expect(summary.unvalidatedEditToolSteps).toBe(2);
    expectNoPrivacySentinels(summary);
  });

  it("detects validation recovery after a failed validation later passes", () => {
    const summary = parseTranscriptLines([
      ...failedBashTestPair(1),
      JSON.stringify({
        timestamp: "2026-02-03T00:00:07.000Z",
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "test-success", name: "Bash", input: { command: "npm test" } }]
        }
      }),
      JSON.stringify({
        timestamp: "2026-02-03T00:00:08.000Z",
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "test-success", is_error: false, content: "tests passed" }]
        }
      })
    ]);

    expect(summary.validationRecovered).toBe(true);
    expect(summary.repeatedFailures).toEqual([]);
  });

  it("treats read-only shell exploration as read activity, not missing validation", () => {
    const summary = parseTranscriptLines(
      Array.from({ length: 9 }, (_value, index) => index + 1).flatMap((index) => [
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: `read-only-bash-${index}`,
                name: "Bash",
                input: {
                  command: index % 2 === 0 ? "git status --short" : "pwd"
                }
              }
            ]
          }
        }),
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: `read-only-bash-${index}`, is_error: false, content: "safe output" }]
          }
        })
      ])
    );
    expect(summary.toolCalls).toBe(9);
    expect(summary.readToolCalls).toBe(9);
    // Read-dominant, no failures: the gauge stays green and reads as exploring.
    expect(buildGauge(input({ contextPercent: 42 }), summary).light).toBe("green");
  });

  it("keeps compaction as an open boundary only until later activity appears", () => {
    const summary = parseTranscriptLines([
      JSON.stringify({
        timestamp: "2026-02-03T00:00:01.000Z",
        type: "PostCompact"
      }),
      JSON.stringify({
        timestamp: "2026-02-03T00:00:02.000Z",
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: "/secret/path.ts" } }]
        }
      }),
      JSON.stringify({
        timestamp: "2026-02-03T00:00:03.000Z",
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "read-1", is_error: false, content: "private content" }]
        }
      })
    ]);

    expect(summary.compactionEvents).toBe(1);
    expect(summary.postCompactionActivity).toBe(2);
    expectNoPrivacySentinels(summary);
  });

  it("clears stale edit-test loop failures after validation recovers", () => {
    const summary = parseTranscriptLines([
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "edit-1", name: "Edit", input: { file_path: "/secret/path.ts" } }]
        }
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "edit-1", is_error: false, content: "edited private file" }]
        }
      }),
      ...failedBashTestPair(1),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "edit-2", name: "Edit", input: { file_path: "/secret/path.ts" } }]
        }
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "edit-2", is_error: false, content: "edited private file" }]
        }
      }),
      ...failedBashTestPair(2),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "test-success", name: "Bash", input: { command: "npm test" } }]
        }
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "test-success", is_error: false, content: "tests passed" }]
        }
      })
    ]);

    expect(summary.validationRecovered).toBe(true);
    expect(summary.repeatedFailures).toEqual([]);
    expect(summary.editTestLoopFailures).toBe(0);
    expect(summary.hasUnvalidatedEdits).toBe(false);
  });

  it("classifies repeated typecheck failures as validation failures without storing commands", () => {
    const summary = parseTranscriptLines([
      ...failedBashCommandPair(1, "npm run typecheck -- --pretty false"),
      ...failedBashCommandPair(2, "npm run typecheck -- --pretty false")
    ]);

    expect(summary.repeatedFailures).toEqual([{ toolName: "Bash", purpose: "typecheck", count: 2 }]);
    expectNoPrivacySentinels(summary);
  });

  it("does not leak alphanumeric unknown tool names into summaries or statusline decisions", () => {
    const rawUnknownToolName = "PrivateCustomerLookupTool";
    const summary = parseTranscriptLines([
      ...toolPair("private-1", rawUnknownToolName, true, { private_query: "CCVERDICT_RAW_PROMPT_SENTINEL" }),
      ...toolPair("private-2", rawUnknownToolName, true, { private_query: "CCVERDICT_RAW_PROMPT_SENTINEL" })
    ]);
    const gauge = buildGauge(input({ contextPercent: 42 }), summary);
    const rendered = renderGauge(gauge, 180);

    expect(summary.repeatedFailures).toEqual([{ toolName: "tool", count: 2 }]);
    expect(gauge.light).toBe("blue");
    expect(gauge.findings[0]).toMatchObject({ category: "blind_retry", evidence: "2 fails, no fix between runs" });
    expect(JSON.stringify(summary)).not.toContain(rawUnknownToolName);
    expect(rendered).not.toContain(rawUnknownToolName);
    expectNoPrivacySentinels(summary);
  });

  it("counts a successful MCP tool call without warning or leaking the raw name", () => {
    const rawMcpName = "mcp__privateServer__lookupCustomer";
    const summary = parseTranscriptLines(mcpToolPairs(rawMcpName, [false]));

    expect(summary.toolCalls).toBe(1);
    expect(summary.failedToolResults).toBe(0);
    expect(summary.repeatedFailures).toEqual([]);
    expect(JSON.stringify(summary)).not.toContain(rawMcpName);
    expect(buildGauge(input({ contextPercent: 42 }), summary).light).toBe("green");
  });

  it("warns carefully after the same MCP tool fails twice without exposing the raw name", () => {
    const rawMcpName = "mcp__privateServer__failingLookup";
    const summary = parseTranscriptLines(mcpToolPairs(rawMcpName, [true, true]));
    const gauge = buildGauge(input({ contextPercent: 42 }), summary);
    const rendered = renderGauge(gauge, 180);

    expect(summary.repeatedFailures).toEqual([
      { toolName: "MCP tool", category: "MCP", identityHash: expect.any(String), count: 2 }
    ]);
    expect(gauge.light).toBe("blue");
    expect(gauge.findings[0]).toMatchObject({ category: "blind_retry", evidence: "2 fails, no fix between runs" });
    expect(rendered).not.toContain(rawMcpName);
    expectNoPrivacySentinels(summary);
  });

  it("does not attach Bash validation purpose labels to MCP results with validation-like titles", () => {
    const rawMcpName = "mcp__privateServer__testRunner";
    const summary = parseTranscriptLines(mcpToolPairs(rawMcpName, [true, true], 0, "tests failed"));

    expect(summary.repeatedFailures).toEqual([
      { toolName: "MCP tool", category: "MCP", identityHash: expect.any(String), count: 2 }
    ]);
    expect(JSON.stringify(summary)).not.toContain(rawMcpName);
  });

  it("stops after the same MCP tool fails three times without exposing the raw name", () => {
    const rawMcpName = "mcp__privateServer__failingLookup";
    const summary = parseTranscriptLines(mcpToolPairs(rawMcpName, [true, true, true]));
    const gauge = buildGauge(input({ contextPercent: 42 }), summary);
    const rendered = renderGauge(gauge, 200);

    expect(gauge.light).toBe("red");
    expect(gauge.findings[0]).toMatchObject({ category: "blind_retry_loop", evidence: "3 fails, no fix between runs" });
    expect(rendered).not.toContain(rawMcpName);
  });

  it("clears an MCP repeated failure when the same MCP tool later succeeds", () => {
    const rawMcpName = "mcp__privateServer__eventualSuccess";
    const summary = parseTranscriptLines(mcpToolPairs(rawMcpName, [true, true, false]));

    expect(summary.failedToolResults).toBe(2);
    expect(summary.toolCalls).toBe(3);
    expect(summary.repeatedFailures).toEqual([]);
    expect(buildGauge(input({ contextPercent: 42 }), summary).light).toBe("green");
    expect(JSON.stringify(summary)).not.toContain(rawMcpName);
  });

  it("does not merge one-off failures from different MCP tools", () => {
    const firstRawMcpName = "mcp__privateServer__firstFailure";
    const secondRawMcpName = "mcp__privateServer__secondFailure";
    const summary = parseTranscriptLines([
      ...mcpToolPairs(firstRawMcpName, [true]),
      ...mcpToolPairs(secondRawMcpName, [true], 10)
    ]);

    expect(summary.failedToolResults).toBe(2);
    expect(summary.repeatedFailures).toEqual([]);
    expect(buildGauge(input({ contextPercent: 42 }), summary).light).toBe("green");
    expect(JSON.stringify(summary)).not.toContain(firstRawMcpName);
    expect(JSON.stringify(summary)).not.toContain(secondRawMcpName);
  });
});

describe("parseTranscriptTail", () => {
  it("reads a transcript file through the bounded tail parser", async () => {
    const raw = await readFile(fixturePath("mixed-events.jsonl"), "utf8");

    const summary = await parseTranscriptTail(fixturePath("mixed-events.jsonl"), {
      maxBytes: Buffer.byteLength(raw)
    });

    expect(summary.pathReadable).toBe(true);
    expect(summary.linesRead).toBe(10);
    expect(summary.malformedLines).toBe(1);
    expect(summary.tailTruncated).toBe(false);
    expect(summary.repeatedFailures).toEqual([{ toolName: "Bash", purpose: "tests", count: 2 }]);
    expectNoPrivacySentinels(summary);
  });

  it("marks bounded tail reads that start after byte zero as tail truncated", async () => {
    const summary = await parseTranscriptTail(fixturePath("mixed-events.jsonl"), {
      maxBytes: 128
    });

    expect(summary.pathReadable).toBe(true);
    expect(summary.bytesRead).toBeLessThanOrEqual(128);
    expect(summary.tailTruncated).toBe(true);
    expectNoPrivacySentinels(summary);
  });

  it("returns an unreadable empty summary when no path is supplied", async () => {
    await expect(parseTranscriptTail(undefined)).resolves.toMatchObject({
      pathReadable: false,
      tailTruncated: false,
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
      usage: {}
    });
  });
});

function readToolPair(id: string, filePath: string, inputOverrides: Record<string, unknown> = {}): string[] {
  return [
    JSON.stringify({
      timestamp: "2026-02-03T00:00:00.000Z",
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id,
            name: "Read",
            input: {
              file_path: filePath,
              ...inputOverrides
            }
          }
        ]
      }
    }),
    JSON.stringify({
      timestamp: "2026-02-03T00:00:01.000Z",
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: id,
            is_error: false,
            content: privacySentinels[4]
          }
        ]
      }
    })
  ];
}

function mutationToolPair(id: string, name: "Edit" | "Write" | "MultiEdit" | "NotebookEdit", filePath: string): string[] {
  return [
    JSON.stringify({
      timestamp: "2026-02-03T00:00:02.000Z",
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id,
            name,
            input: mutationInputFor(name, filePath)
          }
        ]
      }
    }),
    JSON.stringify({
      timestamp: "2026-02-03T00:00:03.000Z",
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: id,
            is_error: false,
            content: privacySentinels[4]
          }
        ]
      }
    })
  ];
}

function mutationInputFor(name: "Edit" | "Write" | "MultiEdit" | "NotebookEdit", filePath: string): Record<string, unknown> {
  if (name === "Write") {
    return {
      file_path: filePath,
      content: privacySentinels[4]
    };
  }
  if (name === "MultiEdit") {
    return {
      file_path: filePath,
      edits: [
        {
          old_string: privacySentinels[4],
          new_string: "safe replacement"
        }
      ]
    };
  }
  if (name === "NotebookEdit") {
    return {
      notebook_path: filePath,
      cell_id: "safe-cell",
      new_source: "safe replacement"
    };
  }
  return {
    file_path: filePath,
    old_string: privacySentinels[4],
    new_string: "safe replacement"
  };
}

function failedBashTestPair(index: number): string[] {
  return failedBashCommandPair(index, "npm test");
}

function failedBashCommandPair(index: number, command: string): string[] {
  return [
    JSON.stringify({
      timestamp: `2026-02-03T00:00:0${index}.000Z`,
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
              id: `bash-test-${index}`,
              name: "Bash",
              input: {
              command
              }
            }
          ]
      }
    }),
    JSON.stringify({
      timestamp: `2026-02-03T00:00:1${index}.000Z`,
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: `bash-test-${index}`,
            is_error: true,
            content: "tests failed"
          }
        ]
      }
    })
  ];
}

// Mirrors Claude Code's permission-gate decline shape: is_error true with a harness-authored
// "tool use was rejected" message. These are user decisions, not program errors.
function deniedBashPair(index: number, command: string): string[] {
  return [
    JSON.stringify({
      timestamp: `2026-02-03T00:00:0${index}.000Z`,
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: `bash-deny-${index}`, name: "Bash", input: { command } }] }
    }),
    JSON.stringify({
      timestamp: `2026-02-03T00:00:1${index}.000Z`,
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: `bash-deny-${index}`,
            is_error: true,
            content:
              "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."
          }
        ]
      }
    })
  ];
}

function toolPair(id: string, name: string, isError: boolean, input: Record<string, unknown>): string[] {
  return [
    JSON.stringify({
      timestamp: "2026-02-03T00:00:00.000Z",
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id,
            name,
            input
          }
        ]
      }
    }),
    JSON.stringify({
      timestamp: "2026-02-03T00:00:01.000Z",
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: id,
            is_error: isError,
            content: privacySentinels[1]
          }
        ]
      }
    })
  ];
}

function mcpToolPairs(rawName: string, results: boolean[], offset = 0, title?: string): string[] {
  return results.flatMap((isError, index) => {
    const id = `mcp-${offset + index}`;
    return [
      JSON.stringify({
        timestamp: `2026-02-03T00:01:${String(offset + index).padStart(2, "0")}.000Z`,
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id,
              name: rawName,
              input: {
                query: privacySentinels[0]
              }
            }
          ]
        }
      }),
      JSON.stringify({
        timestamp: `2026-02-03T00:02:${String(offset + index).padStart(2, "0")}.000Z`,
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: id,
              is_error: isError,
              title,
              content: isError ? privacySentinels[1] : "safe derived success"
            }
          ]
        }
      })
    ];
  });
}

function assistantUsageLine(inputTokens: number, timestamp: string): string {
  return JSON.stringify({
    timestamp,
    type: "assistant",
    message: {
      role: "assistant",
      usage: {
        input_tokens: inputTokens
      },
      content: [{ type: "text", text: privacySentinels[0] }]
    }
  });
}

function assistantCacheUsageLine(args: {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  timestamp: string;
}): string {
  return JSON.stringify({
    timestamp: args.timestamp,
    type: "assistant",
    message: {
      role: "assistant",
      usage: {
        input_tokens: args.inputTokens,
        cache_creation_input_tokens: args.cacheCreationInputTokens,
        cache_read_input_tokens: args.cacheReadInputTokens
      },
      content: [{ type: "text", text: privacySentinels[0] }]
    }
  });
}

function assistantWithoutUsageLine(timestamp: string): string {
  return JSON.stringify({
    timestamp,
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: privacySentinels[0] }]
    }
  });
}

function toolResultLine(id: string, timestamp: string): string {
  return JSON.stringify({
    timestamp,
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          is_error: false,
          content: privacySentinels[1]
        }
      ]
    }
  });
}

function userTextLine(timestamp: string): string {
  return JSON.stringify({
    timestamp,
    type: "user",
    message: {
      role: "user",
      content: privacySentinels[0]
    }
  });
}
