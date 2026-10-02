import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import * as path from "pathe";
import { execa } from "execa";
import { afterEach, expect, it } from "vitest";
import { createRunner, release } from "../../scripts/release.mjs";
import { createGitRegistryFixture } from "../helpers/git.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

it("resumes a pushed version commit after CI failure, tagging only the verified commit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "toolkit-release-"));
  directories.push(root);
  const { author, remote } = await createGitRegistryFixture(root, { sample: "fixture\n" });
  const manifests = ["package.json", "package-lock.json"];
  for (const file of manifests) await writeFile(path.join(author, file), '{"version":"1.0.0"}\n');
  await execa("git", ["add", "--", ...manifests], { cwd: author });
  await execa("git", ["commit", "-m", "Initial package"], { cwd: author });
  await execa("git", ["push", "origin", "main"], { cwd: author });
  const execute = createRunner(author);
  const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
  let created = 0;
  // Only Git executes real processes, against the temporary local bare remote.
  // GitHub and npm are injected; there are no external requests or publications.
  const runner = async (command: string, args: string[]) => {
    if (command === "git") {
      if (args[0] === "remote" && args[1] === "get-url") return ok("git@github.com:fixture/toolkit.git");
      return execute(command, args);
    }
    if (command === "npm") {
      if (args[0] === "version") for (const file of manifests) await writeFile(path.join(author, file), '{"version":"1.0.1"}\n');
      return ok();
    }
    if (args[0] === "repo") return ok(JSON.stringify({ nameWithOwner: "fixture/toolkit", defaultBranchRef: { name: "main" }, viewerPermission: "WRITE" }));
    if (args[0] === "api") return created ? ok('{"draft":false}') : { exitCode: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
    if (args[0] === "release") created++;
    return ok();
  };
  const options = { runner, readPackage: async () => JSON.parse(await readFile(path.join(author, "package.json"), "utf8")), log: () => {} };
  await expect(release({ ...options, poll: async () => { throw new Error("Verify failed"); } })).rejects.toThrow("--resume");
  const head = (await execa("git", ["rev-parse", "HEAD"], { cwd: author })).stdout;
  expect((await execa("git", ["--git-dir", remote, "rev-parse", "main"])).stdout).toBe(head);
  expect((await execa("git", ["tag", "--list"], { cwd: author })).stdout).toBe("");
  const changed = (await execa("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"], { cwd: author })).stdout.split("\n");
  expect(changed.sort()).toEqual([...manifests].sort());
  const poll = async ({ sha }: { sha: string }) => { expect(sha).toBe(head); };
  await expect(release({ ...options, resume: true, poll })).resolves.toEqual({ tag: "v1.0.1", sha: head });
  expect((await execa("git", ["--git-dir", remote, "rev-parse", "refs/tags/v1.0.1^{commit}"])).stdout).toBe(head);
  expect((await execa("git", ["cat-file", "-t", "refs/tags/v1.0.1"], { cwd: author })).stdout).toBe("tag");
  await release({ ...options, resume: true, poll });
  expect(created).toBe(1);
  expect((await execa("git", ["rev-parse", "HEAD"], { cwd: author })).stdout).toBe(head);
}, 30_000);
