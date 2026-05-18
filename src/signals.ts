import { hashValue } from "./paths.js";
import { mergeUsage } from "./status-input.js";
import type { Decision, StatusLineInput, StoredDecision, TokenUsage, TranscriptSummary } from "./types.js";

export interface DecideOptions {
  previous?: StoredDecision;
}

export function decide(
  input: StatusLineInput,
  transcript: TranscriptSummary,
  options: DecideOptions = {}
): Decision {
  const now = new Date().toISOString();
  const usage = mergeUsage(input.usage, transcript.usage);
  const contextPercent = input.contextPercent;
  const sessionKey = hashValue(input.sessionId);
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

  const repeatedFailure = transcript.repeatedFailures
    .filter((item) => item.count >= 3)
    .sort((a, b) => b.count - a.count)[0];
  if (repeatedFailure) {
    const runningTests = repeatedFailure.toolName === "Bash" && repeatedFailure.purpose === "tests";
    return baseDecision({
      state: "Stop",
      reasonCode: "repeated_tool_failure",
      primaryEvidence: `${repeatedFailure.toolName} failed ${repeatedFailure.count}x${runningTests ? " running tests" : ""}`,
      impact: runningTests ? "Claude is retrying a broken test loop" : "Claude is retrying the same failing tool",
      action: runningTests
        ? "fix the test setup manually, then ask Claude to rerun only that test"
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
      action: "inspect the failing test manually, then ask Claude for one focused fix",
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
    return baseDecision({
      state: "Careful",
      reasonCode: "tool_failure_repeated",
      primaryEvidence: `${earlyRepeatedFailure.toolName} failed ${earlyRepeatedFailure.count}x${runningTests ? " running tests" : ""}`,
      impact: runningTests ? "Tests are failing repeatedly" : "A tool is starting to repeat failures",
      action: runningTests
        ? "pause and inspect the failing test before another retry"
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

  if (transcript.compactionEvents > 0) {
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

  if (cacheWritesHigh(usage)) {
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

function cacheWarm(usage: TokenUsage): boolean {
  const reads = usage.cacheReadInputTokens || 0;
  const writes = usage.cacheCreationInputTokens || 0;
  return reads > 0 && reads >= writes;
}
