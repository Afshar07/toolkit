/** Code-unit ordering: independent of locale, platform, and ICU data (matches Phase 1's model ordering). */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortCodeUnits(values: readonly string[]): string[] {
  return [...values].sort(compareCodeUnits);
}
