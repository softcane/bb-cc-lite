import type { CacheReadSharePoint, CacheReadShareSummary, TokenUsage } from "./types.js";

export function cacheReadSharePoint(usage: TokenUsage, timestamp?: string): CacheReadSharePoint | undefined {
  const inputTokens = tokenCounter(usage.inputTokens);
  if (inputTokens === undefined) {
    return undefined;
  }

  const cacheCreationInputTokens = tokenCounter(usage.cacheCreationInputTokens, 0);
  const cacheReadInputTokens = tokenCounter(usage.cacheReadInputTokens, 0);
  if (cacheCreationInputTokens === undefined || cacheReadInputTokens === undefined) {
    return undefined;
  }

  const totalInputTokens = inputTokens + cacheCreationInputTokens + cacheReadInputTokens;
  if (!Number.isFinite(totalInputTokens) || totalInputTokens <= 0) {
    return undefined;
  }

  return {
    ratio: cacheReadInputTokens / totalInputTokens,
    totalInputTokens,
    inputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    timestamp
  };
}

export function updateCacheReadShareSummary(
  current: CacheReadShareSummary | undefined,
  point: CacheReadSharePoint
): CacheReadShareSummary {
  const peak = !current || point.ratio > current.peak.ratio ? point : current.peak;
  return {
    peak,
    current: point,
    dropPercentagePoints: Math.max(0, (peak.ratio - point.ratio) * 100)
  };
}

function tokenCounter(value: number | undefined, fallback?: number): number | undefined {
  if (value === undefined) {
    return fallback;
  }
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}
