import { performance } from "node:perf_hooks";
import { afterAll } from "vitest";

const timings = new Map<string, { count: number; elapsed: number }>();

/** Records test-only aggregate durations without command arguments or fixture contents. */
export async function timeTestOperation<T>(label: string, operation: () => Promise<T>): Promise<T> {
  if (process.env.TOOLKIT_TEST_TIMINGS !== "1") return operation();
  const started = performance.now();
  try {
    return await operation();
  } finally {
    const total = timings.get(label) ?? { count: 0, elapsed: 0 };
    total.count++;
    total.elapsed += performance.now() - started;
    timings.set(label, total);
  }
}

afterAll(() => {
  if (timings.size === 0) return;
  console.info(`[toolkit test timings] ${JSON.stringify(Object.fromEntries(
    [...timings.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([label, total]) =>
      [label, { count: total.count, elapsedMs: Math.round(total.elapsed) }]),
  ))}`);
  timings.clear();
});
