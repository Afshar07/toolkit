import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import * as path from "pathe";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { readCanonicalAgentRegistry } from "../../src/agents/registry.js";
import { updateGitRegistry } from "../../src/registry/git.js";
import { resolveToolkitRegistryPaths } from "../../src/registry/path.js";
import { initializeToolkitRegistry, inspectToolkitRegistry, localRegistryExists, prepareAgentRegistryForUpdate, readLocalAgentRegistry, resolveOfflineAgentRegistry } from "../../src/registry/registry.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Toolkit registry", () => {
  it("resolves the machine registry beneath a supplied platform home directory", () => {
    expect(resolveToolkitRegistryPaths("/home/example")).toEqual({
      root: "/home/example/.toolkit/registry",
      agents: "/home/example/.toolkit/registry/agents",
    });
    expect(resolveToolkitRegistryPaths("C:\\Users\\example").root).toContain(".toolkit/registry");
  });

  it("detects a missing registry", async () => {
    const home = await temporaryDirectory();
    expect(await localRegistryExists(resolveToolkitRegistryPaths(home))).toBe(false);
  });

  it("rejects an unrelated existing directory instead of replacing it", async () => {
    const fixture = await createRemote();
    const home = await temporaryDirectory();
    const paths = resolveToolkitRegistryPaths(home);
    await mkdir(paths.root, { recursive: true });
    await writeFile(path.join(paths.root, "important.txt"), "keep\n");
    await expect(initializeToolkitRegistry(paths, { remote: fixture.remote })).rejects.toThrow("Refusing to replace");
    await expect(readFile(path.join(paths.root, "important.txt"), "utf8")).resolves.toBe("keep\n");
  });

  it("preserves and rejects an existing regular file at the registry path", async () => {
    const fixture = await createRemote();
    const home = await temporaryDirectory();
    const paths = resolveToolkitRegistryPaths(home);
    await mkdir(path.dirname(paths.root), { recursive: true });
    await writeFile(paths.root, "important file\n");

    await expect(initializeToolkitRegistry(paths, { remote: fixture.remote })).rejects.toThrow("not a safe directory");
    await expect(readFile(paths.root, "utf8")).resolves.toBe("important file\n");
  });

  it.skipIf(process.platform === "win32")("preserves and rejects a symlink at the registry path", async () => {
    const fixture = await createRemote();
    const home = await temporaryDirectory();
    const paths = resolveToolkitRegistryPaths(home);
    const target = path.join(home, "existing-registry-target");
    await mkdir(path.dirname(paths.root), { recursive: true });
    await mkdir(target);
    await symlink(target, paths.root, "dir");

    await expect(initializeToolkitRegistry(paths, { remote: fixture.remote })).rejects.toThrow("not a safe directory");
    await writeFile(path.join(target, "preserved.txt"), "preserved\n");
    await expect(readFile(path.join(paths.root, "preserved.txt"), "utf8")).resolves.toBe("preserved\n");
  });

  it("validates manifests and reads canonical agent content", async () => {
    const root = await temporaryDirectory();
    const agents = path.join(root, "agents");
    await mkdir(agents);
    await writeFile(path.join(agents, "manifest.json"), JSON.stringify({ version: "test.1", agents: ["lead"] }));
    await writeFile(path.join(agents, "lead.md"), "canonical lead\n");
    await expect(readCanonicalAgentRegistry(agents)).resolves.toMatchObject({ version: "test.1", agents: { "lead.md": "canonical lead\n" } });
    await writeFile(path.join(agents, "manifest.json"), JSON.stringify({ version: "test.1", agents: ["../escape"] }));
    await expect(readCanonicalAgentRegistry(agents)).rejects.toThrow("Invalid canonical agent manifest");
  });

  it("initializes a sparse local registry and recognizes it as valid", async () => {
    const fixture = await createRemote();
    const home = await temporaryDirectory();
    const paths = resolveToolkitRegistryPaths(home);
    await initializeToolkitRegistry(paths, { remote: fixture.remote });

    expect(await localRegistryExists(paths)).toBe(true);
    await expect(readLocalAgentRegistry(paths)).resolves.toMatchObject({ version: "test.1", source: "local" });
    await expect(inspectToolkitRegistry(paths)).resolves.toMatchObject({ branch: "main", clean: true, version: "test.1" });
    await expect(access(path.join(paths.root, "ignored.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fast-forwards a clean registry", async () => {
    const fixture = await createRemote();
    const home = await temporaryDirectory();
    const paths = resolveToolkitRegistryPaths(home);
    await initializeToolkitRegistry(paths, { remote: fixture.remote });
    await writeFile(path.join(fixture.source, "agents", "lead.md"), "updated lead\n");
    await git(fixture.source, ["add", "agents/lead.md"]);
    await git(fixture.source, ["commit", "-m", "update lead"]);
    await git(fixture.source, ["push"]);

    await updateGitRegistry(paths.root);
    await expect(readFile(path.join(paths.agents, "lead.md"), "utf8")).resolves.toBe("updated lead\n");
  });

  it("refuses to update a dirty registry", async () => {
    const fixture = await createRemote();
    const home = await temporaryDirectory();
    const paths = resolveToolkitRegistryPaths(home);
    await initializeToolkitRegistry(paths, { remote: fixture.remote });
    await writeFile(path.join(paths.agents, "lead.md"), "local edit\n");

    await expect(updateGitRegistry(paths.root)).rejects.toThrow("local modifications");
    await expect(readFile(path.join(paths.agents, "lead.md"), "utf8")).resolves.toBe("local edit\n");
  });

  it("uses an existing valid registry when its remote cannot be refreshed", async () => {
    const fixture = await createRemote();
    const home = await temporaryDirectory();
    const paths = resolveToolkitRegistryPaths(home);
    await initializeToolkitRegistry(paths, { remote: fixture.remote });
    await rm(fixture.remote, { recursive: true, force: true });

    await expect(prepareAgentRegistryForUpdate(paths)).resolves.toMatchObject({
      action: "existing",
      warning: expect.stringContaining("Could not refresh"),
      registry: { source: "local", version: "test.1" },
    });
  });

  it("uses bundled definitions when first-time Git initialization fails", async () => {
    const home = await temporaryDirectory();
    const paths = resolveToolkitRegistryPaths(home);

    await expect(prepareAgentRegistryForUpdate(paths, { remote: path.join(home, "missing.git") })).resolves.toMatchObject({
      action: "bundled",
      warning: expect.stringContaining("Could not initialize"),
      registry: { source: "bundled" },
    });
    expect(await localRegistryExists(paths)).toBe(false);
  });

  it("does not promote or retain a temporary checkout with an invalid manifest", async () => {
    const fixture = await createRemote({ manifest: "{ invalid json", includeLead: true });
    const home = await temporaryDirectory();
    const paths = resolveToolkitRegistryPaths(home);

    await expect(initializeToolkitRegistry(paths, { remote: fixture.remote })).rejects.toThrow("Cannot read canonical agent manifest");
    await expect(access(paths.root)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(registryTemporaryDirectories(paths.root)).resolves.toEqual([]);
  });

  it("does not promote or retain a temporary checkout with a missing canonical agent", async () => {
    const fixture = await createRemote({ includeLead: false });
    const home = await temporaryDirectory();
    const paths = resolveToolkitRegistryPaths(home);

    await expect(initializeToolkitRegistry(paths, { remote: fixture.remote })).rejects.toThrow("Cannot read canonical agent lead.md");
    await expect(access(paths.root)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(registryTemporaryDirectories(paths.root)).resolves.toEqual([]);
  });

  it("resolves status definitions offline without running a Git command", async () => {
    const home = await temporaryDirectory();
    const paths = resolveToolkitRegistryPaths(home);
    await mkdir(path.join(paths.root, ".git"), { recursive: true });
    await mkdir(paths.agents);
    await writeFile(path.join(paths.agents, "manifest.json"), JSON.stringify({ version: "offline.1", agents: ["lead"] }));
    await writeFile(path.join(paths.agents, "lead.md"), "offline lead\n");

    await expect(resolveOfflineAgentRegistry(paths)).resolves.toMatchObject({
      action: "existing",
      registry: { version: "offline.1", source: "local" },
    });
  });
});

interface IRemoteFixtureOptions {
  manifest?: string;
  includeLead?: boolean;
}

async function createRemote(options: IRemoteFixtureOptions = {}): Promise<{ remote: string; source: string }> {
  const root = await temporaryDirectory();
  const remote = path.join(root, "remote.git");
  const source = path.join(root, "source");
  await execa("git", ["init", "--bare", "--initial-branch=main", remote]);
  await execa("git", ["init", "--initial-branch=main", source]);
  await git(source, ["config", "user.email", "test@example.test"]);
  await git(source, ["config", "user.name", "Test"]);
  await mkdir(path.join(source, "agents"));
  await writeFile(path.join(source, "agents", "manifest.json"), options.manifest ?? `${JSON.stringify({ version: "test.1", agents: ["lead"] }, null, 2)}\n`);
  if (options.includeLead !== false) await writeFile(path.join(source, "agents", "lead.md"), "canonical lead\n");
  await writeFile(path.join(source, "ignored.txt"), "not sparse\n");
  await git(source, ["add", "."]);
  await git(source, ["commit", "-m", "initial"]);
  await git(source, ["remote", "add", "origin", remote]);
  await git(source, ["push", "-u", "origin", "main"]);
  return { remote, source };
}

async function registryTemporaryDirectories(registryRoot: string): Promise<string[]> {
  const parent = path.dirname(registryRoot);
  return (await readdir(parent)).filter((entry) => entry.startsWith(".registry-") && entry.endsWith(".tmp"));
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execa("git", args, { cwd });
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "toolkit-registry-"));
  temporaryDirectories.push(directory);
  return directory;
}
