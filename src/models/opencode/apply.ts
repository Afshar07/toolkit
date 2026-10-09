import { assertSnapshot, writeSafeText } from "./safe-write.js";
import { planModelProfileApplication } from "./plan.js";
import { assertApprovedModelPlan } from "./approval.js";
import type { IApplyModelPlanOptions, IApplyModelProfileOptions, IApplyModelProfileResult, IModelProfilePlan } from "./types.js";

/** Plans are process-local approvals, not a wire format; don't execute untrusted serialized plans. */
export async function applyModelProfilePlan(plan: IModelProfilePlan, options: IApplyModelPlanOptions = {}): Promise<IApplyModelProfileResult> {
  const filesChanged: string[] = [], backups: string[] = [];
  const result = { plan, filesChanged, backups, manualIntervention: [] as string[] };
  if (plan.status !== "ready") return { ...result, status: "blocked" };
  assertApprovedModelPlan(plan);
  if (options.dryRun) return { ...result, status: "dry-run" };
  try {
    for (const snapshot of plan.snapshots) await assertSnapshot(snapshot.target ?? plan.target, snapshot.path, snapshot.text);
    for (const file of plan.files) {
      const backup = await writeSafeText(plan.target, file.path, file.before, file.after);
      filesChanged.push(file.path);
      if (backup) backups.push(backup);
    }
    return { ...result, status: filesChanged.length ? "applied" : "unchanged" };
  } catch (error) {
    const backupPath = (error as { backupPath?: unknown } | null)?.backupPath;
    if (typeof backupPath === "string") backups.push(backupPath);
    return { ...result, status: "failed", manualIntervention: filesChanged.length || backups.length ? plan.files.map((file) => file.path) : [], error: error instanceof Error ? error.message : String(error) };
  }
}

export async function applyModelProfile(options: IApplyModelProfileOptions): Promise<IApplyModelProfileResult> {
  return applyModelProfilePlan(await planModelProfileApplication(options), { dryRun: options.dryRun });
}
