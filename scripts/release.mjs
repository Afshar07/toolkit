import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { evaluateRun, latestRelevantRun } from "./release-gate.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Execute argument arrays without a shell, including npm on Windows. */
export function createRunner(cwd = root) {
  return (command, args) => execa(command, args, { cwd, reject: false });
}

export function parseOptions(args) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return { help: true };
  if (args.length === 1 && args[0] === "--resume") return { resume: true };
  if (!args.length) return { bump: "patch" };
  if (args.length === 1 && ["patch", "minor", "major"].includes(args[0])) return { bump: args[0] };
  throw new Error("Usage: npm run release -- [patch|minor|major|--resume|--help]");
}

function repositoryFromRemote(url) {
  const match = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url);
  if (!match) throw new Error("origin must point to a GitHub repository without embedded credentials.");
  return match[1];
}

function nextVersion(version, bump) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Unsupported release version: ${version}`);
  const [major, minor, patch] = match.slice(1).map(Number);
  return bump === "major" ? `${major + 1}.0.0` : bump === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

function checked(runner) {
  return async (command, args) => {
    const result = await runner(command, args);
    if (result.exitCode !== 0) throw new Error(`${command} ${args.join(" ")} failed.\n${result.stderr || result.stdout || ""}`);
    return (result.stdout ?? "").trimEnd();
  };
}

/** Wait only for the latest exact-commit default-branch push attempt. */
export async function pollVerify({ runner, repository, branch, sha, timeoutMs = 15 * 60_000, pollMs = 15_000, now = Date.now, sleep = (ms) => new Promise((done) => setTimeout(done, ms)) }) {
  const run = checked(runner);
  const deadline = now() + timeoutMs;
  const query = new URLSearchParams({ head_sha: sha, branch, event: "push", per_page: "100" });
  while (true) {
    const pages = JSON.parse(await run("gh", ["api", "--paginate", "--slurp", `repos/${repository}/actions/workflows/verify.yml/runs?${query}`]));
    const latest = latestRelevantRun(pages.flatMap((page) => page.workflow_runs ?? []).filter((entry) => entry.head_branch === branch), sha);
    const state = evaluateRun(latest);
    if (state === "success") return latest;
    const diagnostic = latest ? `\n${latest.html_url}\nLogs: gh run view ${latest.id} --attempt ${latest.run_attempt} --log --repo ${repository}` : "";
    if (state === "failed") throw new Error(`Verify concluded ${latest.conclusion} for ${sha}.${diagnostic}`);
    if (now() >= deadline) throw new Error(`Timed out waiting for Verify for ${sha}.${diagnostic}`);
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }
}

/** Orchestrate a release; all external operations can be injected for tests. */
export async function release({ runner = createRunner(), readPackage = async () => JSON.parse(await readFile(resolve(root, "package.json"), "utf8")), bump = "patch", resume = false, poll = pollVerify, log = console.log } = {}) {
  const run = checked(runner);
  let mutated = false;
  let committed = resume;
  let tag;
  try {
    for (const command of ["git", "gh", "npm"]) await run(command, ["--version"]);
    if (await run("git", ["status", "--porcelain", "--untracked-files=all"])) throw new Error("Working tree must be clean, including untracked files.");
    await run("gh", ["auth", "status", "--hostname", "github.com"]);
    const repository = repositoryFromRemote(await run("git", ["remote", "get-url", "origin"]));
    if (repositoryFromRemote(await run("git", ["remote", "get-url", "--push", "origin"])).toLowerCase() !== repository.toLowerCase()) throw new Error("origin push and fetch repositories differ.");
    const metadata = JSON.parse(await run("gh", ["repo", "view", repository, "--json", "nameWithOwner,defaultBranchRef,viewerPermission"]));
    if (metadata.nameWithOwner.toLowerCase() !== repository.toLowerCase()) throw new Error("origin differs from GitHub repository metadata.");
    const branch = metadata.defaultBranchRef?.name;
    if (!branch || await run("git", ["branch", "--show-current"]) !== branch) throw new Error("Release must run on the GitHub default branch.");
    if (!["ADMIN", "MAINTAIN", "WRITE"].includes(metadata.viewerPermission)) throw new Error("GitHub write permission is required.");
    await run("git", ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`]);
    await run("git", ["fetch", "origin", branch]);
    await run("git", ["push", "--dry-run", "origin", `FETCH_HEAD:refs/heads/${branch}`]);

    const tags = async (name, sha) => {
      const ref = `refs/tags/${name}`;
      const localRefs = await run("git", ["tag", "--list", name]);
      const local = localRefs ? await run("git", ["rev-parse", `${ref}^{commit}`]) : null;
      const entries = (await run("git", ["ls-remote", "--tags", "origin", ref, `${ref}^{}`])).split("\n").filter(Boolean).map((line) => line.split(/\s+/));
      const remote = entries.find((entry) => entry[1] === `${ref}^{}`)?.[0] ?? entries.find((entry) => entry[1] === ref)?.[0];
      if ((local && local !== sha) || (remote && remote !== sha)) throw new Error(`Tag conflict for ${name}; never move or delete a release tag.`);
      return { local, remote };
    };
    const existingRelease = async (name) => {
      const result = await runner("gh", ["api", `repos/${repository}/releases/tags/${name}`]);
      if (result.exitCode === 0) {
        const data = JSON.parse(result.stdout);
        if (data.draft) throw new Error(`Release ${name} is a draft; explicitly publish it in GitHub, then resume.`);
        return data;
      }
      if (/\(HTTP 404\)/.test(result.stderr ?? "")) return null;
      throw new Error(`Could not query release ${name}: ${result.stderr || result.stdout || "unknown error"}`);
    };
    let sha = await run("git", ["rev-parse", "HEAD"]);
    let version = (await readPackage()).version;
    tag = `v${resume ? version : nextVersion(version, bump)}`;
    const initialTags = await tags(tag, resume ? sha : null);
    const initialRelease = await existingRelease(tag);
    if (!resume && (initialTags.local || initialTags.remote || initialRelease)) throw new Error(`Release ${tag} already exists; use --resume for the current version instead.`);
    if (resume) await run("git", ["merge-base", "--is-ancestor", "FETCH_HEAD", sha]);
    await run("git", ["pull", "--ff-only", "origin", branch]);
    if (resume && await run("git", ["rev-parse", "HEAD"]) !== sha) throw new Error("Default branch advanced during resume. HEAD changed; inspect the checkout and restore the intended release HEAD manually before retrying. No release was created.");
    version = (await readPackage()).version;
    if (!resume) {
      tag = `v${nextVersion(version, bump)}`;
      await tags(tag, null);
      if (await existingRelease(tag)) throw new Error(`Release ${tag} already exists.`);
      mutated = true;
      await run("npm", ["version", bump, "--no-git-tag-version", "--ignore-scripts"]);
      if ((await readPackage()).version !== tag.slice(1)) throw new Error("npm produced an unexpected version.");
      const changed = (await run("git", ["status", "--porcelain", "--untracked-files=all"])).split("\n").filter(Boolean);
      if (changed.some((line) => !["package.json", "package-lock.json"].includes(line.slice(3)))) throw new Error("Unexpected changes after version bump; inspect the working tree before committing.");
      await run("git", ["add", "--", "package.json", "package-lock.json"]);
      await run("git", ["commit", "--only", "-m", `Release ${tag}`, "--", "package.json", "package-lock.json"]);
      committed = true;
    }
    sha = await run("git", ["rev-parse", "HEAD"]);
    mutated = true;
    await run("git", ["push", "origin", `HEAD:refs/heads/${branch}`]);
    await poll({ runner, repository, branch, sha });
    const currentTags = await tags(tag, sha);
    if (!currentTags.local && !currentTags.remote) await run("git", ["tag", "-a", tag, sha, "-m", `Release ${tag}`]);
    if (!currentTags.remote) await run("git", ["push", "origin", `refs/tags/${tag}:refs/tags/${tag}`]);
    if (!await existingRelease(tag)) await run("gh", ["release", "create", tag, "--verify-tag", "--generate-notes", "--title", tag, "--repo", repository]);
    log(`Released ${tag}. GitHub Actions handles npm publication; check the Publish workflow.`);
    return { tag, sha };
  } catch (error) {
    if (mutated) {
      error.message += committed
        ? "\nNo state was rolled back. Keep this version and HEAD; retry with npm run release -- --resume."
        : "\nNo state was rolled back. Inspect package.json/package-lock.json and finish the version commit on the default branch, then run npm run release -- --resume. Do not bump again.";
    }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) console.log("Usage: npm run release -- [patch|minor|major|--resume]\nDefault: patch. --resume releases the current version/HEAD without bumping.");
    else await release(options);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
