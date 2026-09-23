import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import * as path from "pathe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const promptMocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  intro: vi.fn(),
  isCancel: vi.fn(() => false),
  outro: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
  log: { error: vi.fn(), info: vi.fn(), step: vi.fn(), success: vi.fn(), warn: vi.fn(), warning: vi.fn() },
}));

vi.mock("@clack/prompts", () => promptMocks);

import { runContextWorkflow, type ContextCommandArgs } from "../../src/commands/context.js";
import { setupAiContext } from "../../src/context/setup.js";

const temporaryDirectories: string[] = [];
const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

beforeEach(() => {
  vi.clearAllMocks();
  promptMocks.isCancel.mockReturnValue(false);
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("context command workflow", () => {
  it("aborts before writing when a non-interactive conflict has no policy", async () => {
    const directory = await temporaryDirectory();
    await writeFile(path.join(directory, "AGENTS.md"), "keep");

    await expect(runContextWorkflow(args(directory), "init")).rejects.toThrow("No files changed");

    await expect(readFile(path.join(directory, "AGENTS.md"), "utf8")).resolves.toBe("keep");
    await expect(access(path.join(directory, ".ai"))).rejects.toThrow();
  });

  it("keeps a conflicting entry point while creating missing files", async () => {
    const directory = await temporaryDirectory();
    await writeFile(path.join(directory, "AGENTS.md"), "keep");

    await runContextWorkflow({ ...args(directory), "on-conflict": "skip" }, "init");

    await expect(readFile(path.join(directory, "AGENTS.md"), "utf8")).resolves.toBe("keep");
    await expect(access(path.join(directory, ".ai", "README.md"))).resolves.toBeUndefined();
    expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining("Confirm that it routes agents"));
  });

  it("requires and creates backups for non-interactive replacements", async () => {
    const directory = await temporaryDirectory();
    await setupAiContext(directory, contextOptions("Original purpose"));
    const workspace = path.join(directory, ".ai", "workspace.md");
    const original = await readFile(workspace, "utf8");
    const replacementArgs = { ...args(directory), purpose: "Changed purpose", "on-conflict": "replace" };

    await expect(runContextWorkflow(replacementArgs, "sync")).rejects.toThrow("requires --backup");
    await expect(readFile(workspace, "utf8")).resolves.toBe(original);

    await runContextWorkflow({ ...replacementArgs, backup: true }, "sync");
    const backupRun = (await readdir(path.join(directory, ".toolkit-backups")))[0]!;
    await expect(readFile(path.join(directory, ".toolkit-backups", backupRun, ".ai", "workspace.md"), "utf8")).resolves.toBe(original);
    await expect(readFile(workspace, "utf8")).resolves.toContain("Changed purpose");
  });

  it("offers interactive add-missing behavior and preserves conflicts", async () => {
    const directory = await temporaryDirectory();
    await writeFile(path.join(directory, "AGENTS.md"), "keep");
    promptMocks.select.mockResolvedValueOnce("missing");
    promptMocks.confirm.mockResolvedValueOnce(true);

    await runContextWorkflow({ ...args(directory), "non-interactive": false }, "init");

    expect(promptMocks.select).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.arrayContaining([expect.objectContaining({ value: "missing", label: "Add missing files only" })]),
    }));
    await expect(readFile(path.join(directory, "AGENTS.md"), "utf8")).resolves.toBe("keep");
    await expect(access(path.join(directory, ".ai", "README.md"))).resolves.toBeUndefined();
    expect(promptMocks.outro).toHaveBeenCalledWith(expect.stringContaining("Context complete"));
  });

  it("infers existing generated context values for sync and diff workflows", async () => {
    const directory = await temporaryDirectory();
    await setupAiContext(directory, contextOptions("Existing purpose"));

    await expect(runContextWorkflow({ destination: directory, "non-interactive": true, "dry-run": true }, "sync")).resolves.toBeUndefined();
    expect(consoleLog).toHaveBeenCalledWith("Dry run complete. No files changed.");
  });
});

function args(destination: string): ContextCommandArgs {
  return {
    destination,
    name: "Workspace",
    purpose: "Original purpose",
    "context-path": ".ai",
    project: "root:.",
    "non-interactive": true,
  };
}

function contextOptions(purpose: string) {
  return {
    workspaceName: "Workspace",
    workspacePurpose: purpose,
    contextPath: ".ai",
    projects: [{ id: "root", path: ".", scope: "Primary project in this workspace." }],
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "toolkit-context-command-"));
  temporaryDirectories.push(directory);
  return directory;
}
