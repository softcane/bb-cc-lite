import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { baselinePath } from "./paths.js";

export const BASELINE_SCHEMA = "bb-cc-lite.baseline.v1";
export const BASELINE_VERSION = 1;
export const BASELINE_READ_MAX_BYTES = 64 * 1024;

export type BaselineConfidence = "low" | "medium" | "high";

export interface PersonalBaseline {
  schema: typeof BASELINE_SCHEMA;
  version: typeof BASELINE_VERSION;
  createdAt: string;
  updatedAt: string;
  source: {
    kind: "local_transcript_scan";
    transcriptFilesScanned: number;
    sessionsSeen: number;
    malformedLines: number;
    maxBytesPerTranscript: number;
  };
  privacy: {
    rawPromptsStored: false;
    rawToolOutputStored: false;
    rawPathsStored: false;
    rawCommandsStored: false;
    perSessionRowsStored: false;
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
  if (!root || containsForbiddenRawDataKey(root) || root.schema !== BASELINE_SCHEMA || root.version !== BASELINE_VERSION) {
    return false;
  }

  const source = asRecord(root.source);
  const privacy = asRecord(root.privacy);
  const totals = asRecord(root.totals);
  const scenarios = asRecord(root.scenarios);
  const outcomes = asRecord(root.outcomes);
  const rates = asRecord(root.rates);

  return (
    typeof root.createdAt === "string" &&
    typeof root.updatedAt === "string" &&
    isSource(source) &&
    isPrivacy(privacy) &&
    isTotals(totals) &&
    isScenarios(scenarios) &&
    isOutcomes(outcomes) &&
    isRates(rates)
  );
}

function isSource(value: Record<string, unknown> | undefined): boolean {
  return (
    value?.kind === "local_transcript_scan" &&
    isNonNegativeNumber(value.transcriptFilesScanned) &&
    isNonNegativeNumber(value.sessionsSeen) &&
    isNonNegativeNumber(value.malformedLines) &&
    isNonNegativeNumber(value.maxBytesPerTranscript)
  );
}

function isPrivacy(value: Record<string, unknown> | undefined): boolean {
  return (
    value?.rawPromptsStored === false &&
    value.rawToolOutputStored === false &&
    value.rawPathsStored === false &&
    value.rawCommandsStored === false &&
    value.perSessionRowsStored === false
  );
}

function isTotals(value: Record<string, unknown> | undefined): boolean {
  return (
    isNonNegativeNumber(value?.toolCalls) &&
    isNonNegativeNumber(value?.successfulToolResults) &&
    isNonNegativeNumber(value?.failedToolResults) &&
    isNonNegativeNumber(value?.validationCalls) &&
    isNonNegativeNumber(value?.validationFailures) &&
    isNonNegativeNumber(value?.validationSuccesses) &&
    isNonNegativeNumber(value?.successfulEditResults) &&
    isNonNegativeNumber(value?.readSearchToolCalls)
  );
}

function isScenarios(value: Record<string, unknown> | undefined): boolean {
  return (
    isScenario(asRecord(value?.read_heavy_debugging)) &&
    isScenario(asRecord(value?.repeated_failure)) &&
    isScenario(asRecord(value?.validation_command_loop)) &&
    isScenario(asRecord(value?.edit_without_validation)) &&
    isScenario(asRecord(value?.validation_recovered))
  );
}

function isScenario(value: Record<string, unknown> | undefined): boolean {
  return isNonNegativeNumber(value?.seen) && isConfidence(value?.confidence);
}

function isOutcomes(value: Record<string, unknown> | undefined): boolean {
  const healthyLike = asRecord(value?.healthyLike);
  const carefulLike = asRecord(value?.carefulLike);
  const stopLike = asRecord(value?.stopLike);
  return (
    isNonNegativeNumber(healthyLike?.validationPassedAfterEdit) &&
    isNonNegativeNumber(healthyLike?.validationRecovered) &&
    isNonNegativeNumber(healthyLike?.readHeavyNoFailure) &&
    isNonNegativeNumber(carefulLike?.editWithoutValidation) &&
    isNonNegativeNumber(carefulLike?.toolFailureRecovered) &&
    isNonNegativeNumber(carefulLike?.twoFailureStreakRecovered) &&
    isNonNegativeNumber(stopLike?.validationLoopUnrecovered) &&
    isNonNegativeNumber(stopLike?.toolLoopUnrecovered) &&
    isNonNegativeNumber(stopLike?.sessionEndedInFailureLoop)
  );
}

function isRates(value: Record<string, unknown> | undefined): boolean {
  return (
    isRate(value?.toolFailureRate) &&
    isRate(value?.repeatedFailureRate) &&
    isRate(value?.validationFailureRate) &&
    isRate(value?.cacheWritesHighRate)
  );
}

function isConfidence(value: unknown): value is BaselineConfidence {
  return value === "low" || value === "medium" || value === "high";
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRate(value: unknown): value is number {
  return isNonNegativeNumber(value) && value <= 1;
}

function sumCounts(value: Record<string, number>): number {
  return Object.values(value).reduce((total, count) => total + count, 0);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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
    if (FORBIDDEN_RAW_DATA_KEYS.has(key) || containsForbiddenRawDataKey(child)) {
      return true;
    }
  }
  return false;
}

const FORBIDDEN_RAW_DATA_KEYS = new Set([
  "assistantText",
  "command",
  "commands",
  "fileContent",
  "fileContents",
  "prompt",
  "prompts",
  "promptText",
  "rawCommand",
  "rawCommands",
  "rawPrompt",
  "rawPrompts",
  "rawSessionId",
  "rawSessionIds",
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

async function bestEffortChmod(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch {
    // Existing platform permissions are still acceptable when chmod is unavailable.
  }
}
