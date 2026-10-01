import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import * as nodePath from "node:path";
import { AiContextSetupError } from "./model.js";
import type { ContextPlanFile } from "./plan.js";
import { assertSafeProjectPath, type IFilesystemRoot, isWithin } from "../workspace/safety.js";

export type ContextPlanState = "create" | "unchanged" | "managed-update" | "conflict";
export type ContextPlanDecision = "replace" | "skip";

export interface InspectedContextPlanFile extends ContextPlanFile {
  content: string;
  state: ContextPlanState;
  targetPath: string;
  rootPath: string;
  rootRealPath: string;
  existingContent?: string;
}

export interface ApplyContextPlanOptions {
  decisions?: Record<string, ContextPlanDecision | undefined>;
  backupRoot?: string;
}

export interface ApplyContextPlanResult {
  created: string[];
  replaced: string[];
  skipped: string[];
  backups: string[];
}

const markerPattern = /^<!-- toolkit:sha256=([a-f0-9]{64}) -->\r?\n([\s\S]*)$/;

/** Prefix a generated Markdown body with its deterministic Toolkit ownership marker. */
export function addToolkitMarker(body: string): string {
  const hash = createHash("sha256").update(body, "utf8").digest("hex");
  return `<!-- toolkit:sha256=${hash} -->\n${body}`;
}

/** Inspect a context plan without modifying the destination. */
export async function inspectContextPlan(destination: string, files: ContextPlanFile[]): Promise<InspectedContextPlanFile[]> {
  const root = await requireRoot(destination);
  const seen = new Set<string>();
  const inspected: InspectedContextPlanFile[] = [];

  for (const file of files) {
    if (seen.has(file.relativePath)) throw new AiContextSetupError(`AI context plan contains duplicate output path: ${file.relativePath}`);
    seen.add(file.relativePath);
    const targetPath = await safeTarget(root, file.relativePath);
    const content = addToolkitMarker(file.content);
    let existing: string | undefined;
    try {
      const stat = await lstat(targetPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new AiContextSetupError(`AI context path is not a regular file: ${file.relativePath}`);
      existing = await readFile(targetPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    inspected.push({
      relativePath: file.relativePath,
      content,
      targetPath,
      rootPath: root.lexical,
      rootRealPath: root.real,
      ...(existing === undefined ? {} : { existingContent: existing }),
      state: existing === undefined ? "create" : stateFor(existing, content),
    });
  }
  return inspected;
}

/** Apply explicit reconciliation decisions after validating all requested writes. */
export async function applyContextPlan(files: InspectedContextPlanFile[], options: ApplyContextPlanOptions = {}): Promise<ApplyContextPlanResult> {
  const decisions = options.decisions ?? {};
  const actions = files.map((file) => ({ file, decision: decisionFor(file, decisions[file.relativePath]) }));
  const unresolved = actions.filter(({ decision }) => decision === undefined).map(({ file }) => file.relativePath);
  if (unresolved.length) throw new AiContextSetupError(`AI context reconciliation requires a decision: ${unresolved.join(", ")}`);

  const root = rootFromFiles(files);
  if (options.backupRoot) {
    const backupRoot = nodePath.resolve(options.backupRoot);
    if (!root || !isWithin(root.lexical, backupRoot)) throw new AiContextSetupError("AI context backup root must be inside the destination.");
    await assertSafeProjectPath(root, backupRoot, "AI context backup root");
    for (const { file, decision } of actions) {
      if (decision !== "replace" || file.state === "create") continue;
      await assertSafeProjectPath(root, nodePath.resolve(backupRoot, file.relativePath), `AI context backup path ${file.relativePath}`);
    }
  }

  for (const { file, decision } of actions) {
    if (decision === "skip") continue;
    const expectedTarget = nodePath.resolve(file.rootPath, file.relativePath);
    if (file.targetPath !== expectedTarget || !isWithin(file.rootPath, expectedTarget)) {
      throw new AiContextSetupError(`AI context path is unsafe: ${file.relativePath}`);
    }
    await inspectParents(nodePath.dirname(file.targetPath), file.rootRealPath, file.relativePath);
    if (file.state === "create") {
      try { await lstat(file.targetPath); throw new AiContextSetupError(`AI context path changed during reconciliation: ${file.relativePath}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    } else {
      const stat = await lstat(file.targetPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new AiContextSetupError(`AI context path changed during reconciliation: ${file.relativePath}`);
      if (await readFile(file.targetPath, "utf8") !== file.existingContent) {
        throw new AiContextSetupError(`AI context path changed during reconciliation: ${file.relativePath}`);
      }
    }
  }

  const result: ApplyContextPlanResult = { created: [], replaced: [], skipped: [], backups: [] };
  const created: string[] = [];
  const replaced: Array<{ path: string; content: string }> = [];
  try {
    for (const { file, decision } of actions) {
      if (decision === "skip") { result.skipped.push(file.relativePath); continue; }
      await mkdir(nodePath.dirname(file.targetPath), { recursive: true });
      if (file.state === "create") {
        await writeFile(file.targetPath, file.content, { encoding: "utf8", flag: "wx" });
        created.push(file.targetPath);
        result.created.push(file.relativePath);
        continue;
      }
      const original = await readFile(file.targetPath, "utf8");
      if (options.backupRoot) {
        const backup = nodePath.resolve(options.backupRoot, file.relativePath);
        if (!isWithin(nodePath.resolve(options.backupRoot), backup)) throw new AiContextSetupError(`AI context backup path is unsafe: ${file.relativePath}`);
        await assertSafeProjectPath(root!, backup, `AI context backup path ${file.relativePath}`);
        await mkdir(nodePath.dirname(backup), { recursive: true });
        await assertSafeProjectPath(root!, backup, `AI context backup path ${file.relativePath}`);
        await writeFile(backup, original, { encoding: "utf8", flag: "wx" });
        result.backups.push(backup);
      }
      replaced.push({ path: file.targetPath, content: original });
      await writeFile(file.targetPath, file.content, "utf8");
      result.replaced.push(file.relativePath);
    }
  } catch (error) {
    await rollback(created, replaced, result.backups, root);
    throw error;
  }
  return result;
}

function rootFromFiles(files: InspectedContextPlanFile[]): IFilesystemRoot | undefined {
  const first = files[0];
  if (!first) return undefined;
  if (files.some((file) => file.rootPath !== first.rootPath || file.rootRealPath !== first.rootRealPath)) {
    throw new AiContextSetupError("AI context plan contains mixed destination roots.");
  }
  return { lexical: first.rootPath, real: first.rootRealPath };
}

function stateFor(existing: string, desired: string): ContextPlanState {
  if (existing === desired) return "unchanged";
  const marker = markerPattern.exec(existing);
  if (!marker) return "conflict";
  return createHash("sha256").update(marker[2], "utf8").digest("hex") === marker[1] ? "managed-update" : "conflict";
}

function decisionFor(file: InspectedContextPlanFile, decision: ContextPlanDecision | undefined): ContextPlanDecision | undefined {
  if (file.state === "create") return "replace";
  if (file.state === "unchanged") return "skip";
  return decision;
}

async function requireRoot(destination: string): Promise<{ lexical: string; real: string }> {
  const lexical = nodePath.resolve(destination);
  const stat = await lstat(lexical).catch(() => undefined);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new AiContextSetupError(`AI context reconciliation requires an existing directory: ${lexical}`);
  return { lexical, real: await realpath(lexical) };
}

async function safeTarget(root: { lexical: string; real: string }, relativePath: string): Promise<string> {
  if (!relativePath || nodePath.isAbsolute(relativePath)) throw new AiContextSetupError(`AI context path is unsafe: ${relativePath}`);
  const target = nodePath.resolve(root.lexical, relativePath);
  if (!isWithin(root.lexical, target)) throw new AiContextSetupError(`AI context path escapes the destination: ${relativePath}`);
  await inspectParents(nodePath.dirname(target), root.real, relativePath);
  return target;
}

async function inspectParents(directory: string, rootReal: string, relativePath: string): Promise<void> {
  let cursor = directory;
  while (true) {
    try {
      const stat = await lstat(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !isWithin(rootReal, await realpath(cursor))) throw new AiContextSetupError(`AI context path is unsafe: ${relativePath}`);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      cursor = nodePath.dirname(cursor);
    }
  }
}

async function rollback(created: string[], replaced: Array<{ path: string; content: string }>, backups: string[], root: IFilesystemRoot | undefined): Promise<void> {
  if (!root) return;
  for (const file of created.reverse()) {
    await assertSafeProjectPath(root, file, "Context rollback path").then(() => rm(file, { force: true })).catch(() => undefined);
  }
  for (const file of replaced.reverse()) {
    await assertSafeProjectPath(root, file.path, "Context rollback path").then(() => writeFile(file.path, file.content, "utf8")).catch(() => undefined);
  }
  for (const backup of backups.reverse()) {
    await assertSafeProjectPath(root, backup, "Context rollback path").then(() => rm(backup, { force: true })).catch(() => undefined);
  }
}
