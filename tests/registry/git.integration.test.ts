import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import * as path from "pathe";
import { afterEach, describe, expect, it } from "vitest";
import { readAgentManifest } from "../../src/agents/manifest.js";
import { hashAgentContent, updateAgents } from "../../src/agents/sync.js";
import { resolveToolkitRegistryPaths } from "../../src/registry/path.js";
import { initializeToolkitRegistry, prepareAgentRegistryForUpdate } from "../../src/registry/registry.js";
import { createGitRegistryFixture, normalizeLineEndings, publishAgents } from "../helpers/git.js";

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("Git-backed agent distribution", () => {
  it("refreshes one machine registry and safely synchronizes multiple projects", async () => {
    const root = await temporaryDirectory();
    const fixture = await createGitRegistryFixture(root, { lead: "lead v1\n", coder: "coder v1\n" });
    const paths = resolveToolkitRegistryPaths(path.join(root, "home"));
    const projectA = path.join(root, "project-a");
    const projectB = path.join(root, "project-b");
    await Promise.all([mkdir(projectA), mkdir(projectB)]);

    const initial = await initializeToolkitRegistry(paths, { remote: fixture.remote });
    await updateAgents(projectA, {}, initial);
    await updateAgents(projectB, {}, initial);
    expect(initial.path).toBe(paths.agents);

    await publishAgents(fixture.author, { lead: "lead v2\n", coder: "coder v1\n", reviewer: "reviewer v1\n" }, "v2");
    const refreshed = await prepareAgentRegistryForUpdate(paths);
    await updateAgents(projectA, {}, refreshed.registry);
    await updateAgents(projectB, {}, refreshed.registry);

    expect(normalizeLineEndings(await readFile(path.join(paths.agents, "lead.md"), "utf8"))).toBe("lead v2\n");
    const installedLead = await readFile(path.join(projectA, ".opencode/agents/lead.md"), "utf8");
    expect(normalizeLineEndings(installedLead)).toBe("lead v2\n");
    expect(normalizeLineEndings(await readFile(path.join(projectB, ".opencode/agents/reviewer.md"), "utf8"))).toBe("reviewer v1\n");
    const installedHash = hashAgentContent(installedLead);
    expect((await readAgentManifest(projectA)).installed.lead?.hash).toBe(installedHash);

    await writeFile(path.join(projectA, ".opencode/agents/lead.md"), "project customization\n");
    await publishAgents(fixture.author, { lead: "lead v3\n", coder: "coder v1\n" }, "v3");
    const latest = await prepareAgentRegistryForUpdate(paths);
    const result = await updateAgents(projectA, {}, latest.registry);

    expect(result.conflicts).toContain("lead");
    expect(normalizeLineEndings(await readFile(path.join(paths.agents, "lead.md"), "utf8"))).toBe("lead v3\n");
    await expect(readFile(path.join(projectA, ".opencode/agents/lead.md"), "utf8")).resolves.toBe("project customization\n");
    expect(normalizeLineEndings(await readFile(path.join(projectA, ".opencode/agents/reviewer.md"), "utf8"))).toBe("reviewer v1\n");
    expect((await readAgentManifest(projectA)).installed.lead?.hash).toBe(installedHash);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "toolkit-git-integration-"));
  temporaryDirectories.push(directory);
  return directory;
}
