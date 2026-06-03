import type { DecisionConfidence, DecisionPersonalBaseline, FailureEpisodeSummary } from "./types.js";

export type FailureRecoveryCategory =
  | "tests"
  | "lint"
  | "typecheck"
  | "build"
  | "read"
  | "grep"
  | "glob"
  | "ls"
  | "edit"
  | "mcp"
  | "tool";

export interface FailureRecoveryAggregate {
  episodes: number;
  recovered: number;
  unrecovered: number;
  activeEnded: number;
  recoveryRate: number;
  smoothedRecoveryRate?: number;
  effectiveSamples?: number;
  medianAttemptsBeforeRecovery: number;
  p75AttemptsBeforeRecovery: number;
  blindRetryEpisodes: number;
  blindRetryRecovered: number;
  blindRetryUnrecovered: number;
  confidence: DecisionConfidence;
}

export interface BlindRetryAggregate {
  episodes: number;
  recovered: number;
  unrecovered: number;
  recoveryRate: number;
  smoothedRecoveryRate?: number;
  effectiveSamples?: number;
  carefulLikeEpisodes: number;
  stopLikeEpisodes: number;
  confidence: DecisionConfidence;
}

export type RetryAttemptBucket = "1" | "2" | "3" | "4" | "5plus";

export interface RetryHazardAggregate {
  episodes: number;
  recovered: number;
  unrecovered: number;
  recoveryRate: number;
  smoothedRecoveryRate: number;
  effectiveSamples: number;
  confidence: DecisionConfidence;
}

export type RetryHazardTable = Partial<Record<FailureRecoveryCategory, Partial<Record<RetryAttemptBucket, RetryHazardAggregate>>>>;

export interface FailureRecoveryInsight {
  kind: "usually_recovers" | "usually_unrecovered";
  confidence: Exclude<DecisionConfidence, "low">;
  category: FailureRecoveryCategory;
  diagnosis: string;
  baselineNote: string;
}

export interface RecoveryBuildCounters {
  episodes: number;
  recovered: number;
  unrecovered: number;
  activeEnded: number;
  attemptsBeforeRecovery: number[];
  blindRetryEpisodes: number;
  blindRetryRecovered: number;
  blindRetryUnrecovered: number;
  blindRetryCarefulLikeEpisodes: number;
  blindRetryStopLikeEpisodes: number;
  retryHazards: Record<RetryAttemptBucket, RetryHazardBuildCounters>;
}

type BaselineFailureRecoveryAggregate = NonNullable<NonNullable<DecisionPersonalBaseline["failureRecovery"]>[FailureRecoveryCategory]>;
type BaselineRetryHazardAggregate = NonNullable<
  NonNullable<NonNullable<DecisionPersonalBaseline["retryHazards"]>[FailureRecoveryCategory]>[RetryAttemptBucket]
>;

interface RetryHazardBuildCounters {
  episodes: number;
  recovered: number;
  unrecovered: number;
}

export const FAILURE_RECOVERY_CATEGORIES: FailureRecoveryCategory[] = [
  "tests",
  "lint",
  "typecheck",
  "build",
  "read",
  "grep",
  "glob",
  "ls",
  "edit",
  "mcp",
  "tool"
];
export const RETRY_ATTEMPT_BUCKETS: RetryAttemptBucket[] = ["1", "2", "3", "4", "5plus"];

const RECOVERY_SMOOTHING_ALPHA = 0.5;
const RECOVERY_SMOOTHING_BETA = 0.5;

export function emptyRecoveryBuildCounters(): Record<FailureRecoveryCategory, RecoveryBuildCounters> {
  const result = {} as Record<FailureRecoveryCategory, RecoveryBuildCounters>;
  for (const category of FAILURE_RECOVERY_CATEGORIES) {
    result[category] = {
      episodes: 0,
      recovered: 0,
      unrecovered: 0,
      activeEnded: 0,
      attemptsBeforeRecovery: [],
      blindRetryEpisodes: 0,
      blindRetryRecovered: 0,
      blindRetryUnrecovered: 0,
      blindRetryCarefulLikeEpisodes: 0,
      blindRetryStopLikeEpisodes: 0,
      retryHazards: emptyRetryHazardCounters()
    };
  }
  return result;
}

export function mergeRecoveryBuildCounters(
  target: Record<FailureRecoveryCategory, RecoveryBuildCounters>,
  source: Record<FailureRecoveryCategory, RecoveryBuildCounters>
): void {
  for (const category of FAILURE_RECOVERY_CATEGORIES) {
    target[category].episodes += source[category].episodes;
    target[category].recovered += source[category].recovered;
    target[category].unrecovered += source[category].unrecovered;
    target[category].activeEnded += source[category].activeEnded;
    target[category].attemptsBeforeRecovery.push(...source[category].attemptsBeforeRecovery);
    target[category].blindRetryEpisodes += source[category].blindRetryEpisodes;
    target[category].blindRetryRecovered += source[category].blindRetryRecovered;
    target[category].blindRetryUnrecovered += source[category].blindRetryUnrecovered;
    target[category].blindRetryCarefulLikeEpisodes += source[category].blindRetryCarefulLikeEpisodes;
    target[category].blindRetryStopLikeEpisodes += source[category].blindRetryStopLikeEpisodes;
    mergeRetryHazardCounters(target[category].retryHazards, source[category].retryHazards);
  }
}

export function addFailureEpisodeToRecoveryCounters(
  target: Record<FailureRecoveryCategory, RecoveryBuildCounters>,
  episode: FailureEpisodeSummary
): void {
  const counters = target[episode.category];
  counters.episodes += 1;
  counters.recovered += episode.recovered ? 1 : 0;
  counters.unrecovered += episode.recovered ? 0 : 1;
  counters.activeEnded += episode.activeEnded ? 1 : 0;
  if (episode.recovered) {
    counters.attemptsBeforeRecovery.push(episode.attemptCount);
  }
  if (episode.blindRetryFailureCount >= 2) {
    counters.blindRetryEpisodes += 1;
    counters.blindRetryRecovered += episode.recovered ? 1 : 0;
    counters.blindRetryUnrecovered += episode.recovered ? 0 : 1;
    counters.blindRetryCarefulLikeEpisodes += 1;
    counters.blindRetryStopLikeEpisodes += episode.blindRetryFailureCount >= 3 ? 1 : 0;
  }
  addEpisodeToRetryHazards(counters.retryHazards, episode);
}

export function recoveryAggregatesFromCounters(
  counters: Record<FailureRecoveryCategory, RecoveryBuildCounters>
): Partial<Record<FailureRecoveryCategory, FailureRecoveryAggregate>> {
  const result: Partial<Record<FailureRecoveryCategory, FailureRecoveryAggregate>> = {};
  for (const category of FAILURE_RECOVERY_CATEGORIES) {
    const source = counters[category];
    if (source.episodes === 0) {
      continue;
    }
    result[category] = {
      episodes: source.episodes,
      recovered: source.recovered,
      unrecovered: source.unrecovered,
      activeEnded: source.activeEnded,
      recoveryRate: rate(source.recovered, source.recovered + source.unrecovered),
      smoothedRecoveryRate: smoothedRecoveryRate(source.recovered, source.unrecovered),
      effectiveSamples: effectiveSamples(source.recovered, source.unrecovered),
      medianAttemptsBeforeRecovery: percentile(source.attemptsBeforeRecovery, 0.5),
      p75AttemptsBeforeRecovery: percentile(source.attemptsBeforeRecovery, 0.75),
      blindRetryEpisodes: source.blindRetryEpisodes,
      blindRetryRecovered: source.blindRetryRecovered,
      blindRetryUnrecovered: source.blindRetryUnrecovered,
      confidence: confidenceForAggregate(source)
    };
  }
  return result;
}

export function blindRetryAggregatesFromCounters(
  counters: Record<FailureRecoveryCategory, RecoveryBuildCounters>
): Partial<Record<FailureRecoveryCategory, BlindRetryAggregate>> {
  const result: Partial<Record<FailureRecoveryCategory, BlindRetryAggregate>> = {};
  for (const category of FAILURE_RECOVERY_CATEGORIES) {
    const source = counters[category];
    if (source.blindRetryEpisodes === 0) {
      continue;
    }
    result[category] = {
      episodes: source.blindRetryEpisodes,
      recovered: source.blindRetryRecovered,
      unrecovered: source.blindRetryUnrecovered,
      recoveryRate: rate(source.blindRetryRecovered, source.blindRetryRecovered + source.blindRetryUnrecovered),
      smoothedRecoveryRate: smoothedRecoveryRate(source.blindRetryRecovered, source.blindRetryUnrecovered),
      effectiveSamples: effectiveSamples(source.blindRetryRecovered, source.blindRetryUnrecovered),
      carefulLikeEpisodes: source.blindRetryCarefulLikeEpisodes,
      stopLikeEpisodes: source.blindRetryStopLikeEpisodes,
      confidence: confidenceForSeen(source.blindRetryEpisodes)
    };
  }
  return result;
}

export function retryHazardsFromCounters(counters: Record<FailureRecoveryCategory, RecoveryBuildCounters>): RetryHazardTable {
  const result: RetryHazardTable = {};
  for (const category of FAILURE_RECOVERY_CATEGORIES) {
    const hazardTable: Partial<Record<RetryAttemptBucket, RetryHazardAggregate>> = {};
    for (const bucket of RETRY_ATTEMPT_BUCKETS) {
      const source = counters[category].retryHazards[bucket];
      if (source.episodes === 0) {
        continue;
      }
      hazardTable[bucket] = {
        episodes: source.episodes,
        recovered: source.recovered,
        unrecovered: source.unrecovered,
        recoveryRate: rate(source.recovered, source.recovered + source.unrecovered),
        smoothedRecoveryRate: smoothedRecoveryRate(source.recovered, source.unrecovered),
        effectiveSamples: effectiveSamples(source.recovered, source.unrecovered),
        confidence: confidenceForSeen(source.recovered + source.unrecovered)
      };
    }
    if (Object.keys(hazardTable).length > 0) {
      result[category] = hazardTable;
    }
  }
  return result;
}

export function recoveryInsight(
  baseline: DecisionPersonalBaseline | undefined,
  category: FailureRecoveryCategory,
  attempts: number
): FailureRecoveryInsight | undefined {
  const aggregate = normalizeAggregate(baseline?.failureRecovery?.[category]) || legacyValidationAggregate(baseline, category);
  if (!aggregate) {
    return undefined;
  }
  return recoveryInsightFromAggregate(category, aggregate, attempts, normalizeRetryHazard(baseline?.retryHazards?.[category]?.[retryAttemptBucket(attempts)]));
}

export function recoveryInsightFromAggregate(
  category: FailureRecoveryCategory,
  aggregate: FailureRecoveryAggregate,
  attempts: number,
  hazard?: RetryHazardAggregate
): FailureRecoveryInsight | undefined {
  const relevantEpisodes = aggregate.recovered + aggregate.unrecovered;
  if (relevantEpisodes < 5) {
    return undefined;
  }

  const confidence = confidenceForAggregateLike(aggregate);
  if (confidence === "low") {
    return undefined;
  }

  const recoveryRate = hazard && hazard.episodes >= 5 ? hazard.smoothedRecoveryRate : aggregate.smoothedRecoveryRate ?? aggregate.recoveryRate;
  const unrecovered = hazard && hazard.episodes >= 5 ? hazard.unrecovered : aggregate.unrecovered;

  if (recoveryRate >= 0.75 && aggregate.medianAttemptsBeforeRecovery > 0 && aggregate.medianAttemptsBeforeRecovery <= 2) {
    return {
      kind: "usually_recovers",
      confidence,
      category,
      diagnosis: `${categoryFailurePlural(category)} failed twice; usually passes after one targeted fix`,
      baselineNote: `${categoryFailureSingular(category)} failures usually recovered after one targeted fix`
    };
  }

  if (unrecovered >= 5 && recoveryRate <= 0.4) {
    return {
      kind: "usually_unrecovered",
      confidence,
      category,
      diagnosis: `${categoryFailureSingular(category)} loop rarely recovered after ${attempts} failures`,
      baselineNote: `${categoryFailureSingular(category)} loops rarely recovered after ${attempts} failures`
    };
  }

  return undefined;
}

export function confidenceForSeen(seen: number): DecisionConfidence {
  if (seen >= 10) {
    return "high";
  }
  if (seen >= 5) {
    return "medium";
  }
  return "low";
}

export function categoryFailureSingular(category: FailureRecoveryCategory): string {
  switch (category) {
    case "tests":
      return "test";
    case "mcp":
      return "MCP tool";
    case "typecheck":
      return "typecheck";
    default:
      return category;
  }
}

export function categoryFailurePlural(category: FailureRecoveryCategory): string {
  switch (category) {
    case "tests":
      return "tests";
    case "mcp":
      return "MCP tool";
    case "typecheck":
      return "typecheck";
    default:
      return category;
  }
}

export function rate(count: number, total: number): number {
  return total > 0 ? Number((count / total).toFixed(4)) : 0;
}

export function smoothedRecoveryRate(recovered: number, unrecovered: number): number {
  return Number(((recovered + RECOVERY_SMOOTHING_ALPHA) / effectiveSamples(recovered, unrecovered)).toFixed(4));
}

export function effectiveSamples(recovered: number, unrecovered: number): number {
  return recovered + unrecovered + RECOVERY_SMOOTHING_ALPHA + RECOVERY_SMOOTHING_BETA;
}

export function average(values: number[]): number {
  return values.length > 0 ? Number((values.reduce((total, value) => total + value, 0) / values.length).toFixed(4)) : 0;
}

export function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * percentileValue) - 1);
  return sorted[index] ?? 0;
}

function confidenceForAggregate(counters: RecoveryBuildCounters): DecisionConfidence {
  return confidenceForSeen(counters.recovered + counters.unrecovered);
}

function confidenceForAggregateLike(aggregate: Pick<FailureRecoveryAggregate, "recovered" | "unrecovered">): DecisionConfidence {
  return confidenceForSeen(aggregate.recovered + aggregate.unrecovered);
}

function emptyRetryHazardCounters(): Record<RetryAttemptBucket, RetryHazardBuildCounters> {
  return {
    "1": emptyRetryHazardBucket(),
    "2": emptyRetryHazardBucket(),
    "3": emptyRetryHazardBucket(),
    "4": emptyRetryHazardBucket(),
    "5plus": emptyRetryHazardBucket()
  };
}

function emptyRetryHazardBucket(): RetryHazardBuildCounters {
  return { episodes: 0, recovered: 0, unrecovered: 0 };
}

function mergeRetryHazardCounters(
  target: Record<RetryAttemptBucket, RetryHazardBuildCounters>,
  source: Record<RetryAttemptBucket, RetryHazardBuildCounters>
): void {
  for (const bucket of RETRY_ATTEMPT_BUCKETS) {
    target[bucket].episodes += source[bucket].episodes;
    target[bucket].recovered += source[bucket].recovered;
    target[bucket].unrecovered += source[bucket].unrecovered;
  }
}

function addEpisodeToRetryHazards(target: Record<RetryAttemptBucket, RetryHazardBuildCounters>, episode: FailureEpisodeSummary): void {
  for (const bucket of retryAttemptBucketsReached(episode.attemptCount)) {
    target[bucket].episodes += 1;
    target[bucket].recovered += episode.recovered ? 1 : 0;
    target[bucket].unrecovered += episode.recovered ? 0 : 1;
  }
}

function retryAttemptBucketsReached(attemptCount: number): RetryAttemptBucket[] {
  const result: RetryAttemptBucket[] = [];
  if (attemptCount >= 1) {
    result.push("1");
  }
  if (attemptCount >= 2) {
    result.push("2");
  }
  if (attemptCount >= 3) {
    result.push("3");
  }
  if (attemptCount >= 4) {
    result.push("4");
  }
  if (attemptCount >= 5) {
    result.push("5plus");
  }
  return result;
}

function retryAttemptBucket(attemptCount: number): RetryAttemptBucket {
  if (attemptCount >= 5) {
    return "5plus";
  }
  if (attemptCount >= 4) {
    return "4";
  }
  if (attemptCount >= 3) {
    return "3";
  }
  if (attemptCount >= 2) {
    return "2";
  }
  return "1";
}

function legacyValidationAggregate(
  baseline: DecisionPersonalBaseline | undefined,
  category: FailureRecoveryCategory
): FailureRecoveryAggregate | undefined {
  if (category !== "tests" && category !== "lint" && category !== "typecheck" && category !== "build") {
    return undefined;
  }
  const aggregate = baseline?.validation?.[category];
  if (!aggregate) {
    return undefined;
  }
  return {
    episodes: (aggregate.recovered || 0) + (aggregate.unrecovered || 0),
    recovered: aggregate.recovered || 0,
    unrecovered: aggregate.unrecovered || 0,
    activeEnded: aggregate.unrecovered || 0,
    recoveryRate: aggregate.recoveryRate || 0,
    smoothedRecoveryRate: smoothedRecoveryRate(aggregate.recovered || 0, aggregate.unrecovered || 0),
    effectiveSamples: effectiveSamples(aggregate.recovered || 0, aggregate.unrecovered || 0),
    medianAttemptsBeforeRecovery: aggregate.medianFailuresBeforeRecovery || 0,
    p75AttemptsBeforeRecovery: aggregate.p75FailuresBeforeRecovery || 0,
    blindRetryEpisodes: 0,
    blindRetryRecovered: 0,
    blindRetryUnrecovered: 0,
    confidence: confidenceForSeen((aggregate.recovered || 0) + (aggregate.unrecovered || 0))
  };
}

function normalizeAggregate(value: BaselineFailureRecoveryAggregate | undefined): FailureRecoveryAggregate | undefined {
  if (!value) {
    return undefined;
  }
  return {
    episodes: value.episodes || 0,
    recovered: value.recovered || 0,
    unrecovered: value.unrecovered || 0,
    activeEnded: value.activeEnded || 0,
    recoveryRate: value.recoveryRate || 0,
    smoothedRecoveryRate: value.smoothedRecoveryRate ?? smoothedRecoveryRate(value.recovered || 0, value.unrecovered || 0),
    effectiveSamples: value.effectiveSamples ?? effectiveSamples(value.recovered || 0, value.unrecovered || 0),
    medianAttemptsBeforeRecovery: value.medianAttemptsBeforeRecovery || 0,
    p75AttemptsBeforeRecovery: value.p75AttemptsBeforeRecovery || 0,
    blindRetryEpisodes: value.blindRetryEpisodes || 0,
    blindRetryRecovered: value.blindRetryRecovered || 0,
    blindRetryUnrecovered: value.blindRetryUnrecovered || 0,
    confidence: value.confidence || confidenceForSeen((value.recovered || 0) + (value.unrecovered || 0))
  };
}

function normalizeRetryHazard(value: BaselineRetryHazardAggregate | undefined): RetryHazardAggregate | undefined {
  if (!value) {
    return undefined;
  }
  const recovered = value.recovered || 0;
  const unrecovered = value.unrecovered || 0;
  return {
    episodes: value.episodes || 0,
    recovered,
    unrecovered,
    recoveryRate: value.recoveryRate || 0,
    smoothedRecoveryRate: value.smoothedRecoveryRate ?? smoothedRecoveryRate(recovered, unrecovered),
    effectiveSamples: value.effectiveSamples ?? effectiveSamples(recovered, unrecovered),
    confidence: value.confidence || confidenceForSeen(recovered + unrecovered)
  };
}
