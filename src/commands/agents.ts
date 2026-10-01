import { readFile } from "node:fs/promises";
import * as path from "pathe";
import { defineCommand } from "citty";
import * as prompts from "@clack/prompts";
import { canonicalAgents } from "../agents/registry.js";
import { inspectAgents, manageAgent, openCodeAgentDirectory, overrideAgent, updateAgents } from "../agents/sync.js";

export const agentsCommand = defineCommand({
  meta: { name: "agents", description: "Manage reusable Toolkit agents in a project" },
  subCommands: {
    status: defineCommand({
      meta: { name: "status", description: "Show managed, local, and overridden agents" },
      args: { destination: destinationArg() },
      async run({ args }) { showAgentStatus(await inspectAgents(resolveDestination(args.destination))); },
    }),
    update: defineCommand({
      meta: { name: "update", description: "Safely install and update Toolkit-managed agents" },
      args: {
        destination: destinationArg(),
        "non-interactive": { type: "boolean", description: "Preserve conflicts without prompting" },
      },
      async run({ args }) {
        const destination = resolveDestination(args.destination);
        const status = await inspectAgents(destination);
        const replaceModified = new Set<string>();
        const interactive = args["non-interactive"] !== true && process.stdin.isTTY && process.stdout.isTTY;
        if (interactive) {
          for (const agent of status.managed.filter((candidate) => candidate.state === "modified")) {
            if (await resolveModifiedAgent(destination, agent.name, agent.fileName)) replaceModified.add(agent.name);
          }
        }
        const result = await updateAgents(destination, { replaceModified });
        printUpdateResult(result);
        if (result.conflicts.length) process.exitCode = 1;
      },
    }),
    override: defineCommand({
      meta: { name: "override", description: "Mark a canonical agent as project-owned" },
      args: { name: agentNameArg(), destination: destinationOption() },
      async run({ args }) {
        const name = String(args.name);
        await overrideAgent(resolveDestination(args.destination), name);
        console.log(`Override recorded for ${name}. Toolkit will not update its file.`);
      },
    }),
    manage: defineCommand({
      meta: { name: "manage", description: "Return an agent to Toolkit ownership" },
      args: { name: agentNameArg(), destination: destinationOption(), yes: { type: "boolean", description: "Replace the file without prompting" } },
      async run({ args }) {
        const name = String(args.name);
        if (args.yes !== true && process.stdin.isTTY && process.stdout.isTTY) {
          const confirmed = await prompts.confirm({ message: `Replace ${name}.md with Toolkit's canonical definition?`, initialValue: false });
          if (prompts.isCancel(confirmed) || !confirmed) { prompts.cancel("No files changed."); return; }
        } else if (args.yes !== true) {
          throw new Error("Returning an agent to Toolkit management replaces its file. Re-run with --yes.");
        }
        await manageAgent(resolveDestination(args.destination), name);
        console.log(`${name} is now Toolkit-managed.`);
      },
    }),
  },
});

function destinationArg() { return { type: "positional" as const, description: "Project directory", required: false }; }
function destinationOption() { return { type: "string" as const, description: "Project directory" }; }
function agentNameArg() { return { type: "positional" as const, description: "Canonical agent name", required: true }; }
function resolveDestination(value: unknown): string { return path.resolve(typeof value === "string" ? value : process.cwd()); }

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

async function resolveModifiedAgent(destination: string, name: string, fileName: string): Promise<boolean> {
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
    const existing = await readFile(path.join(destination, openCodeAgentDirectory, fileName), "utf8");
    const desired = canonicalAgents[fileName as keyof typeof canonicalAgents];
    console.log(`\n--- ${fileName} (local)\n+++ ${fileName} (Toolkit)`);
    for (const line of existing.split(/\r?\n/)) if (line) console.log(`- ${line}`);
    for (const line of desired.split(/\r?\n/)) if (line) console.log(`+ ${line}`);
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
