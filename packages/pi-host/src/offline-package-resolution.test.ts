/**
 * Implicit resource loading must never install a package.
 *
 * The first test drives the real SDK DefaultResourceLoader against a configured
 * but uninstalled `npm:` package. That is the exact shape that makes resolve()
 * auto-install: without the guard this same call shells out to `npm install`
 * against the live registry and rejects (measured at ~1.9s and a 404 for a
 * nonexistent package). With the guard it resolves offline in ~100ms.
 *
 * So the passing path needs no network, but a regression that disabled the
 * guard would fail the test — by rejecting, or by hanging on a real install.
 */
import { describe, expect, it, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  implicitPackageInstallSuppressed,
  withoutImplicitPackageInstall,
} from "./offline-package-resolution.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.PI_OFFLINE;
});

function layoutWithConfiguredPackage(): { cwd: string; agentDir: string } {
  const root = mkdtempSync(join(tmpdir(), "piabyss-offline-"));
  roots.push(root);
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  // The `npm:` prefix matters. parseSource() treats an unprefixed spec as a
  // local path, which never installs and would make this test vacuous.
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ packages: ["npm:piabyss-not-a-real-package@1.0.0"] }, null, 2),
  );
  return { cwd, agentDir };
}

async function reload(cwd: string, agentDir: string): Promise<DefaultResourceLoader> {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: true }),
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  return loader;
}

describe("withoutImplicitPackageInstall", () => {
  it("resolves offline instead of installing a configured but absent package", async () => {
    const { cwd, agentDir } = layoutWithConfiguredPackage();

    // Unguarded, this rejects with npm's registry error instead.
    const loader = await withoutImplicitPackageInstall(() => reload(cwd, agentDir));

    // The package is skipped, not fetched, and not treated as a load failure.
    expect(loader.getExtensions().extensions).toEqual([]);
    expect(existsSync(join(agentDir, "packages", "piabyss-not-a-real-package"))).toBe(false);
  }, 60_000);

  it("restores the previous value, including when it was unset", async () => {
    expect(process.env.PI_OFFLINE).toBeUndefined();
    await withoutImplicitPackageInstall(async () => {
      expect(process.env.PI_OFFLINE).toBe("1");
    });
    expect(process.env.PI_OFFLINE).toBeUndefined();

    process.env.PI_OFFLINE = "0";
    await withoutImplicitPackageInstall(async () => {
      expect(process.env.PI_OFFLINE).toBe("1");
    });
    expect(process.env.PI_OFFLINE).toBe("0");
  });

  it("restores the previous value when the callback throws", async () => {
    process.env.PI_OFFLINE = "original";
    await expect(
      withoutImplicitPackageInstall(async () => {
        throw new Error("reload failed");
      }),
    ).rejects.toThrow("reload failed");
    expect(process.env.PI_OFFLINE).toBe("original");
  });

  it("reports suppression only for values the SDK accepts", () => {
    expect(implicitPackageInstallSuppressed()).toBe(false);
    for (const value of ["1", "true", "TRUE", "yes", "Yes"]) {
      process.env.PI_OFFLINE = value;
      expect(implicitPackageInstallSuppressed(), value).toBe(true);
    }
    for (const value of ["0", "false", "no", ""]) {
      process.env.PI_OFFLINE = value;
      expect(implicitPackageInstallSuppressed(), value).toBe(false);
    }
  });

  it("does not leak suppression to code running after it", async () => {
    await withoutImplicitPackageInstall(async () => undefined);
    // Package mutation reconcile deliberately runs without the guard, so a leak
    // here would silently disable the user's explicit install.
    expect(implicitPackageInstallSuppressed()).toBe(false);
  });
});
