import type { AgentTarget, IAgentTarget } from "../../agents/target.js";
import type { IModelRef, IModelDiscoverySource } from "../types.js";
import type { IModelProfile, IModelProfileLocation, IModelProfileResolution, ModelResolutionSelections } from "../profiles/types.js";

export interface IPlanModelProfileOptions {
  readonly target: AgentTarget;
  readonly profile?: string;
  /**
   * An in-memory profile definition used instead of looking `profile` up in the stores. Requires an explicit
   * `profile` name (used for validation, local selections, and state) and must satisfy the profile schema.
   * Planning and applying never write it to the portable profile store.
   */
  readonly profileDefinition?: IModelProfile;
  /** Exact `provider/model` IDs by agent that override saved local selections for this plan only. */
  readonly selections?: ModelResolutionSelections;
  /**
   * Restricts resolution and application to these agents of the profile. Other agents are neither resolved,
   * checked, nor changed, and their saved selections are kept. Must be non-empty and name only profile agents.
   */
  readonly agents?: readonly string[];
  readonly models?: readonly IModelRef[];
  readonly source?: IModelDiscoverySource;
  readonly inheritFrom?: IModelProfileLocation;
  /** A project context to inspect for shadowing a global application; never written. */
  readonly project?: string;
  readonly replaceAssignments?: ReadonlySet<string>;
}
export interface IModelAssignmentPlan {
  readonly agent: string;
  readonly model: string;
  readonly previous: unknown;
  readonly ownership: "absent" | "managed-current" | "edited" | "unmanaged" | "identical";
  readonly status: "apply" | "unchanged" | "conflict" | "skipped-override" | "missing-agent" | "unmanaged-agent" | "modified-agent" | "migration-required";
}
export interface IPlannedModelFile {
  readonly path: string;
  readonly before: string | undefined;
  readonly after: string;
}
export interface IModelProfilePlan {
  readonly status: "ready" | "blocked" | "not-found" | "no-profile" | "config-conflict";
  readonly target: IAgentTarget;
  readonly profile?: string;
  readonly resolution?: IModelProfileResolution;
  readonly assignments: readonly IModelAssignmentPlan[];
  readonly files: readonly IPlannedModelFile[];
  readonly conflicts: readonly string[];
  readonly shadowed: readonly string[];
  /** Snapshots include read dependencies, not just files to write. */
  readonly snapshots: readonly { readonly path: string; readonly text: string | undefined; readonly target?: IAgentTarget }[];
}
export interface IApplyModelProfileOptions extends IPlanModelProfileOptions {
  readonly dryRun?: boolean;
}
export interface IApplyModelPlanOptions { readonly dryRun?: boolean }
export interface IApplyModelProfileResult {
  readonly status: "applied" | "unchanged" | "dry-run" | "blocked" | "failed";
  readonly plan: IModelProfilePlan;
  readonly filesChanged: readonly string[];
  readonly backups: readonly string[];
  readonly manualIntervention: readonly string[];
  readonly error?: string;
}
