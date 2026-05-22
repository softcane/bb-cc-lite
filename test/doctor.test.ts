import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PersonalBaseline } from "../src/baseline.js";
import { formatDoctorChecks, runDoctor, type DoctorCheck } from "../src/doctor.js";
import { projectBaselinePath, projectKeyFromPath } from "../src/paths.js";
import { installStatusLine, resolveSettingsTarget } from "../src/settings.js";
import {
  createTempWorkspace,
  pathExists,
  removeTempWorkspace,
  setIsolatedEnv,
  type TempWorkspace,
  writeJson
} from "./helpers/temp.js";

describe("doctor", () => {
  let workspace: TempWorkspace | undefined;
  let restoreEnv: (() => void) | undefined;

  beforeEach(async () => {
    workspace = await createTempWorkspace();
    restoreEnv = setIsolatedEnv({
      BB_CC_LITE_HOME: workspace.appHome,
      BB_CC_LITE_PRICING_CACHE: join(workspace.appHome, "pricing.json"),
      ANTHROPIC_BASE_URL: undefined
    });
  });

  afterEach(async () => {
    restoreEnv?.();
    await removeTempWorkspace(workspace);
  });

  it("reports OK checks for installed settings, readable transcript, and cached pricing", async () => {
    const dirs = mustHaveWorkspace(workspace);
    const transcriptPath = join(dirs.root, "transcript.jsonl");
    await installStatusLine({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir,
      cliFilePath: await createFakeRuntime(dirs.root)
    });
    await Promise.all([
      writeFile(transcriptPath, "{}", "utf8"),
      writeFile(process.env.BB_CC_LITE_PRICING_CACHE as string, '{"models":{}}\n', "utf8")
    ]);

    const checks = await runDoctor({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir,
      transcriptPath
    });

    expect(findCheck(checks, "settings")).toMatchObject({ level: "OK" });
    expect(findCheck(checks, "hooks")).toMatchObject({ level: "WARN" });
    expect(findCheck(checks, "transcript")).toMatchObject({ level: "OK" });
    expect(findCheck(checks, "litellm-pricing")).toMatchObject({ level: "OK" });
    expect(findCheck(checks, "anthropic-base-url")).toMatchObject({ level: "OK" });
    expect(checks.some((check) => check.level === "FAIL")).toBe(false);
  });

  it("reports OK for optional hooks when install --hooks was used", async () => {
    const dirs = mustHaveWorkspace(workspace);
    await installStatusLine({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir,
      cliFilePath: await createFakeRuntime(dirs.root),
      hooks: true
    });

    const checks = await runDoctor({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir
    });

    expect(findCheck(checks, "hooks")).toMatchObject({ level: "OK" });
  });

  it("warns on custom settings and missing pricing cache while failing an unreadable transcript", async () => {
    const dirs = mustHaveWorkspace(workspace);
    const target = resolveSettingsTarget({ projectDir: dirs.projectDir, homeDir: dirs.homeDir });
    await writeJson(target.settingsPath, {
      statusLine: {
        type: "command",
        command: "custom-statusline"
      }
    });

    const checks = await runDoctor({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir,
      transcriptPath: join(dirs.root, "missing-transcript.jsonl")
    });

    expect(findCheck(checks, "settings")).toMatchObject({ level: "WARN" });
    expect(findCheck(checks, "settings").message).toContain("custom statusLine");
    expect(findCheck(checks, "transcript")).toMatchObject({ level: "FAIL" });
    expect(findCheck(checks, "litellm-pricing")).toMatchObject({ level: "WARN" });
  });

  it("formats checks", () => {
    expect(formatDoctorChecks([{ level: "OK", name: "sample", message: "ready" }])).toBe("OK sample: ready");
  });

  it("warns when ANTHROPIC_BASE_URL points at a custom endpoint", async () => {
    const dirs = mustHaveWorkspace(workspace);
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:10000";

    const checks = await runDoctor({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir
    });

    expect(findCheck(checks, "anthropic-base-url")).toMatchObject({
      level: "WARN",
      message: expect.stringContaining("127.0.0.1:10000")
    });
  });

  it("shows a safe personal baseline summary without exposing raw fields", async () => {
    const dirs = mustHaveWorkspace(workspace);
    const rawPathSentinel = "/tmp/bb-cc-lite/private/worktree/src/secret.ts";
    await writeJson(join(dirs.appHome, "baseline.json"), {
      schema: "bb-cc-lite.baseline.v1",
      version: 1,
      createdAt: "2026-05-19T12:00:00.000Z",
      updatedAt: "2026-05-19T12:00:00.000Z",
      source: {
        kind: "local_transcript_scan",
        transcriptFilesScanned: 4,
        sessionsSeen: 3,
        malformedLines: 1,
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
        toolCalls: 8,
        successfulToolResults: 8,
        failedToolResults: 0,
        validationCalls: 0,
        validationFailures: 0,
        validationSuccesses: 0,
        successfulEditResults: 0,
        readSearchToolCalls: 6
      },
      scenarios: {
        read_heavy_debugging: { seen: 2, confidence: "medium" },
        repeated_failure: { seen: 0, confidence: "low" },
        validation_command_loop: { seen: 0, confidence: "low" },
        edit_without_validation: { seen: 0, confidence: "low" },
        validation_recovered: { seen: 0, confidence: "low" }
      },
      outcomes: {
        healthyLike: {
          validationPassedAfterEdit: 0,
          validationRecovered: 0,
          readHeavyNoFailure: 2
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
      },
      recent: {
        windowKind: "newest_files",
        windowSize: 100,
        transcriptFilesScanned: 3,
        sessionsSeen: 3
      },
      validation: {
        tests: {
          calls: 4,
          failures: 1,
          failureRate: 0.25,
          recovered: 1,
          unrecovered: 0,
          recoveryRate: 1,
          averageFailuresBeforeRecovery: 1,
          medianFailuresBeforeRecovery: 1,
          p75FailuresBeforeRecovery: 1,
          fivePlusFailuresBeforeRecovery: 0
        }
      },
      editValidation: {
        editsFollowedByValidation: 2,
        editsWithoutValidation: 1,
        editWithoutValidationRate: 0.3333,
        medianToolStepsFromEditToValidation: 2,
        p75ToolStepsFromEditToValidation: 3
      },
      toolCategories: {
        "Bash:tests": {
          calls: 4,
          failures: 1,
          repeatedFailureSessions: 0,
          recovered: 1,
          unrecovered: 0,
          recoveryRate: 1
        }
      }
    });

    const checks = await runDoctor({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir,
      appHomePath: dirs.appHome,
      showBaseline: true
    });

    const baseline = findCheck(checks, "baseline");
    expect(baseline).toMatchObject({ level: "OK" });
    expect(baseline.message).toContain("3 sessions");
    expect(baseline.message).toContain("4 transcript files");
    expect(baseline.message).toContain("derived aggregate data only");
    expect(baseline.message).toContain("recent newest_files window 3/100");
    expect(baseline.message).toContain("validation categories: tests");
    expect(baseline.message).toContain("tool categories: Bash:tests");
    expect(baseline.message).not.toContain(rawPathSentinel);
  });

  it("shows a safe project baseline summary without exposing the project path or hash", async () => {
    const dirs = mustHaveWorkspace(workspace);
    const projectKey = projectKeyFromPath(dirs.projectDir);
    await writeJson(
      projectBaselinePath({
        appHomePath: dirs.appHome,
        projectKey
      }),
      projectBaseline(projectKey, 5)
    );

    const checks = await runDoctor({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir,
      appHomePath: dirs.appHome,
      showBaseline: true
    });

    const project = findCheck(checks, "project-baseline");
    expect(project).toMatchObject({ level: "OK" });
    expect(project.message).toContain("project baseline: 5 sessions");
    expect(project.message).toContain("derived aggregate data only");
    expect(project.message).toContain("activity samples: high 5, no-progress 2, progress 3, read-heavy 4");
    expect(project.message).toContain("budget samples: cost 5, duration 5");
    expect(project.message).not.toContain(dirs.projectDir);
    expect(project.message).not.toContain(projectKey);
  });

  it("clears all learned baselines without removing the event store", async () => {
    const dirs = mustHaveWorkspace(workspace);
    const baselinePath = join(dirs.appHome, "baseline.json");
    const projectKey = projectKeyFromPath(dirs.projectDir);
    const projectBaselineFile = projectBaselinePath({ appHomePath: dirs.appHome, projectKey });
    const eventStorePath = join(dirs.appHome, "events.json");
    await Promise.all([
      writeJson(baselinePath, {
        schema: "bb-cc-lite.baseline.v1",
        version: 1,
        source: { sessionsSeen: 1, transcriptFilesScanned: 1 }
      }),
      writeJson(projectBaselineFile, {
        schema: "bb-cc-lite.baseline.v1",
        version: 1,
        project: { kind: "hashed_project", key: projectKey },
        source: { sessionsSeen: 3, transcriptFilesScanned: 3 }
      }),
      writeJson(eventStorePath, { events: [{ state: "Healthy" }] })
    ]);

    const checks = await runDoctor({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir,
      appHomePath: dirs.appHome,
      clearBaseline: true
    });

    expect(findCheck(checks, "baseline")).toMatchObject({
      level: "OK",
      message: "cleared learned baselines"
    });
    await expect(pathExists(baselinePath)).resolves.toBe(false);
    await expect(pathExists(projectBaselineFile)).resolves.toBe(false);
    await expect(pathExists(eventStorePath)).resolves.toBe(true);
  });

  it("builds a personal baseline from local Claude JSONL history", async () => {
    const dirs = mustHaveWorkspace(workspace);
    const transcriptPath = join(dirs.homeDir, ".claude", "projects", "sample", "session.jsonl");
    await writeTranscript(transcriptPath, [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "bash-test",
              name: "Bash",
              input: { command: "npm test -- BB_CC_LITE_RAW_COMMAND_SENTINEL" }
            }
          ]
        }
      }),
      JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "bash-test",
              is_error: false,
              content: "BB_CC_LITE_RAW_TOOL_OUTPUT_SENTINEL"
            }
          ]
        }
      })
    ]);

    const checks = await runDoctor({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir,
      appHomePath: dirs.appHome,
      buildBaseline: true
    });

    const baseline = findCheck(checks, "baseline");
    expect(baseline).toMatchObject({ level: "OK" });
    expect(baseline.message).toContain("Personal baseline ready (1 sessions).");
    const baselinePath = join(dirs.appHome, "baseline.json");
    await expect(pathExists(baselinePath)).resolves.toBe(true);
    const serialized = await readFile(baselinePath, "utf8");
    expect(serialized).not.toContain("BB_CC_LITE_RAW_COMMAND_SENTINEL");
    expect(serialized).not.toContain("BB_CC_LITE_RAW_TOOL_OUTPUT_SENTINEL");
    const projectKey = projectKeyFromPath(dirs.projectDir);
    const projectBaselineFile = projectBaselinePath({ appHomePath: dirs.appHome, projectKey });
    await expect(pathExists(projectBaselineFile)).resolves.toBe(true);
    const serializedProjectBaseline = await readFile(projectBaselineFile, "utf8");
    expect(serializedProjectBaseline).toContain(projectKey);
    expect(serializedProjectBaseline).not.toContain(dirs.projectDir);
    expect(serializedProjectBaseline).not.toContain("BB_CC_LITE_RAW_COMMAND_SENTINEL");
    expect(serializedProjectBaseline).not.toContain("BB_CC_LITE_RAW_TOOL_OUTPUT_SENTINEL");
  });

  it("reports aggregate-only historical replay metrics", async () => {
    const dirs = mustHaveWorkspace(workspace);
    const olderPath = join(dirs.homeDir, ".claude", "projects", "sample", "older.jsonl");
    const newerPath = join(dirs.homeDir, ".claude", "projects", "sample", "newer.jsonl");
    await writeTranscript(olderPath, [
      ...failedBashValidation("older-1"),
      ...failedBashValidation("older-2"),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "older-pass", name: "Bash", input: { command: "npm test" } }]
        }
      }),
      JSON.stringify({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "older-pass", is_error: false, content: "BB_CC_LITE_RAW_TOOL_OUTPUT_SENTINEL" }]
        }
      })
    ]);
    await writeTranscript(newerPath, [
      ...failedBashValidation("newer-1"),
      ...failedBashValidation("newer-2"),
      ...failedBashValidation("newer-3")
    ]);

    const checks = await runDoctor({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir,
      appHomePath: dirs.appHome,
      replayBaseline: true
    });

    const replay = findCheck(checks, "baseline-replay");
    expect(replay.message).toContain("holdout sessions");
    expect(replay.message).toContain("evaluated failure episodes");
    expect(replay.message).toContain("category coverage");
    expect(replay.message).not.toContain(dirs.homeDir);
    expect(replay.message).not.toContain("npm test");
    expect(replay.message).not.toContain("BB_CC_LITE_RAW");
  });
});

function findCheck(checks: DoctorCheck[], name: string): DoctorCheck {
  const check = checks.find((candidate) => candidate.name === name);
  if (!check) {
    throw new Error(`Missing doctor check: ${name}`);
  }
  return check;
}

function mustHaveWorkspace(workspace: TempWorkspace | undefined): TempWorkspace {
  if (!workspace) {
    throw new Error("test workspace was not initialized");
  }
  return workspace;
}

async function createFakeRuntime(root: string): Promise<string> {
  const distDir = join(root, `dist-${randomUUID()}`);
  await mkdir(distDir, { recursive: true });
  await writeFile(join(distDir, "cli.js"), "console.log('fake bb-cc-lite runtime');\n", "utf8");
  return join(distDir, "cli.js");
}

async function writeTranscript(path: string, lines: string[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
}

function projectBaseline(projectKey: string, sessionsSeen: number): PersonalBaseline {
  return {
    schema: "bb-cc-lite.baseline.v1",
    version: 1,
    createdAt: "2026-05-19T12:00:00.000Z",
    updatedAt: "2026-05-19T12:00:00.000Z",
    project: {
      kind: "hashed_project",
      key: projectKey
    },
    source: {
      kind: "local_transcript_scan",
      transcriptFilesScanned: sessionsSeen,
      sessionsSeen,
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
      toolCalls: 20,
      successfulToolResults: 20,
      failedToolResults: 0,
      validationCalls: 4,
      validationFailures: 0,
      validationSuccesses: 4,
      successfulEditResults: 3,
      readSearchToolCalls: 12
    },
    scenarios: {
      read_heavy_debugging: { seen: 4, confidence: "medium" },
      repeated_failure: { seen: 0, confidence: "low" },
      validation_command_loop: { seen: 0, confidence: "low" },
      edit_without_validation: { seen: 0, confidence: "low" },
      validation_recovered: { seen: 3, confidence: "medium" }
    },
    outcomes: {
      healthyLike: {
        validationPassedAfterEdit: 3,
        validationRecovered: 3,
        readHeavyNoFailure: 4
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
    },
    activity: {
      highActivitySessions: 5,
      busyNoProgressSessions: 2,
      observedProgressSessions: 3,
      readHeavySessions: 4,
      confidence: "medium"
    },
    budget: {
      costSamples: 5,
      durationSamples: 5,
      p75CostUsd: 0.42,
      p90CostUsd: 0.5,
      p75DurationMs: 600000,
      p90DurationMs: 900000,
      confidence: "medium"
    }
  };
}

function failedBashValidation(id: string): string[] {
  return [
    JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id, name: "Bash", input: { command: "npm test -- BB_CC_LITE_RAW_COMMAND_SENTINEL" } }]
      }
    }),
    JSON.stringify({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: "BB_CC_LITE_RAW_TOOL_OUTPUT_SENTINEL" }]
      }
    })
  ];
}
