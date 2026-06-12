import { EDIT_DRIFT_CATEGORY } from "./findings.js";
import { formatCost } from "./signals.js";
import type { Finding, Gauge, GaugeLight } from "./types.js";

// Gauge renderer (PRD-01, branch C). Grammar: <dot> <verb> · <evidence> · <files> · <ctx> · <cost>.
// Three width tiers; the dot survives at every width. ANSI color on the dot only, with a distinct
// shape per state so the gauge reads correctly under NO_COLOR / CCVERDICT_COLOR=0.

const DEFAULT_WIDTH = 120;
const SEP = " · ";
const ESC = "";
const RESET = `${ESC}[0m`;
const HIGHLIGHT = `${ESC}[33m`;

const SHAPES: Record<GaugeLight, string> = {
  green: "●",
  blue: "◐",
  red: "■",
  gray: "○"
};

const COLORS: Record<GaugeLight, string> = {
  green: `${ESC}[32m`,
  blue: `${ESC}[34m`,
  red: `${ESC}[1;31m`,
  gray: `${ESC}[90m`
};

export function renderGauge(gauge: Gauge, width?: number): string {
  const terminalWidth = Math.max(12, Math.floor(width || DEFAULT_WIDTH));
  const candidates = candidatesForWidth(gauge, terminalWidth);
  for (const candidate of candidates) {
    if (visibleLength(candidate) <= terminalWidth) {
      return candidate;
    }
  }
  return truncate(candidates.at(-1) || dot(gauge.light), terminalWidth, gauge.light);
}

function candidatesForWidth(gauge: Gauge, width: number): string[] {
  if (width >= 80) {
    return [fullLine(gauge), compactLine(gauge), minimalLine(gauge)];
  }
  if (width >= 40) {
    return [compactLine(gauge), minimalLine(gauge)];
  }
  return [minimalLine(gauge)];
}

function fullLine(gauge: Gauge): string {
  const segments = [
    verbDisplay(gauge),
    lineEvidence(gauge),
    filesSegment(gauge),
    contextSegment(gauge),
    costSegment(gauge)
  ].filter((segment): segment is string => Boolean(segment));
  return joinWithDot(gauge.light, segments);
}

function compactLine(gauge: Gauge): string {
  const segments = [verbDisplay(gauge), uncheckedSegment(gauge), contextPercentOnly(gauge), costSegment(gauge)].filter(
    (segment): segment is string => Boolean(segment)
  );
  return joinWithDot(gauge.light, segments);
}

function minimalLine(gauge: Gauge): string {
  const parts = [uncheckedSegment(gauge), contextPercentOnly(gauge)].filter((part): part is string => Boolean(part));
  const tail = parts.length > 0 ? ` ${parts.join(" ")}` : ` ${gauge.light === "gray" ? "no signal" : gauge.activity}`;
  return `${dot(gauge.light)}${tail}`;
}

function joinWithDot(light: GaugeLight, segments: string[]): string {
  const body = segments.map(sanitizeLinePart).filter(Boolean).join(SEP);
  return body ? `${dot(light)} ${body}` : dot(light);
}

function verbDisplay(gauge: Gauge): string {
  if (gauge.light === "gray") {
    return "no signal";
  }
  const target = gauge.activityTarget ? ` ${gauge.activityTarget}` : "";
  return `${gauge.activity}${target}`;
}

function lineEvidence(gauge: Gauge): string | undefined {
  if (gauge.light === "gray") {
    return gauge.findings[0]?.evidence;
  }
  const top = gauge.findings[0];
  if (top && top.category !== EDIT_DRIFT_CATEGORY) {
    return evidenceWithHint(top);
  }
  if (gauge.activity === "idle" && gauge.light === "green") {
    return "no activity yet";
  }
  return undefined;
}

// File hints appear only at full width (grill I3, privacy: basenames only). Redundant-read
// evidence is rewritten to name the file ("same file reread 3x" -> "reread auth.ts 3x"); the
// stored evidence stays basename-free so compact/minimal tiers and the store never carry it.
function evidenceWithHint(finding: Finding): string {
  if (!finding.fileHint) {
    return finding.evidence;
  }
  const reread = finding.evidence.match(/^same file reread (.+)$/u);
  if (reread) {
    return `reread ${finding.fileHint} ${reread[1]}`;
  }
  return `${finding.evidence} (${finding.fileHint})`;
}

function filesSegment(gauge: Gauge): string | undefined {
  const { edited, unchecked, latestUncheckedBasename } = gauge.files;
  if (edited <= 0) {
    return undefined;
  }
  const fileWord = edited === 1 ? "file" : "files";
  if (unchecked <= 0) {
    return `${edited} ${fileWord}`;
  }
  const hint = latestUncheckedBasename ? ` (${latestUncheckedBasename}…)` : "";
  return `${edited} ${fileWord}, ${unchecked} unchecked${hint}`;
}

function uncheckedSegment(gauge: Gauge): string | undefined {
  return gauge.files.unchecked > 0 ? `${gauge.files.unchecked}✎?` : undefined;
}

function contextSegment(gauge: Gauge): string | undefined {
  const percent = gauge.facts.contextPercent;
  if (percent === undefined) {
    return undefined;
  }
  const text = `ctx ${percent}%`;
  return gauge.facts.contextHighlighted ? highlight(text) : text;
}

function contextPercentOnly(gauge: Gauge): string | undefined {
  const percent = gauge.facts.contextPercent;
  if (percent === undefined) {
    return undefined;
  }
  const text = `${percent}%`;
  return gauge.facts.contextHighlighted ? highlight(text) : text;
}

function costSegment(gauge: Gauge): string | undefined {
  if (gauge.facts.costUsd === undefined) {
    return undefined;
  }
  return gauge.facts.costSource === "estimated" ? `${formatCost(gauge.facts.costUsd)} est` : formatCost(gauge.facts.costUsd);
}

function dot(light: GaugeLight): string {
  return colorize(SHAPES[light], COLORS[light]);
}

// Ctx 80-91% highlights the segment (grill B5) without touching the dot. Color emphasis when color
// is on; a distinct trailing "!" marker under NO_COLOR / CCVERDICT_COLOR=0 so the early warning is
// never color-only information.
function highlight(text: string): string {
  return colorEnabled() ? `${HIGHLIGHT}${text}${RESET}` : `${text}!`;
}

function colorize(value: string, color: string): string {
  return colorEnabled() ? `${color}${value}${RESET}` : value;
}

function colorEnabled(): boolean {
  return !process.env.NO_COLOR && process.env.CCVERDICT_COLOR !== "0";
}

function visibleLength(value: string): number {
  return stripAnsi(value).length;
}

function truncate(value: string, width: number, light: GaugeLight): string {
  if (visibleLength(value) <= width) {
    return value;
  }
  const shape = SHAPES[light];
  if (width <= shape.length) {
    return dot(light);
  }
  const plain = stripAnsi(value);
  const sliced = plain.slice(0, width).trimEnd();
  return sliced.startsWith(shape) ? `${dot(light)}${sliced.slice(shape.length)}` : sliced;
}

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\[[0-9;]*m/gu, "");
}

function sanitizeLinePart(value: string): string {
  // Collapse control characters but PRESERVE ANSI escape sequences (ESC, U+001B) so the dot color
  // and the ctx highlight survive joining; width math strips ANSI separately.
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001a\u001c-\u001f\u007f]+/gu, " ").replace(/[ \t]+/gu, " ").trim();
}
