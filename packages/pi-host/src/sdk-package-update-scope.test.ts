import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DefaultPackageManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updatePackageInScope } from "./package-controller.js";

describe("Host package update scope", () => {
  it("does not rewrite npm sources to installedPath", async () => {
    const update = vi.fn().mockResolvedValue(undefined);

    await updatePackageInScope({ update } as never, {
      source: "npm:shared-package@^1.0.0",
      scope: "user",
      kind: "npm",
      installedPath: "/agent/npm/node_modules/shared-package",
    });

    expect(update).toHaveBeenCalledWith("npm:shared-package@^1.0.0", { local: false });
  });

  it("passes installedPath for a user-local package whose settings path is relative to agentDir", async () => {
    const update = vi.fn().mockResolvedValue(undefined);

    await updatePackageInScope({ update } as never, {
      source: "../ext-lifecycle-pkg",
      scope: "user",
      kind: "local",
      installedPath: "/var/folders/ext-lifecycle-pkg",
    });

    expect(update).toHaveBeenCalledWith("/var/folders/ext-lifecycle-pkg", { local: false });
  });

  it("falls back to the raw source when installedPath is absent", async () => {
    const update = vi.fn().mockResolvedValue(undefined);

    await updatePackageInScope({ update } as never, {
      source: "../ext-lifecycle-pkg",
      scope: "user",
      kind: "local",
    });

    expect(update).toHaveBeenCalledWith("../ext-lifecycle-pkg", { local: false });
  });
});

describe("SDK local package update identity", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "piabyss-package-update-local-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("matches a user-local package stored relative to agentDir, not workspace cwd", async () => {
    const agentDir = join(root, "agent");
    const workspace = join(root, "workspace", "nested");
    const pkg = join(root, "pkg");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "local-pkg", version: "1.0.0" }),
    );

    const relativeSource = relative(agentDir, pkg);
    const manager = new DefaultPackageManager({
      cwd: workspace,
      agentDir,
      settingsManager: {
        getGlobalSettings: () => ({ packages: [relativeSource] }),
        getProjectSettings: () => ({ packages: [] }),
      } as never,
    });

    await expect(manager.update(relativeSource, { local: false })).rejects.toThrow(
      /No matching package found/,
    );

    await expect(
      updatePackageInScope(manager, {
        source: relativeSource,
        scope: "user",
        kind: "local",
        installedPath: pkg,
      }),
    ).resolves.toBeUndefined();
  });
});
