import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execa } from "execa";
import { setupWorkspace, WorkspaceSetupError } from "../../src/setup/setup.js";
import type { WorkspaceManifest } from "../../src/workspace/manifest.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("setupWorkspace", () => {
  it("creates normal directories and clones missing repositories into relative paths", async () => {
    const temporaryDirectory = await makeTemporaryDirectory();
    const remote = path.join(temporaryDirectory, "panel.git");
    await execa("git", ["init", "--bare", remote]);
    const manifest: WorkspaceManifest = {
      schemaVersion: 1,
      name: "work",
      directories: ["notes"],
      repositories: [{ name: "panel", path: "apps/panel", remote }],
    };

    const result = await setupWorkspace(manifest, temporaryDirectory, () => {});

    expect(result).toEqual({ cloned: ["apps/panel"], skipped: [] });
    await expect(access(path.join(temporaryDirectory, "work", "notes"))).resolves.toBeUndefined();
    await expect(access(path.join(temporaryDirectory, "work", "apps", "panel", ".git"))).resolves.toBeUndefined();
  });

  it("does not overwrite an existing repository destination", async () => {
    const temporaryDirectory = await makeTemporaryDirectory();
    const manifest: WorkspaceManifest = {
      schemaVersion: 1,
      name: "work",
      directories: [],
      repositories: [{ name: "panel", path: "panel", remote: "https://example.test/panel.git" }],
    };
    await execa("git", ["init", path.join(temporaryDirectory, "work", "panel")]);

    await expect(setupWorkspace(manifest, temporaryDirectory, () => {})).resolves.toEqual({ cloned: [], skipped: ["panel"] });
  });

  it("continues cloning other repositories when one clone fails", async () => {
    const temporaryDirectory = await makeTemporaryDirectory();
    const remote = path.join(temporaryDirectory, "working.git");
    await execa("git", ["init", "--bare", remote]);
    const manifest: WorkspaceManifest = {
      schemaVersion: 1,
      name: "work",
      directories: [],
      repositories: [
        { name: "missing", path: "missing", remote: path.join(temporaryDirectory, "missing.git") },
        { name: "working", path: "working", remote },
      ],
    };

    await expect(setupWorkspace(manifest, temporaryDirectory, () => {})).rejects.toBeInstanceOf(WorkspaceSetupError);
    await expect(access(path.join(temporaryDirectory, "work", "working", ".git"))).resolves.toBeUndefined();
  });
});

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "toolkit-"));
  temporaryDirectories.push(directory);
  return directory;
}
