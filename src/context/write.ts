import { lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import * as nodePath from "node:path";
import * as path from "pathe";
import { AiContextSetupError } from "./model.js";
import type { ContextPlanFile } from "./plan.js";

/** Write a context plan after checking every path, with bounded rollback. */
export async function writeContextFiles(root: string, files: ContextPlanFile[]): Promise<void> {
  const rootReal = await realpath(root);
  const conflicts: string[] = [];
  const unsafe: string[] = [];

  for (const file of files) {
    const target = path.resolve(root, file.relativePath);
    const parent = nodePath.dirname(target);
    const parentStatus = await inspectExistingPath(parent, rootReal, true);
    if (parentStatus.error) unsafe.push(`${file.relativePath}: ${parentStatus.error}`);
    if (parentStatus.notDirectory) conflicts.push(nodePath.relative(root, parentStatus.notDirectory));

    const targetStatus = await inspectExistingPath(target, rootReal, false);
    if (targetStatus.error) unsafe.push(`${file.relativePath}: ${targetStatus.error}`);
    if (targetStatus.exists) conflicts.push(file.relativePath);
  }

  if (conflicts.length || unsafe.length) {
    const details = [...new Set([...conflicts.map((entry) => `${entry} already exists`), ...unsafe])];
    throw new AiContextSetupError(`AI context setup stopped: ${details.join("; ")}.`);
  }

  const createdFiles: string[] = [];
  const createdDirectories: string[] = [];
  try {
    for (const file of files) {
      const target = path.resolve(root, file.relativePath);
      await createMissingDirectories(nodePath.dirname(target), root, createdDirectories);
      await writeFile(target, file.content, { encoding: "utf8", flag: "wx" });
      createdFiles.push(target);
    }
  } catch (error) {
    await rollback(createdFiles, createdDirectories);
    throw error;
  }
}

async function inspectExistingPath(filePath: string, rootReal: string, mustBeDirectory: boolean): Promise<{
  exists: boolean;
  notDirectory?: string;
  error?: string;
}> {
  let existing = false;
  try {
    const stat = await lstat(filePath);
    existing = true;
    if (stat.isDirectory()) {
      const resolved = await realpath(filePath);
      return isWithin(rootReal, resolved) ? { exists: true } : { exists: true, error: "path resolves outside the destination" };
    }
    if (mustBeDirectory) return { exists: true, notDirectory: filePath };
    const resolved = await realpath(filePath);
    return isWithin(rootReal, resolved)
      ? { exists: true }
      : { exists: true, error: "path resolves outside the destination" };
  } catch (error) {
    if (existing) return { exists: true, error: "path cannot be resolved safely" };
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { exists: false, error: "path cannot be inspected safely" };
  }

  let cursor = nodePath.dirname(filePath);
  while (true) {
    try {
      const stat = await lstat(cursor);
      if (!stat.isDirectory()) return { exists: false, notDirectory: cursor };
      const resolved = await realpath(cursor);
      return isWithin(rootReal, resolved)
        ? { exists: false }
        : { exists: false, error: "parent path resolves outside the destination" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { exists: false, error: "path cannot be inspected safely" };
      const next = nodePath.dirname(cursor);
      if (next === cursor) return { exists: false, error: "path cannot be inspected safely" };
      cursor = next;
    }
  }
}

async function createMissingDirectories(directory: string, root: string, created: string[]): Promise<void> {
  const missing: string[] = [];
  let cursor = directory;
  while (path.resolve(cursor) !== path.resolve(root)) {
    try {
      const stat = await lstat(cursor);
      if (!stat.isDirectory()) throw new AiContextSetupError(`AI context setup requires a directory: ${nodePath.relative(root, cursor)}`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.push(cursor);
      const next = nodePath.dirname(cursor);
      if (next === cursor) throw new AiContextSetupError("AI context setup cannot resolve a parent path.");
      cursor = next;
    }
  }
  for (const entry of missing.reverse()) {
    await mkdir(entry);
    created.push(entry);
  }
}

async function rollback(files: string[], directories: string[]): Promise<void> {
  for (const file of files.reverse()) await rm(file, { force: true }).catch(() => undefined);
  for (const directory of directories.reverse()) await rm(directory, { recursive: false, force: true }).catch(() => undefined);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = nodePath.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${nodePath.sep}`) && !nodePath.isAbsolute(relative));
}
