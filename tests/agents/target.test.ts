import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import * as path from "pathe";
import { afterEach, describe, expect, it } from "vitest";
import { agentDirectory, resolveGlobalAgentTarget } from "../../src/agents/target.js";
import { inspectAgents, manageAgent, overrideAgent, updateAgents } from "../../src/agents/sync.js";
import { readAgentManifest } from "../../src/agents/manifest.js";
import type { ICanonicalAgentRegistry } from "../../src/agents/registry.js";

const directories: string[] = [];
const registry: ICanonicalAgentRegistry = { version: "first", agents: { "sample.md": "first\n" }, source: "bundled", path: "fixture" };
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "toolkit-global-agents-"));
  directories.push(root);
  return { root, target: resolveGlobalAgentTarget({ home: root, env: {} }) };
}

describe("global agent targets", () => {
  it("honors only absolute nonempty XDG config paths and otherwise uses the portable home config", async () => {
    const { root } = await fixture();
    for (const value of [undefined, "", "relative", "   "]) {
      expect(resolveGlobalAgentTarget({ home: root, env: { XDG_CONFIG_HOME: value } }).root).toBe(path.join(root, ".config/opencode"));
    }
    expect(resolveGlobalAgentTarget({ home: root, env: { XDG_CONFIG_HOME: path.join(root, "custom") } }).root).toBe(path.join(root, "custom/opencode"));
  });

  it("inspects an absent global config offline without creating any directories", async () => {
    const { root, target } = await fixture();
    expect((await inspectAgents(target, registry)).managed[0]?.state).toBe("not-installed");
    expect(await readAgentManifest(target)).toMatchObject({ installed: {}, overrides: [] });
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it("bootstraps, updates, preserves modifications and local files, and keeps project ownership separate", async () => {
    const { root, target } = await fixture();
    await updateAgents(root, {}, registry);
    const projectOwnership = await readFile(path.join(root, ".toolkit/agents.json"), "utf8");
    expect((await updateAgents(target, {}, registry)).installed).toEqual(["sample"]);
    const updated = { ...registry, version: "second", agents: { "sample.md": "second\n" } };
    expect((await updateAgents(target, {}, updated)).updated).toEqual(["sample"]);
    const file = path.join(agentDirectory(target), "sample.md");
    await writeFile(file, "local\r\n");
    await writeFile(path.join(agentDirectory(target), "personal.md"), "personal\n");
    const result = await updateAgents(target, {}, registry);
    expect(result.conflicts).toEqual(["sample"]);
    expect(result.local).toEqual(["personal"]);
    await expect(readFile(file, "utf8")).resolves.toBe("local\r\n");
    expect((await updateAgents(target, { replaceModified: new Set(["sample"]) }, registry)).updated).toEqual(["sample"]);
    await expect(readFile(path.join(root, ".toolkit/agents.json"), "utf8")).resolves.toBe(projectOwnership);
  });

  it("preserves overrides until explicitly returned to management", async () => {
    const { target } = await fixture();
    await updateAgents(target, {}, registry);
    await overrideAgent(target, "sample", registry);
    const file = path.join(agentDirectory(target), "sample.md");
    await writeFile(file, "override\n");
    expect((await updateAgents(target, {}, registry)).overrides).toEqual(["sample"]);
    await expect(manageAgent(target, "sample", { replaceExisting: false }, registry)).rejects.toThrow("replaceExisting");
    await expect(readFile(file, "utf8")).resolves.toBe("override\n");
    await manageAgent(target, "sample", { replaceExisting: true }, registry);
    expect((await inspectAgents(target, registry)).managed[0]?.state).toBe("current");
    expect((await readAgentManifest(target)).overrides).toEqual([]);
  });

  it.each(["ancestor", "agents", "metadata"])("rejects redirected %s directories before writing", async (location) => {
    const { root, target } = await fixture();
    const outside = path.join(root, "outside");
    await mkdir(outside);
    const link = location === "ancestor" ? path.join(root, ".config") : path.join(target.root, location === "agents" ? "agents" : ".toolkit");
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    await expect(inspectAgents(target, registry)).rejects.toThrow("unsafe");
    await expect(updateAgents(target, {}, registry)).rejects.toThrow("unsafe");
    await expect(readdir(outside)).resolves.toEqual([]);
    if (location === "metadata") await expect(access(agentDirectory(target))).rejects.toThrow();
  });
});
