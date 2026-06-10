import type { AuditOptions } from "./audit.js";
import { runDeepAdvisoryAudit, type DeepAdvisoryReport } from "./deep-advisory.js";
import { formatFeedbackLedger } from "./feedback-ledger.js";
import {
  backupInstructionFile,
  buildInstructionBlock,
  globalClaudePath,
  projectClaudePath,
  readInstructionFile,
  removeBlock,
  upsertBlock,
  writeInstructionFile,
  type BlockAction
} from "./instruction-block.js";
import {
  coarseCategoryForFinding,
  correlateInstructions,
  instructionLinesFromFile,
  type CoarseCategory,
  type InstructionCorrelation,
  type InstructionLine,
  type InstructionWindow
} from "./instruction-correlator.js";
import { projectKeyFromPath } from "./paths.js";
import { latestProjectDecision, recentFeedbackOutcomes, readStore } from "./store.js";
import type { Finding, GaugeLight, LedgerEntry, StoredDecision, StoredFeedbackOutcome } from "./types.js";

// Audit: "the line is now; audit is the story" (branch H1). One command, three sections in order:
// (1) the current project's latest session, (2) recent behavioral patterns, (3) an instruction
// report that prunes first. Plain `audit` never writes; `--apply` is the only write path.

export interface AuditReportOptions extends AuditOptions {
  apply?: boolean;
  cleanup?: boolean;
  global?: boolean;
  now?: Date;
  storePath?: string;
}

export interface AuditSessionFinding {
  category: string;
  severity: Finding["severity"];
  confidence: Finding["confidence"];
  evidence: string;
  fileHint?: string;
  note?: string;
}

export interface AuditSessionSection {
  hasHistory: boolean;
  projectScoped: boolean;
  projectKey?: string;
  light?: GaugeLight;
  state?: StoredDecision["state"];
  ageSeconds?: number;
  ageLabel?: string;
  reasonCode?: string;
  findings: AuditSessionFinding[];
  ledger: LedgerEntry[];
  feedbackOutcomes: StoredFeedbackOutcome[];
}

export interface AuditInstructionSection {
  windowSessions: number;
  removalCandidates: InstructionCorrelation["removalCandidates"];
  followed: InstructionCorrelation["followed"];
  gaps: InstructionCorrelation["gaps"];
}

export interface AuditApplyResult {
  target: "project_claude" | "global_claude";
  changed: boolean;
  backupCreated: boolean;
  blockAction: BlockAction;
  added: string[];
}

export interface AuditReport {
  kind: "audit";
  mode: "report" | "apply" | "cleanup";
  session: AuditSessionSection;
  patterns: DeepAdvisoryReport;
  instructions: AuditInstructionSection;
  diff?: string;
  applied: AuditApplyResult[];
}

const LIGHT_SYMBOLS: Record<GaugeLight, string> = {
  green: "●",
  blue: "◐",
  red: "■",
  gray: "○"
};

const LIGHT_WORDS: Record<GaugeLight, string> = {
  green: "green",
  blue: "blue",
  red: "red",
  gray: "gray"
};

// Generic, privacy-safe additions for a gap category (branch H7: generic phrasing only, never raw
// commands/paths/prompts). One line per category.
const GAP_INSTRUCTIONS: Record<CoarseCategory, string> = {
  validation_retry: "Inspect the first failure before rerunning a failed check.",
  unchecked_edits: "After changing code, run the smallest relevant check.",
  redundant_reads: "Use existing context before rereading the same unchanged file.",
  context_pressure: "Write a short handoff with open risks before compaction or stopping."
};

const MAX_ADDITIONS_PER_APPLY = 2;

export async function runAuditReport(options: AuditReportOptions = {}): Promise<AuditReport> {
  const now = options.now ?? new Date();
  if (options.cleanup) {
    const applied = await cleanupBlocks(options);
    return {
      kind: "audit",
      mode: "cleanup",
      session: emptySession(),
      patterns: await runDeepAdvisoryAudit(options),
      instructions: { windowSessions: 0, removalCandidates: [], followed: [], gaps: [] },
      applied
    };
  }

  const session = await buildSessionSection(options, now);
  const patterns = await runDeepAdvisoryAudit(options);
  const { section: instructions, lines, window } = await buildInstructionSection(options);

  let diff: string | undefined;
  let applied: AuditApplyResult[] = [];
  if (options.apply) {
    const writeResult = await applyInstructionAdditions(options, instructions, lines, window, now);
    diff = writeResult.diff;
    applied = writeResult.applied;
  }

  return {
    kind: "audit",
    mode: options.apply ? "apply" : "report",
    session,
    patterns,
    instructions,
    diff,
    applied
  };
}

// --- Section 1: current session -------------------------------------------------------------

function sessionProjectKey(options: AuditReportOptions): string {
  // Section 1 is always the current project's latest session (branch H2); --transcript only
  // scopes the section-2 pattern scan, never the project the session view reads.
  return projectKeyFromPath(options.projectDir || process.cwd());
}

async function buildSessionSection(options: AuditReportOptions, now: Date): Promise<AuditSessionSection> {
  const projectKey = sessionProjectKey(options);
  const decision = await latestProjectDecision(projectKey, options.storePath);
  if (!decision) {
    return { ...emptySession(), projectKey };
  }
  const feedbackOutcomes = decision.sessionKey ? await recentFeedbackOutcomes(decision.sessionKey, options.storePath) : [];
  const ageSeconds = decisionAgeSeconds(decision, now);
  return {
    hasHistory: true,
    projectScoped: true,
    projectKey,
    light: decision.light,
    state: decision.state,
    ageSeconds,
    ageLabel: ageSeconds === undefined ? undefined : formatAge(ageSeconds),
    reasonCode: decision.reasonCode,
    findings: (decision.findings ?? []).map((finding) => ({
      category: finding.category,
      severity: finding.severity,
      confidence: finding.confidence,
      evidence: finding.evidence,
      fileHint: finding.fileHint,
      note: finding.note
    })),
    ledger: decision.ledger ?? [],
    feedbackOutcomes
  };
}

function emptySession(): AuditSessionSection {
  return { hasHistory: false, projectScoped: true, findings: [], ledger: [], feedbackOutcomes: [] };
}

function decisionAgeSeconds(decision: StoredDecision, now: Date): number | undefined {
  const created = Date.parse(decision.createdAt);
  if (!Number.isFinite(created)) {
    return undefined;
  }
  return Math.max(0, Math.round((now.getTime() - created) / 1000));
}

function formatAge(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ago`;
  }
  if (seconds < 86_400) {
    return `${Math.floor(seconds / 3600)}h ago`;
  }
  return `${Math.floor(seconds / 86_400)}d ago`;
}

// --- Section 3: instruction report ----------------------------------------------------------

interface InstructionBuild {
  section: AuditInstructionSection;
  lines: InstructionLine[];
  window: InstructionWindow;
}

async function buildInstructionSection(options: AuditReportOptions): Promise<InstructionBuild> {
  const window = await buildInstructionWindow(options);
  const lines = await readInstructionLines(options);
  const correlation = correlateInstructions(lines, window);
  return {
    section: {
      windowSessions: window.sessionCount,
      removalCandidates: correlation.removalCandidates,
      followed: correlation.followed,
      gaps: correlation.gaps
    },
    lines,
    window
  };
}

async function buildInstructionWindow(options: AuditReportOptions): Promise<InstructionWindow> {
  const projectKey = sessionProjectKey(options);
  const store = await readStore(options.storePath);
  const decisions = store.decisions.filter((decision) =>
    options.allProjects ? Array.isArray(decision.findings) : decision.projectKey === projectKey && Array.isArray(decision.findings)
  );
  const bySession = new Map<string, Set<CoarseCategory>>();
  for (const decision of decisions) {
    const key = decision.sessionKey || decision.id;
    let categories = bySession.get(key);
    if (!categories) {
      categories = new Set<CoarseCategory>();
      bySession.set(key, categories);
    }
    for (const finding of decision.findings ?? []) {
      const coarse = coarseCategoryForFinding(finding.category);
      if (coarse) {
        categories.add(coarse);
      }
    }
  }
  const categorySessions: Partial<Record<CoarseCategory, number>> = {};
  for (const categories of bySession.values()) {
    for (const category of categories) {
      categorySessions[category] = (categorySessions[category] ?? 0) + 1;
    }
  }
  return { sessionCount: bySession.size, categorySessions };
}

async function readInstructionLines(options: AuditReportOptions): Promise<InstructionLine[]> {
  const sources: Array<{ label: string; path: string }> = [
    { label: "./CLAUDE.md", path: projectClaudePath(options.projectDir) },
    { label: "~/.claude/CLAUDE.md", path: globalClaudePath(options.homeDir) }
  ];
  const lines: InstructionLine[] = [];
  for (const source of sources) {
    const file = await readInstructionFile(source.path);
    if (file.exists) {
      lines.push(...instructionLinesFromFile(source.label, file.text));
    }
  }
  return lines;
}

// --- --apply write path ---------------------------------------------------------------------

interface ApplyOutcome {
  diff?: string;
  applied: AuditApplyResult[];
}

async function applyInstructionAdditions(
  options: AuditReportOptions,
  instructions: AuditInstructionSection,
  lines: InstructionLine[],
  window: InstructionWindow,
  now: Date
): Promise<ApplyOutcome> {
  const target: AuditApplyResult["target"] = options.global || options.allProjects ? "global_claude" : "project_claude";
  const path = target === "global_claude" ? globalClaudePath(options.homeDir) : projectClaudePath(options.projectDir);
  const additions = instructions.gaps.slice(0, MAX_ADDITIONS_PER_APPLY).map((gap) => GAP_INSTRUCTIONS[gap.category]);
  if (additions.length === 0) {
    return { diff: undefined, applied: [] };
  }

  const before = await readInstructionFile(path);
  const block = buildInstructionBlock(additions);
  const next = upsertBlock(before.text, block);
  const diff = renderDiff(target, additions, instructions.removalCandidates);
  if (next.text === before.text) {
    return {
      diff,
      applied: [{ target, changed: false, backupCreated: false, blockAction: "unchanged", added: additions }]
    };
  }
  let backupCreated = false;
  if (before.exists) {
    await backupInstructionFile(path, before.text, now);
    backupCreated = true;
  }
  await writeInstructionFile(path, next.text);
  return {
    diff,
    applied: [{ target, changed: true, backupCreated, blockAction: next.action, added: additions }]
  };
}

async function cleanupBlocks(options: AuditReportOptions): Promise<AuditApplyResult[]> {
  const now = options.now ?? new Date();
  const target: AuditApplyResult["target"] = options.global || options.allProjects ? "global_claude" : "project_claude";
  const path = target === "global_claude" ? globalClaudePath(options.homeDir) : projectClaudePath(options.projectDir);
  const before = await readInstructionFile(path);
  if (!before.exists) {
    return [{ target, changed: false, backupCreated: false, blockAction: "unchanged", added: [] }];
  }
  const next = removeBlock(before.text);
  if (next.text === before.text) {
    return [{ target, changed: false, backupCreated: false, blockAction: "unchanged", added: [] }];
  }
  await backupInstructionFile(path, before.text, now);
  await writeInstructionFile(path, next.text);
  return [{ target, changed: true, backupCreated: true, blockAction: "removed", added: [] }];
}

function renderDiff(target: AuditApplyResult["target"], additions: string[], removals: InstructionCorrelation["removalCandidates"]): string {
  const label = target === "global_claude" ? "~/.claude/CLAUDE.md" : "./CLAUDE.md";
  const lines = [`--- a/${label}`, `+++ b/${label}`, "@@ bb-cc-lite block @@"];
  lines.push("+<!-- bb-cc-lite improve:start -->");
  lines.push("+## bb-cc-lite lessons");
  for (const addition of [...additions].sort((a, b) => a.localeCompare(b))) {
    lines.push(`+- ${addition}`);
  }
  lines.push("+<!-- bb-cc-lite improve:end -->");
  for (const removal of removals) {
    // Removal proposals are comments only; bb never deletes a user-authored line (branch H7).
    lines.push(`# proposed removal (not applied): ${removal.file}:${removal.lineNumber} ${removal.text}`);
  }
  return lines.join("\n");
}

// --- Rendering ------------------------------------------------------------------------------

const ESC = String.fromCharCode(27);
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const LIGHT_COLORS: Record<GaugeLight, string> = {
  green: `${ESC}[32m`,
  blue: `${ESC}[34m`,
  red: `${ESC}[1;31m`,
  gray: `${ESC}[2m`
};

export interface FormatAuditOptions {
  color?: boolean;
}

export function renderAuditReport(report: AuditReport, options: FormatAuditOptions = {}): string {
  const color = options.color === true;
  const blocks: string[] = [];
  blocks.push(renderSessionSection(report.session, color));
  blocks.push(renderPatternsSection(report.patterns));
  const instructionBlock = renderInstructionSection(report);
  if (instructionBlock) {
    blocks.push(instructionBlock);
  }
  blocks.push(
    "Privacy: bb stores derived metadata only. Instruction lines above are read locally and shown with line numbers; their content is never written into bb's store."
  );
  return blocks.join("\n\n");
}

function renderSessionSection(session: AuditSessionSection, color: boolean): string {
  const lines = [bold("[1] Current session", color)];
  if (!session.hasHistory) {
    lines.push("No bb history for this project.");
    return lines.join("\n");
  }
  const light = session.light ?? "gray";
  const header = `${colorLight(light, color)} ${LIGHT_WORDS[light]} (${session.state ?? "?"}) · ${session.ageLabel ?? "age unknown"}`;
  lines.push(header);
  if (session.findings.length === 0) {
    lines.push("Findings: none recorded for this decision.");
  } else {
    lines.push("Findings:");
    for (const finding of session.findings) {
      const tail = finding.note ? ` [${finding.note}]` : "";
      lines.push(`  ${severityMark(finding.severity)} ${finding.confidence.padEnd(6)} ${finding.category}: ${finding.evidence}${tail}`);
    }
  }
  lines.push(...renderLedger(session.ledger));
  const feedback = formatFeedbackLedger(session.feedbackOutcomes, { color });
  if (feedback) {
    lines.push(feedback);
  }
  return lines.join("\n");
}

function renderLedger(ledger: LedgerEntry[]): string[] {
  if (ledger.length === 0) {
    return ["Edit ledger: empty."];
  }
  const rows = ["Edit ledger:", "  file              edits  status"];
  for (const entry of ledger) {
    const name = (entry.basename ?? entry.identityHash.slice(0, 8)).padEnd(17);
    const edits = String(entry.edits).padEnd(6);
    rows.push(`  ${name} ${edits} ${entry.unchecked ? "unchecked" : "cleared by check"}`);
  }
  return rows;
}

function renderPatternsSection(patterns: DeepAdvisoryReport): string {
  const lines = ["[2] Recent patterns"];
  const scopeLabel =
    patterns.scope === "project"
      ? `project transcripts, newest ${patterns.recentLimit}`
      : patterns.scope === "all-projects"
        ? `all local project transcripts, newest ${patterns.recentLimit}`
        : "provided transcript";
  lines.push(`Scope: ${scopeLabel}`);
  lines.push(`Scanned: ${patterns.sessionsScanned} Claude Code session${patterns.sessionsScanned === 1 ? "" : "s"}`);
  if (patterns.unreadableTranscripts > 0) {
    lines.push(`Skipped: ${patterns.unreadableTranscripts} unreadable transcript${patterns.unreadableTranscripts === 1 ? "" : "s"}`);
  }
  lines.push(`Sessions with findings: ${patterns.sessionsWithFindings}`);
  lines.push(`Report confidence: ${patterns.reportConfidence} - ${patterns.reportConfidenceReason}`);
  if (patterns.findings.length === 0) {
    lines.push("Patterns: none in the scanned transcript window.");
  } else {
    lines.push("Patterns:");
    for (const finding of patterns.findings.slice(0, 20)) {
      lines.push(`  ${finding.state.padEnd(7)} ${finding.confidence.padEnd(6)} session ${finding.session}: ${finding.evidence}`);
    }
    if (patterns.findings.length > 20) {
      lines.push(`  plus ${patterns.findings.length - 20} more derived findings`);
    }
  }
  return lines.join("\n");
}

function renderInstructionSection(report: AuditReport): string | undefined {
  const { instructions } = report;
  const subsections: string[] = [];
  if (instructions.removalCandidates.length > 0) {
    const rows = ["Candidates for removal:"];
    for (const candidate of instructions.removalCandidates) {
      rows.push(`  ${candidate.file}:${candidate.lineNumber}  ${candidate.text} — matched no recent finding categories`);
    }
    subsections.push(rows.join("\n"));
  }
  if (instructions.followed.length > 0) {
    const rows = ["Apparently followed:"];
    for (const line of instructions.followed) {
      rows.push(
        `  ${line.file}:${line.lineNumber}  ${line.text} — followed in ${line.compliedSessions}/${line.totalSessions} edit sessions, possibly redundant`
      );
    }
    subsections.push(rows.join("\n"));
  }
  if (instructions.gaps.length > 0) {
    const rows = ["Gaps:"];
    for (const gap of instructions.gaps) {
      rows.push(`  ${gap.label}: seen ${gap.seen}x with no addressing instruction line`);
    }
    subsections.push(rows.join("\n"));
  }

  const writeBlocks: string[] = [];
  if (report.diff) {
    writeBlocks.push(["Proposed CLAUDE.md diff:", report.diff].join("\n"));
  }
  if (report.mode === "apply" || report.mode === "cleanup") {
    const applied = report.applied;
    if (applied.length === 0) {
      writeBlocks.push(report.mode === "cleanup" ? "Cleaned: nothing to remove." : "Applied: no addition met the evidence threshold.");
    } else {
      const rows = [report.mode === "cleanup" ? "Cleaned:" : "Applied:"];
      for (const result of applied) {
        rows.push(`  ${targetLabel(result.target)}: ${result.blockAction}; backup ${result.backupCreated ? "created" : "not needed"}`);
      }
      writeBlocks.push(rows.join("\n"));
    }
  }

  if (subsections.length === 0 && writeBlocks.length === 0) {
    return undefined;
  }
  return ["[3] Instruction report", ...subsections, ...writeBlocks].join("\n\n");
}

function targetLabel(target: AuditApplyResult["target"]): string {
  return target === "global_claude" ? "~/.claude/CLAUDE.md" : "./CLAUDE.md";
}

function severityMark(severity: Finding["severity"]): string {
  if (severity === "red") {
    return "■";
  }
  if (severity === "blue") {
    return "◐";
  }
  return "·";
}

function colorLight(light: GaugeLight, enabled: boolean): string {
  return enabled ? `${LIGHT_COLORS[light]}${LIGHT_SYMBOLS[light]}${RESET}` : LIGHT_SYMBOLS[light];
}

function bold(text: string, enabled: boolean): string {
  return enabled ? `${BOLD}${text}${RESET}` : text;
}
