# Model profiles and OpenCode (library API)

Phase 3 exposes library APIs from `@afshar7/toolkit`. There is no `toolkit models`
command yet. Profiles and deterministic resolution use the Phase 1/2 APIs.

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
but not runtime-tested. Live inference is outside this phase.
