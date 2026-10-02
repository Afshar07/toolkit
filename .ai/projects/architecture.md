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
- Workspace names are portable single directory names, and HTTP(S) Git remotes are credential-free. Existing symlinks or junctions must not redirect recipe, agent, or context-backup writes outside their selected root; preflight all planned writes and use exclusive creation for new files.
- Setup never overwrites an existing destination. Clone at most three repositories concurrently; continue other clones when one fails.
- Tests mirror source concerns under `tests/` and use temporary Git repositories.
- `src/scanner/scan.ts` drains all concurrent remote-reading Git processes with
  `Promise.allSettled` before rejecting. Do not reintroduce early rejection while
  sibling processes still run: Windows can retain directory locks and fail test
  cleanup with `EBUSY`. `tests/scanner/scan-lifecycle.test.ts` covers both unsafe
  URLs and Git failures while another remote read remains pending.

## Toolkit agent distribution

Keep these layers distinct:

```text
normal Toolkit development clone / agents/
                 ↓ Git push and sparse checkout
machine registry / ~/.toolkit/registry/agents/
                 ↓ canonical loading
target synchronization / src/agents/sync.ts
                 ↓ current target adapter
project / .opencode/agents/

project ownership state / .toolkit/agents.json
global target / <OpenCode config>/agents/
global ownership state / <OpenCode config>/.toolkit/agents.json
```

`toolkit agents publish NAME` is the reverse path: it reads one selected agent,
uses ownership hashes as its conflict baseline, and commits only that definition
plus the canonical version through a disposable ordinary checkout. The machine
registry remains a distribution cache and is refreshed only after a successful
push, before the selected target's ownership is reconciled.

`toolkit agents publish --all` selects validated upstream manifest membership and
uses the same engine as single-agent publication. All selected local files and
ownership baselines are preflighted before checkout writes or confirmation. One
combined diff, confirmation, version bump, commit, and normal push publishes only
changed definitions. Refresh happens once; all changed local files are rechecked
before any reconciliation, then exact-byte per-file checks remain in place.
Unchanged files and unrelated local state are preserved. Post-push failures report
successful publication with incomplete (potentially partial) local synchronization.
The CLI requires exactly one of `NAME` or `--all`; `--all` works with project and
global targets, `--dry-run`, and `--yes`. `--include-override` and
`--allow-unmanaged` acknowledge every selected agent's corresponding state, but
never bypass a known stale baseline. The additive `publishAllAgents` API exposes
batch previews/results; `publishAgent` retains its single-agent public contract.

`src/agents/target.ts` selects project or global OpenCode paths. Existing string
roots still mean project targets. `--global` is supported throughout the agent
lifecycle and is mutually exclusive with an explicit destination, rejected before
registry/network operations. Global config is absolute nonempty
`XDG_CONFIG_HOME/opencode`, otherwise `os.homedir()/.config/opencode` on all
platforms; `context agents` shares this resolver. Offline inspection never
creates directories. Global writes preflight missing-root ancestors as well as
agent and metadata directories against symlink/junction redirection before
bootstrapping. Global ownership never changes project ownership, and global
publication recovery commands retain `--global`.

- `agents/` in the Toolkit repository is the authoring source for canonical
  definitions. Its manifest determines membership dynamically; the current names
  are not a fixed architectural list.
- Canonical agent definitions are LF text. Canonical loading normalizes CRLF from
  legacy checkouts, while ownership hashes continue to represent the exact bytes
  installed in each project.
- `src/registry/*` owns the single machine-wide, sparse Git checkout, including
  initialization, refresh, paths, and Git safety.
- `src/agents/registry.ts` validates and loads an `agents/` directory without
  knowing how it was acquired.
- `src/agents/sync.ts` compares canonical definitions with the selected target's
  files and separate ownership manifest. Project state lives at
  `.toolkit/agents.json`; global state lives under the OpenCode config root.
- `.opencode/agents/` is the default project installation target; global mode
  selects `<OpenCode config>/agents/`. The canonical Toolkit
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
- New registry and authoring clones set `core.autocrlf=false` and `core.eol=lf`
  before checkout. Existing clean CRLF registries are interpreted through the LF
  canonical-loading boundary rather than reset or rewritten in place.
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

Canonical membership is changed in a normal Toolkit clone. Existing canonical
definitions may also be published from a project or global target with
`toolkit agents publish`;
its deterministic `YYYY.MM.sequence` version supports multiple same-day
publications. Never author changes in `~/.toolkit/registry`; another project or
machine receives them with `toolkit agents update`.

Registry and synchronization tests should prefer real temporary filesystems,
temporary Git repositories, local bare remotes, and an injected temporary home.
They must not contact GitHub, write the user's `~/.toolkit`, change global Git
configuration, or depend on the developer's working tree. Configure Git identity
locally in each fixture. Keep path handling portable, avoid shell-only Git
assumptions, and skip only genuinely platform-specific symlink cases on Windows.

Installation tests compare filenames and exact installed text with the current
canonical registry, not hardcoded prompt wording or a fixed agent count.
Compiled CLI tests asserting help text explicitly set `CONSOLA_LEVEL=3` so the
inherited test environment cannot suppress informational help output.

`npm run verify` is the release-confidence gate: it builds TypeScript before
running domain, real-Git, compiled-CLI, packed-artifact, and clean-consumer tests.
CI runs this same command on Ubuntu and Windows; package tests must exercise only
the supported public exports and assets present in the npm tarball.

## CI and releases

`.github/workflows/verify.yml` verifies pull requests and pushes to `main`, not
every feature-branch push. Both triggers ignore changes exclusively under
`agents/**`; mixed changes still run the complete Ubuntu/Windows matrix. This
skip does not weaken npm release gates. A skipped workflow can leave required
branch-protection checks pending; repository settings must accommodate this
separately. An agent-only commit without exact-SHA verification cannot qualify
for npm publication.

`npm run release` runs `scripts/release.mjs` from the source checkout. It defaults
to a patch bump; `npm run release -- minor` and `-- major` select larger bumps.
This is a mutating release command, not a verification command; never execute it
as part of ordinary agent validation.

- Require a clean worktree including untracked files, the GitHub default branch,
  Git/npm/authenticated `gh`, consistent origin fetch/push repositories, and write
  access. Pull fast-forward only; never reset, stash, force-push, or move tags.
- Bump with lifecycle scripts disabled, commit only `package.json` and
  `package-lock.json`, then normally push the default branch. Wait up to 15
  minutes for the latest exact-SHA default-branch push Verify attempt to succeed
  before creating an annotated tag at that SHA and a generated-notes GitHub
  Release. Failed/cancelled/skipped Verify attempts stop with diagnostics.
- `npm run release -- --resume` retries the current version and HEAD without
  another bump. Refuse mismatching tags, changed resume HEAD, and draft releases;
  matching existing tags/releases are accepted. Partial failures retain state
  and print recovery instructions, not automatic rollback. If the bump was not
  committed, inspect and finish that commit before resuming.
- Release tests inject GitHub/npm commands and use temporary local Git remotes;
  no test publishes to GitHub or npm. `tests/ci/release.integration.test.ts`
  exercises version-commit push, failed-CI resume, and explicit-SHA tagging.

`.github/workflows/publish.yml` remains the only npm publishing path, using OIDC.
`scripts/release-gate.mjs` requires the tagged commit in default-branch history
and a successful complete exact-SHA push Verify run. It does not accept a PR run
or another commit's success. The preparation job packs that exact checkout and
passes the immutable tarball to the separately OIDC-permitted publish job. If
Publish fails after release creation, rerun Publish rather than bumping again or
moving the tag. No local npm publishing credential is needed for the release
script.

## Deferred terminal diff UI

Richer diff rendering was explored but deferred at the user's request. No
OpenTUI, Pierre Diffs, Ink, jsdiff, or Delta integration was added. Keep the
current plain diff presentation and Node.js >=20 runtime contract unless a new
task explicitly revisits them; do not treat the exploration as pending work.
