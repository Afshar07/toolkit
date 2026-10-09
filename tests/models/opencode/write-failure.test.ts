import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import * as path from "pathe";
import { useTemporaryRoots, inventoryOf } from "../profiles/helpers.js";
import { hashAgentContent } from "../../../src/agents/sync.js";
import { createModelProfile, resolveModelProfileLocation } from "../../../src/models/profiles/index.js";
import { applyModelProfile } from "../../../src/models/opencode/apply.js";

const failure = vi.hoisted(() => ({ enabled: false }));
vi.mock("../../../src/models/opencode/safe-write.js", async (original) => {
  const actual = await original<typeof import("../../../src/models/opencode/safe-write.js")>();
  return { ...actual, writeSafeText: async (...args: Parameters<typeof actual.writeSafeText>) => {
    if (failure.enabled && args[1].endsWith("applied.json")) throw new Error("injected ownership write failure");
    return actual.writeSafeText(...args);
  } };
});
const roots = useTemporaryRoots();
afterEach(() => { failure.enabled = false; });
describe("partial application failure", () => {
  it("reports changed config but never persists successful resolution state after failure", async () => {
    const root = await roots.create();
    const location = resolveModelProfileLocation(root);
    const content = "---\ndescription: lead\n---\nbody\n";
    await mkdir(path.join(root, ".opencode/agents"), { recursive: true });
    await mkdir(path.join(root, ".toolkit"));
    await writeFile(path.join(root, ".opencode/agents/lead.md"), content);
    await writeFile(path.join(root, ".toolkit/agents.json"), JSON.stringify({ schemaVersion: 1, target: "opencode", overrides: [], installed: { lead: { source: "toolkit", version: "1", hash: hashAgentContent(content) } } }));
    await createModelProfile(location, "openai", { agents: { lead: { id: "openai/gpt-5" } } });
    failure.enabled = true;
    const result = await applyModelProfile({ target: root, profile: "openai", models: inventoryOf("openai/gpt-5") });
    expect(result.status).toBe("failed");
    expect(result.filesChanged).toEqual([path.join(root, "opencode.jsonc")]);
    expect(result.manualIntervention).toContain(path.join(root, "opencode.jsonc"));
    expect(JSON.parse(await readFile(path.join(root, "opencode.jsonc"), "utf8")).agents.lead.model).toBe("openai/gpt-5");
    await expect(readFile(location.statePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(root, ".opencode/agents/lead.md"), "utf8")).toBe(content);
  });
});
