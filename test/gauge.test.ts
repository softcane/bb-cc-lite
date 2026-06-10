import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyActivity } from "../src/activity.js";
import { buildEditLedger, LEDGER_IDENTITY_CAP, type LedgerEvent } from "../src/edit-ledger.js";
import { runDetectors, resolveLight } from "../src/findings.js";
import { buildGauge } from "../src/gauge.js";
import { renderGauge } from "../src/gauge-renderer.js";
import { latestProjectDecision, readStore, recordDecision } from "../src/store.js";
import type { Decision, EditLedger, StatusLineInput, TranscriptSummary } from "../src/types.js";

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
    linesRead: 1,
    malformedLines: 0,
    parseableLines: 1,
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

function ledger(overrides: Partial<EditLedger> = {}): EditLedger {
  return { entries: [], edited: 0, unchecked: 0, ...overrides };
}

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\[[0-9;]*m/gu, "");
}

function render(gaugeInput: StatusLineInput, transcriptSummary: TranscriptSummary, width = 120): string {
  return stripAnsi(renderGauge(buildGauge(gaugeInput, transcriptSummary), width));
}

const greenEditing = {
  input: input({ contextPercent: 42, costUsd: 0.18, costSource: "claude" as const }),
  transcript: transcript({
    toolCalls: 2,
    successfulEditResults: 1,
    hasUnvalidatedEdits: true,
    unvalidatedEditToolSteps: 0,
    changedFileIdentityCount: 1,
    unvalidatedChangedFileIdentityCount: 1,
    latestActivityKind: "edit",
    ledger: ledger({ edited: 1, unchecked: 1, latestUncheckedBasename: "auth.ts", entries: [{ identityHash: "h", basename: "auth.ts", edits: 1, unchecked: true }] })
  })
};

const blueDrift = {
  input: input({ contextPercent: 42 }),
  transcript: transcript({
    toolCalls: 5,
    successfulEditResults: 3,
    hasUnvalidatedEdits: true,
    unvalidatedEditToolSteps: 4,
    changedFileIdentityCount: 3,
    unvalidatedChangedFileIdentityCount: 2,
    latestActivityKind: "edit",
    ledger: ledger({ edited: 3, unchecked: 2, latestUncheckedBasename: "auth.ts", entries: [{ identityHash: "h", basename: "auth.ts", edits: 1, unchecked: true }] })
  })
};

const redRetry = {
  input: input(),
  transcript: transcript({
    failedToolResults: 3,
    repeatedFailures: [{ toolName: "Bash", purpose: "tests", count: 3 }],
    blindRetry: { category: "tests", label: "test", attemptCount: 3, recovered: false, activeEnded: true, blindRetryFailureCount: 3 }
  })
};

const grayUnreadable = {
  input: input({ transcriptPath: "/private/malformed.jsonl" }),
  transcript: transcript({ linesRead: 2, malformedLines: 2, parseableLines: 0 })
};

const greenIdle = {
  input: input(),
  transcript: transcript({ linesRead: 0, parseableLines: 0 })
};

describe("gauge fixture scenarios render the new grammar", () => {
  it("renders green editing", () => {
    expect(render(greenEditing.input, greenEditing.transcript)).toBe(
      "● editing · 1 file, 1 unchecked (auth.ts…) · ctx 42% · $0.18"
    );
  });

  it("renders blue unchecked drift", () => {
    expect(render(blueDrift.input, blueDrift.transcript)).toBe("◐ editing · 3 files, 2 unchecked (auth.ts…) · ctx 42%");
  });

  it("renders red 3x retry", () => {
    expect(render(redRetry.input, redRetry.transcript)).toBe("■ retrying tests · 3 fails, no fix between runs");
  });

  it("renders gray unreadable transcript", () => {
    expect(render(grayUnreadable.input, grayUnreadable.transcript)).toBe("○ no signal · transcript unreadable");
  });

  it("renders green idle", () => {
    expect(render(greenIdle.input, greenIdle.transcript)).toBe("● idle · no activity yet");
  });
});

describe("banned-words corpus", () => {
  it("contains no imperative advice in any rendered fixture line", () => {
    const scenarios = [greenEditing, blueDrift, redRetry, grayUnreadable, greenIdle];
    const corpus = scenarios.map((scenario) => render(scenario.input, scenario.transcript, 120)).join("\n");
    for (const banned of ["ask ", "run ", "pause", "stop and", "inspect", "before continuing"]) {
      expect(corpus.toLowerCase()).not.toContain(banned);
    }
  });
});

describe("flap stability", () => {
  it("produces identical dots and lines for identical consecutive inputs", () => {
    for (const scenario of [greenEditing, blueDrift, redRetry, grayUnreadable, greenIdle]) {
      const first = buildGauge(scenario.input, scenario.transcript);
      const second = buildGauge(scenario.input, scenario.transcript);
      expect(first.light).toBe(second.light);
      expect(renderGauge(first, 120)).toBe(renderGauge(second, 120));
    }
  });
});

describe("renderer width tiers and color fallback", () => {
  it("degrades from full to compact to minimal while keeping the dot", () => {
    const previousColor = process.env.BB_CC_LITE_COLOR;
    process.env.BB_CC_LITE_COLOR = "0";
    try {
      const gauge = buildGauge(blueDrift.input, blueDrift.transcript);
      expect(renderGauge(gauge, 120)).toBe("◐ editing · 3 files, 2 unchecked (auth.ts…) · ctx 42%");
      expect(renderGauge(gauge, 40)).toBe("◐ editing · 2✎? · 42%");
      const minimal = renderGauge(gauge, 20);
      expect(minimal).toBe("◐ 2✎? 42%");
      expect(minimal.startsWith("◐")).toBe(true);
    } finally {
      restoreEnv("BB_CC_LITE_COLOR", previousColor);
    }
  });

  it("keeps distinct shapes under NO_COLOR with no ANSI codes", () => {
    const previous = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const red = renderGauge(buildGauge(redRetry.input, redRetry.transcript), 120);
      const green = renderGauge(buildGauge(greenIdle.input, greenIdle.transcript), 120);
      expect(red).not.toContain("[");
      expect(green).not.toContain("[");
      expect(red.startsWith("■")).toBe(true);
      expect(green.startsWith("●")).toBe(true);
    } finally {
      restoreEnv("NO_COLOR", previous);
    }
  });
});

describe("findings detectors and resolver", () => {
  it("flags context critical as red", () => {
    const findings = runDetectors(input({ contextPercent: 94 }), transcript());
    expect(findings[0]).toMatchObject({ category: "context_critical", severity: "red" });
  });

  it("does not change the dot for ctx 80-91", () => {
    const findings = runDetectors(input({ contextPercent: 85 }), transcript());
    expect(resolveLight(findings)).toBe("green");
  });

  it("keeps cost a fact and never red on its own", () => {
    const findings = runDetectors(input({ costUsd: 5, costSource: "claude" }), transcript());
    expect(resolveLight(findings)).toBe("green");
  });

  it("turns cost plus repeated failure red", () => {
    const findings = runDetectors(
      input({ costUsd: 5, costSource: "claude" }),
      transcript({ repeatedFailures: [{ toolName: "Bash", purpose: "tests", count: 2 }] }),
      { budgetThresholds: { costUsd: 2, costDeltaUsd: 0.5, durationMs: 1 } }
    );
    expect(findings.some((finding) => finding.category === "budget_with_repeated_failure" && finding.severity === "red")).toBe(true);
  });

  it("only drifts blue on unchecked edits with lag", () => {
    expect(resolveLight(runDetectors(input(), transcript({ hasUnvalidatedEdits: true, unvalidatedEditToolSteps: 1 })))).toBe("green");
    expect(resolveLight(runDetectors(input(), transcript({ hasUnvalidatedEdits: true, unvalidatedEditToolSteps: 4 })))).toBe("blue");
  });
});

describe("activity classifier priority", () => {
  it("retrying beats testing", () => {
    expect(
      classifyActivity(
        transcript({
          latestActivityKind: "validate",
          repeatedFailures: [{ toolName: "Bash", purpose: "tests", count: 2 }],
          blindRetry: { category: "tests", label: "test", attemptCount: 2, recovered: false, activeEnded: true, blindRetryFailureCount: 2 }
        })
      ).verb
    ).toBe("retrying");
  });

  it("testing beats editing", () => {
    expect(classifyActivity(transcript({ latestActivityKind: "validate", hasUnvalidatedEdits: true })).verb).toBe("testing");
  });

  it("editing beats exploring", () => {
    expect(classifyActivity(transcript({ hasUnvalidatedEdits: true, toolCalls: 5, readToolCalls: 4, latestActivityKind: "edit" })).verb).toBe(
      "editing"
    );
  });

  it("exploring for read-dominant windows", () => {
    expect(classifyActivity(transcript({ toolCalls: 4, readToolCalls: 4, latestActivityKind: "read" })).verb).toBe("exploring");
  });

  it("idle for empty windows", () => {
    expect(classifyActivity(transcript()).verb).toBe("idle");
  });
});

describe("edit ledger clear/no-clear matrix", () => {
  const edit = (basename: string): LedgerEvent => ({ kind: "edit", identityHash: `hash-${basename}`, basename });

  it("clears all unchecked on a passing check", () => {
    const result = buildEditLedger([edit("a.ts"), edit("b.ts"), { kind: "validation_pass" }]);
    expect(result).toMatchObject({ edited: 2, unchecked: 0 });
  });

  it("clears nothing on a failing check", () => {
    expect(buildEditLedger([edit("a.ts"), { kind: "validation_fail" }])).toMatchObject({ edited: 1, unchecked: 1 });
  });

  it("clears nothing on compaction", () => {
    expect(buildEditLedger([edit("a.ts"), { kind: "compaction" }])).toMatchObject({ edited: 1, unchecked: 1 });
  });

  it("clears everything on a lifecycle reset", () => {
    expect(buildEditLedger([edit("a.ts"), { kind: "lifecycle_reset" }])).toMatchObject({ edited: 0, unchecked: 0 });
  });

  it("re-marks a file unchecked after editing past a passing check", () => {
    const result = buildEditLedger([edit("a.ts"), { kind: "validation_pass" }, edit("a.ts")]);
    expect(result).toMatchObject({ edited: 1, unchecked: 1, latestUncheckedBasename: "a.ts" });
  });

  it("keeps counts exact past the identity cap while truncating detail", () => {
    const events = Array.from({ length: LEDGER_IDENTITY_CAP + 10 }, (_value, index) => edit(`file-${index}.ts`));
    const result = buildEditLedger(events);
    expect(result.edited).toBe(LEDGER_IDENTITY_CAP + 10);
    expect(result.unchecked).toBe(LEDGER_IDENTITY_CAP + 10);
    expect(result.entries).toHaveLength(LEDGER_IDENTITY_CAP);
  });
});

describe("store schema v2", () => {
  it("round-trips gauge fields and migrates version on first write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bb-cc-lite-gauge-store-"));
    try {
      const storePath = join(dir, "events.json");
      const decision: Decision = {
        state: "Careful",
        reasonCode: "edit_without_validation",
        primaryEvidence: "edits have not been checked",
        evidence: [{ label: "edits have not been checked" }],
        impact: "",
        action: "ask Claude to run the smallest relevant check",
        sessionKey: "sk-1",
        createdAt: "2026-06-10T00:00:00.000Z",
        schemaVersion: 2,
        projectKey: "a".repeat(64),
        light: "blue",
        activity: "editing",
        findings: [{ category: "edit_drift", severity: "blue", confidence: "medium", evidence: "edits unchecked since last check", fileHint: "auth.ts" }],
        ledger: [{ identityHash: "h1", basename: "auth.ts", edits: 1, unchecked: true }],
        files: { edited: 1, unchecked: 1, latestUncheckedBasename: "auth.ts" }
      };
      await recordDecision(decision, storePath);

      const store = await readStore(storePath);
      expect(store.version).toBe(2);
      const stored = store.decisions.at(-1);
      expect(stored).toMatchObject({
        schemaVersion: 2,
        projectKey: "a".repeat(64),
        light: "blue",
        activity: "editing",
        files: { edited: 1, unchecked: 1, latestUncheckedBasename: "auth.ts" }
      });
      expect(stored?.findings?.[0]).toMatchObject({ category: "edit_drift", severity: "blue" });
      expect(stored?.ledger?.[0]).toMatchObject({ identityHash: "h1", basename: "auth.ts", unchecked: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loads a pre-existing v1 store without error and reports version 1 until first write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bb-cc-lite-gauge-v1-"));
    try {
      const storePath = join(dir, "events.json");
      await writeFile(
        storePath,
        `${JSON.stringify({
          version: 1,
          updatedAt: "2026-05-19T12:00:00.000Z",
          decisions: [
            {
              id: "v1-decision",
              state: "Healthy",
              reasonCode: "healthy",
              primaryEvidence: "ctx 20%",
              evidence: [{ label: "ctx 20%" }],
              impact: "session stable",
              action: "continue normally",
              createdAt: "2026-05-19T12:00:00.000Z"
            }
          ],
          hookEvents: [],
          feedbackOutcomes: []
        })}\n`,
        "utf8"
      );

      const store = await readStore(storePath);
      expect(store.version).toBe(1);
      expect(store.decisions).toHaveLength(1);
      expect(store.decisions[0]).toMatchObject({ id: "v1-decision", state: "Healthy" });
      expect(store.decisions[0].light).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never cross-contaminates latest-decision queries between two projects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bb-cc-lite-gauge-two-writer-"));
    try {
      const storePath = join(dir, "events.json");
      const projectA = "a".repeat(64);
      const projectB = "b".repeat(64);
      const base = (projectKey: string, sessionKey: string, evidence: string): Decision => ({
        state: "Healthy",
        reasonCode: "healthy",
        primaryEvidence: evidence,
        evidence: [{ label: evidence }],
        impact: "",
        action: "continue normally",
        sessionKey,
        createdAt: "2026-06-10T00:00:00.000Z",
        schemaVersion: 2,
        projectKey,
        light: "green",
        activity: "idle",
        findings: [],
        ledger: [],
        files: { edited: 0, unchecked: 0 }
      });
      await recordDecision(base(projectA, "sa", "project A"), storePath);
      await recordDecision(base(projectB, "sb", "project B"), storePath);
      await recordDecision(base(projectA, "sa", "project A second"), storePath);

      expect((await latestProjectDecision(projectA, storePath))?.primaryEvidence).toBe("project A second");
      expect((await latestProjectDecision(projectB, storePath))?.primaryEvidence).toBe("project B");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}
