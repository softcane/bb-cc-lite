// Instruction correlator (PRD-02 section 3, branch H4/H5). Deliberately coarse keyword/category
// matching, isolated here behind a small interface so it can improve without touching report
// logic. Every claim is phrased as "matched / didn't match", never causal. Subsection callers
// render a subsection only when it is non-empty.
//
// Privacy: this module receives instruction-file line text (local, user-owned) only to echo it
// back with line numbers in TERMINAL output. It never persists anything; callers must keep the
// derived-only store invariant.

export type CoarseCategory = "validation_retry" | "unchecked_edits" | "redundant_reads" | "context_pressure";

export const COARSE_CATEGORIES: readonly CoarseCategory[] = [
  "validation_retry",
  "unchecked_edits",
  "redundant_reads",
  "context_pressure"
];

// Gaps require a category seen at least this many times in the evidence window (branch H4).
export const GAP_MIN_SEEN = 3;
// "Apparently followed" needs a window of at least this many sessions before a ratio means much.
const FOLLOWED_MIN_SESSIONS = 3;
// A line is "apparently followed" when its category was a finding in at most this share of sessions.
const FOLLOWED_MAX_VIOLATION_RATIO = 0.3;

const CATEGORY_LABELS: Record<CoarseCategory, string> = {
  validation_retry: "repeated validation/retry failures",
  unchecked_edits: "edits left unchecked",
  redundant_reads: "rereading unchanged files",
  context_pressure: "context pressure at compaction or stop"
};

// Stored finding categories (from src/findings.ts) collapse into the coarse buckets a human rule
// can plausibly address. Unmapped finding categories (e.g. gray plumbing states) are ignored.
const FINDING_CATEGORY_TO_COARSE: Record<string, CoarseCategory> = {
  blind_retry_loop: "validation_retry",
  repeated_tool_failure: "validation_retry",
  edit_test_retry_loop: "validation_retry",
  budget_with_repeated_failure: "validation_retry",
  blind_retry: "validation_retry",
  tool_failure_repeated: "validation_retry",
  edit_drift: "unchecked_edits",
  redundant_read_loop: "redundant_reads",
  redundant_read: "redundant_reads",
  context_critical: "context_pressure",
  compaction_goal_preservation: "context_pressure",
  cache_efficiency_regression: "context_pressure"
};

// Coarse keyword sets for instruction lines. Order matters only for readability; a line may match
// several categories.
const KEYWORDS: Record<CoarseCategory, readonly string[]> = {
  validation_retry: ["test", "validate", "validation", "validation failure", "inspect the first failure", "lint", "typecheck", "type-check", "build", "retry", "rerun", "re-run", "failing check", "checks pass"],
  unchecked_edits: ["after chang", "after edit", "after a change", "changes, run", "run the smallest", "verify the change", "confirm the edit", "before committing", "after writing code", "after you edit"],
  redundant_reads: ["reread", "re-read", "read the same", "rereading", "existing context", "source map", "test map", "unchanged files", "already read", "same file"],
  context_pressure: ["compact", "compaction", "handoff", "hand-off", "summarize progress", "restate", "open risk", "open risks", "next check", "before continuing after"]
};

export function coarseCategoryForFinding(category: string): CoarseCategory | undefined {
  return FINDING_CATEGORY_TO_COARSE[category];
}

export function coarseCategoryLabel(category: CoarseCategory): string {
  return CATEGORY_LABELS[category];
}

export function classifyInstructionLine(text: string): CoarseCategory[] {
  const haystack = text.toLowerCase();
  const matched: CoarseCategory[] = [];
  for (const category of COARSE_CATEGORIES) {
    if (KEYWORDS[category].some((keyword) => haystack.includes(keyword))) {
      matched.push(category);
    }
  }
  return matched;
}

export interface InstructionLine {
  file: string;
  lineNumber: number;
  text: string;
  categories: CoarseCategory[];
}

// Parse a CLAUDE.md file into correlatable instruction lines. Only lines that classify into at
// least one coarse category are tracked; headings, blank lines, and prose we cannot map are left
// alone so we never propose removing something we did not understand.
export function instructionLinesFromFile(file: string, content: string): InstructionLine[] {
  const lines: InstructionLine[] = [];
  const rawLines = content.split(/\r?\n/u);
  for (const [index, raw] of rawLines.entries()) {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith("<!--")) {
      continue;
    }
    const categories = classifyInstructionLine(trimmed);
    if (categories.length === 0) {
      continue;
    }
    lines.push({ file, lineNumber: index + 1, text: stripBullet(trimmed), categories });
  }
  return lines;
}

function stripBullet(text: string): string {
  return text.replace(/^[-*+]\s+/u, "").replace(/^\d+\.\s+/u, "");
}

export interface InstructionWindow {
  // Number of distinct sessions in the evidence window.
  sessionCount: number;
  // Per coarse category: how many of those sessions exhibited it as a finding.
  categorySessions: Partial<Record<CoarseCategory, number>>;
  // Optional basename-level hints from stored gauge findings. These are not raw paths.
  categoryFileHints?: Partial<Record<CoarseCategory, string[]>>;
}

export interface RemovalCandidate {
  file: string;
  lineNumber: number;
  text: string;
}

export interface FollowedLine {
  file: string;
  lineNumber: number;
  text: string;
  category: CoarseCategory;
  compliedSessions: number;
  totalSessions: number;
}

export interface GapCategory {
  category: CoarseCategory;
  label: string;
  seen: number;
}

export interface InstructionCorrelation {
  removalCandidates: RemovalCandidate[];
  followed: FollowedLine[];
  gaps: GapCategory[];
}

export function correlateInstructions(lines: readonly InstructionLine[], window: InstructionWindow): InstructionCorrelation {
  const seen = (category: CoarseCategory): number => window.categorySessions[category] ?? 0;
  const removalCandidates: RemovalCandidate[] = [];
  const followed: FollowedLine[] = [];
  const addressed = new Set<CoarseCategory>();

  for (const line of lines) {
    for (const category of line.categories) {
      addressed.add(category);
    }
    // Removal: none of the line's mapped categories appeared in the window at all.
    if (line.categories.every((category) => seen(category) === 0)) {
      removalCandidates.push({ file: line.file, lineNumber: line.lineNumber, text: line.text });
      continue;
    }
    // Apparently followed: the strongest mapped category showed up rarely, i.e. mostly complied.
    const strongest = [...line.categories].sort((a, b) => seen(b) - seen(a))[0];
    const seenCount = seen(strongest);
    const total = window.sessionCount;
    if (
      total >= FOLLOWED_MIN_SESSIONS &&
      seenCount >= 1 &&
      seenCount <= Math.floor(total * FOLLOWED_MAX_VIOLATION_RATIO)
    ) {
      followed.push({
        file: line.file,
        lineNumber: line.lineNumber,
        text: line.text,
        category: strongest,
        compliedSessions: total - seenCount,
        totalSessions: total
      });
    }
  }

  const gaps: GapCategory[] = [];
  for (const category of COARSE_CATEGORIES) {
    if (seen(category) >= GAP_MIN_SEEN && !addressed.has(category)) {
      gaps.push({ category, label: CATEGORY_LABELS[category], seen: seen(category) });
    }
  }

  return { removalCandidates, followed, gaps };
}
