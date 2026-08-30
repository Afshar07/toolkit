import { lstat, mkdir, writeFile } from "node:fs/promises";
import * as path from "pathe";

export interface AiContextOptions {
  workspaceName: string;
  workspacePurpose: string;
  projectId: string;
  projectScope: string;
}

export class AiContextSetupError extends Error {}

export async function setupAiContext(destination: string, options: AiContextOptions): Promise<string[]> {
  const root = path.resolve(destination);
  await requireDirectory(root);
  const files = createFiles(normalizeOptions(options));
  const conflicts = await Promise.all([
    pathExists(path.join(root, "AGENTS.md")),
    pathExists(path.join(root, ".ai")),
  ]);
  if (conflicts[0] || conflicts[1]) {
    const existing = [conflicts[0] ? "AGENTS.md" : undefined, conflicts[1] ? ".ai" : undefined]
      .filter((entry): entry is string => entry !== undefined);
    throw new AiContextSetupError(`AI context setup stopped: ${existing.join(" and ")} already exists.`);
  }

  await mkdir(path.join(root, ".ai", "projects"), { recursive: true });
  await mkdir(path.join(root, ".ai", "policies"), { recursive: true });
  await mkdir(path.join(root, ".ai", "domains"));
  await mkdir(path.join(root, ".ai", "history"));
  await mkdir(path.join(root, ".ai", "ongoing"));
  await Promise.all(files.map(async ({ relativePath, content }) => {
    await writeFile(path.join(root, relativePath), content, "utf8");
  }));
  return files.map(({ relativePath }) => relativePath);
}

export function defaultAiContextOptions(destination: string): AiContextOptions {
  const name = path.basename(path.resolve(destination));
  return {
    workspaceName: name,
    workspacePurpose: "Describe this workspace's purpose.",
    projectId: toProjectId(name),
    projectScope: "Primary project in this workspace.",
  };
}

function createFiles(options: AiContextOptions): Array<{ relativePath: string; content: string }> {
  const projectPath = `.ai/projects/${options.projectId}.md`;
  const context = {
    schemaVersion: 1,
    workspace: options.workspaceName,
    alwaysRead: [".ai/workspace.md"],
    projects: [{
      id: options.projectId,
      scope: options.projectScope,
      match: ["."],
      read: [projectPath],
      status: "active",
    }],
    routes: [
      {
        id: "engineering-conventions",
        kind: "policy",
        scope: "Shared coding, documentation, and verification conventions.",
        readWhen: ["Writing or changing code, tests, configuration, or documentation.", "Planning or performing verification."],
        read: [".ai/engineering-conventions.md"],
        authority: "authoritative",
        status: "active",
      },
      {
        id: "delegation",
        kind: "policy",
        scope: "Worker selection, context handoff, and review responsibilities.",
        readWhen: ["Assigning or performing delegated work."],
        read: [".ai/policies/delegation.md"],
        authority: "authoritative",
        status: "conditional",
      },
    ],
    agentRoutes: [
      {
        id: "researcher",
        useWhen: ["Broad local discovery, code tracing, or evidence gathering is needed."],
        doNotUseWhen: ["The exact file and required change are already known."],
        policy: ".ai/policies/delegation.md",
      },
      {
        id: "coder",
        useWhen: ["A tightly scoped implementation can be isolated with clear acceptance criteria."],
        doNotUseWhen: ["Architecture, product behavior, security, or public contracts remain undecided."],
        policy: ".ai/policies/delegation.md",
      },
    ],
  };
  return [
    { relativePath: "AGENTS.md", content: agentsMarkdown(options.workspaceName) },
    { relativePath: ".ai/context.json", content: `${JSON.stringify(context, null, 2)}\n` },
    { relativePath: ".ai/workspace.md", content: workspaceMarkdown(options) },
    { relativePath: ".ai/engineering-conventions.md", content: engineeringMarkdown() },
    { relativePath: projectPath, content: projectMarkdown(options) },
    { relativePath: ".ai/policies/delegation.md", content: delegationMarkdown() },
    { relativePath: ".ai/history/README.md", content: "# History\n\nAdd dated records here only when historical context is needed.\n" },
    { relativePath: ".ai/ongoing/README.md", content: ongoingReadmeMarkdown() },
    { relativePath: ".ai/ongoing/current.md", content: "# Current task\n\nNo ongoing task.\n" },
    { relativePath: ".ai/ongoing/TASK_TEMPLATE.md", content: ongoingTaskTemplateMarkdown() },
  ];
}

function normalizeOptions(options: AiContextOptions): AiContextOptions {
  return {
    workspaceName: requireText(options.workspaceName, "workspace name"),
    workspacePurpose: requireText(options.workspacePurpose, "workspace purpose"),
    projectId: toProjectId(requireText(options.projectId, "project ID")),
    projectScope: requireText(options.projectScope, "project scope"),
  };
}

function agentsMarkdown(workspaceName: string): string {
  return `# ${workspaceName} Agent Router

This file is the stable entry point for AI-assisted work in this workspace. Detailed routes live in \`.ai/context.json\`.

## Before working

1. Read \`.ai/context.json\`.
2. Read every file in \`alwaysRead\`, in listed order.
3. Identify the active project from the working directory, user-requested paths, and each project's \`match\` hints. Read only the matching project's index.
4. Evaluate \`routes\` against the task. Read only routes whose \`readWhen\` conditions apply, then follow narrower routes in those documents. Skip an \`archived\` route unless the task explicitly requires historical recovery or investigation.
5. Inspect an exact user-named file before broad discovery.
6. Read \`.ai/ongoing/current.md\`. When it names an ongoing task, read that task's note before continuing its work.

Only create or add tasks in \`.ai/ongoing/\` when the user explicitly asks, or when the work is large enough that it cannot reasonably be completed in one session. Otherwise, do not use ongoing-task notes.

If no project matches, continue only when the task is clearly workspace-level. If several projects match and the choice changes the work, ask which project is in scope.

## Delegation

- The lead owns requirements, engineering decisions, context selection, and the final result.
- Use \`agentRoutes\` to choose a worker role. Delegation is optional, not mandatory.
- Give a worker selected context, paths, constraints, acceptance criteria, and verification requirements. Do not tell it to rediscover the entire \`.ai/\` tree.
- Review all worker changes and verification results before reporting completion.

## Context boundaries

- \`authoritative\` guidance defines a shared contract.
- \`local-delta\` guidance may add project-specific rules but may not silently override an authoritative contract.
- \`reference\` guidance is supporting information, not a contract.
- \`historical\` guidance is read only for continuation, recovery, or an explicit historical investigation.
- Do not load every \`.ai/\` document by default.
- Resolve paths relative to the active workspace. Do not assume machine-specific absolute paths.
- Preserve unrelated changes and do not run Git commands unless explicitly requested.
`;
}

function workspaceMarkdown(options: AiContextOptions): string {
  return `# ${options.workspaceName} Workspace

## Purpose

${options.workspacePurpose}

Shared context belongs in this root. Project-specific implementation detail belongs in the owning project's index or local context.

## Working style

- Keep changes tightly scoped to the requested project and paths.
- Read selected context before editing code.
- Prefer existing project primitives and conventions.
- Do not turn style-only work into behavior changes.
- Verify changes in proportion to their risk.
`;
}

function engineeringMarkdown(): string {
  return `# Engineering Conventions

Read when writing or changing code, tests, configuration, documentation, or performing normal verification.

## Coding

- Preserve public behavior and contracts unless the task explicitly changes them.
- Prefer the simplest implementation that satisfies the acceptance criteria.
- Do not introduce abstractions or compatibility behavior without evidence.

## Verification

- Use the active project's documented package manager and commands.
- Run targeted checks for the changed boundary.
- Report environment failures separately from code failures.
- State what was and was not verified.
`;
}

function projectMarkdown(options: AiContextOptions): string {
  return `# ${options.projectId}

## Scope

${options.projectScope}

## Local context

When working directly in this project, add focused routes only when a real boundary appears. Do not load every local document by default.

## Ownership boundaries

- This project owns its implementation details and local conventions.
- Put cross-project contracts in \`.ai/domains/\` and register them in \`.ai/context.json\`.

## Verification

- Document this project's package manager and targeted verification commands here.
`;
}

function delegationMarkdown(): string {
  return `# Delegation

Read when assigning or performing delegated work.

- The lead selects applicable workspace, project, domain, and policy context before delegating.
- Delegate only when specialization, isolation, or parallel work saves meaningful effort. Handle small, clear, single-area tasks directly.
- Use a researcher for broad discovery, code tracing, and evidence with file and line references.
- Use a coder for tightly scoped implementation with settled requirements and explicit acceptance criteria.
- Assignments include relevant findings, paths, constraints, acceptance criteria, and targeted verification. Workers must not scan the entire \`.ai/\` tree.
- Workers do not run Git commands or modify unrelated files.
- The lead reviews worker changes, resolves engineering decisions, and owns final correctness.
`;
}

function ongoingReadmeMarkdown(): string {
  return `# Ongoing tasks

Use this directory for work that spans more than one session.

## Starting a long-running task

1. Copy \`TASK_TEMPLATE.md\` to a descriptive task file name, such as \`workspace-audit.md\`.
2. Update \`current.md\` to link to that note before ending the session.
3. Fill in the task's goal, acceptance criteria, current status, decisions, files under investigation, and completed and remaining verification.

## Resuming work

Read \`current.md\` first. If it links to a task note, read that note before making changes. Update the note and \`current.md\` when the active task changes or completes.
`;
}

function ongoingTaskTemplateMarkdown(): string {
  return `# <Task name>

## Session state

- **Status:** not started | in progress | blocked | complete
- **Current step:** <number and short name>
- **Next action:** <specific next action>
- **Last reviewed:** <YYYY-MM-DD>

## Goal and acceptance criteria

- <goal>
- <observable acceptance criterion>

## Scope and guardrails

- <constraint or safety boundary>
- <out-of-scope item>

## Current code map

| Concern | Source | Tests |
| --- | --- | --- |
| <concern> | \`<path>\` | \`<path>\` |

## Implementation plan

### 1. <Step name>

1. <action>
2. <verification>

## Decision log

| Decision | Status | Rationale |
| --- | --- | --- |
| <decision> | pending | <rationale> |

## Resume checklist

1. Read this file and the selected project context.
2. Confirm the current step and working-tree status.
3. Complete only the current step and its focused verification.
4. Update this note and \`current.md\` before ending the session.

## Verification log

- <command and result>
`;
}

async function requireDirectory(filePath: string): Promise<void> {
  try {
    if ((await lstat(filePath)).isDirectory()) return;
  } catch {
    // The error below gives the caller one consistent message.
  }
  throw new AiContextSetupError(`AI context setup requires an existing directory: ${filePath}`);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

function toProjectId(name: string): string {
  return name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-+|-+$/g, "") || "project";
}

function requireText(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new AiContextSetupError(`AI context setup requires a non-empty ${label}.`);
  return trimmed;
}
