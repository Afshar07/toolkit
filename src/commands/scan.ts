import { defineCommand } from "citty";
import * as prompts from "@clack/prompts";
import { existsSync, statSync } from "node:fs";
import * as path from "pathe";
import { scanWorkspace } from "../scanner/scan.js";
import { writeManifest } from "../workspace/manifest.js";

export const scanCommand = defineCommand({
  meta: { name: "scan", description: "Create a portable workspace manifest" },
  async run() {
    prompts.intro("Create a workspace recipe");
    const workspace = await askText("Which workspace should Toolkit scan?", process.cwd(), (value) => {
      try {
        return statSync(path.resolve(value ?? "")).isDirectory() ? undefined : "Enter a directory path.";
      } catch {
        return "That directory does not exist.";
      }
    });
    const workspacePath = path.resolve(workspace);
    const name = await askText("What should this workspace be called?", path.basename(workspacePath));
    const output = await askText("Where should Toolkit save the recipe?", path.join(process.cwd(), `${name}.workspace.json`), (value) => {
      return existsSync(path.dirname(path.resolve(value ?? ""))) ? undefined : "Its parent directory does not exist.";
    });

    if (existsSync(output) && !await askConfirm(`${output} already exists. Replace it?`, false)) cancelled();
    if (!await askConfirm("Scan this workspace and create the recipe?", true)) cancelled();

    const spinner = prompts.spinner();
    spinner.start("Scanning workspace");
    const manifest = await scanWorkspace(workspacePath, {
      selectRemote: async (repository) => {
        const remoteName = await prompts.select({
          message: `${repository.path} has multiple remotes without an origin. Which should Toolkit clone?`,
          options: repository.remotes.map((remote) => ({ value: remote.name, label: remote.name, hint: remote.url })),
        });
        if (prompts.isCancel(remoteName)) cancelled();
        return repository.remotes.find((remote) => remote.name === remoteName);
      },
    });
    manifest.name = name;
    await writeManifest(output, manifest);
    spinner.stop(`Found ${manifest.repositories.length} reconstructable ${manifest.repositories.length === 1 ? "repository" : "repositories"}.`);
    prompts.outro(`Saved ${output}`);
  },
});

async function askText(message: string, initialValue: string, validate?: (value: string | undefined) => string | undefined): Promise<string> {
  const value = await prompts.text({
    message,
    initialValue,
    validate(value) {
      if (!value?.trim()) return "A value is required.";
      return validate?.(value);
    },
  });
  if (prompts.isCancel(value)) cancelled();
  return value.trim();
}

async function askConfirm(message: string, initialValue: boolean): Promise<boolean> {
  const value = await prompts.confirm({ message, initialValue });
  if (prompts.isCancel(value)) cancelled();
  return value;
}

function cancelled(): never {
  prompts.cancel("Scan cancelled.");
  process.exit(0);
}
