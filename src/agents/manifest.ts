import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import * as path from "pathe";
import { assertSafeTargetDirectory, resolveAgentTarget, type AgentTarget } from "./target.js";

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

export async function readAgentManifest(projectRoot: AgentTarget): Promise<AgentOwnershipManifest> {
  const manifestPath = path.join(resolveAgentTarget(projectRoot).root, agentManifestRelativePath);
  await assertSafeTargetDirectory(projectRoot, path.dirname(manifestPath));
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

export async function writeAgentManifest(projectRoot: AgentTarget, manifest: AgentOwnershipManifest): Promise<void> {
  assertAgentManifest(manifest);
  const manifestPath = path.join(resolveAgentTarget(projectRoot).root, agentManifestRelativePath);
  const directory = path.dirname(manifestPath);
  await assertSafeTargetDirectory(projectRoot, directory);
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
