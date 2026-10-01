import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import * as nodePath from "node:path";
import * as path from "pathe";
import { afterEach, describe, expect, it } from "vitest";
import { addToolkitMarker, applyContextPlan, inspectContextPlan } from "../../src/context/reconcile.js";

const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("context reconciliation", () => {
  it("classifies missing, exact, managed, and unmanaged files", async () => {
    const directory = await temporaryDirectory();
    await writeFile(path.join(directory, "exact.md"), addToolkitMarker("exact"));
    await writeFile(path.join(directory, "managed.md"), addToolkitMarker("old"));
    await writeFile(path.join(directory, "conflict.md"), "user content");
    const inspected = await inspectContextPlan(directory, ["new.md", "exact.md", "managed.md", "conflict.md"].map((relativePath) => ({ relativePath, content: relativePath === "exact.md" ? "exact" : "new" })));
    expect(inspected.map(({ relativePath, state }) => [relativePath, state])).toEqual([["new.md", "create"], ["exact.md", "unchanged"], ["managed.md", "managed-update"], ["conflict.md", "conflict"]]);
  });

  it("treats a modified managed body as a conflict", async () => {
    const directory = await temporaryDirectory();
    await writeFile(path.join(directory, "file.md"), `${addToolkitMarker("original")}\nuser edit`);
    await expect(inspectContextPlan(directory, [{ relativePath: "file.md", content: "new" }])).resolves.toMatchObject([{ state: "conflict" }]);
  });

  it("continues selectively and preserves skipped files", async () => {
    const directory = await temporaryDirectory();
    await writeFile(path.join(directory, "managed.md"), addToolkitMarker("old"));
    await writeFile(path.join(directory, "conflict.md"), "keep");
    const inspected = await inspectContextPlan(directory, [{ relativePath: "new.md", content: "new" }, { relativePath: "managed.md", content: "updated" }, { relativePath: "conflict.md", content: "replacement" }]);
    await expect(applyContextPlan(inspected, { decisions: { "managed.md": "replace", "conflict.md": "skip" } })).resolves.toMatchObject({ created: ["new.md"], replaced: ["managed.md"], skipped: ["conflict.md"] });
    await expect(readFile(path.join(directory, "conflict.md"), "utf8")).resolves.toBe("keep");
  });

  it("backs up replaced originals under the supplied root", async () => {
    const directory = await temporaryDirectory();
    const backup = path.join(directory, ".toolkit-backups", "run");
    await mkdir(path.join(directory, "nested"));
    await writeFile(path.join(directory, "nested", "file.md"), "keep");
    const inspected = await inspectContextPlan(directory, [{ relativePath: "nested/file.md", content: "new" }]);
    const result = await applyContextPlan(inspected, { decisions: { "nested/file.md": "replace" }, backupRoot: backup });
    await expect(readFile(path.join(backup, "nested", "file.md"), "utf8")).resolves.toBe("keep");
    expect(result.backups).toEqual([nodePath.join(backup, "nested", "file.md")]);
  });

  it("rejects a redirected backup directory before changing originals", async () => {
    const directory = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const original = path.join(directory, "file.md");
    await writeFile(original, "keep");
    await symlink(outside, path.join(directory, ".toolkit-backups"), process.platform === "win32" ? "junction" : "dir");
    const inspected = await inspectContextPlan(directory, [{ relativePath: "file.md", content: "replacement" }]);
    await expect(applyContextPlan(inspected, { decisions: { "file.md": "replace" }, backupRoot: path.join(directory, ".toolkit-backups", "run") })).rejects.toThrow(/symbolic link|unsafe/);
    await expect(readFile(original, "utf8")).resolves.toBe("keep");
    await expect(readFile(path.join(outside, "run", "file.md"), "utf8")).rejects.toThrow();
  });

  it("fails unresolved entries before writing anything", async () => {
    const directory = await temporaryDirectory();
    await writeFile(path.join(directory, "conflict.md"), "keep");
    const inspected = await inspectContextPlan(directory, [{ relativePath: "new.md", content: "new" }, { relativePath: "conflict.md", content: "new" }]);
    await expect(applyContextPlan(inspected)).rejects.toThrow("requires a decision");
    await expect(readFile(path.join(directory, "conflict.md"), "utf8")).resolves.toBe("keep");
    await expect(readFile(path.join(directory, "new.md"), "utf8")).rejects.toThrow();
  });

  it("aborts when a file changes after inspection", async () => {
    const directory = await temporaryDirectory();
    const target = path.join(directory, "conflict.md");
    await writeFile(target, "first");
    const inspected = await inspectContextPlan(directory, [{ relativePath: "conflict.md", content: "replacement" }]);
    await writeFile(target, "changed later");

    await expect(applyContextPlan(inspected, { decisions: { "conflict.md": "replace" } })).rejects.toThrow("changed during reconciliation");
    await expect(readFile(target, "utf8")).resolves.toBe("changed later");
  });

  it("rejects paths that escape through a symlink", async () => {
    const directory = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await symlink(outside, path.join(directory, "linked"), process.platform === "win32" ? "junction" : "dir");
    await expect(inspectContextPlan(directory, [{ relativePath: "linked/file.md", content: "new" }])).rejects.toThrow("unsafe");
  });

  it("rejects an existing target-file symlink without changing its referent", async () => {
    const directory = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const referent = path.join(outside, "file.md");
    await writeFile(referent, "outside");
    await symlink(referent, path.join(directory, "file.md"), "file");
    await expect(inspectContextPlan(directory, [{ relativePath: "file.md", content: "new" }])).rejects.toThrow("not a regular file");
    await expect(readFile(referent, "utf8")).resolves.toBe("outside");
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "toolkit-reconcile-"));
  temporaryDirectories.push(directory);
  return directory;
}
