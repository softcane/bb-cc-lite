import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { createStatusLine } from "../src/statusline.js";
import { parseTranscriptTail } from "../src/transcript.js";
import { setIsolatedEnv } from "./helpers/temp.js";

describe("large transcript performance", () => {
  it("parses only the bounded transcript tail under the hard budget", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-perf-"));
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

  it("keeps statusline rendering fast when a stale baseline only triggers background refresh", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-statusline-refresh-perf-"));
    const restoreEnv = setIsolatedEnv({
      BB_CC_LITE_HOME: join(tempDir, "app-home"),
      BB_CC_LITE_STORE: join(tempDir, "app-home", "events.json"),
      BB_CC_LITE_COLOR: "0",
      BB_CC_LITE_AUTO_LEARN: undefined
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
      expect(rendered).toContain("bb: Healthy");
      expect(spawned).toBe(1);
      expect(elapsedMs).toBeLessThan(300);
    } finally {
      restoreEnv();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function statusInput(): string {
  return `${JSON.stringify({
    session_id: "refresh-perf-session",
    model: {
      id: "claude-sonnet-4-5",
      display_name: "Claude Sonnet 4.5"
    },
    terminal_width: 180
  })}\n`;
}

function staleBaseline(): Record<string, unknown> {
  return {
    schema: "bb-cc-lite.baseline.v1",
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
