import { readFile, realpath } from "node:fs/promises";
import * as nodePath from "node:path";
import * as path from "pathe";

export type ContextValidationSeverity = "error" | "warning";
export interface ContextValidationIssue {
  severity: ContextValidationSeverity;
  code: string;
  message: string;
  path?: string;
}
export interface ContextValidationResult {
  valid: boolean;
  issues: ContextValidationIssue[];
  entrypoint: string;
  projects: Array<{ id: string; path: string; localIndex: string; guidance: string }>;
}

/** Validate the generated, stable Markdown routing contract without writing files. */
export async function validateAiContext(destination = "."): Promise<ContextValidationResult> {
  const root = path.resolve(destination);
  const rootReal = await realpath(root);
  const issues: ContextValidationIssue[] = [];
  const entrypoint = path.join(root, "AGENTS.md");
  const projects: ContextValidationResult["projects"] = [];
  const checkedReferences = new Set<string>();
  const check = async (reference: string, code: string): Promise<void> => {
    if (checkedReferences.has(reference)) return;
    checkedReferences.add(reference);
    await checkReference(root, rootReal, reference, issues, code);
  };
  const agents = await readText(entrypoint);
  if (agents === undefined) {
    issues.push(issue("error", "missing-entrypoint", "AGENTS.md does not exist.", "AGENTS.md"));
    return { valid: false, issues, entrypoint, projects };
  }

  const tableStart = agents.indexOf("## Project routing table");
  if (tableStart < 0) issues.push(issue("error", "missing-routing-table", "AGENTS.md has no supported project routing table.", "AGENTS.md"));
  const table = tableStart < 0 ? "" : agents.slice(tableStart, agents.indexOf("\n## ", tableStart + 4) < 0 ? undefined : agents.indexOf("\n## ", tableStart + 4));
  const rows = table.split("\n").slice(4).filter((line) => line.startsWith("|") && !line.includes("---") && !line.includes("None"));
  if (!rows.length) issues.push(issue("warning", "no-projects", "The routing table contains no active project rows.", "AGENTS.md"));
  for (const row of rows) {
    const cells = row.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length !== 4) {
      issues.push(issue("error", "malformed-project-row", "A project routing row does not have the expected columns.", "AGENTS.md"));
      continue;
    }
    const id = cells[0];
    const projectPath = fencedValue(cells[1]);
    const localIndex = fencedValue(cells[2]);
    const guidance = fencedValue(cells[3]);
    if (!id || !projectPath || !localIndex || !guidance || projectPath === "—") {
      issues.push(issue("error", "malformed-project-row", `Project row for ${id || "unknown"} has invalid references.`, "AGENTS.md"));
      continue;
    }
    projects.push({ id, path: projectPath, localIndex, guidance });
    await check(projectPath, "unsafe-project-path");
    await check(localIndex, "missing-local-index");
    await check(path.join(path.dirname(localIndex), "ongoing/README.md"), "missing-ongoing-index");
    await check(guidance, "missing-project-guidance");
  }

  const routingReferences = new Set(projects.flatMap((project) => [project.path, project.localIndex, project.guidance]));
  const references = [...new Set([...agents.matchAll(/`([^`]+)`/g)].map((match) => match[1]))];
  for (const reference of references) {
    if (reference === "AGENTS.md" || reference === ".ai" || reference === ".ai/" || routingReferences.has(reference)
      || (reference.endsWith("/**") && routingReferences.has(reference.slice(0, -3)))) continue;
    await check(reference, "missing-shared-reference");
  }
  const workspaceReference = references.find((reference) => reference.endsWith("/workspace.md"));
  if (workspaceReference) {
    const contextPath = workspaceReference.slice(0, -"/workspace.md".length);
    const sharedReferences = [
      `${contextPath}/engineering-conventions.md`,
      `${contextPath}/policies/delegation.md`,
      `${contextPath}/policies/context-maintenance.md`,
    ];
    sharedReferences.unshift(`${contextPath}/README.md`);
    for (const reference of sharedReferences) await check(reference, "missing-shared-reference");
  }
  return { valid: !issues.some((item) => item.severity === "error"), issues, entrypoint, projects };
}

function fencedValue(value: string): string { return value.match(/^`([^`]+)`$/)?.[1] ?? ""; }
function issue(severity: ContextValidationSeverity, code: string, message: string, relativePath?: string): ContextValidationIssue {
  return { severity, code, message, ...(relativePath ? { path: relativePath } : {}) };
}
async function readText(filePath: string): Promise<string | undefined> {
  try { return await readFile(filePath, "utf8"); } catch { return undefined; }
}
async function checkReference(root: string, rootReal: string, reference: string, issues: ContextValidationIssue[], code: string): Promise<void> {
  const relative = reference.replaceAll("\\", "/");
  if (relative.startsWith("/") || relative.includes("..")) {
    issues.push(issue("error", code, `Reference escapes the workspace: ${reference}`, reference));
    return;
  }
  const target = path.resolve(root, relative);
  try {
    const targetReal = await realpath(target);
    const relativeToRoot = nodePath.relative(rootReal, targetReal);
    if (relativeToRoot !== "" && (relativeToRoot === ".." || relativeToRoot.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(relativeToRoot))) {
      throw new Error("outside");
    }
  } catch {
    issues.push(issue("error", code, `Referenced file does not exist or is outside the workspace: ${reference}`, reference));
  }
}
