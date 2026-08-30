import { access, mkdir, rm } from "node:fs/promises";
import * as path from "pathe";
import { execa } from "execa";
import type { WorkspaceManifest } from "../workspace/manifest.js";

export interface SetupResult {
  cloned: string[];
  skipped: string[];
}

export class WorkspaceSetupError extends Error {
  constructor(readonly failed: string[]) {
    super(`Failed to clone ${failed.length} ${failed.length === 1 ? "repository" : "repositories"}: ${failed.join(", ")}`);
    this.name = "WorkspaceSetupError";
  }
}

const cloneConcurrency = 3;

export async function setupWorkspace(manifest: WorkspaceManifest, destination: string, onProgress: (message: string) => void): Promise<SetupResult> {
  return setupWorkspaceAt(manifest, path.join(destination, manifest.name), onProgress);
}

export async function setupWorkspaceAt(manifest: WorkspaceManifest, destination: string, onProgress: (message: string) => void): Promise<SetupResult> {
  const root = path.resolve(destination);
  await mkdir(root, { recursive: true });
  const cloned: string[] = [];
  const skipped: string[] = [];
  const pending = [] as typeof manifest.repositories;

  for (const directory of manifest.directories) {
    await mkdir(resolveInside(root, directory), { recursive: true });
  }

  for (const repository of manifest.repositories) {
    const target = resolveInside(root, repository.path);
    if (await exists(target)) {
      onProgress(`Skipping ${repository.path}: destination already exists.`);
      skipped.push(repository.path);
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    pending.push(repository);
  }

  const failed: string[] = [];
  await Promise.all(Array.from({ length: Math.min(cloneConcurrency, pending.length) }, async () => {
    while (pending.length > 0) {
      const repository = pending.shift()!;
      const target = resolveInside(root, repository.path);
      try {
        onProgress(`Cloning ${repository.remote} into ${repository.path}...`);
        await execa("git", ["clone", repository.remote, target], { stdio: "inherit" });
        onProgress(`Cloned ${repository.path}.`);
        cloned.push(repository.path);
      } catch {
        await rm(target, { recursive: true, force: true });
        onProgress(`Failed to clone ${repository.path}.`);
        failed.push(repository.path);
      }
    }
  }));

  if (failed.length > 0) throw new WorkspaceSetupError(failed);
  return { cloned, skipped };
}

function resolveInside(root: string, manifestPath: string): string {
  const normalized = path.normalize(manifestPath);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || path.isAbsolute(normalized)) {
    throw new Error(`Manifest path must be a non-root relative path: ${manifestPath}`);
  }
  const resolved = path.resolve(root, ...normalized.split("/"));
  if (path.relative(root, resolved).startsWith("..") || path.isAbsolute(path.relative(root, resolved))) {
    throw new Error(`Manifest path escapes workspace: ${manifestPath}`);
  }
  return resolved;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
