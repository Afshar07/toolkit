import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
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

  it("reports a missing ongoing-task index", async () => {
    const directory = await makeTemporaryDirectory();
    await setupAiContext(directory, {
      workspaceName: "Workspace",
      workspacePurpose: "Useful tools.",
      projects: [{ id: "web", path: "apps/web", scope: "Web app" }],
    });
    await unlink(path.join(directory, "apps", "web", ".ai", "ongoing", "README.md"));

    const result = await validateAiContext(directory);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "missing-ongoing-index", severity: "error" }));
  });

  it("reports unsafe router references", async () => {
    const directory = await makeTemporaryDirectory();
    await writeFile(path.join(directory, "AGENTS.md"), `# Workspace Agent Router\n\n## Project routing table\n\n| Project | Workspace-relative path | Local index | Shared guidance |\n| --- | --- | --- | --- |\n| web | \`../web\` | \`apps/web/.ai/README.md\` | \`.ai/projects/web.md\` |\n`);

    const result = await validateAiContext(directory);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "unsafe-project-path", severity: "error" }));
  });

  it("rejects unsupported legacy routing-table layouts", async () => {
    const directory = await makeTemporaryDirectory();
    await writeFile(path.join(directory, "AGENTS.md"), `# Workspace Router

## Project routing

| Match | Local index | Shared guidance |
|---|---|---|
| \`app/**\` | \`app/.ai/README.md\` | \`context/.ai/projects/app.md\` |

## Shared policy routes

- Read \`context/.ai/policies/delegation.md\` for delegation.
`);
    const result = await validateAiContext(directory);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "missing-routing-table", severity: "error" }));
  });
});

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "toolkit-"));
  temporaryDirectories.push(directory);
  return directory;
}
