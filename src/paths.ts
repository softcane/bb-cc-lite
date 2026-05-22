import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP_DIR_NAME = "bb-cc-lite";
export const PROJECT_BASELINE_DIR_NAME = "project-baselines";

export function appHome(homeDir = homedir()): string {
  return process.env.BB_CC_LITE_HOME || join(homeDir, ".claude", APP_DIR_NAME);
}

export function eventStorePath(): string {
  return process.env.BB_CC_LITE_STORE || join(appHome(), "events.json");
}

export function baselinePath(homeDir?: string): string {
  return join(appHome(homeDir), "baseline.json");
}

export function projectKeyFromPath(projectDir: string): string {
  return createHash("sha256").update(resolve(projectDir)).digest("hex");
}

export function projectBaselinePath(options: { projectKey: string; homeDir?: string; appHomePath?: string }): string {
  if (!/^[a-f0-9]{64}$/u.test(options.projectKey)) {
    throw new Error("invalid project key");
  }
  return join(options.appHomePath ?? appHome(options.homeDir), PROJECT_BASELINE_DIR_NAME, `${options.projectKey}.json`);
}

export function backupDir(homeDir?: string): string {
  return join(appHome(homeDir), "backups");
}

export function pricingCachePath(): string {
  return process.env.BB_CC_LITE_PRICING_CACHE || join(appHome(), "litellm-pricing.json");
}

export function cliPath(): string {
  return fileURLToPath(import.meta.url).endsWith("/paths.js")
    ? resolve(dirname(fileURLToPath(import.meta.url)), "cli.js")
    : resolve(process.argv[1] || "");
}

export function hashValue(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
