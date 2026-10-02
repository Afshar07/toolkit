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
toolkit agents publish coder
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

Project agents remain the default. Use `--global` on `agents status`, `update`,
`override`, `manage`, or `publish` to select OpenCode's global Markdown definitions:

```sh
toolkit agents status --global
toolkit agents update --global
toolkit agents publish coder --global --dry-run
toolkit agents override coder --global
toolkit agents manage coder --global --yes
```

Global agents live in `$XDG_CONFIG_HOME/opencode/agents` when `XDG_CONFIG_HOME`
is nonempty and absolute, otherwise `~/.config/opencode/agents` on all platforms.
Global ownership is stored separately in that config directory's
`.toolkit/agents.json`; project ownership is unchanged. Global status is offline
and never creates a missing config directory; update safely creates it.
`--global` cannot be combined with an explicit destination (including the
positional directory on status/update). Global files follow the same hash,
collision, override, explicit replacement, and publication-baseline rules as
project files. After publication reconciliation fails, use
`toolkit agents update --global`, and if needed
`toolkit agents manage NAME --global --yes`, not a project update.

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

The registry is a distribution cache, not an editing checkout. To share an
improvement from the project where it was developed, publish that one canonical
agent through a temporary authoring checkout:

```sh
$EDITOR .opencode/agents/coder.md
toolkit agents publish coder
```

To publish all canonical agents together, use `toolkit agents publish --all`
(or `--all --global` for global OpenCode definitions). Select exactly one of a
name or `--all`. Membership comes from the upstream `agents/manifest.json`, not
local filenames. Every selected file must exist and pass ownership and conflict
checks before the combined diff and single confirmation. Only changed definitions
are committed, with one version bump and normal push; unchanged files and
unrelated local agents are not reconciled. `--include-override` and
`--allow-unmanaged` apply to every selected agent without bypassing stale baselines.
Before any local reconciliation, all changed files are rechecked for edits made
during publication. A post-push failure may leave local synchronization partial;
it does not roll back the remote publication.

Publication writes to the actual Toolkit source repository's default branch; it
never authors in `~/.toolkit/registry`. It requires Git read and direct-push
access using the user's existing credentials, but no npm token or npm release.
Use `--dry-run` for the upstream diff and proposed version without persistent
changes, or `--yes` to confirm in a non-interactive environment. `--destination`
selects another project directory.

Canonical agent definitions are LF text. Publishing converts only CRLF line
endings to LF, preserving all other content and trailing-newline behavior; an
agent differing from upstream only by CRLF versus LF has no shared change to
publish. After an actual publication, Toolkit verifies that the project file did
not change during the operation, installs the published LF bytes locally, and
records the hash of those exact installed bytes.

Then, on another computer and inside any project, run:

```sh
toolkit agents update
```

The latest definition is fetched and distributed with the same ownership-hash
protections. No npm publication or CLI update is required for agent-only changes;
changes to Toolkit code under `src/` still require a normal npm CLI release.

Publishing refuses a stale managed baseline when the same shared agent changed;
run `toolkit agents update`, reconcile that agent, and retry. Changes to other
shared agents do not conflict. An override requires `--include-override` (and is
returned to Toolkit management after success), while an unowned canonical-name
file requires `--allow-unmanaged`. These acknowledgements never bypass a known
stale baseline. Protected-branch or permission push failures are reported and
never force-pushed or converted into an automatic pull request.

If the remote push succeeds but registry refresh or ownership recording fails,
Toolkit reports “published successfully; local synchronization incomplete.” Do
not publish again: run `toolkit agents update` to refresh distribution state,
then use `toolkit agents manage NAME --yes` only if ownership still needs repair.

New temporary authoring checkouts and machine registries explicitly disable Git
checkout line-ending conversion. Existing clean registries created with
`core.autocrlf=true` remain supported without a destructive rewrite: Toolkit
interprets their validated canonical files as LF and deliberately converts
eligible unchanged project agents through the normal synchronization flow.
Dirty or diverged registries remain refused. If an existing registry cannot be
safely refreshed, preserve it and resolve the reported Git state before running
`toolkit agents update`; do not reset or edit the registry as an authoring clone.

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

Publication coverage is split into three sequential eight-test files with separate
fixture cleanup. Release Verify keeps `npm run verify` on Ubuntu; Windows runs
`npm run build` followed by `npm test -- --maxWorkers=2 --minWorkers=2`, preserving
the complete gate while allowing two files to run concurrently. This is a bounded
performance experiment, not a validated Windows speedup: baseline run
`37037832998` took 141.5s for Windows tests (74.2s for publication), versus 4.6s
for Ubuntu publication. Compare subsequent Windows runs before tuning further;
Linux timings do not establish a Windows improvement. Fixture reuse is deferred.
Once these changes are pushed, manually run Release Verify from GitHub Actions
to benchmark them without bumping a version. Manual runs do not qualify for the
release gate, which still requires an exact-commit push run.

Set `TOOLKIT_TEST_TIMINGS=1` to print test-only, per-file aggregate counts and
elapsed milliseconds for helper Git commands and publication fixture setup and
cleanup (enabled in Release Verify's Windows test step). No arguments, output,
paths, or fixture contents are logged. Production Git operations are not
instrumented; setup totals include their time, and aggregate durations overlap
with the measured helper commands rather than summing to wall-clock time.

GitHub Actions runs `Verify` on Ubuntu for pull requests and pushes to `main`, except when all changed files are under `agents/`. Mixed changes still run Ubuntu verification. Feature-branch pushes do not start a duplicate push run, and superseded pull-request verification is cancelled. If branch protection requires Verify checks, path-filtered pull requests can remain blocked with pending checks; configure those rules to accommodate agent-only updates.

`Release Verify` (`.github/workflows/release-verify.yml`) runs the full Ubuntu/Windows matrix on pushes to `main` that change `package.json` or `package-lock.json`, including version bumps and dependency changes. It never cancels in-progress runs and does not run on pull requests; do not require it as a PR check. Releases require this successful complete workflow for the exact tagged commit's default-branch push. Ordinary `Verify` success alone, or an agent-only commit without Release Verify, cannot qualify for npm publication.

## Publishing a release

```sh
npm run release             # patch bump (default)
npm run release -- minor    # or major
npm run release -- --resume # retry current version/HEAD without another bump
```

Run from a clean checkout (including untracked files) on the GitHub default
branch, with Git, npm, and authenticated `gh` available, Git push credentials,
and GitHub write permission. Both origin URLs must identify that GitHub repository.
No local npm login or publish token is needed.

The script pulls fast-forward only, bumps package.json and package-lock.json,
commits only those files, and normally pushes the default branch. It waits up to
15 minutes for the latest exact-commit default-branch push `Release Verify` attempt to
succeed before creating an annotated version tag and a generated-notes GitHub
Release. Failed/cancelled/skipped verification stops immediately with a run URL
and log command. No force push, tag movement, stash, reset, or rollback is used.

After a partial failure, follow the printed recovery instructions and use
`--resume` with the same version and HEAD. If the bump was not committed, first
inspect and finish that version commit. Resume accepts matching existing tags
(including remote-only tags) and published releases, but refuses tag conflicts
or draft releases; explicitly publish an existing draft in GitHub. If npm
publication later fails, rerun Publish rather than creating another release.

The GitHub publication pipeline remains:

1. The released version and its lockfile entry are committed on the default branch.
2. A GitHub Release uses the matching tag, such as `v1.1.0` for version `1.1.0`.
3. Publishing the release triggers `.github/workflows/publish.yml`. It resolves
   annotated or lightweight tags to a commit, requires that commit in `main`'s
   history, and waits (for a bounded period) for the latest exact-SHA `Release Verify`
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
