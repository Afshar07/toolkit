import * as path from "pathe";
import { ModelProfileError } from "../profiles/errors.js";
import { isValidAgentName, isCompleteModelId } from "../profiles/schema.js";
import type { IAgentTarget } from "../../agents/target.js";
import { readSafeText } from "./safe-write.js";

export interface IAppliedModelRecord {
  readonly config: string;
  readonly model: string;
}
export interface IAppliedModelOwnership {
  readonly schemaVersion: 1;
  readonly agents: Readonly<Record<string, IAppliedModelRecord>>;
}
export const appliedModelOwnershipRelativePath = ".toolkit/models/applied.json";

export async function readAppliedModelOwnership(target: IAgentTarget): Promise<{ readonly path: string; readonly text: string | undefined; readonly value: IAppliedModelOwnership }> {
  const filePath = path.join(target.root, appliedModelOwnershipRelativePath);
  const text = await readSafeText(target, filePath);
  if (text === undefined) return { path: filePath, text, value: { schemaVersion: 1, agents: {} } };
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new ModelProfileError("invalid-config", `Invalid applied model ownership: ${filePath}`); }
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.agents)
    || Object.keys(value).some((key) => !["schemaVersion", "agents"].includes(key))
    || !Object.entries(value.agents).every(([name, record]) => isValidAgentName(name) && isRecord(record)
      && Object.keys(record).length === 2 && typeof record.config === "string"
      && ["opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc"].includes(record.config)
      && isCompleteModelId(record.model))) {
    throw new ModelProfileError("invalid-config", `Invalid or unsupported applied model ownership: ${filePath}`);
  }
  return { path: filePath, text, value: value as unknown as IAppliedModelOwnership };
}

export function serializeAppliedModelOwnership(value: IAppliedModelOwnership): string {
  return `${JSON.stringify({ schemaVersion: 1, agents: Object.fromEntries(Object.entries(value.agents).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) }, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
