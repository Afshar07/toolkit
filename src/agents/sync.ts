import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import * as nodePath from "node:path";
import * as path from "pathe";
import { bundledAgentRegistry, type ICanonicalAgentRegistry } from "./registry.js";
import { readAgentManifest, writeAgentManifest, type AgentOwnershipManifest } from "./manifest.js";

export type ManagedAgentState = "current" | "update-available" | "modified" | "missing" | "not-installed" | "unmanaged-collision" | "override";

export interface ManagedAgentStatus {
  name: string;
  fileName: string;
  state: ManagedAgentState;
  installedVersion?: string;
  availableVersion: string;
  localHash?: string;
}

export interface AgentStatus {
  managed: ManagedAgentStatus[];
  local: string[];
  overrides: string[];
}

export interface UpdateAgentsOptions {
  replaceModified?: ReadonlySet<string>;
}

export interface IManageAgentOptions {
  replaceExisting: boolean;
}

export interface UpdateAgentsResult {
  installed: string[];
  updated: string[];
  current: string[];
  restored: string[];
  conflicts: string[];
  overrides: string[];
  local: string[];
}

export const openCodeAgentDirectory = ".opencode/agents";

/** Return the SHA-256 used to prove that a managed file is still unchanged. */
export function hashAgentContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Inspect canonical, managed, overridden, and unrelated project agents without writing. */
export async function inspectAgents(projectRoot: string, registry: ICanonicalAgentRegistry = bundledAgentRegistry): Promise<AgentStatus> {
  const root = await requireProjectRoot(projectRoot);
  const manifest = await readAgentManifest(root);
  const directory = path.join(root, openCodeAgentDirectory);
  await assertSafeAgentDirectory(root, directory);
  const localFiles = await readAgentFileNames(directory);
  const overrides = new Set(manifest.overrides);
  const canonicalNames = Object.keys(registry.agents).map(fileNameToAgentName);
  const managed: ManagedAgentStatus[] = [];

  for (const [fileName, content] of Object.entries(registry.agents)) {
    const name = fileNameToAgentName(fileName);
    const record = manifest.installed[name];
    if (overrides.has(name)) {
      managed.push({ name, fileName, state: "override", installedVersion: record?.version, availableVersion: registry.version });
      continue;
    }
    const localContent = await readRegularAgent(path.join(directory, fileName));
    if (!record) {
      managed.push({ name, fileName, state: localContent === undefined ? "not-installed" : "unmanaged-collision", availableVersion: registry.version });
      continue;
    }
    if (localContent === undefined) {
      managed.push({ name, fileName, state: "missing", installedVersion: record.version, availableVersion: registry.version });
      continue;
    }
    const localHash = hashAgentContent(localContent);
    const desiredHash = hashAgentContent(content);
    const state = localHash === desiredHash ? "current" : localHash === record.hash ? "update-available" : "modified";
    managed.push({ name, fileName, state, installedVersion: record.version, availableVersion: registry.version, localHash });
  }

  const ownedNames = new Set([...Object.keys(manifest.installed).filter((name) => canonicalNames.includes(name)), ...manifest.overrides]);
  const local = localFiles.map(fileNameToAgentName).filter((name) => !ownedNames.has(name) && !canonicalNames.includes(name)).sort();
  return { managed, local, overrides: [...manifest.overrides].sort() };
}

/** Safely install and update canonical agents, preserving all unproved or modified files. */
export async function updateAgents(projectRoot: string, options: UpdateAgentsOptions = {}, registry: ICanonicalAgentRegistry = bundledAgentRegistry): Promise<UpdateAgentsResult> {
  const root = await requireProjectRoot(projectRoot);
  const manifest = await readAgentManifest(root);
  const directory = path.join(root, openCodeAgentDirectory);
  await ensureSafeDirectory(root, directory);
  const result: UpdateAgentsResult = { installed: [], updated: [], current: [], restored: [], conflicts: [], overrides: [], local: [] };
  const status = await inspectAgents(root, registry);
  result.local = status.local;

  for (const agent of status.managed) {
    const content = registry.agents[agent.fileName];
    const target = path.join(directory, agent.fileName);
    if (agent.state === "override") { result.overrides.push(agent.name); continue; }
    if (agent.state === "current") {
      result.current.push(agent.name);
      manifest.installed[agent.name] = installedRecord(content, registry.version);
      continue;
    }
    if (agent.state === "unmanaged-collision" || (agent.state === "modified" && !options.replaceModified?.has(agent.name))) {
      result.conflicts.push(agent.name);
      continue;
    }
    if (agent.state === "not-installed") {
      await writeNewAgent(target, content);
      result.installed.push(agent.name);
    } else if (agent.state === "missing") {
      await writeNewAgent(target, content);
      result.restored.push(agent.name);
    } else {
      await assertRegularTargetHash(target, agent.localHash);
      await writeFile(target, content, "utf8");
      result.updated.push(agent.name);
    }
    manifest.installed[agent.name] = installedRecord(content, registry.version);
  }

  await writeAgentManifest(root, manifest);
  return result;
}

/** Mark a canonical name as project-owned without changing its agent file. */
export async function overrideAgent(projectRoot: string, name: string, registry: ICanonicalAgentRegistry = bundledAgentRegistry): Promise<void> {
  assertCanonicalName(name, registry);
  const root = await requireProjectRoot(projectRoot);
  const manifest = await readAgentManifest(root);
  if (!manifest.overrides.includes(name)) manifest.overrides.push(name);
  manifest.overrides.sort();
  delete manifest.installed[name];
  await writeAgentManifest(root, manifest);
}

/** Explicitly return an overridden or local collision to Toolkit ownership. */
export async function manageAgent(projectRoot: string, name: string, options: IManageAgentOptions, registry: ICanonicalAgentRegistry = bundledAgentRegistry): Promise<void> {
  assertCanonicalName(name, registry);
  const root = await requireProjectRoot(projectRoot);
  const manifest = await readAgentManifest(root);
  const fileName = `${name}.md`;
  const content = registry.agents[fileName];
  const directory = path.join(root, openCodeAgentDirectory);
  await ensureSafeDirectory(root, directory);
  const target = path.join(directory, fileName);
  const existing = await readRegularAgent(target);
  if (existing === undefined) await writeNewAgent(target, content);
  else if (options.replaceExisting) await writeFile(target, content, "utf8");
  else throw new Error(`Managing ${name} would replace an existing file; set replaceExisting to true.`);
  manifest.overrides = manifest.overrides.filter((candidate) => candidate !== name);
  manifest.installed[name] = installedRecord(content, registry.version);
  await writeAgentManifest(root, manifest);
}

function installedRecord(content: string, version: string) {
  return { source: "toolkit" as const, version, hash: hashAgentContent(content) };
}

function fileNameToAgentName(fileName: string): string { return fileName.replace(/\.md$/, ""); }

function assertCanonicalName(name: string, registry: ICanonicalAgentRegistry): void {
  if (!Object.hasOwn(registry.agents, `${name}.md`)) throw new Error(`Unknown canonical agent: ${name}`);
}

async function requireProjectRoot(projectRoot: string): Promise<string> {
  const root = path.resolve(projectRoot);
  const stat = await lstat(root).catch(() => undefined);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error(`Agent synchronization requires an existing project directory: ${root}`);
  return root;
}

async function readAgentFileNames(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".md"))
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readRegularAgent(filePath: string): Promise<string | undefined> {
  try {
    const stat = await lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Agent path is not a regular file: ${filePath}`);
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function ensureSafeDirectory(root: string, directory: string): Promise<void> {
  await assertSafeAgentDirectory(root, directory);
  await mkdir(directory, { recursive: true });
}

async function assertSafeAgentDirectory(root: string, directory: string): Promise<void> {
  const rootReal = await realpath(root);
  let cursor = directory;
  while (cursor !== root) {
    try {
      const stat = await lstat(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Agent directory is unsafe: ${cursor}`);
      if (!isWithin(rootReal, await realpath(cursor))) throw new Error(`Agent directory escapes the project: ${cursor}`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      cursor = nodePath.dirname(cursor);
    }
  }
}

async function writeNewAgent(target: string, content: string): Promise<void> {
  await mkdir(nodePath.dirname(target), { recursive: true });
  await writeFile(target, content, { encoding: "utf8", flag: "wx" });
}

async function assertRegularTargetHash(target: string, expectedHash: string | undefined): Promise<void> {
  const content = await readRegularAgent(target);
  if (content === undefined) throw new Error(`Agent path changed during update: ${target}`);
  if (!expectedHash || hashAgentContent(content) !== expectedHash) throw new Error(`Agent path changed during update: ${target}`);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = nodePath.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${nodePath.sep}`) && !nodePath.isAbsolute(relative));
}
