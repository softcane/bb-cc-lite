import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTempWorkspace, removeTempWorkspace, type TempWorkspace } from "./helpers/temp.js";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const tscPath = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));

const privacySentinels = [
  "BB_CC_LITE_RAW_PROMPT_SENTINEL",
  "BB_CC_LITE_TOOL_OUTPUT_SENTINEL",
  "BB_CC_LITE_API_KEY_SENTINEL",
  "BB_CC_LITE_FILE_CONTENT_SENTINEL",
  "/tmp/bb-cc-lite/private/worktree/src/secret.ts"
];

interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
}

let compiledRoot: string | undefined;
let cliPath: string | undefined;

beforeAll(async () => {
  compiledRoot = await mkdtemp(join(tmpdir(), "bb-cc-lite-cli-build-"));
  await writeFile(join(compiledRoot, "package.json"), '{"type":"module"}\n', "utf8");
  const distDir = join(compiledRoot, "dist");
  const result = await runProcess(process.execPath, [tscPath, "-p", "tsconfig.json", "--outDir", distDir], {
    cwd: repoRoot
  });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to compile CLI fixture:\n${result.stdout}\n${result.stderr}`);
  }
  cliPath = join(distDir, "cli.js");
}, 30_000);

afterAll(async () => {
  if (compiledRoot) {
    await rm(compiledRoot, { recursive: true, force: true });
  }
});

describe("CLI behavior characterization", () => {
  it("records and explains a healthy statusline decision without leaking private fields", async () => {
    const workspace = await createTempWorkspace();
    try {
      const sessionId = `session-${privacySentinels[0]}`;
      const env = cliEnv(workspace);

      const statusline = await runCli(["statusline"], {
        env,
        input: statusInput({
          session_id: sessionId,
          context_window: {
            used_tokens: 84_000,
            total: 200_000
          },
          cost: {
            total_cost_usd: 0.0421
          },
          usage: {
            cache_creation_input_tokens: 200,
            cache_read_input_tokens: 900
          },
          terminal_width: 180
        })
      });

      expect(statusline.exitCode).toBe(0);
      expect(statusline.stderr).toBe("");
      expect(statusline.stdout.trim()).toContain("bb: Healthy");
      expect(statusline.stdout).toContain("ctx 42%");
      expect(statusline.stdout).toContain("cache warm");
      expect(statusline.stdout).toContain("continue normally");

      const why = await runCli(["why"], { env });
      expect(why.exitCode).toBe(0);
      expect(why.stdout).toContain("Last decision: Healthy.");
      expect(why.stdout).toContain("Reason: ctx 42%. cache warm.");
      expect(why.stdout).toContain("Next action: continue normally.");
      expect(why.stdout).toContain("Cost evidence: $0.0421.");

      const whyJson = await runCli(["why", "--json"], { env });
      expect(whyJson.exitCode).toBe(0);
      const parsedWhy = JSON.parse(whyJson.stdout) as { state: string; reasonCode: string; sessionKey?: string };
      expect(parsedWhy).toMatchObject({
        state: "Healthy",
        reasonCode: "healthy"
      });
      expect(parsedWhy.sessionKey).toEqual(expect.any(String));

      const storeText = await readFile(env.BB_CC_LITE_STORE as string, "utf8");
      expectNoPrivacySentinels(statusline.stdout, why.stdout, whyJson.stdout, storeText);
    } finally {
      await removeTempWorkspace(workspace);
    }
  });

  it("keeps careful statusline output width-aware", async () => {
    const workspace = await createTempWorkspace();
    try {
      const statusline = await runCli(["statusline"], {
        env: cliEnv(workspace),
        input: statusInput({
          session_id: "session-careful",
          context_window: {
            used_tokens: 164_000,
            total: 200_000
          },
          terminal_width: 55
        })
      });

      const rendered = statusline.stdout.trim();
      expect(statusline.exitCode).toBe(0);
      expect(visibleLength(rendered)).toBeLessThanOrEqual(55);
      expect(rendered).toContain("bb: Careful");
      expect(rendered).toMatch(/\.\.\.$/u);
      expectNoPrivacySentinels(rendered, await readFile(cliEnv(workspace).BB_CC_LITE_STORE as string, "utf8"));
    } finally {
      await removeTempWorkspace(workspace);
    }
  });

  it("renders Stop with inline why and lets why target an older explicit session", async () => {
    const workspace = await createTempWorkspace();
    try {
      const env = cliEnv(workspace);
      const stopSessionId = "session-stop";
      const transcriptPath = join(workspace.root, "transcripts", "stop.jsonl");
      await writeTranscript(transcriptPath, repeatedFailedTestTranscript(3));

      const stop = await runCli(["statusline"], {
        env,
        input: statusInput({
          session_id: stopSessionId,
          transcript_path: transcriptPath,
          terminal_width: 180
        })
      });

      expect(stop.exitCode).toBe(0);
      expect(stop.stdout).toContain("bb: Stop");
      expect(stop.stdout).toContain("why: Bash failed 3x running tests");
      expect(stop.stdout).toContain("do: fix the test setup manually, then ask Claude to rerun only that test");

      const latest = await runCli(["statusline"], {
        env,
        input: statusInput({
          session_id: "session-latest",
          context_window: {
            used_tokens: 20_000,
            total: 200_000
          },
          terminal_width: 180
        })
      });
      expect(latest.exitCode).toBe(0);
      expect(latest.stdout).toContain("bb: Healthy");

      const whyLatest = await runCli(["why"], { env });
      expect(whyLatest.exitCode).toBe(0);
      expect(whyLatest.stdout).toContain("Last decision: Healthy.");

      const whyStop = await runCli(["why", "--session", stopSessionId], { env });
      expect(whyStop.exitCode).toBe(0);
      expect(whyStop.stdout).toContain("Last decision: Stop.");
      expect(whyStop.stdout).toContain("Reason: Bash failed 3x running tests. Claude is retrying a broken test loop.");
      expect(whyStop.stdout).toContain(
        "Next action: fix the test setup manually, then ask Claude to rerun only that test."
      );

      const whyJson = await runCli(["why", "--session", stopSessionId, "--json"], { env });
      expect(whyJson.exitCode).toBe(0);
      expect(JSON.parse(whyJson.stdout)).toMatchObject({
        state: "Stop",
        reasonCode: "repeated_tool_failure",
        primaryEvidence: "Bash failed 3x running tests"
      });

      const storeText = await readFile(env.BB_CC_LITE_STORE as string, "utf8");
      expectNoPrivacySentinels(stop.stdout, latest.stdout, whyLatest.stdout, whyStop.stdout, whyJson.stdout, storeText);
    } finally {
      await removeTempWorkspace(workspace);
    }
  });

  it("characterizes fixture-based status states through the CLI path", async () => {
    const cases: Array<{
      name: string;
      input: Record<string, unknown>;
      transcript?: string[];
      expected: string[];
    }> = [
      {
        name: "fresh/simple session",
        input: {
          session_id: "fixture-fresh",
          terminal_width: 180
        },
        expected: ["bb: Healthy", "no stop-level findings", "session stable", "continue normally"]
      },
      {
        name: "two repeated failed test commands",
        input: {
          session_id: "fixture-two-failures",
          terminal_width: 180
        },
        transcript: repeatedFailedTestTranscript(2),
        expected: ["bb: Careful", "Bash failed 2x running tests", "pause and inspect the failing test before another retry"]
      },
      {
        name: "three repeated failed test commands",
        input: {
          session_id: "fixture-three-failures",
          terminal_width: 180
        },
        transcript: repeatedFailedTestTranscript(3),
        expected: [
          "bb: Stop",
          "why: Bash failed 3x running tests",
          "do: fix the test setup manually, then ask Claude to rerun only that test"
        ]
      },
      {
        name: "high context",
        input: {
          session_id: "fixture-high-context",
          context_window: {
            used_tokens: 164_000,
            total: 200_000
          },
          terminal_width: 180
        },
        expected: ["bb: Careful", "ctx 82%", "ask Claude for a 6-bullet handoff before more work"]
      },
      {
        name: "cache risk",
        input: {
          session_id: "fixture-cache-risk",
          usage: {
            cache_creation_input_tokens: 50_000,
            cache_read_input_tokens: 100
          },
          terminal_width: 180
        },
        expected: ["bb: Careful", "cache writes high", "keep the next prompt narrow and avoid broad repo scans"]
      },
      {
        name: "compaction event",
        input: {
          session_id: "fixture-compaction",
          terminal_width: 180
        },
        transcript: compactionTranscript(),
        expected: ["bb: Careful", "compaction event seen", "ask Claude to restate current goal and next 3 steps"]
      },
      {
        name: "malformed transcript",
        input: {
          session_id: "fixture-malformed",
          terminal_width: 180
        },
        transcript: ["not-json", "{\"type\":\"assistant\""],
        expected: ["bb: Healthy", "continue normally"]
      },
      {
        name: "missing transcript",
        input: {
          session_id: "fixture-missing",
          transcript_path: "/tmp/bb-cc-lite/missing/transcript.jsonl",
          terminal_width: 180
        },
        expected: ["bb: Healthy", "continue normally"]
      }
    ];

    for (const testCase of cases) {
      const workspace = await createTempWorkspace();
      try {
        const env = cliEnv(workspace);
        const input = { ...testCase.input };
        if (testCase.transcript) {
          const transcriptPath = join(workspace.root, "transcripts", `${testCase.name.replaceAll(/\W+/gu, "-")}.jsonl`);
          await writeTranscript(transcriptPath, testCase.transcript);
          input.transcript_path = transcriptPath;
        }

        const statusline = await runCli(["statusline"], {
          env,
          input: statusInput(input)
        });

        expect(statusline.exitCode, testCase.name).toBe(0);
        expect(statusline.stderr, testCase.name).toBe("");
        expect(statusline.stdout, testCase.name).not.toContain("statusline crashed");
        for (const expected of testCase.expected) {
          expect(statusline.stdout, testCase.name).toContain(expected);
        }
        expectNoPrivacySentinels(statusline.stdout, await readFile(env.BB_CC_LITE_STORE as string, "utf8"));
      } finally {
        await removeTempWorkspace(workspace);
      }
    }
  });
});

function cliEnv(workspace: TempWorkspace): NodeJS.ProcessEnv {
  return {
    ...process.env,
    BB_CC_LITE_COLOR: "0",
    BB_CC_LITE_HOME: workspace.appHome,
    BB_CC_LITE_STORE: join(workspace.appHome, "events.json")
  };
}

function statusInput(overrides: Record<string, unknown>): string {
  return `${JSON.stringify({
    session_id: "session-default",
    cwd: privacySentinels[4],
    model: {
      id: "claude-sonnet-4-5",
      display_name: "Claude Sonnet 4.5"
    },
    raw_prompt: privacySentinels[0],
    tool_output: privacySentinels[1],
    file_contents: privacySentinels[3],
    environment: {
      ANTHROPIC_API_KEY: privacySentinels[2]
    },
    ...overrides
  })}\n`;
}

function repeatedFailedTestTranscript(count: number): string[] {
  return Array.from({ length: count }, (_value, index) => index + 1).flatMap((index) => [
    JSON.stringify({
      timestamp: `2026-05-19T00:00:0${index}.000Z`,
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: `bash-test-${index}`,
            name: "Bash",
            input: {
              command: `npm test -- ${privacySentinels[0]}`
            }
          }
        ]
      }
    }),
    JSON.stringify({
      timestamp: `2026-05-19T00:00:1${index}.000Z`,
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: `bash-test-${index}`,
            is_error: true,
            content: `failed test output ${privacySentinels[1]} ${privacySentinels[2]} ${privacySentinels[3]} ${privacySentinels[4]}`
          }
        ]
      }
    })
  ]);
}

function compactionTranscript(): string[] {
  return [
    JSON.stringify({
      timestamp: "2026-05-19T00:01:00.000Z",
      type: "PostCompact",
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 50
      },
      content: privacySentinels[3]
    })
  ];
}

async function writeTranscript(path: string, lines: string[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
}

async function runCli(args: string[], options: RunOptions = {}): Promise<ProcessResult> {
  if (!cliPath) {
    throw new Error("CLI fixture was not compiled");
  }
  return runProcess(process.execPath, [cliPath, ...args], options);
}

async function runProcess(command: string, args: string[], options: RunOptions = {}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || repoRoot,
      env: options.env || process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode: exitCode ?? 0 });
    });
    child.stdin.end(options.input || "");
  });
}

function visibleLength(value: string): number {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;]*m/gu, "").length;
}

function expectNoPrivacySentinels(...values: unknown[]): void {
  const serialized = values.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join("\n");
  for (const sentinel of privacySentinels) {
    expect(serialized).not.toContain(sentinel);
  }
}
