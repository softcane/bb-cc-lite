#!/usr/bin/env node
import {
  buildPersonalBaseline,
  clearPersonalBaseline,
  formatDoctorChecks,
  runDoctor
} from "./doctor.js";
import { runBaselineRefresh } from "./baseline-refresh.js";
import { parseHookPayload } from "./hook-payload.js";
import { installStatusLine, uninstallStatusLine, type SettingsScope } from "./settings.js";
import { readStdin } from "./status-input.js";
import { createStatusLine } from "./statusline.js";
import { recordHookEvent } from "./store.js";
import { formatWhy, getWhyDecision } from "./why.js";

interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
  positionals: string[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "install":
      await commandInstall(args);
      break;
    case "uninstall":
      await commandUninstall(args);
      break;
    case "unlearn":
      await commandUnlearn(args);
      break;
    case "statusline":
      await commandStatusLine();
      break;
    case "why":
      await commandWhy(args);
      break;
    case "doctor":
      await commandDoctor(args);
      break;
    case "baseline-refresh":
      await commandBaselineRefresh(args);
      break;
    case "hook":
      await commandHook(args);
      break;
    case "help":
    case "--help":
    case "-h":
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
  const result = await installStatusLine({
    scope: scopeFlag(args),
    replace: Boolean(args.flags.replace),
    hooks: Boolean(args.flags.hooks),
    projectDir: stringFlag(args, "project"),
    homeDir: stringFlag(args, "home")
  });
  console.log(result.message);
  if (result.status === "refused") {
    process.exitCode = 1;
    return;
  }
  if (!shouldLearn) {
    console.log("Personal baseline skipped (--no-learn).");
    return;
  }
  const baseline = await buildPersonalBaseline({ homeDir: stringFlag(args, "home"), projectDir: result.target.projectDir });
  console.log(baseline.message);
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
  }
}

async function commandUnlearn(args: ParsedArgs): Promise<void> {
  const result = await clearPersonalBaseline({ homeDir: stringFlag(args, "home") });
  console.log(result.message.replace(/^cleared/u, "Cleared") + ".");
}

async function commandStatusLine(): Promise<void> {
  try {
    const raw = await readStdin();
    process.stdout.write(`${await createStatusLine(raw, process.stdout.columns)}\n`);
  } catch {
    process.stdout.write("bb: Careful | statusline crashed | run bb-cc-lite doctor\n");
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
    const event = parseHookPayload(await readStdin(), fallbackEventName);
    if (event) {
      await recordHookEvent(event);
    }
  } catch {
    // Hooks are telemetry-only and must never block Claude Code.
  }
}

async function commandWhy(args: ParsedArgs): Promise<void> {
  const decision = await getWhyDecision({ sessionId: stringFlag(args, "session") });
  if (args.flags.json) {
    console.log(JSON.stringify(decision || null, null, 2));
    return;
  }
  if (!decision) {
    console.log("No bb-cc-lite decision has been recorded yet. Run the statusline command from Claude Code first.");
    return;
  }
  console.log(formatWhy(decision));
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

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
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

function scopeFlag(args: ParsedArgs): SettingsScope {
  const scope = stringFlag(args, "scope") || "local";
  if (scope === "local" || scope === "project" || scope === "user") {
    return scope;
  }
  throw new Error(`Invalid --scope ${scope}; expected local, project, or user`);
}

function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}

function printHelp(): void {
  console.log(`bb-cc-lite

Usage:
  bb-cc-lite install [--scope local|project|user] [--hooks]
                     [--no-learn]
  bb-cc-lite statusline
  bb-cc-lite why [--session <id>] [--json]
  bb-cc-lite doctor [--scope local|project|user] [--transcript <path>] [--refresh-pricing]
                    [--baseline] [--build-baseline] [--replay-baseline] [--clear-baseline]
  bb-cc-lite unlearn
  bb-cc-lite uninstall [--scope local|project|user] [--force]

Learning:
  install builds a small local baseline by default.
  install preserves an existing Claude statusLine unless --replace is passed.
  --no-learn skips baseline creation.
  doctor --baseline shows a safe aggregate summary, including recent and validation categories.
  doctor --build-baseline refreshes the baseline.
  doctor --replay-baseline evaluates aggregate holdout metrics from local JSONL history.
  doctor --clear-baseline and unlearn remove learned baselines.
`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
