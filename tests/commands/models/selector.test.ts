import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { filterModelsByQuery, matchesModelQuery, selectModel } from "../../../src/commands/models/selector.js";

const models = [
  { id: "anthropic/claude-sonnet-4-5" },
  { id: "openai/gpt-5.5" },
  { id: "openrouter/anthropic/claude-3.5-sonnet" },
  { id: "openai/o3" },
];

function terminal(tty = true) {
  const input = Object.assign(new PassThrough(), { isTTY: tty, setRawMode: () => input });
  const output = Object.assign(new PassThrough(), { isTTY: tty, columns: 100, rows: 30 });
  let text = "";
  output.on("data", (chunk: Buffer) => {
    text += chunk.toString();
  });
  return { input, output, text: () => text };
}

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(keys: readonly string[], options: Parameters<typeof selectModel>[1] = {}, list = models) {
  const io = terminal();
  const result = selectModel(list, { ...options, input: io.input, output: io.output });
  await settle();
  for (const key of keys) {
    io.input.write(key);
    await settle();
  }
  return { result: await result, text: io.text() };
}

describe("matchesModelQuery", () => {
  it("matches everything for an empty or blank query", () => {
    expect(matchesModelQuery("openai/gpt-5.5", "")).toBe(true);
    expect(matchesModelQuery("openai/gpt-5.5", "   ")).toBe(true);
  });

  it("ignores case in both query and ID", () => {
    expect(matchesModelQuery("OpenAI/GPT-5.5", "openai gpt")).toBe(true);
    expect(matchesModelQuery("openai/gpt-5.5", "GPT")).toBe(true);
  });

  it("matches in-order subsequences across separators", () => {
    expect(matchesModelQuery("openai/gpt-5.5", "gpt55")).toBe(true);
    expect(matchesModelQuery("openai/gpt-5.5", "ogpt")).toBe(true);
  });

  it("rejects out-of-order characters and missing terms", () => {
    expect(matchesModelQuery("openai/gpt-5.5", "tpg")).toBe(false);
    expect(matchesModelQuery("openai/gpt-5.5", "gpt claude")).toBe(false);
  });

  it("requires every whitespace-separated term", () => {
    expect(matchesModelQuery("openrouter/anthropic/claude-3.5-sonnet", "router sonnet")).toBe(true);
  });
});

describe("filterModelsByQuery", () => {
  it("preserves input order and does not mutate the input", () => {
    const input = [...models];
    expect(filterModelsByQuery(input, "anthropic").map((model) => model.id)).toEqual([
      "anthropic/claude-sonnet-4-5",
      "openrouter/anthropic/claude-3.5-sonnet",
    ]);
    expect(input).toEqual(models);
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterModelsByQuery(models, "zzz")).toEqual([]);
  });

  it("is deterministic for repeated calls and large lists", () => {
    const large = Array.from({ length: 5000 }, (_, index) => ({ id: `provider-${index % 7}/model-${index}` }));
    const first = filterModelsByQuery(large, "provider-3/ model-42");
    expect(first.length).toBeGreaterThan(0);
    expect(filterModelsByQuery(large, "provider-3/ model-42")).toEqual(first);
    expect(first.every((model) => model.id.startsWith("provider-3/"))).toBe(true);
  });
});

describe("selectModel", () => {
  it("rejects a non-interactive input with an actionable error", async () => {
    const io = terminal(false);
    await expect(selectModel(models, { input: io.input, output: io.output })).rejects.toThrow(/requires a terminal.*exact provider\/model ID/s);
  });

  it("rejects a non-interactive output", async () => {
    const io = terminal();
    const output = Object.assign(new PassThrough(), { isTTY: false });
    await expect(selectModel(models, { input: io.input, output })).rejects.toThrow("requires a terminal");
  });

  it("rejects an empty model list with an actionable error", async () => {
    const io = terminal();
    await expect(selectModel([], { input: io.input, output: io.output })).rejects.toThrow("opencode models");
  });

  it("returns the first listed exact ID on Enter", async () => {
    const { result } = await run(["\r"]);
    expect(result).toBe("anthropic/claude-sonnet-4-5");
  });

  it("returns the complete ID of a model chosen by searching", async () => {
    const { result } = await run(["r", "o", "u", "t", "e", "r", "\r"]);
    expect(result).toBe("openrouter/anthropic/claude-3.5-sonnet");
  });

  it("returns undefined when cancelled with Escape", async () => {
    const { result } = await run(["\u001b"]);
    expect(result).toBeUndefined();
  });

  it("returns undefined when cancelled with Ctrl+C", async () => {
    const { result } = await run(["\u0003"]);
    expect(result).toBeUndefined();
  });

  it("marks the current model and focuses it initially", async () => {
    const { result, text } = await run(["\r"], { current: "openai/gpt-5.5", agent: "reviewer" });
    expect(result).toBe("openai/gpt-5.5");
    expect(text).toContain("openai/gpt-5.5 (current)");
    expect(text).toContain("for reviewer");
  });

  it("does not select anything when the search has no matches", async () => {
    const { result, text } = await run(["z", "z", "z", "\r", "\u001b"]);
    expect(result).toBeUndefined();
    expect(text).toContain("No matches found");
  });

  it("reports a current model that is absent from the list without marking another", async () => {
    const { text } = await run(["\u001b"], { current: "openai/missing" });
    expect(text).toContain("openai/missing, not in the list");
    expect(text).not.toContain("(current)");
  });

  it("collapses duplicate IDs", async () => {
    const { result } = await run(["\u001b[B", "\r"], {}, [{ id: "a/one" }, { id: "a/one" }, { id: "a/two" }]);
    expect(result).toBe("a/two");
  });

  it("limits the visible list for large inputs", async () => {
    const large = Array.from({ length: 500 }, (_, index) => ({ id: `p/model-${String(index).padStart(3, "0")}` }));
    const { result, text } = await run(["4", "9", "9", "\r"], {}, large);
    expect(result).toBe("p/model-499");
    expect(text).not.toContain("p/model-020");
  });
});
