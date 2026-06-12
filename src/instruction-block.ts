import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Marked CLAUDE.md block machinery. New writes use audit markers; cleanup still recognizes the
// retired improve markers. ccverdict only owns text between known markers.

export const BLOCK_START = "<!-- ccverdict audit:start -->";
export const BLOCK_END = "<!-- ccverdict audit:end -->";
export const LEGACY_BLOCK_START = "<!-- ccverdict improve:start -->";
export const LEGACY_BLOCK_END = "<!-- ccverdict improve:end -->";
export const BLOCK_HEADING = "## ccverdict lessons";

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
  const ranges = findBlockRanges(existing);
  if (ranges.length > 0) {
    return { text: replaceRangesWithBlock(existing, ranges, block), action: "updated" };
  }
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n\n" : existing.length > 0 ? "\n" : "";
  return {
    text: `${existing}${separator}${block}`,
    action: "created"
  };
}

export function removeBlock(existing: string): { text: string; action: "removed" | "unchanged" } {
  const ranges = findBlockRanges(existing);
  if (ranges.length === 0) {
    return { text: existing, action: "unchanged" };
  }
  return { text: removeRanges(existing, ranges), action: "removed" };
}

export function instructionLinesFromOwnedBlocks(existing: string): string[] {
  const lines: string[] = [];
  for (const range of findBlockRanges(existing)) {
    const inner = existing.slice(range.contentStart, range.contentEnd);
    for (const rawLine of inner.split(/\r?\n/u)) {
      const trimmed = rawLine.trim();
      if (trimmed.length === 0 || trimmed === BLOCK_HEADING || trimmed.startsWith("#")) {
        continue;
      }
      const line = trimmed.replace(/^[-*+]\s+/u, "").trim();
      if (line.length > 0) {
        lines.push(line);
      }
    }
  }
  return [...new Set(lines)].sort((left, right) => left.localeCompare(right));
}

interface BlockRange {
  start: number;
  end: number;
  contentStart: number;
  contentEnd: number;
}

const BLOCK_MARKERS = [
  { start: BLOCK_START, end: BLOCK_END },
  { start: LEGACY_BLOCK_START, end: LEGACY_BLOCK_END }
] as const;

function findBlockRanges(existing: string): BlockRange[] {
  const ranges: BlockRange[] = [];
  for (const marker of BLOCK_MARKERS) {
    let searchIndex = 0;
    while (searchIndex < existing.length) {
      const start = existing.indexOf(marker.start, searchIndex);
      if (start < 0) {
        break;
      }
      const endStart = existing.indexOf(marker.end, start + marker.start.length);
      if (endStart < 0) {
        break;
      }
      ranges.push({
        start,
        end: endStart + marker.end.length,
        contentStart: start + marker.start.length,
        contentEnd: endStart
      });
      searchIndex = endStart + marker.end.length;
    }
  }
  return ranges.sort((left, right) => left.start - right.start).filter((range, index, sorted) => {
    const previous = sorted[index - 1];
    return !previous || range.start >= previous.end;
  });
}

function replaceRangesWithBlock(existing: string, ranges: readonly BlockRange[], block: string): string {
  let text = "";
  let cursor = 0;
  for (const [index, range] of ranges.entries()) {
    text += existing.slice(cursor, range.start);
    if (index === 0) {
      text += block;
    }
    cursor = skipOneNewline(existing, range.end);
  }
  text += existing.slice(cursor);
  return text;
}

function removeRanges(existing: string, ranges: readonly BlockRange[]): string {
  let text = "";
  let cursor = 0;
  for (const range of ranges) {
    text += existing.slice(cursor, range.start);
    cursor = skipOneNewline(existing, range.end);
  }
  text += existing.slice(cursor);
  return text;
}

function skipOneNewline(text: string, index: number): number {
  if (text.slice(index, index + 2) === "\r\n") {
    return index + 2;
  }
  if (text[index] === "\n") {
    return index + 1;
  }
  return index;
}

export async function backupInstructionFile(path: string, text: string, now: Date): Promise<string> {
  const backupPath = `${path}.ccverdict-backup-${now.toISOString().replaceAll(/[:.]/gu, "-")}`;
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
