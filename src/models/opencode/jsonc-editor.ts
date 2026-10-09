import { applyEdits, getNodeValue, modify, parseTree, printParseErrorCode, type Node, type ParseError } from "jsonc-parser";
import { ModelProfileError } from "../profiles/errors.js";
import { assertAgentName } from "../profiles/names.js";
import { isCompleteModelId } from "../profiles/schema.js";

const byteOrderMark = "\uFEFF";

interface IParsedDocument {
  readonly body: string;
  readonly config: Record<string, unknown>;
}

interface IAgentModels {
  /** Present when the `agents.<name>` entry declares `model`, even when its value is not a string. */
  readonly plural?: { readonly value: unknown };
  readonly legacy?: { readonly value: unknown };
}

/**
 * Parses OpenCode configuration text (JSONC: comments and trailing commas allowed). Malformed syntax,
 * a non-object root, and duplicate object keys at any depth are rejected with `invalid-config`, so a
 * later edit never has to guess which of two same-named keys is meant.
 */
export function parseOpenCodeConfig(text: string): Record<string, unknown> {
  return parseDocument(text).config;
}

/**
 * Reads the raw `model` value configured for `agent`. The plural `agents` entry wins over the legacy
 * `agent` entry when it declares `model`. The value is returned as found (it may be an object or any
 * other JSON value); an absent model is `undefined`.
 */
export function readConfigAgentModel(config: Record<string, unknown>, agent: string): unknown {
  assertAgentName(agent);
  const models = readAgentModels(config, agent);
  return models.plural ? models.plural.value : models.legacy?.value;
}

/**
 * Returns `text` with `agents.<name>.model` set for every assignment, editing only those paths and
 * leaving comments, unrelated content, BOM, and line endings intact. Returns `text` unchanged (byte
 * for byte) when every targeted plural model already matches. An existing non-string `model` at a
 * targeted path is replaced; deciding whether that is acceptable is the caller's responsibility.
 */
export function editOpenCodeAgentModels(text: string, assignments: Readonly<Record<string, string>>): string {
  const entries = Object.entries(assignments);
  for (const [name, model] of entries) {
    assertAgentName(name);
    if (!isCompleteModelId(model)) {
      throw new ModelProfileError("invalid-input", `Invalid model ID for agent "${display(name)}"; use a complete provider/model ID.`);
    }
  }

  const { body, config } = parseDocument(text);
  const pending = entries.filter(([name, model]) => {
    const models = readAgentModels(config, name);
    return !(models.plural && models.plural.value === model);
  });
  if (pending.length === 0) return text;

  const formattingOptions = detectFormatting(body);
  let result = body;
  for (const [name, model] of pending) {
    result = applyEdits(result, modify(result, ["agents", name, "model"], model, { formattingOptions }));
  }

  const edited = parseDocument(result).config;
  for (const [name, model] of pending) {
    if (readAgentModels(edited, name).plural?.value !== model) {
      throw new ModelProfileError("invalid-config", `Could not safely set the model for agent "${display(name)}" in the configuration.`);
    }
  }
  return text.startsWith(byteOrderMark) ? byteOrderMark + result : result;
}

function parseDocument(text: string): IParsedDocument {
  const body = text.startsWith(byteOrderMark) ? text.slice(1) : text;
  const errors: ParseError[] = [];
  const root = parseTree(body, errors, { allowTrailingComma: true, disallowComments: false, allowEmptyContent: false });
  const first = errors[0];
  if (first) {
    throw invalidConfig(`Malformed OpenCode configuration: ${printParseErrorCode(first.error)} at line ${lineOf(body, first.offset)}.`);
  }
  if (!root) throw invalidConfig("Malformed OpenCode configuration: no content.");
  if (root.type !== "object") throw invalidConfig("OpenCode configuration must be a JSON object.");
  assertNoDuplicateKeys(root, "");
  return { body, config: getNodeValue(root) as Record<string, unknown> };
}

function assertNoDuplicateKeys(node: Node, path: string): void {
  if (node.type === "array") {
    (node.children ?? []).forEach((child, index) => assertNoDuplicateKeys(child, `${path}[${index}]`));
    return;
  }
  if (node.type !== "object") return;
  const seen = new Set<string>();
  for (const property of node.children ?? []) {
    const keyNode = property.children?.[0];
    if (!keyNode || typeof keyNode.value !== "string") continue;
    const key = keyNode.value;
    const keyPath = path === "" ? key : `${path}.${key}`;
    if (seen.has(key)) throw invalidConfig(`Duplicate key "${display(keyPath)}" in OpenCode configuration; remove one before editing.`, keyPath);
    seen.add(key);
    const valueNode = property.children?.[1];
    if (valueNode) assertNoDuplicateKeys(valueNode, keyPath);
  }
}

function readAgentModels(config: Record<string, unknown>, name: string): IAgentModels {
  const agents = readContainer(config, "agents");
  const legacy = readContainer(config, "agent");
  const plural = readModel(agents, "agents", name);
  const legacyModel = readModel(legacy, "agent", name);
  return { ...(plural ? { plural } : {}), ...(legacyModel ? { legacy: legacyModel } : {}) };
}

function readContainer(config: Record<string, unknown>, key: "agents" | "agent"): Record<string, unknown> | undefined {
  if (!Object.hasOwn(config, key)) return undefined;
  const value = config[key];
  if (!isRecord(value)) throw invalidConfig(`"${key}" in OpenCode configuration must be an object.`, key);
  return value;
}

function readModel(container: Record<string, unknown> | undefined, key: string, name: string): { readonly value: unknown } | undefined {
  if (!container || !Object.hasOwn(container, name)) return undefined;
  const entry = container[name];
  const path = `${key}.${name}`;
  if (!isRecord(entry)) throw invalidConfig(`"${display(path)}" in OpenCode configuration must be an object.`, path);
  return Object.hasOwn(entry, "model") ? { value: entry.model } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Best-effort match of the file's existing line endings and indentation so inserted text blends in. */
function detectFormatting(body: string): { insertSpaces: boolean; tabSize: number; eol: string } {
  const crlf = (body.match(/\r\n/g) ?? []).length;
  const lf = (body.match(/\n/g) ?? []).length - crlf;
  const eol = crlf > lf ? "\r\n" : "\n";
  const indent = /^([ \t]+)\S/m.exec(body)?.[1];
  if (indent === undefined) return { insertSpaces: true, tabSize: 2, eol };
  if (indent.startsWith("\t")) return { insertSpaces: false, tabSize: 1, eol };
  return { insertSpaces: true, tabSize: Math.min(indent.length, 8), eol };
}

function lineOf(body: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < body.length; index++) if (body[index] === "\n") line++;
  return line;
}

function invalidConfig(message: string, path = "(root)"): ModelProfileError {
  return new ModelProfileError("invalid-config", message, { issues: [{ path, message }] });
}

/** Keeps configuration-derived text from flooding messages or smuggling control characters into them. */
function display(value: string): string {
  // eslint-disable-next-line no-control-regex
  const safe = value.replace(/[\u0000-\u001f\u007f]/g, "?");
  return safe.length > 60 ? `${safe.slice(0, 60)}…` : safe;
}
