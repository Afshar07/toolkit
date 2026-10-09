import { describe, expect, it } from "vitest";
import { resolveAgentModel, resolveModelProfile, resolveModel, selectionsFromResolution } from "../../../src/models/index.js";
import type { IModelPreference, IModelProfile } from "../../../src/models/index.js";
import { inventoryOf } from "./helpers.js";

const both = ["cpa-gui", "openai"];
const inventory = inventoryOf(
  "openai/gpt-6.1-sol",
  "cpa-gui/gpt-6.1-sol",
  "openai/gpt-6-luna",
  "anthropic/claude-sonnet-5-5",
  "cpa-gui/claude-haiku-4-5",
  "openrouter/anthropic/claude-3.5-sonnet",
);

describe("resolveAgentModel", () => {
  it("resolves an exact ID", () => {
    expect(resolveAgentModel(inventory, { id: "openai/gpt-6-luna" })).toMatchObject({ status: "resolved", matchedBy: "id", source: "preference", model: { id: "openai/gpt-6-luna" } });
    expect(resolveAgentModel(inventory, { id: "openrouter/anthropic/claude-3.5-sonnet" })).toMatchObject({ status: "resolved", matchedBy: "id" });
  });

  it("resolves a unique family within allowed providers", () => {
    expect(resolveAgentModel(inventory, { family: "Claude-Haiku-4-5", allowedProviders: both })).toMatchObject({ status: "resolved", matchedBy: "family", model: { id: "cpa-gui/claude-haiku-4-5" } });
  });

  it("does not choose a provider by list order: a family in two allowed providers is ambiguous", () => {
    for (const allowedProviders of [["cpa-gui", "openai"], ["openai", "cpa-gui"]]) {
      const result = resolveAgentModel(inventory, { family: "gpt-6.1-sol", allowedProviders });
      expect(result).toMatchObject({ status: "ambiguous", stage: "family" });
      expect(result.status === "ambiguous" && result.candidates.map((model) => model.id)).toEqual(["cpa-gui/gpt-6.1-sol", "openai/gpt-6.1-sol"]);
    }
  });

  it("restricts candidates to allowed providers", () => {
    expect(resolveAgentModel(inventory, { family: "gpt-6.1-sol", allowedProviders: ["openai"] })).toMatchObject({ status: "resolved", model: { id: "openai/gpt-6.1-sol" } });
    expect(resolveAgentModel(inventory, { family: "claude-sonnet-5-5", allowedProviders: ["cpa-gui"] })).toMatchObject({ status: "unavailable", reason: "no-match" });
  });

  it("resolves explicit patterns and keeps ambiguous patterns ambiguous", () => {
    expect(resolveAgentModel(inventory, { patterns: ["anthropic/claude-sonnet-*"] })).toMatchObject({ status: "resolved", matchedBy: "pattern", model: { id: "anthropic/claude-sonnet-5-5" } });
    expect(resolveAgentModel(inventory, { patterns: ["*/gpt-6.1-sol"] })).toMatchObject({ status: "ambiguous", stage: "pattern" });
  });

  it("reports unavailable models, and an empty inventory", () => {
    expect(resolveAgentModel(inventory, { id: "openai/missing" })).toMatchObject({ status: "unavailable", reason: "no-match" });
    expect(resolveAgentModel([], { id: "openai/gpt-6-luna" })).toMatchObject({ status: "unavailable", reason: "empty-inventory" });
  });

  it("reports invalid preferences as a value instead of throwing", () => {
    expect(resolveAgentModel(inventory, { family: "x" } as IModelPreference)).toMatchObject({ status: "invalid" });
    expect(resolveAgentModel(inventory, {} as IModelPreference)).toMatchObject({ status: "invalid" });
  });

  it("matches families exactly, so numeric proxy suffix changes do not match a different model", () => {
    const proxy = inventoryOf("cpa-gui/gpt-6.1-sol", "cpa-gui/gpt-6.1-sol-2", "cpa-gui/gpt-6.2-sol");
    expect(resolveAgentModel(proxy, { family: "gpt-6.1-sol", allowedProviders: ["cpa-gui"] })).toMatchObject({ status: "resolved", model: { id: "cpa-gui/gpt-6.1-sol" } });
    // The previously available exact model disappeared and only a "newer" one remains: nothing is guessed.
    const renamed = inventoryOf("cpa-gui/gpt-6.1-sol-2", "cpa-gui/gpt-6.2-sol");
    expect(resolveAgentModel(renamed, { family: "gpt-6.1-sol", allowedProviders: ["cpa-gui"] })).toMatchObject({ status: "unavailable" });
    expect(resolveAgentModel(renamed, { id: "cpa-gui/gpt-6.1-sol" })).toMatchObject({ status: "unavailable" });
  });

  it("delegates to Phase 1 so results agree with resolveModel", () => {
    const request = { family: "gpt-6.1-sol", allowedProviders: both };
    const direct = resolveModel(inventory, request);
    const viaProfile = resolveAgentModel(inventory, request);
    expect(viaProfile.status).toBe(direct.status);
  });
});

describe("resolveAgentModel saved selections", () => {
  const preference: IModelPreference = { family: "gpt-6.1-sol", allowedProviders: both };

  it("reuses a valid saved ID, resolving an otherwise ambiguous preference", () => {
    const result = resolveAgentModel(inventory, preference, { savedId: "cpa-gui/gpt-6.1-sol" });
    expect(result).toMatchObject({ status: "resolved", source: "saved", model: { id: "cpa-gui/gpt-6.1-sol" } });
    expect(result).not.toHaveProperty("staleSelection");
  });

  it("reuses a saved ID that is the unique match", () => {
    expect(resolveAgentModel(inventory, { family: "gpt-6-luna", allowedProviders: both }, { savedId: "openai/gpt-6-luna" })).toMatchObject({ status: "resolved", source: "saved" });
  });

  it("reports a stale saved ID that is gone from the inventory, then falls back to the preference", () => {
    const unique = resolveAgentModel(inventory, { family: "gpt-6-luna", allowedProviders: both }, { savedId: "cpa-gui/gpt-6-luna" });
    expect(unique).toMatchObject({ status: "resolved", source: "preference", model: { id: "openai/gpt-6-luna" }, staleSelection: { id: "cpa-gui/gpt-6-luna", reason: "missing" } });
    const ambiguous = resolveAgentModel(inventory, preference, { savedId: "openai/gpt-6.1-sol-old" });
    expect(ambiguous).toMatchObject({ status: "ambiguous", staleSelection: { reason: "missing" } });
    expect(resolveAgentModel(inventory, { id: "openai/nope" }, { savedId: "openai/gone" })).toMatchObject({ status: "unavailable", staleSelection: { reason: "missing" } });
  });

  it("does not let a saved ID override changed restrictions", () => {
    // The saved ID still exists, but the profile now only allows openai.
    const restricted = resolveAgentModel(inventory, { family: "gpt-6.1-sol", allowedProviders: ["openai"] }, { savedId: "cpa-gui/gpt-6.1-sol" });
    expect(restricted).toMatchObject({ status: "resolved", source: "preference", model: { id: "openai/gpt-6.1-sol" }, staleSelection: { id: "cpa-gui/gpt-6.1-sol", reason: "incompatible" } });
    // A different family entirely.
    const other = resolveAgentModel(inventory, { family: "gpt-6-luna", allowedProviders: both }, { savedId: "cpa-gui/gpt-6.1-sol" });
    expect(other).toMatchObject({ status: "resolved", model: { id: "openai/gpt-6-luna" }, staleSelection: { reason: "incompatible" } });
    // Restrictions with no remaining candidate: unavailable, not the saved model.
    expect(resolveAgentModel(inventory, { family: "gpt-6.1-sol", allowedProviders: ["anthropic"] }, { savedId: "cpa-gui/gpt-6.1-sol" })).toMatchObject({ status: "unavailable", staleSelection: { reason: "incompatible" } });
  });

  it("does not use a saved exact ID outside an exact-ID preference", () => {
    expect(resolveAgentModel(inventory, { id: "openai/gpt-6-luna" }, { savedId: "cpa-gui/gpt-6.1-sol" })).toMatchObject({ status: "resolved", model: { id: "openai/gpt-6-luna" }, staleSelection: { reason: "incompatible" } });
  });
});

describe("resolveAgentModel fallbacks", () => {
  it("uses a fallback only when the earlier preference is unavailable", () => {
    const result = resolveAgentModel(inventory, {
      id: "openai/missing",
      fallbacks: [{ family: "gpt-6-luna", allowedProviders: both }],
    });
    expect(result).toMatchObject({ status: "resolved", model: { id: "openai/gpt-6-luna" }, criterionIndex: 1, matchedBy: "family" });
  });

  it("prefers the primary over a fallback when both could match", () => {
    const result = resolveAgentModel(inventory, { id: "openai/gpt-6-luna", fallbacks: [{ id: "openai/gpt-6.1-sol" }] });
    expect(result).toMatchObject({ model: { id: "openai/gpt-6-luna" }, criterionIndex: 0 });
  });

  it("never skips an ambiguous preference to select a later fallback", () => {
    const result = resolveAgentModel(inventory, {
      family: "gpt-6.1-sol",
      allowedProviders: both,
      fallbacks: [{ id: "openai/gpt-6-luna" }],
    });
    expect(result).toMatchObject({ status: "ambiguous", stage: "family", criterionIndex: 0 });
  });

  it("walks several fallbacks in order and reports unavailable when all fail", () => {
    const preference: IModelPreference = { id: "a/one", fallbacks: [{ id: "a/two" }, { id: "anthropic/claude-sonnet-5-5" }] };
    expect(resolveAgentModel(inventory, preference)).toMatchObject({ status: "resolved", criterionIndex: 2 });
    expect(resolveAgentModel(inventory, { id: "a/one", fallbacks: [{ id: "a/two" }] })).toMatchObject({ status: "unavailable", reason: "no-match" });
  });

  it("applies a saved selection to a fallback's candidates", () => {
    const preference: IModelPreference = {
      id: "a/missing",
      fallbacks: [{ family: "gpt-6.1-sol", allowedProviders: both }],
    };
    expect(resolveAgentModel(inventory, preference, { savedId: "openai/gpt-6.1-sol" })).toMatchObject({ status: "resolved", source: "saved", criterionIndex: 1 });
    expect(resolveAgentModel(inventory, preference)).toMatchObject({ status: "ambiguous", criterionIndex: 1 });
  });
});

describe("resolveModelProfile", () => {
  const profile: IModelProfile = {
    agents: {
      lead: { family: "gpt-6.1-sol", allowedProviders: both },
      coder: { id: "openai/gpt-6-luna" },
      researcher: { family: "claude-sonnet-5-5", allowedProviders: ["cpa-gui"] },
      "external-researcher": { family: "claude-haiku-4-5", allowedProviders: ["cpa-gui"] },
    },
  };

  it("gives each agent an independent outcome", () => {
    const result = resolveModelProfile(inventory, profile);
    expect(Object.keys(result.agents)).toEqual(["coder", "external-researcher", "lead", "researcher"]);
    expect(result.agents.coder!.status).toBe("resolved");
    expect(result.agents["external-researcher"]!.status).toBe("resolved");
    expect(result.agents.lead!.status).toBe("ambiguous");
    expect(result.agents.researcher!.status).toBe("unavailable");
    expect(result.summary).toEqual({ resolved: 2, ambiguous: 1, unavailable: 1, invalid: 0 });
    expect(result.complete).toBe(false);
  });

  it("applies saved selections per agent, reports unused ones, and never persists", () => {
    const result = resolveModelProfile(inventory, profile, { selections: { lead: "cpa-gui/gpt-6.1-sol", gone: "openai/x" } });
    expect(result.agents.lead).toMatchObject({ status: "resolved", source: "saved" });
    expect(result.unusedSelections).toEqual(["gone"]);
    expect(selectionsFromResolution(result)).toEqual({
      coder: "openai/gpt-6-luna",
      "external-researcher": "cpa-gui/claude-haiku-4-5",
      lead: "cpa-gui/gpt-6.1-sol",
    });
  });

  it("is complete only when every agent resolves, including an empty profile", () => {
    expect(resolveModelProfile(inventory, { agents: { coder: { id: "openai/gpt-6-luna" } } }).complete).toBe(true);
    expect(resolveModelProfile(inventory, { agents: {} }).complete).toBe(true);
  });

  it("does not mutate its inputs", () => {
    const snapshot = JSON.stringify(profile);
    resolveModelProfile(inventory, profile, { selections: { lead: "cpa-gui/gpt-6.1-sol" } });
    expect(JSON.stringify(profile)).toBe(snapshot);
  });
});
