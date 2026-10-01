# Architecture

```text
src/
├── cli.ts             # Citty command registration
├── commands/          # Citty + Clack interactive presentation layer
├── agents/            # Canonical reusable agents, ownership metadata, and safe synchronization
├── registry/          # Machine-wide sparse Git registry paths, refresh, and canonical source selection
├── context/           # Generates AI context and routing files; no CLI dependency
├── scanner/           # Inspects Git workspaces; no CLI dependency
├── workspace/         # Manifest schema, validation, and discovery
├── setup/             # Safe directory creation and bounded Git cloning
└── doctor/            # Read-only prerequisite checks
```

- Keep Citty and Clack in `commands/`; core modules must remain usable without a CLI.
- Keep reusable agent behavior in the root `agents/` registry, separate from
  repository knowledge in `.ai`; `src/registry/` owns the machine-wide sparse
  Git checkout and `src/agents/` owns canonical loading and safe project
  synchronization. The packaged root agents remain an explicit offline fallback.
  Project installation state lives in `.toolkit/agents.json`, and unowned files
  are never modified.
- The `context` module creates an `AGENTS.md` entry point and `.ai/` routing
  system. Existing files are preserved unless replacement is explicitly selected;
  every replacement is backed up.
- Context commands are exposed as `toolkit context init`, `toolkit context sync`,
  `toolkit context diff`, `toolkit context validate`, and
  `toolkit context agents`. Generated routes remain manually maintained
  Markdown; sync updates only unmodified Toolkit-managed files unless replacement
  is explicitly approved.
- Manifests are declarative recipes: an optional explicit root repository or relative repository paths, named remotes with an explicit clone selection, and empty normal directories. Never copy source, generated files, credentials, or `.git` data.
- Use `pathe` for portable path normalization. Validate manifest paths before setup so they cannot escape the workspace root.
- Setup never overwrites an existing destination. Clone at most three repositories concurrently; continue other clones when one fails.
- Tests mirror source concerns under `tests/` and use temporary Git repositories.
