import { describe, expect, it } from "vitest";
import {
  classifyInstructionLine,
  coarseCategoryForFinding,
  correlateInstructions,
  instructionLinesFromFile,
  type InstructionWindow
} from "../src/instruction-correlator.js";

describe("instruction correlator", () => {
  it("maps stored finding categories to coarse buckets, ignoring plumbing categories", () => {
    expect(coarseCategoryForFinding("blind_retry_loop")).toBe("validation_retry");
    expect(coarseCategoryForFinding("edit_drift")).toBe("unchecked_edits");
    expect(coarseCategoryForFinding("redundant_read")).toBe("redundant_reads");
    expect(coarseCategoryForFinding("context_critical")).toBe("context_pressure");
    expect(coarseCategoryForFinding("statusline_input_unavailable")).toBeUndefined();
  });

  it("classifies instruction lines coarsely by keyword", () => {
    expect(classifyInstructionLine("Always run the failing tests before retrying")).toContain("validation_retry");
    expect(classifyInstructionLine("After changing code, run the smallest check")).toContain("unchecked_edits");
    expect(classifyInstructionLine("Do not reread the same file")).toContain("redundant_reads");
    expect(classifyInstructionLine("Write a handoff before compaction")).toContain("context_pressure");
    expect(classifyInstructionLine("Prefer kebab-case file names")).toEqual([]);
  });

  it("parses only correlatable lines and strips bullets, skipping headings and comments", () => {
    const content = ["# Heading", "", "<!-- comment -->", "- Reread the same file sparingly", "Prefer tabs"].join("\n");
    const lines = instructionLinesFromFile("./CLAUDE.md", content);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ file: "./CLAUDE.md", lineNumber: 4, text: "Reread the same file sparingly" });
  });

  it("flags a stale line, an apparently-followed line, and a gap", () => {
    const lines = [
      { file: "./CLAUDE.md", lineNumber: 2, text: "Reread the same file sparingly", categories: ["redundant_reads" as const] },
      { file: "./CLAUDE.md", lineNumber: 3, text: "After changing code, run the smallest check", categories: ["unchecked_edits" as const] }
    ];
    const window: InstructionWindow = {
      sessionCount: 10,
      categorySessions: { validation_retry: 6, unchecked_edits: 1 }
    };

    const result = correlateInstructions(lines, window);

    // redundant_reads never appeared -> the reread line is a removal candidate.
    expect(result.removalCandidates).toEqual([
      { file: "./CLAUDE.md", lineNumber: 2, text: "Reread the same file sparingly" }
    ]);
    // unchecked_edits appeared in only 1/10 sessions -> the edit line is apparently followed.
    expect(result.followed).toEqual([
      expect.objectContaining({ lineNumber: 3, category: "unchecked_edits", compliedSessions: 9, totalSessions: 10 })
    ]);
    // validation_retry seen >= 3 with no addressing line -> a gap.
    expect(result.gaps).toEqual([expect.objectContaining({ category: "validation_retry", seen: 6 })]);
  });

  it("suppresses every subsection when the window fully matches the instructions", () => {
    const lines = [
      { file: "./CLAUDE.md", lineNumber: 1, text: "Inspect failing tests before retrying", categories: ["validation_retry" as const] }
    ];
    const window: InstructionWindow = { sessionCount: 4, categorySessions: { validation_retry: 3 } };

    const result = correlateInstructions(lines, window);

    expect(result.removalCandidates).toEqual([]);
    expect(result.followed).toEqual([]);
    expect(result.gaps).toEqual([]);
  });
});
