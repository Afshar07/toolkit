# Context maintenance

- Keep Markdown context discoverable and authoritative.
- Update routing when project ownership, paths, or workflow boundaries change.
- Keep cross-session task state in the selected project's `ongoing/` directory
  and list each active task in its `README.md`.
- Read only the ongoing task matching the current work; do not use a global
  current-task pointer.
- Move durable decisions into focused guidance when a task finishes, then remove
  its ongoing entry and task document.
- Do not introduce generated routing JSON or history directories.
