import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import * as path from "pathe";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { overrideAgent, updateAgents } from "../../src/agents/sync.js";
import { resolveToolkitRegistryPaths } from "../../src/registry/path.js";
import { initializeToolkitRegistry, prepareAgentRegistryForUpdate } from "../../src/registry/registry.js";
import { createGitRegistryFixture, normalizeLineEndings, publishAgents } from "../helpers/git.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const cli = path.join(repositoryRoot, "dist/cli.js");
const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("compiled CLI", () => {
  it("exposes and parses help for every public top-level command", async () => {
    await expect(access(cli)).resolves.toBeUndefined();
    const rootHelp = await runCli(["--help"]);
    expect(rootHelp.exitCode).toBe(0);
    const source = await readFile(path.join(repositoryRoot, "src/cli.ts"), "utf8");
    const commands = [...source.matchAll(/^ {4}(\w+):\s*\w+Command,$/gm)].map((match) => match[1]);
    expect(commands.length).toBeGreaterThanOrEqual(6);
    for (const command of commands) {
      const help = await runCli([command!, "--help"]);
      expect(help.exitCode).toBe(0);
    }
  });

  it("reports agent states and enforces conflict, override, and manage semantics through processes", async () => {
    const root = await temporaryDirectory();
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    const fixture = await createGitRegistryFixture(root, { lead: "lead v1\n", coder: "coder v1\n", researcher: "researcher v1\n", stable: "stable v1\n" });
    const paths = resolveToolkitRegistryPaths(home);
    const registry = await initializeToolkitRegistry(paths, { remote: fixture.remote });
    await mkdir(project);
    await updateAgents(project, {}, registry);
    await writeFile(path.join(project, ".opencode/agents/lead.md"), "local lead\n");
    await writeFile(path.join(project, ".opencode/agents/local.md"), "local only\n");
    await overrideAgent(project, "coder", registry);
    await publishAgents(fixture.author, { lead: "lead v2\n", coder: "coder v2\n", researcher: "researcher v2\n", stable: "stable v1\n", reviewer: "reviewer v1\n" }, "v2");
    await prepareAgentRegistryForUpdate(paths);

    const status = await runCli(["agents", "status", project], home);
    expect(status.stdout + status.stderr).toMatch(/locally modified/);
    expect(status.stdout + status.stderr).toMatch(/stable\s+current/);
    expect(status.stdout + status.stderr).toMatch(/researcher\s+update available/);
    expect(status.stdout + status.stderr).toMatch(/reviewer\s+not installed/);
    expect(status.stdout + status.stderr).toMatch(/Local agents[\s\S]*local/);
    expect(status.stdout + status.stderr).toMatch(/Overrides[\s\S]*coder/);

    const conflict = await runCli(["agents", "update", project, "--non-interactive"], home, false);
    expect(conflict.exitCode).not.toBe(0);
    expect(conflict.stdout + conflict.stderr).toContain("preserved because Toolkit cannot safely overwrite");
    await expect(readFile(path.join(project, ".opencode/agents/lead.md"), "utf8")).resolves.toBe("local lead\n");

    const refused = await runCli(["agents", "manage", "coder", "--destination", project], home, false);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stdout + refused.stderr).toContain("Re-run with --yes");
    expect(normalizeLineEndings(await readFile(path.join(project, ".opencode/agents/coder.md"), "utf8"))).toBe("coder v1\n");

    await runCli(["agents", "manage", "coder", "--destination", project, "--yes"], home);
    expect(normalizeLineEndings(await readFile(path.join(project, ".opencode/agents/coder.md"), "utf8"))).toBe("coder v2\n");
  }, 15_000);

  it("keeps both status commands offline when the configured remote disappears", async () => {
    const root = await temporaryDirectory();
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    const fixture = await createGitRegistryFixture(root, { lead: "lead\n" });
    const registry = await initializeToolkitRegistry(resolveToolkitRegistryPaths(home), { remote: fixture.remote });
    await mkdir(project);
    await updateAgents(project, {}, registry);
    await rm(fixture.remote, { recursive: true, force: true });
    await expect(runCli(["agents", "status", project], home)).resolves.toMatchObject({ exitCode: 0 });
    await expect(runCli(["registry", "status"], home)).resolves.toMatchObject({ exitCode: 0 });
  });
});

async function runCli(args: string[], home?: string, reject = true) {
  return execa(process.execPath, [cli, ...args], {
    cwd: repositoryRoot,
    reject,
    env: { NODE_ENV: "production", NO_COLOR: "1", FORCE_COLOR: "0", ...(home ? { HOME: home, USERPROFILE: home } : {}) },
  });
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "toolkit-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}
