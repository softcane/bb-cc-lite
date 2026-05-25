import type { DecisionPresentation } from "./decision-presentation.js";

const DEFAULT_WIDTH = 120;
const RESET = "\u001b[0m";
const COLORS: Record<DecisionPresentation["state"], string> = {
  Healthy: "\u001b[32m",
  Careful: "\u001b[33m",
  Stop: "\u001b[1;31m"
};

export function renderStatusLine(decision: DecisionPresentation, width?: number): string {
  const terminalWidth = Math.max(20, Math.floor(width || DEFAULT_WIDTH));
  const candidates = decision.state === "Stop" ? stopCandidates(decision) : defaultCandidates(decision);

  for (const candidate of candidates.map(joinParts)) {
    if (visibleLength(candidate) <= terminalWidth) {
      return colorizeState(candidate, decision.state);
    }
  }

  return colorizeState(truncate(joinParts(candidates.at(-1) || [`bb: ${decision.state}`]), terminalWidth), decision.state);
}

function defaultCandidates(decision: DecisionPresentation): string[][] {
  const evidence = decision.evidence.map((item) => item.label);
  const headline = decision.diagnosis || decision.primaryEvidence;
  const badge = decision.baselineNote || "";
  const feedbackNote = decision.feedbackNote || "";
  if (decision.diagnosis) {
    return [
      [`bb: ${decision.state}`, headline, badge, feedbackNote, decision.action],
      [`bb: ${decision.state}`, headline, feedbackNote, decision.action],
      [`bb: ${decision.state}`, headline]
    ];
  }
  return [
    [`bb: ${decision.state}`, headline, badge, feedbackNote, ...evidence.filter((item) => item !== headline), decision.action],
    [`bb: ${decision.state}`, headline, feedbackNote, decision.action],
    [`bb: ${decision.state}`, headline]
  ];
}

function stopCandidates(decision: DecisionPresentation): string[][] {
  const costEvidence = decision.evidence.filter((item) => item.detail).map((item) => item.label);
  const headline = decision.diagnosis || decision.primaryEvidence;
  const feedbackNote = decision.feedbackNote ? `; ${decision.feedbackNote}` : "";
  const fullWhy =
    decision.impact && decision.impact !== headline ? `why: ${headline}; ${decision.impact}${feedbackNote}` : `why: ${headline}${feedbackNote}`;
  const shortWhy = `why: ${headline}`;
  const action = `do: ${decision.action}`;
  return [
    [`bb: ${decision.state}`, fullWhy, ...costEvidence, action],
    [`bb: ${decision.state}`, shortWhy, action],
    [`bb: ${decision.state}`, shortWhy]
  ];
}

function joinParts(parts: string[]): string {
  return parts.filter(Boolean).map(sanitizeLinePart).join(" | ");
}

function visibleLength(value: string): number {
  // ANSI escape stripping is needed before width checks.
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;]*m/gu, "").length;
}

function truncate(value: string, width: number): string {
  if (visibleLength(value) <= width) {
    return value;
  }
  if (width <= 3) {
    return value.slice(0, width);
  }
  return `${value.slice(0, width - 3).trimEnd()}...`;
}

function sanitizeLinePart(value: string): string {
  // Collapse control characters before joining statusline segments.
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function colorizeState(value: string, state: DecisionPresentation["state"]): string {
  if (process.env.NO_COLOR || process.env.BB_CC_LITE_COLOR === "0") {
    return value;
  }
  const prefix = `bb: ${state}`;
  if (!value.startsWith(prefix)) {
    return value;
  }
  return `${COLORS[state]}${prefix}${RESET}${value.slice(prefix.length)}`;
}
