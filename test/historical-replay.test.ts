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
      expect(metrics.warningLeadTimeAttempts).toBeGreaterThanOrEqual(0);
      expect(metrics.policies.current_fixed).toMatchObject({
        falseStopCount: 0,
        missedUnrecoveredLoopCount: 0,
        decisionFlipRate: 0,
        categoryCoverage: {
          tests: 2
        }
      });
      expect(metrics.policies.smoothed_recovery_wording.decisionFlipRate).toBe(0);
      expect(metrics.policies.hazard_threshold_candidate.missedUnrecoveredLoopCount).toBe(1);
      expect(metrics.policies.hazard_threshold_candidate.decisionFlipRate).toBeGreaterThan(0);
      expect(formatted).toContain("holdout sessions 2");
      expect(formatted).toContain("sessions evaluated 2");
      expect(formatted).toContain("warnings ");
      expect(formatted).toContain("project-baseline suppressions n/a (not replayed)");
      expect(formatted).toContain("average tool results before warning");
      expect(formatted).toContain("average cost before warning n/a");
      expect(formatted).toContain("average duration before warning n/a");
      expect(formatted).toContain("warning lead time");
      expect(formatted).toContain("decision flip rate");
      expect(formatted).toContain("policy comparison current_fixed false Stops");
      expect(formatted).toContain("hazard_threshold_candidate");
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

  it("keeps MCP and session identifiers out of replay metrics", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-replay-private-"));
    try {
      const claudeProjectsDir = join(tempDir, ".claude", "projects", "project");
      await mkdir(claudeProjectsDir, { recursive: true });
      const rawMcpName = "mcp__privateServer__BB_CC_LITE_RAW_MCP_SENTINEL";
      const rawSessionId = "BB_CC_LITE_RAW_SESSION_SENTINEL";
      const rawPrompt = "BB_CC_LITE_RAW_PROMPT_SENTINEL";
      const rawPath = "/private/BB_CC_LITE_RAW_PATH_SENTINEL.ts";

      const older = join(claudeProjectsDir, "older-mcp-recovered.jsonl");
      const newer = join(claudeProjectsDir, "newer-mcp-unrecovered.jsonl");
      await writeJsonl(older, recoveredMcpTranscript("older-mcp", rawMcpName, rawSessionId, rawPrompt, rawPath));
      await writeJsonl(newer, unrecoveredMcpTranscript("newer-mcp", rawMcpName, rawSessionId, rawPrompt));
      await setMtime(older, "2026-05-18T00:00:00.000Z");
      await setMtime(newer, "2026-05-19T00:00:00.000Z");

      const metrics = await evaluateHistoricalReplay({
        claudeProjectsDir: join(tempDir, ".claude", "projects"),
        maxFiles: 2,
        holdoutRatio: 0.5
      });
      const formatted = formatHistoricalReplayMetrics(metrics);
      const serializedMetrics = JSON.stringify(metrics);

      expect(metrics).toMatchObject({
        holdoutSessions: 1,
        evaluatedFailureEpisodes: 1,
        categoryCoverage: {
          mcp: 1
        }
      });
      expect(formatted).toContain("category coverage mcp:1");
      for (const sentinel of [rawMcpName, rawSessionId, rawPrompt, rawPath, "BB_CC_LITE_RAW_TOOL_OUTPUT_SENTINEL"]) {
        expect(formatted).not.toContain(sentinel);
        expect(serializedMetrics).not.toContain(sentinel);
      }
      expect(formatted).not.toContain(claudeProjectsDir);
      expect(formatted).not.toContain("mcp__");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("measures safe cost and duration before warning when transcript metrics are available", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-replay-budget-"));
    try {
      const claudeProjectsDir = join(tempDir, ".claude", "projects", "project");
      await mkdir(claudeProjectsDir, { recursive: true });
      const older = join(claudeProjectsDir, "older-training.jsonl");
      const newer = join(claudeProjectsDir, "newer-holdout.jsonl");
      await writeJsonl(older, recoveredTestTranscript("older-budget"));
      await writeJsonl(newer, unrecoveredBlindTestTranscriptWithMetrics("holdout-budget"));
      await setMtime(older, "2026-05-18T00:00:00.000Z");
      await setMtime(newer, "2026-05-19T00:00:00.000Z");

      const metrics = await evaluateHistoricalReplay({
        claudeProjectsDir: join(tempDir, ".claude", "projects"),
        maxFiles: 2,
        holdoutRatio: 0.5
      });
      const formatted = formatHistoricalReplayMetrics(metrics);

      expect(metrics.averageToolResultsBeforeWarning).toBe(2);
      expect(metrics.averageCostBeforeWarning).toBeGreaterThan(0);
      expect(metrics.averageDurationBeforeWarning).toBeGreaterThan(0);
      expect(formatted).toContain("average cost before warning $");
      expect(formatted).toContain("average duration before warning ");
      expect(formatted).not.toContain(claudeProjectsDir);
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

function unrecoveredBlindTestTranscriptWithMetrics(prefix: string): string[] {
  return [
    toolUse(`${prefix}-fail-1`, "Bash", { command: "npm test -- BB_CC_LITE_RAW_COMMAND_SENTINEL" }),
    toolResultWithMetrics(`${prefix}-fail-1`, true, "2026-05-19T00:00:01.000Z", 0.04, 1000),
    toolUse(`${prefix}-fail-2`, "Bash", { command: "npm test" }),
    toolResultWithMetrics(`${prefix}-fail-2`, true, "2026-05-19T00:02:00.000Z", 0.12, 120000),
    toolUse(`${prefix}-fail-3`, "Bash", { command: "npm test" }),
    toolResultWithMetrics(`${prefix}-fail-3`, true, "2026-05-19T00:03:00.000Z", 0.2, 180000)
  ];
}

function recoveredMcpTranscript(
  prefix: string,
  rawMcpName: string,
  rawSessionId: string,
  rawPrompt: string,
  rawPath: string
): string[] {
  return [
    ...failedMcpCommand(`${prefix}-fail-1`, rawMcpName, rawSessionId, rawPrompt),
    ...successfulEditWithPath(`${prefix}-edit`, rawPath),
    ...successfulMcpCommand(`${prefix}-pass`, rawMcpName, rawSessionId, rawPrompt)
  ];
}

function unrecoveredMcpTranscript(prefix: string, rawMcpName: string, rawSessionId: string, rawPrompt: string): string[] {
  return [
    ...failedMcpCommand(`${prefix}-fail-1`, rawMcpName, rawSessionId, rawPrompt),
    ...failedMcpCommand(`${prefix}-fail-2`, rawMcpName, rawSessionId, rawPrompt),
    ...failedMcpCommand(`${prefix}-fail-3`, rawMcpName, rawSessionId, rawPrompt)
  ];
}

function successfulEdit(id: string): string[] {
  return [
    toolUse(id, "Edit", { file_path: "/private/BB_CC_LITE_RAW_PATH_SENTINEL.ts", new_string: "private" }),
    toolResult(id, false)
  ];
}

function successfulEditWithPath(id: string, rawPath: string): string[] {
  return [toolUse(id, "Edit", { file_path: rawPath, new_string: "BB_CC_LITE_RAW_FILE_CONTENT_SENTINEL" }), toolResult(id, false)];
}

function failedBashCommand(id: string, command: string): string[] {
  return [toolUse(id, "Bash", { command }), toolResult(id, true)];
}

function successfulBashCommand(id: string, command: string): string[] {
  return [toolUse(id, "Bash", { command }), toolResult(id, false)];
}

function failedMcpCommand(id: string, rawMcpName: string, rawSessionId: string, rawPrompt: string): string[] {
  return [toolUseWithSession(id, rawMcpName, { query: rawPrompt }, rawSessionId), toolResult(id, true)];
}

function successfulMcpCommand(id: string, rawMcpName: string, rawSessionId: string, rawPrompt: string): string[] {
  return [toolUseWithSession(id, rawMcpName, { query: rawPrompt }, rawSessionId), toolResult(id, false)];
}

function toolUse(id: string, name: string, input: Record<string, unknown>): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id, name, input }]
    }
  });
}

function toolUseWithSession(id: string, name: string, input: Record<string, unknown>, rawSessionId: string): string {
  return JSON.stringify({
    session_id: rawSessionId,
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

function toolResultWithMetrics(id: string, isError: boolean, timestamp: string, totalCostUsd: number, totalDurationMs: number): string {
  return JSON.stringify({
    timestamp,
    type: "user",
    cost: {
      total_cost_usd: totalCostUsd,
      total_duration_ms: totalDurationMs
    },
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
