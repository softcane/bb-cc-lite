import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { parseTranscriptTail } from "../src/transcript.js";

describe("large transcript performance", () => {
  it("parses only the bounded transcript tail under the hard budget", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-perf-"));
    try {
      const transcriptPath = join(tempDir, "large.jsonl");
      const line = JSON.stringify({
        timestamp: "2026-05-18T20:00:00.000Z",
        type: "assistant",
        message: {
          role: "assistant",
          usage: {
            input_tokens: 100,
            output_tokens: 10,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 50
          },
          content: [{ type: "text", text: "not stored" }]
        }
      });
      const repeat = Math.ceil((10 * 1024 * 1024) / (line.length + 1));
      await writeFile(transcriptPath, `${Array.from({ length: repeat }, () => line).join("\n")}\n`, "utf8");

      const startedAt = performance.now();
      const summary = await parseTranscriptTail(transcriptPath);
      const elapsedMs = performance.now() - startedAt;

      expect(summary.pathReadable).toBe(true);
      expect(summary.bytesRead).toBeLessThanOrEqual(512 * 1024);
      expect(summary.linesRead).toBeGreaterThan(100);
      expect(elapsedMs).toBeLessThan(300);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
