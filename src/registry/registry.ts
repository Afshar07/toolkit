import { lstat } from "node:fs/promises";
import * as path from "pathe";
import { bundledAgentRegistry, readCanonicalAgentRegistry, type ICanonicalAgentRegistry } from "../agents/registry.js";
import { initializeGitRegistry, inspectGitRegistry, RegistryGitError, updateGitRegistry, type IGitRegistryInfo, type IRegistryGitOptions } from "./git.js";
import { resolveToolkitRegistryPaths, type IToolkitRegistryPaths } from "./path.js";

export interface IToolkitRegistryInfo extends IGitRegistryInfo {
  path: string;
  version: string;
}

export interface IPreparedAgentRegistry {
  registry: ICanonicalAgentRegistry;
  action: "initialized" | "updated" | "existing" | "bundled";
  warning?: string;
  commit?: string;
}

export class ToolkitRegistryError extends Error {}

export async function localRegistryExists(paths = resolveToolkitRegistryPaths()): Promise<boolean> {
  try {
    const stat = await lstat(paths.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ToolkitRegistryError(`Toolkit registry path exists but is not a safe directory: ${paths.root}`);
    }
    return true;
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function readLocalAgentRegistry(paths = resolveToolkitRegistryPaths()): Promise<ICanonicalAgentRegistry> {
  if (!await localRegistryExists(paths)) throw new ToolkitRegistryError(`Toolkit registry is not initialized at ${paths.root}.`);
  try {
    const gitMetadata = await lstat(path.join(paths.root, ".git"));
    if (!gitMetadata.isDirectory() && !gitMetadata.isFile()) throw new Error("missing Git metadata");
    return await readCanonicalAgentRegistry(paths.agents, "local");
  } catch (error) {
    throw new ToolkitRegistryError(`Invalid Toolkit registry at ${paths.root}: ${error instanceof Error ? error.message : "validation failed"}`);
  }
}

export async function initializeToolkitRegistry(
  paths = resolveToolkitRegistryPaths(), options: IRegistryGitOptions = {},
): Promise<ICanonicalAgentRegistry> {
  if (await localRegistryExists(paths)) {
    try { return await readLocalAgentRegistry(paths); }
    catch (error) { throw new ToolkitRegistryError(`Refusing to replace the existing registry path. ${error instanceof Error ? error.message : ""}`.trim()); }
  }
  const registry = await initializeGitRegistry(paths.root, async (checkoutRoot) => {
    return await readCanonicalAgentRegistry(path.join(checkoutRoot, "agents"), "local");
  }, options);
  return { ...registry, path: paths.agents };
}

export async function updateToolkitRegistry(paths = resolveToolkitRegistryPaths(), options: IRegistryGitOptions = {}): Promise<ICanonicalAgentRegistry> {
  await readLocalAgentRegistry(paths);
  await updateGitRegistry(paths.root, options);
  return await readLocalAgentRegistry(paths);
}

export async function inspectToolkitRegistry(paths = resolveToolkitRegistryPaths()): Promise<IToolkitRegistryInfo> {
  const registry = await readLocalAgentRegistry(paths);
  const git = await inspectGitRegistry(paths.root);
  return { ...git, path: paths.root, version: registry.version };
}

/** Resolve locally and never contact a remote. */
export async function resolveOfflineAgentRegistry(paths = resolveToolkitRegistryPaths()): Promise<IPreparedAgentRegistry> {
  if (!await localRegistryExists(paths)) return { registry: bundledAgentRegistry, action: "bundled", warning: "Toolkit registry is not initialized." };
  return { registry: await readLocalAgentRegistry(paths), action: "existing" };
}

/** Initialize or refresh, falling back only for operational Git failures. */
export async function prepareAgentRegistryForUpdate(
  paths = resolveToolkitRegistryPaths(), options: IRegistryGitOptions = {},
): Promise<IPreparedAgentRegistry> {
  const exists = await localRegistryExists(paths);
  if (exists) {
    const existing = await readLocalAgentRegistry(paths);
    let before: IGitRegistryInfo;
    try {
      before = await inspectGitRegistry(paths.root, options);
    } catch (error) {
      return { registry: existing, action: "existing", warning: `Could not inspect or refresh Toolkit registry: ${error instanceof Error ? error.message : "Git failed"}` };
    }
    if (!before.clean) throw new ToolkitRegistryError(`Toolkit registry at ${paths.root} has local modifications; refusing to update or use it automatically.`);
    try {
      const registry = await updateToolkitRegistry(paths, options);
      const info = await inspectGitRegistry(paths.root, options);
      return { registry, action: "updated", commit: info.commit };
    } catch (error) {
      if (error instanceof RegistryGitError && (error.kind === "dirty" || error.kind === "diverged")) throw error;
      return { registry: existing, action: "existing", commit: before.commit, warning: `Could not refresh Toolkit registry: ${error instanceof Error ? error.message : "Git failed"}` };
    }
  }
  try {
    const registry = await initializeToolkitRegistry(paths, options);
    const info = await inspectGitRegistry(paths.root, options);
    return { registry, action: "initialized", commit: info.commit };
  } catch (error) {
    if (await localRegistryExists(paths)) throw error;
    return { registry: bundledAgentRegistry, action: "bundled", warning: `Could not initialize Git registry: ${error instanceof Error ? error.message : "Git failed"}` };
  }
}

export type { IToolkitRegistryPaths };
