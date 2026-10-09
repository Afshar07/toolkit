import type { Readable, Writable } from "node:stream";
import { autocomplete, isCancel } from "@clack/prompts";
import type { IModelRef } from "../../models/types.js";

const MAX_VISIBLE_ITEMS = 10;

export interface ISelectModelOptions {
  /** Agent the model is being chosen for; shown in the prompt message. */
  readonly agent?: string;
  /** Exact `provider/model` ID currently in use; marked in the list and focused first when present. */
  readonly current?: string;
  /** Terminal input. Defaults to `process.stdin`. */
  readonly input?: Readable;
  /** Terminal output. Defaults to `process.stdout`. */
  readonly output?: Writable;
}

/**
 * Case-insensitive fuzzy match. The query is split on whitespace and every term must appear in
 * `id` as an in-order subsequence (`gpt5` matches `openai/gpt-5.5`). An empty query matches all.
 */
export function matchesModelQuery(id: string, query: string): boolean {
  const target = id.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term !== "")
    .every((term) => isSubsequence(term, target));
}

/** Filters by {@link matchesModelQuery}. Input order is preserved; the input is never mutated. */
export function filterModelsByQuery<T extends Pick<IModelRef, "id">>(models: readonly T[], query: string): T[] {
  return models.filter((model) => matchesModelQuery(model.id, query));
}

/**
 * Prompts for one model with a searchable list and returns its exact, complete ID.
 * Returns `undefined` when the user cancels (Escape or Ctrl+C). Throws an actionable error
 * when no terminal is attached or no models are available. Never persists or resolves anything.
 */
export async function selectModel(models: readonly Pick<IModelRef, "id">[], options: ISelectModelOptions = {}): Promise<string | undefined> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (!isTerminal(input) || !isTerminal(output)) {
    throw new Error("Interactive model selection requires a terminal (TTY). Run it from an interactive terminal, or provide an exact provider/model ID instead.");
  }

  const ids = [...new Set(models.map((model) => model.id))];
  if (ids.length === 0) {
    throw new Error("No models are available to select. Run `opencode models` to check that OpenCode reports models, then try again.");
  }

  const current = options.current !== undefined && ids.includes(options.current) ? options.current : undefined;
  const target = options.agent ? ` for ${options.agent}` : "";
  const note = options.current !== undefined && current === undefined ? ` (current: ${options.current}, not in the list)` : "";

  const selected = await autocomplete<string>({
    message: `Select a model${target}${note}`,
    options: ids.map((id) => ({ value: id, label: id === current ? `${id} (current)` : id })),
    initialValue: current,
    maxItems: MAX_VISIBLE_ITEMS,
    placeholder: "Type to search",
    filter: (search, option) => matchesModelQuery(option.value, search),
    validate: (value) => (typeof value === "string" ? undefined : "No model matches the search. Edit the search text to choose a model, or press Escape to cancel."),
    input,
    output,
  });
  return isCancel(selected) ? undefined : selected;
}

function isSubsequence(term: string, target: string): boolean {
  let position = 0;
  for (const character of term) {
    position = target.indexOf(character, position);
    if (position === -1) return false;
    position += 1;
  }
  return true;
}

function isTerminal(stream: Readable | Writable): boolean {
  return (stream as { isTTY?: boolean }).isTTY === true;
}
