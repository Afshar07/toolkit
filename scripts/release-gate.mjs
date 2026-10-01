import { execFileSync } from "node:child_process";

export function latestRelevantRun(runs, sha) {
  const relevant = runs.filter((run) => run.head_sha === sha && run.event === "push")
    .sort((a, b) => (b.run_attempt - a.run_attempt) || (b.id - a.id));
  return relevant[0];
}

export function evaluateRun(run) {
  if (!run) return "missing";
  if (run.status !== "completed") return "pending";
  return run.conclusion === "success" ? "success" : "failed";
}

async function github(path) {
  const response = await fetch(`https://api.github.com${path}`, { headers: {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    "x-github-api-version": "2022-11-28",
  } });
  if (!response.ok) throw new Error(`GitHub Actions query failed with HTTP ${response.status}.`);
  return response.json();
}

export async function gate({ repository, tag, defaultBranch, timeoutMs = 15 * 60_000, pollMs = 15_000 }) {
  const sha = execFileSync("git", ["rev-parse", `${tag}^{commit}`], { encoding: "utf8" }).trim();
  try { execFileSync("git", ["merge-base", "--is-ancestor", sha, `origin/${defaultBranch}`]); }
  catch { throw new Error(`Release tag commit ${sha} is not in the default branch history.`); }
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const query = new URLSearchParams({ branch: defaultBranch, event: "push", head_sha: sha, per_page: "100" });
    const data = await github(`/repos/${repository}/actions/workflows/verify.yml/runs?${query}`);
    const run = latestRelevantRun(data.workflow_runs ?? [], sha);
    const state = evaluateRun(run);
    if (state === "success") return sha;
    if (state === "failed") throw new Error(`Latest Verify run attempt for ${sha} concluded ${run.conclusion}.`);
    if (Date.now() >= deadline) throw new Error(state === "missing" ? `No qualifying Verify run found for ${sha}.` : `Timed out waiting for Verify run ${run.id} for ${sha}.`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  gate({ repository: process.env.GITHUB_REPOSITORY, tag: process.env.RELEASE_TAG, defaultBranch: process.env.DEFAULT_BRANCH })
    .then((sha) => process.stdout.write(`${sha}\n`))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
