import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { baselineRefreshLockPath } from "../src/baseline-refresh.js";
import { lessonMemoryPath } from "../src/memory-lessons.js";
import { projectBaselinePath, projectKeyFromPath } from "../src/paths.js";
import { createTempWorkspace, pathExists, removeTempWorkspace, type TempWorkspace, writeJson } from "./helpers/temp.js";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const tscPath = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));

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

interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
}

let compiledRoot: string | undefined;
let cliPath: string | undefined;

beforeAll(async () => {
  compiledRoot = await mkdtemp(join(tmpdir(), "bb-cc-lite-cli-build-"));
  await writeFile(join(compiledRoot, "package.json"), '{"type":"module"}\n', "utf8");
  const distDir = join(compiledRoot, "dist");
  const result = await runProcess(process.execPath, [tscPath, "-p", "tsconfig.json", "--outDir", distDir], {
    cwd: repoRoot
  });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to compile CLI fixture:\n${result.stdout}\n${result.stderr}`);
  }
  cliPath = join(distDir, "cli.js");
}, 30_000);

afterAll(async () => {
  if (compiledRoot) {
    await rm(compiledRoot, { recursive: true, force: true });
  }
});

describe("CLI behavior characterization", () => {
  it("install --no-learn skips personal baseline learning explicitly", async () => {
    const workspace = await createTempWorkspace();
    try {
      const result = await runCli(["install", "--project", workspace.projectDir, "--home", workspace.homeDir, "--no-learn"], {
        env: cliEnv(workspace)
      });
      const settingsPath = join(workspace.projectDir, ".claude", "settings.local.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        hooks: Record<string, Array<{ hooks: Array<{ args: string[] }> }>>;
      };
      const launcher = await readFile(join(workspace.appHome, "bin", "statusline"), "utf8");

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Installed bb-cc-lite statusLine");
      expect(result.stdout).toContain("Personal baseline skipped (--no-learn).");
      expect(settings.hooks.SessionStart[0].hooks[0].args).toContain("--bb-cc-lite-learn");
      expect(settings.hooks.SessionStart[0].hooks[0].args).toContain("0");
      expect(launcher).toContain("BB_CC_LITE_AUTO_LEARN=0");
      await expect(pathExists(join(workspace.appHome, "baseline.json"))).resolves.toBe(false);
    } finally {
      await removeTempWorkspace(workspace);
    }
  });

  it("install defaults to coach mode hooks", async () => {
    const workspace = await createTempWorkspace();
    try {
      const result = await runCli(["install", "--project", workspace.projectDir, "--home", workspace.homeDir], {
        env: cliEnv(workspace)
      });
      const settings = JSON.parse(await readFile(join(workspace.projectDir, ".claude", "settings.local.json"), "utf8")) as {
        hooks: Record<string, Array<{ matcher: string; hooks: Array<{ args: string[]; async?: boolean }> }>>;
      };

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Installed bb-cc-lite statusLine and coach hooks");
      expect(Object.keys(settings.hooks).sort()).toEqual([
        "PostCompact",
        "PostToolBatch",
        "PostToolUse",
        "PostToolUseFailure",
        "PreCompact",
        "PreToolUse",
        "SessionEnd",
        "SessionStart",
        "Stop"
      ]);
      expect(settings.hooks.PreToolUse[0].matcher).toBe("Bash");
      expect(settings.hooks.PostToolUseFailure[0].hooks[0].args).toContain("coach");
      expect(settings.hooks.PostToolUseFailure[0].hooks[0].async).toBeUndefined();
      expect(settings.hooks.UserPromptSubmit).toBeUndefined();
    } finally {
      await removeTempWorkspace(workspace);
    }
  });

  it("install --observe-only keeps Claude-facing feedback hooks out", async () => {
    const workspace = await createTempWorkspace();
    try {
      const result = await runCli(["install", "--observe-only", "--project", workspace.projectDir, "--home", workspace.homeDir], {
        env: cliEnv(workspace)
      });
      const settings = JSON.parse(await readFile(join(workspace.projectDir, ".claude", "settings.local.json"), "utf8")) as {
        hooks: Record<string, Array<{ hooks: Array<{ args: string[]; async?: boolean }> }>>;
      };

      expect(result.exitCode).toBe(0);
      expect(settings.hooks.SessionStart).toBeUndefined();
      expect(settings.hooks.PreToolUse).toBeUndefined();
      expect(settings.hooks.PostToolUseFailure[0].hooks[0].args).toContain("observe");
      expect(settings.hooks.PostToolUseFailure[0].hooks[0].async).toBe(true);
    } finally {
      await removeTempWorkspace(workspace);
    }
  });

  it("install --guard is explicit and cannot be combined with observe-only", async () => {
    const workspace = await createTempWorkspace();
    try {
      const guard = await runCli(["install", "--guard", "--project", workspace.projectDir, "--home", workspace.homeDir], {
        env: cliEnv(workspace)
      });
      const settings = JSON.parse(await readFile(join(workspace.projectDir, ".claude", "settings.local.json"), "utf8")) as {
        hooks: Record<string, Array<{ hooks: Array<{ args: string[] }> }>>;
      };
      const invalid = await runCli(
        ["install", "--guard", "--observe-only", "--project", workspace.projectDir, "--home", workspace.homeDir, "--replace"],
        { env: cliEnv(workspace) }
      );

      expect(guard.exitCode).toBe(0);
      expect(settings.hooks.PreToolUse[0].hooks[0].args).toContain("guard");
      expect(invalid.exitCode).toBe(1);
      expect(invalid.stderr).toContain("--guard cannot be combined with --observe-only");
    } finally {
      await removeTempWorkspace(workspace);
    }
  });

  it("install builds a personal baseline by default after statusline install", async () => {
    const workspace = await createTempWorkspace();
    try {
      const env = cliEnv(workspace);
      const transcriptPath = join(workspace.homeDir, ".claude", "projects", "sample", "session.jsonl");
      await writeTranscript(transcriptPath, repeatedFailedTestTranscript(3));

      const result = await runCli(["install", "--project", workspace.projectDir, "--home", workspace.homeDir], {
        env
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Installed bb-cc-lite statusLine");
      expect(result.stdout).toContain("Personal baseline ready (1 sessions).");
      expect(result.stdout).not.toContain("It reads local Claude JSONL once.");
      expect(result.stdout).not.toContain("No prompts, assistant text");

      const baselinePath = join(workspace.appHome, "baseline.json");
      await expect(pathExists(baselinePath)).resolves.toBe(true);
      expectNoPrivacySentinels(await readFile(baselinePath, "utf8"), result.stdout);
    } finally {
      await removeTempWorkspace(workspace);
    }
  });

  it("install creates an empty personal baseline when no Claude history exists", async () => {
    const workspace = await createTempWorkspace();
    try {
      const result = await runCli(["install", "--project", workspace.projectDir, "--home", workspace.homeDir], {
        env: cliEnv(workspace)
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Installed bb-cc-lite statusLine");
      expect(result.stdout).toContain("Personal baseline ready (0 sessions).");

      const baselineText = await readFile(join(workspace.appHome, "baseline.json"), "utf8");
      const baseline = JSON.parse(baselineText) as {
        source: { transcriptFilesScanned?: number; sessionsSeen?: number; maxFiles?: number; maxBytesPerTranscript?: number };
      };
      expect(baseline.source).toMatchObject({
        transcriptFilesScanned: 0,
        sessionsSeen: 0,
        maxFiles: 1500,
        maxBytesPerTranscript: 1048576
      });
      expectNoPrivacySentinels(result.stdout, baselineText);
    } finally {
      await removeTempWorkspace(workspace);
    }
  });

  it("audit scans project history without installing into Claude settings", async () => {
    const workspace = await createTempWorkspace();
    try {
      const transcriptPath = join(
        workspace.homeDir,
        ".claude",
        "projects",
        claudeProjectDirectoryName(workspace.projectDir),
        "session.jsonl"
      );
      await writeTranscript(transcriptPath, repeatedFailedTestTranscript(3));

      const result = await runCli(["audit", "--project", workspace.projectDir, "--home", workspace.homeDir], {
        env: cliEnv(workspace)
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("bb retrospective audit");
      expect(result.stdout).toContain("Would have helped: 1 session");
      expect(result.stdout).toContain("Stop");
      expect(result.stdout).toContain("same test failed 3x without a fix");
      expect(result.stdout).toContain("Repeated retries spotted: 2");
      expect(result.stdout).toContain("Cost/time: not estimated");
      expect(result.stdout).not.toContain("Estimated saved:");
      expect(result.stdout).toContain("Report confidence: high");
      expect(result.stdout).toContain("npx --yes bb-cc-lite install --scope local");
      await expect(pathExists(join(workspace.projectDir, ".claude", "settings.local.json"))).resolves.toBe(false);
      expectNoPrivacySentinels(result.stdout);
    } finally {
      await removeTempWorkspace(workspace);
    }
  });

  it("audit --all-projects scans wider local history without project names", async () => {
    const workspace = await createTempWorkspace();
    try {
      const privateProjectName = "BB_CC_LITE_RAW_PROJECT_NAME_SENTINEL";
      await writeTranscript(
        join(workspace.homeDir, ".claude", "projects", privateProjectName, "session.jsonl"),
        repeatedFailedTestTranscript(3)
      );
      await writeTranscript(join(workspace.homeDir, ".claude", "projects", "other-project", "healthy.jsonl"), successfulRawCommandTranscript("healthy"));

      const result = await runCli(["audit", "--all-projects", "--recent", "10", "--home", workspace.homeDir], {
        env: cliEnv(workspace)
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Scope: all local project transcripts, newest 10");
      expect(result.stdout).toContain("Scanned: 2 Claude Code sessions");
      expect(result.stdout).toContain("Would have helped: 1 session");
      expect(result.stdout).toContain("Repeated retries spotted: 2");
      expect(result.stdout).toContain("Cost/time: not estimated");
      expect(result.stdout).not.toContain("Estimated saved:");
      expect(result.stdout).not.toContain(privateProjectName);
      await expect(pathExists(join(workspace.projectDir, ".claude", "settings.local.json"))).resolves.toBe(false);
      expectNoPrivacySentinels(result.stdout);
    } finally {
      await removeTempWorkspace(workspace);
    }
  });

  it("install preserves a custom statusline by default and skips learning", async () => {
    const workspace = await createTempWorkspace();
    try {
      const env = cliEnv(workspace);
      const settingsPath = join(workspace.projectDir, ".claude", "settings.local.json");
      await mkdir(dirname(settingsPath), { recursive: true });
      await writeFile(
        settingsPath,
        `${JSON.stringify({ statusLine: { type: "command", command: "custom-statusline" } }, null, 2)}\n`,
        "utf8"
      );
      await writeTranscript(
        join(workspace.homeDir, ".claude", "projects", "sample", "session.jsonl"),
        repeatedFailedTestTranscript(3)
      );

      const result = await runCli(["install", "--project", workspace.projectDir, "--home", workspace.homeDir], {
        env
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Existing Claude statusLine found");
      expect(result.stdout).toContain("pass --replace");
      expect(result.stdout).not.toContain("Personal baseline ready");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as { statusLine?: { command?: string } };
      expect(settings.statusLine?.command).toBe("custom-statusline");
      await expect(pathExists(join(workspace.appHome, "baseline.json"))).resolves.toBe(false);
    } finally {
      await removeTempWorkspace(workspace);
    }
  });

  it("install --replace replaces a custom statusline and still learns", async () => {
    const workspace = await createTempWorkspace();
    try {
      const env = cliEnv(workspace);
      const settingsPath = join(workspace.projectDir, ".claude", "settings.local.json");
      await mkdir(dirname(settingsPath), { recursive: true });
      await writeFile(
        settingsPath,
        `${JSON.stringify({ statusLine: { type: "command", command: "custom-statusline" } }, null, 2)}\n`,
        "utf8"
      );
      await writeTranscript(
        join(workspace.homeDir, ".claude", "projects", "sample", "session.jsonl"),
        repeatedFailedTestTranscript(3)
      );

      const result = await runCli(["install", "--replace", "--project", workspace.projectDir, "--home", workspace.homeDir], {
        env
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Replaced existing Claude statusLine with bb-cc-lite");
      expect(result.stdout).toContain("Previous settings were backed up.");
      expect(result.stdout).toContain("Personal baseline ready (1 sessions).");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as { statusLine?: { command?: string } };
      expect(settings.statusLine?.command).toContain(join(workspace.appHome, "bin", "statusline"));
      await expect(pathExists(join(workspace.appHome, "baseline.json"))).resolves.toBe(true);
    } finally {
      await removeTempWorkspace(workspace);
    }
  });

  it("unlearn clears all learned baselines", async () => {
    const workspace = await createTempWorkspace();
    try {
      const baselinePath = join(workspace.appHome, "baseline.json");
      const projectKey = projectKeyFromPath(workspace.projectDir);
      const projectBaselineFile = projectBaselinePath({ appHomePath: workspace.appHome, projectKey });
      const lessonFile = lessonMemoryPath({ appHomePath: workspace.appHome, projectKey });
      await writeFile(baselinePath, '{"schema":"bb-cc-lite.baseline.v1"}\n', "utf8");
      await writeJson(projectBaselineFile, { schema: "bb-cc-lite.baseline.v1" });
      await writeJson(lessonFile, { schema: "bb-cc-lite.lesson-memory.v1" });

      const result = await runCli(["unlearn", "--home", workspace.homeDir], {
        env: cliEnv(workspace)
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toBe("Cleared learned baselines and lesson memory.");
      await expect(pathExists(baselinePath)).resolves.toBe(false);
      await expect(pathExists(projectBaselineFile)).resolves.toBe(false);
      await expect(pathExists(lessonFile)).resolves.toBe(false);
    } finally {
      await removeTempWorkspace(workspace);
    }
  });

  it("baseline-refresh --quiet rebuilds a baseline without output or private data", async () => {
    const workspace = await createTempWorkspace();
    try {
      const env = cliEnv(workspace, { autoLearn: true });
      await writeTranscript(
        join(workspace.homeDir, ".claude", "projects", "sample", "session.jsonl"),
        repeatedFailedTestTranscript(3)
      );

      const result = await runCli(["baseline-refresh", "--quiet", "--home", workspace.homeDir], { env });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");

      const baselineText = await readFile(join(workspace.appHome, "baseline.json"), "utf8");
      const baseline = JSON.parse(baselineText) as { source: { maxFiles?: number; maxBytesPerTranscript?: number } };
      expect(baseline.source.maxFiles).toBe(1500);
      expect(baseline.source.maxBytesPerTranscript).toBe(1048576);
      expectNoPrivacySentinels(baselineText);
    } finally {
      await removeTempWorkspace(workspace);
    }
  });

  it("baseline-refresh --quiet handles no transcript history gracefully", async () => {
    const workspace = await createTempWorkspace();
    try {
      const baselinePath = join(workspace.appHome, "baseline.json");
      const result = await runCli(["baseline-refresh", "--quiet", "--home", workspace.homeDir], {
        env: cliEnv(workspace, { autoLearn: true })
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      await expect(pathExists(baselinePath)).resolves.toBe(true);
      const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as {
        source: { transcriptFilesScanned?: number; sessionsSeen?: number; maxFiles?: number; maxBytesPerTranscript?: number };
      };
      expect(baseline.source).toMatchObject({
        transcriptFilesScanned: 0,
        sessionsSeen: 0,
        maxFiles: 1500,
        maxBytesPerTranscript: 1048576
      });
      expectNoPrivacySentinels(JSON.stringify(baseline));
    } finally {
      await removeTempWorkspace(workspace);
    }
  });

  it("records and explains a healthy statusline decision without leaking private fields", async () => {
    const workspace = await createTempWorkspace();
    try {
      const sessionId = `session-${privacySentinels[0]}`;
      const env = cliEnv(workspace);

      const statusline = await runCli(["statusline"], {
        env,
        input: statusInput({
          session_id: sessionId,
          context_window: {
            used_tokens: 84_000,
            total: 200_000
          },
          cost: {
            total_cost_usd: 0.0421
          },
          usage: {
            cache_creation_input_tokens: 200,
            cache_read_input_tokens: 900
          },
          terminal_width: 180
        })
      });

      expect(statusline.exitCode).toBe(0);
      expect(statusline.stderr).toBe("");
      expect(statusline.stdout.trim()).toContain("bb: Healthy");
      expect(statusline.stdout).toContain("ctx 42%");
      expect(statusline.stdout).toContain("cache warm");
      expect(statusline.stdout).toContain("continue normally");

      const why = await runCli(["why"], { env });
      expect(why.exitCode).toBe(0);
      expect(why.stdout).toContain("Last decision: Healthy.");
      expect(why.stdout).toContain("Reason: ctx 42%. cache warm.");
      expect(why.stdout).toContain("Next action: continue normally.");
      expect(why.stdout).toContain("Cost evidence: $0.0421.");

      const whyJson = await runCli(["why", "--json"], { env });
      expect(whyJson.exitCode).toBe(0);
      const parsedWhy = JSON.parse(whyJson.stdout) as { state: string; reasonCode: string; sessionKey?: string };
      expect(parsedWhy).toMatchObject({
        state: "Healthy",
        reasonCode: "healthy"
      });
      expect(parsedWhy.sessionKey).toEqual(expect.any(String));

      const storeText = await readFile(env.BB_CC_LITE_STORE as string, "utf8");
      expectNoPrivacySentinels(statusline.stdout, why.stdout, whyJson.stdout, storeText);
    } finally {
      await removeTempWorkspace(workspace);
    }
  });

  it("uses an aggregate personal baseline for read-heavy statusline wording", async () => {
    const workspace = await createTempWorkspace();
    try {
      const env = cliEnv(workspace);
      await writeJson(join(workspace.appHome, "baseline.json"), readHeavyBaseline());
      const transcriptPath = join(workspace.root, "transcripts", "research.jsonl");
      await writeTranscript(transcriptPath, readHeavyTranscript());

      const statusline = await runCli(["statusline"], {
        env,
        input: statusInput({
          session_id: "session-research",
          transcript_path: transcriptPath,
          terminal_width: 180
        })
      });

      expect(statusline.exitCode).toBe(0);
      expect(statusline.stderr).toBe("");
      expect(statusline.stdout).toContain("bb: Healthy");
      expect(statusline.stdout).toContain("research-heavy session usually ended OK");
      expect(statusline.stdout).toContain("similar research-heavy sessions usually ended OK");
      expectNoPrivacySentinels(statusline.stdout, await readFile(env.BB_CC_LITE_STORE as string, "utf8"));
    } finally {
      await removeTempWorkspace(workspace);
    }
  });

  it("uses a strong project baseline for normal project budget patterns", async () => {
    const workspace = await createTempWorkspace();
    try {
      const env = cliEnv(workspace);
      const projectKey = projectKeyFromPath(workspace.projectDir);
      await writeJson(
        projectBaselinePath({ appHomePath: workspace.appHome, projectKey }),
        {
          ...readHeavyBaseline(),
          project: {
            kind: "hashed_project",
            key: projectKey
          },
          source: {
            ...readHeavyBaseline().source,
            sessionsSeen: 6,
            transcriptFilesScanned: 6
          },
          budget: {
            costSamples: 6,
            durationSamples: 6,
            p75CostUsd: 2.5,
            p90CostUsd: 4,
            p75DurationMs: 60 * 60_000,
            p90DurationMs: 90 * 60_000,
            confidence: "medium"
          }
        }
      );

      const statusline = await runCli(["statusline"], {
        env,
        input: statusInput({
          session_id: "session-project-budget",
          cwd: workspace.projectDir,
          cost: {
            total_cost_usd: 2.4,
            total_duration_ms: 60 * 60_000
          },
          terminal_width: 180
        })
      });

      expect(statusline.exitCode).toBe(0);
      expect(statusline.stderr).toBe("");
      expect(statusline.stdout).toContain("bb: Healthy");
      expect(statusline.stdout).not.toContain("cost is above");
      expect(statusline.stdout).not.toContain("session ran");
      expect(statusline.stdout).not.toContain(workspace.projectDir);
      expectNoPrivacySentinels(statusline.stdout, await readFile(env.BB_CC_LITE_STORE as string, "utf8"));
    } finally {
      await removeTempWorkspace(workspace);
    }
  });

  it("does not scan old Claude JSONL history during statusline rendering", async () => {
    const workspace = await createTempWorkspace();
    try {
      const env = cliEnv(workspace);
      await writeTranscript(
        join(workspace.homeDir, ".claude", "projects", "old", "stop-loop.jsonl"),
        repeatedFailedTestTranscript(3)
      );

      const statusline = await runCli(["statusline"], {
        env,
        input: statusInput({
          session_id: "session-no-transcript",
          terminal_width: 180
        })
      });

      expect(statusline.exitCode).toBe(0);
      expect(statusline.stderr).toBe("");
      expect(statusline.stdout).toContain("bb: Healthy");
      expect(statusline.stdout).not.toContain("test loop");
      expectNoPrivacySentinels(statusline.stdout, await readFile(env.BB_CC_LITE_STORE as string, "utf8"));
    } finally {
      await removeTempWorkspace(workspace);
    }
  });

  it("uses environment budget thresholds in the real statusline path", async () => {
    const workspace = await createTempWorkspace();
    try {
      const env = {
        ...cliEnv(workspace),
        BB_CC_LITE_BUDGET_COST_USD: "0.10",
        BB_CC_LITE_BUDGET_DURATION_MS: "10000"
      };

      const costStatusline = await runCli(["statusline"], {
        env,
        input: statusInput({
          session_id: "session-budget-env-cost",
          cwd: workspace.projectDir,
          cost: {
            total_cost_usd: 0.11
          },
          terminal_width: 180
        })
      });
      const costWhy = await runCli(["why", "--session", "session-budget-env-cost", "--json"], { env });

      const durationStatusline = await runCli(["statusline"], {
        env,
        input: statusInput({
          session_id: "session-budget-env-duration",
          cwd: workspace.projectDir,
          duration_ms: 11000,
          terminal_width: 180
        })
      });
      const durationWhy = await runCli(["why", "--session", "session-budget-env-duration", "--json"], { env });

      expect(costStatusline.exitCode).toBe(0);
      expect(durationStatusline.exitCode).toBe(0);
      expect(costStatusline.stdout).toContain("bb: Careful");
      expect(durationStatusline.stdout).toContain("bb: Careful");
      expect(JSON.parse(costWhy.stdout)).toMatchObject({ reasonCode: "cost_budget" });
      expect(JSON.parse(durationWhy.stdout)).toMatchObject({ reasonCode: "duration_budget" });
      expectNoPrivacySentinels(costStatusline.stdout, durationStatusline.stdout, await readFile(env.BB_CC_LITE_STORE as string, "utf8"));
    } finally {
      await removeTempWorkspace(workspace);
    }
  });

  it("statusline triggers stale baseline refresh in the background without changing current output", async () => {
    const workspace = await createTempWorkspace();
    try {
      const env = cliEnv(workspace, { autoLearn: true });
      const staleBaseline = {
        ...readHeavyBaseline(),
        createdAt: "2000-01-01T00:00:00.000Z",
        updatedAt: "2000-01-01T00:00:00.000Z"
      };
      await writeJson(join(workspace.appHome, "baseline.json"), staleBaseline);
      await writeTranscript(
        join(workspace.homeDir, ".claude", "projects", "sample", "session.jsonl"),
        repeatedFailedTestTranscript(3)
      );
      const transcriptPath = join(workspace.root, "transcripts", "research.jsonl");
      await writeTranscript(transcriptPath, readHeavyTranscript());

      const startedAt = performance.now();
      const statusline = await runCli(["statusline"], {
        env,
        input: statusInput({
          session_id: "session-stale-refresh",
          transcript_path: transcriptPath,
          terminal_width: 180
        })
      });
      const elapsedMs = performance.now() - startedAt;

      expect(statusline.exitCode).toBe(0);
      expect(statusline.stderr).toBe("");
      expect(statusline.stdout.split("\n").filter(Boolean)).toHaveLength(1);
      expect(statusline.stdout).toContain("research-heavy session usually ended OK");
      expect(elapsedMs).toBeLessThan(1000);

      const refreshed = await waitForBaselineUpdated(join(workspace.appHome, "baseline.json"), staleBaseline.updatedAt);
      expect(refreshed.source).toMatchObject({
        transcriptFilesScanned: 1,
        sessionsSeen: 1,
        maxFiles: 1500,
        maxBytesPerTranscript: 1048576
      });
      expect(new Date(refreshed.updatedAt).getTime()).toBeGreaterThan(new Date(staleBaseline.updatedAt).getTime());
      expectNoPrivacySentinels(JSON.stringify(refreshed), statusline.stdout);
      await waitForPathAbsent(baselineRefreshLockPath({ appHomePath: workspace.appHome }));
    } finally {
      await removeTempWorkspace(workspace);
    }
  });

  it("statusline triggers a missing-baseline refresh only when auto learning is enabled", async () => {
    const enabledWorkspace = await createTempWorkspace();
    try {
      const enabledEnv = cliEnv(enabledWorkspace, { autoLearn: true });
      await writeTranscript(
        join(enabledWorkspace.homeDir, ".claude", "projects", "sample", "session.jsonl"),
        repeatedFailedTestTranscript(2)
      );

      const enabled = await runCli(["statusline"], {
        env: enabledEnv,
        input: statusInput({
          session_id: "session-missing-refresh-enabled",
          terminal_width: 180
        })
      });

      expect(enabled.exitCode).toBe(0);
      expect(enabled.stderr).toBe("");
      expect(enabled.stdout.split("\n").filter(Boolean)).toHaveLength(1);
      const enabledBaselinePath = join(enabledWorkspace.appHome, "baseline.json");
      const firstBaseline = await waitForBaselineUpdated(enabledBaselinePath);

      const second = await runCli(["statusline"], {
        env: enabledEnv,
        input: statusInput({
          session_id: "session-missing-refresh-enabled-second",
          terminal_width: 180
        })
      });
      expect(second.exitCode).toBe(0);
      expect(second.stderr).toBe("");
      await wait(200);
      const secondBaseline = JSON.parse(await readFile(enabledBaselinePath, "utf8")) as { updatedAt: string };
      expect(secondBaseline.updatedAt).toBe(firstBaseline.updatedAt);
      await waitForPathAbsent(baselineRefreshLockPath({ appHomePath: enabledWorkspace.appHome }));
    } finally {
      await removeTempWorkspace(enabledWorkspace);
    }

    const disabledWorkspace = await createTempWorkspace();
    try {
      await writeTranscript(
        join(disabledWorkspace.homeDir, ".claude", "projects", "sample", "session.jsonl"),
        repeatedFailedTestTranscript(2)
      );

      const disabled = await runCli(["statusline"], {
        env: cliEnv(disabledWorkspace),
        input: statusInput({
          session_id: "session-missing-refresh-disabled",
          terminal_width: 180
        })
      });

      expect(disabled.exitCode).toBe(0);
      expect(disabled.stderr).toBe("");
      expect(disabled.stdout.split("\n").filter(Boolean)).toHaveLength(1);
      await wait(200);
      await expect(pathExists(join(disabledWorkspace.appHome, "baseline.json"))).resolves.toBe(false);
      await waitForPathAbsent(baselineRefreshLockPath({ appHomePath: disabledWorkspace.appHome }));
    } finally {
      await removeTempWorkspace(disabledWorkspace);
    }
  });

  it("statusline respects the refresh lock and does not duplicate background work", async () => {
    const workspace = await createTempWorkspace();
    try {
      const env = cliEnv(workspace, { autoLearn: true });
      const staleBaseline = {
        ...readHeavyBaseline(),
        updatedAt: "2000-01-01T00:00:00.000Z"
      };
      await writeJson(join(workspace.appHome, "baseline.json"), staleBaseline);
      const lockPath = baselineRefreshLockPath({ appHomePath: workspace.appHome });
      await writeFile(lockPath, `${JSON.stringify({ startedAt: new Date().toISOString(), pid: 12345 })}\n`, "utf8");

      const statusline = await runCli(["statusline"], {
        env,
        input: statusInput({
          session_id: "session-refresh-locked",
          terminal_width: 180
        })
      });

      expect(statusline.exitCode).toBe(0);
      expect(statusline.stderr).toBe("");
      expect(statusline.stdout.split("\n").filter(Boolean)).toHaveLength(1);
      await wait(200);
      const baseline = JSON.parse(await readFile(join(workspace.appHome, "baseline.json"), "utf8")) as { updatedAt: string };
      expect(baseline.updatedAt).toBe(staleBaseline.updatedAt);
      expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ pid: 12345 });
    } finally {
      await removeTempWorkspace(workspace);
    }
  });

  it("statusline degrades safely with corrupt or sparse baselines", async () => {
    const workspace = await createTempWorkspace();
    try {
      const env = cliEnv(workspace);
      const transcriptPath = join(workspace.root, "transcripts", "with-intervention.jsonl");
      await writeTranscript(transcriptPath, repeatedFailedTestWithEditInterventionTranscript());
      await writeFile(join(workspace.appHome, "baseline.json"), "{not-json", "utf8");

      const corrupt = await runCli(["statusline"], {
        env,
        input: statusInput({
          session_id: "session-corrupt-baseline",
          transcript_path: transcriptPath,
          terminal_width: 180
        })
      });
      expect(corrupt.exitCode).toBe(0);
      expect(corrupt.stdout).toContain("bb: Careful");
      expect(corrupt.stdout).toContain("tests failed twice");
      expect(corrupt.stdout).not.toContain("usually passes");

      await writeJson(join(workspace.appHome, "baseline.json"), sparseRecoveryBaseline());
      const sparse = await runCli(["statusline"], {
        env,
        input: statusInput({
          session_id: "session-sparse-baseline",
          transcript_path: transcriptPath,
          terminal_width: 180
        })
      });
      expect(sparse.exitCode).toBe(0);
      expect(sparse.stdout).toContain("bb: Careful");
      expect(sparse.stdout).toContain("tests failed twice");
      expect(sparse.stdout).not.toContain("usually passes");
      expectNoPrivacySentinels(corrupt.stdout, sparse.stdout, await readFile(env.BB_CC_LITE_STORE as string, "utf8"));
    } finally {
      await removeTempWorkspace(workspace);
    }
  });

  it("explains extended baseline recovery influence through statusline and why safely", async () => {
    const workspace = await createTempWorkspace();
    try {
      const env = cliEnv(workspace);
      await writeJson(join(workspace.appHome, "baseline.json"), recoveryBaseline());
      const transcriptPath = join(workspace.root, "transcripts", "two-test-failures.jsonl");
      await writeTranscript(transcriptPath, repeatedFailedTestWithEditInterventionTranscript());

      const statusline = await runCli(["statusline"], {
        env,
        input: statusInput({
          session_id: "session-recovery-baseline",
          transcript_path: transcriptPath,
          terminal_width: 180
        })
      });

      expect(statusline.exitCode).toBe(0);
      expect(statusline.stderr).toBe("");
      expect(statusline.stdout).toContain("bb: Careful");
      expect(statusline.stdout).toContain("tests failed twice; usually passes after one targeted fix");

      const why = await runCli(["why"], { env });
      expect(why.stdout).toContain("Baseline: test failures usually recovered after one targeted fix.");

      const whyJson = await runCli(["why", "--json"], { env });
      const parsed = JSON.parse(whyJson.stdout) as { state: string; baselineNote?: string };
      expect(parsed).toMatchObject({
        state: "Careful",
        baselineNote: "test failures usually recovered after one targeted fix"
      });
      expectNoPrivacySentinels(statusline.stdout, why.stdout, whyJson.stdout, await readFile(env.BB_CC_LITE_STORE as string, "utf8"));
    } finally {
      await removeTempWorkspace(workspace);
    }
  });

  it("renders edit-without-check wording through the real statusline and why path", async () => {
    const workspace = await createTempWorkspace();
    try {
      const env = cliEnv(workspace);
      const transcriptPath = join(workspace.root, "transcripts", "unchecked-edit.jsonl");
      await writeTranscript(transcriptPath, unvalidatedEditTranscript());

      const statusline = await runCli(["statusline"], {
        env,
        input: statusInput({
          session_id: "session-unchecked-edit",
          transcript_path: transcriptPath,
          terminal_width: 180
        })
      });

      expect(statusline.exitCode).toBe(0);
      expect(statusline.stderr).toBe("");
      expect(statusline.stdout).toContain("bb: Careful");
      expect(statusline.stdout).toContain("edits have not been checked yet");
      expect(statusline.stdout).toContain("ask Claude to run the smallest relevant check");
      expect(statusline.stdout).not.toContain("focused check");
      expect(statusline.stdout).not.toContain("validation lag");

      const why = await runCli(["why"], { env });
      expect(why.stdout).toContain("Reason: edits have not been checked.");
      expect(why.stdout).toContain("Next action: ask Claude to run the smallest relevant check.");
      expect(why.stdout).not.toContain("focused check");
      expectNoPrivacySentinels(statusline.stdout, why.stdout, await readFile(env.BB_CC_LITE_STORE as string, "utf8"));
    } finally {
      await removeTempWorkspace(workspace);
    }
  });

  it("shows the recent feedback loop in why after hook feedback is resolved", async () => {
    const workspace = await createTempWorkspace();
    try {
      const env = cliEnv(workspace);
      const sessionId = `session-feedback-${privacySentinels[6]}`;
      const editHook = await runCli(["hook", "--bb-cc-lite-hook", "PostToolUse"], {
        env,
        input: hookInput({
          session_id: sessionId,
          hook_event_name: "PostToolUse",
          tool_name: "Edit",
          tool_input: {
            file_path: privacySentinels[4],
            old_string: "before",
            new_string: privacySentinels[3]
          }
        })
      });
      const validationHook = await runCli(["hook", "--bb-cc-lite-hook", "PostToolUse"], {
        env,
        input: hookInput({
          session_id: sessionId,
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: {
            command: `npm test -- ${privacySentinels[5]}`
          }
        })
      });

      const statusline = await runCli(["statusline"], {
        env,
        input: statusInput({
          session_id: sessionId,
          terminal_width: 180
        })
      });
      const why = await runCli(["why", "--session", sessionId], { env });
      const whyJson = await runCli(["why", "--session", sessionId, "--json"], { env });
      const parsedWhy = JSON.parse(whyJson.stdout) as { feedbackOutcomes?: Array<{ outcome?: string; reasonCode?: string }> };

      expect(editHook.exitCode).toBe(0);
      expect(editHook.stdout).toContain("edits have not been validated yet");
      expect(validationHook.exitCode).toBe(0);
      expect(statusline.exitCode).toBe(0);
      expect(statusline.stdout).toContain("bb: Healthy");
      expect(statusline.stdout).toContain("validation resolved");
      expect(why.stdout).toContain("Recent bb loop:");
      expect(why.stdout).toContain("Coach feedback: edits needed validation.");
      expect(why.stdout).toContain("Claude ran tests.");
      expect(why.stdout).toContain("Tests passed.");
      expect(why.stdout).toContain("Outcome: resolved.");
      expect(parsedWhy.feedbackOutcomes).toEqual([
        expect.objectContaining({
          reasonCode: "edit_without_validation",
          outcome: "resolved"
        })
      ]);
      expect(whyJson.stdout).not.toContain("\u001b[");
      expectNoPrivacySentinels(editHook.stdout, validationHook.stdout, statusline.stdout, why.stdout, whyJson.stdout, await readFile(env.BB_CC_LITE_STORE as string, "utf8"));
    } finally {
      await removeTempWorkspace(workspace);
    }
  });

  it("uses edit-check history through the real statusline path without internal wording", async () => {
    const workspace = await createTempWorkspace();
    try {
      const env = cliEnv(workspace);
      await writeJson(join(workspace.appHome, "baseline.json"), editValidationBaseline());
      const transcriptPath = join(workspace.root, "transcripts", "unusual-unchecked-edit.jsonl");
      await writeTranscript(transcriptPath, unvalidatedEditTranscript(7));

      const statusline = await runCli(["statusline"], {
        env,
        input: statusInput({
          session_id: "session-unusual-unchecked-edit",
          transcript_path: transcriptPath,
          terminal_width: 180
        })
      });

      expect(statusline.exitCode).toBe(0);
      expect(statusline.stderr).toBe("");
      expect(statusline.stdout).toContain("bb: Careful");
      expect(statusline.stdout).toContain("edits have gone longer than usual without a check");
      expect(statusline.stdout).toContain("past sessions usually checked edits sooner");
      expect(statusline.stdout).toContain("ask Claude to run the smallest relevant check");
      expect(statusline.stdout).not.toContain("focused check");
      expect(statusline.stdout).not.toContain("validation lag");

      const why = await runCli(["why"], { env });
      expect(why.stdout).toContain("Baseline: past sessions usually checked edits sooner.");
      expectNoPrivacySentinels(statusline.stdout, why.stdout, await readFile(env.BB_CC_LITE_STORE as string, "utf8"));
    } finally {
      await removeTempWorkspace(workspace);
    }
  });

  it("keeps careful statusline output width-aware", async () => {
    const workspace = await createTempWorkspace();
    try {
      const statusline = await runCli(["statusline"], {
        env: cliEnv(workspace),
        input: statusInput({
          session_id: "session-careful",
          context_window: {
            used_tokens: 164_000,
            total: 200_000
          },
          terminal_width: 55
        })
      });

      const rendered = statusline.stdout.trim();
      expect(statusline.exitCode).toBe(0);
      expect(visibleLength(rendered)).toBeLessThanOrEqual(55);
      expect(rendered).toContain("bb: Careful");
      expect(rendered).toContain("ctx 82%");
      expect(rendered).not.toContain("ask Claude for a 6-bullet handoff before more work");
      expectNoPrivacySentinels(rendered, await readFile(cliEnv(workspace).BB_CC_LITE_STORE as string, "utf8"));
    } finally {
      await removeTempWorkspace(workspace);
    }
  });

  it("renders Stop with inline why and lets why target an older explicit session", async () => {
    const workspace = await createTempWorkspace();
    try {
      const env = cliEnv(workspace);
      const stopSessionId = "session-stop";
      const transcriptPath = join(workspace.root, "transcripts", "stop.jsonl");
      await writeTranscript(transcriptPath, repeatedFailedTestTranscript(3));

      const stop = await runCli(["statusline"], {
        env,
        input: statusInput({
          session_id: stopSessionId,
          transcript_path: transcriptPath,
          terminal_width: 180
        })
      });

      expect(stop.exitCode).toBe(0);
      expect(stop.stdout).toContain("bb: Stop");
      expect(stop.stdout).toContain("why: same failure retried 3x without a fix");
      expect(stop.stdout).toContain("do: stop and inspect first failure");

      const latest = await runCli(["statusline"], {
        env,
        input: statusInput({
          session_id: "session-latest",
          context_window: {
            used_tokens: 20_000,
            total: 200_000
          },
          terminal_width: 180
        })
      });
      expect(latest.exitCode).toBe(0);
      expect(latest.stdout).toContain("bb: Healthy");

      const whyLatest = await runCli(["why"], { env });
      expect(whyLatest.exitCode).toBe(0);
      expect(whyLatest.stdout).toContain("Last decision: Healthy.");

      const whyStop = await runCli(["why", "--session", stopSessionId], { env });
      expect(whyStop.exitCode).toBe(0);
      expect(whyStop.stdout).toContain("Last decision: Stop.");
      expect(whyStop.stdout).toContain(
        "Reason: same test failed 3x without a fix. Claude is repeating the same failure without a fix or passing check."
      );
      expect(whyStop.stdout).toContain("Next action: stop and inspect first failure.");

      const whyJson = await runCli(["why", "--session", stopSessionId, "--json"], { env });
      expect(whyJson.exitCode).toBe(0);
      expect(JSON.parse(whyJson.stdout)).toMatchObject({
        state: "Stop",
        reasonCode: "blind_retry_loop",
        primaryEvidence: "same test failed 3x without a fix"
      });

      const storeText = await readFile(env.BB_CC_LITE_STORE as string, "utf8");
      expectNoPrivacySentinels(stop.stdout, latest.stdout, whyLatest.stdout, whyStop.stdout, whyJson.stdout, storeText);
    } finally {
      await removeTempWorkspace(workspace);
    }
  });

  it("keeps MCP statusline, why, why --json, and store output free of raw MCP names", async () => {
    const workspace = await createTempWorkspace();
    try {
      const env = cliEnv(workspace);
      const rawMcpName = "mcp__privateServer__failingLookup";
      const transcriptPath = join(workspace.root, "transcripts", "mcp-stop.jsonl");
      await writeTranscript(transcriptPath, repeatedFailedMcpTranscript(rawMcpName, 3));

      const statusline = await runCli(["statusline"], {
        env,
        input: statusInput({
          session_id: "session-mcp-stop",
          transcript_path: transcriptPath,
          terminal_width: 220
        })
      });

      expect(statusline.exitCode).toBe(0);
      expect(statusline.stderr).toBe("");
      expect(statusline.stdout).toContain(
        "bb: Stop | why: same failure retried 3x without a fix"
      );

      const why = await runCli(["why"], { env });
      expect(why.exitCode).toBe(0);
      expect(why.stdout).toContain(
        "Reason: same MCP tool failed 3x without a fix. Claude is repeating the same failure without a fix or passing check."
      );
      expect(why.stdout).toContain("Next action: stop and inspect first failure.");

      const whyJson = await runCli(["why", "--json"], { env });
      expect(whyJson.exitCode).toBe(0);
      expect(JSON.parse(whyJson.stdout)).toMatchObject({
        state: "Stop",
        reasonCode: "blind_retry_loop",
        primaryEvidence: "same MCP tool failed 3x without a fix"
      });

      const storeText = await readFile(env.BB_CC_LITE_STORE as string, "utf8");
      for (const output of [statusline.stdout, why.stdout, whyJson.stdout, storeText]) {
        expect(output).not.toContain(rawMcpName);
        expect(output).not.toContain("mcp__");
      }
      expectNoPrivacySentinels(statusline.stdout, why.stdout, whyJson.stdout, storeText);
    } finally {
      await removeTempWorkspace(workspace);
    }
  });

  it("keeps end-to-end CLI QA surfaces free of forbidden raw data sentinels", async () => {
    const workspace = await createTempWorkspace();
    try {
      const env = {
        ...cliEnv(workspace),
        BB_CC_LITE_PRICING_CACHE: join(workspace.appHome, "pricing.json")
      };
      const refreshEnv = {
        ...cliEnv(workspace, { autoLearn: true }),
        BB_CC_LITE_PRICING_CACHE: join(workspace.appHome, "pricing.json")
      };
      const rawSessionId = `session-${privacySentinels[6]}`;
      const transcriptPath = join(workspace.root, "transcripts", "privacy-surfaces.jsonl");
      await writeTranscript(transcriptPath, privacySurfaceTranscript());
      await writeHistoricalPrivacyTranscripts(workspace.homeDir);

      const statusline = await runCli(["statusline"], {
        env,
        input: statusInput({
          session_id: rawSessionId,
          transcript_path: transcriptPath,
          terminal_width: 240
        })
      });

      expect(statusline.exitCode).toBe(0);
      expect(statusline.stderr).toBe("");
      expect(statusline.stdout).toContain("bb: Stop");

      const why = await runCli(["why", "--session", rawSessionId], { env });
      const whyJson = await runCli(["why", "--session", rawSessionId, "--json"], { env });
      expect(why.exitCode).toBe(0);
      expect(whyJson.exitCode).toBe(0);
      expect(JSON.parse(whyJson.stdout)).toMatchObject({
        state: "Stop"
      });

      const refresh = await runCli(["baseline-refresh", "--quiet", "--home", workspace.homeDir], { env: refreshEnv });
      expect(refresh.exitCode).toBe(0);
      expect(refresh.stdout).toBe("");
      expect(refresh.stderr).toBe("");

      const doctor = await runCli(
        [
          "doctor",
          "--project",
          workspace.projectDir,
          "--home",
          workspace.homeDir,
          "--transcript",
          transcriptPath,
          "--build-baseline",
          "--baseline",
          "--replay-baseline"
        ],
        { env }
      );
      expect(doctor.exitCode).toBe(0);
      expect(doctor.stdout).toContain("OK baseline:");
      expect(doctor.stdout).toContain("derived aggregate data only");
      expect(doctor.stdout).toContain("baseline-replay:");

      const storeText = await readFile(env.BB_CC_LITE_STORE as string, "utf8");
      const baselineText = await readFile(join(workspace.appHome, "baseline.json"), "utf8");
      const serializedSurfaces = [
        statusline.stdout,
        why.stdout,
        whyJson.stdout,
        refresh.stdout,
        refresh.stderr,
        doctor.stdout,
        doctor.stderr,
        storeText,
        baselineText
      ].join("\n");

      expectNoPrivacySentinels(serializedSurfaces);
      for (const rawPath of [workspace.root, workspace.projectDir, workspace.homeDir, workspace.appHome, transcriptPath]) {
        expect(serializedSurfaces).not.toContain(rawPath);
      }
    } finally {
      await removeTempWorkspace(workspace);
    }
  });

  it("characterizes fixture-based status states through the CLI path", async () => {
    const cases: Array<{
      name: string;
      input: Record<string, unknown>;
      transcript?: string[];
      expected: string[];
    }> = [
      {
        name: "fresh/simple session",
        input: {
          session_id: "fixture-fresh",
          terminal_width: 180
        },
        expected: ["bb: Healthy", "no stop-level findings", "session stable", "continue normally"]
      },
      {
        name: "two repeated failed test commands",
        input: {
          session_id: "fixture-two-failures",
          terminal_width: 180
        },
        transcript: repeatedFailedTestTranscript(2),
        expected: ["bb: Careful", "same test failed twice without a fix", "inspect first failure"]
      },
      {
        name: "three repeated failed test commands",
        input: {
          session_id: "fixture-three-failures",
          terminal_width: 180
        },
        transcript: repeatedFailedTestTranscript(3),
        expected: [
          "bb: Stop",
          "why: same failure retried 3x without a fix",
          "do: stop and inspect first failure"
        ]
      },
      {
        name: "high context",
        input: {
          session_id: "fixture-high-context",
          context_window: {
            used_tokens: 164_000,
            total: 200_000
          },
          terminal_width: 180
        },
        expected: ["bb: Careful", "ctx 82%", "ask Claude for a 6-bullet handoff before more work"]
      },
      {
        name: "cache risk",
        input: {
          session_id: "fixture-cache-risk",
          usage: {
            cache_creation_input_tokens: 50_000,
            cache_read_input_tokens: 100
          },
          terminal_width: 180
        },
        expected: ["bb: Careful", "cache writes high", "keep the next prompt narrow and avoid broad repo scans"]
      },
      {
        name: "compaction event",
        input: {
          session_id: "fixture-compaction",
          terminal_width: 180
        },
        transcript: compactionTranscript(),
        expected: ["bb: Careful", "compaction event seen", "ask Claude to restate current goal and next 3 steps"]
      },
      {
        name: "malformed transcript",
        input: {
          session_id: "fixture-malformed",
          terminal_width: 180
        },
        transcript: ["not-json", "{\"type\":\"assistant\""],
        expected: ["bb: Healthy", "continue normally"]
      },
      {
        name: "missing transcript",
        input: {
          session_id: "fixture-missing",
          transcript_path: "/tmp/bb-cc-lite/missing/transcript.jsonl",
          terminal_width: 180
        },
        expected: ["bb: Healthy", "continue normally"]
      }
    ];

    for (const testCase of cases) {
      const workspace = await createTempWorkspace();
      try {
        const env = cliEnv(workspace);
        const input = { ...testCase.input };
        if (testCase.transcript) {
          const transcriptPath = join(workspace.root, "transcripts", `${testCase.name.replaceAll(/\W+/gu, "-")}.jsonl`);
          await writeTranscript(transcriptPath, testCase.transcript);
          input.transcript_path = transcriptPath;
        }

        const statusline = await runCli(["statusline"], {
          env,
          input: statusInput(input)
        });

        expect(statusline.exitCode, testCase.name).toBe(0);
        expect(statusline.stderr, testCase.name).toBe("");
        expect(statusline.stdout, testCase.name).not.toContain("statusline crashed");
        for (const expected of testCase.expected) {
          expect(statusline.stdout, testCase.name).toContain(expected);
        }
        expectNoPrivacySentinels(statusline.stdout, await readFile(env.BB_CC_LITE_STORE as string, "utf8"));
      } finally {
        await removeTempWorkspace(workspace);
      }
    }
  });
});

function cliEnv(workspace: TempWorkspace, options: { autoLearn?: boolean } = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: workspace.homeDir,
    BB_CC_LITE_COLOR: "0",
    BB_CC_LITE_HOME: workspace.appHome,
    BB_CC_LITE_STORE: join(workspace.appHome, "events.json")
  };
  if (options.autoLearn) {
    delete env.BB_CC_LITE_AUTO_LEARN;
  } else {
    env.BB_CC_LITE_AUTO_LEARN = "0";
  }
  return env;
}

function statusInput(overrides: Record<string, unknown>): string {
  return `${JSON.stringify({
    session_id: "session-default",
    cwd: privacySentinels[4],
    model: {
      id: "claude-sonnet-4-5",
      display_name: "Claude Sonnet 4.5"
    },
    raw_prompt: privacySentinels[0],
    tool_output: privacySentinels[1],
    file_contents: privacySentinels[3],
    environment: {
      ANTHROPIC_API_KEY: privacySentinels[2]
    },
    ...overrides
  })}\n`;
}

function hookInput(overrides: Record<string, unknown>): string {
  return `${JSON.stringify({
    session_id: "session-default",
    hook_event_name: "PostToolUse",
    prompt: privacySentinels[0],
    tool_response: {
      stdout: privacySentinels[1],
      content: privacySentinels[3]
    },
    cwd: privacySentinels[4],
    transcript_path: join(privacySentinels[4], "transcript.jsonl"),
    mcp_server_name: privacySentinels[7],
    ...overrides
  })}\n`;
}

function repeatedFailedTestTranscript(count: number): string[] {
  return Array.from({ length: count }, (_value, index) => index + 1).flatMap((index) => [
    JSON.stringify({
      timestamp: `2026-05-19T00:00:0${index}.000Z`,
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: `bash-test-${index}`,
            name: "Bash",
            input: {
              command: `npm test -- ${privacySentinels[0]}`
            }
          }
        ]
      }
    }),
    JSON.stringify({
      timestamp: `2026-05-19T00:00:1${index}.000Z`,
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: `bash-test-${index}`,
            is_error: true,
            content: `failed test output ${privacySentinels[1]} ${privacySentinels[2]} ${privacySentinels[3]} ${privacySentinels[4]}`
          }
        ]
      }
    })
  ]);
}

function claudeProjectDirectoryName(projectDir: string): string {
  return resolve(projectDir).replaceAll(/[\\/]/gu, "-");
}

function repeatedFailedTestWithEditInterventionTranscript(): string[] {
  const firstFailure = repeatedFailedTestTranscript(1);
  const secondFailure = repeatedFailedTestTranscript(1).map((line) => line.replaceAll("bash-test-1", "bash-test-after-edit"));
  return [
    ...firstFailure,
    JSON.stringify({
      timestamp: "2026-05-19T00:00:30.000Z",
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "edit-between-tests",
            name: "Edit",
            input: {
              file_path: privacySentinels[4],
              new_string: privacySentinels[3]
            }
          }
        ]
      }
    }),
    JSON.stringify({
      timestamp: "2026-05-19T00:00:31.000Z",
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "edit-between-tests",
            is_error: false,
            content: "edited"
          }
        ]
      }
    }),
    ...secondFailure
  ];
}

function unvalidatedEditTranscript(extraToolResultsAfterEdit = 0): string[] {
  const lines = [
    JSON.stringify({
      timestamp: "2026-05-19T00:05:00.000Z",
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "unchecked-edit",
            name: "Edit",
            input: {
              file_path: privacySentinels[4],
              old_string: "before",
              new_string: privacySentinels[3]
            }
          }
        ]
      }
    }),
    JSON.stringify({
      timestamp: "2026-05-19T00:05:01.000Z",
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "unchecked-edit",
            is_error: false,
            content: "edited"
          }
        ]
      }
    })
  ];

  for (let index = 0; index < extraToolResultsAfterEdit; index += 1) {
    lines.push(
      JSON.stringify({
        timestamp: `2026-05-19T00:05:${String(index + 2).padStart(2, "0")}.000Z`,
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: `post-edit-read-${index}`,
              name: "Read",
              input: {
                file_path: privacySentinels[4]
              }
            }
          ]
        }
      }),
      JSON.stringify({
        timestamp: `2026-05-19T00:06:${String(index + 2).padStart(2, "0")}.000Z`,
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: `post-edit-read-${index}`,
              is_error: false,
              content: "read complete"
            }
          ]
        }
      })
    );
  }

  return lines;
}

function repeatedFailedMcpTranscript(rawMcpName: string, count: number): string[] {
  return Array.from({ length: count }, (_value, index) => index + 1).flatMap((index) => [
    JSON.stringify({
      timestamp: `2026-05-19T00:03:0${index}.000Z`,
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: `mcp-fail-${index}`,
            name: rawMcpName,
            input: {
              private_query: privacySentinels[0]
            }
          }
        ]
      }
    }),
    JSON.stringify({
      timestamp: `2026-05-19T00:04:0${index}.000Z`,
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: `mcp-fail-${index}`,
            is_error: true,
            content: `failed MCP output ${privacySentinels[1]}`
          }
        ]
      }
    })
  ]);
}

function privacySurfaceTranscript(): string[] {
  return [
    JSON.stringify({
      session_id: privacySentinels[6],
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: privacySentinels[0] }]
      }
    }),
    ...repeatedFailedRawCommandTranscript("privacy-bash", 3),
    ...repeatedFailedMcpTranscript(privacySentinels[7], 2),
    JSON.stringify({
      timestamp: "2026-05-19T00:07:00.000Z",
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "privacy-edit",
            name: "Edit",
            input: {
              file_path: privacySentinels[4],
              old_string: "before",
              new_string: privacySentinels[3]
            }
          }
        ]
      }
    }),
    JSON.stringify({
      timestamp: "2026-05-19T00:07:01.000Z",
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "privacy-edit",
            is_error: false,
            content: privacySentinels[1]
          }
        ]
      }
    })
  ];
}

function repeatedFailedRawCommandTranscript(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_value, index) => index + 1).flatMap((index) => [
    JSON.stringify({
      timestamp: `2026-05-19T00:08:0${index}.000Z`,
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: `${prefix}-${index}`,
            name: "Bash",
            input: {
              command: `npm test -- ${privacySentinels[5]} ${privacySentinels[4]}`
            }
          }
        ]
      }
    }),
    JSON.stringify({
      timestamp: `2026-05-19T00:09:0${index}.000Z`,
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: `${prefix}-${index}`,
            is_error: true,
            content: `${privacySentinels[1]} ${privacySentinels[2]} ${privacySentinels[3]}`
          }
        ]
      }
    })
  ]);
}

async function writeHistoricalPrivacyTranscripts(homeDir: string): Promise<void> {
  const projectDir = join(homeDir, ".claude", "projects", "privacy");
  await writeTranscript(join(projectDir, "older-recovered.jsonl"), [
    ...repeatedFailedRawCommandTranscript("older-bash", 2),
    ...successfulRawCommandTranscript("older-pass")
  ]);
  await writeTranscript(join(projectDir, "newer-unrecovered.jsonl"), [
    ...repeatedFailedRawCommandTranscript("newer-bash", 3),
    ...repeatedFailedMcpTranscript(privacySentinels[7], 3)
  ]);
}

function successfulRawCommandTranscript(id: string): string[] {
  return [
    JSON.stringify({
      timestamp: "2026-05-19T00:10:00.000Z",
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id,
            name: "Bash",
            input: {
              command: `npm test -- ${privacySentinels[5]}`
            }
          }
        ]
      }
    }),
    JSON.stringify({
      timestamp: "2026-05-19T00:10:01.000Z",
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: id,
            is_error: false,
            content: privacySentinels[1]
          }
        ]
      }
    })
  ];
}

function compactionTranscript(): string[] {
  return [
    JSON.stringify({
      timestamp: "2026-05-19T00:01:00.000Z",
      type: "PostCompact",
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 50
      },
      content: privacySentinels[3]
    })
  ];
}

function readHeavyTranscript(): string[] {
  return Array.from({ length: 5 }, (_value, index) =>
    JSON.stringify({
      timestamp: `2026-05-19T00:02:0${index}.000Z`,
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: `read-${index}`,
            name: index % 2 === 0 ? "Read" : "Grep",
            input: {
              file_path: privacySentinels[4],
              pattern: privacySentinels[0]
            }
          }
        ]
      }
    })
  );
}

function readHeavyBaseline(): Record<string, unknown> {
  return {
    schema: "bb-cc-lite.baseline.v1",
    version: 1,
    createdAt: "2026-05-19T00:00:00.000Z",
    updatedAt: "2026-05-19T00:00:00.000Z",
    source: {
      kind: "local_transcript_scan",
      transcriptFilesScanned: 16,
      sessionsSeen: 16,
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
      toolCalls: 80,
      successfulToolResults: 80,
      failedToolResults: 0,
      validationCalls: 0,
      validationFailures: 0,
      validationSuccesses: 0,
      successfulEditResults: 0,
      readSearchToolCalls: 70
    },
    scenarios: {
      read_heavy_debugging: { seen: 16, confidence: "medium" },
      repeated_failure: { seen: 0, confidence: "low" },
      validation_command_loop: { seen: 0, confidence: "low" },
      edit_without_validation: { seen: 0, confidence: "low" },
      validation_recovered: { seen: 0, confidence: "low" }
    },
    outcomes: {
      healthyLike: {
        validationPassedAfterEdit: 0,
        validationRecovered: 0,
        readHeavyNoFailure: 16
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

function recoveryBaseline(): Record<string, unknown> {
  return {
    ...readHeavyBaseline(),
    validation: {
      tests: {
        calls: 24,
        failures: 10,
        failureRate: 0.4167,
        recovered: 9,
        unrecovered: 1,
        recoveryRate: 0.9,
        averageFailuresBeforeRecovery: 1,
        medianFailuresBeforeRecovery: 1,
        p75FailuresBeforeRecovery: 1,
        fivePlusFailuresBeforeRecovery: 0
      }
    }
  };
}

function sparseRecoveryBaseline(): Record<string, unknown> {
  return {
    ...readHeavyBaseline(),
    failureRecovery: {
      tests: {
        episodes: 4,
        recovered: 4,
        unrecovered: 0,
        activeEnded: 0,
        recoveryRate: 1,
        medianAttemptsBeforeRecovery: 1,
        p75AttemptsBeforeRecovery: 1,
        blindRetryEpisodes: 0,
        blindRetryRecovered: 0,
        blindRetryUnrecovered: 0,
        confidence: "low"
      }
    }
  };
}

function editValidationBaseline(): Record<string, unknown> {
  return {
    ...readHeavyBaseline(),
    editValidation: {
      editsFollowedByValidation: 12,
      editsWithoutValidation: 1,
      editWithoutValidationRate: 0.0769,
      medianToolStepsFromEditToValidation: 2,
      p75ToolStepsFromEditToValidation: 4
    }
  };
}

async function writeTranscript(path: string, lines: string[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
}

async function runCli(args: string[], options: RunOptions = {}): Promise<ProcessResult> {
  if (!cliPath) {
    throw new Error("CLI fixture was not compiled");
  }
  return runProcess(process.execPath, [cliPath, ...args], options);
}

async function runProcess(command: string, args: string[], options: RunOptions = {}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || repoRoot,
      env: options.env || process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode: exitCode ?? 0 });
    });
    child.stdin.end(options.input || "");
  });
}

function visibleLength(value: string): number {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;]*m/gu, "").length;
}

async function waitForBaselineUpdated(
  path: string,
  previousUpdatedAt?: string
): Promise<{ updatedAt: string; source: { transcriptFilesScanned: number; sessionsSeen: number; maxFiles?: number; maxBytesPerTranscript?: number } }> {
  const deadline = Date.now() + 5000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as {
        updatedAt?: unknown;
        source?: {
          transcriptFilesScanned?: unknown;
          sessionsSeen?: unknown;
          maxFiles?: unknown;
          maxBytesPerTranscript?: unknown;
        };
      };
      if (
        typeof parsed.updatedAt === "string" &&
        parsed.updatedAt !== previousUpdatedAt &&
        parsed.source &&
        typeof parsed.source.transcriptFilesScanned === "number" &&
        typeof parsed.source.sessionsSeen === "number"
      ) {
        return {
          updatedAt: parsed.updatedAt,
          source: {
            transcriptFilesScanned: parsed.source.transcriptFilesScanned,
            sessionsSeen: parsed.source.sessionsSeen,
            maxFiles: typeof parsed.source.maxFiles === "number" ? parsed.source.maxFiles : undefined,
            maxBytesPerTranscript:
              typeof parsed.source.maxBytesPerTranscript === "number" ? parsed.source.maxBytesPerTranscript : undefined
          }
        };
      }
    } catch (error) {
      lastError = error;
    }
    await wait(50);
  }
  throw new Error(`Timed out waiting for refreshed baseline${lastError instanceof Error ? `: ${lastError.message}` : ""}`);
}

async function waitForPathAbsent(path: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!(await pathExists(path))) {
      return;
    }
    await wait(50);
  }
  throw new Error(`Timed out waiting for ${path} to be removed`);
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function expectNoPrivacySentinels(...values: unknown[]): void {
  const serialized = values.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join("\n");
  for (const sentinel of privacySentinels) {
    expect(serialized).not.toContain(sentinel);
  }
}
