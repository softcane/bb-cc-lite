import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseTranscriptLines, parseTranscriptTail } from "../src/transcript.js";

const privacySentinels = [
  "BB_CC_LITE_RAW_PROMPT_SENTINEL",
  "BB_CC_LITE_TOOL_OUTPUT_SENTINEL",
  "BB_CC_LITE_API_KEY_SENTINEL"
];

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`./fixtures/transcripts/${name}`, import.meta.url));
}

function nonEmptyLines(raw: string): string[] {
  return raw.split(/\r?\n/u).filter(Boolean);
}

function expectNoPrivacySentinels(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const sentinel of privacySentinels) {
    expect(serialized).not.toContain(sentinel);
  }
}

describe("parseTranscriptLines", () => {
  it("summarizes transcript events without retaining raw prompts or tool output", async () => {
    const raw = await readFile(fixturePath("mixed-events.jsonl"), "utf8");

    for (const sentinel of privacySentinels) {
      expect(raw).toContain(sentinel);
    }

    const summary = parseTranscriptLines(nonEmptyLines(raw), Buffer.byteLength(raw));

    expect(summary).toMatchObject({
      pathReadable: true,
      bytesRead: Buffer.byteLength(raw),
      linesRead: 10,
      malformedLines: 1,
      toolCalls: 5,
      failedToolResults: 3,
      repeatedFailures: [{ toolName: "Bash", purpose: "tests", count: 2 }],
      editTestLoopFailures: 2,
      compactionEvents: 1,
      usage: {
        inputTokens: 150,
        outputTokens: 30,
        cacheCreationInputTokens: 10,
        cacheReadInputTokens: 90,
        totalTokens: 270
      },
      latestTimestamp: "2026-02-03T00:00:09.000Z"
    });
    expectNoPrivacySentinels(summary);
  });
});

describe("parseTranscriptTail", () => {
  it("reads a transcript file through the bounded tail parser", async () => {
    const raw = await readFile(fixturePath("mixed-events.jsonl"), "utf8");

    const summary = await parseTranscriptTail(fixturePath("mixed-events.jsonl"), {
      maxBytes: Buffer.byteLength(raw)
    });

    expect(summary.pathReadable).toBe(true);
    expect(summary.linesRead).toBe(10);
    expect(summary.malformedLines).toBe(1);
    expect(summary.repeatedFailures).toEqual([{ toolName: "Bash", purpose: "tests", count: 2 }]);
    expectNoPrivacySentinels(summary);
  });

  it("returns an unreadable empty summary when no path is supplied", async () => {
    await expect(parseTranscriptTail(undefined)).resolves.toMatchObject({
      pathReadable: false,
      bytesRead: 0,
      linesRead: 0,
      malformedLines: 0,
      toolCalls: 0,
      failedToolResults: 0,
      repeatedFailures: [],
      editTestLoopFailures: 0,
      compactionEvents: 0,
      usage: {}
    });
  });
});
