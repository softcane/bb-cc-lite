import type { LedgerEntry } from "./types.js";

// Checkpoint-semantics edit ledger (PRD-01, branch D).
// "Unchecked" = a file successfully edited after the last passing validation check.
// Any passing check clears the whole ledger; failing checks and compaction clear nothing;
// lifecycle resets (startup/clear) clear it. Only successful edits enter. Counts stay exact
// past the identity cap; only per-file detail truncates oldest-first.

export const LEDGER_IDENTITY_CAP = 50;

export type LedgerEventKind =
  | "edit"
  | "validation_pass"
  | "validation_fail"
  | "compaction"
  | "lifecycle_reset";

export interface LedgerEvent {
  kind: LedgerEventKind;
  identityHash?: string;
  basename?: string;
}

export interface EditLedger {
  entries: LedgerEntry[];
  edited: number;
  unchecked: number;
  latestUncheckedBasename?: string;
}

interface DetailEntry {
  identityHash: string;
  basename?: string;
  edits: number;
  order: number;
}

export function emptyLedger(): EditLedger {
  return { entries: [], edited: 0, unchecked: 0 };
}

export function buildEditLedger(events: readonly LedgerEvent[]): EditLedger {
  const edited = new Set<string>();
  const unchecked = new Set<string>();
  const detail = new Map<string, DetailEntry>();
  let order = 0;
  let latestUncheckedBasename: string | undefined;

  for (const event of events) {
    switch (event.kind) {
      case "edit": {
        if (!event.identityHash) {
          continue;
        }
        order += 1;
        edited.add(event.identityHash);
        unchecked.add(event.identityHash);
        const existing = detail.get(event.identityHash);
        if (existing) {
          existing.edits += 1;
          existing.order = order;
          if (event.basename) {
            existing.basename = event.basename;
          }
        } else {
          detail.set(event.identityHash, {
            identityHash: event.identityHash,
            basename: event.basename,
            edits: 1,
            order
          });
          capDetail(detail);
        }
        latestUncheckedBasename = detail.get(event.identityHash)?.basename;
        break;
      }
      case "validation_pass": {
        unchecked.clear();
        latestUncheckedBasename = undefined;
        break;
      }
      case "lifecycle_reset": {
        edited.clear();
        unchecked.clear();
        detail.clear();
        latestUncheckedBasename = undefined;
        break;
      }
      case "validation_fail":
      case "compaction":
      default:
        break;
    }
  }

  if (latestUncheckedBasename === undefined && unchecked.size > 0) {
    latestUncheckedBasename = newestUncheckedBasename(detail, unchecked);
  }

  const entries: LedgerEntry[] = [...detail.values()]
    .sort((left, right) => left.order - right.order)
    .map((item) => ({
      identityHash: item.identityHash,
      basename: item.basename,
      edits: item.edits,
      unchecked: unchecked.has(item.identityHash)
    }));

  return {
    entries,
    edited: edited.size,
    unchecked: unchecked.size,
    latestUncheckedBasename
  };
}

function capDetail(detail: Map<string, DetailEntry>): void {
  if (detail.size <= LEDGER_IDENTITY_CAP) {
    return;
  }
  let oldestKey: string | undefined;
  let oldestOrder = Number.POSITIVE_INFINITY;
  for (const [key, entry] of detail) {
    if (entry.order < oldestOrder) {
      oldestOrder = entry.order;
      oldestKey = key;
    }
  }
  if (oldestKey !== undefined) {
    detail.delete(oldestKey);
  }
}

function newestUncheckedBasename(detail: Map<string, DetailEntry>, unchecked: Set<string>): string | undefined {
  let bestOrder = -1;
  let bestBasename: string | undefined;
  for (const entry of detail.values()) {
    if (unchecked.has(entry.identityHash) && entry.order > bestOrder) {
      bestOrder = entry.order;
      bestBasename = entry.basename;
    }
  }
  return bestBasename;
}
