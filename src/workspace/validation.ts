import * as path from "node:path";

const credentialQueryNames = /^(?:access[_-]?token|api[_-]?key|auth|key|password|secret|token)$/i;

export function assertWorkspaceName(name: string): void {
  if (!name.trim() || name === "." || name === ".." || name.includes("/") || name.includes("\\")
    || path.posix.isAbsolute(name) || path.win32.isAbsolute(name) || /^[A-Za-z]:/.test(name)) {
    throw new Error("name must be a portable single directory name without traversal, separators, or drive prefixes");
  }
}

export function assertSafeGitRemoteUrl(value: string): void {
  if (!value.trim() || value.startsWith("-")) throw new Error("Git remote URL must not be empty or option-like");
  if (!/^https?:\/\//i.test(value)) return;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Git remote URL is invalid"); }
  if (url.username || url.password || [...url.searchParams.keys()].some((key) => credentialQueryNames.test(key))) {
    throw new Error("Git remote URL contains credentials; use SSH or a credential manager instead");
  }
}
