import type { AiContextOptions, AiContextProject } from "./model.js";
import { projectLocalIndexPath } from "./path.js";

export function rootAgentsMarkdown(name: string, options: AiContextOptions): string {
  const active = options.projects.filter((project) => project.status !== "held");
  const contextPath = options.contextPath ?? ".ai";
  const rows = active.map((project) => `| ${project.id} | \`${project.path}\` | \`${projectLocalIndexPath(project, contextPath)}\` | \`${contextPath}/projects/${project.id}.md\` |`).join("\n") || "| None | — | — | — |";
  return `# ${name} Agent Router

This file is the stable entry point for AI-assisted work in this workspace. Markdown context is authoritative.

## First time in this workspace

This workspace uses routed Markdown context. Do not read every context file.

1. Start with this file and follow the ordered protocol below.
2. Read only the project index, shared guidance, policies, and focused route selected for the task.
3. Treat routed Markdown as authoritative. Ask when no project matches or when several matches would change the work.
4. Inspect a user-named source file before broad discovery.

## Project routing table

| Project | Workspace-relative path | Local index | Shared guidance |
| --- | --- | --- | --- |
${rows}

Held projects are intentionally absent from this active routing table; their scope and boundaries remain in shared guidance.

## Ordered protocol

1. Read \`${options.contextPath}/workspace.md\`.
2. Match the requested path in the project routing table above. For a direct session, use the project containing the working directory.
3. Read **only** the selected project's local index. Choose a task route there and defer its focused documents until that route applies.
4. Read the selected project's shared guidance at the path shown above.
5. For coding, testing, configuration, documentation, or verification tasks, read \`${options.contextPath}/engineering-conventions.md\`.
6. Read only task-applicable policies.
7. Execute the selected route in its exact order, including any named domain contract.
8. Inspect an exact user-named source file before broad discovery.

If no project matches, continue only for workspace-level work; do not guess a project. If multiple projects match and the choice changes the work, ask for clarification. Do not browse all of \`${options.contextPath}\` or all local indexes.

## Boundaries

- Shared guidance defines cross-project contracts; local indexes define project-specific routes.
- Held projects are not active routes and must not be selected for ordinary work.
- Preserve unrelated changes and keep work within the selected project and requested paths.
`;
}

export function readmeMarkdown(options: AiContextOptions): string {
  const active = options.projects.filter((project) => project.status !== "held");
  const held = options.projects.filter((project) => project.status === "held");
  const rootProject = active.find((project) => project.path === ".");
  const contextPath = options.contextPath ?? ".ai";
  if (rootProject) return `# ${contextPath}/ - Project Context for AI Agents

At workspace-router step 3, select one route below; defer its documents until
step 7, then follow the route exactly in order.

## Files

| File | Read when you're... |
| --- | --- |
| \`ongoing/README.md\` | continuing an in-progress task; read only the matching task document |
| \`technical-debt/README.md\` | locating unresolved technical debt relevant to the current work; read only the matching record |
| <!-- example.md --> | <!-- working on a focused project concern --> |

## Rules

- This folder is the local source of truth for AI task context in \`${rootProject.id}\`.
- Keep file descriptions and task routes updated when project-specific decisions or boundaries change.
- Read only the files selected by the applicable task route or an exact user-named file.

## Task routes

- Continuing in-progress work: \`ongoing/README.md\` → only the matching task document → source.
- Add focused task routes here when a real project boundary appears.
- Route format: \`local-context.md\` → optional shared/domain context → source.
- When no route applies, inspect the requested source file directly.
`;
  return `# Context routing

Markdown files in this directory are authoritative. Read \`workspace.md\` before routing. Read engineering conventions only when the task makes them applicable.

## How this context is organized

- \`workspace.md\` defines workspace purpose and stable boundaries.
- \`projects/\` defines shared ownership for each project.
- \`policies/\` defines reusable conditional rules.
- \`domains/\`, when present, defines cross-project contracts.
- \`technical-debt/README.md\` indexes unresolved technical debt; read only records relevant to the current work.
- Each active project's local index selects focused task guidance.

Do not load every document. Follow \`AGENTS.md\`.

## Active projects

| ID | Path | Guidance |
| --- | --- | --- |
${active.map((project) => `| ${project.id} | \`${project.path}\` | \`${options.contextPath}/projects/${project.id}.md\` |`).join("\n") || "| None | — | — |"}

## Held projects

${held.map((project) => `- **${project.id}** (\`${project.path}\`): ${project.scope}`).join("\n") || "- None."}
`;
}

export function workspaceMarkdown(options: AiContextOptions): string { return `# ${options.workspaceName} Workspace

## Purpose

${options.workspacePurpose}

Shared context belongs in this root. Project-specific implementation detail belongs in the owning project's local index.
`;
}

export function engineeringMarkdown(): string { return `# Engineering Conventions

- Preserve public behavior and contracts unless the task explicitly changes them.
- Prefer the simplest implementation that satisfies the acceptance criteria.
- Run targeted checks for the changed boundary and report what was not verified.
`; }

export function delegationMarkdown(): string { return `# Delegation

- The lead selects applicable context before delegating.
- Assign paths, constraints, acceptance criteria, and targeted verification.
- Workers do not scan unrelated context or modify unrelated files.
- The lead reviews worker changes and owns final correctness.
`; }

export function contextMaintenanceMarkdown(): string { return `# Context maintenance

- Keep Markdown context discoverable and authoritative.
- Update routing when project ownership, paths, or workflow boundaries change.
- Keep cross-session task state in the selected project's \`ongoing/\` directory and list each active task in its \`README.md\`.
- Read only the ongoing task matching the current work; do not use a global current-task pointer.
- Move durable decisions into focused guidance when a task finishes, then remove its ongoing entry and task document.
- Track unresolved technical debt separately from ongoing task state in the shared \`technical-debt/README.md\`; index each scoped record there and read only records relevant to the current work.
- In each debt record, date the verified evidence and inventory, describe impact and migration constraints, and define completion and verification criteria. Refresh dated evidence before implementation; recording debt does not authorize the work.
- When debt is resolved, update its index disposition and record verification in the debt record. Do not create history directories.
- Do not introduce generated routing JSON or history directories into this scaffold.
`; }

export function technicalDebtReadmeMarkdown(): string { return `# Technical Debt

This shared index lists scoped, unresolved technical debt. There are no open
debt records yet. Copy [TEMPLATE.md](TEMPLATE.md) to a descriptive filename
for each new record and add it to the index below. Update the index disposition
when a record is resolved; retain its verification in the record.

| Record | Scope | Disposition |
| --- | --- | --- |
| None | — | — |

Read only records relevant to the current work. These manually maintained
records describe debt, not instructions or shared contracts. Recording debt does
not approve implementation.
`; }

export function technicalDebtTemplateMarkdown(): string { return `# [Descriptive debt title]

- **Status:** Open
- **Verified:** YYYY-MM-DD
- **Scope/owner:** Unknown (identify the affected scope and owner if known)

## Problem

Describe the unresolved technical debt and its boundaries.

## Evidence and inventory

List dated evidence and affected paths, versions, or counts. Refresh this
inventory before implementation.

## Impact

Describe observed or likely consequences of leaving the debt unresolved.

## Migration constraints

Describe compatibility, sequencing, ownership, or other constraints.

## Completion criteria

List the conditions required to consider the debt resolved.

## Verification

Not performed. Describe the checks required and record their results when run.

## Resolution (optional)

Record disposition, date, and outcome when resolved; update the index. This
record does not authorize implementation.
`; }

export function ongoingReadmeMarkdown(): string { return `# Ongoing Tasks

Read only the task document relevant to the work being continued. Task documents
record in-progress decisions, current stages, unresolved questions, and resume
instructions.

| Task | Read when you're... |
| --- | --- |
| None | — |

Move durable conventions into the appropriate focused context document when a
task finishes, then remove its ongoing-task entry and task document.
`; }

export function projectGuidanceMarkdown(project: AiContextProject): string { return `# ${project.id}

## Scope

${project.scope}

## Ownership boundaries

- This project owns its implementation details and local conventions.
- Cross-project contracts belong in shared workspace context.
`;
}

export function localProjectReadmeMarkdown(project: AiContextProject): string { return `# .ai/ - Project Context for AI Agents

At workspace-router step 3, select one route below; defer its documents until
step 7, then follow the route exactly in order.

## Files

| File | Read when you're... |
| --- | --- |
| \`ongoing/README.md\` | continuing an in-progress task; read only the matching task document |
| <!-- example.md --> | <!-- working on a focused project concern --> |

## Rules

- This folder is the local source of truth for AI task context in \`${project.id}\`.
- Keep file descriptions and task routes updated when project-specific decisions or boundaries change.
- Read only the files selected by the applicable task route or an exact user-named file.

## Task routes

- Continuing in-progress work: \`ongoing/README.md\` → only the matching task document → source.
- Add focused task routes here when a real project boundary appears.
- Route format: \`local-context.md\` → optional shared/domain context → source.
- When no route applies, inspect the requested source file directly.

## Verification

- Document this project's package manager and targeted verification commands here.
`; }
