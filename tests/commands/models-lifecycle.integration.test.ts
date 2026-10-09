import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { bundledAgentRegistry } from "../../src/agents/registry.js";
import { updateAgents } from "../../src/agents/sync.js";
import { createModelProfile, resolveModelProfileLocation } from "../../src/models/index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

interface IFileSnapshot { text: string; modified: number }
async function snapshot(root: string, directory = root, files: Record<string, IFileSnapshot> = {}) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await snapshot(root, file, files);
    else files[path.relative(root, file)] = { text: await readFile(file, "utf8"), modified: (await stat(file)).mtimeMs };
  }
  return files;
}

describe("model lifecycle through actual CLI processes", () => {
  it.each(["source", "compiled"])("switches and isolates assignments using %s CLI with deterministic OpenCode executable", async (mode) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "toolkit-model-journey-")); roots.push(root);
    const project = path.join(root, "project");
    const bin = path.join(root, "bin");
    await mkdir(project); await mkdir(bin);
    const fixture = path.join(bin, "inventory.cjs");
    await writeFile(fixture, "console.log('cpa-gui/gpt-6.1-sol\\ncpa-gui/claude-sonnet-5-5\\ncpa-gui/gpt-6.1-sol-123');");
    const command = path.join(bin, process.platform === "win32" ? "opencode.cmd" : "opencode");
    await writeFile(command, process.platform === "win32" ? `@echo off\r\n"${process.execPath}" "${fixture}"\r\n` : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${fixture.replaceAll("'", "'\\''")}'\n`);
    if (process.platform !== "win32") await chmod(command, 0o755);
    const cli = async (...args: string[]) => execa(process.execPath, mode === "source"
      ? ["--import", pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href, path.resolve("src/cli.ts"), "models", ...args]
      : [path.resolve("dist/cli.js"), "models", ...args], {
      cwd: project, reject: false, timeout: 15_000,
      env: { PATH: bin, HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "config"), CONSOLA_LEVEL: "3" },
    });
    expect((await cli("profiles", "--json")).exitCode).toBe(0);
    expect((await cli("status", "--json")).exitCode).toBe(0);
    expect(await readdir(project)).toEqual([]);
    // Installation and profile persistence use public APIs; all discovery/application below is subprocess CLI.
    await updateAgents(project, {}, bundledAgentRegistry);
    const location = resolveModelProfileLocation(project);
    for (const [name, id] of [["openai", "cpa-gui/gpt-6.1-sol"], ["anthropic", "cpa-gui/claude-sonnet-5-5"]]) {
      await createModelProfile(location, name!, { agents: { coder: { id: id! }, lead: { id: id! } } });
    }
    const markdown = await snapshot(path.join(project, ".opencode/agents"));
    expect(JSON.parse((await cli("list", "--json")).stdout).models).toHaveLength(3);
    expect((await cli("configure", "--non-interactive")).exitCode).not.toBe(0);
    expect((await cli("set", "coder", "--non-interactive")).exitCode).not.toBe(0);
    for (const profile of ["openai", "anthropic", "openai"]) {
      const result = await cli("use", profile, "--non-interactive");
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(await readFile(location.statePath, "utf8")).activeProfile).toBe(profile);
    }
    const before = await snapshot(project);
    expect((await cli("use", "openai", "--non-interactive")).exitCode).toBe(0);
    expect(await snapshot(project)).toEqual(before);
    expect((await cli("use", "anthropic", "--dry-run", "--non-interactive")).exitCode).toBe(0);
    expect((await cli("set", "coder", "cpa-gui/gpt-6.1-sol-123", "--dry-run", "--non-interactive")).exitCode).toBe(0);
    expect(await snapshot(project)).toEqual(before);
    expect((await cli("set", "coder", "cpa-gui/gpt-6.1-sol-123", "--non-interactive")).exitCode).toBe(0);
    const config = JSON.parse(await readFile(path.join(project, "opencode.jsonc"), "utf8"));
    expect(config.agents.coder.model).toBe("cpa-gui/gpt-6.1-sol-123");
    expect(config.agents.lead.model).toBe("cpa-gui/gpt-6.1-sol");
    const ownership = JSON.parse(await readFile(path.join(location.directory, "applied.json"), "utf8"));
    expect(ownership.agents.coder.model).toBe(config.agents.coder.model);
    expect((await cli("doctor", "--json")).exitCode).toBe(0);
    expect(await snapshot(path.join(project, ".opencode/agents"))).toEqual(markdown);
  }, 30_000);
});
