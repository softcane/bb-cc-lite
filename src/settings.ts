import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SAFE_HOOK_EVENTS } from "./hook-payload.js";
import { appHome, backupDir, cliPath, quoteShell } from "./paths.js";

export type SettingsScope = "local" | "project" | "user";

export interface SettingsTarget {
  scope: SettingsScope;
  settingsPath: string;
  projectDir: string;
  homeDir: string;
}

export interface InstallOptions {
  scope?: SettingsScope;
  projectDir?: string;
  homeDir?: string;
  replace?: boolean;
  cliFilePath?: string;
  hooks?: boolean;
}

export interface UninstallOptions {
  scope?: SettingsScope;
  projectDir?: string;
  homeDir?: string;
  force?: boolean;
}

export interface InstallResult {
  status: "installed" | "updated";
  target: SettingsTarget;
  message: string;
  command?: string;
  backupId?: string;
}

export interface UninstallResult {
  status: "restored" | "removed" | "skipped" | "refused";
  target: SettingsTarget;
  message: string;
}

interface BackupManifest {
  schema: "bb-cc-lite.install-backup.v1";
  installId: string;
  packageVersion: string;
  createdAt: string;
  scope: SettingsScope;
  projectDirHash: string;
  settingsPathHash: string;
  // Legacy manifests may contain raw paths. New manifests store hashes only.
  projectDir?: string;
  settingsPath?: string;
  before: {
    fileExisted: boolean;
    sha256?: string;
    hadStatusLine: boolean;
    statusLine?: unknown;
    hadHooks?: boolean;
    hooks?: unknown;
  };
  after: {
    sha256: string;
    statusLine: unknown;
    hooks?: unknown;
  };
  restoreStrategy: "raw-if-after-hash-matches-else-statusLine-only";
  state: "active" | "uninstalled";
}

const PACKAGE_VERSION = "0.1.1";

export function resolveSettingsTarget(options: InstallOptions | UninstallOptions = {}): SettingsTarget {
  const scope = options.scope || "local";
  const projectDir = resolve(options.projectDir || process.cwd());
  const homeDir = resolve(options.homeDir || homedir());
  const settingsPath =
    scope === "user"
      ? join(homeDir, ".claude", "settings.json")
      : scope === "project"
        ? join(projectDir, ".claude", "settings.json")
        : join(projectDir, ".claude", "settings.local.json");
  return { scope, settingsPath, projectDir, homeDir };
}

export async function installStatusLine(options: InstallOptions = {}): Promise<InstallResult> {
  const target = resolveSettingsTarget(options);
  const targetRead = await readSettings(target.settingsPath);
  const existing = targetRead.settings.statusLine;
  const existingHooks = targetRead.settings.hooks;

  const launchers = await ensureRuntimeLaunchers(options.cliFilePath || cliPath(), target.homeDir);
  const statusLine = {
    type: "command",
    command: quoteShell(launchers.statusline),
    padding: 0
  };

  if (existing && isBbStatusLine(existing)) {
    const afterHooks = options.hooks ? mergeBbHooks(existingHooks, launchers.hook) : existingHooks;
    const shouldWriteStatusLine = JSON.stringify(existing) !== JSON.stringify(statusLine);
    const shouldWriteHooks = options.hooks && JSON.stringify(existingHooks) !== JSON.stringify(afterHooks);
    if (shouldWriteStatusLine || shouldWriteHooks) {
      const beforeRaw = targetRead.raw;
      const beforeSettings = targetRead.settings;
      const afterSettings = {
        ...beforeSettings,
        statusLine,
        ...(afterHooks === undefined ? {} : { hooks: afterHooks })
      };
      const afterRaw = `${JSON.stringify(afterSettings, null, 2)}\n`;
      const installId = randomUUID();
      await writeBackup(installId, target, beforeRaw, beforeSettings.statusLine, beforeSettings.hooks, afterRaw, statusLine, afterSettings.hooks);
      await writeFileAtomic(target.settingsPath, afterRaw, targetRead.mode);
      return {
        status: "updated",
        target,
        command: statusLine.command,
        backupId: installId,
        message: `bb-cc-lite statusLine is already installed in ${describeSettingsTarget(target)}; ${options.hooks ? "repaired optional hooks and " : ""}refreshed runtime launcher.`
      };
    }
    return {
      status: "updated",
      target,
      command: statusLine.command,
      message: `bb-cc-lite statusLine is already installed in ${describeSettingsTarget(target)}; refreshed runtime launcher.`
    };
  }

  const beforeRaw = targetRead.raw;
  const beforeSettings = targetRead.settings;
  const afterSettings = {
    ...beforeSettings,
    statusLine,
    ...(options.hooks ? { hooks: mergeBbHooks(beforeSettings.hooks, launchers.hook) } : {})
  };
  const afterRaw = `${JSON.stringify(afterSettings, null, 2)}\n`;
  const installId = randomUUID();
  await writeBackup(installId, target, beforeRaw, beforeSettings.statusLine, beforeSettings.hooks, afterRaw, statusLine, afterSettings.hooks);
  await writeFileAtomic(target.settingsPath, afterRaw, targetRead.mode);

  return {
    status: existing ? "updated" : "installed",
    target,
    command: statusLine.command,
    backupId: installId,
    message: existing
      ? `Replaced existing Claude statusLine with bb-cc-lite${options.hooks ? " and optional hooks" : ""} in ${describeSettingsTarget(target)}. Previous settings were backed up.`
      : `Installed bb-cc-lite statusLine${options.hooks ? " and optional hooks" : ""} in ${describeSettingsTarget(target)}.`
  };
}

export async function uninstallStatusLine(options: UninstallOptions = {}): Promise<UninstallResult> {
  const target = resolveSettingsTarget(options);
  const current = await readSettings(target.settingsPath);
  const currentStatusLine = current.settings.statusLine;
  const currentHasBbHooks = hasBbHooks(current.settings.hooks, target.homeDir);
  const manifest = await latestBackupFor(target.settingsPath, target.homeDir, (candidate) => {
    return !(candidate.before.hadStatusLine && isBbStatusLine(candidate.before.statusLine));
  });

  if (!currentStatusLine && !currentHasBbHooks) {
    return {
      status: "skipped",
      target,
      message: `No bb-cc-lite statusLine or hooks are configured in ${describeSettingsTarget(target)}.`
    };
  }

  const manifestOwned =
    manifest?.after.statusLine !== undefined &&
    JSON.stringify(currentStatusLine) === JSON.stringify(manifest.after.statusLine);
  if (currentStatusLine && !isBbStatusLine(currentStatusLine) && !currentHasBbHooks && !manifestOwned && !options.force) {
    return {
      status: "refused",
      target,
      message: `Refused to modify non-bb-cc-lite statusLine in ${describeSettingsTarget(target)}.`
    };
  }

  const currentRaw = current.raw;
  if (manifest && currentRaw && sha256(currentRaw) === manifest.after.sha256) {
    if (manifest.before.fileExisted) {
      const beforeRaw = await readFile(join(backupDir(target.homeDir), manifest.installId, "before.settings.json"), "utf8");
      await writeFileAtomic(target.settingsPath, beforeRaw, current.mode);
      await markBackupUninstalled(manifest, target.homeDir);
      return {
        status: "restored",
        target,
        message: `Restored previous Claude settings from backup ${manifest.installId}.`
      };
    }
    await rm(target.settingsPath, { force: true });
    await markBackupUninstalled(manifest, target.homeDir);
    return {
      status: "removed",
      target,
      message: `Removed bb-cc-lite statusLine and deleted settings file created by install.`
    };
  }

  const nextSettings = { ...current.settings };
  if (currentStatusLine && (isBbStatusLine(currentStatusLine) || manifestOwned || options.force) && manifest?.before.hadStatusLine) {
    nextSettings.statusLine = manifest.before.statusLine;
  } else if (!currentStatusLine || isBbStatusLine(currentStatusLine) || manifestOwned || options.force) {
    delete nextSettings.statusLine;
  }
  if (currentHasBbHooks) {
    const hooks = removeBbHooks(nextSettings.hooks, target.homeDir);
    if (hooks === undefined) {
      delete nextSettings.hooks;
    } else {
      nextSettings.hooks = hooks;
    }
  }

  const keys = Object.keys(nextSettings);
  if (keys.length === 0) {
    await rm(target.settingsPath, { force: true });
  } else {
    await writeFileAtomic(target.settingsPath, `${JSON.stringify(nextSettings, null, 2)}\n`, current.mode);
  }
  if (manifest) {
    await markBackupUninstalled(manifest, target.homeDir);
  }
  return {
    status: manifest?.before.hadStatusLine ? "restored" : "removed",
    target,
    message: manifest
      ? `Restored bb-cc-lite settings from backup ${manifest.installId} while preserving unrelated current settings.`
      : `Removed bb-cc-lite statusLine and hooks. No backup was found, so no previous statusLine was restored.`
  };
}

export async function readStatusLine(scope: SettingsScope, projectDir = process.cwd(), homeDir = homedir()): Promise<unknown> {
  const target = resolveSettingsTarget({ scope, projectDir, homeDir });
  const read = await readSettings(target.settingsPath);
  return read.settings.statusLine;
}

export async function readHooks(scope: SettingsScope, projectDir = process.cwd(), homeDir = homedir()): Promise<unknown> {
  const target = resolveSettingsTarget({ scope, projectDir, homeDir });
  const read = await readSettings(target.settingsPath);
  return read.settings.hooks;
}

export function describeSettingsTarget(target: Pick<SettingsTarget, "scope">): string {
  return `${target.scope} Claude settings`;
}

export function isBbStatusLine(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const command = (value as Record<string, unknown>).command;
  if (typeof command !== "string") {
    return false;
  }
  const normalizedCommand = command.replaceAll("'", "");
  return commandReferencesBbCcLite(command) || normalizedCommand.includes(join(appHome(), "bin", "statusline"));
}

async function ensureRuntimeLaunchers(cliFilePath: string, homeDir: string): Promise<{ statusline: string; hook: string }> {
  const home = appHome(homeDir);
  const binDir = join(home, "bin");
  const statuslinePath = join(binDir, "statusline");
  const hookPath = join(binDir, "hook");
  const stableCliPath = await copyRuntime(cliFilePath, home);
  await mkdir(binDir, { recursive: true, mode: 0o700 });
  await writeFile(
    statuslinePath,
    `#!/bin/sh\nexport BB_CC_LITE_HOME=${quoteShell(home)}\nexec ${quoteShell(process.execPath)} ${quoteShell(stableCliPath)} statusline "$@"\n`,
    {
      encoding: "utf8",
      mode: 0o700
    }
  );
  await writeFile(
    hookPath,
    `#!/bin/sh\nexport BB_CC_LITE_HOME=${quoteShell(home)}\nexec ${quoteShell(process.execPath)} ${quoteShell(stableCliPath)} hook "$@"\n`,
    {
      encoding: "utf8",
      mode: 0o700
    }
  );
  await chmod(statuslinePath, 0o700);
  await chmod(hookPath, 0o700);
  return { statusline: statuslinePath, hook: hookPath };
}

function mergeBbHooks(existingHooks: unknown, hookPath: string): Record<string, unknown> {
  const result = removeBbHooks(existingHooks, undefined) ?? {};
  for (const eventName of SAFE_HOOK_EVENTS) {
    const entries = Array.isArray(result[eventName]) ? [...result[eventName]] : [];
    entries.push({
      matcher: "*",
      hooks: [
        {
          type: "command",
          command: hookPath,
          args: ["--bb-cc-lite-hook", eventName],
          async: true,
          timeout: 1
        }
      ]
    });
    result[eventName] = entries;
  }
  return result;
}

function removeBbHooks(existingHooks: unknown, homeDir: string | undefined): Record<string, unknown> | undefined {
  const hooks = cloneRecord(existingHooks);
  for (const [eventName, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) {
      continue;
    }
    const nextEntries = entries
      .map((entry) => removeBbHookFromEntry(entry, homeDir))
      .filter((entry) => entry !== undefined);
    if (nextEntries.length === 0) {
      delete hooks[eventName];
    } else {
      hooks[eventName] = nextEntries;
    }
  }
  return Object.keys(hooks).length === 0 ? undefined : hooks;
}

export function hasBbHooks(existingHooks: unknown, homeDir: string): boolean {
  const hooks = cloneRecord(existingHooks);
  return Object.values(hooks).some((entries) => Array.isArray(entries) && entries.some((entry) => entryHasBbHook(entry, homeDir)));
}

function removeBbHookFromEntry(entry: unknown, homeDir: string | undefined): unknown | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return entry;
  }
  const record = { ...(entry as Record<string, unknown>) };
  if (!Array.isArray(record.hooks)) {
    return entry;
  }
  const nextHooks = record.hooks.filter((hook) => !isBbHookCommand(hook, homeDir));
  if (nextHooks.length === 0) {
    return undefined;
  }
  return { ...record, hooks: nextHooks };
}

function entryHasBbHook(entry: unknown, homeDir: string | undefined): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return false;
  }
  const hooks = (entry as Record<string, unknown>).hooks;
  return Array.isArray(hooks) && hooks.some((hook) => isBbHookCommand(hook, homeDir));
}

function isBbHookCommand(value: unknown, homeDir: string | undefined): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const args = Array.isArray(record.args) ? record.args : [];
  const command = typeof record.command === "string" ? record.command : "";
  const normalizedCommand = command.replaceAll("'", "");
  return (
    args.includes("--bb-cc-lite-hook") ||
    commandReferencesBbCcLite(command) ||
    (homeDir !== undefined && normalizedCommand.includes(join(appHome(homeDir), "bin", "hook")))
  );
}

function commandReferencesBbCcLite(command: string): boolean {
  return /(^|[\s/\\])bb-cc-lite($|[\s/\\])/u.test(command.replaceAll("'", ""));
}

function cloneRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

async function copyRuntime(cliFilePath: string, home: string): Promise<string> {
  const distDir = dirname(cliFilePath);
  const stableDistDir = join(home, "versions", PACKAGE_VERSION, "dist");
  const stableCliPath = join(stableDistDir, "cli.js");
  await mkdir(dirname(stableDistDir), { recursive: true, mode: 0o700 });
  await rm(stableDistDir, { recursive: true, force: true });
  await cp(distDir, stableDistDir, { recursive: true, force: true });
  await chmodTree(join(home, "versions"), 0o700, 0o600);
  await chmod(stableCliPath, 0o700);
  return stableCliPath;
}

async function chmodTree(path: string, dirMode: number, fileMode: number): Promise<void> {
  try {
    const fileStat = await stat(path);
    if (fileStat.isDirectory()) {
      await chmod(path, dirMode);
      const entries = await readdir(path);
      await Promise.all(entries.map((entry) => chmodTree(join(path, entry), dirMode, fileMode)));
    } else {
      await chmod(path, fileMode);
    }
  } catch {
    // Best effort. Existing umask protections still apply if chmod is unavailable.
  }
}

async function readSettings(settingsPath: string): Promise<{
  raw?: string;
  settings: Record<string, unknown>;
  mode?: number;
}> {
  try {
    const [raw, fileStat] = await Promise.all([readFile(settingsPath, "utf8"), stat(settingsPath)]);
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Settings file is not a JSON object");
    }
    return { raw, settings: parsed as Record<string, unknown>, mode: fileStat.mode };
  } catch (error) {
    if (isNotFound(error)) {
      return { settings: {} };
    }
    throw error;
  }
}

async function writeBackup(
  installId: string,
  target: SettingsTarget,
  beforeRaw: string | undefined,
  beforeStatusLine: unknown,
  beforeHooks: unknown,
  afterRaw: string,
  afterStatusLine: unknown,
  afterHooks: unknown
): Promise<void> {
  const dir = join(backupDir(target.homeDir), installId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (beforeRaw !== undefined) {
    await writeFile(join(dir, "before.settings.json"), beforeRaw, { encoding: "utf8", mode: 0o600 });
  }
  await writeFile(join(dir, "after.settings.json"), afterRaw, { encoding: "utf8", mode: 0o600 });
  const manifest: BackupManifest = {
    schema: "bb-cc-lite.install-backup.v1",
    installId,
    packageVersion: PACKAGE_VERSION,
    createdAt: new Date().toISOString(),
    scope: target.scope,
    projectDirHash: sha256(target.projectDir),
    settingsPathHash: sha256(target.settingsPath),
    before: {
      fileExisted: beforeRaw !== undefined,
      sha256: beforeRaw === undefined ? undefined : sha256(beforeRaw),
      hadStatusLine: beforeStatusLine !== undefined,
      statusLine: beforeStatusLine,
      hadHooks: beforeHooks !== undefined,
      hooks: beforeHooks
    },
    after: {
      sha256: sha256(afterRaw),
      statusLine: afterStatusLine,
      hooks: afterHooks
    },
    restoreStrategy: "raw-if-after-hash-matches-else-statusLine-only",
    state: "active"
  };
  await writeFile(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
}

async function latestBackupFor(
  settingsPath: string,
  homeDir: string,
  include: (manifest: BackupManifest) => boolean = () => true
): Promise<BackupManifest | undefined> {
  try {
    const entries = await readdir(backupDir(homeDir), { withFileTypes: true });
    const manifests: BackupManifest[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      try {
        const parsed = JSON.parse(await readFile(join(backupDir(homeDir), entry.name, "manifest.json"), "utf8")) as BackupManifest;
        if (
          parsed.schema === "bb-cc-lite.install-backup.v1" &&
          (parsed.settingsPathHash === sha256(settingsPath) || parsed.settingsPath === settingsPath) &&
          parsed.state === "active" &&
          include(parsed)
        ) {
          manifests.push(parsed);
        }
      } catch {
        // Ignore corrupt backup metadata; uninstall can still remove bb-owned statusLine.
      }
    }
    return manifests.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  } catch {
    return undefined;
  }
}

async function markBackupUninstalled(manifest: BackupManifest, homeDir: string): Promise<void> {
  manifest.state = "uninstalled";
  const manifestPath = join(backupDir(homeDir), manifest.installId, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function writeFileAtomic(path: string, data: string, existingMode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, data, { encoding: "utf8", mode: existingMode ?? 0o600 });
  await chmod(tempPath, existingMode ?? 0o600);
  await rename(tempPath, path);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}
