import { cacheReadSharePoint } from "./cache-efficiency.js";
import type { CacheReadSharePoint, DecisionPersonalBaseline, TokenUsage, TranscriptSummary } from "./types.js";

// Shared signal utilities. The decide() advisor waterfall was removed in PRD-03 (grill F1); the
// gauge (gauge.ts + findings.ts) is the only decision engine. What remains here are the pure
// helpers the gauge still consumes: budget-threshold parsing, cost formatting, the cache-efficiency
// regression detector, and the edit-validation-lag baseline check.

export interface BudgetThresholds {
  costUsd?: number;
  costTotalCarefulUsd?: number;
  costDeltaUsd?: number;
  costDeltaCarefulUsd?: number;
  durationMs?: number;
  durationCarefulMs?: number;
}

export interface NormalizedBudgetThresholds {
  costUsd: number;
  costDeltaUsd: number;
  durationMs: number;
}

const DEFAULT_BUDGET_THRESHOLDS: NormalizedBudgetThresholds = {
  costUsd: 2,
  costDeltaUsd: 0.5,
  durationMs: 45 * 60_000
};
const CACHE_EFFICIENCY_MIN_PEAK_RATIO = 0.3;
const CACHE_EFFICIENCY_MIN_TOTAL_INPUT_TOKENS = 1_000;
const CACHE_EFFICIENCY_DROP_THRESHOLD_RATIO = 0.2;
const CACHE_EFFICIENCY_COMPACTION_SUPPRESSION_ACTIVITY = 1;

export function formatCost(value: number): string {
  if (value < 0.01) {
    return `$${value.toFixed(4)}`;
  }
  if (value < 10) {
    return `$${value.toFixed(2)}`;
  }
  return `$${Math.round(value).toString()}`;
}

export interface CacheEfficiencyRegression {
  peak: CacheReadSharePoint;
  current: CacheReadSharePoint;
}

export function cacheEfficiencyRegression(inputUsage: TokenUsage, transcript: TranscriptSummary): CacheEfficiencyRegression | undefined {
  const inputCurrent = cacheReadSharePoint(inputUsage);
  const transcriptCurrent = transcript.cacheReadShare?.current;
  const current = inputCurrent || transcriptCurrent;
  if (!current) {
    return undefined;
  }

  const transcriptPeak = transcript.cacheReadShare?.peak;
  const peak = !transcriptPeak || current.ratio > transcriptPeak.ratio ? current : transcriptPeak;
  const dropRatio = peak.ratio - current.ratio;
  if (
    peak.ratio < CACHE_EFFICIENCY_MIN_PEAK_RATIO ||
    peak.totalInputTokens < CACHE_EFFICIENCY_MIN_TOTAL_INPUT_TOKENS ||
    current.totalInputTokens < CACHE_EFFICIENCY_MIN_TOTAL_INPUT_TOKENS ||
    dropRatio <= CACHE_EFFICIENCY_DROP_THRESHOLD_RATIO
  ) {
    return undefined;
  }

  return { peak, current };
}

export function suppressCacheEfficiencyRegressionAfterCompaction(transcript: TranscriptSummary): boolean {
  return (
    transcript.compactionEvents > 0 &&
    transcript.postCompactionActivity <= CACHE_EFFICIENCY_COMPACTION_SUPPRESSION_ACTIVITY
  );
}

export function cacheEfficiencyEvidence(regression: CacheEfficiencyRegression): string {
  return `cache reuse dropped from ${formatPercent(regression.peak.ratio)} to ${formatPercent(regression.current.ratio)}`;
}

export function hasUnusualEditValidationLag(transcript: TranscriptSummary, baseline: DecisionPersonalBaseline | undefined): boolean {
  const currentLag = transcript.unvalidatedEditToolSteps;
  const p75 = baseline?.editValidation?.p75ToolStepsFromEditToValidation || 0;
  const followed = baseline?.editValidation?.editsFollowedByValidation || 0;
  return currentLag !== undefined && followed >= 5 && p75 > 0 && currentLag > p75;
}

export function normalizeBudgetThresholds(thresholds: BudgetThresholds | undefined): NormalizedBudgetThresholds {
  return {
    costUsd: thresholdOrDefault(thresholds?.costTotalCarefulUsd ?? thresholds?.costUsd, DEFAULT_BUDGET_THRESHOLDS.costUsd),
    costDeltaUsd: thresholdOrDefault(
      thresholds?.costDeltaCarefulUsd ?? thresholds?.costDeltaUsd,
      DEFAULT_BUDGET_THRESHOLDS.costDeltaUsd
    ),
    durationMs: thresholdOrDefault(thresholds?.durationCarefulMs ?? thresholds?.durationMs, DEFAULT_BUDGET_THRESHOLDS.durationMs)
  };
}

export function budgetThresholdsFromEnv(env: NodeJS.ProcessEnv = process.env): BudgetThresholds | undefined {
  const costUsd = numberEnv(env, "BB_CC_LITE_BUDGET_COST_USD", "BB_CC_LITE_COST_BUDGET_USD");
  const costDeltaUsd = numberEnv(env, "BB_CC_LITE_BUDGET_COST_DELTA_USD", "BB_CC_LITE_COST_DELTA_BUDGET_USD");
  const durationMs =
    numberEnv(env, "BB_CC_LITE_BUDGET_DURATION_MS", "BB_CC_LITE_DURATION_BUDGET_MS") ??
    minutesEnv(env, "BB_CC_LITE_BUDGET_DURATION_MINUTES", "BB_CC_LITE_DURATION_BUDGET_MINUTES");
  return costUsd === undefined && costDeltaUsd === undefined && durationMs === undefined
    ? undefined
    : {
        costUsd,
        costDeltaUsd,
        durationMs
      };
}

function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

function numberEnv(env: NodeJS.ProcessEnv, ...names: string[]): number | undefined {
  for (const name of names) {
    const value = env[name];
    if (value === undefined || value.trim() === "") {
      continue;
    }
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return undefined;
}

function minutesEnv(env: NodeJS.ProcessEnv, ...names: string[]): number | undefined {
  const minutes = numberEnv(env, ...names);
  return minutes === undefined ? undefined : minutes * 60_000;
}

function thresholdOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}
