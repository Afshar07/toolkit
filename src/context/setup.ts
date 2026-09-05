import { lstat } from "node:fs/promises";
import * as path from "pathe";
import { createAiContextPlan } from "./plan.js";
import { AiContextSetupError, normalizeAiContextOptions } from "./model.js";
import type { AiContextOptions } from "./model.js";
import { writeContextFiles } from "./write.js";

export { AiContextSetupError } from "./model.js";
export type { AiContextOptions, AiContextProject } from "./model.js";

/** Create the Markdown context scaffold without overwriting existing roots. */
export async function setupAiContext(destination: string, options: AiContextOptions): Promise<string[]> {
  const root = path.resolve(destination);
  await requireDirectory(root);
  const normalized = normalizeAiContextOptions(options);
  const files = createAiContextPlan(normalized);
  await writeContextFiles(root, files);
  return files.map(({ relativePath }) => relativePath);
}

export function defaultAiContextOptions(destination: string): AiContextOptions & { projectId: string; projectScope: string } {
  const name = path.basename(path.resolve(destination));
  const projectId = name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-+|-+$/g, "") || "project";
  return {
    workspaceName: name,
    workspacePurpose: "Describe this workspace's purpose.",
    contextPath: ".ai",
    projects: [{ id: projectId, path: ".", scope: "Primary project in this workspace.", status: "active" }],
    projectId,
    projectScope: "Primary project in this workspace.",
  };
}

async function requireDirectory(filePath: string): Promise<void> {
  try { if ((await lstat(filePath)).isDirectory()) return; } catch { /* consistent error below */ }
  throw new AiContextSetupError(`AI context setup requires an existing directory: ${filePath}`);
}
