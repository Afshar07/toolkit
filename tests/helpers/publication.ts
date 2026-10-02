import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import * as path from "pathe";
import { updateAgents } from "../../src/agents/sync.js";
import { initializeToolkitRegistry, readLocalAgentRegistry } from "../../src/registry/registry.js";
import { resolveToolkitRegistryPaths } from "../../src/registry/path.js";
import { createGitRegistryFixture, gitCommand } from "./git.js";
import { timeTestOperation } from "./timings.js";

interface IFixture {
  root: string;
  remote: string;
  author: string;
  project: string;
  paths: ReturnType<typeof resolveToolkitRegistryPaths>;
  registry: Awaited<ReturnType<typeof initializeToolkitRegistry>>;
  temporaryParent: string;
  initialHead: string;
  gitEnvironment: NodeJS.ProcessEnv;
}

/** Each test file owns its fixture lifecycle, including cleanup of failed setup. */
export function createPublicationFixtures() {
  const temporaryDirectories: string[] = [];
  return {
    fixture: (inheritedAutoCrlf = false, legacyRegistry = false, forceAutoCrlf = false): Promise<IFixture> =>
      timeTestOperation("publication setup", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "toolkit-publish-test-"));
        temporaryDirectories.push(root);
        const globalConfig = path.join(root, "gitconfig");
        await writeFile(globalConfig, `[core]\n\tautocrlf = ${inheritedAutoCrlf}\n`);
        const gitEnvironment = {
          GIT_CONFIG_GLOBAL: globalConfig,
          GIT_CONFIG_NOSYSTEM: "1",
          ...(forceAutoCrlf ? { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.autocrlf", GIT_CONFIG_VALUE_0: "true" } : {}),
        };
        const source = await createGitRegistryFixture(root, { lead: "lead v1\n", coder: "coder v1\n" });
        const paths = resolveToolkitRegistryPaths(path.join(root, "home"));
        if (legacyRegistry) await createLegacyRegistry(paths.root, source.remote, gitEnvironment);
        const registry = legacyRegistry
          ? await readLocalAgentRegistry(paths)
          : await initializeToolkitRegistry(paths, { remote: source.remote, gitEnvironment });
        const project = path.join(root, "project");
        const temporaryParent = path.join(root, "temporary");
        await Promise.all([mkdir(project), mkdir(temporaryParent)]);
        await updateAgents(project, {}, registry);
        return { root, ...source, project, paths, registry, temporaryParent, initialHead: await remoteHead(source.remote), gitEnvironment };
      }),
    cleanup: () => timeTestOperation("publication cleanup", async () => {
      await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })));
    }),
  };
}

export function publishOptions(setup: IFixture) {
  return {
    destination: setup.project,
    remote: setup.remote,
    registryPaths: setup.paths,
    temporaryParent: setup.temporaryParent,
    now: new Date("2026-10-01T12:00:00Z"),
    confirm: async () => true,
    gitIdentity: { name: "Toolkit Tests", email: "toolkit-tests@example.test" },
    gitEnvironment: setup.gitEnvironment,
  };
}

async function createLegacyRegistry(root: string, remote: string, gitEnvironment: NodeJS.ProcessEnv): Promise<void> {
  await mkdir(path.dirname(root), { recursive: true });
  await gitCommand("clone", ["clone", "--config", "core.autocrlf=true", "--filter=blob:none", "--no-checkout", "--", remote, root], { env: gitEnvironment });
  await gitCommand("sparse-checkout", ["-C", root, "sparse-checkout", "init", "--no-cone"], { env: gitEnvironment });
  await gitCommand("sparse-checkout", ["-C", root, "sparse-checkout", "set", "/agents/"], { env: gitEnvironment });
  await gitCommand("checkout", ["-C", root, "checkout"], { env: gitEnvironment });
}

export function agentPath(project: string, name: string): string { return path.join(project, ".opencode/agents", `${name}.md`); }
export async function remoteHead(remote: string): Promise<string> { return (await gitCommand("rev-parse", ["--git-dir", remote, "rev-parse", "main"])).stdout.trim(); }
