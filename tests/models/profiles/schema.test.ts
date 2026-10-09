import { describe, expect, it } from "vitest";
import {
  serializeModelProfileStore,
  validateLocalModelState,
  validateModelPreference,
  validateModelProfileStore,
} from "../../../src/models/index.js";

const valid = {
  schemaVersion: 1,
  profiles: {
    openai: {
      agents: {
        lead: { family: "gpt-6.1-sol", allowedProviders: ["cpa-gui", "openai"] },
        "external-researcher": { id: "openai/gpt-6-luna" },
      },
    },
    anthropic: { agents: { coder: { family: "claude-sonnet-5-5", allowedProviders: ["anthropic"], patterns: ["anthropic/claude-sonnet-*"] } } },
  },
};

function issuesOf(value: unknown): string {
  const result = validateModelProfileStore(value);
  if (result.ok) throw new Error("Expected invalid");
  return result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n");
}

function withAgent(agent: unknown, name = "lead"): unknown {
  return { schemaVersion: 1, profiles: { p: { agents: { [name]: agent } } } };
}

describe("validateModelProfileStore", () => {
  it("accepts valid configurations, custom profiles, arbitrary providers, and non-canonical agent names", () => {
    expect(validateModelProfileStore(valid).ok).toBe(true);
    expect(validateModelProfileStore({ schemaVersion: 1, profiles: {} }).ok).toBe(true);
    expect(validateModelProfileStore(withAgent({ family: "My_Model", allowedProviders: ["my.corp-proxy"] }, "brand-new-agent-2")).ok).toBe(true);
    expect(validateModelProfileStore(withAgent({ id: "openrouter/anthropic/claude-3.5-sonnet" })).ok).toBe(true);
  });

  it("accepts ordered fallbacks and explicit patterns", () => {
    const result = validateModelPreference({
      family: "gpt-6.1-sol",
      allowedProviders: ["openai"],
      fallbacks: [{ family: "gpt-6", allowedProviders: ["openai"] }, { patterns: ["openai/gpt-*"] }],
    });
    expect(result.ok && result.value.fallbacks).toHaveLength(2);
  });

  it("requires schemaVersion and profiles", () => {
    expect(issuesOf({ profiles: {} })).toContain("schemaVersion");
    expect(issuesOf({ schemaVersion: 1 })).toContain("profiles: Must be an object");
    expect(issuesOf(null)).toContain("(root)");
    expect(issuesOf([])).toContain("(root)");
    expect(issuesOf({ schemaVersion: 1, profiles: { p: {} } })).toContain("profiles.p.agents");
  });

  it("rejects unknown and non-numeric schema versions", () => {
    expect(issuesOf({ schemaVersion: 2, profiles: {} })).toContain("schemaVersion: Must be 1");
    expect(issuesOf({ schemaVersion: "1", profiles: {} })).toContain("schemaVersion");
    expect(issuesOf({ schemaVersion: 0, profiles: {} })).toContain("schemaVersion");
  });

  it("rejects malformed profiles and preferences", () => {
    expect(issuesOf({ schemaVersion: 1, profiles: [] })).toContain("profiles");
    expect(issuesOf({ schemaVersion: 1, profiles: { p: "x" } })).toContain("profiles.p");
    expect(issuesOf(withAgent("gpt"))).toContain("profiles.p.agents.lead");
    expect(issuesOf(withAgent({}))).toContain("at least one of id, family, or patterns");
    expect(issuesOf(withAgent({ allowedProviders: ["openai"] }))).toContain("at least one of id, family, or patterns");
  });

  it("rejects malformed profile and agent names", () => {
    for (const name of ["Upper", "-lead", "has space", "a/b", "..", "a.b", "", "__proto__x", "x".repeat(65)]) {
      expect(validateModelProfileStore({ schemaVersion: 1, profiles: { [name]: { agents: {} } } }).ok, `profile ${name}`).toBe(false);
      expect(validateModelProfileStore(withAgent({ id: "openai/gpt-5.5" }, name)).ok, `agent ${name}`).toBe(false);
    }
  });

  it("rejects malformed or unsafe model IDs", () => {
    for (const id of ["gpt-5.5", "openai/", "/gpt", "openai//x", "openai/../x", "openai/x y", "openai\\x", "openai/x\u0000", " openai/gpt-5.5", "openai/" + "x".repeat(600), 5, null, ""]) {
      expect(validateModelProfileStore(withAgent({ id })).ok, JSON.stringify(id)).toBe(false);
    }
  });

  it("rejects malformed families and requires explicit allowed providers for a family", () => {
    expect(issuesOf(withAgent({ family: "", allowedProviders: ["openai"] }))).toContain("family");
    expect(issuesOf(withAgent({ family: "a b/../c", allowedProviders: ["openai"] }))).toContain("family");
    expect(issuesOf(withAgent({ family: "gpt-5.5" }))).toContain("allowedProviders: Required with family");
  });

  it("rejects invalid, duplicate, or empty provider restrictions", () => {
    expect(issuesOf(withAgent({ family: "g", allowedProviders: [] }))).toContain("allowedProviders");
    expect(issuesOf(withAgent({ family: "g", allowedProviders: "openai" }))).toContain("allowedProviders");
    expect(issuesOf(withAgent({ family: "g", allowedProviders: ["open/ai"] }))).toContain("allowedProviders[0]");
    expect(issuesOf(withAgent({ family: "g", allowedProviders: ["-bad"] }))).toContain("allowedProviders[0]");
    expect(issuesOf(withAgent({ family: "g", allowedProviders: [3] }))).toContain("allowedProviders[0]");
    expect(issuesOf(withAgent({ family: "g", allowedProviders: ["openai", "openai"] }))).toContain("Duplicate");
  });

  it("rejects an exact ID that conflicts with allowedProviders", () => {
    expect(issuesOf(withAgent({ id: "openai/gpt-5.5", allowedProviders: ["anthropic"] }))).toContain("Conflicts with allowedProviders");
    expect(validateModelProfileStore(withAgent({ id: "openai/gpt-5.5", allowedProviders: ["openai"] })).ok).toBe(true);
  });

  it("rejects unsafe or catch-all patterns and duplicates", () => {
    expect(issuesOf(withAgent({ patterns: ["*"] }))).toContain("patterns[0]");
    expect(issuesOf(withAgent({ patterns: ["**"] }))).toContain("patterns[0]");
    expect(issuesOf(withAgent({ patterns: ["a b"] }))).toContain("patterns[0]");
    expect(issuesOf(withAgent({ patterns: [] }))).toContain("patterns");
    expect(issuesOf(withAgent({ patterns: ["openai/*", "OPENAI/*"] }))).toContain("Duplicate");
  });

  it("rejects unknown properties at every level instead of dropping them", () => {
    expect(issuesOf({ ...valid, extra: true })).toContain('Unknown property "extra"');
    expect(issuesOf({ schemaVersion: 1, profiles: { p: { agents: {}, note: "x" } } })).toContain("profiles.p.note");
    expect(issuesOf(withAgent({ id: "openai/gpt-5.5", allowedProvider: ["openai"] }))).toContain("allowedProvider");
    expect(issuesOf(withAgent({ id: "openai/gpt-5.5", fallbacks: [{ id: "openai/gpt-5.4", fallbacks: [] }] }))).toContain('Unknown property "fallbacks"');
  });

  it("rejects empty or oversized fallback lists", () => {
    expect(issuesOf(withAgent({ id: "openai/a", fallbacks: [] }))).toContain("fallbacks");
    expect(issuesOf(withAgent({ id: "openai/a", fallbacks: Array.from({ length: 9 }, () => ({ id: "openai/b" })) }))).toContain("fallbacks");
  });

  it("does not store credential-like properties", () => {
    expect(issuesOf(withAgent({ id: "openai/gpt-5.5", apiKey: "secret" }))).toContain('Unknown property "apiKey"');
  });

  it("canonicalizes provider and pattern sets so order never implies priority", () => {
    const result = validateModelPreference({ family: "g", allowedProviders: ["zeta", "alpha"], patterns: ["Z*", "a*"] });
    expect(result.ok && result.value.allowedProviders).toEqual(["alpha", "zeta"]);
    expect(result.ok && result.value.patterns).toEqual(["Z*", "a*"]);
  });
});

describe("validateLocalModelState", () => {
  it("accepts valid and empty state", () => {
    expect(validateLocalModelState({ schemaVersion: 1, activeProfile: "openai", resolutions: { openai: { lead: "cpa-gui/gpt-6.1-sol" } } }).ok).toBe(true);
    expect(validateLocalModelState({ schemaVersion: 1, resolutions: {} }).ok).toBe(true);
  });

  it("rejects bad versions, names, IDs, and unknown properties", () => {
    expect(validateLocalModelState({ schemaVersion: 9, resolutions: {} }).ok).toBe(false);
    expect(validateLocalModelState({ schemaVersion: 1 }).ok).toBe(false);
    expect(validateLocalModelState({ schemaVersion: 1, activeProfile: "Bad Name", resolutions: {} }).ok).toBe(false);
    expect(validateLocalModelState({ schemaVersion: 1, resolutions: { "Bad": {} } }).ok).toBe(false);
    expect(validateLocalModelState({ schemaVersion: 1, resolutions: { p: { "Bad": "a/b" } } }).ok).toBe(false);
    expect(validateLocalModelState({ schemaVersion: 1, resolutions: { p: { lead: "not-an-id" } } }).ok).toBe(false);
    expect(validateLocalModelState({ schemaVersion: 1, resolutions: { p: { lead: "a/b" } }, token: "x" }).ok).toBe(false);
  });
});

describe("serializeModelProfileStore", () => {
  it("is deterministic regardless of input key or list order", () => {
    const a = validateModelProfileStore({
      schemaVersion: 1,
      profiles: {
        zed: { agents: { b: { family: "m", allowedProviders: ["y", "x"] }, a: { id: "x/m" } } },
        alpha: { agents: {} },
      },
    });
    const b = validateModelProfileStore({
      profiles: {
        alpha: { agents: {} },
        zed: { agents: { a: { id: "x/m" }, b: { allowedProviders: ["x", "y"], family: "m" } } },
      },
      schemaVersion: 1,
    });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      const text = serializeModelProfileStore(a.value);
      expect(text).toBe(serializeModelProfileStore(b.value));
      expect(text.endsWith("}\n")).toBe(true);
      expect(text).not.toContain("\r");
      expect(text.indexOf('"alpha"')).toBeLessThan(text.indexOf('"zed"'));
    }
  });
});
