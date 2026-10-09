import { normalizeModelFamily } from "../normalize.js";
import { isValidModelName, isValidModelPattern, isValidModelProvider, parseModelId } from "../parse.js";
import { sortCodeUnits } from "./sort.js";
import type {
  ILocalModelState,
  IModelPreference,
  IModelPreferenceCriteria,
  IModelProfile,
  IModelProfileIssue,
  IModelProfileStore,
  ModelProfileValidation,
} from "./types.js";

/** The only schema version this Toolkit reads and writes. Later versions are rejected, never guessed at. */
export const supportedModelProfileSchemaVersion = 1;

export const maxProfileNameLength = 64;
export const maxAgentNameLength = 64;
const maxProviders = 32;
const maxPatterns = 16;
const maxFallbacks = 8;
const maxIssues = 50;

/** Same shape as canonical agent names, so any registry agent (including `external-researcher`) is valid. */
const namePattern = /^[a-z0-9][a-z0-9-]*$/;

const criteriaKeys = ["id", "family", "allowedProviders", "patterns"] as const;
const preferenceKeys = [...criteriaKeys, "fallbacks"] as const;

export function isValidProfileName(value: unknown): value is string {
  return typeof value === "string" && value.length <= maxProfileNameLength && namePattern.test(value);
}

export function isValidAgentName(value: unknown): value is string {
  return typeof value === "string" && value.length <= maxAgentNameLength && namePattern.test(value);
}

/**
 * Validates an untrusted profile document. Unknown properties are rejected rather than dropped:
 * a typo must not silently turn a restriction into no restriction, and a newer field must arrive
 * with a new `schemaVersion`.
 */
export function validateModelProfileStore(value: unknown): ModelProfileValidation<IModelProfileStore> {
  const issues = new IssueList();
  const record = expectRecord(value, "", issues);
  if (!record) return issues.result();
  checkKeys(record, ["schemaVersion", "profiles"], "", issues);
  checkSchemaVersion(record, issues);

  const profiles: Record<string, IModelProfile> = {};
  const profilesValue = expectRecord(record.profiles, "profiles", issues);
  if (profilesValue) {
    for (const [name, profileValue] of Object.entries(profilesValue)) {
      const path = `profiles.${name}`;
      if (!isValidProfileName(name)) {
        issues.add(path, `Invalid profile name "${display(name)}"; use lowercase letters, digits, and hyphens (at most ${maxProfileNameLength} characters).`);
        continue;
      }
      const profile = readProfile(profileValue, path, issues);
      if (profile) profiles[name] = profile;
    }
  }
  return issues.result({ schemaVersion: 1, profiles });
}

export function validateModelProfile(value: unknown, path = "profile"): ModelProfileValidation<IModelProfile> {
  const issues = new IssueList();
  const profile = readProfile(value, path, issues);
  return profile ? issues.result(profile) : issues.result();
}

export function validateModelPreference(value: unknown, path = "preference"): ModelProfileValidation<IModelPreference> {
  const issues = new IssueList();
  const preference = readPreference(value, path, issues);
  return preference ? issues.result(preference) : issues.result();
}

/** Validates the machine-specific document: active profile name and exact `provider/model` selections. */
export function validateLocalModelState(value: unknown): ModelProfileValidation<ILocalModelState> {
  const issues = new IssueList();
  const record = expectRecord(value, "", issues);
  if (!record) return issues.result();
  checkKeys(record, ["schemaVersion", "activeProfile", "resolutions"], "", issues);
  checkSchemaVersion(record, issues);

  let activeProfile: string | undefined;
  if (record.activeProfile !== undefined) {
    if (isValidProfileName(record.activeProfile)) activeProfile = record.activeProfile;
    else issues.add("activeProfile", "Must be a valid profile name.");
  }

  const resolutions: Record<string, Record<string, string>> = {};
  const resolutionsValue = expectRecord(record.resolutions, "resolutions", issues);
  if (resolutionsValue) {
    for (const [profile, agentsValue] of Object.entries(resolutionsValue)) {
      const path = `resolutions.${profile}`;
      if (!isValidProfileName(profile)) {
        issues.add(path, `Invalid profile name "${display(profile)}".`);
        continue;
      }
      const agents = expectRecord(agentsValue, path, issues);
      if (!agents) continue;
      const selections: Record<string, string> = {};
      for (const [agent, id] of Object.entries(agents)) {
        const agentPath = `${path}.${agent}`;
        if (!isValidAgentName(agent)) issues.add(agentPath, `Invalid agent name "${display(agent)}".`);
        else if (!isCompleteModelId(id)) issues.add(agentPath, "Must be a complete, valid provider/model ID.");
        else selections[agent] = id;
      }
      resolutions[profile] = selections;
    }
  }
  return issues.result(activeProfile === undefined ? { schemaVersion: 1, resolutions } : { schemaVersion: 1, activeProfile, resolutions });
}

/** True when `value` is already in the exact form `provider/model` (no surrounding whitespace). */
export function isCompleteModelId(value: unknown): value is string {
  return typeof value === "string" && parseModelId(value)?.id === value;
}

function readProfile(value: unknown, path: string, issues: IssueList): IModelProfile | undefined {
  const record = expectRecord(value, path, issues);
  if (!record) return undefined;
  checkKeys(record, ["agents"], path, issues);
  const agents: Record<string, IModelPreference> = {};
  const agentsValue = expectRecord(record.agents, `${path}.agents`, issues);
  if (agentsValue) {
    for (const [name, preferenceValue] of Object.entries(agentsValue)) {
      const agentPath = `${path}.agents.${name}`;
      if (!isValidAgentName(name)) {
        issues.add(agentPath, `Invalid agent name "${display(name)}"; use lowercase letters, digits, and hyphens (at most ${maxAgentNameLength} characters).`);
        continue;
      }
      const preference = readPreference(preferenceValue, agentPath, issues);
      if (preference) agents[name] = preference;
    }
  }
  return { agents };
}

function readPreference(value: unknown, path: string, issues: IssueList): IModelPreference | undefined {
  const record = expectRecord(value, path, issues);
  if (!record) return undefined;
  checkKeys(record, preferenceKeys, path, issues);
  const criteria = readCriteria(record, path, issues);

  let fallbacks: IModelPreferenceCriteria[] | undefined;
  if (record.fallbacks !== undefined) {
    const fallbackPath = `${path}.fallbacks`;
    if (!Array.isArray(record.fallbacks) || record.fallbacks.length === 0 || record.fallbacks.length > maxFallbacks) {
      issues.add(fallbackPath, `Must be a non-empty array of at most ${maxFallbacks} preferences.`);
    } else {
      fallbacks = [];
      record.fallbacks.forEach((entry: unknown, index: number) => {
        const entryPath = `${fallbackPath}[${index}]`;
        const entryRecord = expectRecord(entry, entryPath, issues);
        if (!entryRecord) return;
        checkKeys(entryRecord, criteriaKeys, entryPath, issues);
        const entryCriteria = readCriteria(entryRecord, entryPath, issues);
        if (entryCriteria) fallbacks!.push(entryCriteria);
      });
    }
  }
  if (!criteria) return undefined;
  return fallbacks && fallbacks.length > 0 ? { ...criteria, fallbacks } : criteria;
}

function readCriteria(record: Record<string, unknown>, path: string, issues: IssueList): IModelPreferenceCriteria | undefined {
  const before = issues.count;
  const criteria: { id?: string; family?: string; allowedProviders?: string[]; patterns?: string[] } = {};

  if (record.id !== undefined) {
    if (isCompleteModelId(record.id)) criteria.id = record.id;
    else issues.add(`${path}.id`, "Must be a complete, valid provider/model ID.");
  }
  if (record.family !== undefined) {
    if (typeof record.family === "string" && normalizeModelFamily(record.family) !== "" && isValidModelName(record.family)) criteria.family = record.family;
    else issues.add(`${path}.family`, "Must be a valid model family name.");
  }
  if (record.allowedProviders !== undefined) {
    const providers = readStringList(record.allowedProviders, `${path}.allowedProviders`, maxProviders, isValidModelProvider, "a valid provider name", (value) => value, issues);
    if (providers) criteria.allowedProviders = providers;
  }
  if (record.patterns !== undefined) {
    const patterns = readStringList(record.patterns, `${path}.patterns`, maxPatterns, isValidModelPattern, "a valid glob (using * and ? only, with at least one literal character)", (value) => value.toLowerCase(), issues);
    if (patterns) criteria.patterns = patterns;
  }

  if (issues.count > before) return undefined;
  // Provider and pattern lists are sets: sorting makes it explicit that order never means priority
  // and keeps serialization deterministic.
  if (criteria.allowedProviders) criteria.allowedProviders = sortCodeUnits(criteria.allowedProviders);
  if (criteria.patterns) criteria.patterns = sortCodeUnits(criteria.patterns);
  if (criteria.id === undefined && criteria.family === undefined && criteria.patterns === undefined) {
    issues.add(path, "Must specify at least one of id, family, or patterns.");
    return undefined;
  }
  if (criteria.family !== undefined && criteria.allowedProviders === undefined) {
    issues.add(`${path}.allowedProviders`, "Required with family: family matching only considers explicitly allowed providers.");
    return undefined;
  }
  if (criteria.id !== undefined && criteria.allowedProviders !== undefined) {
    const provider = parseModelId(criteria.id)!.provider;
    if (!criteria.allowedProviders.includes(provider)) {
      issues.add(`${path}.id`, `Conflicts with allowedProviders: provider "${provider}" is not allowed.`);
      return undefined;
    }
  }
  return criteria;
}

function readStringList(
  value: unknown,
  path: string,
  limit: number,
  isValid: (entry: string) => boolean,
  description: string,
  key: (entry: string) => string,
  issues: IssueList,
): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > limit) {
    issues.add(path, `Must be a non-empty array of at most ${limit} entries.`);
    return undefined;
  }
  const result: string[] = [];
  const seen = new Set<string>();
  let valid = true;
  value.forEach((entry: unknown, index: number) => {
    if (typeof entry !== "string" || !isValid(entry)) {
      issues.add(`${path}[${index}]`, `Must be ${description}.`);
      valid = false;
    } else if (seen.has(key(entry))) {
      issues.add(`${path}[${index}]`, `Duplicate entry "${display(entry)}".`);
      valid = false;
    } else {
      seen.add(key(entry));
      result.push(entry);
    }
  });
  return valid ? result : undefined;
}

function checkSchemaVersion(record: Record<string, unknown>, issues: IssueList): void {
  if (record.schemaVersion !== supportedModelProfileSchemaVersion) {
    issues.add("schemaVersion", `Must be ${supportedModelProfileSchemaVersion}.`);
  }
}

function checkKeys(record: Record<string, unknown>, allowed: readonly string[], path: string, issues: IssueList): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) issues.add(path === "" ? key : `${path}.${key}`, `Unknown property "${display(key)}".`);
  }
}

function expectRecord(value: unknown, path: string, issues: IssueList): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  issues.add(path === "" ? "(root)" : path, "Must be an object.");
  return undefined;
}

/** Keeps arbitrary configuration text from flooding messages or smuggling control characters into them. */
function display(value: string): string {
  // eslint-disable-next-line no-control-regex
  const safe = value.replace(/[\u0000-\u001f\u007f]/g, "?");
  return safe.length > 60 ? `${safe.slice(0, 60)}…` : safe;
}

class IssueList {
  private readonly items: IModelProfileIssue[] = [];

  get count(): number {
    return this.items.length;
  }

  add(path: string, message: string): void {
    if (this.items.length < maxIssues) this.items.push({ path, message });
  }

  result<T>(value?: T): ModelProfileValidation<T> {
    if (this.items.length > 0 || value === undefined) {
      return { ok: false, issues: this.items.length > 0 ? this.items : [{ path: "(root)", message: "Invalid value." }] };
    }
    return { ok: true, value };
  }
}
