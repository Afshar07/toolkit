import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execa } from "execa";
import { scanWorkspace } from "../../src/scanner/scan.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
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
    await mkdir(path.join(workspace, "node_modules"));

    await expect(scanWorkspace(workspace)).resolves.toEqual({
      schemaVersion: 1,
      name: path.basename(workspace),
      repositories: [{
        name: "panel",
        path: "apps/panel",
        remote: "https://example.test/panel.git",
        packageManager: "pnpm",
        nodeVersion: "22",
      }],
      directories: ["apps", "notes"],
    });
  });

  it("uses the remote selected by the caller when a repository has multiple remotes", async () => {
    const workspace = await makeWorkspace();
    const repository = path.join(workspace, "panel");
    await mkdir(repository);
    await execa("git", ["init"], { cwd: repository });
    await execa("git", ["remote", "add", "origin", "https://example.test/panel.git"], { cwd: repository });
    await execa("git", ["remote", "add", "upstream", "https://example.test/upstream.git"], { cwd: repository });

    const manifest = await scanWorkspace(workspace, {
      selectRemote: async (candidate) => candidate.remotes.find((remote) => remote.name === "upstream"),
    });

    expect(manifest.repositories[0]?.remote).toBe("https://example.test/upstream.git");
  });

  it("does not include repositories without an origin remote", async () => {
    const workspace = await makeWorkspace();
    const repository = path.join(workspace, "local-only");
    await mkdir(repository);
    await execa("git", ["init"], { cwd: repository });

    const manifest = await scanWorkspace(workspace);

    expect(manifest.repositories).toEqual([]);
    expect(manifest.directories).toEqual([]);
  });
});

async function makeWorkspace(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "toolkit-"));
  temporaryDirectories.push(directory);
  return directory;
}
