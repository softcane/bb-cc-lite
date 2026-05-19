import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseTranscriptLines, parseTranscriptTail } from "../src/transcript.js";

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
