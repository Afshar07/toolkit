import os from "node:os";
import { statSync } from "node:fs";
import * as path from "pathe";
import { defineCommand } from "citty";
import * as prompts from "@clack/prompts";
import { setupOpenCodeAgents } from "../context/agents.js";
import { defaultAiContextOptions, setupAiContext } from "../context/setup.js";
import { validateAiContext } from "../context/validate.js";
import { parseContextProject, resolveContextInitValues } from "./values.js";

export const contextCommand = defineCommand({
  meta: { name: "context", description: "Create and validate AI context" },
  subCommands: {
    init: defineCommand({
      meta: { name: "init", description: "Create AI context" },
      args: {
        destination: { type: "positional", description: "Destination directory", required: false },
        name: { type: "string", description: "Workspace name" },
        purpose: { type: "string", description: "Workspace purpose" },
        "context-path": { type: "string", description: "Shared context directory" },
        project: { type: "string", description: "Project in id:path form" },
        "non-interactive": { type: "boolean", description: "Require all initialization values as flags" },
      },
      async run({ args }) {
        const destination = typeof args.destination === "string" ? args.destination : process.cwd();
        const defaults = defaultAiContextOptions(destination);
        if (!args["non-interactive"]) prompts.intro("Set up AI context");
        const values = await resolveContextInitValues(args as Parameters<typeof resolveContextInitValues>[0], {
          destination: async () => askText("Where should Toolkit create the context?", process.cwd(), (value) => {
            try {
              return statSync(path.resolve(value ?? "")).isDirectory() ? undefined : "Enter an existing directory.";
            } catch {
              return "That directory does not exist.";
            }
          }),
          name: async (selectedDestination) => askText("What is this workspace called?", defaultAiContextOptions(selectedDestination).workspaceName),
          purpose: async () => askText("What is this workspace for?", defaults.workspacePurpose),
          contextPath: async () => askText("Where should shared context live?", defaults.contextPath!),
          project: async () => askText("What is the primary project? Use id:path.", `${defaults.projectId}:.`),
        });
        if (!args["non-interactive"] && !await confirm(`Create AGENTS.md and context files in ${path.resolve(values.destination)}?`)) cancelled();
        const files = await setupAiContext(values.destination, {
          workspaceName: values.name,
          workspacePurpose: values.purpose,
          contextPath: values.contextPath,
          projects: values.projects.map((project) => ({ id: project.id, path: project.path, scope: `Primary project in this workspace.` })),
        });
        if (args["non-interactive"]) console.log(`Created ${files.length} AI context files.`);
        else prompts.outro(`Created ${files.length} AI context files.`);
      },
    }),
    validate: defineCommand({
      meta: { name: "validate", description: "Validate AI context without changing files" },
      args: { destination: { type: "positional", description: "Workspace directory" } },
      async run({ args }) {
        const result = await validateAiContext(typeof args.destination === "string" ? args.destination : process.cwd());
        for (const item of result.issues) prompts.log[item.severity](item.message);
        if (result.valid) prompts.outro("AI context is valid.");
        else throw new Error(`AI context validation failed with ${result.issues.filter((item) => item.severity === "error").length} error(s).`);
      },
    }),
    agents: defineCommand({
      meta: { name: "agents", description: "Create personal OpenCode agents" },
      async run() {
        const scope = await prompts.select({
          message: "Where should the agents be available?",
          options: [
            { value: "local", label: "This workspace", hint: ".opencode/agents" },
            { value: "global", label: "All workspaces", hint: "~/.config/opencode/agents" },
          ],
        });
        if (prompts.isCancel(scope)) cancelled();
        const destination = scope === "local"
          ? path.join(process.cwd(), ".opencode", "agents")
          : path.join(os.homedir(), ".config", "opencode", "agents");
        if (!await confirm(`Create four OpenCode agent files in ${destination}?`)) cancelled();
        const files = await setupOpenCodeAgents(destination);
        prompts.outro(`Created ${files.length} OpenCode agents in ${destination}. Restart OpenCode to load them.`);
      },
    }),
  },
});

async function askText(message: string, initialValue: string, validate?: (value: string | undefined) => string | undefined): Promise<string> {
  const value = await prompts.text({
    message,
    initialValue,
    validate: (answer) => answer?.trim() ? validate?.(answer) : "A value is required.",
  });
  if (prompts.isCancel(value)) cancelled();
  return value.trim();
}
async function confirm(message: string): Promise<boolean> {
  const value = await prompts.confirm({ message, initialValue: true });
  if (prompts.isCancel(value)) cancelled();
  return value;
}
function cancelled(): never { prompts.cancel("AI context setup cancelled."); process.exit(0); }

// Keep the parser available to CLI consumers that need to resolve repeated flags.
export { parseContextProject };
