import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { toDecisionPresentation } from "../src/decision-presentation.js";
import { renderStatusLine } from "../src/renderer.js";
import { decide } from "../src/signals.js";
import { parseStatusLineInput } from "../src/status-input.js";
import { createStatusLine } from "../src/statusline.js";
import { readStore } from "../src/store.js";
import { parseTranscriptTail } from "../src/transcript.js";
import type { DecisionState } from "../src/types.js";
import { formatWhy, formatWhyJson } from "../src/why.js";
import { setIsolatedEnv } from "./helpers/temp.js";

// Fixture envelopes are informed by public Claude Code transcript descriptions
// and examples; fixture contents remain deliberately fake and privacy-sentinel based.
interface ReplayCase {
  fixture: string;
  contextPercent?: number;
  expected: {
    state: DecisionState;
    reasonCode: string;
    primaryEvidence: string;
    action: string;
  };
}

const REPLAY_CASES: ReplayCase[] = [
  {
    fixture: "healthy-validation-recovered.jsonl",
    expected: {
      state: "Healthy",
      reasonCode: "validation_recovered",
      primaryEvidence: "validation recovered",
      action: "continue"
    }
  },
  {
    fixture: "careful-unvalidated-edits.jsonl",
    expected: {
      state: "Careful",
      reasonCode: "edit_without_validation",
      primaryEvidence: "edits have not been checked",
      action: "ask Claude to run the smallest relevant check"
    }
  },
  {
    fixture: "careful-same-test-failed-twice.jsonl",
    expected: {
      state: "Careful",
      reasonCode: "blind_retry",
      primaryEvidence: "same test failed twice without a fix",
      action: "inspect first failure"
    }
  },
  {
    fixture: "stop-same-test-failed-3x.jsonl",
    expected: {
      state: "Stop",
      reasonCode: "blind_retry_loop",
      primaryEvidence: "same test failed 3x without a fix",
      action: "stop and inspect first failure"
    }
  },
  {
    fixture: "stop-blind-retry-loop.jsonl",
    expected: {
      state: "Stop",
      reasonCode: "blind_retry_loop",
      primaryEvidence: "same tool failed 3x without a fix",
      action: "stop and inspect first failure"
    }
  },
  {
    fixture: "careful-context-high.jsonl",
    contextPercent: 80,
    expected: {
      state: "Careful",
      reasonCode: "context_high",
      primaryEvidence: "ctx 80%",
      action: "ask Claude for a 6-bullet handoff before more work"
    }
  },
  {
    fixture: "careful-busy-no-progress.jsonl",
    expected: {
      state: "Careful",
      reasonCode: "busy_no_observed_progress",
      primaryEvidence: "8 tool calls, no check or recovery seen",
      action: "pause and ask Claude what changed"
    }
  }
];

const PRIVACY_SENTINELS = [
  "BB_CC_LITE_RAW_PROMPT_SENTINEL",
  "BB_CC_LITE_TOOL_OUTPUT_SENTINEL",
  "BB_CC_LITE_FILE_CONTENT_SENTINEL",
  "BB_CC_LITE_API_KEY_SENTINEL",
  "BB_CC_LITE_RAW_COMMAND_SENTINEL",
  "BB_CC_LITE_RAW_SESSION_SENTINEL",
  "BB_CC_LITE_RAW_PATH_SENTINEL",
  "BB_CC_LITE_RAW_MCP_SENTINEL",
  "BB_CC_LITE_RAW_TOOL_NAME_SENTINEL",
  "mcp__bbcc_private__rawPrivacyTool",
  "/tmp/bb-cc-lite-fixture/"
];

describe("real-shape sanitized JSONL replay fixtures", () => {
  it.each(REPLAY_CASES)("replays $fixture into the expected raw decision", async (testCase) => {
    const path = fixturePath(testCase.fixture);
    const raw = await readFile(path, "utf8");
    const entries = parseJsonlFixture(raw);
    assertClaudeLikeShape(entries);

    const input = parseStatusLineInput(statusLineInput(path, testCase, fixtureSessionId(entries)));
    const transcript = await parseTranscriptTail(input.transcriptPath, { maxBytes: Buffer.byteLength(raw) });
    const decision = decide(input, transcript);

    expect(decision).toMatchObject(testCase.expected);
    expect(transcript.pathReadable).toBe(true);
    expect(transcript.linesRead).toBe(entries.length);
    expectNoPrivacySentinels(transcript);
    const derivedOutputs = [
      decision,
      renderStatusLine(toDecisionPresentation(decision), 220),
      formatWhy(decision),
      formatWhyJson(decision)
    ];
    expectNoPrivacySentinels(...derivedOutputs);
    expectNoForbiddenValues(derivedOutputs, [path]);
  });

  it("keeps deliberate raw sentinel coverage in the fixture corpus", async () => {
    const corpus = (
      await Promise.all(REPLAY_CASES.map(async (testCase) => readFile(fixturePath(testCase.fixture), "utf8")))
    ).join("\n");

    for (const sentinel of [
      "BB_CC_LITE_RAW_PROMPT_SENTINEL",
      "BB_CC_LITE_TOOL_OUTPUT_SENTINEL",
      "BB_CC_LITE_FILE_CONTENT_SENTINEL",
      "BB_CC_LITE_API_KEY_SENTINEL",
      "BB_CC_LITE_RAW_COMMAND_SENTINEL",
      "BB_CC_LITE_RAW_PATH_SENTINEL",
      "BB_CC_LITE_RAW_MCP_SENTINEL",
      "BB_CC_LITE_RAW_TOOL_NAME_SENTINEL",
      "mcp__bbcc_private__rawPrivacyTool"
    ]) {
      expect(corpus).toContain(sentinel);
    }
  });

  it("routes every fixture through statusline orchestration and stores only derived decisions", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-jsonl-replay-"));
    const appHome = join(tempDir, "app-home");
    const storePath = join(appHome, "events.json");
    const restoreEnv = setIsolatedEnv({
      BB_CC_LITE_HOME: appHome,
      BB_CC_LITE_STORE: storePath,
      BB_CC_LITE_COLOR: "0",
      BB_CC_LITE_AUTO_LEARN: "0"
    });

    try {
      for (const testCase of REPLAY_CASES) {
        const path = fixturePath(testCase.fixture);
        const entries = parseJsonlFixture(await readFile(path, "utf8"));
        const rendered = await createStatusLine(statusLineInput(path, testCase, fixtureSessionId(entries)), 220);
        expect(rendered.split("\n").filter(Boolean)).toHaveLength(1);
        expectNoPrivacySentinels(rendered);
        expectNoForbiddenValues([rendered], [path]);
      }

      const storeText = await readFile(storePath, "utf8");
      const store = await readStore(storePath);
      expect(store.decisions).toHaveLength(REPLAY_CASES.length);
      for (const [index, testCase] of REPLAY_CASES.entries()) {
        expect(store.decisions[index]).toMatchObject(testCase.expected);
      }
      expectNoPrivacySentinels(storeText, store);
      expectNoForbiddenValues(
        [storeText, store],
        REPLAY_CASES.map((testCase) => fixturePath(testCase.fixture))
      );
    } finally {
      restoreEnv();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`./fixtures/jsonl/${name}`, import.meta.url));
}

function statusLineInput(path: string, testCase: ReplayCase, sessionId: string): string {
  return `${JSON.stringify({
    session_id: sessionId,
    transcript_path: path,
    cwd: "/tmp/bb-cc-lite-fixture/project/BB_CC_LITE_RAW_PATH_SENTINEL",
    model: {
      id: "claude-sonnet-4-5",
      display_name: "Claude Sonnet 4.5"
    },
    workspace: {
      current_dir: "/tmp/bb-cc-lite-fixture/project/BB_CC_LITE_RAW_PATH_SENTINEL",
      project_dir: "/tmp/bb-cc-lite-fixture/project",
      added_dirs: []
    },
    context_window: {
      used_percentage: testCase.contextPercent ?? 42,
      current_usage: {
        input_tokens: 1200,
        output_tokens: 120,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 600
      }
    },
    version: "2.1.150",
    output_style: {
      name: "default"
    },
    terminal_width: 220,
    raw_prompt: "BB_CC_LITE_RAW_PROMPT_SENTINEL",
    tool_output: "BB_CC_LITE_TOOL_OUTPUT_SENTINEL",
    file_contents: "BB_CC_LITE_FILE_CONTENT_SENTINEL",
    environment: {
      ANTHROPIC_API_KEY: "BB_CC_LITE_API_KEY_SENTINEL"
    },
    mcp_server_name: "mcp__bbcc_private__rawPrivacyTool"
  })}\n`;
}

function fixtureSessionId(entries: Record<string, unknown>[]): string {
  const sessionId = stringField(entries[0]?.sessionId);
  if (!sessionId) {
    throw new Error("fixture entry must include sessionId");
  }
  return sessionId;
}

function parseJsonlFixture(raw: string): Record<string, unknown>[] {
  expect(raw.endsWith("\n")).toBe(true);
  const lines = raw.split(/\r?\n/u).filter(Boolean);
  expect(lines.length).toBeGreaterThan(0);
  return lines.map((line) => {
    const parsed = JSON.parse(line) as unknown;
    const record = asRecord(parsed);
    if (!record) {
      throw new Error("fixture JSONL entry must be an object");
    }
    return record;
  });
}

function assertClaudeLikeShape(entries: Record<string, unknown>[]): void {
  const toolUseIds = new Set<string>();
  const toolResultIds: string[] = [];
  let assistantMessages = 0;
  let userMessages = 0;
  let previousTimestamp = 0;

  for (const entry of entries) {
    const timestamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
    expect(Number.isFinite(timestamp)).toBe(true);
    expect(timestamp).toBeGreaterThanOrEqual(previousTimestamp);
    previousTimestamp = timestamp;

    expect(typeof entry.uuid).toBe("string");
    expect(entry.uuid).toMatch(/^[0-9a-f-]{36}$/u);
    expect(typeof entry.sessionId).toBe("string");
    expect(entry.sessionId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(entry.gitBranch).toBe("main");

    const message = asRecord(entry.message);
    if (!message) {
      throw new Error("fixture entry must include message object");
    }
    const role = message.role;
    if (role === "assistant") {
      assistantMessages += 1;
      expect(entry.type).toBe("assistant");
      expect(typeof entry.requestId).toBe("string");
      expect(typeof message.id).toBe("string");
      expect(message.type).toBe("message");
    } else if (role === "user") {
      userMessages += 1;
      expect(entry.type).toBe("user");
    } else {
      throw new Error("fixture message role must be assistant or user");
    }
    expect(Array.isArray(message.content)).toBe(true);

    for (const part of messageContentParts(message)) {
      if (part.type === "tool_use") {
        const id = stringField(part.id);
        expect(id).toBeDefined();
        expect(typeof part.name).toBe("string");
        toolUseIds.add(id as string);
      } else if (part.type === "tool_result") {
        const toolUseId = stringField(part.tool_use_id) || stringField(part.toolUseId);
        expect(toolUseId).toBeDefined();
        expect(entry.sourceToolAssistantUUID).toBeDefined();
        expect(entry.toolUseResult).toBeDefined();
        toolResultIds.push(toolUseId as string);
      }
    }
  }

  expect(assistantMessages).toBeGreaterThan(0);
  expect(userMessages).toBeGreaterThan(0);
  expect(toolUseIds.size).toBeGreaterThan(0);
  expect(toolResultIds.length).toBeGreaterThan(0);
  for (const id of toolResultIds) {
    expect(toolUseIds.has(id)).toBe(true);
  }
}

function messageContentParts(message: Record<string, unknown>): Record<string, unknown>[] {
  const content = message.content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((part) => {
    const record = asRecord(part);
    return record ? [record] : [];
  });
}

function expectNoPrivacySentinels(...values: unknown[]): void {
  expectNoForbiddenValues(values, PRIVACY_SENTINELS);
}

function expectNoForbiddenValues(values: unknown[], forbiddenValues: string[]): void {
  const serialized = values.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join("\n");
  for (const sentinel of forbiddenValues) {
    expect(serialized).not.toContain(sentinel);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
