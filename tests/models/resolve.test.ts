import { describe, expect, it } from "vitest";
import { discoverModels, resolveModel } from "../../src/models/index.js";
import type { IModelRef } from "../../src/models/index.js";
import { fixtureSource, standardOutput } from "./fixtures.js";

async function inventory(output = standardOutput): Promise<readonly IModelRef[]> {
  return (await discoverModels({ source: fixtureSource(output) })).models;
}

describe("resolveModel", () => {
  it("resolves an exact configured ID first, even with conflicting family and provider settings", async () => {
    const result = resolveModel(await inventory(), { id: "openai/gpt-5.5", family: "claude-sonnet-5-5", allowedProviders: ["cpa-gui"] });
    expect(result).toMatchObject({ status: "resolved", matchedBy: "id", model: { id: "openai/gpt-5.5" } });
  });

  it("matches IDs exactly: numeric suffixes and nested IDs are never truncated or prefix-matched", async () => {
    const models = await inventory();
    expect(resolveModel(models, { id: "cpa-gui/gpt-image-2.5-flare" })).toMatchObject({ status: "resolved", matchedBy: "id" });
    expect(resolveModel(models, { id: "openrouter/anthropic/claude-3.5-sonnet" })).toMatchObject({ status: "resolved", matchedBy: "id" });
    expect(resolveModel(models, { id: "cpa-gui/gpt-image-2.5" })).toMatchObject({ status: "unavailable", reason: "no-match" });
    expect(resolveModel(models, { id: "openai/gpt-5" })).toMatchObject({ status: "unavailable" });
    expect(resolveModel(models, { id: "gpt-5.5" })).toMatchObject({ status: "unavailable" });
  });

  it("resolves a unique family within permitted providers", async () => {
    const result = resolveModel(await inventory(), { family: "Claude-Sonnet-5-5", allowedProviders: ["cpa-gui", "openai"] });
    expect(result).toMatchObject({ status: "resolved", matchedBy: "family", model: { id: "cpa-gui/claude-sonnet-5-5" } });
  });

  it("reports ambiguity when a family exists in several permitted providers", async () => {
    const result = resolveModel(await inventory(), { family: "gpt-5.5", allowedProviders: ["openai", "cpa-gui"] });
    expect(result).toEqual({
      status: "ambiguous",
      stage: "family",
      candidates: expect.arrayContaining([expect.objectContaining({ id: "cpa-gui/gpt-5.5" }), expect.objectContaining({ id: "openai/gpt-5.5" })]),
    });
    expect(result.candidates.map((model) => model.id)).toEqual(["cpa-gui/gpt-5.5", "openai/gpt-5.5"]);
  });

  it("resolves the same family once the provider scope narrows it", async () => {
    expect(resolveModel(await inventory(), { family: "gpt-5.5", allowedProviders: ["openai"] })).toMatchObject({ status: "resolved", model: { id: "openai/gpt-5.5" } });
  });

  it("never matches family outside permitted providers or without any permission", async () => {
    const models = await inventory();
    expect(resolveModel(models, { family: "gpt-5.5", allowedProviders: ["anthropic"] })).toMatchObject({ status: "unavailable", reason: "no-match" });
    expect(resolveModel(models, { family: "gpt-5.5", allowedProviders: [] })).toMatchObject({ status: "unavailable" });
    expect(resolveModel(models, { family: "gpt-5.5" })).toMatchObject({ status: "unavailable" });
  });

  it("does not treat similar family names as matches (no fuzzy selection)", async () => {
    const models = await inventory();
    expect(resolveModel(models, { family: "gpt-5", allowedProviders: ["openai"] })).toMatchObject({ status: "unavailable" });
    expect(resolveModel(models, { family: "gpt-55", allowedProviders: ["openai"] })).toMatchObject({ status: "unavailable" });
    expect(resolveModel(models, { family: "gpt-5.5-fa", allowedProviders: ["openai"] })).toMatchObject({ status: "unavailable" });
    expect(resolveModel(models, { family: "sonnet", allowedProviders: ["anthropic", "cpa-gui"] })).toMatchObject({ status: "unavailable" });
  });

  it("resolves an unambiguous explicit pattern", async () => {
    const result = resolveModel(await inventory(), { patterns: ["cpa-gui/claude-*"] });
    expect(result).toMatchObject({ status: "resolved", matchedBy: "pattern", model: { id: "cpa-gui/claude-sonnet-5-5" } });
  });

  it("reports ambiguity for patterns that match several models and never picks one", async () => {
    const result = resolveModel(await inventory(), { patterns: ["openai/gpt-5.5*"] });
    expect(result.status).toBe("ambiguous");
    expect(result.candidates.map((model) => model.id)).toEqual(["openai/gpt-5.5", "openai/gpt-5.5-fast"]);
  });

  it("pools matches across patterns so equal results are not ambiguous but different ones are", async () => {
    const models = await inventory();
    expect(resolveModel(models, { patterns: ["openai/gpt-6.*", "*/gpt-6.1-*"] })).toMatchObject({ status: "resolved", model: { id: "openai/gpt-6.1-sol" } });
    expect(resolveModel(models, { patterns: ["openai/gpt-6.1-sol", "cpa-gui/gpt-5.5"] })).toMatchObject({ status: "ambiguous" });
  });

  it("scopes patterns to permitted providers and treats regex syntax literally", async () => {
    const models = await inventory();
    expect(resolveModel(models, { patterns: ["*/gpt-5.5"], allowedProviders: ["openai"] })).toMatchObject({ status: "resolved", model: { id: "openai/gpt-5.5" } });
    expect(resolveModel(models, { patterns: ["*/gpt-5.5"] })).toMatchObject({ status: "ambiguous" });
    expect(resolveModel(models, { patterns: ["openai/gpt-5.5|openai/gpt-6.1-sol"] })).toMatchObject({ status: "unavailable" });
    expect(resolveModel(models, { patterns: ["openai/gpt-5.[5]"] })).toMatchObject({ status: "unavailable" });
    expect(resolveModel(models, { patterns: ["openai/gpt-5.5?fast"] })).toMatchObject({ status: "resolved", model: { id: "openai/gpt-5.5-fast" } });
  });

  it("does not fall through to patterns to escape a family ambiguity", async () => {
    const result = resolveModel(await inventory(), { family: "gpt-5.5", allowedProviders: ["openai", "cpa-gui"], patterns: ["openai/*-fast"] });
    expect(result).toMatchObject({ status: "ambiguous", stage: "family" });
  });

  it("falls back to patterns when the family stage has no match", async () => {
    const result = resolveModel(await inventory(), { family: "unknown", allowedProviders: ["openai"], patterns: ["openai/gpt-6.1-sol"] });
    expect(result).toMatchObject({ status: "resolved", matchedBy: "pattern" });
  });

  it("returns structured unavailable results with distinct reasons", async () => {
    expect(resolveModel(await inventory(), { id: "openai/nope" })).toEqual({ status: "unavailable", reason: "no-match", candidates: [] });
    expect(resolveModel([], { id: "openai/gpt-5.5" })).toEqual({ status: "unavailable", reason: "empty-inventory", candidates: [] });
    expect(resolveModel(await inventory(), {})).toEqual({ status: "unavailable", reason: "no-criteria", candidates: [] });
    expect(resolveModel(await inventory(), { id: "  ", patterns: [" "] })).toMatchObject({ reason: "no-criteria" });
  });

  it("is deterministic for duplicated or reordered inventories", async () => {
    const models = await inventory();
    const shuffled = [...models].reverse().concat(models);
    const request = { family: "gpt-5.5", allowedProviders: ["openai", "cpa-gui"] };
    expect(resolveModel(shuffled, request)).toEqual(resolveModel(models, request));
  });
});
