import type { AiContextProject } from "./model.js";

export { normalizeRelativePath, normalizeProjectId } from "./model.js";

export function projectLocalIndexPath(project: AiContextProject, contextPath: string): string {
  return project.path === "." ? `${contextPath}/README.md` : `${project.path}/.ai/README.md`;
}

export function projectOngoingIndexPath(project: AiContextProject, contextPath: string): string {
  return project.path === "." ? `${contextPath}/ongoing/README.md` : `${project.path}/.ai/ongoing/README.md`;
}
