import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import * as path from "pathe";
import { afterEach, describe, expect, it } from "vitest";
import { incrementCanonicalVersion, publishAgent } from "../../src/agents/publish.js";
import { readAgentManifest } from "../../src/agents/manifest.js";
import { hashAgentContent, overrideAgent } from "../../src/agents/sync.js";
import { readLocalAgentRegistry } from "../../src/registry/registry.js";
import { publishAgents } from "../helpers/git.js";
import { agentPath, createPublicationFixtures, publishOptions, remoteHead } from "../helpers/publication.js";

const { fixture, cleanup } = createPublicationFixtures();
afterEach(cleanup);

/** Real Git operations need more than the default five seconds on Windows. */
describe.sequential("agent single publication and conflicts", { timeout: 30_000 }, () => {
  it("treats a local CRLF-only difference as no shared-content change", async () => {
    const setup = await fixture(true);
    await writeFile(agentPath(setup.project, "coder"), "coder v1\r\n");
    const before = await remoteHead(setup.remote);

    const result = await publishAgent("coder", publishOptions(setup));

    expect(result.outcome).toBe("unchanged");
    expect(await remoteHead(setup.remote)).toBe(before);
    await expect(readFile(agentPath(setup.project, "coder"), "utf8")).resolves.toBe("coder v1\r\n");
  });

  it("reads and safely refreshes an existing CRLF machine registry as canonical LF", async () => {
    const setup = await fixture(true, true);
    expect(await readFile(path.join(setup.paths.agents, "coder.md"), "utf8")).toBe("coder v1\r\n");
    expect((await readLocalAgentRegistry(setup.paths)).agents["coder.md"]).toBe("coder v1\n");
    const legacyManifest = await readAgentManifest(setup.project);
    await writeFile(agentPath(setup.project, "coder"), "coder v1\r\n");
    legacyManifest.installed.coder!.hash = hashAgentContent("coder v1\r\n");
    await writeFile(path.join(setup.project, ".toolkit/agents.json"), `${JSON.stringify(legacyManifest, null, 2)}\n`);
    await writeFile(agentPath(setup.project, "coder"), "legacy registry publication\r\n");

    const result = await publishAgent("coder", publishOptions(setup));

    expect(result.outcome).toBe("published");
    await expect(readFile(agentPath(setup.project, "coder"), "utf8")).resolves.toBe("legacy registry publication\n");
    expect((await readAgentManifest(setup.project)).installed.coder?.hash).toBe(hashAgentContent("legacy registry publication\n"));
  });

  it("keeps canonical LF behavior when Git environment overrides repository configuration", async () => {
    const setup = await fixture(false, false, true);
    await writeFile(agentPath(setup.project, "coder"), "forced conversion\r\n");

    const result = await publishAgent("coder", publishOptions(setup));

    expect(result.outcome).toBe("published");
    expect((await readLocalAgentRegistry(setup.paths)).agents["coder.md"]).toBe("forced conversion\n");
    await expect(readFile(agentPath(setup.project, "coder"), "utf8")).resolves.toBe("forced conversion\n");
  });

  it("does not commit, bump, or persist state for identical content or a dry run", async () => {
    const setup = await fixture();
    const before = await remoteHead(setup.remote);
    const identical = await publishAgent("coder", publishOptions(setup));
    expect(identical.outcome).toBe("unchanged");
    expect(await remoteHead(setup.remote)).toBe(before);

    await writeFile(agentPath(setup.project, "coder"), "preview only\n");
    const ownershipBefore = await readFile(path.join(setup.project, ".toolkit/agents.json"), "utf8");
    const dryRun = await publishAgent("coder", { ...publishOptions(setup), dryRun: true, confirm: undefined });
    expect(dryRun.outcome).toBe("dry-run");
    expect(dryRun.preview.diff).toContain("+preview only");
    expect(await remoteHead(setup.remote)).toBe(before);
    await expect(readFile(path.join(setup.project, ".toolkit/agents.json"), "utf8")).resolves.toBe(ownershipBefore);
  });

  it("refuses stale baselines, overrides, unmanaged files, unsafe names, and escaping links", async () => {
    const setup = await fixture();
    await writeFile(agentPath(setup.project, "coder"), "local edit\n");
    await publishAgents(setup.author, { lead: "lead v1\n", coder: "upstream edit\n" }, "upstream");
    await expect(publishAgent("coder", publishOptions(setup))).rejects.toThrow("shared definition changed");

    const fresh = await fixture();
    await overrideAgent(fresh.project, "coder", fresh.registry);
    await expect(publishAgent("coder", publishOptions(fresh))).rejects.toThrow("--include-override");
    await expect(publishAgent("../coder", publishOptions(fresh))).rejects.toThrow("Invalid agent name");

    const unmanaged = path.join(fresh.root, "unmanaged");
    await mkdir(path.join(unmanaged, ".opencode/agents"), { recursive: true });
    await writeFile(agentPath(unmanaged, "coder"), "unmanaged\n");
    await expect(publishAgent("coder", { ...publishOptions(fresh), destination: unmanaged })).rejects.toThrow("--allow-unmanaged");

    const unsafe = path.resolve(fresh.root, "unsafe");
    const outside = path.resolve(fresh.root, "outside");
    await Promise.all([mkdir(unsafe), mkdir(outside, { recursive: true })]);
    await symlink(outside, path.join(unsafe, ".opencode"), process.platform === "win32" ? "junction" : "dir");
    await expect(publishAgent("coder", { ...publishOptions(fresh), destination: unsafe })).rejects.toThrow(/regular file|unsafe/);
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it("rejects a normal push when upstream advances and cleans its checkout", async () => {
    const setup = await fixture();
    await writeFile(agentPath(setup.project, "coder"), "coder improved\n");
    await expect(publishAgent("coder", {
      ...publishOptions(setup),
      beforePush: async () => publishAgents(setup.author, { lead: "lead v2\n", coder: "coder v1\n" }, "advance"),
    })).rejects.toThrow(/Direct push failed/);
    await expect(readdir(setup.temporaryParent)).resolves.toEqual([]);
  });

  it("reports successful publication separately when local reconciliation fails", async () => {
    const setup = await fixture();
    await writeFile(agentPath(setup.project, "coder"), "published bytes\n");
    await expect(publishAgent("coder", {
      ...publishOptions(setup),
      beforeReconcile: async () => writeFile(agentPath(setup.project, "coder"), "changed during push\n"),
    })).rejects.toMatchObject({ published: true });
    expect(await remoteHead(setup.remote)).not.toBe(setup.initialHead);
    expect((await readAgentManifest(setup.project)).installed.coder?.version).toBe("initial registry");
  });

  it("increments human-readable versions deterministically more than once per day", () => {
    const day = new Date("2026-10-01T12:00:00Z");
    expect(incrementCanonicalVersion("2026.10.1", day)).toBe("2026.10.2");
    expect(incrementCanonicalVersion("2026.10.2", day)).toBe("2026.10.3");
    expect(incrementCanonicalVersion("2026.09.42", day)).toBe("2026.10.1");
  });
});
