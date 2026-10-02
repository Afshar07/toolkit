import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const workflow = (name: string) => readFile(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8");

describe("verification workflow contracts", () => {
  it("keeps routine PR/main verification on Ubuntu with agent-only exclusions", async () => {
    const verify = await workflow("verify");
    expect(verify).toContain("name: Verify\n");
    expect(verify).toContain("  push:\n    branches: [main]\n    paths-ignore:\n      - 'agents/**'\n  pull_request:\n    paths-ignore:\n      - 'agents/**'");
    expect(verify).toContain("    runs-on: ubuntu-latest\n");
    expect(verify).not.toMatch(/matrix:|windows-latest/);
    expect(verify).toContain("group: verify-${{ github.event.pull_request.number || github.ref }}");
    expect(verify).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
  });

  it("runs the full release matrix for main package metadata pushes or manual benchmarks without cancellation", async () => {
    const verify = await workflow("release-verify");
    expect(verify).toContain("name: Release Verify\n");
    expect(verify).toContain("on:\n  push:\n    branches: [main]\n    paths:\n      - 'package.json'\n      - 'package-lock.json'\n");
    expect(verify).not.toMatch(/pull_request:|paths-ignore:/);
    expect(verify).toContain("  workflow_dispatch:");
    expect(verify).toContain("group: release-verify-${{ github.ref }}");
    expect(verify).toContain("cancel-in-progress: false");
    expect(verify).toContain("fail-fast: false");
    expect(verify).toContain("os: [ubuntu-latest, windows-latest]");
    expect(verify).toContain("runs-on: ${{ matrix.os }}");
    expect(verify).toContain("- run: npm run verify\n        if: runner.os != 'Windows'");
    expect(verify).toContain("- run: npm run build\n        if: runner.os == 'Windows'\n      - run: npm test -- --maxWorkers=2 --minWorkers=2\n        if: runner.os == 'Windows'\n        env:\n          TOOLKIT_TEST_TIMINGS: '1'");
  });

  it.each(["verify", "release-verify"])("uses pinned read-only Node 22 verification steps in %s", async (name) => {
    const verify = await workflow(name);
    expect(verify).toContain("permissions:\n  contents: read\n");
    expect(verify).toContain("actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683");
    expect(verify).toContain("persist-credentials: false");
    expect(verify).toContain("actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020");
    expect(verify).toContain("node-version: 22\n          cache: npm");
    expect(verify).toContain("- run: npm ci\n      - run: npm run verify");
    if (name === "verify") expect(verify).not.toContain("TOOLKIT_TEST_TIMINGS");
  });
});
