import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "pathe";
import { assertManifestPath } from "./path.js";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface Repository {
  name: string;
  path: string;
  remote: string;
  packageManager?: PackageManager;
  nodeVersion?: string;
}

export interface WorkspaceManifest {
  schemaVersion: 1;
  name: string;
  repositories: Repository[];
  directories: string[];
}

export async function readManifest(filePath: string): Promise<WorkspaceManifest> {
  const source = await readFile(filePath, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`Invalid workspace manifest ${filePath}: invalid JSON`);
  }
  assertWorkspaceManifest(value, filePath);
  return value;
}

export async function writeManifest(filePath: string, manifest: WorkspaceManifest): Promise<void> {
  assertWorkspaceManifest(manifest);
  await writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export async function findWorkspaceManifests(directory: string): Promise<Array<{ path: string; manifest: WorkspaceManifest }>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const manifests = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map(async (entry) => {
      const filePath = join(directory, entry.name);
      try {
        return { path: filePath, manifest: await readManifest(filePath) };
      } catch {
        return undefined;
      }
    }));
  return manifests.filter((manifest): manifest is { path: string; manifest: WorkspaceManifest } => manifest !== undefined);
}

export function assertWorkspaceManifest(value: unknown, filePath?: string): asserts value is WorkspaceManifest {
  const prefix = filePath ? `Invalid workspace manifest ${filePath}` : "Invalid workspace manifest";
  if (!isRecord(value) || value.schemaVersion !== 1 || !isNonEmptyString(value.name)) {
    throw new Error(`${prefix}: schemaVersion must be 1 and name must be non-empty`);
  }
  if (!Array.isArray(value.repositories) || !value.repositories.every(isRepository)) {
    throw new Error(`${prefix}: repositories must contain valid repositories with non-empty names and remotes`);
  }
  if (!Array.isArray(value.directories) || !value.directories.every((directory) => typeof directory === "string")) {
    throw new Error(`${prefix}: directories must be an array of paths`);
  }

  try {
    for (const repository of value.repositories) assertManifestPath(repository.path);
    for (const directory of value.directories) assertManifestPath(directory);
  } catch (error) {
    throw new Error(`${prefix}: ${error instanceof Error ? error.message : "invalid path"}`);
  }

  const repositoryPaths = value.repositories.map((repository) => repository.path);
  if (new Set(repositoryPaths).size !== repositoryPaths.length || new Set(value.directories).size !== value.directories.length) {
    throw new Error(`${prefix}: repository and directory paths must not be duplicated`);
  }
  if (hasPathCollision(repositoryPaths)) {
    throw new Error(`${prefix}: repository paths must not overlap`);
  }
  if (value.directories.some((directory) => repositoryPaths.some((repository) => pathsCollide(directory, repository)))) {
    throw new Error(`${prefix}: directories must not overlap repository paths`);
  }
}

function isRepository(value: unknown): value is Repository {
  return isRecord(value)
    && isNonEmptyString(value.name)
    && typeof value.path === "string"
    && isNonEmptyString(value.remote)
    && (value.packageManager === undefined || ["npm", "pnpm", "yarn", "bun"].includes(value.packageManager as string))
    && (value.nodeVersion === undefined || typeof value.nodeVersion === "string");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function pathsCollide(first: string, second: string): boolean {
  return first === second || first.startsWith(`${second}/`) || second.startsWith(`${first}/`);
}

function hasPathCollision(paths: string[]): boolean {
  return paths.some((path, index) => paths.slice(index + 1).some((otherPath) => pathsCollide(path, otherPath)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
