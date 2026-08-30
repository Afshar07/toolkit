import { execa } from "execa";
import type { PackageManager, WorkspaceManifest } from "../workspace/manifest.js";

export interface Prerequisite {
  name: string;
  status: "available" | "missing" | "incompatible";
  version?: string;
  expectedVersions?: string[];
}

export async function checkPrerequisites(manifest?: WorkspaceManifest): Promise<Prerequisite[]> {
  const tools = new Set<string>(["git", "node"]);
  for (const manager of repositories(manifest).map((repository) => repository.packageManager).filter(Boolean)) {
    tools.add(manager as PackageManager);
  }
  const expectedNodeVersions = [...new Set(repositories(manifest)
    .map((repository) => repository.nodeVersion)
    .filter((version): version is string => version !== undefined)
    .filter(isExactVersion))];
  return Promise.all([...tools].map((tool) => checkTool(tool, tool === "node" ? expectedNodeVersions : [])));
}

async function checkTool(name: string, expectedVersions: string[]): Promise<Prerequisite> {
  try {
    const { stdout } = await execa(name, ["--version"]);
    const version = stdout.split("\n")[0];
    if (expectedVersions.length > 0 && !expectedVersions.some((expected) => versionsMatch(version, expected))) {
      return { name, status: "incompatible", version, expectedVersions };
    }
    return { name, status: "available", version };
  } catch {
    return { name, status: "missing", expectedVersions: expectedVersions.length > 0 ? expectedVersions : undefined };
  }
}

function repositories(manifest?: WorkspaceManifest) {
  return [...(manifest?.rootRepository ? [manifest.rootRepository] : []), ...(manifest?.repositories ?? [])];
}

function isExactVersion(version: string): boolean {
  return /^v?\d+\.\d+\.\d+$/.test(version);
}

function versionsMatch(actual: string, expected: string): boolean {
  return actual.replace(/^v/, "") === expected.replace(/^v/, "");
}
