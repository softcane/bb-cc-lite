#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  buildPersonalBaseline,
  clearPersonalBaseline,
  formatDoctorChecks,
  runDoctor
} from "./doctor.js";
import { renderAuditReport, runAuditReport } from "./audit-report.js";
import { runBaselineRefresh } from "./baseline-refresh.js";
import { handleHook } from "./hook-control.js";
import { eventStorePath } from "./paths.js";
import { rm } from "node:fs/promises";
import { installStatusLine, uninstallStatusLine, type InstallMode, type SettingsScope } from "./settings.js";
import { readStdin } from "./status-input.js";
import { createStatusLine } from "./statusline.js";
import { renderDemo, renderInstallBanner, renderWelcome } from "./welcome.js";
import { createInterface } from "node:readline/promises";

interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
  positionals: string[];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    console.log(renderWelcome(packageVersion(), { color: shouldUseColor() }));
    return;
  }
  const args = parseArgs(argv);
  if (isVersionRequest(args)) {
    printVersion();
    return;
  }
  if (isHelpRequest(args)) {
    printHelp(helpTopic(args));
    return;
  }
  switch (args.command) {
    case "install":
      await commandInstall(args);
      break;
    case "uninstall":
      await commandUninstall(args);
      break;
    case "unlearn":
      await commandUnlearn();
      break;
    case "learn":
      await commandLearn();
      break;
    case "statusline":
      await commandStatusLine();
      break;
    case "why":
      await commandWhy();
      break;
    case "doctor":
      await commandDoctor(args);
      break;
    case "audit":
      await commandAudit(args);
      break;
    case "improve":
      await commandImprove();
      break;
    case "baseline-refresh":
      await commandBaselineRefresh(args);
      break;
    case "hook":
      await commandHook(args);
      break;
    case "demo":
      console.log(renderDemo({ color: shouldUseColor() }));
      break;
    case "help":
      printHelp();
      break;
    default:
      if (!args.command) {
        printHelp();
      } else {
        console.error(`Unknown command: ${args.command}`);
        printHelp();
        process.exitCode = 1;
      }
  }
}

async function commandInstall(args: ParsedArgs): Promise<void> {
  const shouldLearn = !args.flags["no-learn"];
  const mode = await resolveInstallMode(args);
  const result = await installStatusLine({
    scope: scopeFlag(args),
    replace: Boolean(args.flags.replace),
    hooks: true,
    mode,
    learn: shouldLearn,
    projectDir: stringFlag(args, "project"),
    homeDir: stringFlag(args, "home")
  });
  console.log(result.message);
  if (result.status === "refused") {
    process.exitCode = 1;
    return;
  }
  let baselineLine: string | undefined;
  if (!shouldLearn) {
    console.log("Personal baseline skipped (--no-learn).");
  } else {
    const baseline = await buildPersonalBaseline({ homeDir: stringFlag(args, "home"), projectDir: result.target.projectDir });
    baselineLine = baseline.message;
  }
  console.log(renderInstallBanner({ mode, baselineLine, color: shouldUseColor() }));
}

// The mode question only fires on an interactive terminal with no mode flag, so scripts, hooks,
// and CI installs keep the non-interactive coach default.
async function resolveInstallMode(args: ParsedArgs): Promise<InstallMode> {
  const explicit = installMode(args);
  if (explicit !== undefined) {
    return explicit;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return "coach";
  }
  return promptInstallMode();
}

async function promptInstallMode(): Promise<InstallMode> {
  console.log(`
One question: how much should bb step in?

  1. observe — statusline only; nothing is ever sent to Claude
  2. coach   — statusline + a short note to Claude when behavior drifts (recommended)
  3. guard   — coach, plus deny high-confidence blind validation retries
`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("Choose 1-3 [2]: ")).trim().toLowerCase();
    if (answer === "1" || answer.startsWith("o")) {
      return "observe";
    }
    if (answer === "3" || answer.startsWith("g")) {
      return "guard";
    }
    return "coach";
  } catch {
    // Stdin closed at the prompt (Ctrl+D or EOF): fall back to the non-interactive default.
    console.log("\nNo answer — using coach mode.");
    return "coach";
  } finally {
    rl.close();
  }
}

async function commandUninstall(args: ParsedArgs): Promise<void> {
  const result = await uninstallStatusLine({
    scope: scopeFlag(args),
    force: Boolean(args.flags.force),
    projectDir: stringFlag(args, "project"),
    homeDir: stringFlag(args, "home")
  });
  console.log(result.message);
  if (result.status === "refused") {
    process.exitCode = 1;
    return;
  }
  if (args.flags.purge) {
    const cleared = await clearPersonalBaseline({ homeDir: stringFlag(args, "home") });
    await rm(eventStorePath(), { force: true });
    console.log(`Purged learned data: ${cleared.message.replace(/^cleared /u, "")}, and the derived event store.`);
  }
}

async function commandUnlearn(): Promise<void> {
  console.log("`bb-cc-lite unlearn` is deprecated; folded into: bb-cc-lite uninstall --purge");
}

async function commandLearn(): Promise<void> {
  console.log("`bb-cc-lite learn` is deprecated; the baseline is built on install and refreshed automatically.");
}

async function commandStatusLine(): Promise<void> {
  try {
    const raw = await readStdin();
    process.stdout.write(`${await createStatusLine(raw, process.stdout.columns)}\n`);
  } catch {
    process.stdout.write("○ no signal · statusline crashed\n");
  }
}

async function commandBaselineRefresh(args: ParsedArgs): Promise<void> {
  const quiet = Boolean(args.flags.quiet);
  const result = await runBaselineRefresh({
    homeDir: stringFlag(args, "home"),
    projectDir: stringFlag(args, "project"),
    transcriptPath: stringFlag(args, "transcript")
  });
  if (!quiet) {
    if (result.ok && result.skipped === "disabled") {
      console.log("Baseline auto refresh disabled.");
    } else if (result.ok && result.skipped === "locked") {
      console.log("Baseline refresh already running.");
    } else if (result.ok) {
      console.log("Baseline refreshed.");
    } else {
      console.log("Could not refresh baseline.");
    }
  }
  if (!result.ok) {
    process.exitCode = 1;
  }
}

async function commandHook(args: ParsedArgs): Promise<void> {
  try {
    const fallbackEventName =
      stringFlag(args, "bb-cc-lite-hook") || args.positionals.find((value) => value !== "--bb-cc-lite-hook");
    const response = await handleHook(await readStdin(), {
      fallbackEventName,
      mode: hookMode(args),
      learn: stringFlag(args, "bb-cc-lite-learn") !== "0"
    });
    if (response) {
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  } catch {
    // Hooks are telemetry-only and must never block Claude Code.
  }
}

async function commandWhy(): Promise<void> {
  console.log("`bb-cc-lite why` is deprecated; folded into: bb-cc-lite audit (current-session view)");
}

async function commandDoctor(args: ParsedArgs): Promise<void> {
  const checks = await runDoctor({
    scope: scopeFlag(args),
    projectDir: stringFlag(args, "project"),
    homeDir: stringFlag(args, "home"),
    transcriptPath: stringFlag(args, "transcript"),
    refreshPricing: Boolean(args.flags["refresh-pricing"]),
    buildBaseline: Boolean(args.flags["build-baseline"]),
    replayBaseline: Boolean(args.flags["replay-baseline"]),
    showBaseline: Boolean(args.flags.baseline),
    clearBaseline: Boolean(args.flags["clear-baseline"])
  });
  console.log(formatDoctorChecks(checks));
  if (checks.some((check) => check.level === "FAIL")) {
    process.exitCode = 1;
  }
}

async function commandAudit(args: ParsedArgs): Promise<void> {
  validateAuditScopeFlags(args);
  if (args.flags.apply && args.flags.cleanup) {
    throw new Error("--apply cannot be combined with --cleanup");
  }
  if (args.flags.apply && args.flags.transcript) {
    throw new Error("--apply cannot be combined with --transcript");
  }
  if (args.flags.cleanup && args.flags.transcript) {
    throw new Error("--cleanup cannot be combined with --transcript");
  }
  const report = await runAuditReport({
    projectDir: stringFlag(args, "project"),
    homeDir: stringFlag(args, "home"),
    transcriptPath: stringFlag(args, "transcript"),
    allProjects: Boolean(args.flags["all-projects"]),
    recent: numberFlag(args, "recent"),
    apply: Boolean(args.flags.apply),
    cleanup: Boolean(args.flags.cleanup),
    global: Boolean(args.flags.global)
  });
  if (args.flags.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(renderAuditReport(report, { color: shouldUseColor() }));
}

async function commandImprove(): Promise<void> {
  console.log("`bb-cc-lite improve` is deprecated; folded into: bb-cc-lite audit (instruction report; --apply to write)");
}

function validateAuditScopeFlags(args: ParsedArgs): void {
  if (args.flags["all-projects"] && args.flags.transcript) {
    throw new Error("--all-projects cannot be combined with --transcript");
  }
  if (args.flags["all-projects"] && args.flags.project) {
    throw new Error("--all-projects cannot be combined with --project");
  }
}

function shouldUseColor(): boolean {
  return Boolean(process.stdout.isTTY && !process.env.NO_COLOR && process.env.BB_CC_LITE_COLOR !== "0");
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "-h") {
      flags.help = true;
      continue;
    }
    if (arg === "-v") {
      flags.version = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      flags[rawKey] = inlineValue;
      continue;
    }
    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      flags[rawKey] = next;
      index += 1;
    } else {
      flags[rawKey] = true;
    }
  }
  return { command, flags, positionals };
}

function isHelpRequest(args: ParsedArgs): boolean {
  return args.command === "help" || args.command === "--help" || args.command === "-h" || Boolean(args.flags.help);
}

function isVersionRequest(args: ParsedArgs): boolean {
  return args.command === "version" || args.command === "--version" || args.command === "-v" || Boolean(args.flags.version);
}

function helpTopic(args: ParsedArgs): string | undefined {
  if (args.command === "help") {
    return args.positionals[0];
  }
  if (args.command !== "--help" && args.command !== "-h") {
    return args.command;
  }
  return undefined;
}

function printVersion(): void {
  console.log(`bb-cc-lite ${packageVersion()}`);
}

function scopeFlag(args: ParsedArgs): SettingsScope {
  const scope = stringFlag(args, "scope") || "local";
  if (scope === "local" || scope === "project" || scope === "user") {
    return scope;
  }
  throw new Error(`Invalid --scope ${scope}; expected local, project, or user`);
}

function installMode(args: ParsedArgs): InstallMode | undefined {
  if (args.flags.guard && args.flags["observe-only"]) {
    throw new Error("--guard cannot be combined with --observe-only");
  }
  if (args.flags.guard) {
    return "guard";
  }
  if (args.flags["observe-only"]) {
    return "observe";
  }
  if (args.flags.coach) {
    return "coach";
  }
  return undefined;
}

function hookMode(args: ParsedArgs): InstallMode {
  const mode = stringFlag(args, "bb-cc-lite-mode");
  if (mode === "observe" || mode === "coach" || mode === "guard") {
    return mode;
  }
  return "coach";
}

function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}

function numberFlag(args: ParsedArgs, name: string): number | undefined {
  const value = stringFlag(args, name);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  throw new Error(`Invalid --${name} ${value}; expected a positive number`);
}

function printHelp(topic?: string): void {
  switch (topic) {
    case "audit":
      console.log(`bb-cc-lite audit

Usage:
  bb-cc-lite audit [--project <path>] [--all-projects] [--transcript <path>]
                   [--recent <count>] [--global] [--apply] [--cleanup] [--json]

audit prints three sections:
  [1] Current session - the current project's latest decision: dot, age, all findings,
      the edit ledger, and the coach/guard feedback-outcome ledger.
  [2] Recent patterns - aggregated behavioral patterns across recent local history.
  [3] Instruction report - your CLAUDE.md lines correlated against recent findings:
      removal candidates, apparently-followed lines, and gaps.

Plain audit never writes. --apply shows a diff, then writes only inside the marked
bb-cc-lite CLAUDE.md block (backup first). --cleanup removes that block (backup first).
Use --json for machine-readable output covering all three sections.
`);
      return;
    case "improve":
      console.log(`bb-cc-lite improve

improve is deprecated and folded into: bb-cc-lite audit
The instruction report replaces it; use --apply to write, --cleanup to remove the block.
`);
      return;
    case "install":
      console.log(`bb-cc-lite install

Usage:
  bb-cc-lite install [--scope local|project|user] [--observe-only] [--coach] [--guard]
                     [--replace] [--no-learn]

Installs the Claude Code statusLine and bb-owned hooks.
On an interactive terminal, install asks one question: observe, coach, or guard.
Pass --observe-only, --coach, or --guard to skip the question. Non-interactive
installs default to coach. --observe-only avoids Claude-facing feedback.
`);
      return;
    case "demo":
      console.log(`bb-cc-lite demo

Usage:
  bb-cc-lite demo

Prints the example gauge states with explanations: healthy progress, unchecked-edit
drift, retry loops, repeated reads, context pressure, and no-signal.
`);
      return;
    case "doctor":
      console.log(`bb-cc-lite doctor

Usage:
  bb-cc-lite doctor [--scope local|project|user] [--transcript <path>] [--refresh-pricing]
                    [--baseline] [--build-baseline] [--replay-baseline] [--clear-baseline]
`);
      return;
    case "why":
      console.log(`bb-cc-lite why

why is deprecated and folded into: bb-cc-lite audit
The current-session view (section 1) replaces it, correctly scoped to this project.
`);
      return;
    case "statusline":
      console.log(`bb-cc-lite statusline

Usage:
  bb-cc-lite statusline
`);
      return;
    case "unlearn":
      console.log(`bb-cc-lite unlearn

unlearn is deprecated and folded into: bb-cc-lite uninstall --purge
`);
      return;
    case "learn":
      console.log(`bb-cc-lite learn

learn is deprecated; the baseline is built on install and refreshed automatically.
`);
      return;
    case "uninstall":
      console.log(`bb-cc-lite uninstall

Usage:
  bb-cc-lite uninstall [--scope local|project|user] [--force] [--purge]

--purge also deletes learned baselines, lesson memory, and the derived event store.
`);
      return;
  }

  console.log(`bb-cc-lite

Usage:
  bb-cc-lite audit [--project <path>] [--all-projects] [--transcript <path>]
                   [--recent <count>] [--global] [--apply] [--cleanup] [--json]
  bb-cc-lite install [--scope local|project|user] [--observe-only] [--coach] [--guard]
                     [--replace] [--no-learn]
  bb-cc-lite demo
  bb-cc-lite statusline
  bb-cc-lite doctor [--scope local|project|user] [--transcript <path>] [--refresh-pricing]
                    [--baseline] [--build-baseline] [--replay-baseline] [--clear-baseline]
  bb-cc-lite uninstall [--scope local|project|user] [--force] [--purge]

Run bb-cc-lite with no arguments for a quick visual tour.

audit:
  audit [1] current session, [2] recent patterns, [3] instruction report.
  Plain audit never writes; --apply writes only the marked bb-cc-lite CLAUDE.md block
  after showing a diff, and --cleanup removes that block. Both back up first.
  --all-projects scans newest local transcripts across ~/.claude/projects.

install:
  install asks observe/coach/guard on an interactive terminal (coach otherwise)
  and builds a small local baseline by default.
  --observe-only keeps display and local telemetry without Claude-facing feedback.
  --guard enables coach feedback plus strict repeated-validation retry denial.
  install preserves an existing Claude statusLine unless --replace is passed.
  --no-learn skips baseline creation and disables lesson memory.
  uninstall --purge removes learned baselines, lesson memory, and the event store.

Deprecated (folded into audit): why, improve, learn, unlearn.
`);
}

function packageVersion(): string {
  try {
    const parsed = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim() ? parsed.version : "0.0.0-dev";
  } catch {
    return "0.0.0-dev";
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
