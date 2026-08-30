import { readdir, readFile, stat } from "node:fs/promises";
import * as path from "pathe";
import { execa } from "execa";
import type { PackageManager, Repository, WorkspaceManifest } from "../workspace/manifest.js";

const ignoredDirectoryNames = new Set([".git", "node_modules", ".nuxt", "dist", ".idea", ".vscode", ".cache"]);
const lockfiles: ReadonlyArray<readonly [string, PackageManager]> = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

export interface GitRemote {
  name: string;
  url: string;
}

export interface RepositoryCandidate extends Omit<Repository, "remote"> {
  remotes: GitRemote[];
}

export interface ScanOptions {
  selectRemote?: (repository: RepositoryCandidate) => Promise<GitRemote | undefined>;
}

export async function scanWorkspace(target: string, options: ScanOptions = {}): Promise<WorkspaceManifest> {
  const root = path.resolve(target);
  if (!(await stat(root)).isDirectory()) {
    throw new Error(`Workspace is not a directory: ${root}`);
  }

  const candidates: RepositoryCandidate[] = [];
  await findRepositories(root, root, candidates);
  const directories = await findTopLevelDirectories(root);
  const repositories: Repository[] = [];

  for (const candidate of candidates.sort((a, b) => a.path.localeCompare(b.path))) {
    const remote = candidate.remotes.length > 1 && options.selectRemote
      ? await options.selectRemote(candidate)
      : candidate.remotes[0];
    if (!remote) continue;
    const { remotes: _, ...repository } = candidate;
    repositories.push({ ...repository, remote: remote.url });
  }

  return {
    schemaVersion: 1,
    name: path.basename(root),
    repositories,
    directories,
  };
}

async function findRepositories(root: string, current: string, repositories: RepositoryCandidate[]): Promise<void> {
  if (current !== root && await isGitRepository(current)) {
    const remotes = await getGitRemotes(current);
    if (remotes.length > 0) {
      repositories.push({
        name: path.basename(current),
        path: toManifestPath(root, current),
        remotes,
        packageManager: await detectPackageManager(current),
        nodeVersion: await detectNodeVersion(current),
      });
    }
    return;
  }

  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink() && !ignoredDirectoryNames.has(entry.name)) {
      await findRepositories(root, path.join(current, entry.name), repositories);
    }
  }
}

async function findTopLevelDirectories(root: string): Promise<string[]> {
  const directories: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || ignoredDirectoryNames.has(entry.name)) continue;
    const fullPath = path.join(root, entry.name);
    if (!(await isGitRepository(fullPath))) directories.push(entry.name);
  }
  return directories.sort();
}

async function isGitRepository(directory: string): Promise<boolean> {
  try {
    const gitPath = path.join(directory, ".git");
    return (await stat(gitPath)).isDirectory() || (await stat(gitPath)).isFile();
  } catch {
    return false;
  }
}

async function getGitRemotes(directory: string): Promise<GitRemote[]> {
  try {
    const { stdout } = await execa("git", ["-C", directory, "remote"]);
    const remotes = await Promise.all(stdout.split("\n").filter(Boolean).map(async (name) => {
      const { stdout: url } = await execa("git", ["-C", directory, "remote", "get-url", name]);
      return { name, url };
    }));
    return remotes.sort((a, b) => (a.name === "origin" ? -1 : b.name === "origin" ? 1 : a.name.localeCompare(b.name)));
  } catch {
    return [];
  }
}

async function detectPackageManager(directory: string): Promise<PackageManager | undefined> {
  const files = new Set(await readdir(directory));
  return lockfiles.find(([file]) => files.has(file))?.[1];
}

async function detectNodeVersion(directory: string): Promise<string | undefined> {
  for (const file of [".nvmrc", ".node-version"]) {
    try {
      const version = (await readFile(path.join(directory, file), "utf8")).trim();
      if (version) return version;
    } catch { /* Try the next hint. */ }
  }
  try {
    const packageJson: unknown = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
    if (typeof packageJson === "object" && packageJson !== null) {
      const engines = (packageJson as { engines?: { node?: unknown } }).engines;
      if (typeof engines?.node === "string") return engines.node;
    }
  } catch { /* No readable package.json node hint. */ }
  return undefined;
}

function toManifestPath(root: string, directory: string): string {
  const relativePath = path.relative(root, directory);
  return relativePath ? relativePath.split(path.sep).join("/") : ".";
}
