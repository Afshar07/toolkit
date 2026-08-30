import os from "node:os";
import * as path from "pathe";
import { defineCommand } from "citty";
import * as prompts from "@clack/prompts";
import { setupOpenCodeAgents } from "../context/agents.js";
import { defaultAiContextOptions, setupAiContext } from "../context/setup.js";

export const contextCommand = defineCommand({
  meta: { name: "context", description: "Set up AI context and routing instructions" },
  args: {
    setup: { type: "boolean", description: "Create an AI context system in the current directory" },
    agents: { type: "boolean", description: "Create personal OpenCode agents" },
  },
  async run({ args }) {
    if (args.agents) return setupAgents();
    if (!args.setup) throw new Error("Pass --setup to create an AI context system or --agents to create OpenCode agents.");
    const defaults = defaultAiContextOptions(process.cwd());
    prompts.intro("Set up AI context");
    const workspaceName = await askText("What is this workspace called?", defaults.workspaceName);
    const workspacePurpose = await askText("What is this workspace for?", defaults.workspacePurpose);
    const projectScope = await askText("What does the primary project own?", defaults.projectScope);
    if (!await confirm("Create AGENTS.md and .ai/ in the current directory?")) cancelled();

    const files = await setupAiContext(process.cwd(), {
      ...defaults,
      workspaceName,
      workspacePurpose,
      projectScope,
    });
    prompts.outro(`Created ${files.length} AI context files. Customize .ai/projects/${defaults.projectId}.md as the project evolves.`);
  },
});

async function setupAgents(): Promise<void> {
  prompts.intro("Set up personal OpenCode agents");
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
}

async function askText(message: string, initialValue: string): Promise<string> {
  const value = await prompts.text({
    message,
    initialValue,
    validate: (answer) => answer?.trim() ? undefined : "A value is required.",
  });
  if (prompts.isCancel(value)) cancelled();
  return value.trim();
}

async function confirm(message: string): Promise<boolean> {
  const value = await prompts.confirm({ message, initialValue: true });
  if (prompts.isCancel(value)) cancelled();
  return value;
}

function cancelled(): never {
  prompts.cancel("AI context setup cancelled.");
  process.exit(0);
}
