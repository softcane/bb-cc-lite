import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { loadProjectConfig, type ProjectConfig, type ValidationCommandCategory } from "./project-config.js";

export type ValidationCommandSource = "ccverdict-config" | "package-script";

export interface ValidationCommand {
  category: ValidationCommandCategory;
  command: string;
  source: ValidationCommandSource;
}

export type WorkAreaId =
  | "gauge_statusline"
  | "audit_report"
  | "install_settings"
  | "transcript_parsing"
  | "hook_ingestion"
  | "pricing_cost"
  | "docs";

export interface WorkAreaProfile {
  id: WorkAreaId;
  label: string;
  sourceFiles: string[];
  testFiles: string[];
}

export interface RepoProfile {
  packageManager: "npm" | "pnpm" | "yarn" | "bun";
  packageScripts: Record<string, string>;
  validationCommands: ValidationCommand[];
  config: ProjectConfig;
  workAreas: WorkAreaProfile[];
  testFiles: string[];
  contextSources: string[];
  hasUsefulContext: boolean;
}

interface AgentsMapEntry {
  path: string;
  description: string;
  section: "source" | "test";
}

interface AreaDefinition {
  id: WorkAreaId;
  label: string;
  keywords: readonly string[];
  sourceBasenames: readonly string[];
  testBasenames: readonly string[];
}

const PACKAGE_JSON_MAX_BYTES = 128 * 1024;
const AGENTS_MAX_BYTES = 128 * 1024;
const MAX_FILES_TO_SCAN = 1_000;
const MAX_SCAN_DEPTH = 5;
const IGNORED_DIRS = new Set([".git", ".claude", "coverage", "dist", "node_modules"]);
const VALIDATION_ORDER: ValidationCommandCategory[] = ["typecheck", "lint", "tests", "build"];
const AREA_DEFINITIONS: AreaDefinition[] = [
  {
    id: "gauge_statusline",
    label: "gauge/statusline",
    keywords: ["gauge", "statusline", "status line", "finding", "signal", "renderer"],
    sourceBasenames: ["gauge.ts", "findings.ts", "gauge-renderer.ts", "signals.ts", "statusline.ts", "status-input.ts"],
    testBasenames: ["gauge.test.ts", "status-input.test.ts", "performance.test.ts"]
  },
  {
    id: "audit_report",
    label: "audit/report",
    keywords: ["audit", "instruction", "correlator", "feedback ledger", "report"],
    sourceBasenames: ["audit-report.ts", "audit.ts", "instruction-correlator.ts", "instruction-block.ts", "feedback-ledger.ts"],
    testBasenames: ["audit-report.test.ts", "instruction-correlator.test.ts", "feedback-ledger.test.ts"]
  },
  {
    id: "install_settings",
    label: "install/settings",
    keywords: ["install", "uninstall", "settings", "scope", "backup"],
    sourceBasenames: ["settings.ts", "cli.ts", "doctor.ts"],
    testBasenames: ["settings.test.ts", "doctor.test.ts", "cli-characterization.test.ts"]
  },
  {
    id: "transcript_parsing",
    label: "transcript parsing",
    keywords: ["transcript", "jsonl", "failure episode", "recovery"],
    sourceBasenames: ["transcript.ts", "transcript-reader.ts", "failure-episodes.ts", "recovery-stats.ts", "historical-replay.ts"],
    testBasenames: ["transcript.test.ts", "failure-episodes.test.ts", "recovery-stats.test.ts", "historical-replay.test.ts", "jsonl-replay.test.ts"]
  },
  {
    id: "hook_ingestion",
    label: "hook ingestion",
    keywords: ["hook", "payload", "feedback", "control"],
    sourceBasenames: ["hooks.ts", "hook-payload.ts", "hook-control.ts", "hook-response.ts", "hook-summary.ts"],
    testBasenames: ["hooks.test.ts", "hook-control.test.ts", "feedback-policy.test.ts", "feedback-outcomes.test.ts"]
  },
  {
    id: "pricing_cost",
    label: "pricing/cost",
    keywords: ["pricing", "cost", "litellm", "cache"],
    sourceBasenames: ["pricing.ts", "cache-efficiency.ts"],
    testBasenames: ["store-pricing.test.ts"]
  },
  {
    id: "docs",
    label: "docs",
    keywords: ["readme", "docs", "documentation"],
    sourceBasenames: ["README.md"],
    testBasenames: []
  }
];

export async function buildRepoProfile(projectDir = process.cwd()): Promise<RepoProfile> {
  const root = resolve(projectDir);
  const [packageInfo, config, agentsEntries, files] = await Promise.all([
    readPackageInfo(root),
    loadProjectConfig(root),
    readAgentsMap(root),
    collectFiles(root)
  ]);
  const validationCommands = validationCommandsFromConfig(config);
  validationCommands.push(...validationCommandsFromPackage(packageInfo.packageManager, packageInfo.scripts));
  const testFiles = stableTestFiles(files, agentsEntries);
  const workAreas = buildWorkAreas(files, agentsEntries);
  const contextSources = contextSourceLabels(packageInfo.scripts, config, agentsEntries, testFiles);
  return {
    packageManager: packageInfo.packageManager,
    packageScripts: packageInfo.scripts,
    validationCommands: dedupeValidationCommands(validationCommands),
    config,
    workAreas,
    testFiles,
    contextSources,
    hasUsefulContext: contextSources.length > 0
  };
}

export function emptyRepoProfile(): RepoProfile {
  return {
    packageManager: "npm",
    packageScripts: {},
    validationCommands: [],
    config: { validationCommands: {}, validationPatterns: {} },
    workAreas: [],
    testFiles: [],
    contextSources: [],
    hasUsefulContext: false
  };
}

export function workAreasForFileHint(profile: RepoProfile, fileHint: string | undefined): WorkAreaProfile[] {
  if (!fileHint || !isSafeRelativeFragment(fileHint)) {
    return [];
  }
  const hintBase = basename(fileHint);
  return profile.workAreas.filter((area) =>
    [...area.sourceFiles, ...area.testFiles].some((file) => basename(file) === hintBase)
  );
}

async function readPackageInfo(root: string): Promise<{ packageManager: RepoProfile["packageManager"]; scripts: Record<string, string> }> {
  const path = join(root, "package.json");
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > PACKAGE_JSON_MAX_BYTES) {
      return { packageManager: "npm", scripts: {} };
    }
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.scripts)) {
      return { packageManager: await detectPackageManager(root, parsed), scripts: {} };
    }
    const scripts: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed.scripts)) {
      if (typeof value === "string" && isSafeScriptName(name)) {
        scripts[name] = value;
      }
    }
    return { packageManager: await detectPackageManager(root, parsed), scripts };
  } catch {
    return { packageManager: "npm", scripts: {} };
  }
}

async function detectPackageManager(root: string, packageJson: unknown): Promise<RepoProfile["packageManager"]> {
  if (isRecord(packageJson) && typeof packageJson.packageManager === "string") {
    if (packageJson.packageManager.startsWith("pnpm@")) {
      return "pnpm";
    }
    if (packageJson.packageManager.startsWith("yarn@")) {
      return "yarn";
    }
    if (packageJson.packageManager.startsWith("bun@")) {
      return "bun";
    }
  }
  if (await fileExists(join(root, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (await fileExists(join(root, "yarn.lock"))) {
    return "yarn";
  }
  if (await fileExists(join(root, "bun.lockb"))) {
    return "bun";
  }
  return "npm";
}

function validationCommandsFromConfig(config: ProjectConfig): ValidationCommand[] {
  const commands: ValidationCommand[] = [];
  for (const category of VALIDATION_ORDER) {
    for (const command of config.validationCommands[category] || []) {
      if (isSafeLessonCommand(command)) {
        commands.push({ category, command, source: "ccverdict-config" });
      }
    }
  }
  return commands;
}

function validationCommandsFromPackage(
  packageManager: RepoProfile["packageManager"],
  scripts: Record<string, string>
): ValidationCommand[] {
  const commands: ValidationCommand[] = [];
  const scriptMap: Array<[ValidationCommandCategory, string]> = [
    ["typecheck", "typecheck"],
    ["lint", "lint"],
    ["tests", "test"],
    ["build", "build"]
  ];
  for (const [category, scriptName] of scriptMap) {
    if (scripts[scriptName] !== undefined) {
      commands.push({ category, command: packageScriptCommand(packageManager, scriptName), source: "package-script" });
    }
  }
  return commands;
}

function packageScriptCommand(packageManager: RepoProfile["packageManager"], scriptName: string): string {
  if (packageManager === "npm") {
    return scriptName === "test" ? "npm test" : `npm run ${scriptName}`;
  }
  return scriptName === "test" ? `${packageManager} test` : `${packageManager} run ${scriptName}`;
}

function dedupeValidationCommands(commands: ValidationCommand[]): ValidationCommand[] {
  const seen = new Set<string>();
  const result: ValidationCommand[] = [];
  for (const command of commands) {
    const key = `${command.category}:${command.command}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(command);
    }
  }
  return result;
}

async function readAgentsMap(root: string): Promise<AgentsMapEntry[]> {
  const path = join(root, "AGENTS.md");
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > AGENTS_MAX_BYTES) {
      return [];
    }
    return parseAgentsMap(await readFile(path, "utf8"));
  } catch {
    return [];
  }
}

export function parseAgentsMap(text: string): AgentsMapEntry[] {
  const entries: AgentsMapEntry[] = [];
  let section: AgentsMapEntry["section"] | undefined;
  for (const rawLine of text.split(/\r?\n/u)) {
    const heading = rawLine.match(/^##\s+(.+?)\s*$/u)?.[1]?.toLowerCase();
    if (heading) {
      section = heading === "source map" ? "source" : heading === "test map" ? "test" : undefined;
      continue;
    }
    if (!section) {
      continue;
    }
    const match = rawLine.match(/^-\s+`([^`]+)`:\s*(.+)$/u);
    if (!match) {
      continue;
    }
    const path = normalizeRelativePath(match[1]);
    if (path) {
      entries.push({ path, description: match[2].trim(), section });
    }
  }
  return entries;
}

function buildWorkAreas(files: readonly string[], agentsEntries: readonly AgentsMapEntry[]): WorkAreaProfile[] {
  return AREA_DEFINITIONS.map((definition) => {
    const sourceFiles = stableUnique([
      ...agentsEntries
        .filter((entry) => entry.section === "source" && entryMatchesDefinition(entry, definition))
        .map((entry) => entry.path),
      ...files.filter((file) => definition.sourceBasenames.includes(basename(file)))
    ]);
    const testFiles = stableUnique([
      ...agentsEntries
        .filter((entry) => entry.section === "test" && entryMatchesDefinition(entry, definition))
        .map((entry) => entry.path),
      ...files.filter((file) => definition.testBasenames.includes(basename(file)))
    ]);
    return { id: definition.id, label: definition.label, sourceFiles, testFiles };
  }).filter((area) => area.sourceFiles.length > 0 || area.testFiles.length > 0);
}

function entryMatchesDefinition(entry: AgentsMapEntry, definition: AreaDefinition): boolean {
  const entryBase = basename(entry.path);
  const text = `${entry.path} ${entry.description}`.toLowerCase();
  return (
    definition.sourceBasenames.includes(entryBase) ||
    definition.testBasenames.includes(entryBase) ||
    definition.keywords.some((keyword) => text.includes(keyword))
  );
}

function stableTestFiles(files: readonly string[], agentsEntries: readonly AgentsMapEntry[]): string[] {
  return stableUnique([
    ...agentsEntries.filter((entry) => entry.section === "test").map((entry) => entry.path),
    ...files.filter((file) => /^test\/.+\.test\.[cm]?[jt]s$/u.test(file))
  ]);
}

async function collectFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await collectFilesFrom(root, "", files, 0);
  return files.sort((left, right) => left.localeCompare(right));
}

async function collectFilesFrom(root: string, relativeDir: string, files: string[], depth: number): Promise<void> {
  if (files.length >= MAX_FILES_TO_SCAN || depth > MAX_SCAN_DEPTH) {
    return;
  }
  let entries;
  try {
    entries = await readdir(join(root, relativeDir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (files.length >= MAX_FILES_TO_SCAN) {
      return;
    }
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        await collectFilesFrom(root, relativePath, files, depth + 1);
      }
    } else if (entry.isFile()) {
      const normalized = normalizeRelativePath(relativePath);
      if (normalized) {
        files.push(normalized);
      }
    }
  }
}

function contextSourceLabels(
  scripts: Record<string, string>,
  config: ProjectConfig,
  agentsEntries: readonly AgentsMapEntry[],
  testFiles: readonly string[]
): string[] {
  const labels: string[] = [];
  if (Object.keys(scripts).some((script) => ["test", "lint", "typecheck", "build"].includes(script))) {
    labels.push("package.json scripts");
  }
  if (Object.values(config.validationCommands).some((commands) => (commands || []).length > 0)) {
    labels.push(".ccverdict.json validation commands");
  }
  if (agentsEntries.some((entry) => entry.section === "source")) {
    labels.push("AGENTS.md Source Map");
  }
  if (agentsEntries.some((entry) => entry.section === "test")) {
    labels.push("AGENTS.md Test Map");
  }
  if (testFiles.length > 0) {
    labels.push("test filenames");
  }
  return labels;
}

function stableUnique(values: readonly string[]): string[] {
  return [...new Set(values.filter(isSafeRelativeFragment))].sort((left, right) => left.localeCompare(right));
}

function normalizeRelativePath(path: string): string | undefined {
  const normalized = path.trim().replaceAll("\\", "/").replace(/^\.\/+/u, "");
  return isSafeRelativeFragment(normalized) ? normalized : undefined;
}

function isSafeRelativeFragment(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 160 &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:/u.test(value) &&
    !value.split("/").includes("..") &&
    !containsPrivacySentinel(value)
  );
}

function isSafeLessonCommand(value: string): boolean {
  return value.length > 0 && value.length <= 200 && !containsFullPath(value) && !containsPrivacySentinel(value);
}

function containsFullPath(value: string): boolean {
  return /(^|\s)(\/Users\/|\/tmp\/|\/private\/|[A-Za-z]:\\)/u.test(value);
}

function containsPrivacySentinel(value: string): boolean {
  return /RAW_|API[_-]?KEY|SECRET|TOKEN/u.test(value);
}

function isSafeScriptName(value: string): boolean {
  return /^[A-Za-z0-9:_-]{1,80}$/u.test(value);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
