import { sessionKeyFromId } from "./session.js";
import { mergeUsage } from "./status-input.js";
import { cacheReadSharePoint } from "./cache-efficiency.js";
import { classifyLifecycleEvidence } from "./lifecycle-evidence.js";
import { recoveryInsight } from "./recovery-stats.js";
import type {
  CacheReadSharePoint,
  Decision,
  DecisionPersonalBaseline,
  FailureRecoveryCategory,
  StatusLineInput,
  TokenUsage,
  TranscriptSummary
} from "./types.js";

export interface DecideOptions {
  previous?: {
    costUsd?: number;
  };
  baseline?: DecisionPersonalBaseline;
  budgetThresholds?: BudgetThresholds;
}

export interface BudgetThresholds {
  costUsd?: number;
  costTotalCarefulUsd?: number;
  costDeltaUsd?: number;
  costDeltaCarefulUsd?: number;
  durationMs?: number;
  durationCarefulMs?: number;
}

interface NormalizedBudgetThresholds {
  costUsd: number;
  costDeltaUsd: number;
  durationMs: number;
}

type ValidationPurpose = "tests" | "lint" | "typecheck" | "build";

const DEFAULT_BUDGET_THRESHOLDS: NormalizedBudgetThresholds = {
  costUsd: 2,
  costDeltaUsd: 0.5,
  durationMs: 45 * 60_000
};
const CACHE_EFFICIENCY_MIN_PEAK_RATIO = 0.3;
const CACHE_EFFICIENCY_MIN_TOTAL_INPUT_TOKENS = 1_000;
const CACHE_EFFICIENCY_DROP_THRESHOLD_RATIO = 0.2;
const CACHE_EFFICIENCY_COMPACTION_SUPPRESSION_ACTIVITY = 1;

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
  const budgetThresholds = normalizeBudgetThresholds(options.budgetThresholds ?? budgetThresholdsFromEnv());
  const costDelta = costUsd !== undefined && options.previous?.costUsd !== undefined ? costUsd - options.previous.costUsd : 0;
  const lifecycleEvidence = classifyLifecycleEvidence(input, transcript);

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

  if (lifecycleEvidence.sessionIdentity.mismatch) {
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

    return baseDecision({
      state: "Careful",
      reasonCode: "transcript_session_mismatch",
      primaryEvidence: "transcript session mismatch",
      impact: "bb could not trust transcript evidence for the current Claude session",
      action: "run bb-cc-lite doctor if this persists",
      input,
      usage,
      transcript,
      now,
      sessionKey,
      costUsd,
      costSource
    });
  }

  const priorFailureRisk = staleRepeatedFailureRisk(transcript);
  if (priorFailureRisk) {
    return baseDecision({
      state: "Careful",
      reasonCode: "prior_repeated_failure",
      diagnosisCode: "prior_repeated_failure",
      diagnosis: `prior ${priorFailureRisk.label} failures before resume`,
      confidence: "medium",
      primaryEvidence: `resumed after prior ${priorFailureRisk.label} failures`,
      impact: "Prior session evidence had repeated failures before this resume",
      action: "inspect first failure before retrying",
      input,
      usage,
      transcript,
      now,
      sessionKey,
      costUsd,
      costSource
    });
  }

  if (tailTruncatedWeakFailureRisk(transcript)) {
    return baseDecision({
      state: "Careful",
      reasonCode: "tail_truncated_failure_evidence",
      diagnosisCode: "tail_truncated_failure_evidence",
      diagnosis: "tail-truncated weak failure evidence",
      confidence: "medium",
      primaryEvidence: "tail-truncated weak failure evidence",
      impact: "The bounded transcript tail may be missing recovery or identity context",
      action: "inspect recent transcript context before stopping",
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
    const baselineInsight = recoveryInsightForFailure(options.baseline, repeatedFailure);
    const baselineUnrecoveredLoop = baselineInsight?.kind === "usually_unrecovered";
    const baselineUsuallyRecovers = baselineInsight?.kind === "usually_recovers";
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
          : baselineUnrecoveredLoop && baselineInsight
            ? baselineInsight.diagnosis
            : undefined,
      confidence: baselineUsuallyRecovers ? "medium" : baselineInsight?.confidence || "high",
      baselineNote: baselineUnrecoveredLoop && baselineInsight
        ? baselineInsight.baselineNote
        : baselineUsuallyRecovers && baselineInsight
          ? `${baselineInsight.baselineNote}; fixed retry limit still says stop`
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
        : baselineUnrecoveredLoop
          ? "stop retrying and inspect first failure"
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

  const budgetRepeatedFailure = transcript.repeatedFailures
    .filter((item) => item.count >= 2)
    .sort((a, b) => b.count - a.count)[0];
  if (
    budgetRepeatedFailure &&
    ((costUsd !== undefined && costUsd >= budgetThresholds.costUsd) || costDelta >= budgetThresholds.costDeltaUsd)
  ) {
    const costEvidence =
      costDelta >= budgetThresholds.costDeltaUsd ? `cost +${formatCost(costDelta)}` : budgetCostEvidence(costUsd || 0, costSource);
    return baseDecision({
      state: "Stop",
      reasonCode: "budget_with_repeated_failure",
      diagnosisCode: "budget_with_repeated_failure",
      diagnosis: "high cost plus repeated failures",
      confidence: "high",
      primaryEvidence: `${costEvidence} plus ${repeatedFailureEvidence(budgetRepeatedFailure)}`,
      impact: "high cost plus repeated failures",
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

  if ((transcript.redundantRead?.unchangedFullFileReadCount || 0) >= 3) {
    const readCount = transcript.redundantRead?.unchangedFullFileReadCount || 3;
    return baseDecision({
      state: "Stop",
      reasonCode: "redundant_read_loop",
      diagnosisCode: "redundant_read_loop",
      diagnosis: `same file reread ${formatFailureCount(readCount)}`,
      confidence: "high",
      primaryEvidence: redundantReadEvidence(transcript.redundantRead),
      impact: "Claude is rereading an unchanged file",
      action: "stop and ask why the same file is needed again",
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
    const baselineInsight = recoveryInsightForFailure(options.baseline, earlyRepeatedFailure);
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

  if ((transcript.redundantRead?.unchangedFullFileReadCount || 0) >= 2) {
    return baseDecision({
      state: "Careful",
      reasonCode: "redundant_read",
      diagnosisCode: "redundant_read_loop",
      diagnosis: "same file reread twice",
      confidence: "medium",
      primaryEvidence: redundantReadEvidence(transcript.redundantRead),
      impact: "Claude reread an unchanged file",
      action: "ask Claude to use existing context before rereading",
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

  const tokenJump = strongestCrossedInputTokenJump(transcript);
  if (tokenJump) {
    const primaryEvidence = inputTokenJumpEvidence(tokenJump);
    return baseDecision({
      state: "Careful",
      reasonCode: "tool_result_explosion",
      diagnosisCode: "tool_result_explosion",
      diagnosis: primaryEvidence,
      confidence: "medium",
      primaryEvidence,
      impact: inputTokenJumpImpact(tokenJump),
      action: "compact or narrow the next step",
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
      reasonCode: "compaction_goal_preservation",
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

  const cacheRegression = cacheEfficiencyRegression(input.usage, transcript);
  if (cacheRegression && !suppressCacheEfficiencyRegressionAfterCompaction(transcript)) {
    return baseDecision({
      state: "Careful",
      reasonCode: "cache_efficiency_regression",
      primaryEvidence: cacheEfficiencyEvidence(cacheRegression),
      impact: "Prompt cache reuse fell during this session",
      action: "keep the next prompt narrow",
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

  const budgetCarefulEvidence = budgetCarefulEvidenceFor(
    input,
    costDelta,
    costSource,
    budgetThresholds,
    options.baseline,
    lifecycleEvidence.hasCurrentActivity
  );
  if (budgetCarefulEvidence && isBusyWithoutProgress(transcript)) {
    return baseDecision({
      state: "Careful",
      reasonCode: "budget_busy_no_observed_progress",
      diagnosisCode: "budget_busy_no_observed_progress",
      diagnosis: "budget is high and no progress was observed",
      confidence: "medium",
      primaryEvidence: `${budgetCarefulEvidence} plus ${transcript.toolCalls} tool calls, no check or recovery seen`,
      impact: "Budget is high and no observed progress signal was seen",
      action: "pause and ask Claude what changed before continuing",
      input,
      usage,
      transcript,
      now,
      sessionKey,
      costUsd,
      costSource
    });
  }

  if (costDelta >= budgetThresholds.costDeltaUsd) {
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

  if (
    costUsd !== undefined &&
    costUsd >= budgetThresholds.costUsd &&
    !baselineSuppressesCostBudget(costUsd, options.baseline)
  ) {
    return baseDecision({
      state: "Careful",
      reasonCode: "cost_budget",
      primaryEvidence: budgetCostEvidence(costUsd, costSource),
      impact: "Session cost is above the budget threshold",
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

  if (
    input.durationMs !== undefined &&
    input.durationMs >= budgetThresholds.durationMs &&
    lifecycleEvidence.hasCurrentActivity &&
    !baselineSuppressesDurationBudget(input.durationMs, options.baseline)
  ) {
    return baseDecision({
      state: "Careful",
      reasonCode: "duration_budget",
      primaryEvidence: `session ran ${formatDuration(input.durationMs)}`,
      impact: "Session has been running longer than expected",
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

  if (isBusyWithoutProgress(transcript)) {
    return baseDecision({
      state: "Careful",
      reasonCode: "busy_no_observed_progress",
      diagnosisCode: "busy_no_observed_progress",
      diagnosis: `${transcript.toolCalls} tool calls, no check or recovery seen`,
      confidence: "medium",
      primaryEvidence: `${transcript.toolCalls} tool calls, no check or recovery seen`,
      impact: "Many safe activity signals were seen, but no observed progress signal was seen",
      action: "pause and ask Claude what changed",
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

  if (lifecycleEvidence.status === "missing_transcript") {
    return baseDecision({
      state: "Careful",
      reasonCode: "transcript_unavailable",
      primaryEvidence: "transcript unavailable",
      impact: "bb could not read current transcript evidence",
      action: "run bb-cc-lite doctor if this persists",
      input,
      usage,
      transcript,
      now,
      sessionKey,
      costUsd,
      costSource
    });
  }

  if (lifecycleEvidence.status === "malformed_transcript") {
    return baseDecision({
      state: "Careful",
      reasonCode: "transcript_unreadable",
      primaryEvidence: "transcript unreadable",
      impact: "bb could not parse current transcript evidence",
      action: "run bb-cc-lite doctor",
      input,
      usage,
      transcript,
      now,
      sessionKey,
      costUsd,
      costSource
    });
  }

  if (
    !lifecycleEvidence.hasCurrentActivity &&
    (lifecycleEvidence.status === "empty_transcript" ||
      lifecycleEvidence.status === "no_transcript_path" ||
      lifecycleEvidence.status === "no_activity")
  ) {
    const resumedIdle = transcript.latestLifecycleSource === "resume";
    return baseDecision({
      state: "Healthy",
      reasonCode: resumedIdle ? "resumed_idle_session" : "no_session_activity",
      primaryEvidence: resumedIdle ? "resumed idle session" : "no session activity yet",
      impact: resumedIdle ? "bb has no post-resume Claude activity to evaluate" : "bb has no current Claude activity to evaluate",
      action: "start when ready",
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

interface CacheEfficiencyRegression {
  peak: CacheReadSharePoint;
  current: CacheReadSharePoint;
}

function cacheEfficiencyRegression(inputUsage: TokenUsage, transcript: TranscriptSummary): CacheEfficiencyRegression | undefined {
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

function suppressCacheEfficiencyRegressionAfterCompaction(transcript: TranscriptSummary): boolean {
  return (
    transcript.compactionEvents > 0 &&
    transcript.postCompactionActivity <= CACHE_EFFICIENCY_COMPACTION_SUPPRESSION_ACTIVITY
  );
}

function cacheEfficiencyEvidence(regression: CacheEfficiencyRegression): string {
  return `cache reuse dropped from ${formatPercent(regression.peak.ratio)} to ${formatPercent(regression.current.ratio)}`;
}

function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
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

function isBusyWithoutProgress(transcript: TranscriptSummary): boolean {
  const nonReadToolCalls = Math.max(0, transcript.toolCalls - transcript.readToolCalls);
  return (
    transcript.toolCalls >= 8 &&
    nonReadToolCalls >= 6 &&
    transcript.failedToolResults === 0 &&
    !transcript.hasUnvalidatedEdits &&
    !hasObservedProgress(transcript) &&
    !isReadHeavyCurrentSession(transcript)
  );
}

function hasObservedProgress(transcript: TranscriptSummary): boolean {
  return Boolean(
    transcript.observedProgress ||
      transcript.validationRecovered ||
      (transcript.validationSuccesses || 0) > 0 ||
      (transcript.toolRecoveryEvents || 0) > 0
  );
}

function hasOpenCompactionBoundary(transcript: TranscriptSummary): boolean {
  return transcript.compactionEvents > 0 && transcript.postCompactionActivity === 0;
}

function staleRepeatedFailureRisk(transcript: TranscriptSummary): { label: string } | undefined {
  if (
    transcript.latestLifecycleSource !== "resume" ||
    !transcript.latestLifecycleTimestamp ||
    (transcript.latestTimestamp && transcript.latestTimestamp > transcript.latestLifecycleTimestamp)
  ) {
    return undefined;
  }

  if (transcript.blindRetry && transcript.blindRetry.blindRetryFailureCount >= 2) {
    return { label: priorRiskLabel(transcript.blindRetry.category, transcript.blindRetry.label) };
  }

  const repeatedFailure = transcript.repeatedFailures
    .filter((item) => item.count >= 2)
    .sort((a, b) => b.count - a.count)[0];
  if (!repeatedFailure) {
    return undefined;
  }

  return { label: priorRiskLabel(recoveryCategoryForFailure(repeatedFailure), repeatedFailure.toolName) };
}

function tailTruncatedWeakFailureRisk(transcript: TranscriptSummary): boolean {
  if (!transcript.tailTruncated) {
    return false;
  }
  if (transcript.blindRetry && transcript.blindRetry.blindRetryFailureCount >= 3 && weakFailureCategory(transcript.blindRetry.category)) {
    return true;
  }
  return transcript.repeatedFailures.some((failure) => failure.count >= 3 && weakRepeatedFailureIdentity(failure));
}

function weakFailureCategory(category: FailureRecoveryCategory): boolean {
  return category === "tool";
}

function weakRepeatedFailureIdentity(failure: { toolName: string; purpose?: string; category?: string; identityHash?: string }): boolean {
  return failure.toolName === "tool" || (!failure.purpose && !failure.category && !failure.identityHash && failure.toolName !== "Bash");
}

function priorRiskLabel(category: FailureRecoveryCategory | undefined, fallback: string): string {
  if (category === "tests") {
    return "test";
  }
  if (category === "lint" || category === "typecheck" || category === "build") {
    return category;
  }
  if (category === "mcp") {
    return "MCP tool";
  }
  return fallback === "Bash" || fallback === "tool" ? "tool" : fallback;
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

function recoveryInsightForFailure(
  baseline: DecisionPersonalBaseline | undefined,
  failure: { toolName: string; purpose?: string; category?: string; count: number }
) {
  const category = recoveryCategoryForFailure(failure);
  return category ? recoveryInsight(baseline, category, failure.count) : undefined;
}

function recoveryCategoryForFailure(failure: { toolName: string; purpose?: string; category?: string }): FailureRecoveryCategory | undefined {
  const validationPurpose = validationPurposeForFailure(failure);
  if (validationPurpose) {
    return validationPurpose;
  }
  if (isMcpFailure(failure)) {
    return "mcp";
  }
  if (failure.toolName === "Read" || (failure.toolName === "Bash" && failure.purpose === "read")) {
    return "read";
  }
  if (failure.toolName === "Grep") {
    return "grep";
  }
  if (failure.toolName === "Glob") {
    return "glob";
  }
  if (failure.toolName === "LS") {
    return "ls";
  }
  if (failure.toolName === "Edit" || failure.toolName === "MultiEdit" || failure.toolName === "Write") {
    return "edit";
  }
  return "tool";
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

function redundantReadEvidence(redundantRead: TranscriptSummary["redundantRead"]): string {
  if (!redundantRead) {
    return "same file reread";
  }
  const label = redundantRead.safeFileLabel ? ` (${redundantRead.safeFileLabel})` : "";
  return `same file reread ${formatFailureCount(redundantRead.unchangedFullFileReadCount)}${label}`;
}

function strongestCrossedInputTokenJump(transcript: TranscriptSummary): TranscriptSummary["latestInputTokenJump"] {
  if (transcript.latestInputTokenJump?.crossedThreshold) {
    return transcript.latestInputTokenJump;
  }
  return transcript.largestInputTokenJump?.crossedThreshold ? transcript.largestInputTokenJump : undefined;
}

function inputTokenJumpEvidence(jump: NonNullable<TranscriptSummary["latestInputTokenJump"]>): string {
  const delta = `~${formatWholeNumber(jump.inputTokenDelta)}`;
  if (jump.toolResultCount === 1) {
    return `single tool result added ${delta} tokens`;
  }
  if (jump.toolResultCount > 1) {
    return `context jumped by ${delta} tokens after tool output batch`;
  }
  return `context jumped by ${delta} tokens`;
}

function inputTokenJumpImpact(jump: NonNullable<TranscriptSummary["latestInputTokenJump"]>): string {
  if (jump.toolResultCount === 1) {
    return "One tool result was the only local tool output before the jump";
  }
  if (jump.toolResultCount > 1) {
    return "Token-jump heuristic from usage counters; recent tool output may be too broad";
  }
  return "Token-jump heuristic from usage counters; no local tool result was in that interval";
}

function validationPurposeLabel(purpose: ValidationPurpose): string {
  return purpose === "tests" ? "tests" : purpose;
}

function formatFailureCount(count: number): string {
  return count === 2 ? "twice" : `${count}x`;
}

function formatWholeNumber(value: number): string {
  return Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

function normalizeBudgetThresholds(thresholds: BudgetThresholds | undefined): NormalizedBudgetThresholds {
  return {
    costUsd: thresholdOrDefault(thresholds?.costTotalCarefulUsd ?? thresholds?.costUsd, DEFAULT_BUDGET_THRESHOLDS.costUsd),
    costDeltaUsd: thresholdOrDefault(
      thresholds?.costDeltaCarefulUsd ?? thresholds?.costDeltaUsd,
      DEFAULT_BUDGET_THRESHOLDS.costDeltaUsd
    ),
    durationMs: thresholdOrDefault(thresholds?.durationCarefulMs ?? thresholds?.durationMs, DEFAULT_BUDGET_THRESHOLDS.durationMs)
  };
}

function budgetThresholdsFromEnv(env: NodeJS.ProcessEnv = process.env): BudgetThresholds | undefined {
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

function budgetCostEvidence(costUsd: number, costSource: Decision["costSource"]): string {
  const cost = formatCost(costUsd);
  return costSource === "estimated" ? `estimated cost ${cost}` : `cost ${cost}`;
}

function budgetCarefulEvidenceFor(
  input: StatusLineInput,
  costDelta: number,
  costSource: Decision["costSource"],
  thresholds: NormalizedBudgetThresholds,
  baseline: DecisionPersonalBaseline | undefined,
  hasCurrentActivity = true
): string | undefined {
  if (costDelta >= thresholds.costDeltaUsd) {
    return `cost +${formatCost(costDelta)}`;
  }
  if (
    input.costUsd !== undefined &&
    input.costUsd >= thresholds.costUsd &&
    !baselineSuppressesCostBudget(input.costUsd, baseline)
  ) {
    return budgetCostEvidence(input.costUsd, costSource);
  }
  if (
    input.durationMs !== undefined &&
    input.durationMs >= thresholds.durationMs &&
    hasCurrentActivity &&
    !baselineSuppressesDurationBudget(input.durationMs, baseline)
  ) {
    return `session ran ${formatDuration(input.durationMs)}`;
  }
  return undefined;
}

function baselineSuppressesCostBudget(costUsd: number, baseline: DecisionPersonalBaseline | undefined): boolean {
  const budget = baseline?.budget;
  return Boolean(
    budget &&
      (budget.costSamples || 0) >= 3 &&
      budget.confidence !== "low" &&
      (budget.p90CostUsd || 0) >= costUsd
  );
}

function baselineSuppressesDurationBudget(durationMs: number, baseline: DecisionPersonalBaseline | undefined): boolean {
  const budget = baseline?.budget;
  return Boolean(
    budget &&
      (budget.durationSamples || 0) >= 3 &&
      budget.confidence !== "low" &&
      (budget.p90DurationMs || 0) >= durationMs
  );
}

function formatDuration(durationMs: number): string {
  const minutes = Math.max(1, Math.round(durationMs / 60_000));
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

function hasUnusualEditValidationLag(transcript: TranscriptSummary, baseline: DecisionPersonalBaseline | undefined): boolean {
  const currentLag = transcript.unvalidatedEditToolSteps;
  const p75 = baseline?.editValidation?.p75ToolStepsFromEditToValidation || 0;
  const followed = baseline?.editValidation?.editsFollowedByValidation || 0;
  return currentLag !== undefined && followed >= 5 && p75 > 0 && currentLag > p75;
}
