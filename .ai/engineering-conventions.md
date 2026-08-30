# Engineering Conventions

Read when writing or changing code, tests, configuration, documentation, or performing normal verification.

## Coding

- Preserve public behavior and contracts unless the task explicitly changes them.
- Prefer the simplest implementation that satisfies the acceptance criteria.
- Do not introduce abstractions or compatibility behavior without evidence.

## Verification

- Use the active project's documented package manager and commands.
- Run targeted checks for the changed boundary.
- Report environment failures separately from code failures.
- State what was and was not verified.
