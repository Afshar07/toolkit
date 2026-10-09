import { describe, expect, it } from "vitest";
import { createOpenCodeModelSource, discoverModels } from "../../src/models/index.js";

// A fake CLI built from the current Node executable: portable and independent of OpenCode.
function nodeSource(script: string, options: { timeoutMs?: number; maxOutputBytes?: number; environment?: Record<string, string> } = {}) {
  return createOpenCodeModelSource({ command: process.execPath, arguments: ["--eval", script], ...options });
}

describe("createOpenCodeModelSource", () => {
  it("reads stdout from a subprocess and feeds discovery", async () => {
    const source = createOpenCodeModelSource({ command: process.execPath, arguments: ["--eval", "console.log('cpa-gui/gpt-image-2.5\\nopenai/gpt-5.5')"] });
    const inventory = await discoverModels({ source });
    expect(inventory.models.map((model) => model.id)).toEqual(["cpa-gui/gpt-image-2.5", "openai/gpt-5.5"]);
  });

  it("reports an unavailable CLI with an actionable message", async () => {
    const source = createOpenCodeModelSource({ command: "toolkit-definitely-not-installed-opencode" });
    await expect(discoverModels({ source })).rejects.toMatchObject({
      name: "ModelDiscoveryError",
      kind: "unavailable",
      message: expect.stringContaining("not found"),
    });
  });

  it("times out stalled processes", async () => {
    const source = nodeSource("setTimeout(() => {}, 30000)", { timeoutMs: 300 });
    await expect(source.read()).rejects.toMatchObject({ kind: "timeout", message: expect.stringContaining("300ms") });
  }, 15_000);

  it("reports non-zero exits with a bounded stderr summary", async () => {
    const source = nodeSource("console.error('line one\\nline two ' + 'x'.repeat(500)); process.exit(3)");
    const error = await source.read().catch((caught: unknown) => caught as { kind: string; exitCode: number; message: string });
    expect(error).toMatchObject({ kind: "exit", exitCode: 3 });
    expect(error.message).toContain("line one line two");
    expect(error.message.length).toBeLessThan(300);
  });

  it("enforces an output size limit", async () => {
    const source = nodeSource("process.stdout.write('a/b\\n'.repeat(10000))", { maxOutputBytes: 1024 });
    await expect(source.read()).rejects.toMatchObject({ kind: "output-too-large" });
  });

  it("passes arguments without shell interpolation", async () => {
    const marker = "$(echo injected);`echo injected`;& echo injected | echo injected";
    const source = createOpenCodeModelSource({ command: process.execPath, arguments: ["--eval", "console.log('x/' + process.argv.at(-1).length)", marker] });
    await expect(source.read()).resolves.toBe(`x/${marker.length}`);
  });

  it("merges explicit environment values without leaking them into errors", async () => {
    const secret = "sk-test-secret-value";
    const ok = nodeSource("console.log('env/' + process.env.TOOLKIT_TEST_VALUE)", { environment: { TOOLKIT_TEST_VALUE: "set" } });
    await expect(ok.read()).resolves.toBe("env/set");
    const failing = nodeSource("process.exit(2)", { environment: { API_KEY: secret } });
    const error = await failing.read().catch((caught: unknown) => caught as Error);
    expect(error.message).not.toContain(secret);
  });

  it("validates options eagerly", () => {
    expect(() => createOpenCodeModelSource({ command: " " })).toThrow(TypeError);
    expect(() => createOpenCodeModelSource({ timeoutMs: 0 })).toThrow(TypeError);
    expect(() => createOpenCodeModelSource({ maxOutputBytes: -1 })).toThrow(TypeError);
  });

  it("treats help text printed with a successful exit as malformed output", async () => {
    const source = createOpenCodeModelSource({ command: process.execPath, arguments: ["--eval", "console.log('USAGE\\n  opencode models [flags]')"] });
    await expect(discoverModels({ source })).rejects.toMatchObject({ kind: "malformed-output" });
  });
});
