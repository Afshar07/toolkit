import { readFile, readdir, writeFile } from "node:fs/promises";
import * as path from "pathe";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTemporaryRoots } from "../profiles/helpers.js";
import { writeSafeText } from "../../../src/models/opencode/safe-write.js";

const fault = vi.hoisted(() => ({ extension: "" }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
    if (fault.extension && String(args[0]).endsWith(fault.extension)) throw new Error("injected backup/temporary failure");
    return actual.writeFile(...args);
  } };
});
const roots = useTemporaryRoots();
afterEach(() => { fault.extension = ""; });
describe("backup creation and promotion failures", () => {
  it.each([".bak", ".tmp"])("preserves the original and removes temporary files after %s failure", async (extension) => {
    const target = { scope: "project" as const, root: await roots.create() };
    const file = path.join(target.root, "opencode.jsonc");
    await writeFile(file, "original");
    fault.extension = extension;
    const error = await writeSafeText(target, file, "original", "replacement").catch((error: Error & { backupPath?: string }) => error);
    expect(error).toBeInstanceOf(Error);
    expect(await readFile(file, "utf8")).toBe("original");
    expect((await readdir(target.root)).some((name) => name.endsWith(".tmp"))).toBe(false);
    if (extension === ".tmp") {
      const backup = (error as Error & { backupPath: string }).backupPath;
      expect(await readFile(backup, "utf8")).toBe("original");
    } else expect(await readdir(target.root)).toEqual(["opencode.jsonc"]);
  });
});
