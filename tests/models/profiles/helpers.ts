import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { createModelRef, parseModelId, resolveModelProfileLocation } from "../../../src/models/index.js";
import type { IModelProfileLocation, IModelRef } from "../../../src/models/index.js";

/** Registers per-file temporary directory cleanup and returns a factory for fresh roots. */
export function useTemporaryRoots(): { create(): Promise<string> } {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 3 })));
  });
  return {
    async create() {
      const root = await mkdtemp(path.join(os.tmpdir(), "toolkit-model-profiles-"));
      roots.push(root);
      return root;
    },
  };
}

export async function projectLocation(roots: { create(): Promise<string> }): Promise<IModelProfileLocation> {
  return resolveModelProfileLocation(await roots.create());
}

/** A global-scope location under a temporary root, never the real home directory. */
export async function globalLocation(roots: { create(): Promise<string> }): Promise<IModelProfileLocation> {
  return resolveModelProfileLocation({ scope: "global", root: await roots.create() });
}

export function inventoryOf(...ids: string[]): IModelRef[] {
  return ids.map((id) => {
    const parsed = parseModelId(id);
    if (!parsed) throw new Error(`Bad fixture ID ${id}`);
    return createModelRef(parsed.provider, parsed.modelId);
  });
}
