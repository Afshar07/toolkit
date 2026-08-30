# @afshar7/toolkit

Create portable recipes for development workspaces containing independent Git repositories.

```sh
toolkit scan
toolkit setup
toolkit doctor --workspace workspace.json
```

`scan` writes a human-readable `workspace.json` describing cloneable Git repositories, their relative paths, package-manager lockfile hints, Node-version hints, and top-level normal directories. It ignores generated, sensitive, and machine-specific directories such as `.git`, `node_modules`, `.nuxt`, `dist`, and IDE caches.

`setup` finds compatible workspace recipes in the current directory (or accepts one as `toolkit setup <manifest>`), then interactively asks where to create the workspace. It creates recorded normal directories and clones only repositories whose destination does not already exist. It does not install dependencies or overwrite files.

`scan` interactively asks for the workspace directory, workspace name, and output location, each with a useful default. When a repository has multiple Git remotes, it asks which one should be used to recreate it.
