import { normalizeModelFamily, uniqueSortedModels } from "./normalize.js";
import type {
  IAmbiguousModelResolution,
  IModelRef,
  IModelResolutionRequest,
  IResolvedModelResolution,
  IUnavailableModelResolution,
  ModelResolution,
  ModelUnavailableReason,
} from "./types.js";

/**
 * Resolves a request against a known inventory without guessing. Stages run in order and the
 * first stage with any match decides the outcome:
 *
 * 1. Exact configured `provider/model` ID.
 * 2. Exact normalized family within `allowedProviders`.
 * 3. Explicit glob patterns (pooled), scoped to `allowedProviders` when given.
 *
 * More than one match at a stage is `ambiguous`; resolution never falls through to a later stage
 * to escape an ambiguity, and no similarity scoring is involved.
 */
export function resolveModel(models: readonly IModelRef[], request: IModelResolutionRequest): ModelResolution {
  const id = request.id?.trim() ?? "";
  const family = normalizeModelFamily(request.family ?? "");
  const patterns = (request.patterns ?? []).map((pattern) => pattern.trim()).filter((pattern) => pattern !== "");
  if (id === "" && family === "" && patterns.length === 0) return unavailable("no-criteria");

  const inventory = uniqueSortedModels(models);
  if (inventory.length === 0) return unavailable("empty-inventory");

  if (id !== "") {
    const exact = inventory.find((model) => model.id === id);
    if (exact) return resolved(exact, "id");
  }

  const permitted = request.allowedProviders && new Set(request.allowedProviders.map((provider) => provider.trim()));
  const scoped = permitted ? inventory.filter((model) => permitted.has(model.provider)) : inventory;

  if (family !== "" && permitted) {
    const outcome = decide(scoped.filter((model) => model.family === family), "family");
    if (outcome) return outcome;
  }

  if (patterns.length > 0) {
    const expressions = patterns.map(globToRegExp);
    const outcome = decide(scoped.filter((model) => expressions.some((expression) => expression.test(model.id))), "pattern");
    if (outcome) return outcome;
  }

  return unavailable("no-match");
}

function decide(matches: readonly IModelRef[], stage: "family" | "pattern"): IResolvedModelResolution | IAmbiguousModelResolution | undefined {
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return resolved(matches[0]!, stage);
  return { status: "ambiguous", stage, candidates: matches };
}

function resolved(model: IModelRef, matchedBy: IResolvedModelResolution["matchedBy"]): IResolvedModelResolution {
  return { status: "resolved", model, matchedBy, candidates: [model] };
}

function unavailable(reason: ModelUnavailableReason): IUnavailableModelResolution {
  return { status: "unavailable", reason, candidates: [] };
}

/** Only `*` and `?` are wildcards; everything else is literal. No user-supplied regular expressions. */
function globToRegExp(pattern: string): RegExp {
  const source = [...pattern.replace(/\*+/g, "*")]
    .map((character) => (character === "*" ? ".*" : character === "?" ? "." : character.replace(/[\\^$.+()[\]{}|/-]/g, "\\$&")))
    .join("");
  return new RegExp(`^${source}$`, "i");
}
