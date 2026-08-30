import { access, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import * as path from "pathe";
import { afterEach, describe, expect, it } from "vitest";
import { AiContextSetupError, defaultAiContextOptions, setupAiContext } from "../../src/context/setup.js";
import { OpenCodeAgentSetupError, setupOpenCodeAgents } from "../../src/context/agents.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("setupAiContext", () => {
  it("creates a resolved, internally routed AI context system", async () => {
    const directory = await makeTemporaryDirectory("My Workspace");
    const options = {
      workspaceName: "Workspace",
      workspacePurpose: "Build useful tools.",
      projectId: "toolkit",
      projectScope: "The command-line application.",
    };

    await expect(setupAiContext(directory, options)).resolves.toHaveLength(10);
    await expect(access(path.join(directory, "AGENTS.md"))).resolves.toBeUndefined();
    await expect(access(path.join(directory, ".ai", "domains"))).resolves.toBeUndefined();
    const context = JSON.parse(await readFile(path.join(directory, ".ai", "context.json"), "utf8"));

    expect(context.workspace).toBe("Workspace");
    expect(context.projects[0]).toMatchObject({ id: "toolkit", match: ["."], read: [".ai/projects/toolkit.md"] });
    expect(JSON.stringify(context)).not.toContain("{{");
    await expect(access(path.join(directory, ".ai", "projects", "toolkit.md"))).resolves.toBeUndefined();
    await expect(access(path.join(directory, ".ai", "policies", "delegation.md"))).resolves.toBeUndefined();
    await expect(readFile(path.join(directory, ".ai", "ongoing", "current.md"), "utf8")).resolves.toBe("# Current task\n\nNo ongoing task.\n");
    await expect(readFile(path.join(directory, ".ai", "ongoing", "TASK_TEMPLATE.md"), "utf8")).resolves.toContain("## Goal and acceptance criteria");
    await expect(readFile(path.join(directory, ".ai", "ongoing", "README.md"), "utf8")).resolves.toContain("Copy `TASK_TEMPLATE.md`");
    await expect(readFile(path.join(directory, "AGENTS.md"), "utf8")).resolves.toContain(".ai/ongoing/current.md");
    await expect(readFile(path.join(directory, "AGENTS.md"), "utf8")).resolves.toContain("when the user explicitly asks");
  });

  it("does not overwrite an existing AI context entry point", async () => {
    const directory = await makeTemporaryDirectory();
    const agentsPath = path.join(directory, "AGENTS.md");
    await writeFile(agentsPath, "existing instructions");

    await expect(setupAiContext(directory, defaultAiContextOptions(directory))).rejects.toBeInstanceOf(AiContextSetupError);
    await expect(readFile(agentsPath, "utf8")).resolves.toBe("existing instructions");
  });

  it("does not overwrite an existing context directory", async () => {
    const directory = await makeTemporaryDirectory();
    await writeFile(path.join(directory, ".ai"), "existing context");

    await expect(setupAiContext(directory, defaultAiContextOptions(directory))).rejects.toThrow(".ai already exists");
    await expect(readFile(path.join(directory, ".ai"), "utf8")).resolves.toBe("existing context");
  });

  it("derives safe defaults from the destination directory name", () => {
    expect(defaultAiContextOptions("C:/work/My Project!")).toMatchObject({
      workspaceName: "My Project!",
      projectId: "my-project",
    });
  });

  it("normalizes a project ID before using it as a context file path", async () => {
    const directory = await makeTemporaryDirectory();

    await setupAiContext(directory, { ...defaultAiContextOptions(directory), projectId: "../Outside Project" });

    await expect(access(path.join(directory, ".ai", "projects", "outside-project.md"))).resolves.toBeUndefined();
    await expect(access(path.join(directory, "Outside Project.md"))).rejects.toThrow();
  });
});

describe("setupOpenCodeAgents", () => {
  it("creates the four personal OpenCode agent files", async () => {
    const directory = await makeTemporaryDirectory();

    await expect(setupOpenCodeAgents(directory)).resolves.toEqual([
      "lead.md",
      "researcher.md",
      "external-researcher.md",
      "coder.md",
    ]);
    await expect(readFile(path.join(directory, "lead.md"), "utf8")).resolves.toContain("mode: primary");
    await expect(readFile(path.join(directory, "researcher.md"), "utf8")).resolves.toContain("read-only code researcher");
    await expect(readFile(path.join(directory, "external-researcher.md"), "utf8")).resolves.toContain("webfetch: allow");
    await expect(readFile(path.join(directory, "coder.md"), "utf8")).resolves.toContain("edit: allow");
  });

  it("does not overwrite any existing personal agent", async () => {
    const directory = await makeTemporaryDirectory();
    const leadPath = path.join(directory, "lead.md");
    await writeFile(leadPath, "existing lead");

    await expect(setupOpenCodeAgents(directory)).rejects.toBeInstanceOf(OpenCodeAgentSetupError);
    await expect(readFile(leadPath, "utf8")).resolves.toBe("existing lead");
    await expect(access(path.join(directory, "coder.md"))).rejects.toThrow();
  });
});

async function makeTemporaryDirectory(prefix = "toolkit-"): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
