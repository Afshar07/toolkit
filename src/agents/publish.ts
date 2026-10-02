import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import * as path from "pathe";
import { execa } from "execa";
import { readAgentManifest } from "./manifest.js";
import { normalizeCanonicalAgentContent, readCanonicalAgentRegistry } from "./registry.js";
import { hashAgentContent, recordPublishedAgent } from "./sync.js";
import { agentDirectory, assertSafeTargetDirectory, resolveAgentTarget, resolveGlobalAgentTarget, type IAgentTarget } from "./target.js";
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
  global?: boolean;
  target?: IAgentTarget;
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
  gitEnvironment?: NodeJS.ProcessEnv;
}

export interface IPublishGitIdentity {
  name: string;
  email: string;
}

export interface IPublishAllAgentsPreview extends Omit<IPublishAgentPreview, "agentPath"> {
  agents: { name: string; agentPath: string; differs: boolean }[];
}

export interface IPublishAllAgentsResult extends Omit<IPublishAgentResult, "preview"> {
  preview: IPublishAllAgentsPreview;
}

export interface IPublishAllAgentsOptions extends Omit<IPublishAgentOptions, "confirm" | "onPreview"> {
  confirm?: (preview: IPublishAllAgentsPreview) => Promise<boolean>;
  onPreview?: (preview: IPublishAllAgentsPreview) => void;
}

export class AgentPublishError extends Error {
  constructor(message: string, public readonly published = false) { super(message); }
}

/** Publish exactly one existing canonical project agent through an isolated ordinary checkout. */
export async function publishAgent(name: string, options: IPublishAgentOptions = {}): Promise<IPublishAgentResult> {
  assertAgentName(name);
  const singlePreview = (preview: IPublishAllAgentsPreview): IPublishAgentPreview => {
    const { agents, ...shared } = preview;
    return { ...shared, agentPath: agents[0].agentPath };
  };
  const result = await publishSelectedAgents(name, {
    ...options,
    onPreview: (preview) => options.onPreview?.(singlePreview(preview)),
    confirm: options.confirm ? (preview) => options.confirm!(singlePreview(preview)) : undefined,
  });
  return { ...result, preview: singlePreview(result.preview) };
}

/** Publish all upstream manifest members together, with one preflight, confirmation, and push. */
export async function publishAllAgents(options: IPublishAllAgentsOptions = {}): Promise<IPublishAllAgentsResult> {
  return publishSelectedAgents(undefined, options);
}

async function publishSelectedAgents(name: string | undefined, options: IPublishAllAgentsOptions): Promise<IPublishAllAgentsResult> {
  if (options.global && options.destination !== undefined) throw new AgentPublishError("--global and --destination are mutually exclusive.");
  if (options.target && (options.global || options.destination !== undefined)) throw new AgentPublishError("target cannot be combined with global or destination.");
  const projectRoot = options.target ?? (options.global ? resolveGlobalAgentTarget() : resolveAgentTarget(options.destination ?? process.cwd()));
  const scope = projectRoot.scope === "global" ? "global" : "project";
  const recovery = `toolkit agents update${scope === "global" ? " --global" : ""}`;
  const selectedPath = name === undefined ? undefined : await safeProjectAgentPath(projectRoot, name);
  const selectedContent = selectedPath === undefined ? undefined : await readFile(selectedPath, "utf8");
  const ownership = await readAgentManifest(projectRoot);
  const paths = options.registryPaths ?? resolveToolkitRegistryPaths();
  const remote = options.remote ?? await configuredRemote(paths);
  assertSafeRemote(remote);
  const displayRemote = safeRemoteForDisplay(remote);
  const temporaryRoot = await mkdtemp(path.join(options.temporaryParent ?? os.tmpdir(), "toolkit-publish-"));

  try {
    await runGit(["clone", "--config", "core.autocrlf=false", "--config", "core.eol=lf", "--no-tags", "--", remote, temporaryRoot], "Could not create the temporary Toolkit authoring checkout", options.gitEnvironment);
    const branch = (await runGit(["-C", temporaryRoot, "branch", "--show-current"], "Could not determine the Toolkit default branch", options.gitEnvironment)).trim();
    if (!branch) throw new AgentPublishError("The Toolkit remote default branch could not be determined.");
    const agentsPath = path.join(temporaryRoot, "agents");
    const upstream = await readCanonicalAgentRegistry(agentsPath, "local");
    if (name !== undefined && !Object.hasOwn(upstream.agents, `${name}.md`)) throw new AgentPublishError(`Unknown canonical agent: ${name}. Membership comes from agents/manifest.json.`);
    const selected = [];
    for (const fileName of name === undefined ? Object.keys(upstream.agents) : [`${name}.md`]) {
      const agentName = fileName.slice(0, -3);
      const agentPath = selectedPath ?? await safeProjectAgentPath(projectRoot, agentName);
      const originalLocalContent = selectedContent ?? await readFile(agentPath, "utf8");
      const canonicalLocalContent = normalizeCanonicalAgentContent(originalLocalContent);
      const upstreamContent = upstream.agents[fileName];
      const record = ownership.installed[agentName];
      const overridden = ownership.overrides.includes(agentName);
      if (overridden && !options.includeOverride) {
        throw new AgentPublishError(`${agentName} is a ${scope} override. Re-run with --include-override to publish it and return it to Toolkit management.`);
      }
      if (!overridden && !record && !options.allowUnmanaged) {
        throw new AgentPublishError(`${agentName} is unmanaged in this ${scope} target, so no trustworthy installed baseline exists. Re-run with --allow-unmanaged to acknowledge this.`);
      }
      if (record && !installedHashMatchesCanonical(record.hash, upstreamContent) && canonicalLocalContent !== upstreamContent) {
        throw new AgentPublishError(`Publication conflict for ${agentName}: the shared definition changed since this ${scope} target installed it. Run \`${recovery}\`, reconcile the changes, then publish again.`);
      }
      selected.push({ name: agentName, fileName, agentPath, originalLocalContent, canonicalLocalContent, overridden, differs: canonicalLocalContent !== upstreamContent });
    }
    const agents = selected.map(({ name, agentPath, differs }) => ({ name, agentPath, differs }));
    const changed = selected.filter((agent) => agent.differs);

    if (!changed.length) {
      const preview = { agents, repository: displayRemote, branch, differs: false, diff: "", currentVersion: upstream.version };
      options.onPreview?.(preview);
      return { outcome: "unchanged", preview, localSynchronizationComplete: true };
    }

    const proposedVersion = incrementCanonicalVersion(upstream.version, options.now ?? new Date());
    for (const agent of changed) await writeFile(path.join(agentsPath, agent.fileName), agent.canonicalLocalContent, "utf8");
    const manifestPath = path.join(agentsPath, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.version = proposedVersion;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await readCanonicalAgentRegistry(agentsPath, "local");
    const changedPaths = [...changed.map((agent) => `agents/${agent.fileName}`), "agents/manifest.json"];
    const diff = await runGit(["-C", temporaryRoot, "diff", "--", ...changedPaths], "Could not generate the publication diff", options.gitEnvironment);
    const preview = { agents, repository: displayRemote, branch, differs: true, diff, currentVersion: upstream.version, proposedVersion };
    options.onPreview?.(preview);
    if (options.dryRun) return { outcome: "dry-run", preview, localSynchronizationComplete: true };
    if (!options.confirm || !await options.confirm(preview)) throw new AgentPublishError("Publication cancelled; no remote or local state was changed.");

    await runGit(["-C", temporaryRoot, "add", "--", ...changedPaths], "Could not stage the agent publication", options.gitEnvironment);
    if (options.gitIdentity) {
      await runGit(["-C", temporaryRoot, "config", "user.name", options.gitIdentity.name], "Could not configure temporary Git author name", options.gitEnvironment);
      await runGit(["-C", temporaryRoot, "config", "user.email", options.gitIdentity.email], "Could not configure temporary Git author email", options.gitEnvironment);
    }
    await runGit(["-C", temporaryRoot, "commit", "-m", name === undefined ? `publish agents (${proposedVersion})` : `publish ${name} agent (${proposedVersion})`], "Could not commit the agent publication. Configure Git user.name and user.email, then retry", options.gitEnvironment);
    const commit = (await runGit(["-C", temporaryRoot, "rev-parse", "HEAD"], "Could not identify the publication commit", options.gitEnvironment)).trim();
    await options.beforePush?.();
    try {
      await runGit(["-C", temporaryRoot, "push", "origin", `HEAD:${branch}`], "Direct push failed. Upstream may have advanced (rerun for a fresh comparison), the branch may be protected, or you may lack write access; never force-push", options.gitEnvironment);
    } catch (error) {
      const accepted = await remoteContainsCommit(temporaryRoot, branch, commit, options.gitEnvironment);
      if (!accepted) throw error;
    }

    try {
      await options.beforeReconcile?.();
      const refreshed = await prepareAgentRegistryForUpdate(paths, { remote, gitEnvironment: options.gitEnvironment });
      if (refreshed.registry.version !== proposedVersion || changed.some((agent) => refreshed.registry.agents[agent.fileName] !== agent.canonicalLocalContent)) {
        throw new Error("the machine registry did not refresh to the published commit");
      }
      for (const agent of changed) {
        const currentPath = await safeProjectAgentPath(projectRoot, agent.name);
        if (hashAgentContent(await readFile(currentPath, "utf8")) !== hashAgentContent(agent.originalLocalContent)) {
          throw new Error(`Agent path changed during update: ${currentPath}`);
        }
      }
      for (const agent of changed) await recordPublishedAgent(projectRoot, agent.name, agent.canonicalLocalContent, proposedVersion, {
        removeOverride: agent.overridden && options.includeOverride === true,
        originalContent: agent.originalLocalContent,
      });
      return { outcome: "published", preview, commit, localSynchronizationComplete: true };
    } catch (error) {
      throw new AgentPublishError(`published successfully; local synchronization incomplete: ${error instanceof Error ? error.message : "reconciliation failed"}. Run \`${recovery}\` to recover.`, true);
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

async function safeProjectAgentPath(projectRoot: IAgentTarget, name: string): Promise<string> {
  const directory = agentDirectory(projectRoot);
  await assertSafeTargetDirectory(projectRoot, directory);
  const target = path.join(directory, `${name}.md`);
  const stat = await lstat(target).catch(() => undefined);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new AgentPublishError(`Selected agent must be an existing regular file: ${target}`);
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

async function remoteContainsCommit(checkout: string, branch: string, commit: string, environment?: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await runGit(["-C", checkout, "fetch", "--no-tags", "origin", `refs/heads/${branch}`], "Could not verify the remote publication outcome", environment);
    await execa("git", ["-C", checkout, "merge-base", "--is-ancestor", commit, "FETCH_HEAD"], { env: environment });
    return true;
  } catch { return false; }
}

async function runGit(args: string[], context: string, environment?: NodeJS.ProcessEnv): Promise<string> {
  try { return (await execa("git", args, { env: environment })).stdout; }
  catch (error) {
    const detail = error instanceof Error ? error.message.replace(/https?:\/\/[^\s@]+@/g, "https://[credentials-redacted]@") : "Git failed";
    throw new AgentPublishError(`${context}. ${detail}`);
  }
}

function installedHashMatchesCanonical(installedHash: string, canonicalContent: string): boolean {
  return installedHash === hashAgentContent(canonicalContent)
    || installedHash === hashAgentContent(canonicalContent.replace(/\n/g, "\r\n"));
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
