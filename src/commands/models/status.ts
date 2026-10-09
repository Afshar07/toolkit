import { readdir } from "node:fs/promises";
import * as path from "pathe";
import { inspectAgents } from "../../agents/sync.js";
import { agentDirectory, assertSafeTargetDirectory, resolveGlobalAgentTarget } from "../../agents/target.js";
import { resolveOfflineAgentRegistry } from "../../registry/registry.js";
import { getModelProfile, inspectEffectiveOpenCodeModels, inspectOpenCodeConfig, parseModelId, planModelProfileApplication, prepareAgentModelMigration, readLocalModelState, resolveModelProfileLocation } from "../../models/index.js";
import { readAppliedModelOwnership } from "../../models/opencode/ownership.js";
import { readConfigAgentModel } from "../../models/opencode/jsonc-editor.js";
import { readSafeText } from "../../models/opencode/safe-write.js";
import { inspectMarkdownModel } from "../../models/opencode/markdown-model.js";
import type { IAgentTarget } from "../../agents/target.js";
import type { IModelRef } from "../../models/index.js";
import { displayModel } from "./workflow.js";

export async function inspectStatus(target: IAgentTarget, inventory?: readonly IModelRef[]) {
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
  const options = { target, profile: state.activeProfile, models: inventory ?? models };
  const plan = await planModelProfileApplication(options);
  const migration = await prepareAgentModelMigration(options);
  const legacyAgents: string[] = [];
  for (const agent of names) {
    const text = await readSafeText(target, path.join(agentDirectory(target), `${agent}.md`));
    if (text !== undefined && inspectMarkdownModel(text).model !== undefined) legacyAgents.push(agent);
  }
  const directories = [...new Set([agentDirectory(target), target.root, path.join(target.root, ".opencode"), location.directory])];
  const backups: string[] = [];
  for (const directory of directories) {
    await assertSafeTargetDirectory(target, directory);
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
    conflicts: [...effective.conflicts, ...plan.conflicts,
      ...(state.activeProfile && !profile ? [`Active profile ${state.activeProfile} is missing; restore its portable definition or select an existing profile.`] : []),
      ...Object.entries(ownership.value.agents).flatMap(([agent, record]) => {
        const matching = config.status === "ready" && record.config === path.relative(target.root, config.file.path);
        return !matching ? [`${agent}: stale assignment ownership references ${record.config}; selected configuration differs. No ownership inferred.`]
          : readConfigAgentModel(config.file.value, agent) !== record.model ? [`${agent}: owned assignment is missing or edited; replacement requires per-agent consent.`] : [];
      }),
      ...plan.assignments.filter((assignment) => assignment.status === "apply").map((assignment) => `${assignment.agent}: saved profile proposes ${assignment.model}, but configuration differs; run models use ${state.activeProfile} to review and apply.`),
      ...(inventory ? Object.entries(plan.resolution?.agents ?? {}).flatMap(([agent, outcome]) => outcome.status === "resolved"
        ? outcome.staleSelection ? [`${agent}: saved selection ${outcome.staleSelection.id} is ${outcome.staleSelection.reason}.`] : []
        : [`${agent}: ${outcome.status}${outcome.status === "ambiguous" ? `; select one of ${outcome.candidates.map((m) => m.id).join(", ")}` : "; edit the preference or configure the missing provider/model"}.`]) : []),
    ],
    migration: { status: migration.status, legacyAgents, pendingFiles: migration.files.filter((f) => f.path.endsWith(".md") || f.path.endsWith("agents.json")).map((f) => f.path), recoveryPossible: plan.status === "blocked" && migration.status === "ready" },
    backups: backups.sort(), limitations: [...effective.limitations, inventory ? "Discovery verified IDs only, not authenticated inference availability." : "Offline inspection: discovery, missing/ambiguous runtime inventory and inference availability are not verified. Saved exact selections are not evidence of current reachability. Run models doctor for discovery diagnostics."],
  };
}
