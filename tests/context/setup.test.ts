import { access, mkdir, mkdtemp, rm, symlink, writeFile, readFile, readdir } from "node:fs/promises";
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
      contextPath: ".ai",
      projects: [{ id: "toolkit", path: ".", scope: "The command-line application." }],
    };

    await expect(setupAiContext(directory, options)).resolves.toHaveLength(8);
    await expect(access(path.join(directory, "AGENTS.md"))).resolves.toBeUndefined();
    await expect(access(path.join(directory, ".ai", "projects", "toolkit.md"))).resolves.toBeUndefined();
    await expect(access(path.join(directory, ".ai", "policies", "delegation.md"))).resolves.toBeUndefined();
    await expect(access(path.join(directory, ".ai", "ongoing", "README.md"))).resolves.toBeUndefined();
    await expect(readdir(path.join(directory, ".ai", "ongoing"))).resolves.toEqual(["README.md"]);
    await expect(readdir(path.join(directory, ".ai"))).resolves.not.toContain("history");
    await expect(readFile(path.join(directory, "AGENTS.md"), "utf8")).resolves.toMatch(/^<!-- toolkit:sha256=[a-f0-9]{64} -->\n/);
    await expect(readFile(path.join(directory, "AGENTS.md"), "utf8")).resolves.toContain("Markdown context is authoritative");
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

    await setupAiContext(directory, { ...defaultAiContextOptions(directory), projects: [{ id: "../Outside Project", path: ".", scope: "Scope" }] });

    await expect(access(path.join(directory, ".ai", "projects", "outside-project.md"))).resolves.toBeUndefined();
    await expect(access(path.join(directory, "Outside Project.md"))).rejects.toThrow();
  });

  it("creates shared and project-local context for multiple projects", async () => {
    const directory = await makeTemporaryDirectory();
    const options = {
      workspaceName: "Workspace",
      workspacePurpose: "Build useful tools.",
      contextPath: "shared/.ai",
      projects: [
        { id: "one", path: "projects/one", scope: "One" },
        { id: "two", path: "projects/two", scope: "Two" },
      ],
    };

    await expect(setupAiContext(directory, options)).resolves.toEqual([
      "AGENTS.md",
      "shared/.ai/README.md",
      "shared/.ai/workspace.md",
      "shared/.ai/engineering-conventions.md",
      "shared/.ai/policies/delegation.md",
      "shared/.ai/policies/context-maintenance.md",
      "shared/.ai/projects/one.md",
      "projects/one/.ai/README.md",
      "projects/one/.ai/ongoing/README.md",
      "shared/.ai/projects/two.md",
      "projects/two/.ai/README.md",
      "projects/two/.ai/ongoing/README.md",
    ]);
  });

  it("preflights project-local conflicts without partial writes", async () => {
    const directory = await makeTemporaryDirectory();
    await mkdir(path.join(directory, "projects", "one", ".ai"), { recursive: true });
    await writeFile(path.join(directory, "projects", "one", ".ai", "README.md"), "keep me");

    await expect(setupAiContext(directory, {
      ...defaultAiContextOptions(directory),
      projects: [{ id: "one", path: "projects/one", scope: "One" }],
    })).rejects.toThrow("projects/one/.ai/README.md already exists");
    await expect(access(path.join(directory, "AGENTS.md"))).rejects.toThrow();
    await expect(access(path.join(directory, ".ai"))).rejects.toThrow();
    await expect(readFile(path.join(directory, "projects", "one", ".ai", "README.md"), "utf8")).resolves.toBe("keep me");
  });

  it("rejects a project path whose parent is a symlink outside the destination", async () => {
    const directory = await makeTemporaryDirectory();
    const outside = await makeTemporaryDirectory("toolkit-outside-");
    await mkdir(path.join(directory, "projects"), { recursive: true });
    await symlink(outside, path.join(directory, "projects", "one"), process.platform === "win32" ? "junction" : "dir");

    await expect(setupAiContext(directory, {
      ...defaultAiContextOptions(directory),
      projects: [{ id: "one", path: "projects/one", scope: "One" }],
    })).rejects.toBeInstanceOf(AiContextSetupError);
    await expect(access(path.join(directory, "AGENTS.md"))).rejects.toThrow();
    await expect(readdir(outside)).resolves.toEqual([]);
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
    await expect(readFile(path.join(directory, "lead.md"), "utf8")).resolves.toContain("active workspace AGENTS.md");
    await expect(readFile(path.join(directory, "lead.md"), "utf8")).resolves.toContain("workspace lead engineer");
    await expect(readFile(path.join(directory, "researcher.md"), "utf8")).resolves.toContain("read-only code researcher");
    await expect(readFile(path.join(directory, "researcher.md"), "utf8")).resolves.toContain("active workspace AGENTS.md");
    await expect(readFile(path.join(directory, "external-researcher.md"), "utf8")).resolves.toContain("webfetch: allow");
    await expect(readFile(path.join(directory, "external-researcher.md"), "utf8")).resolves.toContain("active workspace AGENTS.md");
    await expect(readFile(path.join(directory, "coder.md"), "utf8")).resolves.toContain("edit: allow");
    await expect(readFile(path.join(directory, "coder.md"), "utf8")).resolves.toContain("active workspace AGENTS.md");
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
