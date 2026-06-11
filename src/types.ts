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

export interface CacheReadSharePoint {
  ratio: number;
  totalInputTokens: number;
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  timestamp?: string;
}

export interface CacheReadShareSummary {
  peak: CacheReadSharePoint;
  current: CacheReadSharePoint;
  dropPercentagePoints: number;
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

export interface RedundantReadSummary {
  fileIdentityHash: string;
  unchangedFullFileReadCount: number;
  latestState: Extract<DecisionState, "Careful" | "Stop">;
  basename?: string;
}

export type ReadKind = "full" | "partial";

export interface ActiveFullFileReadSummary {
  fileIdentityHash: string;
  unchangedFullFileReadCount: number;
}

export interface InputTokenJumpSummary {
  previousInputTokens: number;
  currentInputTokens: number;
  inputTokenDelta: number;
  toolResultCount: number;
  thresholdTokens: number;
  crossedThreshold: boolean;
  timestamp?: string;
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
  meaningfulIntervention?: Array<"edit" | "validation_success" | "same_failure_success" | "possible_mutation">;
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
  tailTruncated?: boolean;
  linesRead: number;
  malformedLines: number;
  parseableLines?: number;
  userMessages?: number;
  assistantMessages?: number;
  transcriptHasSessionIds?: boolean;
  transcriptSessionKeys?: string[];
  transcriptSessionKeyCount?: number;
  toolCalls: number;
  readToolCalls: number;
  successfulEditResults?: number;
  failedEditResults?: number;
  unvalidatedEditResultCount?: number;
  changedFileIdentityCount?: number;
  unvalidatedChangedFileIdentityCount?: number;
  workContinuedAfterFailedEdit?: boolean;
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
  cacheReadShare?: CacheReadShareSummary;
  latestTimestamp?: string;
  latestLifecycleSource?: SessionStartSource;
  latestLifecycleTimestamp?: string;
  terminalEvents?: number;
  latestTerminalEvent?: Extract<HookEventKind, "stop" | "session_end">;
  latestTerminalTimestamp?: string;
  latestCompactionTimestamp?: string;
  redundantRead?: RedundantReadSummary;
  activeFullFileReads?: ActiveFullFileReadSummary[];
  latestInputTokenJump?: InputTokenJumpSummary;
  largestInputTokenJump?: InputTokenJumpSummary;
  // Gauge fields (PRD-01).
  ledger?: import("./edit-ledger.js").EditLedger;
  latestActivityKind?: ActivityKind;
}

export type ActivityKind = "edit" | "validate" | "read" | "exec" | "mcp" | "other";

export type HookEventKind =
  | "session_start"
  | "tool_success"
  | "tool_failure"
  | "tool_batch"
  | "compaction"
  | "stop"
  | "session_end"
  | "feedback";

export type CompactionStage = "pre" | "post";
export type SessionStartSource = "startup" | "resume" | "clear" | "compact" | "unknown";

export interface DerivedHookEvent {
  kind: HookEventKind;
  sessionKey?: string;
  timestamp: string;
  hookEventName: string;
  lifecycleSource?: SessionStartSource;
  compactionStage?: CompactionStage;
  toolName?: string;
  purpose?: string;
  category?: "MCP";
  identityHash?: string;
  fileIdentityHash?: string;
  readKind?: ReadKind;
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
        smoothedRecoveryRate?: number;
        effectiveSamples?: number;
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
        smoothedRecoveryRate?: number;
        effectiveSamples?: number;
        carefulLikeEpisodes?: number;
        stopLikeEpisodes?: number;
        confidence?: DecisionConfidence;
      }
    >
  >;
  retryHazards?: Partial<
    Record<
      FailureRecoveryCategory,
      Partial<
        Record<
          "1" | "2" | "3" | "4" | "5plus",
          {
            episodes?: number;
            recovered?: number;
            unrecovered?: number;
            recoveryRate?: number;
            smoothedRecoveryRate?: number;
            effectiveSamples?: number;
            confidence?: DecisionConfidence;
          }
        >
      >
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

export type GaugeLight = "green" | "blue" | "red" | "gray";
export type ActivityVerb = "retrying" | "testing" | "editing" | "exploring" | "idle";
export type FindingSeverity = "red" | "blue" | "info";

export interface Finding {
  category: string;
  severity: FindingSeverity;
  confidence: DecisionConfidence;
  evidence: string;
  fileHint?: string;
  note?: string;
}

export interface LedgerEntry {
  identityHash: string;
  basename?: string;
  edits: number;
  unchecked: boolean;
}

export interface GaugeFiles {
  edited: number;
  unchecked: number;
  latestUncheckedBasename?: string;
}

export interface GaugeFacts {
  contextPercent?: number;
  contextHighlighted?: boolean;
  costUsd?: number;
  costSource?: "claude" | "estimated";
  durationMs?: number;
  rateLimitPercent?: number;
}

export interface Gauge {
  light: GaugeLight;
  activity: ActivityVerb;
  activityTarget?: string;
  files: GaugeFiles;
  facts: GaugeFacts;
  findings: Finding[];
  sessionKey?: string;
  projectKey?: string;
  createdAt: string;
}

export interface Decision {
  // Advisor fields (decide() era). Optional since PRD-03: newly stored gauge decisions omit every
  // one of them. Historical v1/0.2/0.3 records still carry them and must keep loading. The
  // legacy-state mapping is the only place these are read back into the old vocabulary.
  state?: DecisionState;
  reasonCode?: string;
  diagnosisCode?: string;
  diagnosis?: string;
  confidence?: DecisionConfidence;
  baselineNote?: string;
  primaryEvidence?: string;
  evidence?: DecisionEvidence[];
  impact?: string;
  action?: string;
  costUsd?: number;
  costSource?: "claude" | "estimated";
  contextPercent?: number;
  rateLimitPercent?: number;
  sessionKey?: string;
  createdAt: string;
  // Gauge schema v2 fields (PRD-01). Optional so v1 records and bare decisions stay valid.
  schemaVersion?: 2;
  projectKey?: string;
  light?: GaugeLight;
  activity?: ActivityVerb;
  findings?: Finding[];
  ledger?: LedgerEntry[];
  files?: GaugeFiles;
}

export interface StoredDecision extends Decision {
  id: string;
}

export interface EventStoreData {
  version: 1 | 2;
  updatedAt: string;
  decisions: StoredDecision[];
  hookEvents: StoredHookEvent[];
  feedbackOutcomes: StoredFeedbackOutcome[];
}
