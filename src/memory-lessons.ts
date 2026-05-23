import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { appHome } from "./paths.js";
import type { DecisionConfidence, TranscriptSummary } from "./types.js";

export const LESSON_MEMORY_DIR_NAME = "project-lessons";
export const LESSON_MEMORY_SCHEMA = "bb-cc-lite.lesson-memory.v1";
export const LESSON_CARD_SCHEMA = "bb-cc-lite.lesson-card.v1";
export const LESSON_MEMORY_VERSION = 1;
const LESSON_MEMORY_MAX_BYTES = 64 * 1024;
const LESSON_DECAY_MS = 30 * 24 * 60 * 60 * 1000;

type LessonSafeCategory = "tests" | "lint" | "typecheck" | "build";

export interface LessonEvidenceCounts {
  failures: number;
  sessions: number;
}

export interface LessonCard {
  schema: typeof LESSON_CARD_SCHEMA;
  lessonId: string;
  projectKey: string;
  reasonCode: string;
  safeCategory: LessonSafeCategory;
  confidence: DecisionConfidence;
  evidenceCounts: LessonEvidenceCounts;
  createdAt: string;
  updatedAt: string;
  decayAt: string;
  wordingKey: string;
}

export interface ProjectLessonMemory {
  schema: typeof LESSON_MEMORY_SCHEMA;
  version: typeof LESSON_MEMORY_VERSION;
  projectKey: string;
  updatedAt: string;
  lessons: LessonCard[];
}

export interface LessonMemoryPathOptions {
  projectKey: string;
  homeDir?: string;
  appHomePath?: string;
}

export function lessonMemoryPath(options: LessonMemoryPathOptions): string {
  assertProjectKey(options.projectKey);
  return join(options.appHomePath ?? appHome(options.homeDir), LESSON_MEMORY_DIR_NAME, `${options.projectKey}.json`);
}

export async function recordLessonFromSummary(options: {
  projectKey: string;
  summary: TranscriptSummary;
  homeDir?: string;
  appHomePath?: string;
  now?: Date;
}): Promise<LessonCard | undefined> {
  const candidate = lessonCandidate(options.projectKey, options.summary, options.now ?? new Date());
  if (!candidate) {
    return undefined;
  }

  const memoryPath = lessonMemoryPath(options);
  const existing = await readLessonMemory({ ...options, projectKey: options.projectKey });
  const lessons = existing?.lessons.filter((lesson) => lesson.lessonId !== candidate.lessonId) ?? [];
  const previous = existing?.lessons.find((lesson) => lesson.lessonId === candidate.lessonId);
  const next: LessonCard = {
    ...candidate,
    createdAt: previous?.createdAt || candidate.createdAt,
    evidenceCounts: {
      failures: Math.max(previous?.evidenceCounts.failures || 0, candidate.evidenceCounts.failures),
      sessions: Math.max(previous?.evidenceCounts.sessions || 0, candidate.evidenceCounts.sessions)
    }
  };
  const memory: ProjectLessonMemory = {
    schema: LESSON_MEMORY_SCHEMA,
    version: LESSON_MEMORY_VERSION,
    projectKey: options.projectKey,
    updatedAt: next.updatedAt,
    lessons: [...lessons, next].sort((left, right) => left.lessonId.localeCompare(right.lessonId))
  };
  await writeLessonMemory(memory, memoryPath);
  return next;
}

export async function lessonContextForProject(options: {
  projectKey: string;
  homeDir?: string;
  appHomePath?: string;
  now?: Date;
}): Promise<string | undefined> {
  const now = options.now ?? new Date();
  const memory = await readLessonMemory(options);
  if (!memory) {
    return undefined;
  }
  const active = memory.lessons.filter((lesson) => !isExpired(lesson, now));
  if (active.length !== memory.lessons.length) {
    await writeLessonMemory({ ...memory, updatedAt: now.toISOString(), lessons: active }, lessonMemoryPath(options));
  }
  const selected = active
    .filter((lesson) => lesson.confidence !== "low" && lesson.evidenceCounts.failures >= 3)
    .sort((left, right) => right.evidenceCounts.failures - left.evidenceCounts.failures)[0];
  if (!selected) {
    return undefined;
  }
  return lessonMessage(selected.wordingKey);
}

export async function clearLessonMemory(options: { homeDir?: string; appHomePath?: string } = {}): Promise<void> {
  await rm(join(options.appHomePath ?? appHome(options.homeDir), LESSON_MEMORY_DIR_NAME), { recursive: true, force: true });
}

async function readLessonMemory(options: LessonMemoryPathOptions): Promise<ProjectLessonMemory | undefined> {
  try {
    const path = lessonMemoryPath(options);
    const fileStat = await stat(path);
    if (!fileStat.isFile() || fileStat.size > LESSON_MEMORY_MAX_BYTES) {
      return undefined;
    }
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return isProjectLessonMemory(parsed, options.projectKey) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function writeLessonMemory(memory: ProjectLessonMemory, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(memory, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(tempPath, 0o600);
  await rename(tempPath, path);
}

function lessonCandidate(projectKey: string, summary: TranscriptSummary, now: Date): LessonCard | undefined {
  assertProjectKey(projectKey);
  const strongest = strongestValidationFailure(summary);
  if (!strongest || strongest.failures < 2) {
    return undefined;
  }
  const timestamp = now.toISOString();
  const confidence: DecisionConfidence = strongest.failures >= 3 ? "high" : "low";
  return {
    schema: LESSON_CARD_SCHEMA,
    lessonId: `validation_repeated:${strongest.safeCategory}`,
    projectKey,
    reasonCode: "validation_repeated",
    safeCategory: strongest.safeCategory,
    confidence,
    evidenceCounts: {
      failures: strongest.failures,
      sessions: 1
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    decayAt: new Date(now.getTime() + LESSON_DECAY_MS).toISOString(),
    wordingKey: `validation_repeated:${strongest.safeCategory}`
  };
}

function strongestValidationFailure(summary: TranscriptSummary): { safeCategory: LessonSafeCategory; failures: number } | undefined {
  const blindRetry = summary.blindRetry;
  const blindRetryCategory = lessonCategory(blindRetry?.category);
  const blindRetryCandidate =
    blindRetry && blindRetryCategory
      ? {
          safeCategory: blindRetryCategory,
          failures: blindRetry.blindRetryFailureCount
        }
      : undefined;
  const repeatedCandidate = summary.repeatedFailures
    .flatMap((failure) => {
      const category = failure.toolName === "Bash" ? lessonCategory(failure.purpose) : undefined;
      return category ? [{ safeCategory: category, failures: failure.count }] : [];
    })
    .sort((left, right) => right.failures - left.failures)[0];

  if (blindRetryCandidate && repeatedCandidate) {
    return blindRetryCandidate.failures >= repeatedCandidate.failures ? blindRetryCandidate : repeatedCandidate;
  }
  return blindRetryCandidate || repeatedCandidate;
}

function lessonCategory(value: string | undefined): LessonSafeCategory | undefined {
  return value === "tests" || value === "lint" || value === "typecheck" || value === "build" ? value : undefined;
}

function isExpired(lesson: LessonCard, now: Date): boolean {
  const decayAtMs = Date.parse(lesson.decayAt);
  return !Number.isFinite(decayAtMs) || decayAtMs <= now.getTime();
}

function lessonMessage(wordingKey: string): string | undefined {
  if (wordingKey.startsWith("validation_repeated:")) {
    return "bb-cc-lite lesson: similar validation retries in this project rarely recovered after repeated failures. Inspect the first failure, make one targeted fix, then run one focused check.";
  }
  return undefined;
}

function isProjectLessonMemory(value: unknown, projectKey: string): value is ProjectLessonMemory {
  const root = asRecord(value);
  if (
    !root ||
    !hasOnlyKeys(root, MEMORY_KEYS) ||
    root.schema !== LESSON_MEMORY_SCHEMA ||
    root.version !== LESSON_MEMORY_VERSION ||
    root.projectKey !== projectKey ||
    !isIsoTimestamp(root.updatedAt) ||
    !Array.isArray(root.lessons)
  ) {
    return false;
  }
  return root.lessons.every((lesson) => isLessonCard(lesson, projectKey));
}

function isLessonCard(value: unknown, projectKey: string): value is LessonCard {
  const root = asRecord(value);
  if (
    !root ||
    !hasOnlyKeys(root, CARD_KEYS) ||
    root.schema !== LESSON_CARD_SCHEMA ||
    root.projectKey !== projectKey ||
    typeof root.lessonId !== "string" ||
    typeof root.reasonCode !== "string" ||
    !lessonCategory(String(root.safeCategory)) ||
    !isConfidence(root.confidence) ||
    typeof root.wordingKey !== "string" ||
    !isIsoTimestamp(root.createdAt) ||
    !isIsoTimestamp(root.updatedAt) ||
    !isIsoTimestamp(root.decayAt)
  ) {
    return false;
  }
  const counts = asRecord(root.evidenceCounts);
  return Boolean(
    counts &&
      hasOnlyKeys(counts, EVIDENCE_KEYS) &&
      isNonNegativeInteger(counts.failures) &&
      isNonNegativeInteger(counts.sessions)
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isIsoTimestamp(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isConfidence(value: unknown): value is DecisionConfidence {
  return value === "low" || value === "medium" || value === "high";
}

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function assertProjectKey(projectKey: string): void {
  if (!/^[a-f0-9]{64}$/u.test(projectKey)) {
    throw new Error("invalid project key");
  }
}

const MEMORY_KEYS = new Set(["schema", "version", "projectKey", "updatedAt", "lessons"]);
const CARD_KEYS = new Set([
  "schema",
  "lessonId",
  "projectKey",
  "reasonCode",
  "safeCategory",
  "confidence",
  "evidenceCounts",
  "createdAt",
  "updatedAt",
  "decayAt",
  "wordingKey"
]);
const EVIDENCE_KEYS = new Set(["failures", "sessions"]);
