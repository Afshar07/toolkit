# Model management and OpenCode

Toolkit's model CLI reuses the discovery, portable profile, deterministic resolution,
and safe OpenCode integration APIs. Ordinary switching never requires editing
agent Markdown or JSONC manually.

## Command reference

| Command | Purpose |
| --- | --- |
| `toolkit models list` | Discover exact IDs with OpenCode; supports `--provider`, `--search`, `--json` |
| `toolkit models profiles` | List saved profiles and the active selection; supports `--json` |
| `toolkit models configure` | Create, edit, or select a profile interactively |
| `toolkit models use <profile>` | Resolve, preview, and safely apply a saved profile |
| `toolkit models set <agent> [model]` | Update one agent in the active profile; omit model for searchable selection |
| `toolkit models status` | Read-only inspection of saved and statically effective state; supports `--json` |
| `toolkit models doctor` | Read-only discovery plus profile, ownership and recovery diagnostics; supports `--json`; never inference |

All commands accept `--destination <path>` or `--global` (mutually exclusive).
Project scope defaults to the current directory. Mutating commands support
`--dry-run` and `--non-interactive`. Configuration requires a terminal; supplying
`--non-interactive` does not invent wizard answers. There is no broad `--force`
approval, automatic profile generation, or local-only `set` override.

## New-machine setup and profile editing

1. Install OpenCode and configure/authenticate the provider you want to use.
2. Install Toolkit and run `toolkit agents update` in your project (or with
   `--global`). This agent distribution command may access the registry network;
   model commands use the local/bundled canonical registry, without refreshing it.
3. Run `toolkit models list` to inspect the provider's inventory.
4. Run `toolkit models configure`, choose a new profile name, and choose models for
   the canonical agents. Preserve existing preferences or skip assignments as needed.
5. Review portable preferences and exact local IDs before confirming the save.
   Saving a profile and applying it are separate steps; application can be declined
   or blocked even when saving succeeded.

Run `configure` again and choose edit to change an existing profile, or select an
existing profile to apply. Names use lowercase letters, digits, and hyphens and
must begin with a letter or digit. Cancelling before save leaves profile and active
state untouched. Dry-run does not save or activate anything.

Portable profiles live in `.toolkit/models/profiles.json`. Machine-specific exact
selections and the active profile live in `.toolkit/models/local.json`; keep this
local file out of version control. Copy portable profiles to a new machine, then
discover and apply there. Global storage uses the OpenCode configuration root,
`$XDG_CONFIG_HOME/opencode` for absolute XDG paths or `~/.config/opencode` otherwise.
Project model operations never write global configuration, and vice versa.

## Model search and portable intent

`models set coder` and the wizard provide type-to-search selection, case-insensitive
fuzzy filtering over complete provider/model IDs, arrow navigation, Enter to select,
and cancellation. Current IDs are marked; no-results searches are explicit. Fuzzy
matching is a UI filter only, never automatic runtime resolution. Direct assignment
requires a complete, currently discovered exact ID:

```sh
toolkit models set coder cpa-gui/gpt-6.1-sol-123 --non-interactive
```

Selecting a model saves its normalized family restricted to its selected provider,
and stores the chosen exact ID separately as a local resolution. Phase 1 normalization
preserves numbers and suffixes; the CLI does not guess which model-version digits
are proxy decorations. Explicit portable patterns can accommodate changing proxy
IDs, but broad patterns may be ambiguous and never imply permission to choose one
automatically. Exact IDs remain intact in discovery, selection, and OpenCode.
In the wizard, choose **Enter portable family or pattern**, then supply the allowed
provider and either a family or a complete ID glob. For example, provider `cpa-gui`
and pattern `cpa-gui/gpt-6.1-sol-*` explicitly allow matching numbered proxy IDs.
An empty discovery result or unavailable OpenCode can still produce a save-only
portable profile; it is not reported as successful integration.
Only a unique deterministic match or a valid saved explicit choice resolves a
preference. Missing models block application; ambiguity requires explicit selection
among the valid candidates. No provider fallback is silently added.

## Switching OpenAI, Anthropic, and EasyCLIProxyAPI

Profile names are not provider presets. Create `openai` and `anthropic` in the wizard
using whatever exact IDs your provider exposes. Both profiles may use the same proxy:

```sh
toolkit models list --provider cpa-gui
# For example, a configured EasyCLIProxyAPI may expose:
# cpa-gui/gpt-6.1-sol
# cpa-gui/claude-sonnet-5-5
toolkit models use openai
toolkit models use anthropic
toolkit models use openai
```

Direct namespaces such as `openai` and `anthropic`, custom provider names, and
nested IDs are also supported. Inventory reflects discovery, not successful live
inference. Switching edits only eligible model assignments, not agent prompts or
permissions. Re-applying unchanged state avoids unnecessary writes. Overrides are
preserved, not silently returned to Toolkit management.

`models set` requires an active profile and applies only the selected agent. It
plans against an in-memory preference before committing portable preference changes;
failed application leaves prior preferences intact. Multi-file failures can still
leave OpenCode changes or local resolutions; inspect reported paths and backups.

## Scripts and inspection

```sh
toolkit models list --search sonnet --json
toolkit models profiles --global --json
toolkit models use openai --destination ./project --non-interactive
toolkit models use anthropic --global --dry-run --non-interactive
toolkit models set coder cpa-gui/gpt-6.1-sol --non-interactive
toolkit models status --destination ./project --json
```

Non-TTY input never opens a prompt. Protected replacement, ambiguous selection, and
legacy migration needing consent fail rather than implicitly approving changes.
JSON read-only output is machine-readable; failures use a nonzero exit status.
Listing profiles and status do not require discovery or create missing directories.

Status distinguishes saved preference, local exact resolution, OpenCode assignment,
assignment ownership, and statically effective source. Without discovery it cannot
prove whether a saved resolution is currently discoverable or whether matching is
currently missing/ambiguous. It surfaces file conflicts, overrides and migration
problems from local evidence. Global assignments may be shadowed by project files.
It never reports an existing session's selected model or verifies inference. Open
a new OpenCode session if configuration changes do not affect an existing one.

Use `toolkit models doctor` when offline status cannot determine whether the current
inventory resolves a preference. It discovers IDs and reports missing/ambiguous
preferences, stale saved selections, stale assignment ownership, edited assignments,
configuration conflicts, pending migration and provable interrupted hash repair.
It never writes, prompts or sends inference requests. Exit code 1 means discovery
failed or conflicts/migration/recovery need attention; JSON output is still available.
Provider stderr is deliberately withheld from discovery errors because providers
can print credentials or configuration. Run `opencode models` locally for details;
do not share unredacted logs. A backup's existence alone does not prove interruption.

## Verification boundaries

Command tests use isolated temporary project/global roots and injected discovery,
so they do not authenticate providers or contact a provider network. Selector tests
drive Clack with terminal-like streams, including search, navigation and cancellation.
Live provider inference and changing an already-running OpenCode session are not
verified by these tests.

Source and compiled CLI lifecycle tests additionally execute real Node subprocesses
against a deterministic fake OpenCode executable. They verify switching, direct
assignment, exit codes, ownership, exact-byte/mtime idempotency and dry-run behavior.
Profile creation in those subprocess tests uses the library API, not a manually
operated wizard. Mocked wizard/consent tests and terminal-stream selector tests are
automated coverage, not evidence of manual interactive end-to-end verification.

Windows security fixtures need permission to create file symbolic links (Developer
Mode or an appropriately privileged test process). An `EPERM` while creating a
fixture is unsupported test infrastructure, not evidence that the security assertion
passed. Run the complete suite in a symlink-capable environment for a green gate;
directory-junction tests alone are not a substitute for file-symlink tests.

## Library integration

The Phase 3 APIs remain exported from `@afshar7/toolkit`. Profiles and deterministic
resolution use the Phase 1/2 APIs.

Phase 4 adds optional `profileDefinition`, `selections`, and `agents` to application
planning options. A draft definition requires an explicit profile name, is validated
through the profile schema, and is not saved as portable preferences by application.
An `agents` filter must be nonempty and name only agents defined in that profile;
it limits resolution and application to those agents. Exact selections must name
only agents being planned. Existing local selections for other agents are preserved.
These options do not bypass assignment consent, migration checks, snapshots, or
the requirement to execute an unchanged process-local plan.

```ts
import {
  planModelProfileApplication,
  applyModelProfilePlan,
  prepareAgentModelMigration,
  resolveGlobalAgentTarget,
} from "@afshar7/toolkit";

const options = { target: "/absolute/project/path", profile: "openai" };
const plan = await planModelProfileApplication(options);
// Present plan.assignments, plan.resolution, plan.conflicts and plan.shadowed.
if (plan.status === "ready") {
  const preview = await applyModelProfilePlan(plan, { dryRun: true });
  // After caller approval; the original, unmodified plan is required.
  const result = await applyModelProfilePlan(plan);
}

// Existing managed agents with frontmatter models need explicit staged migration.
const migration = await prepareAgentModelMigration(options);
if (migration.status === "ready") await applyModelProfilePlan(migration);

// Global target uses the existing injectable home/XDG resolver.
const global = resolveGlobalAgentTarget();
```

`applyModelProfile(options)` combines planning and application; `migrateAgentModels`
also resumes provable interrupted migrations. Use `models` or `source` to inject
inventory without a real OpenCode process. Omit `profile` to use the target's active
profile. Application does not activate a profile. `inheritFrom` allows a project to
reference a global profile without changing global files.

## Ownership and conflicts

The CLI displays the current and proposed model and whether a differing assignment
was edited outside Toolkit or is unmanaged. Replacement requires a separate
confirmation for that agent, defaulting to preserve. Declining aborts the application;
it does not adopt unrelated protected assignments. Non-interactive operations cannot
grant this consent. Modified or unmanaged Markdown and deliberate agent overrides
are distinct from assignment conflicts: approving a JSONC replacement does not
authorize overwriting those files.

Agent eligibility is proved by `.toolkit/agents.json`: present, unchanged managed
files only. Overrides are skipped. Modified, missing and unmanaged agent files are
reported, never adopted or rewritten by profile application.

Independent JSONC ownership lives at `.toolkit/models/applied.json`. A previously
owned, unchanged assignment can switch models. Edited owned or differing unowned
assignments require `replaceAssignments: new Set(["lead"])` after caller consent.
Identical unowned assignments remain unowned. Profile resolution must be complete
before any write, including when an agent will be skipped. No provider is silently
selected to resolve ambiguity.

The adapter edits only `agents.<name>.model`, preserving unrelated settings and
comments with `jsonc-parser`. It uses the single existing supported config file;
multiple root or `.opencode` candidates return `config-conflict`. With none, root
`opencode.jsonc` is created. Malformed JSONC, duplicate keys, unsafe paths and
unsupported metadata are not repaired.

Plans are process-local approvals and cannot be serialized and later executed or
mutated after planning. Generate a fresh plan in the process that will apply it.
Whole-config OpenCode schema validation is not performed: unrelated unknown settings
are deliberately preserved, while JSONC structure and targeted model edits are validated.

## Migration and recovery

`models use`, `models set`, and immediate application from `configure` preview
required legacy migration and ask for explicit approval. Declining leaves files
unchanged. Non-interactive switching cannot perform destructive migration without
interactive approval. No separate migration command is required.

Canonical templates contain no provider-specific model. An installed agent's
working `model:` is removed only after its replacement JSONC assignment exists.
Migration preserves all other Markdown bytes and updates only the installed hash,
retaining the agent version and source. Ordinary agent updates report a conflict
rather than stripping a working model. Publication strips models from shared
registry content but keeps installed models until migration.

Every changed existing file receives a same-directory `.bak` file. Exact-byte
snapshot checks detect stale plans. Multi-file application is **not transactional**:
check `status`, `filesChanged`, `backups` and `manualIntervention`. A failure may
leave configuration applied while metadata is incomplete. Do not assume rollback.
Preserve backups until recovery is complete; backups may contain sensitive provider
configuration. There is no automatic backup deletion.

On failure, do not assume the new profile is active. Review the reported changed
files, backup paths and manual-intervention requirements with `models status`.
If evidence supports interrupted hash repair, retry the interactive application and
review its recovery preview. If proof is absent, preserve backups and reconcile the
files manually; Toolkit will not infer ownership from matching names. A failure
after configuration application but before profile persistence is also partial
success, not a completed switch. Keep the prior portable profile until recovery
has been checked.

If Markdown was stripped before its manifest hash was written, migration can
prove recovery from an exact-original backup and the still-present replacement
assignment. A migration preview then contains the hash-repair step; apply it and
re-plan. `migrateAgentModels` performs both steps. Without proof, resolve manually.

## Effective configuration limits

Isolated runtime probes on **OpenCode v2.0.25** verified `agents` (plural), legacy
`agent`, string `provider/model[#variant]` and object model forms. Project Markdown
model overrides project JSONC; project JSONC overrides global Markdown and JSONC.
Global Markdown overrides global JSONC. The integration writes resolved IDs without
adding variant policy to profiles.

`inspectEffectiveOpenCodeModels({ agents, project, global })` reports static file
precedence. Global apply can accept `project` to report project shadows without
writing project files. Neither API claims runtime/session effectiveness: injected
environment config, organization config, defaults, and existing session selections
are outside inspection. Existing-session agent-selection behavior was documented
but not runtime-tested. Live inference requires separately authorized access and is
not part of ordinary diagnostics or automated tests.

The Phase 5 local v2.0.25 smoke attempt did **not** establish runtime acceptance:
isolated debug commands collided with the managed-service port, `debug agents`
does not accept `--standalone`, and standalone discovery did not expose the fixture
provider. Real settings/services were not changed to work around this. Repeat the
configuration/agent/new-session precedence checks in a genuinely disposable runtime
before treating Phase 5 as fully verified. No inference requests were made.

## Release gate

Build, the complete test suite, `npm run verify`, and `npm pack --dry-run` must be
checked before publication. The tarball includes this guide, compiled model/profile/
OpenCode/CLI modules and bundled model-independent canonical agents. Only the root
package export is public; importing internal source paths is unsupported. The existing
release workflow requires successful exact-commit Ubuntu and Windows Release Verify
before OIDC publication. Do not equate a local build or partial test pass with that gate.
The additive model CLI/library feature warrants a **minor** version bump from 1.1.3
(1.2.0), after blockers are resolved and release approval is given; this work does not
change the version or run the mutating release script.
