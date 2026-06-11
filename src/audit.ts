import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Transcript-candidate discovery for the offline audit. The standalone compact-audit renderer
// (runAudit/formatAuditReport) was removed in PRD-03 (grill F3); section 2 of `audit` is now the
// deep-advisory engine, which reuses this candidate listing through auditTranscriptCandidates.

const DEFAULT_RECENT_SESSIONS = 30;

export interface AuditOptions {
  projectDir?: string;
  homeDir?: string;
  transcriptPath?: string;
  allProjects?: boolean;
  recent?: number;
  maxBytesPerTranscript?: number;
}

export interface TranscriptCandidate {
  path: string;
  mtimeMs: number;
}

export interface AuditTranscriptCandidateResult {
  scope: "project" | "all-projects" | "transcript";
  recentLimit: number;
  candidates: TranscriptCandidate[];
}

export async function auditTranscriptCandidates(options: AuditOptions = {}): Promise<AuditTranscriptCandidateResult> {
  const recentLimit = normalizedRecentLimit(options.recent);
  const candidates = options.transcriptPath
    ? await directTranscriptCandidate(options.transcriptPath)
    : options.allProjects
      ? await allProjectTranscriptCandidates(options.homeDir, recentLimit)
      : await projectTranscriptCandidates(options.homeDir, options.projectDir, recentLimit);
  return {
    scope: auditScope(options),
    recentLimit,
    candidates
  };
}

async function directTranscriptCandidate(path: string): Promise<TranscriptCandidate[]> {
  const mtimeMs = await readableFileMtimeMs(path);
  return mtimeMs === undefined ? [] : [{ path, mtimeMs }];
}

async function projectTranscriptCandidates(
  homeDir = homedir(),
  projectDir = process.cwd(),
  recentLimit = DEFAULT_RECENT_SESSIONS
): Promise<TranscriptCandidate[]> {
  const roots = claudeProjectDirectoryNames(projectDir).map((name) => join(resolve(homeDir), ".claude", "projects", name));
  const candidates = (await Promise.all(roots.map((root) => listTranscriptCandidates(root)))).flat();
  const uniqueCandidates = [...new Map(candidates.map((candidate) => [candidate.path, candidate])).values()];
  return uniqueCandidates
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path))
    .slice(0, recentLimit);
}

async function allProjectTranscriptCandidates(homeDir = homedir(), recentLimit = DEFAULT_RECENT_SESSIONS): Promise<TranscriptCandidate[]> {
  const root = join(resolve(homeDir), ".claude", "projects");
  return (await listTranscriptCandidates(root))
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path))
    .slice(0, recentLimit);
}

async function listTranscriptCandidates(root: string): Promise<TranscriptCandidate[]> {
  const candidates: TranscriptCandidate[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(child);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const mtimeMs = await readableFileMtimeMs(child);
        if (mtimeMs !== undefined) {
          candidates.push({ path: child, mtimeMs });
        }
      }
    }
  }
  return candidates;
}

async function readableFileMtimeMs(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

function normalizedRecentLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_RECENT_SESSIONS;
  }
  return Math.max(1, Math.floor(value));
}

function auditScope(options: AuditOptions): AuditTranscriptCandidateResult["scope"] {
  if (options.transcriptPath) {
    return "transcript";
  }
  return options.allProjects ? "all-projects" : "project";
}

function claudeProjectDirectoryName(projectDir: string): string {
  return resolve(projectDir).replaceAll(/[\\/]/gu, "-");
}

function claudeProjectDirectoryNames(projectDir: string): string[] {
  const resolved = resolve(projectDir);
  return [...new Set([claudeProjectDirectoryName(resolved), resolved.replaceAll(/[^A-Za-z0-9.-]/gu, "-")])];
}
