import type { IModelRef, ModelMatchStage, ModelUnavailableReason } from "../types.js";

export type ModelProfileScope = "project" | "global";

/** One problem found while validating a configuration value. `path` is dotted, e.g. `profiles.openai.agents.lead.family`. */
export interface IModelProfileIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * One way of choosing a model. Fields map directly onto Phase 1's `IModelResolutionRequest`:
 * `id` is an exact `provider/model`, `family` needs `allowedProviders`, and `patterns` are explicit globs.
 * `allowedProviders` restricts candidates; it never establishes priority.
 */
export interface IModelPreferenceCriteria {
  readonly id?: string;
  readonly family?: string;
  readonly allowedProviders?: readonly string[];
  readonly patterns?: readonly string[];
}

/** A primary preference plus ordered fallbacks. Fallbacks are tried only while earlier entries are unavailable. */
export interface IModelPreference extends IModelPreferenceCriteria {
  readonly fallbacks?: readonly IModelPreferenceCriteria[];
}

/** Logical agent name to preference. Agent names are not restricted to the canonical registry. */
export type ModelProfileAgents = Readonly<Record<string, IModelPreference>>;

export interface IModelProfile {
  readonly agents: ModelProfileAgents;
}

/** The portable, versioned profile document. Contains preferences only, never concrete local choices. */
export interface IModelProfileStore {
  readonly schemaVersion: 1;
  readonly profiles: Readonly<Record<string, IModelProfile>>;
}

/** Agent name to exact `provider/model` ID chosen on this machine. */
export type ModelResolutionSelections = Readonly<Record<string, string>>;

/** The machine-specific document: active profile and exact selections. Never portable, never credentials. */
export interface ILocalModelState {
  readonly schemaVersion: 1;
  readonly activeProfile?: string;
  readonly resolutions: Readonly<Record<string, ModelResolutionSelections>>;
}

export interface IModelProfileValid<T> {
  readonly ok: true;
  readonly value: T;
}

export interface IModelProfileInvalid {
  readonly ok: false;
  readonly issues: readonly IModelProfileIssue[];
}

export type ModelProfileValidation<T> = IModelProfileValid<T> | IModelProfileInvalid;

/** Where the two documents for one scope live. Structurally an `IAgentTarget`, so agent safety checks apply. */
export interface IModelProfileLocation {
  readonly scope: ModelProfileScope;
  readonly root: string;
  readonly directory: string;
  readonly profilesPath: string;
  readonly statePath: string;
}

// --- Profile management outcomes -------------------------------------------------------------

export interface IModelProfileChange {
  readonly status: "changed" | "unchanged";
  readonly profile: string;
  readonly value: IModelProfile;
}

export interface IModelProfileNotFound {
  readonly status: "not-found";
  readonly profile: string;
}

export interface IModelProfileAlreadyExists {
  readonly status: "already-exists";
  readonly profile: string;
}

export interface IModelAgentNotFound {
  readonly status: "agent-not-found";
  readonly profile: string;
  readonly agent: string;
}

export type CreateModelProfileResult = IModelProfileChange | IModelProfileAlreadyExists;
export type UpdateModelProfileResult = IModelProfileChange | IModelProfileNotFound;
export type SetAgentModelPreferenceResult = IModelProfileChange | IModelProfileNotFound;
export type RemoveAgentModelPreferenceResult = IModelProfileChange | IModelProfileNotFound | IModelAgentNotFound;

export interface IModelProfileLookupOptions {
  /** Another location whose profiles may be referenced by name when this location does not define them. */
  readonly inheritFrom?: IModelProfileLocation;
}

export interface IRemoveModelProfileOptions extends IModelProfileLookupOptions {
  /** Becomes the active profile when the removed profile was active. Must exist and differ from the removed profile. */
  readonly replacementProfile?: string;
  /** Clears the active profile when the removed profile was active. Mutually exclusive with `replacementProfile`. */
  readonly deactivate?: boolean;
}

export interface IModelProfileRemoved {
  readonly status: "removed";
  readonly profile: string;
  /** Active profile after removal; `undefined` after deactivation or when another profile was active. */
  readonly activeProfile: string | undefined;
  readonly wasActive: boolean;
}

/** The profile is active and neither a replacement nor `deactivate` was given. Nothing was changed. */
export interface IModelProfileRemovalBlocked {
  readonly status: "active-profile";
  readonly profile: string;
}

export interface IModelProfileReplacementNotFound {
  readonly status: "replacement-not-found";
  readonly profile: string;
  readonly replacement: string;
}

export type RemoveModelProfileResult =
  | IModelProfileRemoved
  | IModelProfileNotFound
  | IModelProfileRemovalBlocked
  | IModelProfileReplacementNotFound;

export interface IActiveModelProfileChange {
  readonly status: "changed" | "unchanged";
  readonly profile: string;
}

export type SetActiveModelProfileResult = IActiveModelProfileChange | IModelProfileNotFound;

export interface ISavedModelResolutions {
  readonly status: "changed" | "unchanged";
  readonly profile: string;
  /** Every saved selection for the profile after the operation. */
  readonly selections: ModelResolutionSelections;
}

export interface IModelSelectionIncompatible {
  readonly status: "incompatible";
  readonly profile: string;
  readonly agent: string;
  readonly id: string;
}

export type SaveModelResolutionsResult =
  | ISavedModelResolutions
  | IModelProfileNotFound
  | IModelAgentNotFound
  | IModelSelectionIncompatible;

// --- Resolution outcomes ---------------------------------------------------------------------

export type StaleSelectionReason = "missing" | "incompatible";

/** A previously saved selection that could not be reused. It is reported, never silently dropped. */
export interface IStaleModelSelection {
  readonly id: string;
  /** `missing`: not in the inventory. `incompatible`: present, but not a candidate of the current preference. */
  readonly reason: StaleSelectionReason;
}

export interface IResolvedAgentModel {
  readonly status: "resolved";
  readonly model: IModelRef;
  /** `saved` when a valid saved selection was reused; `preference` when Phase 1 matching alone decided. */
  readonly source: "saved" | "preference";
  readonly matchedBy: ModelMatchStage;
  /** 0 is the primary preference; n is the nth fallback. */
  readonly criterionIndex: number;
  readonly staleSelection?: IStaleModelSelection;
}

export interface IAmbiguousAgentModel {
  readonly status: "ambiguous";
  readonly stage: Exclude<ModelMatchStage, "id">;
  readonly candidates: readonly IModelRef[];
  readonly criterionIndex: number;
  readonly staleSelection?: IStaleModelSelection;
}

export interface IUnavailableAgentModel {
  readonly status: "unavailable";
  readonly reason: ModelUnavailableReason;
  readonly staleSelection?: IStaleModelSelection;
}

export interface IInvalidAgentModel {
  readonly status: "invalid";
  readonly issues: readonly IModelProfileIssue[];
}

export type AgentModelResolution =
  | IResolvedAgentModel
  | IAmbiguousAgentModel
  | IUnavailableAgentModel
  | IInvalidAgentModel;

export interface IAgentModelResolutionOptions {
  /** A previously saved exact ID for this agent. */
  readonly savedId?: string;
}

export interface IModelProfileResolutionOptions {
  /** Saved selections by agent name. */
  readonly selections?: ModelResolutionSelections;
}

export interface IModelProfileResolutionSummary {
  readonly resolved: number;
  readonly ambiguous: number;
  readonly unavailable: number;
  readonly invalid: number;
}

export interface IModelProfileResolution {
  /** Every agent in the profile, in sorted order. Outcomes are independent. */
  readonly agents: Readonly<Record<string, AgentModelResolution>>;
  readonly summary: IModelProfileResolutionSummary;
  /** True only when every agent resolved. */
  readonly complete: boolean;
  /** Saved selections for agents the profile no longer defines. They are ignored, not deleted. */
  readonly unusedSelections: readonly string[];
}

export interface IStoredModelProfileResolution {
  readonly status: "found";
  readonly profile: string;
  readonly definedIn: ModelProfileScope;
  readonly resolution: IModelProfileResolution;
}

export interface IStoredAgentModelResolution {
  readonly status: "found";
  readonly profile: string;
  readonly agent: string;
  readonly definedIn: ModelProfileScope;
  readonly resolution: AgentModelResolution;
}

export type ResolveStoredModelProfileResult = IStoredModelProfileResolution | IModelProfileNotFound;
export type ResolveStoredAgentModelResult = IStoredAgentModelResolution | IModelProfileNotFound | IModelAgentNotFound;

// --- Scope precedence ------------------------------------------------------------------------

export interface IEffectiveModelProfileLocations {
  readonly project?: IModelProfileLocation;
  readonly global?: IModelProfileLocation;
}

export interface INoEffectiveModelProfile {
  readonly status: "none";
}

/** A scope names a profile that neither scope defines. Nothing is substituted. */
export interface IMissingEffectiveModelProfile {
  readonly status: "profile-missing";
  readonly profile: string;
  readonly selectedBy: ModelProfileScope;
}

export interface ISelectedEffectiveModelProfile {
  readonly status: "selected";
  readonly profile: string;
  readonly selectedBy: ModelProfileScope;
  readonly definedIn: ModelProfileScope;
  /** True when the project defines the profile and the global store defines one with the same name. */
  readonly shadowsGlobal: boolean;
  readonly definition: IModelProfile;
}

export type EffectiveModelProfileSelection =
  | INoEffectiveModelProfile
  | IMissingEffectiveModelProfile
  | ISelectedEffectiveModelProfile;
