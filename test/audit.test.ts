import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { formatAuditReport, runAudit } from "../src/audit.js";

const privacySentinels = [
  "BB_CC_LITE_RAW_PROMPT_SENTINEL",
  "BB_CC_LITE_TOOL_OUTPUT_SENTINEL",
  "BB_CC_LITE_API_KEY_SENTINEL",
  "BB_CC_LITE_FILE_CONTENT_SENTINEL",
  "/tmp/bb-cc-lite/private/worktree/src/secret.ts",
  "BB_CC_LITE_RAW_COMMAND_SENTINEL",
  "BB_CC_LITE_RAW_SESSION_SENTINEL",
  "mcp__privateServer__rawPrivacyTool"
];

describe("audit", () => {
  it("reports install-free project findings from past Claude transcripts", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-audit-"));
    try {
      const homeDir = join(tempDir, "home");
      const projectDir = join(tempDir, "project");
      const transcriptDir = join(homeDir, ".claude", "projects", claudeProjectDirectoryName(projectDir));
      await writeTranscript(join(transcriptDir, "session.jsonl"), repeatedFailedTestTranscript(3));

      const report = await runAudit({ homeDir, projectDir });
      const formatted = formatAuditReport(report);

      expect(report).toMatchObject({
        scope: "project",
        sessionsScanned: 1,
        sessionsWithFindings: 1,
        repeatedRetriesSpotted: 2,
        estimatedSavings: {
          durationMinutes: 0,
          costUsd: 0,
          repeatedToolRunsAvoided: 2,
          confidence: "low",
          measured: false
        },
        reportConfidence: "high"
      });
      expect(report.findings[0]).toMatchObject({
        state: "Stop",
        confidence: "high",
        reasonCode: "blind_retry_loop",
        evidence: "same test failed 3x without a fix"
      });
      expect(formatted).toContain("bb retrospective audit");
      expect(formatted).toContain("Would have helped: 1 session");
      expect(formatted).toContain("Repeated retries spotted: 2");
      expect(formatted).toContain("Cost/time: not estimated");
      expect(formatted).not.toContain("Estimated saved:");
      expect(formatted).not.toContain("Savings estimate confidence:");
      expect(formatted).toContain("Report confidence: high");
      expect(formatted).toContain("npx --yes bb-cc-lite install --scope local");
      expectNoPrivacySentinels(report, formatted);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("finds project transcripts stored under Claude Code sanitized directory names", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-audit-sanitized-dir-"));
    try {
      const homeDir = join(tempDir, "home");
      const projectDir = join(tempDir, "project_with_underscore");
      const transcriptDir = join(homeDir, ".claude", "projects", claudeSanitizedProjectDirectoryName(projectDir));
      await writeTranscript(join(transcriptDir, "session.jsonl"), repeatedFailedTestTranscript(3));

      const report = await runAudit({ homeDir, projectDir });

      expect(report).toMatchObject({
        scope: "project",
        sessionsScanned: 1,
        sessionsWithFindings: 1,
        reportConfidence: "high"
      });
      expect(report.findings[0]).toMatchObject({
        reasonCode: "blind_retry_loop",
        evidence: "same test failed 3x without a fix"
      });
      expectNoPrivacySentinels(report);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps a no-finding audit explicit and low confidence for a small sample", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-audit-empty-"));
    try {
      const homeDir = join(tempDir, "home");
      const projectDir = join(tempDir, "project");
      const transcriptDir = join(homeDir, ".claude", "projects", claudeProjectDirectoryName(projectDir));
      await writeTranscript(join(transcriptDir, "healthy.jsonl"), successfulReadTranscript());

      const report = await runAudit({ homeDir, projectDir });
      const formatted = formatAuditReport(report);

      expect(report).toMatchObject({
        sessionsScanned: 1,
        sessionsWithFindings: 0,
        estimatedSavings: {
          durationMinutes: 0,
          costUsd: 0,
          repeatedToolRunsAvoided: 0,
          confidence: "low",
          measured: false
        },
        reportConfidence: "low"
      });
      expect(formatted).toContain("Findings");
      expect(formatted).toContain("none in the scanned transcript window.");
      expect(formatted).toContain("Repeated retries spotted: 0");
      expect(formatted).not.toContain("Estimated saved:");
      expect(formatted).toContain("Report confidence: low");
      expectNoPrivacySentinels(report, formatted);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses safe transcript cost and duration metadata for savings estimates when available", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-audit-savings-"));
    try {
      const transcriptPath = join(tempDir, "measured-session.jsonl");
      await writeTranscript(transcriptPath, repeatedFailedTestTranscriptWithMetrics());

      const report = await runAudit({ transcriptPath });
      const formatted = formatAuditReport(report);

      expect(report).toMatchObject({
        sessionsScanned: 1,
        sessionsWithFindings: 1,
        estimatedSavings: {
          durationMinutes: 2,
          costUsd: 0.08,
          repeatedToolRunsAvoided: 2,
          confidence: "medium",
          measured: true
        }
      });
      expect(formatted).toContain("Repeated retries spotted: 2");
      expect(formatted).toContain("Measured duplicate retry cost/time: 2 min, $0.08");
      expect(formatted).not.toContain("Savings estimate confidence:");
      expectNoPrivacySentinels(report, formatted);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("supports direct transcript audits without leaking private identifiers", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-audit-direct-"));
    try {
      const transcriptPath = join(tempDir, "private-session.jsonl");
      await writeTranscript(transcriptPath, repeatedFailedMcpTranscript(3));

      const report = await runAudit({ transcriptPath });
      const formatted = formatAuditReport(report);

      expect(report).toMatchObject({
        scope: "transcript",
        sessionsScanned: 1,
        sessionsWithFindings: 1,
        reportConfidence: "high"
      });
      expect(formatted).toContain("same MCP tool failed 3x without a fix");
      expect(formatted).not.toContain(transcriptPath);
      expectNoPrivacySentinels(report, formatted);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("can scan newest transcripts across all local Claude projects without naming projects", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-audit-all-"));
    try {
      const homeDir = join(tempDir, "home");
      const privateProjectName = "BB_CC_LITE_RAW_PROJECT_NAME_SENTINEL";
      await writeTranscript(
        join(homeDir, ".claude", "projects", privateProjectName, "unrecovered.jsonl"),
        repeatedFailedTestTranscript(3)
      );
      await writeTranscript(join(homeDir, ".claude", "projects", "other-project", "healthy.jsonl"), successfulReadTranscript());

      const report = await runAudit({ homeDir, allProjects: true, recent: 10 });
      const formatted = formatAuditReport(report);

      expect(report).toMatchObject({
        scope: "all-projects",
        sessionsScanned: 2,
        sessionsWithFindings: 1,
        reportConfidence: "high"
      });
      expect(formatted).toContain("Scope: all local project transcripts, newest 10");
      expect(formatted).not.toContain(privateProjectName);
      expect(JSON.stringify(report)).not.toContain(privateProjectName);
      expectNoPrivacySentinels(report, formatted);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function writeTranscript(path: string, lines: string[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
}

function claudeProjectDirectoryName(projectDir: string): string {
  return resolve(projectDir).replaceAll(/[\\/]/gu, "-");
}

function claudeSanitizedProjectDirectoryName(projectDir: string): string {
  return resolve(projectDir).replaceAll(/[^A-Za-z0-9.-]/gu, "-");
}

function repeatedFailedTestTranscript(count: number): string[] {
  return Array.from({ length: count }, (_value, index) => index + 1).flatMap((index) => [
    toolUse(`bash-test-${index}`, "Bash", { command: `npm test -- ${privacySentinels[5]}` }),
    toolResult(`bash-test-${index}`, true)
  ]);
}

function repeatedFailedTestTranscriptWithMetrics(): string[] {
  return [
    toolUse("bash-test-1", "Bash", { command: `npm test -- ${privacySentinels[5]}` }),
    toolResultWithMetrics("bash-test-1", true, 0.04, 60_000),
    toolUse("bash-test-2", "Bash", { command: `npm test -- ${privacySentinels[5]}` }),
    toolResultWithMetrics("bash-test-2", true, 0.08, 120_000),
    toolUse("bash-test-3", "Bash", { command: `npm test -- ${privacySentinels[5]}` }),
    toolResultWithMetrics("bash-test-3", true, 0.12, 180_000)
  ];
}

function repeatedFailedMcpTranscript(count: number): string[] {
  return Array.from({ length: count }, (_value, index) => index + 1).flatMap((index) => [
    toolUseWithSession(`mcp-${index}`, privacySentinels[7], { query: privacySentinels[0] }, privacySentinels[6]),
    toolResult(`mcp-${index}`, true)
  ]);
}

function successfulReadTranscript(): string[] {
  return [toolUse("read-1", "Read", { file_path: privacySentinels[4] }), toolResult("read-1", false)];
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
          content: `${privacySentinels[1]} ${privacySentinels[2]} ${privacySentinels[3]} ${privacySentinels[4]}`
        }
      ]
    }
  });
}

function toolResultWithMetrics(id: string, isError: boolean, totalCostUsd: number, totalDurationMs: number): string {
  return JSON.stringify({
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
          content: `${privacySentinels[1]} ${privacySentinels[2]} ${privacySentinels[3]} ${privacySentinels[4]}`
        }
      ]
    }
  });
}

function expectNoPrivacySentinels(...values: unknown[]): void {
  const serialized = values.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join("\n");
  for (const sentinel of privacySentinels) {
    expect(serialized).not.toContain(sentinel);
  }
}
