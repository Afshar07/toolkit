import { defineCommand } from "citty";
import * as prompts from "@clack/prompts";
import * as path from "pathe";
import { setupWorkspaceAt, WorkspaceSetupError } from "../setup/setup.js";
import { findWorkspaceManifests, readManifest } from "../workspace/manifest.js";
import { resolveSetupValues } from "./values.js";

export const setupCommand = defineCommand({
  meta: { name: "setup", description: "Recreate a workspace from a manifest" },
  args: {
    workspace: {
      type: "positional",
      description: "Workspace manifest file",
      required: false,
    },
    destination: {
      type: "string",
      description: "Destination directory",
    },
  },
  async run({ args }) {
    prompts.intro("Recreate a workspace");
    const { workspace: selected, destination } = await resolveSetupValues(args, {
      workspace: selectManifest,
      parseWorkspace: async (workspace) => {
        const manifestPath = path.resolve(workspace);
        return { path: manifestPath, manifest: await readManifest(manifestPath) };
      },
      destination: async (workspace) => {
        const value = await prompts.text({
          message: `Where should Toolkit create ${workspace.manifest.name}?`,
          initialValue: path.join(process.cwd(), workspace.manifest.name),
          validate: (value) => value?.trim() ? undefined : "Enter a destination directory.",
        });
        if (prompts.isCancel(value)) cancelled();
        return value;
      },
    });
    if (!(await confirm(`Create ${selected.manifest.name} at ${destination}?`)))
      cancelled();

    try {
      const result = await setupWorkspaceAt(
        selected.manifest,
        destination,
        (message) => prompts.log.step(message),
      );
      prompts.outro(
        `Setup complete: ${result.cloned.length} cloned, ${result.skipped.length} skipped.`,
      );
    } catch (error) {
      if (error instanceof WorkspaceSetupError) {
        prompts.log.error(error.message);
        process.exitCode = 1;
        return;
      }
      throw error;
    }
  },
});

async function selectManifest() {
  const manifests = await findWorkspaceManifests(process.cwd());
  if (manifests.length === 0) {
    throw new Error(
      `No compatible workspace manifest found in ${process.cwd()}. Pass one with: toolkit setup <manifest>.`,
    );
  }
  if (manifests.length === 1) return manifests[0]!;

  const selectedPath = await prompts.select({
    message: "Which workspace recipe should Toolkit use?",
    options: manifests.map((candidate) => ({
      value: candidate.path,
      label: candidate.manifest.name,
      hint: candidate.path,
    })),
  });
  if (prompts.isCancel(selectedPath)) cancelled();
  return manifests.find((candidate) => candidate.path === selectedPath)!;
}

async function confirm(message: string): Promise<boolean> {
  const value = await prompts.confirm({ message, initialValue: true });
  if (prompts.isCancel(value)) cancelled();
  return value;
}

function cancelled(): never {
  prompts.cancel("Setup cancelled.");
  process.exit(0);
}
