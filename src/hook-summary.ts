import type { TranscriptSummary } from "./types.js";

export function mergeHookSummary(
  transcript: TranscriptSummary,
  hookData: {
    failedToolResults: number;
    toolCalls: number;
    readToolCalls?: number;
    successfulEditResults?: number;
    validationChecks?: number;
    validationSuccesses?: number;
    validationRecovered?: boolean;
    hasUnvalidatedEdits?: boolean;
    unvalidatedEditToolSteps?: number;
    compactionEvents: number;
    postCompactionActivity: number;
    repeatedFailures: TranscriptSummary["repeatedFailures"];
    blindRetry?: TranscriptSummary["blindRetry"];
    latestTimestamp?: string;
    latestLifecycleSource?: TranscriptSummary["latestLifecycleSource"];
    latestLifecycleTimestamp?: string;
    latestCompactionTimestamp?: string;
    redundantRead?: TranscriptSummary["redundantRead"];
    activeFullFileReads?: TranscriptSummary["activeFullFileReads"];
  }
): TranscriptSummary {
  const hookOpenRiskCleared = transcriptClearsOlderHookRisk(transcript, hookData);
  const hookRepeatedFailures = hookOpenRiskCleared ? [] : hookData.repeatedFailures;
  const repeatedFailures = new Map<string, TranscriptSummary["repeatedFailures"][number]>();
  for (const failure of [...transcript.repeatedFailures, ...hookRepeatedFailures]) {
    const key = failureKey(failure);
    const existing = repeatedFailures.get(key);
    repeatedFailures.set(key, { ...failure, count: Math.max(existing?.count || 0, failure.count) });
  }

  const latestTimestamp = latestIsoTimestamp(transcript.latestTimestamp, hookData.latestTimestamp);
  const latestLifecycle = latestLifecycleEvent(transcript, hookData);
  const latestCompactionTimestamp = latestIsoTimestamp(transcript.latestCompactionTimestamp, hookData.latestCompactionTimestamp);

  return {
    ...transcript,
    toolCalls: Math.max(transcript.toolCalls, hookData.toolCalls),
    readToolCalls: Math.max(transcript.readToolCalls, hookData.readToolCalls || 0),
    successfulEditResults: Math.max(transcript.successfulEditResults || 0, hookData.successfulEditResults || 0),
    validationChecks: Math.max(transcript.validationChecks || 0, hookData.validationChecks || 0),
    validationSuccesses: Math.max(transcript.validationSuccesses || 0, hookData.validationSuccesses || 0),
    failedToolResults: Math.max(transcript.failedToolResults, hookData.failedToolResults),
    repeatedFailures: [...repeatedFailures.values()].filter((failure) => failure.count >= 2),
    blindRetry: hookOpenRiskCleared ? transcript.blindRetry : strongestBlindRetry(transcript.blindRetry, hookData.blindRetry),
    hasUnvalidatedEdits: transcript.hasUnvalidatedEdits || Boolean(hookData.hasUnvalidatedEdits),
    unvalidatedEditToolSteps: Math.max(transcript.unvalidatedEditToolSteps || 0, hookData.unvalidatedEditToolSteps || 0) || undefined,
    validationRecovered: transcript.validationRecovered || Boolean(hookData.validationRecovered),
    compactionEvents: Math.max(transcript.compactionEvents, hookData.compactionEvents),
    postCompactionActivity: mergedPostCompactionActivity(transcript, hookData, latestTimestamp, latestCompactionTimestamp),
    latestTimestamp,
    latestLifecycleSource: latestLifecycle.source,
    latestLifecycleTimestamp: latestLifecycle.timestamp,
    latestCompactionTimestamp,
    redundantRead: strongestRedundantRead(transcript.redundantRead, hookData.redundantRead),
    activeFullFileReads: mergeActiveFullFileReads(transcript.activeFullFileReads, hookData.activeFullFileReads)
  };
}

function transcriptClearsOlderHookRisk(
  transcript: Pick<TranscriptSummary, "latestTimestamp" | "validationSuccesses" | "validationRecovered">,
  hookData: { latestTimestamp?: string; repeatedFailures: TranscriptSummary["repeatedFailures"]; blindRetry?: TranscriptSummary["blindRetry"] }
): boolean {
  return Boolean(
    ((transcript.validationSuccesses || 0) > 0 || transcript.validationRecovered) &&
      transcript.latestTimestamp &&
      hookData.latestTimestamp &&
      transcript.latestTimestamp > hookData.latestTimestamp &&
      (hookData.repeatedFailures.length > 0 || hookData.blindRetry)
  );
}

function latestLifecycleEvent(
  transcript: Pick<TranscriptSummary, "latestLifecycleSource" | "latestLifecycleTimestamp">,
  hookData: { latestLifecycleSource?: TranscriptSummary["latestLifecycleSource"]; latestLifecycleTimestamp?: string }
): { source?: TranscriptSummary["latestLifecycleSource"]; timestamp?: string } {
  if (transcript.latestLifecycleTimestamp && hookData.latestLifecycleTimestamp) {
    return transcript.latestLifecycleTimestamp >= hookData.latestLifecycleTimestamp
      ? { source: transcript.latestLifecycleSource, timestamp: transcript.latestLifecycleTimestamp }
      : { source: hookData.latestLifecycleSource, timestamp: hookData.latestLifecycleTimestamp };
  }
  return transcript.latestLifecycleTimestamp
    ? { source: transcript.latestLifecycleSource, timestamp: transcript.latestLifecycleTimestamp }
    : { source: hookData.latestLifecycleSource, timestamp: hookData.latestLifecycleTimestamp };
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

function strongestRedundantRead(
  first: TranscriptSummary["redundantRead"],
  second: TranscriptSummary["redundantRead"]
): TranscriptSummary["redundantRead"] {
  if (!first) {
    return second;
  }
  if (!second) {
    return first;
  }
  return second.unchangedFullFileReadCount > first.unchangedFullFileReadCount ? second : first;
}

function mergeActiveFullFileReads(
  first: TranscriptSummary["activeFullFileReads"],
  second: TranscriptSummary["activeFullFileReads"]
): TranscriptSummary["activeFullFileReads"] {
  const byFile = new Map<string, NonNullable<TranscriptSummary["activeFullFileReads"]>[number]>();
  for (const read of [...(first || []), ...(second || [])]) {
    const existing = byFile.get(read.fileIdentityHash);
    if (!existing || read.unchangedFullFileReadCount > existing.unchangedFullFileReadCount) {
      byFile.set(read.fileIdentityHash, read);
    }
  }
  return [...byFile.values()];
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
