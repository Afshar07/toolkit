import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import * as nodePath from "node:path";
import * as path from "pathe";
import { execa } from "execa";
import { readAgentManifest } from "./manifest.js";
import { readCanonicalAgentRegistry } from "./registry.js";
import { hashAgentContent, openCodeAgentDirectory, recordPublishedAgent } from "./sync.js";
import { defaultToolkitRegistryRemote } from "../registry/git.js";
import { localRegistryExists, prepareAgentRegistryForUpdate } from "../registry/registry.js";
import { resolveToolkitRegistryPaths, type IToolkitRegistryPaths } from "../registry/path.js";

export interface IPublishAgentPreview {
  agentPath: string;
  repository: string;
  branch: string;
  differs: boolean;
  diff: string;
  currentVersion: string;
  proposedVersion?: string;
}

export interface IPublishAgentResult {
  outcome: "published" | "unchanged" | "dry-run";
  preview: IPublishAgentPreview;
  commit?: string;
  localSynchronizationComplete: boolean;
  recoveryCommand?: string;
}

export interface IPublishAgentOptions {
  destination?: string;
  dryRun?: boolean;
  includeOverride?: boolean;
  allowUnmanaged?: boolean;
  remote?: string;
  registryPaths?: IToolkitRegistryPaths;
  temporaryParent?: string;
  now?: Date;
  confirm?: (preview: IPublishAgentPreview) => Promise<boolean>;
  onPreview?: (preview: IPublishAgentPreview) => void;
  beforePush?: () => Promise<void>;
  beforeReconcile?: () => Promise<void>;
  gitIdentity?: IPublishGitIdentity;
}

export interface IPublishGitIdentity {
  name: string;
  email: string;
}

export class AgentPublishError extends Error {
  constructor(message: string, public readonly published = false) { super(message); }
}

/** Publish exactly one existing canonical project agent through an isolated ordinary checkout. */
export async function publishAgent(name: string, options: IPublishAgentOptions = {}): Promise<IPublishAgentResult> {
  assertAgentName(name);
  const projectRoot = path.resolve(options.destination ?? process.cwd());
  const agentPath = await safeProjectAgentPath(projectRoot, name);
  const localContent = await readFile(agentPath, "utf8");
  const ownership = await readAgentManifest(projectRoot);
  const paths = options.registryPaths ?? resolveToolkitRegistryPaths();
  const remote = options.remote ?? await configuredRemote(paths);
  assertSafeRemote(remote);
  const displayRemote = safeRemoteForDisplay(remote);
  const temporaryRoot = await mkdtemp(path.join(options.temporaryParent ?? os.tmpdir(), "toolkit-publish-"));

  try {
    await runGit(["clone", "--no-tags", remote, temporaryRoot], "Could not create the temporary Toolkit authoring checkout");
    const branch = (await runGit(["-C", temporaryRoot, "branch", "--show-current"], "Could not determine the Toolkit default branch")).trim();
    if (!branch) throw new AgentPublishError("The Toolkit remote default branch could not be determined.");
    const agentsPath = path.join(temporaryRoot, "agents");
    const upstream = await readCanonicalAgentRegistry(agentsPath, "local");
    const fileName = `${name}.md`;
    if (!Object.hasOwn(upstream.agents, fileName)) throw new AgentPublishError(`Unknown canonical agent: ${name}. Membership comes from agents/manifest.json.`);
    const upstreamContent = upstream.agents[fileName];
    const record = ownership.installed[name];
    const overridden = ownership.overrides.includes(name);
    if (overridden && !options.includeOverride) {
      throw new AgentPublishError(`${name} is a project override. Re-run with --include-override to publish it and return it to Toolkit management.`);
    }
    if (!overridden && !record && !options.allowUnmanaged) {
      throw new AgentPublishError(`${name} is unmanaged in this project, so no trustworthy installed baseline exists. Re-run with --allow-unmanaged to acknowledge this.`);
    }
    if (record && hashAgentContent(upstreamContent) !== record.hash && localContent !== upstreamContent) {
      throw new AgentPublishError(`Publication conflict for ${name}: the shared definition changed since this project installed it. Run \`toolkit agents update\`, reconcile the changes, then publish again.`);
    }

    if (localContent === upstreamContent) {
      const preview = { agentPath, repository: displayRemote, branch, differs: false, diff: "", currentVersion: upstream.version };
      options.onPreview?.(preview);
      return { outcome: "unchanged", preview, localSynchronizationComplete: true };
    }

    const proposedVersion = incrementCanonicalVersion(upstream.version, options.now ?? new Date());
    await writeFile(path.join(agentsPath, fileName), localContent, "utf8");
    const manifestPath = path.join(agentsPath, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.version = proposedVersion;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await readCanonicalAgentRegistry(agentsPath, "local");
    const diff = await runGit(["-C", temporaryRoot, "diff", "--", `agents/${fileName}`, "agents/manifest.json"], "Could not generate the publication diff");
    const preview = { agentPath, repository: displayRemote, branch, differs: true, diff, currentVersion: upstream.version, proposedVersion };
    options.onPreview?.(preview);
    if (options.dryRun) return { outcome: "dry-run", preview, localSynchronizationComplete: true };
    if (!options.confirm || !await options.confirm(preview)) throw new AgentPublishError("Publication cancelled; no remote or local state was changed.");

    await runGit(["-C", temporaryRoot, "add", "--", `agents/${fileName}`, "agents/manifest.json"], "Could not stage the agent publication");
    if (options.gitIdentity) {
      await runGit(["-C", temporaryRoot, "config", "user.name", options.gitIdentity.name], "Could not configure temporary Git author name");
      await runGit(["-C", temporaryRoot, "config", "user.email", options.gitIdentity.email], "Could not configure temporary Git author email");
    }
    await runGit(["-C", temporaryRoot, "commit", "-m", `publish ${name} agent (${proposedVersion})`], "Could not commit the agent publication. Configure Git user.name and user.email, then retry");
    const commit = (await runGit(["-C", temporaryRoot, "rev-parse", "HEAD"], "Could not identify the publication commit")).trim();
    await options.beforePush?.();
    try {
      await runGit(["-C", temporaryRoot, "push", "origin", `HEAD:${branch}`], "Direct push failed. Upstream may have advanced (rerun for a fresh comparison), the branch may be protected, or you may lack write access; never force-push");
    } catch (error) {
      const accepted = await remoteContainsCommit(temporaryRoot, branch, commit);
      if (!accepted) throw error;
    }

    try {
      await options.beforeReconcile?.();
      const refreshed = await prepareAgentRegistryForUpdate(paths, { remote });
      if (refreshed.registry.version !== proposedVersion || refreshed.registry.agents[fileName] !== localContent) {
        throw new Error("the machine registry did not refresh to the published commit");
      }
      await recordPublishedAgent(projectRoot, name, localContent, proposedVersion, { removeOverride: overridden && options.includeOverride === true });
      return { outcome: "published", preview, commit, localSynchronizationComplete: true };
    } catch (error) {
      throw new AgentPublishError(`published successfully; local synchronization incomplete: ${error instanceof Error ? error.message : "reconciliation failed"}. Run \`toolkit agents update\` to recover.`, true);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export function incrementCanonicalVersion(current: string, now: Date): string {
  const prefix = `${now.getUTCFullYear()}.${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const match = new RegExp(`^${prefix.replace(".", "\\.")}\\.(\\d+)$`).exec(current);
  return `${prefix}.${match ? Number(match[1]) + 1 : 1}`;
}

async function safeProjectAgentPath(projectRoot: string, name: string): Promise<string> {
  const rootStat = await lstat(projectRoot).catch(() => undefined);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) throw new AgentPublishError(`Publication requires an existing project directory: ${projectRoot}`);
  const rootReal = await realpath(projectRoot);
  const directory = path.join(projectRoot, openCodeAgentDirectory);
  let cursor = directory;
  while (cursor !== projectRoot) {
    try {
      const stat = await lstat(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !isWithin(rootReal, await realpath(cursor))) throw new AgentPublishError(`Agent directory is unsafe: ${cursor}`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      cursor = nodePath.dirname(cursor);
    }
  }
  const target = path.join(directory, `${name}.md`);
  const stat = await lstat(target).catch(() => undefined);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new AgentPublishError(`Project agent must be an existing regular file: ${target}`);
  return target;
}

async function configuredRemote(paths: IToolkitRegistryPaths): Promise<string> {
  if (!await localRegistryExists(paths)) return defaultToolkitRegistryRemote;
  try {
    return (await runGit(["-C", paths.root, "remote", "get-url", "origin"], "Could not read the configured Toolkit repository source")).trim();
  } catch {
    return defaultToolkitRegistryRemote;
  }
}

async function remoteContainsCommit(checkout: string, branch: string, commit: string): Promise<boolean> {
  try {
    await runGit(["-C", checkout, "fetch", "--no-tags", "origin", `refs/heads/${branch}`], "Could not verify the remote publication outcome");
    await execa("git", ["-C", checkout, "merge-base", "--is-ancestor", commit, "FETCH_HEAD"]);
    return true;
  } catch { return false; }
}

async function runGit(args: string[], context: string): Promise<string> {
  try { return (await execa("git", args)).stdout; }
  catch (error) {
    const detail = error instanceof Error ? error.message.replace(/https?:\/\/[^\s@]+@/g, "https://[credentials-redacted]@") : "Git failed";
    throw new AgentPublishError(`${context}. ${detail}`);
  }
}

function safeRemoteForDisplay(remote: string): string {
  return remote.replace(/(https?:\/\/)[^\s/@]+@/g, "$1[credentials-redacted]@");
}

function assertSafeRemote(remote: string): void {
  if (!/^https?:\/\//i.test(remote)) return;
  let parsed: URL;
  try { parsed = new URL(remote); }
  catch { throw new AgentPublishError("The configured Toolkit repository URL is invalid."); }
  const credentialQuery = [...parsed.searchParams.keys()].some((key) => /token|password|passwd|secret|credential|auth/i.test(key));
  if (parsed.username || parsed.password || credentialQuery) {
    throw new AgentPublishError("The configured Toolkit repository URL contains credentials. Configure Git credentials separately before publishing.");
  }
}

function assertAgentName(name: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new AgentPublishError(`Invalid agent name: ${name}`);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = nodePath.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${nodePath.sep}`) && !nodePath.isAbsolute(relative));
}
