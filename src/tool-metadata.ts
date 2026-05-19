import { basename } from "node:path";
import { asRecord, stringField } from "./status-input.js";

const TEST_COMMAND_RE =
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|vitest|jest)|\b(vitest|jest|mocha|pytest|cargo\s+test|go\s+test|rspec|playwright\s+test)\b/i;

interface SafeToolNameOptions {
  basenameOnly?: boolean;
}

export function classifyToolPurpose(
  toolName: string,
  input: unknown,
  options: SafeToolNameOptions = {}
): string | undefined {
  if (safeToolName(toolName, options) !== "Bash") {
    return undefined;
  }
  const command = stringField(asRecord(input)?.command);
  if (command && TEST_COMMAND_RE.test(command)) {
    return "tests";
  }
  return undefined;
}

export function classifyResultPurpose(part: Record<string, unknown>): string | undefined {
  const title = stringField(part.title) || stringField(part.summary);
  if (title && /test/i.test(title)) {
    return "tests";
  }
  return undefined;
}

export function isEditTool(toolName: string, options: SafeToolNameOptions = {}): boolean {
  return /^(Edit|MultiEdit|Write|NotebookEdit)$/u.test(safeToolName(toolName, options));
}

export function safeToolName(toolName: string | undefined, options: SafeToolNameOptions = {}): string {
  if (!toolName) {
    return "tool";
  }
  const candidate = options.basenameOnly ? basename(toolName) : toolName;
  return /^[A-Za-z][A-Za-z0-9_-]{0,32}$/u.test(candidate) ? candidate : "tool";
}
