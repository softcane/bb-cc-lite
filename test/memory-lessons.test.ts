import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handleHook } from "../src/hook-control.js";
import {
  clearLessonMemory,
  lessonContextForProject,
  lessonMemoryPath,
  recordLessonFromSummary
} from "../src/memory-lessons.js";
import { projectKeyFromPath } from "../src/paths.js";
import type { TranscriptSummary } from "../src/types.js";

const privacySentinels = [
  "CCVERDICT_RAW_PROMPT_SENTINEL",
  "CCVERDICT_RAW_COMMAND_SENTINEL",
  "CCVERDICT_TOOL_OUTPUT_SENTINEL",
  "CCVERDICT_FILE_CONTENT_SENTINEL",
  "CCVERDICT_RAW_SESSION_SENTINEL",
  "mcp__privateServer__rawPrivacyTool",
  "/tmp/ccverdict/private/workspace/src/secret.ts"
];

describe("lesson memory", () => {
  it("stores lesson cards with only allowlisted safe fields", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ccverdict-lessons-"));
    try {
      const projectDir = join(tempDir, "project-with-private-name");
      const projectKey = projectKeyFromPath(projectDir);

      await recordLessonFromSummary({
        appHomePath: tempDir,
        projectKey,
        summary: repeatedTestFailureSummary(3),
        now: new Date("2026-05-23T00:00:00.000Z")
      });

      const path = lessonMemoryPath({ appHomePath: tempDir, projectKey });
      const text = await readFile(path, "utf8");
      const parsed = JSON.parse(text) as {
        projectKey: string;
        lessons: Array<Record<string, unknown>>;
      };

      expect(path).toContain(projectKey);
      expect(path).not.toContain(projectDir);
      expect(text).not.toContain(projectDir);
      expect(parsed.projectKey).toBe(projectKey);
      expect(parsed.lessons).toHaveLength(1);
      expect(Object.keys(parsed.lessons[0]).sort()).toEqual([
        "confidence",
        "createdAt",
        "decayAt",
        "evidenceCounts",
        "lessonId",
        "projectKey",
        "reasonCode",
        "safeCategory",
        "schema",
        "updatedAt",
        "wordingKey"
      ]);
      expectNoPrivacySentinels(text, path, projectDir);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("stores broader safe lesson cards without injecting them into live SessionStart context", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ccverdict-lessons-broad-"));
    try {
      const projectDir = join(tempDir, "project");
      const projectKey = projectKeyFromPath(projectDir);

      await recordLessonFromSummary({
        appHomePath: tempDir,
        projectKey,
        summary: broadRiskSummary(),
        now: new Date("2026-05-23T00:00:00.000Z")
      });
      await recordLessonFromSummary({
        appHomePath: tempDir,
        projectKey,
        summary: broadRiskSummary(),
        now: new Date("2026-05-23T00:01:00.000Z")
      });

      const text = await readFile(lessonMemoryPath({ appHomePath: tempDir, projectKey }), "utf8");
      const parsed = JSON.parse(text) as {
        lessons: Array<{
          reasonCode: string;
          safeCategory: string;
          evidenceCounts: { failures: number; sessions: number };
        }>;
      };

      expect(parsed.lessons.map((lesson) => lesson.reasonCode).sort()).toEqual([
        "context_pressure",
        "redundant_read",
        "unchecked_edits",
        "write_failed"
      ]);
      expect(parsed.lessons).toContainEqual(
        expect.objectContaining({
          reasonCode: "unchecked_edits",
          safeCategory: "edit",
          evidenceCounts: expect.objectContaining({ sessions: 2 })
        })
      );
      await expect(
        lessonContextForProject({ appHomePath: tempDir, projectKey, now: new Date("2026-05-23T00:02:00.000Z") })
      ).resolves.toBeUndefined();
      expectNoPrivacySentinels(text, projectDir);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not inject sparse, stale, or corrupt lesson memory", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ccverdict-lessons-sparse-"));
    try {
      const projectKey = projectKeyFromPath(join(tempDir, "project"));
      await recordLessonFromSummary({
        appHomePath: tempDir,
        projectKey,
        summary: repeatedTestFailureSummary(2),
        now: new Date("2026-05-23T00:00:00.000Z")
      });
      await expect(
        lessonContextForProject({ appHomePath: tempDir, projectKey, now: new Date("2026-05-23T00:00:01.000Z") })
      ).resolves.toBeUndefined();

      await recordLessonFromSummary({
        appHomePath: tempDir,
        projectKey,
        summary: repeatedTestFailureSummary(3),
        now: new Date("2026-01-01T00:00:00.000Z")
      });
      await expect(
        lessonContextForProject({ appHomePath: tempDir, projectKey, now: new Date("2026-03-01T00:00:00.000Z") })
      ).resolves.toBeUndefined();
      expect(await readFile(lessonMemoryPath({ appHomePath: tempDir, projectKey }), "utf8")).not.toContain("validation_repeated");

      await writeFile(lessonMemoryPath({ appHomePath: tempDir, projectKey }), "{not-json", "utf8");
      await expect(
        lessonContextForProject({ appHomePath: tempDir, projectKey, now: new Date("2026-05-23T00:00:00.000Z") })
      ).resolves.toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("injects safe lesson context at SessionStart only when learning is enabled", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ccverdict-lessons-hook-"));
    try {
      const projectDir = join(tempDir, "project");
      const projectKey = projectKeyFromPath(projectDir);
      await recordLessonFromSummary({
        appHomePath: tempDir,
        projectKey,
        summary: repeatedTestFailureSummary(3),
        now: new Date("2026-05-23T00:00:00.000Z")
      });

      const learned = await handleHook(sessionStartHook(projectDir), {
        fallbackEventName: "SessionStart",
        mode: "coach",
        learn: true,
        storePath: join(tempDir, "events.json"),
        appHomePath: tempDir
      });
      const disabled = await handleHook(sessionStartHook(projectDir), {
        fallbackEventName: "SessionStart",
        mode: "coach",
        learn: false,
        storePath: join(tempDir, "events-disabled.json"),
        appHomePath: tempDir
      });
      const observe = await handleHook(sessionStartHook(projectDir), {
        fallbackEventName: "SessionStart",
        mode: "observe",
        learn: true,
        storePath: join(tempDir, "events-observe.json"),
        appHomePath: tempDir
      });

      expect(learned).toMatchObject({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: expect.stringContaining("ccverdict lesson")
        }
      });
      expect(disabled).toBeUndefined();
      expect(observe).toBeUndefined();
      expectNoPrivacySentinels(learned, disabled, observe, projectDir);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("creates lesson memory from SessionEnd hook state when learning is enabled", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ccverdict-lessons-session-end-"));
    try {
      const projectDir = join(tempDir, "project");
      const storePath = join(tempDir, "events.json");
      const projectKey = projectKeyFromPath(projectDir);
      await handleHook(failedTestHook(projectDir), {
        fallbackEventName: "PostToolUseFailure",
        mode: "coach",
        learn: true,
        storePath,
        appHomePath: tempDir
      });
      await handleHook(failedTestHook(projectDir), {
        fallbackEventName: "PostToolUseFailure",
        mode: "coach",
        learn: true,
        storePath,
        appHomePath: tempDir
      });
      await handleHook(failedTestHook(projectDir), {
        fallbackEventName: "PostToolUseFailure",
        mode: "coach",
        learn: true,
        storePath,
        appHomePath: tempDir
      });

      const sessionEnd = await handleHook(
        JSON.stringify({
          session_id: `session-${privacySentinels[4]}`,
          hook_event_name: "SessionEnd",
          cwd: projectDir,
          transcript_path: join(projectDir, "private-transcript.jsonl"),
          prompt: privacySentinels[0]
        }),
        {
          fallbackEventName: "SessionEnd",
          mode: "coach",
          learn: true,
          storePath,
          appHomePath: tempDir
        }
      );

      expect(sessionEnd).toBeUndefined();
      await expect(
        lessonContextForProject({ appHomePath: tempDir, projectKey, now: new Date("2026-05-23T00:00:00.000Z") })
      ).resolves.toContain("ccverdict lesson");
      const memoryText = await readFile(lessonMemoryPath({ appHomePath: tempDir, projectKey }), "utf8");
      expect(memoryText).not.toContain(projectDir);
      expectNoPrivacySentinels(memoryText);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("clears lesson memory", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ccverdict-lessons-clear-"));
    try {
      const projectKey = projectKeyFromPath(join(tempDir, "project"));
      await recordLessonFromSummary({
        appHomePath: tempDir,
        projectKey,
        summary: repeatedTestFailureSummary(3),
        now: new Date("2026-05-23T00:00:00.000Z")
      });

      await clearLessonMemory({ appHomePath: tempDir });

      await expect(
        lessonContextForProject({ appHomePath: tempDir, projectKey, now: new Date("2026-05-23T00:00:01.000Z") })
      ).resolves.toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function repeatedTestFailureSummary(count: number): TranscriptSummary {
  return {
    pathReadable: true,
    bytesRead: 0,
    linesRead: 0,
    malformedLines: 0,
    toolCalls: count,
    readToolCalls: 0,
    failedToolResults: count,
    repeatedFailures: [
      {
        toolName: "Bash",
        purpose: "tests",
        count
      }
    ],
    blindRetry: {
      category: "tests",
      label: "test",
      attemptCount: count,
      recovered: false,
      activeEnded: true,
      blindRetryFailureCount: count
    },
    editTestLoopFailures: 0,
    hasUnvalidatedEdits: false,
    validationRecovered: false,
    compactionEvents: 0,
    postCompactionActivity: 0,
    usage: {}
  };
}

function broadRiskSummary(): TranscriptSummary {
  return {
    pathReadable: true,
    bytesRead: 0,
    linesRead: 0,
    malformedLines: 0,
    toolCalls: 8,
    readToolCalls: 3,
    successfulEditResults: 3,
    failedEditResults: 1,
    unvalidatedEditResultCount: 3,
    changedFileIdentityCount: 3,
    unvalidatedChangedFileIdentityCount: 3,
    workContinuedAfterFailedEdit: true,
    validationChecks: 0,
    failedToolResults: 1,
    repeatedFailures: [],
    editTestLoopFailures: 0,
    hasUnvalidatedEdits: true,
    validationRecovered: false,
    compactionEvents: 1,
    postCompactionActivity: 2,
    terminalEvents: 1,
    redundantRead: {
      fileIdentityHash: "0123456789abcdef",
      unchangedFullFileReadCount: 3,
      latestState: "Careful"
    },
    usage: {}
  };
}

function sessionStartHook(projectDir: string): string {
  return JSON.stringify({
    session_id: `session-${privacySentinels[4]}`,
    hook_event_name: "SessionStart",
    cwd: projectDir,
    transcript_path: join(projectDir, "private-transcript.jsonl"),
    prompt: privacySentinels[0],
    tool_response: privacySentinels[2],
    command: privacySentinels[1],
    file_path: privacySentinels[6],
    mcp_server_name: privacySentinels[5]
  });
}

function failedTestHook(projectDir: string): string {
  return JSON.stringify({
    session_id: `session-${privacySentinels[4]}`,
    hook_event_name: "PostToolUseFailure",
    tool_name: "Bash",
    tool_input: {
      command: `npm test -- ${privacySentinels[1]} ${privacySentinels[6]}`
    },
    tool_response: {
      stderr: privacySentinels[2],
      content: privacySentinels[3]
    },
    cwd: projectDir,
    transcript_path: join(projectDir, "private-transcript.jsonl"),
    prompt: privacySentinels[0],
    mcp_server_name: privacySentinels[5]
  });
}

function expectNoPrivacySentinels(...values: unknown[]): void {
  const serialized = values.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join("\n");
  for (const sentinel of privacySentinels) {
    expect(serialized).not.toContain(sentinel);
  }
}
