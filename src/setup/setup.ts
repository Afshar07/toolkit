import { lstat, mkdir, rm } from "node:fs/promises";
import * as path from "pathe";
import { execa } from "execa";
import { assertWorkspaceManifest, type GitRemote, type Repository, type WorkspaceManifest } from "../workspace/manifest.js";
import { resolveManifestPath } from "../workspace/path.js";
import { assertSafeProjectPath, filesystemRoot, isWithin } from "../workspace/safety.js";

export interface SetupResult {
  cloned: string[];
  skipped: string[];
}

export interface SetupConflict {
  path: string;
  reason: string;
}

export interface SetupOptions {
  selectFallbackRemote?: (repository: Repository, failedRemote: GitRemote) => Promise<GitRemote | undefined>;
  onCloneRemoteChanged?: (repository: Repository, cloneRemote: GitRemote) => void;
}

export class WorkspaceSetupError extends Error {
  constructor(readonly failed: string[], readonly conflicts: SetupConflict[] = []) {
    const failures = failed.length === 0 ? "" : `Setup failed for ${failed.length} ${failed.length === 1 ? "repository" : "repositories"}: ${failed.join(", ")}.`;
    const conflictDetails = conflicts.map((conflict) => `${conflict.path} (${conflict.reason})`).join(", ");
    super([failures, conflictDetails && `Destination conflicts: ${conflictDetails}.`].filter(Boolean).join(" "));
    this.name = "WorkspaceSetupError";
  }
}

const cloneConcurrency = 3;

export async function setupWorkspace(manifest: WorkspaceManifest, destination: string, onProgress: (message: string) => void, options?: SetupOptions): Promise<SetupResult> {
  assertWorkspaceManifest(manifest);
  const parent = path.resolve(destination);
  const root = path.resolve(parent, manifest.name);
  if (!isWithin(parent, root) || root === parent) throw new Error("Workspace name escapes the selected destination.");
  return setupWorkspaceAt(manifest, root, onProgress, options);
}

export async function setupWorkspaceAt(manifest: WorkspaceManifest, destination: string, onProgress: (message: string) => void, options?: SetupOptions): Promise<SetupResult> {
  assertWorkspaceManifest(manifest);
  const root = path.resolve(destination);
  const rootExisted = await exists(root);
  const cloned: string[] = [];
  const skipped: string[] = [];
  const pending = [] as typeof manifest.repositories;
  const conflicts: SetupConflict[] = [];

  const repositories: Repository[] = manifest.rootRepository
    ? [{ ...manifest.rootRepository, path: "." }, ...manifest.repositories]
    : manifest.repositories;

  await mkdir(root, { recursive: true });
  const safeRoot = await filesystemRoot(root);
  const planned = [
    ...manifest.directories.map((entry) => ({ path: resolveManifestPath(root, entry), label: entry })),
    ...repositories.map((entry) => ({ path: entry.path === "." ? root : resolveManifestPath(root, entry.path), label: entry.path })),
  ];
  await Promise.all(planned.map((entry) => assertSafeProjectPath(safeRoot, entry.path, `Workspace path ${entry.label}`)));

  for (const directory of manifest.directories) {
    const target = resolveManifestPath(root, directory);
    await assertSafeProjectPath(safeRoot, target, `Workspace path ${directory}`);
    await mkdir(target, { recursive: true });
  }

  for (const repository of repositories) {
    const target = repository.path === "." ? root : resolveManifestPath(root, repository.path);
    if (await exists(target) && (repository.path !== "." || rootExisted)) {
      const conflict = await inspectDestination(target, repository.cloneRemote, getCloneUrl(repository));
      if (conflict) {
        onProgress(`Conflict at ${repository.path}: ${conflict}.`);
        conflicts.push({ path: repository.path, reason: conflict });
      } else {
        onProgress(`Skipping ${repository.path}: matching repository already exists.`);
        skipped.push(repository.path);
      }
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    pending.push(repository);
  }

  const failed: string[] = [];
  await Promise.all(Array.from({ length: Math.min(cloneConcurrency, pending.length) }, async () => {
    while (pending.length > 0) {
      const repository = pending.shift()!;
      const target = repository.path === "." ? root : resolveManifestPath(root, repository.path);
      let cloneRemote = repository.cloneRemote;
      let cloneFailed = false;
      while (true) {
        let createdTarget = false;
        try {
          const cloneUrl = getCloneUrl(repository, cloneRemote);
          await assertSafeProjectPath(safeRoot, target, `Workspace path ${repository.path}`);
          onProgress(`Cloning remote ${cloneRemote} into ${repository.path}...`);
          if (repository.path !== ".") await mkdir(target);
          createdTarget = repository.path !== "." || !rootExisted;
          await execa("git", ["clone", "--origin", cloneRemote, "--", cloneUrl, target]);
        } catch {
          if (createdTarget && await isSafeOwnedTarget(safeRoot, target)) await rm(target, { recursive: true, force: true });
          const failedRemote = repository.remotes.find((remote) => remote.name === cloneRemote)!;
          const fallback = await options?.selectFallbackRemote?.(repository, failedRemote);
          if (fallback && fallback.name !== cloneRemote && repository.remotes.some((remote) => remote.name === fallback.name)) {
            cloneRemote = fallback.name;
            continue;
          }
          onProgress(`Failed to clone ${repository.path} from remote ${cloneRemote}.`);
          failed.push(`${repository.path} (clone remote ${cloneRemote})`);
          cloneFailed = true;
          break;
        }
        if (cloneRemote !== repository.cloneRemote) {
          options?.onCloneRemoteChanged?.(repository, repository.remotes.find((remote) => remote.name === cloneRemote)!);
        }
        onProgress(`Cloned ${repository.path}.`);
        cloned.push(repository.path);
        break;
      }

      if (cloneFailed) continue;
      for (const remote of repository.remotes.filter((remote) => remote.name !== cloneRemote)) {
        try {
          await execa("git", ["-C", target, "remote", "add", "--", remote.name, remote.url]);
        } catch {
          onProgress(`Failed to configure remote ${remote.name} for ${repository.path}.`);
          failed.push(`${repository.path} (remote ${remote.name})`);
          break;
        }
      }
    }
  }));

  if (failed.length > 0 || conflicts.length > 0) throw new WorkspaceSetupError(failed, conflicts);
  return { cloned, skipped };
}

async function inspectDestination(target: string, remoteName: string, expectedRemote: string): Promise<string | undefined> {
  try {
    const { stdout: isWorktree } = await execa("git", ["-C", target, "rev-parse", "--is-inside-work-tree"]);
    if (isWorktree.trim() !== "true") return "destination is not a Git worktree";
  } catch {
    return "destination is not a Git worktree";
  }

  try {
    const { stdout: remote } = await execa("git", ["-C", target, "remote", "get-url", remoteName]);
    if (remote.trim() !== expectedRemote) return `${remoteName} remote does not match the manifest`;
  } catch {
    return `${remoteName} remote does not match the manifest`;
  }
}

function getCloneUrl(repository: WorkspaceManifest["repositories"][number], cloneRemote = repository.cloneRemote): string {
  return repository.remotes.find((remote) => remote.name === cloneRemote)!.url;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isSafeOwnedTarget(root: Awaited<ReturnType<typeof filesystemRoot>>, target: string): Promise<boolean> {
  try {
    await assertSafeProjectPath(root, target, "Clone cleanup path");
    const stat = await lstat(target);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch { return false; }
}
