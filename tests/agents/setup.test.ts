import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import * as path from "pathe";
import { afterEach, describe, expect, it } from "vitest";
import { setupOpenCodeAgents } from "../../src/agents/setup.js";
import { canonicalAgents } from "../../src/agents/registry.js";

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((entry) => rm(entry, { recursive: true, force: true }))));

describe("setupOpenCodeAgents", () => {
  it("creates agents in an ordinary nested destination", async () => {
    const root = await temporaryDirectory();
    const destination = path.join(root, ".opencode", "agents");
    await expect(setupOpenCodeAgents(destination)).resolves.toEqual(Object.keys(canonicalAgents));
    await expect(readFile(path.join(destination, "lead.md"), "utf8")).resolves.toBe(canonicalAgents["lead.md"]);
  });

  it("rejects a symlink destination and writes nothing outside", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await mkdir(path.join(root, ".opencode"));
    await symlink(outside, path.join(root, ".opencode", "agents"), process.platform === "win32" ? "junction" : "dir");
    await expect(setupOpenCodeAgents(path.join(root, ".opencode", "agents"))).rejects.toThrow("symbolic link");
    await expect(access(path.join(outside, "lead.md"))).rejects.toThrow();
  });

  it("does not overwrite an existing target-file symlink or unmanaged file", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const destination = path.join(root, ".opencode", "agents");
    await mkdir(destination, { recursive: true });
    const outsideFile = path.join(outside, "lead.md");
    await writeFile(outsideFile, "outside");
    await symlink(outsideFile, path.join(destination, "lead.md"), "file");
    await writeFile(path.join(destination, "local.md"), "local");
    await expect(setupOpenCodeAgents(destination)).rejects.toThrow("already exists");
    await expect(readFile(outsideFile, "utf8")).resolves.toBe("outside");
    await expect(readFile(path.join(destination, "local.md"), "utf8")).resolves.toBe("local");
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "toolkit-agent-setup-"));
  temporaryDirectories.push(directory);
  return directory;
}
