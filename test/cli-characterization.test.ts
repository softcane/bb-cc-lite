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
  const repoPackage = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as { version?: string };
  await writeFile(
    join(compiledRoot, "package.json"),
    `${JSON.stringify({ type: "module", version: repoPackage.version }, null, 2)}\n`,
    "utf8"
  );
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
  it("prints version and command help without running command bodies", async () => {
    const repoPackage = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as { version: string };
    const version = await runCli(["--version"]);
    const versionCommand = await runCli(["version"]);
    const improveHelp = await runCli(["improve", "--help"]);
    const helpImprove = await runCli(["help", "improve"]);
    const learnHelp = await runCli(["learn", "--help"]);
    const auditShortHelp = await runCli(["audit", "-h"]);
    const invalidCleanup = await runCli(["audit", "--cleanup", "--transcript", join(tmpdir(), "private.jsonl")]);

    expect(version.exitCode).toBe(0);
    expect(version.stdout.trim()).toBe(`bb-cc-lite ${repoPackage.version}`);
    expect(versionCommand.exitCode).toBe(0);
    expect(versionCommand.stdout.trim()).toBe(`bb-cc-lite ${repoPackage.version}`);
    expect(improveHelp.exitCode).toBe(0);
    expect(improveHelp.stderr).toBe("");
    expect(improveHelp.stdout).toContain("bb-cc-lite improve");
    expect(improveHelp.stdout).toContain("folded into: bb-cc-lite audit");
    expect(helpImprove.stdout).toContain("bb-cc-lite improve");
    expect(learnHelp.exitCode).toBe(0);
    expect(learnHelp.stdout).toContain("bb-cc-lite learn");
    expect(auditShortHelp.stdout).toContain("bb-cc-lite audit");
    expect(invalidCleanup.exitCode).toBe(1);
    expect(invalidCleanup.stderr).toContain("--cleanup cannot be combined with --transcript");
  });

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
      expect(settings.hooks.PreCompact[0].hooks[0].async).toBe(true);
      expect(settings.hooks.PostCompact[0].hooks[0].async).toBeUndefined();
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
      expect(settings.hooks.SessionStart[0].hooks[0].args).toContain("observe");
      expect(settings.hooks.SessionStart[0].hooks[0].async).toBe(true);
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
        source: {
          transcriptFilesScanned?: number;
          sessionsSeen?: number;
          maxBytesPerTranscript?: number;
          scanBudgetMs?: number;
          scanDeadlineHit?: boolean;
          transcriptFilesDiscovered?: number;
          bytesPerTranscriptCap?: number;
          parallelism?: number;
        };
      };
      expect(baseline.source).toMatchObject({
        transcriptFilesScanned: 0,
        sessionsSeen: 0,
        maxBytesPerTranscript: 1048576,
        scanBudgetMs: 30000,
        scanDeadlineHit: false,
        transcriptFilesDiscovered: 0,
        bytesPerTranscriptCap: 1048576,
        parallelism: 8
      });
      expectNoPrivacySentinels(result.stdout, baselineText);
    } finally {
      await removeTempWorkspace(workspace);
    }
  });

  it("learn, why, improve, and unlearn print one deprecation pointer and exit 0", async () => {
    const learn = await runCli(["learn"]);
    const why = await runCli(["why"]);
    const improve = await runCli(["improve"]);
    const unlearn = await runCli(["unlearn"]);

    expect(learn.exitCode).toBe(0);
    expect(learn.stdout).toContain("deprecated");
    expect(why.exitCode).toBe(0);
    expect(why.stdout).toContain("folded into: bb-cc-lite audit");
    expect(improve.exitCode).toBe(0);
    expect(improve.stdout).toContain("folded into: bb-cc-lite audit");
    expect(unlearn.exitCode).toBe(0);
    expect(unlearn.stdout).toContain("folded into: bb-cc-lite uninstall --purge");
    for (const result of [learn, why, improve, unlearn]) {
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
    }
  });

  it("audit prints the three-section report without installing into Claude settings", async () => {
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
      expect(result.stdout).toContain("[1] Current session");
      expect(result.stdout).toContain("No bb history for this project.");
      expect(result.stdout).toContain("[2] Recent patterns");
      expect(result.stdout).toContain("same test failed 3x without a code change");
      expect(result.stdout).toContain("Report confidence: high");
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
      expect(result.stdout).toContain("same test failed 3x without a code change");
      expect(result.stdout).not.toContain(privateProjectName);
      await expect(pathExists(join(workspace.projectDir, ".claude", "settings.local.json"))).resolves.toBe(false);
      expectNoPrivacySentinels(result.stdout);
    } finally {
      await removeTempWorkspace(workspace);
    }
  });

  it("audit --json covers all three sections and parses without private text", async () => {
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

      const result = await runCli(["audit", "--json", "--project", workspace.projectDir, "--home", workspace.homeDir], {
        env: cliEnv(workspace)
      });
      const parsed = JSON.parse(result.stdout) as {
        kind: string;
        session: { hasHistory: boolean };
        patterns: { kind: string; findings: Array<{ reasonCode: string; evidence: string }> };
        instructions: { windowSessions: number };
      };

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(parsed.kind).toBe("audit");
      expect(parsed.session).toHaveProperty("hasHistory");
      expect(parsed.patterns.kind).toBe("deep-advisory");
      expect(parsed.patterns.findings).toContainEqual(
        expect.objectContaining({
          reasonCode: "blind_validation_retry",
          evidence: "same test failed 3x without a code change"
        })
      );
      expect(parsed.instructions).toHaveProperty("windowSessions");
      expect(result.stdout).not.toContain(transcriptPath);
      expectNoPrivacySentinels(result.stdout);
    } finally {
      await removeTempWorkspace(workspace);
    }
  });

  it("audit --apply and --json deprecate improve while reporting from the v2 store", async () => {
    const workspace = await createTempWorkspace();
    try {
      const sessionEnv = cliEnv(workspace);
      const transcriptDir = join(
        workspace.homeDir,
        ".claude",
        "projects",
        claudeProjectDirectoryName(workspace.projectDir)
      );
      // Record three retry sessions so the instruction window sees validation_retry >= 3.
      for (const session of ["apply-1", "apply-2", "apply-3"]) {
        const transcriptPath = join(transcriptDir, `${session}.jsonl`);
        await writeTranscript(transcriptPath, repeatedFailedTestTranscript(3));
        await runCli(["statusline"], {
          env: sessionEnv,
          input: statusInput({ session_id: session, cwd: workspace.projectDir, transcript_path: transcriptPath, terminal_width: 180 })
        });
      }
      await writeFile(join(workspace.projectDir, "CLAUDE.md"), "# Project\n\nKeep this user line.\n", "utf8");

      const result = await runCli(["audit", "--apply", "--project", workspace.projectDir, "--home", workspace.homeDir], {
        env: sessionEnv
      });
      const claudeText = await readFile(join(workspace.projectDir, "CLAUDE.md"), "utf8");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Proposed CLAUDE.md diff:");
      expect(result.stdout).toContain("Applied:");
      expect(claudeText).toContain("Keep this user line.");
      expect(claudeText).toContain("<!-- bb-cc-lite improve:start -->");
      expect(claudeText).toContain("- Inspect the first failure before rerunning a failed check.");
      expectNoPrivacySentinels(result.stdout, claudeText);
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

  it("uninstall --purge removes learned baselines, lesson memory, and the event store", async () => {
    const workspace = await createTempWorkspace();
    try {
      const env = cliEnv(workspace);
      await runCli(["install", "--project", workspace.projectDir, "--home", workspace.homeDir, "--no-learn"], { env });
      const baselinePath = join(workspace.appHome, "baseline.json");
      const projectKey = projectKeyFromPath(workspace.projectDir);
      const projectBaselineFile = projectBaselinePath({ appHomePath: workspace.appHome, projectKey });
      const lessonFile = lessonMemoryPath({ appHomePath: workspace.appHome, projectKey });
      const storeFile = join(workspace.appHome, "events.json");
      await writeFile(baselinePath, '{"schema":"bb-cc-lite.baseline.v1"}\n', "utf8");
      await writeJson(projectBaselineFile, { schema: "bb-cc-lite.baseline.v1" });
      await writeJson(lessonFile, { schema: "bb-cc-lite.lesson-memory.v1" });
      await writeJson(storeFile, { version: 2, updatedAt: "2026-06-10T00:00:00.000Z", decisions: [], hookEvents: [], feedbackOutcomes: [] });

      const result = await runCli(["uninstall", "--purge", "--project", workspace.projectDir, "--home", workspace.homeDir], {
        env
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Purged learned data");
      await expect(pathExists(baselinePath)).resolves.toBe(false);
      await expect(pathExists(projectBaselineFile)).resolves.toBe(false);
      await expect(pathExists(lessonFile)).resolves.toBe(false);
      await expect(pathExists(storeFile)).resolves.toBe(false);
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
      const baseline = JSON.parse(baselineText) as { source: { maxBytesPerTranscript?: number; scanBudgetMs?: number } };
      expect(baseline.source.maxBytesPerTranscript).toBe(1048576);
      expect(baseline.source.scanBudgetMs).toBe(30000);
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
        source: {
          transcriptFilesScanned?: number;
          sessionsSeen?: number;
          maxBytesPerTranscript?: number;
          scanBudgetMs?: number;
          scanDeadlineHit?: boolean;
          transcriptFilesDiscovered?: number;
          bytesPerTranscriptCap?: number;
          parallelism?: number;
        };
      };
      expect(baseline.source).toMatchObject({
        transcriptFilesScanned: 0,
        sessionsSeen: 0,
        maxBytesPerTranscript: 1048576,
        scanBudgetMs: 30000,
        scanDeadlineHit: false,
        transcriptFilesDiscovered: 0,
        bytesPerTranscriptCap: 1048576,
        parallelism: 8
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
          cwd: workspace.projectDir,
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
      expect(statusline.stdout.trim()).toContain("●");
      expect(statusline.stdout).toContain("ctx 42%");

      const audit = await runCli(["audit", "--project", workspace.projectDir, "--home", workspace.homeDir, "--json"], { env });
      expect(audit.exitCode).toBe(0);
      const parsed = JSON.parse(audit.stdout) as { session: { hasHistory: boolean; light: string } };
      expect(parsed.session).toMatchObject({
        hasHistory: true,
        light: "green"
      });

      const storeText = await readFile(env.BB_CC_LITE_STORE as string, "utf8");
      expectNoPrivacySentinels(statusline.stdout, audit.stdout, storeText);
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
      expect(statusline.stdout).toContain("●");
      expect(statusline.stdout).toContain("exploring");
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
            sessionsSeen: 10,
            transcriptFilesScanned: 10
          },
          budget: {
            costSamples: 10,
            durationSamples: 10,
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
      expect(statusline.stdout).toContain("●");
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
      expect(statusline.stdout).toContain("●");
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

      const costProject = workspace.projectDir;
      const durationProject = join(workspace.root, "proj-duration");

      const costStatusline = await runCli(["statusline"], {
        env,
        input: statusInput({
          session_id: "session-budget-env-cost",
          cwd: costProject,
          cost: {
            total_cost_usd: 0.11
          },
          terminal_width: 180
        })
      });
      const costAudit = await runCli(["audit", "--project", costProject, "--home", workspace.homeDir, "--json"], { env });
      const durationTranscriptPath = join(workspace.root, "transcripts", "duration-active.jsonl");
      await writeTranscript(durationTranscriptPath, readHeavyTranscript());

      const durationStatusline = await runCli(["statusline"], {
        env,
        input: statusInput({
          session_id: "session-budget-env-duration",
          cwd: durationProject,
          transcript_path: durationTranscriptPath,
          duration_ms: 11000,
          terminal_width: 180
        })
      });
      const durationAudit = await runCli(["audit", "--project", durationProject, "--home", workspace.homeDir, "--json"], { env });

      expect(costStatusline.exitCode).toBe(0);
      expect(durationStatusline.exitCode).toBe(0);
      expect(costStatusline.stdout).toContain("●");
      expect(durationStatusline.stdout).toContain("●");
      // Budget is a fact, never a finding under the gauge (grill F2): high cost/duration alone keeps
      // the light green. The combined budget+failure red detector is the only place budget matters.
      expect(JSON.parse(costAudit.stdout).session).toMatchObject({ light: "green" });
      expect(JSON.parse(durationAudit.stdout).session).toMatchObject({ light: "green" });
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
      expect(statusline.stdout).toContain("exploring");
      expect(elapsedMs).toBeLessThan(1000);

      const refreshed = await waitForBaselineUpdated(join(workspace.appHome, "baseline.json"), staleBaseline.updatedAt);
      expect(refreshed.source).toMatchObject({
        transcriptFilesScanned: 1,
        sessionsSeen: 1,
        maxBytesPerTranscript: 1048576,
        scanBudgetMs: 30000,
        scanDeadlineHit: false,
        transcriptFilesDiscovered: 1,
        bytesPerTranscriptCap: 1048576,
        parallelism: 8
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
      expect(corrupt.stdout).toContain("◐");
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
      expect(sparse.stdout).toContain("◐");
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
          cwd: workspace.projectDir,
          transcript_path: transcriptPath,
          terminal_width: 180
        })
      });

      expect(statusline.exitCode).toBe(0);
      expect(statusline.stderr).toBe("");
      expect(statusline.stdout).toContain("◐");
      expect(statusline.stdout).toContain("tests failed twice");

      const audit = await runCli(["audit", "--project", workspace.projectDir, "--home", workspace.homeDir, "--json"], { env });
      const parsed = JSON.parse(audit.stdout) as { session: { light: string } };
      expect(parsed.session).toMatchObject({ light: "blue" });
      expectNoPrivacySentinels(statusline.stdout, audit.stdout, await readFile(env.BB_CC_LITE_STORE as string, "utf8"));
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
          cwd: workspace.projectDir,
          transcript_path: transcriptPath,
          terminal_width: 180
        })
      });

      expect(statusline.exitCode).toBe(0);
      expect(statusline.stderr).toBe("");
      expect(statusline.stdout).toContain("● editing");
      expect(statusline.stdout).toContain("1 unchecked");
      expect(statusline.stdout).not.toContain("focused check");
      expect(statusline.stdout).not.toContain("validation lag");

      const audit = await runCli(["audit", "--project", workspace.projectDir, "--home", workspace.homeDir, "--json"], { env });
      const parsed = JSON.parse(audit.stdout) as { session: { hasHistory: boolean; light: string } };
      expect(parsed.session).toMatchObject({ hasHistory: true, light: "green" });
      expectNoPrivacySentinels(statusline.stdout, audit.stdout, await readFile(env.BB_CC_LITE_STORE as string, "utf8"));
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
          cwd: workspace.projectDir,
          terminal_width: 180
        })
      });
      const audit = await runCli(["audit", "--project", workspace.projectDir, "--home", workspace.homeDir], { env });
      const auditJson = await runCli(["audit", "--project", workspace.projectDir, "--home", workspace.homeDir, "--json"], { env });
      const parsed = JSON.parse(auditJson.stdout) as {
        session: { feedbackOutcomes?: Array<{ outcome?: string; reasonCode?: string }> };
      };

      expect(editHook.exitCode).toBe(0);
      expect(editHook.stdout).toContain("edits have not been validated yet");
      expect(validationHook.exitCode).toBe(0);
      expect(statusline.exitCode).toBe(0);
      expect(statusline.stdout).toContain("●");
      expect(statusline.stdout).toContain("testing");
      expect(audit.stdout).toContain("Recent bb loop:");
      expect(audit.stdout).toContain("Coach feedback: edits needed validation.");
      expect(audit.stdout).toContain("Claude ran tests.");
      expect(audit.stdout).toContain("Tests passed.");
      expect(audit.stdout).toContain("Outcome: resolved.");
      expect(parsed.session.feedbackOutcomes).toEqual([
        expect.objectContaining({
          reasonCode: "edit_without_validation",
          outcome: "resolved"
        })
      ]);
      expect(auditJson.stdout).not.toContain("\u001b[");
      expectNoPrivacySentinels(editHook.stdout, validationHook.stdout, statusline.stdout, audit.stdout, auditJson.stdout, await readFile(env.BB_CC_LITE_STORE as string, "utf8"));
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
          cwd: workspace.projectDir,
          transcript_path: transcriptPath,
          terminal_width: 180
        })
      });

      expect(statusline.exitCode).toBe(0);
      expect(statusline.stderr).toBe("");
      expect(statusline.stdout).toContain("◐ editing");
      expect(statusline.stdout).toContain("1 unchecked");
      expect(statusline.stdout).not.toContain("focused check");
      expect(statusline.stdout).not.toContain("validation lag");

      const audit = await runCli(["audit", "--project", workspace.projectDir, "--home", workspace.homeDir, "--json"], { env });
      const parsed = JSON.parse(audit.stdout) as { session: { light: string; findings: Array<{ category: string }> } };
      expect(parsed.session.light).toBe("blue");
      expect(parsed.session.findings.map((finding) => finding.category)).toContain("edit_drift");
      expectNoPrivacySentinels(statusline.stdout, audit.stdout, await readFile(env.BB_CC_LITE_STORE as string, "utf8"));
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
      expect(rendered).toContain("●");
      expect(rendered).toContain("82%");
      expectNoPrivacySentinels(rendered, await readFile(cliEnv(workspace).BB_CC_LITE_STORE as string, "utf8"));
    } finally {
      await removeTempWorkspace(workspace);
    }
  });

  it("renders Stop on the line and keeps each project's audit session isolated", async () => {
    const workspace = await createTempWorkspace();
    try {
      const env = cliEnv(workspace);
      const stopProject = workspace.projectDir;
      const latestProject = join(workspace.root, "proj-latest");
      const transcriptPath = join(workspace.root, "transcripts", "stop.jsonl");
      await writeTranscript(transcriptPath, repeatedFailedTestTranscript(3));

      const stop = await runCli(["statusline"], {
        env,
        input: statusInput({
          session_id: "session-stop",
          cwd: stopProject,
          transcript_path: transcriptPath,
          terminal_width: 180
        })
      });

      expect(stop.exitCode).toBe(0);
      expect(stop.stdout).toContain("■");
      expect(stop.stdout).toContain("3 fails, no fix between runs");

      const latest = await runCli(["statusline"], {
        env,
        input: statusInput({
          session_id: "session-latest",
          cwd: latestProject,
          context_window: {
            used_tokens: 20_000,
            total: 200_000
          },
          terminal_width: 180
        })
      });
      expect(latest.exitCode).toBe(0);
      expect(latest.stdout).toContain("●");

      const auditLatest = await runCli(["audit", "--project", latestProject, "--home", workspace.homeDir, "--json"], { env });
      expect(JSON.parse(auditLatest.stdout).session).toMatchObject({ light: "green" });

      const auditStop = await runCli(["audit", "--project", stopProject, "--home", workspace.homeDir, "--json"], { env });
      const stopSession = JSON.parse(auditStop.stdout).session as { light: string; findings: Array<{ category: string; evidence: string }> };
      expect(stopSession.light).toBe("red");
      expect(stopSession.findings[0]).toMatchObject({ category: "blind_retry_loop", evidence: "3 fails, no fix between runs" });

      const storeText = await readFile(env.BB_CC_LITE_STORE as string, "utf8");
      expectNoPrivacySentinels(stop.stdout, latest.stdout, auditLatest.stdout, auditStop.stdout, storeText);
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
          cwd: workspace.projectDir,
          transcript_path: transcriptPath,
          terminal_width: 220
        })
      });

      expect(statusline.exitCode).toBe(0);
      expect(statusline.stderr).toBe("");
      expect(statusline.stdout).toContain("■");
      expect(statusline.stdout).toContain("3 fails, no fix between runs");

      const audit = await runCli(["audit", "--project", workspace.projectDir, "--home", workspace.homeDir], { env });
      const auditJson = await runCli(["audit", "--project", workspace.projectDir, "--home", workspace.homeDir, "--json"], { env });
      expect(auditJson.exitCode).toBe(0);
      expect(JSON.parse(auditJson.stdout).session).toMatchObject({ light: "red" });
      expect(JSON.parse(auditJson.stdout).session.findings[0]).toMatchObject({ category: "blind_retry_loop" });

      const storeText = await readFile(env.BB_CC_LITE_STORE as string, "utf8");
      for (const output of [statusline.stdout, audit.stdout, auditJson.stdout, storeText]) {
        expect(output).not.toContain(rawMcpName);
        expect(output).not.toContain("mcp__");
      }
      expectNoPrivacySentinels(statusline.stdout, audit.stdout, auditJson.stdout, storeText);
    } finally {
      await removeTempWorkspace(workspace);
    }
  });

  it("renders tool-result token jumps through statusline, why, why --json, and store without raw data", async () => {
    const workspace = await createTempWorkspace();
    try {
      const env = cliEnv(workspace);
      const rawSessionId = `session-${privacySentinels[6]}`;
      const transcriptPath = join(workspace.root, "transcripts", "tool-result-explosion.jsonl");
      await writeTranscript(transcriptPath, toolResultExplosionTranscript(rawSessionId));

      const wide = await runCli(["statusline"], {
        env,
        input: statusInput({
          session_id: rawSessionId,
          cwd: workspace.projectDir,
          transcript_path: transcriptPath,
          terminal_width: 180
        })
      });
      const narrow = await runCli(["statusline"], {
        env,
        input: statusInput({
          session_id: rawSessionId,
          cwd: workspace.projectDir,
          transcript_path: transcriptPath,
          terminal_width: 52
        })
      });

      expect(wide.exitCode).toBe(0);
      expect(wide.stderr).toBe("");
      expect(wide.stdout).toContain("●");
      expect(wide.stdout).not.toContain("■");
      expect(narrow.exitCode).toBe(0);
      expect(visibleLength(narrow.stdout.trim())).toBeLessThanOrEqual(52);
      expect(narrow.stdout).toContain("●");

      const audit = await runCli(["audit", "--project", workspace.projectDir, "--home", workspace.homeDir], { env });
      const auditJson = await runCli(["audit", "--project", workspace.projectDir, "--home", workspace.homeDir, "--json"], { env });
      expect(auditJson.exitCode).toBe(0);
      // Tool-result token jumps are not a gauge detector (grill F2): the session stays green.
      expect(JSON.parse(auditJson.stdout).session).toMatchObject({ light: "green" });

      const storeText = await readFile(env.BB_CC_LITE_STORE as string, "utf8");
      expectNoPrivacySentinels(wide.stdout, narrow.stdout, audit.stdout, auditJson.stdout, storeText);
      for (const rawPath of [workspace.root, workspace.projectDir, workspace.homeDir, workspace.appHome, transcriptPath]) {
        expect([wide.stdout, narrow.stdout, audit.stdout, auditJson.stdout, storeText].join("\n")).not.toContain(rawPath);
      }
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
      await writeTranscript(transcriptPath, privacySurfaceTranscript(rawSessionId));
      await writeHistoricalPrivacyTranscripts(workspace.homeDir);

      const statusline = await runCli(["statusline"], {
        env,
        input: statusInput({
          session_id: rawSessionId,
          cwd: workspace.projectDir,
          transcript_path: transcriptPath,
          terminal_width: 240
        })
      });

      expect(statusline.exitCode).toBe(0);
      expect(statusline.stderr).toBe("");
      expect(statusline.stdout).toContain("■");

      const why = await runCli(["audit", "--project", workspace.projectDir, "--home", workspace.homeDir, "--transcript", transcriptPath], { env });
      const auditJson = await runCli(["audit", "--project", workspace.projectDir, "--home", workspace.homeDir, "--transcript", transcriptPath, "--json"], { env });
      expect(why.exitCode).toBe(0);
      expect(auditJson.exitCode).toBe(0);
      expect(JSON.parse(auditJson.stdout).session).toMatchObject({ light: "red" });

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
        auditJson.stdout,
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
        expected: ["●", "idle", "no activity yet"]
      },
      {
        name: "empty readable transcript",
        input: {
          session_id: "fixture-empty",
          terminal_width: 180
        },
        transcript: [],
        expected: ["●", "idle", "no activity yet"]
      },
      {
        name: "two repeated failed test commands",
        input: {
          session_id: "fixture-two-failures",
          terminal_width: 180
        },
        transcript: repeatedFailedTestTranscript(2),
        expected: ["◐", "retrying tests", "2 fails, no fix between runs"]
      },
      {
        name: "three repeated failed test commands",
        input: {
          session_id: "fixture-three-failures",
          terminal_width: 180
        },
        transcript: repeatedFailedTestTranscript(3),
        expected: ["■", "retrying tests", "3 fails, no fix between runs"]
      },
      {
        name: "mismatched transcript session",
        input: {
          session_id: "fixture-current-session",
          terminal_width: 180
        },
        transcript: withTranscriptSessionId(
          repeatedFailedTestTranscript(3),
          `fixture-other-session-${privacySentinels[6]}`
        ),
        expected: ["○", "no signal", "transcript session mismatch"]
      },
      {
        name: "three redundant full-file reads",
        input: {
          session_id: "fixture-redundant-reads",
          terminal_width: 180
        },
        transcript: redundantReadTranscript(3),
        expected: ["■", "reread secret.ts 3x"]
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
        expected: ["●", "ctx 82%"]
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
        expected: ["●"]
      },
      {
        name: "cache efficiency regression",
        input: {
          session_id: privacySentinels[6],
          terminal_width: 180
        },
        transcript: cacheEfficiencyRegressionTranscript(),
        expected: ["◐", "cache reuse dropped from 68% to 29%"]
      },
      {
        name: "compaction event",
        input: {
          session_id: "fixture-compaction",
          terminal_width: 180
        },
        transcript: compactionTranscript(),
        expected: ["◐", "compaction boundary open"]
      },
      {
        name: "malformed transcript",
        input: {
          session_id: "fixture-malformed",
          terminal_width: 180
        },
        transcript: ["not-json", "{\"type\":\"assistant\""],
        expected: ["○", "no signal", "transcript unreadable"]
      },
      {
        name: "missing transcript",
        input: {
          session_id: "fixture-missing",
          transcript_path: "/tmp/bb-cc-lite/missing/transcript.jsonl",
          terminal_width: 180
        },
        expected: ["○", "no signal", "transcript unavailable"]
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

function withTranscriptSessionId(lines: string[], sessionId: string): string[] {
  return lines.map((line) => {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    parsed.sessionId = sessionId;
    return JSON.stringify(parsed);
  });
}

function redundantReadTranscript(count: number): string[] {
  return Array.from({ length: count }, (_value, index) => index + 1).flatMap((index) => [
    JSON.stringify({
      timestamp: `2026-05-19T00:02:0${index}.000Z`,
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: `read-${index}`,
            name: "Read",
            input: {
              file_path: privacySentinels[4]
            }
          }
        ]
      }
    }),
    JSON.stringify({
      timestamp: `2026-05-19T00:02:1${index}.000Z`,
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: `read-${index}`,
            is_error: false,
            content: privacySentinels[3]
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
                file_path: `${privacySentinels[4]}.${index}`
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

function privacySurfaceTranscript(sessionId: string): string[] {
  return [
    JSON.stringify({
      session_id: sessionId,
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

function cacheEfficiencyRegressionTranscript(): string[] {
  return [
    JSON.stringify({
      timestamp: "2026-05-19T00:00:01.000Z",
      type: "assistant",
      session_id: privacySentinels[6],
      cwd: privacySentinels[4],
      message: {
        role: "assistant",
        usage: {
          input_tokens: 220,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 680
        },
        content: [{ type: "text", text: privacySentinels[0] }]
      }
    }),
    JSON.stringify({
      timestamp: "2026-05-19T00:00:02.000Z",
      type: "assistant",
      session_id: privacySentinels[6],
      cwd: privacySentinels[4],
      message: {
        role: "assistant",
        usage: {
          input_tokens: 610,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 290
        },
        content: [{ type: "text", text: privacySentinels[0] }]
      }
    })
  ];
}

function toolResultExplosionTranscript(sessionId: string): string[] {
  return [
    JSON.stringify({
      timestamp: "2026-05-19T00:11:00.000Z",
      type: "assistant",
      session_id: sessionId,
      cwd: privacySentinels[4],
      message: {
        role: "assistant",
        usage: {
          input_tokens: 1_000
        },
        content: [{ type: "text", text: privacySentinels[0] }]
      }
    }),
    JSON.stringify({
      timestamp: "2026-05-19T00:11:01.000Z",
      type: "user",
      cwd: privacySentinels[4],
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "private-result",
            is_error: false,
            content: `${privacySentinels[1]} ${privacySentinels[3]} ${privacySentinels[4]}`
          }
        ]
      }
    }),
    JSON.stringify({
      timestamp: "2026-05-19T00:11:02.000Z",
      type: "assistant",
      session_id: sessionId,
      message: {
        role: "assistant",
        usage: {
          input_tokens: 13_400
        },
        content: [{ type: "text", text: "derived assistant text not retained" }]
      }
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
              file_path: `${privacySentinels[4]}.${index}`,
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
): Promise<{
  updatedAt: string;
  source: {
    transcriptFilesScanned: number;
    sessionsSeen: number;
    maxFiles?: number;
    maxBytesPerTranscript?: number;
    scanBudgetMs?: number;
    scanDeadlineHit?: boolean;
    transcriptFilesDiscovered?: number;
    bytesPerTranscriptCap?: number;
    parallelism?: number;
  };
}> {
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
          scanBudgetMs?: unknown;
          scanDeadlineHit?: unknown;
          transcriptFilesDiscovered?: unknown;
          bytesPerTranscriptCap?: unknown;
          parallelism?: unknown;
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
              typeof parsed.source.maxBytesPerTranscript === "number" ? parsed.source.maxBytesPerTranscript : undefined,
            scanBudgetMs: typeof parsed.source.scanBudgetMs === "number" ? parsed.source.scanBudgetMs : undefined,
            scanDeadlineHit: typeof parsed.source.scanDeadlineHit === "boolean" ? parsed.source.scanDeadlineHit : undefined,
            transcriptFilesDiscovered:
              typeof parsed.source.transcriptFilesDiscovered === "number" ? parsed.source.transcriptFilesDiscovered : undefined,
            bytesPerTranscriptCap:
              typeof parsed.source.bytesPerTranscriptCap === "number" ? parsed.source.bytesPerTranscriptCap : undefined,
            parallelism: typeof parsed.source.parallelism === "number" ? parsed.source.parallelism : undefined
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
