import { basename } from "node:path";
import { hashValue } from "./paths.js";
import { classifyConfiguredValidationCommand, type ProjectConfig } from "./project-config.js";
import { asRecord, stringField } from "./status-input.js";

const TEST_COMMAND_RE =
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|vitest|jest)|\b(vitest|jest|mocha|pytest|cargo\s+test|go\s+test|rspec|playwright\s+test)\b/i;
const LINT_COMMAND_RE = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?lint\b|\b(eslint|ruff|flake8|cargo\s+clippy)\b/i;
const TYPECHECK_COMMAND_RE = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?typecheck\b|\btsc\s+--noEmit\b|\bmypy\b/i;
const BUILD_COMMAND_RE = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(build|compile)\b|\b(tsc|vite\s+build|cargo\s+build|go\s+build)\b/i;
const READ_ONLY_BASH_COMMAND_RE = /^(pwd|ls\b|git\s+(status|diff|log|show)\b|rg\b|grep\b|sed\s+-n\b|head\b|tail\b|wc\b)/iu;
const SHELL_MUTATION_HINT_RE = /(\s>|>>|\|\s*(tee|xargs)\b|&&|\|\||;)/iu;

interface SafeToolNameOptions {
  basenameOnly?: boolean;
  projectConfig?: ProjectConfig;
}

export interface ToolIdentity {
  displayName: string;
  category?: "MCP";
  identityHash?: string;
  purpose?: string;
  isEdit: boolean;
  isReadSearch: boolean;
}

export function classifyToolIdentity(
  toolName: string | undefined,
  input?: unknown,
  options: SafeToolNameOptions = {}
): ToolIdentity {
  const candidate = rawToolNameCandidate(toolName, options) || "";
  if (candidate && isMcpToolName(candidate)) {
    return {
      displayName: "MCP tool",
      category: "MCP",
      identityHash: hashValue(candidate),
      isEdit: false,
      isReadSearch: false
    };
  }

  const displayName = safeToolName(toolName, options);
  const purpose = classifyToolPurpose(displayName, input, options);
  return {
    displayName,
    purpose,
    isEdit: isEditTool(displayName),
    isReadSearch: isReadSearchTool(displayName) || purpose === "read"
  };
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
  const configured = classifyConfiguredValidationCommand(command, options.projectConfig);
  if (configured) {
    return configured;
  }
  if (command && TEST_COMMAND_RE.test(command)) {
    return "tests";
  }
  if (command && LINT_COMMAND_RE.test(command)) {
    return "lint";
  }
  if (command && TYPECHECK_COMMAND_RE.test(command)) {
    return "typecheck";
  }
  if (command && BUILD_COMMAND_RE.test(command)) {
    return "build";
  }
  if (isReadOnlyBashCommand(command)) {
    return "read";
  }
  return undefined;
}

export function classifyResultPurpose(part: Record<string, unknown>): string | undefined {
  const title = stringField(part.title) || stringField(part.summary);
  if (title && /test/i.test(title)) {
    return "tests";
  }
  if (title && /lint/i.test(title)) {
    return "lint";
  }
  if (title && /typecheck|type check|tsc/i.test(title)) {
    return "typecheck";
  }
  if (title && /build|compile/i.test(title)) {
    return "build";
  }
  return undefined;
}

export function isEditTool(toolName: string, options: SafeToolNameOptions = {}): boolean {
  return /^(Edit|MultiEdit|Write|NotebookEdit)$/u.test(safeToolName(toolName, options));
}

export function isReadSearchTool(toolName: string, options: SafeToolNameOptions = {}): boolean {
  return /^(Read|Grep|Glob|LS|WebFetch|WebSearch)$/u.test(safeToolName(toolName, options));
}

export function safeToolName(toolName: string | undefined, options: SafeToolNameOptions = {}): string {
  if (!toolName) {
    return "tool";
  }
  const candidate = rawToolNameCandidate(toolName, options) || "";
  return APPROVED_BUILT_IN_TOOL_NAMES.has(candidate) ? candidate : "tool";
}

function rawToolNameCandidate(toolName: string | undefined, options: SafeToolNameOptions): string | undefined {
  if (!toolName) {
    return undefined;
  }
  return options.basenameOnly ? basename(toolName) : toolName;
}

function isMcpToolName(toolName: string): boolean {
  return toolName.startsWith("mcp__");
}

function isReadOnlyBashCommand(command: string | undefined): boolean {
  if (!command) {
    return false;
  }
  const normalized = command.trim().replace(/\s+/gu, " ");
  return READ_ONLY_BASH_COMMAND_RE.test(normalized) && !SHELL_MUTATION_HINT_RE.test(normalized);
}

const APPROVED_BUILT_IN_TOOL_NAMES = new Set([
  "Bash",
  "Edit",
  "ExitPlanMode",
  "Glob",
  "Grep",
  "LS",
  "MultiEdit",
  "NotebookEdit",
  "Read",
  "Task",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "Write"
]);
