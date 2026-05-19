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
  validationRecovered: boolean;
  compactionEvents: number;
  usage: TokenUsage;
  latestTimestamp?: string;
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
  confidence?: DecisionConfidence;
}

export interface DecisionPersonalBaseline {
  scenarios?: Partial<Record<string, BaselineScenarioSummary>>;
  outcomes?: {
    healthyLike?: Partial<Record<string, number>>;
    carefulLike?: Partial<Record<string, number>>;
    stopLike?: Partial<Record<string, number>>;
  };
  rates?: Partial<Record<string, number>>;
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
