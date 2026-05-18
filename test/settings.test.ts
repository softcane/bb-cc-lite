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

    const result = await installStatusLine({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir,
      cliFilePath
    });

    const target = resolveSettingsTarget({ projectDir: dirs.projectDir, homeDir: dirs.homeDir });
    const launcherPath = join(dirs.appHome, "bin", "statusline");
    const stableCliPath = join(dirs.appHome, "versions", "0.1.0", "dist", "cli.js");
    const settings = await readJson<{ statusLine: { type: string; command: string; padding: number } }>(target.settingsPath);
    const launcher = await readFile(launcherPath, "utf8");
    const copiedRuntime = await readFile(stableCliPath, "utf8");

    expect(result.status).toBe("installed");
    expect(result.target).toEqual(target);
    expect(result.command).toBe(quoteShell(launcherPath));
    expect(settings.statusLine).toEqual({
      type: "command",
      command: quoteShell(launcherPath),
      padding: 0
    });
    expect(launcher).toBe(`#!/bin/sh\nexec ${quoteShell(process.execPath)} ${quoteShell(stableCliPath)} statusline "$@"\n`);
    expect(launcher).not.toContain(cliFilePath);
    expect(copiedRuntime).toContain("fake bb-cc-lite runtime");
  });

  it("installs optional safe hooks without enabling prompt-capture hooks", async () => {
    const dirs = mustHaveWorkspace(workspace);
    const cliFilePath = await createFakeRuntime(dirs.root);

    const result = await installStatusLine({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir,
      cliFilePath,
      hooks: true
    });

    const target = resolveSettingsTarget({ projectDir: dirs.projectDir, homeDir: dirs.homeDir });
    const hookLauncherPath = join(dirs.appHome, "bin", "hook");
    const stableCliPath = join(dirs.appHome, "versions", "0.1.0", "dist", "cli.js");
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
              args: ["--bb-cc-lite-hook", eventName],
              async: true,
              timeout: 1
            }
          ]
        }
      ]);
    }
    expect(hookLauncher).toBe(`#!/bin/sh\nexec ${quoteShell(process.execPath)} ${quoteShell(stableCliPath)} hook "$@"\n`);
  });

  it("preserves a custom statusLine unless replace is requested", async () => {
    const dirs = mustHaveWorkspace(workspace);
    const target = resolveSettingsTarget({ projectDir: dirs.projectDir, homeDir: dirs.homeDir });
    const existing = {
      cleanupPeriodDays: 7,
      statusLine: {
        type: "command",
        command: "custom-statusline"
      }
    };
    await writeJson(target.settingsPath, existing);

    const skipped = await installStatusLine({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir,
      cliFilePath: await createFakeRuntime(dirs.root)
    });

    expect(skipped.status).toBe("skipped");
    await expect(readJson(target.settingsPath)).resolves.toEqual(existing);

    const replaced = await installStatusLine({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir,
      replace: true,
      cliFilePath: await createFakeRuntime(dirs.root)
    });
    const settings = await readJson<{ cleanupPeriodDays: number; statusLine: { command: string } }>(target.settingsPath);

    expect(replaced.status).toBe("updated");
    expect(replaced.backupId).toEqual(expect.any(String));
    expect(settings.cleanupPeriodDays).toBe(7);
    expect(settings.statusLine.command).toBe(quoteShell(join(dirs.appHome, "bin", "statusline")));
  });

  it("does not mutate runtime launchers when install is skipped", async () => {
    const dirs = mustHaveWorkspace(workspace);
    const target = resolveSettingsTarget({ projectDir: dirs.projectDir, homeDir: dirs.homeDir });
    await writeJson(target.settingsPath, {
      statusLine: {
        type: "command",
        command: "custom-statusline"
      }
    });

    const skipped = await installStatusLine({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir,
      cliFilePath: await createFakeRuntime(dirs.root)
    });

    expect(skipped.status).toBe("skipped");
    await expect(pathExists(join(dirs.appHome, "bin", "statusline"))).resolves.toBe(false);
    await expect(pathExists(join(dirs.appHome, "bin", "hook"))).resolves.toBe(false);
  });

  it("reinstall with hooks repairs partial bb hook settings", async () => {
    const dirs = mustHaveWorkspace(workspace);
    const target = resolveSettingsTarget({ projectDir: dirs.projectDir, homeDir: dirs.homeDir });
    const cliFilePath = await createFakeRuntime(dirs.root);
    await installStatusLine({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir,
      cliFilePath,
      hooks: true
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
      hooks: true
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
              command: "custom-format-hook"
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
          command: "custom-format-hook"
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
                command: "custom-format-hook"
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

async function createFakeRuntime(root: string): Promise<string> {
  const distDir = join(root, `dist-${randomUUID()}`);
  await mkdir(distDir, { recursive: true });
  await writeFile(join(distDir, "cli.js"), "console.log('fake bb-cc-lite runtime');\n", "utf8");
  await writeFile(join(distDir, "helper.js"), "export const ok = true;\n", "utf8");
  return join(distDir, "cli.js");
}
