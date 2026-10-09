import * as path from "pathe";
import { agentDirectory, resolveAgentTarget, type AgentTarget } from "../../agents/target.js";
import { inspectOpenCodeConfig } from "./config-files.js";
import { readConfigAgentModel } from "./jsonc-editor.js";
import { inspectMarkdownModel } from "./markdown-model.js";
import { readSafeText } from "./safe-write.js";
import { assertAgentName } from "../profiles/names.js";

export interface IInspectEffectiveModelsOptions {
  readonly agents: readonly string[];
  readonly global?: AgentTarget;
  readonly project?: string;
}
export interface IEffectiveAgentModel {
  readonly agent: string;
  readonly configuredGlobal: unknown;
  readonly configuredProject: unknown;
  readonly effective: unknown;
  readonly source: "project-markdown" | "project-config" | "global-markdown" | "global-config" | "default" | "unknown";
}
export interface IEffectiveModelInspection {
  readonly agents: readonly IEffectiveAgentModel[];
  readonly conflicts: readonly string[];
  readonly limitations: readonly string[];
}

/** Static file inspection of the verified v2.0.25 precedence, not session/live inference. */
export async function inspectEffectiveOpenCodeModels(options: IInspectEffectiveModelsOptions): Promise<IEffectiveModelInspection> {
  const globalTarget = options.global ? resolveAgentTarget(options.global) : undefined;
  const projectTarget = options.project ? resolveAgentTarget(options.project) : undefined;
  const global = globalTarget ? await inspectOpenCodeConfig(globalTarget) : undefined;
  const project = projectTarget ? await inspectOpenCodeConfig(projectTarget) : undefined;
  const conflicts = [global, project].flatMap((item) => item?.status === "config-conflict" ? [...item.files] : []);
  const agents: IEffectiveAgentModel[] = [];
  for (const agent of options.agents) {
    assertAgentName(agent);
    const globalText = globalTarget ? await readSafeText(globalTarget, path.join(agentDirectory(globalTarget), `${agent}.md`)) : undefined;
    const projectText = projectTarget ? await readSafeText(projectTarget, path.join(agentDirectory(projectTarget), `${agent}.md`)) : undefined;
    const configuredGlobal = global?.status === "ready" ? readConfigAgentModel(global.file.value, agent) : undefined;
    const configuredProject = project?.status === "ready" ? readConfigAgentModel(project.file.value, agent) : undefined;
    const globalModel = globalText === undefined ? undefined : inspectMarkdownModel(globalText).model;
    const projectModel = projectText === undefined ? undefined : inspectMarkdownModel(projectText).model;
    const source = conflicts.length ? "unknown" : projectModel !== undefined ? "project-markdown" : configuredProject !== undefined ? "project-config"
      : globalModel !== undefined ? "global-markdown" : configuredGlobal !== undefined ? "global-config" : "default";
    const effective = source === "unknown" ? undefined : projectModel ?? configuredProject ?? globalModel ?? configuredGlobal;
    agents.push({ agent, configuredGlobal, configuredProject, effective, source });
  }
  return { agents, conflicts, limitations: ["Static files only: environment config, remote/organization config, default models and existing session model selections are not evaluated.", "Global effectiveness outside the supplied project context is unknown."] };
}
