import { describe, expect, it } from "vitest";
import { createAiContextPlan } from "../../src/context/plan.js";

describe("createAiContextPlan", () => {
  it("renders active routing, held-project boundaries, and indexed ongoing state", () => {
    const files = createAiContextPlan({
      workspaceName: "Workspace",
      workspacePurpose: "Purpose",
      projects: [
        { id: "web", path: "apps/web", scope: "Web application" },
        { id: "legacy", path: "apps/legacy", scope: "Legacy application", status: "held" },
      ],
    });
    const paths = files.map((file) => file.relativePath);
    expect(paths.every((value) => !value.endsWith(".json"))).toBe(true);
    expect(paths).toContain("apps/web/.ai/ongoing/README.md");
    expect(paths.some((value) => value.includes("history"))).toBe(false);
    expect(files.find((file) => file.relativePath === ".ai/README.md")?.content).toContain("| web |");
    expect(files.find((file) => file.relativePath === ".ai/README.md")?.content).toContain("legacy");
    expect(paths).toContain("apps/web/.ai/README.md");
    expect(paths).not.toContain("apps/legacy/.ai/README.md");
    expect(paths).not.toContain("apps/legacy/.ai/ongoing/README.md");

    const agents = files.find((file) => file.relativePath === "AGENTS.md")?.content ?? "";
    expect(agents).toContain("| web | `apps/web` | `apps/web/.ai/README.md` | `.ai/projects/web.md` |");
    expect(agents).not.toContain("| legacy | `apps/legacy`");
    const ordered = [
      "1. Read `.ai/workspace.md`",
      "2. Match the requested path",
      "3. Read **only** the selected project's local index",
      "4. Read the selected project's shared guidance",
      "5. For coding, testing, configuration, documentation, or verification tasks",
      "6. Read only task-applicable policies",
      "7. Execute the selected route in its exact order, including any named domain contract",
      "8. Inspect an exact user-named source file",
    ];
    let previous = -1;
    for (const step of ordered) {
      const index = agents.indexOf(step);
      expect(index).toBeGreaterThan(previous);
      previous = index;
    }
    expect(agents).toContain("If no project matches, continue only for workspace-level work");
    expect(agents).toContain("If multiple projects match and the choice changes the work, ask for clarification");
    expect(agents).toContain("Do not browse all of `.ai` or all local indexes");
    expect(agents).toContain("## First time in this workspace");
    expect(agents).toContain("This workspace uses routed Markdown context");
    expect(agents).not.toContain("engineering conventions are always");
    expect(agents.endsWith("\n")).toBe(true);
  });

  it("uses the shared README as the root project's single local index", () => {
    const files = createAiContextPlan({
      workspaceName: "Workspace",
      workspacePurpose: "Purpose",
      projects: [{ id: "root", path: ".", scope: "Root project" }],
    });
    const paths = files.map((file) => file.relativePath);
    expect(paths.filter((value) => value === ".ai/README.md")).toHaveLength(1);
    expect(paths).toContain(".ai/ongoing/README.md");
    const readme = files.find((file) => file.relativePath === ".ai/README.md")?.content ?? "";
    expect(readme).toContain("# .ai/ - Project Context for AI Agents");
    expect(readme).toContain("At workspace-router step 3");
    expect(readme).toContain("## Files");
    expect(readme).toContain("| File | Read when you're... |");
    expect(readme).toContain("## Rules");
    expect(readme).toContain("## Task routes");
    expect(readme).toContain("`ongoing/README.md`");
    expect(readme).toContain("Route format:");
    expect(readme).toContain("When no route applies, inspect the requested source file directly.");
  });

  it("scaffolds explicit task-routing sections in non-root project indexes", () => {
    const files = createAiContextPlan({
      workspaceName: "Workspace",
      workspacePurpose: "Purpose",
      projects: [{ id: "web", path: "apps/web", scope: "Web application" }],
    });
    const readme = files.find((file) => file.relativePath === "apps/web/.ai/README.md")?.content ?? "";
    expect(readme).toContain("## Files");
    expect(readme).toContain("| File | Read when you're... |");
    expect(readme).toContain("## Rules");
    expect(readme).toContain("## Task routes");
    expect(readme).toContain("`ongoing/README.md`");
    expect(readme).toContain("Route format:");
    expect(readme).toContain("When no route applies, inspect the requested source file directly.");
    expect(readme).toContain("## Verification");
    expect(files.find((file) => file.relativePath === "apps/web/.ai/ongoing/README.md")?.content).toContain("Read only the task document relevant");
  });

  it("uses a custom shared context path consistently for a root project", () => {
    const files = createAiContextPlan({
      workspaceName: "Workspace",
      workspacePurpose: "Purpose",
      contextPath: "shared/context",
      projects: [{ id: "root", path: ".", scope: "Root project" }],
    });
    const agents = files.find((file) => file.relativePath === "AGENTS.md")?.content ?? "";

    expect(agents).toContain("| root | `.` | `shared/context/README.md` | `shared/context/projects/root.md` |");
    expect(files.map((file) => file.relativePath)).toContain("shared/context/ongoing/README.md");
    expect(files.find((file) => file.relativePath === "shared/context/README.md")?.content).not.toContain("Each project's `.ai/README.md`");
  });

});
