import { describe, expect, it } from "vitest";
import { extractFailureEpisodesFromTranscriptLines, summarizeBlindRetry } from "../src/failure-episodes.js";

const rawMcpName = "mcp__privateServer__failingLookup";

describe("safe failure episodes and blind retry", () => {
  it("detects a blind test retry at two failures and Stop-level blind retry at three", () => {
    const twoFailures = extractFailureEpisodesFromTranscriptLines(repeatedFailedTestTranscript(2));
    expect(twoFailures).toMatchObject([
      {
        category: "tests",
        label: "test",
        attemptCount: 2,
        recovered: false,
        activeEnded: true,
        blindRetryFailureCount: 2
      }
    ]);
    expect(summarizeBlindRetry(twoFailures)).toMatchObject({
      category: "tests",
      label: "test",
      blindRetryFailureCount: 2
    });

    const threeFailures = extractFailureEpisodesFromTranscriptLines(repeatedFailedTestTranscript(3));
    expect(summarizeBlindRetry(threeFailures)).toMatchObject({
      category: "tests",
      blindRetryFailureCount: 3
    });
  });

  it("does not count read/search-only investigation as meaningful intervention", () => {
    const episodes = extractFailureEpisodesFromTranscriptLines([
      ...failedBashCommand("test-1", "npm test"),
      ...successfulTool("read-1", "Read"),
      ...successfulTool("grep-1", "Grep"),
      ...failedBashCommand("test-2", "npm test")
    ]);

    expect(summarizeBlindRetry(episodes)).toMatchObject({
      category: "tests",
      blindRetryFailureCount: 2
    });
  });

  it("clears blind retry suspicion after successful edit or validation evidence", () => {
    const afterEdit = extractFailureEpisodesFromTranscriptLines([
      ...failedBashCommand("test-1", "npm test"),
      ...successfulTool("edit-1", "Edit"),
      ...failedBashCommand("test-2", "npm test")
    ]);
    expect(afterEdit).toMatchObject([
      {
        category: "tests",
        attemptCount: 2,
        blindRetryFailureCount: 1,
        meaningfulIntervention: ["edit"]
      }
    ]);
    expect(summarizeBlindRetry(afterEdit)).toBeUndefined();

    const afterValidation = extractFailureEpisodesFromTranscriptLines([
      ...failedBashCommand("test-1", "npm test"),
      ...successfulBashCommand("lint-pass", "npm run lint"),
      ...failedBashCommand("test-2", "npm test")
    ]);
    expect(afterValidation).toMatchObject([
      {
        category: "tests",
        attemptCount: 2,
        blindRetryFailureCount: 1,
        meaningfulIntervention: ["validation_success"]
      }
    ]);
    expect(summarizeBlindRetry(afterValidation)).toBeUndefined();
  });

  it("marks a same-identity success as recovered instead of active-ended", () => {
    const episodes = extractFailureEpisodesFromTranscriptLines([
      ...failedBashCommand("test-1", "npm test"),
      ...failedBashCommand("test-2", "npm test"),
      ...successfulBashCommand("test-pass", "npm test")
    ]);

    expect(episodes).toMatchObject([
      {
        category: "tests",
        attemptCount: 2,
        recovered: true,
        activeEnded: false,
        meaningfulIntervention: ["same_failure_success"],
        blindRetryFailureCount: 2
      }
    ]);
    expect(summarizeBlindRetry(episodes)).toBeUndefined();
  });

  it("starts a fresh episode after recovery instead of carrying old blind retry state forward", () => {
    const episodes = extractFailureEpisodesFromTranscriptLines([
      ...failedBashCommand("test-1", "npm test"),
      ...failedBashCommand("test-2", "npm test"),
      ...successfulBashCommand("test-pass", "npm test"),
      ...failedBashCommand("test-new-fail", "npm test")
    ]);

    expect(episodes).toMatchObject([
      {
        category: "tests",
        attemptCount: 2,
        recovered: true,
        activeEnded: false,
        blindRetryFailureCount: 2
      },
      {
        category: "tests",
        attemptCount: 1,
        recovered: false,
        activeEnded: true,
        blindRetryFailureCount: 1
      }
    ]);
    expect(summarizeBlindRetry(episodes)).toBeUndefined();
  });

  it("tracks separate active failure identities while applying edit evidence to all of them", () => {
    const episodes = extractFailureEpisodesFromTranscriptLines([
      ...failedBashCommand("test-1", "npm test"),
      ...failedBashCommand("build-1", "npm run build"),
      ...successfulTool("edit-1", "Edit"),
      ...failedBashCommand("test-2", "npm test"),
      ...failedBashCommand("build-2", "npm run build")
    ]);

    expect(episodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "tests",
          attemptCount: 2,
          meaningfulIntervention: ["edit"],
          blindRetryFailureCount: 1
        }),
        expect.objectContaining({
          category: "build",
          attemptCount: 2,
          meaningfulIntervention: ["edit"],
          blindRetryFailureCount: 1
        })
      ])
    );
    expect(summarizeBlindRetry(episodes)).toBeUndefined();
  });

  it("does not treat unrelated failed tools as meaningful intervention", () => {
    const episodes = extractFailureEpisodesFromTranscriptLines([
      ...failedBashCommand("test-1", "npm test"),
      ...failedBashCommand("build-1", "npm run build"),
      ...failedBashCommand("test-2", "npm test")
    ]);

    expect(episodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "tests",
          attemptCount: 2,
          blindRetryFailureCount: 2
        })
      ])
    );
    expect(summarizeBlindRetry(episodes)).toMatchObject({
      category: "tests",
      blindRetryFailureCount: 2
    });
  });

  it("aggregates MCP failures without exposing raw MCP names", () => {
    const episodes = extractFailureEpisodesFromTranscriptLines([
      ...failedTool("mcp-1", rawMcpName),
      ...failedTool("mcp-2", rawMcpName)
    ]);

    expect(episodes).toMatchObject([
      {
        category: "mcp",
        label: "MCP tool",
        attemptCount: 2,
        blindRetryFailureCount: 2,
        identityHash: expect.any(String)
      }
    ]);
    expect(JSON.stringify(episodes)).not.toContain(rawMcpName);
    expect(JSON.stringify(episodes)).not.toContain("mcp__");
  });

  it("handles malformed JSONL and unknown tools without raw leakage", () => {
    const episodes = extractFailureEpisodesFromTranscriptLines([
      "not-json",
      ...failedTool("unknown-1", "PrivateToolName"),
      ...failedTool("unknown-2", "PrivateToolName")
    ]);

    expect(episodes).toMatchObject([
      {
        category: "tool",
        label: "tool",
        attemptCount: 2
      }
    ]);
    expect(JSON.stringify(episodes)).not.toContain("PrivateToolName");
  });
});

function repeatedFailedTestTranscript(count: number): string[] {
  return Array.from({ length: count }, (_value, index) => failedBashCommand(`test-${index + 1}`, "npm test")).flat();
}

function failedBashCommand(id: string, command: string): string[] {
  return failedTool(id, "Bash", { command });
}

function successfulBashCommand(id: string, command: string): string[] {
  return successfulTool(id, "Bash", { command });
}

function failedTool(id: string, name: string, input: Record<string, unknown> = {}): string[] {
  return [
    JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id, name, input }]
      }
    }),
    JSON.stringify({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: "private output" }]
      }
    })
  ];
}

function successfulTool(id: string, name: string, input: Record<string, unknown> = {}): string[] {
  return [
    JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id, name, input }]
      }
    }),
    JSON.stringify({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: id, is_error: false, content: "private output" }]
      }
    })
  ];
}
