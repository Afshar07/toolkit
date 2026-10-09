import type { IModelProfileIssue } from "./types.js";

export type ModelProfileErrorKind =
  /** A caller supplied a malformed name, preference, or selection. */
  | "invalid-input"
  /** A configuration file exists but is malformed. It is never overwritten. */
  | "invalid-config"
  /** A configuration file declares a schema version this Toolkit does not understand. */
  | "unsupported-schema"
  /** A path is a symbolic link or junction, is not a regular file, or escapes its root. */
  | "unsafe-path"
  | "filesystem";

/** Reserved for invalid configuration, unsafe paths, and filesystem failures; ordinary outcomes are result values. */
export class ModelProfileError extends Error {
  public readonly issues: readonly IModelProfileIssue[];
  public readonly filePath?: string;

  constructor(
    public readonly kind: ModelProfileErrorKind,
    message: string,
    options: { readonly issues?: readonly IModelProfileIssue[]; readonly filePath?: string; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ModelProfileError";
    this.issues = options.issues ?? [];
    this.filePath = options.filePath;
  }
}
