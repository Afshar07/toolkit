import { describe, expect, it } from "vitest";
import { evaluateRun, latestRelevantRun } from "../../scripts/release-gate.mjs";

describe("release verification gate selection", () => {
  const sha = "a".repeat(40);
  it("accepts only a completed successful exact-SHA push run", () => {
    expect(evaluateRun(latestRelevantRun([{ id: 1, run_attempt: 1, head_sha: sha, event: "push", status: "completed", conclusion: "success" }], sha))).toBe("success");
  });
  it("does not select a successful run for another SHA or a PR event", () => {
    expect(latestRelevantRun([{ id: 1, run_attempt: 1, head_sha: "b".repeat(40), event: "push", status: "completed", conclusion: "success" }, { id: 2, run_attempt: 1, head_sha: sha, event: "pull_request", status: "completed", conclusion: "success" }], sha)).toBeUndefined();
  });
  it.each([["queued", null, "pending"], ["in_progress", null, "pending"], ["completed", "failure", "failed"], ["completed", "cancelled", "failed"], ["completed", "skipped", "failed"]])("classifies %s/%s", (status, conclusion, expected) => {
    expect(evaluateRun({ status, conclusion })).toBe(expected);
  });
  it("uses the latest run attempt so an old success cannot hide a failure", () => {
    const run = latestRelevantRun([{ id: 10, run_attempt: 1, head_sha: sha, event: "push", status: "completed", conclusion: "success" }, { id: 11, run_attempt: 2, head_sha: sha, event: "push", status: "completed", conclusion: "failure" }], sha);
    expect(run?.id).toBe(11);
  });
  it("classifies a missing run", () => expect(evaluateRun(undefined)).toBe("missing"));
});
