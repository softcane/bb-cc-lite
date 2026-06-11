import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGauge } from "../src/gauge.js";
import { mergeHookSummary, parseHookPayload } from "../src/hooks.js";
import { hashValue } from "../src/paths.js";
import { hookSummary, readStore, recordHookEvent } from "../src/store.js";
import type { StatusLineInput, TranscriptSummary } from "../src/types.js";

const privacySentinels = [
  "BB_CC_LITE_RAW_PROMPT_SENTINEL",
  "BB_CC_LITE_ASSISTANT_TEXT_SENTINEL",
  "BB_CC_LITE_TOOL_OUTPUT_SENTINEL",
  "BB_CC_LITE_FILE_CONTENT_SENTINEL",
  "BB_CC_LITE_API_KEY_SENTINEL",
  "BB_CC_LITE_RAW_SESSION_SENTINEL",
  "/tmp/bb-cc-lite/private/workspace/src/secret.ts"
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

  it("parses PreCompact as safe derived compaction metadata", () => {
    const rawSessionId = `session-alpha-${privacySentinels[5]}`;
    const event = parseHookPayload(
      JSON.stringify({
        session_id: rawSessionId,
        hook_event_name: "PreCompact",
        timestamp: "2026-06-03T10:00:00.000Z",
        prompt: privacySentinels[0],
        assistant_text: privacySentinels[1],
        tool_response: {
          stdout: privacySentinels[2],
          content: privacySentinels[3]
        },
        cwd: privacySentinels[6],
        transcript_path: `${privacySentinels[6]}/transcript.jsonl`
      })
    );

    expect(event).toMatchObject({
      kind: "compaction",
      hookEventName: "PreCompact",
      compactionStage: "pre",
      timestamp: "2026-06-03T10:00:00.000Z",
      sessionKey: hashValue(rawSessionId)
    });
    expect(JSON.stringify(event)).not.toContain(rawSessionId);
    expectNoPrivacySentinels(event);
  });

  it("parses PostCompact as safe derived compaction metadata", () => {
    const event = parseHookPayload(
      JSON.stringify({
        session_id: "session-alpha",
        hook_event_name: "PostCompact",
        timestamp: "2026-06-03T10:01:00.000Z",
        last_assistant_message: privacySentinels[1],
        tool_response: {
          stderr: privacySentinels[2]
        },
        cwd: privacySentinels[6]
      })
    );

    expect(event).toMatchObject({
      kind: "compaction",
      hookEventName: "PostCompact",
      compactionStage: "post",
      timestamp: "2026-06-03T10:01:00.000Z",
      sessionKey: hashValue("session-alpha")
    });
    expectNoPrivacySentinels(event);
  });

  it("parses SessionStart source as safe lifecycle metadata", () => {
    const rawSessionId = `session-alpha-${privacySentinels[5]}`;
    for (const source of ["startup", "resume", "clear", "compact"] as const) {
      const event = parseHookPayload(
        JSON.stringify({
          session_id: rawSessionId,
          hook_event_name: "SessionStart",
          source,
          timestamp: "2026-06-04T10:00:00.000Z",
          prompt: privacySentinels[0],
          assistant_text: privacySentinels[1],
          tool_response: {
            stdout: privacySentinels[2],
            content: privacySentinels[3],
            api_key: privacySentinels[4]
          },
          cwd: privacySentinels[6],
          transcript_path: `${privacySentinels[6]}/transcript.jsonl`
        })
      );

      expect(event).toMatchObject({
        kind: "session_start",
        hookEventName: "SessionStart",
        lifecycleSource: source,
        timestamp: "2026-06-04T10:00:00.000Z",
        sessionKey: hashValue(rawSessionId)
      });
      expect(JSON.stringify(event)).not.toContain(rawSessionId);
      expectNoPrivacySentinels(event);
    }

    expect(
      parseHookPayload(
        JSON.stringify({
          session_id: rawSessionId,
          hook_event_name: "SessionStart",
          source: "private-raw-source"
        })
      )
    ).toMatchObject({
      kind: "session_start",
      lifecycleSource: "unknown"
    });
  });

  it("stores SessionStart lifecycle metadata without raw payload fields", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-hooks-sessionstart-"));
    try {
      const storePath = join(tempDir, "events.json");
      const rawSessionId = `session-alpha-${privacySentinels[5]}`;
      const event = parseHookPayload(
        JSON.stringify({
          session_id: rawSessionId,
          hook_event_name: "SessionStart",
          source: "resume",
          timestamp: "2026-06-04T10:00:00.000Z",
          prompt: privacySentinels[0],
          cwd: privacySentinels[6],
          transcript_path: `${privacySentinels[6]}/transcript.jsonl`
        })
      );
      if (!event) {
        throw new Error("expected SessionStart event");
      }

      await recordHookEvent(event, storePath);

      const store = await readStore(storePath);
      expect(store.hookEvents).toEqual([
        expect.objectContaining({
          kind: "session_start",
          hookEventName: "SessionStart",
          lifecycleSource: "resume",
          sessionKey: hashValue(rawSessionId)
        })
      ]);
      const storeText = await readFile(storePath, "utf8");
      expect(storeText).not.toContain(rawSessionId);
      expectNoPrivacySentinels(storeText);

      expect(await hookSummary(hashValue(rawSessionId), storePath)).toMatchObject({
        latestLifecycleSource: "resume",
        latestLifecycleTimestamp: "2026-06-04T10:00:00.000Z"
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("derives safe hashed file identity for successful full-file Read hooks", () => {
    const rawPath = privacySentinels[6];
    const event = parseHookPayload(
      JSON.stringify({
        session_id: "session-alpha",
        hook_event_name: "PostToolUse",
        tool_name: "Read",
        tool_input: {
          file_path: rawPath
        },
        tool_response: {
          content: privacySentinels[3]
        },
        prompt: privacySentinels[0]
      })
    );

    expect(event).toMatchObject({
      kind: "tool_success",
      toolName: "Read",
      fileIdentityHash: hashValue(rawPath),
      readKind: "full"
    });
    expect(JSON.stringify(event)).not.toContain(rawPath);
    expect(JSON.stringify(event)).not.toContain("secret.ts");
    expectNoPrivacySentinels(event);
  });

  it("returns no derived event for malformed hook payloads", () => {
    expect(parseHookPayload("{", "PreCompact")).toBeUndefined();
    expect(parseHookPayload("[]", "PostCompact")).toBeUndefined();
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

  it("sanitizes alphanumeric unknown hook tool names instead of treating them as safe built-ins", () => {
    const rawUnknownToolName = "PrivateCustomerLookupTool";
    const event = parseHookPayload(
      JSON.stringify({
        session_id: "session-alpha",
        hook_event_name: "PostToolUseFailure",
        tool_name: rawUnknownToolName,
        tool_input: {
          private_query: privacySentinels[0]
        }
      })
    );

    expect(event).toMatchObject({
      kind: "tool_failure",
      toolName: "tool"
    });
    expect(JSON.stringify(event)).not.toContain(rawUnknownToolName);
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

  it("stores compaction metadata without raw prompt, assistant, output, file, path, or session data", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-hooks-compaction-privacy-"));
    try {
      const storePath = join(tempDir, "events.json");
      const rawSessionId = `session-alpha-${privacySentinels[5]}`;
      for (const hookEventName of ["PreCompact", "PostCompact"]) {
        const event = parseHookPayload(
          JSON.stringify({
            session_id: rawSessionId,
            hook_event_name: hookEventName,
            prompt: privacySentinels[0],
            last_assistant_message: privacySentinels[1],
            tool_response: {
              stdout: privacySentinels[2],
              content: privacySentinels[3],
              api_key: privacySentinels[4]
            },
            cwd: privacySentinels[6],
            transcript_path: `${privacySentinels[6]}/transcript.jsonl`
          })
        );
        if (!event) {
          throw new Error("expected compaction event");
        }
        await recordHookEvent(event, storePath);
      }

      const store = await readStore(storePath);
      expect(store.hookEvents).toEqual([
        expect.objectContaining({
          kind: "compaction",
          hookEventName: "PreCompact",
          compactionStage: "pre",
          sessionKey: hashValue(rawSessionId)
        }),
        expect.objectContaining({
          kind: "compaction",
          hookEventName: "PostCompact",
          compactionStage: "post",
          sessionKey: hashValue(rawSessionId)
        })
      ]);
      const storeText = await readFile(storePath, "utf8");
      expect(storeText).not.toContain(rawSessionId);
      expectNoPrivacySentinels(storeText);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps concurrent hook writes from losing recent events", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-hooks-concurrent-"));
    try {
      const storePath = join(tempDir, "events.json");
      const events = Array.from({ length: 20 }, (_value, index) => {
        const event = parseHookPayload(
          JSON.stringify({
            session_id: "session-alpha",
            hook_event_name: "PostToolUseFailure",
            tool_name: "Bash",
            tool_input: {
              command: index % 2 === 0 ? "npm test" : "npm run lint"
            }
          })
        );
        if (!event) {
          throw new Error("expected hook event");
        }
        return event;
      });

      await Promise.all(events.map((event) => recordHookEvent(event, storePath)));

      const store = await readStore(storePath);
      expect(store.hookEvents).toHaveLength(20);
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
      const careful = buildGauge(input({ sessionId }), mergeHookSummary(transcript(), carefulSummary));
      expect(careful.light).toBe("blue");
      expect(careful.findings[0]).toMatchObject({ category: "blind_retry", evidence: "2 fails, no fix between runs" });

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
      const stop = buildGauge(input({ sessionId }), mergeHookSummary(transcript(), stopSummary));
      expect(stop.light).toBe("red");
      expect(stop.findings[0]).toMatchObject({ category: "blind_retry_loop", evidence: "3 fails, no fix between runs" });
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

  it("lets newer transcript validation success clear older hook-derived repeated failure risk", () => {
    const merged = mergeHookSummary(
      transcript({
        latestTimestamp: "2026-06-04T10:02:00.000Z",
        validationSuccesses: 1,
        validationRecovered: true,
        observedProgress: true
      }),
      {
        failedToolResults: 3,
        toolCalls: 3,
        readToolCalls: 0,
        successfulEditResults: 0,
        validationChecks: 3,
        validationSuccesses: 0,
        validationRecovered: false,
        hasUnvalidatedEdits: false,
        compactionEvents: 0,
        postCompactionActivity: 0,
        repeatedFailures: [{ toolName: "Bash", purpose: "tests", count: 3 }],
        blindRetry: {
          category: "tests",
          label: "test",
          attemptCount: 3,
          recovered: false,
          activeEnded: true,
          blindRetryFailureCount: 3
        },
        latestTimestamp: "2026-06-04T10:00:00.000Z",
        activeFullFileReads: []
      }
    );

    expect(merged.repeatedFailures).toEqual([]);
    expect(merged.blindRetry).toBeUndefined();
    expect(buildGauge(input({ sessionId: "session-alpha" }), merged).light).toBe("green");
  });

  it("bounds open hook failure risk at SessionStart clear lifecycle boundaries", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-hooks-clear-boundary-"));
    try {
      const storePath = join(tempDir, "events.json");
      const sessionId = "session-alpha";
      const sessionKey = hashValue(sessionId);
      for (let count = 0; count < 2; count += 1) {
        const event = parseHookPayload(
          JSON.stringify({
            session_id: sessionId,
            hook_event_name: "PostToolUseFailure",
            timestamp: `2026-06-04T10:0${count}:00.000Z`,
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

      const clear = parseHookPayload(
        JSON.stringify({
          session_id: sessionId,
          hook_event_name: "SessionStart",
          source: "clear",
          timestamp: "2026-06-04T10:02:00.000Z"
        })
      );
      if (!clear) {
        throw new Error("expected clear event");
      }
      await recordHookEvent(clear, storePath);

      const summary = await hookSummary(sessionKey, storePath);
      expect(summary).toMatchObject({
        latestLifecycleSource: "clear",
        repeatedFailures: []
      });
      expect(summary.blindRetry).toBeUndefined();
      expect(buildGauge(input({ sessionId }), mergeHookSummary(transcript(), summary)).light).toBe("green");
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
      const careful = buildGauge(input({ sessionId }), mergeHookSummary(transcript(), carefulSummary));
      expect(careful.light).toBe("blue");
      expect(careful.findings[0]).toMatchObject({ category: "blind_retry", evidence: "2 fails, no fix between runs" });

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
      const stop = buildGauge(input({ sessionId }), mergeHookSummary(transcript(), stopSummary));
      expect(stop.light).toBe("red");
      expect(stop.findings[0]).toMatchObject({ category: "blind_retry_loop", evidence: "3 fails, no fix between runs" });

      const storeText = await readFile(storePath, "utf8");
      expect(storeText).not.toContain(rawMcpName);
      expect(JSON.stringify(carefulSummary)).not.toContain(rawMcpName);
      expect(JSON.stringify(stopSummary)).not.toContain(rawMcpName);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("turns hook-derived unchanged full-file Reads into redundant-read decisions and resets after NotebookEdit", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-hooks-redundant-read-"));
    try {
      const storePath = join(tempDir, "events.json");
      const sessionId = "session-alpha";
      const sessionKey = hashValue(sessionId);
      const rawPath = privacySentinels[6];
      for (let count = 0; count < 2; count += 1) {
        const event = parseHookPayload(
          JSON.stringify({
            session_id: sessionId,
            hook_event_name: "PostToolUse",
            tool_name: "Read",
            tool_input: {
              file_path: rawPath
            },
            tool_response: {
              content: privacySentinels[3]
            },
            prompt: privacySentinels[0]
          })
        );
        if (!event) {
          throw new Error("expected hook event");
        }
        await recordHookEvent(event, storePath);
      }

      const carefulSummary = await hookSummary(sessionKey, storePath);
      expect(carefulSummary).toMatchObject({
        readToolCalls: 2,
        redundantRead: {
          fileIdentityHash: hashValue(rawPath),
          unchangedFullFileReadCount: 2,
          latestState: "Careful"
        },
        activeFullFileReads: [
          {
            fileIdentityHash: hashValue(rawPath),
            unchangedFullFileReadCount: 2
          }
        ]
      });
      expect(JSON.stringify(carefulSummary)).not.toContain("secret.ts");
      const redundantGauge = buildGauge(input({ sessionId }), mergeHookSummary(transcript(), carefulSummary));
      expect(redundantGauge.light).toBe("blue");
      expect(redundantGauge.findings[0]).toMatchObject({ category: "redundant_read", evidence: "same file reread twice" });

      const notebookEdit = parseHookPayload(
        JSON.stringify({
          session_id: sessionId,
          hook_event_name: "PostToolUse",
          tool_name: "NotebookEdit",
          tool_input: {
            notebook_path: rawPath,
            new_source: privacySentinels[3]
          },
          tool_response: {
            content: privacySentinels[3]
          },
          prompt: privacySentinels[0]
        })
      );
      if (!notebookEdit) {
        throw new Error("expected hook event");
      }
      await recordHookEvent(notebookEdit, storePath);

      const resetSummary = await hookSummary(sessionKey, storePath);
      expect(resetSummary.redundantRead).toBeUndefined();
      expect(resetSummary.activeFullFileReads).toEqual([]);
      expectNoPrivacySentinels(carefulSummary);
      expectNoPrivacySentinels(resetSummary);
      expectNoPrivacySentinels(await readFile(storePath, "utf8"));
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
      const decision = buildGauge(input({ sessionId, contextPercent: 42 }), mergeHookSummary(transcript(), summary));
      expect(decision.light).toBe("green");
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
    expect(buildGauge(input(), summary).light).toBe("green");
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
    const compactionGauge = buildGauge(input(), summary);
    expect(compactionGauge.light).toBe("blue");
    expect(compactionGauge.findings[0]).toMatchObject({ category: "compaction_goal_preservation" });
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
      const openGauge = buildGauge(input({ sessionId }), mergeHookSummary(transcript(), openBoundarySummary));
      expect(openGauge.light).toBe("blue");
      expect(openGauge.findings[0]).toMatchObject({ category: "compaction_goal_preservation" });

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
      expect(buildGauge(input({ sessionId }), mergeHookSummary(transcript(), completedSummary)).light).toBe("green");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses PreCompact as an open compaction boundary before later activity", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-hooks-precompact-"));
    try {
      const storePath = join(tempDir, "events.json");
      const sessionId = "session-alpha";
      const sessionKey = hashValue(sessionId);
      const preCompact = parseHookPayload(
        JSON.stringify({
          session_id: sessionId,
          hook_event_name: "PreCompact",
          timestamp: "2026-06-03T10:00:00.000Z",
          prompt: privacySentinels[0],
          cwd: privacySentinels[6]
        })
      );
      if (!preCompact) {
        throw new Error("expected compact event");
      }
      await recordHookEvent(preCompact, storePath);

      const openBoundarySummary = await hookSummary(sessionKey, storePath);
      expect(openBoundarySummary).toMatchObject({
        compactionEvents: 1,
        postCompactionActivity: 0,
        latestCompactionTimestamp: "2026-06-03T10:00:00.000Z"
      });
      const preCompactGauge = buildGauge(input({ sessionId }), mergeHookSummary(transcript(), openBoundarySummary));
      expect(preCompactGauge.light).toBe("blue");
      expect(preCompactGauge.findings[0]).toMatchObject({ category: "compaction_goal_preservation" });
      expectNoPrivacySentinels(openBoundarySummary, await readFile(storePath, "utf8"));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
