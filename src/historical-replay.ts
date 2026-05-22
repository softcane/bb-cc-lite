import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  extractFailureEpisodesFromTranscriptLines,
  extractSafeToolResultEventsFromTranscriptLines,
  type SafeToolResultEvent
} from "./failure-episodes.js";
import { asRecord, numberField } from "./status-input.js";
import {
  addFailureEpisodeToRecoveryCounters,
  blindRetryAggregatesFromCounters,
  emptyRecoveryBuildCounters,
  FAILURE_RECOVERY_CATEGORIES,
  recoveryAggregatesFromCounters,
  recoveryInsight,
  type FailureRecoveryCategory
} from "./recovery-stats.js";
import { readTranscriptTail } from "./transcript-reader.js";
import type { DecisionPersonalBaseline, FailureEpisodeSummary } from "./types.js";

const DEFAULT_MAX_FILES = 1500;
const DEFAULT_MAX_BYTES_PER_TRANSCRIPT = 1024 * 1024;
const DEFAULT_HOLDOUT_RATIO = 0.2;

export interface HistoricalReplayOptions {
  homeDir?: string;
  claudeProjectsDir?: string;
  maxFiles?: number;
  maxBytesPerTranscript?: number;
  holdoutRatio?: number;
}

export interface HistoricalReplayMetrics {
  sessionsEvaluated: number;
  holdoutSessions: number;
  evaluatedFailureEpisodes: number;
  warnings: number;
  stopPrecisionOnUnrecoveredEpisodes: number | undefined;
  falseStopCount: number;
  falseStopCountOnRecoveredEpisodes: number;
  missedUnrecoveredLoopCount: number;
  blindRetryPrecision: number | undefined;
  averageAttemptsBeforeWarning: number;
  averageToolResultsBeforeWarning: number;
  averageCostBeforeWarning: number | undefined;
  averageDurationBeforeWarning: number | undefined;
  projectBaselineSuppressions: number | undefined;
  lowSampleSuppressions: number;
  categoryCoverage: Partial<Record<FailureRecoveryCategory, number>>;
}

interface ReplayToolResultEvent extends SafeToolResultEvent {
  costUsd?: number;
  durationMs?: number;
}

interface TranscriptCandidate {
  path: string;
  mtimeMs: number;
}

interface ReplayEpisode {
  identity: string;
  category: FailureRecoveryCategory;
  attemptCount: number;
  blindRunCount: number;
  maxBlindRunCount: number;
  meaningfulInterventionSinceFailure: boolean;
  warningAttempt?: number;
  stopIssued: boolean;
  blindRetryWarningIssued: boolean;
  warningToolResultCount?: number;
  warningCostUsd?: number;
  warningDurationMs?: number;
}

interface ReplayOutcome {
  category: FailureRecoveryCategory;
  attemptCount: number;
  recovered: boolean;
  warningAttempt?: number;
  warningToolResultCount?: number;
  warningCostUsd?: number;
  warningDurationMs?: number;
  stopIssued: boolean;
  blindRetryWarningIssued: boolean;
}

export async function evaluateHistoricalReplay(options: HistoricalReplayOptions = {}): Promise<HistoricalReplayMetrics> {
  const homeDir = options.homeDir ?? homedir();
  const claudeProjectsDir = options.claudeProjectsDir ?? join(homeDir, ".claude", "projects");
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytesPerTranscript = options.maxBytesPerTranscript ?? DEFAULT_MAX_BYTES_PER_TRANSCRIPT;
  const files = await listTranscriptFiles(claudeProjectsDir, maxFiles);
  const holdoutCount = holdoutSessionCount(files.length, options.holdoutRatio ?? DEFAULT_HOLDOUT_RATIO);
  const holdoutFiles = files.slice(0, holdoutCount);
  const trainingFiles = files.slice(holdoutCount);
  const trainingEpisodes = await readEpisodes(trainingFiles, maxBytesPerTranscript);
  const holdoutEventsBySession = await readEventsBySession(holdoutFiles, maxBytesPerTranscript);
  const baseline = baselineFromEpisodes(trainingEpisodes);
  return evaluateHoldout(holdoutEventsBySession, baseline);
}

export function formatHistoricalReplayMetrics(metrics: HistoricalReplayMetrics): string {
  return [
    `sessions evaluated ${metrics.sessionsEvaluated}`,
    `holdout sessions ${metrics.holdoutSessions}`,
    `warnings ${metrics.warnings}`,
    `evaluated failure episodes ${metrics.evaluatedFailureEpisodes}`,
    `Stop precision on unrecovered episodes ${formatMetricRate(metrics.stopPrecisionOnUnrecoveredEpisodes)}`,
    `false Stop count ${metrics.falseStopCount}`,
    `false Stop count on recovered episodes ${metrics.falseStopCountOnRecoveredEpisodes}`,
    `missed unrecovered loop count ${metrics.missedUnrecoveredLoopCount}`,
    `blind retry precision ${formatMetricRate(metrics.blindRetryPrecision)}`,
    `average attempts before warning ${metrics.averageAttemptsBeforeWarning.toFixed(2)}`,
    `average tool results before warning ${metrics.averageToolResultsBeforeWarning.toFixed(2)}`,
    `average cost before warning ${formatOptionalCurrencyAverage(metrics.averageCostBeforeWarning)}`,
    `average duration before warning ${formatOptionalDurationAverage(metrics.averageDurationBeforeWarning)}`,
    `project-baseline suppressions ${metrics.projectBaselineSuppressions === undefined ? "n/a (not replayed)" : metrics.projectBaselineSuppressions}`,
    `low-sample suppressions ${metrics.lowSampleSuppressions}`,
    `category coverage ${formatCategoryCoverage(metrics.categoryCoverage)}`
  ].join("; ");
}

function evaluateHoldout(
  holdoutEventsBySession: ReplayToolResultEvent[][],
  baseline: DecisionPersonalBaseline
): HistoricalReplayMetrics {
  let evaluatedFailureEpisodes = 0;
  let stopTruePositive = 0;
  let stopTotal = 0;
  let falseStopCountOnRecoveredEpisodes = 0;
  let missedUnrecoveredLoopCount = 0;
  let blindRetryTruePositive = 0;
  let blindRetryTotal = 0;
  let lowSampleSuppressions = 0;
  let warnings = 0;
  const attemptsBeforeWarning: number[] = [];
  const toolResultsBeforeWarning: number[] = [];
  const costBeforeWarning: number[] = [];
  const durationBeforeWarning: number[] = [];
  const categoryCoverage: Partial<Record<FailureRecoveryCategory, number>> = {};

  for (const events of holdoutEventsBySession) {
    const replay = replaySession(events, baseline);
    lowSampleSuppressions += replay.lowSampleSuppressions;
    for (const outcome of replay.outcomes) {
      evaluatedFailureEpisodes += 1;
      categoryCoverage[outcome.category] = (categoryCoverage[outcome.category] || 0) + 1;
      if (outcome.warningAttempt !== undefined) {
        warnings += 1;
        attemptsBeforeWarning.push(outcome.warningAttempt);
        if (outcome.warningToolResultCount !== undefined) {
          toolResultsBeforeWarning.push(outcome.warningToolResultCount);
        }
        if (outcome.warningCostUsd !== undefined) {
          costBeforeWarning.push(outcome.warningCostUsd);
        }
        if (outcome.warningDurationMs !== undefined) {
          durationBeforeWarning.push(outcome.warningDurationMs);
        }
      }

      if (outcome.stopIssued) {
        stopTotal += 1;
        if (outcome.recovered) {
          falseStopCountOnRecoveredEpisodes += 1;
        } else {
          stopTruePositive += 1;
        }
      }

      const unrecoveredLoop = !outcome.recovered && outcome.attemptCount >= 3;
      if (unrecoveredLoop && !outcome.stopIssued) {
        missedUnrecoveredLoopCount += 1;
      }

      if (outcome.blindRetryWarningIssued) {
        blindRetryTotal += 1;
        if (!outcome.recovered) {
          blindRetryTruePositive += 1;
        }
      }
    }
  }

  return {
    sessionsEvaluated: holdoutEventsBySession.length,
    holdoutSessions: holdoutEventsBySession.length,
    evaluatedFailureEpisodes,
    warnings,
    stopPrecisionOnUnrecoveredEpisodes: stopTotal > 0 ? roundRate(stopTruePositive / stopTotal) : undefined,
    falseStopCount: falseStopCountOnRecoveredEpisodes,
    falseStopCountOnRecoveredEpisodes,
    missedUnrecoveredLoopCount,
    blindRetryPrecision: blindRetryTotal > 0 ? roundRate(blindRetryTruePositive / blindRetryTotal) : undefined,
    averageAttemptsBeforeWarning:
      attemptsBeforeWarning.length > 0
        ? Number((attemptsBeforeWarning.reduce((total, value) => total + value, 0) / attemptsBeforeWarning.length).toFixed(2))
        : 0,
    averageToolResultsBeforeWarning:
      toolResultsBeforeWarning.length > 0
        ? Number((toolResultsBeforeWarning.reduce((total, value) => total + value, 0) / toolResultsBeforeWarning.length).toFixed(2))
        : 0,
    averageCostBeforeWarning: averageOrUndefined(costBeforeWarning),
    averageDurationBeforeWarning: averageOrUndefined(durationBeforeWarning),
    projectBaselineSuppressions: undefined,
    lowSampleSuppressions,
    categoryCoverage
  };
}

function replaySession(
  events: ReplayToolResultEvent[],
  baseline: DecisionPersonalBaseline
): { outcomes: ReplayOutcome[]; lowSampleSuppressions: number } {
  const active = new Map<string, ReplayEpisode>();
  const outcomes: ReplayOutcome[] = [];
  let lowSampleSuppressions = 0;

  for (const [index, event] of events.entries()) {
    const toolResultCount = index + 1;
    if (event.outcome === "success") {
      const sameIdentityEpisode = active.get(event.identity);
      if (sameIdentityEpisode) {
        outcomes.push(toReplayOutcome(sameIdentityEpisode, true));
        active.delete(event.identity);
      }
      if (event.isEdit || event.isValidation) {
        for (const episode of active.values()) {
          episode.meaningfulInterventionSinceFailure = true;
        }
      }
      continue;
    }

    const episode = active.get(event.identity) || {
      identity: event.identity,
      category: event.category,
      attemptCount: 0,
      blindRunCount: 0,
      maxBlindRunCount: 0,
      meaningfulInterventionSinceFailure: false,
      stopIssued: false,
      blindRetryWarningIssued: false
    };
    if (episode.attemptCount === 0 || episode.meaningfulInterventionSinceFailure) {
      episode.blindRunCount = 1;
    } else {
      episode.blindRunCount += 1;
    }
    episode.attemptCount += 1;
    episode.maxBlindRunCount = Math.max(episode.maxBlindRunCount, episode.blindRunCount);
    episode.meaningfulInterventionSinceFailure = false;

    const currentState = replayDecisionState(episode);
    if (currentState !== "Healthy" && episode.warningAttempt === undefined) {
      episode.warningAttempt = episode.attemptCount;
      episode.warningToolResultCount = toolResultCount;
      episode.warningCostUsd = event.costUsd;
      episode.warningDurationMs = event.durationMs;
    }
    if (currentState !== "Healthy" && !recoveryInsight(baseline, episode.category, episode.attemptCount)) {
      lowSampleSuppressions += 1;
    }
    if (episode.maxBlindRunCount >= 2) {
      episode.blindRetryWarningIssued = true;
    }
    if (currentState === "Stop") {
      episode.stopIssued = true;
    }
    active.set(event.identity, episode);
  }

  for (const episode of active.values()) {
    outcomes.push(toReplayOutcome(episode, false));
  }

  return { outcomes, lowSampleSuppressions };
}

function replayDecisionState(episode: ReplayEpisode): "Healthy" | "Careful" | "Stop" {
  if (episode.maxBlindRunCount >= 3 || episode.attemptCount >= 3) {
    return "Stop";
  }
  if (episode.maxBlindRunCount >= 2 || episode.attemptCount >= 2) {
    return "Careful";
  }
  return "Healthy";
}

function toReplayOutcome(episode: ReplayEpisode, recovered: boolean): ReplayOutcome {
  return {
    category: episode.category,
    attemptCount: episode.attemptCount,
    recovered,
    warningAttempt: episode.warningAttempt,
    warningToolResultCount: episode.warningToolResultCount,
    warningCostUsd: episode.warningCostUsd,
    warningDurationMs: episode.warningDurationMs,
    stopIssued: episode.stopIssued,
    blindRetryWarningIssued: episode.blindRetryWarningIssued
  };
}

function baselineFromEpisodes(episodes: FailureEpisodeSummary[]): DecisionPersonalBaseline {
  const counters = emptyRecoveryBuildCounters();
  for (const episode of episodes) {
    addFailureEpisodeToRecoveryCounters(counters, episode);
  }
  return {
    failureRecovery: recoveryAggregatesFromCounters(counters),
    blindRetry: blindRetryAggregatesFromCounters(counters)
  };
}

async function readEpisodes(files: string[], maxBytesPerTranscript: number): Promise<FailureEpisodeSummary[]> {
  const sessions = await readEpisodesBySession(files, maxBytesPerTranscript);
  return sessions.flat();
}

async function readEpisodesBySession(files: string[], maxBytesPerTranscript: number): Promise<FailureEpisodeSummary[][]> {
  const sessions: FailureEpisodeSummary[][] = [];
  for (const file of files) {
    const tail = await readTranscriptTail(file, { maxBytes: maxBytesPerTranscript });
    if (tail.pathReadable) {
      sessions.push(extractFailureEpisodesFromTranscriptLines(tail.lines));
    }
  }
  return sessions;
}

async function readEventsBySession(files: string[], maxBytesPerTranscript: number): Promise<ReplayToolResultEvent[][]> {
  const sessions: ReplayToolResultEvent[][] = [];
  for (const file of files) {
    const tail = await readTranscriptTail(file, { maxBytes: maxBytesPerTranscript });
    if (tail.pathReadable) {
      sessions.push(extractReplayToolResultEvents(tail.lines));
    }
  }
  return sessions;
}

function extractReplayToolResultEvents(lines: string[]): ReplayToolResultEvent[] {
  const events = extractSafeToolResultEventsFromTranscriptLines(lines);
  const measurements = extractToolResultMeasurements(lines);
  return events.map((event, index) => ({
    ...event,
    ...measurements[index]
  }));
}

function extractToolResultMeasurements(lines: string[]): Array<{ costUsd?: number; durationMs?: number }> {
  const measurements: Array<{ costUsd?: number; durationMs?: number }> = [];
  let latestCostUsd: number | undefined;
  let latestDurationMs: number | undefined;
  let firstTimestampMs: number | undefined;

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
    const timestampMs = timestampMsFromEntry(entry);
    if (timestampMs !== undefined) {
      firstTimestampMs ??= timestampMs;
      latestDurationMs = Math.max(0, timestampMs - firstTimestampMs);
    }
    const costUsd = costUsdFromEntry(entry);
    if (costUsd !== undefined) {
      latestCostUsd = costUsd;
    }
    const durationMs = durationMsFromEntry(entry);
    if (durationMs !== undefined) {
      latestDurationMs = durationMs;
    }

    for (let index = 0; index < countToolResults(entry); index += 1) {
      measurements.push({ costUsd: latestCostUsd, durationMs: latestDurationMs });
    }
  }

  return measurements;
}

function countToolResults(entry: Record<string, unknown>): number {
  let count = 0;
  for (const part of contentParts(entry)) {
    if (part.type === "tool_result") {
      count += 1;
    }
  }
  if (entry.type === "tool_result" || entry.type === "tool_result_delta") {
    count += 1;
  }
  return count;
}

function contentParts(entry: Record<string, unknown>): Record<string, unknown>[] {
  const message = asRecord(entry.message);
  const candidates = [entry.content, message?.content];
  const parts: Record<string, unknown>[] = [];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      parts.push(...candidate.flatMap((part) => (asRecord(part) ? [asRecord(part)!] : [])));
    } else if (asRecord(candidate)) {
      parts.push(asRecord(candidate)!);
    }
  }
  return parts;
}

function costUsdFromEntry(entry: Record<string, unknown>): number | undefined {
  const cost = asRecord(entry.cost);
  const value =
    numberField(cost?.total_cost_usd) ??
    numberField(cost?.totalCostUsd) ??
    numberField(cost?.cost_usd) ??
    numberField(entry.total_cost_usd) ??
    numberField(entry.costUsd);
  return value !== undefined && value >= 0 ? value : undefined;
}

function durationMsFromEntry(entry: Record<string, unknown>): number | undefined {
  const cost = asRecord(entry.cost);
  const value =
    numberField(cost?.total_duration_ms) ??
    numberField(cost?.totalDurationMs) ??
    numberField(entry.duration_ms) ??
    numberField(entry.durationMs);
  return value !== undefined && value >= 0 ? value : undefined;
}

function timestampMsFromEntry(entry: Record<string, unknown>): number | undefined {
  const timestamp = entry.timestamp;
  if (typeof timestamp !== "string") {
    return undefined;
  }
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : undefined;
}

async function listTranscriptFiles(root: string, maxFiles: number): Promise<string[]> {
  if (maxFiles <= 0) {
    return [];
  }

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

  return candidates
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path))
    .slice(0, maxFiles)
    .map((candidate) => candidate.path);
}

async function readableFileMtimeMs(path: string): Promise<number | undefined> {
  try {
    const fileStat = await stat(path);
    return fileStat.isFile() ? fileStat.mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

function holdoutSessionCount(total: number, ratio: number): number {
  if (total <= 1) {
    return total;
  }
  return Math.max(1, Math.min(total - 1, Math.ceil(total * Math.max(0.05, Math.min(0.8, ratio)))));
}

function formatMetricRate(value: number | undefined): string {
  return value === undefined ? "n/a" : value.toFixed(2);
}

function formatOptionalCurrencyAverage(value: number | undefined): string {
  if (value === undefined) {
    return "n/a";
  }
  return `$${value.toFixed(2)}`;
}

function formatOptionalDurationAverage(value: number | undefined): string {
  if (value === undefined) {
    return "n/a";
  }
  if (value < 60_000) {
    return `${Math.round(value / 1000)}s`;
  }
  return `${Number((value / 60_000).toFixed(1))}m`;
}

function averageOrUndefined(values: number[]): number | undefined {
  return values.length > 0 ? Number((values.reduce((total, value) => total + value, 0) / values.length).toFixed(2)) : undefined;
}

function formatCategoryCoverage(coverage: Partial<Record<FailureRecoveryCategory, number>>): string {
  const parts = FAILURE_RECOVERY_CATEGORIES.flatMap((category) => {
    const count = coverage[category] || 0;
    return count > 0 ? [`${category}:${count}`] : [];
  });
  return parts.length > 0 ? parts.join(", ") : "none";
}

function roundRate(value: number): number {
  return Number(value.toFixed(4));
}
