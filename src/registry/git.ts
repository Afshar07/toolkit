import { lstat, mkdir, rename, rm } from "node:fs/promises";
import * as path from "pathe";
import { execa } from "execa";

export const defaultToolkitRegistryRemote = "git@github.com:Afshar07/toolkit.git";
export const toolkitSparsePaths = ["agents"] as const;

export interface IGitRegistryInfo {
  commit: string;
  branch: string;
  clean: boolean;
}

export interface IRegistryGitOptions {
  remote?: string;
  sparsePaths?: readonly string[];
}

export type RegistryCheckoutValidator<Result = void> = (checkoutRoot: string) => Promise<Result>;

export class RegistryGitError extends Error {
  constructor(message: string, public readonly kind: "unavailable" | "dirty" | "command") { super(message); }
}

export async function initializeGitRegistry<Result>(
  root: string,
  validateCheckout: RegistryCheckoutValidator<Result>,
  options: IRegistryGitOptions = {},
): Promise<Result> {
  const parent = path.dirname(root);
  await mkdir(parent, { recursive: true });
  const temporary = path.join(parent, `.registry-${process.pid}-${Date.now()}.tmp`);
  try {
    await git(["clone", "--filter=blob:none", "--no-checkout", options.remote ?? defaultToolkitRegistryRemote, temporary]);
    await git(["-C", temporary, "sparse-checkout", "init", "--no-cone"]);
    await git(["-C", temporary, "sparse-checkout", "set", ...(options.sparsePaths ?? toolkitSparsePaths).map((entry) => `/${entry}/`)]);
    await git(["-C", temporary, "checkout"]);
    const result = await validateCheckout(temporary);
    await assertPromotionTargetIsAbsent(root);
    await rename(temporary, root);
    return result;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function assertPromotionTargetIsAbsent(root: string): Promise<void> {
  try {
    await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new RegistryGitError(`Toolkit registry path already exists; refusing to replace it: ${root}`, "command");
}

export async function updateGitRegistry(root: string): Promise<void> {
  const info = await inspectGitRegistry(root);
  if (!info.clean) throw new RegistryGitError("Toolkit registry has local modifications; refusing to update it.", "dirty");
  await git(["-C", root, "pull", "--ff-only"]);
}

export async function inspectGitRegistry(root: string): Promise<IGitRegistryInfo> {
  const [{ stdout: commit }, { stdout: branch }, { stdout: status }] = await Promise.all([
    git(["-C", root, "rev-parse", "HEAD"]),
    git(["-C", root, "branch", "--show-current"]),
    git(["-C", root, "status", "--porcelain"]),
  ]);
  return { commit: commit.trim(), branch: branch.trim() || "detached", clean: status.trim().length === 0 };
}

async function git(arguments_: string[]) {
  try {
    return await execa("git", arguments_);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new RegistryGitError("Git is required to refresh the Toolkit registry.", "unavailable");
    const message = error instanceof Error ? error.message : "Git command failed";
    throw new RegistryGitError(message, "command");
  }
}
