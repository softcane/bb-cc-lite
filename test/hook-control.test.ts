import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handleHook } from "../src/hook-control.js";
import { parseHookPayload } from "../src/hook-payload.js";
import { recentFeedbackOutcomes, recordHookEvent } from "../src/store.js";

const privacySentinels = [
  "BB_CC_LITE_RAW_PROMPT_SENTINEL",
  "BB_CC_LITE_RAW_COMMAND_SENTINEL",
  "BB_CC_LITE_TOOL_OUTPUT_SENTINEL",
  "BB_CC_LITE_FILE_CONTENT_SENTINEL",
  "BB_CC_LITE_RAW_SESSION_SENTINEL",
  "mcp__privateServer__rawPrivacyTool",
  "/tmp/bb-cc-lite/private/workspace/src/secret.ts"
];

describe("hook control", () => {
  it("returns additionalContext for repeated PostToolUseFailure feedback", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-hook-control-"));
    try {
      const storePath = join(tempDir, "events.json");

      const first = await handleHook(failedTestHook("session-alpha"), {
        fallbackEventName: "PostToolUseFailure",
        mode: "coach",
        learn: false,
        storePath
      });
      const second = await handleHook(failedTestHook("session-alpha"), {
        fallbackEventName: "PostToolUseFailure",
        mode: "coach",
        learn: false,
        storePath
      });

      expect(first).toBeUndefined();
      expect(second).toMatchObject({
        hookSpecificOutput: {
          hookEventName: "PostToolUseFailure",
          additionalContext: expect.stringContaining("validation has failed repeatedly")
        }
      });
      expectNoPrivacySentinels(second, await readFile(storePath, "utf8"));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("creates a pending feedback outcome when coach feedback is emitted", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-hook-control-outcome-pending-"));
    try {
      const storePath = join(tempDir, "events.json");

      await handleHook(successfulEditHook("session-alpha"), {
        fallbackEventName: "PostToolUse",
        mode: "coach",
        learn: false,
        storePath
      });

      const outcomes = await recentFeedbackOutcomes(undefined, storePath);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({
        kind: "feedback_outcome",
        feedbackAction: "coach",
        reasonCode: "edit_without_validation",
        safeCategory: "edit",
        expectedAction: "run_validation",
        outcome: "pending"
      });
      expectNoPrivacySentinels(await readFile(storePath, "utf8"));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("marks edit_without_validation feedback resolved after a recognized validation success", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-hook-control-outcome-resolved-"));
    try {
      const storePath = join(tempDir, "events.json");

      await handleHook(successfulEditHook("session-alpha"), {
        fallbackEventName: "PostToolUse",
        mode: "coach",
        learn: false,
        storePath
      });
      await handleHook(successfulValidationHook("session-alpha"), {
        fallbackEventName: "PostToolUse",
        mode: "coach",
        learn: false,
        storePath
      });

      const outcomes = await recentFeedbackOutcomes(undefined, storePath);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({
        reasonCode: "edit_without_validation",
        safeCategory: "tests",
        outcome: "resolved",
        stateAfter: "Healthy"
      });
      expectNoPrivacySentinels(await readFile(storePath, "utf8"));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("marks repeated validation feedback ignored when Claude retries without intervention", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-hook-control-outcome-ignored-"));
    try {
      const storePath = join(tempDir, "events.json");

      await handleHook(failedTestHook("session-alpha"), { fallbackEventName: "PostToolUseFailure", mode: "coach", learn: false, storePath });
      await handleHook(failedTestHook("session-alpha"), { fallbackEventName: "PostToolUseFailure", mode: "coach", learn: false, storePath });
      await handleHook(failedTestHook("session-alpha"), { fallbackEventName: "PostToolUseFailure", mode: "coach", learn: false, storePath });

      const validationOutcome = (await recentFeedbackOutcomes(undefined, storePath)).find(
        (outcome) => outcome.reasonCode === "validation_repeated"
      );
      expect(validationOutcome).toMatchObject({
        safeCategory: "tests",
        expectedAction: "intervene_before_retry",
        outcome: "ignored"
      });
      expectNoPrivacySentinels(await readFile(storePath, "utf8"));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("dedupes PostToolBatch feedback after a coach note was already emitted", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-hook-control-batch-"));
    try {
      const storePath = join(tempDir, "events.json");
      await handleHook(failedTestHook("session-alpha"), { fallbackEventName: "PostToolUseFailure", mode: "coach", learn: false, storePath });
      const emitted = await handleHook(failedTestHook("session-alpha"), {
        fallbackEventName: "PostToolUseFailure",
        mode: "coach",
        learn: false,
        storePath
      });
      const batch = await handleHook(
        JSON.stringify({
          session_id: `session-alpha-${privacySentinels[4]}`,
          hook_event_name: "PostToolBatch",
          tools: [{ tool_name: "Bash" }, { tool_name: "Read" }],
          prompt: privacySentinels[0]
        }),
        { fallbackEventName: "PostToolBatch", mode: "coach", learn: false, storePath }
      );

      expect(emitted).toBeDefined();
      expect(batch).toBeUndefined();
      expectNoPrivacySentinels(await readFile(storePath, "utf8"));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns a stronger coach note before the next validation retry after prior feedback", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-hook-control-pretool-coach-"));
    try {
      const storePath = join(tempDir, "events.json");
      await handleHook(failedTestHook("session-alpha"), { fallbackEventName: "PostToolUseFailure", mode: "coach", learn: false, storePath });
      await handleHook(failedTestHook("session-alpha"), { fallbackEventName: "PostToolUseFailure", mode: "coach", learn: false, storePath });

      const retry = await handleHook(preToolUseHook("session-alpha", "Bash", { command: "npm test" }), {
        fallbackEventName: "PreToolUse",
        mode: "coach",
        learn: false,
        storePath
      });

      expect(retry).toMatchObject({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: expect.stringContaining("do not run the same validation check again yet")
        }
      });
      expectNoPrivacySentinels(retry, await readFile(storePath, "utf8"));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("denies PreToolUse only in guard mode for repeated validation retries", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-hook-control-guard-"));
    try {
      const storePath = join(tempDir, "events.json");
      await seedFailedTests(storePath, "session-alpha", 3);

      const coach = await handleHook(preToolUseHook("session-alpha", "Bash", { command: "npm test" }), {
        fallbackEventName: "PreToolUse",
        mode: "coach",
        learn: false,
        storePath
      });
      const guard = await handleHook(preToolUseHook("session-alpha", "Bash", { command: "npm test" }), {
        fallbackEventName: "PreToolUse",
        mode: "guard",
        learn: false,
        storePath
      });
      const repeatedGuard = await handleHook(preToolUseHook("session-alpha", "Bash", { command: "npm test" }), {
        fallbackEventName: "PreToolUse",
        mode: "guard",
        learn: false,
        storePath
      });
      const read = await handleHook(preToolUseHook("session-alpha", "Read", { file_path: "/tmp/private-file.ts" }), {
        fallbackEventName: "PreToolUse",
        mode: "guard",
        learn: false,
        storePath
      });

      expect(JSON.stringify(coach)).not.toContain('"permissionDecision":"deny"');
      expect(guard).toMatchObject({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: expect.stringContaining("denied this retry")
        }
      });
      expect(repeatedGuard).toMatchObject({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny"
        }
      });
      expect(read).toBeUndefined();
      expectNoPrivacySentinels(coach, guard, read, await readFile(storePath, "utf8"));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("blocks Stop once and avoids active stop-hook loops", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-hook-control-stop-"));
    try {
      const storePath = join(tempDir, "events.json");
      await seedFailedTests(storePath, "session-alpha", 3);

      const first = await handleHook(
        JSON.stringify({
          session_id: `session-alpha-${privacySentinels[4]}`,
          hook_event_name: "Stop",
          stop_hook_active: false,
          last_assistant_message: privacySentinels[0]
        }),
        { fallbackEventName: "Stop", mode: "coach", learn: false, storePath }
      );
      const second = await handleHook(
        JSON.stringify({
          session_id: `session-alpha-${privacySentinels[4]}`,
          hook_event_name: "Stop",
          stop_hook_active: false
        }),
        { fallbackEventName: "Stop", mode: "coach", learn: false, storePath }
      );
      const active = await handleHook(
        JSON.stringify({
          session_id: "session-alpha",
          hook_event_name: "Stop",
          stop_hook_active: true
        }),
        { fallbackEventName: "Stop", mode: "coach", learn: false, storePath }
      );

      expect(first).toMatchObject({
        decision: "block",
        reason: expect.stringContaining("unresolved validation risk remains")
      });
      expect(second).toBeUndefined();
      expect(active).toBeUndefined();
      expectNoPrivacySentinels(first, second, active, await readFile(storePath, "utf8"));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function seedFailedTests(storePath: string, sessionId: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const event = parseHookPayload(failedTestHook(sessionId), "PostToolUseFailure");
    if (!event) {
      throw new Error("expected hook event");
    }
    await recordHookEvent(event, storePath);
  }
}

function failedTestHook(sessionId: string): string {
  return JSON.stringify({
    session_id: `${sessionId}-${privacySentinels[4]}`,
    hook_event_name: "PostToolUseFailure",
    tool_name: "Bash",
    tool_input: {
      command: `npm test -- ${privacySentinels[1]} ${privacySentinels[6]}`
    },
    tool_response: {
      stderr: privacySentinels[2],
      content: privacySentinels[3]
    },
    prompt: privacySentinels[0],
    cwd: privacySentinels[6],
    transcript_path: join(privacySentinels[6], "transcript.jsonl"),
    mcp_server_name: privacySentinels[5]
  });
}

function successfulEditHook(sessionId: string): string {
  return JSON.stringify({
    session_id: `${sessionId}-${privacySentinels[4]}`,
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: {
      file_path: privacySentinels[6],
      old_string: "before",
      new_string: privacySentinels[3]
    },
    tool_response: {
      content: privacySentinels[3]
    },
    prompt: privacySentinels[0],
    cwd: privacySentinels[6],
    transcript_path: join(privacySentinels[6], "transcript.jsonl")
  });
}

function successfulValidationHook(sessionId: string): string {
  return JSON.stringify({
    session_id: `${sessionId}-${privacySentinels[4]}`,
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: {
      command: `npm test -- ${privacySentinels[1]}`
    },
    tool_response: {
      stdout: privacySentinels[2]
    },
    prompt: privacySentinels[0],
    cwd: privacySentinels[6],
    transcript_path: join(privacySentinels[6], "transcript.jsonl")
  });
}

function preToolUseHook(sessionId: string, toolName: string, toolInput: unknown): string {
  return JSON.stringify({
    session_id: `${sessionId}-${privacySentinels[4]}`,
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    prompt: privacySentinels[0],
    cwd: privacySentinels[6],
    transcript_path: join(privacySentinels[6], "transcript.jsonl"),
    mcp_server_name: privacySentinels[5]
  });
}

function expectNoPrivacySentinels(...values: unknown[]): void {
  const serialized = values.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join("\n");
  for (const sentinel of privacySentinels) {
    expect(serialized).not.toContain(sentinel);
  }
}
