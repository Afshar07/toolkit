import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile, link } from "node:fs/promises";
import * as path from "pathe";
import { assertSafeTargetDirectory, type IAgentTarget } from "../../agents/target.js";
import { ModelProfileError } from "../profiles/errors.js";

export async function readSafeText(target: IAgentTarget, filePath: string): Promise<string | undefined> {
  await assertSafeTargetDirectory(target, path.dirname(filePath));
  try {
    const stat = await lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ModelProfileError("unsafe-path", `Not a regular file: ${filePath}`);
    if (stat.size > 1024 * 1024) throw new ModelProfileError("invalid-config", `Configuration exceeds 1 MiB: ${filePath}`);
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Exact-byte optimistic concurrency check; not a lock against other applications. */
export async function assertSnapshot(target: IAgentTarget, filePath: string, expected: string | undefined): Promise<void> {
  if (await readSafeText(target, filePath) !== expected) throw new ModelProfileError("filesystem", `File changed since planning; re-plan: ${filePath}`);
}

/** Same-directory atomic replacement, exclusive backup, and exact-byte recheck before promotion. */
export async function writeSafeText(target: IAgentTarget, filePath: string, expected: string | undefined, text: string): Promise<string | undefined> {
  await assertSnapshot(target, filePath, expected);
  if (expected === text) return undefined;
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  await assertSafeTargetDirectory(target, directory);
  const suffix = `${process.pid}.${randomBytes(8).toString("hex")}`;
  const temporary = `${filePath}.${suffix}.tmp`;
  const backup = expected === undefined ? undefined : `${filePath}.${suffix}.bak`;
  const mode = expected === undefined ? 0o600 : (await lstat(filePath)).mode & 0o777;
  let backupCreated = false;
  try {
    if (backup) {
      await writeFile(backup, expected!, { encoding: "utf8", flag: "wx", mode });
      backupCreated = true;
    }
    await writeFile(temporary, text, { encoding: "utf8", flag: "wx", mode });
    await assertSnapshot(target, filePath, expected);
    if (expected === undefined) {
      // link provides exclusive promotion: a concurrent creator cannot be overwritten.
      await link(temporary, filePath);
      await rm(temporary);
    } else await rename(temporary, filePath);
    return backup;
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    // Keep any backup for recovery, including when promotion failed.
    if (error instanceof Error && backupCreated) Object.assign(error, { backupPath: backup });
    throw error;
  }
}
