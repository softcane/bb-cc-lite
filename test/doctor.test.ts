import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatDoctorChecks, runDoctor, type DoctorCheck } from "../src/doctor.js";
import { installStatusLine, resolveSettingsTarget } from "../src/settings.js";
import {
  createTempWorkspace,
  removeTempWorkspace,
  setIsolatedEnv,
  type TempWorkspace,
  writeJson
} from "./helpers/temp.js";

describe("doctor", () => {
  let workspace: TempWorkspace | undefined;
  let restoreEnv: (() => void) | undefined;

  beforeEach(async () => {
    workspace = await createTempWorkspace();
    restoreEnv = setIsolatedEnv({
      BB_CC_LITE_HOME: workspace.appHome,
      BB_CC_LITE_PRICING_CACHE: join(workspace.appHome, "pricing.json"),
      ANTHROPIC_BASE_URL: undefined
    });
  });

  afterEach(async () => {
    restoreEnv?.();
    await removeTempWorkspace(workspace);
  });

  it("reports OK checks for installed settings, readable transcript, and cached pricing", async () => {
    const dirs = mustHaveWorkspace(workspace);
    const transcriptPath = join(dirs.root, "transcript.jsonl");
    await installStatusLine({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir,
      cliFilePath: await createFakeRuntime(dirs.root)
    });
    await Promise.all([
      writeFile(transcriptPath, "{}", "utf8"),
      writeFile(process.env.BB_CC_LITE_PRICING_CACHE as string, '{"models":{}}\n', "utf8")
    ]);

    const checks = await runDoctor({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir,
      transcriptPath
    });

    expect(findCheck(checks, "settings")).toMatchObject({ level: "OK" });
    expect(findCheck(checks, "hooks")).toMatchObject({ level: "WARN" });
    expect(findCheck(checks, "transcript")).toMatchObject({ level: "OK" });
    expect(findCheck(checks, "litellm-pricing")).toMatchObject({ level: "OK" });
    expect(findCheck(checks, "anthropic-base-url")).toMatchObject({ level: "OK" });
    expect(checks.some((check) => check.level === "FAIL")).toBe(false);
  });

  it("reports OK for optional hooks when install --hooks was used", async () => {
    const dirs = mustHaveWorkspace(workspace);
    await installStatusLine({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir,
      cliFilePath: await createFakeRuntime(dirs.root),
      hooks: true
    });

    const checks = await runDoctor({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir
    });

    expect(findCheck(checks, "hooks")).toMatchObject({ level: "OK" });
  });

  it("warns on custom settings and missing pricing cache while failing an unreadable transcript", async () => {
    const dirs = mustHaveWorkspace(workspace);
    const target = resolveSettingsTarget({ projectDir: dirs.projectDir, homeDir: dirs.homeDir });
    await writeJson(target.settingsPath, {
      statusLine: {
        type: "command",
        command: "custom-statusline"
      }
    });

    const checks = await runDoctor({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir,
      transcriptPath: join(dirs.root, "missing-transcript.jsonl")
    });

    expect(findCheck(checks, "settings")).toMatchObject({ level: "WARN" });
    expect(findCheck(checks, "settings").message).toContain("custom statusLine");
    expect(findCheck(checks, "transcript")).toMatchObject({ level: "FAIL" });
    expect(findCheck(checks, "litellm-pricing")).toMatchObject({ level: "WARN" });
  });

  it("formats checks", () => {
    expect(formatDoctorChecks([{ level: "OK", name: "sample", message: "ready" }])).toBe("OK sample: ready");
  });

  it("warns when ANTHROPIC_BASE_URL points at a custom endpoint", async () => {
    const dirs = mustHaveWorkspace(workspace);
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:10000";

    const checks = await runDoctor({
      projectDir: dirs.projectDir,
      homeDir: dirs.homeDir
    });

    expect(findCheck(checks, "anthropic-base-url")).toMatchObject({
      level: "WARN",
      message: expect.stringContaining("127.0.0.1:10000")
    });
  });
});

function findCheck(checks: DoctorCheck[], name: string): DoctorCheck {
  const check = checks.find((candidate) => candidate.name === name);
  if (!check) {
    throw new Error(`Missing doctor check: ${name}`);
  }
  return check;
}

function mustHaveWorkspace(workspace: TempWorkspace | undefined): TempWorkspace {
  if (!workspace) {
    throw new Error("test workspace was not initialized");
  }
  return workspace;
}

async function createFakeRuntime(root: string): Promise<string> {
  const distDir = join(root, `dist-${randomUUID()}`);
  await mkdir(distDir, { recursive: true });
  await writeFile(join(distDir, "cli.js"), "console.log('fake bb-cc-lite runtime');\n", "utf8");
  return join(distDir, "cli.js");
}
