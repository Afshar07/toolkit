import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import * as nodePath from "node:path";
import * as path from "pathe";

export interface InstalledAgentRecord {
  source: "toolkit";
  version: string;
  hash: string;
}

export interface AgentOwnershipManifest {
  schemaVersion: 1;
  target: "opencode";
  overrides: string[];
  installed: Record<string, InstalledAgentRecord>;
}

export const agentManifestRelativePath = ".toolkit/agents.json";

export function emptyAgentManifest(): AgentOwnershipManifest {
  return { schemaVersion: 1, target: "opencode", overrides: [], installed: {} };
}

export async function readAgentManifest(projectRoot: string): Promise<AgentOwnershipManifest> {
  const manifestPath = path.join(projectRoot, agentManifestRelativePath);
  await assertSafeManifestDirectory(projectRoot, path.dirname(manifestPath));
  let source: string;
  try {
    const stat = await lstat(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Agent ownership manifest is not a regular file: ${manifestPath}`);
    source = await readFile(manifestPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyAgentManifest();
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(source); }
  catch { throw new Error(`Invalid agent ownership manifest ${manifestPath}: invalid JSON`); }
  assertAgentManifest(value, manifestPath);
  return value;
}

export async function writeAgentManifest(projectRoot: string, manifest: AgentOwnershipManifest): Promise<void> {
  assertAgentManifest(manifest);
  const manifestPath = path.join(projectRoot, agentManifestRelativePath);
  const directory = path.dirname(manifestPath);
  await assertSafeManifestDirectory(projectRoot, directory);
  await mkdir(directory, { recursive: true });
  const temporaryPath = `${manifestPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, manifestPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function assertAgentManifest(value: unknown, filePath?: string): asserts value is AgentOwnershipManifest {
  const prefix = filePath ? `Invalid agent ownership manifest ${filePath}` : "Invalid agent ownership manifest";
  if (!isRecord(value) || value.schemaVersion !== 1 || value.target !== "opencode") {
    throw new Error(`${prefix}: schemaVersion must be 1 and target must be opencode`);
  }
  if (!Array.isArray(value.overrides) || !value.overrides.every(isAgentName) || new Set(value.overrides).size !== value.overrides.length) {
    throw new Error(`${prefix}: overrides must contain unique agent names`);
  }
  if (!isRecord(value.installed) || !Object.entries(value.installed).every(([name, record]) => isAgentName(name) && isInstalledRecord(record))) {
    throw new Error(`${prefix}: installed must contain valid Toolkit ownership records`);
  }
}

function isInstalledRecord(value: unknown): value is InstalledAgentRecord {
  return isRecord(value)
    && value.source === "toolkit"
    && typeof value.version === "string"
    && /^[a-f0-9]{64}$/.test(String(value.hash));
}

function isAgentName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]*$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function assertSafeManifestDirectory(projectRoot: string, directory: string): Promise<void> {
  const root = path.resolve(projectRoot);
  const rootReal = await realpath(root);
  let cursor = directory;
  while (cursor !== root) {
    try {
      const stat = await lstat(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Agent ownership directory is unsafe: ${cursor}`);
      const relative = nodePath.relative(rootReal, await realpath(cursor));
      if (relative === ".." || relative.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(relative)) {
        throw new Error(`Agent ownership directory escapes the project: ${cursor}`);
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      cursor = nodePath.dirname(cursor);
    }
  }
}
