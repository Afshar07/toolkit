import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hashAgentContent } from "../../../src/agents/sync.js";
import { migrateAgentModels, prepareAgentModelMigration } from "../../../src/models/opencode/migrate.js";
import { inventoryOf, useTemporaryRoots } from "../profiles/helpers.js";

const roots = useTemporaryRoots();
const withModel = "---\ndescription: Coder\nmodel: openai/gpt-5.5\n---\nBody\n";
const stripped = "---\ndescription: Coder\n---\nBody\n";

async function put(root: string, relative: string, text: string): Promise<string> {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return file;
}

const manifestText = (text: string, overrides: string[] = []) => JSON.stringify({
  schemaVersion: 1,
  target: "opencode",
  overrides,
  installed: { coder: { source: "toolkit", version: "1.2.3", hash: hashAgentContent(text) } },
}, null, 2) + "\n";

async function project(agentText = withModel, manifestFor = agentText, overrides: string[] = []) {
  const root = await roots.create();
  await put(root, ".opencode/agents/coder.md", agentText);
  await put(root, ".toolkit/agents.json", manifestText(manifestFor, overrides));
  await put(root, ".toolkit/models/profiles.json", JSON.stringify({ schemaVersion: 1, profiles: { fast: { agents: { coder: { id: "openai/gpt-5.5" } } } } }));
  return { root, options: { target: root, profile: "fast", models: inventoryOf("openai/gpt-5.5") } };
}

describe("migrateAgentModels", () => {
  it("orders config, stripped Markdown, manifest, then ownership and state", async () => {
    const { root, options } = await project();
    const plan = await prepareAgentModelMigration(options);
    expect(plan.status).toBe("ready");
    const names = plan.files.map((file) => path.relative(root, file.path).replaceAll("\\", "/"));
    expect(names.slice(0, 3)).toEqual(["opencode.jsonc", ".opencode/agents/coder.md", ".toolkit/agents.json"]);
    expect(names.slice(3)).toEqual([".toolkit/models/applied.json", ".toolkit/models/local.json"].filter((name) => names.includes(name)));
  });

  it("assigns the model in configuration, strips Markdown, and updates only the manifest hash", async () => {
    const { root, options } = await project();
    const result = await migrateAgentModels(options);
    expect(result.status).toBe("applied");
    expect(await readFile(path.join(root, ".opencode/agents/coder.md"), "utf8")).toBe(stripped);
    expect(await readFile(path.join(root, "opencode.jsonc"), "utf8")).toContain("openai/gpt-5.5");
    const manifest = JSON.parse(await readFile(path.join(root, ".toolkit/agents.json"), "utf8"));
    expect(manifest.installed.coder).toEqual({ source: "toolkit", version: "1.2.3", hash: hashAgentContent(stripped) });
  });

  it("writes nothing on a dry run", async () => {
    const { root, options } = await project();
    const result = await migrateAgentModels({ ...options, dryRun: true });
    expect(result.status).toBe("dry-run");
    expect(await readFile(path.join(root, ".opencode/agents/coder.md"), "utf8")).toBe(withModel);
    expect((await readdir(root)).sort()).toEqual([".opencode", ".toolkit"]);
  });

  it("never strips a modified agent", async () => {
    const { root, options } = await project(withModel, "original\n");
    const result = await migrateAgentModels(options);
    expect(result.status).toBe("blocked");
    expect(await readFile(path.join(root, ".opencode/agents/coder.md"), "utf8")).toBe(withModel);
  });

  it("leaves override agents untouched", async () => {
    const { root, options } = await project(withModel, withModel, ["coder"]);
    await migrateAgentModels(options);
    expect(await readFile(path.join(root, ".opencode/agents/coder.md"), "utf8")).toBe(withModel);
  });

  it("resumes when Markdown was stripped but the manifest hash was not updated", async () => {
    const { root, options } = await project(stripped, withModel);
    await put(root, "opencode.jsonc", '{\n  "agent": {\n    "coder": { "model": "openai/gpt-5.5" }\n  }\n}\n');
    await put(root, ".opencode/agents/coder.md.123.0123456789abcdef.bak", withModel);
    const result = await migrateAgentModels(options);
    expect(result.status).toBe("applied");
    const manifest = JSON.parse(await readFile(path.join(root, ".toolkit/agents.json"), "utf8"));
    expect(manifest.installed.coder.hash).toBe(hashAgentContent(stripped));
    expect(manifest.installed.coder.version).toBe("1.2.3");
  });

  it("previews the same resumable repair on a dry run without writing", async () => {
    const { root, options } = await project(stripped, withModel);
    await put(root, "opencode.jsonc", '{\n  "agent": {\n    "coder": { "model": "openai/gpt-5.5" }\n  }\n}\n');
    await put(root, ".opencode/agents/coder.md.123.0123456789abcdef.bak", withModel);
    const plan = await prepareAgentModelMigration(options);
    expect(plan.status).toBe("ready");
    expect(plan.files.map((file) => path.basename(file.path))).toEqual(["agents.json"]);
    const result = await migrateAgentModels({ ...options, dryRun: true });
    expect(result.status).toBe("dry-run");
    const manifest = JSON.parse(await readFile(path.join(root, ".toolkit/agents.json"), "utf8"));
    expect(manifest.installed.coder.hash).toBe(hashAgentContent(withModel));
  });

  it("does not treat a backup as proof when configuration no longer assigns the model", async () => {
    const { root, options } = await project(stripped, withModel);
    await put(root, "opencode.jsonc", "{}\n");
    await put(root, ".opencode/agents/coder.md.123.0123456789abcdef.bak", withModel);
    const result = await migrateAgentModels(options);
    expect(result.status).toBe("blocked");
    expect(result.plan.conflicts).toEqual(["coder: modified-agent"]);
    const manifest = JSON.parse(await readFile(path.join(root, ".toolkit/agents.json"), "utf8"));
    expect(manifest.installed.coder.hash).toBe(hashAgentContent(withModel));
  });

  it("requires manual intervention when no backup proves the original", async () => {
    const { root, options } = await project(stripped, withModel);
    const result = await migrateAgentModels(options);
    expect(result.status).toBe("blocked");
    const manifest = JSON.parse(await readFile(path.join(root, ".toolkit/agents.json"), "utf8"));
    expect(manifest.installed.coder.hash).toBe(hashAgentContent(withModel));
  });
});
