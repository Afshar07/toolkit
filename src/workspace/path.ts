import * as path from "pathe";

export function assertManifestPath(manifestPath: string): void {
  if (!manifestPath || manifestPath.startsWith("/") || manifestPath.includes("\\")
    || /^[A-Za-z]:/.test(manifestPath) || path.isAbsolute(manifestPath)) {
    throw new Error(`must be a non-root relative POSIX path: ${manifestPath}`);
  }

  const segments = manifestPath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`must not contain empty, current-directory, or parent-directory segments: ${manifestPath}`);
  }
}

export function resolveManifestPath(root: string, manifestPath: string): string {
  assertManifestPath(manifestPath);
  const resolved = path.resolve(root, ...manifestPath.split("/"));
  const relative = path.relative(root, resolved);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Manifest path escapes workspace: ${manifestPath}`);
  }
  return resolved;
}

export function toManifestPath(root: string, filesystemPath: string): string {
  const relative = path.relative(root, filesystemPath).replaceAll("\\", "/");
  if (!relative) return ".";
  assertManifestPath(relative);
  return relative;
}
