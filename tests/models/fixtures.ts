import type { IModelDiscoverySource } from "../../src/models/index.js";

export function fixtureSource(output: string): IModelDiscoverySource {
  return { read: async () => output };
}

/** Mirrors real `opencode models` output: one complete provider/model ID per line. */
export const standardOutput = [
  "openai/gpt-5.5",
  "openai/gpt-5.5-fast",
  "openai/gpt-6.1-sol",
  "opencode/big-pickle",
  "anthropic/claude-sonnet-4-5",
  "cpa-gui/claude-sonnet-5-5",
  "cpa-gui/gpt-5.5",
  "cpa-gui/gpt-image-2.5-flare",
  "openrouter/anthropic/claude-3.5-sonnet",
].join("\n");
