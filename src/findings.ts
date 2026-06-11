import { strongestRepeatedFailure } from "./activity.js";
import {
  cacheEfficiencyEvidence,
  cacheEfficiencyRegression,
  formatCost,
  hasUnusualEditValidationLag,
  suppressCacheEfficiencyRegressionAfterCompaction,
  type NormalizedBudgetThresholds
} from "./signals.js";
import type { DecisionPersonalBaseline, Finding, StatusLineInput, ToolFailureSummary, TranscriptSummary } from "./types.js";

// Findings engine (PRD-01, branch F). Each detector is a pure function emitting an optional
// Finding {category, severity, confidence, evidence, fileHint?}. The resolver short-circuits to
// gray (handled by the gauge before this runs), otherwise takes max severity while retaining all
// findings. Only behavioral triggers change the dot; cost/duration/rate-limit are facts, never
// findings. Trigger sets are exactly branches B3 (red) and B4 (blue).

export interface FindingsOptions {
  baseline?: DecisionPersonalBaseline;
  budgetThresholds?: NormalizedBudgetThresholds;
  costDelta?: number;
}

export const EDIT_DRIFT_CATEGORY = "edit_drift";
const EDIT_DRIFT_TOOL_STEP_THRESHOLD = 3;

export function runDetectors(input: StatusLineInput, transcript: TranscriptSummary, options: FindingsOptions = {}): Finding[] {
  const findings: Finding[] = [];
  const strongest = strongestRepeatedFailure(transcript);
  const strongestCount = strongest?.count ?? 0;
  const blindCount = transcript.blindRetry?.blindRetryFailureCount ?? 0;

  // --- Red detectors (branch B3) ---
  if (input.contextPercent !== undefined && input.contextPercent >= 92) {
    findings.push(red("context_critical", `ctx ${input.contextPercent}%, nearly full`));
  }

  let redFailureClaimed = false;
  if (blindCount >= 3 && transcript.blindRetry) {
    findings.push(red("blind_retry_loop", `${blindCount} fails, no fix between runs`));
    redFailureClaimed = true;
  } else if (strongestCount >= 3 && strongest) {
    findings.push(red("repeated_tool_failure", repeatedFailureEvidence(strongest)));
    redFailureClaimed = true;
  }

  if ((transcript.editTestLoopFailures || 0) >= 2) {
    findings.push(red("edit_test_retry_loop", `edit-test loop failed ${transcript.editTestLoopFailures}x`));
  }

  if ((transcript.redundantRead?.unchangedFullFileReadCount || 0) >= 3) {
    findings.push({
      ...red("redundant_read_loop", `same file reread ${transcript.redundantRead?.unchangedFullFileReadCount}x`),
      fileHint: transcript.redundantRead?.basename
    });
  }

  const budgetFailure = budgetWithRepeatedFailure(input, transcript, options);
  if (budgetFailure) {
    findings.push(red("budget_with_repeated_failure", budgetFailure));
  }

  // --- Blue detectors (branch B4) ---
  if (!redFailureClaimed) {
    if (blindCount === 2 && transcript.blindRetry) {
      findings.push(blue("blind_retry", `2 fails, no fix between runs`));
    } else if (strongestCount === 2 && strongest) {
      findings.push(blue("tool_failure_repeated", repeatedFailureEvidence(strongest)));
    }
  }

  if ((transcript.redundantRead?.unchangedFullFileReadCount || 0) === 2) {
    findings.push({ ...blue("redundant_read", "same file reread twice"), fileHint: transcript.redundantRead?.basename });
  }

  const regression = cacheEfficiencyRegression(input.usage, transcript);
  if (regression && !suppressCacheEfficiencyRegressionAfterCompaction(transcript)) {
    findings.push(blue("cache_efficiency_regression", cacheEfficiencyEvidence(regression)));
  }

  if (transcript.compactionEvents > 0 && transcript.postCompactionActivity === 0) {
    findings.push(blue("compaction_goal_preservation", "compaction boundary open"));
  }

  const editDrift = editDriftFinding(transcript, options.baseline);
  if (editDrift) {
    findings.push(editDrift);
  }

  return orderBySeverity(findings);
}

export function resolveLight(findings: readonly Finding[]): "green" | "blue" | "red" {
  if (findings.some((finding) => finding.severity === "red")) {
    return "red";
  }
  if (findings.some((finding) => finding.severity === "blue")) {
    return "blue";
  }
  return "green";
}

function editDriftFinding(transcript: TranscriptSummary, baseline: DecisionPersonalBaseline | undefined): Finding | undefined {
  if (!transcript.hasUnvalidatedEdits) {
    return undefined;
  }
  const steps = transcript.unvalidatedEditToolSteps ?? 0;
  const unusualLag = hasUnusualEditValidationLag(transcript, baseline);
  if (steps < EDIT_DRIFT_TOOL_STEP_THRESHOLD && !unusualLag) {
    // Fresh unchecked edits are normal (green). Only drift turns the dot blue.
    return undefined;
  }
  return {
    category: EDIT_DRIFT_CATEGORY,
    severity: "blue",
    confidence: "medium",
    evidence: "edits unchecked since last check",
    fileHint: transcript.ledger?.latestUncheckedBasename,
    note: unusualLag ? "past sessions usually checked edits sooner" : undefined
  };
}

function budgetWithRepeatedFailure(
  input: StatusLineInput,
  transcript: TranscriptSummary,
  options: FindingsOptions
): string | undefined {
  const thresholds = options.budgetThresholds;
  if (!thresholds) {
    return undefined;
  }
  const repeated = transcript.repeatedFailures.filter((item) => item.count >= 2).sort((a, b) => b.count - a.count)[0];
  if (!repeated) {
    return undefined;
  }
  const costDelta = options.costDelta ?? 0;
  const overTotal = input.costUsd !== undefined && input.costUsd >= thresholds.costUsd;
  const overDelta = costDelta >= thresholds.costDeltaUsd;
  if (!overTotal && !overDelta) {
    return undefined;
  }
  const costEvidence = overDelta ? `cost +${formatCost(costDelta)}` : `cost ${formatCost(input.costUsd || 0)}`;
  return `${costEvidence}, repeated failures`;
}

function repeatedFailureEvidence(failure: ToolFailureSummary): string {
  const countWord = failure.count === 2 ? "twice" : `${failure.count}x`;
  if (failure.toolName === "Bash" && isValidationPurpose(failure.purpose)) {
    return `${failure.purpose === "tests" ? "tests" : failure.purpose} failed ${countWord}`;
  }
  if (failure.category === "MCP" || failure.toolName === "MCP tool") {
    return `MCP tool failed ${countWord}`;
  }
  return `${failure.toolName} failed ${countWord}`;
}

function isValidationPurpose(purpose: string | undefined): boolean {
  return purpose === "tests" || purpose === "lint" || purpose === "typecheck" || purpose === "build";
}

function red(category: string, evidence: string): Finding {
  return { category, severity: "red", confidence: "high", evidence };
}

function blue(category: string, evidence: string): Finding {
  return { category, severity: "blue", confidence: "medium", evidence };
}

function orderBySeverity(findings: Finding[]): Finding[] {
  const rank = { red: 0, blue: 1, info: 2 } as const;
  return [...findings].sort((a, b) => rank[a.severity] - rank[b.severity]);
}
