import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { baselinePath } from "../src/paths.js";
import {
  BASELINE_READ_MAX_BYTES,
  clearBaseline,
  readBaseline,
  summarizeBaseline,
  type PersonalBaseline,
  writeBaseline
} from "../src/baseline.js";
import { buildBaseline } from "../src/baseline-builder.js";

describe("personal baseline storage", () => {
  it("writes and reads a valid baseline with private file permissions", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-baseline-"));
    try {
      const targetPath = join(tempDir, "baseline.json");
      const baseline = sampleBaseline();

      await writeBaseline(baseline, targetPath);

      await expect(readBaseline(targetPath)).resolves.toEqual(baseline);
      expect((await stat(targetPath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves the baseline path inside the app home", () => {
    const previous = process.env.BB_CC_LITE_HOME;
    delete process.env.BB_CC_LITE_HOME;
    try {
      expect(baselinePath("/tmp/bb-home")).toBe("/tmp/bb-home/.claude/bb-cc-lite/baseline.json");
    } finally {
      if (previous === undefined) {
        delete process.env.BB_CC_LITE_HOME;
      } else {
        process.env.BB_CC_LITE_HOME = previous;
      }
    }
  });

  it("ignores a baseline that contains forbidden raw-data fields", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-baseline-private-"));
    try {
      const targetPath = join(tempDir, "baseline.json");
      await writeFile(
        targetPath,
        `${JSON.stringify({
          ...sampleBaseline(),
          rawPrompt: "BB_CC_LITE_RAW_PROMPT_SENTINEL",
          transcriptPath: "/private/path/BB_CC_LITE_RAW_PATH_SENTINEL.jsonl"
        })}\n`,
        "utf8"
      );

      await expect(readBaseline(targetPath)).resolves.toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("ignores corrupt, old, and oversized baseline files and clears only the baseline file", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-baseline-invalid-"));
    try {
      const targetPath = join(tempDir, "baseline.json");

      await writeFile(targetPath, "{not-json", "utf8");
      await expect(readBaseline(targetPath)).resolves.toBeUndefined();

      await writeFile(targetPath, `${JSON.stringify({ ...sampleBaseline(), version: 0 })}\n`, "utf8");
      await expect(readBaseline(targetPath)).resolves.toBeUndefined();

      await writeFile(targetPath, "x".repeat(BASELINE_READ_MAX_BYTES + 1), "utf8");
      await expect(readBaseline(targetPath)).resolves.toBeUndefined();

      await writeBaseline(sampleBaseline(), targetPath);
      await expect(clearBaseline(targetPath)).resolves.toBe(true);
      await expect(clearBaseline(targetPath)).resolves.toBe(false);
      await expect(readBaseline(targetPath)).resolves.toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("summarizes only safe aggregate baseline facts", () => {
    const baseline = sampleBaseline();
    baseline.source.sessionsSeen = 12;
    baseline.outcomes.healthyLike.validationRecovered = 3;
    baseline.outcomes.carefulLike.editWithoutValidation = 2;
    baseline.outcomes.stopLike.validationLoopUnrecovered = 1;

    expect(summarizeBaseline(baseline)).toBe(
      "Personal baseline: 12 sessions, Healthy-like 3, Careful-like 2, Stop-like 1."
    );
  });
});

describe("personal baseline builder", () => {
  it("handles empty history and malformed JSONL without crashing", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-baseline-empty-"));
    try {
      const claudeProjectsDir = join(tempDir, ".claude", "projects");
      const projectDir = join(claudeProjectsDir, "project");
      await mkdir(projectDir, { recursive: true });

      await expect(buildBaseline({ claudeProjectsDir, appHomePath: join(tempDir, "empty-app") })).resolves.toMatchObject({
        written: false,
        baseline: {
          source: {
            transcriptFilesScanned: 0,
            sessionsSeen: 0,
            malformedLines: 0
          }
        }
      });

      await writeFile(join(projectDir, "malformed.jsonl"), "{not-json\n", "utf8");

      await expect(
        buildBaseline({
          claudeProjectsDir,
          appHomePath: join(tempDir, "malformed-app"),
          now: new Date("2026-05-19T10:00:00.000Z")
        })
      ).resolves.toMatchObject({
        written: true,
        baseline: {
          source: {
            transcriptFilesScanned: 1,
            sessionsSeen: 1,
            malformedLines: 1
          }
        }
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("recognizes direct tool rows when deriving edit-without-validation outcomes", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-baseline-direct-"));
    try {
      const claudeProjectsDir = join(tempDir, ".claude", "projects");
      const projectDir = join(claudeProjectsDir, "project");
      await mkdir(projectDir, { recursive: true });
      await writeJsonl(join(projectDir, "direct.jsonl"), [
        {
          type: "tool_use",
          tool_use: {
            id: "direct-edit",
            name: "Edit",
            input: {
              file_path: "/private/BB_CC_LITE_RAW_PATH_SENTINEL.ts",
              new_string: "BB_CC_LITE_RAW_FILE_CONTENT_SENTINEL"
            }
          }
        },
        {
          type: "tool_result",
          tool_use_id: "direct-edit",
          is_error: false,
          content: "BB_CC_LITE_RAW_TOOL_OUTPUT_SENTINEL"
        }
      ]);

      const result = await buildBaseline({
        claudeProjectsDir,
        appHomePath: join(tempDir, "app-home"),
        now: new Date("2026-05-19T10:00:00.000Z")
      });

      expect(result.baseline.outcomes.carefulLike.editWithoutValidation).toBe(1);
      expect(JSON.stringify(result.baseline)).not.toContain("BB_CC_LITE_RAW");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("learns weak outcome aggregates without storing raw private transcript data", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-baseline-builder-"));
    try {
      const claudeProjectsDir = join(tempDir, ".claude", "projects");
      const projectDir = join(claudeProjectsDir, "private-project-path-sentinel");
      const appHomePath = join(tempDir, "app-home");
      await mkdir(projectDir, { recursive: true });

      const rawPromptSentinel = "BB_CC_LITE_RAW_PROMPT_SENTINEL";
      const rawCommandSentinel = "BB_CC_LITE_RAW_COMMAND_SENTINEL";
      const rawToolOutputSentinel = "BB_CC_LITE_RAW_TOOL_OUTPUT_SENTINEL";
      const rawPathSentinel = "BB_CC_LITE_RAW_PATH_SENTINEL";
      const rawFileSentinel = "BB_CC_LITE_RAW_FILE_CONTENT_SENTINEL";
      const rawSessionSentinel = "BB_CC_LITE_RAW_SESSION_SENTINEL";

      await writeJsonl(join(projectDir, `${rawPathSentinel}-healthy.jsonl`), [
        userText(rawPromptSentinel),
        toolUse("edit-1", "Edit", { file_path: `/secret/${rawPathSentinel}.ts`, new_string: rawFileSentinel }),
        toolResult("edit-1", false, `edited ${rawFileSentinel}`),
        toolUse("test-1", "Bash", { command: `npm test -- ${rawCommandSentinel}` }),
        toolResult("test-1", true, rawToolOutputSentinel),
        toolUse("test-2", "Bash", { command: "npm test" }),
        toolResult("test-2", false, "tests passed")
      ]);
      await writeJsonl(join(projectDir, "stop-like.jsonl"), [
        userText(rawSessionSentinel),
        ...failedBashValidation("loop-1"),
        ...failedBashValidation("loop-2"),
        ...failedBashValidation("loop-3")
      ]);
      await writeJsonl(join(projectDir, "read-heavy.jsonl"), [
        toolUse("read-1", "Read", { file_path: `/private/${rawPathSentinel}.md` }),
        toolResult("read-1", false, rawFileSentinel),
        toolUse("grep-1", "Grep", { pattern: rawPromptSentinel }),
        toolResult("grep-1", false, rawToolOutputSentinel),
        toolUse("glob-1", "Glob", { pattern: "**/*.ts" }),
        toolResult("glob-1", false, rawToolOutputSentinel)
      ]);

      const result = await buildBaseline({
        claudeProjectsDir,
        appHomePath,
        now: new Date("2026-05-19T10:00:00.000Z")
      });

      expect(result.written).toBe(true);
      expect(result.baseline.source.sessionsSeen).toBe(3);
      expect(result.baseline.outcomes.healthyLike.validationRecovered).toBe(1);
      expect(result.baseline.outcomes.healthyLike.validationPassedAfterEdit).toBe(1);
      expect(result.baseline.outcomes.healthyLike.readHeavyNoFailure).toBe(1);
      expect(result.baseline.outcomes.stopLike.validationLoopUnrecovered).toBe(1);
      expect(result.baseline.outcomes.stopLike.sessionEndedInFailureLoop).toBe(1);
      expect(result.baseline).toMatchObject({
        totals: {
          toolCalls: 9,
          successfulToolResults: 5,
          failedToolResults: 4,
          validationCalls: 5,
          validationFailures: 4,
          validationSuccesses: 1,
          successfulEditResults: 1,
          readSearchToolCalls: 3
        }
      });
      expect(result.baseline.scenarios.validation_command_loop).toEqual({ seen: 1, confidence: "low" });
      expect(result.baseline.scenarios.read_heavy_debugging).toEqual({ seen: 1, confidence: "low" });

      const baselineText = await readFile(join(appHomePath, "baseline.json"), "utf8");
      for (const sentinel of [
        rawPromptSentinel,
        rawCommandSentinel,
        rawToolOutputSentinel,
        rawPathSentinel,
        rawFileSentinel,
        rawSessionSentinel,
        "private-project-path-sentinel"
      ]) {
        expect(JSON.stringify(result.baseline)).not.toContain(sentinel);
        expect(baselineText).not.toContain(sentinel);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function sampleBaseline(): PersonalBaseline {
  return {
    schema: "bb-cc-lite.baseline.v1",
    version: 1,
    createdAt: "2026-05-19T00:00:00.000Z",
    updatedAt: "2026-05-19T00:00:00.000Z",
    source: {
      kind: "local_transcript_scan",
      transcriptFilesScanned: 0,
      sessionsSeen: 0,
      malformedLines: 0,
      maxBytesPerTranscript: 524288
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

async function writeJsonl(path: string, entries: unknown[]): Promise<void> {
  await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

function userText(content: string): unknown {
  return {
    type: "user",
    sessionId: content,
    message: {
      role: "user",
      content
    }
  };
}

function toolUse(id: string, name: string, input: Record<string, unknown>): unknown {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id,
          name,
          input
        }
      ]
    }
  };
}

function toolResult(toolUseId: string, isError: boolean, content: string): unknown {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          is_error: isError,
          content
        }
      ]
    }
  };
}

function failedBashValidation(id: string): unknown[] {
  return [toolUse(id, "Bash", { command: "npm test" }), toolResult(id, true, "tests failed")];
}
