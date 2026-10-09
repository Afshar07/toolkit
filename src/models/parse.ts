import { createModelRef } from "./normalize.js";
import type { IModelRef, IParsedModelList, IRejectedModelEntry, ModelRejectionReason } from "./types.js";

const maxEntryLength = 512;
const maxDisplayLength = 120;
const providerPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Whitespace, backslashes, and control characters (including ANSI escapes) never occur in real IDs.
// eslint-disable-next-line no-control-regex
const forbiddenCharacters = /[\s\\\u0000-\u001f\u007f]/;

/**
 * Parses `provider/model` lines. Only the first `/` splits the provider, so nested IDs and
 * numeric suffixes survive intact. Invalid lines are reported, never repaired.
 */
export function parseModelList(output: string): IParsedModelList {
  const models: IModelRef[] = [];
  const rejected: IRejectedModelEntry[] = [];
  output.split(/\r\n|\n|\r/).forEach((rawLine, index) => {
    const entry = rawLine.trim();
    if (entry === "") return;
    const result = validateEntry(entry);
    if (typeof result === "string") rejected.push({ line: index + 1, entry: truncate(entry), reason: result });
    else models.push(result);
  });
  return { models, rejected };
}

/** Parses one complete `provider/model` ID, or returns `undefined` when it is malformed. */
export function parseModelId(value: string): IModelRef | undefined {
  const result = validateEntry(value.trim());
  return typeof result === "string" ? undefined : result;
}

/** True when `value` is a provider segment Phase 1 would accept in a discovered ID. */
export function isValidModelProvider(value: string): boolean {
  return value.length <= maxEntryLength && providerPattern.test(value);
}

/** True when `value` is a model segment (possibly nested with `/`) Phase 1 would accept in a discovered ID. */
export function isValidModelName(value: string): boolean {
  return parseModelId(`p/${value}`) !== undefined;
}

/** True when `value` is a safe glob: bounded, free of forbidden characters, and not made only of wildcards. */
export function isValidModelPattern(value: string): boolean {
  return value.length > 0 && value.length <= maxEntryLength && !forbiddenCharacters.test(value) && /[^*?]/.test(value);
}

function validateEntry(entry: string): IModelRef | ModelRejectionReason {
  if (entry.length > maxEntryLength) return "too-long";
  if (forbiddenCharacters.test(entry)) return "invalid-characters";
  const separator = entry.indexOf("/");
  if (separator === -1) return "missing-separator";
  const provider = entry.slice(0, separator);
  const modelId = entry.slice(separator + 1);
  const segments = modelId.split("/");
  if (provider === "" || segments.some((segment) => segment === "")) return "empty-segment";
  if (!providerPattern.test(provider)) return "invalid-provider";
  if (segments.some((segment) => segment === "." || segment === "..")) return "invalid-model";
  return createModelRef(provider, modelId);
}

function truncate(value: string): string {
  return value.length > maxDisplayLength ? `${value.slice(0, maxDisplayLength)}…` : value;
}
