import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createModelProfile,
  readLocalModelState,
  readModelResolutions,
  resolveModelProfileLocation,
  saveModelResolutions,
  setActiveModelProfile,
} from "../../../src/models/index.js";
import type { IModelProfile, IModelProfileLocation } from "../../../src/models/index.js";
import { hashAgentContent } from "../../../src/agents/sync.js";
import { agentDirectory } from "../../../src/agents/target.js";
import type { AgentTarget } from "../../../src/agents/target.js";
import { applyModelProfile, applyModelProfilePlan } from "../../../src/models/opencode/apply.js";
import { planModelProfileApplication } from "../../../src/models/opencode/plan.js";
import { inventoryOf, useTemporaryRoots } from "../profiles/helpers.js";

const roots = useTemporaryRoots();
const models = inventoryOf("openai/gpt-5.5", "openai/gpt-6.1-sol", "cpa-gui/gpt-5.5", "cpa-gui/claude-sonnet-5-5");
const modelFree = (name: string) => `---\ndescription: ${name}\n---\n${name} body\n`;

const profiles: Record<string, IModelProfile> = {
  openai: { agents: { lead: { id: "openai/gpt-5.5" }, coder: { id: "openai/gpt-6.1-sol" } } },
  cpa: { agents: { lead: { id: "cpa-gui/gpt-5.5" }, coder: { id: "cpa-gui/claude-sonnet-5-5" } } },
  partial: { agents: { lead: { id: "openai/gpt-5.5" }, coder: { id: "openai/not-installed" } } },
  shared: { agents: { lead: { family: "gpt-5.5", allowedProviders: ["cpa-gui", "openai"] } } },
};

interface ISetupOptions {
  readonly scope?: "project" | "global";
  /** Agent file contents by name; defaults to model-free `lead` and `coder`. */
  readonly agents?: Record<string, string>;
  /** Agents recorded as installed with a matching hash. Defaults to every agent file. */
  readonly installed?: readonly string[];
  readonly overrides?: readonly string[];
  readonly profiles?: Record<string, IModelProfile>;
  readonly config?: { readonly name: string; readonly text: string };
}
interface IWorkspace {
  readonly root: string;
  readonly target: AgentTarget;
  readonly location: IModelProfileLocation;
  readonly configPath: string;
}

/** A temporary OpenCode target with installed model-free agents and stored profiles; never the real config. */
async function setup(options: ISetupOptions = {}): Promise<IWorkspace> {
  const root = await roots.create();
  const target: AgentTarget = options.scope === "global" ? { scope: "global", root } : root;
  const location = resolveModelProfileLocation(target);
  const agents = options.agents ?? { lead: modelFree("lead"), coder: modelFree("coder") };
  await mkdir(agentDirectory(target), { recursive: true });
  const installed: Record<string, { source: "toolkit"; version: string; hash: string }> = {};
  for (const [name, text] of Object.entries(agents)) {
    await writeFile(path.join(agentDirectory(target), `${name}.md`), text);
    if ((options.installed ?? Object.keys(agents)).includes(name)) installed[name] = { source: "toolkit", version: "1", hash: hashAgentContent(text) };
  }
  await mkdir(path.join(root, ".toolkit"), { recursive: true });
  await writeFile(path.join(root, ".toolkit", "agents.json"), `${JSON.stringify({ schemaVersion: 1, target: "opencode", overrides: options.overrides ?? [], installed }, null, 2)}\n`);
  for (const [name, profile] of Object.entries(options.profiles ?? profiles)) await createModelProfile(location, name, profile);
  const configName = options.config?.name ?? "opencode.jsonc";
  if (options.config) await writeFile(path.join(root, configName), options.config.text);
  return { root, target, location, configPath: path.join(root, configName) };
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
const names = (workspace: IWorkspace, files: readonly { path: string }[]) => files.map((file) => path.relative(workspace.root, file.path).replaceAll("\\", "/")).sort();
const readConfig = async (workspace: IWorkspace) => readFile(workspace.configPath, "utf8");
const exists = (file: string) => readFile(file, "utf8").then(() => true, () => false);

describe("planning a profile application", () => {
  it("plans a complete profile as ready, writing nothing while planning", async () => {
    const workspace = await setup();
    const before = await tree(workspace.root);
    const plan = await planModelProfileApplication({ target: workspace.target, profile: "openai", models });
    expect(plan.status).toBe("ready");
    expect(plan.conflicts).toEqual([]);
    expect(plan.assignments).toEqual([
      { agent: "coder", model: "openai/gpt-6.1-sol", previous: undefined, ownership: "absent", status: "apply" },
      { agent: "lead", model: "openai/gpt-5.5", previous: undefined, ownership: "absent", status: "apply" },
    ]);
    expect(names(workspace, plan.files)).toEqual([".toolkit/models/applied.json", ".toolkit/models/local.json", "opencode.jsonc"]);
    expect(await tree(workspace.root)).toEqual(before);
  });

  it("uses the active profile when none is named", async () => {
    const workspace = await setup();
    await setActiveModelProfile(workspace.location, "cpa");
    const plan = await planModelProfileApplication({ target: workspace.target, models });
    expect(plan).toMatchObject({ status: "ready", profile: "cpa" });
  });

  it("reports no-profile without an active profile, and not-found for an unknown name", async () => {
    const workspace = await setup();
    const before = await tree(workspace.root);
    expect(await planModelProfileApplication({ target: workspace.target, models })).toMatchObject({ status: "no-profile", files: [] });
    expect(await planModelProfileApplication({ target: workspace.target, profile: "missing", models })).toMatchObject({ status: "not-found", profile: "missing", files: [] });
    expect((await applyModelProfile({ target: workspace.target, profile: "missing", models })).status).toBe("blocked");
    expect(await tree(workspace.root)).toEqual(before);
  });

  it("blocks an incomplete profile and writes nothing for the agents that did resolve", async () => {
    const workspace = await setup();
    const before = await tree(workspace.root);
    const plan = await planModelProfileApplication({ target: workspace.target, profile: "partial", models });
    expect(plan.status).toBe("blocked");
    expect(plan.resolution).toMatchObject({ complete: false, summary: { resolved: 1, unavailable: 1 } });
    expect(plan.files).toEqual([]);
    expect(plan.assignments.map((item) => item.agent)).toEqual(["lead"]);
    const result = await applyModelProfile({ target: workspace.target, profile: "partial", models });
    expect(result).toMatchObject({ status: "blocked", filesChanged: [] });
    expect(await tree(workspace.root)).toEqual(before);
    expect(await exists(workspace.configPath)).toBe(false);
  });

  it("blocks an ambiguous agent until an exact saved selection resolves it", async () => {
    const workspace = await setup();
    const ambiguous = await planModelProfileApplication({ target: workspace.target, profile: "shared", models });
    expect(ambiguous.status).toBe("blocked");
    expect(ambiguous.resolution?.agents.lead).toMatchObject({ status: "ambiguous" });
    expect(ambiguous.files).toEqual([]);

    expect(await saveModelResolutions(workspace.location, "shared", { lead: "cpa-gui/gpt-5.5" })).toMatchObject({ status: "changed" });
    const saved = await planModelProfileApplication({ target: workspace.target, profile: "shared", models });
    expect(saved.status).toBe("ready");
    expect(saved.resolution?.agents.lead).toMatchObject({ status: "resolved", source: "saved" });
    expect(saved.assignments).toMatchObject([{ agent: "lead", model: "cpa-gui/gpt-5.5", status: "apply" }]);
    expect(names(workspace, saved.files)).toEqual([".toolkit/models/applied.json", "opencode.jsonc"]);
  });

  it("persists the exact resolved IDs as saved selections when applying", async () => {
    const workspace = await setup();
    expect(await readModelResolutions(workspace.location, "openai")).toEqual({});
    await applyModelProfile({ target: workspace.target, profile: "openai", models });
    expect(await readModelResolutions(workspace.location, "openai")).toEqual({ coder: "openai/gpt-6.1-sol", lead: "openai/gpt-5.5" });
  });

  it("rejects malformed configuration instead of planning over it", async () => {
    const workspace = await setup({ config: { name: "opencode.json", text: '{"agents": ' } });
    await expect(planModelProfileApplication({ target: workspace.target, profile: "openai", models })).rejects.toMatchObject({ kind: "invalid-config" });
    expect(await readConfig(workspace)).toBe('{"agents": ');
  });

  it("reports competing configuration files as a conflict that cannot be applied", async () => {
    const workspace = await setup({ config: { name: "opencode.json", text: "{}" } });
    await writeFile(path.join(workspace.root, "opencode.jsonc"), "{}");
    const before = await tree(workspace.root);
    const plan = await planModelProfileApplication({ target: workspace.target, profile: "openai", models });
    expect(plan.status).toBe("config-conflict");
    expect(plan.conflicts.map((file) => path.basename(file)).sort()).toEqual(["opencode.json", "opencode.jsonc"]);
    expect(plan.files).toEqual([]);
    expect((await applyModelProfilePlan(plan)).status).toBe("blocked");
    expect(await tree(workspace.root)).toEqual(before);
  });

  it.each([
    ["an agent file that is missing", { agents: { lead: modelFree("lead") } }, "coder: missing-agent"],
    ["an agent file Toolkit does not own", { installed: ["lead"] }, "coder: unmanaged-agent"],
    ["an agent edited since installation", { agents: { lead: modelFree("lead"), coder: modelFree("coder") }, installed: ["lead", "coder"], edit: "coder" }, "coder: modified-agent"],
    ["an agent still carrying a frontmatter model", { agents: { lead: modelFree("lead"), coder: "---\ndescription: coder\nmodel: old/model\n---\nbody\n" } }, "coder: migration-required"],
  ] as const)("blocks %s", async (_label, options, conflict) => {
    const { edit, ...rest } = options as ISetupOptions & { edit?: string };
    const workspace = await setup(rest);
    if (edit) await writeFile(path.join(agentDirectory(workspace.target), `${edit}.md`), "edited by the user\n");
    const plan = await planModelProfileApplication({ target: workspace.target, profile: "openai", models });
    expect(plan.status).toBe("blocked");
    expect(plan.conflicts).toEqual([conflict]);
    expect(plan.files).toEqual([]);
  });

  it("skips an overridden agent without blocking the others", async () => {
    const workspace = await setup({ overrides: ["coder"] });
    const plan = await planModelProfileApplication({ target: workspace.target, profile: "openai", models });
    expect(plan.status).toBe("ready");
    expect(plan.assignments.find((item) => item.agent === "coder")?.status).toBe("skipped-override");
    await applyModelProfilePlan(plan);
    expect(await readConfig(workspace)).toContain("openai/gpt-5.5");
    expect(await readConfig(workspace)).not.toContain("gpt-6.1-sol");
  });
});

describe("applying a profile", () => {
  it("writes assignments, ownership, and saved selections while preserving user configuration", async () => {
    const text = `\uFEFF// keep me\r\n{\r\n  "provider": {"custom": {"npm": "pkg",},},\r\n  "permission": {"bash": "ask"},\r\n  "x-unknown": [1,],\r\n}\r\n`;
    const workspace = await setup({ config: { name: "opencode.jsonc", text } });
    const result = await applyModelProfile({ target: workspace.target, profile: "openai", models });
    expect(result.status).toBe("applied");
    expect(names(workspace, result.filesChanged.map((file) => ({ path: file })))).toEqual([".toolkit/models/applied.json", ".toolkit/models/local.json", "opencode.jsonc"]);

    const written = await readConfig(workspace);
    expect(written.startsWith("\uFEFF// keep me\r\n")).toBe(true);
    expect(written).toContain('"provider": {"custom": {"npm": "pkg",},},');
    expect(written).toContain('"permission": {"bash": "ask"}');
    expect(/(?<!\r)\n/.test(written)).toBe(false);
    expect(written).toContain("openai/gpt-5.5");
    expect(written).toContain("openai/gpt-6.1-sol");

    expect(JSON.parse(await readFile(path.join(workspace.root, ".toolkit/models/applied.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      agents: {
        coder: { config: "opencode.jsonc", model: "openai/gpt-6.1-sol" },
        lead: { config: "opencode.jsonc", model: "openai/gpt-5.5" },
      },
    });
  });

  it("keeps a backup of every replaced file and none for newly created ones", async () => {
    const workspace = await setup({ config: { name: "opencode.jsonc", text: "{}\n" } });
    const result = await applyModelProfile({ target: workspace.target, profile: "openai", models });
    expect(result.backups).toHaveLength(1);
    expect(await readFile(result.backups[0]!, "utf8")).toBe("{}\n");
  });

  it("updates a single existing opencode.json in place without creating opencode.jsonc", async () => {
    const workspace = await setup({ config: { name: "opencode.json", text: "{}\n" } });
    await applyModelProfile({ target: workspace.target, profile: "openai", models });
    expect(await exists(path.join(workspace.root, "opencode.jsonc"))).toBe(false);
    expect(await readConfig(workspace)).toContain("openai/gpt-5.5");
    expect(JSON.parse(await readFile(path.join(workspace.root, ".toolkit/models/applied.json"), "utf8")).agents.lead.config).toBe("opencode.json");
  });

  it("is idempotent: a second apply changes and backs up nothing", async () => {
    const workspace = await setup();
    expect((await applyModelProfile({ target: workspace.target, profile: "openai", models })).status).toBe("applied");
    const after = await tree(workspace.root);
    const second = await applyModelProfile({ target: workspace.target, profile: "openai", models });
    expect(second).toMatchObject({ status: "unchanged", filesChanged: [], backups: [] });
    expect(second.plan.assignments.map((item) => [item.status, item.ownership])).toEqual([["unchanged", "identical"], ["unchanged", "identical"]]);
    expect(await tree(workspace.root)).toEqual(after);
  });

  it("switches providers for assignments it owns, updating ownership and selections", async () => {
    const workspace = await setup();
    await applyModelProfile({ target: workspace.target, profile: "openai", models });
    const plan = await planModelProfileApplication({ target: workspace.target, profile: "cpa", models });
    expect(plan.assignments.map((item) => [item.agent, item.ownership, item.status])).toEqual([["coder", "managed-current", "apply"], ["lead", "managed-current", "apply"]]);

    const result = await applyModelProfilePlan(plan);
    expect(result.status).toBe("applied");
    expect(result.backups).toHaveLength(3);
    const config = await readConfig(workspace);
    expect(config).toContain("cpa-gui/gpt-5.5");
    expect(config).toContain("cpa-gui/claude-sonnet-5-5");
    expect(config).not.toContain("openai/");
    expect(JSON.parse(await readFile(path.join(workspace.root, ".toolkit/models/applied.json"), "utf8")).agents.lead).toEqual({ config: "opencode.jsonc", model: "cpa-gui/gpt-5.5" });
    expect(await readModelResolutions(workspace.location, "cpa")).toEqual({ coder: "cpa-gui/claude-sonnet-5-5", lead: "cpa-gui/gpt-5.5" });
    // Selections made for the previous profile stay put.
    expect(await readModelResolutions(workspace.location, "openai")).toEqual({ coder: "openai/gpt-6.1-sol", lead: "openai/gpt-5.5" });
  });

  describe("unmanaged assignments", () => {
    const unmanaged = { name: "opencode.jsonc", text: '{\n  "agents": {\n    "lead": {"model": "other/user-choice"}\n  }\n}\n' };

    it("conflicts without consent and leaves everything untouched", async () => {
      const workspace = await setup({ config: unmanaged });
      const before = await tree(workspace.root);
      const result = await applyModelProfile({ target: workspace.target, profile: "openai", models });
      expect(result.status).toBe("blocked");
      expect(result.plan.conflicts).toEqual(["lead: conflict"]);
      expect(result.plan.assignments.find((item) => item.agent === "lead")).toMatchObject({ previous: "other/user-choice", ownership: "unmanaged", status: "conflict" });
      expect(result.plan.files).toEqual([]);
      expect(await tree(workspace.root)).toEqual(before);
    });

    it("replaces only the agents the caller consented to, then owns them", async () => {
      const workspace = await setup({ config: unmanaged });
      const result = await applyModelProfile({ target: workspace.target, profile: "openai", models, replaceAssignments: new Set(["lead"]) });
      expect(result.status).toBe("applied");
      expect(JSON.parse(await readConfig(workspace)).agents).toEqual({ lead: { model: "openai/gpt-5.5" }, coder: { model: "openai/gpt-6.1-sol" } });
      expect(JSON.parse(await readFile(path.join(workspace.root, ".toolkit/models/applied.json"), "utf8")).agents.lead.model).toBe("openai/gpt-5.5");
    });

    it("ignores consent for agents that do not conflict", async () => {
      const workspace = await setup();
      const plan = await planModelProfileApplication({ target: workspace.target, profile: "openai", models, replaceAssignments: new Set(["lead", "coder", "reviewer"]) });
      expect(plan.status).toBe("ready");
      expect(plan.assignments.map((item) => item.ownership)).toEqual(["absent", "absent"]);
    });

    it("does not take ownership of an identical unmanaged assignment", async () => {
      const workspace = await setup({ config: { name: "opencode.jsonc", text: '{"agents": {"lead": {"model": "openai/gpt-5.5"}}}\n' } });
      const result = await applyModelProfile({ target: workspace.target, profile: "openai", models });
      expect(result.status).toBe("applied");
      expect(result.plan.assignments.find((item) => item.agent === "lead")).toMatchObject({ ownership: "identical", status: "unchanged" });
      const files = await tree(workspace.root);
      const applied = JSON.parse(files[".toolkit/models/applied.json"]!);
      expect(Object.keys(applied.agents)).toEqual(["coder"]);
    });

    it("lets a legacy singular agent entry count as an unmanaged assignment", async () => {
      const workspace = await setup({ config: { name: "opencode.jsonc", text: '{"agent": {"lead": {"model": "legacy/model"}}}\n' } });
      const plan = await planModelProfileApplication({ target: workspace.target, profile: "openai", models });
      expect(plan.assignments.find((item) => item.agent === "lead")).toMatchObject({ previous: "legacy/model", ownership: "unmanaged", status: "conflict" });
    });
  });

  describe("edited owned assignments", () => {
    it("conflicts when the user changed a model Toolkit applied, until they consent", async () => {
      const workspace = await setup();
      await applyModelProfile({ target: workspace.target, profile: "openai", models });
      await writeFile(workspace.configPath, (await readConfig(workspace)).replace("openai/gpt-5.5", "user/edited"));
      const edited = await tree(workspace.root);

      const blocked = await applyModelProfile({ target: workspace.target, profile: "openai", models });
      expect(blocked.status).toBe("blocked");
      expect(blocked.plan.conflicts).toEqual(["lead: conflict"]);
      expect(blocked.plan.assignments.map((item) => [item.agent, item.ownership, item.status])).toEqual([["coder", "identical", "unchanged"], ["lead", "edited", "conflict"]]);
      expect(await tree(workspace.root)).toEqual(edited);

      const consented = await applyModelProfile({ target: workspace.target, profile: "openai", models, replaceAssignments: new Set(["lead"]) });
      expect(consented.status).toBe("applied");
      expect(await readConfig(workspace)).toContain("openai/gpt-5.5");
      expect(await readConfig(workspace)).not.toContain("user/edited");
    });

    it("refuses to choose when an owned configuration gains a competing file", async () => {
      const workspace = await setup();
      await applyModelProfile({ target: workspace.target, profile: "openai", models });
      const moved = (await readConfig(workspace)).replace("openai/gpt-5.5", "other/model");
      await writeFile(path.join(workspace.root, "opencode.json"), moved);
      await writeFile(workspace.configPath, "{}");
      // Two supported files now compete, so nothing is chosen between them.
      expect((await planModelProfileApplication({ target: workspace.target, profile: "openai", models })).status).toBe("config-conflict");
    });
  });

  describe("dry run", () => {
    it("reports the plan without writing anything", async () => {
      const workspace = await setup({ config: { name: "opencode.jsonc", text: "{}\n" } });
      const before = await tree(workspace.root);
      const result = await applyModelProfile({ target: workspace.target, profile: "openai", models, dryRun: true });
      expect(result).toMatchObject({ status: "dry-run", filesChanged: [], backups: [] });
      expect(result.plan.files.length).toBeGreaterThan(0);
      expect(await tree(workspace.root)).toEqual(before);
      expect(await exists(path.join(workspace.root, ".toolkit/models/applied.json"))).toBe(false);
    });

    it("applies the same plan afterwards", async () => {
      const workspace = await setup();
      const plan = await planModelProfileApplication({ target: workspace.target, profile: "openai", models });
      expect((await applyModelProfilePlan(plan, { dryRun: true })).status).toBe("dry-run");
      expect(await exists(workspace.configPath)).toBe(false);
      expect((await applyModelProfilePlan(plan)).status).toBe("applied");
      expect(await exists(workspace.configPath)).toBe(true);
    });

    it("reports a blocked plan as blocked even in dry-run", async () => {
      const workspace = await setup();
      expect((await applyModelProfile({ target: workspace.target, profile: "partial", models, dryRun: true })).status).toBe("blocked");
    });
  });

  describe("concurrent changes", () => {
    it("rejects a configuration changed after planning and writes nothing", async () => {
      const workspace = await setup({ config: { name: "opencode.jsonc", text: "{}\n" } });
      const plan = await planModelProfileApplication({ target: workspace.target, profile: "openai", models });
      await writeFile(workspace.configPath, '{"changed": "meanwhile"}\n');
      const before = await tree(workspace.root);
      const result = await applyModelProfilePlan(plan);
      expect(result).toMatchObject({ status: "failed", filesChanged: [], manualIntervention: [] });
      expect(result.error).toContain("File changed since planning");
      expect(await tree(workspace.root)).toEqual(before);
    });

    it("rejects a configuration created after planning without overwriting it", async () => {
      const workspace = await setup();
      const plan = await planModelProfileApplication({ target: workspace.target, profile: "openai", models });
      await writeFile(workspace.configPath, '{"created": "meanwhile"}\n');
      const result = await applyModelProfilePlan(plan);
      expect(result.status).toBe("failed");
      expect(await readConfig(workspace)).toBe('{"created": "meanwhile"}\n');
      expect(await exists(path.join(workspace.root, ".toolkit/models/applied.json"))).toBe(false);
    });

    it.each([
      ["an agent file", (workspace: IWorkspace) => path.join(agentDirectory(workspace.target), "lead.md")],
      ["the agent manifest", (workspace: IWorkspace) => path.join(workspace.root, ".toolkit/agents.json")],
      ["the profile store", (workspace: IWorkspace) => workspace.location.profilesPath],
    ])("rejects a read dependency changed after planning: %s", async (_label, locate) => {
      const workspace = await setup();
      const plan = await planModelProfileApplication({ target: workspace.target, profile: "openai", models });
      await writeFile(locate(workspace), `${await readFile(locate(workspace), "utf8")}\n`);
      const before = await tree(workspace.root);
      const result = await applyModelProfilePlan(plan);
      expect(result.status).toBe("failed");
      expect(result.error).toContain("File changed since planning");
      expect(await tree(workspace.root)).toEqual(before);
      expect(await exists(workspace.configPath)).toBe(false);
    });

    it("rejects a plan applied twice because the first apply changed its snapshots", async () => {
      const workspace = await setup();
      const plan = await planModelProfileApplication({ target: workspace.target, profile: "openai", models });
      expect((await applyModelProfilePlan(plan)).status).toBe("applied");
      const result = await applyModelProfilePlan(plan);
      expect(result.status).toBe("failed");
      expect(result.error).toContain("File changed since planning");
    });
  });
});

describe("scopes", () => {
  it("applies a global target under its own root and agent directory without touching a project", async () => {
    const globalWorkspace = await setup({ scope: "global" });
    const project = await setup();
    const projectBefore = await tree(project.root);
    const result = await applyModelProfile({ target: globalWorkspace.target, profile: "openai", models });
    expect(result.status).toBe("applied");
    expect(await readConfig(globalWorkspace)).toContain("openai/gpt-5.5");
    expect(path.relative(globalWorkspace.root, agentDirectory(globalWorkspace.target)).replaceAll("\\", "/")).toBe("agents");
    expect(await tree(project.root)).toEqual(projectBefore);
  });

  it("applies a project target without touching a global one", async () => {
    const globalWorkspace = await setup({ scope: "global" });
    const project = await setup();
    const globalBefore = await tree(globalWorkspace.root);
    expect((await applyModelProfile({ target: project.target, profile: "openai", models })).status).toBe("applied");
    expect(await tree(globalWorkspace.root)).toEqual(globalBefore);
  });

  it("does not look in .opencode for global configuration, but does for project configuration", async () => {
    const project = await setup();
    await mkdir(path.join(project.root, ".opencode"), { recursive: true });
    await writeFile(path.join(project.root, ".opencode/opencode.json"), "{}\n");
    const projectPlan = await planModelProfileApplication({ target: project.target, profile: "openai", models });
    expect(projectPlan.files.find((file) => file.path.endsWith("opencode.json"))?.path.replaceAll("\\", "/")).toContain(".opencode/opencode.json");

    const globalWorkspace = await setup({ scope: "global" });
    await mkdir(path.join(globalWorkspace.root, ".opencode"), { recursive: true });
    await writeFile(path.join(globalWorkspace.root, ".opencode/opencode.json"), "{}\n");
    const globalPlan = await planModelProfileApplication({ target: globalWorkspace.target, profile: "openai", models });
    expect(names(globalWorkspace, globalPlan.files)).toContain("opencode.jsonc");
  });

  it("keeps saved selections in the applying scope when a project inherits a global profile", async () => {
    const globalWorkspace = await setup({ scope: "global" });
    const project = await setup({ profiles: {} });
    const globalBefore = await tree(globalWorkspace.root);
    expect((await planModelProfileApplication({ target: project.target, profile: "openai", models })).status).toBe("not-found");

    const result = await applyModelProfile({ target: project.target, profile: "openai", models, inheritFrom: globalWorkspace.location });
    expect(result.status).toBe("applied");
    expect(await readModelResolutions(project.location, "openai")).toEqual({ coder: "openai/gpt-6.1-sol", lead: "openai/gpt-5.5" });
    expect((await readLocalModelState(globalWorkspace.location)).resolutions).toEqual({});
    expect(await tree(globalWorkspace.root)).toEqual(globalBefore);
  });

  describe("project shadowing of a global application", () => {
    it("reports agents a project configuration model would shadow, without blocking or writing the project", async () => {
      const globalWorkspace = await setup({ scope: "global" });
      const project = await setup({ config: { name: "opencode.json", text: '{"agents": {"lead": {"model": "project/choice"}}}\n' } });
      const projectBefore = await tree(project.root);
      const result = await applyModelProfile({ target: globalWorkspace.target, profile: "openai", models, project: project.root });
      expect(result.status).toBe("applied");
      expect(result.plan.shadowed).toEqual(["lead"]);
      expect(await tree(project.root)).toEqual(projectBefore);
    });

    it("also detects a project legacy singular agent model", async () => {
      const globalWorkspace = await setup({ scope: "global" });
      const project = await setup({ config: { name: "opencode.json", text: '{"agent": {"coder": {"model": "project/choice"}}}\n' } });
      const plan = await planModelProfileApplication({ target: globalWorkspace.target, profile: "openai", models, project: project.root });
      expect(plan.shadowed).toEqual(["coder"]);
    });

    it("detects a project agent file with a frontmatter model", async () => {
      const globalWorkspace = await setup({ scope: "global" });
      const project = await setup({ agents: { lead: modelFree("lead"), coder: "---\ndescription: coder\nmodel: project/choice\n---\nbody\n" } });
      const plan = await planModelProfileApplication({ target: globalWorkspace.target, profile: "openai", models, project: project.root });
      expect(plan.shadowed).toEqual(["coder"]);
    });

    it("reports nothing when the project defines no models", async () => {
      const globalWorkspace = await setup({ scope: "global" });
      const project = await setup();
      const plan = await planModelProfileApplication({ target: globalWorkspace.target, profile: "openai", models, project: project.root });
      expect(plan).toMatchObject({ status: "ready", shadowed: [] });
    });

    it("flags an unknown effective configuration when the project has competing files", async () => {
      const globalWorkspace = await setup({ scope: "global" });
      const project = await setup({ config: { name: "opencode.json", text: "{}\n" } });
      await writeFile(path.join(project.root, "opencode.jsonc"), "{}\n");
      const plan = await planModelProfileApplication({ target: globalWorkspace.target, profile: "openai", models, project: project.root });
      expect(plan.shadowed).toHaveLength(2);
      expect(plan.shadowed.every((item) => item.startsWith("Unknown effective configuration: "))).toBe(true);
    });

    it("only inspects a project for a global application", async () => {
      const project = await setup({ config: { name: "opencode.json", text: '{"agents": {"lead": {"model": "project/choice"}}}\n' } });
      const other = await setup();
      const plan = await planModelProfileApplication({ target: other.target, profile: "openai", models, project: project.root });
      expect(plan.shadowed).toEqual([]);
    });
  });
});
