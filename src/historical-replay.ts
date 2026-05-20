import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  extractFailureEpisodesFromTranscriptLines,
  extractSafeToolResultEventsFromTranscriptLines,
  type SafeToolResultEvent
} from "./failure-episodes.js";
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

const DEFAULT_MAX_FILES = 500;
const DEFAULT_MAX_BYTES_PER_TRANSCRIPT = 512 * 1024;
const DEFAULT_HOLDOUT_RATIO = 0.2;

export interface HistoricalReplayOptions {
  homeDir?: string;
  claudeProjectsDir?: string;
  maxFiles?: number;
  maxBytesPerTranscript?: number;
  holdoutRatio?: number;
}

export interface HistoricalReplayMetrics {
  holdoutSessions: number;
  evaluatedFailureEpisodes: number;
  stopPrecisionOnUnrecoveredEpisodes: number | undefined;
  falseStopCountOnRecoveredEpisodes: number;
  missedUnrecoveredLoopCount: number;
  blindRetryPrecision: number | undefined;
  averageAttemptsBeforeWarning: number;
  lowSampleSuppressions: number;
  categoryCoverage: Partial<Record<FailureRecoveryCategory, number>>;
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
}

interface ReplayOutcome {
  category: FailureRecoveryCategory;
  attemptCount: number;
  recovered: boolean;
  warningAttempt?: number;
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
    `holdout sessions ${metrics.holdoutSessions}`,
    `evaluated failure episodes ${metrics.evaluatedFailureEpisodes}`,
    `Stop precision on unrecovered episodes ${formatMetricRate(metrics.stopPrecisionOnUnrecoveredEpisodes)}`,
    `false Stop count on recovered episodes ${metrics.falseStopCountOnRecoveredEpisodes}`,
    `missed unrecovered loop count ${metrics.missedUnrecoveredLoopCount}`,
    `blind retry precision ${formatMetricRate(metrics.blindRetryPrecision)}`,
    `average attempts before warning ${metrics.averageAttemptsBeforeWarning.toFixed(2)}`,
    `low-sample suppressions ${metrics.lowSampleSuppressions}`,
    `category coverage ${formatCategoryCoverage(metrics.categoryCoverage)}`
  ].join("; ");
}

function evaluateHoldout(
  holdoutEventsBySession: SafeToolResultEvent[][],
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
  const attemptsBeforeWarning: number[] = [];
  const categoryCoverage: Partial<Record<FailureRecoveryCategory, number>> = {};

  for (const events of holdoutEventsBySession) {
    const replay = replaySession(events, baseline);
    lowSampleSuppressions += replay.lowSampleSuppressions;
    for (const outcome of replay.outcomes) {
      evaluatedFailureEpisodes += 1;
      categoryCoverage[outcome.category] = (categoryCoverage[outcome.category] || 0) + 1;
      if (outcome.warningAttempt !== undefined) {
        attemptsBeforeWarning.push(outcome.warningAttempt);
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
    holdoutSessions: holdoutEventsBySession.length,
    evaluatedFailureEpisodes,
    stopPrecisionOnUnrecoveredEpisodes: stopTotal > 0 ? roundRate(stopTruePositive / stopTotal) : undefined,
    falseStopCountOnRecoveredEpisodes,
    missedUnrecoveredLoopCount,
    blindRetryPrecision: blindRetryTotal > 0 ? roundRate(blindRetryTruePositive / blindRetryTotal) : undefined,
    averageAttemptsBeforeWarning:
      attemptsBeforeWarning.length > 0
        ? Number((attemptsBeforeWarning.reduce((total, value) => total + value, 0) / attemptsBeforeWarning.length).toFixed(2))
        : 0,
    lowSampleSuppressions,
    categoryCoverage
  };
}

function replaySession(
  events: SafeToolResultEvent[],
  baseline: DecisionPersonalBaseline
): { outcomes: ReplayOutcome[]; lowSampleSuppressions: number } {
  const active = new Map<string, ReplayEpisode>();
  const outcomes: ReplayOutcome[] = [];
  let lowSampleSuppressions = 0;

  for (const event of events) {
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

async function readEventsBySession(files: string[], maxBytesPerTranscript: number): Promise<SafeToolResultEvent[][]> {
  const sessions: SafeToolResultEvent[][] = [];
  for (const file of files) {
    const tail = await readTranscriptTail(file, { maxBytes: maxBytesPerTranscript });
    if (tail.pathReadable) {
      sessions.push(extractSafeToolResultEventsFromTranscriptLines(tail.lines));
    }
  }
  return sessions;
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
