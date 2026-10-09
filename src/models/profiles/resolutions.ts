import { findProfile } from "./active.js";
import { ModelProfileError } from "./errors.js";
import { assertAgentName, assertProfileName } from "./names.js";
import { isModelIdCompatible } from "./resolve-agent.js";
import { isCompleteModelId } from "./schema.js";
import { readLocalModelState, selectionsFor, writeLocalModelState } from "./state.js";
import type {
  IModelProfileLocation,
  IModelProfileLookupOptions,
  ModelResolutionSelections,
  SaveModelResolutionsResult,
} from "./types.js";

/** Saved exact selections for a profile in this location (empty when none). */
export async function readModelResolutions(location: IModelProfileLocation, profile: string): Promise<ModelResolutionSelections> {
  assertProfileName(profile);
  return selectionsFor(await readLocalModelState(location), profile);
}

/**
 * Saves exact `provider/model` choices for some agents, merging with existing selections for other
 * agents. Every ID is checked against the current portable preference first: an ID the profile
 * would not allow (wrong provider, family, or pattern) is reported as `incompatible` and nothing is
 * saved. The model need not currently be installed, so a user can choose before inventory is
 * available. Only IDs are stored: no inventory, credentials, or timestamps. Never edits the portable
 * profile. Writes nothing when the result is unchanged.
 */
export async function saveModelResolutions(
  location: IModelProfileLocation,
  profile: string,
  selections: ModelResolutionSelections,
  options: IModelProfileLookupOptions = {},
): Promise<SaveModelResolutionsResult> {
  assertProfileName(profile);
  const found = await findProfile(location, profile, options.inheritFrom);
  if (!found) return { status: "not-found", profile };

  const additions: Record<string, string> = {};
  for (const [agent, id] of Object.entries(selections)) {
    assertAgentName(agent);
    if (!isCompleteModelId(id)) throw new ModelProfileError("invalid-input", `Invalid model ID for agent "${agent}"; use a complete provider/model ID.`);
    if (!Object.hasOwn(found.profile.agents, agent)) return { status: "agent-not-found", profile, agent };
    if (!isModelIdCompatible(id, found.profile.agents[agent]!)) return { status: "incompatible", profile, agent, id };
    additions[agent] = id;
  }

  const state = await readLocalModelState(location);
  const existing = selectionsFor(state, profile);
  const merged = { ...existing, ...additions };
  const changed = Object.entries(additions).some(([agent, id]) => existing[agent] !== id);
  if (changed) await writeLocalModelState(location, { ...state, resolutions: { ...state.resolutions, [profile]: merged } });
  return { status: changed ? "changed" : "unchanged", profile, selections: merged };
}

/**
 * Forgets saved selections. With `agents` only those are removed; without, all of the profile's
 * selections are removed. Returns whether anything was removed.
 */
export async function clearModelResolutions(location: IModelProfileLocation, profile: string, agents?: readonly string[]): Promise<boolean> {
  assertProfileName(profile);
  for (const agent of agents ?? []) assertAgentName(agent);
  const state = await readLocalModelState(location);
  const current = selectionsFor(state, profile);
  const removing = (agents ?? Object.keys(current)).filter((agent) => Object.hasOwn(current, agent));
  if (removing.length === 0) return false;
  const remaining = Object.fromEntries(Object.entries(current).filter(([agent]) => !removing.includes(agent)));
  const { [profile]: _dropped, ...others } = state.resolutions;
  await writeLocalModelState(location, { ...state, resolutions: Object.keys(remaining).length > 0 ? { ...others, [profile]: remaining } : others });
  return true;
}
