import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type ValidationCommandCategory = "tests" | "lint" | "typecheck" | "build";

export interface ProjectConfig {
  validationCommands: Partial<Record<ValidationCommandCategory, string[]>>;
  validationPatterns: Partial<Record<ValidationCommandCategory, string[]>>;
}

const CONFIG_FILE = ".ccverdict.json";
const MAX_SEARCH_DEPTH = 20;
const MAX_CONFIG_BYTES = 16 * 1024;
const MAX_COMMANDS_PER_CATEGORY = 20;
const MAX_COMMAND_LENGTH = 200;
const VALIDATION_CATEGORIES: ValidationCommandCategory[] = ["tests", "lint", "typecheck", "build"];
const EMPTY_CONFIG: ProjectConfig = { validationCommands: {}, validationPatterns: {} };

export async function loadProjectConfig(cwd: string | undefined): Promise<ProjectConfig> {
  const configPath = await findProjectConfig(cwd);
  if (!configPath) {
    return EMPTY_CONFIG;
  }
  try {
    const fileStat = await stat(configPath);
    if (!fileStat.isFile() || fileStat.size > MAX_CONFIG_BYTES) {
      return EMPTY_CONFIG;
    }
    return sanitizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  } catch {
    return EMPTY_CONFIG;
  }
}

export function classifyConfiguredValidationCommand(
  command: string | undefined,
  config: ProjectConfig | undefined
): ValidationCommandCategory | undefined {
  const normalizedCommand = normalizeCommand(command);
  if (!normalizedCommand || !config) {
    return undefined;
  }
  for (const category of VALIDATION_CATEGORIES) {
    for (const configured of config.validationCommands[category] || []) {
      const normalizedConfigured = normalizeCommand(configured);
      if (
        normalizedConfigured &&
        (normalizedCommand === normalizedConfigured || normalizedCommand.startsWith(`${normalizedConfigured} `))
      ) {
        return category;
      }
    }
    for (const pattern of config.validationPatterns[category] || []) {
      try {
        if (new RegExp(pattern, "u").test(normalizedCommand)) {
          return category;
        }
      } catch {
        // Invalid user patterns are ignored by sanitizeConfig, but stay defensive.
      }
    }
  }
  return undefined;
}

async function findProjectConfig(cwd: string | undefined): Promise<string | undefined> {
  if (!cwd) {
    return undefined;
  }
  let current = isAbsolute(cwd) ? cwd : resolve(cwd);
  for (let depth = 0; depth < MAX_SEARCH_DEPTH; depth += 1) {
    const candidate = join(current, CONFIG_FILE);
    try {
      const fileStat = await stat(candidate);
      if (fileStat.isFile()) {
        return candidate;
      }
    } catch {
      // Keep walking upward; invalid/missing config must not break statusline.
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
  return undefined;
}

function sanitizeConfig(value: unknown): ProjectConfig {
  if (!isRecord(value)) {
    return EMPTY_CONFIG;
  }
  const validationCommands: ProjectConfig["validationCommands"] = {};
  const validationPatterns: ProjectConfig["validationPatterns"] = {};
  for (const category of VALIDATION_CATEGORIES) {
    const commands = isRecord(value.validationCommands) ? value.validationCommands[category] : undefined;
    if (!Array.isArray(commands)) {
      // Patterns are processed below.
    } else {
      const safeCommands = commands
        .flatMap((command) => (typeof command === "string" ? [normalizeCommand(command)] : []))
        .filter((command): command is string => typeof command === "string" && command.length > 0 && command.length <= MAX_COMMAND_LENGTH)
        .slice(0, MAX_COMMANDS_PER_CATEGORY);
      if (safeCommands.length > 0) {
        validationCommands[category] = safeCommands;
      }
    }

    const patterns = isRecord(value.validationPatterns) ? value.validationPatterns[category] : undefined;
    if (Array.isArray(patterns)) {
      const safePatterns = patterns
        .flatMap((pattern) => (typeof pattern === "string" ? [normalizeCommand(pattern)] : []))
        .filter((pattern): pattern is string => typeof pattern === "string" && pattern.length > 0 && pattern.length <= MAX_COMMAND_LENGTH)
        .filter((pattern) => validRegex(pattern))
        .slice(0, MAX_COMMANDS_PER_CATEGORY);
      if (safePatterns.length > 0) {
        validationPatterns[category] = safePatterns;
      }
    }
  }
  return { validationCommands, validationPatterns };
}

function normalizeCommand(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/\s+/gu, " ");
  return normalized || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validRegex(pattern: string): boolean {
  try {
    new RegExp(pattern, "u");
    return true;
  } catch {
    return false;
  }
}
