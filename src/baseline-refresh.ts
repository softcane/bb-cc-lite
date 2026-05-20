import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildBaseline, type BuildBaselineOptions } from "./baseline-builder.js";
import type { PersonalBaseline } from "./baseline.js";
import { appHome, cliPath } from "./paths.js";

export const BASELINE_REFRESH_LOCK_FILE = "baseline-refresh.lock";
export const DEFAULT_BASELINE_REFRESH_INTERVAL_HOURS = 24;
export const DEFAULT_BASELINE_REFRESH_LOCK_STALE_MS = 120_000;
export const BASELINE_REFRESH_LOCK_HELD_ENV = "BB_CC_LITE_BASELINE_REFRESH_LOCK_HELD";

export interface BaselineRefreshLockMetadata {
  startedAt: string;
  pid: number;
}

export interface RefreshSpawnRequest {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export type RefreshSpawner = (request: RefreshSpawnRequest) => void;

export interface MaybeTriggerBaselineRefreshOptions {
  baseline?: PersonalBaseline;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  intervalHours?: number;
  lockStaleMs?: number;
  homeDir?: string;
  appHomePath?: string;
  cliFilePath?: string;
  spawnRefresh?: RefreshSpawner;
}

export interface BaselineRefreshTriggerResult {
  triggered: boolean;
  reason: "disabled" | "fresh" | "locked" | "spawned" | "error";
}

export interface RunBaselineRefreshOptions {
  env?: NodeJS.ProcessEnv;
  now?: Date;
  lockStaleMs?: number;
  homeDir?: string;
  appHomePath?: string;
  lockAlreadyHeld?: boolean;
  build?: (options: BuildBaselineOptions) => Promise<{ baseline: PersonalBaseline; written: boolean }>;
}

export interface BaselineRefreshResult {
  ok: boolean;
  written: boolean;
  skipped?: "disabled" | "locked";
}

interface LockPathOptions {
  homeDir?: string;
  appHomePath?: string;
}

interface AcquireRefreshLockOptions extends LockPathOptions {
  lockPath?: string;
  now?: Date;
  staleAfterMs?: number;
}

export function shouldAutoRefresh(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BB_CC_LITE_AUTO_LEARN !== "0";
}

export function refreshIntervalHoursFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.BB_CC_LITE_BASELINE_REFRESH_INTERVAL_HOURS;
  if (value === undefined || value.trim() === "") {
    return DEFAULT_BASELINE_REFRESH_INTERVAL_HOURS;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BASELINE_REFRESH_INTERVAL_HOURS;
}

export function baselineIsStale(
  baseline: PersonalBaseline | undefined,
  now = new Date(),
  intervalHours = DEFAULT_BASELINE_REFRESH_INTERVAL_HOURS
): boolean {
  if (!baseline) {
    return true;
  }
  const updatedAtMs = Date.parse(baseline.updatedAt);
  if (!Number.isFinite(updatedAtMs)) {
    return true;
  }
  const staleAfterMs = Math.max(0, intervalHours) * 60 * 60 * 1000;
  return now.getTime() - updatedAtMs >= staleAfterMs;
}

export function baselineRefreshLockPath(options: LockPathOptions = {}): string {
  return join(options.appHomePath ?? appHome(options.homeDir), BASELINE_REFRESH_LOCK_FILE);
}

export async function acquireRefreshLock(options: AcquireRefreshLockOptions = {}): Promise<boolean> {
  const lockPath = options.lockPath ?? baselineRefreshLockPath(options);
  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_BASELINE_REFRESH_LOCK_STALE_MS;

  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  await bestEffortChmod(dirname(lockPath), 0o700);

  try {
    await writeRefreshLock(lockPath, now);
    return true;
  } catch (error) {
    if (!isErrno(error, "EEXIST")) {
      throw error;
    }
  }

  if (await refreshLockIsRecent(lockPath, now, staleAfterMs)) {
    return false;
  }

  await rm(lockPath, { force: true });
  try {
    await writeRefreshLock(lockPath, now);
    return true;
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      return false;
    }
    throw error;
  }
}

export async function releaseRefreshLock(lockPath: string): Promise<void> {
  await rm(lockPath, { force: true });
}

export async function maybeTriggerBaselineRefresh(
  options: MaybeTriggerBaselineRefreshOptions = {}
): Promise<BaselineRefreshTriggerResult> {
  const env = options.env ?? process.env;
  if (!shouldAutoRefresh(env)) {
    return { triggered: false, reason: "disabled" };
  }

  const now = options.now ?? new Date();
  const intervalHours = options.intervalHours ?? refreshIntervalHoursFromEnv(env);
  if (!baselineIsStale(options.baseline, now, intervalHours)) {
    return { triggered: false, reason: "fresh" };
  }

  const lockPath = baselineRefreshLockPath(options);
  try {
    const acquired = await acquireRefreshLock({
      lockPath,
      now,
      staleAfterMs: options.lockStaleMs
    });
    if (!acquired) {
      return { triggered: false, reason: "locked" };
    }

    try {
      const childEnv: NodeJS.ProcessEnv = {
        ...env,
        [BASELINE_REFRESH_LOCK_HELD_ENV]: "1"
      };
      if (options.appHomePath) {
        childEnv.BB_CC_LITE_HOME = options.appHomePath;
      }
      if (options.homeDir) {
        childEnv.HOME = options.homeDir;
      }
      const spawnRefresh = options.spawnRefresh ?? spawnDetachedRefresh;
      spawnRefresh({
        command: process.execPath,
        args: [options.cliFilePath ?? cliPath(), "baseline-refresh", "--quiet"],
        env: childEnv
      });
      return { triggered: true, reason: "spawned" };
    } catch {
      await releaseRefreshLock(lockPath).catch(() => undefined);
      return { triggered: false, reason: "error" };
    }
  } catch {
    return { triggered: false, reason: "error" };
  }
}

export async function runBaselineRefresh(options: RunBaselineRefreshOptions = {}): Promise<BaselineRefreshResult> {
  const env = options.env ?? process.env;
  if (!shouldAutoRefresh(env)) {
    return { ok: true, written: false, skipped: "disabled" };
  }

  const lockPath = baselineRefreshLockPath(options);
  const lockAlreadyHeld = options.lockAlreadyHeld ?? env[BASELINE_REFRESH_LOCK_HELD_ENV] === "1";
  let acquired = false;

  try {
    if (!lockAlreadyHeld) {
      acquired = await acquireRefreshLock({
        lockPath,
        now: options.now,
        staleAfterMs: options.lockStaleMs
      });
      if (!acquired) {
        return { ok: true, written: false, skipped: "locked" };
      }
    }

    const builder = options.build ?? buildBaseline;
    const result = await builder({
      homeDir: options.homeDir,
      appHomePath: options.appHomePath,
      now: options.now
    });
    return { ok: true, written: result.written };
  } catch {
    return { ok: false, written: false };
  } finally {
    if (lockAlreadyHeld || acquired) {
      await releaseRefreshLock(lockPath).catch(() => undefined);
    }
  }
}

async function writeRefreshLock(path: string, now: Date): Promise<void> {
  const metadata: BaselineRefreshLockMetadata = {
    startedAt: now.toISOString(),
    pid: process.pid
  };
  await writeFile(path, `${JSON.stringify(metadata)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  await bestEffortChmod(path, 0o600);
}

async function refreshLockIsRecent(path: string, now: Date, staleAfterMs: number): Promise<boolean> {
  const startedAtMs = await refreshLockStartedAtMs(path);
  if (startedAtMs !== undefined) {
    return now.getTime() - startedAtMs < staleAfterMs;
  }
  try {
    const lockStat = await stat(path);
    return now.getTime() - lockStat.mtimeMs < staleAfterMs;
  } catch {
    return false;
  }
}

async function refreshLockStartedAtMs(path: string): Promise<number | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    const startedAt = (parsed as { startedAt?: unknown }).startedAt;
    if (typeof startedAt !== "string") {
      return undefined;
    }
    const parsedMs = Date.parse(startedAt);
    return Number.isFinite(parsedMs) ? parsedMs : undefined;
  } catch {
    return undefined;
  }
}

function spawnDetachedRefresh(request: RefreshSpawnRequest): void {
  const child = spawn(request.command, request.args, {
    detached: true,
    env: request.env,
    stdio: "ignore"
  });
  child.on("error", () => undefined);
  child.unref();
}

async function bestEffortChmod(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch {
    // Some filesystems do not support POSIX permissions.
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code;
}
