import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { appHome } from "./paths.js";
import type { DecisionConfidence, TranscriptSummary } from "./types.js";

export const LESSON_MEMORY_DIR_NAME = "project-lessons";
export const LESSON_MEMORY_SCHEMA = "ccverdict.lesson-memory.v1";
export const LESSON_CARD_SCHEMA = "ccverdict.lesson-card.v1";
export const LESSON_MEMORY_VERSION = 1;
const LESSON_MEMORY_MAX_BYTES = 64 * 1024;
const LESSON_DECAY_MS = 30 * 24 * 60 * 60 * 1000;

type LessonSafeCategory = "tests" | "lint" | "typecheck" | "build" | "edit" | "read" | "context";
type LessonReasonCode = "validation_repeated" | "unchecked_edits" | "write_failed" | "context_pressure" | "redundant_read";

export interface LessonEvidenceCounts {
  failures: number;
  sessions: number;
}

export interface LessonCard {
  schema: typeof LESSON_CARD_SCHEMA;
  lessonId: string;
  projectKey: string;
  reasonCode: LessonReasonCode;
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
  const candidates = lessonCandidates(options.projectKey, options.summary, options.now ?? new Date());
  if (candidates.length === 0) {
    return undefined;
  }

  const memoryPath = lessonMemoryPath(options);
  const existing = await readLessonMemory({ ...options, projectKey: options.projectKey });
  const candidateIds = new Set(candidates.map((candidate) => candidate.lessonId));
  const lessons = existing?.lessons.filter((lesson) => !candidateIds.has(lesson.lessonId)) ?? [];
  const nextLessons = candidates.map((candidate) => mergeLessonCandidate(candidate, existing?.lessons));
  const memory: ProjectLessonMemory = {
    schema: LESSON_MEMORY_SCHEMA,
    version: LESSON_MEMORY_VERSION,
    projectKey: options.projectKey,
    updatedAt: candidates[0]?.updatedAt ?? new Date().toISOString(),
    lessons: [...lessons, ...nextLessons].sort((left, right) => left.lessonId.localeCompare(right.lessonId))
  };
  await writeLessonMemory(memory, memoryPath);
  return nextLessons.sort((left, right) => lessonPriority(right) - lessonPriority(left) || left.lessonId.localeCompare(right.lessonId))[0];
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
    .filter(
      (lesson) =>
        lesson.reasonCode === "validation_repeated" &&
        lesson.confidence !== "low" &&
        lesson.evidenceCounts.failures >= 3
    )
    .sort((left, right) => right.evidenceCounts.failures - left.evidenceCounts.failures)[0];
  if (!selected) {
    return undefined;
  }
  return lessonMessage(selected.wordingKey);
}

export async function clearLessonMemory(options: { homeDir?: string; appHomePath?: string } = {}): Promise<void> {
  await rm(join(options.appHomePath ?? appHome(options.homeDir), LESSON_MEMORY_DIR_NAME), { recursive: true, force: true });
}

export async function readLessonMemory(options: LessonMemoryPathOptions): Promise<ProjectLessonMemory | undefined> {
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

function lessonCandidates(projectKey: string, summary: TranscriptSummary, now: Date): LessonCard[] {
  assertProjectKey(projectKey);
  const candidates: LessonCard[] = [];
  const timestamp = now.toISOString();

  const strongest = strongestValidationFailure(summary);
  if (strongest && strongest.failures >= 2) {
    candidates.push(
      lessonCard({
        projectKey,
        timestamp,
        reasonCode: "validation_repeated",
        safeCategory: strongest.safeCategory,
        evidenceCounts: { failures: strongest.failures, sessions: 1 },
        confidence: strongest.failures >= 3 ? "high" : "low",
        wordingKey: `validation_repeated:${strongest.safeCategory}`
      })
    );
  }

  if (summary.hasUnvalidatedEdits && (summary.unvalidatedEditResultCount || 0) >= 3) {
    candidates.push(
      lessonCard({
        projectKey,
        timestamp,
        reasonCode: "unchecked_edits",
        safeCategory: "edit",
        evidenceCounts: { failures: summary.unvalidatedEditResultCount || 1, sessions: 1 },
        confidence: (summary.unvalidatedEditResultCount || 0) >= 5 ? "high" : "medium",
        wordingKey: "unchecked_edits:edit"
      })
    );
  }

  if ((summary.failedEditResults || 0) > 0) {
    candidates.push(
      lessonCard({
        projectKey,
        timestamp,
        reasonCode: "write_failed",
        safeCategory: "edit",
        evidenceCounts: { failures: summary.failedEditResults || 1, sessions: 1 },
        confidence: summary.workContinuedAfterFailedEdit ? "medium" : "low",
        wordingKey: "write_failed:edit"
      })
    );
  }

  if ((summary.redundantRead?.unchangedFullFileReadCount || 0) >= 3) {
    candidates.push(
      lessonCard({
        projectKey,
        timestamp,
        reasonCode: "redundant_read",
        safeCategory: "read",
        evidenceCounts: { failures: summary.redundantRead?.unchangedFullFileReadCount || 3, sessions: 1 },
        confidence: "medium",
        wordingKey: "redundant_read:read"
      })
    );
  }

  if (((summary.compactionEvents || 0) > 0 || (summary.terminalEvents || 0) > 0) && hasOpenRisk(summary)) {
    candidates.push(
      lessonCard({
        projectKey,
        timestamp,
        reasonCode: "context_pressure",
        safeCategory: "context",
        evidenceCounts: { failures: (summary.compactionEvents || 0) + (summary.terminalEvents || 0), sessions: 1 },
        confidence: "medium",
        wordingKey: "context_pressure:context"
      })
    );
  }

  return candidates;
}

function lessonCard(args: {
  projectKey: string;
  timestamp: string;
  reasonCode: LessonReasonCode;
  safeCategory: LessonSafeCategory;
  evidenceCounts: LessonEvidenceCounts;
  confidence: DecisionConfidence;
  wordingKey: string;
}): LessonCard {
  return {
    schema: LESSON_CARD_SCHEMA,
    lessonId: `${args.reasonCode}:${args.safeCategory}`,
    projectKey: args.projectKey,
    reasonCode: args.reasonCode,
    safeCategory: args.safeCategory,
    confidence: args.confidence,
    evidenceCounts: args.evidenceCounts,
    createdAt: args.timestamp,
    updatedAt: args.timestamp,
    decayAt: new Date(Date.parse(args.timestamp) + LESSON_DECAY_MS).toISOString(),
    wordingKey: args.wordingKey
  };
}

function mergeLessonCandidate(candidate: LessonCard, existing: LessonCard[] | undefined): LessonCard {
  const previous = existing?.find((lesson) => lesson.lessonId === candidate.lessonId);
  return {
    ...candidate,
    createdAt: previous?.createdAt || candidate.createdAt,
    confidence: strongerConfidence(previous?.confidence, candidate.confidence),
    evidenceCounts: {
      failures: Math.max(previous?.evidenceCounts.failures || 0, candidate.evidenceCounts.failures),
      sessions: Math.min(999, (previous?.evidenceCounts.sessions || 0) + candidate.evidenceCounts.sessions)
    }
  };
}

function hasOpenRisk(summary: TranscriptSummary): boolean {
  return Boolean(
    summary.hasUnvalidatedEdits ||
      (summary.blindRetry?.blindRetryFailureCount || 0) >= 2 ||
      (summary.failedEditResults || 0) > 0 ||
      (summary.redundantRead?.unchangedFullFileReadCount || 0) >= 3
  );
}

function strongerConfidence(left: DecisionConfidence | undefined, right: DecisionConfidence): DecisionConfidence {
  const score = (value: DecisionConfidence | undefined): number => (value === "high" ? 2 : value === "medium" ? 1 : 0);
  return score(left) > score(right) ? left! : right;
}

function lessonPriority(lesson: Pick<LessonCard, "confidence" | "evidenceCounts">): number {
  const confidenceScore = lesson.confidence === "high" ? 100 : lesson.confidence === "medium" ? 50 : 0;
  return confidenceScore + lesson.evidenceCounts.failures;
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
  return value === "tests" ||
    value === "lint" ||
    value === "typecheck" ||
    value === "build" ||
    value === "edit" ||
    value === "read" ||
    value === "context"
    ? value
    : undefined;
}

function isExpired(lesson: LessonCard, now: Date): boolean {
  const decayAtMs = Date.parse(lesson.decayAt);
  return !Number.isFinite(decayAtMs) || decayAtMs <= now.getTime();
}

function lessonMessage(wordingKey: string): string | undefined {
  if (wordingKey.startsWith("validation_repeated:")) {
    return "ccverdict lesson: similar validation retries in this project rarely recovered after repeated failures. Inspect the first failure, make one targeted fix, then run one focused check.";
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
    !isReasonCode(root.reasonCode) ||
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

function isReasonCode(value: unknown): value is LessonReasonCode {
  return (
    value === "validation_repeated" ||
    value === "unchecked_edits" ||
    value === "write_failed" ||
    value === "context_pressure" ||
    value === "redundant_read"
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
