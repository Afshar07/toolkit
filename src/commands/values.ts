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
