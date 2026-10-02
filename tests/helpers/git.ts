import { mkdir, writeFile } from "node:fs/promises";
import { execa, type Options } from "execa";
import * as path from "pathe";
import { timeTestOperation } from "./timings.js";

/** Times Git using a fixed command label, never its arguments or output. */
export async function gitCommand(command: string, args: string[], options?: Options) {
  return timeTestOperation(`git ${command}`, async () => execa("git", args, options));
}

export interface GitRegistryFixture {
  remote: string;
  author: string;
}

export async function createGitRegistryFixture(root: string, agents: Record<string, string>): Promise<GitRegistryFixture> {
  const remote = path.join(root, "remote.git");
  const author = path.join(root, "author");
  await gitCommand("init", ["init", "--bare", "--initial-branch=main", remote]);
  await gitCommand("init", ["init", "--initial-branch=main", author]);
  await git(author, ["config", "user.email", "toolkit-tests@example.test"]);
  await git(author, ["config", "user.name", "Toolkit Tests"]);
  await git(author, ["remote", "add", "origin", remote]);
  await publishAgents(author, agents, "initial registry");
  return { remote, author };
}

export async function publishAgents(author: string, agents: Record<string, string>, message: string): Promise<void> {
  const directory = path.join(author, "agents");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "manifest.json"), `${JSON.stringify({ version: message, agents: Object.keys(agents) }, null, 2)}\n`);
  for (const [name, content] of Object.entries(agents)) await writeFile(path.join(directory, `${name}.md`), content);
  await git(author, ["add", "agents"]);
  await git(author, ["commit", "-m", message]);
  await git(author, ["push", "-u", "origin", "main"]);
}

export async function git(repository: string, args: string[]): Promise<void> {
  await gitCommand(args[0]!, ["-C", repository, ...args]);
}

export function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n");
}
