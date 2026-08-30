import { defineCommand } from "citty";
import * as prompts from "@clack/prompts";
import * as path from "pathe";
import { setupWorkspaceAt, WorkspaceSetupError } from "../setup/setup.js";
import { findWorkspaceManifests, readManifest, type GitRemote, type Repository, type WorkspaceManifest, writeManifest } from "../workspace/manifest.js";
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

    let updatedCloneRemote = false;
    let result;
    let setupError: unknown;
    try {
      result = await setupWorkspaceAt(
        selected.manifest,
        destination,
        (message) => prompts.log.step(message),
        {
          selectFallbackRemote: selectFallbackRemote,
          onCloneRemoteChanged(repository, remote) {
            setCloneRemote(selected.manifest, repository, remote);
            updatedCloneRemote = true;
          },
        },
      );
    } catch (error) {
      setupError = error;
    }
    if (updatedCloneRemote) {
      try {
        await writeManifest(selected.path, selected.manifest);
      } catch (error) {
        const message = `A fallback remote cloned successfully, but Toolkit could not update ${selected.path}: ${error instanceof Error ? error.message : "unknown error"}.`;
        if (setupError instanceof WorkspaceSetupError) {
          prompts.log.error(`${setupError.message} ${message}`);
          process.exitCode = 1;
          return;
        }
        throw new Error(message, { cause: error });
      }
    }
    if (setupError instanceof WorkspaceSetupError) {
      prompts.log.error(setupError.message);
      process.exitCode = 1;
      return;
    }
    if (setupError) throw setupError;
    prompts.outro(
      `Setup complete: ${result!.cloned.length} cloned, ${result!.skipped.length} skipped.`,
    );
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

async function selectFallbackRemote(repository: Repository, failedRemote: GitRemote): Promise<GitRemote | undefined> {
  const remotes = repository.remotes.filter((remote) => remote.name !== failedRemote.name);
  if (remotes.length === 0) return undefined;
  const selectedRemote = await prompts.select({
    message: `Cloning ${repository.path} from ${failedRemote.name} failed. Choose another remote or skip it.`,
    options: [
      ...remotes.map((remote) => ({ value: remote.name, label: remote.name, hint: remote.url })),
      { value: "", label: "Skip this repository" },
    ],
  });
  if (prompts.isCancel(selectedRemote)) cancelled();
  return remotes.find((remote) => remote.name === selectedRemote);
}

function setCloneRemote(manifest: WorkspaceManifest, repository: Repository, remote: GitRemote): void {
  if (repository.path === ".") {
    manifest.rootRepository!.cloneRemote = remote.name;
    return;
  }
  manifest.repositories.find((candidate) => candidate.path === repository.path)!.cloneRemote = remote.name;
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
