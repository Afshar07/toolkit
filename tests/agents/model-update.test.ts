import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import * as path from "pathe";
import { useTemporaryRoots } from "../models/profiles/helpers.js";
import { updateAgents, hashAgentContent } from "../../src/agents/sync.js";
import { readAgentManifest } from "../../src/agents/manifest.js";
import type { ICanonicalAgentRegistry } from "../../src/agents/registry.js";

const roots = useTemporaryRoots();
describe("agent updates respect migration ordering", () => {
  it("refuses to erase a working managed model before explicit migration", async () => {
    const root = await roots.create();
    const old = "---\ndescription: lead\nmodel: openai/gpt-5\n---\nbody\n";
    const registry: ICanonicalAgentRegistry = { source: "local", path: root, version: "1", agents: { "lead.md": old } };
    await updateAgents(root, {}, registry);
    const updated = await updateAgents(root, {}, { ...registry, version: "2", agents: { "lead.md": old.replace("model: openai/gpt-5\n", "") } });
    expect(updated.conflicts).toEqual(["lead"]);
    expect(await readFile(path.join(root, ".opencode/agents/lead.md"), "utf8")).toBe(old);
    expect((await readAgentManifest(root)).installed.lead).toMatchObject({ version: "1", hash: hashAgentContent(old) });
  });
});
