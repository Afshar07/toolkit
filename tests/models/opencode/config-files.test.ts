import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ModelProfileError } from "../../../src/models/index.js";
import { inspectOpenCodeConfig } from "../../../src/models/opencode/config-files.js";
import { useTemporaryRoots } from "../profiles/helpers.js";

const roots = useTemporaryRoots();
const global = (root: string) => ({ scope: "global" as const, root });
const slash = (value: string) => value.replaceAll("\\", "/");

async function put(root: string, relative: string, text: string): Promise<void> {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

describe("inspectOpenCodeConfig", () => {
  it("reports an absent configuration as an empty ready file at opencode.jsonc without creating it", async () => {
    const root = await roots.create();
    const result = await inspectOpenCodeConfig(root);
    expect(result).toMatchObject({ status: "ready", file: { text: undefined, value: {} } });
    if (result.status === "ready") expect(slash(result.file.path)).toBe(slash(path.join(root, "opencode.jsonc")));
    expect(await readdir(root)).toEqual([]);
  });

  it.each(["opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc"])("reads a single project file at %s", async (name) => {
    const root = await roots.create();
    await put(root, name, '// c\n{"a": 1,}\n');
    const result = await inspectOpenCodeConfig(root);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(slash(result.file.path)).toBe(slash(path.join(root, name)));
    expect(result.file.text).toBe('// c\n{"a": 1,}\n');
    expect(result.file.value).toEqual({ a: 1 });
  });

  it("treats a string target as a project", async () => {
    const root = await roots.create();
    expect((await inspectOpenCodeConfig(root)).target.scope).toBe("project");
    expect((await inspectOpenCodeConfig(global(root))).target.scope).toBe("global");
  });

  it.each(["opencode.json", "opencode.jsonc"])("reads a single global file at %s", async (name) => {
    const root = await roots.create();
    await put(root, name, '{"g": true}');
    const result = await inspectOpenCodeConfig(global(root));
    expect(result.status === "ready" && result.file.value).toEqual({ g: true });
  });

  it("ignores .opencode configuration files in the global scope", async () => {
    const root = await roots.create();
    await put(root, ".opencode/opencode.json", '{"ignored": true}');
    const result = await inspectOpenCodeConfig(global(root));
    expect(result).toMatchObject({ status: "ready", file: { text: undefined, value: {} } });
  });

  it("reports competing files in one directory as a conflict instead of choosing", async () => {
    const root = await roots.create();
    await put(root, "opencode.json", "{}");
    await put(root, "opencode.jsonc", "{}");
    const result = await inspectOpenCodeConfig(root);
    expect(result.status).toBe("config-conflict");
    if (result.status === "config-conflict") expect(result.files.map(slash)).toEqual([slash(path.join(root, "opencode.json")), slash(path.join(root, "opencode.jsonc"))]);
  });

  it("reports the root file versus the .opencode file as a conflict", async () => {
    const root = await roots.create();
    await put(root, "opencode.jsonc", "{}");
    await put(root, ".opencode/opencode.json", "{}");
    expect((await inspectOpenCodeConfig(root)).status).toBe("config-conflict");
  });

  it("reports global competing files as a conflict", async () => {
    const root = await roots.create();
    await put(root, "opencode.json", "{}");
    await put(root, "opencode.jsonc", "{}");
    expect((await inspectOpenCodeConfig(global(root))).status).toBe("config-conflict");
  });

  it("rejects a malformed configuration with invalid-config", async () => {
    const root = await roots.create();
    await put(root, "opencode.json", '{"a": ');
    await expect(inspectOpenCodeConfig(root)).rejects.toMatchObject({ kind: "invalid-config" });
  });

  it("rejects a configuration with duplicate keys", async () => {
    const root = await roots.create();
    await put(root, "opencode.jsonc", '{"a": 1, "a": 2}');
    await expect(inspectOpenCodeConfig(root)).rejects.toBeInstanceOf(ModelProfileError);
  });

  it("rejects a configuration path that is not a regular file", async () => {
    const root = await roots.create();
    await mkdir(path.join(root, "opencode.json"));
    await expect(inspectOpenCodeConfig(root)).rejects.toMatchObject({ kind: "unsafe-path" });
  });

  it("rejects a configuration larger than 1 MiB", async () => {
    const root = await roots.create();
    await put(root, "opencode.json", `{"pad": "${"x".repeat(1024 * 1024)}"}`);
    await expect(inspectOpenCodeConfig(root)).rejects.toMatchObject({ kind: "invalid-config" });
  });
});
