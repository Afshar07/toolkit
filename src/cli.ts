#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { createRequire } from "node:module";
import { contextCommand } from "./commands/context.js";
import { doctorCommand } from "./commands/doctor.js";
import { scanCommand } from "./commands/scan.js";
import { setupCommand } from "./commands/setup.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const main = defineCommand({
  meta: {
    name: "toolkit",
    version,
    description: "Create portable recipes for development workspaces",
  },
  subCommands: {
    context: contextCommand,
    scan: scanCommand,
    setup: setupCommand,
    doctor: doctorCommand,
  },
});

await runMain(main);
