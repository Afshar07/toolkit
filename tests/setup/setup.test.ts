import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import * as path from "pathe";
import { afterEach, describe, expect, it } from "vitest";
import { execa } from "execa";
import { setupWorkspace, WorkspaceSetupError } from "../../src/setup/setup.js";
import type { WorkspaceManifest } from "../../src/workspace/manifest.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("setupWorkspace", () => {
  it("creates standalone structural directories and repository parents", async () => {
    const temporaryDirectory = await makeTemporaryDirectory();
    const remote = path.join(temporaryDirectory, "panel.git");
    await execa("git", ["init", "--bare", remote]);
    const manifest: WorkspaceManifest = {
      schemaVersion: 2,
      name: "work",
      directories: ["notes", "infrastructure/templates"],
      repositories: [{ name: "panel", path: "apps/panel", cloneRemote: "origin", remotes: [{ name: "origin", url: remote }, { name: "upstream", url: "https://example.test/upstream.git" }] }],
    };

    const result = await setupWorkspace(manifest, temporaryDirectory, () => {});

    expect(result).toEqual({ cloned: ["apps/panel"], skipped: [] });
    await expect(access(path.join(temporaryDirectory, "work", "notes"))).resolves.toBeUndefined();
    await expect(access(path.join(temporaryDirectory, "work", "infrastructure", "templates"))).resolves.toBeUndefined();
    await expect(access(path.join(temporaryDirectory, "work", "apps", "panel", ".git"))).resolves.toBeUndefined();
    await expect(execa("git", ["-C", path.join(temporaryDirectory, "work", "apps", "panel"), "remote", "get-url", "upstream"])).resolves.toMatchObject({ stdout: "https://example.test/upstream.git" });
  });

  it("skips an existing Git worktree with a matching origin remote", async () => {
    const temporaryDirectory = await makeTemporaryDirectory();
    const remote = path.join(temporaryDirectory, "panel.git");
    await execa("git", ["init", "--bare", remote]);
    const manifest: WorkspaceManifest = {
      schemaVersion: 2,
      name: "work",
      directories: [],
      repositories: [{ name: "panel", path: "panel", cloneRemote: "origin", remotes: [{ name: "origin", url: remote }] }],
    };
    await execa("git", ["clone", remote, path.join(temporaryDirectory, "work", "panel")]);

    await expect(setupWorkspace(manifest, temporaryDirectory, () => {})).resolves.toEqual({ cloned: [], skipped: ["panel"] });
  });

  it("reports a non-Git destination as a conflict without modifying it", async () => {
    const temporaryDirectory = await makeTemporaryDirectory();
    const target = path.join(temporaryDirectory, "work", "panel");
    await execa("git", ["init", "--bare", path.join(temporaryDirectory, "panel.git")]);
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "keep.txt"), "keep");
    const manifest = makeManifest(path.join(temporaryDirectory, "panel.git"));

    await expect(setupWorkspace(manifest, temporaryDirectory, () => {})).rejects.toMatchObject({
      conflicts: [{ path: "panel", reason: "destination is not a Git worktree" }],
    });
    await expect(access(path.join(target, "keep.txt"))).resolves.toBeUndefined();
  });

  it("reports a Git worktree with a wrong origin remote as a conflict", async () => {
    const temporaryDirectory = await makeTemporaryDirectory();
    const expectedRemote = path.join(temporaryDirectory, "expected.git");
    const actualRemote = path.join(temporaryDirectory, "actual.git");
    await execa("git", ["init", "--bare", expectedRemote]);
    await execa("git", ["init", "--bare", actualRemote]);
    await execa("git", ["clone", actualRemote, path.join(temporaryDirectory, "work", "panel")]);

    await expect(setupWorkspace(makeManifest(expectedRemote), temporaryDirectory, () => {})).rejects.toMatchObject({
      conflicts: [{ path: "panel", reason: "origin remote does not match the manifest" }],
    });
  });

  it("continues cloning other repositories when one clone fails", async () => {
    const temporaryDirectory = await makeTemporaryDirectory();
    const remote = path.join(temporaryDirectory, "working.git");
    await execa("git", ["init", "--bare", remote]);
    const manifest: WorkspaceManifest = {
      schemaVersion: 2,
      name: "work",
      directories: [],
      repositories: [
        { name: "missing", path: "missing", cloneRemote: "origin", remotes: [{ name: "origin", url: path.join(temporaryDirectory, "missing.git") }] },
        { name: "working", path: "working", cloneRemote: "origin", remotes: [{ name: "origin", url: remote }] },
      ],
    };

    await expect(setupWorkspace(manifest, temporaryDirectory, () => {})).rejects.toBeInstanceOf(WorkspaceSetupError);
    await expect(access(path.join(temporaryDirectory, "work", "working", ".git"))).resolves.toBeUndefined();
  });

  it("rejects unsafe manifest paths before creating the workspace", async () => {
    const temporaryDirectory = await makeTemporaryDirectory();
    const manifest = {
      schemaVersion: 2,
      name: "work",
      directories: ["../outside"],
      repositories: [],
    } as WorkspaceManifest;

    await expect(setupWorkspace(manifest, temporaryDirectory, () => {})).rejects.toThrow("parent-directory");
    await expect(access(path.join(temporaryDirectory, "work"))).rejects.toThrow();
  });
});

function makeManifest(remote: string): WorkspaceManifest {
  return {
    schemaVersion: 2,
    name: "work",
    directories: [],
    repositories: [{ name: "panel", path: "panel", cloneRemote: "origin", remotes: [{ name: "origin", url: remote }] }],
  };
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "toolkit-"));
  temporaryDirectories.push(directory);
  return directory;
}
