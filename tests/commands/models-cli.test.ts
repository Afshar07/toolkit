import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function cli(args: string[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "toolkit-models-cli-"));
  roots.push(root);
  const result = await execa(process.execPath, [path.resolve("dist/cli.js"), ...args], {
    cwd: root,
    reject: false,
    env: { CONSOLA_LEVEL: "3", XDG_CONFIG_HOME: path.join(root, "config"), TOOLKIT_HOME: path.join(root, "home") },
  });
  return { ...result, root };
}

describe("compiled models CLI", () => {
  it("registers the command group and all six help routes", async () => {
    const result = await cli(["models", "--help"]);
    expect(result.exitCode).toBe(0);
    for (const name of ["list", "profiles", "configure", "use", "set", "status"]) expect(result.stdout).toContain(name);
  });

  it.each(["use", "set"])("rejects missing required arguments for %s", async (command) => {
    const result = await cli(["models", command, "--non-interactive"]);
    expect(result.exitCode).not.toBe(0);
    expect(await readdir(result.root)).toEqual([]);
  });

  it.each(["list", "profiles", "configure", "use", "set", "status"])("shows %s help", async (command) => {
    const result = await cli(["models", command, "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(command);
    expect(result.stdout).toContain("--global");
    expect(result.stdout).toContain("--destination");
  });

  it("rejects conflicting scopes before discovery or writes", async () => {
    const result = await cli(["models", "use", "openai", "--global", "--destination", ".", "--non-interactive"]);
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/mutually exclusive|cannot.*combined|conflict/i);
    expect(await readdir(result.root)).toEqual([]);
  });

  it("prints parseable profile JSON without initializing storage", async () => {
    const result = await cli(["models", "profiles", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toBeDefined();
    expect(await readdir(result.root)).toEqual([]);
  });

  it("prints parseable status JSON without initializing storage", async () => {
    const result = await cli(["models", "status", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toBeDefined();
    expect(await readdir(result.root)).toEqual([]);
  });

  it("refuses a non-TTY wizard without creating files", async () => {
    const result = await cli(["models", "configure"]);
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/terminal|interactive|TTY/i);
    expect(await readdir(result.root)).toEqual([]);
  });
});
