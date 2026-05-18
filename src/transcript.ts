import { open, stat } from "node:fs/promises";
import { basename } from "node:path";
import { asRecord, extractUsage, mergeUsage, stringField } from "./status-input.js";
import type { ToolFailureSummary, TokenUsage, TranscriptSummary } from "./types.js";

export interface ParseTranscriptOptions {
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 512 * 1024;
const TEST_COMMAND_RE =
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|vitest|jest)|\b(vitest|jest|mocha|pytest|cargo\s+test|go\s+test|rspec|playwright\s+test)\b/i;

interface ToolMeta {
  name: string;
  purpose?: string;
}

export async function parseTranscriptTail(
  transcriptPath: string | undefined,
  options: ParseTranscriptOptions = {}
): Promise<TranscriptSummary> {
  if (!transcriptPath) {
    return emptySummary(false);
  }

  try {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const fileStat = await stat(transcriptPath);
    const bytesRead = Math.min(fileStat.size, maxBytes);
    const start = Math.max(0, fileStat.size - bytesRead);
    const handle = await open(transcriptPath, "r");
    try {
      const buffer = Buffer.alloc(bytesRead);
      await handle.read(buffer, 0, bytesRead, start);
      const text = buffer.toString("utf8");
      const lines = trimPartialFirstLine(text, start).split(/\r?\n/).filter(Boolean);
      return parseTranscriptLines(lines, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return emptySummary(false);
  }
}

export function parseTranscriptLines(lines: string[], bytesRead = Buffer.byteLength(lines.join("\n"))): TranscriptSummary {
  const toolById = new Map<string, ToolMeta>();
  const failureCounts = new Map<string, ToolFailureSummary>();
  let recentEditBeforeTest = false;
  let editTestLoopFailures = 0;
  let toolCalls = 0;
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
      if (toolUse.id) {
        toolById.set(toolUse.id, {
          name: safeToolName(toolUse.name),
          purpose: classifyToolPurpose(toolUse.name, toolUse.input)
        });
      }
      if (isEditTool(toolUse.name)) {
        recentEditBeforeTest = true;
      }
    }

    for (const toolResult of extractToolResults(entry)) {
      if (!toolResult.isError) {
        continue;
      }
      failedToolResults += 1;
      const meta =
        (toolResult.toolUseId ? toolById.get(toolResult.toolUseId) : undefined) ||
        (toolResult.toolName ? { name: safeToolName(toolResult.toolName), purpose: undefined } : undefined) ||
        { name: "tool", purpose: undefined };
      const purpose = toolResult.purpose || meta.purpose;
      const key = `${meta.name}:${purpose || ""}`;
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
    }
  }

  return {
    pathReadable: true,
    bytesRead,
    linesRead: lines.length,
    malformedLines,
    toolCalls,
    failedToolResults,
    repeatedFailures: [...failureCounts.values()].filter((item) => item.count >= 2),
    editTestLoopFailures,
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
    failedToolResults: 0,
    repeatedFailures: [],
    editTestLoopFailures: 0,
    compactionEvents: 0,
    usage: {}
  };
}

function trimPartialFirstLine(text: string, start: number): string {
  if (start === 0) {
    return text;
  }
  const newline = text.indexOf("\n");
  return newline === -1 ? "" : text.slice(newline + 1);
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

function classifyToolPurpose(toolName: string, input: unknown): string | undefined {
  if (safeToolName(toolName) !== "Bash") {
    return undefined;
  }
  const command = stringField(asRecord(input)?.command);
  if (command && TEST_COMMAND_RE.test(command)) {
    return "tests";
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

function isEditTool(toolName: string): boolean {
  return /^(Edit|MultiEdit|Write|NotebookEdit)$/u.test(safeToolName(toolName));
}

function safeToolName(toolName: string | undefined): string {
  if (!toolName) {
    return "tool";
  }
  const base = basename(toolName);
  return /^[A-Za-z][A-Za-z0-9_-]{0,32}$/u.test(base) ? base : "tool";
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
