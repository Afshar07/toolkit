import * as prompts from "@clack/prompts";
import { resolveOfflineAgentRegistry } from "../../registry/registry.js";
import { createModelProfile, discoverModels, getModelProfile, isValidProfileName, listModelProfiles, readLocalModelState, resolveModelProfile, resolveModelProfileLocation, saveModelResolutions, setActiveModelProfile, updateModelProfile, validateModelPreference } from "../../models/index.js";
import type { IModelPreference, IModelRef } from "../../models/index.js";
import { selectModel } from "./selector.js";
import { confirm, executeProfile } from "./workflow.js";
import type { IModelCommandOptions } from "./types.js";

export function preferenceFor(model: IModelRef): IModelPreference { return { family: model.family, allowedProviders: [model.provider] }; }

export async function configure(cli: IModelCommandOptions): Promise<void> {
  if (!cli.interactive) throw new Error("models configure requires an interactive terminal (TTY). Use models use/set with explicit arguments for scripts.");
  const location = resolveModelProfileLocation(cli.target);
  const names = await listModelProfiles(location);
  const action = await prompts.select({ message: "Choose profile action", options: [
    { value: "create", label: "Create a new profile" },
    ...(names.length ? [{ value: "edit", label: "Edit an existing profile" }, { value: "apply", label: "Select an existing profile to apply" }] : []),
  ] });
  if (prompts.isCancel(action)) return;
  const choice = action === "create" ? await prompts.text({ message: "Profile name", validate: (value) => isValidProfileName(value) && !names.includes(value!) ? undefined : "Use a new lowercase name with digits/hyphens." })
    : await prompts.select({ message: "Select profile", options: names.map((name) => ({ value: name, label: name })) });
  if (prompts.isCancel(choice)) return;
  const name = String(choice);
  if (!isValidProfileName(name)) throw new Error("Invalid profile name.");
  const existing = await getModelProfile(location, name);
  if (action === "create" && existing) throw new Error(`Profile ${name} already exists.`);
  let models: readonly IModelRef[] = [];
  try { models = (await discoverModels({ openCode: { cwd: cli.target.scope === "project" ? cli.target.root : process.cwd() } })).models; }
  catch (error) {
    console.error(`Discovery unavailable: ${error instanceof Error ? error.message : "OpenCode failed"}. Portable preferences can still be saved; OpenCode integration is not verified.`);
    if (action === "apply" || !await confirm("Continue with unresolved portable preferences (save only)?")) return;
  }
  if (action === "apply") {
    const result = await executeProfile({ target: cli.target, profile: name, profileDefinition: existing!, models }, cli);
    if (result && !cli.dryRun) {
      try { await setActiveModelProfile(location, name); }
      catch (error) { throw new Error(`Configuration applied but active-profile persistence failed: ${String(error)}. Switching is incomplete; preserve changed files/backups reported above and retry models use ${name}.`); }
    }
    return;
  }
  const state = await readLocalModelState(location);
  const currentResolution = existing ? resolveModelProfile(models, existing, { selections: state.resolutions[name] }) : undefined;
  const agents: Record<string, IModelPreference> = { ...existing?.agents };
  const selections: Record<string, string> = {};
  const registry = (await resolveOfflineAgentRegistry()).registry;
  for (const agent of Object.keys(registry.agents).map((file) => file.replace(/\.md$/, "")).sort()) {
    const outcome = currentResolution?.agents[agent];
    const current = state.resolutions[name]?.[agent] ?? (outcome?.status === "resolved" ? outcome.model.id : undefined);
    console.log(`${agent}: preference ${JSON.stringify(agents[agent]) ?? "—"}; local resolution ${current ?? "—"}`);
    const mode = await prompts.select({ message: `Assignment for ${agent}`, options: [
      ...(models.length ? [{ value: "select", label: "Select discovered model" }] : []),
      ...(agents[agent] ? [{ value: "keep", label: "Preserve existing preference" }] : []),
      { value: "portable", label: "Enter portable family or pattern" }, { value: "skip", label: "Skip assignment" },
    ] });
    if (prompts.isCancel(mode)) return;
    if (mode === "keep") continue;
    if (mode === "skip") { delete agents[agent]; continue; }
    if (mode === "select") {
      const id = await selectModel(models, { agent, current });
      if (!id) return;
      const model = models.find((m) => m.id === id)!;
      agents[agent] = preferenceFor(model); selections[agent] = id;
    } else {
      const provider = await prompts.text({ message: `Allowed provider for ${agent}` });
      if (prompts.isCancel(provider)) return;
      const rule = await prompts.text({ message: "Family or complete provider/model glob (* or ?); numbers are preserved" });
      if (prompts.isCancel(rule)) return;
      const preference = /[*?]/.test(rule) ? { patterns: [rule], allowedProviders: [provider] } : { family: rule, allowedProviders: [provider] };
      const valid = validateModelPreference(preference);
      if (!valid.ok) throw new Error(valid.issues.map((issue) => issue.message).join("; "));
      agents[agent] = valid.value;
    }
  }
  const definition = { agents };
  const resolved = resolveModelProfile(models, definition, { selections: { ...state.resolutions[name], ...selections } });
  console.log(`Preview profile: ${name}\n${JSON.stringify({ preferences: agents, exactLocalSelections: selections, resolution: resolved }, null, 2)}\nOpenCode is unchanged until optional application.`);
  if (cli.dryRun) { console.log("Dry-run: no profile saved or applied."); return; }
  if (!await confirm(`Save profile ${name}?`)) return;
  const saved = existing ? await updateModelProfile(location, name, definition) : await createModelProfile(location, name, definition);
  if (!["changed", "unchanged"].includes(saved.status)) throw new Error(`Profile save failed: ${saved.status}`);
  const local = await saveModelResolutions(location, name, selections);
  if (!["changed", "unchanged"].includes(local.status)) throw new Error(`Profile saved, but exact local selection save failed: ${local.status}`);
  console.log(`Profile ${name} saved; not yet applied.`);
  if (!models.length || !await confirm(`Apply profile ${name} now?`)) return;
  const result = await executeProfile({ target: cli.target, profile: name, profileDefinition: definition, models, selections }, cli);
  if (result) {
    try { await setActiveModelProfile(location, name); }
    catch (error) { throw new Error(`Profile saved and configuration applied but active-profile persistence failed: ${String(error)}. Switching is incomplete; preserve changed files/backups reported above and retry models use ${name}.`); }
  }
}
