import { describe, expect, it, vi } from "vitest";

vi.mock("execa", () => ({ execa: vi.fn() }));

import { execa } from "execa";
import { checkPrerequisites } from "../../src/doctor/doctor.js";
import type { WorkspaceManifest } from "../../src/workspace/manifest.js";

const runTool = vi.mocked(execa);

describe("checkPrerequisites", () => {
  it("reports compatible tools as available", async () => {
    runTool.mockImplementation(async (name) => ({ stdout: name === "node" ? "v22.1.0" : "2.45.0" }) as never);

    await expect(checkPrerequisites(manifest("22.1.0"))).resolves.toEqual([
      { name: "git", status: "available", version: "2.45.0" },
      { name: "node", status: "available", version: "v22.1.0" },
    ]);
  });

  it("reports an exact incompatible Node version", async () => {
    runTool.mockImplementation(async (name) => ({ stdout: name === "node" ? "v20.0.0" : "2.45.0" }) as never);

    await expect(checkPrerequisites(manifest("22.1.0"))).resolves.toContainEqual({
      name: "node", status: "incompatible", version: "v20.0.0", expectedVersions: ["22.1.0"],
    });
  });

  it("treats non-exact Node version hints as advisory", async () => {
    runTool.mockImplementation(async (name) => ({ stdout: name === "node" ? "v20.0.0" : "2.45.0" }) as never);

    await expect(checkPrerequisites(manifest(">=22"))).resolves.toContainEqual({ name: "node", status: "available", version: "v20.0.0" });
  });

  it("reports unavailable tools as missing", async () => {
    runTool.mockRejectedValue(new Error("not found"));

    await expect(checkPrerequisites()).resolves.toEqual([
      { name: "git", status: "missing", expectedVersions: undefined },
      { name: "node", status: "missing", expectedVersions: undefined },
    ]);
  });
});

function manifest(nodeVersion: string): WorkspaceManifest {
  return { schemaVersion: 3, name: "work", repositories: [{ name: "panel", path: "panel", cloneRemote: "origin", remotes: [{ name: "origin", url: "https://example.test/panel.git" }], nodeVersion }], directories: [] };
}
