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
├── models/            # Model discovery (injectable source) and deterministic resolution; no CLI dependency
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
- The context plan includes one shared `technical-debt/README.md` index and
  `technical-debt/TEMPLATE.md` under the selected context path, not a copy per
  project. Debt records are scoped, manually maintained Markdown; they are
  distinct from project-local ongoing task state and do not authorize work.
  Preserve edited indexes and user-authored records through the existing
  ownership and explicit-replacement boundaries.
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

## Model discovery and resolution

`src/models/` holds no provider-specific IDs. `opencode models` prints one complete
`provider/model` ID per line (verified on v2.0.25); only the first `/` splits the
provider, so nested IDs and numeric suffixes stay intact. Discovery reads through an
injectable `IModelDiscoverySource`; the default runs OpenCode via `execa` without a
shell, with a timeout and output cap. `resolveModel` order: exact ID, exact normalized
family within `allowedProviders`, explicit glob patterns. More than one match at a
stage is `ambiguous`, never silently chosen, and no fuzzy scoring is used. Tests use
fixtures and a Node-based fake CLI, never the real OpenCode. Discovery does not write
OpenCode configuration. Phase 4 exposes discovery through `toolkit models list`.

### Model profiles (`src/models/profiles/`)

Phase 2 adds persistent, versioned profiles on top of discovery/resolution. Its core
APIs have no CLI dependency or OpenCode configuration writes and do not change
`.toolkit/agents.json` or agent Markdown.

- **Modules:** `schema` (validation), `serialize` (deterministic text), `storage` (safe
  read/atomic write), `store` (profile CRUD), `state` (local state), `active` (active
  profile and scope precedence), `resolutions` (saved exact IDs), `resolve-agent` /
  `resolve-profile` (resolution), `location` (paths). Types are `I`-prefixed in `types.ts`.
- **Two documents per scope, beside `agents.json`:** `<root>/.toolkit/models/profiles.json`
  (portable preferences only) and `<root>/.toolkit/models/local.json` (active profile name
  and exact `provider/model` IDs per profile/agent; machine-specific, keep out of VCS).
  `<root>` is the project, or the OpenCode config root for global. Locations take the same
  `AgentTarget` as the agent lifecycle (so `--global` maps directly) and reuse
  `assertSafeTargetDirectory`; home/env are injectable.
- **Schema:** `schemaVersion: 1` only; newer versions throw `unsupported-schema` and the
  file is untouched. Unknown properties are **rejected**, not dropped (a typo must not
  turn a restriction into none). A preference is `{id?, family?, allowedProviders?,
  patterns?, fallbacks?: criteria[]}` with at least one of id/family/patterns; `family`
  requires `allowedProviders` (matches Phase 1, which skips family matching without it);
  an `id` must not conflict with `allowedProviders`; patterns must contain a literal
  character. Provider and pattern lists are sets and are sorted on write: order never
  implies priority. Names are `^[a-z0-9][a-z0-9-]*$` (agent names match the registry's
  rule, so any current or future canonical agent, e.g. `external-researcher`, works).
- **Resolution:** delegates to Phase 1 `resolveModel` per criterion; matching is not
  reimplemented. Criteria are tried in order; `unavailable` moves to the next fallback,
  but `ambiguous` is returned as-is (no fallback skips an ambiguity). A saved ID is reused
  only if it is in the inventory and among the deciding criterion's candidates, so
  changed restrictions invalidate it; otherwise it is reported as `staleSelection`
  (`missing` | `incompatible`). A saved ID may resolve a genuine ambiguity because it is
  the user's explicit choice among exactly those candidates. Outcomes
  (`resolved`/`ambiguous`/`unavailable`/`invalid`) are values; exceptions
  (`ModelProfileError`) are only for invalid input/config, unsafe paths, filesystem errors.
  Resolving never writes; saving is explicit (`saveModelResolutions`, which rejects IDs
  the current preference would not allow).
- **Absent files are empty state**, not corruption. Malformed/unsafe files throw and are
  never overwritten. Writes are exclusive-temp + rename, skipped when bytes are identical;
  no-op edits compare canonical text so hand-formatted files are not reformatted.
  Read-modify-write is unlocked: concurrent writers may lose an update, never corrupt.
- **Active profile:** activation records state only (Phase 3 applies it). Removing the
  active profile requires `replacementProfile` or `deactivate: true`, else `active-profile`
  is returned and nothing changes. State is updated before the profile document so an
  interruption never leaves an active-but-undefined profile.
- **Scope precedence** (`selectEffectiveModelProfile`): the project's active profile wins
  over the global one; names resolve project first, then global; a same-named project
  profile fully shadows the global one (never merged); a global selection can only mean a
  global profile; an undefined name is `profile-missing` with no substitution. Saved
  resolutions belong to the scope that made them. Single-location APIs accept
  `inheritFrom` so a project may activate a global-only profile.

### OpenCode application (`src/models/opencode/`)

Phase 3 provides the library adapter. `planModelProfileApplication` resolves a stored or active
profile using Phase 1 inventory and Phase 2 saved selections. Missing/ambiguous
models block every write. `applyModelProfilePlan` accepts an unchanged process-local
plan; dry-run reads/validates without directories, backups, or state writes.

- `jsonc-editor` uses `jsonc-parser` for minimal edits to `agents.<name>.model`.
  Malformed syntax, duplicate keys, and incompatible containers are rejected.
  Comments, unknown settings, permissions, and other agent properties are preserved.
- `config-files` uses the single existing `opencode.json`/`opencode.jsonc` in the
  selected scope, including project `.opencode/`; multiple candidates are a conflict.
  With no file, it creates root `opencode.jsonc`. No competing config is created.
- `.toolkit/models/applied.json` owns independent JSONC assignments by relative
  config path and last applied model. Agent-file ownership stays in `agents.json`.
  Edited owned assignments and unowned differing assignments require per-agent
  consent. Identical unowned values are not adopted merely because they match.
- Only present, unchanged managed agent Markdown is eligible. Overrides are skipped;
  local/unmanaged/modified agents are protected. Hardcoded models require staged
  migration: replacement config first, stripped Markdown and hash reconciliation
  next, model ownership and local resolutions last. Instructions remain unchanged.
- Routine `updateAgents` refuses to erase a working Markdown model when switching
  to model-free canonical content. Publication strips models from registry content,
  but preserves installed working models until explicit migration.
- Writes use same-directory exclusive temporary files, backups of replaced files,
  and exact-byte snapshot checks. Multi-file operations are not transactions;
  failures return changed paths and recovery backups, not a success result.

OpenCode v2.0.25 isolated probes verified plural `agents`, legacy `agent`, string
`provider/model[#variant]` and object model syntax. Precedence for an agent model:
project Markdown > project `.opencode` config > project root config > global
Markdown > global config. Within a directory `.jsonc` beats `.json`; this adapter
rejects competing files instead of guessing. `inspectEffectiveOpenCodeModels` is
static inspection, not runtime validation; environment/remote config and existing
session model selections aren't evaluated. Session selection behavior is documented,
not runtime-verified. Global plans report project shadows only for supplied context.

### Model CLI (`src/commands/models.ts`, `src/commands/models/`)

Phase 4 exposes `list`, `profiles`, `configure`, `use`, `set`, and `status` via Citty.
CLI presentation stays outside model core. Clack's installed autocomplete provides
searchable selection; fuzzy filtering is UI-only, never deterministic resolution.
Read-only profile/status operations are offline; list and mutating application
discover through OpenCode. No model command refreshes the agent Git registry.

Application planning accepts validated in-memory `profileDefinition` and exact
`selections`, with optional `agents` to isolate a single-agent change. It retains
snapshot and process-local approval guarantees; it never writes portable preferences.
The CLI can therefore apply a proposed `set` before saving its preference, preserving
old preferences when application fails. Exact local resolutions remain separate from
provider-restricted normalized family preferences. Active state changes only after
successful application. Migration and protected assignment consent use the existing
Phase 3 boundaries; non-TTY input never implicitly grants protected consent.

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
Release CI runs this command on Ubuntu. Windows runs the equivalent build followed
by `npm test -- --maxWorkers=2 --minWorkers=2`; package tests must exercise only
the supported public exports and assets present in the npm tarball.

Publication integration coverage has three sequential eight-test files (batch,
global/line endings, single/conflicts), each owning its fixture cleanup through
`tests/helpers/publication.ts`; never share a global directory array across files.
Each helper instance lazily caches one seed-build promise for an immutable author
checkout and bare remote in a separate temporary root. Each test recursively
copies both repositories with `fs.cp` (no hard links, alternates, or shared symlinks)
and retargets the copied author's origin. Registry initialization, Git environment,
line-ending modes, and project ownership remain per-test. After-each cleanup only
removes fixture roots; each file registers after-all seed disposal, which waits for
an active seed build to settle and removes its root even after failed setup.
Both repository copies are drained with `Promise.allSettled` before propagating
failure, so failed setup cannot race cleanup against an active Windows copy.
`TOOLKIT_TEST_TIMINGS=1` enables per-file aggregate helper Git command counts and
elapsed milliseconds plus publication setup/cleanup and seed build/copy/cleanup
totals. Log command names only, never arguments, output, paths, or fixture contents. Production Git is not
instrumented; setup, seed build/copy, and helper Git timings overlap rather than
summing to wall-clock time. Seed cleanup is separate. Windows Release Verify opts
in. Keep the bounded two-worker configuration and per-file seed reuse: real
Windows run `37044452590` passed all 27 files (238 tests passed, one
platform-specific skip), with 91.75s of tests and a 2m14s job versus baseline
run `37037832998` at 141.54s and 2m59s. The observed test-duration reduction
is about 35%; hosted-runner timings vary, so this is not a performance guarantee.
Publication setup totals fell from approximately 46s before seed reuse to 23s.
Linux results alone are not evidence of Windows speedup. Real filesystem/Git
helper tests cover isolation, after-each seed retention, after-all disposal,
failed active seed setup, and draining failed copies before cleanup.

Workflow contract tests normalize CRLF to LF before textual assertions and cover
both checkout line-ending formats. The real-Git registry integration suite uses
the same 30-second test budget as publication suites; retain assertions and avoid
raising the global timeout to accommodate integration work.

## CI and releases

`.github/workflows/verify.yml` verifies pull requests and pushes to `main`, not
every feature-branch push. Both triggers ignore changes exclusively under
`agents/**`; mixed changes still run the single Ubuntu job. This
skip does not weaken npm release gates. A skipped workflow can leave required
branch-protection checks pending; repository settings must accommodate this
separately. An agent-only commit without exact-SHA verification cannot qualify
for npm publication.

`.github/workflows/release-verify.yml` (Release Verify) runs the complete
Ubuntu/Windows matrix only on pushes to `main` changing `package.json` or
`package-lock.json`, covering version bumps and dependency changes. It runs
`npm ci` and the full build/test gate described above, never cancels in-progress runs, and has no PR
trigger. Do not require this path-filtered release workflow as a PR check.
It also supports manual dispatch for performance benchmarks without a version
bump; dispatch runs do not qualify for the push-only release gate.
Routine Verify success alone cannot satisfy the npm release gate.
Keep Release Verify and its manual trigger: it is the release safety gate, not
a temporary benchmark workflow. Manual dispatch permits troubleshooting without
a version bump or publication; it still cannot authorize a release.

`npm run release` runs `scripts/release.mjs` from the source checkout. It defaults
to a patch bump; `npm run release -- minor` and `-- major` select larger bumps.
This is a mutating release command, not a verification command; never execute it
as part of ordinary agent validation.

- Require a clean worktree including untracked files, the GitHub default branch,
  Git/npm/authenticated `gh`, consistent origin fetch/push repositories, and write
  access. Pull fast-forward only; never reset, stash, force-push, or move tags.
- Bump with lifecycle scripts disabled, commit only `package.json` and
  `package-lock.json`, then normally push the default branch. Wait up to 15
  minutes for the latest exact-SHA default-branch push Release Verify attempt to succeed
  before creating an annotated tag at that SHA and a generated-notes GitHub
  Release. Failed/cancelled/skipped Release Verify attempts stop with diagnostics.
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
and a successful complete exact-SHA push Release Verify run. It does not accept a PR run
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
