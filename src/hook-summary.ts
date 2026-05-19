import type { TranscriptSummary } from "./types.js";

export function mergeHookSummary(
  transcript: TranscriptSummary,
  hookData: {
    failedToolResults: number;
    toolCalls: number;
    compactionEvents: number;
    repeatedFailures: Array<{ toolName: string; count: number; purpose?: string }>;
    latestTimestamp?: string;
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

  return {
    ...transcript,
    toolCalls: Math.max(transcript.toolCalls, hookData.toolCalls),
    failedToolResults: Math.max(transcript.failedToolResults, hookData.failedToolResults),
    repeatedFailures: [...repeatedFailures.values()].filter((failure) => failure.count >= 2),
    compactionEvents: Math.max(transcript.compactionEvents, hookData.compactionEvents),
    latestTimestamp:
      transcript.latestTimestamp && hookData.latestTimestamp
        ? transcript.latestTimestamp > hookData.latestTimestamp
          ? transcript.latestTimestamp
          : hookData.latestTimestamp
        : transcript.latestTimestamp || hookData.latestTimestamp
  };
}
