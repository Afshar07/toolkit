#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { createRequire } from "node:module";
import { contextCommand } from "./commands/context.js";
import { doctorCommand } from "./commands/doctor.js";
import { scanCommand } from "./commands/scan.js";
import { setupCommand } from "./commands/setup.js";
import { agentsCommand } from "./commands/agents.js";
import { registryCommand } from "./commands/registry.js";
import { modelsCommand } from "./commands/models.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const main = defineCommand({
  meta: {
    name: "toolkit",
    version,
    description: "Create portable recipes for development workspaces",
  },
  subCommands: {
    models: modelsCommand,
    agents: agentsCommand,
    registry: registryCommand,
    context: contextCommand,
    scan: scanCommand,
    setup: setupCommand,
    doctor: doctorCommand,
  },
});

await runMain(main);
