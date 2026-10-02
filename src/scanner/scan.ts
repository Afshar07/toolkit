import { readdir, readFile, stat } from "node:fs/promises";
import * as path from "pathe";
import { execa } from "execa";
import { assertWorkspaceManifest, type GitRemote, type PackageManager, type Repository, type RootRepository, type WorkspaceManifest } from "../workspace/manifest.js";
import { assertSafeGitRemoteUrl } from "../workspace/validation.js";
import { toManifestPath } from "../workspace/path.js";
export type { GitRemote } from "../workspace/manifest.js";

const ignoredDirectoryNames = new Set([".git", ".toolkit-backups", "node_modules", ".nuxt", "dist", ".idea", ".vscode", ".cache"]);
const lockfiles: ReadonlyArray<readonly [string, PackageManager]> = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

export interface RepositoryCandidate extends Omit<Repository, "cloneRemote" | "remotes"> {
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
  const rootCandidate = candidates.find((candidate) => candidate.path === ".");
  const directories = rootCandidate ? [] : await findStructuralDirectories(root, new Set(candidates.map((candidate) => candidate.path)));
  const repositories: Repository[] = [];
  let rootRepository: RootRepository | undefined;

  for (const candidate of candidates.sort((a, b) => a.path.localeCompare(b.path))) {
    const remote = candidate.remotes.find((remote) => remote.name === "origin")
      ?? (candidate.remotes.length === 1 ? candidate.remotes[0] : await options.selectRemote?.(candidate));
    if (!remote) continue;
    const { remotes: _, ...repository } = candidate;
    const completeRepository = { ...repository, cloneRemote: remote.name, remotes: candidate.remotes };
    if (candidate.path === ".") {
      const { path: _, ...root } = completeRepository;
      rootRepository = root;
    } else repositories.push(completeRepository);
  }

  const manifest: WorkspaceManifest = {
    schemaVersion: 3,
    name: path.basename(root),
    rootRepository,
    repositories,
    directories,
  };
  assertWorkspaceManifest(manifest);
  return manifest;
}

async function findRepositories(root: string, current: string, repositories: RepositoryCandidate[]): Promise<void> {
  if (await isGitRepository(current)) {
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

async function findStructuralDirectories(root: string, repositoryPaths: ReadonlySet<string>): Promise<string[]> {
  const directories: string[] = [];
  await findStructuralDirectoriesIn(root, root, repositoryPaths, directories);
  return directories.sort();
}

async function findStructuralDirectoriesIn(root: string, current: string, repositoryPaths: ReadonlySet<string>, directories: string[]): Promise<void> {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || ignoredDirectoryNames.has(entry.name)) continue;
    const directory = path.join(current, entry.name);
    const manifestPath = toManifestPath(root, directory);
    if (repositoryPaths.has(manifestPath) || await isGitRepository(directory)) continue;

    const contents = (await readdir(directory, { withFileTypes: true }))
      .filter((child) => !ignoredDirectoryNames.has(child.name));
    if (contents.length === 0) {
      directories.push(manifestPath);
      continue;
    }

    await findStructuralDirectoriesIn(root, directory, repositoryPaths, directories);
  }
}

async function isGitRepository(directory: string): Promise<boolean> {
  const gitPath = path.join(directory, ".git");
  try {
    return (await stat(gitPath)).isDirectory() || (await stat(gitPath)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(`Unable to inspect Git marker at ${gitPath}`, { cause: error });
  }
}

async function getGitRemotes(directory: string): Promise<GitRemote[]> {
  try {
    const { stdout } = await execa("git", ["-C", directory, "remote"]);
    // Drain every Git process before rejecting so callers can safely remove the
    // scanned directory, particularly on Windows where running Git holds locks.
    const results = await Promise.allSettled(stdout.split("\n").filter(Boolean).map(async (name) => {
      const { stdout: url } = await execa("git", ["-C", directory, "remote", "get-url", name]);
      assertSafeGitRemoteUrl(url);
      return { name, url };
    }));
    const remotes = results.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    return remotes.sort((a, b) => (a.name === "origin" ? -1 : b.name === "origin" ? 1 : a.name.localeCompare(b.name)));
  } catch (error) {
    if (error instanceof Error && error.message.includes("Git remote URL")) throw error;
    throw new Error(`Unable to discover Git remotes for ${directory}`, { cause: error });
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
