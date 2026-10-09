import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

const failure = vi.hoisted(() => ({ renames: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (failure.renames > 0) {
        failure.renames -= 1;
        throw Object.assign(new Error("simulated rename failure"), { code: "EIO" });
      }
      return actual.rename(...args);
    },
  };
});

const { ModelProfileError, createModelProfile, listModelProfiles, setActiveModelProfile } = await import("../../../src/models/index.js");
const { projectLocation, useTemporaryRoots } = await import("./helpers.js");

const roots = useTemporaryRoots();

describe("interrupted writes", () => {
  it("keeps the previous committed content and leaves no temporary file when the rename fails", async () => {
    const location = await projectLocation(roots);
    await createModelProfile(location, "first", { agents: { lead: { id: "openai/gpt-6-luna" } } });
    const committed = await readFile(location.profilesPath, "utf8");

    failure.renames = 1;
    const error = await createModelProfile(location, "second", { agents: {} }).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(ModelProfileError);
    expect((error as InstanceType<typeof ModelProfileError>).kind).toBe("filesystem");

    expect(await readFile(location.profilesPath, "utf8")).toBe(committed);
    expect(await readdir(location.directory)).toEqual(["profiles.json"]);
    expect(await listModelProfiles(location)).toEqual(["first"]);

    // A later attempt succeeds.
    expect(await createModelProfile(location, "second", { agents: {} })).toMatchObject({ status: "changed" });
    expect(await listModelProfiles(location)).toEqual(["first", "second"]);
  });

  it("does not create a first file or leave a temporary file when the very first write fails", async () => {
    const location = await projectLocation(roots);
    failure.renames = 1;
    await expect(createModelProfile(location, "first")).rejects.toBeInstanceOf(ModelProfileError);
    expect(await readdir(location.directory)).toEqual([]);
    expect(await listModelProfiles(location)).toEqual([]);
  });

  it("applies the same protection to local state", async () => {
    const location = await projectLocation(roots);
    await createModelProfile(location, "first", { agents: {} });
    await setActiveModelProfile(location, "first");
    const committed = await readFile(location.statePath, "utf8");
    await createModelProfile(location, "second", { agents: {} });

    failure.renames = 1;
    await expect(setActiveModelProfile(location, "second")).rejects.toBeInstanceOf(ModelProfileError);
    expect(await readFile(location.statePath, "utf8")).toBe(committed);
    expect((await readdir(location.directory)).sort()).toEqual(["local.json", "profiles.json"]);
  });
});
