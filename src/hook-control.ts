import { decideFeedback, type FeedbackMode } from "./feedback-policy.js";
import { responseForFeedback, type HookResponse } from "./hook-response.js";
import { parseHookPayload } from "./hook-payload.js";
import { lessonContextForProject, recordLessonFromSummary } from "./memory-lessons.js";
import { hashValue, projectKeyFromPath } from "./paths.js";
import { asRecord, stringField } from "./status-input.js";
import { classifyToolIdentity } from "./tool-metadata.js";
import { hookSummary, latestDecision, recentFeedbackEvents, recordFeedbackEvent, recordHookEvent } from "./store.js";
import type { TranscriptSummary } from "./types.js";

export interface HandleHookOptions {
  fallbackEventName?: string;
  mode?: FeedbackMode;
  learn?: boolean;
  storePath?: string;
  homeDir?: string;
  appHomePath?: string;
}

const EMPTY_TRANSCRIPT: TranscriptSummary = {
  pathReadable: true,
  bytesRead: 0,
  linesRead: 0,
  malformedLines: 0,
  toolCalls: 0,
  readToolCalls: 0,
  successfulEditResults: 0,
  validationChecks: 0,
  validationSuccesses: 0,
  toolRecoveryEvents: 0,
  failedToolResults: 0,
  repeatedFailures: [],
  editTestLoopFailures: 0,
  hasUnvalidatedEdits: false,
  validationRecovered: false,
  observedProgress: false,
  compactionEvents: 0,
  postCompactionActivity: 0,
  usage: {}
};

export async function handleHook(raw: string, options: HandleHookOptions = {}): Promise<HookResponse | undefined> {
  const root = parseRoot(raw);
  if (!root) {
    return undefined;
  }

  const hookEventName = stringField(root.hook_event_name) || stringField(root.event) || options.fallbackEventName || "unknown";
  const sessionKey = hashValue(stringField(root.session_id) || stringField(root.sessionId));
  const mode = options.mode || "coach";
  const learn = options.learn !== false && process.env.BB_CC_LITE_LESSON_MEMORY !== "0";
  const event = parseHookPayload(raw, hookEventName);

  if (event && hookEventName !== "PreToolUse" && hookEventName !== "SessionStart") {
    await recordHookEvent(event, options.storePath);
  }

  const summary = sessionKey ? await summaryForSession(sessionKey, options.storePath) : EMPTY_TRANSCRIPT;

  if (hookEventName === "SessionEnd") {
    if (learn) {
      const projectKey = projectKeyFromHook(root);
      if (projectKey) {
        await recordLessonFromSummary({
          projectKey,
          summary,
          homeDir: options.homeDir,
          appHomePath: options.appHomePath
        });
      }
    }
    return undefined;
  }

  if (hookEventName === "SessionStart") {
    if (mode === "observe" || !learn) {
      return undefined;
    }
    const projectKey = projectKeyFromHook(root);
    const lessonContext = projectKey
      ? await lessonContextForProject({ projectKey, homeDir: options.homeDir, appHomePath: options.appHomePath })
      : undefined;
    return lessonContext
      ? {
          hookSpecificOutput: {
            hookEventName,
            additionalContext: lessonContext
          }
        }
      : undefined;
  }

  const decision = sessionKey ? await latestDecision(sessionKey, options.storePath) : undefined;
  const recentFeedback = await recentFeedbackEvents(sessionKey, options.storePath);
  const feedback = decideFeedback({
    mode,
    hookEventName,
    decision,
    summary,
    currentTool: currentTool(root),
    recentFeedback,
    stopHookActive: root.stop_hook_active === true || root.stopHookActive === true
  });

  if (feedback.kind !== "none") {
    await recordFeedbackEvent(
      {
        sessionKey,
        hookEventName,
        feedbackAction: feedback.kind,
        cooldownKey: feedback.cooldownKey
      },
      options.storePath
    );
  }

  return responseForFeedback(hookEventName, feedback);
}

async function summaryForSession(sessionKey: string, storePath: string | undefined): Promise<TranscriptSummary> {
  const summary = await hookSummary(sessionKey, storePath);
  return {
    ...EMPTY_TRANSCRIPT,
    ...summary
  };
}

function currentTool(root: Record<string, unknown>): { toolName: string; purpose?: string } | undefined {
  const identity = classifyToolIdentity(stringField(root.tool_name) || stringField(root.toolName), root.tool_input ?? root.toolInput);
  return {
    toolName: identity.displayName,
    purpose: identity.purpose
  };
}

function parseRoot(raw: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(raw.trim() || "{}"));
  } catch {
    return undefined;
  }
}

function projectKeyFromHook(root: Record<string, unknown>): string | undefined {
  const cwd = stringField(root.cwd) || stringField(asRecord(root.workspace)?.current_dir) || stringField(asRecord(root.workspace)?.project_dir);
  return cwd ? projectKeyFromPath(cwd) : undefined;
}
