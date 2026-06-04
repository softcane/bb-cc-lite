import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyConfiguredValidationCommand,
  loadProjectConfig
} from "../src/project-config.js";
import { parseHookPayload } from "../src/hook-payload.js";
import { recordHookEvent } from "../src/store.js";
import { parseTranscriptLines } from "../src/transcript.js";

describe("project validation config", () => {
  it("loads .bb-cc-lite.json from cwd or nearest parent", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-project-config-"));
    try {
      const projectDir = join(tempDir, "project");
      const nestedDir = join(projectDir, "packages", "app");
      await mkdir(nestedDir, { recursive: true });
      await writeFile(
        join(projectDir, ".bb-cc-lite.json"),
        `${JSON.stringify({
          validationCommands: {
            tests: ["make test"],
            lint: ["just lint"],
            typecheck: ["make typecheck"],
            build: ["make build"]
          },
          validationPatterns: {
            tests: ["^mise run ci:test( |$)"],
            typecheck: ["^task types:check( |$)"]
          }
        })}\n`,
        "utf8"
      );

      const config = await loadProjectConfig(nestedDir);

      expect(config.validationCommands.tests).toEqual(["make test"]);
      expect(config.validationCommands.lint).toEqual(["just lint"]);
      expect(classifyConfiguredValidationCommand("make test --filter focused", config)).toBe("tests");
      expect(classifyConfiguredValidationCommand("mise run ci:test --filter focused", config)).toBe("tests");
      expect(classifyConfiguredValidationCommand("just lint", config)).toBe("lint");
      expect(classifyConfiguredValidationCommand("task types:check --watch=false", config)).toBe("typecheck");
      expect(classifyConfiguredValidationCommand("make build", config)).toBe("build");
      expect(classifyConfiguredValidationCommand("make test-other", config)).toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("ignores invalid JSON and unknown categories safely", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-project-config-invalid-"));
    try {
      const invalidDir = join(tempDir, "invalid");
      await mkdir(invalidDir, { recursive: true });
      await writeFile(join(invalidDir, ".bb-cc-lite.json"), "{not-json", "utf8");
      await expect(loadProjectConfig(invalidDir)).resolves.toMatchObject({ validationCommands: {} });

      const unknownDir = join(tempDir, "unknown");
      await mkdir(unknownDir, { recursive: true });
      await writeFile(
        join(unknownDir, ".bb-cc-lite.json"),
        `${JSON.stringify({
          validationCommands: {
            deploy: ["make deploy"],
            tests: ["make test"]
          }
        })}\n`,
        "utf8"
      );

      const config = await loadProjectConfig(unknownDir);
      expect(config.validationCommands).toEqual({ tests: ["make test"] });
      expect(config.validationPatterns).toEqual({});
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("classifies configured transcript commands without storing raw command strings", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-project-config-transcript-"));
    try {
      const projectDir = join(tempDir, "project");
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        join(projectDir, ".bb-cc-lite.json"),
        `${JSON.stringify({ validationCommands: { tests: ["make test"] } })}\n`,
        "utf8"
      );
      const config = await loadProjectConfig(projectDir);

      const summary = parseTranscriptLines([...failedCommandPair("make test", 1), ...failedCommandPair("make test", 2)], 0, {
        projectConfig: config
      });

      expect(summary.repeatedFailures).toEqual([{ toolName: "Bash", purpose: "tests", count: 2 }]);
      expect(summary.blindRetry).toMatchObject({ category: "tests", blindRetryFailureCount: 2 });
      expect(JSON.stringify(summary)).not.toContain("make test");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("classifies configured hook commands and keeps raw configured commands out of event history", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-cc-lite-project-config-hooks-"));
    try {
      const projectDir = join(tempDir, "project");
      const storePath = join(tempDir, "events.json");
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        join(projectDir, ".bb-cc-lite.json"),
        `${JSON.stringify({ validationCommands: { tests: ["make test"] } })}\n`,
        "utf8"
      );
      const config = await loadProjectConfig(projectDir);

      const event = parseHookPayload(
        JSON.stringify({
          session_id: "session-alpha",
          hook_event_name: "PostToolUseFailure",
          tool_name: "Bash",
          tool_input: {
            command: "make test --private-target"
          }
        }),
        undefined,
        { projectConfig: config }
      );
      if (!event) {
        throw new Error("expected hook event");
      }
      await recordHookEvent(event, storePath);

      expect(event).toMatchObject({ toolName: "Bash", purpose: "tests" });
      const storeText = await readFile(storePath, "utf8");
      expect(storeText).not.toContain("make test");
      expect(storeText).not.toContain("--private-target");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function failedCommandPair(command: string, index: number): string[] {
  return [
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: `bash-${index}`, name: "Bash", input: { command } }]
      }
    }),
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: `bash-${index}`, is_error: true, content: "failed" }]
      }
    })
  ];
}
