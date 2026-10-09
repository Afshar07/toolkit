import * as path from "pathe";
import { resolveAgentTarget, resolveGlobalAgentTarget, type AgentTarget } from "../../agents/target.js";
import type { IModelProfileLocation } from "./types.js";

/** Both documents live beside, never inside, `.toolkit/agents.json`, which keeps tracking agent ownership only. */
export const modelProfileDirectoryRelativePath = ".toolkit/models";
export const modelProfilesFileName = "profiles.json";
export const localModelStateFileName = "local.json";

/**
 * Locates the profile documents for one scope, without touching the filesystem.
 *
 * - Project: `<project>/.toolkit/models/profiles.json` (portable, suitable to commit) and
 *   `<project>/.toolkit/models/local.json` (machine-specific; keep it out of version control).
 * - Global: the same relative paths under the OpenCode config root used by the agent lifecycle,
 *   beside `<OpenCode config>/.toolkit/agents.json`.
 *
 * Accepts the same `AgentTarget` values as the agent lifecycle, so `--global` integration is a
 * direct mapping and safety checks are shared. A string root is a project, as for agents.
 */
export function resolveModelProfileLocation(target: AgentTarget): IModelProfileLocation {
  const selected = resolveAgentTarget(target);
  const directory = path.join(selected.root, modelProfileDirectoryRelativePath);
  return {
    scope: selected.scope,
    root: selected.root,
    directory,
    profilesPath: path.join(directory, modelProfilesFileName),
    statePath: path.join(directory, localModelStateFileName),
  };
}

/** Resolves the global location. `env` and `home` are injectable so tests never touch the real home directory. */
export function resolveGlobalModelProfileLocation(options: { env?: NodeJS.ProcessEnv; home?: string } = {}): IModelProfileLocation {
  return resolveModelProfileLocation(resolveGlobalAgentTarget(options));
}
