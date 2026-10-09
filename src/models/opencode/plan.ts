import * as path from "pathe";
import { agentDirectory, resolveAgentTarget } from "../../agents/target.js";
import { readAgentManifest, agentManifestRelativePath } from "../../agents/manifest.js";
import { hashAgentContent } from "../../agents/sync.js";
import { discoverModels } from "../discover.js";
import { resolveModelProfileLocation } from "../profiles/location.js";
import { findProfile, getActiveModelProfile } from "../profiles/active.js";
import { readLocalModelState } from "../profiles/state.js";
import { resolveModelProfile, selectionsFromResolution } from "../profiles/resolve-profile.js";
import { serializeLocalModelState } from "../profiles/serialize.js";
import { assertProfileName } from "../profiles/names.js";
import { ModelProfileError } from "../profiles/errors.js";
import { validateModelProfile } from "../profiles/schema.js";
import type { IModelProfile } from "../profiles/types.js";
import { pick, selectedAgents, validatedSelections } from "./plan-scope.js";
import { inspectOpenCodeConfig } from "./config-files.js";
import { readConfigAgentModel, editOpenCodeAgentModels } from "./jsonc-editor.js";
import { inspectMarkdownModel } from "./markdown-model.js";
import { readAppliedModelOwnership, serializeAppliedModelOwnership } from "./ownership.js";
import { readSafeText } from "./safe-write.js";
import { approveModelPlan } from "./approval.js";
import type { IModelProfilePlan, IPlanModelProfileOptions, IModelAssignmentPlan, IPlannedModelFile } from "./types.js";

/** Reads and resolves everything before producing any writable plan. */
export async function planModelProfileApplication(options: IPlanModelProfileOptions): Promise<IModelProfilePlan> {
  return buildModelProfilePlan(options, false);
}

/** Internal migration planner; not exported from the package entry point. */
export async function buildModelProfilePlan(options: IPlanModelProfileOptions, prepareMigration: boolean): Promise<IModelProfilePlan> {
  const target = resolveAgentTarget(options.target);
  const location = resolveModelProfileLocation(target);
  const snapshots: { path: string; text: string | undefined; target?: ReturnType<typeof resolveAgentTarget> }[] = [];
  for (const filePath of [location.profilesPath, location.statePath, path.join(target.root, agentManifestRelativePath)]) {
    snapshots.push({ path: filePath, text: await readSafeText(target, filePath) });
  }
  const base = { target, assignments: [], files: [], conflicts: [], shadowed: [], snapshots };
  if (options.profileDefinition !== undefined && options.profile === undefined) throw new ModelProfileError("invalid-input", "A profile definition requires an explicit profile name.");
  const profile = options.profile ?? await getActiveModelProfile(location);
  if (!profile) return { ...base, status: "no-profile" };
  assertProfileName(profile);
  let definition: IModelProfile;
  if (options.profileDefinition !== undefined) {
    const validated = validateModelProfile(options.profileDefinition);
    if (!validated.ok) throw new ModelProfileError("invalid-input", "Invalid profile definition.", { issues: validated.issues });
    definition = validated.value;
  } else {
    const found = await findProfile(location, profile, options.inheritFrom);
    if (!found) return { ...base, profile, status: "not-found" };
    definition = found.profile;
  }
  if (options.inheritFrom) snapshots.push({ path: options.inheritFrom.profilesPath, text: await readSafeText(options.inheritFrom, options.inheritFrom.profilesPath), target: options.inheritFrom });
  const requested = options.agents === undefined ? undefined : selectedAgents(options.agents, definition);
  const scoped: IModelProfile = requested ? { agents: Object.fromEntries(requested.map((agent) => [agent, definition.agents[agent]!])) } : definition;
  const overrides = validatedSelections(options.selections, scoped);
  const state = await readLocalModelState(location);
  const models = options.models ?? (await discoverModels({ source: options.source })).models;
  const saved = state.resolutions[profile] ?? {};
  const resolution = resolveModelProfile(models, scoped, {
    selections: requested ? { ...pick(saved, requested), ...overrides } : { ...saved, ...overrides },
  });
  const config = await inspectOpenCodeConfig(target);
  if (config.status === "config-conflict") return { ...base, profile, resolution, status: "config-conflict", conflicts: config.files };
  snapshots.push({ path: config.file.path, text: config.file.text });
  const candidates = target.scope === "global" ? ["opencode.json", "opencode.jsonc"] : ["opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc"];
  for (const candidate of candidates) {
    const candidatePath = path.join(target.root, candidate);
    if (candidatePath !== config.file.path) snapshots.push({ path: candidatePath, text: undefined });
  }
  const ownership = await readAppliedModelOwnership(target);
  snapshots.push({ path: ownership.path, text: ownership.text });
  const manifest = await readAgentManifest(target);
  const assignments: IModelAssignmentPlan[] = [];
  const desired: Record<string, string> = {};
  const records = { ...ownership.value.agents };
  const relative = path.relative(target.root, config.file.path);
  for (const [agent, outcome] of Object.entries(resolution.agents)) {
    if (outcome.status !== "resolved") continue;
    const filePath = path.join(agentDirectory(target), `${agent}.md`);
    const text = await readSafeText(target, filePath);
    snapshots.push({ path: filePath, text });
    const previous = readConfigAgentModel(config.file.value, agent);
    const record = ownership.value.agents[agent];
    const model = outcome.model.id;
    const kind = previous === model ? "identical" : record && record.config === relative
      ? previous === record.model ? "managed-current" : "edited" : previous === undefined ? "absent" : "unmanaged";
    let status: IModelAssignmentPlan["status"];
    if (manifest.overrides.includes(agent)) status = "skipped-override";
    else if (text === undefined) status = "missing-agent";
    else if (!manifest.installed[agent]) status = "unmanaged-agent";
    else if (hashAgentContent(text) !== manifest.installed[agent]!.hash) status = "modified-agent";
    else if (!prepareMigration && inspectMarkdownModel(text).model !== undefined) status = "migration-required";
    else if ((kind === "edited" || kind === "unmanaged") && !options.replaceAssignments?.has(agent)) status = "conflict";
    else {
      status = previous === model ? "unchanged" : "apply";
      desired[agent] = model;
      // Identical unmanaged assignments remain unowned: equality isn't consent.
      if (kind !== "identical" || record?.config === relative && record.model === model) records[agent] = { config: relative, model };
    }
    assignments.push({ agent, model, previous, ownership: kind, status });
  }
  const conflicts = assignments.filter((item) => !["apply", "unchanged", "skipped-override"].includes(item.status)).map((item) => `${item.agent}: ${item.status}`);
  const files: IPlannedModelFile[] = [];
  const add = (filePath: string, before: string | undefined, after: string) => { if (before !== after) files.push({ path: filePath, before, after }); };
  if (resolution.complete && conflicts.length === 0) {
    if (Object.keys(desired).length) add(config.file.path, config.file.text, editOpenCodeAgentModels(config.file.text ?? "{}\n", desired));
    if (JSON.stringify(records) !== JSON.stringify(ownership.value.agents)) add(ownership.path, ownership.text, serializeAppliedModelOwnership({ schemaVersion: 1, agents: records }));
    const selections = { ...state.resolutions[profile], ...selectionsFromResolution(resolution) };
    if (JSON.stringify(selections) !== JSON.stringify(state.resolutions[profile] ?? {})) add(location.statePath, snapshots.find((item) => item.path === location.statePath)!.text, serializeLocalModelState({ ...state, resolutions: { ...state.resolutions, [profile]: selections } }));
  }
  const shadowed: string[] = [];
  if (target.scope === "global" && options.project) {
    const projectTarget = resolveAgentTarget(options.project);
    const projectConfig = await inspectOpenCodeConfig(projectTarget);
    if (projectConfig.status === "config-conflict") shadowed.push(...projectConfig.files.map((file) => `Unknown effective configuration: ${file}`));
    for (const item of assignments) {
      const md = await readSafeText(projectTarget, path.join(agentDirectory(projectTarget), `${item.agent}.md`));
      if (md !== undefined && inspectMarkdownModel(md).model !== undefined || projectConfig.status === "ready" && readConfigAgentModel(projectConfig.file.value, item.agent) !== undefined) shadowed.push(item.agent);
    }
  }
  return approveModelPlan({ target, profile, resolution, assignments, files, conflicts, shadowed, snapshots, status: resolution.complete && conflicts.length === 0 ? "ready" : "blocked" });
}
