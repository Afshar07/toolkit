import { readFile, writeFile } from "node:fs/promises";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { publishAgent } from "../../src/agents/publish.js";
import { readAgentManifest } from "../../src/agents/manifest.js";
import { hashAgentContent } from "../../src/agents/sync.js";
import { ModelProfileError } from "../../src/models/profiles/errors.js";
import { readLocalAgentRegistry } from "../../src/registry/registry.js";
import { agentPath, createPublicationFixtures, publishOptions, remoteHead } from "../helpers/publication.js";

const { fixture, cleanup, dispose } = createPublicationFixtures();
afterEach(cleanup);
afterAll(dispose);

/** Real Git operations need more than the default five seconds on Windows. */
describe.sequential("agent publication never publishes machine-specific models", { timeout: 30_000 }, () => {
  it("strips the published model while preserving the installed working model", async () => {
    const setup = await fixture();
    await writeFile(agentPath(setup.project, "coder"), "---\r\ndescription: d\r\nmodel: cpa-gui/x\r\n---\r\nbody\r\n");

    const result = await publishAgent("coder", publishOptions(setup));

    expect(result.outcome).toBe("published");
    expect(result.preview.diff).not.toContain("model:");
    const published = "---\ndescription: d\n---\nbody\n";
    const installed = "---\ndescription: d\nmodel: cpa-gui/x\n---\nbody\n";
    expect((await readLocalAgentRegistry(setup.paths)).agents["coder.md"]).toBe(published);
    /** Publication is not migration approval: the installed working model stays, only line endings are canonical. */
    await expect(readFile(agentPath(setup.project, "coder"), "utf8")).resolves.toBe(installed);
    expect((await readAgentManifest(setup.project)).installed.coder?.hash).toBe(hashAgentContent(installed));
  });

  it("treats a model-only local difference as unchanged", async () => {
    const setup = await fixture();
    await writeFile(agentPath(setup.project, "coder"), "---\ndescription: d\n---\nbody\n");
    await publishAgent("coder", publishOptions(setup));
    const head = await remoteHead(setup.remote);
    await writeFile(agentPath(setup.project, "coder"), "---\ndescription: d\nmodel: a/b\n---\nbody\n");

    const result = await publishAgent("coder", publishOptions(setup));

    expect(result.outcome).toBe("unchanged");
    expect(await remoteHead(setup.remote)).toBe(head);
    await expect(readFile(agentPath(setup.project, "coder"), "utf8")).resolves.toContain("model: a/b");
  });

  it("rejects ambiguous model entries before any remote or local change", async () => {
    const setup = await fixture();
    const duplicate = "---\nmodel: a/b\nmodel: c/d\n---\nbody\n";
    await writeFile(agentPath(setup.project, "coder"), duplicate);
    const ownership = await readFile(`${setup.project}/.toolkit/agents.json`, "utf8");

    await expect(publishAgent("coder", publishOptions(setup))).rejects.toBeInstanceOf(ModelProfileError);

    expect(await remoteHead(setup.remote)).toBe(setup.initialHead);
    await expect(readFile(agentPath(setup.project, "coder"), "utf8")).resolves.toBe(duplicate);
    await expect(readFile(`${setup.project}/.toolkit/agents.json`, "utf8")).resolves.toBe(ownership);
  });
});
