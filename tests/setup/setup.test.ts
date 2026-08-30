import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import * as path from "pathe";
import { afterEach, describe, expect, it } from "vitest";
import { execa } from "execa";
import { setupWorkspace } from "../../src/setup/setup.js";
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
      schemaVersion: 3,
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
      schemaVersion: 3,
      name: "work",
      directories: [],
      repositories: [{ name: "panel", path: "panel", cloneRemote: "origin", remotes: [{ name: "origin", url: remote }] }],
    };
    await execa("git", ["clone", remote, path.join(temporaryDirectory, "work", "panel")]);

    await expect(setupWorkspace(manifest, temporaryDirectory, () => {})).resolves.toEqual({ cloned: [], skipped: ["panel"] });
  });

  it("skips an existing linked worktree with a matching origin remote", async () => {
    const temporaryDirectory = await makeTemporaryDirectory();
    const remote = path.join(temporaryDirectory, "panel.git");
    const source = path.join(temporaryDirectory, "source");
    const checkout = path.join(temporaryDirectory, "checkout");
    const target = path.join(temporaryDirectory, "work", "panel");
    await execa("git", ["init", "--bare", remote]);
    await execa("git", ["init", source]);
    await execa("git", ["-C", source, "config", "user.email", "test@example.test"]);
    await execa("git", ["-C", source, "config", "user.name", "Test"]);
    await execa("git", ["-C", source, "commit", "--allow-empty", "-m", "initial"]);
    await execa("git", ["-C", source, "remote", "add", "origin", remote]);
    await execa("git", ["-C", source, "push", "origin", "HEAD"]);
    await execa("git", ["clone", remote, checkout]);
    await execa("git", ["-C", checkout, "worktree", "add", target]);

    await expect(setupWorkspace(makeManifest(remote), temporaryDirectory, () => {})).resolves.toEqual({ cloned: [], skipped: ["panel"] });
    await expect(access(path.join(target, ".git"))).resolves.toBeUndefined();
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
      schemaVersion: 3,
      name: "work",
      directories: [],
      repositories: [
        { name: "missing", path: "missing", cloneRemote: "origin", remotes: [{ name: "origin", url: path.join(temporaryDirectory, "missing.git") }] },
        { name: "working", path: "working", cloneRemote: "origin", remotes: [{ name: "origin", url: remote }] },
      ],
    };

    await expect(setupWorkspace(manifest, temporaryDirectory, () => {})).rejects.toMatchObject({
      failed: ["missing (clone remote origin)"],
    });
    await expect(access(path.join(temporaryDirectory, "work", "working", ".git"))).resolves.toBeUndefined();
    await expect(access(path.join(temporaryDirectory, "work", "missing"))).rejects.toThrow();
  });

  it("preserves a cloned repository when configuring a secondary remote fails", async () => {
    const temporaryDirectory = await makeTemporaryDirectory();
    const remote = path.join(temporaryDirectory, "panel.git");
    await execa("git", ["init", "--bare", remote]);
    const manifest: WorkspaceManifest = {
      schemaVersion: 3,
      name: "work",
      directories: [],
      repositories: [{
        name: "panel",
        path: "panel",
        cloneRemote: "origin",
        remotes: [
          { name: "origin", url: remote },
          { name: "invalid remote", url: "https://example.test/upstream.git" },
        ],
      }],
    };
    const progress: string[] = [];

    await expect(setupWorkspace(manifest, temporaryDirectory, (message) => progress.push(message))).rejects.toMatchObject({
      failed: ["panel (remote invalid remote)"],
    });
    await expect(access(path.join(temporaryDirectory, "work", "panel", ".git"))).resolves.toBeUndefined();
    expect(progress).toContain("Failed to configure remote invalid remote for panel.");
  });

  it("retries a failed clone with a selected fallback remote", async () => {
    const temporaryDirectory = await makeTemporaryDirectory();
    const fallback = path.join(temporaryDirectory, "fallback.git");
    await execa("git", ["init", "--bare", fallback]);
    const manifest: WorkspaceManifest = {
      schemaVersion: 3,
      name: "work",
      directories: [],
      repositories: [{
        name: "panel",
        path: "panel",
        cloneRemote: "origin",
        remotes: [
          { name: "origin", url: path.join(temporaryDirectory, "missing.git") },
          { name: "upstream", url: fallback },
        ],
      }],
    };
    const changes: string[] = [];

    await expect(setupWorkspace(manifest, temporaryDirectory, () => {}, {
      selectFallbackRemote: async () => manifest.repositories[0]!.remotes[1],
      onCloneRemoteChanged: (repository, remote) => {
        manifest.repositories.find((candidate) => candidate.path === repository.path)!.cloneRemote = remote.name;
        changes.push(remote.name);
      },
    })).resolves.toEqual({ cloned: ["panel"], skipped: [] });
    expect(changes).toEqual(["upstream"]);
    expect(manifest.repositories[0]!.cloneRemote).toBe("upstream");
    await expect(execa("git", ["-C", path.join(temporaryDirectory, "work", "panel"), "remote", "get-url", "origin"])).resolves.toMatchObject({ stdout: path.join(temporaryDirectory, "missing.git") });
  });

  it("rejects unsafe manifest paths before creating the workspace", async () => {
    const temporaryDirectory = await makeTemporaryDirectory();
    const manifest = {
      schemaVersion: 3,
      name: "work",
      directories: ["../outside"],
      repositories: [],
    } as WorkspaceManifest;

    await expect(setupWorkspace(manifest, temporaryDirectory, () => {})).rejects.toThrow("parent-directory");
    await expect(access(path.join(temporaryDirectory, "work"))).rejects.toThrow();
  });

  it("clones an explicit root repository into the workspace root", async () => {
    const temporaryDirectory = await makeTemporaryDirectory();
    const remote = path.join(temporaryDirectory, "work.git");
    await execa("git", ["init", "--bare", remote]);
    const manifest: WorkspaceManifest = {
      schemaVersion: 3,
      name: "work",
      rootRepository: { name: "work", cloneRemote: "origin", remotes: [{ name: "origin", url: remote }] },
      repositories: [],
      directories: [],
    };

    await expect(setupWorkspace(manifest, temporaryDirectory, () => {})).resolves.toEqual({ cloned: ["."], skipped: [] });
    await expect(access(path.join(temporaryDirectory, "work", ".git"))).resolves.toBeUndefined();
  });
});

function makeManifest(remote: string): WorkspaceManifest {
  return {
    schemaVersion: 3,
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
