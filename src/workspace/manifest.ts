import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "pathe";

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
  const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
  if (!isManifest(value)) {
    throw new Error(`Invalid workspace manifest: ${filePath}`);
  }
  return value;
}

export async function writeManifest(filePath: string, manifest: WorkspaceManifest): Promise<void> {
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

function isManifest(value: unknown): value is WorkspaceManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.name !== "string") {
    return false;
  }
  return Array.isArray(value.repositories) && value.repositories.every(isRepository)
    && Array.isArray(value.directories) && value.directories.every((directory) => typeof directory === "string");
}

function isRepository(value: unknown): value is Repository {
  return isRecord(value)
    && typeof value.name === "string"
    && typeof value.path === "string"
    && typeof value.remote === "string"
    && (value.packageManager === undefined || ["npm", "pnpm", "yarn", "bun"].includes(value.packageManager as string))
    && (value.nodeVersion === undefined || typeof value.nodeVersion === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
