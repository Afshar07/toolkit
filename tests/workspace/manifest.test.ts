import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import * as path from "pathe";
import { afterEach, describe, expect, it } from "vitest";
import { findWorkspaceManifests } from "../../src/workspace/manifest.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("findWorkspaceManifests", () => {
  it("returns only compatible workspace manifests in the selected directory", async () => {
    const directory = await makeTemporaryDirectory();
    await writeFile(path.join(directory, "work.workspace.json"), JSON.stringify({
      schemaVersion: 1,
      name: "work",
      repositories: [],
      directories: [],
    }));
    await writeFile(path.join(directory, "package.json"), "{}");
    await writeFile(path.join(directory, "invalid.json"), "{");

    await expect(findWorkspaceManifests(directory)).resolves.toEqual([{
      path: path.join(directory, "work.workspace.json").replaceAll("\\", "/"),
      manifest: { schemaVersion: 1, name: "work", repositories: [], directories: [] },
    }]);
  });
});

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "toolkit-"));
  temporaryDirectories.push(directory);
  return directory;
}
