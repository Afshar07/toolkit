import { ModelProfileError } from "../profiles/errors.js";
import { assertAgentName } from "../profiles/names.js";
import { isCompleteModelId } from "../profiles/schema.js";
import type { IModelProfile, ModelResolutionSelections } from "../profiles/types.js";

/** Validates an agent filter against the profile; returns unique names in request order. */
export function selectedAgents(agents: readonly string[], profile: IModelProfile): string[] {
  if (!Array.isArray(agents) || agents.length === 0) throw new ModelProfileError("invalid-input", "Selected agents must be a non-empty list.");
  const unique = [...new Set(agents)];
  for (const agent of unique) {
    assertAgentName(agent);
    if (!Object.hasOwn(profile.agents, agent)) throw new ModelProfileError("invalid-input", `Agent "${agent}" is not defined by the profile.`);
  }
  return unique;
}

/** Validates plan-only exact selections: valid agent names and complete IDs, limited to the agents being planned. */
export function validatedSelections(selections: ModelResolutionSelections | undefined, profile: IModelProfile): ModelResolutionSelections {
  const checked: Record<string, string> = {};
  for (const [agent, id] of Object.entries(selections ?? {})) {
    assertAgentName(agent);
    if (!isCompleteModelId(id)) throw new ModelProfileError("invalid-input", `Selection for "${agent}" must be a complete, valid provider/model ID.`);
    if (!Object.hasOwn(profile.agents, agent)) throw new ModelProfileError("invalid-input", `Selection names agent "${agent}", which is not being planned.`);
    checked[agent] = id;
  }
  return checked;
}

export function pick(selections: ModelResolutionSelections, agents: readonly string[]): ModelResolutionSelections {
  return Object.fromEntries(agents.filter((agent) => Object.hasOwn(selections, agent)).map((agent) => [agent, selections[agent]!]));
}
