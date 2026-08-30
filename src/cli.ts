#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { doctorCommand } from "./commands/doctor.js";
import { scanCommand } from "./commands/scan.js";
import { setupCommand } from "./commands/setup.js";

const main = defineCommand({
  meta: {
    name: "toolkit",
    version: "0.1.1",
    description: "Create portable recipes for development workspaces",
  },
  subCommands: {
    scan: scanCommand,
    setup: setupCommand,
    doctor: doctorCommand,
  },
});

await runMain(main);
