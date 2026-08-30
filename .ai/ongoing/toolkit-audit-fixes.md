# Toolkit audit fixes

## Session state

- **Status:** in progress.
- **Current step:** 6 — Stop swallowing unexpected scanner errors.
- **Next action:** inspect Git repository detection and remote-discovery failure handling.
- **Last reviewed:** 2026-08-30.
- **Baseline:** working tree contains the audit changes from completed Steps 1–3, plus this task document and `.ai/ongoing/README.md` as untracked files.

## Scope and guardrails

- Preserve the current layers: Citty and Clack in `src/commands/`; scanner, setup, doctor, and manifest modules remain CLI-independent.
- Use native filesystem paths at runtime and POSIX (`/`) paths in manifests.
- Never overwrite or delete pre-existing destinations. Clone cleanup may remove only a destination created by that failed clone.
- Add focused Vitest coverage alongside every changed behavior, favoring real temporary directories and Git repositories.
- Complete and verify one numbered step before beginning the next. Do not add out-of-scope features.

## Current code map

| Concern | Source | Existing tests |
| --- | --- | --- |
| Manifest types, parsing, discovery | `src/workspace/manifest.ts` | `tests/workspace/manifest.test.ts` |
| Workspace scanning and Git inspection | `src/scanner/scan.ts` | `tests/scanner/scan.test.ts` |
| Safe setup and cloning | `src/setup/setup.ts` | `tests/setup/setup.test.ts` |
| Interactive scan/setup commands | `src/commands/scan.ts`, `src/commands/setup.ts` | None |
| Doctor checks | `src/doctor/doctor.ts`, `src/commands/doctor.ts` | None |

## Implementation plan

### 1. Fix existing destination handling — **next**

1. In `src/setup/setup.ts`, inspect an existing repository target with Git commands (support both `.git` directories and `.git` files/worktrees).
2. Treat only a valid Git worktree whose expected clone remote matches as skipped; compare the normalized remote URL returned by Git rather than parsing `.git/config`.
3. Collect non-Git and wrong-remote destinations as clear setup conflicts, without cloning into, deleting, or modifying them. Keep independent clone failures concurrent and bounded to three workers.
4. Define result/error reporting so conflicts identify the repository path and reason; retain useful clone-failure reporting.
5. Update `tests/setup/setup.test.ts` for matching-repo skip, non-Git conflict, wrong-remote conflict, and normal missing-target clone.
6. Run the focused setup tests, then `npm test` and `npm run build`.

### 2. Define `directories`

1. Document and encode `directories` as standalone, empty structural directories needed in addition to repository parent directories—not backups of content.
2. Change scanner traversal so it records meaningful empty/non-repository structural paths, including nested standalone directories, while excluding repository paths and repository parents setup creates automatically.
3. Keep setup responsible only for creating these declared empty directories plus required repository parents.
4. Add scanner/setup tests for nested repository paths and standalone empty structural directories.
5. If analysis proves the field redundant, make an explicit schema-versioned removal instead; otherwise retain it with the clarified semantics.

### 3. Strengthen manifest validation

1. Extract shared manifest-path validation and safe manifest-path-to-filesystem resolution in `src/workspace/` so parsing and setup enforce identical rules.
2. Require non-empty workspace/repository names and remotes; require POSIX, non-root relative paths for repositories and directories; reject absolute paths, `..` traversal, duplicates, and incompatible repository/directory collisions.
3. Ensure `readManifest` reports invalid manifests clearly and that setup consumes the shared validation boundary rather than reimplementing it.
4. Add malformed/malicious manifest tests in `tests/workspace/manifest.test.ts` and setup tests where resolution behavior is relevant.

### 4. Preserve all Git remotes with an explicit clone remote

1. Evolve the repository manifest model from `remote` to a named remote list and explicit clone selection (for example, `cloneRemote` plus `remotes`).
2. Bump `schemaVersion` for the persisted shape. No migration is required unless a small, unambiguous compatibility read is genuinely trivial.
3. Scan all remotes, choose `origin` automatically when present, and prompt only when no unambiguous default exists. Setup clones using the explicit clone remote URL.
4. Update scanner, manifest, setup, and command tests for persisted remotes and clone selection.

### 5. Add optional CLI values while retaining prompts

1. Consult current Citty documentation before changing command argument declarations.
2. Add scan's optional positional workspace path and `--name`/`--output`; supplied values bypass only their corresponding Clack questions.
3. Add setup's optional manifest positional argument (already present) and `--destination`; supplied values bypass only their corresponding prompt.
4. Preserve overwrite, final safety confirmation, and genuinely ambiguous remote-selection prompts.
5. Extract only small pure argument-resolution helpers if needed and add focused tests for prompt-bypass/default resolution without coupling domain modules to Citty/Clack.

### 6. Stop swallowing unexpected scanner errors

1. Make Git repository detection distinguish an absent `.git` marker from filesystem access failures.
2. Make remote discovery return an empty list only for a successful Git query with no remotes; propagate missing-Git, corrupt/unreadable repository, and unexpected Git command errors with concise context.
3. Add reliable failure-path tests, using real Git/filesystem fixtures where possible and narrowly controlled process failure injection only where necessary.

### 7. Clarify root repository behavior

1. Decide and document the root repository representation before implementation because Step 3's non-root path rule conflicts with using `"."` as an ordinary repository path.
2. Preferred implementation: add an explicit root-repository representation to the schema rather than weakening all manifest path validation. If a `"."` sentinel is chosen instead, explicitly limit it to repositories and update the shared validator/resolver and documentation.
3. Scan the target itself before descendants; retain child-repository behavior and avoid descending into a detected repository.
4. Add scanner/setup tests for a child-repository workspace, root-only repository, and applicable root-with-normal-directory case.

### 8. Make path semantics explicit

1. Consolidate the manifest/native path boundary in the shared workspace helper introduced in Step 3.
2. Convert scanner-relative paths to POSIX at the boundary; resolve manifest paths to native paths only in setup.
3. Add portable tests for backslash input, POSIX manifest output, traversal rejection, and cross-platform-safe resolution semantics.

### 9. Improve doctor semantics

1. Inspect `src/commands/doctor.ts` and the manifest version-hint shape.
2. Extend doctor result modeling to distinguish available, missing, and available-but-incompatible tools while retaining Git, Node, and referenced package-manager checks.
3. Use a conservative, documented version comparison approach; consult current dependency documentation first if adding a semver dependency is warranted. Do not implement a fragile range parser.
4. Present concise compatibility warnings in the command layer and add focused doctor model tests.

### 10. Strengthen safety-critical tests

1. Review the completed tests for the listed safety cases: traversal/absolute paths, duplicates, malformed manifests, destination conflicts, root/nested repos, `.git` file worktrees, clone cleanup, Windows-style paths, and Git failures.
2. Add only missing cases, using temporary real Git repositories where practical.
3. Run the full test suite and TypeScript build.

### 11. Dependency and scope review

1. Review changed modules, dependency use (including whether `pathe` remains justified), command/domain separation, and documentation/comments.
2. Remove only clearly unnecessary helpers or dependencies; do not introduce functionality.
3. Run final `npm test` and `npm run build`.
4. Update this document to **complete** with schema version, verification results, known limitations, and intentionally excluded features; then provide the requested short user-facing summary.

## Decision log

| Decision | Status | Rationale |
| --- | --- | --- |
| `directories` represents standalone empty structural paths | Complete 2026-08-30 | These paths are useful when not implied by repository parents and never represent source or backup content. |
| Repository remote model gets a schema bump | Complete 2026-08-30 | Schema version 2 records named remotes and a selected `cloneRemote`. |
| Root repository representation | Pending Step 7 | Must reconcile root support with non-root path validation safely. |
| Version-range comparison strategy | Pending Step 9 | Must be conservative and based on verified library/API behavior. |
| Use `pathe` for all path operations | Complete 2026-08-30 | Audited source and tests; replaced the remaining `node:path` imports in filesystem/Git test fixtures. |

## Resume checklist

1. Read this file and `.ai/projects/architecture.md`.
2. Confirm the current step and working-tree status.
3. Read the listed source and test files for that step.
4. Implement only that step, add its focused tests, and record commands/results below.
5. Move the **Current step** marker and append verification notes before ending the session.

## Verification log

### Step 1 — Fix existing destination handling (complete)

- Existing targets are checked with `git -C <target> rev-parse --is-inside-work-tree` and `git -C <target> remote get-url origin`, which supports both `.git` directories and `.git` files/worktrees without parsing Git configuration.
- Only an existing worktree whose `origin` equals the manifest clone remote is skipped. Non-Git targets and mismatched remotes are reported as `WorkspaceSetupError.conflicts` and left untouched.
- Clone targets are explicitly created before cloning, so failure cleanup removes only a target created by this setup run. Other clones continue with the existing three-worker bound.
- Added setup coverage for matching remote skips, non-Git conflicts, wrong-remote conflicts, and missing-target clones.
- Passed `npm test -- tests/setup/setup.test.ts` (5 tests), `npm test` (9 tests), and `npm run build` on 2026-08-30.

### Step 2 — Define `directories` (complete)

- `directories` represents standalone, empty structural directories only. Repository paths and their parent directories are excluded because setup creates repository parents as needed.
- Scanner traversal now records nested empty structural directories and stops at Git repositories, so repository contents are never treated as structural directories.
- Added coverage for a nested repository path plus a nested standalone directory; setup coverage now verifies nested structural-directory creation alongside automatic repository-parent creation.
- Passed `npm test -- tests/scanner/scan.test.ts` (3 tests), `npm test -- tests/setup/setup.test.ts` (5 tests), and `npm run build` on 2026-08-30.

### Step 3 — Strengthen manifest validation (complete)

- Added shared POSIX manifest-path validation and safe native filesystem resolution in `src/workspace/path.ts`; setup now validates its input before creating anything and uses the shared resolver.
- Manifest validation now requires non-empty workspace/repository names and remotes, rejects root, absolute, traversal, backslash, and malformed paths, rejects duplicate/overlapping repository paths, and rejects directory/repository collisions.
- `readManifest` distinguishes malformed JSON from structurally invalid manifests with the manifest path in the error; `writeManifest` also refuses invalid persisted data.
- Added malformed/malicious manifest coverage and setup validation-before-creation coverage.
- Passed focused manifest tests (10 tests), focused setup tests (6 tests), `npm test` (24 tests), and `npm run build` on 2026-08-30.

### Step 4 — Preserve all Git remotes with an explicit clone remote (complete)

- Bumped the persisted manifest to schema version 2. Each repository now stores named `remotes` and the selected `cloneRemote`; version 1 manifests are intentionally unsupported without migration.
- Scanner persists every discovered remote, automatically chooses `origin`, automatically uses a sole non-origin remote, and invokes selection only for multiple remotes without `origin`.
- Setup clones from the selected remote URL using its preserved name, restores every other named remote, and validates existing worktrees against the selected remote.
- Updated the scan prompt to describe the only ambiguous selection case and documented the schema model in the architecture contract.
- Passed focused scanner tests (4 tests), focused manifest tests (12 tests), focused setup tests (6 tests), `npm test` (28 tests), and `npm run build` on 2026-08-30.

### Step 5 — Add optional CLI values while retaining prompts (complete)

- Consulted Citty's current argument documentation and verified that optional positionals use `type: "positional"` with `required: false`, while optional named values use `type: "string"`.
- Scan now accepts an optional workspace positional plus `--name` and `--output`; setup retains its optional manifest positional and now accepts `--destination`.
- Supplied values bypass only their matching text prompt. Overwrite confirmation, final safety confirmation, and ambiguous remote selection remain interactive.
- Added small command-value resolution helpers with focused prompt-bypass/default tests.
- Passed `npm test -- tests/commands/values.test.ts` (4 tests), `npm test` (32 tests), and `npm run build` on 2026-08-30.
