import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeDeepAdvisorySession,
  formatDeepAdvisoryReport,
  runDeepAdvisoryAudit
} from "../src/deep-advisory.js";
import { parseTranscriptLines } from "../src/transcript.js";

const privacySentinels = [
  "CCVERDICT_RAW_PROMPT_SENTINEL",
  "CCVERDICT_ASSISTANT_TEXT_SENTINEL",
  "CCVERDICT_TOOL_OUTPUT_SENTINEL",
  "CCVERDICT_SHELL_OUTPUT_SENTINEL",
  "CCVERDICT_RAW_COMMAND_SENTINEL",
  "CCVERDICT_FILE_CONTENT_SENTINEL",
  "CCVERDICT_RAW_SESSION_SENTINEL",
  "mcp__privateServer__rawPrivacyTool",
  "/tmp/ccverdict/private/workspace/src/secret.ts",
  "secret.ts"
];

describe("deep advisory", () => {
  it("reports multiple safe advisory paths for one Claude transcript", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ccverdict-deep-"));
    try {
      const transcriptPath = join(tempDir, "session.jsonl");
      await writeTranscript(transcriptPath, riskyTranscript());

      const report = await runDeepAdvisoryAudit({ transcriptPath });
      const formatted = formatDeepAdvisoryReport(report);
      const reasonCodes = report.findings.map((finding) => finding.reasonCode);

      expect(report).toMatchObject({
        kind: "deep-advisory",
        scope: "transcript",
        sessionsScanned: 1,
        unsupportedTranscripts: 0,
        sessionsWithFindings: 1,
        reportConfidence: "high",
        privacyValidated: true
      });
      expect(reasonCodes).toEqual(
        expect.arrayContaining([
          "blind_validation_retry",
          "write_failed_then_continued",
          "code_change_unvalidated",
          "many_edits_unvalidated",
          "many_changed_files_unvalidated",
          "redundant_read",
          "compaction_with_open_risk",
          "session_end_with_open_risk"
        ])
      );
      expect(report.findings[0]).toMatchObject({
        state: "Stop",
        confidence: "high",
        reasonCode: "blind_validation_retry"
      });
      expect(formatted).toContain("ccverdict deep advisory audit");
      expect(formatted).toContain("same test failed 3x without a code change");
      expect(formatted).toContain("3 changed file identities had no later check");
      expect(formatted).toContain("session stopped or ended while risk was still open");
      expectNoPrivacySentinels(report, formatted);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports validation recovery after a code change as a healthy finding", () => {
    const summary = parseTranscriptLines([
      ...failedBashTestPair(1),
      ...editPair("edit-after-failure", "/tmp/private/recovered.ts"),
      ...passedBashTestPair("test-success")
    ]);
    const session = analyzeDeepAdvisorySession(summary, { session: 1 });

    expect(session.findings).toContainEqual(
      expect.objectContaining({
        state: "Healthy",
        confidence: "medium",
        reasonCode: "validation_recovered_after_change",
        evidence: "test failure recovered after a code change"
      })
    );
    expectNoPrivacySentinels(session);
  });

  it("marks unsupported direct JSONL without pretending it was Claude Code", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ccverdict-deep-unsupported-"));
    try {
      const transcriptPath = join(tempDir, "codex.jsonl");
      await writeTranscript(transcriptPath, [
        JSON.stringify({
          source: "other-agent",
          event: "raw_event",
          prompt: privacySentinels[0],
          command: privacySentinels[4],
          path: privacySentinels[8],
          tool: privacySentinels[7]
        })
      ]);

      const report = await runDeepAdvisoryAudit({ transcriptPath });
      const formatted = formatDeepAdvisoryReport(report);

      expect(report).toMatchObject({
        sessionsScanned: 1,
        unsupportedTranscripts: 1,
        sessionsWithFindings: 0,
        reportConfidence: "low"
      });
      expect(formatted).toContain("Unsupported: 1 transcript did not look like Claude Code JSONL.");
      expectNoPrivacySentinels(report, formatted);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses project validation config without leaking configured commands", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ccverdict-deep-config-"));
    try {
      const homeDir = join(tempDir, "home");
      const projectDir = join(tempDir, "project");
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        join(projectDir, ".ccverdict.json"),
        `${JSON.stringify({ validationCommands: { tests: ["make private-check"] } })}\n`,
        "utf8"
      );
      await writeTranscript(
        join(homeDir, ".claude", "projects", claudeProjectDirectoryName(projectDir), "configured.jsonl"),
        [
          ...failedCommandPair("make private-check --target hidden", 1),
          ...failedCommandPair("make private-check --target hidden", 2)
        ]
      );

      const report = await runDeepAdvisoryAudit({ homeDir, projectDir });
      const serialized = JSON.stringify(report);

      expect(report.findings).toContainEqual(
        expect.objectContaining({
          reasonCode: "blind_validation_retry",
          evidence: "same test failed twice without a code change"
        })
      );
      expect(serialized).not.toContain("make private-check");
      expect(serialized).not.toContain("--target hidden");
      expectNoPrivacySentinels(report, formatDeepAdvisoryReport(report));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("scans all projects without exposing project directory names", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ccverdict-deep-all-"));
    try {
      const homeDir = join(tempDir, "home");
      const privateProjectName = "CCVERDICT_RAW_PROJECT_NAME_SENTINEL";
      await writeTranscript(
        join(homeDir, ".claude", "projects", privateProjectName, "session.jsonl"),
        riskyTranscript()
      );
      await writeTranscript(join(homeDir, ".claude", "projects", "other", "healthy.jsonl"), readPair("read-ok", "/tmp/safe.ts"));

      const report = await runDeepAdvisoryAudit({ homeDir, allProjects: true, recent: 10 });
      const formatted = formatDeepAdvisoryReport(report);

      expect(report).toMatchObject({
        scope: "all-projects",
        sessionsScanned: 2,
        sessionsWithFindings: 1
      });
      expect(formatted).toContain("Scope: all local project transcripts, newest 10");
      expect(JSON.stringify(report)).not.toContain(privateProjectName);
      expect(formatted).not.toContain(privateProjectName);
      expectNoPrivacySentinels(report, formatted);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("treats generic assistant text as unsupported low-confidence source", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ccverdict-deep-generic-"));
    try {
      const transcriptPath = join(tempDir, "generic.jsonl");
      await writeTranscript(transcriptPath, [
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: privacySentinels[1] }]
          }
        })
      ]);

      const report = await runDeepAdvisoryAudit({ transcriptPath });

      expect(report).toMatchObject({
        unsupportedTranscripts: 1,
        reportConfidence: "low"
      });
      expectNoPrivacySentinels(report, formatDeepAdvisoryReport(report));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("handles malformed JSONL softly", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ccverdict-deep-malformed-"));
    try {
      const transcriptPath = join(tempDir, "malformed.jsonl");
      await writeTranscript(transcriptPath, [`{"type":"assistant","message":${privacySentinels[0]}`]);

      const report = await runDeepAdvisoryAudit({ transcriptPath });
      const formatted = formatDeepAdvisoryReport(report);

      expect(report).toMatchObject({
        sessionsScanned: 1,
        unsupportedTranscripts: 1,
        sessionsWithFindings: 0,
        reportConfidence: "low"
      });
      expect(formatted).toContain("Unsupported: 1 transcript did not look like Claude Code JSONL.");
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

function riskyTranscript(): string[] {
  return [
    assistantTextLine(),
    ...failedBashTestPair(1),
    ...failedBashTestPair(2),
    ...failedBashTestPair(3),
    ...editPair("edit-1", "/tmp/private/src/a.ts"),
    ...editPair("edit-2", "/tmp/private/src/b.ts"),
    ...editPair("edit-3", "/tmp/private/src/c.ts"),
    toolUse("failed-edit", "Edit", { file_path: "/tmp/private/src/a.ts", old_string: privacySentinels[5], new_string: "safe" }),
    toolResult("failed-edit", true),
    ...readPair("read-after-failed-edit", "/tmp/private/src/a.ts"),
    ...readPair("read-repeat-1", privacySentinels[8]),
    ...readPair("read-repeat-2", privacySentinels[8]),
    ...readPair("read-repeat-3", privacySentinels[8]),
    JSON.stringify({ timestamp: "2026-02-03T00:00:10.000Z", type: "PreCompact" }),
    JSON.stringify({ timestamp: "2026-02-03T00:00:11.000Z", hook_event_name: "SessionEnd", session_id: privacySentinels[6] })
  ];
}

function assistantTextLine(): string {
  return JSON.stringify({
    type: "assistant",
    session_id: privacySentinels[6],
    message: {
      role: "assistant",
      content: [{ type: "text", text: privacySentinels[1] }]
    }
  });
}

function failedBashTestPair(index: number): string[] {
  return [
    toolUse(`test-${index}`, "Bash", { command: `npm test -- ${privacySentinels[4]}` }),
    toolResult(`test-${index}`, true)
  ];
}

function passedBashTestPair(id: string): string[] {
  return [toolUse(id, "Bash", { command: `npm test -- ${privacySentinels[4]}` }), toolResult(id, false)];
}

function editPair(id: string, filePath: string): string[] {
  return [toolUse(id, "Edit", { file_path: filePath, old_string: privacySentinels[5], new_string: "safe" }), toolResult(id, false)];
}

function readPair(id: string, filePath: string): string[] {
  return [toolUse(id, "Read", { file_path: filePath }), toolResult(id, false)];
}

function failedCommandPair(command: string, index: number): string[] {
  return [toolUse(`configured-${index}`, "Bash", { command }), toolResult(`configured-${index}`, true)];
}

function claudeProjectDirectoryName(projectDir: string): string {
  return resolve(projectDir).replaceAll(/[\\/]/gu, "-");
}

function toolUse(id: string, name: string, input: Record<string, unknown>): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name, input }]
    }
  });
}

function toolResult(id: string, isError: boolean): string {
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          is_error: isError,
          content: `${privacySentinels[2]} ${privacySentinels[3]} ${privacySentinels[5]} ${privacySentinels[8]}`
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
