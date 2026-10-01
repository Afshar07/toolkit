import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as path from "pathe";

export interface ICanonicalAgentManifest {
  version: string;
  agents: string[];
}

export interface ICanonicalAgentRegistry {
  version: string;
  agents: Readonly<Record<string, string>>;
  source: "local" | "bundled";
  path: string;
}

const bundledRegistryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../agents");

/** Read and validate a canonical agent registry from an agents directory. */
export async function readCanonicalAgentRegistry(
  agentsPath: string,
  source: ICanonicalAgentRegistry["source"] = "local",
): Promise<ICanonicalAgentRegistry> {
  const manifestPath = path.join(agentsPath, "manifest.json");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read canonical agent manifest ${manifestPath}: ${error instanceof Error ? error.message : "invalid JSON"}`);
  }
  assertCanonicalAgentManifest(value, manifestPath);
  const entries = await Promise.all(value.agents.map(async (name) => {
    const fileName = `${name}.md`;
    try {
      return [fileName, await readFile(path.join(agentsPath, fileName), "utf8")] as const;
    } catch (error) {
      throw new Error(`Cannot read canonical agent ${fileName}: ${error instanceof Error ? error.message : "read failed"}`);
    }
  }));
  return { version: value.version, agents: Object.freeze(Object.fromEntries(entries)), source, path: agentsPath };
}

export function assertCanonicalAgentManifest(value: unknown, manifestPath = "canonical agent manifest"): asserts value is ICanonicalAgentManifest {
  if (!isRecord(value) || typeof value.version !== "string" || value.version.length === 0
    || !Array.isArray(value.agents) || value.agents.length === 0
    || !value.agents.every((name) => typeof name === "string" && /^[a-z0-9][a-z0-9-]*$/.test(name))
    || new Set(value.agents).size !== value.agents.length) {
    throw new Error(`Invalid canonical agent manifest ${manifestPath}.`);
  }
}

/** Bundled definitions remain available for bootstrap, offline fallback, and API compatibility. */
export const bundledAgentRegistry = await readCanonicalAgentRegistry(bundledRegistryRoot, "bundled");
export const canonicalAgentVersion = bundledAgentRegistry.version;
export const canonicalAgents = bundledAgentRegistry.agents;
export type CanonicalAgentName = keyof typeof canonicalAgents;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
