import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mergeHookSummary, parseHookPayload } from "../src/hooks.js";
import { hashValue } from "../src/paths.js";
import { decide } from "../src/signals.js";
import { hookSummary, recordHookEvent } from "../src/store.js";
import type { StatusLineInput, TranscriptSummary } from "../src/types.js";

const privacySentinels = [
  "BB_CC_LITE_RAW_PROMPT_SENTINEL",
  "BB_CC_LITE_TOOL_OUTPUT_SENTINEL",
  "BB_CC_LITE_API_KEY_SENTINEL"
];

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

function expectNoPrivacySentinels(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const sentinel of privacySentinels) {
    expect(serialized).not.toContain(sentinel);
  }
}

describe("optional Claude Code hooks", () => {
  it("derives compact metadata from hook JSON without storing raw prompt or tool output", () => {
    const event = parseHookPayload(
      JSON.stringify({
        session_id: "session-alpha",
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        tool_input: {
          command: `npm test -- ${privacySentinels[0]}`
        },
        tool_response: {
          stderr: privacySentinels[1],
          api_key: privacySentinels[2]
        },
        prompt: privacySentinels[0]
      })
    );

    expect(event).toMatchObject({
      kind: "tool_failure",
      hookEventName: "PostToolUseFailure",
      sessionKey: hashValue("session-alpha"),
      toolName: "Bash",
      purpose: "tests"
    });
    expectNoPrivacySentinels(event);
  });

  it("uses the installed hook argument as a fallback event name", () => {
    const event = parseHookPayload(
      JSON.stringify({
        session_id: "session-alpha",
        tool_name: "Bash",
        tool_input: {
          command: "npm test"
        }
      }),
      "PostToolUseFailure"
    );

    expect(event).toMatchObject({
      kind: "tool_failure",
      hookEventName: "PostToolUseFailure",
      toolName: "Bash",
      purpose: "tests"
    });
  });

  it("sanitizes unsafe hook tool names so statusline evidence stays one-line", () => {
    const event = parseHookPayload(
      JSON.stringify({
        session_id: "session-alpha",
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash\nBB_CC_LITE_TOOL_OUTPUT_SENTINEL",
        tool_input: {
          command: "npm test"
        }
      })
    );

    expect(event).toMatchObject({
      kind: "tool_failure",
      toolName: "tool"
    });
    expectNoPrivacySentinels(event);
  });

  it("stores hook events without raw prompt or tool-output sentinels", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-hooks-privacy-"));
    try {
      const storePath = join(tempDir, "events.json");
      const event = parseHookPayload(
        JSON.stringify({
          session_id: `session-${privacySentinels[0]}`,
          hook_event_name: "PostToolUseFailure",
          tool_name: "Bash",
          tool_input: {
            command: `npm test -- ${privacySentinels[0]}`
          },
          tool_response: {
            stdout: privacySentinels[1],
            apiKey: privacySentinels[2]
          }
        })
      );
      if (!event) {
        throw new Error("expected hook event");
      }

      await recordHookEvent(event, storePath);

      expectNoPrivacySentinels(await readFile(storePath, "utf8"));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("stores hook-derived MCP tool events with only safe names and hashes", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-hooks-mcp-privacy-"));
    try {
      const storePath = join(tempDir, "events.json");
      const rawMcpName = "mcp__privateServer__failingLookup";
      const event = parseHookPayload(
        JSON.stringify({
          session_id: "session-alpha",
          hook_event_name: "PostToolUseFailure",
          tool_name: rawMcpName,
          tool_input: {
            private_query: privacySentinels[0]
          },
          tool_response: {
            stderr: privacySentinels[1]
          }
        })
      );
      if (!event) {
        throw new Error("expected hook event");
      }

      expect(event).toMatchObject({
        kind: "tool_failure",
        toolName: "MCP tool",
        category: "MCP",
        identityHash: expect.any(String)
      });
      await recordHookEvent(event, storePath);

      const storeText = await readFile(storePath, "utf8");
      expect(storeText).not.toContain(rawMcpName);
      expect(storeText).toContain("MCP tool");
      expect(storeText).toContain("\"category\": \"MCP\"");
      expectNoPrivacySentinels(storeText);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("turns hook telemetry into Careful before Stop for repeated failures", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-hooks-"));
    try {
      const storePath = join(tempDir, "events.json");
      const sessionId = "session-alpha";
      const sessionKey = hashValue(sessionId);
      for (let count = 0; count < 2; count += 1) {
        const event = parseHookPayload(
          JSON.stringify({
            session_id: sessionId,
            hook_event_name: "PostToolUseFailure",
            tool_name: "Bash",
            tool_input: {
              command: "npm test"
            }
          })
        );
        if (!event) {
          throw new Error("expected hook event");
        }
        await recordHookEvent(event, storePath);
      }

      const carefulSummary = await hookSummary(sessionKey, storePath);
      expectNoPrivacySentinels(await readFile(storePath, "utf8"));
      const careful = decide(input({ sessionId }), mergeHookSummary(transcript(), carefulSummary));
      expect(careful).toMatchObject({
        state: "Careful",
        reasonCode: "tool_failure_repeated",
        primaryEvidence: "Bash failed 2x running tests"
      });

      const thirdEvent = parseHookPayload(
        JSON.stringify({
          session_id: sessionId,
          hook_event_name: "PostToolUseFailure",
          tool_name: "Bash",
          tool_input: {
            command: "npm test"
          }
        })
      );
      if (!thirdEvent) {
        throw new Error("expected hook event");
      }
      await recordHookEvent(thirdEvent, storePath);

      const stopSummary = await hookSummary(sessionKey, storePath);
      const stop = decide(input({ sessionId }), mergeHookSummary(transcript(), stopSummary));
      expect(stop).toMatchObject({
        state: "Stop",
        reasonCode: "repeated_tool_failure",
        primaryEvidence: "Bash failed 3x running tests"
      });
      expect(await hookSummary(hashValue("other-session"), storePath)).toMatchObject({
        failedToolResults: 0,
        toolCalls: 0,
        compactionEvents: 0,
        repeatedFailures: []
      });
      expectNoPrivacySentinels(await hookSummary(sessionKey, storePath));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("turns hook-derived repeated MCP failures into the same Careful and Stop decisions", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-hooks-mcp-decisions-"));
    try {
      const storePath = join(tempDir, "events.json");
      const sessionId = "session-alpha";
      const sessionKey = hashValue(sessionId);
      const rawMcpName = "mcp__privateServer__failingLookup";
      for (let count = 0; count < 2; count += 1) {
        const event = parseHookPayload(
          JSON.stringify({
            session_id: sessionId,
            hook_event_name: "PostToolUseFailure",
            tool_name: rawMcpName
          })
        );
        if (!event) {
          throw new Error("expected hook event");
        }
        await recordHookEvent(event, storePath);
      }

      const carefulSummary = await hookSummary(sessionKey, storePath);
      const careful = decide(input({ sessionId }), mergeHookSummary(transcript(), carefulSummary));
      expect(careful).toMatchObject({
        state: "Careful",
        reasonCode: "tool_failure_repeated",
        primaryEvidence: "MCP tool failed 2x",
        action: "inspect the failing MCP step before another retry"
      });

      const thirdEvent = parseHookPayload(
        JSON.stringify({
          session_id: sessionId,
          hook_event_name: "PostToolUseFailure",
          tool_name: rawMcpName
        })
      );
      if (!thirdEvent) {
        throw new Error("expected hook event");
      }
      await recordHookEvent(thirdEvent, storePath);

      const stopSummary = await hookSummary(sessionKey, storePath);
      const stop = decide(input({ sessionId }), mergeHookSummary(transcript(), stopSummary));
      expect(stop).toMatchObject({
        state: "Stop",
        reasonCode: "repeated_tool_failure",
        primaryEvidence: "MCP tool failed 3x",
        action: "inspect MCP server/tool config before more retries"
      });

      const storeText = await readFile(storePath, "utf8");
      expect(storeText).not.toContain(rawMcpName);
      expect(JSON.stringify(carefulSummary)).not.toContain(rawMcpName);
      expect(JSON.stringify(stopSummary)).not.toContain(rawMcpName);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("clears repeated hook failure findings after the same tool purpose succeeds", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-hooks-recovery-"));
    try {
      const storePath = join(tempDir, "events.json");
      const sessionId = "session-alpha";
      const sessionKey = hashValue(sessionId);
      for (let count = 0; count < 3; count += 1) {
        const event = parseHookPayload(
          JSON.stringify({
            session_id: sessionId,
            hook_event_name: "PostToolUseFailure",
            tool_name: "Bash",
            tool_input: {
              command: "npm test"
            }
          })
        );
        if (!event) {
          throw new Error("expected hook event");
        }
        await recordHookEvent(event, storePath);
      }

      const success = parseHookPayload(
        JSON.stringify({
          session_id: sessionId,
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: {
            command: "npm test"
          }
        })
      );
      if (!success) {
        throw new Error("expected hook event");
      }
      await recordHookEvent(success, storePath);

      const summary = await hookSummary(sessionKey, storePath);

      expect(summary).toMatchObject({
        failedToolResults: 3,
        toolCalls: 4,
        repeatedFailures: []
      });
      const decision = decide(input({ sessionId, contextPercent: 42 }), mergeHookSummary(transcript(), summary));
      expect(decision).toMatchObject({
        state: "Healthy",
        reasonCode: "healthy"
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("clears hook compaction when the transcript has later activity", () => {
    const summary = mergeHookSummary(
      transcript({
        latestTimestamp: "2026-02-03T00:00:02.000Z"
      }),
      {
        failedToolResults: 0,
        toolCalls: 0,
        compactionEvents: 1,
        postCompactionActivity: 0,
        repeatedFailures: [],
        latestTimestamp: "2026-02-03T00:00:01.000Z",
        latestCompactionTimestamp: "2026-02-03T00:00:01.000Z"
      }
    );

    expect(summary).toMatchObject({
      compactionEvents: 1,
      postCompactionActivity: 1
    });
    expect(decide(input(), summary)).toMatchObject({
      state: "Healthy",
      reasonCode: "healthy"
    });
  });

  it("keeps a newer transcript compaction open despite older hook activity", () => {
    const summary = mergeHookSummary(
      transcript({
        compactionEvents: 1,
        postCompactionActivity: 0,
        latestTimestamp: "2026-02-03T00:00:03.000Z",
        latestCompactionTimestamp: "2026-02-03T00:00:03.000Z"
      }),
      {
        failedToolResults: 0,
        toolCalls: 1,
        compactionEvents: 1,
        postCompactionActivity: 1,
        repeatedFailures: [],
        latestTimestamp: "2026-02-03T00:00:02.000Z",
        latestCompactionTimestamp: "2026-02-03T00:00:01.000Z"
      }
    );

    expect(summary).toMatchObject({
      compactionEvents: 1,
      postCompactionActivity: 0
    });
    expect(decide(input(), summary)).toMatchObject({
      state: "Careful",
      reasonCode: "compaction_boundary"
    });
  });

  it("clears hook-derived compaction warning after later hook activity", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-hooks-compaction-"));
    try {
      const storePath = join(tempDir, "events.json");
      const sessionId = "session-alpha";
      const sessionKey = hashValue(sessionId);
      const compact = parseHookPayload(
        JSON.stringify({
          session_id: sessionId,
          hook_event_name: "PostCompact"
        })
      );
      if (!compact) {
        throw new Error("expected compact event");
      }
      await recordHookEvent(compact, storePath);

      const openBoundarySummary = await hookSummary(sessionKey, storePath);
      expect(openBoundarySummary).toMatchObject({
        compactionEvents: 1,
        postCompactionActivity: 0
      });
      expect(decide(input({ sessionId }), mergeHookSummary(transcript(), openBoundarySummary))).toMatchObject({
        state: "Careful",
        reasonCode: "compaction_boundary"
      });

      const success = parseHookPayload(
        JSON.stringify({
          session_id: sessionId,
          hook_event_name: "PostToolUse",
          tool_name: "Read"
        })
      );
      if (!success) {
        throw new Error("expected tool event");
      }
      await recordHookEvent(success, storePath);

      const completedSummary = await hookSummary(sessionKey, storePath);
      expect(completedSummary).toMatchObject({
        compactionEvents: 1,
        postCompactionActivity: 1
      });
      expect(decide(input({ sessionId }), mergeHookSummary(transcript(), completedSummary))).toMatchObject({
        state: "Healthy",
        reasonCode: "healthy"
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
