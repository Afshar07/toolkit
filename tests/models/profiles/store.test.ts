import { mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ModelProfileError,
  clearActiveModelProfile,
  clearModelResolutions,
  createModelProfile,
  getActiveModelProfile,
  getModelProfile,
  listModelProfiles,
  readLocalModelState,
  readModelProfileStore,
  readModelResolutions,
  removeAgentModelPreference,
  removeModelProfile,
  resolveStoredAgentModel,
  resolveStoredModelProfile,
  saveModelResolutions,
  selectEffectiveModelProfile,
  setActiveModelProfile,
  setAgentModelPreference,
  updateModelProfile,
  writeModelProfileStore,
} from "../../../src/models/index.js";
import type { IModelProfile } from "../../../src/models/index.js";
import { globalLocation, inventoryOf, projectLocation, useTemporaryRoots } from "./helpers.js";

const roots = useTemporaryRoots();
const openai: IModelProfile = {
  agents: {
    lead: { family: "gpt-6.1-sol", allowedProviders: ["cpa-gui", "openai"] },
    coder: { family: "gpt-6.1-sol", allowedProviders: ["cpa-gui", "openai"] },
    "external-researcher": { family: "gpt-6-luna", allowedProviders: ["openai"] },
  },
};
const anthropic: IModelProfile = { agents: { lead: { family: "claude-sonnet-5-5", allowedProviders: ["anthropic"] } } };

async function expectError(promise: Promise<unknown>, kind: string): Promise<ModelProfileError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ModelProfileError);
  expect((error as ModelProfileError).kind).toBe(kind);
  return error as ModelProfileError;
}

async function listFiles(directory: string): Promise<string[]> {
  return readdir(directory).catch(() => []);
}

describe("profile management", () => {
  it("treats an absent store as empty without creating anything", async () => {
    const location = await projectLocation(roots);
    expect(await listModelProfiles(location)).toEqual([]);
    expect(await getModelProfile(location, "openai")).toBeUndefined();
    expect(await getActiveModelProfile(location)).toBeUndefined();
    expect(await readLocalModelState(location)).toEqual({ schemaVersion: 1, resolutions: {} });
    expect(await listFiles(path.join(location.root, ".toolkit"))).toEqual([]);
  });

  it("creates, lists, and retrieves profiles, including custom names and arbitrary agents", async () => {
    const location = await projectLocation(roots);
    expect(await createModelProfile(location, "openai", openai)).toMatchObject({ status: "changed", profile: "openai" });
    expect(await createModelProfile(location, "my-team-2", { agents: { "brand-new-agent": { id: "acme.proxy/model-x/v2" } } })).toMatchObject({ status: "changed" });
    expect(await createModelProfile(location, "empty")).toMatchObject({ status: "changed", value: { agents: {} } });
    expect(await listModelProfiles(location)).toEqual(["empty", "my-team-2", "openai"]);
    expect(await getModelProfile(location, "openai")).toEqual(openai);
    expect((await getModelProfile(location, "my-team-2"))?.agents["brand-new-agent"]).toEqual({ id: "acme.proxy/model-x/v2" });
  });

  it("reports an existing profile instead of replacing it, and missing profiles instead of throwing", async () => {
    const location = await projectLocation(roots);
    await createModelProfile(location, "openai", openai);
    expect(await createModelProfile(location, "openai", anthropic)).toEqual({ status: "already-exists", profile: "openai" });
    expect(await getModelProfile(location, "openai")).toEqual(openai);
    expect(await updateModelProfile(location, "nope", openai)).toEqual({ status: "not-found", profile: "nope" });
    expect(await setAgentModelPreference(location, "nope", "lead", { id: "a/b" })).toEqual({ status: "not-found", profile: "nope" });
    expect(await removeModelProfile(location, "nope")).toEqual({ status: "not-found", profile: "nope" });
    expect(await removeAgentModelPreference(location, "openai", "ghost")).toMatchObject({ status: "agent-not-found" });
    expect(await removeAgentModelPreference(location, "nope", "lead")).toMatchObject({ status: "not-found" });
    expect(await setActiveModelProfile(location, "nope")).toEqual({ status: "not-found", profile: "nope" });
  });

  it("updates a profile and writes nothing when the update is a no-op", async () => {
    const location = await projectLocation(roots);
    await createModelProfile(location, "openai", openai);
    const before = (await stat(location.profilesPath)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await updateModelProfile(location, "openai", openai)).toMatchObject({ status: "unchanged" });
    expect((await stat(location.profilesPath)).mtimeMs).toBe(before);
    expect(await updateModelProfile(location, "openai", anthropic)).toMatchObject({ status: "changed" });
    expect(await getModelProfile(location, "openai")).toEqual(anthropic);
  });

  it("assigns and removes per-agent preferences", async () => {
    const location = await projectLocation(roots);
    await createModelProfile(location, "openai", openai);
    expect(await setAgentModelPreference(location, "openai", "reviewer", { id: "openai/gpt-6-luna" })).toMatchObject({ status: "changed" });
    expect((await getModelProfile(location, "openai"))?.agents.reviewer).toEqual({ id: "openai/gpt-6-luna" });
    expect(await setAgentModelPreference(location, "openai", "reviewer", { id: "openai/gpt-6-luna" })).toMatchObject({ status: "unchanged" });
    expect(await removeAgentModelPreference(location, "openai", "reviewer")).toMatchObject({ status: "changed" });
    expect((await getModelProfile(location, "openai"))?.agents.reviewer).toBeUndefined();
  });

  it("throws for malformed names and preferences, leaving files untouched", async () => {
    const location = await projectLocation(roots);
    await createModelProfile(location, "openai", openai);
    const text = await readFile(location.profilesPath, "utf8");
    await expectError(createModelProfile(location, "Bad Name"), "invalid-input");
    await expectError(createModelProfile(location, "../escape"), "invalid-input");
    await expectError(setAgentModelPreference(location, "openai", "Bad/Agent", { id: "a/b" }), "invalid-input");
    await expectError(setAgentModelPreference(location, "openai", "lead", { family: "x" } as never), "invalid-input");
    await expectError(updateModelProfile(location, "openai", { agents: { lead: { id: "nope" } } }), "invalid-input");
    await expectError(getModelProfile(location, "__proto__/x"), "invalid-input");
    expect(await readFile(location.profilesPath, "utf8")).toBe(text);
  });

  it("does not treat prototype property names as profiles", async () => {
    const location = await projectLocation(roots);
    expect(await getModelProfile(location, "constructor")).toBeUndefined();
    expect(await getModelProfile(location, "tostring")).toBeUndefined();
  });
});

describe("active profile", () => {
  it("reads and changes the active profile without touching the portable store or OpenCode", async () => {
    const location = await projectLocation(roots);
    await createModelProfile(location, "openai", openai);
    await createModelProfile(location, "anthropic", anthropic);
    const portable = await readFile(location.profilesPath, "utf8");
    expect(await setActiveModelProfile(location, "openai")).toEqual({ status: "changed", profile: "openai" });
    expect(await setActiveModelProfile(location, "openai")).toEqual({ status: "unchanged", profile: "openai" });
    expect(await getActiveModelProfile(location)).toBe("openai");
    expect(await setActiveModelProfile(location, "anthropic")).toMatchObject({ status: "changed" });
    expect(await getActiveModelProfile(location)).toBe("anthropic");
    expect(await readFile(location.profilesPath, "utf8")).toBe(portable);
    expect(await clearActiveModelProfile(location)).toBe(true);
    expect(await clearActiveModelProfile(location)).toBe(false);
    expect(await getActiveModelProfile(location)).toBeUndefined();
  });

  it("refuses to remove the active profile without a replacement or explicit deactivation", async () => {
    const location = await projectLocation(roots);
    await createModelProfile(location, "openai", openai);
    await createModelProfile(location, "anthropic", anthropic);
    await setActiveModelProfile(location, "openai");
    expect(await removeModelProfile(location, "openai")).toEqual({ status: "active-profile", profile: "openai" });
    expect(await listModelProfiles(location)).toEqual(["anthropic", "openai"]);
    expect(await getActiveModelProfile(location)).toBe("openai");
  });

  it("switches to a replacement when removing the active profile, validating the replacement first", async () => {
    const location = await projectLocation(roots);
    await createModelProfile(location, "openai", openai);
    await createModelProfile(location, "anthropic", anthropic);
    await setActiveModelProfile(location, "openai");
    expect(await removeModelProfile(location, "openai", { replacementProfile: "ghost" })).toMatchObject({ status: "replacement-not-found" });
    expect(await removeModelProfile(location, "openai", { replacementProfile: "openai" })).toMatchObject({ status: "replacement-not-found" });
    expect(await listModelProfiles(location)).toEqual(["anthropic", "openai"]);
    expect(await removeModelProfile(location, "openai", { replacementProfile: "anthropic" })).toEqual({ status: "removed", profile: "openai", activeProfile: "anthropic", wasActive: true });
    expect(await getActiveModelProfile(location)).toBe("anthropic");
    expect(await listModelProfiles(location)).toEqual(["anthropic"]);
  });

  it("deactivates when asked, and rejects combining replacement with deactivation", async () => {
    const location = await projectLocation(roots);
    await createModelProfile(location, "openai", openai);
    await setActiveModelProfile(location, "openai");
    await expectError(removeModelProfile(location, "openai", { replacementProfile: "x", deactivate: true }), "invalid-input");
    expect(await removeModelProfile(location, "openai", { deactivate: true })).toEqual({ status: "removed", profile: "openai", activeProfile: undefined, wasActive: true });
    expect(await getActiveModelProfile(location)).toBeUndefined();
  });

  it("removes an inactive profile, keeps the active one, and drops its saved resolutions", async () => {
    const location = await projectLocation(roots);
    await createModelProfile(location, "openai", openai);
    await createModelProfile(location, "anthropic", anthropic);
    await setActiveModelProfile(location, "anthropic");
    await saveModelResolutions(location, "openai", { lead: "cpa-gui/gpt-6.1-sol" });
    expect(await removeModelProfile(location, "openai")).toEqual({ status: "removed", profile: "openai", activeProfile: "anthropic", wasActive: false });
    expect(await getActiveModelProfile(location)).toBe("anthropic");
    expect(await readModelResolutions(location, "openai")).toEqual({});
  });

  it("allows a project to activate a global profile and to remove a project profile replaced by a global one", async () => {
    const project = await projectLocation(roots);
    const global = await globalLocation(roots);
    await createModelProfile(global, "openai", openai);
    expect(await setActiveModelProfile(project, "openai")).toMatchObject({ status: "not-found" });
    expect(await setActiveModelProfile(project, "openai", { inheritFrom: global })).toMatchObject({ status: "changed" });
    await createModelProfile(project, "local", anthropic);
    await setActiveModelProfile(project, "local");
    expect(await removeModelProfile(project, "local", { replacementProfile: "openai", inheritFrom: global })).toMatchObject({ status: "removed", activeProfile: "openai" });
  });
});

describe("saved resolutions", () => {
  const inventory = inventoryOf("openai/gpt-6.1-sol", "cpa-gui/gpt-6.1-sol", "openai/gpt-6-luna");

  it("saves, merges, and reads exact selections without altering the portable profile", async () => {
    const location = await projectLocation(roots);
    await createModelProfile(location, "openai", openai);
    const portable = await readFile(location.profilesPath, "utf8");
    expect(await saveModelResolutions(location, "openai", { lead: "cpa-gui/gpt-6.1-sol" })).toMatchObject({ status: "changed", selections: { lead: "cpa-gui/gpt-6.1-sol" } });
    expect(await saveModelResolutions(location, "openai", { coder: "openai/gpt-6.1-sol" })).toMatchObject({ status: "changed" });
    expect(await readModelResolutions(location, "openai")).toEqual({ lead: "cpa-gui/gpt-6.1-sol", coder: "openai/gpt-6.1-sol" });
    expect(await saveModelResolutions(location, "openai", { lead: "cpa-gui/gpt-6.1-sol" })).toMatchObject({ status: "unchanged" });
    expect(await readFile(location.profilesPath, "utf8")).toBe(portable);
  });

  it("rejects selections that the current preference does not allow, saving nothing", async () => {
    const location = await projectLocation(roots);
    await createModelProfile(location, "openai", openai);
    expect(await saveModelResolutions(location, "openai", { lead: "cpa-gui/gpt-6.1-sol", "external-researcher": "cpa-gui/gpt-6-luna" })).toEqual({
      status: "incompatible",
      profile: "openai",
      agent: "external-researcher",
      id: "cpa-gui/gpt-6-luna",
    });
    expect(await saveModelResolutions(location, "openai", { ghost: "a/b" })).toMatchObject({ status: "agent-not-found" });
    expect(await saveModelResolutions(location, "nope", { lead: "a/b" })).toMatchObject({ status: "not-found" });
    await expectError(saveModelResolutions(location, "openai", { lead: "bare-model" }), "invalid-input");
    expect(await readModelResolutions(location, "openai")).toEqual({});
    expect(await listFiles(location.directory)).toEqual(["profiles.json"]);
  });

  it("clears selected or all selections", async () => {
    const location = await projectLocation(roots);
    await createModelProfile(location, "openai", openai);
    await saveModelResolutions(location, "openai", { lead: "cpa-gui/gpt-6.1-sol", coder: "openai/gpt-6.1-sol" });
    expect(await clearModelResolutions(location, "openai", ["lead"])).toBe(true);
    expect(await readModelResolutions(location, "openai")).toEqual({ coder: "openai/gpt-6.1-sol" });
    expect(await clearModelResolutions(location, "openai", ["lead"])).toBe(false);
    expect(await clearModelResolutions(location, "openai")).toBe(true);
    expect(await readModelResolutions(location, "openai")).toEqual({});
  });

  it("resolves a stored profile with saved selections and reports stale ones; resolving never writes", async () => {
    const location = await projectLocation(roots);
    await createModelProfile(location, "openai", openai);
    await saveModelResolutions(location, "openai", { lead: "cpa-gui/gpt-6.1-sol", coder: "cpa-gui/gpt-6.1-sol" });
    const stateBefore = await readFile(location.statePath, "utf8");

    const result = await resolveStoredModelProfile(location, "openai", inventory);
    expect(result).toMatchObject({ status: "found", definedIn: "project" });
    if (result.status !== "found") return;
    expect(result.resolution.agents.lead).toMatchObject({ status: "resolved", source: "saved" });
    expect(result.resolution.agents["external-researcher"]).toMatchObject({ status: "resolved", model: { id: "openai/gpt-6-luna" } });

    // Provider disappears: saved selection is stale, preference is now unique.
    const reduced = await resolveStoredModelProfile(location, "openai", inventoryOf("openai/gpt-6.1-sol", "openai/gpt-6-luna"));
    expect(reduced.status === "found" && reduced.resolution.agents.lead).toMatchObject({ status: "resolved", source: "preference", staleSelection: { reason: "missing" } });

    expect(await readFile(location.statePath, "utf8")).toBe(stateBefore);
    expect(await resolveStoredModelProfile(location, "ghost", inventory)).toEqual({ status: "not-found", profile: "ghost" });
  });

  it("resolves one stored agent", async () => {
    const location = await projectLocation(roots);
    await createModelProfile(location, "openai", openai);
    expect(await resolveStoredAgentModel(location, "openai", "lead", inventory)).toMatchObject({ status: "found", resolution: { status: "ambiguous" } });
    await saveModelResolutions(location, "openai", { lead: "openai/gpt-6.1-sol" });
    expect(await resolveStoredAgentModel(location, "openai", "lead", inventory)).toMatchObject({ resolution: { status: "resolved", source: "saved" } });
    expect(await resolveStoredAgentModel(location, "openai", "ghost", inventory)).toMatchObject({ status: "agent-not-found" });
    expect(await resolveStoredAgentModel(location, "ghost", "lead", inventory)).toMatchObject({ status: "not-found" });
  });
});

describe("project and global scopes", () => {
  it("keeps stores isolated and never merges same-named profiles", async () => {
    const project = await projectLocation(roots);
    const global = await globalLocation(roots);
    await createModelProfile(global, "openai", openai);
    await createModelProfile(project, "openai", anthropic);
    await setActiveModelProfile(global, "openai");
    expect(await listModelProfiles(project)).toEqual(["openai"]);
    expect(await getModelProfile(project, "openai")).toEqual(anthropic);
    expect(await getModelProfile(global, "openai")).toEqual(openai);
    expect(await getActiveModelProfile(project)).toBeUndefined();
    expect(project.directory).not.toBe(global.directory);
  });

  it("selects the project's active profile over the global one, shadowing rather than merging", async () => {
    const project = await projectLocation(roots);
    const global = await globalLocation(roots);
    expect(await selectEffectiveModelProfile({ project, global })).toEqual({ status: "none" });

    await createModelProfile(global, "openai", openai);
    await setActiveModelProfile(global, "openai");
    expect(await selectEffectiveModelProfile({ project, global })).toMatchObject({ status: "selected", profile: "openai", selectedBy: "global", definedIn: "global", shadowsGlobal: false });

    await createModelProfile(project, "anthropic", anthropic);
    await setActiveModelProfile(project, "anthropic");
    expect(await selectEffectiveModelProfile({ project, global })).toMatchObject({ profile: "anthropic", selectedBy: "project", definedIn: "project", definition: anthropic });

    await createModelProfile(project, "openai", anthropic);
    await setActiveModelProfile(project, "openai");
    const shadowing = await selectEffectiveModelProfile({ project, global });
    expect(shadowing).toMatchObject({ profile: "openai", definedIn: "project", shadowsGlobal: true, definition: anthropic });
  });

  it("lets a project select a global-only profile, and reports a missing profile without substituting another", async () => {
    const project = await projectLocation(roots);
    const global = await globalLocation(roots);
    await createModelProfile(global, "openai", openai);
    await setActiveModelProfile(project, "openai", { inheritFrom: global });
    expect(await selectEffectiveModelProfile({ project, global })).toMatchObject({ status: "selected", selectedBy: "project", definedIn: "global" });

    await removeModelProfile(global, "openai");
    expect(await selectEffectiveModelProfile({ project, global })).toEqual({ status: "profile-missing", profile: "openai", selectedBy: "project" });
  });

  it("does not let a project profile redefine what a global selection means", async () => {
    const project = await projectLocation(roots);
    const global = await globalLocation(roots);
    await createModelProfile(project, "openai", anthropic);
    await createModelProfile(global, "openai", openai);
    await setActiveModelProfile(global, "openai");
    expect(await selectEffectiveModelProfile({ project, global })).toMatchObject({ selectedBy: "global", definedIn: "global", definition: openai });
  });

  it("stores the profile files beside, not inside, the agent ownership manifest", async () => {
    const project = await projectLocation(roots);
    await mkdir(path.join(project.root, ".toolkit"), { recursive: true });
    const manifest = JSON.stringify({ schemaVersion: 1, target: "opencode", overrides: [], installed: {} }, null, 2);
    await writeFile(path.join(project.root, ".toolkit", "agents.json"), manifest);
    await createModelProfile(project, "openai", openai);
    await setActiveModelProfile(project, "openai");
    expect(await readFile(path.join(project.root, ".toolkit", "agents.json"), "utf8")).toBe(manifest);
    expect((await listFiles(path.join(project.root, ".toolkit"))).sort()).toEqual(["agents.json", "models"]);
  });
});

describe("persistence safety", () => {
  it("writes deterministic, validated JSON with a schema version and no temporary files left behind", async () => {
    const location = await projectLocation(roots);
    await createModelProfile(location, "zeta", anthropic);
    await createModelProfile(location, "alpha", openai);
    const text = await readFile(location.profilesPath, "utf8");
    expect(text.indexOf('"alpha"')).toBeLessThan(text.indexOf('"zeta"'));
    expect(JSON.parse(text).schemaVersion).toBe(1);
    expect(text.endsWith("}\n")).toBe(true);
    expect(await listFiles(location.directory)).toEqual(["profiles.json"]);
    expect(await writeModelProfileStore(location, await readModelProfileStore(location))).toBe(false);
  });

  it("does not rewrite a hand-formatted file when nothing changes", async () => {
    const location = await projectLocation(roots);
    await mkdir(location.directory, { recursive: true });
    const handWritten = JSON.stringify({ profiles: { openai: openai }, schemaVersion: 1 });
    await writeFile(location.profilesPath, handWritten);
    expect(await updateModelProfile(location, "openai", openai)).toMatchObject({ status: "unchanged" });
    expect(await readFile(location.profilesPath, "utf8")).toBe(handWritten);
  });

  it("rejects malformed JSON, never overwriting it", async () => {
    const location = await projectLocation(roots);
    await mkdir(location.directory, { recursive: true });
    await writeFile(location.profilesPath, "{ not json");
    await writeFile(location.statePath, "[1,");
    await expectError(listModelProfiles(location), "invalid-config");
    await expectError(createModelProfile(location, "openai", openai), "invalid-config");
    await expectError(getActiveModelProfile(location), "invalid-config");
    await expectError(setActiveModelProfile(location, "openai"), "invalid-config");
    expect(await readFile(location.profilesPath, "utf8")).toBe("{ not json");
    expect(await readFile(location.statePath, "utf8")).toBe("[1,");
    expect(await listFiles(location.directory)).toEqual(["local.json", "profiles.json"]);
  });

  it("rejects schema-invalid files with issues, and unknown properties", async () => {
    const location = await projectLocation(roots);
    await mkdir(location.directory, { recursive: true });
    await writeFile(location.profilesPath, JSON.stringify({ schemaVersion: 1, profiles: { Bad: { agents: {} } }, extra: 1 }));
    const error = await expectError(listModelProfiles(location), "invalid-config");
    expect(error.issues.map((issue) => issue.path)).toEqual(expect.arrayContaining(["extra", "profiles.Bad"]));
    expect(error.filePath).toBe(location.profilesPath);
  });

  it("rejects future and unsupported schema versions without modifying the file", async () => {
    const location = await projectLocation(roots);
    await mkdir(location.directory, { recursive: true });
    const future = JSON.stringify({ schemaVersion: 2, profiles: { openai: { agents: {}, newField: true } } });
    await writeFile(location.profilesPath, future);
    await writeFile(location.statePath, JSON.stringify({ schemaVersion: 7, resolutions: {} }));
    await expectError(listModelProfiles(location), "unsupported-schema");
    await expectError(createModelProfile(location, "other"), "unsupported-schema");
    await expectError(getActiveModelProfile(location), "unsupported-schema");
    await writeFile(location.profilesPath, JSON.stringify({ schemaVersion: 0, profiles: {} }));
    await expectError(listModelProfiles(location), "invalid-config");
    await writeFile(location.profilesPath, future);
    expect(await readFile(location.profilesPath, "utf8")).toBe(future);
  });

  it("rejects oversized configuration", async () => {
    const location = await projectLocation(roots);
    await mkdir(location.directory, { recursive: true });
    await writeFile(location.profilesPath, `{"schemaVersion":1,"profiles":{},"pad":"${"x".repeat(1024 * 1024)}"}`);
    await expectError(listModelProfiles(location), "invalid-config");
  });

  it("refuses to write an invalid store", async () => {
    const location = await projectLocation(roots);
    await expectError(writeModelProfileStore(location, { schemaVersion: 1, profiles: { "Bad Name": { agents: {} } } }), "invalid-input");
    await expectError(writeModelProfileStore(location, { schemaVersion: 2 as never, profiles: {} }), "invalid-input");
    expect(await listFiles(location.directory)).toEqual([]);
  });

  it("recovers from a leftover temporary file of an interrupted write without touching the committed file", async () => {
    const location = await projectLocation(roots);
    await createModelProfile(location, "openai", openai);
    const committed = await readFile(location.profilesPath, "utf8");
    await writeFile(`${location.profilesPath}.999.deadbeef.tmp`, '{"schemaVersion":1,"profiles":{"half');
    expect(await listModelProfiles(location)).toEqual(["openai"]);
    expect(await readFile(location.profilesPath, "utf8")).toBe(committed);
    await createModelProfile(location, "anthropic", anthropic);
    expect(await listModelProfiles(location)).toEqual(["anthropic", "openai"]);
  });

  it("refuses a symlinked configuration file", async (context) => {
    const location = await projectLocation(roots);
    const outside = await roots.create();
    await mkdir(location.directory, { recursive: true });
    const target = path.join(outside, "victim.json");
    await writeFile(target, JSON.stringify({ schemaVersion: 1, profiles: {} }));
    try {
      await symlink(target, location.profilesPath, "file");
    } catch {
      context.skip();
      return;
    }
    await expectError(listModelProfiles(location), "unsafe-path");
    await expectError(createModelProfile(location, "openai", openai), "unsafe-path");
    expect(await readFile(target, "utf8")).toBe(JSON.stringify({ schemaVersion: 1, profiles: {} }));
  });

  it("refuses a symlinked or junctioned models directory and writes nothing outside the root", async () => {
    const location = await projectLocation(roots);
    const outside = await roots.create();
    await mkdir(path.join(location.root, ".toolkit"), { recursive: true });
    await symlink(outside, location.directory, process.platform === "win32" ? "junction" : "dir");
    await expectError(createModelProfile(location, "openai", openai), "unsafe-path");
    await expectError(listModelProfiles(location), "unsafe-path");
    await expectError(setActiveModelProfile(location, "openai"), "unsafe-path");
    expect(await listFiles(outside)).toEqual([]);
  });

  it("refuses a symlinked .toolkit directory", async () => {
    const location = await projectLocation(roots);
    const outside = await roots.create();
    await symlink(outside, path.join(location.root, ".toolkit"), process.platform === "win32" ? "junction" : "dir");
    await expectError(createModelProfile(location, "openai", openai), "unsafe-path");
    expect(await listFiles(outside)).toEqual([]);
  });

  it("refuses a missing project root rather than creating it", async () => {
    const location = await projectLocation(roots);
    const missing = { ...location, root: path.join(location.root, "absent"), directory: path.join(location.root, "absent", ".toolkit", "models"), profilesPath: path.join(location.root, "absent", ".toolkit", "models", "profiles.json") };
    await expectError(createModelProfile(missing, "openai", openai), "unsafe-path");
    expect(await listFiles(location.root)).toEqual([]);
  });
});
