import { describe, expect, it } from "vitest";
import { parseOptions, pollVerify, release } from "../../scripts/release.mjs";

const sha = "a".repeat(40);
const other = "b".repeat(40);
const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
const fail = (stderr: string) => ({ exitCode: 1, stdout: "", stderr });

function fixture(overrides: Record<string, ReturnType<typeof ok>> = {}) {
  const calls: string[] = [];
  let version = "1.0.6";
  let bumped = false;
  const runner = async (command: string, args: string[]) => {
    const key = `${command} ${args.join(" ")}`;
    calls.push(key);
    if (overrides[key]) return overrides[key];
    if (command === "npm" && args[0] === "version") { version = "1.0.7"; bumped = true; }
    if (key.startsWith("git remote get-url")) return ok("git@github.com:owner/toolkit.git");
    if (key.startsWith("gh repo view")) return ok(JSON.stringify({ nameWithOwner: "owner/toolkit", defaultBranchRef: { name: "main" }, viewerPermission: "WRITE" }));
    if (key === "git branch --show-current") return ok("main");
    if (key === "git rev-parse HEAD") return ok(sha);
    if (key.startsWith("git status")) return ok(bumped ? " M package.json\n M package-lock.json\n" : "");
    if (key.startsWith("gh api repos/owner/toolkit/releases/tags/")) return fail("gh: Not Found (HTTP 404)");
    return ok();
  };
  return { calls, runner, readPackage: async () => ({ version }), log: () => {}, poll: async () => { calls.push("Verify success"); } };
}

describe("release orchestration (injected commands only)", () => {
  it("defaults to patch and validates arguments", () => {
    expect(parseOptions([])).toEqual({ bump: "patch" });
    expect(parseOptions(["minor"])).toEqual({ bump: "minor" });
    expect(parseOptions(["major"])).toEqual({ bump: "major" });
    expect(parseOptions(["--resume"])).toEqual({ resume: true });
    expect(() => parseOptions(["minor", "--resume"])).toThrow("Usage");
  });
  it("bumps only manifests, pushes branch, waits, then tags explicit SHA and creates release", async () => {
    const f = fixture();
    await expect(release(f)).resolves.toEqual({ tag: "v1.0.7", sha });
    const sequence = ["git pull --ff-only origin main", "npm version patch --no-git-tag-version --ignore-scripts", "git add -- package.json package-lock.json", "git commit --only -m Release v1.0.7 -- package.json package-lock.json", "git push origin HEAD:refs/heads/main", "Verify success", `git tag -a v1.0.7 ${sha} -m Release v1.0.7`, "git push origin refs/tags/v1.0.7:refs/tags/v1.0.7", "gh release create v1.0.7 --verify-tag --generate-notes --title v1.0.7 --repo owner/toolkit"];
    const positions = sequence.map((command) => f.calls.indexOf(command));
    expect(positions.every((position, index) => position >= 0 && (!index || position > positions[index - 1]))).toBe(true);
  });
  it("resumes current version without bump or commit, including pushing a previously local commit", async () => {
    const f = fixture();
    await release({ ...f, resume: true });
    expect(f.calls).toContain("git push origin HEAD:refs/heads/main");
    expect(f.calls.some((call) => call.startsWith("npm version") || call.startsWith("git commit"))).toBe(false);
    expect(f.calls).toContain(`git tag -a v1.0.6 ${sha} -m Release v1.0.6`);
  });
  it.each([
    ["git --version", fail("git unavailable"), "git unavailable"],
    ["npm --version", fail("npm unavailable"), "npm unavailable"],
    ["git status --porcelain --untracked-files=all", ok("?? stray.txt"), "clean"],
    ["git branch --show-current", ok("feature"), "default branch"],
    ["gh auth status --hostname github.com", fail("not authenticated"), "not authenticated"],
    ["git ls-remote --exit-code --heads origin refs/heads/main", fail("network unavailable"), "network unavailable"],
    ["git push --dry-run origin FETCH_HEAD:refs/heads/main", fail("permission denied"), "permission denied"],
    ["git remote get-url --push origin", ok("git@github.com:elsewhere/repo.git"), "differ"],
    ["gh repo view owner/toolkit --json nameWithOwner,defaultBranchRef,viewerPermission", ok(JSON.stringify({ nameWithOwner: "elsewhere/repo" })), "metadata"],
    ["gh api repos/owner/toolkit/releases/tags/v1.0.7", fail("HTTP 503 network failed"), "Could not query"],
    ["gh api repos/owner/toolkit/releases/tags/v1.0.7", fail("gh: Unauthorized (HTTP 401)"), "Could not query"],
  ])("stops preflight %s before worktree mutation", async (key, result, message) => {
    const f = fixture({ [key]: result });
    await expect(release(f)).rejects.toThrow(message);
    expect(f.calls.some((call) => call.startsWith("npm version") || call.startsWith("git pull") || call.startsWith("git tag -a") || call.startsWith("gh release create"))).toBe(false);
  });
  it("rejects unexpected bump side effects before commit", async () => {
    const f = fixture();
    let checks = 0;
    const runner = async (command: string, args: string[]) => command === "git" && args[0] === "status" && ++checks === 2 ? ok(" M package.json\n M other.txt") : f.runner(command, args);
    await expect(release({ ...f, runner })).rejects.toThrow("Unexpected changes");
    expect(f.calls.some((call) => call.startsWith("git commit"))).toBe(false);
  });
  it("refuses resume when remote history would advance or diverge from current HEAD", async () => {
    const f = fixture({ [`git merge-base --is-ancestor FETCH_HEAD ${sha}`]: fail("not an ancestor") });
    await expect(release({ ...f, resume: true })).rejects.toThrow("not an ancestor");
    expect(f.calls).not.toContain("git pull --ff-only origin main");
    expect(f.calls).not.toContain("git push origin HEAD:refs/heads/main");
  });
  it("does not release a different HEAD if the remote advances during resume pull", async () => {
    const f = fixture();
    let heads = 0;
    const runner = async (command: string, args: string[]) => command === "git" && args.join(" ") === "rev-parse HEAD" && ++heads === 2 ? ok(other) : f.runner(command, args);
    await expect(release({ ...f, runner, resume: true })).rejects.toThrow("Default branch advanced during resume");
    expect(f.calls).not.toContain("git push origin HEAD:refs/heads/main");
  });
  it.each(["Local", "Remote"])("refuses %s tag mismatch", async (where) => {
    const f = fixture(where === "Local" ? { "git tag --list v1.0.6": ok("v1.0.6"), "git rev-parse refs/tags/v1.0.6^{commit}": ok(other) } : { "git ls-remote --tags origin refs/tags/v1.0.6 refs/tags/v1.0.6^{}": ok(`${other}\trefs/tags/v1.0.6`) });
    await expect(release({ ...f, resume: true })).rejects.toThrow("Tag conflict");
    expect(f.calls).not.toContain("git push origin HEAD:refs/heads/main");
  });
  it.each([false, true])("accepts matching annotated tags, remote-only=%s, and does not duplicate a published release", async (remoteOnly) => {
    const f = fixture({
      "git tag --list v1.0.6": ok(remoteOnly ? "" : "v1.0.6"),
      "git rev-parse refs/tags/v1.0.6^{commit}": ok(sha),
      "git ls-remote --tags origin refs/tags/v1.0.6 refs/tags/v1.0.6^{}": ok(`${other}\trefs/tags/v1.0.6\n${sha}\trefs/tags/v1.0.6^{}`),
      "gh api repos/owner/toolkit/releases/tags/v1.0.6": ok(JSON.stringify({ draft: false })),
    });
    await release({ ...f, resume: true });
    expect(f.calls.some((call) => call.startsWith("git tag -a") || call.startsWith("git push origin refs/tags") || call.startsWith("gh release create"))).toBe(false);
  });
  it("refuses a draft rather than pretending it is published", async () => {
    const f = fixture({ "gh api repos/owner/toolkit/releases/tags/v1.0.6": ok('{"draft":true}') });
    await expect(release({ ...f, resume: true })).rejects.toThrow("explicitly publish");
  });
  it.each(["push", "CI", "release"])("prints resume recovery after %s failure without rollback", async (stage) => {
    const f = fixture(stage === "push" ? { "git push origin HEAD:refs/heads/main": fail("push denied") } : stage === "release" ? { "gh release create v1.0.7 --verify-tag --generate-notes --title v1.0.7 --repo owner/toolkit": fail("release failed") } : {});
    await expect(release({ ...f, ...(stage === "CI" ? { poll: async () => { throw new Error("Verify failed"); } } : {}) })).rejects.toThrow("npm run release -- --resume");
    if (stage !== "release") expect(f.calls.some((call) => call.startsWith("git tag -a") || call.startsWith("gh release create"))).toBe(false);
    expect(f.calls.some((call) => /reset|stash|--force|--delete/.test(call))).toBe(false);
  });
});

describe("Release Verify polling", () => {
  const entry = (fields = {}) => ({ id: 42, run_attempt: 1, head_sha: sha, head_branch: "main", event: "push", status: "completed", conclusion: "success", html_url: "https://github.com/owner/toolkit/actions/runs/42", ...fields });
  function pollFixture(runs: object[]) {
    const calls: string[][] = [];
    let clock = 0;
    return { calls, runner: async (_command: string, args: string[]) => { calls.push(args); return ok(JSON.stringify([{ workflow_runs: runs }])); }, repository: "owner/toolkit", branch: "main", sha, timeoutMs: 30, pollMs: 15, now: () => clock, sleep: async (ms: number) => { clock += ms; } };
  }
  it("queries SHA/branch/event via REST and accepts latest success", async () => {
    const f = pollFixture([entry()]);
    await expect(pollVerify(f)).resolves.toMatchObject({ id: 42 });
    expect(f.calls[0].join(" ")).toContain(`head_sha=${sha}&branch=main&event=push`);
    expect(f.calls[0].join(" ")).toContain("actions/workflows/release-verify.yml/runs?");
    expect(f.calls[0]).toContain("--paginate");
  });
  it.each(["failure", "cancelled", "skipped"])("rejects latest %s attempt despite prior success, with diagnostics", async (conclusion) => {
    const f = pollFixture([entry(), entry({ run_attempt: 2, conclusion })]);
    await expect(pollVerify(f)).rejects.toThrow(`Release Verify concluded ${conclusion}`);
    await expect(pollVerify(f)).rejects.toThrow("gh run view 42 --attempt 2 --log --repo owner/toolkit");
  });
  it.each([[], [entry({ status: "in_progress" })], [entry({ head_sha: other })], [entry({ event: "pull_request" })], [entry({ head_branch: "feature" })]])("bounds missing or pending verification", async (...args) => {
    const runs = args[0] ? args : [];
    const f = pollFixture(runs);
    await expect(pollVerify(f)).rejects.toThrow("Timed out");
    expect(f.calls).toHaveLength(3);
  });
  it("propagates API network failures rather than treating them as missing runs", async () => {
    const f = pollFixture([]);
    await expect(pollVerify({ ...f, runner: async () => fail("network error") })).rejects.toThrow("network error");
  });
  it("cannot use ordinary Verify success when Release Verify is missing", async () => {
    const f = pollFixture([]);
    const runner = async (_command: string, args: string[]) => ok(JSON.stringify([{ workflow_runs: args.some((arg) => arg.includes("/workflows/verify.yml/")) ? [entry()] : [] }]));
    await expect(pollVerify({ ...f, runner })).rejects.toThrow("Timed out waiting for Release Verify");
  });
});
