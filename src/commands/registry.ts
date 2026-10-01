import { defineCommand } from "citty";
import { initializeToolkitRegistry, inspectToolkitRegistry, updateToolkitRegistry } from "../registry/registry.js";
import { resolveToolkitRegistryPaths } from "../registry/path.js";

export const registryCommand = defineCommand({
  meta: { name: "registry", description: "Manage the machine-wide Toolkit registry" },
  subCommands: {
    init: defineCommand({
      meta: { name: "init", description: "Initialize the sparse Git-backed registry" },
      async run() {
        const paths = resolveToolkitRegistryPaths();
        const registry = await initializeToolkitRegistry(paths);
        console.log(`Toolkit registry initialized at ${paths.root} (agents ${registry.version}).`);
      },
    }),
    update: defineCommand({
      meta: { name: "update", description: "Fast-forward the Toolkit registry" },
      async run() {
        const paths = resolveToolkitRegistryPaths();
        const registry = await updateToolkitRegistry(paths);
        console.log(`Toolkit registry updated (agents ${registry.version}).`);
      },
    }),
    status: defineCommand({
      meta: { name: "status", description: "Show local Toolkit registry information" },
      async run() {
        const info = await inspectToolkitRegistry(resolveToolkitRegistryPaths());
        console.log("Toolkit registry\n");
        console.log(`Path:     ${info.path}`);
        console.log(`Version:  ${info.version}`);
        console.log(`Commit:   ${info.commit.slice(0, 8)}`);
        console.log(`Branch:   ${info.branch}`);
        console.log(`Status:   ${info.clean ? "clean" : "modified"}`);
      },
    }),
  },
});
