import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import * as path from "pathe";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { incrementCanonicalVersion, publishAgent } from "../../src/agents/publish.js";
import { readAgentManifest } from "../../src/agents/manifest.js";
import { hashAgentContent, overrideAgent, updateAgents } from "../../src/agents/sync.js";
import { agentDirectory, resolveGlobalAgentTarget } from "../../src/agents/target.js";
import { initializeToolkitRegistry, prepareAgentRegistryForUpdate, readLocalAgentRegistry } from "../../src/registry/registry.js";
import { resolveToolkitRegistryPaths } from "../../src/registry/path.js";
import { createGitRegistryFixture, publishAgents } from "../helpers/git.js";

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))));

// These integration tests create, clone, commit, push, and refresh real Git repositories.
// Windows runners need more than Vitest's default five seconds for these operations.
describe("agent publication", { timeout: 30_000 }, () => {
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
    const changed = await execa("git", ["--git-dir", setup.remote, "diff-tree", "--no-commit-id", "--name-only", "-r", "main"]);
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

  it("treats a local CRLF-only difference as no shared-content change", async () => {
    const setup = await fixture(true);
    await writeFile(agentPath(setup.project, "coder"), "coder v1\r\n");
    const before = await remoteHead(setup.remote);

    const result = await publishAgent("coder", publishOptions(setup));

    expect(result.outcome).toBe("unchanged");
    expect(await remoteHead(setup.remote)).toBe(before);
    await expect(readFile(agentPath(setup.project, "coder"), "utf8")).resolves.toBe("coder v1\r\n");
  });

  it("reads and safely refreshes an existing CRLF machine registry as canonical LF", async () => {
    const setup = await fixture(true, true);
    expect(await readFile(path.join(setup.paths.agents, "coder.md"), "utf8")).toBe("coder v1\r\n");
    expect((await readLocalAgentRegistry(setup.paths)).agents["coder.md"]).toBe("coder v1\n");
    const legacyManifest = await readAgentManifest(setup.project);
    await writeFile(agentPath(setup.project, "coder"), "coder v1\r\n");
    legacyManifest.installed.coder!.hash = hashAgentContent("coder v1\r\n");
    await writeFile(path.join(setup.project, ".toolkit/agents.json"), `${JSON.stringify(legacyManifest, null, 2)}\n`);
    await writeFile(agentPath(setup.project, "coder"), "legacy registry publication\r\n");

    const result = await publishAgent("coder", publishOptions(setup));

    expect(result.outcome).toBe("published");
    await expect(readFile(agentPath(setup.project, "coder"), "utf8")).resolves.toBe("legacy registry publication\n");
    expect((await readAgentManifest(setup.project)).installed.coder?.hash).toBe(hashAgentContent("legacy registry publication\n"));
  });

  it("keeps canonical LF behavior when Git environment overrides repository configuration", async () => {
    const setup = await fixture(false, false, true);
    await writeFile(agentPath(setup.project, "coder"), "forced conversion\r\n");

    const result = await publishAgent("coder", publishOptions(setup));

    expect(result.outcome).toBe("published");
    expect((await readLocalAgentRegistry(setup.paths)).agents["coder.md"]).toBe("forced conversion\n");
    await expect(readFile(agentPath(setup.project, "coder"), "utf8")).resolves.toBe("forced conversion\n");
  });

  it("does not commit, bump, or persist state for identical content or a dry run", async () => {
    const setup = await fixture();
    const before = await remoteHead(setup.remote);
    const identical = await publishAgent("coder", publishOptions(setup));
    expect(identical.outcome).toBe("unchanged");
    expect(await remoteHead(setup.remote)).toBe(before);

    await writeFile(agentPath(setup.project, "coder"), "preview only\n");
    const ownershipBefore = await readFile(path.join(setup.project, ".toolkit/agents.json"), "utf8");
    const dryRun = await publishAgent("coder", { ...publishOptions(setup), dryRun: true, confirm: undefined });
    expect(dryRun.outcome).toBe("dry-run");
    expect(dryRun.preview.diff).toContain("+preview only");
    expect(await remoteHead(setup.remote)).toBe(before);
    await expect(readFile(path.join(setup.project, ".toolkit/agents.json"), "utf8")).resolves.toBe(ownershipBefore);
  });

  it("refuses stale baselines, overrides, unmanaged files, unsafe names, and escaping links", async () => {
    const setup = await fixture();
    await writeFile(agentPath(setup.project, "coder"), "local edit\n");
    await publishAgents(setup.author, { lead: "lead v1\n", coder: "upstream edit\n" }, "upstream");
    await expect(publishAgent("coder", publishOptions(setup))).rejects.toThrow("shared definition changed");

    const fresh = await fixture();
    await overrideAgent(fresh.project, "coder", fresh.registry);
    await expect(publishAgent("coder", publishOptions(fresh))).rejects.toThrow("--include-override");
    await expect(publishAgent("../coder", publishOptions(fresh))).rejects.toThrow("Invalid agent name");

    const unmanaged = path.join(fresh.root, "unmanaged");
    await mkdir(path.join(unmanaged, ".opencode/agents"), { recursive: true });
    await writeFile(agentPath(unmanaged, "coder"), "unmanaged\n");
    await expect(publishAgent("coder", { ...publishOptions(fresh), destination: unmanaged })).rejects.toThrow("--allow-unmanaged");

    const unsafe = path.resolve(fresh.root, "unsafe");
    const outside = path.resolve(fresh.root, "outside");
    await Promise.all([mkdir(unsafe), mkdir(outside, { recursive: true })]);
    await symlink(outside, path.join(unsafe, ".opencode"), process.platform === "win32" ? "junction" : "dir");
    await expect(publishAgent("coder", { ...publishOptions(fresh), destination: unsafe })).rejects.toThrow(/regular file|unsafe/);
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it("rejects a normal push when upstream advances and cleans its checkout", async () => {
    const setup = await fixture();
    await writeFile(agentPath(setup.project, "coder"), "coder improved\n");
    await expect(publishAgent("coder", {
      ...publishOptions(setup),
      beforePush: async () => publishAgents(setup.author, { lead: "lead v2\n", coder: "coder v1\n" }, "advance"),
    })).rejects.toThrow(/Direct push failed/);
    await expect(readdir(setup.temporaryParent)).resolves.toEqual([]);
  });

  it("reports successful publication separately when local reconciliation fails", async () => {
    const setup = await fixture();
    await writeFile(agentPath(setup.project, "coder"), "published bytes\n");
    await expect(publishAgent("coder", {
      ...publishOptions(setup),
      beforeReconcile: async () => writeFile(agentPath(setup.project, "coder"), "changed during push\n"),
    })).rejects.toMatchObject({ published: true });
    expect(await remoteHead(setup.remote)).not.toBe(setup.initialHead);
    expect((await readAgentManifest(setup.project)).installed.coder?.version).toBe("initial registry");
  });

  it("increments human-readable versions deterministically more than once per day", () => {
    const day = new Date("2026-10-01T12:00:00Z");
    expect(incrementCanonicalVersion("2026.10.1", day)).toBe("2026.10.2");
    expect(incrementCanonicalVersion("2026.10.2", day)).toBe("2026.10.3");
    expect(incrementCanonicalVersion("2026.09.42", day)).toBe("2026.10.1");
  });
});

interface IFixture {
  root: string;
  remote: string;
  author: string;
  project: string;
  paths: ReturnType<typeof resolveToolkitRegistryPaths>;
  registry: Awaited<ReturnType<typeof initializeToolkitRegistry>>;
  temporaryParent: string;
  initialHead: string;
  gitEnvironment: NodeJS.ProcessEnv;
}

async function fixture(inheritedAutoCrlf = false, legacyRegistry = false, forceAutoCrlf = false): Promise<IFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "toolkit-publish-test-"));
  temporaryDirectories.push(root);
  const globalConfig = path.join(root, "gitconfig");
  await writeFile(globalConfig, `[core]\n\tautocrlf = ${inheritedAutoCrlf}\n`);
  const gitEnvironment = {
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    ...(forceAutoCrlf ? { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.autocrlf", GIT_CONFIG_VALUE_0: "true" } : {}),
  };
  const source = await createGitRegistryFixture(root, { lead: "lead v1\n", coder: "coder v1\n" });
  const paths = resolveToolkitRegistryPaths(path.join(root, "home"));
  if (legacyRegistry) await createLegacyRegistry(paths.root, source.remote, gitEnvironment);
  const registry = legacyRegistry
    ? await readLocalAgentRegistry(paths)
    : await initializeToolkitRegistry(paths, { remote: source.remote, gitEnvironment });
  const project = path.join(root, "project");
  const temporaryParent = path.join(root, "temporary");
  await Promise.all([mkdir(project), mkdir(temporaryParent)]);
  await updateAgents(project, {}, registry);
  return { root, ...source, project, paths, registry, temporaryParent, initialHead: await remoteHead(source.remote), gitEnvironment };
}

function publishOptions(setup: IFixture) {
  return {
    destination: setup.project,
    remote: setup.remote,
    registryPaths: setup.paths,
    temporaryParent: setup.temporaryParent,
    now: new Date("2026-10-01T12:00:00Z"),
    confirm: async () => true,
    gitIdentity: { name: "Toolkit Tests", email: "toolkit-tests@example.test" },
    gitEnvironment: setup.gitEnvironment,
  };
}

async function createLegacyRegistry(root: string, remote: string, gitEnvironment: NodeJS.ProcessEnv): Promise<void> {
  await mkdir(path.dirname(root), { recursive: true });
  await execa("git", ["clone", "--config", "core.autocrlf=true", "--filter=blob:none", "--no-checkout", "--", remote, root], { env: gitEnvironment });
  await execa("git", ["-C", root, "sparse-checkout", "init", "--no-cone"], { env: gitEnvironment });
  await execa("git", ["-C", root, "sparse-checkout", "set", "/agents/"], { env: gitEnvironment });
  await execa("git", ["-C", root, "checkout"], { env: gitEnvironment });
}

function agentPath(project: string, name: string): string { return path.join(project, ".opencode/agents", `${name}.md`); }
async function remoteHead(remote: string): Promise<string> { return (await execa("git", ["--git-dir", remote, "rev-parse", "main"])).stdout.trim(); }
