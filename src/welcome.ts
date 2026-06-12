import { renderGauge } from "./gauge-renderer.js";
import type { Gauge, GaugeLight } from "./types.js";

// Friendly CLI screens: the no-arg welcome, the `demo` walkthrough, and the post-install banner.
// These are presentation-only; every gauge line shown here goes through the real renderer so the
// demo never drifts from what the statusline actually prints.

const ESC = "\u001b";
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const CYAN = `${ESC}[36m`;

const DOT_COLORS: Record<GaugeLight, string> = {
  green: `${ESC}[32m`,
  blue: `${ESC}[34m`,
  red: `${ESC}[1;31m`,
  gray: `${ESC}[90m`
};

const DOT_SHAPES: Record<GaugeLight, string> = {
  green: "●",
  blue: "◐",
  red: "■",
  gray: "○"
};

export const DOT_LEGEND: ReadonlyArray<{ light: GaugeLight; label: string; meaning: string }> = [
  { light: "green", label: "progressing", meaning: "behavior looks healthy" },
  { light: "blue", label: "drifting", meaning: "check the session when you have a moment" },
  { light: "red", label: "intervene", meaning: "retry loop, repeated failure, or critical context pressure" },
  { light: "gray", label: "no signal", meaning: "ccverdict cannot read the evidence" }
];

interface DemoState {
  gauge: Gauge;
  caption: string;
}

function demoGauge(partial: Pick<Gauge, "light" | "activity"> & Partial<Gauge>): Gauge {
  return {
    files: { edited: 0, unchecked: 0 },
    facts: {},
    findings: [],
    createdAt: new Date(0).toISOString(),
    ...partial
  };
}

function demoStates(): DemoState[] {
  return [
    {
      gauge: demoGauge({
        light: "green",
        activity: "editing",
        files: { edited: 1, unchecked: 1, latestUncheckedBasename: "auth.ts" },
        facts: { contextPercent: 42, costUsd: 0.18, costSource: "claude" }
      }),
      caption: "healthy progress, one edit awaiting a check"
    },
    {
      gauge: demoGauge({
        light: "blue",
        activity: "editing",
        files: { edited: 3, unchecked: 2, latestUncheckedBasename: "auth.ts" },
        facts: { contextPercent: 44 }
      }),
      caption: "edits piling up without a passing check"
    },
    {
      gauge: demoGauge({
        light: "red",
        activity: "retrying",
        activityTarget: "tests",
        findings: [
          { category: "blind-retry", severity: "red", confidence: "high", evidence: "3 fails, no fix between runs" }
        ]
      }),
      caption: "stuck: rerunning failing tests without a fix"
    },
    {
      gauge: demoGauge({
        light: "red",
        activity: "exploring",
        findings: [
          {
            category: "redundant-read",
            severity: "red",
            confidence: "high",
            evidence: "same file reread 3x",
            fileHint: "config.ts"
          }
        ]
      }),
      caption: "rereading the same unchanged file"
    },
    {
      gauge: demoGauge({
        light: "green",
        activity: "exploring",
        facts: { contextPercent: 85, contextHighlighted: true }
      }),
      caption: "early warning: context window filling up"
    },
    {
      gauge: demoGauge({
        light: "gray",
        activity: "idle",
        findings: [
          { category: "no-signal", severity: "info", confidence: "high", evidence: "transcript unreadable" }
        ]
      }),
      caption: "ccverdict cannot see the evidence right now"
    }
  ];
}

export interface ScreenOptions {
  color: boolean;
}

export function renderWelcome(version: string, options: ScreenOptions): string {
  const c = palette(options.color);
  const lines: string[] = [];
  lines.push(`${c.bold(`ccverdict ${version}`)} — a behavioral gauge for Claude Code`);
  lines.push("");
  lines.push("Most statuslines show facts: model, branch, tokens.");
  lines.push("ccverdict watches how the agent behaves and shows a verdict:");
  lines.push("");
  lines.push(...demoLines(options, "  "));
  lines.push("");
  lines.push(c.bold("Get started:"));
  lines.push(...commandList(c, [
    ["npx ccverdict install --scope local", "set up the statusline for this repo"],
    ["npx ccverdict audit --project .", "try it on your history first — installs nothing"],
    ["npx ccverdict demo", "replay these example states with explanations"],
    ["npx ccverdict help", "full usage"]
  ]));
  return lines.join("\n");
}

export function renderDemo(options: ScreenOptions): string {
  const c = palette(options.color);
  const lines: string[] = [];
  lines.push(c.bold("ccverdict demo — the states the gauge moves through"));
  lines.push("");
  for (const state of demoStates()) {
    lines.push(`  ${renderDemoGauge(state.gauge, options)}`);
    lines.push(`  ${c.dim(state.caption)}`);
    lines.push("");
  }
  lines.push("Dot legend:");
  lines.push(...legendLines(options, "  "));
  lines.push("");
  lines.push("The dot has a shape per state, so the gauge stays readable without color.");
  return lines.join("\n");
}

export interface InstallBannerOptions extends ScreenOptions {
  mode: "observe" | "coach" | "guard";
  baselineLine?: string;
}

export function renderInstallBanner(options: InstallBannerOptions): string {
  const c = palette(options.color);
  const modeLine: Record<InstallBannerOptions["mode"], string> = {
    observe: "Observe mode: ccverdict stays silent toward Claude — gauge and local history only.",
    coach: "Coach mode: when behavior drifts, ccverdict sends Claude a short corrective note.",
    guard: "Guard mode: coach notes, plus ccverdict denies high-confidence blind validation retries."
  };
  const lines: string[] = [];
  lines.push("");
  lines.push(c.bold(`${check(options)} ccverdict is watching this project (${options.mode} mode)`));
  if (options.baselineLine) {
    lines.push(`  ${options.baselineLine}`);
  }
  lines.push("");
  lines.push("  Your statusline judges behavior, not just facts:");
  lines.push(...legendLines(options, "    "));
  lines.push("");
  lines.push("  You'll see lines like:");
  lines.push(`    ${renderDemoGauge(demoStates()[2].gauge, options)}`);
  lines.push("");
  lines.push(`  ${modeLine[options.mode]}`);
  lines.push("");
  lines.push(`  ${c.bold("Next:")} restart Claude Code in this project — the gauge appears at the bottom.`);
  lines.push(`  ${c.bold("Try:")}  npx ccverdict audit --project .   ${c.dim("(what ccverdict would have flagged already)")}`);
  return lines.join("\n");
}

function demoLines(options: ScreenOptions, indent: string): string[] {
  const c = palette(options.color);
  const states = demoStates();
  const rendered = states.map((state) => renderDemoGauge(state.gauge, options));
  const widest = Math.max(...rendered.map((line) => visibleLength(line)));
  return rendered.map((line, index) => {
    const padding = " ".repeat(widest - visibleLength(line) + 3);
    return `${indent}${line}${padding}${c.dim(states[index].caption)}`;
  });
}

function legendLines(options: ScreenOptions, indent: string): string[] {
  const c = palette(options.color);
  return DOT_LEGEND.map(({ light, label, meaning }) => {
    const dot = options.color ? `${DOT_COLORS[light]}${DOT_SHAPES[light]}${RESET}` : DOT_SHAPES[light];
    return `${indent}${dot} ${label.padEnd(11)} ${c.dim(`— ${meaning}`)}`;
  });
}

function commandList(c: Palette, entries: Array<[string, string]>): string[] {
  const widest = Math.max(...entries.map(([command]) => command.length));
  return entries.map(([command, caption]) => `  ${c.cyan(command.padEnd(widest))}   ${c.dim(caption)}`);
}

// The renderer reads color preference from the environment (it normally runs inside Claude Code,
// not a TTY). For CLI screens the TTY decides, so force the renderer's no-color path when the
// screen is plain — that also yields the exact NO_COLOR variants, like the trailing "!" marker.
function renderDemoGauge(gauge: Gauge, options: ScreenOptions): string {
  if (options.color) {
    return renderGauge(gauge, 120);
  }
  const previous = process.env.CCVERDICT_COLOR;
  process.env.CCVERDICT_COLOR = "0";
  try {
    return renderGauge(gauge, 120);
  } finally {
    if (previous === undefined) {
      delete process.env.CCVERDICT_COLOR;
    } else {
      process.env.CCVERDICT_COLOR = previous;
    }
  }
}

function check(options: ScreenOptions): string {
  return options.color ? `${ESC}[32m✔${RESET}` : "✔";
}

interface Palette {
  bold: (value: string) => string;
  dim: (value: string) => string;
  cyan: (value: string) => string;
}

function palette(color: boolean): Palette {
  if (!color) {
    const plain = (value: string): string => value;
    return { bold: plain, dim: plain, cyan: plain };
  }
  return {
    bold: (value) => `${BOLD}${value}${RESET}`,
    dim: (value) => `${DIM}${value}${RESET}`,
    cyan: (value) => `${CYAN}${value}${RESET}`
  };
}

function visibleLength(value: string): number {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;]*m/gu, "").length;
}
