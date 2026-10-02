import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import * as path from "pathe";
import { afterEach, describe, expect, it } from "vitest";
import { publishAgent, publishAllAgents } from "../../src/agents/publish.js";
import { readAgentManifest } from "../../src/agents/manifest.js";
import { hashAgentContent, overrideAgent, updateAgents } from "../../src/agents/sync.js";
import { agentDirectory, resolveGlobalAgentTarget } from "../../src/agents/target.js";
import { prepareAgentRegistryForUpdate } from "../../src/registry/registry.js";
import { gitCommand, publishAgents } from "../helpers/git.js";
import { agentPath, createPublicationFixtures, publishOptions, remoteHead } from "../helpers/publication.js";

const { fixture, cleanup } = createPublicationFixtures();
afterEach(cleanup);

/** Real Git operations need more than the default five seconds on Windows. */
describe.sequential("agent global publication and line endings", { timeout: 30_000 }, () => {
  it("rechecks every changed global file before any local write after push", async () => {
    const setup = await fixture();
    const target = resolveGlobalAgentTarget({ home: path.join(setup.root, "global-home"), env: {} });
    await updateAgents(target, {}, setup.registry);
    const lead = path.join(agentDirectory(target), "lead.md");
    const coder = path.join(agentDirectory(target), "coder.md");
    await writeFile(lead, "lead global\r\n");
    await writeFile(coder, "coder global\r\n");
    const options = { ...publishOptions(setup), destination: undefined, target };
    const ownership = await readAgentManifest(target);
    await expect(publishAllAgents({ ...options, beforeReconcile: async () => writeFile(coder, "concurrent edit\n") })).rejects.toMatchObject({ published: true, message: expect.stringContaining("toolkit agents update --global") });
    await expect(readFile(lead, "utf8")).resolves.toBe("lead global\r\n");
    await expect(readFile(coder, "utf8")).resolves.toBe("concurrent edit\n");
    expect(await readAgentManifest(target)).toEqual(ownership);
    expect(await remoteHead(setup.remote)).not.toBe(setup.initialHead);
    await expect(readdir(setup.temporaryParent)).resolves.toEqual([]);
  });

  it("reconciles multiple global files to LF without changing project ownership", async () => {
    const setup = await fixture();
    const target = resolveGlobalAgentTarget({ home: path.join(setup.root, "global-home"), env: {} });
    await updateAgents(target, {}, setup.registry);
    const projectOwnership = await readAgentManifest(setup.project);
    for (const name of ["lead", "coder"]) await writeFile(path.join(agentDirectory(target), `${name}.md`), `${name} global\r\n`);
    await publishAllAgents({ ...publishOptions(setup), destination: undefined, target });
    for (const name of ["lead", "coder"]) {
      await expect(readFile(path.join(agentDirectory(target), `${name}.md`), "utf8")).resolves.toBe(`${name} global\n`);
      expect((await readAgentManifest(target)).installed[name]?.hash).toBe(hashAgentContent(`${name} global\n`));
    }
    expect(await readAgentManifest(setup.project)).toEqual(projectOwnership);
  });

  it("previews and publishes global definitions with isolated ownership and LF reconciliation", async () => {
    const setup = await fixture();
    const target = resolveGlobalAgentTarget({ home: path.join(setup.root, "global-home"), env: {} });
    await updateAgents(target, {}, setup.registry);
    const file = path.join(agentDirectory(target), "coder.md");
    const ownershipPath = path.join(target.root, ".toolkit/agents.json");
    const projectBefore = await readAgentManifest(setup.project);
    const ownershipBefore = await readFile(ownershipPath, "utf8");
    await writeFile(file, "global improvement\r\n");
    const options = { ...publishOptions(setup), destination: undefined, target };
    const preview = await publishAgent("coder", { ...options, dryRun: true });
    expect(preview.outcome).toBe("dry-run");
    expect(preview.preview.agentPath).toBe(file);
    expect(await remoteHead(setup.remote)).toBe(setup.initialHead);
    await expect(readFile(ownershipPath, "utf8")).resolves.toBe(ownershipBefore);
    const result = await publishAgent("coder", options);
    expect(result.outcome).toBe("published");
    await expect(readFile(file, "utf8")).resolves.toBe("global improvement\n");
    expect((await readAgentManifest(target)).installed.coder?.hash).toBe(hashAgentContent("global improvement\n"));
    expect(await readAgentManifest(setup.project)).toEqual(projectBefore);
  });

  it("uses global conflict baselines and global recovery after successful push", async () => {
    const setup = await fixture();
    const target = resolveGlobalAgentTarget({ home: path.join(setup.root, "global-home"), env: {} });
    await updateAgents(target, {}, setup.registry);
    const file = path.join(agentDirectory(target), "coder.md");
    const options = { ...publishOptions(setup), destination: undefined, target };
    await writeFile(file, "global edit\n");
    await publishAgents(setup.author, { lead: "lead v1\n", coder: "upstream edit\n" }, "upstream");
    await expect(publishAgent("coder", options)).rejects.toThrow("toolkit agents update --global");
    const refreshed = await prepareAgentRegistryForUpdate(setup.paths, { gitEnvironment: setup.gitEnvironment });
    await updateAgents(target, { replaceModified: new Set(["coder"]) }, refreshed.registry);
    await overrideAgent(target, "coder", refreshed.registry);
    await writeFile(file, "published global override\r\n");
    await expect(publishAgent("coder", options)).rejects.toThrow("--include-override");
    await expect(publishAgent("coder", {
      ...options,
      includeOverride: true,
      beforeReconcile: async () => writeFile(file, "changed while publishing\n"),
    })).rejects.toMatchObject({ published: true, message: expect.stringContaining("toolkit agents update --global") });
    await expect(readFile(file, "utf8")).resolves.toBe("changed while publishing\n");
    expect((await readAgentManifest(target)).overrides).toContain("coder");
  });

  it.each([
    { inheritedAutoCrlf: true, localContent: "coder improved\n", label: "autocrlf=true with LF local content" },
    { inheritedAutoCrlf: false, localContent: "coder improved\n", label: "autocrlf=false with LF local content" },
    { inheritedAutoCrlf: true, localContent: "coder improved\r\nsecond line\r\n", label: "autocrlf=true with CRLF local content" },
    { inheritedAutoCrlf: false, localContent: "coder improved\r\nsecond line\r\n", label: "autocrlf=false with CRLF local content" },
  ])("publishes, reconciles, and can be received under $label", async ({ inheritedAutoCrlf, localContent }) => {
    const setup = await fixture(inheritedAutoCrlf);
    await writeFile(agentPath(setup.project, "coder"), localContent);
    const canonicalContent = localContent.replace(/\r\n/g, "\n");

    const result = await publishAgent("coder", publishOptions(setup));

    expect(result.outcome).toBe("published");
    expect(result.localSynchronizationComplete).toBe(true);
    const changed = await gitCommand("diff-tree", ["--git-dir", setup.remote, "diff-tree", "--no-commit-id", "--name-only", "-r", "main"]);
    expect(changed.stdout.split(/\r?\n/).sort()).toEqual(["agents/coder.md", "agents/manifest.json"]);
    const manifest = await readAgentManifest(setup.project);
    expect(manifest.installed.coder?.version).toBe(result.preview.proposedVersion);
    expect(manifest.installed.coder?.hash).toBe(hashAgentContent(canonicalContent));
    await expect(readFile(agentPath(setup.project, "coder"), "utf8")).resolves.toBe(canonicalContent);

    const other = path.join(setup.root, "other");
    await mkdir(other);
    const refreshed = await prepareAgentRegistryForUpdate(setup.paths, { gitEnvironment: setup.gitEnvironment });
    await updateAgents(other, {}, refreshed.registry);
    await expect(readFile(agentPath(other, "coder"), "utf8")).resolves.toBe(canonicalContent);
    await expect(readdir(setup.temporaryParent)).resolves.toEqual([]);
  });
});
