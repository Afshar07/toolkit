import { access, readFile, writeFile } from "node:fs/promises";
import * as filesystem from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import * as path from "pathe";
import { describe, expect, it, vi } from "vitest";
import { publishAgent } from "../../src/agents/publish.js";
import * as gitHelpers from "./git.js";
import { agentPath, createPublicationFixtures, publishOptions, remoteHead } from "./publication.js";

const seedRoots = vi.hoisted(() => [] as string[]);

/** Observe real temporary roots without adding seed paths to the helper's API. */
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdtemp: async (prefix: string) => {
      const root = await actual.mkdtemp(prefix);
      if (path.basename(prefix) === "toolkit-publish-seed-") seedRoots.push(root);
      return root;
    },
  };
});

describe.sequential("publication fixture seed lifecycle", { timeout: 30_000 }, () => {
  it("copies independent repositories and retains only the immutable seed between tests", async () => {
    const fixtures = createPublicationFixtures();
    const start = seedRoots.length;
    try {
      const [first, second] = await Promise.all([fixtures.fixture(), fixtures.fixture()]);
      expect(seedRoots.length).toBe(start + 1);
      const seedRoot = seedRoots[start]!;
      const origin = async (author: string) => (await gitHelpers.gitCommand("remote", ["-C", author, "remote", "get-url", "origin"])).stdout.trim();
      expect(await origin(first.author)).toBe(first.remote);
      expect(await origin(second.author)).toBe(second.remote);
      expect(first.remote).not.toBe(second.remote);

      await writeFile(agentPath(first.project, "coder"), "first publication\n");
      expect((await publishAgent("coder", publishOptions(first))).outcome).toBe("published");
      expect(await remoteHead(first.remote)).not.toBe(first.initialHead);
      expect(await remoteHead(second.remote)).toBe(second.initialHead);
      await expect(readFile(path.join(second.author, "agents/coder.md"), "utf8")).resolves.toBe("coder v1\n");
      await writeFile(agentPath(second.project, "coder"), "second publication\n");
      expect((await publishAgent("coder", publishOptions(second))).outcome).toBe("published");

      await fixtures.cleanup();
      await expect(access(first.root)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(second.root)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(seedRoot)).resolves.toBeUndefined();
      const fresh = await fixtures.fixture();
      expect(seedRoots.length).toBe(start + 1);
      expect(await remoteHead(fresh.remote)).toBe(first.initialHead);
      await expect(readFile(agentPath(fresh.project, "coder"), "utf8")).resolves.toBe("coder v1\n");
      expect(await remoteHead(path.join(seedRoot, "remote.git"))).toBe(first.initialHead);
      await expect(readFile(path.join(seedRoot, "author/agents/coder.md"), "utf8")).resolves.toBe("coder v1\n");

      await fixtures.dispose();
      await expect(access(seedRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(agentPath(fresh.project, "coder"), "after seed disposal\n");
      expect((await publishAgent("coder", publishOptions(fresh))).outcome).toBe("published");
      await gitHelpers.git(fresh.author, ["pull", "--ff-only", "origin", "main"]);
      await gitHelpers.publishAgents(fresh.author, { lead: "lead v1\n", coder: "author still independent\n" }, "independent author");
    } finally {
      await fixtures.cleanup();
      await fixtures.dispose();
    }
  });

  it("waits for a pending sibling copy before rejecting setup and cleaning the fixture", async () => {
    const fixtures = createPublicationFixtures();
    const nativeCopy = filesystem.cp;
    const failure = new Error("remote copy failed");
    let releaseCopy!: () => void;
    let copyStarted!: () => void;
    let fixtureRoot!: string;
    let settled = false;
    const pending = new Promise<void>((resolve) => { releaseCopy = resolve; });
    const started = new Promise<void>((resolve) => { copyStarted = resolve; });
    const spy = vi.spyOn(filesystem, "cp").mockImplementation(async (source, destination, options) => {
      if (path.basename(String(destination)) === "remote.git") throw failure;
      fixtureRoot = path.dirname(String(destination));
      copyStarted();
      await pending;
      await nativeCopy(source, destination, options);
    });
    const setup = fixtures.fixture().then(
      () => { settled = true; return undefined; },
      (error: unknown) => { settled = true; return error; },
    );
    try {
      await started;
      await setImmediate();
      expect(settled).toBe(false);
      await expect(access(fixtureRoot)).resolves.toBeUndefined();
      releaseCopy();
      await expect(setup).resolves.toBe(failure);
      await expect(access(path.join(fixtureRoot, "author/.git"))).resolves.toBeUndefined();
      await fixtures.cleanup();
      await expect(access(fixtureRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      releaseCopy();
      await setup;
      try {
        await fixtures.cleanup();
        await fixtures.dispose();
      } finally {
        spy.mockRestore();
      }
    }
  });

  it("waits for a failing active seed build before disposal and cleans failed fixture setup", async () => {
    const fixtures = createPublicationFixtures();
    const start = seedRoots.length;
    let rejectBuild!: (error: Error) => void;
    let buildStarted!: () => void;
    const started = new Promise<void>((resolve) => { buildStarted = resolve; });
    const build = new Promise<never>((_, reject) => { rejectBuild = reject; });
    const spy = vi.spyOn(gitHelpers, "createGitRegistryFixture").mockImplementation(async () => {
      buildStarted();
      return build;
    });
    const setup = fixtures.fixture();
    const rejected = expect(setup).rejects.toThrow("seed setup failed");
    try {
      await started;
      const seedRoot = seedRoots[start]!;
      const disposal = fixtures.dispose();
      await expect(access(seedRoot)).resolves.toBeUndefined();
      rejectBuild(new Error("seed setup failed"));
      await rejected;
      await disposal;
      await expect(access(seedRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      rejectBuild(new Error("seed setup failed"));
      await rejected;
      await fixtures.cleanup();
      await fixtures.dispose();
      spy.mockRestore();
    }
  });
});
