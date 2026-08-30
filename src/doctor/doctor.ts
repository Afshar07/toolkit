import { execa } from "execa";
import type { PackageManager, WorkspaceManifest } from "../workspace/manifest.js";

export interface Prerequisite {
  name: string;
  available: boolean;
  version?: string;
}

export async function checkPrerequisites(manifest?: WorkspaceManifest): Promise<Prerequisite[]> {
  const tools = new Set<string>(["git", "node"]);
  for (const manager of manifest?.repositories.map((repository) => repository.packageManager).filter(Boolean) ?? []) {
    tools.add(manager as PackageManager);
  }
  return Promise.all([...tools].map(checkTool));
}

async function checkTool(name: string): Promise<Prerequisite> {
  try {
    const { stdout } = await execa(name, ["--version"]);
    return { name, available: true, version: stdout.split("\n")[0] };
  } catch {
    return { name, available: false };
  }
}
