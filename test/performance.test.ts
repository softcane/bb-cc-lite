import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { runDeepAdvisoryAudit } from "../src/deep-advisory.js";
import { createStatusLine } from "../src/statusline.js";
import { parseTranscriptTail } from "../src/transcript.js";
import { pathExists, setIsolatedEnv } from "./helpers/temp.js";

describe("large transcript performance", () => {
  it("parses only the bounded transcript tail under the hard budget", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ccverdict-perf-"));
    try {
      const transcriptPath = join(tempDir, "large.jsonl");
      const line = JSON.stringify({
        timestamp: "2026-05-18T20:00:00.000Z",
        type: "assistant",
        message: {
          role: "assistant",
          usage: {
            input_tokens: 100,
            output_tokens: 10,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 50
          },
          content: [{ type: "text", text: "not stored" }]
        }
      });
      const repeat = Math.ceil((10 * 1024 * 1024) / (line.length + 1));
      await writeFile(transcriptPath, `${Array.from({ length: repeat }, () => line).join("\n")}\n`, "utf8");

      const startedAt = performance.now();
      const summary = await parseTranscriptTail(transcriptPath);
      const elapsedMs = performance.now() - startedAt;

      expect(summary.pathReadable).toBe(true);
      expect(summary.bytesRead).toBeLessThanOrEqual(512 * 1024);
      expect(summary.linesRead).toBeGreaterThan(100);
      expect(elapsedMs).toBeLessThan(300);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps direct deep advisory bounded on large JSONL input", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ccverdict-deep-perf-"));
    try {
      const transcriptPath = join(tempDir, "large-deep.jsonl");
      const filler = JSON.stringify({
        timestamp: "2026-05-18T20:00:00.000Z",
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "CCVERDICT_RAW_PROMPT_SENTINEL" }]
        }
      });
      const repeat = Math.ceil((10 * 1024 * 1024) / (filler.length + 1));
      await writeFile(
        transcriptPath,
        `${Array.from({ length: repeat }, () => filler).join("\n")}\n${privacyFailureTail().join("\n")}\n`,
        "utf8"
      );

      const startedAt = performance.now();
      const report = await runDeepAdvisoryAudit({ transcriptPath });
      const elapsedMs = performance.now() - startedAt;

      expect(report.sessionsScanned).toBe(1);
      expect(report.findings).toContainEqual(expect.objectContaining({ reasonCode: "blind_validation_retry" }));
      expect(elapsedMs).toBeLessThan(1000);
      expectNoPrivacySentinels(report);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps statusline rendering fast when a stale baseline only triggers background refresh", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ccverdict-statusline-refresh-perf-"));
    const restoreEnv = setIsolatedEnv({
      CCVERDICT_HOME: join(tempDir, "app-home"),
      CCVERDICT_STORE: join(tempDir, "app-home", "events.json"),
      CCVERDICT_COLOR: "0",
      CCVERDICT_AUTO_LEARN: undefined
    });
    try {
      const appHome = join(tempDir, "app-home");
      await mkdir(appHome, { recursive: true });
      await writeFile(join(appHome, "baseline.json"), `${JSON.stringify(staleBaseline())}\n`, "utf8");

      let spawned = 0;
      const startedAt = performance.now();
      const rendered = await createStatusLine(statusInput(), 180, {
        baselineRefresh: {
          appHomePath: appHome,
          spawnRefresh: () => {
            spawned += 1;
          }
        }
      });
      const elapsedMs = performance.now() - startedAt;

      expect(rendered.split("\n").filter(Boolean)).toHaveLength(1);
      expect(rendered).toContain("●");
      expect(spawned).toBe(1);
      expect(elapsedMs).toBeLessThan(300);
    } finally {
      restoreEnv();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not scan local Claude history synchronously while rendering statusline", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ccverdict-statusline-no-scan-"));
    const appHome = join(tempDir, "app-home");
    const homeDir = join(tempDir, "home");
    const projectDir = join(tempDir, "project");
    const storePath = join(appHome, "events.json");
    const restoreEnv = setIsolatedEnv({
      HOME: homeDir,
      CCVERDICT_HOME: appHome,
      CCVERDICT_STORE: storePath,
      CCVERDICT_COLOR: "0",
      CCVERDICT_AUTO_LEARN: "0"
    });
    try {
      await mkdir(join(homeDir, ".claude", "projects", "private-project"), { recursive: true });
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        join(homeDir, ".claude", "projects", "private-project", "raw-history.jsonl"),
        `${privacyFailureTail().join("\n")}\n`,
        "utf8"
      );

      const startedAt = performance.now();
      const rendered = await createStatusLine(
        statusInput({
          cwd: projectDir,
          terminal_width: 180
        }),
        180
      );
      const elapsedMs = performance.now() - startedAt;

      expect(rendered).toContain("●");
      expect(elapsedMs).toBeLessThan(300);
      await expect(pathExists(join(appHome, "baseline.json"))).resolves.toBe(false);
      expectNoPrivacySentinels(rendered, await readFile(storePath, "utf8"));
    } finally {
      restoreEnv();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps statusline fast and private with a large raw-data-heavy transcript", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ccverdict-statusline-private-perf-"));
    const appHome = join(tempDir, "app-home");
    const storePath = join(appHome, "events.json");
    const restoreEnv = setIsolatedEnv({
      CCVERDICT_HOME: appHome,
      CCVERDICT_STORE: storePath,
      CCVERDICT_COLOR: "0",
      CCVERDICT_AUTO_LEARN: "0"
    });
    try {
      const transcriptPath = join(tempDir, "large-private.jsonl");
      const filler = JSON.stringify({
        timestamp: "2026-05-18T20:00:00.000Z",
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "CCVERDICT_RAW_PROMPT_SENTINEL" }]
        }
      });
      const repeat = Math.ceil((10 * 1024 * 1024) / (filler.length + 1));
      await writeFile(
        transcriptPath,
        `${Array.from({ length: repeat }, () => filler).join("\n")}\n${privacyFailureTail().join("\n")}\n`,
        "utf8"
      );

      const startedAt = performance.now();
      const rendered = await createStatusLine(
        statusInput({
          session_id: "session-CCVERDICT_RAW_SESSION_SENTINEL",
          transcript_path: transcriptPath,
          terminal_width: 220
        }),
        220
      );
      const elapsedMs = performance.now() - startedAt;

      expect(rendered.split("\n").filter(Boolean)).toHaveLength(1);
      expect(rendered).toContain("■");
      expect(elapsedMs).toBeLessThan(500);
      expectNoPrivacySentinels(rendered, await readFile(storePath, "utf8"));
    } finally {
      restoreEnv();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function statusInput(overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    session_id: "refresh-perf-session",
    model: {
      id: "claude-sonnet-4-5",
      display_name: "Claude Sonnet 4.5"
    },
    terminal_width: 180,
    ...overrides
  })}\n`;
}

function privacyFailureTail(): string[] {
  const bashFailures = [1, 2, 3].flatMap((index) => [
    JSON.stringify({
      timestamp: `2026-05-18T20:01:0${index}.000Z`,
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: `private-fail-${index}`,
            name: "Bash",
            input: {
              command: "npm test -- CCVERDICT_RAW_COMMAND_SENTINEL /tmp/ccverdict/private/worktree/src/secret.ts",
              file_path: "/tmp/ccverdict/private/worktree/src/secret.ts",
              query: "CCVERDICT_RAW_PROMPT_SENTINEL"
            }
          }
        ]
      }
    }),
    JSON.stringify({
      timestamp: `2026-05-18T20:02:0${index}.000Z`,
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: `private-fail-${index}`,
            is_error: true,
            content: "CCVERDICT_TOOL_OUTPUT_SENTINEL CCVERDICT_FILE_CONTENT_SENTINEL"
          }
        ]
      }
    })
  ]);
  const mcpFailure = [
    JSON.stringify({
      timestamp: "2026-05-18T20:03:00.000Z",
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "private-mcp-fail",
            name: "mcp__privateServer__rawPrivacyTool",
            input: {
              query: "CCVERDICT_RAW_PROMPT_SENTINEL"
            }
          }
        ]
      }
    }),
    JSON.stringify({
      timestamp: "2026-05-18T20:03:01.000Z",
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "private-mcp-fail",
            is_error: true,
            content: "CCVERDICT_TOOL_OUTPUT_SENTINEL"
          }
        ]
      }
    })
  ];
  return [...bashFailures, ...mcpFailure];
}

function expectNoPrivacySentinels(...values: unknown[]): void {
  const serialized = values.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join("\n");
  for (const sentinel of [
    "CCVERDICT_RAW_PROMPT_SENTINEL",
    "CCVERDICT_TOOL_OUTPUT_SENTINEL",
    "CCVERDICT_FILE_CONTENT_SENTINEL",
    "/tmp/ccverdict/private/worktree/src/secret.ts",
    "CCVERDICT_RAW_COMMAND_SENTINEL",
    "CCVERDICT_RAW_SESSION_SENTINEL",
    "mcp__privateServer__rawPrivacyTool"
  ]) {
    expect(serialized).not.toContain(sentinel);
  }
}

function staleBaseline(): Record<string, unknown> {
  return {
    schema: "ccverdict.baseline.v1",
    version: 1,
    createdAt: "2000-01-01T00:00:00.000Z",
    updatedAt: "2000-01-01T00:00:00.000Z",
    source: {
      kind: "local_transcript_scan",
      transcriptFilesScanned: 1,
      sessionsSeen: 1,
      malformedLines: 0,
      maxBytesPerTranscript: 1048576,
      maxFiles: 1500
    },
    privacy: {
      rawPromptsStored: false,
      rawToolOutputStored: false,
      rawPathsStored: false,
      rawCommandsStored: false,
      perSessionRowsStored: false
    },
    totals: {
      toolCalls: 0,
      successfulToolResults: 0,
      failedToolResults: 0,
      validationCalls: 0,
      validationFailures: 0,
      validationSuccesses: 0,
      successfulEditResults: 0,
      readSearchToolCalls: 0
    },
    scenarios: {
      read_heavy_debugging: { seen: 0, confidence: "low" },
      repeated_failure: { seen: 0, confidence: "low" },
      validation_command_loop: { seen: 0, confidence: "low" },
      edit_without_validation: { seen: 0, confidence: "low" },
      validation_recovered: { seen: 0, confidence: "low" }
    },
    outcomes: {
      healthyLike: {
        validationPassedAfterEdit: 0,
        validationRecovered: 0,
        readHeavyNoFailure: 0
      },
      carefulLike: {
        editWithoutValidation: 0,
        toolFailureRecovered: 0,
        twoFailureStreakRecovered: 0
      },
      stopLike: {
        validationLoopUnrecovered: 0,
        toolLoopUnrecovered: 0,
        sessionEndedInFailureLoop: 0
      }
    },
    rates: {
      toolFailureRate: 0,
      repeatedFailureRate: 0,
      validationFailureRate: 0,
      cacheWritesHighRate: 0
    }
  };
}
