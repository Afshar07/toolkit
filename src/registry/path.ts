import os from "node:os";
import * as path from "pathe";

export interface IToolkitRegistryPaths {
  root: string;
  agents: string;
}

export function resolveToolkitRegistryPaths(homeDirectory = os.homedir()): IToolkitRegistryPaths {
  const root = path.resolve(homeDirectory, ".toolkit", "registry");
  return { root, agents: path.join(root, "agents") };
}
