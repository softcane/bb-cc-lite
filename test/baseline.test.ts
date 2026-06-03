import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { baselinePath, projectBaselinePath, projectKeyFromPath } from "../src/paths.js";
import {
  BASELINE_READ_MAX_BYTES,
  clearBaseline,
  readBaselineForProject,
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
      expect((await stat(dirname(targetPath))).mode & 0o777).toBe(0o700);
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
          raw_prompt: "BB_CC_LITE_RAW_PROMPT_SENTINEL",
          cwd: "/private/path/BB_CC_LITE_RAW_PATH_SENTINEL",
          transcriptPath: "/private/path/BB_CC_LITE_RAW_PATH_SENTINEL.jsonl"
        })}\n`,
        "utf8"
      );

      await expect(readBaseline(targetPath)).resolves.toBeUndefined();

      await writeFile(
        targetPath,
        `${JSON.stringify({
          ...sampleBaseline(),
          updatedAt: "/private/path/BB_CC_LITE_RAW_PATH_SENTINEL"
        })}\n`,
        "utf8"
      );

      await expect(readBaseline(targetPath)).resolves.toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reads an extended v1 baseline with only approved aggregate sections", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-baseline-extended-"));
    try {
      const targetPath = join(tempDir, "baseline.json");
      const baseline = {
        ...sampleBaseline(),
        source: {
          ...sampleBaseline().source,
          maxFiles: 1500,
          scanStrategy: "mtime_desc_bounded_parallel",
          parallelism: 8,
          scanBudgetMs: 30000,
          scanDeadlineHit: false,
          transcriptFilesDiscovered: 4,
          bytesPerTranscriptCap: 1048576
        },
        recent: {
          windowKind: "newest_files",
          windowSize: 100,
          transcriptFilesScanned: 4,
          sessionsSeen: 4
        },
        validation: {
          tests: validationAggregate(),
          lint: validationAggregate(),
          typecheck: validationAggregate(),
          build: validationAggregate()
        },
        editValidation: {
          editsFollowedByValidation: 3,
          editsWithoutValidation: 1,
          editWithoutValidationRate: 0.25,
          medianToolStepsFromEditToValidation: 2,
          p75ToolStepsFromEditToValidation: 4
        },
        toolCategories: {
          "Bash:tests": toolCategoryAggregate(),
          MCP: toolCategoryAggregate(),
          Read: toolCategoryAggregate()
        },
        failureRecovery: {
          tests: failureRecoveryAggregate(),
          mcp: failureRecoveryAggregate()
        },
        blindRetry: {
          tests: blindRetryAggregate(),
          mcp: blindRetryAggregate()
        },
        retryHazards: {
          tests: {
            "1": retryHazardAggregate(),
            "2": retryHazardAggregate(),
            "3": retryHazardAggregate()
          },
          read: {
            "3": retryHazardAggregate()
          }
        }
      };
      await writeFile(targetPath, `${JSON.stringify(baseline)}\n`, "utf8");

      await expect(readBaseline(targetPath)).resolves.toEqual(baseline);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("ignores extended v1 baselines with unsafe aggregate keys or raw-data-like fields", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-baseline-unsafe-extended-"));
    try {
      const targetPath = join(tempDir, "baseline.json");
      await writeFile(
        targetPath,
        `${JSON.stringify({
          ...sampleBaseline(),
          toolCategories: {
            "Bash:npm test -- private": toolCategoryAggregate()
          }
        })}\n`,
        "utf8"
      );
      await expect(readBaseline(targetPath)).resolves.toBeUndefined();

      await writeFile(
        targetPath,
        `${JSON.stringify({
          ...sampleBaseline(),
          toolCategories: {
            mcp__privateServer__failingLookup: toolCategoryAggregate()
          }
        })}\n`,
        "utf8"
      );
      await expect(readBaseline(targetPath)).resolves.toBeUndefined();

      await writeFile(
        targetPath,
        `${JSON.stringify({
          ...sampleBaseline(),
          validation: {
            tests: {
              ...validationAggregate(),
              filePath: "/private/path/BB_CC_LITE_RAW_PATH_SENTINEL.ts"
            }
          }
        })}\n`,
        "utf8"
      );
      await expect(readBaseline(targetPath)).resolves.toBeUndefined();

      await writeFile(
        targetPath,
        `${JSON.stringify({
          ...sampleBaseline(),
          failureRecovery: {
            "mcp__privateServer__rawTool": failureRecoveryAggregate()
          }
        })}\n`,
        "utf8"
      );
      await expect(readBaseline(targetPath)).resolves.toBeUndefined();

      await writeFile(
        targetPath,
        `${JSON.stringify({
          ...sampleBaseline(),
          blindRetry: {
            tests: {
              ...blindRetryAggregate(),
              rawCommand: "npm test -- BB_CC_LITE_RAW_COMMAND_SENTINEL"
            }
          }
        })}\n`,
        "utf8"
      );
      await expect(readBaseline(targetPath)).resolves.toBeUndefined();

      await writeFile(
        targetPath,
        `${JSON.stringify({
          ...sampleBaseline(),
          failureRecovery: {
            tests: {
              ...failureRecoveryAggregate(),
              effectiveSamples: -1
            }
          }
        })}\n`,
        "utf8"
      );
      await expect(readBaseline(targetPath)).resolves.toBeUndefined();

      await writeFile(
        targetPath,
        `${JSON.stringify({
          ...sampleBaseline(),
          source: {
            ...sampleBaseline().source,
            scanBudgetMs: 30000,
            scanDeadlineHit: "no",
            transcriptFilesDiscovered: 4,
            bytesPerTranscriptCap: 1048576
          }
        })}\n`,
        "utf8"
      );
      await expect(readBaseline(targetPath)).resolves.toBeUndefined();

      await writeFile(
        targetPath,
        `${JSON.stringify({
          ...sampleBaseline(),
          retryHazards: {
            tests: {
              "3": {
                ...retryHazardAggregate(),
                smoothedRecoveryRate: 1.2
              }
            }
          }
        })}\n`,
        "utf8"
      );
      await expect(readBaseline(targetPath)).resolves.toBeUndefined();

      await writeFile(
        targetPath,
        `${JSON.stringify({
          ...sampleBaseline(),
          retryHazards: {
            tests: {
              command: retryHazardAggregate()
            }
          }
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

      await writeFile(targetPath, `${JSON.stringify({ ...sampleBaseline(), extra: "not allowed" })}\n`, "utf8");
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

describe("project baseline storage", () => {
  it("stores project baselines under app home using only a hashed project key", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-project-baseline-"));
    try {
      const rawProjectPath = join(tempDir, "private-client-worktree");
      const appHomePath = join(tempDir, "app-home");
      await mkdir(rawProjectPath, { recursive: true });

      const projectKey = projectKeyFromPath(rawProjectPath);
      const targetPath = projectBaselinePath({ appHomePath, projectKey });
      const baseline: PersonalBaseline = {
        ...sampleBaseline(),
        source: {
          ...sampleBaseline().source,
          sessionsSeen: 3,
          transcriptFilesScanned: 3
        },
        project: {
          kind: "hashed_project",
          key: projectKey
        },
        activity: {
          highActivitySessions: 2,
          busyNoProgressSessions: 1,
          observedProgressSessions: 1,
          readHeavySessions: 1,
          confidence: "medium"
        },
        budget: {
          costSamples: 2,
          durationSamples: 2,
          p75CostUsd: 0.42,
          p90CostUsd: 0.5,
          p75DurationMs: 600000,
          p90DurationMs: 900000,
          confidence: "medium"
        }
      };

      await writeBaseline(baseline, targetPath);

      const serialized = await readFile(targetPath, "utf8");
      expect(projectKey).toMatch(/^[a-f0-9]{64}$/u);
      expect(targetPath).toBe(join(appHomePath, "project-baselines", `${projectKey}.json`));
      expect(targetPath).not.toContain(rawProjectPath);
      expect(serialized).toContain(projectKey);
      expect(serialized).not.toContain(rawProjectPath);
      await expect(readBaseline(targetPath)).resolves.toEqual(baseline);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("prefers a strong project baseline and falls back for sparse or corrupt project data", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-project-baseline-select-"));
    try {
      const rawProjectPath = join(tempDir, "private-client-worktree");
      const appHomePath = join(tempDir, "app-home");
      const projectKey = projectKeyFromPath(rawProjectPath);
      const personalPath = join(appHomePath, "baseline.json");
      const projectPath = projectBaselinePath({ appHomePath, projectKey });
      const personalBaseline = {
        ...sampleBaseline(),
        source: {
          ...sampleBaseline().source,
          sessionsSeen: 12,
          transcriptFilesScanned: 12
        }
      };
      const sparseProjectBaseline = projectBaseline(projectKey, 9);
      const strongProjectBaseline = projectBaseline(projectKey, 10);

      await writeBaseline(personalBaseline, personalPath);
      await writeBaseline(sparseProjectBaseline, projectPath);

      const sparseSelection = await readBaselineForProject({
        projectDir: rawProjectPath,
        appHomePath,
        personalPath
      });

      expect(sparseSelection.source).toBe("personal");
      expect(sparseSelection.baseline).toEqual(personalBaseline);
      expect(JSON.stringify(sparseSelection)).not.toContain(rawProjectPath);

      await writeBaseline(strongProjectBaseline, projectPath);

      const strongSelection = await readBaselineForProject({
        projectDir: rawProjectPath,
        appHomePath,
        personalPath
      });

      expect(strongSelection).toMatchObject({
        source: "project",
        projectKey,
        baseline: strongProjectBaseline
      });
      expect(JSON.stringify(strongSelection)).not.toContain(rawProjectPath);

      await writeFile(projectPath, "{not-json", "utf8");

      const corruptSelection = await readBaselineForProject({
        projectDir: rawProjectPath,
        appHomePath,
        personalPath
      });

      expect(corruptSelection.source).toBe("personal");
      expect(corruptSelection.baseline).toEqual(personalBaseline);
      expect(JSON.stringify(corruptSelection)).not.toContain(rawProjectPath);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("personal baseline builder", () => {
  it("handles empty history and malformed JSONL without crashing", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-baseline-empty-"));
    try {
      const claudeProjectsDir = join(tempDir, ".claude", "projects");
      const projectDir = join(claudeProjectsDir, "project");
      await mkdir(projectDir, { recursive: true });

      const emptyAppHome = join(tempDir, "empty-app");
      await expect(buildBaseline({ claudeProjectsDir, appHomePath: emptyAppHome })).resolves.toMatchObject({
        written: true,
        baseline: {
          source: {
            transcriptFilesScanned: 0,
            sessionsSeen: 0,
            malformedLines: 0,
            maxBytesPerTranscript: 1048576,
            scanBudgetMs: 30000,
            scanDeadlineHit: false,
            transcriptFilesDiscovered: 0,
            bytesPerTranscriptCap: 1048576,
            parallelism: 8
          }
        }
      });
      await expect(readBaseline(join(emptyAppHome, "baseline.json"))).resolves.toMatchObject({
        source: {
          transcriptFilesScanned: 0,
          sessionsSeen: 0,
          maxBytesPerTranscript: 1048576,
          scanBudgetMs: 30000,
          scanDeadlineHit: false,
          transcriptFilesDiscovered: 0,
          bytesPerTranscriptCap: 1048576,
          parallelism: 8
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

  it("prefers newer JSONL transcripts before applying maxFiles", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-baseline-newest-"));
    try {
      const claudeProjectsDir = join(tempDir, ".claude", "projects");
      const projectDir = join(claudeProjectsDir, "project");
      await mkdir(projectDir, { recursive: true });

      const oldStopPath = join(projectDir, "old-stop.jsonl");
      const middleEditPath = join(projectDir, "middle-edit.jsonl");
      const newestReadPath = join(projectDir, "newest-read.jsonl");
      await writeJsonl(oldStopPath, stopLoopSession("old"));
      await writeJsonl(middleEditPath, editWithoutValidationSession("middle"));
      await writeJsonl(newestReadPath, readHeavySession("newest"));
      await setMtime(oldStopPath, "2026-05-17T10:00:00.000Z");
      await setMtime(middleEditPath, "2026-05-18T10:00:00.000Z");
      await setMtime(newestReadPath, "2026-05-19T10:00:00.000Z");

      const result = await buildBaseline({
        claudeProjectsDir,
        appHomePath: join(tempDir, "app-home"),
        maxFiles: 2,
        now: new Date("2026-05-19T11:00:00.000Z")
      });

      expect(result.baseline.source.sessionsSeen).toBe(2);
      expect(result.baseline.source.transcriptFilesScanned).toBe(2);
      expect(result.baseline.source).toMatchObject({
        maxFiles: 2,
        scanStrategy: "mtime_desc_bounded_parallel",
        parallelism: 8
      });
      expect(result.baseline.recent).toEqual({
        windowKind: "newest_files",
        windowSize: 100,
        transcriptFilesScanned: 2,
        sessionsSeen: 2
      });
      expect(result.baseline.outcomes.healthyLike.readHeavyNoFailure).toBe(1);
      expect(result.baseline.outcomes.carefulLike.editWithoutValidation).toBe(1);
      expect(result.baseline.outcomes.stopLike.validationLoopUnrecovered).toBe(0);
      expect(result.baseline.scenarios.validation_command_loop.seen).toBe(0);
      expect(result.baseline.scenarios.read_heavy_debugging).toMatchObject({ seen: 1, recentSeen: 1 });
      expect(result.baseline.scenarios.edit_without_validation).toMatchObject({ seen: 1, recentSeen: 1 });
      expect(result.baseline.scenarios.validation_command_loop).toMatchObject({ seen: 0, recentSeen: 0 });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("aggregates representative transcript counters across bounded parallel batches", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-baseline-parallel-"));
    try {
      const claudeProjectsDir = join(tempDir, ".claude", "projects");
      const projectDir = join(claudeProjectsDir, "project");
      await mkdir(projectDir, { recursive: true });

      const sessions = [
        readHeavySession("read-1"),
        readHeavySession("read-2"),
        editWithoutValidationSession("edit-1"),
        editWithoutValidationSession("edit-2"),
        validationRecoveredSession("recovered-1"),
        validationRecoveredSession("recovered-2"),
        validationRecoveredSession("recovered-3"),
        stopLoopSession("stop-1"),
        stopLoopSession("stop-2"),
        stopLoopSession("stop-3")
      ];
      for (const [index, entries] of sessions.entries()) {
        await writeJsonl(join(projectDir, `session-${index}.jsonl`), entries);
      }

      const result = await buildBaseline({
        claudeProjectsDir,
        appHomePath: join(tempDir, "app-home"),
        now: new Date("2026-05-19T10:00:00.000Z")
      });

      expect(result.baseline.source.sessionsSeen).toBe(10);
      expect(result.baseline).toMatchObject({
        totals: {
          toolCalls: 26,
          successfulToolResults: 14,
          failedToolResults: 12,
          validationCalls: 15,
          validationFailures: 12,
          validationSuccesses: 3,
          successfulEditResults: 5,
          readSearchToolCalls: 6
        },
        outcomes: {
          healthyLike: {
            validationPassedAfterEdit: 3,
            validationRecovered: 3,
            readHeavyNoFailure: 2
          },
          carefulLike: {
            editWithoutValidation: 2,
            toolFailureRecovered: 3,
            twoFailureStreakRecovered: 0
          },
          stopLike: {
            validationLoopUnrecovered: 3,
            toolLoopUnrecovered: 3,
            sessionEndedInFailureLoop: 3
          }
        },
        rates: {
          toolFailureRate: 0.4615,
          repeatedFailureRate: 0.3,
          validationFailureRate: 0.8,
          cacheWritesHighRate: 0
        }
      });
      expect(result.baseline.scenarios.validation_command_loop).toMatchObject({ seen: 3, recentSeen: 3, confidence: "medium" });
      expect(result.baseline.scenarios.validation_recovered).toMatchObject({ seen: 3, recentSeen: 3, confidence: "medium" });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("skips unreadable JSONL files safely", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) {
      return;
    }

    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-baseline-unreadable-"));
    const unreadablePath = join(tempDir, ".claude", "projects", "project", "unreadable.jsonl");
    try {
      const claudeProjectsDir = join(tempDir, ".claude", "projects");
      const projectDir = join(claudeProjectsDir, "project");
      await mkdir(projectDir, { recursive: true });
      await writeJsonl(join(projectDir, "readable.jsonl"), readHeavySession("readable"));
      await writeJsonl(unreadablePath, stopLoopSession("unreadable"));
      await chmod(unreadablePath, 0o000);

      const result = await buildBaseline({
        claudeProjectsDir,
        appHomePath: join(tempDir, "app-home"),
        now: new Date("2026-05-19T10:00:00.000Z")
      });

      expect(result.baseline.source.sessionsSeen).toBe(1);
      expect(result.baseline.outcomes.healthyLike.readHeavyNoFailure).toBe(1);
      expect(result.baseline.outcomes.stopLike.validationLoopUnrecovered).toBe(0);
    } finally {
      await chmod(unreadablePath, 0o600).catch(() => undefined);
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

  it("builds extended validation, recovery, edit-lag, and safe tool-category aggregates", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-baseline-rich-"));
    try {
      const claudeProjectsDir = join(tempDir, ".claude", "projects");
      const projectDir = join(claudeProjectsDir, "project");
      await mkdir(projectDir, { recursive: true });
      await writeJsonl(join(projectDir, "rich.jsonl"), [
        toolUse("edit-rich", "Edit", { file_path: "/private/file.ts", new_string: "updated" }),
        toolResult("edit-rich", false, "edited"),
        ...failedBashCommand("test-fail-1", "npm test"),
        ...failedBashCommand("test-fail-2", "npm test"),
        ...successfulBashCommand("test-pass", "npm test"),
        ...failedBashCommand("lint-fail", "npm run lint"),
        ...successfulBashCommand("lint-pass", "npm run lint"),
        ...successfulBashCommand("typecheck-pass", "tsc --noEmit"),
        ...failedBashCommand("build-fail", "npm run build"),
        ...successfulBashCommand("git-status", "git status")
      ]);
      await writeJsonl(join(projectDir, "edit-only.jsonl"), editWithoutValidationSession("edit-only"));

      const result = await buildBaseline({
        claudeProjectsDir,
        appHomePath: join(tempDir, "app-home"),
        now: new Date("2026-05-19T10:00:00.000Z")
      });

      expect(result.baseline.validation?.tests).toMatchObject({
        calls: 3,
        failures: 2,
        failureRate: 0.6667,
        recovered: 1,
        unrecovered: 0,
        recoveryRate: 1,
        averageFailuresBeforeRecovery: 2,
        medianFailuresBeforeRecovery: 2,
        p75FailuresBeforeRecovery: 2,
        fivePlusFailuresBeforeRecovery: 0
      });
      expect(result.baseline.validation?.lint).toMatchObject({
        calls: 2,
        failures: 1,
        recovered: 1,
        recoveryRate: 1,
        medianFailuresBeforeRecovery: 1
      });
      expect(result.baseline.validation?.typecheck).toMatchObject({
        calls: 1,
        failures: 0,
        recoveryRate: 0
      });
      expect(result.baseline.validation?.build).toMatchObject({
        calls: 1,
        failures: 1,
        recovered: 0,
        unrecovered: 1,
        recoveryRate: 0
      });
      expect(result.baseline.editValidation).toMatchObject({
        editsFollowedByValidation: 1,
        editsWithoutValidation: 1,
        editWithoutValidationRate: 0.5,
        medianToolStepsFromEditToValidation: 1,
        p75ToolStepsFromEditToValidation: 1
      });
      expect(result.baseline.toolCategories?.["Bash:tests"]).toMatchObject({
        calls: 3,
        failures: 2,
        repeatedFailureSessions: 1,
        recovered: 1,
        unrecovered: 0,
        recoveryRate: 1
      });
      expect(result.baseline.failureRecovery?.tests).toMatchObject({
        episodes: 1,
        recovered: 1,
        unrecovered: 0,
        recoveryRate: 1,
        smoothedRecoveryRate: 0.75,
        effectiveSamples: 2,
        medianAttemptsBeforeRecovery: 2,
        blindRetryEpisodes: 1,
        blindRetryRecovered: 1,
        confidence: "low"
      });
      expect(result.baseline.failureRecovery?.build).toMatchObject({
        episodes: 1,
        recovered: 0,
        unrecovered: 1,
        recoveryRate: 0
      });
      expect(result.baseline.blindRetry?.tests).toMatchObject({
        episodes: 1,
        recovered: 1,
        unrecovered: 0,
        recoveryRate: 1,
        smoothedRecoveryRate: 0.75,
        carefulLikeEpisodes: 1,
        stopLikeEpisodes: 0
      });
      expect(result.baseline.retryHazards?.tests?.["2"]).toMatchObject({
        episodes: 1,
        recovered: 1,
        unrecovered: 0,
        recoveryRate: 1,
        smoothedRecoveryRate: 0.75,
        effectiveSamples: 2
      });
      expect(result.baseline.retryHazards?.build?.["1"]).toMatchObject({
        episodes: 1,
        recovered: 0,
        unrecovered: 1,
        recoveryRate: 0,
        smoothedRecoveryRate: 0.25
      });
      expect(result.baseline.toolCategories?.["Bash:build"]).toMatchObject({
        calls: 1,
        failures: 1,
        recovered: 0,
        unrecovered: 1,
        recoveryRate: 0
      });
      expect(result.baseline.toolCategories?.Edit).toMatchObject({
        calls: 2,
        failures: 0,
        recoveryRate: 0
      });
      expect(result.baseline.toolCategories).not.toHaveProperty("Bash:git");
      expect(JSON.stringify(result.baseline)).not.toContain("git status");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("records scan-budget metadata and stops before broad reads when the budget is exhausted", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-baseline-budget-"));
    try {
      const claudeProjectsDir = join(tempDir, ".claude", "projects");
      const projectDir = join(claudeProjectsDir, "project");
      await mkdir(projectDir, { recursive: true });
      await writeJsonl(join(projectDir, "newest.jsonl"), readHeavySession("newest"));

      const result = await buildBaseline({
        claudeProjectsDir,
        appHomePath: join(tempDir, "app-home"),
        scanBudgetMs: 0,
        clock: { now: () => 1000 },
        now: new Date("2026-05-19T10:00:00.000Z")
      });

      expect(result.baseline.source).toMatchObject({
        transcriptFilesDiscovered: 0,
        transcriptFilesScanned: 0,
        sessionsSeen: 0,
        scanBudgetMs: 0,
        scanDeadlineHit: true,
        bytesPerTranscriptCap: 1048576,
        parallelism: 8
      });
      expect(result.baseline.outcomes.healthyLike.readHeavyNoFailure).toBe(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("builds safe activity and budget aggregates for project-baseline consumers", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-baseline-activity-budget-"));
    try {
      const claudeProjectsDir = join(tempDir, ".claude", "projects");
      const projectDir = join(claudeProjectsDir, "project");
      await mkdir(projectDir, { recursive: true });

      await writeJsonl(join(projectDir, "busy-no-progress.jsonl"), [
        statusMetrics(0.12, 300000),
        ...readHeavySession("busy-read-1"),
        ...readHeavySession("busy-read-2"),
        userText("BB_CC_LITE_RAW_PROMPT_SENTINEL")
      ]);
      await writeJsonl(join(projectDir, "progress.jsonl"), [
        statusMetrics(0.45, 900000),
        ...validationRecoveredSession("progress"),
        userText("/tmp/bb-cc-lite/private/worktree/src/secret.ts")
      ]);

      const result = await buildBaseline({
        claudeProjectsDir,
        appHomePath: join(tempDir, "app-home"),
        now: new Date("2026-05-19T10:00:00.000Z")
      });

      expect(result.baseline.activity).toMatchObject({
        highActivitySessions: 1,
        busyNoProgressSessions: 1,
        observedProgressSessions: 1,
        readHeavySessions: 1,
        confidence: "low"
      });
      expect(result.baseline.budget).toMatchObject({
        costSamples: 2,
        durationSamples: 2,
        p75CostUsd: 0.45,
        p90CostUsd: 0.45,
        p75DurationMs: 900000,
        p90DurationMs: 900000,
        confidence: "low"
      });
      expect(JSON.stringify(result.baseline)).not.toContain("BB_CC_LITE_RAW");
      expect(JSON.stringify(result.baseline)).not.toContain("/tmp/bb-cc-lite/private/worktree");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("writes a project baseline under app home when a project directory is supplied", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-baseline-project-build-"));
    try {
      const rawProjectPath = join(tempDir, "private-client-worktree");
      const claudeProjectsDir = join(tempDir, ".claude", "projects");
      const transcriptProjectDir = join(claudeProjectsDir, "project");
      const appHomePath = join(tempDir, "app-home");
      await mkdir(rawProjectPath, { recursive: true });
      await mkdir(transcriptProjectDir, { recursive: true });
      await writeJsonl(join(transcriptProjectDir, "project-session.jsonl"), readHeavySession("project-build"));

      const result = await buildBaseline({
        claudeProjectsDir,
        appHomePath,
        projectDir: rawProjectPath,
        projectTranscriptDir: transcriptProjectDir,
        now: new Date("2026-05-19T10:00:00.000Z")
      });

      const projectKey = projectKeyFromPath(rawProjectPath);
      const storedProjectBaseline = await readBaseline(projectBaselinePath({ appHomePath, projectKey }));

      expect(result.projectBaseline).toMatchObject({
        project: {
          kind: "hashed_project",
          key: projectKey
        },
        source: {
          sessionsSeen: 1,
          transcriptFilesScanned: 1
        }
      });
      expect(storedProjectBaseline).toEqual(result.projectBaseline);
      expect(projectBaselinePath({ appHomePath, projectKey })).not.toContain(rawProjectPath);
      expect(JSON.stringify(storedProjectBaseline)).not.toContain(rawProjectPath);
      expect(JSON.stringify(storedProjectBaseline)).not.toContain("private-client-worktree");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not build a project baseline from an unrelated single transcript project", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-baseline-project-unmatched-"));
    try {
      const rawProjectPath = join(tempDir, "current-worktree-with-no-history");
      const claudeProjectsDir = join(tempDir, ".claude", "projects");
      const unrelatedTranscriptDir = join(claudeProjectsDir, "unrelated-project");
      const appHomePath = join(tempDir, "app-home");
      await mkdir(rawProjectPath, { recursive: true });
      await mkdir(unrelatedTranscriptDir, { recursive: true });
      await writeJsonl(join(unrelatedTranscriptDir, "stop-loop.jsonl"), stopLoopSession("unrelated"));

      const result = await buildBaseline({
        claudeProjectsDir,
        appHomePath,
        projectDir: rawProjectPath,
        now: new Date("2026-05-19T10:00:00.000Z")
      });

      const projectKey = projectKeyFromPath(rawProjectPath);
      const storedProjectBaseline = await readBaseline(projectBaselinePath({ appHomePath, projectKey }));

      expect(result.baseline.source.sessionsSeen).toBe(1);
      expect(result.baseline.outcomes.stopLike.validationLoopUnrecovered).toBe(1);
      expect(result.projectBaseline).toMatchObject({
        project: {
          kind: "hashed_project",
          key: projectKey
        },
        source: {
          sessionsSeen: 0,
          transcriptFilesScanned: 0
        },
        outcomes: {
          stopLike: {
            validationLoopUnrecovered: 0
          }
        }
      });
      expect(storedProjectBaseline).toEqual(result.projectBaseline);
      expect(JSON.stringify(storedProjectBaseline)).not.toContain(rawProjectPath);
      expect(JSON.stringify(storedProjectBaseline)).not.toContain("unrelated-project");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("builds the project baseline from only that project's transcript directory", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-baseline-project-specific-"));
    try {
      const rawProjectPath = join(tempDir, "private-client-worktree");
      const claudeProjectsDir = join(tempDir, ".claude", "projects");
      const targetTranscriptDir = join(claudeProjectsDir, "target-project");
      const otherTranscriptDir = join(claudeProjectsDir, "other-project");
      const appHomePath = join(tempDir, "app-home");
      await mkdir(rawProjectPath, { recursive: true });
      await mkdir(targetTranscriptDir, { recursive: true });
      await mkdir(otherTranscriptDir, { recursive: true });

      for (let index = 0; index < 3; index += 1) {
        await writeJsonl(join(targetTranscriptDir, `read-heavy-${index}.jsonl`), readHeavySession(`target-${index}`));
        await writeJsonl(join(otherTranscriptDir, `stop-loop-${index}.jsonl`), stopLoopSession(`other-${index}`));
      }

      const result = await buildBaseline({
        claudeProjectsDir,
        appHomePath,
        projectDir: rawProjectPath,
        projectTranscriptDir: targetTranscriptDir,
        now: new Date("2026-05-19T10:00:00.000Z")
      });

      expect(result.baseline.source.sessionsSeen).toBe(6);
      expect(result.baseline.outcomes.stopLike.validationLoopUnrecovered).toBe(3);
      expect(result.projectBaseline?.source.sessionsSeen).toBe(3);
      expect(result.projectBaseline?.outcomes.healthyLike.readHeavyNoFailure).toBe(3);
      expect(result.projectBaseline?.outcomes.stopLike.validationLoopUnrecovered).toBe(0);
      expect(result.projectBaseline?.scenarios.validation_command_loop).toMatchObject({ seen: 0, recentSeen: 0 });
      expect(JSON.stringify(result.projectBaseline)).not.toContain(rawProjectPath);
      expect(JSON.stringify(result.projectBaseline)).not.toContain("other-project");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("builds aggregate MCP tool category counts without storing raw MCP names", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-baseline-mcp-"));
    try {
      const claudeProjectsDir = join(tempDir, ".claude", "projects");
      const projectDir = join(claudeProjectsDir, "project");
      const appHomePath = join(tempDir, "app-home");
      await mkdir(projectDir, { recursive: true });
      const recoveredMcpName = "mcp__privateServer__eventualSuccess";
      const unrecoveredMcpName = "mcp__privateServer__alwaysFails";
      const successMcpName = "mcp__privateServer__lookupCustomer";

      await writeJsonl(join(projectDir, "mcp-success.jsonl"), [
        toolUse("mcp-success", successMcpName, { query: "private" }),
        toolResult("mcp-success", false, "ok")
      ]);
      await writeJsonl(join(projectDir, "mcp-recovered.jsonl"), [
        ...failedMcpTool("mcp-recovered-1", recoveredMcpName),
        ...failedMcpTool("mcp-recovered-2", recoveredMcpName),
        toolUse("mcp-recovered-success", recoveredMcpName, { query: "private" }),
        toolResult("mcp-recovered-success", false, "ok")
      ]);
      await writeJsonl(join(projectDir, "mcp-unrecovered.jsonl"), [
        ...failedMcpTool("mcp-unrecovered-1", unrecoveredMcpName),
        ...failedMcpTool("mcp-unrecovered-2", unrecoveredMcpName),
        ...failedMcpTool("mcp-unrecovered-3", unrecoveredMcpName)
      ]);

      const result = await buildBaseline({
        claudeProjectsDir,
        appHomePath,
        now: new Date("2026-05-19T10:00:00.000Z")
      });

      expect(result.baseline.toolCategories?.MCP).toMatchObject({
        calls: 7,
        failures: 5,
        repeatedFailureSessions: 2,
        recovered: 1,
        unrecovered: 1,
        recoveryRate: 0.5
      });
      const baselineText = await readFile(join(appHomePath, "baseline.json"), "utf8");
      for (const rawMcpName of [recoveredMcpName, unrecoveredMcpName, successMcpName]) {
        expect(JSON.stringify(result.baseline)).not.toContain(rawMcpName);
        expect(baselineText).not.toContain(rawMcpName);
      }
      expect(baselineText).not.toContain("mcp__");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not count MCP results with validation-like titles as Bash validation baseline data", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-baseline-mcp-purpose-"));
    try {
      const claudeProjectsDir = join(tempDir, ".claude", "projects");
      const projectDir = join(claudeProjectsDir, "project");
      await mkdir(projectDir, { recursive: true });
      const rawMcpName = "mcp__privateServer__testRunner";

      await writeJsonl(join(projectDir, "mcp-title.jsonl"), [
        toolUse("mcp-fail", rawMcpName, { query: "private" }),
        toolResultWithTitle("mcp-fail", true, "tests failed", "mcp failed"),
        toolUse("mcp-pass", rawMcpName, { query: "private" }),
        toolResultWithTitle("mcp-pass", false, "tests passed", "mcp passed")
      ]);

      const result = await buildBaseline({
        claudeProjectsDir,
        appHomePath: join(tempDir, "app-home"),
        now: new Date("2026-05-19T10:00:00.000Z")
      });

      expect(result.baseline.validation?.tests).toMatchObject({
        calls: 0,
        failures: 0,
        recovered: 0,
        unrecovered: 0
      });
      expect(result.baseline.toolCategories?.MCP).toMatchObject({
        calls: 2,
        failures: 1,
        recovered: 1,
        unrecovered: 0
      });
      expect(JSON.stringify(result.baseline)).not.toContain(rawMcpName);
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
      expect(result.baseline.privacy).toMatchObject({
        rawPromptsStored: false,
        rawAssistantTextStored: false,
        rawToolOutputStored: false,
        rawShellOutputStored: false,
        rawPathsStored: false,
        rawTranscriptPathsStored: false,
        rawWorkspacePathsStored: false,
        rawCommandsStored: false,
        rawFileContentsStored: false,
        rawSessionIdsStored: false,
        rawMcpNamesStored: false,
        perSessionRowsStored: false
      });
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
      expect(result.baseline.scenarios.validation_command_loop).toMatchObject({ seen: 1, recentSeen: 1, confidence: "low" });
      expect(result.baseline.scenarios.read_heavy_debugging).toMatchObject({ seen: 1, recentSeen: 1, confidence: "low" });

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
      maxBytesPerTranscript: 1048576
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

function projectBaseline(projectKey: string, sessionsSeen: number): PersonalBaseline {
  return {
    ...sampleBaseline(),
    project: {
      kind: "hashed_project",
      key: projectKey
    },
    source: {
      ...sampleBaseline().source,
      sessionsSeen,
      transcriptFilesScanned: sessionsSeen
    },
    activity: {
      highActivitySessions: sessionsSeen,
      busyNoProgressSessions: Math.max(0, sessionsSeen - 1),
      observedProgressSessions: 1,
      readHeavySessions: sessionsSeen,
      confidence: sessionsSeen >= 3 ? "medium" : "low"
    },
    budget: {
      costSamples: sessionsSeen,
      durationSamples: sessionsSeen,
      p75CostUsd: 0.5,
      p90CostUsd: 0.7,
      p75DurationMs: 600000,
      p90DurationMs: 900000,
      confidence: sessionsSeen >= 3 ? "medium" : "low"
    }
  };
}

function validationAggregate(): Record<string, number> {
  return {
    calls: 4,
    failures: 2,
    failureRate: 0.5,
    recovered: 1,
    unrecovered: 1,
    recoveryRate: 0.5,
    averageFailuresBeforeRecovery: 1,
    medianFailuresBeforeRecovery: 1,
    p75FailuresBeforeRecovery: 1,
    fivePlusFailuresBeforeRecovery: 0
  };
}

function toolCategoryAggregate(): Record<string, number> {
  return {
    calls: 4,
    failures: 2,
    repeatedFailureSessions: 1,
    recovered: 1,
    unrecovered: 1,
    recoveryRate: 0.5
  };
}

function failureRecoveryAggregate(): Record<string, number | string> {
  return {
    episodes: 6,
    recovered: 5,
    unrecovered: 1,
    activeEnded: 1,
    recoveryRate: 0.8333,
    smoothedRecoveryRate: 0.7857,
    effectiveSamples: 7,
    medianAttemptsBeforeRecovery: 2,
    p75AttemptsBeforeRecovery: 2,
    blindRetryEpisodes: 2,
    blindRetryRecovered: 1,
    blindRetryUnrecovered: 1,
    confidence: "medium"
  };
}

function blindRetryAggregate(): Record<string, number | string> {
  return {
    episodes: 2,
    recovered: 1,
    unrecovered: 1,
    recoveryRate: 0.5,
    smoothedRecoveryRate: 0.5,
    effectiveSamples: 3,
    carefulLikeEpisodes: 2,
    stopLikeEpisodes: 1,
    confidence: "low"
  };
}

function retryHazardAggregate(): Record<string, number | string> {
  return {
    episodes: 6,
    recovered: 4,
    unrecovered: 2,
    recoveryRate: 0.6667,
    smoothedRecoveryRate: 0.6429,
    effectiveSamples: 7,
    confidence: "medium"
  };
}

async function writeJsonl(path: string, entries: unknown[]): Promise<void> {
  await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

async function setMtime(path: string, timestamp: string): Promise<void> {
  const date = new Date(timestamp);
  await utimes(path, date, date);
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

function statusMetrics(costUsd: number, durationMs: number): unknown {
  return {
    type: "system",
    cost: {
      total_cost_usd: costUsd,
      total_duration_ms: durationMs
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

function toolResultWithTitle(toolUseId: string, isError: boolean, title: string, content: string): unknown {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          is_error: isError,
          title,
          content
        }
      ]
    }
  };
}

function failedBashValidation(id: string): unknown[] {
  return [toolUse(id, "Bash", { command: "npm test" }), toolResult(id, true, "tests failed")];
}

function failedBashCommand(id: string, command: string): unknown[] {
  return [toolUse(id, "Bash", { command }), toolResult(id, true, "command failed")];
}

function successfulBashCommand(id: string, command: string): unknown[] {
  return [toolUse(id, "Bash", { command }), toolResult(id, false, "command passed")];
}

function failedMcpTool(id: string, rawName: string): unknown[] {
  return [toolUse(id, rawName, { query: "private" }), toolResult(id, true, "mcp failed")];
}

function readHeavySession(prefix: string): unknown[] {
  return [
    toolUse(`${prefix}-read`, "Read", { file_path: "/private/file.ts" }),
    toolResult(`${prefix}-read`, false, "file"),
    toolUse(`${prefix}-grep`, "Grep", { pattern: "needle" }),
    toolResult(`${prefix}-grep`, false, "match"),
    toolUse(`${prefix}-glob`, "Glob", { pattern: "**/*.ts" }),
    toolResult(`${prefix}-glob`, false, "paths")
  ];
}

function editWithoutValidationSession(prefix: string): unknown[] {
  return [
    toolUse(`${prefix}-edit`, "Edit", { file_path: "/private/file.ts", new_string: "updated" }),
    toolResult(`${prefix}-edit`, false, "edited")
  ];
}

function validationRecoveredSession(prefix: string): unknown[] {
  return [
    toolUse(`${prefix}-edit`, "Edit", { file_path: "/private/file.ts", new_string: "updated" }),
    toolResult(`${prefix}-edit`, false, "edited"),
    ...failedBashValidation(`${prefix}-test-fail`),
    toolUse(`${prefix}-test-pass`, "Bash", { command: "npm test" }),
    toolResult(`${prefix}-test-pass`, false, "tests passed")
  ];
}

function stopLoopSession(prefix: string): unknown[] {
  return [
    ...failedBashValidation(`${prefix}-loop-1`),
    ...failedBashValidation(`${prefix}-loop-2`),
    ...failedBashValidation(`${prefix}-loop-3`)
  ];
}
