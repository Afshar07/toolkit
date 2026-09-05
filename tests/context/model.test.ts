import { describe, expect, it } from "vitest";
import { AiContextSetupError, normalizeAiContextOptions } from "../../src/context/model.js";

describe("normalizeAiContextOptions", () => {
  const base = { workspaceName: "Workspace", workspacePurpose: "Purpose", projects: [{ id: "Web App", path: "apps/web", scope: "Web" }] };

  it("normalizes POSIX paths and project IDs", () => {
    expect(normalizeAiContextOptions({ ...base, contextPath: "./.ai/../.context" })).toMatchObject({
      contextPath: ".context",
      projects: [{ id: "web-app", path: "apps/web" }],
    });
  });

  it.each(["/tmp/context", "../context", "apps\\web"])('rejects unsafe path "%s"', (contextPath) => {
    expect(() => normalizeAiContextOptions({ ...base, contextPath })).toThrow(AiContextSetupError);
  });

  it("rejects the workspace root as a shared context path", () => {
    expect(() => normalizeAiContextOptions({ ...base, contextPath: "." })).toThrow("below the workspace root");
  });

  it("rejects duplicate IDs and overlapping project paths", () => {
    expect(() => normalizeAiContextOptions({ ...base, projects: [base.projects[0], { id: "WEB APP", path: "apps/api", scope: "API" }] })).toThrow("unique project IDs");
    expect(() => normalizeAiContextOptions({ ...base, projects: [base.projects[0], { id: "API", path: "apps", scope: "API" }] })).toThrow("overlapping");
  });
});
