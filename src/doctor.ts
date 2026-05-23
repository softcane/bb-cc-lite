import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { clearAllBaselines, readBaseline, readBaselineForProject, summarizeBaseline, type PersonalBaseline } from "./baseline.js";
import { buildBaseline } from "./baseline-builder.js";
import { evaluateHistoricalReplay, formatHistoricalReplayMetrics } from "./historical-replay.js";
import { clearLessonMemory } from "./memory-lessons.js";
import { baselinePath, pricingCachePath } from "./paths.js";
import { refreshPricing } from "./pricing.js";
import {
  describeSettingsTarget,
  hasBbHooks,
  isBbStatusLine,
  readHooks,
  readStatusLine,
  resolveSettingsTarget,
  type SettingsScope
} from "./settings.js";

export interface DoctorOptions {
  scope?: SettingsScope;
  projectDir?: string;
  homeDir?: string;
  transcriptPath?: string;
  refreshPricing?: boolean;
  showBaseline?: boolean;
  clearBaseline?: boolean;
  buildBaseline?: boolean;
  replayBaseline?: boolean;
  appHomePath?: string;
}

export interface DoctorCheck {
  level: "OK" | "WARN" | "FAIL";
  name: string;
  message: string;
}

export interface PersonalBaselineResult {
  ok: boolean;
  message: string;
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  checks.push(checkNodeVersion());

  const target = resolveSettingsTarget(options);
  const targetLabel = describeSettingsTarget(target);
  try {
    const statusLine = await readStatusLine(target.scope, target.projectDir, target.homeDir);
    if (statusLine && isBbStatusLine(statusLine)) {
      checks.push({ level: "OK", name: "settings", message: `bb-cc-lite statusLine is installed in ${targetLabel}` });
    } else if (statusLine) {
      checks.push({ level: "WARN", name: "settings", message: `custom statusLine is configured in ${targetLabel}` });
    } else {
      checks.push({ level: "WARN", name: "settings", message: `no statusLine found in ${targetLabel}` });
    }
  } catch (error) {
    checks.push({
      level: "FAIL",
      name: "settings",
      message: error instanceof Error ? error.message : `could not read ${targetLabel}`
    });
  }

  try {
    const hooks = await readHooks(target.scope, target.projectDir, target.homeDir);
    if (hasBbHooks(hooks, target.homeDir)) {
      checks.push({ level: "OK", name: "hooks", message: `optional bb-cc-lite hooks are installed in ${targetLabel}` });
    } else {
      checks.push({ level: "WARN", name: "hooks", message: "optional bb-cc-lite hooks are not installed; run install --hooks to enable faster telemetry" });
    }
  } catch (error) {
    checks.push({
      level: "FAIL",
      name: "hooks",
      message: error instanceof Error ? error.message : `could not read hooks from ${targetLabel}`
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
  if (options.clearBaseline) {
    await addClearBaselineCheck(checks, options);
  }
  if (options.buildBaseline) {
    await addBuildBaselineCheck(checks, options);
  }
  if (options.showBaseline) {
    await addBaselineSummaryCheck(checks, options);
    await addProjectBaselineSummaryCheck(checks, { ...options, projectDir: target.projectDir, homeDir: target.homeDir });
  }
  if (options.replayBaseline) {
    await addBaselineReplayCheck(checks, options);
  }
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

async function addClearBaselineCheck(checks: DoctorCheck[], options: DoctorOptions): Promise<void> {
  await clearPersonalBaseline({ homeDir: options.homeDir, appHomePath: options.appHomePath });
  checks.push({
    level: "OK",
    name: "baseline",
    message: "cleared learned baselines"
  });
}

async function addBuildBaselineCheck(checks: DoctorCheck[], options: DoctorOptions): Promise<void> {
  const result = await buildPersonalBaseline({
    homeDir: options.homeDir,
    appHomePath: options.appHomePath,
    projectDir: options.projectDir,
    transcriptPath: options.transcriptPath
  });
  checks.push({
    level: result.ok ? "OK" : "WARN",
    name: "baseline",
    message: result.message.replaceAll("\n", " ")
  });
}

async function addBaselineSummaryCheck(checks: DoctorCheck[], options: DoctorOptions): Promise<void> {
  const baseline = await readBaseline(baselineFilePath(options));
  if (baseline) {
    checks.push({
      level: "OK",
      name: "baseline",
      message: formatBaselineSummaryMessage(baseline, summarizeBaseline(baseline))
    });
    return;
  }
  checks.push({
    level: "WARN",
    name: "baseline",
    message: "no readable personal baseline found; run doctor --build-baseline to create one"
  });
}

async function addProjectBaselineSummaryCheck(checks: DoctorCheck[], options: DoctorOptions): Promise<void> {
  if (!options.projectDir) {
    return;
  }
  const selection = await readBaselineForProject({
    projectDir: options.projectDir,
    homeDir: options.homeDir,
    appHomePath: options.appHomePath
  });
  if (selection.source === "project" && selection.baseline) {
    checks.push({
      level: "OK",
      name: "project-baseline",
      message: formatProjectBaselineSummaryMessage(selection.baseline)
    });
    return;
  }
  checks.push({
    level: "WARN",
    name: "project-baseline",
    message: "no usable project baseline found; using personal baseline until this project has enough aggregate history"
  });
}

async function addBaselineReplayCheck(checks: DoctorCheck[], options: DoctorOptions): Promise<void> {
  try {
    const metrics = await evaluateHistoricalReplay({ homeDir: options.homeDir });
    checks.push({
      level: metrics.holdoutSessions > 0 ? "OK" : "WARN",
      name: "baseline-replay",
      message: formatHistoricalReplayMetrics(metrics)
    });
  } catch {
    checks.push({
      level: "WARN",
      name: "baseline-replay",
      message: "could not evaluate local Claude JSONL history"
    });
  }
}

export async function buildPersonalBaseline(
  options: { homeDir?: string; appHomePath?: string; projectDir?: string; transcriptPath?: string } = {}
): Promise<PersonalBaselineResult> {
  try {
    const baseline = await buildBaseline({
      homeDir: options.homeDir,
      appHomePath: options.appHomePath,
      projectDir: options.projectDir,
      transcriptPath: options.transcriptPath
    });
    return {
      ok: true,
      message: formatBuiltBaselineMessage(baseline)
    };
  } catch {
    return {
      ok: false,
      message: "could not build personal baseline"
    };
  }
}

export async function clearPersonalBaseline(
  options: { homeDir?: string; appHomePath?: string } = {}
): Promise<PersonalBaselineResult> {
  await clearAllBaselines(options);
  await clearLessonMemory(options);
  return {
    ok: true,
    message: "cleared learned baselines and lesson memory"
  };
}

function formatBuiltBaselineMessage(value: unknown): string {
  const sessionsSeen = sessionsSeenFrom(value);
  return `Personal baseline ready (${sessionsSeen} sessions).`;
}

function formatBaselineSummaryMessage(value: unknown, summary?: unknown): string {
  const sessionsSeen = sessionsSeenFrom(value);
  const filesScanned = filesScannedFrom(value);
  const outcomeSummary =
    typeof summary === "string" && summary.startsWith("Personal baseline:")
      ? `; ${summary.replace("Personal baseline:", "outcomes:").replace(/\.$/u, "")}`
      : "";
  const extendedSummary = extendedBaselineSummary(value);
  return `personal baseline: ${sessionsSeen} sessions, ${filesScanned} transcript files; derived aggregate data only${outcomeSummary}${extendedSummary}`;
}

function formatProjectBaselineSummaryMessage(baseline: PersonalBaseline): string {
  const parts = [`project baseline: ${baseline.source.sessionsSeen} sessions`, "derived aggregate data only"];
  const activity = baseline.activity;
  if (activity) {
    parts.push(
      `activity samples: high ${activity.highActivitySessions}, no-progress ${activity.busyNoProgressSessions}, progress ${activity.observedProgressSessions}, read-heavy ${activity.readHeavySessions}`
    );
  }
  const budget = baseline.budget;
  if (budget) {
    parts.push(`budget samples: cost ${budget.costSamples}, duration ${budget.durationSamples}`);
  }
  return parts.join("; ");
}

function extendedBaselineSummary(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }
  const baseline = value as {
    recent?: { windowKind?: unknown; windowSize?: unknown; sessionsSeen?: unknown };
    validation?: Record<string, unknown>;
    toolCategories?: Record<string, unknown>;
    failureRecovery?: Record<string, unknown>;
    blindRetry?: Record<string, unknown>;
  };
  const parts: string[] = [];
  const recent = baseline.recent;
  if (
    recent &&
    recent.windowKind === "newest_files" &&
    typeof recent.sessionsSeen === "number" &&
    typeof recent.windowSize === "number"
  ) {
    parts.push(`recent newest_files window ${recent.sessionsSeen}/${recent.windowSize}`);
  }
  const validationCategories = baseline.validation ? Object.keys(baseline.validation).sort() : [];
  if (validationCategories.length > 0) {
    parts.push(`validation categories: ${validationCategories.join(", ")}`);
  }
  const toolCategories = baseline.toolCategories ? Object.keys(baseline.toolCategories).sort() : [];
  if (toolCategories.length > 0) {
    parts.push(`tool categories: ${toolCategories.join(", ")}`);
  }
  const recoveryCategories = baseline.failureRecovery ? Object.keys(baseline.failureRecovery).sort() : [];
  if (recoveryCategories.length > 0) {
    parts.push(`recovery categories: ${recoveryCategories.join(", ")}`);
  }
  const blindRetryCategories = baseline.blindRetry ? Object.keys(baseline.blindRetry).sort() : [];
  if (blindRetryCategories.length > 0) {
    parts.push(`blind retry categories: ${blindRetryCategories.join(", ")}`);
  }
  return parts.length > 0 ? `; ${parts.join("; ")}` : "";
}

function sessionsSeenFrom(value: unknown): number {
  if (!value || typeof value !== "object") {
    return 0;
  }
  const nestedBaseline = (value as { baseline?: unknown }).baseline;
  if (nestedBaseline) {
    return sessionsSeenFrom(nestedBaseline);
  }
  const source = (value as { source?: unknown }).source;
  if (source && typeof source === "object" && typeof (source as { sessionsSeen?: unknown }).sessionsSeen === "number") {
    return (source as { sessionsSeen: number }).sessionsSeen;
  }
  if (typeof (value as { sessionsSeen?: unknown }).sessionsSeen === "number") {
    return (value as { sessionsSeen: number }).sessionsSeen;
  }
  return 0;
}

function filesScannedFrom(value: unknown): number {
  if (!value || typeof value !== "object") {
    return 0;
  }
  const nestedBaseline = (value as { baseline?: unknown }).baseline;
  if (nestedBaseline) {
    return filesScannedFrom(nestedBaseline);
  }
  const source = (value as { source?: unknown }).source;
  if (
    source &&
    typeof source === "object" &&
    typeof (source as { transcriptFilesScanned?: unknown }).transcriptFilesScanned === "number"
  ) {
    return (source as { transcriptFilesScanned: number }).transcriptFilesScanned;
  }
  if (typeof (value as { transcriptFilesScanned?: unknown }).transcriptFilesScanned === "number") {
    return (value as { transcriptFilesScanned: number }).transcriptFilesScanned;
  }
  return 0;
}

function baselineFilePath(options: { homeDir?: string; appHomePath?: string }): string {
  return options.appHomePath ? join(options.appHomePath, "baseline.json") : baselinePath(options.homeDir);
}

async function addLiteLLMChecks(checks: DoctorCheck[], shouldRefreshPricing: boolean): Promise<void> {
  try {
    await access(pricingCachePath(), constants.R_OK);
    checks.push({ level: "OK", name: "litellm-pricing", message: "pricing cache exists" });
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
