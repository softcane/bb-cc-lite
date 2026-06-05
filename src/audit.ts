import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { asRecord, numberField } from "./status-input.js";
import { parseTranscriptLines } from "./transcript.js";
import { readTranscriptTail } from "./transcript-reader.js";
import type { DecisionConfidence, DecisionState, FailureEpisodeSummary, TranscriptSummary } from "./types.js";

const DEFAULT_RECENT_SESSIONS = 30;
const DEFAULT_MAX_BYTES_PER_TRANSCRIPT = 1024 * 1024;
const MAX_FORMATTED_FINDINGS = 8;
const MAX_RETRY_DURATION_MS = 5 * 60_000;
const MAX_RETRY_COST_USD = 0.25;
const RESET = "\u001b[0m";
const COLORS = {
  title: "\u001b[1m",
  Healthy: "\u001b[32m",
  Careful: "\u001b[33m",
  Stop: "\u001b[1;31m",
  high: "\u001b[1;31m",
  medium: "\u001b[33m",
  low: "\u001b[2m"
} as const;

export interface AuditOptions {
  projectDir?: string;
  homeDir?: string;
  transcriptPath?: string;
  allProjects?: boolean;
  recent?: number;
  maxBytesPerTranscript?: number;
}

export interface AuditReport {
  scope: "project" | "all-projects" | "transcript";
  recentLimit: number;
  sessionsScanned: number;
  transcriptsFound: number;
  unreadableTranscripts: number;
  sessionsWithFindings: number;
  findings: AuditFinding[];
  repeatedRetriesSpotted: number;
  estimatedSavings: AuditSavingsEstimate;
  reportConfidence: DecisionConfidence;
  reportConfidenceReason: string;
}

export interface AuditFinding {
  session: number;
  state: DecisionState;
  confidence: DecisionConfidence;
  reasonCode: string;
  evidence: string;
  action: string;
  repeatedRetries?: number;
  estimatedDurationMs?: number;
  estimatedCostUsd?: number;
  savingsEstimateSource?: "measured" | "fallback";
}

export interface TranscriptCandidate {
  path: string;
  mtimeMs: number;
}

export interface AuditTranscriptCandidateResult {
  scope: AuditReport["scope"];
  recentLimit: number;
  candidates: TranscriptCandidate[];
}

export interface AuditSavingsEstimate {
  durationMinutes: number;
  costUsd: number;
  repeatedToolRunsAvoided: number;
  confidence: DecisionConfidence;
  basis: string;
  measured: boolean;
}

export interface FormatAuditReportOptions {
  color?: boolean;
}

export async function runAudit(options: AuditOptions = {}): Promise<AuditReport> {
  const recentLimit = normalizedRecentLimit(options.recent);
  const { candidates } = await auditTranscriptCandidates(options);
  const findings: AuditFinding[] = [];
  let unreadableTranscripts = 0;

  for (const [index, candidate] of candidates.entries()) {
    const tail = await readTranscriptTail(candidate.path, {
      maxBytes: options.maxBytesPerTranscript ?? DEFAULT_MAX_BYTES_PER_TRANSCRIPT
    });
    if (!tail.pathReadable) {
      unreadableTranscripts += 1;
      continue;
    }
    const summary = parseTranscriptLines(tail.lines, tail.bytesRead);
    if (!summary.pathReadable) {
      unreadableTranscripts += 1;
      continue;
    }
    const finding = withSavingsEstimate(findingFromSummary(summary, index + 1), summary, transcriptMeasurementFromLines(tail.lines));
    if (finding) {
      findings.push(finding);
    }
  }

  const sessionsWithFindings = new Set(findings.map((finding) => finding.session)).size;
  const repeatedRetriesSpotted = findings.reduce((total, finding) => total + (finding.repeatedRetries || 0), 0);
  const estimatedSavings = savingsEstimate(findings);
  const confidence = reportConfidence(candidates.length - unreadableTranscripts, findings);
  return {
    scope: auditScope(options),
    recentLimit,
    sessionsScanned: candidates.length - unreadableTranscripts,
    transcriptsFound: candidates.length,
    unreadableTranscripts,
    sessionsWithFindings,
    findings: sortFindings(findings),
    repeatedRetriesSpotted,
    estimatedSavings,
    reportConfidence: confidence.confidence,
    reportConfidenceReason: confidence.reason
  };
}

export async function auditTranscriptCandidates(options: AuditOptions = {}): Promise<AuditTranscriptCandidateResult> {
  const recentLimit = normalizedRecentLimit(options.recent);
  const candidates = options.transcriptPath
    ? await directTranscriptCandidate(options.transcriptPath)
    : options.allProjects
      ? await allProjectTranscriptCandidates(options.homeDir, recentLimit)
      : await projectTranscriptCandidates(options.homeDir, options.projectDir, recentLimit);
  return {
    scope: auditScope(options),
    recentLimit,
    candidates
  };
}

export function formatAuditReport(report: AuditReport, options: FormatAuditReportOptions = {}): string {
  const color = options.color === true;
  const lines: string[] = [];
  const scopeLabel =
    report.scope === "project"
      ? `project transcripts, newest ${report.recentLimit}`
      : report.scope === "all-projects"
        ? `all local project transcripts, newest ${report.recentLimit}`
        : "provided transcript";
  const summaryLines = [
    colorize("bb retrospective audit", "title", color),
    `Scope: ${scopeLabel}`,
    `Scanned: ${formatCount(report.sessionsScanned, "Claude Code session")}`
  ];
  if (report.unreadableTranscripts > 0) {
    summaryLines.push(`Skipped: ${formatCount(report.unreadableTranscripts, "unreadable transcript")}`);
  }
  summaryLines.push(`Would have helped: ${formatCount(report.sessionsWithFindings, "session")}`);
  lines.push(...box(summaryLines));
  lines.push("");

  if (report.findings.length === 0) {
    lines.push(...box(["Findings", "none in the scanned transcript window."]));
  } else {
    lines.push(...box(["Findings"]));
    lines.push("State    Conf    Evidence");
    for (const finding of report.findings.slice(0, MAX_FORMATTED_FINDINGS)) {
      const state = colorize(finding.state.padEnd(7), finding.state, color);
      const confidence = colorize(finding.confidence.padEnd(7), finding.confidence, color);
      lines.push(
        `${state} ${confidence} session ${finding.session}: ${finding.evidence}`
      );
      lines.push(`        do: ${finding.action}`);
    }
    if (report.findings.length > MAX_FORMATTED_FINDINGS) {
      lines.push(`        plus ${report.findings.length - MAX_FORMATTED_FINDINGS} more derived findings`);
    }
  }

  lines.push("");
  const evidenceLines = [`Repeated retries spotted: ${report.repeatedRetriesSpotted}`];
  if (report.estimatedSavings.measured) {
    evidenceLines.push(
      `Measured duplicate retry cost/time: ${report.estimatedSavings.durationMinutes} min, ${formatCurrency(
        report.estimatedSavings.costUsd
      )}`
    );
  } else if (report.repeatedRetriesSpotted > 0) {
    evidenceLines.push("Cost/time: not estimated; transcripts did not expose usable cost/duration metadata");
  }
  evidenceLines.push(`Report confidence: ${report.reportConfidence} - ${report.reportConfidenceReason}`);
  lines.push(...box(evidenceLines));
  lines.push("");
  lines.push(
    "Privacy: derived metadata only; no prompts, tool output, command text, file contents, raw paths, or raw session ids printed/stored."
  );
  lines.push("Install live protection:");
  lines.push("npx --yes bb-cc-lite install --scope local");
  return lines.join("\n");
}

function findingFromSummary(summary: TranscriptSummary, session: number): AuditFinding | undefined {
  const episodeFinding = findingFromEpisodes(summary.failureEpisodes || [], session);
  if (episodeFinding) {
    return episodeFinding;
  }

  if (summary.editTestLoopFailures >= 2) {
    return {
      session,
      state: "Stop",
      confidence: "high",
      reasonCode: "edit_test_retry_loop",
      evidence: `edit-test loop failed ${summary.editTestLoopFailures}x`,
      action: "inspect the failing test manually, then ask Claude for one targeted fix",
      repeatedRetries: Math.max(0, summary.editTestLoopFailures - 1)
    };
  }

  if (summary.hasUnvalidatedEdits) {
    return {
      session,
      state: "Careful",
      confidence: "medium",
      reasonCode: "edit_without_validation",
      evidence: "edits were left without validation",
      action: "ask Claude to run the smallest relevant check"
    };
  }

  if (isBusyWithoutProgress(summary)) {
    return {
      session,
      state: "Careful",
      confidence: "medium",
      reasonCode: "busy_no_observed_progress",
      evidence: `${summary.toolCalls} tool calls, no check or recovery seen`,
      action: "pause and ask Claude what changed"
    };
  }

  if (summary.compactionEvents > 0 && summary.postCompactionActivity === 0) {
    return {
      session,
      state: "Careful",
      confidence: "medium",
      reasonCode: "compaction_goal_preservation",
      evidence: "compaction event ended the scanned window",
      action: "ask Claude to restate current goal and next 3 steps"
    };
  }

  return undefined;
}

function withSavingsEstimate(
  finding: AuditFinding | undefined,
  summary: TranscriptSummary,
  measurement: TranscriptMeasurement
): AuditFinding | undefined {
  if (!finding) {
    return undefined;
  }
  const repeatedRetries = finding.repeatedRetries || 0;
  if (repeatedRetries <= 0) {
    return {
      ...finding,
      estimatedDurationMs: 0,
      estimatedCostUsd: 0,
      savingsEstimateSource: "fallback"
    };
  }
  const toolCalls = Math.max(1, summary.toolCalls);
  const measuredDurationPerRetry =
    measurement.durationMs === undefined ? undefined : clamp(measurement.durationMs / toolCalls, 0, MAX_RETRY_DURATION_MS);
  const measuredCostPerRetry =
    measurement.costUsd === undefined ? undefined : clamp(measurement.costUsd / toolCalls, 0, MAX_RETRY_COST_USD);
  const hasMeasuredSavings = measuredDurationPerRetry !== undefined || measuredCostPerRetry !== undefined;
  return {
    ...finding,
    estimatedDurationMs: measuredDurationPerRetry === undefined ? undefined : repeatedRetries * measuredDurationPerRetry,
    estimatedCostUsd: measuredCostPerRetry === undefined ? undefined : repeatedRetries * measuredCostPerRetry,
    savingsEstimateSource: hasMeasuredSavings ? "measured" : "fallback"
  };
}

function findingFromEpisodes(episodes: FailureEpisodeSummary[], session: number): AuditFinding | undefined {
  const risky = episodes
    .filter((episode) => episode.attemptCount >= 2 || episode.blindRetryFailureCount >= 2)
    .sort((left, right) => episodeScore(right) - episodeScore(left))[0];
  if (!risky) {
    return undefined;
  }

  const state: DecisionState = risky.attemptCount >= 3 || risky.blindRetryFailureCount >= 3 ? "Stop" : "Careful";
  const confidence: DecisionConfidence =
    state === "Stop" && (risky.blindRetryFailureCount >= 3 || risky.activeEnded) ? "high" : state === "Stop" ? "medium" : "medium";
  const blindRetry = risky.blindRetryFailureCount >= risky.attemptCount || risky.blindRetryFailureCount >= 2;
  return {
    session,
    state,
    confidence,
    reasonCode:
      state === "Stop" ? (blindRetry ? "blind_retry_loop" : "repeated_tool_failure") : blindRetry ? "blind_retry" : "tool_failure_repeated",
    evidence: episodeEvidence(risky, blindRetry),
    action: state === "Stop" ? "stop and inspect first failure" : "pause and inspect first failure before another retry",
    repeatedRetries: Math.max(0, Math.max(risky.attemptCount, risky.blindRetryFailureCount) - 1)
  };
}

function episodeEvidence(episode: FailureEpisodeSummary, blindRetry: boolean): string {
  const count = Math.max(episode.attemptCount, episode.blindRetryFailureCount);
  if (blindRetry) {
    return `same ${episode.label} failed ${formatFailureCount(count)} without a fix`;
  }
  if (episode.recovered) {
    return `${episode.label} failed ${formatFailureCount(count)} before recovery`;
  }
  return `${episode.label} failed ${formatFailureCount(count)} without recovery`;
}

function episodeScore(episode: FailureEpisodeSummary): number {
  const count = Math.max(episode.attemptCount, episode.blindRetryFailureCount);
  const stateScore = count >= 3 ? 100 : 50;
  const activeScore = episode.activeEnded ? 10 : 0;
  const blindScore = episode.blindRetryFailureCount >= 2 ? 5 : 0;
  return stateScore + activeScore + blindScore + count;
}

function isBusyWithoutProgress(summary: TranscriptSummary): boolean {
  const nonReadToolCalls = Math.max(0, summary.toolCalls - summary.readToolCalls);
  return (
    summary.toolCalls >= 8 &&
    nonReadToolCalls >= 6 &&
    summary.failedToolResults === 0 &&
    !summary.hasUnvalidatedEdits &&
    !hasObservedProgress(summary) &&
    !isReadHeavy(summary)
  );
}

function isReadHeavy(summary: TranscriptSummary): boolean {
  return (
    summary.toolCalls >= 4 &&
    summary.readToolCalls >= 3 &&
    summary.readToolCalls / Math.max(1, summary.toolCalls) >= 0.6 &&
    summary.failedToolResults === 0 &&
    !summary.hasUnvalidatedEdits
  );
}

function hasObservedProgress(summary: TranscriptSummary): boolean {
  return Boolean(
    summary.observedProgress ||
      summary.validationRecovered ||
      (summary.validationSuccesses || 0) > 0 ||
      (summary.toolRecoveryEvents || 0) > 0
  );
}

async function directTranscriptCandidate(path: string): Promise<TranscriptCandidate[]> {
  const mtimeMs = await readableFileMtimeMs(path);
  return mtimeMs === undefined ? [] : [{ path, mtimeMs }];
}

async function projectTranscriptCandidates(
  homeDir = homedir(),
  projectDir = process.cwd(),
  recentLimit = DEFAULT_RECENT_SESSIONS
): Promise<TranscriptCandidate[]> {
  const root = join(resolve(homeDir), ".claude", "projects", claudeProjectDirectoryName(projectDir));
  return (await listTranscriptCandidates(root))
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path))
    .slice(0, recentLimit);
}

async function allProjectTranscriptCandidates(homeDir = homedir(), recentLimit = DEFAULT_RECENT_SESSIONS): Promise<TranscriptCandidate[]> {
  const root = join(resolve(homeDir), ".claude", "projects");
  return (await listTranscriptCandidates(root))
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path))
    .slice(0, recentLimit);
}

async function listTranscriptCandidates(root: string): Promise<TranscriptCandidate[]> {
  const candidates: TranscriptCandidate[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(child);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const mtimeMs = await readableFileMtimeMs(child);
        if (mtimeMs !== undefined) {
          candidates.push({ path: child, mtimeMs });
        }
      }
    }
  }
  return candidates;
}

async function readableFileMtimeMs(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

interface TranscriptMeasurement {
  costUsd?: number;
  durationMs?: number;
}

function transcriptMeasurementFromLines(lines: string[]): TranscriptMeasurement {
  let costUsd: number | undefined;
  let durationMs: number | undefined;
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = asRecord(parsed);
    if (!entry) {
      continue;
    }
    const entryCost = costUsdFromEntry(entry);
    if (entryCost !== undefined) {
      costUsd = Math.max(costUsd ?? 0, entryCost);
    }
    const entryDuration = durationMsFromEntry(entry);
    if (entryDuration !== undefined) {
      durationMs = Math.max(durationMs ?? 0, entryDuration);
    }
  }
  return { costUsd, durationMs };
}

function costUsdFromEntry(entry: Record<string, unknown>): number | undefined {
  const cost = asRecord(entry.cost);
  return (
    numberField(cost?.total_cost_usd) ??
    numberField(cost?.totalCostUsd) ??
    numberField(cost?.cost_usd) ??
    numberField(entry.total_cost_usd) ??
    numberField(entry.costUsd)
  );
}

function durationMsFromEntry(entry: Record<string, unknown>): number | undefined {
  const cost = asRecord(entry.cost);
  return (
    numberField(cost?.total_duration_ms) ??
    numberField(cost?.totalDurationMs) ??
    numberField(entry.duration_ms) ??
    numberField(entry.durationMs)
  );
}

function savingsEstimate(findings: AuditFinding[]): AuditSavingsEstimate {
  const repeatedToolRunsAvoided = findings.reduce((total, finding) => total + (finding.repeatedRetries || 0), 0);
  const durationMs = findings.reduce((total, finding) => total + (finding.estimatedDurationMs || 0), 0);
  const costUsd = findings.reduce((total, finding) => total + (finding.estimatedCostUsd || 0), 0);
  const measuredFindings = findings.filter((finding) => finding.savingsEstimateSource === "measured").length;
  const measured = repeatedToolRunsAvoided > 0 && measuredFindings === findings.length && findings.length > 0;
  const confidence: DecisionConfidence =
    repeatedToolRunsAvoided === 0 ? "low" : measured ? "medium" : "low";
  const basis =
    repeatedToolRunsAvoided === 0
      ? "no repeated retries were found"
      : measured
        ? "time/cost used transcript metadata where Claude recorded it"
        : "time/cost not estimated because transcripts did not expose usable cost/duration metadata";
  return {
    durationMinutes: measured ? Math.round(durationMs / 60_000) : 0,
    costUsd: measured ? roundCurrency(costUsd) : 0,
    repeatedToolRunsAvoided,
    confidence,
    basis,
    measured
  };
}

function normalizedRecentLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_RECENT_SESSIONS;
  }
  return Math.max(1, Math.floor(value));
}

function auditScope(options: AuditOptions): AuditReport["scope"] {
  if (options.transcriptPath) {
    return "transcript";
  }
  return options.allProjects ? "all-projects" : "project";
}

function claudeProjectDirectoryName(projectDir: string): string {
  return resolve(projectDir).replaceAll(/[\\/]/gu, "-");
}

function sortFindings(findings: AuditFinding[]): AuditFinding[] {
  return [...findings].sort((left, right) => findingScore(right) - findingScore(left) || left.session - right.session);
}

function findingScore(finding: AuditFinding): number {
  const stateScore = finding.state === "Stop" ? 100 : finding.state === "Careful" ? 50 : 0;
  const confidenceScore = finding.confidence === "high" ? 10 : finding.confidence === "medium" ? 5 : 0;
  return stateScore + confidenceScore + (finding.repeatedRetries || 0);
}

function reportConfidence(
  sessionsScanned: number,
  findings: AuditFinding[]
): { confidence: DecisionConfidence; reason: string } {
  if (sessionsScanned === 0) {
    return { confidence: "low", reason: "no local Claude Code transcripts were found for this scope" };
  }
  if (findings.some((finding) => finding.confidence === "high" && finding.state === "Stop")) {
    return { confidence: "high", reason: "high-signal repeated failure patterns were found in scanned transcripts" };
  }
  if (findings.length > 0) {
    return { confidence: "medium", reason: "moderate risk patterns were found, but retrospective replay cannot prove outcome changes" };
  }
  if (sessionsScanned >= 10) {
    return { confidence: "medium", reason: "enough sessions were scanned, but no risky patterns surfaced" };
  }
  return { confidence: "low", reason: "small scanned sample and no risky patterns surfaced" };
}

function formatFailureCount(count: number): string {
  return count === 2 ? "twice" : `${count}x`;
}

function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatCurrency(value: number): string {
  return `$${value.toFixed(2)}`;
}

function roundCurrency(value: number): number {
  return Number(value.toFixed(2));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function box(lines: string[]): string[] {
  const width = Math.max(...lines.map(visibleLength), 0);
  const border = `+${"-".repeat(width + 2)}+`;
  return [border, ...lines.map((line) => `| ${line}${" ".repeat(width - visibleLength(line))} |`), border];
}

function colorize(value: string, key: keyof typeof COLORS, enabled: boolean): string {
  return enabled ? `${COLORS[key]}${value}${RESET}` : value;
}

function visibleLength(value: string): number {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;]*m/gu, "").length;
}
