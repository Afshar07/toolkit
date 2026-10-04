import type { AiContextOptions } from "./model.js";
import { AiContextSetupError, normalizeAiContextOptions } from "./model.js";
import { contextMaintenanceMarkdown, delegationMarkdown, engineeringMarkdown, localProjectReadmeMarkdown, ongoingReadmeMarkdown, projectGuidanceMarkdown, readmeMarkdown, rootAgentsMarkdown, technicalDebtReadmeMarkdown, technicalDebtTemplateMarkdown, workspaceMarkdown } from "./templates.js";
import { projectLocalIndexPath, projectOngoingIndexPath } from "./path.js";

export interface ContextPlanFile { relativePath: string; content: string }

export function createAiContextPlan(input: AiContextOptions): ContextPlanFile[] {
  const options = normalizeAiContextOptions(input);
  const contextPath = options.contextPath ?? ".ai";
  const files: ContextPlanFile[] = [
    { relativePath: "AGENTS.md", content: rootAgentsMarkdown(options.workspaceName, { ...options, contextPath }) },
    { relativePath: `${contextPath}/README.md`, content: readmeMarkdown({ ...options, contextPath }) },
    { relativePath: `${contextPath}/workspace.md`, content: workspaceMarkdown({ ...options, contextPath }) },
    { relativePath: `${contextPath}/engineering-conventions.md`, content: engineeringMarkdown() },
    { relativePath: `${contextPath}/policies/delegation.md`, content: delegationMarkdown() },
    { relativePath: `${contextPath}/policies/context-maintenance.md`, content: contextMaintenanceMarkdown() },
    { relativePath: `${contextPath}/technical-debt/README.md`, content: technicalDebtReadmeMarkdown() },
    { relativePath: `${contextPath}/technical-debt/TEMPLATE.md`, content: technicalDebtTemplateMarkdown() },
  ];
  for (const project of options.projects) {
    files.push({ relativePath: `${contextPath}/projects/${project.id}.md`, content: projectGuidanceMarkdown(project) });
    if (project.status === "held") continue;
    const local = projectLocalIndexPath(project, contextPath);
    if (local !== `${contextPath}/README.md`) {
      files.push({ relativePath: local, content: localProjectReadmeMarkdown(project) });
    }
    files.push({ relativePath: projectOngoingIndexPath(project, contextPath), content: ongoingReadmeMarkdown() });
  }
  const paths = files.map((file) => file.relativePath);
  const duplicate = paths.find((file, index) => paths.indexOf(file) !== index);
  if (duplicate) throw new AiContextSetupError(`AI context plan contains duplicate output path: ${duplicate}`);
  return files;
}
