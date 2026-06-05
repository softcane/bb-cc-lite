import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readBaselineForProject } from "./baseline.js";
import { assertAdvisoryPrivacy, runDeepAdvisoryAudit, type DeepAdvisoryFinding, type DeepAdvisoryReport } from "./deep-advisory.js";
import { readLessonMemory } from "./memory-lessons.js";
import { projectKeyFromPath } from "./paths.js";
import type { AuditOptions } from "./audit.js";
import type { DecisionConfidence } from "./types.js";

const BLOCK_START = "<!-- bb-cc-lite improve:start -->";
const BLOCK_END = "<!-- bb-cc-lite improve:end -->";

type ImproveScope = "global" | "project" | "session";
type ImproveTarget = "global_claude" | "project_claude" | "session_report";
type LessonKey = "unchecked_edits" | "blind_validation_retry" | "write_failed" | "context_pressure" | "redundant_read";

export interface ImproveOptions extends AuditOptions {
  apply?: boolean;
  global?: boolean;
  now?: Date;
  appHomePath?: string;
}

export interface ImproveSuggestion {
  id: string;
  scope: ImproveScope;
  target: ImproveTarget;
  writable: boolean;
  confidence: DecisionConfidence;
  lessonKey: LessonKey;
  instruction: string;
  evidence: {
    sessions: number;
    projects: number;
    findings: number;
  };
  note: string;
}

export interface ImproveApplyResult {
  target: Exclude<ImproveTarget, "session_report">;
  changed: boolean;
  backupCreated: boolean;
  blockAction: "created" | "updated" | "unchanged";
  suggestionIds: string[];
}

export interface ImproveReport {
  kind: "improve";
  mode: "review" | "apply";
  deepReportConfidence: DecisionConfidence;
  baselineSource: "project" | "personal" | "none";
  suggestions: ImproveSuggestion[];
  applied: ImproveApplyResult[];
  privacyValidated: true;
}

interface LessonGroup {
  lessonKey: LessonKey;
  findings: DeepAdvisoryFinding[];
  sessions: Set<number>;
  projects: Set<string>;
  memoryEvidence?: {
    failures: number;
    sessions: number;
  };
}

export async function runImprove(options: ImproveOptions = {}): Promise<ImproveReport> {
  const deepReport = await runDeepAdvisoryAudit(options);
  const baseline = await readBaselineForProject({
    projectDir: options.projectDir,
    homeDir: options.homeDir,
    appHomePath: options.appHomePath
  });
  const groups = await improvementGroups(deepReport, options);
  const suggestions = [...groups.values()]
    .map((group) => suggestionFromGroup(group, deepReport, options))
    .filter((suggestion): suggestion is ImproveSuggestion => Boolean(suggestion))
    .sort((left, right) => suggestionScore(right) - suggestionScore(left) || left.id.localeCompare(right.id));
  const applied = options.apply ? await applySuggestions(suggestions, options) : [];
  const report: ImproveReport = {
    kind: "improve",
    mode: options.apply ? "apply" : "review",
    deepReportConfidence: deepReport.reportConfidence,
    baselineSource: baseline.source,
    suggestions,
    applied,
    privacyValidated: true
  };
  assertAdvisoryPrivacy(report);
  return report;
}

export function formatImproveReport(report: ImproveReport): string {
  assertAdvisoryPrivacy(report);
  const lines: string[] = [];
  lines.push(report.mode === "apply" ? "bb improve applied" : "bb improve suggestions");
  lines.push(`Mode: ${report.mode === "apply" ? "apply" : "review only"}`);
  lines.push(`Baseline source: ${report.baselineSource}`);
  lines.push("");
  if (report.suggestions.length === 0) {
    lines.push("Suggestions: none strong enough to write.");
  } else {
    lines.push("Suggestions:");
    for (const suggestion of report.suggestions) {
      lines.push(
        `${suggestion.scope.padEnd(7)} ${suggestion.confidence.padEnd(7)} ${targetLabel(suggestion.target)}: ${suggestion.instruction}`
      );
      lines.push(
        `        evidence: ${suggestion.evidence.sessions} sessions, ${suggestion.evidence.projects} project groups, ${suggestion.evidence.findings} findings`
      );
      lines.push(`        ${suggestion.note}`);
    }
  }
  if (report.applied.length > 0) {
    lines.push("");
    lines.push("Applied:");
    for (const applied of report.applied) {
      lines.push(
        `${targetLabel(applied.target)}: ${applied.blockAction}; backup ${applied.backupCreated ? "created" : "not needed"}`
      );
    }
  }
  lines.push("");
  lines.push("Privacy: suggestions use safe categories only. No commands, paths, prompts, tool output, or file contents are written.");
  lines.push("Project validation command patterns belong in .bb-cc-lite.json, not CLAUDE.md.");
  lines.push("AGENTS.md is not edited in this version.");
  const output = lines.join("\n");
  assertAdvisoryPrivacy(output);
  return output;
}

async function improvementGroups(report: DeepAdvisoryReport, options: ImproveOptions): Promise<Map<LessonKey, LessonGroup>> {
  const groups = new Map<LessonKey, LessonGroup>();
  const projectBySession = new Map(report.sessions.map((session) => [session.session, session.projectKey || "transcript"]));
  for (const finding of report.findings) {
    const lessonKey = lessonKeyForFinding(finding);
    if (!lessonKey) {
      continue;
    }
    const group = groups.get(lessonKey) || {
      lessonKey,
      findings: [],
      sessions: new Set<number>(),
      projects: new Set<string>()
    };
    group.findings.push(finding);
    group.sessions.add(finding.session);
    group.projects.add(projectBySession.get(finding.session) || "transcript");
    groups.set(lessonKey, group);
  }

  const projectDir = options.projectDir || (!options.allProjects && !options.transcriptPath ? process.cwd() : undefined);
  if (projectDir) {
    const projectKey = projectKeyFromPath(projectDir);
    const memory = await readLessonMemory({ projectKey, homeDir: options.homeDir, appHomePath: options.appHomePath });
    const validationLesson = memory?.lessons
      .filter((lesson) => lesson.reasonCode === "validation_repeated" && lesson.evidenceCounts.failures >= 3)
      .sort((left, right) => right.evidenceCounts.failures - left.evidenceCounts.failures)[0];
    if (validationLesson) {
      const group = groups.get("blind_validation_retry") || {
        lessonKey: "blind_validation_retry",
        findings: [],
        sessions: new Set<number>(),
        projects: new Set<string>()
      };
      group.projects.add(projectKey);
      group.memoryEvidence = validationLesson.evidenceCounts;
      groups.set("blind_validation_retry", group);
    }
  }
  return groups;
}

function suggestionFromGroup(
  group: LessonGroup,
  report: DeepAdvisoryReport,
  options: ImproveOptions
): ImproveSuggestion | undefined {
  const sessions = Math.max(group.sessions.size, group.memoryEvidence?.sessions || 0);
  const findings = Math.max(group.findings.length, group.memoryEvidence?.failures || 0);
  const projects = group.projects.size;
  const scope = suggestionScope({ sessions, findings, projects, globalRequested: Boolean(options.global) });
  if (!scope) {
    return undefined;
  }
  const target = targetForScope(scope);
  const writable = target !== "session_report" && (scope === "global" || report.scope === "project");
  return {
    id: `${scope}:${group.lessonKey}`,
    scope,
    target,
    writable,
    confidence: suggestionConfidence(scope, sessions, findings, projects),
    lessonKey: group.lessonKey,
    instruction: instructionForLesson(group.lessonKey),
    evidence: {
      sessions,
      projects,
      findings
    },
    note: noteForSuggestion(scope, writable)
  };
}

function lessonKeyForFinding(finding: DeepAdvisoryFinding): LessonKey | undefined {
  switch (finding.reasonCode) {
    case "code_change_unvalidated":
    case "many_edits_unvalidated":
    case "many_changed_files_unvalidated":
      return "unchecked_edits";
    case "blind_validation_retry":
      return "blind_validation_retry";
    case "write_failed":
    case "write_failed_then_continued":
      return "write_failed";
    case "compaction_with_open_risk":
    case "session_end_with_open_risk":
      return "context_pressure";
    case "redundant_read":
      return "redundant_read";
    case "validation_recovered_after_change":
      return undefined;
  }
}

function suggestionScope(args: {
  sessions: number;
  findings: number;
  projects: number;
  globalRequested: boolean;
}): ImproveScope | undefined {
  if (args.globalRequested && (args.projects >= 2 || args.sessions >= 5)) {
    return "global";
  }
  if (args.sessions >= 2 || args.findings >= 3) {
    return "project";
  }
  if (args.findings > 0) {
    return "session";
  }
  return undefined;
}

function targetForScope(scope: ImproveScope): ImproveTarget {
  if (scope === "global") {
    return "global_claude";
  }
  if (scope === "project") {
    return "project_claude";
  }
  return "session_report";
}

function suggestionConfidence(scope: ImproveScope, sessions: number, findings: number, projects: number): DecisionConfidence {
  if (scope === "global" && projects >= 2) {
    return "high";
  }
  if (scope === "project" && (sessions >= 3 || findings >= 3)) {
    return "high";
  }
  return scope === "session" ? "low" : "medium";
}

function instructionForLesson(lessonKey: LessonKey): string {
  switch (lessonKey) {
    case "unchecked_edits":
      return "After changing code, run the smallest relevant check.";
    case "blind_validation_retry":
      return "Do not rerun a failed validation check until you inspect the first failure and make one targeted change.";
    case "write_failed":
      return "After a write or edit fails, confirm the change landed before continuing.";
    case "context_pressure":
      return "Before continuing after compaction or session stop risk, write a short handoff with open risks.";
    case "redundant_read":
      return "Use the current context before rereading the same file repeatedly.";
  }
}

function noteForSuggestion(scope: ImproveScope, writable: boolean): string {
  if (scope === "session") {
    return "session-only; not written to CLAUDE.md";
  }
  if (!writable) {
    return "review-only in this scan mode; no instruction file target is selected";
  }
  return "review this before applying; --apply writes only the marked bb-cc-lite block";
}

async function applySuggestions(suggestions: ImproveSuggestion[], options: ImproveOptions): Promise<ImproveApplyResult[]> {
  const writable = suggestions.filter((suggestion) => suggestion.writable && suggestion.scope !== "session");
  const globalSuggestions = writable.filter((suggestion) => suggestion.target === "global_claude");
  const projectSuggestions = writable.filter((suggestion) => suggestion.target === "project_claude");
  const results: ImproveApplyResult[] = [];
  if (globalSuggestions.length > 0) {
    results.push(
      await applyInstructionBlock({
        target: "global_claude",
        path: globalClaudePath(options.homeDir),
        suggestions: globalSuggestions,
        now: options.now
      })
    );
  }
  if (projectSuggestions.length > 0) {
    results.push(
      await applyInstructionBlock({
        target: "project_claude",
        path: projectClaudePath(options.projectDir),
        suggestions: projectSuggestions,
        now: options.now
      })
    );
  }
  return results;
}

async function applyInstructionBlock(options: {
  target: Exclude<ImproveTarget, "session_report">;
  path: string;
  suggestions: ImproveSuggestion[];
  now?: Date;
}): Promise<ImproveApplyResult> {
  const before = await readTextFile(options.path);
  const block = instructionBlock(options.suggestions);
  const next = upsertBlock(before.text, block);
  if (next.text === before.text) {
    return {
      target: options.target,
      changed: false,
      backupCreated: false,
      blockAction: "unchanged",
      suggestionIds: options.suggestions.map((suggestion) => suggestion.id)
    };
  }
  assertAdvisoryPrivacy(block);
  await mkdir(dirname(options.path), { recursive: true });
  let backupCreated = false;
  if (before.exists) {
    const backupPath = backupInstructionPath(options.path, options.now ?? new Date());
    await writeFile(backupPath, before.text, "utf8");
    backupCreated = true;
  }
  await writeFile(options.path, next.text, "utf8");
  return {
    target: options.target,
    changed: true,
    backupCreated,
    blockAction: next.action,
    suggestionIds: options.suggestions.map((suggestion) => suggestion.id)
  };
}

function instructionBlock(suggestions: ImproveSuggestion[]): string {
  const lines = [
    BLOCK_START,
    "## bb-cc-lite lessons",
    ...suggestions
      .map((suggestion) => `- ${suggestion.instruction}`)
      .sort((left, right) => left.localeCompare(right)),
    BLOCK_END
  ];
  return `${lines.join("\n")}\n`;
}

function upsertBlock(existing: string, block: string): { text: string; action: "created" | "updated" } {
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

async function readTextFile(path: string): Promise<{ exists: boolean; text: string }> {
  try {
    return { exists: true, text: await readFile(path, "utf8") };
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, text: "" };
    }
    throw error;
  }
}

function backupInstructionPath(path: string, now: Date): string {
  return `${path}.bb-cc-lite-backup-${now.toISOString().replaceAll(/[:.]/gu, "-")}`;
}

function globalClaudePath(homeDir = homedir()): string {
  return join(resolve(homeDir), ".claude", "CLAUDE.md");
}

function projectClaudePath(projectDir = process.cwd()): string {
  return join(resolve(projectDir), "CLAUDE.md");
}

function targetLabel(target: ImproveTarget): string {
  if (target === "global_claude") {
    return "global CLAUDE.md";
  }
  if (target === "project_claude") {
    return "project CLAUDE.md";
  }
  return "session report";
}

function suggestionScore(suggestion: ImproveSuggestion): number {
  const scopeScore = suggestion.scope === "global" ? 100 : suggestion.scope === "project" ? 50 : 0;
  const confidenceScore = suggestion.confidence === "high" ? 10 : suggestion.confidence === "medium" ? 5 : 0;
  return scopeScore + confidenceScore + suggestion.evidence.sessions + suggestion.evidence.findings;
}
