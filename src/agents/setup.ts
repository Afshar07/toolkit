import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import * as path from "pathe";
import { canonicalAgents } from "./registry.js";

export class OpenCodeAgentSetupError extends Error {}

export async function setupOpenCodeAgents(destination: string): Promise<string[]> {
  const target = path.resolve(destination);
  await assertNoSymlinkComponents(target);
  const conflicts = await Promise.all(Object.keys(canonicalAgents).map(async (fileName) => pathExists(path.join(target, fileName))));
  const existing = Object.keys(canonicalAgents).filter((_, index) => conflicts[index]);
  if (existing.length > 0) {
    throw new OpenCodeAgentSetupError(`OpenCode agent setup stopped: ${existing.join(", ")} already exists.`);
  }

  await mkdir(target, { recursive: true });
  await assertNoSymlinkComponents(target);
  const created: string[] = [];
  try {
    for (const [fileName, content] of Object.entries(canonicalAgents)) {
      const filePath = path.join(target, fileName);
      await assertNoSymlinkComponents(path.dirname(filePath));
      await writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
      created.push(filePath);
    }
  } catch (error) {
    for (const filePath of created.reverse()) await rm(filePath, { force: true }).catch(() => undefined);
    throw error;
  }
  return Object.keys(canonicalAgents);
}

async function assertNoSymlinkComponents(filePath: string): Promise<void> {
  let cursor = filePath;
  while (true) {
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) throw new OpenCodeAgentSetupError(`OpenCode agent destination contains a symbolic link: ${cursor}`);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch {
    return false;
  }
}
