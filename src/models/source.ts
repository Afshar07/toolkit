import { execa } from "execa";
import { ModelDiscoveryError } from "./errors.js";
import type { IModelDiscoverySource, IOpenCodeModelSourceOptions } from "./types.js";

export const defaultOpenCodeCommand = "opencode";
export const defaultDiscoveryTimeoutMs = 30_000;
export const defaultMaxOutputBytes = 5 * 1024 * 1024;

interface IProcessFailure {
  code?: string;
  timedOut?: boolean;
  isMaxBuffer?: boolean;
  exitCode?: number;
  stderr?: unknown;
}

/**
 * Runs `opencode models` directly (no shell, no stdin) with a timeout and output cap.
 * Errors describe the failure without echoing the command line or environment.
 */
export function createOpenCodeModelSource(options: IOpenCodeModelSourceOptions = {}): IModelDiscoverySource {
  const command = options.command ?? defaultOpenCodeCommand;
  const commandArguments = [...(options.arguments ?? ["models"])];
  const timeoutMs = options.timeoutMs ?? defaultDiscoveryTimeoutMs;
  const maxOutputBytes = options.maxOutputBytes ?? defaultMaxOutputBytes;
  if (command.trim() === "" || command.includes("\0")) throw new TypeError("OpenCode command must be a non-empty executable name or path.");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("Model discovery timeout must be a positive number of milliseconds.");
  if (!Number.isFinite(maxOutputBytes) || maxOutputBytes <= 0) throw new TypeError("Model discovery output limit must be a positive number of bytes.");

  return {
    async read() {
      try {
        const result = await execa(command, commandArguments, {
          cwd: options.cwd,
          env: { NO_COLOR: "1", ...options.environment },
          stdin: "ignore",
          timeout: timeoutMs,
          maxBuffer: maxOutputBytes,
          windowsHide: true,
        });
        return String(result.stdout);
      } catch (error) {
        throw classifyFailure(error as IProcessFailure, command, timeoutMs);
      }
    },
  };
}

function classifyFailure(failure: IProcessFailure, command: string, timeoutMs: number): ModelDiscoveryError {
  if (failure.code === "ENOENT" || looksLikeMissingCommand(failure)) {
    return new ModelDiscoveryError("unavailable", `OpenCode CLI "${command}" was not found. Install OpenCode or make it available on PATH.`);
  }
  if (failure.timedOut) {
    return new ModelDiscoveryError("timeout", `OpenCode model discovery did not finish within ${timeoutMs}ms.`);
  }
  if (failure.isMaxBuffer) {
    return new ModelDiscoveryError("output-too-large", "OpenCode model discovery produced more output than the configured limit.");
  }
  if (typeof failure.exitCode === "number") {
    // Provider errors can include credentials or complete configuration objects. Never
    // relay untrusted stderr, even when bounded; inspect it locally in OpenCode instead.
    return new ModelDiscoveryError("exit", `OpenCode model discovery exited with code ${failure.exitCode}. Run opencode models locally to inspect provider diagnostics (stderr withheld to protect credentials).`, failure.exitCode);
  }
  return new ModelDiscoveryError("failed", `OpenCode model discovery could not run${failure.code ? ` (${failure.code})` : ""}.`);
}

/** On Windows, an unresolved command falls back to `cmd.exe`, which exits 1 with this message instead of raising ENOENT. */
function looksLikeMissingCommand(failure: IProcessFailure): boolean {
  if (typeof failure.stderr !== "string") return false;
  return failure.exitCode === 1 && /is not recognized as an internal or external command/i.test(failure.stderr);
}
