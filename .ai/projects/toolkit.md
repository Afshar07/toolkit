# toolkit

## Scope

The CLI for creating portable workspace recipes and routed AI context scaffolds.

## Local context

When working directly in this project, add focused routes only when a real boundary appears. Do not load every local document by default.

## Ownership boundaries

- This project owns its implementation details and local conventions.
- Put cross-project contracts in `.ai/domains/` and route them from the applicable
  local `.ai/README.md`.

## Verification

- Use npm, as established by `package-lock.json`.
- Run `npm test` for behavior changes and `npm run build` for TypeScript and
  distributable-output verification.
