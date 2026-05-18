import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { pricingCachePath } from "./paths.js";
import { refreshPricing } from "./pricing.js";
import { hasBbHooks, isBbStatusLine, readHooks, readStatusLine, resolveSettingsTarget, type SettingsScope } from "./settings.js";

export interface DoctorOptions {
  scope?: SettingsScope;
  projectDir?: string;
  homeDir?: string;
  transcriptPath?: string;
  refreshPricing?: boolean;
}

export interface DoctorCheck {
  level: "OK" | "WARN" | "FAIL";
  name: string;
  message: string;
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  checks.push(checkNodeVersion());

  const target = resolveSettingsTarget(options);
  try {
    const statusLine = await readStatusLine(target.scope, target.projectDir, target.homeDir);
    if (statusLine && isBbStatusLine(statusLine)) {
      checks.push({ level: "OK", name: "settings", message: `bb-cc-lite statusLine is installed in ${target.settingsPath}` });
    } else if (statusLine) {
      checks.push({ level: "WARN", name: "settings", message: `custom statusLine is configured in ${target.settingsPath}` });
    } else {
      checks.push({ level: "WARN", name: "settings", message: `no statusLine found in ${target.settingsPath}` });
    }
  } catch (error) {
    checks.push({
      level: "FAIL",
      name: "settings",
      message: error instanceof Error ? error.message : `could not read ${target.settingsPath}`
    });
  }

  try {
    const hooks = await readHooks(target.scope, target.projectDir, target.homeDir);
    if (hasBbHooks(hooks, target.homeDir)) {
      checks.push({ level: "OK", name: "hooks", message: `optional bb-cc-lite hooks are installed in ${target.settingsPath}` });
    } else {
      checks.push({ level: "WARN", name: "hooks", message: "optional bb-cc-lite hooks are not installed; run install --hooks to enable faster telemetry" });
    }
  } catch (error) {
    checks.push({
      level: "FAIL",
      name: "hooks",
      message: error instanceof Error ? error.message : `could not read hooks from ${target.settingsPath}`
    });
  }

  if (options.transcriptPath) {
    try {
      await access(options.transcriptPath, constants.R_OK);
      checks.push({ level: "OK", name: "transcript", message: "transcript path is readable" });
    } catch {
      checks.push({ level: "FAIL", name: "transcript", message: "transcript path is not readable" });
    }
  } else {
    checks.push({
      level: "WARN",
      name: "transcript",
      message: "no transcript path supplied; pass --transcript <path> to check access"
    });
  }

  addAnthropicBaseUrlCheck(checks);
  await addLiteLLMChecks(checks, options.refreshPricing || false);
  return checks;
}

export function formatDoctorChecks(checks: DoctorCheck[]): string {
  return checks.map((check) => `${check.level} ${check.name}: ${check.message}`).join("\n");
}

function checkNodeVersion(): DoctorCheck {
  const major = Number(process.versions.node.split(".")[0]);
  if (Number.isFinite(major) && major >= 20) {
    return { level: "OK", name: "node", message: `Node ${process.versions.node}` };
  }
  return { level: "FAIL", name: "node", message: `Node ${process.versions.node}; bb-cc-lite requires Node >=20` };
}

async function addLiteLLMChecks(checks: DoctorCheck[], shouldRefreshPricing: boolean): Promise<void> {
  try {
    await access(pricingCachePath(), constants.R_OK);
    checks.push({ level: "OK", name: "litellm-pricing", message: `pricing cache exists at ${pricingCachePath()}` });
  } catch {
    checks.push({ level: "WARN", name: "litellm-pricing", message: "using bundled pricing fallback; run doctor --refresh-pricing to cache LiteLLM prices" });
  }

  if (shouldRefreshPricing) {
    try {
      const table = await refreshPricing();
      checks.push({ level: "OK", name: "litellm-pricing-refresh", message: `cached ${Object.keys(table.models).length} LiteLLM pricing entries` });
    } catch (error) {
      checks.push({
        level: "WARN",
        name: "litellm-pricing-refresh",
        message: error instanceof Error ? error.message : "could not refresh LiteLLM pricing"
      });
    }
  }

}

function addAnthropicBaseUrlCheck(checks: DoctorCheck[]): void {
  const value = process.env.ANTHROPIC_BASE_URL;
  if (!value) {
    checks.push({ level: "OK", name: "anthropic-base-url", message: "ANTHROPIC_BASE_URL is unset; Claude Code will use the default Anthropic endpoint" });
    return;
  }

  let host = "custom endpoint";
  try {
    host = new URL(value).host;
  } catch {
    // Keep a non-sensitive generic label for malformed values.
  }
  checks.push({
    level: "WARN",
    name: "anthropic-base-url",
    message: `ANTHROPIC_BASE_URL is set to ${host}; custom endpoints must support Claude Code model aliases`
  });
}
