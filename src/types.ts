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
}

export interface TranscriptSummary {
  pathReadable: boolean;
  bytesRead: number;
  linesRead: number;
  malformedLines: number;
  toolCalls: number;
  readToolCalls: number;
  failedToolResults: number;
  repeatedFailures: ToolFailureSummary[];
  editTestLoopFailures: number;
  hasUnvalidatedEdits: boolean;
  unvalidatedEditToolSteps?: number;
  validationRecovered: boolean;
  compactionEvents: number;
  postCompactionActivity: number;
  usage: TokenUsage;
  latestUsage?: TokenUsage;
  latestUsageTimestamp?: string;
  latestTimestamp?: string;
  latestCompactionTimestamp?: string;
}

export type HookEventKind = "tool_success" | "tool_failure" | "tool_batch" | "compaction" | "stop" | "session_end";

export interface DerivedHookEvent {
  kind: HookEventKind;
  sessionKey?: string;
  timestamp: string;
  hookEventName: string;
  toolName?: string;
  purpose?: string;
  toolCount?: number;
}

export interface StoredHookEvent extends DerivedHookEvent {
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
}
