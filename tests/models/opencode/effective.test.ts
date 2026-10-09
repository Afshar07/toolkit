import { describe, it, expect } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "pathe";
import { useTemporaryRoots } from "../profiles/helpers.js";
import { inspectEffectiveOpenCodeModels } from "../../../src/models/opencode/effective.js";
import { editOpenCodeAgentModels } from "../../../src/index.js";

const roots = useTemporaryRoots();
describe("static effective model inspection", () => {
  it("uses project config over global Markdown and project Markdown over config", async () => {
    const global = { scope: "global" as const, root: await roots.create() };
    const project = await roots.create();
    await mkdir(path.join(global.root, "agents"));
    await writeFile(path.join(global.root, "agents/lead.md"), "---\nmodel: anthropic/global\n---\nbody");
    await writeFile(path.join(global.root, "opencode.jsonc"), editOpenCodeAgentModels("{}", { lead: "openai/global" }));
    await writeFile(path.join(project, "opencode.jsonc"), editOpenCodeAgentModels("{}", { lead: "openai/project" }));
    let result = await inspectEffectiveOpenCodeModels({ global, project, agents: ["lead"] });
    expect(result.agents[0]).toMatchObject({ effective: "openai/project", source: "project-config" });
    await mkdir(path.join(project, ".opencode/agents"), { recursive: true });
    await writeFile(path.join(project, ".opencode/agents/lead.md"), "---\nmodel: anthropic/project\n---\nbody");
    result = await inspectEffectiveOpenCodeModels({ global, project, agents: ["lead"] });
    expect(result.agents[0]).toMatchObject({ effective: "anthropic/project", source: "project-markdown" });
  });
  it("reports default as undetermined rather than inventing a model", async () => {
    const result = await inspectEffectiveOpenCodeModels({ project: await roots.create(), agents: ["lead"] });
    expect(result.agents[0]).toMatchObject({ effective: undefined, source: "default" });
    expect(result.limitations.length).toBeGreaterThan(0);
  });
});
