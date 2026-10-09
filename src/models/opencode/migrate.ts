import { readdir } from "node:fs/promises";
import * as path from "pathe";
import { agentManifestRelativePath, assertAgentManifest, emptyAgentManifest, type AgentOwnershipManifest } from "../../agents/manifest.js";
import { assertSafeTargetDirectory, agentDirectory, type IAgentTarget } from "../../agents/target.js";
import { hashAgentContent } from "../../agents/sync.js";
import { inspectOpenCodeConfig } from "./config-files.js";
import { parseOpenCodeConfig, readConfigAgentModel } from "./jsonc-editor.js";
import { resolveModelProfileLocation } from "../profiles/location.js";
import { applyModelProfilePlan } from "./apply.js";
import { approveModelPlan } from "./approval.js";
import { inspectMarkdownModel } from "./markdown-model.js";
import { appliedModelOwnershipRelativePath } from "./ownership.js";
import { buildModelProfilePlan } from "./plan.js";
import { readSafeText } from "./safe-write.js";
import type { IApplyModelProfileOptions, IApplyModelProfileResult, IModelProfilePlan, IPlanModelProfileOptions, IPlannedModelFile } from "./types.js";

interface IAgentManifestSnapshot {
  readonly path: string;
  readonly text: string | undefined;
  readonly value: AgentOwnershipManifest;
}
interface IAgentMigration {
  readonly agent: string;
  readonly filePath: string;
  readonly before: string;
  readonly after: string;
}
/** A managed agent whose Markdown was already stripped but whose manifest hash is still the original's. */
interface IInterruptedMigration {
  readonly agent: string;
  readonly hash: string;
}
interface IMigrationPlan {
  readonly plan: IModelProfilePlan;
  readonly manifest: IAgentManifestSnapshot;
  /** True when the plan is only the manifest-hash repair of an interrupted migration. */
  readonly repair: boolean;
}

/**
 * Plans moving managed `model:` frontmatter into OpenCode configuration.
 * Write order: configuration, stripped agent Markdown, agent manifest hash, then ownership/local state,
 * so every interruption leaves the model assigned in configuration before it disappears from Markdown.
 * An interrupted migration (Markdown stripped, hash not yet recorded) is returned as a ready plan holding
 * only the hash repair; re-plan after applying it for any remaining migration.
 */
export async function prepareAgentModelMigration(options: IPlanModelProfileOptions): Promise<IModelProfilePlan> {
  return (await planMigration(options)).plan;
}

/** Applies the migration; with `dryRun` nothing is written, including interrupted-migration repair. */
export async function migrateAgentModels(options: IApplyModelProfileOptions): Promise<IApplyModelProfileResult> {
  const first = await planMigration(options);
  if (!first.repair || options.dryRun) return applyModelProfilePlan(first.plan, { dryRun: options.dryRun });

  // Repair is its own step: only the manifest hash is behind, so record it, then plan the rest from fresh state.
  const repair = await applyModelProfilePlan(first.plan);
  if (repair.status !== "applied") return repair;
  const second = await applyModelProfilePlan((await planMigration(options)).plan);
  const filesChanged = [...repair.filesChanged, ...second.filesChanged];
  const backups = [...repair.backups, ...second.backups];
  if (second.status === "blocked" || second.status === "failed") {
    return {
      ...second,
      status: "failed",
      filesChanged,
      backups,
      manualIntervention: [...new Set([...repair.filesChanged, ...second.manualIntervention])],
      error: second.error ?? `Interrupted migration was repaired, but the remaining migration is blocked: ${second.plan.conflicts.join(", ") || second.plan.status}`,
    };
  }
  return { ...second, status: second.status === "unchanged" ? repair.status : second.status, filesChanged, backups };
}

async function planMigration(options: IPlanModelProfileOptions): Promise<IMigrationPlan> {
  const plan = await buildModelProfilePlan(options, true);
  const manifest = readManifestSnapshot(plan);
  // The planner validates the manifest before reaching these states; earlier states never use it.
  if (plan.status !== "ready" && plan.status !== "blocked") return { plan, manifest, repair: false };
  if (plan.status === "ready") {
    return { plan: approveModelPlan(withMigrationFiles(plan, manifest, collectMigrations(plan, manifest))), manifest, repair: false };
  }
  const interrupted = await findInterruptedMigrations(plan, manifest.value);
  const names = new Set(interrupted.map((item) => item.agent));
  const repairable = interrupted.length > 0 && plan.resolution?.complete === true
    && plan.conflicts.every((conflict) => names.has(conflict.split(": ")[0]!));
  if (!repairable) return { plan, manifest, repair: false };
  // Dry runs and previews see the same resumable step: a ready plan containing only the manifest hash repair.
  return { plan: approveModelPlan({ ...plan, status: "ready", conflicts: [], files: [manifestFile(manifest, interrupted)] }), manifest, repair: true };
}

function readManifestSnapshot(plan: IModelProfilePlan): IAgentManifestSnapshot {
  const manifestPath = path.join(plan.target.root, agentManifestRelativePath);
  const text = plan.snapshots.find((snapshot) => snapshot.path === manifestPath)?.text;
  if (text === undefined) return { path: manifestPath, text, value: emptyAgentManifest() };
  const value: unknown = JSON.parse(text);
  assertAgentManifest(value, manifestPath);
  return { path: manifestPath, text, value };
}

/** Only unchanged, non-override, manifest-owned agents are stripped; everything else keeps its Markdown. */
function collectMigrations(plan: IModelProfilePlan, manifest: IAgentManifestSnapshot): IAgentMigration[] {
  const migrations: IAgentMigration[] = [];
  for (const item of plan.assignments) {
    if (!["apply", "unchanged", "migration-required"].includes(item.status) || manifest.value.overrides.includes(item.agent)) continue;
    const record = manifest.value.installed[item.agent];
    const filePath = path.join(agentDirectory(plan.target), `${item.agent}.md`);
    const text = plan.snapshots.find((snapshot) => snapshot.path === filePath)?.text;
    if (!record || text === undefined || hashAgentContent(text) !== record.hash) continue;
    const inspected = inspectMarkdownModel(text);
    if (inspected.model === undefined) continue;
    migrations.push({ agent: item.agent, filePath, before: text, after: inspected.stripped });
  }
  return migrations;
}

function withMigrationFiles(plan: IModelProfilePlan, manifest: IAgentManifestSnapshot, migrations: readonly IAgentMigration[]): IModelProfilePlan {
  if (!migrations.length) return plan;
  const trailing = new Set([path.join(plan.target.root, appliedModelOwnershipRelativePath), resolveModelProfileLocation(plan.target).statePath]);
  const markdown: IPlannedModelFile[] = migrations.map((item) => ({ path: item.filePath, before: item.before, after: item.after }));
  const updates = migrations.map((item) => ({ agent: item.agent, hash: hashAgentContent(item.after) }));
  return {
    ...plan,
    files: [
      ...plan.files.filter((file) => !trailing.has(file.path)),
      ...markdown,
      manifestFile(manifest, updates),
      ...plan.files.filter((file) => trailing.has(file.path)),
    ],
  };
}

/** Updates only the recorded hash; source and version stay as installed. */
function manifestFile(manifest: IAgentManifestSnapshot, updates: readonly { readonly agent: string; readonly hash: string }[]): IPlannedModelFile {
  const installed = { ...manifest.value.installed };
  for (const update of updates) installed[update.agent] = { ...installed[update.agent]!, hash: update.hash };
  return { path: manifest.path, before: manifest.text, after: `${JSON.stringify({ ...manifest.value, installed }, null, 2)}\n` };
}

/**
 * Proves an interrupted migration without touching anything else: the configuration still assigns the planned
 * model, the current file has no `model`, and a safe-write backup beside it hashes to the manifest's recorded
 * hash and strips to exactly the current text.
 */
async function findInterruptedMigrations(plan: IModelProfilePlan, manifest: AgentOwnershipManifest): Promise<IInterruptedMigration[]> {
  const found: IInterruptedMigration[] = [];
  const config = await inspectOpenCodeConfig(plan.target);
  // Markdown is only stripped after configuration was written, so the assignment must still be there.
  const configText = config.status === "ready" ? plan.snapshots.find((snapshot) => snapshot.path === config.file.path)?.text : undefined;
  if (configText === undefined) return found;
  const configValue = parseOpenCodeConfig(configText);
  for (const item of plan.assignments) {
    const record = manifest.installed[item.agent];
    if (item.status !== "modified-agent" || !record || manifest.overrides.includes(item.agent)) continue;
    if (readConfigAgentModel(configValue, item.agent) !== item.model) continue;
    const current = plan.snapshots.find((snapshot) => snapshot.path === path.join(agentDirectory(plan.target), `${item.agent}.md`))?.text;
    if (current === undefined || hashAgentContent(current) === record.hash) continue;
    if (await hasOriginalBackup(plan.target, item.agent, record.hash, current)) found.push({ agent: item.agent, hash: hashAgentContent(current) });
  }
  return found;
}

async function hasOriginalBackup(target: IAgentTarget, agent: string, originalHash: string, current: string): Promise<boolean> {
  const directory = agentDirectory(target);
  await assertSafeTargetDirectory(target, directory);
  let names: string[];
  try { names = await readdir(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  // Agent names are [a-z0-9-], so they are literal in this pattern; it matches writeSafeText's backup names.
  const pattern = new RegExp(`^${agent}\\.md\\.\\d+\\.[a-f0-9]{16}\\.bak$`);
  for (const name of names.filter((item) => pattern.test(item))) {
    try {
      const original = await readSafeText(target, path.join(directory, name));
      if (original === undefined || hashAgentContent(original) !== originalHash) continue;
      const inspected = inspectMarkdownModel(original);
      if (inspected.model !== undefined && inspected.stripped === current && inspectMarkdownModel(current).model === undefined) return true;
    } catch {
      // An unreadable or unsupported backup is not proof.
    }
  }
  return false;
}
