import { assertProfileName } from "./names.js";
import { readLocalModelState, writeLocalModelState } from "./state.js";
import { readModelProfileStore } from "./store.js";
import type {
  EffectiveModelProfileSelection,
  IEffectiveModelProfileLocations,
  IModelProfile,
  IModelProfileLocation,
  IModelProfileLookupOptions,
  ModelProfileScope,
  SetActiveModelProfileResult,
} from "./types.js";

/**
 * The active profile name recorded in this location's local state, or `undefined`. This is Toolkit
 * state only; it says nothing about what OpenCode is configured to use.
 */
export async function getActiveModelProfile(location: IModelProfileLocation): Promise<string | undefined> {
  return (await readLocalModelState(location)).activeProfile;
}

/**
 * Records `name` as the active profile for this location. Only Toolkit's local state changes:
 * nothing is applied to OpenCode (Phase 3). The profile must be defined here, or in
 * `inheritFrom` (so a project can activate a global profile). Saved resolutions are preserved.
 */
export async function setActiveModelProfile(
  location: IModelProfileLocation,
  name: string,
  options: IModelProfileLookupOptions = {},
): Promise<SetActiveModelProfileResult> {
  assertProfileName(name);
  if (!(await findProfile(location, name, options.inheritFrom))) return { status: "not-found", profile: name };
  const state = await readLocalModelState(location);
  if (state.activeProfile === name) return { status: "unchanged", profile: name };
  await writeLocalModelState(location, { ...state, activeProfile: name });
  return { status: "changed", profile: name };
}

/** Clears the active profile. Returns whether anything changed. */
export async function clearActiveModelProfile(location: IModelProfileLocation): Promise<boolean> {
  const state = await readLocalModelState(location);
  if (state.activeProfile === undefined) return false;
  await writeLocalModelState(location, { schemaVersion: state.schemaVersion, resolutions: state.resolutions });
  return true;
}

/** A profile found in a location, with the scope that defines it. */
export interface IFoundModelProfile {
  readonly profile: IModelProfile;
  readonly definedIn: ModelProfileScope;
}

/** Looks in `location` first, then `inheritFrom`. A same-named local profile fully shadows the other; they are never merged. */
export async function findProfile(
  location: IModelProfileLocation,
  name: string,
  inheritFrom?: IModelProfileLocation,
): Promise<IFoundModelProfile | undefined> {
  const own = (await readModelProfileStore(location)).profiles;
  if (Object.hasOwn(own, name)) return { profile: own[name]!, definedIn: location.scope };
  if (!inheritFrom) return undefined;
  const inherited = (await readModelProfileStore(inheritFrom)).profiles;
  return Object.hasOwn(inherited, name) ? { profile: inherited[name]!, definedIn: inheritFrom.scope } : undefined;
}

/**
 * Explicit project-versus-global precedence, for callers that know both locations:
 *
 * 1. The project's active profile wins; the global active profile applies only when the project
 *    has none. The two are never combined.
 * 2. The selected name is looked up in the project store first, then the global store. A
 *    project profile fully shadows a same-named global profile (`shadowsGlobal`); agents are never
 *    merged across scopes.
 * 3. A name defined in neither scope is `profile-missing`. No other profile is substituted.
 *
 * Saved resolutions belong to the scope that made the selection (`selectedBy`).
 */
export async function selectEffectiveModelProfile(locations: IEffectiveModelProfileLocations): Promise<EffectiveModelProfileSelection> {
  const { project, global } = locations;
  const projectActive = project ? await getActiveModelProfile(project) : undefined;
  const selectedBy: ModelProfileScope | undefined = projectActive !== undefined ? "project" : global && (await getActiveModelProfile(global)) !== undefined ? "global" : undefined;
  if (selectedBy === undefined) return { status: "none" };

  const profile = (selectedBy === "project" ? projectActive : await getActiveModelProfile(global!))!;
  const projectProfiles = project ? (await readModelProfileStore(project)).profiles : {};
  const globalProfiles = global ? (await readModelProfileStore(global)).profiles : {};
  const inProject = Object.hasOwn(projectProfiles, profile);
  const inGlobal = Object.hasOwn(globalProfiles, profile);

  // A global selection can only refer to a global profile: the project must not redefine what a
  // global selection means.
  if (selectedBy === "global" ? !inGlobal : !inProject && !inGlobal) return { status: "profile-missing", profile, selectedBy };
  const definedIn: ModelProfileScope = selectedBy === "global" ? "global" : inProject ? "project" : "global";
  return {
    status: "selected",
    profile,
    selectedBy,
    definedIn,
    shadowsGlobal: definedIn === "project" && inGlobal,
    definition: definedIn === "project" ? projectProfiles[profile]! : globalProfiles[profile]!,
  };
}
