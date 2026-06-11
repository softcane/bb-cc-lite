import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planContextualLessons } from "../src/contextual-lessons.js";
import { buildRepoProfile, emptyRepoProfile } from "../src/repo-profile.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-lessons-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("repo profile", () => {
  it("profiles package scripts, AGENTS maps, and stable test names", async () => {
    const projectDir = join(tempDir, "profile");
    await mkdir(join(projectDir, "test"), { recursive: true });
    await writePackage(projectDir, { test: "vitest run", lint: "eslint .", typecheck: "tsc --noEmit", build: "tsc" });
    await writeFile(join(projectDir, "test", "audit-report.test.ts"), "", "utf8");
    await writeAgents(projectDir);

    const profile = await buildRepoProfile(projectDir);

    expect(profile.contextSources).toEqual(
      expect.arrayContaining(["package.json scripts", "AGENTS.md Source Map", "AGENTS.md Test Map", "test filenames"])
    );
    expect(profile.validationCommands).toEqual(
      expect.arrayContaining([
        { category: "tests", command: "npm test", source: "package-script" },
        { category: "lint", command: "npm run lint", source: "package-script" },
        { category: "typecheck", command: "npm run typecheck", source: "package-script" },
        { category: "build", command: "npm run build", source: "package-script" }
      ])
    );
    expect(profile.workAreas).toContainEqual(
      expect.objectContaining({ label: "audit/report", testFiles: expect.arrayContaining(["test/audit-report.test.ts"]) })
    );
  });

  it("profiles safe .bb-cc-lite.json validation commands before package scripts", async () => {
    const projectDir = join(tempDir, "config");
    await mkdir(projectDir, { recursive: true });
    await writePackage(projectDir, { test: "vitest run", typecheck: "tsc --noEmit" });
    await writeFile(
      join(projectDir, ".bb-cc-lite.json"),
      `${JSON.stringify({ validationCommands: { tests: ["make test"], typecheck: ["make typecheck"] } })}\n`,
      "utf8"
    );

    const profile = await buildRepoProfile(projectDir);
    const candidate = planContextualLessons({
      profile,
      gaps: [{ category: "unchecked_edits", label: "edits left unchecked", seen: 3 }],
      evidence: { unchecked_edits: { category: "unchecked_edits", seen: 3, fileHints: [] } }
    })[0];

    expect(profile.contextSources).toContain(".bb-cc-lite.json validation commands");
    expect(candidate?.text).toContain("`make test`");
    expect(candidate?.text).toContain("`make typecheck`");
  });
});

describe("contextual lesson planner", () => {
  it("falls back to the old generic lines when repo context is missing", () => {
    const candidates = planContextualLessons({
      profile: emptyRepoProfile(),
      gaps: [{ category: "validation_retry", label: "repeated validation/retry failures", seen: 3 }],
      evidence: { validation_retry: { category: "validation_retry", seen: 3, fileHints: [] } }
    });

    expect(candidates).toEqual([
      expect.objectContaining({
        source: "generic_fallback",
        text: "Inspect the first failure before rerunning a failed check."
      })
    ]);
  });

  it("writes contextual lessons for all coarse finding categories", async () => {
    const projectDir = join(tempDir, "categories");
    await mkdir(projectDir, { recursive: true });
    await writePackage(projectDir, { test: "vitest run", lint: "eslint .", typecheck: "tsc --noEmit", build: "tsc" });
    await writeAgents(projectDir);
    const profile = await buildRepoProfile(projectDir);

    const candidates = planContextualLessons({
      profile,
      gaps: [
        { category: "validation_retry", label: "repeated validation/retry failures", seen: 3 },
        { category: "unchecked_edits", label: "edits left unchecked", seen: 3 },
        { category: "redundant_reads", label: "rereading unchanged files", seen: 3 },
        { category: "context_pressure", label: "context pressure at compaction or stop", seen: 3 }
      ],
      evidence: {
        validation_retry: { category: "validation_retry", seen: 3, fileHints: ["audit-report.ts"] },
        unchecked_edits: { category: "unchecked_edits", seen: 3, fileHints: ["audit-report.ts"] },
        redundant_reads: { category: "redundant_reads", seen: 3, fileHints: ["instruction-correlator.ts"] },
        context_pressure: { category: "context_pressure", seen: 3, fileHints: [] }
      }
    });

    expect(candidates.map((candidate) => candidate.source)).toEqual(["contextual", "contextual", "contextual", "contextual"]);
    expect(candidates[0]?.text).toContain("Inspect the first failure before rerunning a failed check. For example, for audit/report validation failures");
    expect(candidates[1]?.text).toContain("After changing code, run the smallest relevant check before the full gate. For example, for audit/report changes");
    expect(candidates[2]?.text).toContain("Use existing context before rereading the same unchanged file. For example, for audit/report, use the repo Source Map and Test Map before rereading unchanged files");
    expect(candidates[3]?.text).toContain("Write a short handoff with open risks before compaction or stopping. For example, for handoffs, record the current finding, next check, and open risks");
    for (const candidate of candidates) {
      expect(candidate.text).not.toContain("audit-report.ts");
    }
  });

  it("does not copy privacy sentinels or unsafe configured commands into lessons", async () => {
    const projectDir = join(tempDir, "privacy");
    await mkdir(projectDir, { recursive: true });
    await writePackage(projectDir, { test: "vitest run" });
    await writeAgents(projectDir);
    await writeFile(
      join(projectDir, ".bb-cc-lite.json"),
      `${JSON.stringify({ validationCommands: { tests: ["BB_CC_LITE_RAW_COMMAND_SENTINEL --secret"] } })}\n`,
      "utf8"
    );
    const profile = await buildRepoProfile(projectDir);

    const candidate = planContextualLessons({
      profile,
      gaps: [{ category: "validation_retry", label: "repeated validation/retry failures", seen: 3 }],
      evidence: {
        validation_retry: {
          category: "validation_retry",
          seen: 3,
          fileHints: ["/tmp/bb-cc-lite/private/worktree/src/secret.ts", "audit-report.ts"]
        }
      }
    })[0];

    expect(candidate?.text).toContain("`npm test -- test/audit-report.test.ts test/instruction-correlator.test.ts`");
    expect(candidate?.text).not.toContain("BB_CC_LITE_RAW_COMMAND_SENTINEL");
    expect(candidate?.text).not.toContain("/tmp/bb-cc-lite/private/worktree");
    expect(candidate?.text).not.toContain("secret.ts");
  });
});

async function writePackage(projectDir: string, scripts: Record<string, string>): Promise<void> {
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, "package.json"), `${JSON.stringify({ type: "module", scripts }, null, 2)}\n`, "utf8");
}

async function writeAgents(projectDir: string): Promise<void> {
  await writeFile(
    join(projectDir, "AGENTS.md"),
    [
      "# Agent Map",
      "",
      "## Source Map",
      "",
      "- `src/audit-report.ts`: audit/report behavior.",
      "- `src/instruction-correlator.ts`: instruction report matching.",
      "",
      "## Test Map",
      "",
      "- `test/audit-report.test.ts`: audit/report tests.",
      "- `test/instruction-correlator.test.ts`: instruction report tests."
    ].join("\n"),
    "utf8"
  );
}
