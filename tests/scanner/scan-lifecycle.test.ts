import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import * as path from "pathe";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execa } from "execa";
import { scanWorkspace } from "../../src/scanner/scan.js";

vi.mock("execa", () => ({ execa: vi.fn() }));
const directories: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("scanner Git process lifecycle", () => {
  it.each(["unsafe URL", "Git failure"])("waits for all remote reads before rejecting a %s", async (failure) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "toolkit-scan-lifecycle-"));
    directories.push(root);
    await mkdir(path.join(root, ".git"));
    let finishOrigin!: () => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const origin = new Promise<{ stdout: string }>((resolve) => {
      finishOrigin = () => resolve({ stdout: "https://example.test/repo.git" });
    });
    // The mock only needs the stdout part of Execa's process result.
    vi.mocked(execa).mockImplementation(((_command: string, args: string[]) => {
      if (args.length === 3) return Promise.resolve({ stdout: "origin\nbackup\n" });
      if (args.at(-1) === "origin") {
        signalStarted();
        return origin;
      }
      return failure === "Git failure"
        ? Promise.reject(new Error("Git fixture failed"))
        : Promise.resolve({ stdout: "https://user:FAKE_TOKEN@example.test/repo.git" });
    }) as unknown as typeof execa);

    let settled = false;
    const result = scanWorkspace(root).then(
      () => { settled = true; return undefined; },
      (error: unknown) => { settled = true; return error; },
    );
    await started;
    try {
      await setImmediate();
      expect(settled).toBe(false);
    } finally {
      finishOrigin();
    }
    const error = await result;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(failure === "Git failure" ? "Unable to discover Git remotes" : "credential");
    expect((error as Error).message).not.toContain("FAKE_TOKEN");
  });
});
