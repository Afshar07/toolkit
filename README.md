# @afshar7/toolkit

Toolkit creates portable **workspace recipes**: declarative manifests for reconstructing workspace structure, not backups of arbitrary local files.

```sh
toolkit scan
toolkit scan .
toolkit scan . --name my-workspace
toolkit scan . --name my-workspace --output ./my-workspace.workspace.json

toolkit setup
toolkit setup ./my-workspace.workspace.json
toolkit setup ./my-workspace.workspace.json --destination ~/work

toolkit doctor --workspace ./my-workspace.workspace.json

toolkit context init
toolkit context init --dry-run
toolkit context sync
toolkit context diff
toolkit context validate
toolkit context agents

toolkit agents status
toolkit agents update
toolkit agents override coder
toolkit agents manage coder --yes
```

`scan` is interactive by default. A supplied workspace, name, or output skips that prompt. It records a root Git repository when the workspace itself is a repository, otherwise discovers child Git repositories using relative paths. Every discovered remote is recorded; `origin` is selected for cloning when available, and Toolkit asks you to choose when multiple remotes exist without an `origin`.

Recipes also record package-manager lockfile hints, Node-version hints, and standalone structural or empty directories where applicable. Generated, sensitive, and machine-specific directories (such as `.git`, `node_modules`, `.nuxt`, `dist`, and IDE caches) are ignored.

`setup` is interactive by default; a supplied manifest or destination skips the matching prompt. It recreates declared directories and clones repositories without installing dependencies. Existing destinations are validated as matching Git repositories and skipped; non-matching repositories or other existing content are reported as conflicts and never overwritten. If the selected clone remote fails, interactive setup can retry another recorded remote and updates the recipe’s selection after a successful fallback clone. If a secondary remote cannot be configured, the successful clone is kept and the setup error names the repository and remote.

`doctor` checks Git, Node, and recorded package managers. Node compatibility is checked only for exact `major.minor.patch` hints (with an optional `v`); ranges and major-only hints remain advisory.

`context init` creates an `AGENTS.md` entry point and a routed `.ai/` Markdown context structure for the current workspace. Markdown context is authoritative: `AGENTS.md` selects a project, each local `.ai/README.md` selects the narrowest task route, and `ongoing/README.md` indexes only tasks that must persist across sessions. Existing files are kept by default and are replaced only after explicit approval with backups.

Run `toolkit context init` without arguments for a preflight plan and interactive conflict choices. Existing files can be kept while missing files are created, reviewed individually, or explicitly replaced with timestamped backups. Generated Markdown carries a small ownership hash so `context sync` can distinguish an unchanged Toolkit file from one edited by a person. Use `context sync` to update unmodified Toolkit-managed files and `context diff` or `--dry-run` to preview without writing.

For new workspaces in scripts, supply the destination and all context flags with `--non-interactive`; sync and diff can infer values from an existing generated router. Conflicts abort by default. Select `--on-conflict=skip` to keep existing files or `--on-conflict=replace --backup` to replace them safely. Supported policies are `abort`, `skip`, `replace`, and `prompt`; `prompt` is interactive only.

`context validate` checks that the Markdown context entry point and referenced structure are present without changing files. `context agents` creates the four personal OpenCode agent files in either the workspace or global OpenCode agents directory, also without overwriting existing files.

The generated structure includes shared workspace guidance under `.ai/`, project guidance under `.ai/projects/`, project-local indexes, and an indexed `ongoing/` directory for each active project. Project and ongoing-task routes are intentionally maintained in Markdown; Toolkit does not infer or rewrite them after initialization.

## Canonical agents

Toolkit ships canonical definitions for `lead`, `coder`, `researcher`, and
`external-researcher` under `agents/`, with the set version in
`agents/manifest.json`. These reusable definitions describe how an agent behaves;
they are separate from the repository knowledge and routing stored under `.ai/`.
Git synchronizes changes to Toolkit itself between computers, while the `agents`
commands safely distribute the definitions into each project's
`.opencode/agents/` directory.

From a project root, inspect and apply agent updates with:

```sh
toolkit agents status
toolkit agents update
```

The first update installs missing canonical agents and records their content
hashes in `.toolkit/agents.json`. Later updates replace a managed file only when
its current hash proves it is still the version Toolkit installed. Version labels
make status output easier to understand, but hashes are the authoritative
ownership and modification check.

Commit `.toolkit/agents.json` with the project so its managed and overridden
ownership choices are consistent for everyone using that checkout.

Agent files fall into three categories:

- **Managed:** installed and tracked by Toolkit. Unchanged files can be updated or
  restored when missing.
- **Local:** files without Toolkit ownership metadata. Toolkit reports ordinary
  local agents and never modifies or deletes them. A pre-existing file such as
  `lead.md` is also preserved rather than claimed merely because its name matches
  a canonical agent.
- **Overrides:** canonical names intentionally assigned to the project. Toolkit
  leaves their files untouched during updates.

If a managed file was edited locally, `agents status` reports it as locally
modified. `agents update` preserves it by default. In an interactive terminal,
Toolkit offers to keep it, show a diff, or explicitly use the canonical version;
`--non-interactive` always takes the safe path and reports the conflict.

To specialize a canonical agent for one project, record an override before or
after editing it:

```sh
toolkit agents override coder
$EDITOR .opencode/agents/coder.md
```

To discard the project version and return it to Toolkit management, use:

```sh
toolkit agents manage coder --yes
```

This command intentionally replaces `coder.md` with the canonical definition and
records its new ownership hash. Without `--yes`, a non-interactive invocation
refuses to make that destructive ownership change.
