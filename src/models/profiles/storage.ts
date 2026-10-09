import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { assertSafeTargetDirectory } from "../../agents/target.js";
import { ModelProfileError } from "./errors.js";
import { supportedModelProfileSchemaVersion } from "./schema.js";
import type { IModelProfileIssue, IModelProfileLocation, ModelProfileValidation } from "./types.js";

/** Configuration is small; anything larger is not a profile document. */
export const maxConfigurationBytes = 1024 * 1024;

export interface IConfigurationDocument<T> {
  /** Human label for messages, e.g. `model profiles`. */
  readonly label: string;
  validate(value: unknown): ModelProfileValidation<T>;
}

export interface IReadConfiguration<T> {
  readonly value: T;
  readonly text: string;
}

/**
 * Reads and validates one document. An absent file is not an error (`undefined`); a present but
 * malformed, newer-schema, unsafe, or unreadable file always throws and is never repaired.
 */
export async function readConfiguration<T>(
  location: IModelProfileLocation,
  filePath: string,
  document: IConfigurationDocument<T>,
): Promise<IReadConfiguration<T> | undefined> {
  await assertSafeDirectory(location);
  const text = await readRegularFile(filePath);
  if (text === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw new ModelProfileError("invalid-config", `Invalid ${document.label} ${filePath}: invalid JSON.`, { filePath });
  }
  const version = typeof parsed === "object" && parsed !== null ? (parsed as { schemaVersion?: unknown }).schemaVersion : undefined;
  if (typeof version === "number" && version > supportedModelProfileSchemaVersion) {
    throw new ModelProfileError(
      "unsupported-schema",
      `Unsupported ${document.label} schemaVersion ${version} in ${filePath}; this Toolkit supports ${supportedModelProfileSchemaVersion}. Update Toolkit; the file was not modified.`,
      { filePath },
    );
  }
  const result = document.validate(parsed);
  if (!result.ok) {
    throw new ModelProfileError("invalid-config", `Invalid ${document.label} ${filePath}: ${summarize(result.issues)}`, { filePath, issues: result.issues });
  }
  return { value: result.value, text };
}

/**
 * Writes `text` atomically (exclusive temporary file in the same directory, then rename) and
 * returns whether anything changed. Writes nothing when the bytes are identical. A malformed or
 * unsupported existing file is rejected before any write, so it is never silently overwritten,
 * and a failed write leaves the previous file untouched.
 *
 * Callers read-modify-write without locking; concurrent writers can lose an update but can never
 * produce a partial file.
 */
export async function writeConfiguration<T>(
  location: IModelProfileLocation,
  filePath: string,
  document: IConfigurationDocument<T>,
  text: string,
): Promise<boolean> {
  const existing = await readConfiguration(location, filePath, document);
  if (existing?.text === text) return false;

  await assertSafeDirectory(location);
  await filesystem(() => mkdir(location.directory, { recursive: true }), filePath);
  await assertSafeDirectory(location);

  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporaryPath, text, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw toFilesystemError(error, filePath);
  }
  return true;
}

async function readRegularFile(filePath: string): Promise<string | undefined> {
  let size: number;
  try {
    const stat = await lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new ModelProfileError("unsafe-path", `Configuration is not a regular file (symbolic links are refused): ${filePath}`, { filePath });
    }
    size = stat.size;
  } catch (error) {
    if (error instanceof ModelProfileError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw toFilesystemError(error, filePath);
  }
  if (size > maxConfigurationBytes) {
    throw new ModelProfileError("invalid-config", `Configuration is larger than ${maxConfigurationBytes} bytes: ${filePath}`, { filePath });
  }
  return filesystem(() => readFile(filePath, "utf8"), filePath);
}

/** Reuses the agent lifecycle's symlink/junction and containment preflight for the models directory. */
async function assertSafeDirectory(location: IModelProfileLocation): Promise<void> {
  try {
    await assertSafeTargetDirectory(location, location.directory);
  } catch (error) {
    throw error instanceof ModelProfileError
      ? error
      : typeof (error as NodeJS.ErrnoException).code === "string"
        ? toFilesystemError(error, location.directory)
        : new ModelProfileError("unsafe-path", error instanceof Error ? error.message : "Unsafe model profile directory.", { filePath: location.directory, cause: error });
  }
}

async function filesystem<T>(operation: () => Promise<T>, filePath: string): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw toFilesystemError(error, filePath);
  }
}

function toFilesystemError(error: unknown, filePath: string): ModelProfileError {
  if (error instanceof ModelProfileError) return error;
  const detail = error instanceof Error ? error.message : "unknown error";
  return new ModelProfileError("filesystem", `Model profile file operation failed for ${filePath}: ${detail}`, { filePath, cause: error });
}

function summarize(issues: readonly IModelProfileIssue[]): string {
  const shown = issues.slice(0, 3).map((issue) => `${issue.path}: ${issue.message}`).join("; ");
  return issues.length > 3 ? `${shown}; and ${issues.length - 3} more.` : shown;
}
