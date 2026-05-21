import { sessionKeyFromId } from "./session.js";
import { mergeUsage } from "./status-input.js";
import { recoveryInsight } from "./recovery-stats.js";
import type { Decision, DecisionPersonalBaseline, StatusLineInput, StoredDecision, TokenUsage, TranscriptSummary } from "./types.js";

export interface DecideOptions {
  previous?: StoredDecision;
  baseline?: DecisionPersonalBaseline;
}

type ValidationPurpose = "tests" | "lint" | "typecheck" | "build";

export function decide(
  input: StatusLineInput,
  transcript: TranscriptSummary,
  options: DecideOptions = {}
): Decision {
  const now = new Date().toISOString();
  const usage = mergeUsage(input.usage, transcript.usage);
  const contextPercent = input.contextPercent;
  const sessionKey = sessionKeyFromId(input.sessionId);
  const costUsd = input.costUsd;
  const costSource = input.costSource;

  if (!input.rawValid) {
    return baseDecision({
      state: "Careful",
      reasonCode: "statusline_input_unavailable",
      primaryEvidence: "statusline input unavailable",
      impact: "Claude Code did not provide readable status JSON",
      action: "run bb-cc-lite doctor and check Claude Code settings",
      input,
      usage,
      transcript,
      now,
      sessionKey,
      costUsd,
      costSource
    });
  }

  if (transcript.blindRetry && transcript.blindRetry.blindRetryFailureCount >= 3) {
    const blindRetry = transcript.blindRetry;
    return baseDecision({
      state: "Stop",
      reasonCode: "blind_retry_loop",
      diagnosisCode: "blind_retry_loop",
      diagnosis: `same failure retried ${blindRetry.blindRetryFailureCount}x without a fix`,
      confidence: "high",
      primaryEvidence: `same ${blindRetry.label} failed ${formatFailureCount(blindRetry.blindRetryFailureCount)} without a fix`,
      impact: "Claude is repeating the same failure without a fix or passing check",
      action: "stop and inspect first failure",
      input,
      usage,
      transcript,
      now,
      sessionKey,
      costUsd,
      costSource
    });
  }

  const repeatedFailure = transcript.repeatedFailures
    .filter((item) => item.count >= 3)
    .sort((a, b) => b.count - a.count)[0];
  if (repeatedFailure) {
    const runningTests = repeatedFailure.toolName === "Bash" && repeatedFailure.purpose === "tests";
    const mcpFailure = isMcpFailure(repeatedFailure);
    const validationPurpose = validationPurposeForFailure(repeatedFailure);
    const validationLabel = validationPurpose ? validationPurposeLabel(validationPurpose) : undefined;
    const baselineInsight = validationPurpose
      ? recoveryInsight(options.baseline, validationPurpose, repeatedFailure.count)
      : mcpFailure
        ? recoveryInsight(options.baseline, "mcp", repeatedFailure.count)
        : undefined;
    const baselineUnrecoveredLoop = baselineInsight?.kind === "usually_unrecovered";
    const baselineStopLike = runningTests && supportsValidationLoopStop(options.baseline);
    return baseDecision({
      state: "Stop",
      reasonCode: "repeated_tool_failure",
      diagnosisCode: runningTests ? "validation_command_loop" : mcpFailure ? "mcp_tool_failure_repeated" : "tool_failure_repeated",
      diagnosis: mcpFailure
        ? baselineUnrecoveredLoop && baselineInsight
          ? baselineInsight.diagnosis
          : `MCP tool failed ${repeatedFailure.count}x`
        : runningTests
        ? baselineUnrecoveredLoop && baselineInsight
          ? baselineInsight.diagnosis
          : baselineStopLike
          ? "test loop: past runs ended badly"
          : `test loop: failed ${repeatedFailure.count}x`
        : validationLabel
          ? baselineUnrecoveredLoop && baselineInsight
            ? baselineInsight.diagnosis
            : `${validationLabel} failed ${formatFailureCount(repeatedFailure.count)}`
          : undefined,
      confidence: baselineInsight?.confidence || "high",
      baselineNote: baselineUnrecoveredLoop && baselineInsight
        ? baselineInsight.baselineNote
        : baselineStopLike
          ? "similar past loops usually needed intervention"
          : undefined,
      primaryEvidence: repeatedFailureEvidence(repeatedFailure),
      impact: mcpFailure
        ? "Claude is retrying the same failing MCP tool"
        : runningTests
          ? "Claude is retrying a broken test loop"
          : validationLabel
            ? `Claude is retrying a failing ${validationLabel} check`
          : "Claude is retrying the same failing tool",
      action: mcpFailure
        ? baselineUnrecoveredLoop
          ? "stop retrying and inspect first failure"
          : "inspect MCP server/tool config before more retries"
        : runningTests
        ? baselineUnrecoveredLoop
          ? "stop retrying and inspect first failure"
          : "inspect first failure"
        : validationLabel
          ? baselineUnrecoveredLoop
            ? "stop retrying and inspect first failure"
            : `inspect the first ${validationLabel} failure, then rerun that check`
        : repeatedFailure.toolName === "Bash"
          ? "fix the failing command manually, then ask Claude to rerun only that command"
          : `inspect the failing ${repeatedFailure.toolName} step manually before more retries`,
      input,
      usage,
      transcript,
      now,
      sessionKey,
      costUsd,
      costSource
    });
  }

  if (transcript.editTestLoopFailures >= 2) {
    return baseDecision({
      state: "Stop",
      reasonCode: "edit_test_retry_loop",
      primaryEvidence: `edit-test loop failed ${transcript.editTestLoopFailures}x`,
      impact: "More edits are likely to churn without a narrower failure target",
      action: "inspect the failing test manually, then ask Claude for one targeted fix",
      input,
      usage,
      transcript,
      now,
      sessionKey,
      costUsd,
      costSource
    });
  }

  if (transcript.blindRetry && transcript.blindRetry.blindRetryFailureCount >= 2) {
    const blindRetry = transcript.blindRetry;
    return baseDecision({
      state: "Careful",
      reasonCode: "blind_retry",
      diagnosisCode: "blind_retry_loop",
      diagnosis: `same ${blindRetry.label} failed twice without a fix`,
      confidence: "medium",
      primaryEvidence: `same ${blindRetry.label} failed twice without a fix`,
      impact: "Claude retried before making a successful edit or getting a passing check",
      action: "inspect first failure",
      input,
      usage,
      transcript,
      now,
      sessionKey,
      costUsd,
      costSource
    });
  }

  const earlyRepeatedFailure = transcript.repeatedFailures
    .filter((item) => item.count >= 2)
    .sort((a, b) => b.count - a.count)[0];
  if (earlyRepeatedFailure) {
    const runningTests = earlyRepeatedFailure.toolName === "Bash" && earlyRepeatedFailure.purpose === "tests";
    const mcpFailure = isMcpFailure(earlyRepeatedFailure);
    const validationPurpose = validationPurposeForFailure(earlyRepeatedFailure);
    const validationLabel = validationPurpose ? validationPurposeLabel(validationPurpose) : undefined;
    const baselineInsight = validationPurpose
      ? recoveryInsight(options.baseline, validationPurpose, earlyRepeatedFailure.count)
      : mcpFailure
        ? recoveryInsight(options.baseline, "mcp", earlyRepeatedFailure.count)
        : undefined;
    const quickRecovery = baselineInsight?.kind === "usually_recovers";
    return baseDecision({
      state: "Careful",
      reasonCode: "tool_failure_repeated",
      diagnosisCode: validationPurpose ? "validation_command_loop" : mcpFailure ? "mcp_tool_failure_repeated" : "tool_failure_repeated",
      diagnosis: mcpFailure
        ? `MCP tool failed ${earlyRepeatedFailure.count}x`
        : quickRecovery
          ? baselineInsight.diagnosis
          : undefined,
      confidence: quickRecovery ? baselineInsight.confidence : undefined,
      baselineNote: quickRecovery ? baselineInsight.baselineNote : undefined,
      primaryEvidence: repeatedFailureEvidence(earlyRepeatedFailure),
      impact: mcpFailure
        ? "Claude is retrying the same failing MCP tool"
        : runningTests
          ? "Tests are failing repeatedly"
          : validationLabel
            ? `${validationLabel} is failing repeatedly`
          : "A tool is starting to repeat failures",
      action: mcpFailure
        ? "inspect the failing MCP step before another retry"
        : quickRecovery
        ? "inspect first failure"
        : runningTests
        ? "pause and inspect the failing test before another retry"
        : validationLabel
        ? `pause and inspect the failing ${validationLabel} before another retry`
        : `inspect the failing ${earlyRepeatedFailure.toolName} step before another retry`,
      input,
      usage,
      transcript,
      now,
      sessionKey,
      costUsd,
      costSource
    });
  }

  if (contextPercent !== undefined && contextPercent >= 92) {
    return baseDecision({
      state: "Stop",
      reasonCode: "context_critical",
      primaryEvidence: `ctx ${contextPercent}%`,
      impact: "Context is almost full",
      action: "ask Claude for a handoff now, then compact or restart",
      input,
      usage,
      transcript,
      now,
      sessionKey,
      costUsd,
      costSource
    });
  }

  if (contextPercent !== undefined && contextPercent >= 80) {
    return baseDecision({
      state: "Careful",
      reasonCode: "context_high",
      primaryEvidence: `ctx ${contextPercent}%`,
      impact: "Context is getting tight",
      action: "ask Claude for a 6-bullet handoff before more work",
      input,
      usage,
      transcript,
      now,
      sessionKey,
      costUsd,
      costSource
    });
  }

  if (hasOpenCompactionBoundary(transcript)) {
    return baseDecision({
      state: "Careful",
      reasonCode: "compaction_boundary",
      primaryEvidence: `compaction event seen`,
      impact: "Session continuity may have shifted",
      action: "ask Claude to restate current goal and next 3 steps",
      input,
      usage,
      transcript,
      now,
      sessionKey,
      costUsd,
      costSource
    });
  }

  if (transcript.hasUnvalidatedEdits) {
    const unusualEditLag = hasUnusualEditValidationLag(transcript, options.baseline);
    return baseDecision({
      state: "Careful",
      reasonCode: "edit_without_validation",
      diagnosisCode: "edit_without_validation",
      diagnosis: unusualEditLag ? "edits have gone longer than usual without a check" : "edits have not been checked yet",
      confidence: "medium",
      baselineNote: unusualEditLag ? "past sessions usually checked edits sooner" : undefined,
      primaryEvidence: "edits have not been checked",
      impact: "A successful edit has not been checked by a test, lint, typecheck, or build yet",
      action: "ask Claude to run the smallest relevant check",
      input,
      usage,
      transcript,
      now,
      sessionKey,
      costUsd,
      costSource
    });
  }

  if (cacheWritesHigh(cacheRiskUsage(input.usage, transcript))) {
    return baseDecision({
      state: "Careful",
      reasonCode: "cache_writes_high",
      primaryEvidence: "cache writes high",
      impact: "Prompt cache is being created more than reused",
      action: "keep the next prompt narrow and avoid broad repo scans",
      input,
      usage,
      transcript,
      now,
      sessionKey,
      costUsd,
      costSource
    });
  }

  if (input.rateLimitPercent !== undefined && input.rateLimitPercent >= 85) {
    return baseDecision({
      state: "Careful",
      reasonCode: "rate_limit_high",
      primaryEvidence: `rate limit ${input.rateLimitPercent}%`,
      impact: "You are close to throttling",
      action: "slow down and keep the next request small",
      input,
      usage,
      transcript,
      now,
      sessionKey,
      costUsd,
      costSource
    });
  }

  const costDelta = costUsd !== undefined && options.previous?.costUsd !== undefined ? costUsd - options.previous.costUsd : 0;
  if (costDelta >= 0.5) {
    return baseDecision({
      state: "Careful",
      reasonCode: "cost_growth",
      primaryEvidence: `cost +${formatCost(costDelta)}`,
      impact: "Spend rose quickly since the last statusline update",
      action: "ask Claude to summarize progress before continuing",
      input,
      usage,
      transcript,
      now,
      sessionKey,
      costUsd,
      costSource
    });
  }

  if (transcript.validationRecovered) {
    return baseDecision({
      state: "Healthy",
      reasonCode: "validation_recovered",
      diagnosisCode: "validation_recovered",
      diagnosis: "validation recovered",
      confidence: "medium",
      primaryEvidence: "validation recovered",
      impact: "A failed validation later passed",
      action: "continue",
      input,
      usage,
      transcript,
      now,
      sessionKey,
      costUsd,
      costSource
    });
  }

  if (isReadHeavyCurrentSession(transcript) && supportsReadHeavyHealthy(options.baseline)) {
    return baseDecision({
      state: "Healthy",
      reasonCode: "read_heavy_debugging",
      diagnosisCode: "read_heavy_debugging",
      diagnosis: "research-heavy session usually ended OK",
      confidence: options.baseline?.scenarios?.read_heavy_debugging?.confidence || "medium",
      baselineNote: "similar research-heavy sessions usually ended OK",
      primaryEvidence: `${transcript.readToolCalls} read/search tool calls`,
      impact: "This matches past research-heavy sessions that ended OK",
      action: "continue",
      input,
      usage,
      transcript,
      now,
      sessionKey,
      costUsd,
      costSource
    });
  }

  return baseDecision({
    state: "Healthy",
    reasonCode: "healthy",
    primaryEvidence: contextPercent !== undefined ? `ctx ${contextPercent}%` : "no stop-level findings",
    impact: cacheWarm(usage) ? "cache warm" : "session stable",
    action: "continue normally",
    input,
    usage,
    transcript,
    now,
    sessionKey,
    costUsd,
    costSource
  });
}

export function formatCost(value: number): string {
  if (value < 0.01) {
    return `$${value.toFixed(4)}`;
  }
  if (value < 10) {
    return `$${value.toFixed(2)}`;
  }
  return `$${Math.round(value).toString()}`;
}

function baseDecision(args: {
  state: Decision["state"];
  reasonCode: string;
  diagnosisCode?: Decision["diagnosisCode"];
  diagnosis?: string;
  confidence?: Decision["confidence"];
  baselineNote?: string;
  primaryEvidence: string;
  impact: string;
  action: string;
  input: StatusLineInput;
  usage: TokenUsage;
  transcript: TranscriptSummary;
  now: string;
  sessionKey?: string;
  costUsd?: number;
  costSource?: Decision["costSource"];
}): Decision {
  const evidence: Decision["evidence"] = [{ label: args.primaryEvidence }];
  if (args.costUsd !== undefined) {
    evidence.push({
      label: args.costSource === "estimated" ? `${formatCost(args.costUsd)} est` : formatCost(args.costUsd),
      detail: args.costSource === "estimated" ? "estimated" : args.costSource
    });
  }
  if (args.impact && args.impact !== args.primaryEvidence) {
    evidence.push({ label: args.impact });
  }
  return {
    state: args.state,
    reasonCode: args.reasonCode,
    diagnosisCode: args.diagnosisCode,
    diagnosis: args.diagnosis,
    confidence: args.confidence,
    baselineNote: args.baselineNote,
    primaryEvidence: args.primaryEvidence,
    evidence,
    impact: args.impact,
    action: args.action,
    costUsd: args.costUsd,
    costSource: args.costSource,
    contextPercent: args.input.contextPercent,
    rateLimitPercent: args.input.rateLimitPercent,
    sessionKey: args.sessionKey,
    createdAt: args.now
  };
}

function cacheWritesHigh(usage: TokenUsage): boolean {
  const writes = usage.cacheCreationInputTokens || 0;
  const reads = usage.cacheReadInputTokens || 0;
  return writes >= 10_000 && reads < writes * 0.2;
}

function cacheRiskUsage(inputUsage: TokenUsage, transcript: TranscriptSummary): TokenUsage {
  if (hasCacheUsage(inputUsage)) {
    return inputUsage;
  }
  return hasFreshTranscriptCacheUsage(transcript) ? transcript.latestUsage || {} : {};
}

function hasFreshTranscriptCacheUsage(transcript: TranscriptSummary): boolean {
  if (!transcript.latestUsage || !hasCacheUsage(transcript.latestUsage)) {
    return false;
  }
  if (!transcript.latestTimestamp || !transcript.latestUsageTimestamp) {
    return true;
  }
  return transcript.latestUsageTimestamp >= transcript.latestTimestamp;
}

function hasCacheUsage(usage: TokenUsage): boolean {
  return usage.cacheCreationInputTokens !== undefined || usage.cacheReadInputTokens !== undefined;
}

function cacheWarm(usage: TokenUsage): boolean {
  const reads = usage.cacheReadInputTokens || 0;
  const writes = usage.cacheCreationInputTokens || 0;
  return reads > 0 && reads >= writes;
}

function isReadHeavyCurrentSession(transcript: TranscriptSummary): boolean {
  return (
    transcript.toolCalls >= 4 &&
    transcript.readToolCalls >= 3 &&
    transcript.readToolCalls / Math.max(1, transcript.toolCalls) >= 0.6 &&
    transcript.failedToolResults === 0 &&
    !transcript.hasUnvalidatedEdits
  );
}

function hasOpenCompactionBoundary(transcript: TranscriptSummary): boolean {
  return transcript.compactionEvents > 0 && transcript.postCompactionActivity === 0;
}

function supportsReadHeavyHealthy(baseline: DecisionPersonalBaseline | undefined): boolean {
  const scenario = baseline?.scenarios?.read_heavy_debugging;
  const healthyCount = baseline?.outcomes?.healthyLike?.readHeavyNoFailure || 0;
  const recentSessionsSeen = baseline?.recent?.sessionsSeen || 0;
  const recentSeen = scenario?.recentSeen;
  const recentHistoryIsEnough = recentSessionsSeen >= 3;
  const recentSupportsHealthy = recentSeen !== undefined && recentSeen >= 3;
  const allTimeSupportsHealthy = !recentHistoryIsEnough && (scenario?.seen || 0) >= 3;
  return Boolean(scenario && (recentSupportsHealthy || allTimeSupportsHealthy) && scenario.confidence !== "low" && healthyCount > 0);
}

function supportsValidationLoopStop(baseline: DecisionPersonalBaseline | undefined): boolean {
  const scenario = baseline?.scenarios?.validation_command_loop;
  const stopCount = baseline?.outcomes?.stopLike?.validationLoopUnrecovered || 0;
  return Boolean(scenario && scenario.seen >= 5 && scenario.confidence !== "low" && stopCount >= 5);
}

function validationPurposeForFailure(failure: { toolName: string; purpose?: string }): ValidationPurpose | undefined {
  if (failure.toolName !== "Bash") {
    return undefined;
  }
  return failure.purpose === "tests" || failure.purpose === "lint" || failure.purpose === "typecheck" || failure.purpose === "build"
    ? failure.purpose
    : undefined;
}

function isMcpFailure(failure: { toolName: string; category?: string }): boolean {
  return failure.category === "MCP" || failure.toolName === "MCP tool";
}

function repeatedFailureEvidence(failure: { toolName: string; purpose?: string; count: number; category?: string }): string {
  const validationPurpose = validationPurposeForFailure(failure);
  if (validationPurpose) {
    return `${validationPurposeLabel(validationPurpose)} failed ${formatFailureCount(failure.count)}`;
  }
  return `${isMcpFailure(failure) ? "MCP tool" : failure.toolName} failed ${failure.count}x${
    failure.toolName === "Bash" && failure.purpose === "tests" ? " running tests" : ""
  }`;
}

function validationPurposeLabel(purpose: ValidationPurpose): string {
  return purpose === "tests" ? "tests" : purpose;
}

function formatFailureCount(count: number): string {
  return count === 2 ? "twice" : `${count}x`;
}

function hasUnusualEditValidationLag(transcript: TranscriptSummary, baseline: DecisionPersonalBaseline | undefined): boolean {
  const currentLag = transcript.unvalidatedEditToolSteps;
  const p75 = baseline?.editValidation?.p75ToolStepsFromEditToValidation || 0;
  const followed = baseline?.editValidation?.editsFollowedByValidation || 0;
  return currentLag !== undefined && followed >= 5 && p75 > 0 && currentLag > p75;
}
