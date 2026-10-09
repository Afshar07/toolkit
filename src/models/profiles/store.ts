import { ModelProfileError } from "./errors.js";
import { serializeModelProfileStore } from "./serialize.js";
import { assertAgentName, assertProfileName } from "./names.js";
import { validateModelPreference, validateModelProfile, validateModelProfileStore } from "./schema.js";
import { compareCodeUnits } from "./sort.js";
import { readConfiguration, writeConfiguration, type IConfigurationDocument } from "./storage.js";
import { removeProfileState } from "./state.js";
import type {
  CreateModelProfileResult,
  IModelPreference,
  IModelProfile,
  IModelProfileLocation,
  IModelProfileStore,
  IRemoveModelProfileOptions,
  RemoveAgentModelPreferenceResult,
  RemoveModelProfileResult,
  SetAgentModelPreferenceResult,
  UpdateModelProfileResult,
} from "./types.js";

const profileDocument: IConfigurationDocument<IModelProfileStore> = {
  label: "model profiles",
  validate: validateModelProfileStore,
};

export function emptyModelProfileStore(): IModelProfileStore {
  return { schemaVersion: 1, profiles: {} };
}

/**
 * Reads the portable profile store. An absent file is an empty store, not corruption. A malformed,
 * unsafe, or newer-schema file throws `ModelProfileError`. Does not require OpenCode.
 */
export async function readModelProfileStore(location: IModelProfileLocation): Promise<IModelProfileStore> {
  return (await readConfiguration(location, location.profilesPath, profileDocument))?.value ?? emptyModelProfileStore();
}

/** Validates, then atomically writes the store. Returns `false` (and writes nothing) when the content is unchanged. */
export async function writeModelProfileStore(location: IModelProfileLocation, store: IModelProfileStore): Promise<boolean> {
  const validated = validateModelProfileStore(store);
  if (!validated.ok) throw new ModelProfileError("invalid-input", "Refusing to write an invalid model profile store.", { issues: validated.issues });
  return writeConfiguration(location, location.profilesPath, profileDocument, serializeModelProfileStore(validated.value));
}

/** Profile names in code-unit order. */
export async function listModelProfiles(location: IModelProfileLocation): Promise<string[]> {
  return Object.keys((await readModelProfileStore(location)).profiles).sort(compareCodeUnits);
}

export async function getModelProfile(location: IModelProfileLocation, name: string): Promise<IModelProfile | undefined> {
  assertProfileName(name);
  const profiles = (await readModelProfileStore(location)).profiles;
  return Object.hasOwn(profiles, name) ? profiles[name] : undefined;
}

/** Creates a profile (empty by default). An existing profile is reported, never replaced. */
export async function createModelProfile(location: IModelProfileLocation, name: string, profile: IModelProfile = { agents: {} }): Promise<CreateModelProfileResult> {
  assertProfileName(name);
  const value = validProfile(profile);
  const store = await readModelProfileStore(location);
  if (Object.hasOwn(store.profiles, name)) return { status: "already-exists", profile: name };
  await writeModelProfileStore(location, { ...store, profiles: { ...store.profiles, [name]: value } });
  return { status: "changed", profile: name, value };
}

/** Replaces an existing profile's whole definition. Reports `unchanged` without writing when identical. */
export async function updateModelProfile(location: IModelProfileLocation, name: string, profile: IModelProfile): Promise<UpdateModelProfileResult> {
  assertProfileName(name);
  const value = validProfile(profile);
  return replaceProfile(location, name, () => value);
}

/** Sets (or replaces) one agent's preference. The agent need not be a canonical Toolkit agent. */
export async function setAgentModelPreference(
  location: IModelProfileLocation,
  profile: string,
  agent: string,
  preference: IModelPreference,
): Promise<SetAgentModelPreferenceResult> {
  assertProfileName(profile);
  assertAgentName(agent);
  const validated = validateModelPreference(preference, `agents.${agent}`);
  if (!validated.ok) throw new ModelProfileError("invalid-input", `Invalid model preference for agent "${agent}".`, { issues: validated.issues });
  return replaceProfile(location, profile, (current) => ({ agents: { ...current.agents, [agent]: validated.value } }));
}

export async function removeAgentModelPreference(location: IModelProfileLocation, profile: string, agent: string): Promise<RemoveAgentModelPreferenceResult> {
  assertProfileName(profile);
  assertAgentName(agent);
  const store = await readModelProfileStore(location);
  const current = Object.hasOwn(store.profiles, profile) ? store.profiles[profile] : undefined;
  if (!current) return { status: "not-found", profile };
  if (!Object.hasOwn(current.agents, agent)) return { status: "agent-not-found", profile, agent };
  const { [agent]: _removed, ...agents } = current.agents;
  const value: IModelProfile = { agents };
  await writeModelProfileStore(location, { ...store, profiles: { ...store.profiles, [profile]: value } });
  return { status: "changed", profile, value };
}

/**
 * Removes a profile without ever leaving the active-profile reference dangling:
 *
 * - Not active here: removed; its saved local resolutions are dropped with it.
 * - Active here: nothing changes unless the caller passes `replacementProfile` (must exist and
 *   differ) or `deactivate: true` (clears the active profile). Otherwise `active-profile` is returned.
 *
 * The local state is updated before the profile document, so an interrupted removal leaves the
 * profile defined (and merely inactive) rather than active but undefined.
 */
export async function removeModelProfile(location: IModelProfileLocation, name: string, options: IRemoveModelProfileOptions = {}): Promise<RemoveModelProfileResult> {
  assertProfileName(name);
  if (options.replacementProfile !== undefined && options.deactivate) {
    throw new ModelProfileError("invalid-input", "Choose either a replacement profile or deactivation, not both.");
  }
  if (options.replacementProfile !== undefined) assertProfileName(options.replacementProfile);

  const store = await readModelProfileStore(location);
  if (!Object.hasOwn(store.profiles, name)) return { status: "not-found", profile: name };

  const replacement = options.replacementProfile;
  if (replacement !== undefined) {
    const available = replacement !== name && (Object.hasOwn(store.profiles, replacement) || (options.inheritFrom !== undefined && Object.hasOwn((await readModelProfileStore(options.inheritFrom)).profiles, replacement)));
    if (!available) return { status: "replacement-not-found", profile: name, replacement };
  }

  const { [name]: _removed, ...remaining } = store.profiles;
  const state = await removeProfileState(location, name, { replacement, deactivate: options.deactivate === true });
  if (state.status === "blocked") return { status: "active-profile", profile: name };

  await writeModelProfileStore(location, { ...store, profiles: remaining });
  return { status: "removed", profile: name, activeProfile: state.activeProfile, wasActive: state.wasActive };
}

async function replaceProfile(
  location: IModelProfileLocation,
  name: string,
  change: (current: IModelProfile) => IModelProfile,
): Promise<UpdateModelProfileResult> {
  const store = await readModelProfileStore(location);
  const current = Object.hasOwn(store.profiles, name) ? store.profiles[name] : undefined;
  if (!current) return { status: "not-found", profile: name };
  const value = validProfile(change(current));
  // Compare canonical text, so a no-op never rewrites (and never reformats) a hand-edited file.
  const unchanged = serializeModelProfileStore({ ...store, profiles: { [name]: current } }) === serializeModelProfileStore({ ...store, profiles: { [name]: value } });
  if (unchanged) return { status: "unchanged", profile: name, value: current };
  await writeModelProfileStore(location, { ...store, profiles: { ...store.profiles, [name]: value } });
  return { status: "changed", profile: name, value };
}

function validProfile(profile: IModelProfile): IModelProfile {
  const validated = validateModelProfile(profile);
  if (!validated.ok) throw new ModelProfileError("invalid-input", "Invalid model profile.", { issues: validated.issues });
  return validated.value;
}
