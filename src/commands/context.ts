import os from "node:os";
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "pathe";
import { defineCommand } from "citty";
import * as prompts from "@clack/prompts";
import { setupOpenCodeAgents } from "../agents/setup.js";
import { applyContextPlan, inspectContextPlan } from "../context/reconcile.js";
import type { ContextPlanDecision, InspectedContextPlanFile } from "../context/reconcile.js";
import { createAiContextPlan } from "../context/plan.js";
import { defaultAiContextOptions } from "../context/setup.js";
import { validateAiContext } from "../context/validate.js";
import type { AiContextOptions } from "../context/model.js";
import { parseContextProject, resolveContextInitValues } from "./values.js";

type ContextOperation = "init" | "sync" | "diff";
type ConflictPolicy = "abort" | "skip" | "replace" | "prompt";
type InteractiveMode = "missing" | "managed" | "review" | "replace" | "abort";

export interface ContextCommandArgs {
  destination?: string;
  name?: string;
  purpose?: string;
  "context-path"?: string | string[];
  project?: string | string[];
  "non-interactive"?: boolean;
  "dry-run"?: boolean;
  "on-conflict"?: string;
  backup?: boolean;
}

function contextArgs() {
  return {
    destination: { type: "positional" as const, description: "Destination directory", required: false },
    name: { type: "string" as const, description: "Workspace name" },
    purpose: { type: "string" as const, description: "Workspace purpose" },
    "context-path": { type: "string" as const, description: "Shared context directory" },
    project: { type: "string" as const, description: "Project in id:path form" },
    "non-interactive": { type: "boolean" as const, description: "Require all context values as flags" },
    "dry-run": { type: "boolean" as const, description: "Show the plan without changing files" },
    "on-conflict": { type: "string" as const, description: "Conflict policy: abort, skip, replace, or prompt" },
    backup: { type: "boolean" as const, description: "Allow replacements and back up every replaced file" },
  };
}

export const contextCommand = defineCommand({
  meta: { name: "context", description: "Create, update, compare, and validate AI context" },
  subCommands: {
    init: defineCommand({
      meta: { name: "init", description: "Create missing AI context with safe conflict handling" },
      args: contextArgs(),
      async run({ args }) { await runContextWorkflowSafely(args as ContextCommandArgs, "init"); },
    }),
    sync: defineCommand({
      meta: { name: "sync", description: "Update Toolkit-managed context and review conflicts" },
      args: contextArgs(),
      async run({ args }) { await runContextWorkflowSafely(args as ContextCommandArgs, "sync"); },
    }),
    diff: defineCommand({
      meta: { name: "diff", description: "Preview generated context differences without writing" },
      args: contextArgs(),
      async run({ args }) { await runContextWorkflowSafely(args as ContextCommandArgs, "diff"); },
    }),
    validate: defineCommand({
      meta: { name: "validate", description: "Validate AI context without changing files" },
      args: { destination: { type: "positional", description: "Workspace directory" } },
      async run({ args }) {
        const result = await validateAiContext(typeof args.destination === "string" ? args.destination : process.cwd());
        for (const item of result.issues) prompts.log[item.severity](item.message);
        if (result.valid) prompts.outro("AI context is valid.");
        else throw new Error(`AI context validation failed with ${result.issues.filter((item) => item.severity === "error").length} error(s).`);
      },
    }),
    agents: defineCommand({
      meta: { name: "agents", description: "Create personal OpenCode agents" },
      async run() {
        const scope = await prompts.select({
          message: "Where should the agents be available?",
          options: [
            { value: "local", label: "This workspace", hint: ".opencode/agents" },
            { value: "global", label: "All workspaces", hint: "~/.config/opencode/agents" },
          ],
        });
        if (prompts.isCancel(scope)) cancelled();
        const destination = scope === "local"
          ? path.join(process.cwd(), ".opencode", "agents")
          : path.join(os.homedir(), ".config", "opencode", "agents");
        if (!await confirm(`Create four OpenCode agent files in ${destination}?`)) cancelled();
        const files = await setupOpenCodeAgents(destination);
        prompts.outro(`Created ${files.length} OpenCode agents in ${destination}. Restart OpenCode to load them.`);
      },
    }),
  },
});

export async function runContextWorkflow(args: ContextCommandArgs, operation: ContextOperation): Promise<void> {
  const nonInteractive = args["non-interactive"] === true;
  const destination = typeof args.destination === "string" ? args.destination : process.cwd();
  const inferred = await inferContextOptions(destination);
  const defaults = inferred ?? defaultAiContextOptions(destination);
  if (!nonInteractive) prompts.intro(operation === "init" ? "Set up AI context" : operation === "sync" ? "Sync AI context" : "Compare AI context");
  const values = await resolveContextInitValues({
    destination: args.destination,
    name: args.name ?? inferred?.workspaceName,
    purpose: args.purpose ?? inferred?.workspacePurpose,
    contextPath: args["context-path"] ?? inferred?.contextPath,
    project: args.project ?? inferred?.projects.map((project) => `${project.id}:${project.path}`),
    nonInteractive,
  }, {
    destination: async () => askText("Where should Toolkit manage the context?", process.cwd(), existingDirectoryMessage),
    name: async (selectedDestination) => askText("What is this workspace called?", defaultAiContextOptions(selectedDestination).workspaceName),
    purpose: async () => askText("What is this workspace for?", defaults.workspacePurpose),
    contextPath: async () => askText("Where should shared context live?", defaults.contextPath ?? ".ai"),
    project: async () => askText(
      "What is the primary project? Use id:path.",
      `${defaults.projects[0]?.id ?? "project"}:${defaults.projects[0]?.path ?? "."}`,
    ),
  });
  const files = await inspectContextPlan(values.destination, createAiContextPlan({
    workspaceName: values.name,
    workspacePurpose: values.purpose,
    contextPath: values.contextPath,
    projects: values.projects.map((project) => ({
      id: project.id,
      path: project.path,
      scope: inferred?.projects.find((candidate) => candidate.id === project.id && candidate.path === project.path)?.scope
        ?? "Primary project in this workspace.",
    })),
  }));

  showPlan(files, nonInteractive);
  if (operation === "diff") {
    await showAllDifferences(files);
    finish(nonInteractive, "Diff complete. No files changed.");
    return;
  }
  if (args["dry-run"]) {
    finish(nonInteractive, "Dry run complete. No files changed.");
    return;
  }

  const decisions = await resolveDecisions(files, args, operation, nonInteractive);
  const replacementCount = Object.values(decisions).filter((decision) => decision === "replace").length;
  const createCount = files.filter((file) => file.state === "create").length;
  if (replacementCount === 0 && createCount === 0) {
    finish(nonInteractive, "AI context is already up to date or all conflicts were kept. No files changed.");
    return;
  }
  if (!nonInteractive && !await confirm(`Apply ${createCount} creation(s) and ${replacementCount} replacement(s)?`)) {
    finish(false, "Cancelled. No files changed.");
    return;
  }

  const backupRoot = replacementCount > 0 ? path.join(values.destination, ".toolkit-backups", backupStamp()) : undefined;
  const result = await applyContextPlan(files, { decisions, backupRoot });
  const summary = `Context complete: ${result.created.length} created, ${result.replaced.length} replaced, ${result.skipped.length} kept.`;
  if (result.skipped.includes("AGENTS.md")) warning(nonInteractive, "AGENTS.md was kept. Confirm that it routes agents to the context files Toolkit created.");
  finish(nonInteractive, result.backups.length ? `${summary} Backups: ${backupRoot}` : summary);
}

async function runContextWorkflowSafely(args: ContextCommandArgs, operation: ContextOperation): Promise<void> {
  try {
    await runContextWorkflow(args, operation);
  } catch (error) {
    prompts.log.error(error instanceof Error ? error.message : "AI context operation failed.");
    process.exitCode = 1;
  }
}

async function resolveDecisions(
  files: InspectedContextPlanFile[],
  args: ContextCommandArgs,
  operation: Exclude<ContextOperation, "diff">,
  nonInteractive: boolean,
): Promise<Record<string, ContextPlanDecision>> {
  const actionable = files.filter((file) => file.state === "managed-update" || file.state === "conflict");
  if (!actionable.length) return {};
  const policy = parseConflictPolicy(args["on-conflict"] ?? (nonInteractive ? "abort" : "prompt"));
  if (nonInteractive && policy === "prompt") throw new Error("--on-conflict=prompt cannot be used with --non-interactive. No files changed.");
  if (policy === "abort") throw new Error(`Context conflicts require a decision: ${actionable.map((file) => file.relativePath).join(", ")}. No files changed.`);
  if (policy === "skip") return Object.fromEntries(actionable.map((file) => [file.relativePath, "skip"]));
  if (policy === "replace") {
    if (nonInteractive && !args.backup) throw new Error("--on-conflict=replace requires --backup in non-interactive mode. No files changed.");
    return Object.fromEntries(actionable.map((file) => [file.relativePath, "replace"]));
  }

  const mode = await prompts.select<InteractiveMode>({
    message: "How should Toolkit handle existing files?",
    options: operation === "sync" ? [
      { value: "managed", label: "Update managed files", hint: "recommended" },
      { value: "missing", label: "Add missing files only" },
      { value: "review", label: "Review each conflict" },
      { value: "replace", label: "Replace everything", hint: "creates backups" },
      { value: "abort", label: "Cancel" },
    ] : [
      { value: "missing", label: "Add missing files only", hint: "recommended" },
      { value: "managed", label: "Update managed files" },
      { value: "review", label: "Review each conflict" },
      { value: "replace", label: "Replace everything", hint: "creates backups" },
      { value: "abort", label: "Cancel" },
    ],
  });
  if (prompts.isCancel(mode) || mode === "abort") cancelled();
  if (mode === "missing") return Object.fromEntries(actionable.map((file) => [file.relativePath, "skip"]));
  if (mode === "replace") return Object.fromEntries(actionable.map((file) => [file.relativePath, "replace"]));
  if (mode === "managed") return Object.fromEntries(actionable.map((file) => [file.relativePath, file.state === "managed-update" ? "replace" : "skip"]));

  const decisions: Record<string, ContextPlanDecision> = {};
  for (const file of actionable) decisions[file.relativePath] = await reviewFile(file);
  return decisions;
}

async function reviewFile(file: InspectedContextPlanFile): Promise<ContextPlanDecision> {
  while (true) {
    const decision = await prompts.select<"skip" | "replace" | "diff" | "abort">({
      message: `${file.relativePath} ${file.state === "managed-update" ? "has a managed update" : "already exists or was edited"}.`,
      options: [
        { value: "skip", label: "Keep it and continue", hint: "no changes" },
        { value: "replace", label: "Replace with backup" },
        { value: "diff", label: "Show differences" },
        { value: "abort", label: "Cancel setup" },
      ],
    });
    if (prompts.isCancel(decision) || decision === "abort") cancelled();
    if (decision === "diff") { await showDifference(file); continue; }
    return decision;
  }
}

function showPlan(files: InspectedContextPlanFile[], nonInteractive: boolean): void {
  output(nonInteractive, "AI context plan:");
  for (const file of files) {
    const label = file.state === "create" ? "CREATE" : file.state === "unchanged" ? "SAME  " : file.state === "managed-update" ? "UPDATE" : "EXISTS";
    output(nonInteractive, `${label}  ${file.relativePath}`);
  }
  output(nonInteractive, "No files have been changed.");
}

async function showAllDifferences(files: InspectedContextPlanFile[]): Promise<void> {
  for (const file of files) if (file.state !== "unchanged") await showDifference(file);
}

async function showDifference(file: InspectedContextPlanFile): Promise<void> {
  const existing = file.state === "create" ? "" : await readFile(file.targetPath, "utf8");
  console.log(`\n--- ${file.relativePath} (existing)\n+++ ${file.relativePath} (planned)`);
  for (const line of existing.split(/\r?\n/)) if (line) console.log(`- ${line}`);
  for (const line of file.content.split(/\r?\n/)) if (line) console.log(`+ ${line}`);
}

function parseConflictPolicy(value: string): ConflictPolicy {
  if (["abort", "skip", "replace", "prompt"].includes(value)) return value as ConflictPolicy;
  throw new Error("--on-conflict must be abort, skip, replace, or prompt. No files changed.");
}

async function inferContextOptions(destination: string): Promise<AiContextOptions | undefined> {
  try {
    const root = path.resolve(destination);
    const agents = await readFile(path.join(root, "AGENTS.md"), "utf8");
    const workspaceName = agents.match(/^# (.+) Agent Router\s*$/m)?.[1]?.trim();
    const workspaceReference = agents.match(/`([^`]+\/workspace\.md)`/)?.[1];
    if (!workspaceName || !workspaceReference) return undefined;
    const contextPath = path.dirname(workspaceReference);
    const workspace = await readFile(path.join(root, workspaceReference), "utf8");
    const workspacePurpose = workspace.match(/## Purpose\s+([\s\S]*?)\s+Shared context belongs/)?.[1]?.trim();
    if (!workspacePurpose) return undefined;
    const projects: AiContextOptions["projects"] = [];
    const table = agents.slice(agents.indexOf("## Project routing table"));
    for (const match of table.matchAll(/^\|\s*([^|]+?)\s*\|\s*`([^`]+)`\s*\|\s*`[^`]+`\s*\|\s*`([^`]+)`\s*\|\s*$/gm)) {
      const id = match[1]!.trim();
      if (id === "Project" || id.includes("---")) continue;
      const guidance = await readFile(path.join(root, match[3]!), "utf8");
      const scope = guidance.match(/## Scope\s+([\s\S]*?)(?:\s+## |$)/)?.[1]?.trim() ?? "Primary project in this workspace.";
      projects.push({ id, path: match[2]!, scope });
    }
    return projects.length ? { workspaceName, workspacePurpose, contextPath, projects } : undefined;
  } catch {
    return undefined;
  }
}

function existingDirectoryMessage(value: string | undefined): string | undefined {
  try { return statSync(path.resolve(value ?? "")).isDirectory() ? undefined : "Enter an existing directory."; }
  catch { return "That directory does not exist."; }
}

function backupStamp(): string { return new Date().toISOString().replaceAll(":", "-"); }
function output(nonInteractive: boolean, message: string): void { nonInteractive ? console.log(message) : prompts.log.info(message); }
function warning(nonInteractive: boolean, message: string): void { nonInteractive ? console.warn(message) : prompts.log.warn(message); }
function finish(nonInteractive: boolean, message: string): void { nonInteractive ? console.log(message) : prompts.outro(message); }

async function askText(message: string, initialValue: string, validate?: (value: string | undefined) => string | undefined): Promise<string> {
  const value = await prompts.text({ message, initialValue, validate: (answer) => answer?.trim() ? validate?.(answer) : "A value is required." });
  if (prompts.isCancel(value)) cancelled();
  return value.trim();
}
async function confirm(message: string): Promise<boolean> {
  const value = await prompts.confirm({ message, initialValue: true });
  if (prompts.isCancel(value)) cancelled();
  return value;
}
function cancelled(): never { prompts.cancel("AI context setup cancelled. No files changed."); process.exit(0); }

export { parseContextProject };
