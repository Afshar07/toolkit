# toolkit Agent Router

This file is the stable entry point for AI-assisted work in this workspace. Detailed routes live in `.ai/context.json`.

## Before working

1. Read `.ai/context.json`.
2. Read every file in `alwaysRead`, in listed order.
3. Identify the active project from the working directory, user-requested paths, and each project's `match` hints. Read only the matching project's index.
4. Evaluate `routes` against the task. Read only routes whose `readWhen` conditions apply, then follow narrower routes in those documents. Skip an `archived` route unless the task explicitly requires historical recovery or investigation.
5. Inspect an exact user-named file before broad discovery.
6. Read `.ai/ongoing/current.md`. When it names an ongoing task, read that task's note before continuing its work.

If no project matches, continue only when the task is clearly workspace-level. If several projects match and the choice changes the work, ask which project is in scope.

## Delegation

- The lead owns requirements, engineering decisions, context selection, and the final result.
- Use `agentRoutes` to choose a worker role. Delegation is optional, not mandatory.
- Give a worker selected context, paths, constraints, acceptance criteria, and verification requirements. Do not tell it to rediscover the entire `.ai/` tree.
- Review all worker changes and verification results before reporting completion.

## Context boundaries

- `authoritative` guidance defines a shared contract.
- `local-delta` guidance may add project-specific rules but may not silently override an authoritative contract.
- `reference` guidance is supporting information, not a contract.
- `historical` guidance is read only for continuation, recovery, or an explicit historical investigation.
- Do not load every `.ai/` document by default.
- Resolve paths relative to the active workspace. Do not assume machine-specific absolute paths.
- Preserve unrelated changes and do not run Git commands unless explicitly requested.
