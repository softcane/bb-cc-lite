import { asRecord, stringField } from "./status-input.js";
import { classifyResultPurpose, classifyToolIdentity, isEditTool, isReadSearchTool } from "./tool-metadata.js";
import { categoryFailureSingular, type FailureRecoveryCategory } from "./recovery-stats.js";
import type { ProjectConfig } from "./project-config.js";
import type { BlindRetrySummary, FailureEpisodeSummary, StoredHookEvent } from "./types.js";

type ToolResultOutcome = "success" | "failure";
type InterventionKind = "edit" | "validation_success" | "same_failure_success";

export interface SafeToolResultEvent {
  outcome: ToolResultOutcome;
  identity: string;
  category: FailureRecoveryCategory;
  label: string;
  toolName: string;
  purpose?: string;
  identityHash?: string;
  isEdit: boolean;
  isValidation: boolean;
  isReadSearch: boolean;
}

interface ToolMeta {
  name: string;
  purpose?: string;
  category?: "MCP";
  identityHash?: string;
  isEdit: boolean;
  isReadSearch: boolean;
}

interface ExtractSafeToolResultOptions {
  projectConfig?: ProjectConfig;
}

interface ActiveEpisode {
  identity: string;
  category: FailureRecoveryCategory;
  label: string;
  identityHash?: string;
  attemptCount: number;
  blindRunCount: number;
  maxBlindRunCount: number;
  meaningfulInterventionSinceFailure: boolean;
  interventionEvidence: Set<InterventionKind>;
}

export function extractFailureEpisodesFromTranscriptLines(
  lines: string[],
  options: ExtractSafeToolResultOptions = {}
): FailureEpisodeSummary[] {
  return summarizeFailureEpisodes(extractSafeToolResultEventsFromTranscriptLines(lines, options));
}

export function extractSafeToolResultEventsFromTranscriptLines(
  lines: string[],
  options: ExtractSafeToolResultOptions = {}
): SafeToolResultEvent[] {
  const toolById = new Map<string, ToolMeta>();
  const events: SafeToolResultEvent[] = [];

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const entry = asRecord(parsed);
    if (!entry) {
      continue;
    }

    for (const toolUse of extractToolUses(entry)) {
      if (toolUse.id) {
        toolById.set(toolUse.id, metaFromToolName(toolUse.name, toolUse.input, options.projectConfig));
      }
    }

    for (const toolResult of extractToolResults(entry)) {
      const meta = resolveMeta(toolResult, toolById);
      events.push(safeToolResultEvent(meta, toolResult.isError ? "failure" : "success"));
    }
  }

  return events;
}

export function safeToolResultEventFromHookEvent(event: StoredHookEvent): SafeToolResultEvent | undefined {
  if (event.kind !== "tool_success" && event.kind !== "tool_failure") {
    return undefined;
  }
  const meta = metaFromStoredHookEvent(event);
  return safeToolResultEvent(meta, event.kind === "tool_failure" ? "failure" : "success");
}

export function summarizeFailureEpisodes(events: SafeToolResultEvent[]): FailureEpisodeSummary[] {
  const active = new Map<string, ActiveEpisode>();
  const completed: FailureEpisodeSummary[] = [];

  for (const event of events) {
    if (event.outcome === "success") {
      const sameIdentityEpisode = active.get(event.identity);
      if (sameIdentityEpisode) {
        sameIdentityEpisode.interventionEvidence.add("same_failure_success");
        completed.push(toEpisodeSummary(sameIdentityEpisode, true, false));
        active.delete(event.identity);
      }
      if (event.isEdit || event.isValidation) {
        markMeaningfulIntervention(active, event.isEdit ? "edit" : "validation_success");
      }
      continue;
    }

    const episode = active.get(event.identity) || newEpisode(event);
    if (episode.attemptCount === 0) {
      episode.blindRunCount = 1;
    } else if (episode.meaningfulInterventionSinceFailure) {
      episode.blindRunCount = 1;
    } else {
      episode.blindRunCount += 1;
    }
    episode.attemptCount += 1;
    episode.maxBlindRunCount = Math.max(episode.maxBlindRunCount, episode.blindRunCount);
    episode.meaningfulInterventionSinceFailure = false;
    active.set(event.identity, episode);
  }

  for (const episode of active.values()) {
    completed.push(toEpisodeSummary(episode, false, true));
  }

  return completed;
}

export function summarizeBlindRetry(episodes: FailureEpisodeSummary[]): BlindRetrySummary | undefined {
  return episodes
    .filter((episode) => episode.activeEnded && episode.blindRetryFailureCount >= 2)
    .sort((left, right) => right.blindRetryFailureCount - left.blindRetryFailureCount || right.attemptCount - left.attemptCount)[0];
}

function markMeaningfulIntervention(active: Map<string, ActiveEpisode>, kind: InterventionKind): void {
  for (const episode of active.values()) {
    episode.meaningfulInterventionSinceFailure = true;
    episode.interventionEvidence.add(kind);
  }
}

function newEpisode(event: SafeToolResultEvent): ActiveEpisode {
  return {
    identity: event.identity,
    category: event.category,
    label: event.label,
    identityHash: event.identityHash,
    attemptCount: 0,
    blindRunCount: 0,
    maxBlindRunCount: 0,
    meaningfulInterventionSinceFailure: false,
    interventionEvidence: new Set()
  };
}

function toEpisodeSummary(episode: ActiveEpisode, recovered: boolean, activeEnded: boolean): FailureEpisodeSummary {
  return {
    identity: episode.identity,
    category: episode.category,
    label: episode.label,
    identityHash: episode.identityHash,
    attemptCount: episode.attemptCount,
    recovered,
    activeEnded,
    meaningfulIntervention:
      episode.interventionEvidence.size > 0 ? [...episode.interventionEvidence].sort() : undefined,
    blindRetryFailureCount: episode.maxBlindRunCount
  };
}

function safeToolResultEvent(meta: ToolMeta, outcome: ToolResultOutcome): SafeToolResultEvent {
  const category = failureRecoveryCategory(meta);
  return {
    outcome,
    identity: failureIdentity(meta, category),
    category,
    label: failureLabel(category),
    toolName: meta.category === "MCP" ? "MCP tool" : meta.name,
    purpose: meta.purpose,
    identityHash: meta.category === "MCP" ? meta.identityHash : undefined,
    isEdit: meta.isEdit,
    isValidation: isValidationCategory(category),
    isReadSearch: meta.isReadSearch
  };
}

function failureRecoveryCategory(meta: ToolMeta): FailureRecoveryCategory {
  if (meta.category === "MCP") {
    return "mcp";
  }
  if (meta.name === "Bash") {
    const category = validationCategoryForPurpose(meta.purpose);
    return category || (meta.purpose === "read" ? "read" : "tool");
  }
  if (meta.name === "Read") {
    return "read";
  }
  if (meta.name === "Grep") {
    return "grep";
  }
  if (meta.name === "Glob") {
    return "glob";
  }
  if (meta.name === "LS") {
    return "ls";
  }
  if (meta.isEdit) {
    return "edit";
  }
  return "tool";
}

function failureIdentity(meta: ToolMeta, category: FailureRecoveryCategory): string {
  if (category === "mcp") {
    return `mcp:${meta.identityHash || "aggregate"}`;
  }
  if (category === "tests" || category === "lint" || category === "typecheck" || category === "build") {
    return `validation:${category}`;
  }
  return `category:${category}`;
}

function failureLabel(category: FailureRecoveryCategory): string {
  return categoryFailureSingular(category);
}

function isValidationCategory(category: FailureRecoveryCategory): boolean {
  return category === "tests" || category === "lint" || category === "typecheck" || category === "build";
}

function validationCategoryForPurpose(purpose: string | undefined): FailureRecoveryCategory | undefined {
  return purpose === "tests" || purpose === "lint" || purpose === "typecheck" || purpose === "build" ? purpose : undefined;
}

function metaFromToolName(toolName: string | undefined, input: unknown, projectConfig?: ProjectConfig): ToolMeta {
  const identity = classifyToolIdentity(toolName, input, { basenameOnly: true, projectConfig });
  return {
    name: identity.displayName,
    purpose: identity.purpose,
    category: identity.category,
    identityHash: identity.identityHash,
    isEdit: identity.isEdit,
    isReadSearch: identity.isReadSearch
  };
}

function metaFromStoredHookEvent(event: StoredHookEvent): ToolMeta {
  const name = event.category === "MCP" ? "MCP tool" : event.toolName || "tool";
  return {
    name,
    purpose: event.purpose,
    category: event.category,
    identityHash: event.identityHash,
    isEdit: isEditTool(name),
    isReadSearch: isReadSearchTool(name) || event.purpose === "read"
  };
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
