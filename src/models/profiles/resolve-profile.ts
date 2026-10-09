import type { IModelRef } from "../types.js";
import { findProfile } from "./active.js";
import { assertAgentName, assertProfileName } from "./names.js";
import { resolveAgentModel } from "./resolve-agent.js";
import { compareCodeUnits } from "./sort.js";
import { readLocalModelState, selectionsFor } from "./state.js";
import type {
  AgentModelResolution,
  IModelProfile,
  IModelProfileLocation,
  IModelProfileLookupOptions,
  IModelProfileResolution,
  IModelProfileResolutionOptions,
  IModelProfileResolutionSummary,
  ModelResolutionSelections,
  ResolveStoredAgentModelResult,
  ResolveStoredModelProfileResult,
} from "./types.js";

/**
 * Resolves every agent in a profile independently against `models`. One agent being ambiguous or
 * unavailable never affects another, and nothing is written. `complete` is true only when every
 * agent resolved.
 */
export function resolveModelProfile(
  models: readonly IModelRef[],
  profile: IModelProfile,
  options: IModelProfileResolutionOptions = {},
): IModelProfileResolution {
  const selections = options.selections ?? {};
  const agents: Record<string, AgentModelResolution> = {};
  const counts = { resolved: 0, ambiguous: 0, unavailable: 0, invalid: 0 };
  for (const name of Object.keys(profile.agents).sort(compareCodeUnits)) {
    const savedId = Object.hasOwn(selections, name) ? selections[name] : undefined;
    const outcome = resolveAgentModel(models, profile.agents[name]!, { savedId });
    agents[name] = outcome;
    counts[outcome.status] += 1;
  }
  const summary: IModelProfileResolutionSummary = counts;
  const unusedSelections = Object.keys(selections).filter((name) => !Object.hasOwn(profile.agents, name)).sort(compareCodeUnits);
  return { agents, summary, complete: counts.resolved === Object.keys(agents).length, unusedSelections };
}

/**
 * Resolves a stored profile using this location's saved selections. The profile is looked up in
 * `location`, then in `inheritFrom` (a same-named profile in `location` fully shadows the other).
 * Saved selections are read from `location`'s local state under the profile name. Reads only.
 *
 * `models` comes from Phase 1 discovery (`discoverModels`), supplied by the caller, so reading and
 * editing profiles never needs OpenCode.
 */
export async function resolveStoredModelProfile(
  location: IModelProfileLocation,
  name: string,
  models: readonly IModelRef[],
  options: IModelProfileLookupOptions = {},
): Promise<ResolveStoredModelProfileResult> {
  assertProfileName(name);
  const found = await findProfile(location, name, options.inheritFrom);
  if (!found) return { status: "not-found", profile: name };
  const selections: ModelResolutionSelections = selectionsFor(await readLocalModelState(location), name);
  return { status: "found", profile: name, definedIn: found.definedIn, resolution: resolveModelProfile(models, found.profile, { selections }) };
}

/** Resolves a single agent of a stored profile. */
export async function resolveStoredAgentModel(
  location: IModelProfileLocation,
  profile: string,
  agent: string,
  models: readonly IModelRef[],
  options: IModelProfileLookupOptions = {},
): Promise<ResolveStoredAgentModelResult> {
  assertProfileName(profile);
  assertAgentName(agent);
  const found = await findProfile(location, profile, options.inheritFrom);
  if (!found) return { status: "not-found", profile };
  if (!Object.hasOwn(found.profile.agents, agent)) return { status: "agent-not-found", profile, agent };
  const selections = selectionsFor(await readLocalModelState(location), profile);
  const savedId = Object.hasOwn(selections, agent) ? selections[agent] : undefined;
  return {
    status: "found",
    profile,
    agent,
    definedIn: found.definedIn,
    resolution: resolveAgentModel(models, found.profile.agents[agent]!, { savedId }),
  };
}

/**
 * The exact IDs of every agent that resolved, ready for `saveModelResolutions`. Saving is a separate,
 * explicit step: resolving never persists anything, and ambiguous or unavailable agents contribute nothing.
 */
export function selectionsFromResolution(resolution: IModelProfileResolution): ModelResolutionSelections {
  const selections: Record<string, string> = {};
  for (const [agent, outcome] of Object.entries(resolution.agents)) {
    if (outcome.status === "resolved") selections[agent] = outcome.model.id;
  }
  return selections;
}
