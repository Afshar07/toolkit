import * as path from "pathe";
import { resolveAgentTarget, type AgentTarget, type IAgentTarget } from "../../agents/target.js";
import { readSafeText } from "./safe-write.js";
import { parseOpenCodeConfig } from "./jsonc-editor.js";

export interface IOpenCodeConfigFile {
  readonly path: string;
  readonly text: string | undefined;
  readonly value: Record<string, unknown>;
}
export type OpenCodeConfigInspection =
  | { readonly status: "ready"; readonly target: IAgentTarget; readonly file: IOpenCodeConfigFile }
  | { readonly status: "config-conflict"; readonly target: IAgentTarget; readonly files: readonly string[] };

/** Never choose between competing supported files, including root versus .opencode. */
export async function inspectOpenCodeConfig(target: AgentTarget): Promise<OpenCodeConfigInspection> {
  const selected = resolveAgentTarget(target);
  const names = selected.scope === "global" ? ["opencode.json", "opencode.jsonc"]
    : ["opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc"];
  const existing: IOpenCodeConfigFile[] = [];
  for (const name of names) {
    const filePath = path.join(selected.root, name);
    const text = await readSafeText(selected, filePath);
    if (text !== undefined) existing.push({ path: filePath, text, value: parseOpenCodeConfig(text) });
  }
  if (existing.length > 1) return { status: "config-conflict", target: selected, files: existing.map((file) => file.path) };
  return { status: "ready", target: selected, file: existing[0] ?? { path: path.join(selected.root, "opencode.jsonc"), text: undefined, value: {} } };
}
