import { ModelProfileError } from "./errors.js";
import { serializeLocalModelState } from "./serialize.js";
import { validateLocalModelState } from "./schema.js";
import { readConfiguration, writeConfiguration, type IConfigurationDocument } from "./storage.js";
import type { ILocalModelState, IModelProfileLocation, ModelResolutionSelections } from "./types.js";

const stateDocument: IConfigurationDocument<ILocalModelState> = {
  label: "local model state",
  validate: validateLocalModelState,
};

export function emptyLocalModelState(): ILocalModelState {
  return { schemaVersion: 1, resolutions: {} };
}

/**
 * Reads the machine-specific state. An absent file is empty state, not corruption. The state holds
 * only the active profile name and exact `provider/model` IDs: no inventory, no credentials.
 */
export async function readLocalModelState(location: IModelProfileLocation): Promise<ILocalModelState> {
  return (await readConfiguration(location, location.statePath, stateDocument))?.value ?? emptyLocalModelState();
}

/** Validates, then atomically writes the state. Returns `false` (and writes nothing) when unchanged. */
export async function writeLocalModelState(location: IModelProfileLocation, state: ILocalModelState): Promise<boolean> {
  const validated = validateLocalModelState(state);
  if (!validated.ok) throw new ModelProfileError("invalid-input", "Refusing to write invalid local model state.", { issues: validated.issues });
  return writeConfiguration(location, location.statePath, stateDocument, serializeLocalModelState(validated.value));
}

export interface IProfileStateRemoval {
  readonly status: "updated";
  readonly activeProfile: string | undefined;
  readonly wasActive: boolean;
}

export interface IProfileStateRemovalBlocked {
  readonly status: "blocked";
}

/**
 * Detaches a profile from local state: drops its saved selections and resolves the active-profile
 * reference. Returns `blocked` (writing nothing) when the profile is active and the caller supplied
 * neither a replacement nor `deactivate`.
 */
export async function removeProfileState(
  location: IModelProfileLocation,
  profile: string,
  options: { readonly replacement?: string; readonly deactivate: boolean },
): Promise<IProfileStateRemoval | IProfileStateRemovalBlocked> {
  const state = await readLocalModelState(location);
  const wasActive = state.activeProfile === profile;
  if (wasActive && options.replacement === undefined && !options.deactivate) return { status: "blocked" };

  // Nothing to detach: do not create a state file just to record an empty state.
  if (!wasActive && !Object.hasOwn(state.resolutions, profile)) return { status: "updated", activeProfile: state.activeProfile, wasActive };

  const { [profile]: _dropped, ...resolutions } = state.resolutions;
  const activeProfile = wasActive ? options.replacement : state.activeProfile;
  await writeLocalModelState(location, activeProfile === undefined ? { schemaVersion: 1, resolutions } : { schemaVersion: 1, activeProfile, resolutions });
  return { status: "updated", activeProfile, wasActive };
}

export function selectionsFor(state: ILocalModelState, profile: string): ModelResolutionSelections {
  return Object.hasOwn(state.resolutions, profile) ? state.resolutions[profile]! : {};
}
