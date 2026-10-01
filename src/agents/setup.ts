import { lstat, mkdir, writeFile } from "node:fs/promises";
import * as path from "pathe";
import { canonicalAgents } from "./registry.js";

export class OpenCodeAgentSetupError extends Error {}

export async function setupOpenCodeAgents(destination: string): Promise<string[]> {
  const target = path.resolve(destination);
  const conflicts = await Promise.all(Object.keys(canonicalAgents).map(async (fileName) => pathExists(path.join(target, fileName))));
  const existing = Object.keys(canonicalAgents).filter((_, index) => conflicts[index]);
  if (existing.length > 0) {
    throw new OpenCodeAgentSetupError(`OpenCode agent setup stopped: ${existing.join(", ")} already exists.`);
  }

  await mkdir(target, { recursive: true });
  await Promise.all(Object.entries(canonicalAgents).map(async ([fileName, content]) => {
    await writeFile(path.join(target, fileName), content, "utf8");
  }));
  return Object.keys(canonicalAgents);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch {
    return false;
  }
}
