import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateRun, gate, latestRelevantRun } from "../../scripts/release-gate.mjs";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn(() => "a".repeat(40)) }));
afterEach(() => vi.unstubAllGlobals());

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
  it("queries only Release Verify with exact SHA, default branch, and push event", async () => {
    const fetch = vi.fn(async (_url: string) => ({ ok: true, json: async () => ({ workflow_runs: [{ id: 1, run_attempt: 1, head_sha: sha, event: "push", status: "completed", conclusion: "success" }] }) }));
    vi.stubGlobal("fetch", fetch);
    await expect(gate({ repository: "owner/toolkit", tag: "v1.0.0", defaultBranch: "main", timeoutMs: 0 })).resolves.toBe(sha);
    expect(fetch.mock.calls[0][0]).toBe(`https://api.github.com/repos/owner/toolkit/actions/workflows/release-verify.yml/runs?branch=main&event=push&head_sha=${sha}&per_page=100`);
  });
  it("cannot use ordinary Verify success when Release Verify is missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => ({ workflow_runs: url.includes("/workflows/verify.yml/") ? [{ id: 1, run_attempt: 1, head_sha: sha, event: "push", status: "completed", conclusion: "success" }] : [] }) })));
    await expect(gate({ repository: "owner/toolkit", tag: "v1.0.0", defaultBranch: "main", timeoutMs: 0 })).rejects.toThrow("No qualifying Release Verify run found");
  });
  it.each(["failure", "cancelled", "skipped"])("rejects latest Release Verify %s despite prior success", async (conclusion) => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ workflow_runs: [
      { id: 1, run_attempt: 1, head_sha: sha, event: "push", status: "completed", conclusion: "success" },
      { id: 1, run_attempt: 2, head_sha: sha, event: "push", status: "completed", conclusion },
    ] }) })));
    await expect(gate({ repository: "owner/toolkit", tag: "v1.0.0", defaultBranch: "main", timeoutMs: 0 })).rejects.toThrow(`Latest Release Verify run attempt for ${sha} concluded ${conclusion}`);
  });
});
