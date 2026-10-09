import { ModelProfileError } from "./errors.js";
import { isValidAgentName, isValidProfileName } from "./schema.js";

/** Throws `invalid-input` for a malformed profile name (a programming or input error, not an outcome). */
export function assertProfileName(name: string): void {
  if (!isValidProfileName(name)) throw new ModelProfileError("invalid-input", `Invalid profile name "${printable(name)}"; use lowercase letters, digits, and hyphens.`);
}

/** Throws `invalid-input` for a malformed agent name. */
export function assertAgentName(name: string): void {
  if (!isValidAgentName(name)) throw new ModelProfileError("invalid-input", `Invalid agent name "${printable(name)}"; use lowercase letters, digits, and hyphens.`);
}

function printable(value: unknown): string {
  // eslint-disable-next-line no-control-regex
  return String(value).replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 60);
}
