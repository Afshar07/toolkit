import type { AiContextOptions, AiContextProject } from "./model.js";

export function rootAgentsMarkdown(name: string, options: AiContextOptions): string {
  const active = options.projects.filter((project) => project.status !== "held");
  const rows = active.map((project) => `| ${project.id} | \`${project.path}\` | \`${project.path === "." ? `${options.contextPath}/README.md` : `${project.path}/.ai/README.md`}\` | \`${options.contextPath}/projects/${project.id}.md\` |`).join("\n") || "| None | — | — | — |";
  return `# ${name} Agent Router

This file is the stable entry point for AI-assisted work in this workspace. Markdown context is authoritative.

## First time in this workspace

This workspace uses routed Markdown context. Do not read every \`.ai/\` file.

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
  return `# Context routing

Markdown files in this directory are authoritative. Read \`workspace.md\` before routing. Read engineering conventions only when the task makes them applicable.

## How this context is organized

- \`workspace.md\` defines workspace purpose and stable boundaries.
- \`projects/\` defines shared ownership for each project.
- \`policies/\` defines reusable conditional rules.
- \`domains/\`, when present, defines cross-project contracts.
- Each project's \`.ai/README.md\` selects focused task guidance.

Do not load every document. Follow \`AGENTS.md\`.

## Active projects

| ID | Path | Guidance |
| --- | --- | --- |
${active.map((project) => `| ${project.id} | \`${project.path}\` | \`${options.contextPath}/projects/${project.id}.md\` |`).join("\n") || "| None | — | — |"}

## Held projects

${held.map((project) => `- **${project.id}** (\`${project.path}\`): ${project.scope}`).join("\n") || "- None."}
${rootProject ? `
## ${rootProject.id} local context

${rootProject.scope}

## First time in this project

This is this project's task router. When the workspace router selected this project, choose the narrowest route below and read it in its listed order. When no route applies, inspect the requested source file directly.

Add task routes here when a real project boundary appears. When working directly in this project, start here immediately, then fall back directly to the named source when no narrower route applies. In a deferred workspace session, this README is the selected local index after the root router matches this project. Do not browse every file in \`.ai\` or read held-project context.` : ""}
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
- Do not introduce generated JSON, ongoing-task, or history directories into this scaffold.
`; }

export function projectGuidanceMarkdown(project: AiContextProject): string { return `# ${project.id}

## Scope

${project.scope}

## Ownership boundaries

- This project owns its implementation details and local conventions.
- Cross-project contracts belong in shared workspace context.
`;
}

export function localProjectReadmeMarkdown(project: AiContextProject): string { return `# ${project.id} local context

## Scope

${project.scope}

## First time in this project

This is this project's task router. When the workspace router selected this project, choose the narrowest route below and read it in its listed order. When no route applies, inspect the requested source file directly.

Add task routes here when a real project boundary appears. When working directly in this project, start here immediately, then fall back directly to the named source when no narrower route applies. In a deferred workspace session, read this file only after the root router selects this project. Do not browse every file in \`.ai\`.

## Verification

- Document this project's package manager and targeted verification commands here.
`; }
