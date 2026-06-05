import { hashValue } from "./paths.js";
import { asRecord, stringField } from "./status-input.js";
import type { ReadKind } from "./types.js";

export interface FileIdentity {
  fileIdentityHash: string;
}

export function fileIdentityFromToolInput(toolName: string, input: unknown): FileIdentity | undefined {
  const root = asRecord(input);
  if (!root) {
    return undefined;
  }
  const rawPath = stringField(root.file_path) || (toolName === "NotebookEdit" ? stringField(root.notebook_path) : undefined);
  const fileIdentityHash = hashValue(rawPath);
  return fileIdentityHash ? { fileIdentityHash } : undefined;
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
