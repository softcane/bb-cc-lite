import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateHistoricalReplay, formatHistoricalReplayMetrics } from "../src/historical-replay.js";

describe("historical replay evaluation", () => {
  it("prints aggregate-only holdout metrics from synthetic JSONL history", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-replay-"));
    try {
      const claudeProjectsDir = join(tempDir, ".claude", "projects", "project");
      await mkdir(claudeProjectsDir, { recursive: true });

      for (let index = 0; index < 6; index += 1) {
        const path = join(claudeProjectsDir, `older-recovered-${index}.jsonl`);
        await writeJsonl(path, recoveredTestTranscript(`older-${index}`));
        await setMtime(path, `2026-05-1${index}T00:00:00.000Z`);
      }
      const recoveredHoldout = join(claudeProjectsDir, "newer-recovered-holdout.jsonl");
      const blindHoldout = join(claudeProjectsDir, "newest-blind-holdout.jsonl");
      await writeJsonl(recoveredHoldout, recoveredTestTranscript("holdout-recovered"));
      await writeJsonl(blindHoldout, unrecoveredBlindTestTranscript("holdout-blind"));
      await setMtime(recoveredHoldout, "2026-05-18T00:00:00.000Z");
      await setMtime(blindHoldout, "2026-05-19T00:00:00.000Z");

      const metrics = await evaluateHistoricalReplay({
        claudeProjectsDir: join(tempDir, ".claude", "projects"),
        maxFiles: 8,
        holdoutRatio: 0.25
      });
      const formatted = formatHistoricalReplayMetrics(metrics);

      expect(metrics).toMatchObject({
        holdoutSessions: 2,
        evaluatedFailureEpisodes: 2,
        falseStopCountOnRecoveredEpisodes: 0,
        missedUnrecoveredLoopCount: 0,
        blindRetryPrecision: 1,
        categoryCoverage: {
          tests: 2
        }
      });
      expect(formatted).toContain("holdout sessions 2");
      expect(formatted).toContain("evaluated failure episodes 2");
      expect(formatted).toContain("Stop precision on unrecovered episodes");
      expect(formatted).toContain("blind retry precision 1.00");
      expect(formatted).toContain("category coverage tests:2");
      expect(formatted).not.toContain(claudeProjectsDir);
      expect(formatted).not.toContain("npm test");
      expect(formatted).not.toContain("BB_CC_LITE_RAW");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function writeJsonl(path: string, lines: string[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
}

async function setMtime(path: string, timestamp: string): Promise<void> {
  const date = new Date(timestamp);
  await utimes(path, date, date);
}

function recoveredTestTranscript(prefix: string): string[] {
  return [
    ...failedBashCommand(`${prefix}-fail-1`, "npm test -- BB_CC_LITE_RAW_COMMAND_SENTINEL"),
    ...successfulEdit(`${prefix}-edit`),
    ...failedBashCommand(`${prefix}-fail-2`, "npm test"),
    ...successfulBashCommand(`${prefix}-pass`, "npm test")
  ];
}

function unrecoveredBlindTestTranscript(prefix: string): string[] {
  return [
    ...failedBashCommand(`${prefix}-fail-1`, "npm test -- BB_CC_LITE_RAW_COMMAND_SENTINEL"),
    ...failedBashCommand(`${prefix}-fail-2`, "npm test"),
    ...failedBashCommand(`${prefix}-fail-3`, "npm test")
  ];
}

function successfulEdit(id: string): string[] {
  return [
    toolUse(id, "Edit", { file_path: "/private/BB_CC_LITE_RAW_PATH_SENTINEL.ts", new_string: "private" }),
    toolResult(id, false)
  ];
}

function failedBashCommand(id: string, command: string): string[] {
  return [toolUse(id, "Bash", { command }), toolResult(id, true)];
}

function successfulBashCommand(id: string, command: string): string[] {
  return [toolUse(id, "Bash", { command }), toolResult(id, false)];
}

function toolUse(id: string, name: string, input: Record<string, unknown>): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id, name, input }]
    }
  });
}

function toolResult(id: string, isError: boolean): string {
  return JSON.stringify({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          is_error: isError,
          content: "BB_CC_LITE_RAW_TOOL_OUTPUT_SENTINEL"
        }
      ]
    }
  });
}
