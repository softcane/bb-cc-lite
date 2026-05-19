import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { estimateCostUsd, type PricingTable } from "../src/pricing.js";
import { hashValue } from "../src/paths.js";
import { decide } from "../src/signals.js";
import { latestDecision, recordDecision } from "../src/store.js";
import type { StatusLineInput, TranscriptSummary } from "../src/types.js";

function input(overrides: Partial<StatusLineInput> = {}): StatusLineInput {
  return {
    rawValid: true,
    sessionId: "session-alpha",
    model: { id: "claude-sonnet-4-5" },
    usage: {},
    ...overrides
  };
}

function transcript(overrides: Partial<TranscriptSummary> = {}): TranscriptSummary {
  return {
    pathReadable: true,
    bytesRead: 0,
    linesRead: 0,
    malformedLines: 0,
    toolCalls: 0,
    readToolCalls: 0,
    failedToolResults: 0,
    repeatedFailures: [],
    editTestLoopFailures: 0,
    hasUnvalidatedEdits: false,
    validationRecovered: false,
    compactionEvents: 0,
    usage: {},
    ...overrides
  };
}

describe("store and pricing", () => {
  it("estimates local cost from cached LiteLLM pricing data without credentials", () => {
    const pricing: PricingTable = {
      models: {
        "claude-sonnet-4-5": {
          inputCostPerToken: 3 / 1_000_000,
          outputCostPerToken: 15 / 1_000_000,
          cacheCreationInputTokenCost: 3.75 / 1_000_000,
          cacheReadInputTokenCost: 0.3 / 1_000_000
        }
      }
    };

    expect(
      estimateCostUsd(
        "claude-sonnet-4-5",
        {
          inputTokens: 1000,
          outputTokens: 100,
          cacheCreationInputTokens: 2000,
          cacheReadInputTokens: 5000
        },
        pricing
      )
    ).toBeCloseTo(0.0135);
  });

  it("writes event stores with private file permissions", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-store-mode-"));
    try {
      const storePath = join(tempDir, "events.json");
      await recordDecision(decide(input(), transcript()), storePath);

      expect((await stat(storePath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps the why-store free of raw prompt and tool-output sentinels", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-store-"));
    try {
      const storePath = join(tempDir, "events.json");
      const rawPromptSentinel = "RAW_PROMPT_SENTINEL_DO_NOT_STORE";
      const rawToolOutputSentinel = "RAW_TOOL_OUTPUT_SENTINEL_DO_NOT_STORE";
      const rawSessionId = `session-${rawPromptSentinel}-${rawToolOutputSentinel}`;
      const decision = decide(
        input({
          sessionId: rawSessionId,
          transcriptPath: `/tmp/${rawPromptSentinel}.jsonl`,
          cwd: `/workspace/${rawToolOutputSentinel}`,
          model: { id: `model-${rawPromptSentinel}` },
          usage: {
            cacheCreationInputTokens: 11_000,
            cacheReadInputTokens: 100
          }
        }),
        transcript()
      );

      const stored = await recordDecision(decision, storePath);
      const whyDecision = await latestDecision(decision.sessionKey, storePath);

      expect(whyDecision?.id).toBe(stored.id);
      expect(whyDecision?.sessionKey).toBe(hashValue(rawSessionId));

      const storeText = await readFile(storePath, "utf8");
      const whyText = JSON.stringify(whyDecision);
      for (const scannedText of [storeText, whyText]) {
        expect(scannedText).not.toContain(rawPromptSentinel);
        expect(scannedText).not.toContain(rawToolOutputSentinel);
        expect(scannedText).not.toContain(rawSessionId);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("drops malformed legacy decisions with raw-data fields before why can print them", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-store-legacy-"));
    try {
      const storePath = join(tempDir, "events.json");
      const rawPromptSentinel = "RAW_PROMPT_SENTINEL_DO_NOT_PRINT";
      await writeFile(
        storePath,
        `${JSON.stringify(
          {
            version: 1,
            updatedAt: "2026-05-19T12:00:00.000Z",
            decisions: [
              {
                id: "legacy-raw",
                state: "Healthy",
                action: "continue",
                raw_prompt: rawPromptSentinel
              },
              {
                id: "safe-derived",
                state: "Healthy",
                reasonCode: "healthy",
                primaryEvidence: "no stop-level findings",
                evidence: [{ label: "no stop-level findings" }],
                impact: "session stable",
                action: "continue normally",
                createdAt: "2026-05-19T12:00:00.000Z"
              }
            ],
            hookEvents: []
          },
          null,
          2
        )}\n`,
        "utf8"
      );

      const whyDecision = await latestDecision(undefined, storePath);

      expect(whyDecision?.id).toBe("safe-derived");
      expect(JSON.stringify(whyDecision)).not.toContain(rawPromptSentinel);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
