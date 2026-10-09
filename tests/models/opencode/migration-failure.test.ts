import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "pathe";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashAgentContent } from "../../../src/agents/sync.js";
import { migrateAgentModels, prepareAgentModelMigration } from "../../../src/models/opencode/migrate.js";
import { inventoryOf, useTemporaryRoots } from "../profiles/helpers.js";

const fault = vi.hoisted(() => ({ path: "", reads: false, failReplan: false }));
vi.mock("../../../src/models/opencode/safe-write.js", async (original) => {
  const actual = await original<typeof import("../../../src/models/opencode/safe-write.js")>();
  return { ...actual,
    writeSafeText: async (...args: Parameters<typeof actual.writeSafeText>) => {
      if (args[1] === fault.path) throw new Error("injected stage failure");
      const backup = await actual.writeSafeText(...args);
      if (fault.failReplan && args[1].endsWith("agents.json")) fault.reads = true;
      return backup;
    },
    readSafeText: async (...args: Parameters<typeof actual.readSafeText>) => {
      if (fault.reads && args[1] === fault.path) throw new Error("injected recovery planning failure");
      return actual.readSafeText(...args);
    },
  };
});
const roots = useTemporaryRoots();
afterEach(() => { fault.path = ""; fault.reads = false; fault.failReplan = false; });
const original = "---\ndescription: coder\nmodel: old/working\npermission:\n  edit: allow\n---\nKeep model: examples in instructions.\n";
const stripped = original.replace("model: old/working\n", "");

async function fixture() {
  const root = await roots.create();
  const put = async (relative: string, text: string) => {
    const file = path.join(root, relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); return file;
  };
  await put(".opencode/agents/coder.md", original);
  await put(".toolkit/agents.json", JSON.stringify({ schemaVersion: 1, target: "opencode", overrides: [], installed: { coder: { source: "toolkit", version: "1", hash: hashAgentContent(original) } } }));
  await put(".toolkit/models/profiles.json", JSON.stringify({ schemaVersion: 1, profiles: { fast: { agents: { coder: { id: "cpa-gui/gpt-6.1-sol" } } } } }));
  return { root, put, options: { target: root, profile: "fast", models: inventoryOf("cpa-gui/gpt-6.1-sol") } };
}

describe("interrupted migration stages", () => {
  it("retains recovery evidence if re-planning throws after a successful hash repair", async () => {
    const { root, options, put } = await fixture();
    await put(".opencode/agents/coder.md", stripped);
    await put(".opencode/agents/coder.md.123.0123456789abcdef.bak", original);
    await put("opencode.jsonc", JSON.stringify({ agents: { coder: { model: "cpa-gui/gpt-6.1-sol" } } }));
    fault.path = path.join(root, ".toolkit/models/profiles.json"); fault.failReplan = true;
    const result = await migrateAgentModels(options);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("re-planning failed");
    expect(result.filesChanged).toEqual([path.join(root, ".toolkit/agents.json")]);
    expect(result.backups).toHaveLength(1);
    expect(result.manualIntervention).toEqual(result.filesChanged);
    fault.reads = false; fault.failReplan = false; fault.path = "";
    expect((await migrateAgentModels(options)).status).toBe("applied");
  });
  it.each([0, 1, 2, 3, 4])("retains originals, reports stage %i accurately and safely retries", async (stage) => {
    const { root, options } = await fixture();
    const plan = await prepareAgentModelMigration(options);
    expect(plan.files).toHaveLength(5);
    fault.path = plan.files[stage]!.path;
    const result = await migrateAgentModels(options);
    expect(result.status).toBe("failed");
    expect(result.filesChanged).toEqual(plan.files.slice(0, stage).map((file) => file.path));
    for (const backup of result.backups) {
      expect(await readFile(backup, "utf8")).toBe(plan.files.find((file) => backup.startsWith(`${file.path}.`))!.before);
    }
    const agent = await readFile(path.join(root, ".opencode/agents/coder.md"), "utf8");
    expect(agent).toBe(stage > 1 ? stripped : original);
    if (stage > 1) expect(await readFile(path.join(root, "opencode.jsonc"), "utf8")).toContain("cpa-gui/gpt-6.1-sol");
    await expect(readFile(path.join(root, ".toolkit/models/local.json"))).rejects.toMatchObject({ code: "ENOENT" });
    fault.path = "";
    const retry = await migrateAgentModels(options);
    expect(["applied", "unchanged"]).toContain(retry.status);
    expect(await readFile(path.join(root, ".opencode/agents/coder.md"), "utf8")).toBe(stripped);
    const manifest = JSON.parse(await readFile(path.join(root, ".toolkit/agents.json"), "utf8"));
    expect(manifest.installed.coder.hash).toBe(hashAgentContent(stripped));
    expect(JSON.parse(await readFile(path.join(root, ".toolkit/models/local.json"), "utf8")).activeProfile).toBeUndefined();
  });
});
