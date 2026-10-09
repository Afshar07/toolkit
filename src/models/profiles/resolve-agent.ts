import { resolveModel } from "../resolve.js";
import type { IModelRef, IModelResolutionRequest, ModelResolution } from "../types.js";
import { parseModelId } from "../parse.js";
import { validateModelPreference } from "./schema.js";
import type {
  AgentModelResolution,
  IAgentModelResolutionOptions,
  IModelPreference,
  IModelPreferenceCriteria,
  IStaleModelSelection,
} from "./types.js";

/** The primary criteria followed by the ordered fallbacks. */
export function preferenceCriteria(preference: IModelPreference): readonly IModelPreferenceCriteria[] {
  const { fallbacks, ...primary } = preference;
  return [primary, ...(fallbacks ?? [])];
}

function toRequest(criteria: IModelPreferenceCriteria): IModelResolutionRequest {
  return { id: criteria.id, family: criteria.family, allowedProviders: criteria.allowedProviders, patterns: criteria.patterns };
}

/**
 * True when `model` is a candidate of one criterion. Delegates to Phase 1 by resolving against an
 * inventory holding only that model, so exact-ID, family, and pattern semantics (and provider
 * scoping) are never reimplemented here.
 */
export function isModelCompatibleWithCriteria(model: IModelRef, criteria: IModelPreferenceCriteria): boolean {
  return resolveModel([model], toRequest(criteria)).status === "resolved";
}

/** True when `id` is a well-formed model ID that satisfies the primary preference or any fallback. */
export function isModelIdCompatible(id: string, preference: IModelPreference): boolean {
  const model = parseModelId(id);
  return model !== undefined && model.id === id && preferenceCriteria(preference).some((criteria) => isModelCompatibleWithCriteria(model, criteria));
}

/**
 * Resolves one agent's portable preference against an inventory.
 *
 * Criteria are tried in order (primary, then fallbacks) through Phase 1's `resolveModel`. The first
 * criterion with any match decides the outcome:
 *
 * - `unavailable` moves on to the next fallback.
 * - `resolved` is returned.
 * - `ambiguous` is returned as-is. A fallback is never used to escape an ambiguity, because an
 *   ambiguous primary means models matched; only a saved selection, which is the user's own explicit
 *   choice among those exact candidates, resolves it.
 *
 * A saved ID is reused only when it exists in the inventory and is one of the deciding criterion's
 * candidates, so changing providers, families, or patterns in the profile invalidates it. A saved ID
 * that cannot be reused is reported as `staleSelection`; it is never silently swapped for a different
 * model without that report, and never deleted here.
 *
 * Ordinary outcomes are values, not exceptions. A malformed preference yields `invalid`.
 */
export function resolveAgentModel(
  models: readonly IModelRef[],
  preference: IModelPreference,
  options: IAgentModelResolutionOptions = {},
): AgentModelResolution {
  const validated = validateModelPreference(preference);
  if (!validated.ok) return { status: "invalid", issues: validated.issues };

  const savedId = options.savedId;
  const saved = savedId === undefined ? undefined : models.find((model) => model.id === savedId);
  const missing: IStaleModelSelection | undefined = savedId !== undefined && !saved ? { id: savedId, reason: "missing" } : undefined;

  const criteria = preferenceCriteria(validated.value);
  let firstUnavailable: ModelResolution | undefined;
  for (const [index, entry] of criteria.entries()) {
    const outcome = resolveModel(models, toRequest(entry));
    if (outcome.status === "unavailable") {
      firstUnavailable ??= outcome;
      continue;
    }
    if (outcome.status === "resolved") {
      if (saved && outcome.model.id === saved.id) {
        return { status: "resolved", model: outcome.model, source: "saved", matchedBy: outcome.matchedBy, criterionIndex: index };
      }
      return { status: "resolved", model: outcome.model, source: "preference", matchedBy: outcome.matchedBy, criterionIndex: index, ...stale(missing, saved) };
    }
    const chosen = saved && outcome.candidates.find((candidate) => candidate.id === saved.id);
    if (chosen) return { status: "resolved", model: chosen, source: "saved", matchedBy: outcome.stage, criterionIndex: index };
    return { status: "ambiguous", stage: outcome.stage, candidates: outcome.candidates, criterionIndex: index, ...stale(missing, saved) };
  }

  const reason = firstUnavailable?.status === "unavailable" ? firstUnavailable.reason : "no-match";
  return { status: "unavailable", reason, ...stale(missing, saved) };
}

/** Present only when a saved ID was supplied but could not be reused. */
function stale(missing: IStaleModelSelection | undefined, saved: IModelRef | undefined): { staleSelection?: IStaleModelSelection } {
  if (missing) return { staleSelection: missing };
  return saved ? { staleSelection: { id: saved.id, reason: "incompatible" } } : {};
}
