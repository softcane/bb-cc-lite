import { coarseCategoryLabel, GAP_MIN_SEEN, type CoarseCategory, type GapCategory } from "./instruction-correlator.js";
import { type RepoProfile, type ValidationCommand, type WorkAreaProfile, workAreasForFileHint } from "./repo-profile.js";
import type { DecisionConfidence } from "./types.js";

export type LessonCandidateSource = "contextual" | "generic_fallback";

export interface LessonEvidence {
  category: CoarseCategory;
  seen: number;
  fileHints: string[];
}

export interface LessonCommandPlan {
  focused?: string;
  broad: string[];
}

export interface ContextualLessonCandidate {
  category: CoarseCategory;
  label: string;
  workArea: string;
  confidence: DecisionConfidence;
  evidenceSessions: number;
  text: string;
  source: LessonCandidateSource;
  fallbackReason?: string;
  commands: LessonCommandPlan;
}

export interface PlanContextualLessonsOptions {
  profile: RepoProfile;
  gaps: readonly GapCategory[];
  evidence: Partial<Record<CoarseCategory, LessonEvidence>>;
  maxCandidates?: number;
}

const GENERIC_FALLBACKS: Record<CoarseCategory, string> = {
  validation_retry: "Inspect the first failure before rerunning a failed check.",
  unchecked_edits: "After changing code, run the smallest relevant check before the full gate.",
  redundant_reads: "Use existing context before rereading the same unchanged file.",
  context_pressure: "Write a short handoff with open risks before compaction or stopping."
};

const CATEGORY_PRIORITY: Record<CoarseCategory, number> = {
  validation_retry: 0,
  unchecked_edits: 1,
  redundant_reads: 2,
  context_pressure: 3
};

export function genericFallbackForCategory(category: CoarseCategory): string {
  return GENERIC_FALLBACKS[category];
}

export function planContextualLessons(options: PlanContextualLessonsOptions): ContextualLessonCandidate[] {
  const candidates = options.gaps
    .map((gap) => lessonForGap(gap, options.profile, options.evidence[gap.category]))
    .filter((candidate): candidate is ContextualLessonCandidate => Boolean(candidate))
    .sort(
      (left, right) =>
        sourceRank(left.source) - sourceRank(right.source) ||
        CATEGORY_PRIORITY[left.category] - CATEGORY_PRIORITY[right.category] ||
        right.evidenceSessions - left.evidenceSessions ||
        left.text.localeCompare(right.text)
    );
  return candidates.slice(0, options.maxCandidates ?? candidates.length);
}

function lessonForGap(
  gap: GapCategory,
  profile: RepoProfile,
  evidence: LessonEvidence | undefined
): ContextualLessonCandidate | undefined {
  const seen = evidence?.seen ?? gap.seen;
  if (seen < GAP_MIN_SEEN) {
    return undefined;
  }
  if (!profile.hasUsefulContext) {
    return fallbackCandidate(gap.category, seen, "no repo-owned validation context found");
  }
  const workArea = chooseWorkArea(profile, gap.category, evidence?.fileHints ?? []);
  const commands = commandPlan(profile, workArea);
  const text = contextualText(gap.category, workArea.label, commands, profile);
  if (!text) {
    return fallbackCandidate(gap.category, seen, "repo context did not map to a stable work area");
  }
  return {
    category: gap.category,
    label: coarseCategoryLabel(gap.category),
    workArea: workArea.label,
    confidence: candidateConfidence(workArea, commands),
    evidenceSessions: seen,
    text,
    source: "contextual",
    commands
  };
}

function fallbackCandidate(category: CoarseCategory, seen: number, fallbackReason: string): ContextualLessonCandidate {
  return {
    category,
    label: coarseCategoryLabel(category),
    workArea: "generic",
    confidence: "low",
    evidenceSessions: seen,
    text: GENERIC_FALLBACKS[category],
    source: "generic_fallback",
    fallbackReason,
    commands: { broad: [] }
  };
}

function chooseWorkArea(
  profile: RepoProfile,
  category: CoarseCategory,
  fileHints: readonly string[]
): WorkAreaProfile | { id: "project"; label: string; sourceFiles: string[]; testFiles: string[] } {
  const scored = new Map<string, { area: WorkAreaProfile; score: number }>();
  for (const hint of fileHints) {
    for (const area of workAreasForFileHint(profile, hint)) {
      const current = scored.get(area.id) ?? { area, score: 0 };
      current.score += 1;
      scored.set(area.id, current);
    }
  }
  const best = [...scored.values()].sort(
    (left, right) => right.score - left.score || left.area.label.localeCompare(right.area.label)
  )[0]?.area;
  if (best) {
    return best;
  }
  if (category === "redundant_reads" && profile.contextSources.some((source) => source.includes("AGENTS.md"))) {
    return { id: "project", label: "repo navigation", sourceFiles: [], testFiles: [] };
  }
  if (category === "context_pressure") {
    return { id: "project", label: "handoffs", sourceFiles: [], testFiles: [] };
  }
  return { id: "project", label: "project", sourceFiles: [], testFiles: [] };
}

function commandPlan(profile: RepoProfile, workArea: Pick<WorkAreaProfile, "testFiles">): LessonCommandPlan {
  const focused = focusedValidation(profile, workArea);
  const broad = broadValidation(profile).filter((command) => command !== focused);
  return { focused, broad };
}

function focusedValidation(profile: RepoProfile, workArea: Pick<WorkAreaProfile, "testFiles">): string | undefined {
  const configuredTest = firstCommand(profile.validationCommands, "tests", "bb-config");
  if (configuredTest) {
    return configuredTest.command;
  }
  const packageTest = firstCommand(profile.validationCommands, "tests", "package-script");
  if (!packageTest) {
    return undefined;
  }
  const focusedTests = workArea.testFiles.filter(isSafeTestPath).slice(0, 2);
  if (focusedTests.length === 0) {
    return packageTest.command;
  }
  return `${packageTest.command} -- ${focusedTests.join(" ")}`;
}

function broadValidation(profile: RepoProfile): string[] {
  const commands: string[] = [];
  for (const category of ["typecheck", "lint", "tests", "build"] as const) {
    const configured = firstCommand(profile.validationCommands, category, "bb-config");
    const packageScript = firstCommand(profile.validationCommands, category, "package-script");
    const command = configured?.command ?? packageScript?.command;
    if (command) {
      commands.push(command);
    }
  }
  return commands;
}

function firstCommand(
  commands: readonly ValidationCommand[],
  category: ValidationCommand["category"],
  source: ValidationCommand["source"]
): ValidationCommand | undefined {
  return commands.find((command) => command.category === category && command.source === source);
}

function contextualText(
  category: CoarseCategory,
  workAreaLabel: string,
  commands: LessonCommandPlan,
  profile: RepoProfile
): string | undefined {
  switch (category) {
    case "validation_retry":
      return validationRetryText(workAreaLabel, commands);
    case "unchecked_edits":
      return uncheckedEditsText(workAreaLabel, commands);
    case "redundant_reads":
      return redundantReadsText(workAreaLabel, profile);
    case "context_pressure":
      return contextPressureText(workAreaLabel);
  }
}

function validationRetryText(workAreaLabel: string, commands: LessonCommandPlan): string {
  const focused = formatFocused(commands.focused);
  const broad = formatBroad(commands.broad);
  if (focused && broad) {
    return withExample("validation_retry", `for ${workAreaLabel} validation failures, inspect the first failure, then run ${focused} before ${broad}.`);
  }
  if (focused) {
    return withExample("validation_retry", `for ${workAreaLabel} validation failures, inspect the first failure, then run ${focused}.`);
  }
  return withExample("validation_retry", `for ${workAreaLabel} validation failures, inspect the first failure before rerunning the check.`);
}

function uncheckedEditsText(workAreaLabel: string, commands: LessonCommandPlan): string {
  const focused = formatFocused(commands.focused);
  const broad = formatBroad(commands.broad);
  if (focused && broad) {
    return withExample("unchecked_edits", `for ${workAreaLabel} changes, run ${focused} before ${broad}.`);
  }
  if (focused) {
    return withExample("unchecked_edits", `for ${workAreaLabel} changes, run ${focused} before widening validation.`);
  }
  return withExample("unchecked_edits", `for ${workAreaLabel} changes, run the focused validation before the full release gate.`);
}

function redundantReadsText(workAreaLabel: string, profile: RepoProfile): string {
  const mapLabel = profile.contextSources.some((source) => source.includes("AGENTS.md"))
    ? "the repo Source Map and Test Map"
    : "existing repo context";
  return withExample("redundant_reads", `for ${workAreaLabel}, use ${mapLabel} before rereading unchanged files.`);
}

function contextPressureText(workAreaLabel: string): string {
  return withExample("context_pressure", `for ${workAreaLabel}, record the current finding, next check, and open risks before compaction or stopping.`);
}

function withExample(category: CoarseCategory, example: string): string {
  return `${GENERIC_FALLBACKS[category]} For example, ${example}`;
}

function formatFocused(command: string | undefined): string | undefined {
  return command ? `\`${command}\`` : undefined;
}

function formatBroad(commands: readonly string[]): string | undefined {
  if (commands.length === 0) {
    return "the full release gate";
  }
  return formatCommandList(commands);
}

function formatCommandList(commands: readonly string[]): string {
  const quoted = commands.map((command) => `\`${command}\``);
  if (quoted.length === 1) {
    return quoted[0] ?? "";
  }
  if (quoted.length === 2) {
    return `${quoted[0]} and ${quoted[1]}`;
  }
  return `${quoted.slice(0, -1).join(", ")}, and ${quoted[quoted.length - 1]}`;
}

function candidateConfidence(
  workArea: Pick<WorkAreaProfile, "testFiles"> | { id: "project"; label: string; sourceFiles: string[]; testFiles: string[] },
  commands: LessonCommandPlan
): DecisionConfidence {
  if (workArea.testFiles.length > 0 && commands.focused && commands.broad.length > 0) {
    return "high";
  }
  if (commands.focused || commands.broad.length > 0) {
    return "medium";
  }
  return "low";
}

function isSafeTestPath(value: string): boolean {
  return /^test\/[A-Za-z0-9/_-]+\.test\.[cm]?[jt]s$/u.test(value) && !value.includes("..");
}

function sourceRank(source: LessonCandidateSource): number {
  return source === "contextual" ? 0 : 1;
}
