import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderStatusLine } from "../src/renderer.js";
import { decide } from "../src/signals.js";
import { parseTranscriptLines, parseTranscriptTail } from "../src/transcript.js";
import type { StatusLineInput } from "../src/types.js";

const privacySentinels = [
  "BB_CC_LITE_RAW_PROMPT_SENTINEL",
  "BB_CC_LITE_TOOL_OUTPUT_SENTINEL",
  "BB_CC_LITE_API_KEY_SENTINEL"
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

    for (const sentinel of privacySentinels) {
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
    expectNoPrivacySentinels(checked);
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

  it("counts a successful MCP tool call without warning or leaking the raw name", () => {
    const rawMcpName = "mcp__privateServer__lookupCustomer";
    const summary = parseTranscriptLines(mcpToolPairs(rawMcpName, [false]));

    expect(summary.toolCalls).toBe(1);
    expect(summary.failedToolResults).toBe(0);
    expect(summary.repeatedFailures).toEqual([]);
    expect(JSON.stringify(summary)).not.toContain(rawMcpName);
    expect(decide(input({ contextPercent: 42 }), summary)).toMatchObject({
      state: "Healthy",
      reasonCode: "healthy"
    });
  });

  it("warns carefully after the same MCP tool fails twice without exposing the raw name", () => {
    const rawMcpName = "mcp__privateServer__failingLookup";
    const summary = parseTranscriptLines(mcpToolPairs(rawMcpName, [true, true]));
    const decision = decide(input({ contextPercent: 42 }), summary);
    const rendered = renderStatusLine(decision, 180);

    expect(summary.repeatedFailures).toEqual([
      { toolName: "MCP tool", category: "MCP", identityHash: expect.any(String), count: 2 }
    ]);
    expect(decision).toMatchObject({
      state: "Careful",
      reasonCode: "tool_failure_repeated",
      primaryEvidence: "MCP tool failed 2x",
      action: "inspect the failing MCP step before another retry"
    });
    expect(rendered).toContain("bb: Careful | MCP tool failed 2x | inspect the failing MCP step before another retry");
    expect(rendered).not.toContain(rawMcpName);
    expectNoPrivacySentinels(summary);
  });

  it("stops after the same MCP tool fails three times without exposing the raw name", () => {
    const rawMcpName = "mcp__privateServer__failingLookup";
    const decision = decide(input({ contextPercent: 42 }), parseTranscriptLines(mcpToolPairs(rawMcpName, [true, true, true])));
    const rendered = renderStatusLine(decision, 200);

    expect(decision).toMatchObject({
      state: "Stop",
      reasonCode: "repeated_tool_failure",
      primaryEvidence: "MCP tool failed 3x",
      impact: "Claude is retrying the same failing MCP tool",
      action: "inspect MCP server/tool config before more retries"
    });
    expect(rendered).toContain(
      "bb: Stop | why: MCP tool failed 3x; Claude is retrying the same failing MCP tool | do: inspect MCP server/tool config before more retries"
    );
    expect(rendered).not.toContain(rawMcpName);
  });

  it("clears an MCP repeated failure when the same MCP tool later succeeds", () => {
    const rawMcpName = "mcp__privateServer__eventualSuccess";
    const summary = parseTranscriptLines(mcpToolPairs(rawMcpName, [true, true, false]));

    expect(summary.failedToolResults).toBe(2);
    expect(summary.toolCalls).toBe(3);
    expect(summary.repeatedFailures).toEqual([]);
    expect(decide(input({ contextPercent: 42 }), summary)).toMatchObject({
      state: "Healthy",
      reasonCode: "healthy"
    });
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
    expect(decide(input({ contextPercent: 42 }), summary)).toMatchObject({
      state: "Healthy",
      reasonCode: "healthy"
    });
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
    expect(summary.repeatedFailures).toEqual([{ toolName: "Bash", purpose: "tests", count: 2 }]);
    expectNoPrivacySentinels(summary);
  });

  it("returns an unreadable empty summary when no path is supplied", async () => {
    await expect(parseTranscriptTail(undefined)).resolves.toMatchObject({
      pathReadable: false,
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

function mcpToolPairs(rawName: string, results: boolean[], offset = 0): string[] {
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
              content: isError ? privacySentinels[1] : "safe derived success"
            }
          ]
        }
      })
    ];
  });
}
