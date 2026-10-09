import { normalizeModelFamily, uniqueSortedModels } from "./normalize.js";
import type { IModelFilter, IModelRef } from "./types.js";

/** Exact provider and normalized-family filtering. Fields combine with AND; the result is sorted and unique. */
export function filterModels(models: readonly IModelRef[], filter: IModelFilter = {}): IModelRef[] {
  const providers = filter.providers && new Set(filter.providers.map((provider) => provider.trim()));
  const families = filter.families && new Set(filter.families.map(normalizeModelFamily).filter((family) => family !== ""));
  return uniqueSortedModels(models.filter((model) => (!providers || providers.has(model.provider)) && (!families || families.has(model.family))));
}
