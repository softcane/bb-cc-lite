#!/usr/bin/env node
import { formatDoctorChecks, runDoctor } from "./doctor.js";
import { mergeHookSummary, parseHookPayload } from "./hooks.js";
import { hashValue } from "./paths.js";
import { estimateCostUsd, loadPricing } from "./pricing.js";
import { renderStatusLine } from "./renderer.js";
import { decide } from "./signals.js";
import { installStatusLine, uninstallStatusLine, type SettingsScope } from "./settings.js";
import { parseStatusLineInput, readStdin, mergeUsage } from "./status-input.js";
import { hookSummary, latestDecision, recordDecision, recordHookEvent } from "./store.js";
import { parseTranscriptTail } from "./transcript.js";
import type { Decision } from "./types.js";

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
  if (result.status === "skipped") {
    console.log(`Manual replace: bb-cc-lite install --scope ${result.target.scope} --replace`);
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
  }
}

async function commandStatusLine(): Promise<void> {
  try {
    const raw = await readStdin();
    const input = parseStatusLineInput(raw);
    const sessionKey = hashValue(input.sessionId);
    const transcript = mergeHookSummary(
      await parseTranscriptTail(input.transcriptPath),
      sessionKey
        ? await hookSummary(sessionKey)
        : {
            failedToolResults: 0,
            toolCalls: 0,
            compactionEvents: 0,
            repeatedFailures: []
          }
    );
    const usage = mergeUsage(input.usage, transcript.usage);
    if (input.costUsd === undefined) {
      const estimated = estimateCostUsd(input.model.id || input.model.displayName, usage, await loadPricing());
      if (estimated !== undefined) {
        input.costUsd = estimated;
        input.costSource = "estimated";
      }
    }
    const previous = sessionKey ? await latestDecision(sessionKey) : undefined;
    const decision = decide(input, transcript, { previous });
    await recordDecision(decision);
    const width = input.terminalWidth || process.stdout.columns;
    process.stdout.write(`${renderStatusLine(decision, width)}\n`);
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
  const sessionKey = stringFlag(args, "session") ? hashValue(stringFlag(args, "session")) : undefined;
  const decision = await latestDecision(sessionKey);
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
    refreshPricing: Boolean(args.flags["refresh-pricing"])
  });
  console.log(formatDoctorChecks(checks));
  if (checks.some((check) => check.level === "FAIL")) {
    process.exitCode = 1;
  }
}

function formatWhy(decision: Decision): string {
  const cost =
    decision.costUsd === undefined
      ? ""
      : `\nCost evidence: ${decision.costSource === "estimated" ? "estimated " : ""}$${decision.costUsd.toFixed(4)}.`;
  return [
    `Last decision: ${decision.state}.`,
    `Reason: ${decision.primaryEvidence}. ${decision.impact}.`,
    `Next action: ${decision.action}.${cost}`
  ].join("\n");
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
  bb-cc-lite install [--scope local|project|user] [--replace] [--hooks]
  bb-cc-lite statusline
  bb-cc-lite why [--json]
  bb-cc-lite doctor [--scope local|project|user] [--transcript <path>] [--refresh-pricing]
  bb-cc-lite uninstall [--scope local|project|user]
`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
