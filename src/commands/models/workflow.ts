import * as prompts from "@clack/prompts";
import { applyModelProfilePlan, planModelProfileApplication, prepareAgentModelMigration, readLocalModelState, resolveModelProfile, resolveModelProfileLocation } from "../../models/index.js";
import type { IModelProfilePlan, IPlanModelProfileOptions, IApplyModelProfileResult } from "../../models/index.js";
import type { IModelCommandOptions } from "./types.js";
import { selectModel } from "./selector.js";

export async function confirm(message: string): Promise<boolean> {
  const answer = await prompts.confirm({ message, initialValue: false });
  return !prompts.isCancel(answer) && answer === true;
}

export function displayModel(value: unknown): string | null {
  return typeof value === "string" ? value : value === undefined || value === null ? null : "[object model assignment; inspect locally]";
}

export function preview(plan: IModelProfilePlan): void {
  console.log(`\nProfile: ${plan.profile ?? "—"} (${plan.target.scope})`);
  console.log("Agent                  Current → Proposed [ownership; action]");
  for (const item of plan.assignments) console.log(`${item.agent.padEnd(22)} ${JSON.stringify(displayModel(item.previous)) ?? "—"} → ${item.model} [${item.ownership}; ${item.status}]`);
  for (const [agent, result] of Object.entries(plan.resolution?.agents ?? {})) {
    if (result.status !== "resolved") console.warn(`${agent}: ${result.status}${result.status === "ambiguous" ? ` (${result.candidates.map((m) => m.id).join(", ")})` : ""}`);
    else if (result.staleSelection) console.warn(`${agent}: saved selection ${result.staleSelection.id} is ${result.staleSelection.reason}`);
  }
  for (const conflict of plan.conflicts) console.warn(`Conflict: ${conflict}`);
  for (const agent of plan.shadowed) console.warn(`Shadowed by project configuration: ${agent}`);
  console.log(`${plan.files.length} files planned; OpenCode changes: ${plan.assignments.some((a) => a.status === "apply") ? "yes" : "no"}.`);
}

export function report(result: IApplyModelProfileResult): void {
  console.log(`Application: ${result.status}`);
  for (const file of result.filesChanged) console.log(`Changed: ${file}`);
  for (const file of result.backups) console.log(`Backup: ${file}`);
  for (const file of result.manualIntervention) console.error(`Recovery required: ${file}`);
  if (result.error) console.error(result.error);
}

/** All choices stay in memory; Phase 3 remains the sole configuration writer. */
export async function executeProfile(options: IPlanModelProfileOptions, cli: IModelCommandOptions): Promise<IApplyModelProfileResult | undefined> {
  const state = await readLocalModelState(resolveModelProfileLocation(cli.target));
  const definition = options.profileDefinition;
  const selections: Record<string, string> = { ...options.selections };
  if (definition && options.models) {
    const agents = options.agents ? Object.fromEntries(options.agents.map((a) => [a, definition.agents[a]!])) : definition.agents;
    const resolved = resolveModelProfile(options.models, { agents }, { selections: { ...state.resolutions[options.profile!], ...selections } });
    for (const [agent, outcome] of Object.entries(resolved.agents)) {
      if (outcome.status !== "ambiguous") continue;
      if (!cli.interactive) throw new Error(`${agent}: ambiguous models. Run interactively to select an exact candidate.`);
      const id = await selectModel(outcome.candidates, { agent, current: state.resolutions[options.profile!]?.[agent] });
      if (!id) { console.log("Cancelled; no files changed."); return; }
      selections[agent] = id;
    }
  }
  const approved = new Set<string>();
  const base = { ...options, selections, replaceAssignments: approved };
  let plan = await planModelProfileApplication(base);
  // Migration planning also identifies conflicts hidden by legacy Markdown and provable interrupted repair.
  let migration = await prepareAgentModelMigration(base);
  const migrationNeeded = plan.assignments.some((a) => a.status === "migration-required") || migration.status === "ready" && plan.status !== "ready";
  let selected = migrationNeeded ? migration : plan;
  if (options.agents && selected.assignments.some((a) => a.status === "skipped-override")) throw new Error("Selected agent is overridden; assignment and portable preference are preserved.");
  preview(selected);
  if (cli.dryRun) {
    if (selected.status !== "ready") throw new Error(`Dry-run blocked: ${selected.conflicts.join(", ") || selected.status}`);
    const result = await applyModelProfilePlan(selected, { dryRun: true }); report(result); return result;
  }
  for (const item of selected.assignments.filter((a) => a.status === "conflict")) {
    if (!cli.interactive) throw new Error(`${item.agent}: ${item.ownership} assignment requires explicit per-agent consent. Run interactively.`);
    console.log(`\nConflict: ${item.agent}\nCurrent: ${JSON.stringify(displayModel(item.previous))}\nProposed: ${item.model}\n${item.ownership === "edited" ? "This assignment was modified outside Toolkit." : "Toolkit does not own this assignment."}`);
    if (!await confirm(`Replace the assignment for ${item.agent}?`)) { console.log("Preserved; no files changed."); return; }
    approved.add(item.agent);
  }
  const previousPreview = selected;
  plan = await planModelProfileApplication(base);
  migration = await prepareAgentModelMigration(base);
  selected = migrationNeeded ? migration : plan;
  if (JSON.stringify(previousPreview.snapshots) !== JSON.stringify(selected.snapshots)) throw new Error("Files changed while collecting consent. No files were written; review a fresh application preview.");
  if (selected.status !== "ready") throw new Error(`Application blocked: ${selected.conflicts.join(", ") || selected.status}. Check missing/ambiguous models and agent ownership with models status.`);
  if (migrationNeeded) {
    console.log("Legacy migration/recovery: replacement configuration first, then managed Markdown model removal and ownership hash reconciliation. Instructions and permissions are preserved.");
    for (const file of selected.files) console.log(`Migration step: ${file.path}`);
    if (!cli.interactive) throw new Error("Legacy migration/recovery requires explicit approval in an interactive terminal.");
    if (!await confirm("Proceed with this legacy migration/recovery?")) { console.log("Migration declined; no files changed."); return; }
  }
  const repairOnly = migrationNeeded && plan.assignments.some((a) => a.status === "modified-agent") && selected.files.every((f) => f.path.endsWith("agents.json"));
  const result = await applyModelProfilePlan(selected);
  report(result);
  if (!["applied", "unchanged"].includes(result.status)) throw new Error("Application failed or was blocked; active profile was not changed. Preserve backups and inspect recovery paths above.");
  if (repairOnly) {
    console.log("Interrupted manifest hash repaired. Reviewing remaining application from fresh state; prior changes and backups are listed above.");
    try {
      const remaining = await executeProfile(options, cli);
      if (!remaining) throw new Error("Remaining application cancelled; recovery repair already changed the manifest, but switching is incomplete.");
      return { ...remaining, filesChanged: [...result.filesChanged, ...remaining.filesChanged], backups: [...result.backups, ...remaining.backups] };
    } catch (error) { throw new Error(`Partial recovery: ${String(error)}. Active profile was not changed; preserve reported backups.`); }
  }
  console.log("Static configuration updated; runtime availability was not verified. Open a new OpenCode session if needed.");
  return result;
}
