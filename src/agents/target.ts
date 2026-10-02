import { lstat, mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import * as nodePath from "node:path";
import * as path from "pathe";

export interface IAgentTarget {
  scope: "project" | "global";
  root: string;
}

export type AgentTarget = string | IAgentTarget;

/** Resolve OpenCode's portable global config location without creating it. */
export function resolveGlobalAgentTarget(options: { env?: NodeJS.ProcessEnv; home?: string } = {}): IAgentTarget {
  const xdg = (options.env ?? process.env).XDG_CONFIG_HOME;
  const config = xdg && nodePath.isAbsolute(xdg) ? xdg : path.join(options.home ?? os.homedir(), ".config");
  return { scope: "global", root: path.resolve(config, "opencode") };
}

/** Existing string roots retain their project-local meaning. */
export function resolveAgentTarget(target: AgentTarget): IAgentTarget {
  return typeof target === "string" ? { scope: "project", root: path.resolve(target) } : { ...target, root: path.resolve(target.root) };
}

export function agentDirectory(target: AgentTarget): string {
  const selected = resolveAgentTarget(target);
  return path.join(selected.root, selected.scope === "global" ? "agents" : ".opencode/agents");
}

/** Preflight every target ancestor, including ancestors of an absent global root. */
export async function assertSafeTargetDirectory(target: AgentTarget, directory: string): Promise<void> {
  const selected = resolveAgentTarget(target);
  const relative = nodePath.relative(selected.root, directory);
  if (relative === ".." || relative.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(relative)) throw new Error(`Agent directory escapes the target: ${directory}`);
  if (selected.scope === "project") {
    const stat = await lstat(selected.root).catch(() => undefined);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error(`Agent synchronization requires an existing project directory: ${selected.root}`);
  }
  let cursor = directory;
  while (true) {
    try {
      const stat = await lstat(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Agent directory is unsafe: ${cursor}`);
      if (selected.scope === "project") {
        const rootReal = await realpath(selected.root);
        const resolved = nodePath.relative(rootReal, await realpath(cursor));
        if (resolved === ".." || resolved.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(resolved)) throw new Error(`Agent directory escapes the target: ${cursor}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (selected.scope === "project" && cursor === selected.root) break;
    const parent = nodePath.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

export async function ensureSafeTargetDirectory(target: AgentTarget, directory: string): Promise<void> {
  await assertSafeTargetDirectory(target, directory);
  await mkdir(directory, { recursive: true });
}
