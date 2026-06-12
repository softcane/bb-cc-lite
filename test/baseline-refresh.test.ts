import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readBaseline, writeBaseline, type PersonalBaseline } from "../src/baseline.js";
import {
  acquireRefreshLock,
  baselineIsStale,
  baselineRefreshLockPath,
  maybeTriggerBaselineRefresh,
  refreshIntervalHoursFromEnv,
  runBaselineRefresh,
  shouldAutoRefresh,
  type RefreshSpawnRequest
} from "../src/baseline-refresh.js";
import { projectBaselinePath, projectKeyFromPath } from "../src/paths.js";
import { pathExists } from "./helpers/temp.js";

const privacySentinels = [
  "CCVERDICT_RAW_PROMPT_SENTINEL",
  "CCVERDICT_RAW_TOOL_OUTPUT_SENTINEL",
  "/tmp/ccverdict/private/worktree/src/secret.ts",
  "npm test -- CCVERDICT_RAW_COMMAND_SENTINEL",
  "mcp__privateServer__rawTool"
];

describe("baseline auto refresh freshness", () => {
  it("treats missing and unreadable baselines as stale", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ccverdict-refresh-freshness-"));
    try {
      expect(baselineIsStale(undefined, new Date("2026-05-20T12:00:00.000Z"))).toBe(true);

      const invalidPath = join(tempDir, "baseline.json");
      await writeFile(invalidPath, "{not-json", "utf8");
      const invalidBaseline = await readBaseline(invalidPath);
      expect(invalidBaseline).toBeUndefined();
      expect(baselineIsStale(invalidBaseline, new Date("2026-05-20T12:00:00.000Z"))).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses a 24 hour default freshness window", () => {
    const now = new Date("2026-05-20T12:00:00.000Z");

    expect(baselineIsStale(sampleBaseline("2026-05-20T11:00:00.000Z"), now)).toBe(false);
    expect(baselineIsStale(sampleBaseline("2026-05-19T11:00:00.000Z"), now)).toBe(true);
  });

  it("honors the refresh interval env override", () => {
    const env = { CCVERDICT_BASELINE_REFRESH_INTERVAL_HOURS: "2" };
    const intervalHours = refreshIntervalHoursFromEnv(env);
    const now = new Date("2026-05-20T12:00:00.000Z");

    expect(intervalHours).toBe(2);
    expect(baselineIsStale(sampleBaseline("2026-05-20T10:30:00.000Z"), now, intervalHours)).toBe(false);
    expect(baselineIsStale(sampleBaseline("2026-05-20T09:30:00.000Z"), now, intervalHours)).toBe(true);
  });

  it("lets CCVERDICT_AUTO_LEARN=0 disable auto refresh", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ccverdict-refresh-disabled-"));
    try {
      let spawned = 0;
      const result = await maybeTriggerBaselineRefresh({
        baseline: undefined,
        appHomePath: tempDir,
        env: { CCVERDICT_AUTO_LEARN: "0" },
        spawnRefresh: () => {
          spawned += 1;
        }
      });

      expect(shouldAutoRefresh({ CCVERDICT_AUTO_LEARN: "0" })).toBe(false);
      expect(result).toEqual({ triggered: false, reason: "disabled" });
      expect(spawned).toBe(0);
      await expect(pathExists(baselineRefreshLockPath({ appHomePath: tempDir }))).resolves.toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("baseline auto refresh locking", () => {
  it("allows refresh when no lock exists and writes only safe lock metadata", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ccverdict-refresh-lock-"));
    try {
      const lockPath = baselineRefreshLockPath({ appHomePath: tempDir });

      await expect(acquireRefreshLock({ appHomePath: tempDir, now: new Date("2026-05-20T12:00:00.000Z") })).resolves.toBe(
        true
      );

      const metadata = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
      expect(Object.keys(metadata).sort()).toEqual(["pid", "startedAt"]);
      expect(metadata).toMatchObject({
        startedAt: "2026-05-20T12:00:00.000Z",
        pid: expect.any(Number)
      });
      expectNoPrivacySentinels(metadata);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps a fresh lock from spawning duplicate refresh work", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ccverdict-refresh-fresh-lock-"));
    try {
      await acquireRefreshLock({ appHomePath: tempDir, now: new Date("2026-05-20T12:00:00.000Z") });

      await expect(
        acquireRefreshLock({
          appHomePath: tempDir,
          now: new Date("2026-05-20T12:00:30.000Z"),
          staleAfterMs: 120_000
        })
      ).resolves.toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("replaces a stale lock and allows refresh", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ccverdict-refresh-stale-lock-"));
    try {
      const lockPath = baselineRefreshLockPath({ appHomePath: tempDir });
      await acquireRefreshLock({ appHomePath: tempDir, now: new Date("2026-05-20T12:00:00.000Z") });

      await expect(
        acquireRefreshLock({
          appHomePath: tempDir,
          now: new Date("2026-05-20T12:03:00.000Z"),
          staleAfterMs: 120_000
        })
      ).resolves.toBe(true);

      expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({
        startedAt: "2026-05-20T12:03:00.000Z"
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("cleans up the lock after success and after refresh failure where possible", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ccverdict-refresh-cleanup-"));
    try {
      const lockPath = baselineRefreshLockPath({ appHomePath: tempDir });
      const success = await runBaselineRefresh({
        appHomePath: tempDir,
        build: async () => ({ baseline: sampleBaseline("2026-05-20T12:00:00.000Z"), written: true })
      });
      expect(success).toEqual({ ok: true, written: true });
      await expect(pathExists(lockPath)).resolves.toBe(false);

      const failure = await runBaselineRefresh({
        appHomePath: tempDir,
        build: async () => {
          throw new Error("refresh failed");
        }
      });
      expect(failure).toEqual({ ok: false, written: false });
      await expect(pathExists(lockPath)).resolves.toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("passes the project directory through quiet refresh and writes a project baseline", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ccverdict-refresh-project-"));
    try {
      const appHomePath = join(tempDir, "app-home");
      const projectDir = join(tempDir, "private-project");
      const projectKey = projectKeyFromPath(projectDir);

      const result = await runBaselineRefresh({
        appHomePath,
        projectDir,
        build: async (options) => {
          const baseline = {
            ...sampleBaseline("2026-05-20T12:00:00.000Z"),
            project: options.projectDir
              ? {
                  kind: "hashed_project" as const,
                  key: projectKeyFromPath(options.projectDir)
                }
              : undefined
          };
          if (options.projectDir) {
            await writeBaseline(baseline, projectBaselinePath({ appHomePath, projectKey }));
          }
          return { baseline, written: true };
        }
      });

      expect(result).toEqual({ ok: true, written: true });
      const stored = await readBaseline(projectBaselinePath({ appHomePath, projectKey }));
      expect(stored?.project).toEqual({
        kind: "hashed_project",
        key: projectKey
      });
      expect(JSON.stringify(stored)).not.toContain(projectDir);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not spawn when a fresh lock already exists", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ccverdict-refresh-trigger-lock-"));
    try {
      let spawned = 0;
      await acquireRefreshLock({ appHomePath: tempDir, now: new Date("2026-05-20T12:00:00.000Z") });

      const result = await maybeTriggerBaselineRefresh({
        baseline: sampleBaseline("2026-05-19T00:00:00.000Z"),
        appHomePath: tempDir,
        now: new Date("2026-05-20T12:00:30.000Z"),
        spawnRefresh: () => {
          spawned += 1;
        }
      });

      expect(result).toEqual({ triggered: false, reason: "locked" });
      expect(spawned).toBe(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("spawns stale refresh with the current project and transcript path", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ccverdict-refresh-trigger-project-"));
    try {
      const projectDir = join(tempDir, "private-project");
      const transcriptPath = join(tempDir, ".claude", "projects", "project", "session.jsonl");
      let spawned: RefreshSpawnRequest | undefined;

      const result = await maybeTriggerBaselineRefresh({
        baseline: sampleBaseline("2026-05-19T00:00:00.000Z"),
        appHomePath: tempDir,
        projectDir,
        transcriptPath,
        cliFilePath: "/safe/cli.js",
        now: new Date("2026-05-20T12:00:30.000Z"),
        spawnRefresh: (request) => {
          spawned = request;
        }
      });

      expect(result).toEqual({ triggered: true, reason: "spawned" });
      expect(spawned?.args).toEqual([
        "/safe/cli.js",
        "baseline-refresh",
        "--quiet",
        "--project",
        projectDir,
        "--transcript",
        transcriptPath
      ]);
      expect(spawned?.env.CCVERDICT_BASELINE_REFRESH_LOCK_HELD).toBe("1");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("cleans up the lock when spawning fails", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ccverdict-refresh-spawn-failure-"));
    try {
      const lockPath = baselineRefreshLockPath({ appHomePath: tempDir });

      const result = await maybeTriggerBaselineRefresh({
        baseline: sampleBaseline("2026-05-19T00:00:00.000Z"),
        appHomePath: tempDir,
        now: new Date("2026-05-20T12:00:00.000Z"),
        spawnRefresh: () => {
          throw new Error("spawn failed");
        }
      });

      expect(result).toEqual({ triggered: false, reason: "error" });
      await expect(pathExists(lockPath)).resolves.toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function sampleBaseline(updatedAt: string): PersonalBaseline {
  return {
    schema: "ccverdict.baseline.v1",
    version: 1,
    createdAt: "2026-05-19T00:00:00.000Z",
    updatedAt,
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

function expectNoPrivacySentinels(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const sentinel of privacySentinels) {
    expect(serialized).not.toContain(sentinel);
  }
}
