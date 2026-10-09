import { describe, it, expect } from "vitest";
import { readFile, writeFile, mkdir, symlink } from "node:fs/promises";
import * as path from "pathe";
import { useTemporaryRoots } from "../profiles/helpers.js";
import { readSafeText, writeSafeText } from "../../../src/models/opencode/safe-write.js";

const roots = useTemporaryRoots();
describe("safe model configuration writes", () => {
  it("backs up exact prior bytes and rejects a stale expected value", async () => {
    const target = { scope: "project" as const, root: await roots.create() };
    const file = path.join(target.root, "opencode.jsonc");
    await writeFile(file, "old");
    const backup = await writeSafeText(target, file, "old", "new");
    expect(await readFile(backup!, "utf8")).toBe("old");
    await expect(writeSafeText(target, file, "old", "wrong")).rejects.toThrow("changed since planning");
    expect(await readFile(file, "utf8")).toBe("new");
  });
  it("rejects a junction ancestor without touching its target", async () => {
    const target = { scope: "project" as const, root: await roots.create() };
    const outside = await roots.create();
    await mkdir(path.join(target.root, ".toolkit"));
    await symlink(outside, path.join(target.root, ".toolkit/models"), process.platform === "win32" ? "junction" : "dir");
    await expect(readSafeText(target, path.join(target.root, ".toolkit/models/applied.json"))).rejects.toThrow("unsafe");
  });
});
