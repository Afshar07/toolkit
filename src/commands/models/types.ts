import type { IAgentTarget } from "../../agents/target.js";
export interface IModelCommandOptions {
  readonly target: IAgentTarget;
  readonly interactive: boolean;
  readonly dryRun: boolean;
}
