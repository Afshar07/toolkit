import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createModelProfile, readModelResolutions, resolveModelProfileLocation, saveModelResolutions } from "../../../src/models/index.js";
import type { IModelProfile, IModelProfileLocation } from "../../../src/models/index.js";
import { hashAgentContent } from "../../../src/agents/sync.js";
import { agentDirectory } from "../../../src/agents/target.js";
import { applyModelProfile, applyModelProfilePlan } from "../../../src/models/opencode/apply.js";
import { migrateAgentModels, prepareAgentModelMigration } from "../../../src/models/opencode/migrate.js";
import { planModelProfileApplication } from "../../../src/models/opencode/plan.js";
import { inventoryOf, useTemporaryRoots } from "../profiles/helpers.js";

const roots = useTemporaryRoots();
const models = inventoryOf("openai/gpt-5.5", "openai/gpt-6.1-sol", "cpa-gui/gpt-5.5", "cpa-gui/claude-sonnet-5-5");
const modelFree = (name: string) => `---\ndescription: ${name}\n---\n${name} body\n`;

const stored: Record<string, IModelProfile> = {
  openai: { agents: { lead: { id: "openai/gpt-5.5" }, coder: { id: "openai/gpt-6.1-sol" } } },
};
const draft: IModelProfile = { agents: { lead: { id: "cpa-gui/gpt-5.5" }, coder: { id: "cpa-gui/claude-sonnet-5-5" } } };
/** `lead` resolves; `coder` names a model that is not installed. */
const partialDraft: IModelProfile = { agents: { lead: { id: "openai/gpt-5.5" }, coder: { id: "openai/not-installed" } } };

interface IWorkspace {
  readonly root: string;
  readonly target: string;
  readonly location: IModelProfileLocation;
  readonly configPath: string;
}

/** A temporary project target with installed model-free `lead` and `coder` agents and the stored `openai` profile. */
async function setup(): Promise<IWorkspace> {
  const root = await roots.create();
  const location = resolveModelProfileLocation(root);
  await mkdir(agentDirectory(root), { recursive: true });
  const installed: Record<string, { source: "toolkit"; version: string; hash: string }> = {};
  for (const name of ["lead", "coder"]) {
    const text = modelFree(name);
    await writeFile(path.join(agentDirectory(root), `${name}.md`), text);
    installed[name] = { source: "toolkit", version: "1", hash: hashAgentContent(text) };
  }
  await mkdir(path.join(root, ".toolkit"), { recursive: true });
  await writeFile(path.join(root, ".toolkit", "agents.json"), `${JSON.stringify({ schemaVersion: 1, target: "opencode", overrides: [], installed }, null, 2)}\n`);
  for (const [name, profile] of Object.entries(stored)) await createModelProfile(location, name, profile);
  return { root, target: root, location, configPath: path.join(root, "opencode.jsonc") };
}

/** Every file under `root` with its exact contents, to prove what did and did not change. */
async function tree(root: string, directory = root, found: Record<string, string> = {}): Promise<Record<string, string>> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await tree(root, full, found);
    else found[path.relative(root, full).replaceAll("\\", "/")] = await readFile(full, "utf8");
  }
  return found;
}
const withoutBackups = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).filter(([name]) => !name.endsWith(".bak")));

describe("planning with an in-memory profile definition", () => {
  it("plans an unsaved profile without writing anything", async () => {
    const workspace = await setup();
    const before = await tree(workspace.root);
    const plan = await planModelProfileApplication({ target: workspace.target, profile: "draft", profileDefinition: draft, models });
    expect(plan).toMatchObject({ status: "ready", profile: "draft" });
    expect(plan.assignments.map((item) => [item.agent, item.model, item.status])).toEqual([
      ["coder", "cpa-gui/claude-sonnet-5-5", "apply"],
      ["lead", "cpa-gui/gpt-5.5", "apply"],
    ]);
    expect(await tree(workspace.root)).toEqual(before);
  });

  it("prefers the supplied definition over a stored profile of the same name", async () => {
    const workspace = await setup();
    const plan = await planModelProfileApplication({ target: workspace.target, profile: "openai", profileDefinition: draft, models });
    expect(plan.assignments.map((item) => item.model)).toEqual(["cpa-gui/claude-sonnet-5-5", "cpa-gui/gpt-5.5"]);
  });

  it("applies without saving the definition as a portable preference", async () => {
    const workspace = await setup();
    const profilesBefore = await readFile(workspace.location.profilesPath, "utf8");
    const result = await applyModelProfile({ target: workspace.target, profile: "draft", profileDefinition: draft, models });
    expect(result.status).toBe("applied");
    expect(await readFile(workspace.location.profilesPath, "utf8")).toBe(profilesBefore);
    expect(profilesBefore).not.toContain("draft");
    expect(await readFile(workspace.configPath, "utf8")).toContain("cpa-gui/gpt-5.5");
    // Only the machine-local exact choices are recorded.
    expect(await readModelResolutions(workspace.location, "draft")).toEqual({ coder: "cpa-gui/claude-sonnet-5-5", lead: "cpa-gui/gpt-5.5" });
  });

  it("does not require a stored profile of that name when a definition is supplied", async () => {
    const workspace = await setup();
    const plan = await planModelProfileApplication({ target: workspace.target, profile: "missing", profileDefinition: draft, models });
    expect(plan.status).toBe("ready");
  });

  it("uses exact selections to resolve an ambiguous agent without saving them beforehand", async () => {
    const workspace = await setup();
    const ambiguous: IModelProfile = { agents: { lead: { family: "gpt-5.5", allowedProviders: ["cpa-gui", "openai"] } } };
    const before = await tree(workspace.root);
    expect((await planModelProfileApplication({ target: workspace.target, profile: "draft", profileDefinition: ambiguous, models })).status).toBe("blocked");
    const plan = await planModelProfileApplication({ target: workspace.target, profile: "draft", profileDefinition: ambiguous, selections: { lead: "cpa-gui/gpt-5.5" }, models });
    expect(plan.status).toBe("ready");
    expect(plan.resolution?.agents.lead).toMatchObject({ status: "resolved", source: "saved", model: { id: "cpa-gui/gpt-5.5" } });
    expect(await tree(workspace.root)).toEqual(before);
    expect(await readModelResolutions(workspace.location, "draft")).toEqual({});
  });

  it("lets plan selections override saved ones without changing saved ones until applied", async () => {
    const workspace = await setup();
    await saveModelResolutions(workspace.location, "openai", { lead: "openai/gpt-5.5" });
    const ambiguous: IModelProfile = { agents: { lead: { family: "gpt-5.5", allowedProviders: ["cpa-gui", "openai"] } } };
    const plan = await planModelProfileApplication({ target: workspace.target, profile: "openai", profileDefinition: ambiguous, selections: { lead: "cpa-gui/gpt-5.5" }, models });
    expect(plan.assignments).toMatchObject([{ agent: "lead", model: "cpa-gui/gpt-5.5" }]);
    expect(await readModelResolutions(workspace.location, "openai")).toEqual({ lead: "openai/gpt-5.5" });
  });
});

describe("planning with a selected-agents filter", () => {
  it("applies one agent without blocking on an unrelated unresolved agent", async () => {
    const workspace = await setup();
    expect((await planModelProfileApplication({ target: workspace.target, profile: "draft", profileDefinition: partialDraft, models })).status).toBe("blocked");
    const result = await applyModelProfile({ target: workspace.target, profile: "draft", profileDefinition: partialDraft, agents: ["lead"], models });
    expect(result.status).toBe("applied");
    expect(result.plan.assignments.map((item) => item.agent)).toEqual(["lead"]);
    expect(result.plan.resolution?.complete).toBe(true);
    const config = await readFile(workspace.configPath, "utf8");
    expect(config).toContain("openai/gpt-5.5");
    expect(config).not.toContain("not-installed");
    expect(await readModelResolutions(workspace.location, "draft")).toEqual({ lead: "openai/gpt-5.5" });
  });

  it("keeps other agents' assignments, ownership, and saved selections untouched", async () => {
    const workspace = await setup();
    await applyModelProfile({ target: workspace.target, profile: "openai", models });
    const applied = JSON.parse(await readFile(path.join(workspace.root, ".toolkit/models/applied.json"), "utf8"));

    const result = await applyModelProfile({ target: workspace.target, profile: "openai", profileDefinition: draft, agents: ["lead"], models });
    expect(result.status).toBe("applied");
    const config = await readFile(workspace.configPath, "utf8");
    expect(config).toContain("cpa-gui/gpt-5.5");
    expect(config).toContain("openai/gpt-6.1-sol");
    expect(config).not.toContain("openai/gpt-5.5");
    expect(JSON.parse(await readFile(path.join(workspace.root, ".toolkit/models/applied.json"), "utf8")).agents).toEqual({
      coder: applied.agents.coder,
      lead: { config: "opencode.jsonc", model: "cpa-gui/gpt-5.5" },
    });
    // Merged into existing local state rather than replacing it.
    expect(await readModelResolutions(workspace.location, "openai")).toEqual({ coder: "openai/gpt-6.1-sol", lead: "cpa-gui/gpt-5.5" });
  });

  it("does not consult saved selections or conflicts of agents outside the filter", async () => {
    const workspace = await setup();
    await writeFile(workspace.configPath, JSON.stringify({ agent: { coder: { model: "user/own-choice" } } }));
    const plan = await planModelProfileApplication({ target: workspace.target, profile: "openai", agents: ["lead"], models });
    expect(plan.status).toBe("ready");
    expect(plan.conflicts).toEqual([]);
    expect(plan.assignments.map((item) => item.agent)).toEqual(["lead"]);
  });

  it("ignores duplicate names and works with a stored profile", async () => {
    const workspace = await setup();
    const plan = await planModelProfileApplication({ target: workspace.target, profile: "openai", agents: ["coder", "coder"], models });
    expect(plan.status).toBe("ready");
    expect(plan.assignments).toMatchObject([{ agent: "coder", model: "openai/gpt-6.1-sol" }]);
  });

  it.each([
    ["an empty list", [] as string[]],
    ["an agent the profile does not define", ["lead", "reviewer"]],
    ["a malformed agent name", ["Lead"]],
    ["an inherited property name", ["constructor"]],
  ])("rejects %s without writing", async (_label, agents) => {
    const workspace = await setup();
    const before = await tree(workspace.root);
    await expect(planModelProfileApplication({ target: workspace.target, profile: "openai", agents, models })).rejects.toMatchObject({ kind: "invalid-input" });
    expect(await tree(workspace.root)).toEqual(before);
  });
});

describe("rejecting invalid draft input", () => {
  it("requires an explicit profile name for a definition", async () => {
    const workspace = await setup();
    await expect(planModelProfileApplication({ target: workspace.target, profileDefinition: draft, models })).rejects.toMatchObject({ kind: "invalid-input" });
  });

  it("still validates the profile name", async () => {
    const workspace = await setup();
    await expect(planModelProfileApplication({ target: workspace.target, profile: "Bad Name", profileDefinition: draft, models })).rejects.toMatchObject({ kind: "invalid-input" });
  });

  it.each([
    ["an unknown property", { agents: { lead: { id: "openai/gpt-5.5", colour: "red" } } }],
    ["a family without allowed providers", { agents: { lead: { family: "gpt-5.5" } } }],
    ["a malformed agent name", { agents: { "Not Valid": { id: "openai/gpt-5.5" } } }],
  ])("rejects a definition with %s", async (_label, definition) => {
    const workspace = await setup();
    const before = await tree(workspace.root);
    const error = await planModelProfileApplication({ target: workspace.target, profile: "draft", profileDefinition: definition as IModelProfile, models }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: "invalid-input" });
    expect((error as { issues: unknown[] }).issues.length).toBeGreaterThan(0);
    expect(await tree(workspace.root)).toEqual(before);
  });

  it.each([
    ["an incomplete model ID", { lead: "gpt-5.5" }],
    ["an agent the plan does not cover", { reviewer: "openai/gpt-5.5" }],
    ["a malformed agent name", { "Not Valid": "openai/gpt-5.5" }],
  ])("rejects selections with %s", async (_label, selections) => {
    const workspace = await setup();
    await expect(planModelProfileApplication({ target: workspace.target, profile: "openai", selections, models })).rejects.toMatchObject({ kind: "invalid-input" });
  });

  it("rejects a selection for an agent outside the agents filter", async () => {
    const workspace = await setup();
    await expect(planModelProfileApplication({ target: workspace.target, profile: "openai", agents: ["lead"], selections: { coder: "openai/gpt-6.1-sol" }, models })).rejects.toMatchObject({ kind: "invalid-input" });
  });
});

describe("draft migration of one agent", () => {
  const legacyCoder = "---\ndescription: Coder\nmodel: openai/gpt-5.5\n---\nBody\n";
  const strippedCoder = "---\ndescription: Coder\n---\nBody\n";
  const legacyLead = "---\ndescription: Lead\nmodel: old/model\n---\nLead body\n";
  /** `coder` resolves; the unrelated `lead` names a model that is not installed. */
  const migrationDraft: IModelProfile = { agents: { lead: { id: "openai/not-installed" }, coder: { id: "openai/gpt-5.5" } } };
  const draftOptions = (workspace: IWorkspace) => ({ target: workspace.target, profile: "draft", profileDefinition: migrationDraft, agents: ["coder"], models });

  /** Installed `lead` (legacy model) and `coder` agents, with the manifest recording `coderManifestText`'s hash. */
  async function migrationWorkspace(coderText = legacyCoder, coderManifestText = coderText): Promise<IWorkspace> {
    const workspace = await setup();
    await writeFile(path.join(agentDirectory(workspace.target), "coder.md"), coderText);
    await writeFile(path.join(agentDirectory(workspace.target), "lead.md"), legacyLead);
    await writeFile(path.join(workspace.root, ".toolkit", "agents.json"), `${JSON.stringify({
      schemaVersion: 1,
      target: "opencode",
      overrides: [],
      installed: {
        coder: { source: "toolkit", version: "1.2.3", hash: hashAgentContent(coderManifestText) },
        lead: { source: "toolkit", version: "1.2.3", hash: hashAgentContent(legacyLead) },
      },
    }, null, 2)}\n`);
    return workspace;
  }
  const relativeNames = (workspace: IWorkspace, files: readonly { path: string }[]) => files.map((file) => path.relative(workspace.root, file.path).replaceAll("\\", "/"));

  it("writes configuration before stripping Markdown, then the manifest and local state", async () => {
    const workspace = await migrationWorkspace();
    const plan = await prepareAgentModelMigration(draftOptions(workspace));
    expect(plan.status).toBe("ready");
    expect(plan.assignments.map((item) => item.agent)).toEqual(["coder"]);
    expect(relativeNames(workspace, plan.files)).toEqual(["opencode.jsonc", ".opencode/agents/coder.md", ".toolkit/agents.json", ".toolkit/models/applied.json", ".toolkit/models/local.json"]);
  });

  it("migrates only the selected agent and leaves the portable profile and unrelated agent untouched", async () => {
    const workspace = await migrationWorkspace();
    const profilesBefore = await readFile(workspace.location.profilesPath, "utf8");
    const result = await migrateAgentModels(draftOptions(workspace));
    expect(result.status).toBe("applied");

    expect(await readFile(path.join(agentDirectory(workspace.target), "coder.md"), "utf8")).toBe(strippedCoder);
    expect(await readFile(path.join(agentDirectory(workspace.target), "lead.md"), "utf8")).toBe(legacyLead);
    const config = await readFile(workspace.configPath, "utf8");
    expect(config).toContain("openai/gpt-5.5");
    expect(config).not.toContain("old/model");
    expect(config).not.toContain("not-installed");
    expect(await readFile(workspace.location.profilesPath, "utf8")).toBe(profilesBefore);

    const manifest = JSON.parse(await readFile(path.join(workspace.root, ".toolkit/agents.json"), "utf8"));
    expect(manifest.installed.coder).toEqual({ source: "toolkit", version: "1.2.3", hash: hashAgentContent(strippedCoder) });
    expect(manifest.installed.lead.hash).toBe(hashAgentContent(legacyLead));
    expect(await readModelResolutions(workspace.location, "draft")).toEqual({ coder: "openai/gpt-5.5" });
  });

  it("writes nothing on a dry run", async () => {
    const workspace = await migrationWorkspace();
    const before = await tree(workspace.root);
    expect((await migrateAgentModels({ ...draftOptions(workspace), dryRun: true })).status).toBe("dry-run");
    expect(await tree(workspace.root)).toEqual(before);
  });

  it("blocks on a differing user-owned assignment unless that agent is explicitly replaced", async () => {
    const workspace = await migrationWorkspace();
    await writeFile(workspace.configPath, '{"agents":{"coder":{"model":"user/own-choice"}}}\n');
    const before = await tree(workspace.root);

    const blocked = await migrateAgentModels(draftOptions(workspace));
    expect(blocked.status).toBe("blocked");
    expect(blocked.plan.conflicts).toEqual(["coder: conflict"]);
    expect(await tree(workspace.root)).toEqual(before);

    const other = await migrateAgentModels({ ...draftOptions(workspace), replaceAssignments: new Set(["lead"]) });
    expect(other.status).toBe("blocked");

    const replaced = await migrateAgentModels({ ...draftOptions(workspace), replaceAssignments: new Set(["coder"]) });
    expect(replaced.status).toBe("applied");
    expect(await readFile(workspace.configPath, "utf8")).toContain("openai/gpt-5.5");
    expect(await readFile(workspace.configPath, "utf8")).not.toContain("user/own-choice");
    expect(await readFile(path.join(agentDirectory(workspace.target), "coder.md"), "utf8")).toBe(strippedCoder);
    expect(await readFile(path.join(agentDirectory(workspace.target), "lead.md"), "utf8")).toBe(legacyLead);
  });

  it("does not migrate the unrelated agent when the filter is dropped but the draft is incomplete", async () => {
    const workspace = await migrationWorkspace();
    const before = await tree(workspace.root);
    const result = await migrateAgentModels({ ...draftOptions(workspace), agents: undefined });
    expect(result.status).toBe("blocked");
    expect(await tree(workspace.root)).toEqual(before);
  });

  it("resumes an interrupted migration of the selected agent without touching the unrelated one", async () => {
    const workspace = await migrationWorkspace(strippedCoder, legacyCoder);
    await writeFile(workspace.configPath, '{\n  "agent": {\n    "coder": { "model": "openai/gpt-5.5" }\n  }\n}\n');
    await writeFile(path.join(agentDirectory(workspace.target), "coder.md.123.0123456789abcdef.bak"), legacyCoder);

    const preview = await prepareAgentModelMigration(draftOptions(workspace));
    expect(preview.status).toBe("ready");
    expect(relativeNames(workspace, preview.files)).toEqual([".toolkit/agents.json"]);

    const result = await migrateAgentModels(draftOptions(workspace));
    expect(result.status).toBe("applied");
    const manifest = JSON.parse(await readFile(path.join(workspace.root, ".toolkit/agents.json"), "utf8"));
    expect(manifest.installed.coder).toEqual({ source: "toolkit", version: "1.2.3", hash: hashAgentContent(strippedCoder) });
    expect(manifest.installed.lead.hash).toBe(hashAgentContent(legacyLead));
    expect(await readFile(path.join(agentDirectory(workspace.target), "lead.md"), "utf8")).toBe(legacyLead);
    expect(await readModelResolutions(workspace.location, "draft")).toEqual({ coder: "openai/gpt-5.5" });
  });

  it("does not repair when the backup does not prove the original", async () => {
    const workspace = await migrationWorkspace(strippedCoder, legacyCoder);
    await writeFile(workspace.configPath, '{"agent":{"coder":{"model":"openai/gpt-5.5"}}}\n');
    const before = await tree(workspace.root);
    const result = await migrateAgentModels(draftOptions(workspace));
    expect(result.status).toBe("blocked");
    expect(result.plan.conflicts).toEqual(["coder: modified-agent"]);
    expect(await tree(workspace.root)).toEqual(before);
  });
});

describe("approval and stale snapshots for draft plans", () => {
  it("applies a draft plan only when it is the untouched approved object", async () => {
    const workspace = await setup();
    const plan = await planModelProfileApplication({ target: workspace.target, profile: "draft", profileDefinition: draft, models });
    const forged = { ...plan, files: plan.files.map((file) => ({ ...file })) };
    await expect(applyModelProfilePlan(forged)).rejects.toMatchObject({ kind: "invalid-input" });
    expect((await applyModelProfilePlan(plan)).status).toBe("applied");
  });

  it("fails a draft plan when the configuration changed after planning", async () => {
    const workspace = await setup();
    const plan = await planModelProfileApplication({ target: workspace.target, profile: "draft", profileDefinition: draft, models });
    await writeFile(workspace.configPath, '{"theme":"changed"}\n');
    const before = withoutBackups(await tree(workspace.root));
    const result = await applyModelProfilePlan(plan);
    expect(result.status).toBe("failed");
    expect(withoutBackups(await tree(workspace.root))).toEqual(before);
  });

  it("fails a draft plan when the stored profiles changed after planning", async () => {
    const workspace = await setup();
    const plan = await planModelProfileApplication({ target: workspace.target, profile: "draft", profileDefinition: draft, models });
    await createModelProfile(workspace.location, "other", draft);
    const result = await applyModelProfilePlan(plan);
    expect(result.status).toBe("failed");
    await expect(readFile(workspace.configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails a draft plan when saved local state changed after planning", async () => {
    const workspace = await setup();
    const plan = await planModelProfileApplication({ target: workspace.target, profile: "draft", profileDefinition: draft, agents: ["lead"], models });
    await saveModelResolutions(workspace.location, "openai", { lead: "openai/gpt-5.5" });
    expect((await applyModelProfilePlan(plan)).status).toBe("failed");
  });
});
