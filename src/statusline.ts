import { mergeHookSummary } from "./hook-summary.js";
import { readBaselineForProject } from "./baseline.js";
import { maybeTriggerBaselineRefresh, type MaybeTriggerBaselineRefreshOptions } from "./baseline-refresh.js";
import { buildGauge } from "./gauge.js";
import { renderGauge } from "./gauge-renderer.js";
import { estimateCostUsd, loadPricing } from "./pricing.js";
import { loadProjectConfig } from "./project-config.js";
import { projectKeyFromPath } from "./paths.js";
import { sessionKeyFromId } from "./session.js";
import { decide } from "./signals.js";
import { mergeUsage, parseStatusLineInput } from "./status-input.js";
import { hookSummary, latestDecision, recordDecision } from "./store.js";
import { parseTranscriptTail } from "./transcript.js";
import type { Decision } from "./types.js";

const EMPTY_HOOK_SUMMARY = {
  failedToolResults: 0,
  toolCalls: 0,
  readToolCalls: 0,
  successfulEditResults: 0,
  validationChecks: 0,
  validationSuccesses: 0,
  validationRecovered: false,
  hasUnvalidatedEdits: false,
  unvalidatedEditToolSteps: undefined,
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
  const projectConfig = await loadProjectConfig(input.cwd);
  const transcript = mergeHookSummary(
    await parseTranscriptTail(input.transcriptPath, { projectConfig }),
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
  const baselineSelection = await readBaselineForProject({ projectDir: input.cwd });
  const baseline = baselineSelection.baseline;
  const projectKey = input.cwd ? projectKeyFromPath(input.cwd) : undefined;
  const decision = decide(input, transcript, { previous, baseline });
  const gauge = buildGauge(input, transcript, {
    baseline,
    previous: previous ? { costUsd: previous.costUsd } : undefined,
    sessionKey,
    projectKey
  });
  const record: Decision = {
    ...decision,
    schemaVersion: 2,
    projectKey,
    light: gauge.light,
    activity: gauge.activity,
    findings: gauge.findings,
    ledger: transcript.ledger?.entries ?? [],
    files: gauge.files
  };
  await recordDecision(record);
  await maybeTriggerBaselineRefresh({ ...options.baselineRefresh, baseline, projectDir: input.cwd, transcriptPath: input.transcriptPath });
  return renderGauge(gauge, input.terminalWidth || terminalColumns);
}
