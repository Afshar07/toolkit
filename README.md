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

toolkit registry init
toolkit registry status
toolkit registry update
```

`scan` is interactive by default. A supplied workspace, name, or output skips that prompt. It records a root Git repository when the workspace itself is a repository, otherwise discovers child Git repositories using relative paths. Every discovered remote is recorded; `origin` is selected for cloning when available, and Toolkit asks you to choose when multiple remotes exist without an `origin`.

Recipes also record package-manager lockfile hints, Node-version hints, and standalone structural or empty directories where applicable. Generated, sensitive, and machine-specific directories (such as `.git`, `node_modules`, `.nuxt`, `dist`, and IDE caches) are ignored.

Recipe names are portable single directory names: they may contain ordinary human-readable characters and spaces, but not path separators, absolute or drive-qualified paths, or `.`/`..`. Git remote URLs must not embed HTTP(S) usernames, passwords, tokens, or credential-like query parameters. Use SSH (including normal addresses such as `git@github.com:owner/repo.git`) or a Git credential manager instead. Toolkit rejects an unsafe remote rather than stripping credentials and producing a recipe that may not authenticate.

`setup` is interactive by default; a supplied manifest or destination skips the matching prompt. It recreates declared directories and clones repositories without installing dependencies. Existing destinations are validated as matching Git repositories and skipped; non-matching repositories or other existing content are reported as conflicts and never overwritten. If the selected clone remote fails, interactive setup can retry another recorded remote and updates the recipe’s selection after a successful fallback clone. If a secondary remote cannot be configured, the successful clone is kept and the setup error names the repository and remote.

All planned project-relative writes are checked before content is created. Existing symbolic links or Windows junctions in a workspace path, agent destination, or context-backup path are rejected when they could redirect writes; target-file links are never overwritten. Explicit destinations remain user-selected roots, while children declared by a recipe must stay within the selected root. Toolkit rechecks paths near writes, but—as with ordinary filesystem tools—these checks do not claim complete protection against a privileged process racing filesystem changes.

`doctor` checks Git, Node, and recorded package managers. Node compatibility is checked only for exact `major.minor.patch` hints (with an optional `v`); ranges and major-only hints remain advisory.

`context init` creates an `AGENTS.md` entry point and a routed `.ai/` Markdown context structure for the current workspace. Markdown context is authoritative: `AGENTS.md` selects a project, each local `.ai/README.md` selects the narrowest task route, and `ongoing/README.md` indexes only tasks that must persist across sessions. Existing files are kept by default and are replaced only after explicit approval with backups.

Run `toolkit context init` without arguments for a preflight plan and interactive conflict choices. Existing files can be kept while missing files are created, reviewed individually, or explicitly replaced with timestamped backups. Generated Markdown carries a small ownership hash so `context sync` can distinguish an unchanged Toolkit file from one edited by a person. Use `context sync` to update unmodified Toolkit-managed files and `context diff` or `--dry-run` to preview without writing.

For new workspaces in scripts, supply the destination and all context flags with `--non-interactive`; sync and diff can infer values from an existing generated router. Conflicts abort by default. Select `--on-conflict=skip` to keep existing files or `--on-conflict=replace --backup` to replace them safely. Supported policies are `abort`, `skip`, `replace`, and `prompt`; `prompt` is interactive only.

`context validate` checks that the Markdown context entry point and referenced structure are present without changing files. `context agents` creates the currently bundled personal OpenCode agent files in either the workspace or global OpenCode agents directory, also without overwriting existing files.

The generated structure includes shared workspace guidance under `.ai/`, project guidance under `.ai/projects/`, project-local indexes, and an indexed `ongoing/` directory for each active project. Project and ongoing-task routes are intentionally maintained in Markdown; Toolkit does not infer or rewrite them after initialization.

## Canonical agents

Canonical definitions live under `agents/`, with their membership and
human-readable set version in `agents/manifest.json`. The current registry
includes `lead`, `coder`, `researcher`, and `external-researcher`, but the
manifest can add or remove names over time. Agent definitions have a lifecycle
independent from the npm CLI:

```text
GitHub Afshar07/toolkit/agents
              ↓ sparse Git checkout
      ~/.toolkit/registry/agents
              ↓ safe synchronization
       project/.opencode/agents
```

The user data path is resolved with Node's platform APIs, so the conceptual
`~/.toolkit/registry` location works on Linux and Windows. Every project on a
machine consumes this one local registry; projects are not separate Toolkit
clones. The npm package still contains bundled definitions as an explicit
bootstrap/offline fallback.

From a project root, inspect and apply agent updates with:

```sh
toolkit agents status
toolkit agents update
```

`agents status` is entirely local and offline. It compares the project with the
machine registry immediately and never fetches from GitHub. If the Git registry
has not been initialized, status clearly identifies the bundled fallback and
points to `registry init` or `agents update`.

`agents update` is the normal convenience workflow. It lazily initializes the
sparse registry when needed, otherwise performs a clean fast-forward-only Git
update, validates `agents/manifest.json`, and then runs the existing safe project
synchronization. If the remote is unavailable but the existing registry is valid
and clean, Toolkit warns and uses its existing commit. If first-time
initialization cannot reach GitHub, Toolkit warns and uses the bundled
definitions. A dirty, invalid, or diverged registry stops the update and is never
reset, merged, rebased, deleted, or silently replaced.

For explicit registry management:

```sh
toolkit registry init     # create and validate the sparse checkout
toolkit registry status   # local/offline path, version, commit, branch, cleanliness
toolkit registry update   # require a clean tree and fast-forward only
```

The registry is a distribution cache, not an editing checkout. Edit canonical
agents in a normal development clone. For example, on a work computer:

```sh
cd ~/projects/toolkit
$EDITOR agents/lead.md
git add agents/lead.md
git commit -m "refine lead planning behavior"
git push
```

Then, on another computer and inside any project, run:

```sh
toolkit agents update
```

The latest definition is fetched and distributed with the same ownership-hash
protections. No npm publication or CLI update is required for agent-only changes;
changes to Toolkit code under `src/` still require a normal npm CLI release.

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

Toolkit therefore does not own everything in `.opencode/agents/`. A project can
mix Toolkit-managed and project-local agents, for example:

```text
.opencode/agents/
├── lead.md                   Toolkit-managed
├── coder.md                  Toolkit-managed
├── migration-specialist.md   project-local
└── backend-reviewer.md        project-local
```

Updates ignore the project-local files. If a future canonical registry contains
the same name, Toolkit reports an unmanaged collision instead of claiming or
overwriting the file.

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

## Release verification

Run `npm run verify` before release. It compiles TypeScript, runs the fast domain
suite and real local-Git integration tests, exercises the compiled CLI, packs the
actual npm artifact, installs it into a temporary consumer, and verifies both the
public API and bundled-agent fallback. Automated tests use temporary local bare
remotes and never depend on GitHub or the user's Toolkit home.

GitHub Actions runs the full Ubuntu and Windows matrix for pull requests and for pushes to `main`; feature-branch pushes do not start a duplicate push run. Superseded pull-request verification is cancelled. A release uses the successful complete `Verify` workflow for the exact tagged commit's `main` push rather than running the suite again.

## Publishing a release

1. Update the version in `package.json` (and its lockfile entry) and merge the
   change to `main`.
2. Create and publish a GitHub Release with a matching tag, such as `v1.1.0` for
   package version `1.1.0`.
3. Publishing the release triggers `.github/workflows/publish.yml`. It resolves
   annotated or lightweight tags to a commit, requires that commit in `main`'s
   history, and waits (for a bounded period) for the latest exact-SHA `Verify`
   push run. Missing, failed, cancelled, skipped, or timed-out verification stops
   publication. After the qualifying verification is available, re-run the
   failed Publish workflow from GitHub Actions rather than moving the tag.
4. A preparation job validates the tag against `package.json`, builds, and packs
   that exact checkout. A separate OIDC-enabled job downloads the immutable
   workflow artifact and publishes that tarball without rebuilding it or running
   package lifecycle scripts.
5. npm authenticates the publish through Trusted Publishing (OIDC); no npm
   publishing token or automated OTP is used.

Before the first release, configure the package's trusted publisher on npm with
these GitHub Actions settings:

```text
GitHub owner: Afshar07
Repository:   toolkit
Workflow:     publish.yml
```

This npm-side configuration is an external setup step and cannot be established
by committing the workflow. Keep npm account 2FA enabled and do not create an
`NPM_TOKEN` for this workflow.

The source repository is private while `@afshar7/toolkit` is public. Treat every
file selected by `package.json#files` as public: the package contains only the
compiled `dist/` output and bundled `agents/`, not `.ai` context, tests, Git
metadata, workspace recipes, or local credentials. The workflow does not claim
npm provenance from the private repository. Administrators must separately
configure the npm trusted publisher, keep account 2FA enabled, and enforce the
desired GitHub default-branch and tag/release protections; workflows cannot
prove those external settings exist.
