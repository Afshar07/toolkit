import { ModelProfileError } from "../profiles/errors.js";

export interface IMarkdownModelInspection {
  /** The single simple top-level frontmatter `model` value, when present. */
  readonly model?: string;
  /** The input with only that `model:` line (and its line ending) removed. */
  readonly stripped: string;
}

const byteOrderMark = "\uFEFF";
const delimiter = /^---[ \t]*$/;
const topLevelModelKey = /^(["']?)model\1[ \t]*:(.*)$/;

/**
 * Inspect the top-level YAML frontmatter `model` entry using line-based scanning only.
 * Every other byte (BOM, CRLF/LF, body) is preserved. Duplicate, quoted-key, block, flow,
 * tagged, anchored, or multiline entries are rejected rather than guessed at.
 */
export function inspectMarkdownModel(text: string): IMarkdownModelInspection {
  const bom = text.startsWith(byteOrderMark) ? byteOrderMark : "";
  const lines = (text.slice(bom.length).match(/[^\n]*\n|[^\n]+$/g) ?? []).map((raw) => {
    const content = raw.replace(/\r?\n$/, "");
    return { raw, content };
  });
  if (!lines.length || !delimiter.test(lines[0].content)) return { stripped: text };
  const close = lines.findIndex((line, index) => index > 0 && delimiter.test(line.content));
  if (close < 0) return { stripped: text };

  const matches: number[] = [];
  for (let index = 1; index < close; index += 1) if (topLevelModelKey.test(lines[index].content)) matches.push(index);
  if (!matches.length) return { stripped: text };
  if (matches.length > 1) throw invalid("duplicate model entries");

  const index = matches[0];
  const match = topLevelModelKey.exec(lines[index].content)!;
  if (match[1] !== "") throw invalid("quoted model key");
  for (let next = index + 1; next < close; next += 1) {
    const content = lines[next].content;
    if (content.trim() === "") continue;
    if (!/^[ \t]/.test(content)) break;
    if (!content.trim().startsWith("#")) throw invalid("multiline model entry");
  }
  const model = parseSimpleScalar(match[2]);
  const stripped = bom + lines.filter((_, lineIndex) => lineIndex !== index).map((line) => line.raw).join("");
  return { model, stripped };
}

function parseSimpleScalar(source: string): string {
  const value = source.trim();
  const quoted = /^"([^"\\]*)"[ \t]*(?:#.*)?$/.exec(value) ?? /^'([^']*)'[ \t]*(?:#.*)?$/.exec(value);
  const result = quoted ? quoted[1] : value.replace(/[ \t]+#.*$/, "").trim();
  const plainSafe = quoted !== null || (!/^[|>&*!%[\]{}@`#"',?-]/.test(result) && !/:[ \t]|:$/.test(result));
  if (result === "" || !plainSafe) throw invalid("complex model entry");
  return result;
}

function invalid(reason: string): ModelProfileError {
  return new ModelProfileError("invalid-config", `Unsupported agent frontmatter: ${reason}.`);
}
