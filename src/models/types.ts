/** A complete, validated `provider/model` reference. Only the first `/` separates the provider. */
export interface IModelRef {
  /** Complete ID exactly as reported, e.g. `openai/gpt-5.5` or `openrouter/anthropic/claude-3.5-sonnet`. */
  readonly id: string;
  readonly provider: string;
  /** Everything after the first `/`; may itself contain `/` and numeric suffixes. */
  readonly modelId: string;
  /** `normalizeModelFamily(modelId)`; used only for exact family comparison. */
  readonly family: string;
}

export type ModelRejectionReason =
  | "invalid-characters"
  | "missing-separator"
  | "empty-segment"
  | "invalid-provider"
  | "invalid-model"
  | "too-long";

export interface IRejectedModelEntry {
  /** 1-based line in the discovery output. */
  readonly line: number;
  /** The offending entry, truncated for safe display. */
  readonly entry: string;
  readonly reason: ModelRejectionReason;
}

export interface IParsedModelList {
  /** Valid entries in output order; duplicates are preserved at this stage. */
  readonly models: readonly IModelRef[];
  readonly rejected: readonly IRejectedModelEntry[];
}

export interface IModelInventory {
  /** Unique models, sorted by provider then model ID, after any filter. */
  readonly models: readonly IModelRef[];
  readonly rejected: readonly IRejectedModelEntry[];
  /** Unique models discovered before filtering. */
  readonly totalDiscovered: number;
  /** Repeated exact IDs collapsed during discovery. */
  readonly duplicateCount: number;
  /** True when `models` is empty (nothing discovered, or nothing matched the filter). */
  readonly isEmpty: boolean;
}

/**
 * Providers and families are exact filters. An omitted field applies no restriction;
 * an empty array matches nothing.
 */
export interface IModelFilter {
  readonly providers?: readonly string[];
  /** Compared after `normalizeModelFamily`. */
  readonly families?: readonly string[];
}

/** Injectable source of raw `provider/model`-per-line text. Tests supply fixtures. */
export interface IModelDiscoverySource {
  read(): Promise<string>;
}

export interface IOpenCodeModelSourceOptions {
  /** Executable name or path. Never run through a shell. Defaults to `opencode`. */
  readonly command?: string;
  /** Arguments passed verbatim. Defaults to `["models"]`. */
  readonly arguments?: readonly string[];
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly cwd?: string;
  /** Extra environment variables merged over the inherited environment. */
  readonly environment?: Readonly<Record<string, string>>;
}

export interface IDiscoverModelsOptions {
  /** Defaults to the installed OpenCode CLI. */
  readonly source?: IModelDiscoverySource;
  /** Options for the default OpenCode source; ignored when `source` is provided. */
  readonly openCode?: IOpenCodeModelSourceOptions;
  readonly filter?: IModelFilter;
}

export type ModelDiscoveryErrorKind =
  | "unavailable"
  | "timeout"
  | "exit"
  | "output-too-large"
  | "malformed-output"
  | "failed";

export interface IModelResolutionRequest {
  /** Exact configured `provider/model` ID. Highest priority; not restricted by `allowedProviders`. */
  readonly id?: string;
  /** Model family, compared exactly after normalization. Requires `allowedProviders`. */
  readonly family?: string;
  /**
   * Providers the caller explicitly permits. Family matching is skipped without it.
   * When present it also scopes `patterns`.
   */
  readonly allowedProviders?: readonly string[];
  /** Explicit globs (`*`, `?`) against the complete ID, case-insensitive. Matches from all patterns are pooled. */
  readonly patterns?: readonly string[];
}

export type ModelMatchStage = "id" | "family" | "pattern";

export interface IResolvedModelResolution {
  readonly status: "resolved";
  readonly model: IModelRef;
  readonly matchedBy: ModelMatchStage;
  /** Always the single resolved model. */
  readonly candidates: readonly IModelRef[];
}

export interface IAmbiguousModelResolution {
  readonly status: "ambiguous";
  readonly stage: Exclude<ModelMatchStage, "id">;
  /** Every model that matched at this stage, sorted. None was chosen. */
  readonly candidates: readonly IModelRef[];
}

export type ModelUnavailableReason = "no-criteria" | "empty-inventory" | "no-match";

export interface IUnavailableModelResolution {
  readonly status: "unavailable";
  readonly reason: ModelUnavailableReason;
  /** Always empty: unmatched requests are never answered with guesses. */
  readonly candidates: readonly IModelRef[];
}

export type ModelResolution = IResolvedModelResolution | IAmbiguousModelResolution | IUnavailableModelResolution;
