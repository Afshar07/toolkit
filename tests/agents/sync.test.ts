import { access, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import * as path from "pathe";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalAgents, canonicalAgentVersion } from "../../src/agents/registry.js";
import { readAgentManifest, writeAgentManifest } from "../../src/agents/manifest.js";
import { hashAgentContent, inspectAgents, manageAgent, openCodeAgentDirectory, overrideAgent, updateAgents } from "../../src/agents/sync.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("agent synchronization", () => {
  it("installs missing canonical agents and records ownership metadata", async () => {
    const root = await makeTemporaryDirectory();

    const result = await updateAgents(root);

    expect(result.installed).toEqual(["lead", "researcher", "external-researcher", "coder"]);
    await expect(readFile(agentPath(root, "lead"), "utf8")).resolves.toBe(canonicalAgents["lead.md"]);
    const manifest = await readAgentManifest(root);
    expect(manifest.installed.lead).toEqual({
      source: "toolkit",
      version: canonicalAgentVersion,
      hash: hashAgentContent(canonicalAgents["lead.md"]),
    });
  });

  it("leaves already-current managed agents unchanged", async () => {
    const root = await makeTemporaryDirectory();
    await updateAgents(root);
    const before = await readFile(agentPath(root, "lead"), "utf8");

    const result = await updateAgents(root);

    expect(result.current).toContain("lead");
    await expect(readFile(agentPath(root, "lead"), "utf8")).resolves.toBe(before);
  });

  it("updates an unchanged managed agent when the canonical content changes", async () => {
    const root = await makeTemporaryDirectory();
    await updateAgents(root);
    const previous = "previous Toolkit lead\n";
    await writeFile(agentPath(root, "lead"), previous, "utf8");
    const manifest = await readAgentManifest(root);
    manifest.installed.lead = { source: "toolkit", version: "2026.09.1", hash: hashAgentContent(previous) };
    await writeAgentManifest(root, manifest);

    const result = await updateAgents(root);

    expect(result.updated).toContain("lead");
    await expect(readFile(agentPath(root, "lead"), "utf8")).resolves.toBe(canonicalAgents["lead.md"]);
    expect((await readAgentManifest(root)).installed.lead?.version).toBe(canonicalAgentVersion);
  });

  it("preserves and reports a locally modified managed agent in the non-interactive default", async () => {
    const root = await makeTemporaryDirectory();
    await updateAgents(root);
    await writeFile(agentPath(root, "lead"), "my project-specific edit\n", "utf8");

    const status = await inspectAgents(root);
    const result = await updateAgents(root);

    expect(status.managed.find((agent) => agent.name === "lead")?.state).toBe("modified");
    expect(result.conflicts).toContain("lead");
    await expect(readFile(agentPath(root, "lead"), "utf8")).resolves.toBe("my project-specific edit\n");
  });

  it("replaces a locally modified managed agent only when explicitly authorized", async () => {
    const root = await makeTemporaryDirectory();
    await updateAgents(root);
    await writeFile(agentPath(root, "lead"), "local edit\n", "utf8");

    const result = await updateAgents(root, { replaceModified: new Set(["lead"]) });

    expect(result.updated).toContain("lead");
    await expect(readFile(agentPath(root, "lead"), "utf8")).resolves.toBe(canonicalAgents["lead.md"]);
  });

  it("never touches an unknown local agent", async () => {
    const root = await makeTemporaryDirectory();
    await updateAgents(root);
    await writeFile(agentPath(root, "figma-specialist"), "local only\n", "utf8");

    const result = await updateAgents(root);

    expect(result.local).toContain("figma-specialist");
    await expect(readFile(agentPath(root, "figma-specialist"), "utf8")).resolves.toBe("local only\n");
  });

  it("does not claim or overwrite an unowned canonical-name collision", async () => {
    const root = await makeTemporaryDirectory();
    await writeFile(await preparedAgentPath(root, "lead"), "pre-existing local lead\n", "utf8");

    const result = await updateAgents(root);

    expect(result.conflicts).toContain("lead");
    expect((await readAgentManifest(root)).installed.lead).toBeUndefined();
    await expect(readFile(agentPath(root, "lead"), "utf8")).resolves.toBe("pre-existing local lead\n");
  });

  it("preserves an explicit override and can explicitly return it to management", async () => {
    const root = await makeTemporaryDirectory();
    await updateAgents(root);
    await overrideAgent(root, "coder");
    await writeFile(agentPath(root, "coder"), "special project coder\n", "utf8");

    const result = await updateAgents(root);
    expect(result.overrides).toContain("coder");
    await expect(readFile(agentPath(root, "coder"), "utf8")).resolves.toBe("special project coder\n");

    await manageAgent(root, "coder");
    await expect(readFile(agentPath(root, "coder"), "utf8")).resolves.toBe(canonicalAgents["coder.md"]);
    const manifest = await readAgentManifest(root);
    expect(manifest.overrides).not.toContain("coder");
    expect(manifest.installed.coder?.hash).toBe(hashAgentContent(canonicalAgents["coder.md"]));
  });

  it("restores a missing managed agent", async () => {
    const root = await makeTemporaryDirectory();
    await updateAgents(root);
    await unlink(agentPath(root, "researcher"));

    const result = await updateAgents(root);

    expect(result.restored).toContain("researcher");
    await expect(readFile(agentPath(root, "researcher"), "utf8")).resolves.toBe(canonicalAgents["researcher.md"]);
  });

  it("does not delete a file for a formerly recorded Toolkit agent", async () => {
    const root = await makeTemporaryDirectory();
    await updateAgents(root);
    await writeFile(agentPath(root, "retired"), "keep retired agent\n", "utf8");
    const manifest = await readAgentManifest(root);
    manifest.installed.retired = { source: "toolkit", version: "2025.1", hash: hashAgentContent("keep retired agent\n") };
    await writeAgentManifest(root, manifest);

    const result = await updateAgents(root);

    expect(result.local).toContain("retired");
    await expect(readFile(agentPath(root, "retired"), "utf8")).resolves.toBe("keep retired agent\n");
  });

  it("uses content hashes rather than versions to distinguish edits", async () => {
    const root = await makeTemporaryDirectory();
    await updateAgents(root);
    const manifest = await readAgentManifest(root);
    manifest.installed.lead!.version = "old-version";
    await writeAgentManifest(root, manifest);

    expect((await inspectAgents(root)).managed.find((agent) => agent.name === "lead")?.state).toBe("current");
    await writeFile(agentPath(root, "lead"), `${canonicalAgents["lead.md"]}\nlocal edit`, "utf8");
    expect((await inspectAgents(root)).managed.find((agent) => agent.name === "lead")?.state).toBe("modified");
  });
});

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "toolkit-agents-"));
  temporaryDirectories.push(directory);
  return directory;
}

function agentPath(root: string, name: string): string {
  return path.join(root, openCodeAgentDirectory, `${name}.md`);
}

async function preparedAgentPath(root: string, name: string): Promise<string> {
  await updateAgents(root);
  const target = agentPath(root, name);
  await rm(target);
  const manifest = await readAgentManifest(root);
  delete manifest.installed[name];
  await writeAgentManifest(root, manifest);
  await expect(access(path.dirname(target))).resolves.toBeUndefined();
  return target;
}
