import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import * as path from "pathe";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { publishAllAgents } from "../../src/agents/publish.js";
import { readAgentManifest } from "../../src/agents/manifest.js";
import { hashAgentContent, overrideAgent, updateAgents } from "../../src/agents/sync.js";
import { prepareAgentRegistryForUpdate } from "../../src/registry/registry.js";
import { gitCommand, publishAgents } from "../helpers/git.js";
import { agentPath, createPublicationFixtures, publishOptions, remoteHead } from "../helpers/publication.js";

const { fixture, cleanup } = createPublicationFixtures();
afterEach(cleanup);

/** Real Git operations need more than the default five seconds on Windows. */
describe.sequential("agent batch publication", { timeout: 30_000 }, () => {
  it("supports compiled CLI --all and rejects absent or competing selectors before network", async () => {
    const setup = await fixture();
    const cli = path.resolve("dist/cli.js");
    const env = { ...setup.gitEnvironment, NODE_ENV: "production", CONSOLA_LEVEL: "3", NO_COLOR: "1", FORCE_COLOR: "0", HOME: path.join(setup.root, "home"), USERPROFILE: path.join(setup.root, "home"), XDG_CONFIG_HOME: path.join(setup.root, "config") };
    const run = (args: string[]) => execa(process.execPath, [cli, "agents", "publish", ...args], { cwd: setup.project, env, reject: false });
    for (const args of [[], ["coder", "--all"]]) {
      const result = await run(args);
      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("Select exactly one of NAME or --all");
    }
    const help = await run(["--help"]);
    expect(help.exitCode).toBe(0);
    expect(`${help.stdout}\n${help.stderr}`).toContain("--all");
    await writeFile(agentPath(setup.project, "coder"), "compiled preview\n");
    const preview = await run(["--all", "--dry-run"]);
    expect(preview.exitCode).toBe(0);
    expect(preview.stdout).toContain("+compiled preview");
    expect(preview.stdout).toContain("lead.md (unchanged)");
    expect(await remoteHead(setup.remote)).toBe(setup.initialHead);
  });

  it("publishes dynamic membership with one commit, version bump, and confirmation", async () => {
    const setup = await fixture();
    await publishAgents(setup.author, { lead: "lead v1\n", coder: "coder v1\n", extra: "extra v1\n" }, "membership");
    const refreshed = await prepareAgentRegistryForUpdate(setup.paths, { gitEnvironment: setup.gitEnvironment });
    await updateAgents(setup.project, {}, refreshed.registry);
    const before = await remoteHead(setup.remote);
    await writeFile(agentPath(setup.project, "lead"), "lead improved\r\n");
    await writeFile(agentPath(setup.project, "extra"), "extra improved\n");
    await writeFile(agentPath(setup.project, "unrelated"), "local only\n");
    const ownershipBefore = await readAgentManifest(setup.project);
    let confirmations = 0;
    const result = await publishAllAgents({ ...publishOptions(setup), confirm: async (preview) => {
      confirmations++;
      expect(preview.agents.map((agent) => agent.name).sort()).toEqual(["coder", "extra", "lead"]);
      return true;
    } });
    expect(confirmations).toBe(1);
    expect(result.outcome).toBe("published");
    expect(result.preview.proposedVersion).toBe("2026.10.1");
    const commits = await gitCommand("rev-list", ["--git-dir", setup.remote, "rev-list", "--count", `${before}..main`]);
    expect(commits.stdout).toBe("1");
    const changed = await gitCommand("diff-tree", ["--git-dir", setup.remote, "diff-tree", "--no-commit-id", "--name-only", "-r", "main"]);
    expect(changed.stdout.split(/\r?\n/).sort()).toEqual(["agents/extra.md", "agents/lead.md", "agents/manifest.json"]);
    expect((await readAgentManifest(setup.project)).installed.coder).toEqual(ownershipBefore.installed.coder);
    await expect(readFile(agentPath(setup.project, "lead"), "utf8")).resolves.toBe("lead improved\n");
    await expect(readFile(agentPath(setup.project, "unrelated"), "utf8")).resolves.toBe("local only\n");
    await expect(readdir(setup.temporaryParent)).resolves.toEqual([]);
  });

  it("keeps batch no-change and dry-run state disposable", async () => {
    const setup = await fixture();
    const ownership = await readAgentManifest(setup.project);
    expect((await publishAllAgents(publishOptions(setup))).outcome).toBe("unchanged");
    await writeFile(agentPath(setup.project, "lead"), "preview lead\n");
    await writeFile(agentPath(setup.project, "coder"), "preview coder\n");
    const result = await publishAllAgents({ ...publishOptions(setup), dryRun: true, confirm: undefined });
    expect(result.outcome).toBe("dry-run");
    expect(result.preview.diff).toContain("+preview lead");
    expect(result.preview.diff).toContain("+preview coder");
    expect(await remoteHead(setup.remote)).toBe(setup.initialHead);
    expect(await readAgentManifest(setup.project)).toEqual(ownership);
    await expect(readdir(setup.temporaryParent)).resolves.toEqual([]);
  });

  it.each(["missing", "override", "unmanaged", "stale"])("preflights the second batch member's %s state before confirmation or push", async (state) => {
    const setup = await fixture();
    await writeFile(agentPath(setup.project, "lead"), "first change\n");
    if (state === "missing") await rm(agentPath(setup.project, "coder"));
    if (state === "override") await overrideAgent(setup.project, "coder", setup.registry);
    if (state === "unmanaged") {
      const manifest = await readAgentManifest(setup.project);
      delete manifest.installed.coder;
      await writeFile(path.join(setup.project, ".toolkit/agents.json"), JSON.stringify(manifest));
    }
    if (state === "stale") {
      await writeFile(agentPath(setup.project, "coder"), "second change\n");
      await publishAgents(setup.author, { lead: "lead v1\n", coder: "upstream edit\n" }, "advance");
    }
    const head = await remoteHead(setup.remote);
    const ownership = await readAgentManifest(setup.project);
    let confirmations = 0;
    await expect(publishAllAgents({ ...publishOptions(setup), ...(state === "stale" ? { includeOverride: true, allowUnmanaged: true } : {}), confirm: async () => { confirmations++; return true; } })).rejects.toThrow();
    expect(confirmations).toBe(0);
    expect(await remoteHead(setup.remote)).toBe(head);
    expect(await readAgentManifest(setup.project)).toEqual(ownership);
    await expect(readFile(agentPath(setup.project, "lead"), "utf8")).resolves.toBe("first change\n");
    await expect(readdir(setup.temporaryParent)).resolves.toEqual([]);
  });

  it("publishes acknowledged overrides and unmanaged agents in one batch", async () => {
    const setup = await fixture();
    await overrideAgent(setup.project, "lead", setup.registry);
    const manifest = await readAgentManifest(setup.project);
    delete manifest.installed.coder;
    await writeFile(path.join(setup.project, ".toolkit/agents.json"), JSON.stringify(manifest));
    await writeFile(agentPath(setup.project, "lead"), "shared override\n");
    await writeFile(agentPath(setup.project, "coder"), "shared unmanaged\n");
    const result = await publishAllAgents({ ...publishOptions(setup), includeOverride: true, allowUnmanaged: true });
    expect(result.outcome).toBe("published");
    const ownership = await readAgentManifest(setup.project);
    expect(ownership.overrides).toEqual([]);
    expect(ownership.installed.lead?.hash).toBe(hashAgentContent("shared override\n"));
    expect(ownership.installed.coder?.hash).toBe(hashAgentContent("shared unmanaged\n"));
  });
});
