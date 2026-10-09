import { describe, expect, it } from "vitest";
import { normalizeModelFamily, parseModelId, parseModelList } from "../../src/models/index.js";

describe("parseModelList", () => {
  it("preserves complete IDs including numeric suffixes and nested identifiers", () => {
    const { models, rejected } = parseModelList("cpa-gui/gpt-image-2.5-flare\nopenrouter/anthropic/claude-3.5-sonnet\nopenai/gpt-6.1-sol\n");
    expect(rejected).toEqual([]);
    expect(models.map((model) => [model.id, model.provider, model.modelId])).toEqual([
      ["cpa-gui/gpt-image-2.5-flare", "cpa-gui", "gpt-image-2.5-flare"],
      ["openrouter/anthropic/claude-3.5-sonnet", "openrouter", "anthropic/claude-3.5-sonnet"],
      ["openai/gpt-6.1-sol", "openai", "gpt-6.1-sol"],
    ]);
  });

  it("handles CRLF, blank lines, and surrounding whitespace", () => {
    const { models, rejected } = parseModelList("\r\n  openai/gpt-5.5  \r\n\r\nopenai/gpt-6-sol\r\n");
    expect(models.map((model) => model.id)).toEqual(["openai/gpt-5.5", "openai/gpt-6-sol"]);
    expect(rejected).toEqual([]);
  });

  it("rejects malformed entries with line numbers and reasons instead of repairing them", () => {
    const { models, rejected } = parseModelList(
      [
        "openai/gpt-5.5",
        "no-separator",
        "/missing-provider",
        "openai/",
        "openai//double",
        "openai/trailing/",
        "has space/model",
        "openai/with space",
        "-bad/model",
        "openai/../escape",
        "openai/mo\\del",
        "openai/\u001b[31mcolored",
        `openai/${"a".repeat(600)}`,
        "Usage: opencode models [flags]",
      ].join("\n"),
    );
    expect(models.map((model) => model.id)).toEqual(["openai/gpt-5.5"]);
    expect(rejected.map((entry) => [entry.line, entry.reason])).toEqual([
      [2, "missing-separator"],
      [3, "empty-segment"],
      [4, "empty-segment"],
      [5, "empty-segment"],
      [6, "empty-segment"],
      [7, "invalid-characters"],
      [8, "invalid-characters"],
      [9, "invalid-provider"],
      [10, "invalid-model"],
      [11, "invalid-characters"],
      [12, "invalid-characters"],
      [13, "too-long"],
      [14, "invalid-characters"],
    ]);
    expect(rejected.every((entry) => entry.entry.length <= 121)).toBe(true);
  });

  it("returns nothing for empty output", () => {
    expect(parseModelList("")).toEqual({ models: [], rejected: [] });
    expect(parseModelList("\n  \n")).toEqual({ models: [], rejected: [] });
  });
});

describe("parseModelId", () => {
  it("accepts a complete ID and rejects bare or malformed values", () => {
    expect(parseModelId(" openai/gpt-5.5 ")?.id).toBe("openai/gpt-5.5");
    expect(parseModelId("gpt-5.5")).toBeUndefined();
    expect(parseModelId("")).toBeUndefined();
  });
});

describe("normalizeModelFamily", () => {
  it("is case-insensitive and keeps version dots and suffixes distinct", () => {
    expect(normalizeModelFamily("GPT-5.5")).toBe("gpt-5.5");
    expect(normalizeModelFamily("Claude_Sonnet 5")).toBe("claude-sonnet-5");
    expect(normalizeModelFamily("gpt-5.5")).not.toBe(normalizeModelFamily("gpt-5-5"));
    expect(normalizeModelFamily("gpt-5.5")).not.toBe(normalizeModelFamily("gpt-5.5-fast"));
    expect(normalizeModelFamily("anthropic/Claude-3.5-Sonnet")).toBe("anthropic/claude-3.5-sonnet");
    expect(normalizeModelFamily("   ")).toBe("");
  });
});
