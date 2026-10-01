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
  repository knowledge in `.ai`.
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

## Toolkit agent distribution

Keep these layers distinct:

```text
normal Toolkit development clone / agents/
                 ↓ Git push and sparse checkout
machine registry / ~/.toolkit/registry/agents/
                 ↓ canonical loading
project synchronization / src/agents/sync.ts
                 ↓ current target adapter
project / .opencode/agents/

project ownership state / .toolkit/agents.json
```

- `agents/` in the Toolkit repository is the authoring source for canonical
  definitions. Its manifest determines membership dynamically; the current names
  are not a fixed architectural list.
- `src/registry/*` owns the single machine-wide, sparse Git checkout, including
  initialization, refresh, paths, and Git safety.
- `src/agents/registry.ts` validates and loads an `agents/` directory without
  knowing how it was acquired.
- `src/agents/sync.ts` compares canonical definitions with project files and the
  separate ownership manifest at `.toolkit/agents.json`.
- `.opencode/agents/` is the current installation target. The canonical Toolkit
  agent registry is not an OpenCode-specific concept; do not couple definitions
  or Git distribution to this adapter/location.
- The npm package includes `agents/` as a bootstrap/offline fallback. Normal
  operation prefers a valid machine Git registry so agent-only changes can ship
  without publishing the CLI. The fallback is not an independently authored
  second registry.

### Ownership invariants

Content hashes, not registry versions, prove whether Toolkit may replace a file.
Preserve these states and behaviors:

- **Managed:** `.toolkit/agents.json` records Toolkit ownership. An unchanged
  file may be updated, and a missing managed file may be restored.
- **Local:** Toolkit has no ownership record. Leave the file alone.
- **Override:** the project deliberately owns a canonical-name agent. Leave it
  alone until the user explicitly returns it to Toolkit management.
- **Modified managed file:** its content differs from the installed hash.
  Preserve it unless replacement is explicitly authorized.
- **Unmanaged collision:** a canonical filename exists without ownership
  metadata. Never infer ownership from the filename or content.

Returning an existing file to management is destructive and the lower-level API
must continue to require explicit `replaceExisting: true`; CLI confirmation or
`--yes` is not a substitute for weakening that API boundary. If Toolkit cannot
prove ownership, it must not silently overwrite or delete the file.

Canonical removal is deliberately conservative. If a name disappears from a
future registry manifest, historical ownership does not authorize automatic
project-file deletion. Design explicit removal semantics before adding any such
behavior. Project-specific files can coexist with managed files under
`.opencode/agents/` and remain untouched.

### Machine registry invariants

- Use one registry per machine (conceptually `~/.toolkit/registry`), not one clone
  per project. It is a Toolkit-managed distribution cache, not an authoring
  checkout.
- Initialization stays transactional in this order: clone to a temporary
  checkout, configure sparse checkout, check out, validate the canonical
  registry, re-check that the destination is absent, then promote. Clean up the
  temporary checkout after every pre-promotion failure.
- Preserve unknown existing filesystem state. Regular files, symlinks, unrelated
  directories, and invalid Git registries at the destination are errors, not
  candidates for automatic repair or deletion.
- Refresh only a clean registry and use fast-forward-only Git behavior. Never
  add automatic merge, rebase, hard reset, forced checkout, stash, or clean.
  Dirty or diverged state must stop automatic project synchronization.
- A clean, already validated registry may remain usable with a warning when its
  remote is unavailable. That is different from ambiguous local modifications.
- Status paths are offline: they may inspect local files and local Git metadata,
  but must not fetch, pull, clone, or otherwise contact a remote.

### Authoring and tests

Change a canonical agent in a normal Toolkit clone: edit `agents/<name>.md`,
update `agents/manifest.json` when membership or its human-readable version
changes, run tests, then commit and push. Never author changes in
`~/.toolkit/registry`; another machine receives them with `toolkit agents update`.

Registry and synchronization tests should prefer real temporary filesystems,
temporary Git repositories, local bare remotes, and an injected temporary home.
They must not contact GitHub, write the user's `~/.toolkit`, change global Git
configuration, or depend on the developer's working tree. Configure Git identity
locally in each fixture. Keep path handling portable, avoid shell-only Git
assumptions, and skip only genuinely platform-specific symlink cases on Windows.

`npm run verify` is the release-confidence gate: it builds TypeScript before
running domain, real-Git, compiled-CLI, packed-artifact, and clean-consumer tests.
CI runs this same command on Ubuntu and Windows; package tests must exercise only
the supported public exports and assets present in the npm tarball.
