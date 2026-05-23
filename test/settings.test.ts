import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SAFE_HOOK_EVENTS } from "../src/hooks.js";
import { quoteShell } from "../src/paths.js";
import { installStatusLine, resolveSettingsTarget, uninstallStatusLine } from "../src/settings.js";
import {
  createTempWorkspace,
  pathExists,
  readJson,
  removeTempWorkspace,
  setIsolatedEnv,
  type TempWorkspace,
  writeJson
} from "./helpers/temp.js";

describe("settings install and uninstall", () => {
  let workspace: TempWorkspace | undefined;
  let restoreEnv: (() => void) | undefined;

  beforeEach(async () => {
    workspace = await createTempWorkspace();
    restoreEnv = setIsolatedEnv({
      BB_CC_LITE_HOME: workspace.appHome
    });
  });

  afterEach(async () => {
    restoreEnv?.();
    await removeTempWorkspace(workspace);
  });

  it("installs a local statusLine and runtime launcher in temp directories", async () => {
    const dirs = mustHaveWorkspace(workspace);
    const cliFilePath = await createFakeRuntime(dirs.root);
    const version = await packageVersion();

    const result = await installStatusLine({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir,
      cliFilePath
    });

    const target = resolveSettingsTarget({ projectDir: dirs.projectDir, homeDir: dirs.homeDir });
    const launcherPath = join(dirs.appHome, "bin", "statusline");
    const stableCliPath = join(dirs.appHome, "versions", version, "dist", "cli.js");
    const settings = await readJson<{ statusLine: { type: string; command: string; padding: number } }>(target.settingsPath);
    const launcher = await readFile(launcherPath, "utf8");
    const copiedRuntime = await readFile(stableCliPath, "utf8");

    expect(result.status).toBe("installed");
    expect(result.target).toEqual(target);
    expect(result.command).toBe(quoteShell(launcherPath));
    const manifestText = await readFile(join(dirs.appHome, "backups", result.backupId as string, "manifest.json"), "utf8");
    expect(manifestText).toContain(`"packageVersion": "${version}"`);
    expect(manifestText).toContain("settingsPathHash");
    expect(manifestText).toContain("projectDirHash");
    expect(manifestText).not.toContain(dirs.projectDir);
    expect(manifestText).not.toContain(target.settingsPath);
    expect(settings.statusLine).toEqual({
      type: "command",
      command: quoteShell(launcherPath),
      padding: 0
    });
    expect(launcher).toBe(
      `#!/bin/sh\nexport BB_CC_LITE_HOME=${quoteShell(dirs.appHome)}\nexec ${quoteShell(process.execPath)} ${quoteShell(stableCliPath)} statusline "$@"\n`
    );
    expect(launcher).not.toContain(cliFilePath);
    expect(copiedRuntime).toContain("fake bb-cc-lite runtime");
  });

  it("installs optional safe hooks without enabling prompt-capture hooks", async () => {
    const dirs = mustHaveWorkspace(workspace);
    const cliFilePath = await createFakeRuntime(dirs.root);
    const version = await packageVersion();

    const result = await installStatusLine({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir,
      cliFilePath,
      hooks: true,
      mode: "observe"
    });

    const target = resolveSettingsTarget({ projectDir: dirs.projectDir, homeDir: dirs.homeDir });
    const hookLauncherPath = join(dirs.appHome, "bin", "hook");
    const stableCliPath = join(dirs.appHome, "versions", version, "dist", "cli.js");
    const settings = await readJson<{
      hooks: Record<string, Array<{ matcher: string; hooks: Array<{ command: string; args: string[]; async: boolean; timeout: number }> }>>;
    }>(target.settingsPath);
    const hookLauncher = await readFile(hookLauncherPath, "utf8");

    expect(result.status).toBe("installed");
    expect(Object.keys(settings.hooks).sort()).toEqual([...SAFE_HOOK_EVENTS].sort());
    expect(settings.hooks.UserPromptSubmit).toBeUndefined();
    for (const eventName of SAFE_HOOK_EVENTS) {
      expect(settings.hooks[eventName]).toEqual([
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: hookLauncherPath,
              args: ["--bb-cc-lite-hook", eventName, "--bb-cc-lite-mode", "observe", "--bb-cc-lite-learn", "1"],
              async: true,
              timeout: 1
            }
          ]
        }
      ]);
    }
    expect(hookLauncher).toBe(
      `#!/bin/sh\nexport BB_CC_LITE_HOME=${quoteShell(dirs.appHome)}\nexec ${quoteShell(process.execPath)} ${quoteShell(stableCliPath)} hook "$@"\n`
    );
  });

  it("installs default coach hooks without prompt-boundary hooks", async () => {
    const dirs = mustHaveWorkspace(workspace);
    const cliFilePath = await createFakeRuntime(dirs.root);

    await installStatusLine({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir,
      cliFilePath,
      hooks: true,
      mode: "coach"
    });

    const target = resolveSettingsTarget({ projectDir: dirs.projectDir, homeDir: dirs.homeDir });
    const settings = await readJson<{
      hooks: Record<string, Array<{ matcher: string; hooks: Array<{ args: string[]; async?: boolean }> }>>;
    }>(target.settingsPath);

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
    expect(settings.hooks.UserPromptSubmit).toBeUndefined();
    expect(settings.hooks.PreToolUse[0].matcher).toBe("Bash");
    expect(settings.hooks.SessionStart[0].hooks[0].args).toContain("--bb-cc-lite-mode");
    expect(settings.hooks.SessionStart[0].hooks[0].args).toContain("coach");
    expect(settings.hooks.PostToolUseFailure[0].hooks[0].async).toBeUndefined();
  });

  it("installs observe-only telemetry without Claude-facing feedback hooks", async () => {
    const dirs = mustHaveWorkspace(workspace);

    await installStatusLine({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir,
      cliFilePath: await createFakeRuntime(dirs.root),
      hooks: true,
      mode: "observe"
    });

    const target = resolveSettingsTarget({ projectDir: dirs.projectDir, homeDir: dirs.homeDir });
    const settings = await readJson<{
      hooks: Record<string, Array<{ hooks: Array<{ args: string[]; async?: boolean }> }>>;
    }>(target.settingsPath);

    expect(Object.keys(settings.hooks).sort()).toEqual([...SAFE_HOOK_EVENTS].sort());
    expect(settings.hooks.SessionStart).toBeUndefined();
    expect(settings.hooks.PreToolUse).toBeUndefined();
    expect(settings.hooks.PostToolUseFailure[0].hooks[0].args).toContain("observe");
    expect(settings.hooks.PostToolUseFailure[0].hooks[0].async).toBe(true);
  });

  it("installs guard hooks only when guard mode is requested", async () => {
    const dirs = mustHaveWorkspace(workspace);

    await installStatusLine({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir,
      cliFilePath: await createFakeRuntime(dirs.root),
      hooks: true,
      mode: "guard"
    });

    const target = resolveSettingsTarget({ projectDir: dirs.projectDir, homeDir: dirs.homeDir });
    const settings = await readJson<{
      hooks: Record<string, Array<{ hooks: Array<{ args: string[] }> }>>;
    }>(target.settingsPath);

    expect(settings.hooks.PreToolUse[0].hooks[0].args).toContain("guard");
    expect(settings.hooks.Stop[0].hooks[0].args).toContain("guard");
  });

  it("writes no-learn runtime launchers that disable baseline and lesson learning", async () => {
    const dirs = mustHaveWorkspace(workspace);

    await installStatusLine({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir,
      cliFilePath: await createFakeRuntime(dirs.root),
      hooks: true,
      mode: "coach",
      learn: false
    });

    const statuslineLauncher = await readFile(join(dirs.appHome, "bin", "statusline"), "utf8");
    const hookLauncher = await readFile(join(dirs.appHome, "bin", "hook"), "utf8");
    const target = resolveSettingsTarget({ projectDir: dirs.projectDir, homeDir: dirs.homeDir });
    const settings = await readJson<{
      hooks: Record<string, Array<{ hooks: Array<{ args: string[] }> }>>;
    }>(target.settingsPath);

    expect(statuslineLauncher).toContain("export BB_CC_LITE_AUTO_LEARN=0");
    expect(hookLauncher).toContain("export BB_CC_LITE_LESSON_MEMORY=0");
    expect(settings.hooks.SessionStart[0].hooks[0].args).toContain("--bb-cc-lite-learn");
    expect(settings.hooks.SessionStart[0].hooks[0].args).toContain("0");
  });

  it("preserves a custom statusLine by default and asks for --replace", async () => {
    const dirs = mustHaveWorkspace(workspace);
    const target = resolveSettingsTarget({ projectDir: dirs.projectDir, homeDir: dirs.homeDir });
    const existing = {
      cleanupPeriodDays: 7,
      statusLine: {
        type: "command",
        command: "custom-bb-cc-lite-wrapper"
      }
    };
    await writeJson(target.settingsPath, existing);

    const refused = await installStatusLine({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir,
      cliFilePath: await createFakeRuntime(dirs.root)
    });

    expect(refused.status).toBe("refused");
    expect(refused.backupId).toBeUndefined();
    expect(refused.message).toContain("pass --replace");
    await expect(readJson(target.settingsPath)).resolves.toEqual(existing);
    await expect(pathExists(join(dirs.appHome, "bin", "statusline"))).resolves.toBe(false);
  });

  it("replaces a custom statusLine with --replace and backs it up", async () => {
    const dirs = mustHaveWorkspace(workspace);
    const target = resolveSettingsTarget({ projectDir: dirs.projectDir, homeDir: dirs.homeDir });
    const existing = {
      cleanupPeriodDays: 7,
      statusLine: {
        type: "command",
        command: "custom-bb-cc-lite-wrapper"
      }
    };
    await writeJson(target.settingsPath, existing);

    const replaced = await installStatusLine({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir,
      replace: true,
      cliFilePath: await createFakeRuntime(dirs.root)
    });
    const settings = await readJson<{ cleanupPeriodDays: number; statusLine: { command: string } }>(target.settingsPath);
    const manifest = await readJson<{
      before: { hadStatusLine: boolean; statusLine: { command: string } };
    }>(join(dirs.appHome, "backups", replaced.backupId as string, "manifest.json"));

    expect(replaced.status).toBe("updated");
    expect(replaced.backupId).toEqual(expect.any(String));
    expect(replaced.message).toContain("Previous settings were backed up.");
    expect(manifest.before).toMatchObject({
      hadStatusLine: true,
      statusLine: {
        command: "custom-bb-cc-lite-wrapper"
      }
    });
    expect(settings.cleanupPeriodDays).toBe(7);
    expect(settings.statusLine.command).toBe(quoteShell(join(dirs.appHome, "bin", "statusline")));
  });

  it("replaces a shadowing custom statusLine and writes runtime launchers", async () => {
    const dirs = mustHaveWorkspace(workspace);
    const target = resolveSettingsTarget({ projectDir: dirs.projectDir, homeDir: dirs.homeDir });
    await writeJson(target.settingsPath, {
      statusLine: {
        type: "command",
        command: "custom-bb-cc-lite-wrapper"
      }
    });

    const result = await installStatusLine({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir,
      replace: true,
      cliFilePath: await createFakeRuntime(dirs.root)
    });

    expect(result.status).toBe("updated");
    await expect(pathExists(join(dirs.appHome, "bin", "statusline"))).resolves.toBe(true);
    await expect(pathExists(join(dirs.appHome, "bin", "hook"))).resolves.toBe(true);
  });

  it("reinstall with hooks repairs partial bb hook settings", async () => {
    const dirs = mustHaveWorkspace(workspace);
    const target = resolveSettingsTarget({ projectDir: dirs.projectDir, homeDir: dirs.homeDir });
    const cliFilePath = await createFakeRuntime(dirs.root);
    await installStatusLine({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir,
      cliFilePath,
      hooks: true,
      mode: "observe"
    });
    const partial = await readJson<{
      hooks: Record<string, unknown>;
    }>(target.settingsPath);
    partial.hooks = {
      PostToolUseFailure: partial.hooks.PostToolUseFailure
    };
    await writeJson(target.settingsPath, partial);

    const result = await installStatusLine({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir,
      cliFilePath,
      hooks: true,
      mode: "observe"
    });
    const repaired = await readJson<{
      hooks: Record<string, unknown>;
    }>(target.settingsPath);

    expect(result.status).toBe("updated");
    expect(Object.keys(repaired.hooks).sort()).toEqual([...SAFE_HOOK_EVENTS].sort());
  });

  it("uninstall restores prior settings from the install backup when untouched", async () => {
    const dirs = mustHaveWorkspace(workspace);
    const target = resolveSettingsTarget({ projectDir: dirs.projectDir, homeDir: dirs.homeDir });
    const beforeRaw = `${JSON.stringify(
      {
        includeCoAuthoredBy: false,
        statusLine: {
          type: "command",
          command: "custom-statusline"
        }
      },
      null,
      2
    )}\n`;
    await writeJson(target.settingsPath, JSON.parse(beforeRaw));

    const installed = await installStatusLine({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir,
      replace: true,
      cliFilePath: await createFakeRuntime(dirs.root)
    });
    const uninstalled = await uninstallStatusLine({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir
    });

    expect(installed.status).toBe("updated");
    expect(uninstalled.status).toBe("restored");
    await expect(readFile(target.settingsPath, "utf8")).resolves.toBe(beforeRaw);
  });

  it("uninstall removes the settings file when install created it", async () => {
    const dirs = mustHaveWorkspace(workspace);
    const target = resolveSettingsTarget({ projectDir: dirs.projectDir, homeDir: dirs.homeDir });

    await installStatusLine({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir,
      cliFilePath: await createFakeRuntime(dirs.root)
    });

    const result = await uninstallStatusLine({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir
    });

    expect(result.status).toBe("removed");
    await expect(pathExists(target.settingsPath)).resolves.toBe(false);
  });

  it("uninstall fully removes a statusLine after hooks are enabled later", async () => {
    const dirs = mustHaveWorkspace(workspace);
    const target = resolveSettingsTarget({ projectDir: dirs.projectDir, homeDir: dirs.homeDir });
    const cliFilePath = await createFakeRuntime(dirs.root);

    await installStatusLine({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir,
      cliFilePath
    });
    const hookInstall = await installStatusLine({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir,
      cliFilePath,
      hooks: true
    });

    expect(hookInstall.status).toBe("updated");
    expect((await readJson<{ hooks?: unknown }>(target.settingsPath)).hooks).toBeDefined();

    const result = await uninstallStatusLine({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir
    });

    expect(result.status).toBe("removed");
    await expect(pathExists(target.settingsPath)).resolves.toBe(false);
  });

  it("semantic uninstall removes bb hooks while preserving unrelated current settings", async () => {
    const dirs = mustHaveWorkspace(workspace);
    const target = resolveSettingsTarget({ projectDir: dirs.projectDir, homeDir: dirs.homeDir });
    const customHooks = {
      PostToolUse: [
        {
          matcher: "Edit",
          hooks: [
            {
              type: "command",
              command: "custom-bb-cc-lite-wrapper-hook"
            }
          ]
        }
      ]
    };
    await writeJson(target.settingsPath, {
      statusLine: {
        type: "command",
        command: "custom-statusline"
      },
      hooks: customHooks
    });

    await installStatusLine({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir,
      cliFilePath: await createFakeRuntime(dirs.root),
      replace: true,
      hooks: true
    });
    const installed = await readJson<Record<string, unknown>>(target.settingsPath);
    installed.theme = "dark";
    await writeJson(target.settingsPath, installed);

    const result = await uninstallStatusLine({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir
    });
    const restored = await readJson<{
      statusLine: { command: string };
      hooks: typeof customHooks;
      theme: string;
    }>(target.settingsPath);

    expect(result.status).toBe("restored");
    expect(restored.statusLine.command).toBe("custom-statusline");
    expect(restored.hooks).toEqual(customHooks);
    expect(restored.theme).toBe("dark");
  });

  it("uninstall preserves unrelated hooks added after bb hook install", async () => {
    const dirs = mustHaveWorkspace(workspace);
    const target = resolveSettingsTarget({ projectDir: dirs.projectDir, homeDir: dirs.homeDir });
    await installStatusLine({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir,
      cliFilePath: await createFakeRuntime(dirs.root),
      hooks: true
    });
    const installed = await readJson<{
      hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>>;
    }>(target.settingsPath);
    installed.hooks.PostToolUse.push({
      matcher: "Edit",
      hooks: [
        {
          type: "command",
          command: "custom-bb-cc-lite-wrapper-hook"
        }
      ]
    });
    await writeJson(target.settingsPath, installed);

    const result = await uninstallStatusLine({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir
    });
    const remaining = await readJson<{
      hooks: Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>>;
    }>(target.settingsPath);

    expect(result.status).toBe("removed");
    expect(remaining).toEqual({
      hooks: {
        PostToolUse: [
          {
            matcher: "Edit",
            hooks: [
              {
                type: "command",
                command: "custom-bb-cc-lite-wrapper-hook"
              }
            ]
          }
        ]
      }
    });
  });

  it("uninstall removes guard hooks without deleting unrelated hooks", async () => {
    const dirs = mustHaveWorkspace(workspace);
    const target = resolveSettingsTarget({ projectDir: dirs.projectDir, homeDir: dirs.homeDir });
    await installStatusLine({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir,
      cliFilePath: await createFakeRuntime(dirs.root),
      hooks: true,
      mode: "guard"
    });
    const installed = await readJson<{
      hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>>;
    }>(target.settingsPath);
    installed.hooks.PreToolUse.push({
      matcher: "Read",
      hooks: [
        {
          type: "command",
          command: "custom-read-hook"
        }
      ]
    });
    await writeJson(target.settingsPath, installed);

    const result = await uninstallStatusLine({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir
    });
    const remaining = await readJson<{
      hooks: Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>>;
    }>(target.settingsPath);

    expect(result.status).toBe("removed");
    expect(remaining).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: "Read",
            hooks: [
              {
                type: "command",
                command: "custom-read-hook"
              }
            ]
          }
        ]
      }
    });
  });

  it("refuses to uninstall a custom statusLine without force", async () => {
    const dirs = mustHaveWorkspace(workspace);
    const target = resolveSettingsTarget({ projectDir: dirs.projectDir, homeDir: dirs.homeDir });
    const existing = {
      statusLine: {
        type: "command",
        command: "custom-statusline"
      }
    };
    await writeJson(target.settingsPath, existing);

    const result = await uninstallStatusLine({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir
    });

    expect(result.status).toBe("refused");
    await expect(readJson(target.settingsPath)).resolves.toEqual(existing);
  });
});

function mustHaveWorkspace(workspace: TempWorkspace | undefined): TempWorkspace {
  if (!workspace) {
    throw new Error("test workspace was not initialized");
  }
  return workspace;
}

async function packageVersion(): Promise<string> {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string") {
    throw new Error("package.json is missing a string version");
  }
  return pkg.version;
}

async function createFakeRuntime(root: string): Promise<string> {
  const distDir = join(root, `dist-${randomUUID()}`);
  await mkdir(distDir, { recursive: true });
  await writeFile(join(distDir, "cli.js"), "console.log('fake bb-cc-lite runtime');\n", "utf8");
  await writeFile(join(distDir, "helper.js"), "export const ok = true;\n", "utf8");
  return join(distDir, "cli.js");
}
