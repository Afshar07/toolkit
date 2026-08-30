# Toolkit final audit cleanup

## Session state

- **Status:** complete
- **Current step:** Complete
- **Next action:** None.
- **Last reviewed:** 2026-08-30

## Goal and acceptance criteria

- Complete the final cleanup without redesigning the `scan → manifest → setup` architecture or manifest schema v3.
- A failed clone removes only Toolkit-created clone targets; a failed secondary remote setup preserves the successfully cloned repository and clearly identifies the repository and remote.
- `toolkit --version` and `package.json` use one version source.
- README concisely describes current scan, setup, and doctor behavior and the supplied CLI examples.
- Workspace-root creation is not repeated during directory iteration and does not interfere with cloning an explicit root repository.
- Doctor either correctly checks supported Node version formats using an established solution or explicitly limits validation to exact versions.
- Focused tests cover clone cleanup, successful secondary remotes, and failed secondary-remote preservation; the full test suite and TypeScript build pass.

## Scope and guardrails

- Preserve interactive `scan` and `setup`; supplied positional arguments/options skip their corresponding prompts.
- Do not redesign scanner architecture, root-repository model, or schema v3.
- Do not add dependency installation, environment synchronization, Docker/SSH support, plugins, or context expansion.
- Setup must not overwrite or delete pre-existing user content; clone concurrency and independent-clone continuation remain intact.
- Keep documentation concise and describe reconstruction of declarative workspace structure, not arbitrary file backup.

## Current code map

| Concern | Source | Tests |
| --- | --- | --- |
| Setup cloning, remote configuration, destination creation | `src/setup/setup.ts` — clone cleanup is scoped to lines 73–86; remote failures are reported at 88–96; root is created once at 45 | `tests/setup/setup.test.ts` — clone cleanup at 98–117, remote success at 16–34, remote failure preservation at 119–144, root clone at 159–173 |
| CLI command registration and version reporting | `src/cli.ts` — package metadata loaded as the Citty version source | Manual command verification: `node dist/cli.js --version` |
| Node compatibility checks | `src/doctor/doctor.ts` — documented exact version filter | `tests/doctor/doctor.test.ts` |
| Package metadata and README | `package.json`, `README.md` | N/A |

## Implementation plan

### 1. Map setup clone and cleanup boundaries

1. Locate setup cloning, secondary-remote configuration, root/directory creation, and existing-content validation.
2. Locate the relevant test fixtures and test commands, then update the code map.
3. Verify the current behavior with targeted tests where available.

### 2. Separate clone cleanup from remote configuration failures

1. Restrict removal of a Toolkit-created target to clone-operation failure only.
2. Preserve a repository after clone success if adding any secondary remote fails; surface the repository path, failed remote, and failure phase.
3. Create/update focused tests for clone failure cleanup, all remotes succeeding, and a failed secondary remote preserving the clone.

### 3. Simplify destination creation safely

1. Create the workspace root once only when it is safe and required.
2. Ensure an explicit root repository can be cloned into a not-yet-created destination.
3. Verify normal manifests still create declared empty/structural directories and existing-content conflicts remain safe.

### 4. Unify CLI version reporting

1. Locate the duplicated Citty version declaration.
2. Make package metadata the sole version source with the simplest TypeScript/Node-compatible mechanism.
3. Add or update a focused check that confirms CLI output matches `package.json`.

### 5. Resolve doctor Node-version semantics

1. Inspect the current exact-version compatibility check and its output/tests.
2. Prefer an explicit exact-version-only limitation unless a small established solution materially reduces complexity.
3. Make the chosen supported-format behavior clear in code, output, or README, and test it.

### 6. Refresh README and perform final verification

1. Concisely document recipes, root and child Git repositories, relative paths, remotes and clone selection, hints, standalone directories, conflict validation, and interactive/argument-driven commands.
2. Include the requested `scan`, `setup`, and `doctor` examples.
3. Run focused tests, the full test suite, and the TypeScript build; record results and known limitations.

## Decision log

| Decision | Status | Rationale |
| --- | --- | --- |
| Preserve a successful clone when secondary remote setup fails | decided | A successful repository must never be removed for a later configuration failure. |
| Cleanup applies only to clone failures for Toolkit-created targets | decided | Protects user content and isolates cleanup to the operation that failed. |
| Package metadata is the version source of truth | decided | Eliminates manual version drift without build-system complexity. |
| Keep Node-version validation small unless an established solution clearly pays off | decided | The cleanup pass should avoid unnecessary dependency or parsing complexity. |

## Resume checklist

1. Read this file and the selected project context.
2. Confirm the current step and working-tree status.
3. Complete only the current step and its focused verification.
4. Update this note and `current.md` before ending the session.

## Verification log

- `npm test -- tests/setup/setup.test.ts` — passed (9 tests). The expected failed-clone fixture emits Git’s missing-remote error during the passing test.
- `npm test -- tests/doctor/doctor.test.ts` — passed (4 tests).
- `npm run build` — passed.
- `node dist/cli.js --version` — returned `0.1.3`, matching `package.json`.
- `npm test` — passed (6 files, 48 tests). The setup fixture intentionally emits a failed-clone Git error while validating cleanup.
- `npm run build` — passed after final changes.
