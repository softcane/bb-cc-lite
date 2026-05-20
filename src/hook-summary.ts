import type { TranscriptSummary } from "./types.js";

export function mergeHookSummary(
  transcript: TranscriptSummary,
  hookData: {
    failedToolResults: number;
    toolCalls: number;
    compactionEvents: number;
    postCompactionActivity: number;
    repeatedFailures: TranscriptSummary["repeatedFailures"];
    blindRetry?: TranscriptSummary["blindRetry"];
    latestTimestamp?: string;
    latestCompactionTimestamp?: string;
  }
): TranscriptSummary {
  const repeatedFailures = new Map<string, TranscriptSummary["repeatedFailures"][number]>();
  for (const failure of [...transcript.repeatedFailures, ...hookData.repeatedFailures]) {
    const key = failureKey(failure);
    const existing = repeatedFailures.get(key);
    repeatedFailures.set(key, { ...failure, count: Math.max(existing?.count || 0, failure.count) });
  }

  const latestTimestamp = latestIsoTimestamp(transcript.latestTimestamp, hookData.latestTimestamp);
  const latestCompactionTimestamp = latestIsoTimestamp(transcript.latestCompactionTimestamp, hookData.latestCompactionTimestamp);

  return {
    ...transcript,
    toolCalls: Math.max(transcript.toolCalls, hookData.toolCalls),
    failedToolResults: Math.max(transcript.failedToolResults, hookData.failedToolResults),
    repeatedFailures: [...repeatedFailures.values()].filter((failure) => failure.count >= 2),
    blindRetry: strongestBlindRetry(transcript.blindRetry, hookData.blindRetry),
    compactionEvents: Math.max(transcript.compactionEvents, hookData.compactionEvents),
    postCompactionActivity: mergedPostCompactionActivity(transcript, hookData, latestTimestamp, latestCompactionTimestamp),
    latestTimestamp,
    latestCompactionTimestamp
  };
}

function strongestBlindRetry(
  first: TranscriptSummary["blindRetry"],
  second: TranscriptSummary["blindRetry"]
): TranscriptSummary["blindRetry"] {
  if (!first) {
    return second;
  }
  if (!second) {
    return first;
  }
  return second.blindRetryFailureCount > first.blindRetryFailureCount ? second : first;
}

function failureKey(failure: TranscriptSummary["repeatedFailures"][number]): string {
  return failure.category === "MCP" && failure.identityHash
    ? `MCP:${failure.identityHash}`
    : `${failure.toolName}:${failure.purpose || ""}`;
}

function latestIsoTimestamp(first: string | undefined, second: string | undefined): string | undefined {
  if (first && second) {
    return first > second ? first : second;
  }
  return first || second;
}

function mergedPostCompactionActivity(
  transcript: Pick<TranscriptSummary, "latestCompactionTimestamp" | "latestTimestamp" | "postCompactionActivity">,
  hookData: {
    latestCompactionTimestamp?: string;
    latestTimestamp?: string;
    postCompactionActivity: number;
  },
  latestTimestamp: string | undefined,
  latestCompactionTimestamp: string | undefined
): number {
  if (!latestCompactionTimestamp) {
    return Math.max(transcript.postCompactionActivity, hookData.postCompactionActivity);
  }

  const transcriptActivity =
    transcript.latestCompactionTimestamp === latestCompactionTimestamp ? transcript.postCompactionActivity : 0;
  const hookActivity = hookData.latestCompactionTimestamp === latestCompactionTimestamp ? hookData.postCompactionActivity : 0;
  const laterActivitySeen = latestTimestamp !== undefined && latestTimestamp > latestCompactionTimestamp;
  return Math.max(transcriptActivity, hookActivity, laterActivitySeen ? 1 : 0);
}
