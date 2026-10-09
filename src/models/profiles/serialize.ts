import { compareCodeUnits } from "./sort.js";
import type { ILocalModelState, IModelPreference, IModelPreferenceCriteria, IModelProfileStore } from "./types.js";

/** Deterministic text for a profile store: sorted keys, fixed property order, 2-space indent, LF, trailing newline. */
export function serializeModelProfileStore(store: IModelProfileStore): string {
  const profiles: Record<string, unknown> = {};
  for (const name of sortedKeys(store.profiles)) {
    const agents: Record<string, unknown> = {};
    const profile = store.profiles[name]!;
    for (const agent of sortedKeys(profile.agents)) agents[agent] = orderPreference(profile.agents[agent]!);
    profiles[name] = { agents };
  }
  return `${JSON.stringify({ schemaVersion: store.schemaVersion, profiles }, null, 2)}\n`;
}

/** Deterministic text for the local state document. */
export function serializeLocalModelState(state: ILocalModelState): string {
  const resolutions: Record<string, Record<string, string>> = {};
  for (const profile of sortedKeys(state.resolutions)) {
    const selections = state.resolutions[profile]!;
    // A profile with no saved selections carries no information and is not persisted.
    if (Object.keys(selections).length === 0) continue;
    const ordered: Record<string, string> = {};
    for (const agent of sortedKeys(selections)) ordered[agent] = selections[agent]!;
    resolutions[profile] = ordered;
  }
  const document = state.activeProfile === undefined
    ? { schemaVersion: state.schemaVersion, resolutions }
    : { schemaVersion: state.schemaVersion, activeProfile: state.activeProfile, resolutions };
  return `${JSON.stringify(document, null, 2)}\n`;
}

function orderPreference(preference: IModelPreference): Record<string, unknown> {
  const { fallbacks } = preference;
  return fallbacks && fallbacks.length > 0
    ? { ...orderCriteria(preference), fallbacks: fallbacks.map(orderCriteria) }
    : orderCriteria(preference);
}

function orderCriteria(criteria: IModelPreferenceCriteria): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  if (criteria.id !== undefined) ordered.id = criteria.id;
  if (criteria.family !== undefined) ordered.family = criteria.family;
  if (criteria.allowedProviders !== undefined) ordered.allowedProviders = [...criteria.allowedProviders].sort(compareCodeUnits);
  if (criteria.patterns !== undefined) ordered.patterns = [...criteria.patterns].sort(compareCodeUnits);
  return ordered;
}

function sortedKeys(record: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(record).sort(compareCodeUnits);
}
