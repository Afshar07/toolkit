import { access, mkdir, rm } from "node:fs/promises";
import * as path from "pathe";
import { execa } from "execa";
import { assertWorkspaceManifest, type WorkspaceManifest } from "../workspace/manifest.js";
import { resolveManifestPath } from "../workspace/path.js";

export interface SetupResult {
  cloned: string[];
  skipped: string[];
}

export interface SetupConflict {
  path: string;
  reason: string;
}

export class WorkspaceSetupError extends Error {
  constructor(readonly failed: string[], readonly conflicts: SetupConflict[] = []) {
    const failures = failed.length === 0 ? "" : `Failed to clone ${failed.length} ${failed.length === 1 ? "repository" : "repositories"}: ${failed.join(", ")}.`;
    const conflictDetails = conflicts.map((conflict) => `${conflict.path} (${conflict.reason})`).join(", ");
    super([failures, conflictDetails && `Destination conflicts: ${conflictDetails}.`].filter(Boolean).join(" "));
    this.name = "WorkspaceSetupError";
  }
}

const cloneConcurrency = 3;

export async function setupWorkspace(manifest: WorkspaceManifest, destination: string, onProgress: (message: string) => void): Promise<SetupResult> {
  assertWorkspaceManifest(manifest);
  return setupWorkspaceAt(manifest, path.join(destination, manifest.name), onProgress);
}

export async function setupWorkspaceAt(manifest: WorkspaceManifest, destination: string, onProgress: (message: string) => void): Promise<SetupResult> {
  assertWorkspaceManifest(manifest);
  const root = path.resolve(destination);
  const cloned: string[] = [];
  const skipped: string[] = [];
  const pending = [] as typeof manifest.repositories;
  const conflicts: SetupConflict[] = [];

  const repositories = manifest.rootRepository
    ? [{ ...manifest.rootRepository, path: "." }, ...manifest.repositories]
    : manifest.repositories;

  for (const directory of manifest.directories) {
    await mkdir(root, { recursive: true });
    await mkdir(resolveManifestPath(root, directory), { recursive: true });
  }

  for (const repository of repositories) {
    const target = repository.path === "." ? root : resolveManifestPath(root, repository.path);
    if (await exists(target)) {
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
      let createdTarget = false;
      try {
        const cloneUrl = getCloneUrl(repository);
        onProgress(`Cloning ${cloneUrl} into ${repository.path}...`);
        await mkdir(target);
        createdTarget = true;
        await execa("git", ["clone", "--origin", repository.cloneRemote, cloneUrl, target], { stdio: "inherit" });
        await Promise.all(repository.remotes
          .filter((remote) => remote.name !== repository.cloneRemote)
          .map((remote) => execa("git", ["-C", target, "remote", "add", remote.name, remote.url])));
        onProgress(`Cloned ${repository.path}.`);
        cloned.push(repository.path);
      } catch {
        if (createdTarget) await rm(target, { recursive: true, force: true });
        onProgress(`Failed to clone ${repository.path}.`);
        failed.push(repository.path);
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

function getCloneUrl(repository: WorkspaceManifest["repositories"][number]): string {
  return repository.remotes.find((remote) => remote.name === repository.cloneRemote)!.url;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
