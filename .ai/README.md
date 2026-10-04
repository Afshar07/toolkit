# .ai/ - Project Context for AI Agents

At workspace-router step 3, select one route below; defer its documents until
step 7, then follow the route exactly in order.

## Files

| File | Read when you're... |
| --- | --- |
| `ongoing/README.md` | continuing an in-progress task; read only the matching task document |
| `technical-debt/README.md` | recording, reviewing, or resolving technical debt; read only the matching debt record |
| `projects/architecture.md` | changing source layout, module boundaries, CLI integration, context generation, agent lifecycle, setup, scanning, doctor, CI, or releases |

## Rules

- This folder is the local source of truth for AI task context in `toolkit`.
- Keep these files updated when conventions or project-specific decisions change.
- Read only files selected by the applicable task route or named directly by the
  user.

## Task routes

- AI context generation, validation, routing, or agent setup:
  `projects/architecture.md` → source.
- Workspace manifest, scanning, setup, doctor, or CLI integration:
  `projects/architecture.md` → source.
- Agent distribution, synchronization, or publication:
  `projects/architecture.md` → source.
- CI, release automation, or npm publication:
  `projects/architecture.md` → `scripts/` and applicable workflows/tests.
- Continuing in-progress work: `ongoing/README.md` → only the matching task
  document → source.
- Other project work: source named by the task.

Do not read an ongoing task, policy, or unrelated focused context unless the task
changes that concern or contract.
