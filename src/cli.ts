#!/usr/bin/env node
import {
  buildPersonalBaseline,
  clearPersonalBaseline,
  formatDoctorChecks,
  PERSONAL_BASELINE_DISCLOSURE,
  runDoctor
} from "./doctor.js";
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
  if (result.command) {
    console.log(`Command: ${result.command}`);
  }
  if (!shouldLearn) {
    console.log("Skipped personal baseline learning because --no-learn was passed.");
    return;
  }
  console.log(PERSONAL_BASELINE_DISCLOSURE);
  const baseline = await buildPersonalBaseline({ homeDir: stringFlag(args, "home") });
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
  await clearPersonalBaseline({ homeDir: stringFlag(args, "home") });
  console.log("Cleared personal baseline.");
}

async function commandStatusLine(): Promise<void> {
  try {
    const raw = await readStdin();
    process.stdout.write(`${await createStatusLine(raw, process.stdout.columns)}\n`);
  } catch {
    process.stdout.write("bb: Careful | statusline crashed | run bb-cc-lite doctor\n");
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
                    [--baseline] [--build-baseline] [--clear-baseline]
  bb-cc-lite unlearn
  bb-cc-lite uninstall [--scope local|project|user] [--force]

Learning:
  install builds a local personal baseline from Claude JSONL by default.
  install replaces an existing Claude statusLine and backs it up for uninstall.
  learning scans newest eligible JSONL first with capped 512 KiB tails and bounded reads.
  --no-learn skips that scan.
  doctor --baseline shows a safe aggregate summary, including recent and validation categories.
  doctor --build-baseline refreshes the baseline.
  doctor --clear-baseline and unlearn remove only the baseline.
`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
