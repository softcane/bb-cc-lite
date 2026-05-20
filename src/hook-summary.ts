import type { TranscriptSummary } from "./types.js";

export function mergeHookSummary(
  transcript: TranscriptSummary,
  hookData: {
    failedToolResults: number;
    toolCalls: number;
    compactionEvents: number;
    postCompactionActivity: number;
    repeatedFailures: Array<{ toolName: string; count: number; purpose?: string }>;
    latestTimestamp?: string;
    latestCompactionTimestamp?: string;
  }
): TranscriptSummary {
  const repeatedFailures = new Map<string, { toolName: string; count: number; purpose?: string }>();
  for (const failure of [...transcript.repeatedFailures, ...hookData.repeatedFailures]) {
    const key = `${failure.toolName}:${failure.purpose || ""}`;
    const existing = repeatedFailures.get(key);
    repeatedFailures.set(key, {
      toolName: failure.toolName,
      purpose: failure.purpose,
      count: Math.max(existing?.count || 0, failure.count)
    });
  }

  const latestTimestamp = latestIsoTimestamp(transcript.latestTimestamp, hookData.latestTimestamp);
  const latestCompactionTimestamp = latestIsoTimestamp(transcript.latestCompactionTimestamp, hookData.latestCompactionTimestamp);

  return {
    ...transcript,
    toolCalls: Math.max(transcript.toolCalls, hookData.toolCalls),
    failedToolResults: Math.max(transcript.failedToolResults, hookData.failedToolResults),
    repeatedFailures: [...repeatedFailures.values()].filter((failure) => failure.count >= 2),
    compactionEvents: Math.max(transcript.compactionEvents, hookData.compactionEvents),
    postCompactionActivity: mergedPostCompactionActivity(transcript, hookData, latestTimestamp, latestCompactionTimestamp),
    latestTimestamp,
    latestCompactionTimestamp
  };
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
