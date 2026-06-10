import { classifyActivity } from "./activity.js";
import { emptyLedger } from "./edit-ledger.js";
import { runDetectors, resolveLight } from "./findings.js";
import { classifyLifecycleEvidence } from "./lifecycle-evidence.js";
import { budgetThresholdsFromEnv, normalizeBudgetThresholds, type BudgetThresholds } from "./signals.js";
import type { DecisionPersonalBaseline, Finding, Gauge, GaugeLight, StatusLineInput, TranscriptSummary } from "./types.js";

export interface BuildGaugeOptions {
  baseline?: DecisionPersonalBaseline;
  previous?: { costUsd?: number };
  budgetThresholds?: BudgetThresholds;
  sessionKey?: string;
  projectKey?: string;
}

const CONTEXT_HIGH_THRESHOLD = 80;
const CONTEXT_CRITICAL_THRESHOLD = 92;

export function buildGauge(input: StatusLineInput, transcript: TranscriptSummary, options: BuildGaugeOptions = {}): Gauge {
  const createdAt = new Date().toISOString();
  const facts = factsFrom(input);
  const base = {
    files: { edited: 0, unchecked: 0 },
    facts,
    sessionKey: options.sessionKey,
    projectKey: options.projectKey,
    createdAt
  };

  const grayEvidence = grayReason(input, transcript);
  if (grayEvidence) {
    return {
      ...base,
      light: "gray" as GaugeLight,
      activity: "idle",
      findings: [{ category: grayEvidence.category, severity: "info", confidence: "high", evidence: grayEvidence.evidence }]
    };
  }

  const thresholds = normalizeBudgetThresholds(options.budgetThresholds ?? budgetThresholdsFromEnv());
  const costDelta =
    input.costUsd !== undefined && options.previous?.costUsd !== undefined ? input.costUsd - options.previous.costUsd : 0;
  const findings = runDetectors(input, transcript, { baseline: options.baseline, budgetThresholds: thresholds, costDelta });
  const light = resolveLight(findings);
  const activity = classifyActivity(transcript);
  const ledger = transcript.ledger ?? emptyLedger();

  return {
    ...base,
    light,
    activity: activity.verb,
    activityTarget: activity.target,
    files: {
      edited: transcript.changedFileIdentityCount ?? ledger.edited,
      unchecked: transcript.unvalidatedChangedFileIdentityCount ?? ledger.unchecked,
      latestUncheckedBasename: ledger.latestUncheckedBasename
    },
    findings
  };
}

function factsFrom(input: StatusLineInput): Gauge["facts"] {
  const contextPercent = input.contextPercent;
  return {
    contextPercent,
    contextHighlighted:
      contextPercent !== undefined && contextPercent >= CONTEXT_HIGH_THRESHOLD && contextPercent < CONTEXT_CRITICAL_THRESHOLD,
    costUsd: input.costUsd,
    costSource: input.costSource,
    durationMs: input.durationMs,
    rateLimitPercent: input.rateLimitPercent
  };
}

function grayReason(
  input: StatusLineInput,
  transcript: TranscriptSummary
): { category: string; evidence: string } | undefined {
  if (!input.rawValid) {
    return { category: "statusline_input_unavailable", evidence: "statusline input unreadable" };
  }
  const lifecycle = classifyLifecycleEvidence(input, transcript);
  if (lifecycle.sessionIdentity.mismatch) {
    return { category: "transcript_session_mismatch", evidence: "transcript session mismatch" };
  }
  if (lifecycle.status === "missing_transcript") {
    return { category: "transcript_unavailable", evidence: "transcript unavailable" };
  }
  if (lifecycle.status === "malformed_transcript") {
    return { category: "transcript_unreadable", evidence: "transcript unreadable" };
  }
  return undefined;
}

export function topFinding(gauge: Gauge): Finding | undefined {
  return gauge.findings[0];
}
