import { readFileSync } from "node:fs";

interface CanonicalAgentManifest {
  version: string;
  agents: string[];
}

const registryRoot = new URL("../../agents/", import.meta.url);
const manifest = readCanonicalManifest();

/** Version of the canonical agent set shipped by this Toolkit release. */
export const canonicalAgentVersion = manifest.version;

/** Canonical reusable agent definitions. Installation targets are handled separately. */
export const canonicalAgents: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(
  manifest.agents.map((name) => [`${name}.md`, readFileSync(new URL(`${name}.md`, registryRoot), "utf8")]),
));

export type CanonicalAgentName = keyof typeof canonicalAgents;

function readCanonicalManifest(): CanonicalAgentManifest {
  const manifestPath = new URL("manifest.json", registryRoot);
  let value: unknown;
  try { value = JSON.parse(readFileSync(manifestPath, "utf8")); }
  catch (error) { throw new Error(`Cannot read canonical agent manifest: ${error instanceof Error ? error.message : "invalid JSON"}`); }
  if (!isRecord(value) || typeof value.version !== "string" || !Array.isArray(value.agents)
    || !value.agents.every((name) => typeof name === "string" && /^[a-z0-9][a-z0-9-]*$/.test(name))
    || new Set(value.agents).size !== value.agents.length) {
    throw new Error("Invalid canonical agent manifest.");
  }
  return value as unknown as CanonicalAgentManifest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
