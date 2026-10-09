import type { IModelRef } from "./types.js";

/**
 * Lowercases and treats whitespace and `_` as `-`, so `Claude_Sonnet-4.5` and `claude-sonnet-4.5`
 * share a family key. Dots (versions), suffixes such as `-fast`, and `/` separators in nested IDs
 * are preserved, so `gpt-5.5` and `gpt-5-5` stay distinct. Returns an empty string for blank input.
 */
export function normalizeModelFamily(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .split("/")
    .map((segment) => segment.replace(/[\s_]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, ""))
    .join("/");
}

export function createModelRef(provider: string, modelId: string): IModelRef {
  return { id: `${provider}/${modelId}`, provider, modelId, family: normalizeModelFamily(modelId) };
}

/** Code-unit ordering: independent of locale, platform, and ICU data. */
export function compareModels(a: IModelRef, b: IModelRef): number {
  return compareText(a.provider, b.provider) || compareText(a.modelId, b.modelId);
}

/** Collapses repeated exact IDs and sorts deterministically. */
export function uniqueSortedModels(models: readonly IModelRef[]): IModelRef[] {
  const unique = new Map<string, IModelRef>();
  for (const model of models) if (!unique.has(model.id)) unique.set(model.id, model);
  return [...unique.values()].sort(compareModels);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
