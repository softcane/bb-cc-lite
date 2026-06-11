import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderAuditReport, runAuditReport } from "../src/audit-report.js";
import { projectKeyFromPath } from "../src/paths.js";
import { recordDecision, recordFeedbackOutcome } from "../src/store.js";
import type { Decision, Finding, LedgerEntry, StoredFeedbackOutcome } from "../src/types.js";

let tempDir: string;
let storePath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-audit-"));
  storePath = join(tempDir, "events.json");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("audit section 1 — current session", () => {
  it("shows only the current project's session and isolates a second project", async () => {
    const projectA = join(tempDir, "alpha");
    const projectB = join(tempDir, "beta");
    await seedDecision({ projectDir: projectA, sessionKey: "a1", reasonCode: "blind_retry_loop", findings: [redFinding()] });
    await seedDecision({ projectDir: projectB, sessionKey: "b1", reasonCode: "edit_without_validation", findings: [blueFinding()] });

    const reportA = await runAuditReport({ projectDir: projectA, homeDir: tempDir, storePath });
    const reportB = await runAuditReport({ projectDir: projectB, homeDir: tempDir, storePath });

    expect(reportA.session.hasHistory).toBe(true);
    expect(reportA.session.projectKey).toBe(projectKeyFromPath(projectA));
    expect(reportA.session.findings.map((finding) => finding.category)).toEqual(["blind_retry_loop"]);
    expect(reportB.session.findings.map((finding) => finding.category)).toEqual(["edit_drift"]);
    // Project A's red finding must never appear in project B's view.
    expect(reportB.session.reasonCode).not.toBe("blind_retry_loop");
  });

  it("prints an explicit empty state for a project with no history, never another project's session", async () => {
    const projectWith = join(tempDir, "with");
    const projectWithout = join(tempDir, "without");
    await seedDecision({ projectDir: projectWith, sessionKey: "w1", reasonCode: "blind_retry_loop", findings: [redFinding()] });

    const report = await runAuditReport({ projectDir: projectWithout, homeDir: tempDir, storePath });
    const text = renderAuditReport(report);

    expect(report.session.hasHistory).toBe(false);
    expect(text).toContain("No bb history for this project.");
    expect(text).not.toContain("blind_retry_loop");
  });

  it("renders all findings, the ledger table, and the feedback-outcome ledger with an age", async () => {
    const projectDir = join(tempDir, "rich");
    const ledger: LedgerEntry[] = [
      { identityHash: "h1", basename: "auth.ts", edits: 2, unchecked: true },
      { identityHash: "h2", basename: "utils.ts", edits: 1, unchecked: false }
    ];
    await seedDecision({
      projectDir,
      sessionKey: "rich-1",
      reasonCode: "blind_retry_loop",
      findings: [redFinding(), blueFinding()],
      ledger,
      createdAt: new Date(Date.now() - 12_000).toISOString()
    });
    await recordFeedbackOutcome(feedbackOutcome("rich-1"), storePath);

    const report = await runAuditReport({ projectDir, homeDir: tempDir, storePath });
    const text = renderAuditReport(report);

    expect(report.session.findings).toHaveLength(2);
    expect(report.session.ledger).toHaveLength(2);
    expect(report.session.feedbackOutcomes).toHaveLength(1);
    expect(text).toContain("blind_retry_loop: 3 fails, no fix between runs");
    expect(text).toContain("edit_drift: edits unchecked since last check");
    expect(text).toContain("auth.ts");
    expect(text).toContain("unchecked");
    expect(text).toContain("Recent bb loop:");
    expect(text).toMatch(/\d+s ago/u);
  });
});

describe("audit section 3 — instruction report", () => {
  it("yields removal, followed, and gap subsections with file+line citations", async () => {
    const projectDir = join(tempDir, "proj");
    // 4 sessions: 3 retry failures, 1 unchecked-edit -> validation_retry gap, unchecked mostly followed.
    await seedDecision({ projectDir, sessionKey: "s1", reasonCode: "blind_retry_loop", findings: [redFinding()] });
    await seedDecision({ projectDir, sessionKey: "s2", reasonCode: "blind_retry_loop", findings: [redFinding()] });
    await seedDecision({ projectDir, sessionKey: "s3", reasonCode: "blind_retry_loop", findings: [redFinding()] });
    await seedDecision({ projectDir, sessionKey: "s4", reasonCode: "edit_drift", findings: [blueFinding()] });
    await writeFileEnsured(
      join(projectDir, "CLAUDE.md"),
      ["# Project", "", "Keep this user line.", "- Use existing context before rereading the same file.", "- After changing code, run the smallest relevant check."].join("\n")
    );

    const report = await runAuditReport({ projectDir, homeDir: tempDir, storePath });
    const text = renderAuditReport(report);

    expect(report.instructions.removalCandidates).toEqual([
      expect.objectContaining({ file: "./CLAUDE.md", lineNumber: 4 })
    ]);
    expect(report.instructions.followed).toEqual([
      expect.objectContaining({ file: "./CLAUDE.md", lineNumber: 5, category: "unchecked_edits" })
    ]);
    expect(report.instructions.gaps).toEqual([expect.objectContaining({ category: "validation_retry" })]);
    expect(text).toContain("Candidates for removal:");
    expect(text).toContain("Apparently followed:");
    expect(text).toContain("Gaps:");
    expect(text).toContain("./CLAUDE.md:4");
  });

  it("emits no instruction subsections when CLAUDE.md fully matches the window", async () => {
    const projectDir = join(tempDir, "matched");
    await seedDecision({ projectDir, sessionKey: "m1", reasonCode: "blind_retry_loop", findings: [redFinding()] });
    await seedDecision({ projectDir, sessionKey: "m2", reasonCode: "blind_retry_loop", findings: [redFinding()] });
    await seedDecision({ projectDir, sessionKey: "m3", reasonCode: "blind_retry_loop", findings: [redFinding()] });
    await writeFileEnsured(join(projectDir, "CLAUDE.md"), "- Inspect failing tests before retrying.\n");

    const report = await runAuditReport({ projectDir, homeDir: tempDir, storePath });
    const text = renderAuditReport(report);

    expect(report.instructions.removalCandidates).toEqual([]);
    expect(report.instructions.followed).toEqual([]);
    expect(report.instructions.gaps).toEqual([]);
    expect(text).not.toContain("Candidates for removal:");
    expect(text).not.toContain("Apparently followed:");
    expect(text).not.toContain("Gaps:");
  });
});

describe("audit write behavior", () => {
  it("plain audit performs zero writes outside bb's store", async () => {
    const projectDir = join(tempDir, "frozen");
    await seedDecision({ projectDir, sessionKey: "f1", reasonCode: "blind_retry_loop", findings: [redFinding()] });
    await writeFileEnsured(join(projectDir, "CLAUDE.md"), "- Use existing context before rereading the same file.\n");
    const homeClaude = join(tempDir, "home", ".claude", "CLAUDE.md");
    await writeFileEnsured(homeClaude, "- Some global rule.\n");

    const before = await treeHash([projectDir, dirname(homeClaude)]);
    await runAuditReport({ projectDir, homeDir: join(tempDir, "home"), storePath });
    const after = await treeHash([projectDir, dirname(homeClaude)]);

    expect(after).toBe(before);
  });

  it("--apply prints a diff, writes only the marked block, backs up, routes to project, and is idempotent", async () => {
    const projectDir = join(tempDir, "apply");
    for (const sessionKey of ["a1", "a2", "a3"]) {
      await seedDecision({ projectDir, sessionKey, reasonCode: "blind_retry_loop", findings: [redFinding()] });
    }
    const claudePath = join(projectDir, "CLAUDE.md");
    await writeFileEnsured(claudePath, "# Project\n\nKeep this user line.\n");

    const report = await runAuditReport({ projectDir, homeDir: tempDir, storePath, apply: true, now: new Date("2026-06-10T00:00:00.000Z") });
    const text = renderAuditReport(report);
    const afterFirst = await readFile(claudePath, "utf8");
    const backups = (await readdir(projectDir)).filter((name) => name.startsWith("CLAUDE.md.bb-cc-lite-backup-"));

    expect(report.applied).toEqual([
      expect.objectContaining({ target: "project_claude", changed: true, backupCreated: true, blockAction: "created" })
    ]);
    expect(text).toContain("Proposed CLAUDE.md diff:");
    expect(text).toContain("+<!-- bb-cc-lite improve:start -->");
    expect(afterFirst).toContain("Keep this user line.");
    expect(afterFirst).toContain("<!-- bb-cc-lite improve:start -->");
    expect(afterFirst).toContain("- Inspect the first failure before rerunning a failed check.");
    expect(backups).toHaveLength(1);

    // Idempotent: a second apply with unchanged evidence does not modify the file again.
    await runAuditReport({ projectDir, homeDir: tempDir, storePath, apply: true, now: new Date("2026-06-10T01:00:00.000Z") });
    const afterSecond = await readFile(claudePath, "utf8");
    expect(afterSecond).toBe(afterFirst);
    expect((await readdir(projectDir)).filter((name) => name.startsWith("CLAUDE.md.bb-cc-lite-backup-"))).toHaveLength(1);
  });

  it("never modifies a user-authored line and surfaces removals only as commented proposals", async () => {
    const projectDir = join(tempDir, "removal");
    for (const sessionKey of ["r1", "r2", "r3"]) {
      await seedDecision({ projectDir, sessionKey, reasonCode: "blind_retry_loop", findings: [redFinding()] });
    }
    const claudePath = join(projectDir, "CLAUDE.md");
    await writeFileEnsured(claudePath, "- Use existing context before rereading the same file.\n");

    const report = await runAuditReport({ projectDir, homeDir: tempDir, storePath, apply: true });
    const text = renderAuditReport(report);
    const after = await readFile(claudePath, "utf8");

    expect(after).toContain("- Use existing context before rereading the same file.");
    expect(text).toContain("# proposed removal (not applied): ./CLAUDE.md:1");
  });

  it("--cleanup removes the marked block after a backup", async () => {
    const projectDir = join(tempDir, "cleanup");
    const claudePath = join(projectDir, "CLAUDE.md");
    await writeFileEnsured(
      claudePath,
      ["# Project", "", "Keep me.", "", "<!-- bb-cc-lite improve:start -->", "## bb-cc-lite lessons", "- Old rule.", "<!-- bb-cc-lite improve:end -->", ""].join("\n")
    );

    const report = await runAuditReport({ projectDir, homeDir: tempDir, storePath, cleanup: true, now: new Date("2026-06-10T02:00:00.000Z") });
    const after = await readFile(claudePath, "utf8");

    expect(report.applied).toEqual([
      expect.objectContaining({ target: "project_claude", changed: true, backupCreated: true, blockAction: "removed" })
    ]);
    expect(after).toContain("Keep me.");
    expect(after).not.toContain("bb-cc-lite improve:start");
  });
});

describe("mixed-history tolerance (PRD-03 DoD #4)", () => {
  it("audits a store with v1, 0.2-shape, and gauge-only records without error", async () => {
    const projectDir = join(tempDir, "mixed");
    await writeFile(
      storePath,
      `${JSON.stringify({
        version: 1,
        updatedAt: "2026-05-19T12:00:00.000Z",
        decisions: [
          { id: "v1", state: "Healthy", reasonCode: "healthy", primaryEvidence: "ctx 20%", evidence: [{ label: "ctx 20%" }], impact: "stable", action: "continue", createdAt: "2026-05-19T12:00:00.000Z" },
          {
            id: "v02",
            state: "Stop",
            reasonCode: "blind_retry_loop",
            primaryEvidence: "same test failed 3x",
            evidence: [{ label: "same test failed 3x" }],
            impact: "loop",
            action: "stop and inspect",
            createdAt: "2026-06-01T00:00:00.000Z",
            schemaVersion: 2,
            projectKey: projectKeyFromPath(projectDir),
            sessionKey: "v02",
            light: "red",
            activity: "retrying",
            findings: [{ category: "blind_retry_loop", severity: "red", confidence: "high", evidence: "3 fails, no fix between runs" }],
            ledger: [],
            files: { edited: 0, unchecked: 0 }
          },
          {
            id: "v04",
            createdAt: "2026-06-11T00:00:00.000Z",
            schemaVersion: 2,
            projectKey: projectKeyFromPath(projectDir),
            sessionKey: "v04",
            light: "blue",
            activity: "editing",
            findings: [{ category: "edit_drift", severity: "blue", confidence: "medium", evidence: "edits unchecked since last check" }],
            ledger: [],
            files: { edited: 1, unchecked: 1 }
          }
        ],
        hookEvents: [],
        feedbackOutcomes: []
      })}\n`,
      "utf8"
    );

    const report = await runAuditReport({ projectDir, homeDir: join(tempDir, "home"), storePath });
    const text = renderAuditReport(report);

    // Section 1 surfaces the latest gauge-only record for this project; no advisor crash on history.
    expect(report.session.hasHistory).toBe(true);
    expect(report.session.light).toBe("blue");
    expect(text).toContain("[1] Current session");
    expect(report.instructions.windowSessions).toBeGreaterThan(0);
  });
});

describe("audit vocabulary (grill H1)", () => {
  it("never emits Healthy/Careful/Stop state words in any section, text or --json", async () => {
    const projectDir = join(tempDir, "vocab");
    await seedDecision({ projectDir, sessionKey: "v1", reasonCode: "blind_retry_loop", findings: [redFinding()] });
    // A feedback outcome carrying advisor states must be scrubbed before it reaches an audit surface.
    await recordFeedbackOutcome(
      { ...feedbackOutcome("v1"), stateBefore: "Stop", stateAfter: "Healthy" },
      storePath
    );
    // A failing transcript under the project's Claude history gives section 2 a real pattern finding.
    const transcriptPath = join(
      tempDir,
      "home",
      ".claude",
      "projects",
      resolve(projectDir).replaceAll(/[\\/]/gu, "-"),
      "session.jsonl"
    );
    await writeFileEnsured(transcriptPath, repeatedFailedTestTranscript(3).join("\n"));

    const report = await runAuditReport({ projectDir, homeDir: join(tempDir, "home"), storePath });
    const text = renderAuditReport(report);
    const json = JSON.stringify(report);

    expect(report.patterns.findings.length).toBeGreaterThan(0);
    for (const surface of [text, json]) {
      for (const stateWord of ["Healthy", "Careful", "Stop"]) {
        expect(surface).not.toContain(stateWord);
      }
    }
    // Section 1 header is dot + light word + age, with no "(state)" parenthetical.
    expect(text).toMatch(/■ red · \d+s ago/u);
  });
});

function repeatedFailedTestTranscript(count: number): string[] {
  return Array.from({ length: count }, (_value, index) => index + 1).flatMap((index) => [
    JSON.stringify({
      timestamp: `2026-05-19T00:00:0${index}.000Z`,
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: `bash-test-${index}`, name: "Bash", input: { command: "npm test" } }] }
    }),
    JSON.stringify({
      timestamp: `2026-05-19T00:00:1${index}.000Z`,
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: `bash-test-${index}`, is_error: true, content: "failed" }] }
    })
  ]);
}

describe("audit --json", () => {
  it("covers all three sections and round-trips through JSON.parse", async () => {
    const projectDir = join(tempDir, "json");
    await seedDecision({ projectDir, sessionKey: "j1", reasonCode: "blind_retry_loop", findings: [redFinding()] });

    const report = await runAuditReport({ projectDir, homeDir: tempDir, storePath });
    const parsed = JSON.parse(JSON.stringify(report)) as typeof report;

    expect(parsed.kind).toBe("audit");
    expect(parsed.session.hasHistory).toBe(true);
    expect(parsed.patterns.kind).toBe("deep-advisory");
    expect(parsed.instructions).toHaveProperty("windowSessions");
  });
});

async function seedDecision(options: {
  projectDir: string;
  sessionKey: string;
  reasonCode: string;
  findings: Finding[];
  ledger?: LedgerEntry[];
  createdAt?: string;
}): Promise<void> {
  const decision: Decision = {
    state: options.findings.some((finding) => finding.severity === "red") ? "Stop" : "Careful",
    reasonCode: options.reasonCode,
    primaryEvidence: options.findings[0]?.evidence ?? "evidence",
    evidence: [{ label: options.findings[0]?.evidence ?? "evidence" }],
    impact: "impact",
    action: "action",
    createdAt: options.createdAt ?? new Date().toISOString(),
    schemaVersion: 2,
    projectKey: projectKeyFromPath(options.projectDir),
    sessionKey: options.sessionKey,
    light: options.findings.some((finding) => finding.severity === "red") ? "red" : "blue",
    findings: options.findings,
    ledger: options.ledger ?? []
  };
  await recordDecision(decision, storePath);
}

function redFinding(): Finding {
  return { category: "blind_retry_loop", severity: "red", confidence: "high", evidence: "3 fails, no fix between runs" };
}

function blueFinding(): Finding {
  return { category: "edit_drift", severity: "blue", confidence: "medium", evidence: "edits unchecked since last check" };
}

function feedbackOutcome(sessionKey: string): StoredFeedbackOutcome {
  return {
    id: "fo-1",
    kind: "feedback_outcome",
    sessionKey,
    feedbackAction: "coach",
    cooldownKey: "coach:edit_without_validation:edit",
    expectedAction: "run_validation",
    outcome: "resolved",
    timestamp: new Date().toISOString(),
    reasonCode: "edit_without_validation",
    safeCategory: "tests"
  };
}

async function writeFileEnsured(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function treeHash(roots: string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const root of roots) {
    await hashPath(resolve(root), hash);
  }
  return hash.digest("hex");
}

async function hashPath(path: string, hash: import("node:crypto").Hash): Promise<void> {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      await hashPath(child, hash);
    } else if (entry.isFile()) {
      const info = await stat(child);
      hash.update(`${child}:${info.size}:${await readFile(child, "utf8")}`);
    }
  }
}
