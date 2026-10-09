import { ModelProfileError } from "../profiles/errors.js";
import type { IModelProfilePlan } from "./types.js";

const approvals = new WeakMap<IModelProfilePlan, string>();
/** Process-local plans cannot be substituted or mutated after validation. */
export function approveModelPlan(plan: IModelProfilePlan): IModelProfilePlan {
  approvals.set(plan, JSON.stringify(plan));
  return plan;
}
export function assertApprovedModelPlan(plan: IModelProfilePlan): void {
  if (approvals.get(plan) !== JSON.stringify(plan)) throw new ModelProfileError("invalid-input", "Unknown or modified model plan; generate a fresh plan before applying.");
}
