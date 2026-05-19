import { homedir } from "node:os";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { baselinePath } from "./paths.js";
import { asRecord, extractUsage, mergeUsage, stringField } from "./status-input.js";
import { isEditTool, safeToolName } from "./tool-metadata.js";
import { readTranscriptTail } from "./transcript-reader.js";
import { type BaselineConfidence, type PersonalBaseline, writeBaseline } from "./baseline.js";
import type { TokenUsage } from "./types.js";

const DEFAULT_MAX_FILES = 500;
const DEFAULT_MAX_BYTES_PER_TRANSCRIPT = 512 * 1024;
const SCAN_BUDGET_MS = 5_000;

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
  outcomes: PersonalBaseline["outcomes"];
}

interface ToolMeta {
  name: string;
  purpose?: string;
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
  const files = await listTranscriptFiles(claudeProjectsDir, maxFiles, startedAt + SCAN_BUDGET_MS);
  const counters = emptyCounters();

  for (const file of files) {
    if (Date.now() > startedAt + SCAN_BUDGET_MS) {
      break;
    }
    const tail = await readTranscriptTail(file, { maxBytes: maxBytesPerTranscript });
    if (!tail.pathReadable) {
      continue;
    }
    const session = summarizeSession(tail.lines);
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
    counters.outcomes.healthyLike.validationPassedAfterEdit += session.validationPassedAfterEdit ? 1 : 0;
    counters.outcomes.healthyLike.validationRecovered += session.validationRecovered ? 1 : 0;
    counters.outcomes.healthyLike.readHeavyNoFailure +=
      session.readSearchToolCalls >= 3 && session.failedToolResults === 0 ? 1 : 0;
    counters.outcomes.carefulLike.editWithoutValidation += session.editWithoutValidation ? 1 : 0;
    counters.outcomes.carefulLike.toolFailureRecovered += session.toolFailureRecovered ? 1 : 0;
    counters.outcomes.carefulLike.twoFailureStreakRecovered += session.twoFailureStreakRecovered ? 1 : 0;
    counters.outcomes.stopLike.validationLoopUnrecovered += session.validationLoopUnrecovered ? 1 : 0;
    counters.outcomes.stopLike.toolLoopUnrecovered += session.toolLoopUnrecovered ? 1 : 0;
    counters.outcomes.stopLike.sessionEndedInFailureLoop += session.sessionEndedInFailureLoop ? 1 : 0;
  }

  const baseline = baselineFromCounters(counters, maxBytesPerTranscript, options.now ?? new Date());
  const written = baseline.source.transcriptFilesScanned > 0;
  if (written) {
    await writeBaseline(baseline, options.appHomePath ? join(options.appHomePath, "baseline.json") : baselinePath(homeDir));
  }
  return { baseline, written };
}

async function listTranscriptFiles(root: string, maxFiles: number, deadlineMs: number): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];

  while (pending.length > 0 && files.length < maxFiles && Date.now() <= deadlineMs) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles || Date.now() > deadlineMs) {
        break;
      }
      const child = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(child);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(child);
      }
    }
  }

  return files;
}

function summarizeSession(lines: string[]): SessionCounters {
  const toolById = new Map<string, ToolMeta>();
  const activeFailures = new Map<string, number>();
  let failedValidationSeen = false;
  let editPendingAnyValidation = false;
  let editPendingValidationSuccess = false;
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
      const name = safeToolName(toolUse.name, { basenameOnly: true });
      const meta = {
        name,
        purpose: classifyPurpose(name, toolUse.input),
        isEdit: isEditTool(name, { basenameOnly: true }),
        isReadSearch: isReadSearchTool(name)
      };
      if (meta.isReadSearch) {
        session.readSearchToolCalls += 1;
      }
      if (toolUse.id) {
        toolById.set(toolUse.id, meta);
      }
    }

    for (const toolResult of extractToolResults(entry)) {
      const meta = resolveMeta(toolResult, toolById);
      const key = `${meta.name}:${meta.purpose || "general"}`;
      const isValidation = meta.name === "Bash" && isValidationPurpose(meta.purpose);
      session.toolResults += 1;
      if (isValidation) {
        session.validationResults += 1;
        if (editPendingValidationSuccess && !toolResult.isError) {
          session.validationPassedAfterEdit = true;
          editPendingValidationSuccess = false;
        }
        editPendingAnyValidation = false;
      }

      if (!toolResult.isError) {
        const failureCount = activeFailures.get(key) || 0;
        if (failureCount > 0) {
          session.toolFailureRecovered = true;
          session.twoFailureStreakRecovered ||= failureCount >= 2;
          session.validationRecovered ||= isValidation && failedValidationSeen;
          activeFailures.delete(key);
        }
        if (meta.isEdit) {
          session.successfulEditResults += 1;
          editPendingAnyValidation = true;
          editPendingValidationSuccess = true;
        }
        continue;
      }

      session.failedToolResults += 1;
      const nextFailureCount = (activeFailures.get(key) || 0) + 1;
      activeFailures.set(key, nextFailureCount);
      session.repeatedFailure ||= nextFailureCount >= 2;
      if (isValidation) {
        session.validationFailures += 1;
        failedValidationSeen = true;
      }
    }
  }

  session.cacheWritesHigh = (usage.cacheCreationInputTokens || 0) > (usage.cacheReadInputTokens || 0);
  session.editWithoutValidation = editPendingAnyValidation && session.successfulEditResults > 0;
  for (const [key, count] of activeFailures) {
    session.repeatedFailure ||= count >= 2;
    session.sessionEndedInFailureLoop ||= count >= 3;
    session.validationLoopUnrecovered ||= key === "Bash:tests" && count >= 3;
    session.toolLoopUnrecovered ||= count >= 3;
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
    return { ...byId, purpose: toolResult.purpose || byId.purpose };
  }
  const name = safeToolName(toolResult.toolName, { basenameOnly: true });
  return {
    name,
    purpose: toolResult.purpose,
    isEdit: isEditTool(name, { basenameOnly: true }),
    isReadSearch: isReadSearchTool(name)
  };
}

function classifyPurpose(toolName: string, input: unknown): string | undefined {
  if (toolName !== "Bash") {
    return undefined;
  }
  const command = stringField(asRecord(input)?.command);
  if (!command) {
    return undefined;
  }
  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\b(vitest|jest|mocha|pytest|cargo\s+test|go\s+test|rspec|playwright\s+test)\b/i.test(command)) {
    return "tests";
  }
  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?(build|compile)\b|\b(tsc|vite\s+build|cargo\s+build|go\s+build)\b/i.test(command)) {
    return "build";
  }
  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?lint\b|\b(eslint|ruff|flake8|cargo\s+clippy)\b/i.test(command)) {
    return "lint";
  }
  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?typecheck\b|\btsc\s+--noEmit\b|\bmypy\b/i.test(command)) {
    return "typecheck";
  }
  if (/^\s*git\b/i.test(command)) {
    return "git";
  }
  return undefined;
}

function classifyResultPurpose(part: Record<string, unknown>): string | undefined {
  const title = stringField(part.title) || stringField(part.summary);
  if (title && /test/i.test(title)) {
    return "tests";
  }
  return undefined;
}

function isValidationPurpose(purpose: string | undefined): boolean {
  return purpose === "tests" || purpose === "build" || purpose === "lint" || purpose === "typecheck";
}

function isReadSearchTool(toolName: string): boolean {
  return toolName === "Read" || toolName === "Grep" || toolName === "Glob" || toolName === "LS";
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

function baselineFromCounters(counters: BuildCounters, maxBytesPerTranscript: number, now: Date): PersonalBaseline {
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
      maxBytesPerTranscript
    },
    privacy: {
      rawPromptsStored: false,
      rawToolOutputStored: false,
      rawPathsStored: false,
      rawCommandsStored: false,
      perSessionRowsStored: false
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
      read_heavy_debugging: scenario(counters.scenarios.read_heavy_debugging),
      repeated_failure: scenario(counters.scenarios.repeated_failure),
      validation_command_loop: scenario(counters.scenarios.validation_command_loop),
      edit_without_validation: scenario(counters.scenarios.edit_without_validation),
      validation_recovered: scenario(counters.scenarios.validation_recovered)
    },
    outcomes: counters.outcomes,
    rates: {
      toolFailureRate: rate(counters.failedToolResults, counters.toolResults),
      repeatedFailureRate: rate(counters.repeatedFailureSessions, counters.sessionsSeen),
      validationFailureRate: rate(counters.validationFailures, counters.validationResults),
      cacheWritesHighRate: rate(counters.cacheWritesHighSessions, counters.sessionsSeen)
    }
  };
}

function scenario(seen: number): { seen: number; confidence: BaselineConfidence } {
  return { seen, confidence: confidenceForSeen(seen) };
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
    }
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
    repeatedFailure: false
  };
}
