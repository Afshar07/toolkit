import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand } from "citty";
import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Scripted OpenCode inventory; `error` simulates a failed `opencode models`. Nothing here touches a process or network. */
const discovery = vi.hoisted(() => ({ output: "", error: undefined as Error | undefined, reads: 0 }));

/** Answers for every Clack prompt. Unscripted free-text prompts return the empty string. */
const script = vi.hoisted(() => ({
  text: [] as unknown[],
  /** Preferred option value or label fragments, tried in order for `select`. */
  choose: [] as string[],
  /** `all`/`none`, or the agents whose protected assignment the user consents to replace. */
  consent: "all" as "all" | "none" | string[],
  /** Result of the final save/apply confirmation. */
  confirm: true,
  /** Exact ID returned by the mocked selector per agent; absent agents keep their current ID. */
  models: {} as Record<string, string | symbol | undefined>,
  seenPrompts: [] as string[],
}));
const CANCEL = vi.hoisted(() => Symbol("cancel"));
const selector = vi.hoisted(() => ({ calls: [] as { ids: string[]; agent?: string; current?: string }[] }));

vi.mock("../../src/models/source.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/models/source.js")>()),
  createOpenCodeModelSource: () => ({
    read: async () => {
      discovery.reads += 1;
      if (discovery.error) throw discovery.error;
      return discovery.output;
    },
  }),
}));

vi.mock("../../src/registry/registry.js", async (importOriginal) => {
  const { bundledAgentRegistry } = await import("../../src/agents/registry.js");
  const prepared = async () => ({ registry: bundledAgentRegistry, action: "bundled" as const });
  return {
    ...(await importOriginal<typeof import("../../src/registry/registry.js")>()),
    resolveOfflineAgentRegistry: prepared,
    prepareAgentRegistryForUpdate: prepared,
  };
});

vi.mock("../../src/commands/models/selector.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/commands/models/selector.js")>()),
  selectModel: vi.fn(async (models: readonly { id: string }[], options: { agent?: string; current?: string } = {}) => {
    if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) throw new Error("Interactive model selection requires a terminal (TTY).");
    selector.calls.push({ ids: models.map((model) => model.id), agent: options.agent, current: options.current });
    const scripted = options.agent !== undefined && Object.hasOwn(script.models, options.agent) ? script.models[options.agent] : options.current;
    return scripted === CANCEL ? undefined : (scripted as string | undefined);
  }),
}));

const optionValue = (option: { value?: unknown; label?: string }) => String(option.value ?? option.label);
const matches = (option: { value?: unknown; label?: string }, wanted: string) => `${String(option.value)} ${option.label ?? ""}`.toLowerCase().includes(wanted.toLowerCase());

vi.mock("@clack/prompts", () => {
  const record = (options: { message?: string }) => script.seenPrompts.push(String(options?.message ?? ""));
  const note = vi.fn();
  return {
    intro: vi.fn(), outro: vi.fn(), cancel: vi.fn(), note, isCancel: (value: unknown) => value === CANCEL,
    log: { error: vi.fn(), info: vi.fn(), message: vi.fn(), step: vi.fn(), success: vi.fn(), warn: vi.fn(), warning: vi.fn() },
    spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
    text: vi.fn(async (options: { message?: string; initialValue?: string }) => {
      record(options);
      return script.text.length ? script.text.shift() : (options.initialValue ?? "");
    }),
    confirm: vi.fn(async (options: { message?: string }) => {
      record(options);
      const message = String(options.message ?? "");
      if (!Array.isArray(script.consent)) return script.consent === "none" && /replace|overwrite|consent|protected/i.test(message) ? false : script.confirm;
      const agents = ["lead", "researcher", "external-researcher", "coder"].filter((agent) => new RegExp(`\\b${agent}\\b`).test(message));
      return agents.length === 0 ? script.confirm : agents.some((agent) => (script.consent as string[]).includes(agent));
    }),
    multiselect: vi.fn(async (options: { message?: string; options: { value: unknown; label?: string }[] }) => {
      record(options);
      if (script.consent === "none") return [];
      return options.options.filter((option) => script.consent === "all" || (script.consent as string[]).some((agent) => matches(option, agent))).map((option) => option.value);
    }),
    select: vi.fn(async (options: { message?: string; options: { value: unknown; label?: string }[] }) => {
      record(options);
      for (const wanted of script.choose) {
        const found = options.options.find((option) => matches(option, wanted));
        if (found) return found.value;
      }
      return optionValue(options.options[0]!) === undefined ? undefined : options.options[0]!.value;
    }),
  };
});

import { bundledAgentRegistry } from "../../src/agents/registry.js";
import { hashAgentContent, updateAgents } from "../../src/agents/sync.js";
import { agentDirectory } from "../../src/agents/target.js";
import type { AgentTarget } from "../../src/agents/target.js";
import { createModelProfile, readLocalModelState, readModelProfileStore, readModelResolutions, resolveModelProfileLocation, setActiveModelProfile } from "../../src/models/index.js";
import type { IModelProfile, IModelProfileLocation } from "../../src/models/index.js";
import { modelsCommand } from "../../src/commands/models.js";

const inventory = [
  "openai/gpt-5.5",
  "openai/gpt-6.1-sol",
  "anthropic/claude-sonnet-4-5",
  "cpa-gui/claude-sonnet-5-5",
  "cpa-gui/gpt-5.5",
  "cpa-gui/gpt-6.1-sol",
  "cpa-gui/gpt-6.1-sol-123",
  "openrouter/anthropic/claude-3.5-sonnet",
];

const profiles: Record<string, IModelProfile> = {
  openai: { agents: { lead: { id: "openai/gpt-5.5" }, coder: { id: "openai/gpt-6.1-sol" } } },
  anthropic: { agents: { lead: { id: "anthropic/claude-sonnet-4-5" }, coder: { id: "cpa-gui/claude-sonnet-5-5" } } },
  shared: { agents: { lead: { family: "gpt-5.5", allowedProviders: ["cpa-gui", "openai"] } } },
  partial: { agents: { lead: { id: "openai/gpt-5.5" }, coder: { id: "openai/not-installed" } } },
};

interface IWorkspace {
  readonly root: string;
  readonly target: AgentTarget;
  readonly location: IModelProfileLocation;
}

const temporary: string[] = [];
const originalTty = { stdin: Object.getOwnPropertyDescriptor(process.stdin, "isTTY"), stdout: Object.getOwnPropertyDescriptor(process.stdout, "isTTY") };
const sandbox = { root: "" };
let consoleStdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
vi.spyOn(console, "info").mockImplementation((...parts: unknown[]) => consoleStdout(...parts));
let consoleStderr = vi.spyOn(console, "warn").mockImplementation(() => undefined);
vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => consoleStderr(...parts));

beforeEach(async () => {
  vi.clearAllMocks();
  consoleStdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation((...parts: unknown[]) => consoleStdout(...parts));
  consoleStderr = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => consoleStderr(...parts));
  discovery.output = inventory.join("\n");
  discovery.error = undefined;
  discovery.reads = 0;
  Object.assign(script, { text: [], choose: [], consent: "all", confirm: true, models: {}, seenPrompts: [] });
  selector.calls.length = 0;
  sandbox.root = await mkdtemp(path.join(os.tmpdir(), "toolkit-models-command-"));
  temporary.push(sandbox.root);
  // Neither OpenCode's global root nor the user's home may be reached.
  vi.stubEnv("XDG_CONFIG_HOME", path.join(sandbox.root, "xdg"));
  vi.stubEnv("HOME", path.join(sandbox.root, "home"));
  vi.stubEnv("USERPROFILE", path.join(sandbox.root, "home"));
  setTty(false);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  consoleStdout.mockImplementation(() => undefined);
  consoleStderr.mockImplementation(() => undefined);
  process.exitCode = undefined;
  restoreTty();
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 3 })));
});

function setTty(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true });
}

function restoreTty(): void {
  for (const [stream, descriptor] of [[process.stdin, originalTty.stdin], [process.stdout, originalTty.stdout]] as const) {
    if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
    else delete (stream as { isTTY?: boolean }).isTTY;
  }
}

interface IRun {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  /** Everything a person could read: standard output, diagnostics, and the thrown message. */
  readonly all: string;
  json(): unknown;
}

/** Runs the real citty command tree. A thrown error and a nonzero exit code both count as failure. */
async function run(...argv: string[]): Promise<IRun> {
  consoleStdout.mockClear();
  consoleStderr.mockClear();
  process.exitCode = undefined;
  let thrown = "";
  try {
    await runCommand(modelsCommand, { rawArgs: argv });
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error);
  }
  const lines = (spy: typeof consoleStdout) => spy.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
  const stdout = lines(consoleStdout);
  const stderr = `${lines(consoleStderr)}${thrown ? `\n${thrown}` : ""}`;
  const ok = thrown === "" && (process.exitCode === undefined || Number(process.exitCode) === 0);
  process.exitCode = undefined;
  return { ok, stdout, stderr, all: `${stdout}\n${stderr}`, json: () => JSON.parse(stdout.trim()) };
}

/** Every string anywhere in a JSON value, so tests assert content rather than an exact response shape. */
function strings(value: unknown, found: string[] = []): string[] {
  if (typeof value === "string") found.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, found);
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) { found.push(key); strings(item, found); }
  return found;
}

async function workspace(options: { global?: boolean; profiles?: Record<string, IModelProfile>; active?: string; installAgents?: boolean } = {}): Promise<IWorkspace> {
  const base = await mkdtemp(path.join(sandbox.root, options.global ? "global-" : "project-"));
  const root = options.global ? path.join(base, "opencode") : base;
  if (options.global) vi.stubEnv("XDG_CONFIG_HOME", base);
  const target: AgentTarget = options.global ? { scope: "global", root } : root;
  const location = resolveModelProfileLocation(target);
  if (options.installAgents !== false) await updateAgents(target, {}, bundledAgentRegistry);
  for (const [name, profile] of Object.entries(options.profiles ?? profiles)) await createModelProfile(location, name, profile);
  if (options.active) await setActiveModelProfile(location, options.active);
  return { root, target, location };
}

async function tree(root: string, directory = root, found: Record<string, string> = {}): Promise<Record<string, string>> {
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await tree(root, full, found);
    else found[path.relative(root, full).replaceAll("\\", "/")] = await readFile(full, "utf8");
  }
  return found;
}

const configPath = (space: IWorkspace) => path.join(space.root, "opencode.jsonc");
const readText = (file: string) => readFile(file, "utf8").catch(() => undefined);

async function assigned(space: IWorkspace, agent: string): Promise<unknown> {
  const text = await readText(configPath(space));
  return text === undefined ? undefined : (parseJsonc(text) as { agents?: Record<string, { model?: string }> }).agents?.[agent]?.model;
}

async function activeProfile(space: IWorkspace): Promise<string | undefined> {
  return (await readLocalModelState(space.location)).activeProfile;
}

const scope = (space: IWorkspace) => (space.location.scope === "global" ? ["--global"] : ["--destination", space.root]);

describe("scope selection", () => {
  it.each(["list", "profiles", "status"])("rejects --global together with --destination for %s", async (command) => {
    const space = await workspace();
    const before = await tree(sandbox.root);
    const result = await run(command, "--global", "--destination", space.root);
    expect(result.ok).toBe(false);
    expect(result.all).toMatch(/mutually exclusive|combined|conflict|both/i);
    expect(await tree(sandbox.root)).toEqual(before);
  });

  it("rejects --global together with --destination for use before discovery or writes", async () => {
    const space = await workspace();
    const before = await tree(sandbox.root);
    const result = await run("use", "openai", "--global", "--destination", space.root, "--non-interactive");
    expect(result.ok).toBe(false);
    expect(discovery.reads).toBe(0);
    expect(await tree(sandbox.root)).toEqual(before);
  });

  it("defaults project scope to the current directory", async () => {
    const space = await workspace({ active: "openai" });
    vi.spyOn(process, "cwd").mockReturnValue(space.root);
    const result = await run("profiles", "--json");
    expect(result.ok).toBe(true);
    expect(strings(result.json())).toContain("openai");
  });
});

describe("models list", () => {
  it("prints every exact discovered ID as JSON without writing", async () => {
    const space = await workspace();
    const before = await tree(sandbox.root);
    const result = await run("list", "--json", ...scope(space));
    expect(result.ok).toBe(true);
    expect(strings(result.json())).toEqual(expect.arrayContaining(inventory));
    expect(await tree(sandbox.root)).toEqual(before);
  });

  it("prints IDs for people without --json", async () => {
    const result = await run("list", "--destination", (await workspace()).root);
    expect(result.ok).toBe(true);
    for (const id of inventory) expect(result.stdout).toContain(id);
  });

  it("filters by exact provider", async () => {
    const result = await run("list", "--provider", "cpa-gui", "--json", "--destination", (await workspace()).root);
    const ids = strings(result.json());
    expect(ids).toEqual(expect.arrayContaining(["cpa-gui/gpt-5.5", "cpa-gui/claude-sonnet-5-5"]));
    expect(ids.some((value) => value.startsWith("openai/") || value.startsWith("anthropic/"))).toBe(false);
  });

  it("searches by case-insensitive fuzzy text over complete IDs", async () => {
    const result = await run("list", "--search", "SONNET", "--json", "--destination", (await workspace()).root);
    const ids = strings(result.json());
    expect(ids).toEqual(expect.arrayContaining(["anthropic/claude-sonnet-4-5", "cpa-gui/claude-sonnet-5-5", "openrouter/anthropic/claude-3.5-sonnet"]));
    expect(ids).not.toContain("openai/gpt-5.5");
  });

  it("keeps numbered proxy suffixes in exact IDs", async () => {
    const result = await run("list", "--search", "sol-123", "--json", "--destination", (await workspace()).root);
    expect(strings(result.json())).toContain("cpa-gui/gpt-6.1-sol-123");
  });

  it("succeeds with an explicit empty result when OpenCode reports no models", async () => {
    discovery.output = "";
    const json = await run("list", "--json", "--destination", (await workspace()).root);
    expect(json.ok).toBe(true);
    expect(strings(json.json()).filter((value) => value.includes("/"))).toEqual([]);
    const text = await run("list", "--destination", (await workspace()).root);
    expect(text.ok).toBe(true);
    expect(text.all).toMatch(/no models|none|empty|0/i);
  });

  it("reports a discovery failure without partial output or writes", async () => {
    discovery.error = new Error("opencode exploded");
    const space = await workspace();
    const before = await tree(sandbox.root);
    const result = await run("list", "--json", ...scope(space));
    expect(result.ok).toBe(false);
    expect(result.all).toMatch(/opencode exploded|discovery/i);
    expect(await tree(sandbox.root)).toEqual(before);
  });
});

describe("models profiles", () => {
  it("lists saved profiles and the active one without discovery", async () => {
    discovery.error = new Error("OpenCode is not installed");
    const space = await workspace({ active: "anthropic" });
    const before = await tree(sandbox.root);
    const result = await run("profiles", "--json", ...scope(space));
    expect(result.ok).toBe(true);
    expect(strings(result.json())).toEqual(expect.arrayContaining(["openai", "anthropic", "shared", "partial"]));
    expect(result.stdout).toContain("anthropic");
    expect(discovery.reads).toBe(0);
    expect(await tree(sandbox.root)).toEqual(before);
  });

  it("does not invent default profiles or create directories when none exist", async () => {
    const root = path.join(sandbox.root, "empty-project");
    await mkdir(root);
    const result = await run("profiles", "--json", "--destination", root);
    expect(result.ok).toBe(true);
    expect(strings(result.json())).not.toEqual(expect.arrayContaining(["openai"]));
    expect(await readdir(root)).toEqual([]);
    expect(discovery.reads).toBe(0);
  });

  it("reads the global store under the isolated OpenCode root", async () => {
    const project = await workspace({ profiles: { projectonly: { agents: {} } } });
    const global = await workspace({ global: true, profiles: { globalonly: { agents: {} } } });
    const result = await run("profiles", "--global", "--json");
    expect(result.ok).toBe(true);
    const names = strings(result.json());
    expect(names).toContain("globalonly");
    expect(names).not.toContain("projectonly");
    expect(Object.keys(await tree(global.root)).some((file) => file.endsWith("profiles.json"))).toBe(true);
    expect(project.root).not.toBe(global.root);
  });
});

describe("models configure", () => {
  it("saves explicit portable rules without discovery or application", async () => {
    setTty(true);
    const space = await workspace({ profiles: {} });
    discovery.error = new Error("OpenCode unavailable");
    script.text = ["portable", ...Object.keys(bundledAgentRegistry.agents).flatMap(() => ["cpa-gui", "cpa-gui/gpt-6.1-sol-*"])];
    script.choose = ["create", "portable"];
    const result = await run("configure", ...scope(space));
    expect(result.ok).toBe(true);
    const saved = (await readModelProfileStore(space.location)).profiles.portable!;
    expect(saved.agents.coder).toEqual({ allowedProviders: ["cpa-gui"], patterns: ["cpa-gui/gpt-6.1-sol-*"] });
    expect(await activeProfile(space)).toBeUndefined();
    expect(await readText(configPath(space))).toBeUndefined();
  });
  it("refuses to run the wizard without a terminal, even with --non-interactive", async () => {
    const space = await workspace({ profiles: {} });
    const before = await tree(sandbox.root);
    for (const extra of [[], ["--non-interactive"]]) {
      const result = await run("configure", "--destination", space.root, ...extra);
      expect(result.ok).toBe(false);
      expect(result.all).toMatch(/terminal|interactive|TTY/i);
    }
    expect(await tree(sandbox.root)).toEqual(before);
  });

  it("creates a profile: portable preferences plus local exact selections", async () => {
    setTty(true);
    const space = await workspace({ profiles: {} });
    Object.assign(script, {
      text: ["fresh"],
      choose: ["create", "new"],
      models: { lead: "openai/gpt-5.5", coder: "cpa-gui/gpt-6.1-sol-123", researcher: "openai/gpt-5.5", "external-researcher": "openai/gpt-5.5" },
    });
    const result = await run("configure", "--destination", space.root);
    expect(result.ok).toBe(true);
    const saved = (await readModelProfileStore(space.location)).profiles.fresh;
    expect(saved).toBeDefined();
    expect(saved!.agents.lead).toBeDefined();
    // Normalization preserves suffixes: the portable preference is the normalized family restricted to the
    // selected provider, and the exact ID is stored separately as a local resolution.
    expect(saved!.agents.coder).toMatchObject({ family: "gpt-6.1-sol-123", allowedProviders: ["cpa-gui"] });
    expect(await readModelResolutions(space.location, "fresh")).toMatchObject({ coder: "cpa-gui/gpt-6.1-sol-123", lead: "openai/gpt-5.5" });
    expect(selector.calls.map((call) => call.agent)).toEqual(expect.arrayContaining(["lead", "coder"]));
  });

  it("edits an existing profile and offers the current ID to the selector", async () => {
    setTty(true);
    const space = await workspace({ profiles: { openai: profiles.openai! } });
    Object.assign(script, { text: ["openai"], choose: ["edit", "openai", "select"], models: { coder: "cpa-gui/gpt-6.1-sol", researcher: "openai/gpt-5.5", "external-researcher": "openai/gpt-5.5" } });
    const result = await run("configure", "--destination", space.root);
    expect(result.ok).toBe(true);
    const edited = (await readModelProfileStore(space.location)).profiles.openai!;
    expect(JSON.stringify(edited.agents.coder)).toContain("cpa-gui");
    expect(JSON.stringify(edited.agents.lead)).toContain("openai");
    expect(selector.calls.find((call) => call.agent === "coder")?.current).toBe("openai/gpt-6.1-sol");
  });

  it("writes nothing when the final confirmation is declined", async () => {
    setTty(true);
    const space = await workspace({ profiles: {} });
    Object.assign(script, { text: ["declined"], choose: ["create", "new"], confirm: false, models: { lead: "openai/gpt-5.5", coder: "openai/gpt-6.1-sol" } });
    const before = await tree(sandbox.root);
    await run("configure", "--destination", space.root);
    expect(await tree(sandbox.root)).toEqual(before);
    expect(await activeProfile(space)).toBeUndefined();
    expect(await assigned(space, "lead")).toBeUndefined();
  });

  it("writes nothing when the wizard is cancelled", async () => {
    setTty(true);
    const space = await workspace({ profiles: {} });
    Object.assign(script, { text: [CANCEL] });
    const before = await tree(sandbox.root);
    await run("configure", "--destination", space.root);
    expect(await tree(sandbox.root)).toEqual(before);
  });

  it("does not persist during --dry-run", async () => {
    setTty(true);
    const space = await workspace({ profiles: {} });
    Object.assign(script, { text: ["preview"], choose: ["create", "new"], models: { lead: "openai/gpt-5.5", coder: "openai/gpt-6.1-sol" } });
    const before = await tree(sandbox.root);
    await run("configure", "--dry-run", "--destination", space.root);
    expect(await tree(sandbox.root)).toEqual(before);
    expect(await activeProfile(space)).toBeUndefined();
  });
});

describe("models use", () => {
  it("requires migration consent and preserves legacy models when declined", async () => {
    const space = await workspace({ profiles: { openai: profiles.openai! } });
    const file = path.join(agentDirectory(space.target), "coder.md");
    const text = (await readFile(file, "utf8")).replace("---\n", "---\nmodel: old/model\n");
    await writeFile(file, text);
    const manifestPath = path.join(space.root, ".toolkit/agents.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.installed.coder.hash = hashAgentContent(text);
    await writeFile(manifestPath, JSON.stringify(manifest));
    const before = await tree(space.root);
    expect((await run("use", "openai", "--non-interactive", ...scope(space))).ok).toBe(false);
    expect(await tree(space.root)).toEqual(before);
    setTty(true); script.confirm = false;
    await run("use", "openai", ...scope(space));
    expect(await tree(space.root)).toEqual(before);
    script.confirm = true;
    expect((await run("use", "openai", ...scope(space))).ok).toBe(true);
    expect(await readFile(file, "utf8")).not.toContain("model: old/model");
    expect(await assigned(space, "coder")).toBe("openai/gpt-6.1-sol");
    expect(await activeProfile(space)).toBe("openai");
  });
  it("round-trips openai, anthropic and openai, owning only the profile's agents", async () => {
    const space = await workspace();
    expect((await run("use", "openai", ...scope(space), "--non-interactive")).ok).toBe(true);
    expect(await assigned(space, "lead")).toBe("openai/gpt-5.5");
    expect(await assigned(space, "coder")).toBe("openai/gpt-6.1-sol");
    expect(await activeProfile(space)).toBe("openai");

    expect((await run("use", "anthropic", ...scope(space), "--non-interactive")).ok).toBe(true);
    expect(await assigned(space, "lead")).toBe("anthropic/claude-sonnet-4-5");
    expect(await assigned(space, "coder")).toBe("cpa-gui/claude-sonnet-5-5");
    expect(await activeProfile(space)).toBe("anthropic");

    expect((await run("use", "openai", ...scope(space), "--non-interactive")).ok).toBe(true);
    expect(await assigned(space, "lead")).toBe("openai/gpt-5.5");
    expect(await assigned(space, "researcher")).toBeUndefined();
    expect(await readModelResolutions(space.location, "openai")).toEqual({ coder: "openai/gpt-6.1-sol", lead: "openai/gpt-5.5" });
  });

  it("applies to the isolated global scope only when --global is used", async () => {
    const project = await workspace();
    const global = await workspace({ global: true });
    const projectBefore = await tree(project.root);
    expect((await run("use", "openai", "--global", "--non-interactive")).ok).toBe(true);
    expect(await assigned(global, "lead")).toBe("openai/gpt-5.5");
    expect(await tree(project.root)).toEqual(projectBefore);
  });

  it("previews with --dry-run and changes neither configuration nor active state", async () => {
    const space = await workspace({ active: "anthropic" });
    const before = await tree(sandbox.root);
    const result = await run("use", "openai", "--dry-run", "--non-interactive", ...scope(space));
    expect(result.ok).toBe(true);
    expect(result.all).toContain("openai/gpt-5.5");
    expect(await tree(sandbox.root)).toEqual(before);
  });

  it("fails for an unknown profile without touching anything", async () => {
    const space = await workspace({ active: "openai" });
    const before = await tree(sandbox.root);
    const result = await run("use", "missing", "--non-interactive", ...scope(space));
    expect(result.ok).toBe(false);
    expect(result.all).toMatch(/missing|not found|unknown|does not exist/i);
    expect(await tree(sandbox.root)).toEqual(before);
  });

  it("fails an unresolved profile and keeps the previous active profile and assignments", async () => {
    const space = await workspace();
    await run("use", "openai", ...scope(space), "--non-interactive");
    const before = await tree(sandbox.root);
    const result = await run("use", "partial", ...scope(space), "--non-interactive");
    expect(result.ok).toBe(false);
    expect(result.all).toMatch(/not-installed|unavailable|unresolved|no match|blocked/i);
    expect(await activeProfile(space)).toBe("openai");
    expect(await tree(sandbox.root)).toEqual(before);
  });

  it("fails when a managed agent was modified and never rewrites it", async () => {
    const space = await workspace();
    const file = path.join(agentDirectory(space.target), "coder.md");
    await writeFile(file, "edited by the user\n");
    const before = await tree(sandbox.root);
    const result = await run("use", "openai", ...scope(space), "--non-interactive");
    expect(result.ok).toBe(false);
    expect(result.all).toMatch(/coder|modified/i);
    expect(await tree(sandbox.root)).toEqual(before);
    expect(hashAgentContent((await readText(file))!)).toBe(hashAgentContent("edited by the user\n"));
  });

  describe("protected assignments", () => {
    const user = '{\n  "agents": {\n    "lead": {"model": "other/lead-choice"},\n    "coder": {"model": "other/coder-choice"}\n  }\n}\n';

    it("fails non-interactively without consent and changes nothing", async () => {
      const space = await workspace();
      await writeFile(configPath(space), user);
      const before = await tree(sandbox.root);
      const result = await run("use", "openai", ...scope(space), "--non-interactive");
      expect(result.ok).toBe(false);
      expect(result.all).toMatch(/lead|consent|conflict|protected|replace/i);
      expect(await tree(sandbox.root)).toEqual(before);
      expect(script.seenPrompts).toEqual([]);
    });

    it("never prompts without a terminal, even when --non-interactive is omitted", async () => {
      const space = await workspace();
      await writeFile(configPath(space), user);
      const result = await run("use", "openai", ...scope(space));
      expect(result.ok).toBe(false);
      expect(script.seenPrompts).toEqual([]);
      expect(await readText(configPath(space))).toBe(user);
    });

    it("replaces every protected assignment the user consents to interactively", async () => {
      setTty(true);
      const space = await workspace();
      await writeFile(configPath(space), user);
      script.consent = "all";
      const result = await run("use", "openai", ...scope(space));
      expect(result.ok).toBe(true);
      expect(await assigned(space, "lead")).toBe("openai/gpt-5.5");
      expect(await assigned(space, "coder")).toBe("openai/gpt-6.1-sol");
      const backups = (await readdir(space.root)).filter((file) => file.startsWith("opencode.jsonc.") && file.endsWith(".bak"));
      expect(backups.length).toBeGreaterThan(0);
      expect(await readText(path.join(space.root, backups[0]!))).toBe(user);
    });

    it("applies nothing when consent covers only some conflicting agents", async () => {
      setTty(true);
      const space = await workspace();
      await writeFile(configPath(space), user);
      script.consent = ["lead"];
      await run("use", "openai", ...scope(space));
      expect(await assigned(space, "coder")).not.toBe("openai/gpt-6.1-sol");
      expect(await activeProfile(space)).toBeUndefined();
    });

    it("keeps user models when consent is declined", async () => {
      setTty(true);
      const space = await workspace();
      await writeFile(configPath(space), user);
      script.consent = "none";
      script.confirm = false;
      await run("use", "openai", ...scope(space));
      expect(await readText(configPath(space))).toBe(user);
      expect(await activeProfile(space)).toBeUndefined();
    });
  });

  describe("ambiguous preferences", () => {
    it("fails non-interactively without choosing a provider", async () => {
      const space = await workspace();
      const before = await tree(sandbox.root);
      const result = await run("use", "shared", ...scope(space), "--non-interactive");
      expect(result.ok).toBe(false);
      expect(result.all).toMatch(/ambiguous|multiple|candidates|choose|select/i);
      expect(await tree(sandbox.root)).toEqual(before);
      expect(selector.calls).toEqual([]);
    });

    it("lets a terminal user choose among the valid candidates and saves the exact choice", async () => {
      setTty(true);
      const space = await workspace();
      script.models.lead = "openai/gpt-5.5";
      script.choose = ["openai/gpt-5.5"];
      const result = await run("use", "shared", ...scope(space));
      expect(result.ok).toBe(true);
      expect(await assigned(space, "lead")).toBe("openai/gpt-5.5");
      expect(await readModelResolutions(space.location, "shared")).toEqual({ lead: "openai/gpt-5.5" });
      for (const call of selector.calls) expect(call.ids.sort()).toEqual(["cpa-gui/gpt-5.5", "openai/gpt-5.5"]);
    });

    it("leaves everything unchanged when the user cancels the choice", async () => {
      setTty(true);
      const space = await workspace();
      script.models.lead = CANCEL as unknown as symbol;
      script.choose = ["cancel"];
      const before = await tree(sandbox.root);
      await run("use", "shared", ...scope(space));
      expect(await tree(sandbox.root)).toEqual(before);
    });
  });
});

describe("models set", () => {
  async function activated(): Promise<IWorkspace> {
    const space = await workspace();
    await run("use", "openai", ...scope(space), "--non-interactive");
    return space;
  }

  it("requires an active profile", async () => {
    const space = await workspace();
    const before = await tree(sandbox.root);
    const result = await run("set", "coder", "cpa-gui/gpt-6.1-sol", "--non-interactive", ...scope(space));
    expect(result.ok).toBe(false);
    expect(result.all).toMatch(/active|profile|use/i);
    expect(await tree(sandbox.root)).toEqual(before);
  });

  it("assigns one agent directly and leaves every other agent and preference untouched", async () => {
    const space = await activated();
    const leadPreference = (await readModelProfileStore(space.location)).profiles.openai!.agents.lead;
    const result = await run("set", "coder", "cpa-gui/gpt-6.1-sol", "--non-interactive", ...scope(space));
    expect(result.ok).toBe(true);
    expect(await assigned(space, "coder")).toBe("cpa-gui/gpt-6.1-sol");
    expect(await assigned(space, "lead")).toBe("openai/gpt-5.5");
    const stored = (await readModelProfileStore(space.location)).profiles;
    expect(stored.openai!.agents.lead).toEqual(leadPreference);
    expect(JSON.stringify(stored.openai!.agents.coder)).toContain("cpa-gui");
    expect(stored.anthropic).toEqual(profiles.anthropic);
    expect(await activeProfile(space)).toBe("openai");
    expect(await readModelResolutions(space.location, "openai")).toMatchObject({ coder: "cpa-gui/gpt-6.1-sol", lead: "openai/gpt-5.5" });
  });

  it("saves the preserved normalized family plus provider as the preference, and the exact ID locally", async () => {
    const space = await activated();
    expect((await run("set", "coder", "cpa-gui/gpt-6.1-sol-123", "--non-interactive", ...scope(space))).ok).toBe(true);
    expect(await assigned(space, "coder")).toBe("cpa-gui/gpt-6.1-sol-123");
    // No guessing whether a trailing number is a suffix or part of the model name: the suffix is preserved.
    expect((await readModelProfileStore(space.location)).profiles.openai!.agents.coder).toMatchObject({ family: "gpt-6.1-sol-123", allowedProviders: ["cpa-gui"] });
    expect(await readModelResolutions(space.location, "openai")).toMatchObject({ coder: "cpa-gui/gpt-6.1-sol-123" });
  });

  it("rejects an ID that discovery does not report and leaves preferences intact", async () => {
    const space = await activated();
    const before = await tree(sandbox.root);
    const result = await run("set", "coder", "cpa-gui/not-discovered", "--non-interactive", ...scope(space));
    expect(result.ok).toBe(false);
    expect(result.all).toMatch(/not-discovered|not found|unknown|discover/i);
    expect(await tree(sandbox.root)).toEqual(before);
  });

  it("previews with --dry-run and persists nothing", async () => {
    const space = await activated();
    const before = await tree(sandbox.root);
    const result = await run("set", "coder", "cpa-gui/gpt-6.1-sol", "--dry-run", "--non-interactive", ...scope(space));
    expect(result.ok).toBe(true);
    expect(await tree(sandbox.root)).toEqual(before);
  });

  it("keeps the prior portable preference when application is blocked", async () => {
    const space = await activated();
    await writeFile(path.join(agentDirectory(space.target), "coder.md"), "edited by the user\n");
    const before = await tree(sandbox.root);
    const result = await run("set", "coder", "cpa-gui/gpt-6.1-sol", "--non-interactive", ...scope(space));
    expect(result.ok).toBe(false);
    expect(await tree(sandbox.root)).toEqual(before);
  });

  it("refuses to open a selector without a terminal when no model is given", async () => {
    const space = await activated();
    const before = await tree(sandbox.root);
    const result = await run("set", "coder", ...scope(space));
    expect(result.ok).toBe(false);
    expect(result.all).toMatch(/terminal|interactive|TTY|provider\/model/i);
    expect(await tree(sandbox.root)).toEqual(before);
  });

  it("uses the searchable selector on a terminal, offering discovered IDs and the current one", async () => {
    const space = await activated();
    setTty(true);
    script.models.coder = "cpa-gui/gpt-6.1-sol";
    const result = await run("set", "coder", ...scope(space));
    expect(result.ok).toBe(true);
    expect(selector.calls).toHaveLength(1);
    expect(selector.calls[0]).toMatchObject({ agent: "coder", current: "openai/gpt-6.1-sol" });
    expect(selector.calls[0]!.ids).toEqual(expect.arrayContaining(inventory));
    expect(await assigned(space, "coder")).toBe("cpa-gui/gpt-6.1-sol");
    expect(await assigned(space, "lead")).toBe("openai/gpt-5.5");
  });

  it("changes nothing when the selector is cancelled", async () => {
    const space = await activated();
    setTty(true);
    script.models.coder = CANCEL as unknown as symbol;
    const before = await tree(sandbox.root);
    await run("set", "coder", ...scope(space));
    expect(await tree(sandbox.root)).toEqual(before);
  });

  it("changes only the global scope with --global", async () => {
    const project = await activated();
    const global = await workspace({ global: true, active: "openai" });
    await run("use", "openai", "--global", "--non-interactive");
    const projectBefore = await tree(project.root);
    expect((await run("set", "coder", "cpa-gui/gpt-6.1-sol", "--global", "--non-interactive")).ok).toBe(true);
    expect(await assigned(global, "coder")).toBe("cpa-gui/gpt-6.1-sol");
    expect(await tree(project.root)).toEqual(projectBefore);
  });
});

describe("models status", () => {
  it("reports saved, local and applied state as read-only JSON without discovery", async () => {
    const space = await workspace();
    await run("use", "openai", ...scope(space), "--non-interactive");
    discovery.reads = 0;
    discovery.error = new Error("OpenCode is not installed");
    const before = await tree(sandbox.root);
    const result = await run("status", "--json", ...scope(space));
    expect(result.ok).toBe(true);
    const values = strings(result.json());
    expect(values).toEqual(expect.arrayContaining(["openai", "lead", "coder", "openai/gpt-5.5", "openai/gpt-6.1-sol"]));
    expect(discovery.reads).toBe(0);
    expect(await tree(sandbox.root)).toEqual(before);
  });

  it("succeeds on an uninitialized project without creating anything", async () => {
    const root = path.join(sandbox.root, "bare");
    await mkdir(root);
    const result = await run("status", "--json", "--destination", root);
    expect(result.ok).toBe(true);
    expect(() => result.json()).not.toThrow();
    expect(await readdir(root)).toEqual([]);
  });

  it("surfaces competing OpenCode configuration files instead of choosing one", async () => {
    const space = await workspace({ active: "openai" });
    await writeFile(path.join(space.root, "opencode.json"), "{}\n");
    await writeFile(configPath(space), "{}\n");
    const before = await tree(sandbox.root);
    const result = await run("status", "--json", ...scope(space));
    expect(`${result.all}`).toContain("opencode.json");
    expect(await tree(sandbox.root)).toEqual(before);
  });

  it("reports global status from the isolated root only", async () => {
    const project = await workspace({ active: "openai" });
    const global = await workspace({ global: true, profiles: { globalonly: { agents: {} } }, active: "globalonly" });
    const result = await run("status", "--global", "--json");
    expect(result.ok).toBe(true);
    const values = strings(result.json());
    expect(values).toContain("globalonly");
    expect(values).not.toContain(project.root);
    expect(global.root.startsWith(sandbox.root)).toBe(true);
  });
});
