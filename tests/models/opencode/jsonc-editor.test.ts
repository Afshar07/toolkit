import { describe, expect, it } from "vitest";
import { ModelProfileError } from "../../../src/models/index.js";
import { editOpenCodeAgentModels, parseOpenCodeConfig, readConfigAgentModel } from "../../../src/models/opencode/jsonc-editor.js";

const bom = "\uFEFF";

function errorOf(action: () => unknown): ModelProfileError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ModelProfileError);
    return error as ModelProfileError;
  }
  throw new Error("Expected the action to throw.");
}

describe("parseOpenCodeConfig", () => {
  it("accepts comments, trailing commas, and a leading byte order mark", () => {
    const text = `${bom}// note\n{\n  /* block */ "a": [1, 2,],\n  "b": {"c": true,},\n}\n`;
    expect(parseOpenCodeConfig(text)).toEqual({ a: [1, 2], b: { c: true } });
  });

  it.each([
    ["truncated JSON", '{"a":'],
    ["empty content", ""],
    ["whitespace only", "  \n"],
    ["an array root", "[]"],
    ["a scalar root", '"text"'],
    ["a missing comma", '{"a": 1 "b": 2}'],
  ])("rejects %s as invalid-config", (_label, text) => {
    expect(errorOf(() => parseOpenCodeConfig(text)).kind).toBe("invalid-config");
  });

  it("reports the line of a syntax error", () => {
    expect(errorOf(() => parseOpenCodeConfig('{\n  "a": 1,\n  "b" 2\n}\n')).message).toContain("line 3");
  });

  it("rejects duplicate keys at the root and at any depth", () => {
    const root = errorOf(() => parseOpenCodeConfig('{"a": 1, "a": 2}'));
    expect(root.kind).toBe("invalid-config");
    expect(root.message).toContain('Duplicate key "a"');
    const nested = errorOf(() => parseOpenCodeConfig('{"agents": {"lead": {"model": "a/b", "model": "c/d"}}}'));
    expect(nested.issues[0]?.path).toBe("agents.lead.model");
    const inArray = errorOf(() => parseOpenCodeConfig('{"list": [{"k": 1, "k": 2}]}'));
    expect(inArray.issues[0]?.path).toBe("list[0].k");
  });

  it("allows the same key in sibling objects", () => {
    expect(parseOpenCodeConfig('{"a": {"x": 1}, "b": {"x": 2}}')).toEqual({ a: { x: 1 }, b: { x: 2 } });
  });
});

describe("readConfigAgentModel", () => {
  it("reads the plural entry, falling back to the legacy singular entry", () => {
    const config = parseOpenCodeConfig('{"agents": {"lead": {"model": "openai/gpt-5.5"}}, "agent": {"coder": {"model": "legacy/model"}}}');
    expect(readConfigAgentModel(config, "lead")).toBe("openai/gpt-5.5");
    expect(readConfigAgentModel(config, "coder")).toBe("legacy/model");
    expect(readConfigAgentModel(config, "reviewer")).toBeUndefined();
  });

  it("prefers the plural entry over the legacy one when both declare a model", () => {
    const config = parseOpenCodeConfig('{"agents": {"lead": {"model": "new/model"}}, "agent": {"lead": {"model": "old/model"}}}');
    expect(readConfigAgentModel(config, "lead")).toBe("new/model");
  });

  it("returns non-string values as found", () => {
    const config = parseOpenCodeConfig('{"agents": {"lead": {"model": {"id": "x"}}}}');
    expect(readConfigAgentModel(config, "lead")).toEqual({ id: "x" });
  });

  it("treats an entry without a model as absent", () => {
    const config = parseOpenCodeConfig('{"agents": {"lead": {"prompt": "p"}}}');
    expect(readConfigAgentModel(config, "lead")).toBeUndefined();
  });

  it("rejects containers and entries that are not objects", () => {
    expect(errorOf(() => readConfigAgentModel(parseOpenCodeConfig('{"agents": []}'), "lead")).kind).toBe("invalid-config");
    expect(errorOf(() => readConfigAgentModel(parseOpenCodeConfig('{"agents": {"lead": "x"}}'), "lead")).kind).toBe("invalid-config");
    expect(errorOf(() => readConfigAgentModel(parseOpenCodeConfig('{"agent": {"lead": null}}'), "lead")).kind).toBe("invalid-config");
  });

  it("rejects an invalid agent name", () => {
    expect(errorOf(() => readConfigAgentModel({}, "Not Valid")).kind).toBe("invalid-input");
  });
});

describe("editOpenCodeAgentModels", () => {
  it("creates the agents entry in an empty object", () => {
    const result = editOpenCodeAgentModels("{}\n", { lead: "openai/gpt-5.5" });
    expect(parseOpenCodeConfig(result)).toEqual({ agents: { lead: { model: "openai/gpt-5.5" } } });
  });

  it("returns the text byte for byte when every plural model already matches", () => {
    const text = `${bom}{\r\n  // keep\r\n  "agents": {"lead": {"model": "openai/gpt-5.5",},},\r\n}\r\n`;
    expect(editOpenCodeAgentModels(text, { lead: "openai/gpt-5.5" })).toBe(text);
    expect(editOpenCodeAgentModels(text, {})).toBe(text);
  });

  it("preserves comments and trailing commas outside the edited path", () => {
    const text = [
      "{",
      "  // user provider notes",
      '  "provider": {"custom": {"npm": "pkg",},},',
      "  /* block comment */",
      '  "agents": {',
      '    "lead": {"prompt": "p",},',
      "  },",
      "}",
      "",
    ].join("\n");
    const result = editOpenCodeAgentModels(text, { lead: "openai/gpt-5.5" });
    expect(result).toContain("// user provider notes");
    expect(result).toContain('"provider": {"custom": {"npm": "pkg",},},');
    expect(result).toContain("/* block comment */");
    expect(parseOpenCodeConfig(result).agents).toEqual({ lead: { prompt: "p", model: "openai/gpt-5.5" } });
  });

  it("preserves a leading byte order mark", () => {
    const result = editOpenCodeAgentModels(`${bom}{"a": 1}`, { lead: "openai/gpt-5.5" });
    expect(result.startsWith(`${bom}{`)).toBe(true);
    expect(result.indexOf(bom, 1)).toBe(-1);
    expect(parseOpenCodeConfig(result)).toMatchObject({ a: 1, agents: { lead: { model: "openai/gpt-5.5" } } });
  });

  it("does not add a byte order mark to text that had none", () => {
    expect(editOpenCodeAgentModels("{}", { lead: "openai/gpt-5.5" }).startsWith(bom)).toBe(false);
  });

  it("keeps CRLF line endings for inserted text", () => {
    const text = '{\r\n  "a": 1\r\n}\r\n';
    const result = editOpenCodeAgentModels(text, { lead: "openai/gpt-5.5", coder: "openai/gpt-6.1-sol" });
    expect(result).toContain("\r\n");
    expect(/(?<!\r)\n/.test(result)).toBe(false);
  });

  it("keeps LF line endings for LF text", () => {
    const result = editOpenCodeAgentModels('{\n  "a": 1\n}\n', { lead: "openai/gpt-5.5" });
    expect(result).not.toContain("\r");
  });

  it("matches the existing tab indentation", () => {
    const result = editOpenCodeAgentModels('{\n\t"a": 1\n}\n', { lead: "openai/gpt-5.5" });
    expect(result).toContain('\n\t"agents": {');
    expect(result).not.toMatch(/\n {2}"agents"/);
  });

  it("preserves unknown keys, provider settings, and permissions byte for byte", () => {
    const original = {
      $schema: "https://opencode.ai/config.json",
      provider: { custom: { options: { baseURL: "https://example.test" } } },
      permission: { bash: "ask", edit: { "*.md": "allow" } },
      "x-unknown": [1, { nested: null }],
      agents: { lead: { permission: { edit: "deny" }, temperature: 0.2 } },
    };
    const result = editOpenCodeAgentModels(JSON.stringify(original, null, 2), { lead: "openai/gpt-5.5", coder: "openai/gpt-6.1-sol" });
    expect(parseOpenCodeConfig(result)).toEqual({
      ...original,
      agents: {
        lead: { permission: { edit: "deny" }, temperature: 0.2, model: "openai/gpt-5.5" },
        coder: { model: "openai/gpt-6.1-sol" },
      },
    });
  });

  it("changes only the targeted agent model", () => {
    const text = '{\n  "agents": {\n    "lead": {"model": "old/model"},\n    "coder": {"model": "keep/model"}\n  }\n}\n';
    const result = editOpenCodeAgentModels(text, { lead: "openai/gpt-5.5" });
    expect(result).toBe(text.replace("old/model", "openai/gpt-5.5"));
  });

  it("replaces an existing non-string model", () => {
    const result = editOpenCodeAgentModels('{"agents": {"lead": {"model": {"id": "x"}}}}', { lead: "openai/gpt-5.5" });
    expect(parseOpenCodeConfig(result).agents).toEqual({ lead: { model: "openai/gpt-5.5" } });
  });

  it("sets the plural entry and leaves a legacy singular entry untouched", () => {
    const result = editOpenCodeAgentModels('{"agent": {"lead": {"model": "legacy/model"}}}', { lead: "openai/gpt-5.5" });
    const config = parseOpenCodeConfig(result);
    expect(config.agent).toEqual({ lead: { model: "legacy/model" } });
    expect(readConfigAgentModel(config, "lead")).toBe("openai/gpt-5.5");
  });

  it.each([
    ["malformed syntax", '{"agents": '],
    ["a duplicate key", '{"agents": {}, "agents": {}}'],
    ["a non-object root", "[]"],
    ["an agents container that is not an object", '{"agents": []}'],
    ["an agent entry that is not an object", '{"agents": {"lead": "x"}}'],
  ])("refuses to edit %s", (_label, text) => {
    expect(errorOf(() => editOpenCodeAgentModels(text, { lead: "openai/gpt-5.5" })).kind).toBe("invalid-config");
  });

  it("rejects incomplete model IDs and invalid agent names before parsing", () => {
    expect(errorOf(() => editOpenCodeAgentModels("{}", { lead: "gpt-5.5" })).kind).toBe("invalid-input");
    expect(errorOf(() => editOpenCodeAgentModels("{}", { "Bad Name": "openai/gpt-5.5" })).kind).toBe("invalid-input");
    expect(errorOf(() => editOpenCodeAgentModels("not json", { lead: "gpt-5.5" })).kind).toBe("invalid-input");
  });
});
