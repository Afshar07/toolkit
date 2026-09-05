export interface ScanCliValues {
  workspace?: string;
  name?: string;
  output?: string;
}

export async function resolveScanValues(
  values: ScanCliValues,
  questions: {
    workspace: () => Promise<string>;
    name: (workspace: string) => Promise<string>;
    output: (name: string) => Promise<string>;
  },
): Promise<{ workspace: string; name: string; output: string }> {
  const workspace = optionalCliValue(values.workspace, "workspace") ?? await questions.workspace();
  const name = optionalCliValue(values.name, "name") ?? await questions.name(workspace);
  const output = optionalCliValue(values.output, "output") ?? await questions.output(name);
  return { workspace, name, output };
}

export interface SetupCliValues {
  workspace?: string;
  destination?: string;
}

export interface ContextInitCliValues {
  destination?: string;
  name?: string;
  purpose?: string;
  contextPath?: string | string[];
  project?: string | string[];
  nonInteractive?: boolean;
}

export interface ResolvedContextInitValues {
  destination: string;
  name: string;
  purpose: string;
  contextPath: string;
  projects: Array<{ id: string; path: string }>;
}

/** Resolve context init flags while keeping prompting isolated from parsing. */
export async function resolveContextInitValues(values: ContextInitCliValues, questions: {
  destination: () => Promise<string>;
  name: (destination: string) => Promise<string>;
  purpose: () => Promise<string>;
  contextPath: () => Promise<string>;
  project: () => Promise<string>;
}): Promise<ResolvedContextInitValues> {
  if (values.nonInteractive) {
    const missing = [
      values.destination === undefined ? "destination" : undefined,
      values.name === undefined ? "name" : undefined,
      values.purpose === undefined ? "purpose" : undefined,
      values.contextPath === undefined ? "context-path" : undefined,
      values.project === undefined ? "project" : undefined,
    ].filter((value): value is string => value !== undefined);
    if (missing.length) throw new Error(`--non-interactive requires: ${missing.map((value) => `--${value}`).join(", ")}.`);
  }
  const destination = optionalCliValue(values.destination, "destination") ?? await questions.destination();
  const name = optionalCliValue(values.name, "name") ?? await questions.name(destination);
  const purpose = optionalCliValue(values.purpose, "purpose") ?? await questions.purpose();
  const contextPathValue = Array.isArray(values.contextPath) ? values.contextPath.at(-1) : values.contextPath;
  const contextPath = optionalCliValue(contextPathValue, "context-path") ?? await questions.contextPath();
  const rawProjects = values.project === undefined ? [await questions.project()] : (Array.isArray(values.project) ? values.project : [values.project]);
  const projects = rawProjects.map(parseContextProject);
  return { destination, name, purpose, contextPath, projects };
}

export function parseContextProject(value: string): { id: string; path: string } {
  const input = optionalCliValue(value, "project")!;
  const separator = input.indexOf(":");
  if (separator < 1 || separator === input.length - 1) throw new Error("--project must use the format id:path.");
  return { id: input.slice(0, separator).trim(), path: input.slice(separator + 1).trim() };
}

export async function resolveSetupValues<T>(
  values: SetupCliValues,
  questions: {
    workspace: () => Promise<T>;
    parseWorkspace: (value: string) => Promise<T>;
    destination: (workspace: T) => Promise<string>;
  },
): Promise<{ workspace: T; destination: string }> {
  const workspace = values.workspace === undefined
    ? await questions.workspace()
    : await questions.parseWorkspace(optionalCliValue(values.workspace, "workspace")!);
  const destination = optionalCliValue(values.destination, "destination") ?? await questions.destination(workspace);
  return { workspace, destination };
}

function optionalCliValue(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`--${name} must not be empty.`);
  return trimmed;
}
