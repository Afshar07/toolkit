# Architecture

```text
src/
├── cli.ts             # Citty command registration
├── commands/          # Citty + Clack interactive presentation layer
├── context/           # Generates AI context and routing files; no CLI dependency
├── scanner/           # Inspects Git workspaces; no CLI dependency
├── workspace/         # Manifest schema, validation, and discovery
├── setup/             # Safe directory creation and bounded Git cloning
└── doctor/            # Read-only prerequisite checks
```

- Keep Citty and Clack in `commands/`; core modules must remain usable without a CLI.
- The `context` module creates an `AGENTS.md` entry point and `.ai/` routing system without overwriting existing paths.
- Manifests are declarative recipes: relative repository paths, named remotes with an explicit clone selection, and empty normal directories. Never copy source, generated files, credentials, or `.git` data.
- Use `pathe` for portable path normalization. Validate manifest paths before setup so they cannot escape the workspace root.
- Setup never overwrites an existing destination. Clone at most three repositories concurrently; continue other clones when one fails.
- Tests mirror source concerns under `tests/` and use temporary Git repositories.
