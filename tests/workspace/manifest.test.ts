import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import * as path from "pathe";
import { afterEach, describe, expect, it } from "vitest";
import { findWorkspaceManifests, readManifest } from "../../src/workspace/manifest.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("findWorkspaceManifests", () => {
  it("returns only compatible workspace manifests in the selected directory", async () => {
    const directory = await makeTemporaryDirectory();
    await writeFile(path.join(directory, "work.workspace.json"), JSON.stringify({
      schemaVersion: 2,
      name: "work",
      repositories: [],
      directories: [],
    }));
    await writeFile(path.join(directory, "package.json"), "{}");
    await writeFile(path.join(directory, "invalid.json"), "{");

    await expect(findWorkspaceManifests(directory)).resolves.toEqual([{
      path: path.join(directory, "work.workspace.json").replaceAll("\\", "/"),
      manifest: { schemaVersion: 2, name: "work", repositories: [], directories: [] },
    }]);
  });
});

describe("readManifest", () => {
  it("reads schema version 2 repositories with named remotes and clone selection", async () => {
    const directory = await makeTemporaryDirectory();
    const filePath = path.join(directory, "work.workspace.json");
    const manifest = {
      schemaVersion: 2,
      name: "work",
      directories: [],
      repositories: [{
        name: "panel",
        path: "apps/panel",
        cloneRemote: "upstream",
        remotes: [
          { name: "origin", url: "https://example.test/panel.git" },
          { name: "upstream", url: "https://example.test/upstream.git" },
        ],
      }],
    };
    await writeFile(filePath, JSON.stringify(manifest));

    await expect(readManifest(filePath)).resolves.toEqual(manifest);
  });

  it.each([
    ["empty workspace name", { schemaVersion: 1, name: "", repositories: [], directories: [] }],
    ["empty repository remote", { schemaVersion: 1, name: "work", repositories: [{ name: "panel", path: "panel", remote: " " }], directories: [] }],
    ["absolute repository path", { schemaVersion: 1, name: "work", repositories: [{ name: "panel", path: "/panel", remote: "https://example.test/panel.git" }], directories: [] }],
    ["parent traversal", { schemaVersion: 1, name: "work", repositories: [{ name: "panel", path: "../panel", remote: "https://example.test/panel.git" }], directories: [] }],
    ["Windows directory path", { schemaVersion: 1, name: "work", repositories: [], directories: ["notes\\private"] }],
    ["duplicate repository paths", { schemaVersion: 1, name: "work", repositories: [{ name: "one", path: "apps/panel", remote: "https://example.test/one.git" }, { name: "two", path: "apps/panel", remote: "https://example.test/two.git" }], directories: [] }],
    ["overlapping repository paths", { schemaVersion: 1, name: "work", repositories: [{ name: "one", path: "apps", remote: "https://example.test/one.git" }, { name: "two", path: "apps/panel", remote: "https://example.test/two.git" }], directories: [] }],
    ["directory repository collision", { schemaVersion: 1, name: "work", repositories: [{ name: "panel", path: "apps/panel", remote: "https://example.test/panel.git" }], directories: ["apps"] }],
    ["unknown clone remote", { schemaVersion: 2, name: "work", repositories: [{ name: "panel", path: "panel", cloneRemote: "upstream", remotes: [{ name: "origin", url: "https://example.test/panel.git" }] }], directories: [] }],
  ])("rejects a manifest with %s", async (_reason, manifest) => {
    const directory = await makeTemporaryDirectory();
    const filePath = path.join(directory, "work.workspace.json");
    await writeFile(filePath, JSON.stringify(manifest));

    await expect(readManifest(filePath)).rejects.toThrow("Invalid workspace manifest");
  });

  it("reports malformed JSON clearly", async () => {
    const directory = await makeTemporaryDirectory();
    const filePath = path.join(directory, "broken.workspace.json");
    await writeFile(filePath, "{");

    await expect(readManifest(filePath)).rejects.toThrow("invalid JSON");
  });
});

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "toolkit-"));
  temporaryDirectories.push(directory);
  return directory;
}
