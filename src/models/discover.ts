import { ModelDiscoveryError } from "./errors.js";
import { filterModels } from "./filter.js";
import { uniqueSortedModels } from "./normalize.js";
import { parseModelList } from "./parse.js";
import { createOpenCodeModelSource } from "./source.js";
import type { IDiscoverModelsOptions, IModelInventory } from "./types.js";

/**
 * Discovers models through an injectable source (the OpenCode CLI by default).
 * Valid entries are deduplicated and sorted; malformed lines are reported in `rejected`.
 * Output with no valid entry at all (for example help text printed with exit code 0) throws
 * `malformed-output`. Truly empty output yields an inventory with `isEmpty: true`.
 */
export async function discoverModels(options: IDiscoverModelsOptions = {}): Promise<IModelInventory> {
  const source = options.source ?? createOpenCodeModelSource(options.openCode);
  let output: unknown;
  try {
    output = await source.read();
  } catch (error) {
    if (error instanceof ModelDiscoveryError) throw error;
    throw new ModelDiscoveryError("failed", `Model discovery failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  if (typeof output !== "string") throw new ModelDiscoveryError("failed", "Model discovery source did not return text.");

  const parsed = parseModelList(output);
  if (parsed.models.length === 0 && parsed.rejected.length > 0) {
    throw new ModelDiscoveryError("malformed-output", `Model discovery output contained no valid provider/model entries (${parsed.rejected.length} rejected).`);
  }
  const discovered = uniqueSortedModels(parsed.models);
  const models = options.filter ? filterModels(discovered, options.filter) : discovered;
  return {
    models,
    rejected: parsed.rejected,
    totalDiscovered: discovered.length,
    duplicateCount: parsed.models.length - discovered.length,
    isEmpty: models.length === 0,
  };
}
