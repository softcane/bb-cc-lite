import { asRecord, extractUsage, mergeUsage, stringField } from "./status-input.js";
import { classifyResultPurpose, classifyToolPurpose, isEditTool, safeToolName } from "./tool-metadata.js";
import { readTranscriptTail, type ReadTranscriptTailOptions } from "./transcript-reader.js";
import type { ToolFailureSummary, TokenUsage, TranscriptSummary } from "./types.js";

export type ParseTranscriptOptions = ReadTranscriptTailOptions;

interface ToolMeta {
  name: string;
  purpose?: string;
  isEdit: boolean;
}

export async function parseTranscriptTail(
  transcriptPath: string | undefined,
  options: ParseTranscriptOptions = {}
): Promise<TranscriptSummary> {
  const tail = await readTranscriptTail(transcriptPath, options);
  if (!tail.pathReadable) {
    return emptySummary(false);
  }
  return parseTranscriptLines(tail.lines, tail.bytesRead);
}

export function parseTranscriptLines(lines: string[], bytesRead = Buffer.byteLength(lines.join("\n"))): TranscriptSummary {
  const toolById = new Map<string, ToolMeta>();
  const failureCounts = new Map<string, ToolFailureSummary>();
  let recentEditBeforeTest = false;
  let hasUnvalidatedEdits = false;
  let validationFailedSinceSuccess = false;
  let validationRecovered = false;
  let editTestLoopFailures = 0;
  let toolCalls = 0;
  let readToolCalls = 0;
  let failedToolResults = 0;
  let malformedLines = 0;
  let compactionEvents = 0;
  let usage: TokenUsage = {};
  let latestTimestamp: string | undefined;

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformedLines += 1;
      continue;
    }

    const entry = asRecord(parsed);
    if (!entry) {
      malformedLines += 1;
      continue;
    }

    latestTimestamp = stringField(entry.timestamp) || latestTimestamp;
    usage = mergeUsage(usage, extractUsage(entry), extractUsage(asRecord(entry.message)));

    if (isCompactionEvent(entry)) {
      compactionEvents += 1;
    }

    for (const toolUse of extractToolUses(entry)) {
      toolCalls += 1;
      if (isReadLikeTool(toolUse.name)) {
        readToolCalls += 1;
      }
      if (toolUse.id) {
        const isEdit = isEditTool(toolUse.name, { basenameOnly: true });
        toolById.set(toolUse.id, {
          name: safeToolName(toolUse.name, { basenameOnly: true }),
          purpose: classifyToolPurpose(toolUse.name, toolUse.input, { basenameOnly: true }),
          isEdit
        });
      }
      if (isEditTool(toolUse.name, { basenameOnly: true })) {
        recentEditBeforeTest = true;
      }
    }

    for (const toolResult of extractToolResults(entry)) {
      const meta =
        (toolResult.toolUseId ? toolById.get(toolResult.toolUseId) : undefined) ||
        (toolResult.toolName
          ? { name: safeToolName(toolResult.toolName, { basenameOnly: true }), purpose: undefined, isEdit: false }
          : undefined) ||
        { name: "tool", purpose: undefined, isEdit: false };
      const purpose = toolResult.purpose || meta.purpose;
      const key = `${meta.name}:${purpose || ""}`;
      if (!toolResult.isError) {
        failureCounts.delete(key);
        if (meta.isEdit) {
          hasUnvalidatedEdits = true;
        } else if (meta.name === "Bash" && purpose === "tests") {
          if (validationFailedSinceSuccess) {
            validationRecovered = true;
          }
          validationFailedSinceSuccess = false;
          hasUnvalidatedEdits = false;
        }
        continue;
      }
      failedToolResults += 1;
      const existing = failureCounts.get(key);
      failureCounts.set(key, {
        toolName: meta.name,
        purpose,
        count: (existing?.count || 0) + 1
      });
      if (meta.name === "Bash" && purpose === "tests" && recentEditBeforeTest) {
        editTestLoopFailures += 1;
        recentEditBeforeTest = false;
      }
      if (meta.name === "Bash" && purpose === "tests") {
        validationFailedSinceSuccess = true;
      }
    }
  }

  return {
    pathReadable: true,
    bytesRead,
    linesRead: lines.length,
    malformedLines,
    toolCalls,
    readToolCalls,
    failedToolResults,
    repeatedFailures: [...failureCounts.values()].filter((item) => item.count >= 2),
    editTestLoopFailures,
    hasUnvalidatedEdits,
    validationRecovered,
    compactionEvents,
    usage,
    latestTimestamp
  };
}

function emptySummary(pathReadable: boolean): TranscriptSummary {
  return {
    pathReadable,
    bytesRead: 0,
    linesRead: 0,
    malformedLines: 0,
    toolCalls: 0,
    readToolCalls: 0,
    failedToolResults: 0,
    repeatedFailures: [],
    editTestLoopFailures: 0,
    hasUnvalidatedEdits: false,
    validationRecovered: false,
    compactionEvents: 0,
    usage: {}
  };
}

function isReadLikeTool(toolName: string): boolean {
  return /^(Read|Grep|Glob|LS|WebFetch|WebSearch)$/u.test(safeToolName(toolName, { basenameOnly: true }));
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

function isCompactionEvent(entry: Record<string, unknown>): boolean {
  const event = stringField(entry.hook_event_name) || stringField(entry.event) || stringField(entry.type);
  if (event && /compact/i.test(event)) {
    return true;
  }
  const message = asRecord(entry.message);
  const role = stringField(message?.role) || stringField(entry.role);
  const content = typeof entry.content === "string" ? entry.content : typeof message?.content === "string" ? message.content : "";
  return role === "system" && /\b(compact|compaction)\b/i.test(content);
}
