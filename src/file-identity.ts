import { basename } from "node:path";
import { hashValue } from "./paths.js";
import { asRecord, stringField } from "./status-input.js";
import type { ReadKind } from "./types.js";

export interface FileIdentity {
  fileIdentityHash: string;
}

function rawPathFromToolInput(toolName: string, input: unknown): string | undefined {
  const root = asRecord(input);
  if (!root) {
    return undefined;
  }
  return stringField(root.file_path) || (toolName === "NotebookEdit" ? stringField(root.notebook_path) : undefined);
}

export function fileIdentityFromToolInput(toolName: string, input: unknown): FileIdentity | undefined {
  const fileIdentityHash = hashValue(rawPathFromToolInput(toolName, input));
  return fileIdentityHash ? { fileIdentityHash } : undefined;
}

// Returns just the file name (never a directory path). Basenames are display-safe per the
// privacy invariants; full paths are never returned or stored.
export function fileBasenameFromToolInput(toolName: string, input: unknown): string | undefined {
  const rawPath = rawPathFromToolInput(toolName, input);
  if (!rawPath) {
    return undefined;
  }
  const name = basename(rawPath.replace(/[\\]+/gu, "/"));
  return name && name !== "." && name !== "/" ? name : undefined;
}

export function readKindFromInput(input: unknown): ReadKind | undefined {
  const root = asRecord(input);
  if (!root) {
    return undefined;
  }
  return root.offset === undefined && root.limit === undefined ? "full" : "partial";
}

export function isFullFileReadInput(input: unknown): boolean {
  return readKindFromInput(input) === "full";
}
