import type { StatusLineInput, TokenUsage } from "./types.js";

const MAX_STDIN_BYTES = 1024 * 1024;

export async function readStdin(maxBytes = MAX_STDIN_BYTES): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.length;
    if (total > maxBytes) {
      const remaining = Math.max(0, maxBytes - (total - buffer.length));
      chunks.push(buffer.subarray(0, remaining));
      break;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function parseStatusLineInput(raw: string): StatusLineInput {
  const trimmed = raw.trim();
  if (!trimmed) {
    return emptyInput("empty stdin");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return emptyInput(error instanceof Error ? error.message : "invalid JSON");
  }

  const root = asRecord(parsed);
  if (!root) {
    return emptyInput("stdin JSON is not an object");
  }

  const model = asRecord(root.model);
  const workspace = asRecord(root.workspace);
  const cost = asRecord(root.cost);
  const contextWindow = asRecord(root.context_window) || asRecord(root.contextWindow);
  const costUsd =
    numberField(cost?.total_cost_usd) ??
    numberField(cost?.totalCostUsd) ??
    numberField(cost?.cost_usd) ??
    numberField(root.total_cost_usd);

  const usage = mergeUsage(
    extractUsage(root),
    extractUsage(asRecord(root.usage)),
    extractUsage(asRecord(root.token_usage)),
    extractUsage(asRecord(root.tokens)),
    extractUsage(asRecord(contextWindow?.current_usage) || asRecord(contextWindow?.currentUsage)),
    extractUsage(cost)
  );

  return {
    rawValid: true,
    sessionId: stringField(root.session_id) || stringField(root.sessionId),
    transcriptPath: stringField(root.transcript_path) || stringField(root.transcriptPath),
    cwd:
      stringField(root.cwd) ||
      stringField(workspace?.current_dir) ||
      stringField(workspace?.project_dir),
    model: {
      id: stringField(model?.id) || stringField(root.model_id) || stringField(root.model),
      displayName:
        stringField(model?.display_name) ||
        stringField(model?.displayName) ||
        stringField(model?.name)
    },
    costUsd,
    costSource: costUsd === undefined ? undefined : "claude",
    durationMs: numberField(cost?.total_duration_ms) ?? numberField(root.duration_ms),
    contextPercent: extractPercent(root, ["context", "context_window", "contextWindow"]),
    rateLimitPercent: extractPercent(root, ["rate_limit", "rateLimit", "rate_limits", "rateLimits"]),
    usage,
    terminalWidth:
      numberField(root.terminal_width) ??
      numberField(root.terminalWidth) ??
      numberFromString(process.env.BB_CC_LITE_WIDTH) ??
      numberFromString(process.env.COLUMNS)
  };
}

export function mergeUsage(...items: Array<TokenUsage | undefined>): TokenUsage {
  const result: TokenUsage = {};
  for (const item of items) {
    if (!item) {
      continue;
    }
    result.inputTokens = preferNumber(result.inputTokens, item.inputTokens);
    result.outputTokens = preferNumber(result.outputTokens, item.outputTokens);
    result.cacheCreationInputTokens = preferNumber(
      result.cacheCreationInputTokens,
      item.cacheCreationInputTokens
    );
    result.cacheReadInputTokens = preferNumber(result.cacheReadInputTokens, item.cacheReadInputTokens);
    result.totalTokens = preferNumber(result.totalTokens, item.totalTokens);
  }
  return result;
}

export function extractUsage(value: unknown): TokenUsage {
  const root = asRecord(value);
  if (!root) {
    return {};
  }
  const usage = asRecord(root.usage) || root;
  const cacheCreationDetails = asRecord(usage.cache_creation);
  const cacheReadDetails = asRecord(usage.cache_read);

  return {
    inputTokens:
      numberField(usage.input_tokens) ??
      numberField(usage.inputTokens) ??
      numberField(usage.prompt_tokens) ??
      numberField(usage.promptTokens),
    outputTokens:
      numberField(usage.output_tokens) ??
      numberField(usage.outputTokens) ??
      numberField(usage.completion_tokens) ??
      numberField(usage.completionTokens),
    cacheCreationInputTokens:
      numberField(usage.cache_creation_input_tokens) ??
      numberField(usage.cacheCreationInputTokens) ??
      numberField(usage.cache_write_input_tokens) ??
      numberField(usage.cacheWriteInputTokens) ??
      numberField(cacheCreationDetails?.input_tokens),
    cacheReadInputTokens:
      numberField(usage.cache_read_input_tokens) ??
      numberField(usage.cacheReadInputTokens) ??
      numberField(cacheReadDetails?.input_tokens),
    totalTokens:
      numberField(usage.total_tokens) ??
      numberField(usage.totalTokens) ??
      numberField(usage.context_tokens) ??
      numberField(usage.contextTokens)
  };
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

export function numberField(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    return numberFromString(value);
  }
  return undefined;
}

export function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function emptyInput(parseError: string): StatusLineInput {
  return {
    rawValid: false,
    model: {},
    usage: {},
    parseError
  };
}

function numberFromString(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value.replace("%", ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function preferNumber(current: number | undefined, next: number | undefined): number | undefined {
  if (next === undefined) {
    return current;
  }
  if (current === undefined) {
    return next;
  }
  return Math.max(current, next);
}

function extractPercent(root: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const candidate = root[key];
    const direct = numberField(candidate);
    if (direct !== undefined) {
      return normalizePercent(direct);
    }

    const record = asRecord(candidate);
    if (!record) {
      continue;
    }
    const explicit =
      numberField(record.percent) ||
      numberField(record.percentage) ||
      numberField(record.used_percent) ||
      numberField(record.usedPercentage) ||
      numberField(record.used_percentage) ||
      numberField(record.usedPercent);
    if (explicit !== undefined) {
      return normalizePercent(explicit);
    }

    const nested = Object.values(record)
      .flatMap((value) => {
        const child = asRecord(value);
        if (!child) {
          return [];
        }
        const childPercent =
          numberField(child.used_percentage) ||
          numberField(child.usedPercentage) ||
          numberField(child.percent) ||
          numberField(child.percentage);
        return childPercent === undefined ? [] : [childPercent];
      })
      .sort((a, b) => b - a)[0];
    if (nested !== undefined) {
      return normalizePercent(nested);
    }

    const used =
      numberField(record.used) ||
      numberField(record.used_tokens) ||
      numberField(record.usedTokens) ||
      numberField(record.current);
    const total =
      numberField(record.total) ||
      numberField(record.limit) ||
      numberField(record.window) ||
      numberField(record.max) ||
      numberField(record.context_window);
    if (used !== undefined && total !== undefined && total > 0) {
      return normalizePercent((used / total) * 100);
    }
  }
  return undefined;
}

function normalizePercent(value: number): number {
  const normalized = value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, Math.round(normalized)));
}
