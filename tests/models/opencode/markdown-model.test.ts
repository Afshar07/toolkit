import { describe, expect, it } from "vitest";
import { ModelProfileError } from "../../../src/models/profiles/errors.js";
import { inspectMarkdownModel } from "../../../src/models/opencode/markdown-model.js";

describe("inspectMarkdownModel", () => {
  it("extracts a plain model and removes only that line", () => {
    const text = "---\ndescription: d\nmodel: openai/gpt-5.5\nmode: primary\n---\n\nbody\n";
    expect(inspectMarkdownModel(text)).toEqual({ model: "openai/gpt-5.5", stripped: "---\ndescription: d\nmode: primary\n---\n\nbody\n" });
  });

  it("preserves a BOM and CRLF line endings byte for byte", () => {
    const text = "\uFEFF---\r\nmodel: a/b # note\r\nmode: primary\r\n---\r\nbody\r\n";
    expect(inspectMarkdownModel(text)).toEqual({ model: "a/b", stripped: "\uFEFF---\r\nmode: primary\r\n---\r\nbody\r\n" });
  });

  it("reads quoted values", () => {
    expect(inspectMarkdownModel("---\nmodel: \"a/b\"\n---\n").model).toBe("a/b");
    expect(inspectMarkdownModel("---\nmodel: 'a/b'\n---\n").model).toBe("a/b");
  });

  it("returns the input unchanged without frontmatter or a model entry", () => {
    for (const text of ["", "body\nmodel: a/b\n", "---\nmode: primary\n---\nmodel: a/b\n", "---\nmodel: a/b\nno close\n"]) {
      expect(inspectMarkdownModel(text)).toEqual({ stripped: text });
    }
  });

  it("ignores indented and body model lines", () => {
    const text = "---\npermissions:\n  model: nested\n---\nmodel: body\n";
    expect(inspectMarkdownModel(text)).toEqual({ stripped: text });
  });

  it("handles a model line at the end of frontmatter and a file without a trailing newline", () => {
    expect(inspectMarkdownModel("---\nmode: x\nmodel: a/b\n---")).toEqual({ model: "a/b", stripped: "---\nmode: x\n---" });
  });

  it.each([
    ["duplicate", "---\nmodel: a/b\nmodel: c/d\n---\n"],
    ["quoted key", "---\n\"model\": a/b\n---\n"],
    ["block scalar", "---\nmodel: |\n  a/b\n---\n"],
    ["multiline plain", "---\nmodel: a/\n  b\n---\n"],
    ["nested map", "---\nmodel:\n  id: a/b\n---\n"],
    ["empty", "---\nmodel:\n---\n"],
    ["flow", "---\nmodel: [a/b]\n---\n"],
    ["anchor", "---\nmodel: &m a/b\n---\n"],
    ["escaped double quote", "---\nmodel: \"a\\\"b\"\n---\n"],
  ])("rejects %s entries as invalid-config", (_name, text) => {
    expect(() => inspectMarkdownModel(text)).toThrowError(ModelProfileError);
    try { inspectMarkdownModel(text); } catch (error) { expect(error).toMatchObject({ kind: "invalid-config" }); }
  });
});
