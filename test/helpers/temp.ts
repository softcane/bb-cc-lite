import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface TempWorkspace {
  root: string;
  projectDir: string;
  homeDir: string;
  appHome: string;
}

export async function createTempWorkspace(): Promise<TempWorkspace> {
  const root = await mkdtemp(join(tmpdir(), "bb-cc-lite-test-"));
  const workspace = {
    root,
    projectDir: join(root, "project"),
    homeDir: join(root, "home"),
    appHome: join(root, "app-home")
  };
  await Promise.all([mkdir(workspace.projectDir), mkdir(workspace.homeDir), mkdir(workspace.appHome)]);
  return workspace;
}

export async function removeTempWorkspace(workspace: TempWorkspace | undefined): Promise<void> {
  if (workspace) {
    await rm(workspace.root, { recursive: true, force: true });
  }
}

export function setIsolatedEnv(updates: Record<string, string | undefined>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(updates)) {
    previous.set(key, process.env[key]);
  }
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
