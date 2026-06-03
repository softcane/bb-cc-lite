import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { appHome, baselinePath, PROJECT_BASELINE_DIR_NAME, projectBaselinePath, projectKeyFromPath } from "./paths.js";
import type {
  BlindRetryAggregate,
  FailureRecoveryAggregate,
  FailureRecoveryCategory,
  RetryHazardTable
} from "./recovery-stats.js";

export const BASELINE_SCHEMA = "bb-cc-lite.baseline.v1";
export const BASELINE_VERSION = 1;
export const BASELINE_READ_MAX_BYTES = 64 * 1024;
export const PROJECT_BASELINE_MIN_SESSIONS = 10;

export type BaselineConfidence = "low" | "medium" | "high";
export type ValidationCategory = "tests" | "lint" | "typecheck" | "build";
export type SafeToolCategory =
  | "Bash:tests"
  | "Bash:lint"
  | "Bash:typecheck"
  | "Bash:build"
  | "Read"
  | "Grep"
  | "Glob"
  | "LS"
  | "Edit"
  | "MCP";

export interface ValidationAggregate {
  calls: number;
  failures: number;
  failureRate: number;
  recovered: number;
  unrecovered: number;
  recoveryRate: number;
  averageFailuresBeforeRecovery: number;
  medianFailuresBeforeRecovery: number;
  p75FailuresBeforeRecovery: number;
  fivePlusFailuresBeforeRecovery: number;
}

export interface ToolCategoryAggregate {
  calls: number;
  failures: number;
  repeatedFailureSessions: number;
  recovered: number;
  unrecovered: number;
  recoveryRate: number;
}

export interface PersonalBaseline {
  schema: typeof BASELINE_SCHEMA;
  version: typeof BASELINE_VERSION;
  createdAt: string;
  updatedAt: string;
  project?: {
    kind: "hashed_project";
    key: string;
  };
  source: {
    kind: "local_transcript_scan";
    transcriptFilesScanned: number;
    sessionsSeen: number;
    malformedLines: number;
    maxBytesPerTranscript: number;
    maxFiles?: number;
    scanStrategy?: "mtime_desc_bounded_parallel";
    parallelism?: number;
    scanBudgetMs?: number;
    scanDeadlineHit?: boolean;
    transcriptFilesDiscovered?: number;
    bytesPerTranscriptCap?: number;
  };
  privacy: {
    rawPromptsStored: false;
    rawAssistantTextStored?: false;
    rawToolOutputStored: false;
    rawShellOutputStored?: false;
    rawPathsStored: false;
    rawTranscriptPathsStored?: false;
    rawWorkspacePathsStored?: false;
    rawCommandsStored: false;
    rawFileContentsStored?: false;
    rawSessionIdsStored?: false;
    rawMcpNamesStored?: false;
    perSessionRowsStored: false;
  };
  recent?: {
    windowKind: "newest_files";
    windowSize: number;
    transcriptFilesScanned: number;
    sessionsSeen: number;
  };
  totals: {
    toolCalls: number;
    successfulToolResults: number;
    failedToolResults: number;
    validationCalls: number;
    validationFailures: number;
    validationSuccesses: number;
    successfulEditResults: number;
    readSearchToolCalls: number;
  };
  scenarios: {
    read_heavy_debugging: BaselineScenario;
    repeated_failure: BaselineScenario;
    validation_command_loop: BaselineScenario;
    edit_without_validation: BaselineScenario;
    validation_recovered: BaselineScenario;
  };
  outcomes: {
    healthyLike: {
      validationPassedAfterEdit: number;
      validationRecovered: number;
      readHeavyNoFailure: number;
    };
    carefulLike: {
      editWithoutValidation: number;
      toolFailureRecovered: number;
      twoFailureStreakRecovered: number;
    };
    stopLike: {
      validationLoopUnrecovered: number;
      toolLoopUnrecovered: number;
      sessionEndedInFailureLoop: number;
    };
  };
  rates: {
    toolFailureRate: number;
    repeatedFailureRate: number;
    validationFailureRate: number;
    cacheWritesHighRate: number;
  };
  validation?: Partial<Record<ValidationCategory, ValidationAggregate>>;
  editValidation?: {
    editsFollowedByValidation: number;
    editsWithoutValidation: number;
    editWithoutValidationRate: number;
    medianToolStepsFromEditToValidation: number;
    p75ToolStepsFromEditToValidation: number;
  };
  toolCategories?: Partial<Record<SafeToolCategory, ToolCategoryAggregate>>;
  failureRecovery?: Partial<Record<FailureRecoveryCategory, FailureRecoveryAggregate>>;
  blindRetry?: Partial<Record<FailureRecoveryCategory, BlindRetryAggregate>>;
  retryHazards?: RetryHazardTable;
  activity?: {
    highActivitySessions: number;
    busyNoProgressSessions: number;
    observedProgressSessions: number;
    readHeavySessions: number;
    confidence: BaselineConfidence;
  };
  budget?: {
    costSamples: number;
    durationSamples: number;
    p75CostUsd: number;
    p90CostUsd: number;
    p75DurationMs: number;
    p90DurationMs: number;
    confidence: BaselineConfidence;
  };
}

export interface BaselineSelection {
  source: "project" | "personal" | "none";
  baseline?: PersonalBaseline;
  projectKey?: string;
}

export interface ReadBaselineForProjectOptions {
  projectDir?: string;
  homeDir?: string;
  appHomePath?: string;
  personalPath?: string;
  projectPath?: string;
  minProjectSessions?: number;
}

interface BaselineScenario {
  seen: number;
  confidence: BaselineConfidence;
}

export async function readBaseline(path = baselinePath()): Promise<PersonalBaseline | undefined> {
  try {
    const fileStat = await stat(path);
    if (!fileStat.isFile() || fileStat.size > BASELINE_READ_MAX_BYTES) {
      return undefined;
    }
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return isPersonalBaseline(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function readBaselineForProject(options: ReadBaselineForProjectOptions = {}): Promise<BaselineSelection> {
  const personal = await readBaseline(personalBaselinePath(options));
  const projectKey = options.projectDir ? projectKeyFromPath(options.projectDir) : undefined;
  if (!projectKey) {
    return personal ? { source: "personal", baseline: personal } : { source: "none" };
  }

  const project = await readBaseline(options.projectPath ?? projectBaselinePath({ appHomePath: options.appHomePath, homeDir: options.homeDir, projectKey }));
  if (projectBaselineIsUsable(project, projectKey, options.minProjectSessions ?? PROJECT_BASELINE_MIN_SESSIONS)) {
    return { source: "project", baseline: project, projectKey };
  }
  if (personal) {
    return { source: "personal", baseline: personal, projectKey };
  }
  return { source: "none", projectKey };
}

export async function writeBaseline(baseline: PersonalBaseline, path = baselinePath()): Promise<void> {
  if (!isPersonalBaseline(baseline)) {
    throw new Error("invalid personal baseline");
  }

  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await bestEffortChmod(dir, 0o700);

  const tempPath = `${path}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(baseline, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(tempPath, 0o600);
  await rename(tempPath, path);
  await bestEffortChmod(path, 0o600);
}

function personalBaselinePath(options: Pick<ReadBaselineForProjectOptions, "homeDir" | "appHomePath" | "personalPath">): string {
  return options.personalPath ?? (options.appHomePath ? join(options.appHomePath, "baseline.json") : baselinePath(options.homeDir));
}

function projectBaselineIsUsable(baseline: PersonalBaseline | undefined, projectKey: string, minSessions: number): baseline is PersonalBaseline {
  return Boolean(baseline?.project?.key === projectKey && baseline.source.sessionsSeen >= minSessions);
}

export async function clearBaseline(path = baselinePath()): Promise<boolean> {
  try {
    await rm(path, { force: false });
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function clearAllBaselines(options: { homeDir?: string; appHomePath?: string; personalPath?: string } = {}): Promise<void> {
  await clearBaseline(personalBaselinePath(options));
  await rm(join(options.appHomePath ?? appHome(options.homeDir), PROJECT_BASELINE_DIR_NAME), { recursive: true, force: true });
}

export function summarizeBaseline(baseline: PersonalBaseline | undefined): string {
  if (!baseline) {
    return "No personal baseline found.";
  }
  return `Personal baseline: ${baseline.source.sessionsSeen} sessions, Healthy-like ${sumCounts(
    baseline.outcomes.healthyLike
  )}, Careful-like ${sumCounts(baseline.outcomes.carefulLike)}, Stop-like ${sumCounts(baseline.outcomes.stopLike)}.`;
}

function isPersonalBaseline(value: unknown): value is PersonalBaseline {
  const root = asRecord(value);
  if (
    !root ||
    containsForbiddenRawDataKey(root) ||
    containsRawMcpName(root) ||
    !hasOnlyKeys(root, ROOT_KEYS) ||
    root.schema !== BASELINE_SCHEMA ||
    root.version !== BASELINE_VERSION
  ) {
    return false;
  }

  const source = asRecord(root.source);
  const project = root.project === undefined ? undefined : asRecord(root.project);
  const privacy = asRecord(root.privacy);
  const recent = root.recent === undefined ? undefined : asRecord(root.recent);
  const totals = asRecord(root.totals);
  const scenarios = asRecord(root.scenarios);
  const outcomes = asRecord(root.outcomes);
  const rates = asRecord(root.rates);
  const validation = root.validation === undefined ? undefined : asRecord(root.validation);
  const editValidation = root.editValidation === undefined ? undefined : asRecord(root.editValidation);
  const toolCategories = root.toolCategories === undefined ? undefined : asRecord(root.toolCategories);
  const failureRecovery = root.failureRecovery === undefined ? undefined : asRecord(root.failureRecovery);
  const blindRetry = root.blindRetry === undefined ? undefined : asRecord(root.blindRetry);
  const retryHazards = root.retryHazards === undefined ? undefined : asRecord(root.retryHazards);
  const activity = root.activity === undefined ? undefined : asRecord(root.activity);
  const budget = root.budget === undefined ? undefined : asRecord(root.budget);

  return (
    isIsoTimestamp(root.createdAt) &&
    isIsoTimestamp(root.updatedAt) &&
    (root.project === undefined || isProject(project)) &&
    isSource(source) &&
    isPrivacy(privacy) &&
    (root.recent === undefined || isRecent(recent)) &&
    isTotals(totals) &&
    isScenarios(scenarios) &&
    isOutcomes(outcomes) &&
    isRates(rates) &&
    (root.validation === undefined || isValidationAggregates(validation)) &&
    (root.editValidation === undefined || isEditValidation(editValidation)) &&
    (root.toolCategories === undefined || isToolCategories(toolCategories)) &&
    (root.failureRecovery === undefined || isFailureRecoveryAggregates(failureRecovery)) &&
    (root.blindRetry === undefined || isBlindRetryAggregates(blindRetry)) &&
    (root.retryHazards === undefined || isRetryHazards(retryHazards)) &&
    (root.activity === undefined || isActivity(activity)) &&
    (root.budget === undefined || isBudget(budget))
  );
}

function isProject(value: Record<string, unknown> | undefined): boolean {
  return (
    value !== undefined &&
    hasOnlyKeys(value, PROJECT_KEYS) &&
    value.kind === "hashed_project" &&
    typeof value.key === "string" &&
    /^[a-f0-9]{64}$/u.test(value.key)
  );
}

function isSource(value: Record<string, unknown> | undefined): boolean {
  return (
    value !== undefined &&
    hasOnlyKeys(value, SOURCE_KEYS) &&
    value?.kind === "local_transcript_scan" &&
    isNonNegativeInteger(value.transcriptFilesScanned) &&
    isNonNegativeInteger(value.sessionsSeen) &&
    isNonNegativeInteger(value.malformedLines) &&
    isNonNegativeInteger(value.maxBytesPerTranscript) &&
    (value.maxFiles === undefined || isNonNegativeInteger(value.maxFiles)) &&
    (value.scanStrategy === undefined || value.scanStrategy === "mtime_desc_bounded_parallel") &&
    (value.parallelism === undefined || isNonNegativeInteger(value.parallelism)) &&
    (value.scanBudgetMs === undefined || isNonNegativeInteger(value.scanBudgetMs)) &&
    (value.scanDeadlineHit === undefined || typeof value.scanDeadlineHit === "boolean") &&
    (value.transcriptFilesDiscovered === undefined || isNonNegativeInteger(value.transcriptFilesDiscovered)) &&
    (value.bytesPerTranscriptCap === undefined || isNonNegativeInteger(value.bytesPerTranscriptCap))
  );
}

function isRecent(value: Record<string, unknown> | undefined): boolean {
  return (
    value !== undefined &&
    hasOnlyKeys(value, RECENT_KEYS) &&
    value.windowKind === "newest_files" &&
    isNonNegativeInteger(value.windowSize) &&
    isNonNegativeInteger(value.transcriptFilesScanned) &&
    isNonNegativeInteger(value.sessionsSeen)
  );
}

function isPrivacy(value: Record<string, unknown> | undefined): boolean {
  return (
    value !== undefined &&
    hasOnlyKeys(value, PRIVACY_KEYS) &&
    value?.rawPromptsStored === false &&
    (value.rawAssistantTextStored === undefined || value.rawAssistantTextStored === false) &&
    value.rawToolOutputStored === false &&
    (value.rawShellOutputStored === undefined || value.rawShellOutputStored === false) &&
    value.rawPathsStored === false &&
    (value.rawTranscriptPathsStored === undefined || value.rawTranscriptPathsStored === false) &&
    (value.rawWorkspacePathsStored === undefined || value.rawWorkspacePathsStored === false) &&
    value.rawCommandsStored === false &&
    (value.rawFileContentsStored === undefined || value.rawFileContentsStored === false) &&
    (value.rawSessionIdsStored === undefined || value.rawSessionIdsStored === false) &&
    (value.rawMcpNamesStored === undefined || value.rawMcpNamesStored === false) &&
    value.perSessionRowsStored === false
  );
}

function isActivity(value: Record<string, unknown> | undefined): boolean {
  return (
    value !== undefined &&
    hasOnlyKeys(value, ACTIVITY_KEYS) &&
    isNonNegativeInteger(value.highActivitySessions) &&
    isNonNegativeInteger(value.busyNoProgressSessions) &&
    isNonNegativeInteger(value.observedProgressSessions) &&
    isNonNegativeInteger(value.readHeavySessions) &&
    isConfidence(value.confidence)
  );
}

function isBudget(value: Record<string, unknown> | undefined): boolean {
  return (
    value !== undefined &&
    hasOnlyKeys(value, BUDGET_KEYS) &&
    isNonNegativeInteger(value.costSamples) &&
    isNonNegativeInteger(value.durationSamples) &&
    isNonNegativeNumber(value.p75CostUsd) &&
    isNonNegativeNumber(value.p90CostUsd) &&
    isNonNegativeInteger(value.p75DurationMs) &&
    isNonNegativeInteger(value.p90DurationMs) &&
    isConfidence(value.confidence)
  );
}

function isTotals(value: Record<string, unknown> | undefined): boolean {
  return (
    value !== undefined &&
    hasOnlyKeys(value, TOTALS_KEYS) &&
    isNonNegativeInteger(value?.toolCalls) &&
    isNonNegativeInteger(value?.successfulToolResults) &&
    isNonNegativeInteger(value?.failedToolResults) &&
    isNonNegativeInteger(value?.validationCalls) &&
    isNonNegativeInteger(value?.validationFailures) &&
    isNonNegativeInteger(value?.validationSuccesses) &&
    isNonNegativeInteger(value?.successfulEditResults) &&
    isNonNegativeInteger(value?.readSearchToolCalls)
  );
}

function isScenarios(value: Record<string, unknown> | undefined): boolean {
  return (
    value !== undefined &&
    hasOnlyKeys(value, SCENARIO_KEYS) &&
    isScenario(asRecord(value?.read_heavy_debugging)) &&
    isScenario(asRecord(value?.repeated_failure)) &&
    isScenario(asRecord(value?.validation_command_loop)) &&
    isScenario(asRecord(value?.edit_without_validation)) &&
    isScenario(asRecord(value?.validation_recovered))
  );
}

function isScenario(value: Record<string, unknown> | undefined): boolean {
  return (
    value !== undefined &&
    hasOnlyKeys(value, BASELINE_SCENARIO_KEYS) &&
    isNonNegativeInteger(value.seen) &&
    (value.recentSeen === undefined || isNonNegativeInteger(value.recentSeen)) &&
    isConfidence(value.confidence)
  );
}

function isOutcomes(value: Record<string, unknown> | undefined): boolean {
  if (!value || !hasOnlyKeys(value, OUTCOME_KEYS)) {
    return false;
  }
  const healthyLike = asRecord(value?.healthyLike);
  const carefulLike = asRecord(value?.carefulLike);
  const stopLike = asRecord(value?.stopLike);
  return (
    healthyLike !== undefined &&
    hasOnlyKeys(healthyLike, HEALTHY_OUTCOME_KEYS) &&
    carefulLike !== undefined &&
    hasOnlyKeys(carefulLike, CAREFUL_OUTCOME_KEYS) &&
    stopLike !== undefined &&
    hasOnlyKeys(stopLike, STOP_OUTCOME_KEYS) &&
    isNonNegativeInteger(healthyLike?.validationPassedAfterEdit) &&
    isNonNegativeInteger(healthyLike?.validationRecovered) &&
    isNonNegativeInteger(healthyLike?.readHeavyNoFailure) &&
    isNonNegativeInteger(carefulLike?.editWithoutValidation) &&
    isNonNegativeInteger(carefulLike?.toolFailureRecovered) &&
    isNonNegativeInteger(carefulLike?.twoFailureStreakRecovered) &&
    isNonNegativeInteger(stopLike?.validationLoopUnrecovered) &&
    isNonNegativeInteger(stopLike?.toolLoopUnrecovered) &&
    isNonNegativeInteger(stopLike?.sessionEndedInFailureLoop)
  );
}

function isRates(value: Record<string, unknown> | undefined): boolean {
  return (
    value !== undefined &&
    hasOnlyKeys(value, RATE_KEYS) &&
    isRate(value?.toolFailureRate) &&
    isRate(value?.repeatedFailureRate) &&
    isRate(value?.validationFailureRate) &&
    isRate(value?.cacheWritesHighRate)
  );
}

function isValidationAggregates(value: Record<string, unknown> | undefined): boolean {
  return (
    value !== undefined &&
    hasOnlyKeys(value, VALIDATION_CATEGORY_KEYS) &&
    Object.values(value).every((aggregate) => isValidationAggregate(asRecord(aggregate)))
  );
}

function isValidationAggregate(value: Record<string, unknown> | undefined): boolean {
  return (
    value !== undefined &&
    hasOnlyKeys(value, VALIDATION_AGGREGATE_KEYS) &&
    isNonNegativeInteger(value.calls) &&
    isNonNegativeInteger(value.failures) &&
    isRate(value.failureRate) &&
    isNonNegativeInteger(value.recovered) &&
    isNonNegativeInteger(value.unrecovered) &&
    isRate(value.recoveryRate) &&
    isNonNegativeNumber(value.averageFailuresBeforeRecovery) &&
    isNonNegativeInteger(value.medianFailuresBeforeRecovery) &&
    isNonNegativeInteger(value.p75FailuresBeforeRecovery) &&
    isNonNegativeInteger(value.fivePlusFailuresBeforeRecovery)
  );
}

function isEditValidation(value: Record<string, unknown> | undefined): boolean {
  return (
    value !== undefined &&
    hasOnlyKeys(value, EDIT_VALIDATION_KEYS) &&
    isNonNegativeInteger(value.editsFollowedByValidation) &&
    isNonNegativeInteger(value.editsWithoutValidation) &&
    isRate(value.editWithoutValidationRate) &&
    isNonNegativeInteger(value.medianToolStepsFromEditToValidation) &&
    isNonNegativeInteger(value.p75ToolStepsFromEditToValidation)
  );
}

function isToolCategories(value: Record<string, unknown> | undefined): boolean {
  return (
    value !== undefined &&
    Object.keys(value).every((key) => SAFE_TOOL_CATEGORY_KEYS.has(key)) &&
    Object.values(value).every((aggregate) => isToolCategoryAggregate(asRecord(aggregate)))
  );
}

function isToolCategoryAggregate(value: Record<string, unknown> | undefined): boolean {
  return (
    value !== undefined &&
    hasOnlyKeys(value, TOOL_CATEGORY_AGGREGATE_KEYS) &&
    isNonNegativeInteger(value.calls) &&
    isNonNegativeInteger(value.failures) &&
    isNonNegativeInteger(value.repeatedFailureSessions) &&
    isNonNegativeInteger(value.recovered) &&
    isNonNegativeInteger(value.unrecovered) &&
    isRate(value.recoveryRate)
  );
}

function isFailureRecoveryAggregates(value: Record<string, unknown> | undefined): boolean {
  return (
    value !== undefined &&
    Object.keys(value).every((key) => FAILURE_RECOVERY_CATEGORY_KEYS.has(key)) &&
    Object.values(value).every((aggregate) => isFailureRecoveryAggregate(asRecord(aggregate)))
  );
}

function isFailureRecoveryAggregate(value: Record<string, unknown> | undefined): boolean {
  return (
    value !== undefined &&
    hasOnlyKeys(value, FAILURE_RECOVERY_AGGREGATE_KEYS) &&
    isNonNegativeInteger(value.episodes) &&
    isNonNegativeInteger(value.recovered) &&
    isNonNegativeInteger(value.unrecovered) &&
    isNonNegativeInteger(value.activeEnded) &&
    isRate(value.recoveryRate) &&
    (value.smoothedRecoveryRate === undefined || isRate(value.smoothedRecoveryRate)) &&
    (value.effectiveSamples === undefined || isNonNegativeNumber(value.effectiveSamples)) &&
    isNonNegativeInteger(value.medianAttemptsBeforeRecovery) &&
    isNonNegativeInteger(value.p75AttemptsBeforeRecovery) &&
    isNonNegativeInteger(value.blindRetryEpisodes) &&
    isNonNegativeInteger(value.blindRetryRecovered) &&
    isNonNegativeInteger(value.blindRetryUnrecovered) &&
    isConfidence(value.confidence)
  );
}

function isBlindRetryAggregates(value: Record<string, unknown> | undefined): boolean {
  return (
    value !== undefined &&
    Object.keys(value).every((key) => FAILURE_RECOVERY_CATEGORY_KEYS.has(key)) &&
    Object.values(value).every((aggregate) => isBlindRetryAggregate(asRecord(aggregate)))
  );
}

function isBlindRetryAggregate(value: Record<string, unknown> | undefined): boolean {
  return (
    value !== undefined &&
    hasOnlyKeys(value, BLIND_RETRY_AGGREGATE_KEYS) &&
    isNonNegativeInteger(value.episodes) &&
    isNonNegativeInteger(value.recovered) &&
    isNonNegativeInteger(value.unrecovered) &&
    isRate(value.recoveryRate) &&
    (value.smoothedRecoveryRate === undefined || isRate(value.smoothedRecoveryRate)) &&
    (value.effectiveSamples === undefined || isNonNegativeNumber(value.effectiveSamples)) &&
    isNonNegativeInteger(value.carefulLikeEpisodes) &&
    isNonNegativeInteger(value.stopLikeEpisodes) &&
    isConfidence(value.confidence)
  );
}

function isRetryHazards(value: Record<string, unknown> | undefined): boolean {
  return (
    value !== undefined &&
    Object.keys(value).every((key) => FAILURE_RECOVERY_CATEGORY_KEYS.has(key)) &&
    Object.values(value).every((table) => isRetryHazardTable(asRecord(table)))
  );
}

function isRetryHazardTable(value: Record<string, unknown> | undefined): boolean {
  return (
    value !== undefined &&
    Object.keys(value).every((key) => RETRY_ATTEMPT_BUCKET_KEYS.has(key)) &&
    Object.values(value).every((aggregate) => isRetryHazardAggregate(asRecord(aggregate)))
  );
}

function isRetryHazardAggregate(value: Record<string, unknown> | undefined): boolean {
  return (
    value !== undefined &&
    hasOnlyKeys(value, RETRY_HAZARD_AGGREGATE_KEYS) &&
    isNonNegativeInteger(value.episodes) &&
    isNonNegativeInteger(value.recovered) &&
    isNonNegativeInteger(value.unrecovered) &&
    isRate(value.recoveryRate) &&
    isRate(value.smoothedRecoveryRate) &&
    isNonNegativeNumber(value.effectiveSamples) &&
    isConfidence(value.confidence)
  );
}

function isConfidence(value: unknown): value is BaselineConfidence {
  return value === "low" || value === "medium" || value === "high";
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && isNonNegativeNumber(value);
}

function isRate(value: unknown): value is number {
  return isNonNegativeNumber(value) && value <= 1;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && new Date(value).toISOString() === value;
}

function sumCounts(value: Record<string, number>): number {
  return Object.values(value).reduce((total, count) => total + count, 0);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function containsForbiddenRawDataKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsForbiddenRawDataKey(item));
  }
  const record = asRecord(value);
  if (!record) {
    return false;
  }
  for (const [key, child] of Object.entries(record)) {
    if (FORBIDDEN_RAW_DATA_KEYS.has(key) || FORBIDDEN_RAW_DATA_KEYS_NORMALIZED.has(normalizeKey(key)) || containsForbiddenRawDataKey(child)) {
      return true;
    }
  }
  return false;
}

function containsRawMcpName(value: unknown): boolean {
  if (typeof value === "string") {
    return /\bmcp__/u.test(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsRawMcpName(item));
  }
  const record = asRecord(value);
  if (!record) {
    return false;
  }
  return Object.entries(record).some(([key, child]) => /\bmcp__/u.test(key) || containsRawMcpName(child));
}

const ROOT_KEYS = new Set([
  "schema",
  "version",
  "createdAt",
  "updatedAt",
  "project",
  "source",
  "privacy",
  "recent",
  "totals",
  "scenarios",
  "outcomes",
  "rates",
  "validation",
  "editValidation",
  "toolCategories",
  "failureRecovery",
  "blindRetry",
  "retryHazards",
  "activity",
  "budget"
]);
const PROJECT_KEYS = new Set(["kind", "key"]);
const SOURCE_KEYS = new Set([
  "kind",
  "transcriptFilesScanned",
  "sessionsSeen",
  "malformedLines",
  "maxBytesPerTranscript",
  "maxFiles",
  "scanStrategy",
  "parallelism",
  "scanBudgetMs",
  "scanDeadlineHit",
  "transcriptFilesDiscovered",
  "bytesPerTranscriptCap"
]);
const PRIVACY_KEYS = new Set([
  "rawPromptsStored",
  "rawAssistantTextStored",
  "rawToolOutputStored",
  "rawShellOutputStored",
  "rawPathsStored",
  "rawTranscriptPathsStored",
  "rawWorkspacePathsStored",
  "rawCommandsStored",
  "rawFileContentsStored",
  "rawSessionIdsStored",
  "rawMcpNamesStored",
  "perSessionRowsStored"
]);
const RECENT_KEYS = new Set(["windowKind", "windowSize", "transcriptFilesScanned", "sessionsSeen"]);
const TOTALS_KEYS = new Set([
  "toolCalls",
  "successfulToolResults",
  "failedToolResults",
  "validationCalls",
  "validationFailures",
  "validationSuccesses",
  "successfulEditResults",
  "readSearchToolCalls"
]);
const SCENARIO_KEYS = new Set([
  "read_heavy_debugging",
  "repeated_failure",
  "validation_command_loop",
  "edit_without_validation",
  "validation_recovered"
]);
const BASELINE_SCENARIO_KEYS = new Set(["seen", "recentSeen", "confidence"]);
const OUTCOME_KEYS = new Set(["healthyLike", "carefulLike", "stopLike"]);
const HEALTHY_OUTCOME_KEYS = new Set(["validationPassedAfterEdit", "validationRecovered", "readHeavyNoFailure"]);
const CAREFUL_OUTCOME_KEYS = new Set(["editWithoutValidation", "toolFailureRecovered", "twoFailureStreakRecovered"]);
const STOP_OUTCOME_KEYS = new Set(["validationLoopUnrecovered", "toolLoopUnrecovered", "sessionEndedInFailureLoop"]);
const RATE_KEYS = new Set(["toolFailureRate", "repeatedFailureRate", "validationFailureRate", "cacheWritesHighRate"]);
const VALIDATION_CATEGORY_KEYS = new Set(["tests", "lint", "typecheck", "build"]);
const VALIDATION_AGGREGATE_KEYS = new Set([
  "calls",
  "failures",
  "failureRate",
  "recovered",
  "unrecovered",
  "recoveryRate",
  "averageFailuresBeforeRecovery",
  "medianFailuresBeforeRecovery",
  "p75FailuresBeforeRecovery",
  "fivePlusFailuresBeforeRecovery"
]);
const EDIT_VALIDATION_KEYS = new Set([
  "editsFollowedByValidation",
  "editsWithoutValidation",
  "editWithoutValidationRate",
  "medianToolStepsFromEditToValidation",
  "p75ToolStepsFromEditToValidation"
]);
const SAFE_TOOL_CATEGORY_KEYS = new Set([
  "Bash:tests",
  "Bash:lint",
  "Bash:typecheck",
  "Bash:build",
  "Read",
  "Grep",
  "Glob",
  "LS",
  "Edit",
  "MCP"
]);
const TOOL_CATEGORY_AGGREGATE_KEYS = new Set(["calls", "failures", "repeatedFailureSessions", "recovered", "unrecovered", "recoveryRate"]);
const FAILURE_RECOVERY_CATEGORY_KEYS = new Set([
  "tests",
  "lint",
  "typecheck",
  "build",
  "read",
  "grep",
  "glob",
  "ls",
  "edit",
  "mcp",
  "tool"
]);
const FAILURE_RECOVERY_AGGREGATE_KEYS = new Set([
  "episodes",
  "recovered",
  "unrecovered",
  "activeEnded",
  "recoveryRate",
  "smoothedRecoveryRate",
  "effectiveSamples",
  "medianAttemptsBeforeRecovery",
  "p75AttemptsBeforeRecovery",
  "blindRetryEpisodes",
  "blindRetryRecovered",
  "blindRetryUnrecovered",
  "confidence"
]);
const BLIND_RETRY_AGGREGATE_KEYS = new Set([
  "episodes",
  "recovered",
  "unrecovered",
  "recoveryRate",
  "smoothedRecoveryRate",
  "effectiveSamples",
  "carefulLikeEpisodes",
  "stopLikeEpisodes",
  "confidence"
]);
const RETRY_ATTEMPT_BUCKET_KEYS = new Set(["1", "2", "3", "4", "5plus"]);
const RETRY_HAZARD_AGGREGATE_KEYS = new Set([
  "episodes",
  "recovered",
  "unrecovered",
  "recoveryRate",
  "smoothedRecoveryRate",
  "effectiveSamples",
  "confidence"
]);
const ACTIVITY_KEYS = new Set([
  "highActivitySessions",
  "busyNoProgressSessions",
  "observedProgressSessions",
  "readHeavySessions",
  "confidence"
]);
const BUDGET_KEYS = new Set([
  "costSamples",
  "durationSamples",
  "p75CostUsd",
  "p90CostUsd",
  "p75DurationMs",
  "p90DurationMs",
  "confidence"
]);

const FORBIDDEN_RAW_DATA_KEYS = new Set([
  "args",
  "argument",
  "arguments",
  "assistantText",
  "command",
  "commandArgs",
  "commands",
  "content",
  "diff",
  "fileContent",
  "fileContents",
  "filePath",
  "filePaths",
  "file_path",
  "input",
  "message",
  "output",
  "patch",
  "path",
  "paths",
  "prompt",
  "prompts",
  "promptText",
  "rawCommand",
  "rawCommands",
  "rawPath",
  "rawPaths",
  "rawPrompt",
  "rawPrompts",
  "rawSessionId",
  "rawSessionIds",
  "rawMcpName",
  "rawMcpNames",
  "rawToolOutput",
  "rawToolOutputs",
  "sessionId",
  "sessionIds",
  "toolOutput",
  "toolOutputs",
  "transcriptPath",
  "transcriptPaths",
  "workspacePath",
  "workspacePaths"
]);

const FORBIDDEN_RAW_DATA_KEYS_NORMALIZED = new Set([...FORBIDDEN_RAW_DATA_KEYS, "cwd", "cwds"].map(normalizeKey));

function normalizeKey(value: string): string {
  return value.replaceAll(/[_-]/gu, "").toLowerCase();
}

async function bestEffortChmod(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch {
    // Existing platform permissions are still acceptable when chmod is unavailable.
  }
}
