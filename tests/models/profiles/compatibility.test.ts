import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as toolkit from "../../../src/index.js";
import { readAgentManifest } from "../../../src/agents/manifest.js";
import type { ICanonicalAgentRegistry } from "../../../src/agents/registry.js";
import { agentDirectory } from "../../../src/agents/target.js";
import { canonicalAgents, inspectAgents, resolveModelProfileLocation, updateAgents } from "../../../src/index.js";
import { projectLocation, useTemporaryRoots } from "./helpers.js";

const roots = useTemporaryRoots();
const registry: ICanonicalAgentRegistry = {
  version: "first",
  agents: { "lead.md": "---\nmodel: openai/gpt-5.5\n---\nlead\n", "external-researcher.md": "---\nmodel: cpa-gui/x\n---\nresearch\n" },
  source: "bundled",
  path: "fixture",
};

describe("compatibility with agent management", () => {
  it("leaves agent files, ownership manifest, hashes, and statuses byte-identical across every profile operation", async () => {
    const location = await projectLocation(roots);
    await updateAgents(location.root, {}, registry);
    const directory = agentDirectory(location.root);
    const manifestPath = path.join(location.root, ".toolkit", "agents.json");
    const snapshot = async () => ({
      manifest: await readFile(manifestPath, "utf8"),
      files: Object.fromEntries(await Promise.all((await readdir(directory)).sort().map(async (name) => [name, await readFile(path.join(directory, name), "utf8")]))),
      status: await inspectAgents(location.root, registry),
    });
    const before = await snapshot();

    await toolkit.createModelProfile(location, "openai", { agents: { lead: { id: "openai/gpt-5.5" }, "external-researcher": { id: "cpa-gui/x" } } });
    await toolkit.setActiveModelProfile(location, "openai");
    await toolkit.saveModelResolutions(location, "openai", { lead: "openai/gpt-5.5" });
    await toolkit.removeModelProfile(location, "openai", { deactivate: true });

    const after = await snapshot();
    expect(after).toEqual(before);
    expect(after.files["lead.md"]).toContain("model: openai/gpt-5.5");
    expect((await readAgentManifest(location.root)).installed.lead).toBeDefined();
    expect(after.status.managed.every((agent) => agent.state === "current")).toBe(true);
  });

  it("is not triggered by agent synchronization: updates never create or modify profile files", async () => {
    const location = await projectLocation(roots);
    await updateAgents(location.root, {}, registry);
    await updateAgents(location.root, {}, { ...registry, version: "second" });
    expect(await readdir(path.join(location.root, ".toolkit"))).toEqual(["agents.json"]);
  });

  it("works for the real canonical agents, including external-researcher, without a fixed count", async () => {
    const location = await projectLocation(roots);
    const names = Object.keys(canonicalAgents).map((file) => file.replace(/\.md$/, ""));
    expect(names).toContain("external-researcher");
    const agents = Object.fromEntries(names.map((name) => [name, { id: "cpa-gui/model-1" }]));
    expect(await toolkit.createModelProfile(location, "all", { agents })).toMatchObject({ status: "changed" });
    expect(Object.keys((await toolkit.getModelProfile(location, "all"))!.agents).sort()).toEqual([...names].sort());
  });

  it("does not touch canonical agent Markdown on disk", async () => {
    const before = await readFile(path.resolve("agents", "lead.md"), "utf8");
    const location = await projectLocation(roots);
    await toolkit.createModelProfile(location, "openai", { agents: { lead: { id: "openai/gpt-5.5" } } });
    expect(await readFile(path.resolve("agents", "lead.md"), "utf8")).toBe(before);
    expect(before).toMatch(/^---[\s\S]*?model:/);
  });

  it("exposes profile APIs from the package entry point and does not need OpenCode to edit a profile", async () => {
    for (const name of ["listModelProfiles", "createModelProfile", "removeModelProfile", "setActiveModelProfile", "saveModelResolutions", "resolveStoredModelProfile", "resolveAgentModel", "resolveModel", "discoverModels"]) {
      expect(typeof (toolkit as Record<string, unknown>)[name], name).toBe("function");
    }
    const location = await projectLocation(roots);
    await mkdir(path.dirname(location.directory), { recursive: true });
    const saved = process.env.PATH;
    process.env.PATH = "";
    try {
      expect(await toolkit.createModelProfile(location, "offline", { agents: { lead: { family: "x", allowedProviders: ["openai"] } } })).toMatchObject({ status: "changed" });
    } finally {
      process.env.PATH = saved;
    }
  });

  it("maps global targets to the OpenCode config root beside the global ownership state", () => {
    const location = toolkit.resolveGlobalModelProfileLocation({ home: "/home/example", env: {} });
    expect(location.scope).toBe("global");
    expect(location.profilesPath).toBe("/home/example/.config/opencode/.toolkit/models/profiles.json");
    expect(location.statePath).toBe("/home/example/.config/opencode/.toolkit/models/local.json");
    expect(resolveModelProfileLocation("/work/project").profilesPath).toBe("/work/project/.toolkit/models/profiles.json");
    expect(resolveModelProfileLocation("/work/project").scope).toBe("project");
  });
});
