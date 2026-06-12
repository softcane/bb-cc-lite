import { dirname } from "node:path";
import { auditTranscriptCandidates, type AuditOptions } from "./audit.js";
import { hashValue, projectKeyFromPath } from "./paths.js";
import { loadProjectConfig, type ProjectConfig } from "./project-config.js";
import { parseTranscriptLines } from "./transcript.js";
import { readTranscriptTail } from "./transcript-reader.js";
import type { DecisionConfidence, DecisionState, FailureEpisodeSummary, TranscriptSummary } from "./types.js";

const DEFAULT_MAX_BYTES_PER_TRANSCRIPT = 1024 * 1024;
const MAX_FORMATTED_FINDINGS = 20;
const MANY_UNVALIDATED_EDITS_THRESHOLD = 3;
const MANY_UNVALIDATED_FILES_THRESHOLD = 3;

export type DeepAdvisoryReasonCode =
  | "code_change_unvalidated"
  | "many_edits_unvalidated"
  | "many_changed_files_unvalidated"
  | "blind_validation_retry"
  | "write_failed"
  | "write_failed_then_continued"
  | "redundant_read"
  | "validation_recovered_after_change"
  | "compaction_with_open_risk"
  | "session_end_with_open_risk";

export type DeepAdvisorySource =
  | "transcript_summary"
  | "failure_episode"
  | "unsupported_source";

export interface DeepAdvisoryEvidence {
  kind: "count" | "category" | "hash" | "boolean";
  label: string;
  value: number | string | boolean;
}

export interface DeepAdvisoryFinding {
  session: number;
  state: DecisionState;
  confidence: DecisionConfidence;
  reasonCode: DeepAdvisoryReasonCode;
  evidence: string;
  action: string;
  source: DeepAdvisorySource;
  evidenceDetails: DeepAdvisoryEvidence[];
}

export interface DeepAdvisorySessionReport {
  session: number;
  supportedSource: boolean;
  projectKey?: string;
  sessionKeys?: string[];
  findings: DeepAdvisoryFinding[];
  confidence: DecisionConfidence;
  confidenceReason: string;
}

export interface DeepAdvisoryReport {
  kind: "deep-advisory";
  scope: "project" | "all-projects" | "transcript";
  recentLimit: number;
  transcriptsFound: number;
  sessionsScanned: number;
  unreadableTranscripts: number;
  unsupportedTranscripts: number;
  sessionsWithFindings: number;
  findings: DeepAdvisoryFinding[];
  sessions: DeepAdvisorySessionReport[];
  reportConfidence: DecisionConfidence;
  reportConfidenceReason: string;
  privacyValidated: true;
}

export interface FormatDeepAdvisoryOptions {
  color?: boolean;
}

interface AnalyzeSessionOptions {
  session: number;
  projectKey?: string;
}

export async function runDeepAdvisoryAudit(options: AuditOptions = {}): Promise<DeepAdvisoryReport> {
  const candidateResult = await auditTranscriptCandidates(options);
  const projectConfig = await projectConfigForDeepAudit(options);
  const sessions: DeepAdvisorySessionReport[] = [];
  let unreadableTranscripts = 0;
  let unsupportedTranscripts = 0;

  for (const [index, candidate] of candidateResult.candidates.entries()) {
    const tail = await readTranscriptTail(candidate.path, {
      maxBytes: options.maxBytesPerTranscript ?? DEFAULT_MAX_BYTES_PER_TRANSCRIPT
    });
    if (!tail.pathReadable) {
      unreadableTranscripts += 1;
      continue;
    }
    const summary = parseTranscriptLines(tail.lines, tail.bytesRead, { projectConfig, tailTruncated: tail.tailTruncated });
    if (!summary.pathReadable) {
      unreadableTranscripts += 1;
      continue;
    }
    const projectKey = projectKeyForCandidate(candidate.path, options);
    const session = analyzeDeepAdvisorySession(summary, { session: index + 1, projectKey });
    if (!session.supportedSource) {
      unsupportedTranscripts += 1;
    }
    sessions.push(session);
  }

  const findings = sortDeepFindings(sessions.flatMap((session) => session.findings));
  const sessionsWithFindings = new Set(findings.map((finding) => finding.session)).size;
  const confidence = deepReportConfidence(sessions.length, unsupportedTranscripts, findings);
  const report: DeepAdvisoryReport = {
    kind: "deep-advisory",
    scope: candidateResult.scope,
    recentLimit: candidateResult.recentLimit,
    transcriptsFound: candidateResult.candidates.length,
    sessionsScanned: candidateResult.candidates.length - unreadableTranscripts,
    unreadableTranscripts,
    unsupportedTranscripts,
    sessionsWithFindings,
    findings,
    sessions,
    reportConfidence: confidence.confidence,
    reportConfidenceReason: confidence.reason,
    privacyValidated: true
  };
  assertAdvisoryPrivacy(report);
  return report;
}

export function analyzeDeepAdvisorySession(
  summary: TranscriptSummary,
  options: AnalyzeSessionOptions
): DeepAdvisorySessionReport {
  const supportedSource = isSupportedClaudeSummary(summary);
  const findings = supportedSource ? sortDeepFindings(findingsFromSummary(summary, options.session)) : [];
  const confidence = sessionConfidence(summary, supportedSource, findings);
  const report: DeepAdvisorySessionReport = {
    session: options.session,
    supportedSource,
    projectKey: options.projectKey,
    sessionKeys: summary.transcriptSessionKeys,
    findings,
    confidence: confidence.confidence,
    confidenceReason: confidence.reason
  };
  assertAdvisoryPrivacy(report);
  return report;
}

export function formatDeepAdvisoryReport(report: DeepAdvisoryReport, options: FormatDeepAdvisoryOptions = {}): string {
  assertAdvisoryPrivacy(report);
  const lines: string[] = [];
  const scopeLabel =
    report.scope === "project"
      ? `project transcripts, newest ${report.recentLimit}`
      : report.scope === "all-projects"
        ? `all local project transcripts, newest ${report.recentLimit}`
        : "provided transcript";
  lines.push("ccverdict deep advisory audit");
  lines.push(`Scope: ${scopeLabel}`);
  lines.push(`Scanned: ${formatCount(report.sessionsScanned, "Claude Code session")}`);
  if (report.unreadableTranscripts > 0) {
    lines.push(`Skipped: ${formatCount(report.unreadableTranscripts, "unreadable transcript")}`);
  }
  if (report.unsupportedTranscripts > 0) {
    lines.push(`Unsupported: ${formatCount(report.unsupportedTranscripts, "transcript")} did not look like Claude Code JSONL.`);
  }
  lines.push(`Sessions with findings: ${report.sessionsWithFindings}`);
  lines.push(`Report confidence: ${report.reportConfidence} - ${report.reportConfidenceReason}`);
  lines.push("");

  if (report.findings.length === 0) {
    lines.push("Findings: none in the scanned transcript window.");
  } else {
    lines.push("Findings:");
    for (const finding of report.findings.slice(0, MAX_FORMATTED_FINDINGS)) {
      lines.push(
        `${finding.state.padEnd(7)} ${finding.confidence.padEnd(7)} session ${finding.session}: ${finding.evidence}`
      );
      lines.push(`        do: ${finding.action}`);
    }
    if (report.findings.length > MAX_FORMATTED_FINDINGS) {
      lines.push(`        plus ${report.findings.length - MAX_FORMATTED_FINDINGS} more derived findings`);
    }
  }
  lines.push("");
  lines.push(
    "Privacy: derived metadata only; no prompts, assistant text, tool output, command text, file contents, paths, or raw session ids printed/stored."
  );
  const output = lines.join("\n");
  assertAdvisoryPrivacy(output);
  return options.color ? colorizeDeepOutput(output) : output;
}

export function assertAdvisoryPrivacy(value: unknown): void {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (!serialized) {
    return;
  }
  const disallowed = [
    /CCVERDICT_[A-Z0-9_]*SENTINEL/u,
    /\bmcp__[\w-]+__[\w-]+\b/u,
    /\bsk-[A-Za-z0-9_-]{10,}\b/u,
    /(?:^|[\s"'])\/(?:Users|home|tmp|var|private)\/[^\s"']+/u,
    /[A-Za-z]:\\[^\s"']+/u
  ];
  if (disallowed.some((pattern) => pattern.test(serialized))) {
    throw new Error("advisory privacy validation failed");
  }
}

function findingsFromSummary(summary: TranscriptSummary, session: number): DeepAdvisoryFinding[] {
  return [
    ...validationRetryFindings(summary.failureEpisodes || [], session),
    ...editFailureFindings(summary, session),
    ...unvalidatedChangeFindings(summary, session),
    ...redundantReadFindings(summary, session),
    ...recoveryFindings(summary.failureEpisodes || [], session),
    ...lifecycleRiskFindings(summary, session)
  ];
}

function validationRetryFindings(episodes: FailureEpisodeSummary[], session: number): DeepAdvisoryFinding[] {
  return episodes
    .filter((episode) => isValidationCategory(episode.category) && episode.blindRetryFailureCount >= 2)
    .map((episode) => {
      const count = episode.blindRetryFailureCount;
      const state: DecisionState = count >= 3 ? "Stop" : "Careful";
      return finding({
        session,
        state,
        confidence: count >= 3 ? "high" : "medium",
        reasonCode: "blind_validation_retry",
        evidence: `same ${episode.label} failed ${formatFailureCount(count)} without a code change`,
        action: "stop retrying and inspect first failure",
        source: "failure_episode",
        evidenceDetails: [
          countEvidence("blind retry failures", count),
          categoryEvidence(episode.category)
        ]
      });
    });
}

function editFailureFindings(summary: TranscriptSummary, session: number): DeepAdvisoryFinding[] {
  const failedEditResults = summary.failedEditResults || editFailureCount(summary.failureEpisodes || []);
  if (failedEditResults <= 0) {
    return [];
  }
  const details = [countEvidence("failed edit results", failedEditResults)];
  if (summary.workContinuedAfterFailedEdit) {
    return [
      finding({
        session,
        state: "Careful",
        confidence: "high",
        reasonCode: "write_failed_then_continued",
        evidence: `edit or write failed ${formatFailureCount(failedEditResults)}, then later work continued`,
        action: "confirm the edit actually landed",
        source: "transcript_summary",
        evidenceDetails: [...details, booleanEvidence("work continued", true)]
      })
    ];
  }
  return [
    finding({
      session,
      state: "Careful",
      confidence: "medium",
      reasonCode: "write_failed",
      evidence: `edit or write failed ${formatFailureCount(failedEditResults)}`,
      action: "confirm the edit actually landed",
      source: "failure_episode",
      evidenceDetails: details
    })
  ];
}

function unvalidatedChangeFindings(summary: TranscriptSummary, session: number): DeepAdvisoryFinding[] {
  if (!summary.hasUnvalidatedEdits) {
    return [];
  }
  const unvalidatedEdits = summary.unvalidatedEditResultCount || 1;
  const changedFiles = summary.unvalidatedChangedFileIdentityCount || 0;
  const findings: DeepAdvisoryFinding[] = [
    finding({
      session,
      state: "Careful",
      confidence: changedFiles > 0 ? "high" : "medium",
      reasonCode: "code_change_unvalidated",
      evidence: "code changed and no later check ran",
      action: "run the smallest relevant check",
      source: "transcript_summary",
      evidenceDetails: [
        countEvidence("unvalidated edits", unvalidatedEdits),
        countEvidence("validation checks", summary.validationChecks || 0)
      ]
    })
  ];
  if (unvalidatedEdits >= MANY_UNVALIDATED_EDITS_THRESHOLD) {
    findings.push(
      finding({
        session,
        state: "Careful",
        confidence: "high",
        reasonCode: "many_edits_unvalidated",
        evidence: `${unvalidatedEdits} edits happened with no later check`,
        action: "run the smallest relevant check",
        source: "transcript_summary",
        evidenceDetails: [countEvidence("unvalidated edits", unvalidatedEdits)]
      })
    );
  }
  if (changedFiles >= MANY_UNVALIDATED_FILES_THRESHOLD) {
    findings.push(
      finding({
        session,
        state: "Careful",
        confidence: "high",
        reasonCode: "many_changed_files_unvalidated",
        evidence: `${changedFiles} changed file identities had no later check`,
        action: "run the smallest relevant check",
        source: "transcript_summary",
        evidenceDetails: [countEvidence("changed file identities", changedFiles)]
      })
    );
  }
  return findings;
}

function redundantReadFindings(summary: TranscriptSummary, session: number): DeepAdvisoryFinding[] {
  const redundantRead = summary.redundantRead;
  if (!redundantRead || redundantRead.unchangedFullFileReadCount < 2) {
    return [];
  }
  return [
    finding({
      session,
      state: redundantRead.latestState,
      confidence: redundantRead.unchangedFullFileReadCount >= 3 ? "high" : "medium",
      reasonCode: "redundant_read",
      evidence: `same file identity was read ${formatFailureCount(redundantRead.unchangedFullFileReadCount)} without a change`,
      action: "ask the agent to use existing context",
      source: "transcript_summary",
      evidenceDetails: [
        countEvidence("unchanged full-file reads", redundantRead.unchangedFullFileReadCount),
        hashEvidence("file identity", redundantRead.fileIdentityHash)
      ]
    })
  ];
}

function recoveryFindings(episodes: FailureEpisodeSummary[], session: number): DeepAdvisoryFinding[] {
  return episodes
    .filter(
      (episode) =>
        isValidationCategory(episode.category) &&
        episode.recovered &&
        episode.meaningfulIntervention?.includes("edit")
    )
    .map((episode) =>
      finding({
        session,
        state: "Healthy",
        confidence: episode.attemptCount >= 2 ? "high" : "medium",
        reasonCode: "validation_recovered_after_change",
        evidence: `${episode.label} failure recovered after a code change`,
        action: "continue; failure recovered after change",
        source: "failure_episode",
        evidenceDetails: [
          countEvidence("failures before recovery", episode.attemptCount),
          categoryEvidence(episode.category)
        ]
      })
    );
}

function lifecycleRiskFindings(summary: TranscriptSummary, session: number): DeepAdvisoryFinding[] {
  const openRisk = openRiskEvidence(summary);
  if (openRisk.length === 0) {
    return [];
  }
  const findings: DeepAdvisoryFinding[] = [];
  if (summary.compactionEvents > 0) {
    findings.push(
      finding({
        session,
        state: "Careful",
        confidence: "medium",
        reasonCode: "compaction_with_open_risk",
        evidence: "compaction happened while risk was still open",
        action: "ask for a handoff before continuing",
        source: "transcript_summary",
        evidenceDetails: [countEvidence("compaction events", summary.compactionEvents), ...openRisk]
      })
    );
  }
  if ((summary.terminalEvents || 0) > 0) {
    findings.push(
      finding({
        session,
        state: "Careful",
        confidence: "medium",
        reasonCode: "session_end_with_open_risk",
        evidence: "session stopped or ended while risk was still open",
        action: "ask for a handoff before continuing",
        source: "transcript_summary",
        evidenceDetails: [countEvidence("terminal events", summary.terminalEvents || 0), ...openRisk]
      })
    );
  }
  return findings;
}

function openRiskEvidence(summary: TranscriptSummary): DeepAdvisoryEvidence[] {
  const evidence: DeepAdvisoryEvidence[] = [];
  if (summary.hasUnvalidatedEdits) {
    evidence.push(countEvidence("unvalidated edits", summary.unvalidatedEditResultCount || 1));
  }
  if ((summary.blindRetry?.blindRetryFailureCount || 0) >= 2) {
    evidence.push(countEvidence("blind retry failures", summary.blindRetry?.blindRetryFailureCount || 0));
  }
  if ((summary.failedEditResults || 0) > 0) {
    evidence.push(countEvidence("failed edit results", summary.failedEditResults || 0));
  }
  if ((summary.redundantRead?.unchangedFullFileReadCount || 0) >= 3) {
    evidence.push(countEvidence("unchanged full-file reads", summary.redundantRead?.unchangedFullFileReadCount || 0));
  }
  return evidence;
}

function editFailureCount(episodes: FailureEpisodeSummary[]): number {
  return episodes
    .filter((episode) => episode.category === "edit")
    .reduce((total, episode) => total + episode.attemptCount, 0);
}

function isSupportedClaudeSummary(summary: TranscriptSummary): boolean {
  if (!summary.pathReadable || summary.parseableLines === 0) {
    return false;
  }
  return Boolean(
    summary.toolCalls > 0 ||
      summary.failedToolResults > 0 ||
      summary.transcriptHasSessionIds ||
      (summary.compactionEvents || 0) > 0 ||
      (summary.terminalEvents || 0) > 0 ||
      summary.latestUsage
  );
}

function finding(input: DeepAdvisoryFinding): DeepAdvisoryFinding {
  return input;
}

function sortDeepFindings(findings: DeepAdvisoryFinding[]): DeepAdvisoryFinding[] {
  return [...findings].sort((left, right) => deepFindingScore(right) - deepFindingScore(left) || left.session - right.session);
}

function deepFindingScore(finding: DeepAdvisoryFinding): number {
  const stateScore = finding.state === "Stop" ? 100 : finding.state === "Careful" ? 50 : 10;
  const confidenceScore = finding.confidence === "high" ? 10 : finding.confidence === "medium" ? 5 : 0;
  const reasonScore: Partial<Record<DeepAdvisoryReasonCode, number>> = {
    blind_validation_retry: 9,
    write_failed_then_continued: 8,
    many_changed_files_unvalidated: 7,
    many_edits_unvalidated: 6,
    code_change_unvalidated: 5,
    session_end_with_open_risk: 4,
    compaction_with_open_risk: 3,
    write_failed: 3,
    redundant_read: 2,
    validation_recovered_after_change: 1
  };
  return stateScore + confidenceScore + (reasonScore[finding.reasonCode] || 0);
}

function sessionConfidence(
  summary: TranscriptSummary,
  supportedSource: boolean,
  findings: DeepAdvisoryFinding[]
): { confidence: DecisionConfidence; reason: string } {
  if (!supportedSource) {
    return { confidence: "low", reason: "transcript shape was not recognized as Claude Code JSONL" };
  }
  if (summary.tailTruncated) {
    return { confidence: "low", reason: "transcript tail was truncated before deep audit" };
  }
  if (findings.some((finding) => finding.state === "Stop" && finding.confidence === "high")) {
    return { confidence: "high", reason: "high-signal risk paths were found" };
  }
  if (findings.length > 0) {
    return { confidence: "medium", reason: "safe derived facts found advisory paths" };
  }
  return { confidence: "low", reason: "no advisory paths were found in this session" };
}

function deepReportConfidence(
  sessionsScanned: number,
  unsupportedTranscripts: number,
  findings: DeepAdvisoryFinding[]
): { confidence: DecisionConfidence; reason: string } {
  if (sessionsScanned === 0) {
    return { confidence: "low", reason: "no local Claude Code transcripts were found for this scope" };
  }
  if (unsupportedTranscripts >= sessionsScanned) {
    return { confidence: "low", reason: "scanned transcripts did not look like Claude Code JSONL" };
  }
  if (findings.some((finding) => finding.state === "Stop" && finding.confidence === "high")) {
    return { confidence: "high", reason: "high-signal risk paths were found in scanned transcripts" };
  }
  if (findings.length > 0) {
    return { confidence: "medium", reason: "advisory paths were found from safe derived metadata" };
  }
  return sessionsScanned >= 10
    ? { confidence: "medium", reason: "enough sessions were scanned, but no advisory paths surfaced" }
    : { confidence: "low", reason: "small scanned sample and no advisory paths surfaced" };
}

function projectKeyForCandidate(path: string, options: AuditOptions): string | undefined {
  if (!options.transcriptPath && !options.allProjects) {
    return projectKeyFromPath(options.projectDir || process.cwd());
  }
  if (options.allProjects) {
    return hashValue(dirname(path));
  }
  return undefined;
}

async function projectConfigForDeepAudit(options: AuditOptions): Promise<ProjectConfig | undefined> {
  if (options.allProjects) {
    return undefined;
  }
  if (options.projectDir) {
    return loadProjectConfig(options.projectDir);
  }
  if (!options.transcriptPath) {
    return loadProjectConfig(process.cwd());
  }
  return undefined;
}

function isValidationCategory(value: FailureEpisodeSummary["category"]): boolean {
  return value === "tests" || value === "lint" || value === "typecheck" || value === "build";
}

function countEvidence(label: string, value: number): DeepAdvisoryEvidence {
  return { kind: "count", label, value };
}

function categoryEvidence(value: string): DeepAdvisoryEvidence {
  return { kind: "category", label: "safe category", value };
}

function hashEvidence(label: string, value: string): DeepAdvisoryEvidence {
  return { kind: "hash", label, value };
}

function booleanEvidence(label: string, value: boolean): DeepAdvisoryEvidence {
  return { kind: "boolean", label, value };
}

function formatFailureCount(count: number): string {
  return count === 2 ? "twice" : `${count}x`;
}

function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function colorizeDeepOutput(value: string): string {
  return value
    .replace(/^ccverdict deep advisory audit/u, "\u001b[1mccverdict deep advisory audit\u001b[0m")
    .replace(/\bStop\b/gu, "\u001b[1;31mStop\u001b[0m")
    .replace(/\bCareful\b/gu, "\u001b[33mCareful\u001b[0m")
    .replace(/\bHealthy\b/gu, "\u001b[32mHealthy\u001b[0m");
}
