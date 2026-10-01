import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import * as path from "pathe";
import { afterEach, describe, expect, it } from "vitest";
import { assertWorkspaceManifest, findWorkspaceManifests, readManifest } from "../../src/workspace/manifest.js";
import { resolveManifestPath, toManifestPath } from "../../src/workspace/path.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("findWorkspaceManifests", () => {
  it("returns only compatible workspace manifests in the selected directory", async () => {
    const directory = await makeTemporaryDirectory();
    await writeFile(path.join(directory, "work.workspace.json"), JSON.stringify({
      schemaVersion: 3,
      name: "work",
      repositories: [],
      directories: [],
    }));
    await writeFile(path.join(directory, "package.json"), "{}");
    await writeFile(path.join(directory, "invalid.json"), "{");

    await expect(findWorkspaceManifests(directory)).resolves.toEqual([{
      path: path.join(directory, "work.workspace.json").replaceAll("\\", "/"),
      manifest: { schemaVersion: 3, name: "work", repositories: [], directories: [] },
    }]);
  });
});

describe("readManifest", () => {
  it("reads schema version 3 repositories with named remotes and clone selection", async () => {
    const directory = await makeTemporaryDirectory();
    const filePath = path.join(directory, "work.workspace.json");
    const manifest = {
      schemaVersion: 3,
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
    ["unknown clone remote", { schemaVersion: 3, name: "work", repositories: [{ name: "panel", path: "panel", cloneRemote: "upstream", remotes: [{ name: "origin", url: "https://example.test/panel.git" }] }], directories: [] }],
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

  it("accepts an explicit root repository", async () => {
    const directory = await makeTemporaryDirectory();
    const filePath = path.join(directory, "work.workspace.json");
    const rootRepository = { name: "work", cloneRemote: "origin", remotes: [{ name: "origin", url: "https://example.test/work.git" }] };
    await writeFile(filePath, JSON.stringify({ schemaVersion: 3, name: "work", rootRepository, repositories: [], directories: [] }));

    await expect(readManifest(filePath)).resolves.toMatchObject({ rootRepository });
  });
});

describe("manifest path boundary", () => {
  it("serializes native paths as POSIX manifest paths", () => {
    expect(toManifestPath("C:\\work", "C:\\work\\apps\\panel")).toBe("apps/panel");
  });

  it("resolves POSIX manifest paths within the workspace", () => {
    expect(resolveManifestPath("C:\\work", "apps/panel")).toBe(path.resolve("C:\\work", "apps", "panel"));
  });

  it("rejects backslash and traversal manifest paths", () => {
    expect(() => resolveManifestPath("C:\\work", "apps\\panel")).toThrow("POSIX");
    expect(() => resolveManifestPath("C:\\work", "../panel")).toThrow("parent-directory");
  });
});

describe("manifest trust boundaries", () => {
  it.each(["../escape", "a/b", "a\\b", "/tmp/work", "C:\\work", "C:work", ".", "..", " "])("rejects unsafe workspace name %j", (name) => {
    expect(() => assertWorkspaceManifest({ schemaVersion: 3, name, repositories: [], directories: [] })).toThrow("name");
  });

  it.each(["My Workspace", "toolkit-2", "開発 workspace"])("accepts portable human-readable name %j", (name) => {
    expect(() => assertWorkspaceManifest({ schemaVersion: 3, name, repositories: [], directories: [] })).not.toThrow();
  });

  it.each([
    "https://user@example.invalid/repo.git",
    "https://user:TEST_ONLY_FAKE_TOKEN@example.invalid/repo.git",
    "https://example.invalid/repo.git?token=TEST_ONLY_FAKE_TOKEN",
    "-uhoh",
  ])("rejects an unsafe remote without echoing it", (url) => {
    let message = "";
    try { assertWorkspaceManifest(manifestWithRemote(url)); } catch (error) { message = (error as Error).message; }
    expect(message).toMatch(/credentials|option-like/);
    expect(message).not.toContain("TEST_ONLY_FAKE_TOKEN");
  });

  it.each(["https://example.invalid/repo.git", "git@github.com:owner/repo.git", "../local/repo.git"])("accepts credential-free remote %j", (url) => {
    expect(() => assertWorkspaceManifest(manifestWithRemote(url))).not.toThrow();
  });
});

function manifestWithRemote(url: string) {
  return { schemaVersion: 3, name: "work", directories: [], repositories: [{ name: "repo", path: "repo", cloneRemote: "origin", remotes: [{ name: "origin", url }] }] };
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "toolkit-"));
  temporaryDirectories.push(directory);
  return directory;
}
