import { readdir } from "node:fs/promises";
import * as path from "pathe";
import { inspectAgents } from "../../agents/sync.js";
import { agentDirectory, resolveGlobalAgentTarget } from "../../agents/target.js";
import { resolveOfflineAgentRegistry } from "../../registry/registry.js";
import { getModelProfile, inspectEffectiveOpenCodeModels, inspectOpenCodeConfig, parseModelId, planModelProfileApplication, prepareAgentModelMigration, readLocalModelState, resolveModelProfileLocation } from "../../models/index.js";
import { readAppliedModelOwnership } from "../../models/opencode/ownership.js";
import { readConfigAgentModel } from "../../models/opencode/jsonc-editor.js";
import { readSafeText } from "../../models/opencode/safe-write.js";
import { inspectMarkdownModel } from "../../models/opencode/markdown-model.js";
import type { IAgentTarget } from "../../agents/target.js";
import { displayModel } from "./workflow.js";

export async function inspectStatus(target: IAgentTarget) {
  const location = resolveModelProfileLocation(target);
  const state = await readLocalModelState(location);
  const profile = state.activeProfile ? await getModelProfile(location, state.activeProfile) : undefined;
  const registry = (await resolveOfflineAgentRegistry()).registry;
  const agentState = await inspectAgents(target, registry);
  const ownership = await readAppliedModelOwnership(target);
  const config = await inspectOpenCodeConfig(target);
  const names = [...new Set([...Object.keys(registry.agents).map((n) => n.replace(/\.md$/, "")), ...Object.keys(profile?.agents ?? {}), ...Object.keys(ownership.value.agents), ...agentState.local])].sort();
  const effective = await inspectEffectiveOpenCodeModels({ agents: names, global: target.scope === "global" ? target : resolveGlobalAgentTarget(), project: target.scope === "project" ? target.root : process.cwd() });
  const saved = state.activeProfile ? state.resolutions[state.activeProfile] ?? {} : {};
  const models = Object.values(saved).flatMap((id) => { const parsed = parseModelId(id); return parsed ? [parsed] : []; });
  const options = { target, profile: state.activeProfile, models };
  const plan = await planModelProfileApplication(options);
  const migration = await prepareAgentModelMigration(options);
  const legacyAgents: string[] = [];
  for (const agent of names) {
    const text = await readSafeText(target, path.join(agentDirectory(target), `${agent}.md`));
    if (text !== undefined && inspectMarkdownModel(text).model !== undefined) legacyAgents.push(agent);
  }
  const directories = [agentDirectory(target), target.root, location.directory];
  const backups: string[] = [];
  for (const directory of directories) {
    const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
    backups.push(...files.filter((f) => /\.\d+\.[a-f0-9]{16}\.bak$/.test(f)).map((f) => path.join(directory, f)));
  }
  return {
    scope: target.scope, root: target.root, activeProfile: state.activeProfile ?? null,
    config: config.status === "ready" ? config.file.path : null,
    agents: names.map((agent) => {
      const configured = config.status === "ready" ? readConfigAgentModel(config.file.value, agent) : undefined;
      const record = ownership.value.agents[agent];
      const owned = record && config.status === "ready" && record.config === path.relative(target.root, config.file.path);
      const known = effective.agents.find((a) => a.agent === agent)!;
      return { agent, preference: profile?.agents[agent] ?? null, localResolution: saved[agent] ?? null,
        configured: displayModel(configured), effective: { ...known, configuredGlobal: displayModel(known.configuredGlobal), configuredProject: displayModel(known.configuredProject), effective: displayModel(known.effective) },
        ownership: owned ? configured === record.model ? "managed-current" : "edited" : configured === undefined ? "absent" : "unmanaged",
        agentState: agentState.managed.find((a) => a.name === agent)?.state ?? "local", planState: plan.assignments.find((a) => a.agent === agent)?.status ?? "unresolved" };
    }),
    conflicts: [...effective.conflicts, ...plan.conflicts],
    migration: { status: migration.status, legacyAgents, pendingFiles: migration.files.filter((f) => f.path.endsWith(".md") || f.path.endsWith("agents.json")).map((f) => f.path), recoveryPossible: plan.status === "blocked" && migration.status === "ready" },
    backups: backups.sort(), limitations: [...effective.limitations, "Offline inspection: discovery, missing/ambiguous runtime inventory and inference availability are not verified. Saved exact selections are not evidence of current reachability."],
  };
}
