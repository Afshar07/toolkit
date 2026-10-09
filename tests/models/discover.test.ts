import { describe, expect, it } from "vitest";
import { discoverModels, filterModels, ModelDiscoveryError } from "../../src/models/index.js";
import { fixtureSource, standardOutput } from "./fixtures.js";

describe("discoverModels", () => {
  it("discovers a sorted inventory including custom providers", async () => {
    const inventory = await discoverModels({ source: fixtureSource(standardOutput) });
    expect(inventory.isEmpty).toBe(false);
    expect(inventory.totalDiscovered).toBe(9);
    expect(inventory.models.map((model) => model.id)).toEqual([
      "anthropic/claude-sonnet-4-5",
      "cpa-gui/claude-sonnet-5-5",
      "cpa-gui/gpt-5.5",
      "cpa-gui/gpt-image-2.5-flare",
      "openai/gpt-5.5",
      "openai/gpt-5.5-fast",
      "openai/gpt-6.1-sol",
      "opencode/big-pickle",
      "openrouter/anthropic/claude-3.5-sonnet",
    ]);
  });

  it("produces identical ordering regardless of input order", async () => {
    const reversed = standardOutput.split("\n").reverse().join("\n");
    const [a, b] = await Promise.all([discoverModels({ source: fixtureSource(standardOutput) }), discoverModels({ source: fixtureSource(reversed) })]);
    expect(b.models).toEqual(a.models);
  });

  it("collapses duplicate entries and counts them", async () => {
    const inventory = await discoverModels({ source: fixtureSource("openai/gpt-5.5\nopenai/gpt-5.5\ncpa-gui/gpt-5.5\nopenai/gpt-5.5\n") });
    expect(inventory.models.map((model) => model.id)).toEqual(["cpa-gui/gpt-5.5", "openai/gpt-5.5"]);
    expect(inventory.duplicateCount).toBe(2);
  });

  it("keeps valid entries and reports rejected ones", async () => {
    const inventory = await discoverModels({ source: fixtureSource("openai/gpt-5.5\ngarbage\n") });
    expect(inventory.models.map((model) => model.id)).toEqual(["openai/gpt-5.5"]);
    expect(inventory.rejected).toEqual([{ line: 2, entry: "garbage", reason: "missing-separator" }]);
  });

  it("throws malformed-output when nothing valid is present (for example help text)", async () => {
    await expect(discoverModels({ source: fixtureSource("DESCRIPTION\n  List all available models\n") })).rejects.toMatchObject({
      name: "ModelDiscoveryError",
      kind: "malformed-output",
    });
  });

  it("reports a clear empty state for empty output", async () => {
    const inventory = await discoverModels({ source: fixtureSource("\n") });
    expect(inventory).toEqual({ models: [], rejected: [], totalDiscovered: 0, duplicateCount: 0, isEmpty: true });
  });

  it("filters by provider and normalized family, and reports an empty filtered state", async () => {
    const byProvider = await discoverModels({ source: fixtureSource(standardOutput), filter: { providers: ["cpa-gui"] } });
    expect(byProvider.models.map((model) => model.id)).toEqual(["cpa-gui/claude-sonnet-5-5", "cpa-gui/gpt-5.5", "cpa-gui/gpt-image-2.5-flare"]);
    expect(byProvider.totalDiscovered).toBe(9);

    const byFamily = await discoverModels({ source: fixtureSource(standardOutput), filter: { families: ["GPT-5.5"] } });
    expect(byFamily.models.map((model) => model.id)).toEqual(["cpa-gui/gpt-5.5", "openai/gpt-5.5"]);

    const both = await discoverModels({ source: fixtureSource(standardOutput), filter: { providers: ["openai"], families: ["gpt-5.5"] } });
    expect(both.models.map((model) => model.id)).toEqual(["openai/gpt-5.5"]);

    const none = await discoverModels({ source: fixtureSource(standardOutput), filter: { providers: ["nope"] } });
    expect(none.isEmpty).toBe(true);
    expect(none.totalDiscovered).toBe(9);
  });

  it("wraps failures from injected sources", async () => {
    await expect(discoverModels({ source: { read: async () => { throw new Error("boom"); } } })).rejects.toMatchObject({ kind: "failed" });
    const typed = new ModelDiscoveryError("unavailable", "missing");
    await expect(discoverModels({ source: { read: async () => { throw typed; } } })).rejects.toBe(typed);
    await expect(discoverModels({ source: { read: async () => 42 as unknown as string } })).rejects.toMatchObject({ kind: "failed" });
  });
});

describe("filterModels", () => {
  it("treats an empty list as matching nothing and an omitted field as unrestricted", async () => {
    const { models } = await discoverModels({ source: fixtureSource(standardOutput) });
    expect(filterModels(models, { providers: [] })).toEqual([]);
    expect(filterModels(models, {})).toEqual(models);
    expect(filterModels(models, { families: ["  "] })).toEqual([]);
  });

  it("does not partially match provider names", async () => {
    const { models } = await discoverModels({ source: fixtureSource(standardOutput) });
    expect(filterModels(models, { providers: ["open"] })).toEqual([]);
  });
});
