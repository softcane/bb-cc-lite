import { hashValue } from "./paths.js";
import { asRecord, stringField } from "./status-input.js";
import type { ReadKind } from "./types.js";

export interface FileIdentity {
  fileIdentityHash: string;
  safeFileLabel?: string;
}

export function fileIdentityFromToolInput(toolName: string, input: unknown): FileIdentity | undefined {
  const root = asRecord(input);
  if (!root) {
    return undefined;
  }
  const rawPath = stringField(root.file_path) || (toolName === "NotebookEdit" ? stringField(root.notebook_path) : undefined);
  const fileIdentityHash = hashValue(rawPath);
  return fileIdentityHash
    ? {
        fileIdentityHash,
        safeFileLabel: safeFileLabel(rawPath)
      }
    : undefined;
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

function safeFileLabel(filePath: string | undefined): string | undefined {
  if (!filePath) {
    return undefined;
  }
  const segment = filePath.split(/[\\/]+/u).filter(Boolean).at(-1);
  if (!segment || segment === "." || segment === "..") {
    return undefined;
  }
  // Keep only a basename-style hint; never retain the full local path.
  // eslint-disable-next-line no-control-regex
  const label = segment.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (!label) {
    return undefined;
  }
  return label.length > 80 ? `${label.slice(0, 77)}...` : label;
}
