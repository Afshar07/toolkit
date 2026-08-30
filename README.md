# @afshar7/toolkit

Toolkit creates portable **workspace recipes**: declarative manifests for reconstructing workspace structure, not backups of arbitrary local files.

```sh
toolkit scan
toolkit scan .
toolkit scan . --name trigate
toolkit scan . --name trigate --output ./trigate.workspace.json

toolkit setup
toolkit setup ./trigate.workspace.json
toolkit setup ./trigate.workspace.json --destination ~/work

toolkit doctor --workspace ./trigate.workspace.json
```

`scan` is interactive by default. A supplied workspace, name, or output skips that prompt. It records a root Git repository when the workspace itself is a repository, otherwise discovers child Git repositories using relative paths. Every discovered remote is recorded; `origin` is selected for cloning when available, and Toolkit asks you to choose when multiple remotes exist without an `origin`.

Recipes also record package-manager lockfile hints, Node-version hints, and standalone structural or empty directories where applicable. Generated, sensitive, and machine-specific directories (such as `.git`, `node_modules`, `.nuxt`, `dist`, and IDE caches) are ignored.

`setup` is interactive by default; a supplied manifest or destination skips the matching prompt. It recreates declared directories and clones repositories without installing dependencies. Existing destinations are validated as matching Git repositories and skipped; non-matching repositories or other existing content are reported as conflicts and never overwritten. If the selected clone remote fails, interactive setup can retry another recorded remote and updates the recipe’s selection after a successful fallback clone. If a secondary remote cannot be configured, the successful clone is kept and the setup error names the repository and remote.

`doctor` checks Git, Node, and recorded package managers. Node compatibility is checked only for exact `major.minor.patch` hints (with an optional `v`); ranges and major-only hints remain advisory.
