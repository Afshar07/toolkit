import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import * as path from "pathe";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execa } from "execa";
import { scanWorkspace } from "../../src/scanner/scan.js";

const temporaryDirectories: string[] = [];
const inaccessibleGitMarkers = vi.hoisted(() => new Set<string>());

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    stat: async (target: string | Buffer | URL) => {
      if (typeof target === "string" && inaccessibleGitMarkers.has(target)) {
        const error = new Error("Access denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return original.stat(target);
    },
  };
});

afterEach(async () => {
  inaccessibleGitMarkers.clear();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("scanWorkspace", () => {
  it("captures a cloneable repository and reconstruction hints", async () => {
    const workspace = await makeWorkspace();
    const repository = path.join(workspace, "apps", "panel");
    await mkdir(repository, { recursive: true });
    await execa("git", ["init"], { cwd: repository });
    await execa("git", ["remote", "add", "origin", "https://example.test/panel.git"], { cwd: repository });
    await execa("git", ["remote", "add", "upstream", "https://example.test/upstream.git"], { cwd: repository });
    await writeFile(path.join(repository, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await writeFile(path.join(repository, ".nvmrc"), "22\n");
    await mkdir(path.join(workspace, "notes"));
    await mkdir(path.join(workspace, "infrastructure", "templates"), { recursive: true });
    await mkdir(path.join(workspace, "node_modules"));
    await mkdir(path.join(workspace, ".toolkit-backups", "run", "empty"), { recursive: true });

    await expect(scanWorkspace(workspace)).resolves.toEqual({
      schemaVersion: 3,
      name: path.basename(workspace),
      repositories: [{
        name: "panel",
        path: "apps/panel",
        cloneRemote: "origin",
        remotes: [
          { name: "origin", url: "https://example.test/panel.git" },
          { name: "upstream", url: "https://example.test/upstream.git" },
        ],
        packageManager: "pnpm",
        nodeVersion: "22",
      }],
      directories: ["infrastructure/templates", "notes"],
    });
  });

  it("uses origin without prompting and preserves every remote", async () => {
    const workspace = await makeWorkspace();
    const repository = path.join(workspace, "panel");
    await mkdir(repository);
    await execa("git", ["init"], { cwd: repository });
    await execa("git", ["remote", "add", "origin", "https://example.test/panel.git"], { cwd: repository });
    await execa("git", ["remote", "add", "upstream", "https://example.test/upstream.git"], { cwd: repository });

    const manifest = await scanWorkspace(workspace, { selectRemote: async () => { throw new Error("should not prompt"); } });

    expect(manifest.repositories[0]).toMatchObject({
      cloneRemote: "origin",
      remotes: [
        { name: "origin", url: "https://example.test/panel.git" },
        { name: "upstream", url: "https://example.test/upstream.git" },
      ],
    });
  });

  it("uses the caller selection when multiple remotes have no origin", async () => {
    const workspace = await makeWorkspace();
    const repository = path.join(workspace, "panel");
    await mkdir(repository);
    await execa("git", ["init"], { cwd: repository });
    await execa("git", ["remote", "add", "fork", "https://example.test/fork.git"], { cwd: repository });
    await execa("git", ["remote", "add", "upstream", "https://example.test/upstream.git"], { cwd: repository });

    const manifest = await scanWorkspace(workspace, {
      selectRemote: async (candidate) => candidate.remotes.find((remote) => remote.name === "upstream"),
    });

    expect(manifest.repositories[0]?.cloneRemote).toBe("upstream");
  });

  it("uses a sole non-origin remote without prompting", async () => {
    const workspace = await makeWorkspace();
    const repository = path.join(workspace, "panel");
    await mkdir(repository);
    await execa("git", ["init"], { cwd: repository });
    await execa("git", ["remote", "add", "upstream", "https://example.test/upstream.git"], { cwd: repository });

    await expect(scanWorkspace(workspace)).resolves.toMatchObject({
      repositories: [{ cloneRemote: "upstream", remotes: [{ name: "upstream", url: "https://example.test/upstream.git" }] }],
    });
  });

  it("does not include repositories without remotes", async () => {
    const workspace = await makeWorkspace();
    const repository = path.join(workspace, "local-only");
    await mkdir(repository);
    await execa("git", ["init"], { cwd: repository });

    const manifest = await scanWorkspace(workspace);

    expect(manifest.repositories).toEqual([]);
    expect(manifest.directories).toEqual([]);
  });

  it("represents a root repository explicitly and does not scan its contents", async () => {
    const workspace = await makeWorkspace();
    await execa("git", ["init"], { cwd: workspace });
    await execa("git", ["remote", "add", "origin", "https://example.test/work.git"], { cwd: workspace });
    await mkdir(path.join(workspace, "notes"));

    await expect(scanWorkspace(workspace)).resolves.toMatchObject({
      schemaVersion: 3,
      rootRepository: { name: path.basename(workspace), cloneRemote: "origin" },
      repositories: [],
      directories: [],
    });
  });

  it("reports inaccessible Git markers instead of treating them as absent", async () => {
    const workspace = await makeWorkspace();
    const repository = path.join(workspace, "panel");
    await mkdir(repository);
    inaccessibleGitMarkers.add(path.join(repository, ".git"));

    await expect(scanWorkspace(workspace)).rejects.toThrow(`Unable to inspect Git marker at ${path.join(repository, ".git")}`);
  });

  it("reports corrupt repositories instead of silently omitting them", async () => {
    const workspace = await makeWorkspace();
    const repository = path.join(workspace, "panel");
    await mkdir(repository);
    await writeFile(path.join(repository, ".git"), "not a gitdir\n");

    await expect(scanWorkspace(workspace)).rejects.toThrow(`Unable to discover Git remotes for ${repository}`);
  });
});

async function makeWorkspace(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "toolkit-"));
  temporaryDirectories.push(directory);
  return directory;
}
