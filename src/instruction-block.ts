import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Marked CLAUDE.md block machinery (PRD-02 branch H6). The same block convention, backup naming,
// and scope routing the retired `improve --apply` flow used, so existing installs' blocks stay
// recognizable and `audit --cleanup` keeps working. bb only ever owns the text between these
// markers; user-authored lines outside the block are never modified or removed.

export const BLOCK_START = "<!-- bb-cc-lite improve:start -->";
export const BLOCK_END = "<!-- bb-cc-lite improve:end -->";
export const BLOCK_HEADING = "## bb-cc-lite lessons";

export type BlockAction = "created" | "updated" | "removed" | "unchanged";

export interface InstructionFileText {
  exists: boolean;
  text: string;
}

export async function readInstructionFile(path: string): Promise<InstructionFileText> {
  try {
    return { exists: true, text: await readFile(path, "utf8") };
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, text: "" };
    }
    throw error;
  }
}

export function buildInstructionBlock(instructions: readonly string[]): string {
  const lines = [
    BLOCK_START,
    BLOCK_HEADING,
    ...[...instructions].map((instruction) => `- ${instruction}`).sort((left, right) => left.localeCompare(right)),
    BLOCK_END
  ];
  return `${lines.join("\n")}\n`;
}

export function upsertBlock(existing: string, block: string): { text: string; action: "created" | "updated" } {
  const start = existing.indexOf(BLOCK_START);
  const end = existing.indexOf(BLOCK_END);
  if (start >= 0 && end > start) {
    const afterEnd = end + BLOCK_END.length;
    const suffix = existing.slice(afterEnd).replace(/^\n/u, "");
    return {
      text: `${existing.slice(0, start)}${block}${suffix}`,
      action: "updated"
    };
  }
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n\n" : existing.length > 0 ? "\n" : "";
  return {
    text: `${existing}${separator}${block}`,
    action: "created"
  };
}

export function removeBlock(existing: string): { text: string; action: "removed" | "unchanged" } {
  const start = existing.indexOf(BLOCK_START);
  const end = existing.indexOf(BLOCK_END);
  if (start < 0 || end <= start) {
    return { text: existing, action: "unchanged" };
  }
  const afterEnd = end + BLOCK_END.length;
  const suffix = existing.slice(afterEnd).replace(/^\n/u, "");
  return {
    text: `${existing.slice(0, start)}${suffix}`,
    action: "removed"
  };
}

export async function backupInstructionFile(path: string, text: string, now: Date): Promise<string> {
  const backupPath = `${path}.bb-cc-lite-backup-${now.toISOString().replaceAll(/[:.]/gu, "-")}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(backupPath, text, "utf8");
  return backupPath;
}

export async function writeInstructionFile(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

export function globalClaudePath(homeDir = homedir()): string {
  return join(resolve(homeDir), ".claude", "CLAUDE.md");
}

export function projectClaudePath(projectDir = process.cwd()): string {
  return join(resolve(projectDir), "CLAUDE.md");
}
