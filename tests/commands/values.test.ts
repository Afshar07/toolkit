import { describe, expect, it, vi } from "vitest";
import { parseContextProject, resolveContextInitValues, resolveScanValues, resolveSetupValues } from "../../src/commands/values.js";

describe("resolveScanValues", () => {
  it("bypasses only questions with supplied CLI values", async () => {
    const workspace = vi.fn(async () => "prompted-workspace");
    const name = vi.fn(async () => "prompted-name");
    const output = vi.fn(async () => "prompted-output");

    await expect(resolveScanValues({ workspace: " supplied-workspace ", output: " supplied-output " }, { workspace, name, output }))
      .resolves.toEqual({ workspace: "supplied-workspace", name: "prompted-name", output: "supplied-output" });
    expect(workspace).not.toHaveBeenCalled();
    expect(name).toHaveBeenCalledWith("supplied-workspace");
    expect(output).not.toHaveBeenCalled();
  });

  it("uses prompts when no CLI values are supplied", async () => {
    await expect(resolveScanValues({}, {
      workspace: async () => "workspace",
      name: async (workspace) => `${workspace}-name`,
      output: async (name) => `${name}.json`,
    })).resolves.toEqual({ workspace: "workspace", name: "workspace-name", output: "workspace-name.json" });
  });
});

describe("resolveSetupValues", () => {
  it("uses a supplied manifest and destination without prompting", async () => {
    const workspace = vi.fn(async () => "prompted-manifest");
    const destination = vi.fn(async () => "prompted-destination");

    const parseWorkspace = vi.fn(async (value: string) => ({ path: value }));

    await expect(resolveSetupValues({ workspace: " recipe.json ", destination: " target " }, { workspace, parseWorkspace, destination }))
      .resolves.toEqual({ workspace: { path: "recipe.json" }, destination: "target" });
    expect(workspace).not.toHaveBeenCalled();
    expect(parseWorkspace).toHaveBeenCalledWith("recipe.json");
    expect(destination).not.toHaveBeenCalled();
  });

  it("prompts for omitted setup values", async () => {
    await expect(resolveSetupValues({}, {
      workspace: async () => ({ name: "work" }),
      parseWorkspace: async () => ({ name: "unused" }),
      destination: async (workspace) => workspace.name,
    })).resolves.toEqual({ workspace: { name: "work" }, destination: "work" });
  });
});

describe("context initialization values", () => {
  it("uses supplied non-interactive values without prompting", async () => {
    const question = vi.fn(async () => "unused");

    await expect(resolveContextInitValues({
      destination: "workspace",
      name: "Workspace",
      purpose: "Useful tools",
      contextPath: "context/.ai",
      project: ["web:apps/web", "api:apps/api"],
      nonInteractive: true,
    }, { destination: question, name: question, purpose: question, contextPath: question, project: question })).resolves.toEqual({
      destination: "workspace",
      name: "Workspace",
      purpose: "Useful tools",
      contextPath: "context/.ai",
      projects: [{ id: "web", path: "apps/web" }, { id: "api", path: "apps/api" }],
    });
    expect(question).not.toHaveBeenCalled();
  });

  it("requires every initialization value in non-interactive mode", async () => {
    await expect(resolveContextInitValues({ nonInteractive: true }, {
      destination: async () => "workspace",
      name: async () => "Workspace",
      purpose: async () => "Purpose",
      contextPath: async () => ".ai",
      project: async () => "root:.",
    })).rejects.toThrow("--destination");
  });

  it("parses project values and rejects malformed values", () => {
    expect(parseContextProject(" web : apps/web ")).toEqual({ id: "web", path: "apps/web" });
    expect(() => parseContextProject("web")).toThrow("id:path");
  });
});
