export type DecisionState = "Healthy" | "Careful" | "Stop";
export type DecisionConfidence = "low" | "medium" | "high";

export interface StatusLineModel {
  id?: string;
  displayName?: string;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  totalTokens?: number;
}

export interface StatusLineInput {
  rawValid: boolean;
  sessionId?: string;
  transcriptPath?: string;
  cwd?: string;
  model: StatusLineModel;
  costUsd?: number;
  costSource?: "claude" | "estimated";
  durationMs?: number;
  contextPercent?: number;
  rateLimitPercent?: number;
  usage: TokenUsage;
  terminalWidth?: number;
  parseError?: string;
}

export interface ToolFailureSummary {
  toolName: string;
  count: number;
  purpose?: string;
  category?: "MCP";
  identityHash?: string;
}

export type FailureRecoveryCategory =
  | "tests"
  | "lint"
  | "typecheck"
  | "build"
  | "read"
  | "grep"
  | "glob"
  | "ls"
  | "edit"
  | "mcp"
  | "tool";

export interface FailureEpisodeSummary {
  identity: string;
  category: FailureRecoveryCategory;
  label: string;
  attemptCount: number;
  recovered: boolean;
  activeEnded: boolean;
  blindRetryFailureCount: number;
  meaningfulIntervention?: Array<"edit" | "validation_success" | "same_failure_success">;
  identityHash?: string;
}

export interface BlindRetrySummary {
  category: FailureRecoveryCategory;
  label: string;
  attemptCount: number;
  recovered: boolean;
  activeEnded: boolean;
  blindRetryFailureCount: number;
  identityHash?: string;
}

export interface TranscriptSummary {
  pathReadable: boolean;
  bytesRead: number;
  linesRead: number;
  malformedLines: number;
  toolCalls: number;
  readToolCalls: number;
  successfulEditResults?: number;
  validationChecks?: number;
  validationSuccesses?: number;
  toolRecoveryEvents?: number;
  failedToolResults: number;
  repeatedFailures: ToolFailureSummary[];
  failureEpisodes?: FailureEpisodeSummary[];
  blindRetry?: BlindRetrySummary;
  editTestLoopFailures: number;
  hasUnvalidatedEdits: boolean;
  unvalidatedEditToolSteps?: number;
  validationRecovered: boolean;
  observedProgress?: boolean;
  compactionEvents: number;
  postCompactionActivity: number;
  usage: TokenUsage;
  latestUsage?: TokenUsage;
  latestUsageTimestamp?: string;
  latestTimestamp?: string;
  latestCompactionTimestamp?: string;
}

export type HookEventKind =
  | "tool_success"
  | "tool_failure"
  | "tool_batch"
  | "compaction"
  | "stop"
  | "session_end"
  | "feedback";

export interface DerivedHookEvent {
  kind: HookEventKind;
  sessionKey?: string;
  timestamp: string;
  hookEventName: string;
  toolName?: string;
  purpose?: string;
  category?: "MCP";
  identityHash?: string;
  toolCount?: number;
  feedbackAction?: "coach" | "guard";
  cooldownKey?: string;
}

export interface StoredHookEvent extends DerivedHookEvent {
  id: string;
}

export type FeedbackExpectedAction =
  | "run_validation"
  | "intervene_before_retry"
  | "summarize_or_narrow"
  | "validate_or_summarize";

export type FeedbackOutcomeState = "pending" | "followed" | "ignored" | "resolved" | "superseded";

export type FeedbackOutcomeSafeCategory =
  | "tests"
  | "lint"
  | "typecheck"
  | "build"
  | "tool"
  | "mcp"
  | "edit"
  | "budget"
  | "activity"
  | "finish";

export interface FeedbackOutcomeRecord {
  kind: "feedback_outcome";
  sessionKey?: string;
  feedbackAction: "coach" | "guard";
  cooldownKey: string;
  expectedAction: FeedbackExpectedAction;
  outcome: FeedbackOutcomeState;
  timestamp: string;
  safeCategory?: FeedbackOutcomeSafeCategory;
  reasonCode?: string;
  stateBefore?: DecisionState;
  stateAfter?: DecisionState;
}

export interface StoredFeedbackOutcome extends FeedbackOutcomeRecord {
  id: string;
}

export interface DecisionEvidence {
  label: string;
  detail?: string;
}

export interface BaselineScenarioSummary {
  seen: number;
  recentSeen?: number;
  confidence?: DecisionConfidence;
}

export interface DecisionPersonalBaseline {
  recent?: {
    windowKind?: "newest_files";
    windowSize?: number;
    transcriptFilesScanned?: number;
    sessionsSeen?: number;
  };
  scenarios?: Partial<Record<string, BaselineScenarioSummary>>;
  outcomes?: {
    healthyLike?: Partial<Record<string, number>>;
    carefulLike?: Partial<Record<string, number>>;
    stopLike?: Partial<Record<string, number>>;
  };
  rates?: Partial<Record<string, number>>;
  validation?: Partial<
    Record<
      "tests" | "lint" | "typecheck" | "build",
      {
        calls?: number;
        failures?: number;
        failureRate?: number;
        recovered?: number;
        unrecovered?: number;
        recoveryRate?: number;
        averageFailuresBeforeRecovery?: number;
        medianFailuresBeforeRecovery?: number;
        p75FailuresBeforeRecovery?: number;
        fivePlusFailuresBeforeRecovery?: number;
      }
    >
  >;
  editValidation?: {
    editsFollowedByValidation?: number;
    editsWithoutValidation?: number;
    editWithoutValidationRate?: number;
    medianToolStepsFromEditToValidation?: number;
    p75ToolStepsFromEditToValidation?: number;
  };
  toolCategories?: Partial<
    Record<
      string,
      {
        calls?: number;
        failures?: number;
        repeatedFailureSessions?: number;
        recovered?: number;
        unrecovered?: number;
        recoveryRate?: number;
      }
    >
  >;
  failureRecovery?: Partial<
    Record<
      FailureRecoveryCategory,
      {
        episodes?: number;
        recovered?: number;
        unrecovered?: number;
        activeEnded?: number;
        recoveryRate?: number;
        medianAttemptsBeforeRecovery?: number;
        p75AttemptsBeforeRecovery?: number;
        blindRetryEpisodes?: number;
        blindRetryRecovered?: number;
        blindRetryUnrecovered?: number;
        confidence?: DecisionConfidence;
      }
    >
  >;
  blindRetry?: Partial<
    Record<
      FailureRecoveryCategory,
      {
        episodes?: number;
        recovered?: number;
        unrecovered?: number;
        recoveryRate?: number;
        carefulLikeEpisodes?: number;
        stopLikeEpisodes?: number;
        confidence?: DecisionConfidence;
      }
    >
  >;
  activity?: {
    highActivitySessions?: number;
    busyNoProgressSessions?: number;
    observedProgressSessions?: number;
    readHeavySessions?: number;
    confidence?: DecisionConfidence;
  };
  budget?: {
    costSamples?: number;
    durationSamples?: number;
    p75CostUsd?: number;
    p90CostUsd?: number;
    p75DurationMs?: number;
    p90DurationMs?: number;
    confidence?: DecisionConfidence;
  };
}

export interface Decision {
  state: DecisionState;
  reasonCode: string;
  diagnosisCode?: string;
  diagnosis?: string;
  confidence?: DecisionConfidence;
  baselineNote?: string;
  primaryEvidence: string;
  evidence: DecisionEvidence[];
  impact: string;
  action: string;
  costUsd?: number;
  costSource?: "claude" | "estimated";
  contextPercent?: number;
  rateLimitPercent?: number;
  sessionKey?: string;
  createdAt: string;
}

export interface StoredDecision extends Decision {
  id: string;
}

export interface EventStoreData {
  version: 1;
  updatedAt: string;
  decisions: StoredDecision[];
  hookEvents: StoredHookEvent[];
  feedbackOutcomes: StoredFeedbackOutcome[];
}
