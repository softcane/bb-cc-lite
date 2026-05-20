import { describe, expect, it } from "vitest";
import {
  recoveryAggregatesFromCounters,
  recoveryInsight,
  recoveryInsightFromAggregate,
  emptyRecoveryBuildCounters,
  addFailureEpisodeToRecoveryCounters
} from "../src/recovery-stats.js";
import type { FailureEpisodeSummary } from "../src/types.js";

describe("failure recovery statistics", () => {
  it("suppresses personalization below five relevant episodes", () => {
    expect(
      recoveryInsightFromAggregate(
        "tests",
        {
          episodes: 4,
          recovered: 4,
          unrecovered: 0,
          activeEnded: 0,
          recoveryRate: 1,
          medianAttemptsBeforeRecovery: 1,
          p75AttemptsBeforeRecovery: 2,
          blindRetryEpisodes: 0,
          blindRetryRecovered: 0,
          blindRetryUnrecovered: 0,
          confidence: "low"
        },
        2
      )
    ).toBeUndefined();
  });

  it("selects usually-recovers wording with medium confidence for clear 5-9 sample history", () => {
    expect(
      recoveryInsightFromAggregate(
        "tests",
        {
          episodes: 6,
          recovered: 5,
          unrecovered: 1,
          activeEnded: 1,
          recoveryRate: 0.8333,
          medianAttemptsBeforeRecovery: 2,
          p75AttemptsBeforeRecovery: 2,
          blindRetryEpisodes: 1,
          blindRetryRecovered: 1,
          blindRetryUnrecovered: 0,
          confidence: "medium"
        },
        2
      )
    ).toMatchObject({
      kind: "usually_recovers",
      confidence: "medium",
      diagnosis: "tests failed twice; usually recovers after one focused fix"
    });
  });

  it("selects usually-unrecovered wording only with enough unrecovered examples and low recovery rate", () => {
    expect(
      recoveryInsightFromAggregate(
        "tests",
        {
          episodes: 12,
          recovered: 3,
          unrecovered: 9,
          activeEnded: 9,
          recoveryRate: 0.25,
          medianAttemptsBeforeRecovery: 2,
          p75AttemptsBeforeRecovery: 3,
          blindRetryEpisodes: 7,
          blindRetryRecovered: 1,
          blindRetryUnrecovered: 6,
          confidence: "high"
        },
        3
      )
    ).toMatchObject({
      kind: "usually_unrecovered",
      confidence: "high",
      diagnosis: "test loop rarely recovered after 3 failures"
    });
  });

  it("keeps confidence gates honest at threshold boundaries", () => {
    expect(insight({ recovered: 4, unrecovered: 0, recoveryRate: 1, medianAttemptsBeforeRecovery: 1, confidence: "high" })).toBeUndefined();
    expect(insight({ recovered: 4, unrecovered: 1, recoveryRate: 0.8, medianAttemptsBeforeRecovery: 1 })).toMatchObject({
      kind: "usually_recovers",
      confidence: "medium"
    });
    expect(insight({ recovered: 8, unrecovered: 1, recoveryRate: 0.8889, medianAttemptsBeforeRecovery: 1 })).toMatchObject({
      kind: "usually_recovers",
      confidence: "medium"
    });
    expect(insight({ recovered: 9, unrecovered: 1, recoveryRate: 0.9, medianAttemptsBeforeRecovery: 1 })).toMatchObject({
      kind: "usually_recovers",
      confidence: "high"
    });
    expect(insight({ recovered: 8, unrecovered: 2, recoveryRate: 0.8, medianAttemptsBeforeRecovery: 3 })).toBeUndefined();
    expect(insight({ recovered: 7, unrecovered: 3, recoveryRate: 0.7, medianAttemptsBeforeRecovery: 1 })).toBeUndefined();
    expect(insight({ recovered: 1, unrecovered: 4, recoveryRate: 0.2, medianAttemptsBeforeRecovery: 1 })).toBeUndefined();
    expect(insight({ recovered: 2, unrecovered: 5, recoveryRate: 0.2857, medianAttemptsBeforeRecovery: 1 })).toMatchObject({
      kind: "usually_unrecovered",
      confidence: "medium"
    });
  });

  it("builds aggregate-only recovery and blind retry counts from safe episodes", () => {
    const counters = emptyRecoveryBuildCounters();
    for (const item of [
      makeEpisode({ recovered: true, attemptCount: 2, blindRetryFailureCount: 2 }),
      makeEpisode({ recovered: false, activeEnded: true, attemptCount: 3, blindRetryFailureCount: 3 }),
      makeEpisode({ category: "build", recovered: false, activeEnded: true, attemptCount: 1, blindRetryFailureCount: 1 })
    ]) {
      addFailureEpisodeToRecoveryCounters(counters, item);
    }

    const aggregates = recoveryAggregatesFromCounters(counters);
    expect(aggregates.tests).toMatchObject({
      episodes: 2,
      recovered: 1,
      unrecovered: 1,
      activeEnded: 1,
      recoveryRate: 0.5,
      medianAttemptsBeforeRecovery: 2,
      blindRetryEpisodes: 2,
      blindRetryRecovered: 1,
      blindRetryUnrecovered: 1,
      confidence: "low"
    });
    expect(aggregates.build).toMatchObject({
      episodes: 1,
      recovered: 0,
      unrecovered: 1
    });
  });

  it("falls back to legacy validation aggregates safely", () => {
    expect(
      recoveryInsight(
        {
          validation: {
            tests: {
              calls: 24,
              failures: 10,
              failureRate: 0.4167,
              recovered: 9,
              unrecovered: 1,
              recoveryRate: 0.9,
              averageFailuresBeforeRecovery: 1,
              medianFailuresBeforeRecovery: 1,
              p75FailuresBeforeRecovery: 1,
              fivePlusFailuresBeforeRecovery: 0
            }
          }
        },
        "tests",
        2
      )
    ).toMatchObject({
      kind: "usually_recovers"
    });
  });
});

function makeEpisode(overrides: Partial<FailureEpisodeSummary> = {}): FailureEpisodeSummary {
  return {
    identity: "validation:tests",
    category: "tests",
    label: "test",
    attemptCount: 1,
    recovered: false,
    activeEnded: false,
    blindRetryFailureCount: 1,
    ...overrides
  };
}

function insight(overrides: Partial<Parameters<typeof recoveryInsightFromAggregate>[1]>) {
  const recovered = overrides.recovered || 0;
  const unrecovered = overrides.unrecovered || 0;
  return recoveryInsightFromAggregate(
    "tests",
    {
      episodes: recovered + unrecovered,
      recovered,
      unrecovered,
      activeEnded: unrecovered,
      recoveryRate: overrides.recoveryRate || 0,
      medianAttemptsBeforeRecovery: overrides.medianAttemptsBeforeRecovery || 0,
      p75AttemptsBeforeRecovery: overrides.p75AttemptsBeforeRecovery || overrides.medianAttemptsBeforeRecovery || 0,
      blindRetryEpisodes: overrides.blindRetryEpisodes || 0,
      blindRetryRecovered: overrides.blindRetryRecovered || 0,
      blindRetryUnrecovered: overrides.blindRetryUnrecovered || 0,
      confidence: overrides.confidence || "low"
    },
    3
  );
}
