import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { estimateCostUsd, type PricingTable } from "../src/pricing.js";
import { buildGauge } from "../src/gauge.js";
import { hashValue } from "../src/paths.js";
import { sessionKeyFromId } from "../src/session.js";
import { hookSummary, latestDecision, recordDecision } from "../src/store.js";
import type { Decision, StatusLineInput, TranscriptSummary } from "../src/types.js";

// Mirrors statusline.ts: build the slim gauge-era stored record (no advisor fields) for store tests.
function gaugeDecision(statusInput: StatusLineInput, transcriptSummary: TranscriptSummary): Decision {
  const sessionKey = sessionKeyFromId(statusInput.sessionId);
  const gauge = buildGauge(statusInput, transcriptSummary, { sessionKey });
  return {
    schemaVersion: 2,
    sessionKey,
    light: gauge.light,
    activity: gauge.activity,
    findings: gauge.findings,
    ledger: transcriptSummary.ledger?.entries ?? [],
    files: gauge.files,
    costUsd: statusInput.costUsd,
    costSource: statusInput.costSource,
    contextPercent: statusInput.contextPercent,
    rateLimitPercent: statusInput.rateLimitPercent,
    createdAt: gauge.createdAt
  };
}

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
    postCompactionActivity: 0,
    usage: {},
    ...overrides
  };
}

function cacheShare(peakRatio: number, currentRatio: number): NonNullable<TranscriptSummary["cacheReadShare"]> {
  const peak = cacheSharePoint(peakRatio);
  const current = cacheSharePoint(currentRatio);
  return {
    peak,
    current,
    dropPercentagePoints: Math.max(0, (peak.ratio - current.ratio) * 100)
  };
}

function cacheSharePoint(ratio: number): NonNullable<TranscriptSummary["cacheReadShare"]>["current"] {
  const totalInputTokens = 1_000;
  const cacheReadInputTokens = Math.round(ratio * totalInputTokens);
  return {
    ratio,
    totalInputTokens,
    inputTokens: totalInputTokens - cacheReadInputTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens
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
    const tempDir = await mkdtemp(join(tmpdir(), "ccverdict-store-mode-"));
    try {
      const storePath = join(tempDir, "events.json");
      await recordDecision(gaugeDecision(input(), transcript()), storePath);

      expect((await stat(storePath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps the why-store free of raw prompt and tool-output sentinels", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ccverdict-store-"));
    try {
      const storePath = join(tempDir, "events.json");
      const rawPromptSentinel = "RAW_PROMPT_SENTINEL_DO_NOT_STORE";
      const rawToolOutputSentinel = "RAW_TOOL_OUTPUT_SENTINEL_DO_NOT_STORE";
      const rawSessionId = `session-${rawPromptSentinel}-${rawToolOutputSentinel}`;
      const decision = gaugeDecision(
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

  it("persists cache efficiency regression decisions without raw prompt, output, file content, paths, or session ids", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ccverdict-store-cache-regression-"));
    try {
      const storePath = join(tempDir, "events.json");
      const rawPromptSentinel = "RAW_PROMPT_SENTINEL_DO_NOT_STORE";
      const rawToolOutputSentinel = "RAW_TOOL_OUTPUT_SENTINEL_DO_NOT_STORE";
      const rawFileContentSentinel = "RAW_FILE_CONTENT_SENTINEL_DO_NOT_STORE";
      const rawPath = `/tmp/RAW_PATH_SENTINEL/${rawFileContentSentinel}/transcript.jsonl`;
      const rawWorkspacePath = `/workspace/RAW_WORKSPACE_SENTINEL/${rawPromptSentinel}`;
      const rawSessionId = `session-${rawPromptSentinel}-${rawToolOutputSentinel}-${rawFileContentSentinel}`;
      const decision = gaugeDecision(
        input({
          sessionId: rawSessionId,
          transcriptPath: rawPath,
          cwd: rawWorkspacePath,
          model: { id: `model-${rawPromptSentinel}` }
        }),
        transcript({
          cacheReadShare: cacheShare(0.68, 0.29)
        })
      );

      await recordDecision(decision, storePath);
      const whyDecision = await latestDecision(decision.sessionKey, storePath);

      expect(whyDecision?.light).toBe("blue");
      expect(whyDecision?.findings?.[0]).toMatchObject({
        category: "cache_efficiency_regression",
        evidence: "cache reuse dropped from 68% to 29%"
      });
      expect(whyDecision?.sessionKey).toBe(hashValue(rawSessionId));

      const scannedText = [await readFile(storePath, "utf8"), JSON.stringify(whyDecision)].join("\n");
      for (const rawValue of [
        rawPromptSentinel,
        rawToolOutputSentinel,
        rawFileContentSentinel,
        rawPath,
        rawWorkspacePath,
        rawSessionId
      ]) {
        expect(scannedText).not.toContain(rawValue);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("persists redundant-read decisions without raw full file paths", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ccverdict-store-redundant-read-"));
    try {
      const storePath = join(tempDir, "events.json");
      const rawPath = "/tmp/ccverdict/private/worktree/src/secret.ts";
      const decision = gaugeDecision(
        input({ sessionId: "session-alpha" }),
        transcript({
          toolCalls: 3,
          readToolCalls: 3,
          redundantRead: {
            fileIdentityHash: hashValue(rawPath) || "safe-file-hash",
            unchangedFullFileReadCount: 3,
            latestState: "Stop"
          }
        })
      );

      await recordDecision(decision, storePath);

      const storeText = await readFile(storePath, "utf8");
      expect(storeText).toContain("redundant_read_loop");
      expect(storeText).not.toContain("secret.ts");
      expect(storeText).not.toContain(rawPath);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("drops malformed legacy decisions with raw-data fields before why can print them", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ccverdict-store-legacy-"));
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

  it("drops legacy hook events that contain raw MCP tool names", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ccverdict-store-mcp-legacy-"));
    try {
      const storePath = join(tempDir, "events.json");
      const rawMcpName = "mcp__privateServer__failingLookup";
      await writeFile(
        storePath,
        `${JSON.stringify(
          {
            version: 1,
            updatedAt: "2026-05-19T12:00:00.000Z",
            decisions: [],
            hookEvents: [
              {
                id: "legacy-raw-mcp",
                kind: "tool_failure",
                timestamp: "2026-05-19T12:00:00.000Z",
                hookEventName: "PostToolUseFailure",
                sessionKey: hashValue("session-alpha"),
                toolName: rawMcpName
              },
              {
                id: "safe-mcp",
                kind: "tool_failure",
                timestamp: "2026-05-19T12:00:01.000Z",
                hookEventName: "PostToolUseFailure",
                sessionKey: hashValue("session-alpha"),
                toolName: "MCP tool",
                category: "MCP",
                identityHash: "safehash"
              }
            ]
          },
          null,
          2
        )}\n`,
        "utf8"
      );

      const summary = await hookSummary(hashValue("session-alpha"), storePath);

      expect(summary.failedToolResults).toBe(1);
      expect(JSON.stringify(summary)).not.toContain(rawMcpName);
      expect(JSON.stringify(summary)).not.toContain("mcp__");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
