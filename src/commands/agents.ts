import { readFile } from "node:fs/promises";
import * as path from "pathe";
import { defineCommand } from "citty";
import * as prompts from "@clack/prompts";
import type { ICanonicalAgentRegistry } from "../agents/registry.js";
import { publishAgent, publishAllAgents, type IPublishAgentPreview, type IPublishAllAgentsPreview } from "../agents/publish.js";
import { inspectAgents, manageAgent, overrideAgent, updateAgents } from "../agents/sync.js";
import { agentDirectory, resolveAgentTarget, resolveGlobalAgentTarget, type IAgentTarget } from "../agents/target.js";
import { prepareAgentRegistryForUpdate, resolveOfflineAgentRegistry } from "../registry/registry.js";

export const agentsCommand = defineCommand({
  meta: { name: "agents", description: "Manage reusable Toolkit agents in a project" },
  subCommands: {
    status: defineCommand({
      meta: { name: "status", description: "Show local agent state without refreshing the registry" },
      args: { destination: destinationArg(), global: globalArg() },
      async run({ args, rawArgs }) {
        const destination = resolveDestination(args.destination, args.global === true, rawArgs);
        const prepared = await resolveOfflineAgentRegistry();
        showRegistrySource(prepared.registry, prepared.warning, args.global === true);
        console.log(`Target: ${agentDirectory(destination)}`);
        showAgentStatus(await inspectAgents(destination, prepared.registry));
      },
    }),
    update: defineCommand({
      meta: { name: "update", description: "Safely install and update Toolkit-managed agents" },
      args: {
        destination: destinationArg(),
        global: globalArg(),
        "non-interactive": { type: "boolean", description: "Preserve conflicts without prompting" },
      },
      async run({ args, rawArgs }) {
        const destination = resolveDestination(args.destination, args.global === true, rawArgs);
        console.log("Updating Toolkit registry...");
        const prepared = await prepareAgentRegistryForUpdate();
        if (prepared.warning) console.warn(`⚠ ${prepared.warning}`);
        if (prepared.action === "bundled") console.warn("Using bundled Toolkit agent definitions.");
        else if (prepared.action === "existing") console.warn(`Using existing local registry${prepared.commit ? ` at commit ${prepared.commit.slice(0, 8)}` : ""}.`);
        else console.log(`✓ Registry ${prepared.action}`);
        console.log(`\nChecking ${destination.scope} agents: ${agentDirectory(destination)}`);
        const status = await inspectAgents(destination, prepared.registry);
        const replaceModified = new Set<string>();
        const interactive = args["non-interactive"] !== true && process.stdin.isTTY && process.stdout.isTTY;
        if (interactive) {
          for (const agent of status.managed.filter((candidate) => candidate.state === "modified")) {
            if (await resolveModifiedAgent(destination, agent.name, agent.fileName, prepared.registry)) replaceModified.add(agent.name);
          }
        }
        const result = await updateAgents(destination, { replaceModified }, prepared.registry);
        printUpdateResult(result);
        if (result.conflicts.length) process.exitCode = 1;
      },
    }),
    override: defineCommand({
      meta: { name: "override", description: "Mark a canonical agent as project-owned" },
      args: { name: agentNameArg(), destination: destinationOption(), global: globalArg() },
      async run({ args, rawArgs }) {
        const destination = resolveDestination(args.destination, args.global === true, rawArgs);
        const name = String(args.name);
        const prepared = await resolveOfflineAgentRegistry();
        await overrideAgent(destination, name, prepared.registry);
        console.log(`Override recorded for ${name}. Toolkit will not update its file.`);
      },
    }),
    manage: defineCommand({
      meta: { name: "manage", description: "Replace an agent and return it to Toolkit ownership" },
      args: { name: agentNameArg(), destination: destinationOption(), global: globalArg(), yes: { type: "boolean", description: "Confirm replacement without prompting" } },
      async run({ args, rawArgs }) {
        const destination = resolveDestination(args.destination, args.global === true, rawArgs);
        const name = String(args.name);
        const prepared = await resolveOfflineAgentRegistry();
        if (args.yes !== true && process.stdin.isTTY && process.stdout.isTTY) {
          const confirmed = await prompts.confirm({ message: `Replace ${name}.md with Toolkit's canonical definition?`, initialValue: false });
          if (prompts.isCancel(confirmed) || !confirmed) { prompts.cancel("No files changed."); return; }
        } else if (args.yes !== true) {
          throw new Error("Returning an agent to Toolkit management replaces its file. Re-run with --yes.");
        }
        await manageAgent(destination, name, { replaceExisting: true }, prepared.registry);
        console.log(`${name} is now Toolkit-managed.`);
      },
    }),
    publish: defineCommand({
      meta: { name: "publish", description: "Publish one agent or all upstream canonical agents together" },
      args: {
        name: { ...agentNameArg(), required: false },
        all: { type: "boolean", description: "Publish all upstream manifest agents in one operation" },
        destination: destinationOption(),
        global: globalArg(),
        "dry-run": { type: "boolean", description: "Fetch and preview without committing, pushing, or changing local state" },
        yes: { type: "boolean", description: "Publish without the final interactive confirmation" },
        "include-override": { type: "boolean", description: "Explicitly publish an override and return it to Toolkit management" },
        "allow-unmanaged": { type: "boolean", description: "Explicitly publish a canonical-name file without an installed baseline" },
      },
      async run({ args, rawArgs }) {
        if ((args.name !== undefined) === (args.all === true)) throw new Error("Select exactly one of NAME or --all.");
        const destination = resolveDestination(args.destination, args.global === true, rawArgs);
        const interactive = process.stdin.isTTY && process.stdout.isTTY;
        const options = {
          target: destination,
          dryRun: args["dry-run"] === true,
          includeOverride: args["include-override"] === true,
          allowUnmanaged: args["allow-unmanaged"] === true,
          confirm: args.yes === true ? async () => true : !interactive ? async () => {
            throw new Error("Publishing requires confirmation. Re-run with --yes in a non-interactive environment.");
          } : async () => {
            const confirmed = await prompts.confirm({ message: args.all === true ? "Publish these agents together to the Toolkit repository?" : "Publish this agent to the Toolkit repository?", initialValue: false });
            return !prompts.isCancel(confirmed) && confirmed === true;
          },
        };
        const result = args.all === true
          ? await publishAllAgents({ ...options, onPreview: printPublishPreview })
          : await publishAgent(String(args.name), { ...options, onPreview: printPublishPreview });
        if (result.outcome === "unchanged") console.log("Nothing to publish; the local definition already matches upstream.");
        else if (result.outcome === "dry-run") console.log("Dry run complete; no persistent state was changed.");
        else console.log(`Published successfully (${result.commit?.slice(0, 8)}); the published ${destination.scope} agent${args.all === true ? "s are" : " is"} Toolkit-managed.`);
      },
    }),
  },
});

function destinationArg() { return { type: "positional" as const, description: "Project directory", required: false }; }
function destinationOption() { return { type: "string" as const, description: "Project directory" }; }
function agentNameArg() { return { type: "positional" as const, description: "Canonical agent name", required: true }; }
function globalArg() { return { type: "boolean" as const, description: "Use global OpenCode agents instead of project agents" }; }
function resolveDestination(value: unknown, global?: boolean, rawArgs: string[] = []): IAgentTarget {
  if (global && (value !== undefined || rawArgs.some((arg) => arg === "--destination" || arg.startsWith("--destination=")))) throw new Error("--global and --destination (including a positional destination) are mutually exclusive.");
  return global ? resolveGlobalAgentTarget() : resolveAgentTarget(typeof value === "string" ? value : process.cwd());
}

function showAgentStatus(status: Awaited<ReturnType<typeof inspectAgents>>): void {
  console.log("Toolkit agents");
  for (const agent of status.managed.filter((candidate) => candidate.state !== "override")) {
    const marker = agent.state === "current" ? "✓" : agent.state === "update-available" || agent.state === "missing" || agent.state === "not-installed" ? "↑" : "⚠";
    console.log(`${marker} ${agent.name.padEnd(22)} ${labelFor(agent.state)}`);
  }
  if (status.local.length) {
    console.log("\nLocal agents");
    for (const name of status.local) console.log(`• ${name}`);
  }
  if (status.overrides.length) {
    console.log("\nOverrides");
    for (const name of status.overrides) console.log(`• ${name}`);
  }
}

function labelFor(state: string): string {
  return ({
    current: "current",
    "update-available": "update available",
    modified: "locally modified",
    missing: "missing (managed)",
    "not-installed": "not installed",
    "unmanaged-collision": "local file; not managed",
  } as Record<string, string>)[state] ?? state;
}

async function resolveModifiedAgent(destination: IAgentTarget, name: string, fileName: string, registry: ICanonicalAgentRegistry): Promise<boolean> {
  while (true) {
    const decision = await prompts.select({
      message: `${fileName} has local modifications.`,
      options: [
        { value: "keep", label: "Keep local version", hint: "safe default" },
        { value: "update", label: "Use Toolkit version" },
        { value: "diff", label: "Show diff" },
      ],
    });
    if (prompts.isCancel(decision) || decision === "keep") return false;
    if (decision === "update") return true;
    const existing = await readFile(path.join(agentDirectory(destination), fileName), "utf8");
    const desired = registry.agents[fileName];
    console.log(`\n--- ${fileName} (local)\n+++ ${fileName} (Toolkit)`);
    for (const line of existing.split(/\r?\n/)) if (line) console.log(`- ${line}`);
    for (const line of desired.split(/\r?\n/)) if (line) console.log(`+ ${line}`);
  }
}

function showRegistrySource(registry: ICanonicalAgentRegistry, warning?: string, global?: boolean): void {
  if (registry.source === "bundled") {
    console.warn(`Registry: bundled fallback${warning ? ` (${warning})` : ""}`);
    console.warn(`Run \`toolkit registry init\` or \`toolkit agents update${global ? " --global" : ""}\` to initialize it.\n`);
  } else {
    console.log(`Registry: ${registry.path}\n`);
  }
}

function printUpdateResult(result: Awaited<ReturnType<typeof updateAgents>>): void {
  for (const name of result.installed) console.log(`+ ${name} installed`);
  for (const name of result.updated) console.log(`↑ ${name} updated`);
  for (const name of result.restored) console.log(`+ ${name} restored`);
  for (const name of result.current) console.log(`✓ ${name} current`);
  for (const name of result.overrides) console.log(`• ${name} override preserved`);
  for (const name of result.conflicts) console.warn(`⚠ ${name} preserved because Toolkit cannot safely overwrite it`);
  if (!result.installed.length && !result.updated.length && !result.restored.length && !result.conflicts.length) console.log("No agent updates were needed.");
}

function printPublishPreview(preview: IPublishAgentPreview | IPublishAllAgentsPreview): void {
  console.log("Agent publication preview");
  if ("agents" in preview) for (const agent of preview.agents) console.log(`Agent: ${agent.agentPath} (${agent.differs ? "changed" : "unchanged"})`);
  else console.log(`Agent: ${preview.agentPath}`);
  console.log(`Target: ${preview.repository} (${preview.branch})`);
  console.log(`Local definition differs: ${preview.differs ? "yes" : "no"}`);
  if (preview.proposedVersion) console.log(`Canonical version: ${preview.currentVersion} → ${preview.proposedVersion}`);
  if (preview.diff) console.log(`\n${preview.diff.trimEnd()}\n`);
}
