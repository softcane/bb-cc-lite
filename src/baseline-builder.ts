import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { baselinePath } from "./paths.js";
import { asRecord, extractUsage, mergeUsage, stringField } from "./status-input.js";
import { classifyResultPurpose, classifyToolIdentity } from "./tool-metadata.js";
import { readTranscriptTail } from "./transcript-reader.js";
import {
  type BaselineConfidence,
  type PersonalBaseline,
  type SafeToolCategory,
  type ToolCategoryAggregate,
  type ValidationAggregate,
  type ValidationCategory,
  writeBaseline
} from "./baseline.js";
import type { TokenUsage } from "./types.js";

const DEFAULT_MAX_FILES = 500;
const DEFAULT_MAX_BYTES_PER_TRANSCRIPT = 512 * 1024;
const SCAN_BUDGET_MS = 5_000;
const TRANSCRIPT_READ_CONCURRENCY = 8;
const RECENT_WINDOW_SIZE = 100;
const VALIDATION_CATEGORIES: ValidationCategory[] = ["tests", "lint", "typecheck", "build"];
const SAFE_TOOL_CATEGORIES: SafeToolCategory[] = [
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
];

export interface BuildBaselineOptions {
  homeDir?: string;
  appHomePath?: string;
  claudeProjectsDir?: string;
  maxFiles?: number;
  maxBytesPerTranscript?: number;
  now?: Date;
}

interface BuildCounters {
  transcriptFilesScanned: number;
  sessionsSeen: number;
  malformedLines: number;
  toolCalls: number;
  toolResults: number;
  failedToolResults: number;
  validationResults: number;
  validationFailures: number;
  successfulEditResults: number;
  readSearchToolCalls: number;
  cacheWritesHighSessions: number;
  repeatedFailureSessions: number;
  scenarios: {
    read_heavy_debugging: number;
    repeated_failure: number;
    validation_command_loop: number;
    edit_without_validation: number;
    validation_recovered: number;
  };
  recentScenarios: BuildCounters["scenarios"];
  outcomes: PersonalBaseline["outcomes"];
  validation: Record<ValidationCategory, ValidationBuildCounters>;
  editValidation: EditValidationBuildCounters;
  toolCategories: Partial<Record<SafeToolCategory, ToolCategoryBuildCounters>>;
}

interface TranscriptCandidate {
  path: string;
  mtimeMs: number;
}

interface ToolMeta {
  name: string;
  purpose?: string;
  category?: "MCP";
  identityHash?: string;
  isEdit: boolean;
  isReadSearch: boolean;
}

interface SessionCounters {
  malformedLines: number;
  toolCalls: number;
  toolResults: number;
  failedToolResults: number;
  validationResults: number;
  validationFailures: number;
  successfulEditResults: number;
  readSearchToolCalls: number;
  cacheWritesHigh: boolean;
  validationPassedAfterEdit: boolean;
  validationRecovered: boolean;
  editWithoutValidation: boolean;
  toolFailureRecovered: boolean;
  twoFailureStreakRecovered: boolean;
  validationLoopUnrecovered: boolean;
  toolLoopUnrecovered: boolean;
  sessionEndedInFailureLoop: boolean;
  repeatedFailure: boolean;
  validation: Record<ValidationCategory, ValidationBuildCounters>;
  editValidation: EditValidationBuildCounters;
  toolCategories: Partial<Record<SafeToolCategory, ToolCategoryBuildCounters>>;
}

interface ValidationBuildCounters {
  calls: number;
  failures: number;
  recovered: number;
  unrecovered: number;
  failuresBeforeRecovery: number[];
}

interface EditValidationBuildCounters {
  editsFollowedByValidation: number;
  editsWithoutValidation: number;
  toolStepsFromEditToValidation: number[];
}

interface ToolCategoryBuildCounters {
  calls: number;
  failures: number;
  repeatedFailureSessions: number;
  recovered: number;
  unrecovered: number;
}

interface ActiveFailure {
  count: number;
  validationCategory?: ValidationCategory;
  toolCategory?: SafeToolCategory;
}

export async function buildBaseline(options: BuildBaselineOptions = {}): Promise<{
  baseline: PersonalBaseline;
  written: boolean;
}> {
  const homeDir = options.homeDir ?? homedir();
  const claudeProjectsDir = options.claudeProjectsDir ?? join(homeDir, ".claude", "projects");
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytesPerTranscript = options.maxBytesPerTranscript ?? DEFAULT_MAX_BYTES_PER_TRANSCRIPT;
  const startedAt = Date.now();
  const deadlineMs = startedAt + SCAN_BUDGET_MS;
  const files = await listTranscriptFiles(claudeProjectsDir, maxFiles, deadlineMs);
  const counters = emptyCounters();
  const sessions = await summarizeTranscriptFiles(files, maxBytesPerTranscript, deadlineMs);

  for (const [index, session] of sessions.entries()) {
    addSessionCounters(counters, session, index < RECENT_WINDOW_SIZE);
  }

  const baseline = baselineFromCounters(counters, { maxFiles, maxBytesPerTranscript }, options.now ?? new Date());
  const written = baseline.source.transcriptFilesScanned > 0;
  if (written) {
    await writeBaseline(baseline, options.appHomePath ? join(options.appHomePath, "baseline.json") : baselinePath(homeDir));
  }
  return { baseline, written };
}

async function listTranscriptFiles(root: string, maxFiles: number, deadlineMs: number): Promise<string[]> {
  if (maxFiles <= 0 || Date.now() > deadlineMs) {
    return [];
  }

  const candidates: TranscriptCandidate[] = [];
  const pending = [root];

  while (pending.length > 0 && Date.now() <= deadlineMs) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (Date.now() > deadlineMs) {
        break;
      }
      const child = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(child);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const mtimeMs = await readableFileMtimeMs(child);
        if (mtimeMs !== undefined) {
          candidates.push({ path: child, mtimeMs });
        }
      }
    }
  }

  return candidates
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path))
    .slice(0, maxFiles)
    .map((candidate) => candidate.path);
}

async function readableFileMtimeMs(path: string): Promise<number | undefined> {
  try {
    const fileStat = await stat(path);
    return fileStat.isFile() ? fileStat.mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

async function summarizeTranscriptFiles(
  files: string[],
  maxBytesPerTranscript: number,
  deadlineMs: number
): Promise<SessionCounters[]> {
  const sessions: SessionCounters[] = [];

  for (let index = 0; index < files.length && Date.now() <= deadlineMs; index += TRANSCRIPT_READ_CONCURRENCY) {
    const batch = files.slice(index, index + TRANSCRIPT_READ_CONCURRENCY);
    const summaries = await Promise.all(
      batch.map(async (file) => {
        if (Date.now() > deadlineMs) {
          return undefined;
        }
        const tail = await readTranscriptTail(file, { maxBytes: maxBytesPerTranscript });
        return tail.pathReadable ? summarizeSession(tail.lines) : undefined;
      })
    );
    sessions.push(...summaries.filter((session): session is SessionCounters => session !== undefined));
  }

  return sessions;
}

function addSessionCounters(counters: BuildCounters, session: SessionCounters, isRecent: boolean): void {
  counters.transcriptFilesScanned += 1;
  counters.sessionsSeen += 1;
  counters.malformedLines += session.malformedLines;
  counters.toolCalls += session.toolCalls;
  counters.toolResults += session.toolResults;
  counters.failedToolResults += session.failedToolResults;
  counters.validationResults += session.validationResults;
  counters.validationFailures += session.validationFailures;
  counters.successfulEditResults += session.successfulEditResults;
  counters.readSearchToolCalls += session.readSearchToolCalls;
  counters.cacheWritesHighSessions += session.cacheWritesHigh ? 1 : 0;
  counters.repeatedFailureSessions += session.repeatedFailure ? 1 : 0;
  counters.scenarios.read_heavy_debugging += session.readSearchToolCalls >= 3 && session.failedToolResults === 0 ? 1 : 0;
  counters.scenarios.repeated_failure += session.repeatedFailure ? 1 : 0;
  counters.scenarios.validation_command_loop += session.validationLoopUnrecovered ? 1 : 0;
  counters.scenarios.edit_without_validation += session.editWithoutValidation ? 1 : 0;
  counters.scenarios.validation_recovered += session.validationRecovered ? 1 : 0;
  if (isRecent) {
    counters.recentScenarios.read_heavy_debugging += session.readSearchToolCalls >= 3 && session.failedToolResults === 0 ? 1 : 0;
    counters.recentScenarios.repeated_failure += session.repeatedFailure ? 1 : 0;
    counters.recentScenarios.validation_command_loop += session.validationLoopUnrecovered ? 1 : 0;
    counters.recentScenarios.edit_without_validation += session.editWithoutValidation ? 1 : 0;
    counters.recentScenarios.validation_recovered += session.validationRecovered ? 1 : 0;
  }
  counters.outcomes.healthyLike.validationPassedAfterEdit += session.validationPassedAfterEdit ? 1 : 0;
  counters.outcomes.healthyLike.validationRecovered += session.validationRecovered ? 1 : 0;
  counters.outcomes.healthyLike.readHeavyNoFailure += session.readSearchToolCalls >= 3 && session.failedToolResults === 0 ? 1 : 0;
  counters.outcomes.carefulLike.editWithoutValidation += session.editWithoutValidation ? 1 : 0;
  counters.outcomes.carefulLike.toolFailureRecovered += session.toolFailureRecovered ? 1 : 0;
  counters.outcomes.carefulLike.twoFailureStreakRecovered += session.twoFailureStreakRecovered ? 1 : 0;
  counters.outcomes.stopLike.validationLoopUnrecovered += session.validationLoopUnrecovered ? 1 : 0;
  counters.outcomes.stopLike.toolLoopUnrecovered += session.toolLoopUnrecovered ? 1 : 0;
  counters.outcomes.stopLike.sessionEndedInFailureLoop += session.sessionEndedInFailureLoop ? 1 : 0;
  mergeValidationCounters(counters.validation, session.validation);
  mergeEditValidationCounters(counters.editValidation, session.editValidation);
  mergeToolCategoryCounters(counters.toolCategories, session.toolCategories);
}

function summarizeSession(lines: string[]): SessionCounters {
  const toolById = new Map<string, ToolMeta>();
  const activeFailures = new Map<string, ActiveFailure>();
  let failedValidationSeen = false;
  let editPendingAnyValidation = false;
  let editPendingValidationSuccess = false;
  let toolResultStep = 0;
  const pendingEditSteps: number[] = [];
  let usage: TokenUsage = {};
  const session = emptySessionCounters();

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      session.malformedLines += 1;
      continue;
    }

    const entry = asRecord(parsed);
    if (!entry) {
      session.malformedLines += 1;
      continue;
    }
    usage = mergeUsage(usage, extractUsage(entry), extractUsage(asRecord(entry.message)));

    for (const toolUse of extractToolUses(entry)) {
      session.toolCalls += 1;
      const meta = metaFromToolName(toolUse.name, toolUse.input);
      if (meta.isReadSearch) {
        session.readSearchToolCalls += 1;
      }
      if (toolUse.id) {
        toolById.set(toolUse.id, meta);
      }
    }

    for (const toolResult of extractToolResults(entry)) {
      const meta = resolveMeta(toolResult, toolById);
      const key = failureKey(meta);
      const validationCategory = meta.name === "Bash" ? validationCategoryForPurpose(meta.purpose) : undefined;
      const toolCategory = safeToolCategory(meta);
      const isValidation = validationCategory !== undefined;
      toolResultStep += 1;
      session.toolResults += 1;
      if (toolCategory) {
        ensureToolCategoryCounters(session.toolCategories, toolCategory).calls += 1;
      }
      if (isValidation) {
        session.validationResults += 1;
        session.validation[validationCategory].calls += 1;
        if (pendingEditSteps.length > 0) {
          for (const editStep of pendingEditSteps) {
            session.editValidation.editsFollowedByValidation += 1;
            session.editValidation.toolStepsFromEditToValidation.push(toolResultStep - editStep);
          }
          pendingEditSteps.length = 0;
        }
        if (editPendingValidationSuccess && !toolResult.isError) {
          session.validationPassedAfterEdit = true;
          editPendingValidationSuccess = false;
        }
        editPendingAnyValidation = false;
      }

      if (!toolResult.isError) {
        const activeFailure = activeFailures.get(key);
        if (activeFailure && activeFailure.count > 0) {
          session.toolFailureRecovered = true;
          session.twoFailureStreakRecovered ||= activeFailure.count >= 2;
          session.validationRecovered ||= isValidation && failedValidationSeen;
          if (activeFailure.validationCategory) {
            const validation = session.validation[activeFailure.validationCategory];
            validation.recovered += 1;
            validation.failuresBeforeRecovery.push(activeFailure.count);
          }
          if (activeFailure.toolCategory) {
            ensureToolCategoryCounters(session.toolCategories, activeFailure.toolCategory).recovered += 1;
          }
          activeFailures.delete(key);
        }
        if (meta.isEdit) {
          session.successfulEditResults += 1;
          editPendingAnyValidation = true;
          editPendingValidationSuccess = true;
          pendingEditSteps.push(toolResultStep);
        }
        continue;
      }

      session.failedToolResults += 1;
      if (toolCategory) {
        ensureToolCategoryCounters(session.toolCategories, toolCategory).failures += 1;
      }
      const previousFailure = activeFailures.get(key);
      const nextFailureCount = (previousFailure?.count || 0) + 1;
      activeFailures.set(key, {
        count: nextFailureCount,
        validationCategory,
        toolCategory
      });
      session.repeatedFailure ||= nextFailureCount >= 2;
      if (toolCategory && nextFailureCount === 2) {
        ensureToolCategoryCounters(session.toolCategories, toolCategory).repeatedFailureSessions += 1;
      }
      if (isValidation) {
        session.validationFailures += 1;
        session.validation[validationCategory].failures += 1;
        failedValidationSeen = true;
      }
    }
  }

  session.cacheWritesHigh = (usage.cacheCreationInputTokens || 0) > (usage.cacheReadInputTokens || 0);
  session.editWithoutValidation = editPendingAnyValidation && session.successfulEditResults > 0;
  session.editValidation.editsWithoutValidation += pendingEditSteps.length;
  for (const [key, activeFailure] of activeFailures) {
    session.repeatedFailure ||= activeFailure.count >= 2;
    session.sessionEndedInFailureLoop ||= activeFailure.count >= 3;
    session.validationLoopUnrecovered ||= key === "Bash:tests" && activeFailure.count >= 3;
    session.toolLoopUnrecovered ||= activeFailure.count >= 3;
    if (activeFailure.validationCategory) {
      session.validation[activeFailure.validationCategory].unrecovered += 1;
    }
    if (activeFailure.toolCategory) {
      const toolCounters = ensureToolCategoryCounters(session.toolCategories, activeFailure.toolCategory);
      toolCounters.unrecovered += 1;
    }
  }

  return session;
}

function extractToolUses(entry: Record<string, unknown>): Array<{ id?: string; name: string; input?: unknown }> {
  const result: Array<{ id?: string; name: string; input?: unknown }> = [];
  for (const part of contentParts(entry)) {
    if (part.type === "tool_use") {
      const name = stringField(part.name);
      if (name) {
        result.push({ id: stringField(part.id), name, input: part.input });
      }
    }
  }

  const toolUse = asRecord(entry.tool_use) || asRecord(entry.toolUse);
  const directName = stringField(toolUse?.name) || stringField(entry.tool_name) || stringField(entry.toolName);
  if (directName && (entry.type === "tool_use" || toolUse)) {
    result.push({ id: stringField(toolUse?.id) || stringField(entry.tool_use_id), name: directName, input: toolUse?.input });
  }

  return result;
}

function extractToolResults(entry: Record<string, unknown>): Array<{
  toolUseId?: string;
  toolName?: string;
  isError: boolean;
  purpose?: string;
}> {
  const result: Array<{ toolUseId?: string; toolName?: string; isError: boolean; purpose?: string }> = [];
  for (const part of contentParts(entry)) {
    if (part.type === "tool_result") {
      result.push({
        toolUseId: stringField(part.tool_use_id) || stringField(part.toolUseId),
        toolName: stringField(part.name) || stringField(part.tool_name),
        isError: truthyError(part),
        purpose: classifyResultPurpose(part)
      });
    }
  }
  if (entry.type === "tool_result" || entry.type === "tool_result_delta") {
    result.push({
      toolUseId: stringField(entry.tool_use_id) || stringField(entry.toolUseId),
      toolName: stringField(entry.name) || stringField(entry.tool_name) || stringField(entry.toolName),
      isError: truthyError(entry),
      purpose: classifyResultPurpose(entry)
    });
  }
  return result;
}

function contentParts(entry: Record<string, unknown>): Record<string, unknown>[] {
  const message = asRecord(entry.message);
  const candidates = [entry.content, message?.content];
  const parts: Record<string, unknown>[] = [];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      parts.push(...candidate.flatMap((part) => (asRecord(part) ? [asRecord(part)!] : [])));
    } else if (asRecord(candidate)) {
      parts.push(asRecord(candidate)!);
    }
  }
  return parts;
}

function resolveMeta(
  toolResult: { toolUseId?: string; toolName?: string; purpose?: string },
  toolById: Map<string, ToolMeta>
): ToolMeta {
  const byId = toolResult.toolUseId ? toolById.get(toolResult.toolUseId) : undefined;
  if (byId) {
    return { ...byId, purpose: byId.name === "Bash" ? toolResult.purpose || byId.purpose : byId.purpose };
  }
  const meta = metaFromToolName(toolResult.toolName, undefined);
  return { ...meta, purpose: meta.name === "Bash" ? toolResult.purpose : meta.purpose };
}

function isValidationPurpose(purpose: string | undefined): boolean {
  return purpose === "tests" || purpose === "build" || purpose === "lint" || purpose === "typecheck";
}

function validationCategoryForPurpose(purpose: string | undefined): ValidationCategory | undefined {
  return isValidationPurpose(purpose) ? (purpose as ValidationCategory) : undefined;
}

function safeToolCategory(meta: ToolMeta): SafeToolCategory | undefined {
  if (meta.category === "MCP") {
    return "MCP";
  }
  if (meta.name === "Bash") {
    const category = validationCategoryForPurpose(meta.purpose);
    return category ? (`Bash:${category}` as SafeToolCategory) : undefined;
  }
  if (meta.name === "Read" || meta.name === "Grep" || meta.name === "Glob" || meta.name === "LS") {
    return meta.name;
  }
  if (meta.isEdit) {
    return "Edit";
  }
  return undefined;
}

function metaFromToolName(toolName: string | undefined, input: unknown): ToolMeta {
  const identity = classifyToolIdentity(toolName, input, { basenameOnly: true });
  return {
    name: identity.displayName,
    purpose: identity.purpose,
    category: identity.category,
    identityHash: identity.identityHash,
    isEdit: identity.isEdit,
    isReadSearch: identity.isReadSearch && (identity.displayName === "Read" || identity.displayName === "Grep" || identity.displayName === "Glob" || identity.displayName === "LS")
  };
}

function failureKey(meta: Pick<ToolMeta, "name" | "purpose" | "category" | "identityHash">): string {
  return meta.category === "MCP" && meta.identityHash ? `MCP:${meta.identityHash}` : `${meta.name}:${meta.purpose || "general"}`;
}

function truthyError(value: Record<string, unknown>): boolean {
  if (value.is_error === true || value.isError === true || value.error === true) {
    return true;
  }
  const status = stringField(value.status) || stringField(value.result);
  if (status && /error|failed|failure/i.test(status)) {
    return true;
  }
  const exitCode = value.exit_code ?? value.exitCode;
  return typeof exitCode === "number" && exitCode !== 0;
}

function mergeValidationCounters(
  target: Record<ValidationCategory, ValidationBuildCounters>,
  source: Record<ValidationCategory, ValidationBuildCounters>
): void {
  for (const category of VALIDATION_CATEGORIES) {
    target[category].calls += source[category].calls;
    target[category].failures += source[category].failures;
    target[category].recovered += source[category].recovered;
    target[category].unrecovered += source[category].unrecovered;
    target[category].failuresBeforeRecovery.push(...source[category].failuresBeforeRecovery);
  }
}

function mergeEditValidationCounters(target: EditValidationBuildCounters, source: EditValidationBuildCounters): void {
  target.editsFollowedByValidation += source.editsFollowedByValidation;
  target.editsWithoutValidation += source.editsWithoutValidation;
  target.toolStepsFromEditToValidation.push(...source.toolStepsFromEditToValidation);
}

function mergeToolCategoryCounters(
  target: Partial<Record<SafeToolCategory, ToolCategoryBuildCounters>>,
  source: Partial<Record<SafeToolCategory, ToolCategoryBuildCounters>>
): void {
  for (const [category, sourceCounters] of Object.entries(source) as Array<[SafeToolCategory, ToolCategoryBuildCounters]>) {
    const targetCounters = ensureToolCategoryCounters(target, category);
    targetCounters.calls += sourceCounters.calls;
    targetCounters.failures += sourceCounters.failures;
    targetCounters.repeatedFailureSessions += sourceCounters.repeatedFailureSessions;
    targetCounters.recovered += sourceCounters.recovered;
    targetCounters.unrecovered += sourceCounters.unrecovered;
  }
}

function validationAggregatesFromCounters(
  counters: Record<ValidationCategory, ValidationBuildCounters>
): Record<ValidationCategory, ValidationAggregate> {
  return {
    tests: validationAggregateFromCounters(counters.tests),
    lint: validationAggregateFromCounters(counters.lint),
    typecheck: validationAggregateFromCounters(counters.typecheck),
    build: validationAggregateFromCounters(counters.build)
  };
}

function validationAggregateFromCounters(counters: ValidationBuildCounters): ValidationAggregate {
  const recoveryTotal = counters.recovered + counters.unrecovered;
  return {
    calls: counters.calls,
    failures: counters.failures,
    failureRate: rate(counters.failures, counters.calls),
    recovered: counters.recovered,
    unrecovered: counters.unrecovered,
    recoveryRate: rate(counters.recovered, recoveryTotal),
    averageFailuresBeforeRecovery: average(counters.failuresBeforeRecovery),
    medianFailuresBeforeRecovery: percentile(counters.failuresBeforeRecovery, 0.5),
    p75FailuresBeforeRecovery: percentile(counters.failuresBeforeRecovery, 0.75),
    fivePlusFailuresBeforeRecovery: counters.failuresBeforeRecovery.filter((count) => count >= 5).length
  };
}

function editValidationFromCounters(counters: EditValidationBuildCounters): PersonalBaseline["editValidation"] {
  const totalEdits = counters.editsFollowedByValidation + counters.editsWithoutValidation;
  return {
    editsFollowedByValidation: counters.editsFollowedByValidation,
    editsWithoutValidation: counters.editsWithoutValidation,
    editWithoutValidationRate: rate(counters.editsWithoutValidation, totalEdits),
    medianToolStepsFromEditToValidation: percentile(counters.toolStepsFromEditToValidation, 0.5),
    p75ToolStepsFromEditToValidation: percentile(counters.toolStepsFromEditToValidation, 0.75)
  };
}

function toolCategoryAggregatesFromCounters(
  counters: Partial<Record<SafeToolCategory, ToolCategoryBuildCounters>>
): Partial<Record<SafeToolCategory, ToolCategoryAggregate>> {
  const result: Partial<Record<SafeToolCategory, ToolCategoryAggregate>> = {};
  for (const category of SAFE_TOOL_CATEGORIES) {
    const source = counters[category];
    if (!source || source.calls === 0) {
      continue;
    }
    const recoveryTotal = source.recovered + source.unrecovered;
    result[category] = {
      calls: source.calls,
      failures: source.failures,
      repeatedFailureSessions: source.repeatedFailureSessions,
      recovered: source.recovered,
      unrecovered: source.unrecovered,
      recoveryRate: rate(source.recovered, recoveryTotal)
    };
  }
  return result;
}

function ensureToolCategoryCounters(
  target: Partial<Record<SafeToolCategory, ToolCategoryBuildCounters>>,
  category: SafeToolCategory
): ToolCategoryBuildCounters {
  return (target[category] ??= {
    calls: 0,
    failures: 0,
    repeatedFailureSessions: 0,
    recovered: 0,
    unrecovered: 0
  });
}

function baselineFromCounters(
  counters: BuildCounters,
  sourceOptions: { maxFiles: number; maxBytesPerTranscript: number },
  now: Date
): PersonalBaseline {
  const timestamp = now.toISOString();
  return {
    schema: "bb-cc-lite.baseline.v1",
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    source: {
      kind: "local_transcript_scan",
      transcriptFilesScanned: counters.transcriptFilesScanned,
      sessionsSeen: counters.sessionsSeen,
      malformedLines: counters.malformedLines,
      maxBytesPerTranscript: sourceOptions.maxBytesPerTranscript,
      maxFiles: sourceOptions.maxFiles,
      scanStrategy: "mtime_desc_bounded_parallel",
      parallelism: TRANSCRIPT_READ_CONCURRENCY
    },
    privacy: {
      rawPromptsStored: false,
      rawAssistantTextStored: false,
      rawToolOutputStored: false,
      rawShellOutputStored: false,
      rawPathsStored: false,
      rawTranscriptPathsStored: false,
      rawWorkspacePathsStored: false,
      rawCommandsStored: false,
      rawFileContentsStored: false,
      rawSessionIdsStored: false,
      perSessionRowsStored: false
    },
    recent: {
      windowKind: "newest_files",
      windowSize: RECENT_WINDOW_SIZE,
      transcriptFilesScanned: Math.min(counters.transcriptFilesScanned, RECENT_WINDOW_SIZE),
      sessionsSeen: Math.min(counters.sessionsSeen, RECENT_WINDOW_SIZE)
    },
    totals: {
      toolCalls: counters.toolCalls,
      successfulToolResults: counters.toolResults - counters.failedToolResults,
      failedToolResults: counters.failedToolResults,
      validationCalls: counters.validationResults,
      validationFailures: counters.validationFailures,
      validationSuccesses: counters.validationResults - counters.validationFailures,
      successfulEditResults: counters.successfulEditResults,
      readSearchToolCalls: counters.readSearchToolCalls
    },
    scenarios: {
      read_heavy_debugging: scenario(counters.scenarios.read_heavy_debugging, counters.recentScenarios.read_heavy_debugging),
      repeated_failure: scenario(counters.scenarios.repeated_failure, counters.recentScenarios.repeated_failure),
      validation_command_loop: scenario(counters.scenarios.validation_command_loop, counters.recentScenarios.validation_command_loop),
      edit_without_validation: scenario(counters.scenarios.edit_without_validation, counters.recentScenarios.edit_without_validation),
      validation_recovered: scenario(counters.scenarios.validation_recovered, counters.recentScenarios.validation_recovered)
    },
    outcomes: counters.outcomes,
    rates: {
      toolFailureRate: rate(counters.failedToolResults, counters.toolResults),
      repeatedFailureRate: rate(counters.repeatedFailureSessions, counters.sessionsSeen),
      validationFailureRate: rate(counters.validationFailures, counters.validationResults),
      cacheWritesHighRate: rate(counters.cacheWritesHighSessions, counters.sessionsSeen)
    },
    validation: validationAggregatesFromCounters(counters.validation),
    editValidation: editValidationFromCounters(counters.editValidation),
    toolCategories: toolCategoryAggregatesFromCounters(counters.toolCategories)
  };
}

function scenario(seen: number, recentSeen: number): { seen: number; recentSeen: number; confidence: BaselineConfidence } {
  return { seen, recentSeen, confidence: confidenceForSeen(Math.max(seen, recentSeen)) };
}

function confidenceForSeen(seen: number): BaselineConfidence {
  if (seen >= 10) {
    return "high";
  }
  if (seen >= 3) {
    return "medium";
  }
  return "low";
}

function rate(count: number, total: number): number {
  return total > 0 ? Number((count / total).toFixed(4)) : 0;
}

function average(values: number[]): number {
  return values.length > 0 ? Number((values.reduce((total, value) => total + value, 0) / values.length).toFixed(4)) : 0;
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * percentileValue) - 1);
  return sorted[index] ?? 0;
}

function emptyCounters(): BuildCounters {
  return {
    transcriptFilesScanned: 0,
    sessionsSeen: 0,
    malformedLines: 0,
    toolCalls: 0,
    toolResults: 0,
    failedToolResults: 0,
    validationResults: 0,
    validationFailures: 0,
    successfulEditResults: 0,
    readSearchToolCalls: 0,
    cacheWritesHighSessions: 0,
    repeatedFailureSessions: 0,
    scenarios: {
      read_heavy_debugging: 0,
      repeated_failure: 0,
      validation_command_loop: 0,
      edit_without_validation: 0,
      validation_recovered: 0
    },
    recentScenarios: {
      read_heavy_debugging: 0,
      repeated_failure: 0,
      validation_command_loop: 0,
      edit_without_validation: 0,
      validation_recovered: 0
    },
    outcomes: {
      healthyLike: {
        validationPassedAfterEdit: 0,
        validationRecovered: 0,
        readHeavyNoFailure: 0
      },
      carefulLike: {
        editWithoutValidation: 0,
        toolFailureRecovered: 0,
        twoFailureStreakRecovered: 0
      },
      stopLike: {
        validationLoopUnrecovered: 0,
        toolLoopUnrecovered: 0,
        sessionEndedInFailureLoop: 0
      }
    },
    validation: emptyValidationCounters(),
    editValidation: emptyEditValidationCounters(),
    toolCategories: {}
  };
}

function emptySessionCounters(): SessionCounters {
  return {
    malformedLines: 0,
    toolCalls: 0,
    toolResults: 0,
    failedToolResults: 0,
    validationResults: 0,
    validationFailures: 0,
    successfulEditResults: 0,
    readSearchToolCalls: 0,
    cacheWritesHigh: false,
    validationPassedAfterEdit: false,
    validationRecovered: false,
    editWithoutValidation: false,
    toolFailureRecovered: false,
    twoFailureStreakRecovered: false,
    validationLoopUnrecovered: false,
    toolLoopUnrecovered: false,
    sessionEndedInFailureLoop: false,
    repeatedFailure: false,
    validation: emptyValidationCounters(),
    editValidation: emptyEditValidationCounters(),
    toolCategories: {}
  };
}

function emptyValidationCounters(): Record<ValidationCategory, ValidationBuildCounters> {
  return {
    tests: emptyValidationCategoryCounters(),
    lint: emptyValidationCategoryCounters(),
    typecheck: emptyValidationCategoryCounters(),
    build: emptyValidationCategoryCounters()
  };
}

function emptyValidationCategoryCounters(): ValidationBuildCounters {
  return {
    calls: 0,
    failures: 0,
    recovered: 0,
    unrecovered: 0,
    failuresBeforeRecovery: []
  };
}

function emptyEditValidationCounters(): EditValidationBuildCounters {
  return {
    editsFollowedByValidation: 0,
    editsWithoutValidation: 0,
    toolStepsFromEditToValidation: []
  };
}
