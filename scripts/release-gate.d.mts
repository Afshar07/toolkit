export interface IWorkflowRun {
  id: number;
  run_attempt: number;
  head_sha: string;
  event: string;
  status: string;
  conclusion: string | null;
}
export function latestRelevantRun(runs: IWorkflowRun[], sha: string): IWorkflowRun | undefined;
export function evaluateRun(run: Pick<IWorkflowRun, "status" | "conclusion"> | undefined): "missing" | "pending" | "success" | "failed";
