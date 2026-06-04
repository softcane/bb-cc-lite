import type { StatusLineInput, TokenUsage, TranscriptSummary } from "./types.js";
import { sessionKeyFromId } from "./session.js";

export type LifecycleEvidenceStatus =
  | "current"
  | "empty_transcript"
  | "missing_transcript"
  | "no_transcript_path"
  | "malformed_transcript"
  | "no_activity";

export interface LifecycleEvidence {
  status: LifecycleEvidenceStatus;
  hasCurrentActivity: boolean;
  hasTranscriptActivity: boolean;
  hasDirectStatusSignal: boolean;
  transcript: {
    pathProvided: boolean;
    readable: boolean;
    parseableLines: number;
    malformedLines: number;
    userMessages: number;
    assistantMessages: number;
    toolCalls: number;
  };
  sessionIdentity: {
    inputSessionKeyPresent: boolean;
    transcriptHasSessionIds: boolean;
    transcriptSessionKeyCount: number;
    matchesInput?: boolean;
    mismatch: boolean;
  };
}

export function classifyLifecycleEvidence(input: StatusLineInput, transcript: TranscriptSummary): LifecycleEvidence {
  const parseableLines = transcript.parseableLines ?? Math.max(0, transcript.linesRead - transcript.malformedLines);
  const userMessages = transcript.userMessages ?? 0;
  const assistantMessages = transcript.assistantMessages ?? 0;
  const toolCalls = transcript.toolCalls || 0;
  const hasTranscriptActivity =
    userMessages > 0 ||
    assistantMessages > 0 ||
    toolCalls > 0 ||
    (transcript.failedToolResults || 0) > 0 ||
    (transcript.validationChecks || 0) > 0 ||
    (transcript.validationSuccesses || 0) > 0 ||
    (transcript.compactionEvents || 0) > 0 ||
    hasUsage(transcript.usage) ||
    hasUsage(transcript.latestUsage) ||
    Boolean(transcript.cacheReadShare);
  const hasDirectStatusSignal =
    input.contextPercent !== undefined ||
    input.rateLimitPercent !== undefined ||
    input.costUsd !== undefined ||
    hasUsage(input.usage);
  const hasCurrentActivity = hasTranscriptActivity || hasCurrentUsageActivity(input.usage) || nonZero(input.costUsd);
  const pathProvided = Boolean(input.transcriptPath);
  const inputSessionKey = sessionKeyFromId(input.sessionId);
  const transcriptSessionKeys = transcript.transcriptSessionKeys || [];
  const matchesInput =
    inputSessionKey && transcriptSessionKeys.length > 0
      ? transcriptSessionKeys.every((key) => key === inputSessionKey)
      : undefined;
  const status = lifecycleStatus({
    pathProvided,
    pathReadable: transcript.pathReadable,
    linesRead: transcript.linesRead,
    malformedLines: transcript.malformedLines,
    parseableLines,
    hasTranscriptActivity
  });

  return {
    status,
    hasCurrentActivity,
    hasTranscriptActivity,
    hasDirectStatusSignal,
    transcript: {
      pathProvided,
      readable: transcript.pathReadable,
      parseableLines,
      malformedLines: transcript.malformedLines,
      userMessages,
      assistantMessages,
      toolCalls
    },
    sessionIdentity: {
      inputSessionKeyPresent: Boolean(inputSessionKey),
      transcriptHasSessionIds: transcriptSessionKeys.length > 0 || Boolean(transcript.transcriptHasSessionIds),
      transcriptSessionKeyCount: transcript.transcriptSessionKeyCount ?? transcriptSessionKeys.length,
      matchesInput,
      mismatch: matchesInput === false
    }
  };
}

function lifecycleStatus(args: {
  pathProvided: boolean;
  pathReadable: boolean;
  linesRead: number;
  malformedLines: number;
  parseableLines: number;
  hasTranscriptActivity: boolean;
}): LifecycleEvidenceStatus {
  if (args.hasTranscriptActivity) {
    return "current";
  }
  if (!args.pathProvided) {
    return "no_transcript_path";
  }
  if (!args.pathReadable) {
    return "missing_transcript";
  }
  if (args.linesRead === 0) {
    return "empty_transcript";
  }
  if (args.malformedLines > 0 && args.parseableLines === 0) {
    return "malformed_transcript";
  }
  return "no_activity";
}

function hasUsage(usage: TokenUsage | undefined): boolean {
  return Boolean(
    usage &&
      (usage.inputTokens !== undefined ||
        usage.outputTokens !== undefined ||
        usage.cacheCreationInputTokens !== undefined ||
        usage.cacheReadInputTokens !== undefined ||
        usage.totalTokens !== undefined)
  );
}

function hasCurrentUsageActivity(usage: TokenUsage | undefined): boolean {
  return Boolean(
    usage &&
      (nonZero(usage.inputTokens) ||
        nonZero(usage.outputTokens) ||
        nonZero(usage.cacheCreationInputTokens) ||
        nonZero(usage.cacheReadInputTokens) ||
        nonZero(usage.totalTokens))
  );
}

function nonZero(value: number | undefined): boolean {
  return value !== undefined && value > 0;
}
