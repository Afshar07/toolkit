import { lstat, realpath } from "node:fs/promises";
import * as path from "node:path";

export interface IFilesystemRoot {
  lexical: string;
  real: string;
}

export async function filesystemRoot(root: string): Promise<IFilesystemRoot> {
  const lexical = path.resolve(root);
  const stat = await lstat(lexical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe destination root: ${lexical}`);
  return { lexical, real: await realpath(lexical) };
}

/** Validate an existing target or its nearest existing parent without following a link outside root. */
export async function assertSafeProjectPath(root: IFilesystemRoot, candidate: string, label: string): Promise<void> {
  const target = path.resolve(candidate);
  if (!isWithin(root.lexical, target)) throw new Error(`${label} escapes the destination`);
  let cursor = target;
  while (true) {
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error(`${label} contains a symbolic link`);
      const resolved = await realpath(cursor);
      if (!isWithin(root.real, resolved)) throw new Error(`${label} resolves outside the destination`);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (cursor === root.lexical) throw new Error(`${label} cannot be inspected safely`);
      cursor = path.dirname(cursor);
    }
  }
}

export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
