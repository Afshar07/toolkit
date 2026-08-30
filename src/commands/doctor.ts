import { defineCommand } from "citty";
import * as path from "pathe";
import { checkPrerequisites } from "../doctor/doctor.js";
import { readManifest } from "../workspace/manifest.js";

export const doctorCommand = defineCommand({
  meta: { name: "doctor", description: "Check workspace prerequisites" },
  args: {
    workspace: { type: "string", description: "Optional workspace manifest file", alias: ["w"] },
  },
  async run({ args }) {
    const manifest = args.workspace ? await readManifest(path.resolve(args.workspace)) : undefined;
    const prerequisites = await checkPrerequisites(manifest);
    for (const prerequisite of prerequisites) {
      console.log(`${prerequisite.available ? "✓" : "✗"} ${prerequisite.name}${prerequisite.version ? ` ${prerequisite.version}` : ""}`);
    }
    if (prerequisites.some((prerequisite) => !prerequisite.available)) process.exitCode = 1;
  },
});
