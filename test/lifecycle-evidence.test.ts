import { describe, expect, it } from "vitest";
import { classifyLifecycleEvidence } from "../src/lifecycle-evidence.js";
import { sessionKeyFromId } from "../src/session.js";
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
    parseableLines: 0,
    userMessages: 0,
    assistantMessages: 0,
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

describe("classifyLifecycleEvidence", () => {
  it("classifies a readable empty transcript as sparse no-activity evidence", () => {
    const evidence = classifyLifecycleEvidence(input({ transcriptPath: "/private/session.jsonl" }), transcript());

    expect(evidence).toMatchObject({
      status: "empty_transcript",
      hasCurrentActivity: false,
      hasTranscriptActivity: false,
      transcript: {
        pathProvided: true,
        readable: true,
        parseableLines: 0,
        malformedLines: 0,
        userMessages: 0,
        assistantMessages: 0,
        toolCalls: 0
      }
    });
    expect(JSON.stringify(evidence)).not.toContain("/private/session.jsonl");
  });

  it("distinguishes missing, malformed-only, no-path, and no-activity evidence", () => {
    expect(
      classifyLifecycleEvidence(input({ transcriptPath: "/private/missing.jsonl" }), transcript({ pathReadable: false }))
    ).toMatchObject({
      status: "missing_transcript",
      hasCurrentActivity: false
    });
    expect(
      classifyLifecycleEvidence(
        input({ transcriptPath: "/private/malformed.jsonl" }),
        transcript({ linesRead: 2, malformedLines: 2 })
      )
    ).toMatchObject({
      status: "malformed_transcript",
      hasCurrentActivity: false,
      transcript: {
        parseableLines: 0,
        malformedLines: 2
      }
    });
    expect(classifyLifecycleEvidence(input(), transcript())).toMatchObject({
      status: "no_transcript_path",
      hasCurrentActivity: false
    });
    expect(
      classifyLifecycleEvidence(
        input({ transcriptPath: "/private/no-activity.jsonl" }),
        transcript({ linesRead: 1, parseableLines: 1 })
      )
    ).toMatchObject({
      status: "no_activity",
      hasCurrentActivity: false
    });
  });

  it("keeps direct current status signals separate from transcript activity", () => {
    const evidence = classifyLifecycleEvidence(
      input({
        contextPercent: 42,
        usage: {
          inputTokens: 100,
          cacheReadInputTokens: 50
        }
      }),
      transcript()
    );

    expect(evidence).toMatchObject({
      status: "no_transcript_path",
      hasDirectStatusSignal: true,
      hasCurrentActivity: true,
      hasTranscriptActivity: false
    });
  });

  it("compares transcript session keys to the current statusline session key safely", () => {
    const matching = classifyLifecycleEvidence(
      input({ sessionId: "session-alpha" }),
      transcript({
        transcriptHasSessionIds: true,
        transcriptSessionKeyCount: 1,
        transcriptSessionKeys: [sessionKeyFromId("session-alpha")!]
      })
    );
    const mismatched = classifyLifecycleEvidence(
      input({ sessionId: "session-alpha" }),
      transcript({
        transcriptHasSessionIds: true,
        transcriptSessionKeyCount: 1,
        transcriptSessionKeys: ["not-the-current-session"]
      })
    );

    expect(matching.sessionIdentity).toMatchObject({
      inputSessionKeyPresent: true,
      transcriptHasSessionIds: true,
      transcriptSessionKeyCount: 1,
      matchesInput: true,
      mismatch: false
    });
    expect(mismatched.sessionIdentity).toMatchObject({
      matchesInput: false,
      mismatch: true
    });
    expect(JSON.stringify([matching, mismatched])).not.toContain("session-alpha");
  });
});
