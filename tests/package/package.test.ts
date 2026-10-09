import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import * as path from "pathe";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("published npm package", () => {
  it("packs required assets, installs cleanly, exports its API, and runs with bundled fallback", async () => {
    const root = await temporaryDirectory();
    const output = path.join(root, "package");
    const consumer = path.join(root, "consumer");
    await mkdir(output);
    const packed = await execa("npm", ["pack", "--json", "--pack-destination", output], { cwd: repositoryRoot });
    const metadata = JSON.parse(packed.stdout) as Array<{ files: Array<{ path: string }> }>;
    const archive = path.join(output, (await readdir(output)).find((name) => name.endsWith(".tgz"))!);
    const listing = metadata[0]!.files.map((file) => `package/${file.path}`);
    for (const required of ["package/package.json", "package/dist/cli.js", "package/dist/index.js", "package/dist/registry/registry.js", "package/agents/manifest.json", "package/agents/lead.md", "package/docs/model-integration.md", "package/dist/commands/models.js", "package/dist/models/source.js", "package/dist/models/profiles/store.js", "package/dist/models/opencode/apply.js"]) {
      expect(listing).toContain(required);
    }

    await mkdir(consumer);
    await writeFile(path.join(consumer, "package.json"), JSON.stringify({ name: "toolkit-consumer", private: true, type: "module" }));
    // Seed only dependency artifacts from the verified checkout; npm still installs
    // Toolkit itself from the tarball and can perform the test without a registry.
    await cp(path.join(repositoryRoot, "node_modules"), path.join(consumer, "node_modules"), { recursive: true });
    await execa("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--no-save", archive], { cwd: consumer });

    const installedCli = path.join(consumer, "node_modules/@afshar7/toolkit/dist/cli.js");
    const help = await execa(process.execPath, [installedCli, "--help"], { cwd: consumer, env: { NODE_ENV: "production" } });
    expect(help.exitCode).toBe(0);
    const api = await execa(process.execPath, ["--input-type=module", "--eval", "import { hashAgentContent } from '@afshar7/toolkit'; console.log(hashAgentContent('ok').length)"], { cwd: consumer });
    expect(api.stdout).toBe("64");
    const modelsApi = await execa(process.execPath, ["--input-type=module", "--eval", "import { discoverModels, resolveModel, createModelProfile, planModelProfileApplication, migrateAgentModels } from '@afshar7/toolkit'; console.log([discoverModels, resolveModel, createModelProfile, planModelProfileApplication, migrateAgentModels].every(fn => typeof fn === 'function'))"], { cwd: consumer });
    expect(modelsApi.stdout).toBe("true");

    const home = path.join(root, "isolated-home");
    const project = path.join(root, "isolated-project");
    const emptyPath = path.join(root, "no-programs");
    await mkdir(project);
    const update = await execa(process.execPath, [installedCli, "agents", "update", project, "--non-interactive"], {
      cwd: consumer,
      env: { NODE_ENV: "production", HOME: home, USERPROFILE: home, PATH: emptyPath },
    });
    expect(update.stdout + update.stderr).toContain("Using bundled Toolkit agent definitions");
    await expect(readFile(path.join(project, ".opencode/agents/lead.md"), "utf8")).resolves.toContain("description:");
    await expect(access(path.join(home, ".toolkit/registry"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 120_000);
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "toolkit-package-"));
  temporaryDirectories.push(directory);
  return directory;
}
