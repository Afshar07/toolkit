import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import * as path from "pathe";
import { afterEach, describe, expect, it } from "vitest";
import { setupAiContext } from "../../src/context/setup.js";
import { validateAiContext } from "../../src/context/validate.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("validateAiContext", () => {
  it("validates a generated multi-project context without writing", async () => {
    const directory = await makeTemporaryDirectory();
    await setupAiContext(directory, {
      workspaceName: "Workspace",
      workspacePurpose: "Useful tools.",
      contextPath: "shared/.ai",
      projects: [{ id: "web", path: "apps/web", scope: "Web app" }],
    });

    await expect(validateAiContext(directory)).resolves.toMatchObject({
      valid: true,
      issues: [],
      projects: [{ id: "web", path: "apps/web", localIndex: "apps/web/.ai/README.md", guidance: "shared/.ai/projects/web.md" }],
    });
  });

  it("reports missing referenced local context", async () => {
    const directory = await makeTemporaryDirectory();
    await setupAiContext(directory, {
      workspaceName: "Workspace",
      workspacePurpose: "Useful tools.",
      projects: [{ id: "web", path: "apps/web", scope: "Web app" }],
    });
    await unlink(path.join(directory, "apps", "web", ".ai", "README.md"));

    const result = await validateAiContext(directory);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "missing-local-index", severity: "error" }));
  });

  it("reports unsafe router references", async () => {
    const directory = await makeTemporaryDirectory();
    await writeFile(path.join(directory, "AGENTS.md"), `# Workspace Agent Router\n\n## Project routing table\n\n| Project | Workspace-relative path | Local index | Shared guidance |\n| --- | --- | --- | --- |\n| web | \`../web\` | \`apps/web/.ai/README.md\` | \`.ai/projects/web.md\` |\n`);

    const result = await validateAiContext(directory);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "unsafe-project-path", severity: "error" }));
  });

  it("validates the established three-column Trigate router layout", async () => {
    const directory = await makeTemporaryDirectory();
    await writeFile(path.join(directory, "AGENTS.md"), `# Workspace Router

## Project routing

| Match | Local index | Shared guidance |
|---|---|---|
| \`app/**\` | \`app/.ai/README.md\` | \`context/.ai/projects/app.md\` |

## Shared policy routes

- Read \`context/.ai/policies/delegation.md\` for delegation.
`);
    await mkdir(path.join(directory, "app", ".ai"), { recursive: true });
    await writeFile(path.join(directory, "app", ".ai", "README.md"), "local");
    await mkdir(path.join(directory, "context", ".ai", "projects"), { recursive: true });
    await mkdir(path.join(directory, "context", ".ai", "policies"), { recursive: true });
    await writeFile(path.join(directory, "context", ".ai", "workspace.md"), "workspace");
    await writeFile(path.join(directory, "context", ".ai", "README.md"), "context");
    await writeFile(path.join(directory, "context", ".ai", "engineering-conventions.md"), "conventions");
    await writeFile(path.join(directory, "context", ".ai", "projects", "app.md"), "guidance");
    await writeFile(path.join(directory, "context", ".ai", "policies", "delegation.md"), "delegation");
    await writeFile(path.join(directory, "context", ".ai", "policies", "context-maintenance.md"), "maintenance");

    await expect(validateAiContext(directory)).resolves.toMatchObject({ valid: true, issues: [] });
  });
});

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "toolkit-"));
  temporaryDirectories.push(directory);
  return directory;
}
