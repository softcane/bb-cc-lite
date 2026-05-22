import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseStatusLineInput } from "../src/status-input.js";

const privacySentinels = [
  "BB_CC_LITE_RAW_PROMPT_SENTINEL",
  "BB_CC_LITE_TOOL_OUTPUT_SENTINEL",
  "BB_CC_LITE_API_KEY_SENTINEL"
];

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`./fixtures/statusline/${name}`, import.meta.url));
}

function expectNoPrivacySentinels(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const sentinel of privacySentinels) {
    expect(serialized).not.toContain(sentinel);
  }
}

describe("parseStatusLineInput", () => {
  it("extracts Claude statusline fields and drops ignored raw content", async () => {
    const raw = await readFile(fixturePath("rich-statusline.json"), "utf8");

    for (const sentinel of privacySentinels) {
      expect(raw).toContain(sentinel);
    }

    const input = parseStatusLineInput(raw);

    expect(input).toMatchObject({
      rawValid: true,
      sessionId: "session-fixture-001",
      transcriptPath: "/tmp/bb-cc-lite/transcripts/session.jsonl",
      cwd: "/tmp/bb-cc-lite/workspace",
      model: {
        id: "claude-sonnet-4-5",
        displayName: "Claude Sonnet 4.5"
      },
      costUsd: 0.0421,
      costSource: "claude",
      durationMs: 8342,
      contextPercent: 41,
      rateLimitPercent: 87,
      usage: {
        inputTokens: 1250,
        outputTokens: 350,
        cacheCreationInputTokens: 400,
        cacheReadInputTokens: 910,
        totalTokens: 94000
      },
      terminalWidth: 132
    });
    expectNoPrivacySentinels(input);
  });

  it("returns a defensive empty input for invalid statusline stdin", () => {
    expect(parseStatusLineInput("")).toMatchObject({
      rawValid: false,
      model: {},
      usage: {},
      parseError: "empty stdin"
    });

    expect(parseStatusLineInput("[]")).toMatchObject({
      rawValid: false,
      model: {},
      usage: {},
      parseError: "stdin JSON is not an object"
    });
  });

  it("does not treat LiteLLM response cache hits as Anthropic prompt-cache reads", () => {
    const input = parseStatusLineInput(
      JSON.stringify({
        session_id: "session-cache-hit",
        usage: {
          cache_creation_input_tokens: 50_000,
          cache_hit_input_tokens: 50_000
        }
      })
    );

    expect(input.usage.cacheCreationInputTokens).toBe(50_000);
    expect(input.usage.cacheReadInputTokens).toBeUndefined();
  });

  it("keeps Claude cost source for alternate cost fields and zero values", () => {
    const camelCost = parseStatusLineInput(
      JSON.stringify({
        session_id: "session-camel-cost",
        cost: {
          totalCostUsd: 0.25,
          total_duration_ms: 0
        }
      })
    );
    const zeroCost = parseStatusLineInput(
      JSON.stringify({
        session_id: "session-zero-cost",
        cost: {
          total_cost_usd: 0,
          total_duration_ms: 0
        }
      })
    );

    expect(camelCost).toMatchObject({
      costUsd: 0.25,
      costSource: "claude",
      durationMs: 0
    });
    expect(zeroCost).toMatchObject({
      costUsd: 0,
      costSource: "claude",
      durationMs: 0
    });
  });
});
