# Context maintenance

- Keep Markdown context discoverable and authoritative.
- Update routing when project ownership, paths, or workflow boundaries change.
- Keep cross-session task state in the selected project's `ongoing/` directory
  and list each active task in its `README.md`.
- Read only the ongoing task matching the current work; do not use a global
  current-task pointer.
- Move durable decisions into focused guidance when a task finishes, then remove
  its ongoing entry and task document.
- Keep unresolved engineering debt in the shared context's `technical-debt/`
  directory and index each record in its `README.md`. Use `TEMPLATE.md` to record
  scope, dated evidence, impact, migration constraints, completion criteria, and
  verification; refresh evidence before implementation.
- Debt records are deferred work, not active task state or permission to begin
  implementation. Read only relevant records. Update the record and index when
  debt is resolved or its disposition changes.
- Do not introduce generated routing JSON or history directories.
