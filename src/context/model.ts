import * as posix from "node:path/posix";

export type AiContextProjectStatus = "active" | "held";

export interface AiContextProject {
  id: string;
  path: string;
  scope: string;
  status?: AiContextProjectStatus;
}

export interface AiContextOptions {
  workspaceName: string;
  workspacePurpose: string;
  contextPath?: string;
  projects: AiContextProject[];
}

export class AiContextSetupError extends Error {}

export function normalizeAiContextOptions(options: AiContextOptions): AiContextOptions {
  const contextPath = normalizeRelativePath(options.contextPath ?? ".ai", "context path");
  if (contextPath === ".") throw new AiContextSetupError("AI context setup requires the context path to be a directory below the workspace root.");
  const projects = options.projects.map((project) => ({
    id: normalizeProjectId(requireText(project.id, "project ID")),
    path: normalizeRelativePath(project.path, "project path"),
    scope: requireText(project.scope, "project scope"),
    ...(project.status ? { status: project.status } : {}),
  }));
  for (const project of options.projects) {
    if (project.status !== undefined && project.status !== "active" && project.status !== "held") {
      throw new AiContextSetupError(`AI context setup requires project status to be active or held.`);
    }
  }
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const project of projects) {
    if (ids.has(project.id)) throw new AiContextSetupError(`AI context setup requires unique project IDs: ${project.id}.`);
    if (paths.has(project.path)) throw new AiContextSetupError(`AI context setup requires unique project paths: ${project.path}.`);
    ids.add(project.id);
    paths.add(project.path);
  }
  for (let index = 0; index < projects.length; index++) {
    for (let other = index + 1; other < projects.length; other++) {
      if (isPathWithin(projects[index].path, projects[other].path) || isPathWithin(projects[other].path, projects[index].path)) {
        throw new AiContextSetupError(`AI context setup does not allow overlapping project paths: ${projects[index].path} and ${projects[other].path}.`);
      }
    }
  }
  return {
    workspaceName: requireText(options.workspaceName, "workspace name"),
    workspacePurpose: requireText(options.workspacePurpose, "workspace purpose"),
    contextPath,
    projects,
  };
}

export function normalizeRelativePath(value: string, label: string): string {
  const input = requireText(value, label);
  if (input.includes("\\") || posix.isAbsolute(input) || /^[A-Za-z]:\//.test(input)) throw new AiContextSetupError(`AI context setup requires a POSIX relative ${label}.`);
  const normalized = posix.normalize(input);
  if (normalized === ".." || normalized.startsWith("../")) throw new AiContextSetupError(`AI context setup rejects traversal in ${label}.`);
  return normalized === "." ? "." : normalized.replace(/^\.\//, "");
}

export function normalizeProjectId(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-+|-+$/g, "") || "project";
}

function isPathWithin(parent: string, child: string): boolean {
  return parent !== child && (parent === "." || child.startsWith(`${parent}/`));
}

function requireText(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new AiContextSetupError(`AI context setup requires a non-empty ${label}.`);
  return trimmed;
}
