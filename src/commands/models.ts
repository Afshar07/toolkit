import { defineCommand } from "citty";
import { resolveAgentTarget, resolveGlobalAgentTarget } from "../agents/target.js";
import { resolveOfflineAgentRegistry } from "../registry/registry.js";
import { discoverModels, getModelProfile, isCompleteModelId, readLocalModelState, resolveModelProfileLocation, setActiveModelProfile, updateModelProfile } from "../models/index.js";
import { configure, preferenceFor } from "./models/configure.js";
import { selectModel } from "./models/selector.js";
import { inspectStatus } from "./models/status.js";
import { executeProfile } from "./models/workflow.js";
import type { IModelCommandOptions } from "./models/types.js";

const scopeArgs = {
  destination: { type: "string" as const, description: "Project directory (defaults to cwd)" },
  global: { type: "boolean" as const, description: "Use global OpenCode scope" },
};
const mutateArgs = {
  ...scopeArgs,
  "dry-run": { type: "boolean" as const, description: "Preview without any writes" },
  "non-interactive": { type: "boolean" as const, description: "Never prompt or approve protected changes" },
};
const jsonArg = { type: "boolean" as const, description: "Machine-readable JSON output" };

function options(args: Record<string, unknown>, raw: string[], allowed: readonly string[], maximumPositionals = 0): IModelCommandOptions {
  let positionals = 0;
  for (let index = 0; index < raw.length; index++) {
    const argument = raw[index]!;
    if (argument.startsWith("-") && !allowed.includes(argument.split("=")[0]!)) throw new Error(`Unsupported option: ${argument}`);
    if (argument.startsWith("--") && !argument.includes("=") && ["--destination", "--provider", "--search"].includes(argument)) {
      if (!raw[index + 1] || raw[index + 1]!.startsWith("--")) throw new Error(`Missing value for ${argument}`);
      index++;
    } else if (!argument.startsWith("-")) positionals++;
  }
  if (positionals > maximumPositionals) throw new Error("Unexpected positional arguments for this models command.");
  if (args.global === true && args.destination !== undefined) throw new Error("--global and --destination are mutually exclusive.");
  return { target: args.global === true ? resolveGlobalAgentTarget() : resolveAgentTarget(typeof args.destination === "string" ? args.destination : process.cwd()),
    interactive: args["non-interactive"] !== true && process.stdin.isTTY === true && process.stdout.isTTY === true, dryRun: args["dry-run"] === true };
}
const readFlags = ["--destination", "--global", "--json"];
const writeFlags = ["--destination", "--global", "--dry-run", "--non-interactive"];

export const modelsCommand = defineCommand({
  meta: { name: "models", description: "Discover, configure and safely switch model profiles" },
  subCommands: {
    list: defineCommand({ meta: { name: "list", description: "Discover model IDs exposed by OpenCode (not inference validation)" },
      args: { ...scopeArgs, json: jsonArg, provider: { type: "string" as const, description: "Exact provider namespace" }, search: { type: "string" as const, description: "Case-insensitive ID substring" } },
      async run({ args, rawArgs }) {
        const cli = options(args, rawArgs, [...readFlags, "--provider", "--search"]);
        const inventory = await discoverModels({ openCode: { cwd: cli.target.scope === "project" ? cli.target.root : process.cwd() }, filter: args.provider ? { providers: [args.provider] } : undefined });
        const models = inventory.models.filter((m) => !args.search || m.id.toLowerCase().includes(args.search.toLowerCase()));
        if (args.json) { console.log(JSON.stringify({ ...inventory, models, isEmpty: models.length === 0 })); return; }
        console.log("Available models (discovered; inference availability not verified)\n");
        let provider: string | undefined;
        for (const model of models) { if (provider !== model.provider) { provider = model.provider; console.log(provider); } console.log(`  ${model.id}`); }
        if (!models.length) console.log("No models matched. Check provider configuration with `opencode models`.");
      },
    }),
    profiles: defineCommand({ meta: { name: "profiles", description: "List saved profiles without discovery or writes" }, args: { ...scopeArgs, json: jsonArg },
      async run({ args, rawArgs }) {
        const cli = options(args, rawArgs, readFlags);
        const location = resolveModelProfileLocation(cli.target);
        const { listModelProfiles } = await import("../models/profiles/store.js");
        const names = await listModelProfiles(location);
        const state = await readLocalModelState(location);
        if (args.json) { console.log(JSON.stringify({ scope: cli.target.scope, root: cli.target.root, activeProfile: state.activeProfile ?? null, profiles: names })); return; }
        console.log(`Model profiles (${cli.target.scope}: ${cli.target.root})`);
        for (const name of names) console.log(`${name === state.activeProfile ? "*" : " "} ${name}${name === state.activeProfile ? "  Active" : ""}`);
        if (!names.length) console.log("No configured profiles. Run `toolkit models configure` in a terminal.");
      },
    }),
    configure: defineCommand({ meta: { name: "configure", description: "Interactive profile creation, editing and application" }, args: mutateArgs,
      async run({ args, rawArgs }) { await configure(options(args, rawArgs, writeFlags)); },
    }),
    use: defineCommand({ meta: { name: "use", description: "Safely apply a saved profile" }, args: { ...mutateArgs, profile: { type: "positional" as const, required: true, description: "Saved profile name" } },
      async run({ args, rawArgs }) {
        const cli = options(args, rawArgs, writeFlags, 1);
        const location = resolveModelProfileLocation(cli.target);
        const definition = await getModelProfile(location, args.profile);
        if (!definition) throw new Error(`Profile ${args.profile} not found in ${cli.target.scope} scope. Run models profiles or configure.`);
        const models = (await discoverModels({ openCode: { cwd: cli.target.root } })).models;
        const result = await executeProfile({ target: cli.target, profile: args.profile, profileDefinition: definition, models, project: cli.target.scope === "global" ? process.cwd() : undefined }, cli);
        if (result && !cli.dryRun) {
          try { await setActiveModelProfile(location, args.profile); }
          catch (error) { throw new Error(`Configuration applied but active-profile persistence failed: ${String(error)}. Inspect changed files/backups above; switching is incomplete.`); }
          console.log(`Active profile: ${args.profile}${result.status === "unchanged" ? " (unchanged configuration)" : ""}`);
        }
      },
    }),
    set: defineCommand({ meta: { name: "set", description: "Assign one agent in the active profile" }, args: { ...mutateArgs,
      agent: { type: "positional" as const, required: true, description: "Canonical agent name" }, model: { type: "positional" as const, required: false, description: "Exact discovered provider/model ID" } },
      async run({ args, rawArgs }) {
        const cli = options(args, rawArgs, writeFlags, 2);
        if (!args.model && !cli.interactive) throw new Error("Provide an exact provider/model ID, or run models set in an interactive terminal (TTY).");
        if (args.model && !isCompleteModelId(args.model)) throw new Error("Model must be a complete provider/model ID.");
        const registry = (await resolveOfflineAgentRegistry()).registry;
        if (!Object.hasOwn(registry.agents, `${args.agent}.md`)) throw new Error(`Unknown canonical agent: ${args.agent}`);
        const location = resolveModelProfileLocation(cli.target);
        const state = await readLocalModelState(location);
        if (!state.activeProfile) throw new Error("No active profile. Run models configure and models use <profile> first.");
        const current = await getModelProfile(location, state.activeProfile);
        if (!current) throw new Error(`Active profile ${state.activeProfile} not found.`);
        const models = (await discoverModels({ openCode: { cwd: cli.target.root } })).models;
        const id = args.model ?? await selectModel(models, { agent: args.agent, current: state.resolutions[state.activeProfile]?.[args.agent] });
        if (!id) { console.log("Cancelled; no files changed."); return; }
        const model = models.find((m) => m.id === id);
        if (!model) throw new Error(`Model ${id} not found in discovered inventory. No files changed.`);
        const draft = { agents: { ...current.agents, [args.agent]: preferenceFor(model) } };
        const result = await executeProfile({ target: cli.target, profile: state.activeProfile, profileDefinition: draft, models, agents: [args.agent], selections: { [args.agent]: id } }, cli);
        if (result && !cli.dryRun) {
          if (result.plan.assignments.some((a) => a.status === "skipped-override")) throw new Error(`${args.agent} is overridden; preference was not changed.`);
          try {
            const saved = await updateModelProfile(location, state.activeProfile, draft);
            if (!["changed", "unchanged"].includes(saved.status)) throw new Error(saved.status);
          } catch (error) { throw new Error(`Assignment applied but preference persistence failed: ${String(error)}. Inspect changed files/backups above; prior portable preferences remain until reconciled.`); }
          console.log(`Saved preference for ${args.agent} in ${state.activeProfile}; other agents unchanged.`);
        }
      },
    }),
    status: defineCommand({ meta: { name: "status", description: "Inspect saved and statically effective model state, offline" }, args: { ...scopeArgs, json: jsonArg },
      async run({ args, rawArgs }) {
        const cli = options(args, rawArgs, readFlags);
        const status = await inspectStatus(cli.target);
        if (args.json) { console.log(JSON.stringify(status)); return; }
        console.log(`Model management\nScope: ${status.scope}\nActive profile: ${status.activeProfile ?? "—"}\nConfig: ${status.config ?? "conflicting files"}`);
        for (const agent of status.agents) console.log(`${agent.agent.padEnd(22)} preference=${JSON.stringify(agent.preference)} local=${agent.localResolution ?? "—"} configured=${JSON.stringify(agent.configured)} effective=${JSON.stringify(agent.effective?.effective) ?? "—"} (${agent.effective?.source}) ownership=${agent.ownership}; agent=${agent.agentState}; ${agent.planState}`);
        for (const conflict of status.conflicts) console.warn(`Warning: ${conflict}`);
        console.log(`Migration: ${JSON.stringify(status.migration)}`);
        for (const backup of status.backups) console.log(`Recovery backup: ${backup}`);
        for (const limitation of status.limitations) console.log(limitation);
      },
    }),
    doctor: defineCommand({ meta: { name: "doctor", description: "Read-only discovery, profile, ownership and recovery diagnostics (no inference)" }, args: { ...scopeArgs, json: jsonArg },
      async run({ args, rawArgs }) {
        const cli = options(args, rawArgs, readFlags);
        let inventory;
        let discoveryError: string | undefined;
        try { inventory = await discoverModels({ openCode: { cwd: cli.target.scope === "project" ? cli.target.root : process.cwd() } }); }
        catch (error) { discoveryError = error instanceof Error ? error.message : "OpenCode discovery failed."; }
        const status = await inspectStatus(cli.target, inventory?.models);
        const diagnostics = { ...status, discovery: inventory ? { status: "available", count: inventory.models.length, inferenceVerified: false } : { status: "unavailable", error: discoveryError, inferenceVerified: false } };
        if (args.json) console.log(JSON.stringify(diagnostics));
        else {
          console.log(`Model diagnostics (${cli.target.scope}: ${cli.target.root})\nActive profile: ${status.activeProfile ?? "—"}\nDiscovery: ${inventory ? `${inventory.models.length} IDs (not inference verification)` : discoveryError}`);
          for (const conflict of status.conflicts) console.warn(`Warning: ${conflict}`);
          console.log(`Migration: ${JSON.stringify(status.migration)}`);
          for (const backup of status.backups) console.log(`Recovery backup: ${backup}`);
          for (const limitation of status.limitations) console.log(limitation);
        }
        if (discoveryError || status.conflicts.length || status.migration.legacyAgents.length || status.migration.recoveryPossible) process.exitCode = 1;
      },
    }),
  },
});
