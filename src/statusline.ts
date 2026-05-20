import { mergeHookSummary } from "./hook-summary.js";
import { readBaseline } from "./baseline.js";
import { maybeTriggerBaselineRefresh, type MaybeTriggerBaselineRefreshOptions } from "./baseline-refresh.js";
import { toDecisionPresentation } from "./decision-presentation.js";
import { estimateCostUsd, loadPricing } from "./pricing.js";
import { renderStatusLine } from "./renderer.js";
import { sessionKeyFromId } from "./session.js";
import { decide } from "./signals.js";
import { mergeUsage, parseStatusLineInput } from "./status-input.js";
import { hookSummary, latestDecision, recordDecision } from "./store.js";
import { parseTranscriptTail } from "./transcript.js";

const EMPTY_HOOK_SUMMARY = {
  failedToolResults: 0,
  toolCalls: 0,
  compactionEvents: 0,
  postCompactionActivity: 0,
  repeatedFailures: [],
  blindRetry: undefined
};

export interface CreateStatusLineOptions {
  baselineRefresh?: Omit<MaybeTriggerBaselineRefreshOptions, "baseline">;
}

export async function createStatusLine(
  rawInput: string,
  terminalColumns?: number,
  options: CreateStatusLineOptions = {}
): Promise<string> {
  const input = parseStatusLineInput(rawInput);
  const sessionKey = sessionKeyFromId(input.sessionId);
  const transcript = mergeHookSummary(
    await parseTranscriptTail(input.transcriptPath),
    sessionKey ? await hookSummary(sessionKey) : EMPTY_HOOK_SUMMARY
  );
  const usage = mergeUsage(input.usage, transcript.usage);

  if (input.costUsd === undefined) {
    const estimated = estimateCostUsd(input.model.id || input.model.displayName, usage, await loadPricing());
    if (estimated !== undefined) {
      input.costUsd = estimated;
      input.costSource = "estimated";
    }
  }

  const previous = sessionKey ? await latestDecision(sessionKey) : undefined;
  const baseline = await readBaseline();
  const decision = decide(input, transcript, { previous, baseline });
  await recordDecision(decision);
  await maybeTriggerBaselineRefresh({ ...options.baselineRefresh, baseline });
  return renderStatusLine(toDecisionPresentation(decision), input.terminalWidth || terminalColumns);
}
