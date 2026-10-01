import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import * as path from "pathe";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { incrementCanonicalVersion, publishAgent } from "../../src/agents/publish.js";
import { readAgentManifest } from "../../src/agents/manifest.js";
import { overrideAgent, updateAgents } from "../../src/agents/sync.js";
import { initializeToolkitRegistry, prepareAgentRegistryForUpdate } from "../../src/registry/registry.js";
import { resolveToolkitRegistryPaths } from "../../src/registry/path.js";
import { createGitRegistryFixture, publishAgents } from "../helpers/git.js";

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("agent publication", () => {
  it("publishes only the selected agent and manifest, reconciles ownership, and can be received elsewhere", async () => {
    const setup = await fixture();
    await writeFile(agentPath(setup.project, "coder"), "coder improved\n");

    const result = await publishAgent("coder", publishOptions(setup));

    expect(result.outcome).toBe("published");
    expect(result.localSynchronizationComplete).toBe(true);
    const changed = await execa("git", ["--git-dir", setup.remote, "diff-tree", "--no-commit-id", "--name-only", "-r", "main"]);
    expect(changed.stdout.split(/\r?\n/).sort()).toEqual(["agents/coder.md", "agents/manifest.json"]);
    expect((await readAgentManifest(setup.project)).installed.coder?.version).toBe(result.preview.proposedVersion);

    const other = path.join(setup.root, "other");
    await mkdir(other);
    const refreshed = await prepareAgentRegistryForUpdate(setup.paths);
    await updateAgents(other, {}, refreshed.registry);
    await expect(readFile(agentPath(other, "coder"), "utf8")).resolves.toBe("coder improved\n");
    await expect(readdir(setup.temporaryParent)).resolves.toEqual([]);
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

    const unsafe = path.join(fresh.root, "unsafe");
    await mkdir(unsafe);
    await execa(process.platform === "win32" ? "cmd" : "ln", process.platform === "win32"
      ? ["/c", "mklink", "/D", path.join(unsafe, ".opencode"), path.join(fresh.root, "outside")]
      : ["-s", path.join(fresh.root, "outside"), path.join(unsafe, ".opencode")]);
    await expect(publishAgent("coder", { ...publishOptions(fresh), destination: unsafe })).rejects.toThrow(/regular file|unsafe/);
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
}

async function fixture(): Promise<IFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "toolkit-publish-test-"));
  temporaryDirectories.push(root);
  const source = await createGitRegistryFixture(root, { lead: "lead v1\n", coder: "coder v1\n" });
  const paths = resolveToolkitRegistryPaths(path.join(root, "home"));
  const registry = await initializeToolkitRegistry(paths, { remote: source.remote });
  const project = path.join(root, "project");
  const temporaryParent = path.join(root, "temporary");
  await Promise.all([mkdir(project), mkdir(temporaryParent)]);
  await updateAgents(project, {}, registry);
  return { root, ...source, project, paths, registry, temporaryParent, initialHead: await remoteHead(source.remote) };
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
  };
}

function agentPath(project: string, name: string): string { return path.join(project, ".opencode/agents", `${name}.md`); }
async function remoteHead(remote: string): Promise<string> { return (await execa("git", ["--git-dir", remote, "rev-parse", "main"])).stdout.trim(); }
