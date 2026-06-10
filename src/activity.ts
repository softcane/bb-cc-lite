import type { ActivityVerb, TranscriptSummary } from "./types.js";

// Activity classifier (PRD-01, branch E). Pure function over the bounded recent event window.
// Priority: retrying > testing > editing > exploring > idle.

export interface ActivityResult {
  verb: ActivityVerb;
  target?: string;
}

export function classifyActivity(transcript: TranscriptSummary): ActivityResult {
  const failingLabel = openFailureLabel(transcript);
  if (failingLabel !== undefined) {
    return { verb: "retrying", target: failingLabel || undefined };
  }
  if (transcript.latestActivityKind === "validate") {
    return { verb: "testing" };
  }
  if (
    transcript.hasUnvalidatedEdits ||
    transcript.latestActivityKind === "edit" ||
    (transcript.changedFileIdentityCount || 0) > 0 ||
    (transcript.successfulEditResults || 0) > 0
  ) {
    return { verb: "editing" };
  }
  if (isReadDominant(transcript) || transcript.toolCalls > 0) {
    // Read/search dominant, or any other non-edit/non-validate tool activity (exec, MCP).
    return { verb: "exploring" };
  }
  return { verb: "idle" };
}

function openFailureLabel(transcript: TranscriptSummary): string | undefined {
  if (transcript.blindRetry && transcript.blindRetry.blindRetryFailureCount >= 2) {
    return failureCategoryLabel(transcript.blindRetry.category, transcript.blindRetry.label);
  }
  const repeated = strongestRepeatedFailure(transcript);
  if (repeated) {
    return repeatedFailureLabel(repeated);
  }
  if ((transcript.editTestLoopFailures || 0) >= 1) {
    return "tests";
  }
  return undefined;
}

export function strongestRepeatedFailure(transcript: TranscriptSummary): TranscriptSummary["repeatedFailures"][number] | undefined {
  return transcript.repeatedFailures
    .filter((item) => item.count >= 2)
    .sort((a, b) => b.count - a.count)[0];
}

function repeatedFailureLabel(failure: TranscriptSummary["repeatedFailures"][number]): string {
  if (failure.toolName === "Bash" && isValidationPurpose(failure.purpose)) {
    return failure.purpose === "tests" ? "tests" : (failure.purpose as string);
  }
  return "";
}

function failureCategoryLabel(category: string | undefined, fallback: string): string {
  if (category === "tests") {
    return "tests";
  }
  if (category === "lint" || category === "typecheck" || category === "build") {
    return category;
  }
  return fallback === "test" ? "tests" : "";
}

function isValidationPurpose(purpose: string | undefined): boolean {
  return purpose === "tests" || purpose === "lint" || purpose === "typecheck" || purpose === "build";
}

function isReadDominant(transcript: TranscriptSummary): boolean {
  if (transcript.latestActivityKind === "read") {
    return true;
  }
  return (
    transcript.toolCalls >= 2 &&
    transcript.readToolCalls >= 1 &&
    transcript.readToolCalls / Math.max(1, transcript.toolCalls) >= 0.6
  );
}
