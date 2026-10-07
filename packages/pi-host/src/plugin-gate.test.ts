import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isRepoPluginEnabled,
  MEMO_PLUGIN_ENTRY_FILE,
  PIXIE_PLUGIN_ENTRY_FILE,
} from "./plugin-gate.js";

const REPO_ENTRY_BASE = {
  source: "git:github.com/Nick12138/my-pi-plugins",
};

function writeSettings(agentDir: string, packages: unknown): void {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ packages }, null, 2),
    "utf8",
  );
}

describe("isRepoPluginEnabled", () => {
  let agentDir = "";

  afterEach(() => {
    if (agentDir) rmSync(agentDir, { recursive: true, force: true });
    agentDir = "";
  });

  it("is disabled when the repo package entry is absent", () => {
    agentDir = mkdtempSync(join(tmpdir(), "piabyss-gate-"));
    writeSettings(agentDir, ["npm:betterwright"]);
    expect(isRepoPluginEnabled(agentDir, MEMO_PLUGIN_ENTRY_FILE)).toBe(false);
  });

  it("is disabled when the repo entry omits the plugin file from its include globs", () => {
    // The live settings shape: only pi-subagent is included; sibling plugins
    // (memo, pixie) were force-excluded by earlier disables.
    agentDir = mkdtempSync(join(tmpdir(), "piabyss-gate-"));
    writeSettings(agentDir, [
      {
        ...REPO_ENTRY_BASE,
        extensions: [
          "packages/pi-subagent/extensions/**",
          "-packages/piabyss-memo/extensions/piabyss-memo.ts",
          "-packages/pi-pixie/extensions/pi-pixie.ts",
        ],
      },
    ]);
    expect(isRepoPluginEnabled(agentDir, MEMO_PLUGIN_ENTRY_FILE)).toBe(false);
    expect(isRepoPluginEnabled(agentDir, PIXIE_PLUGIN_ENTRY_FILE)).toBe(false);
  });

  it("is enabled when an include glob covers the plugin entry file", () => {
    agentDir = mkdtempSync(join(tmpdir(), "piabyss-gate-"));
    writeSettings(agentDir, [
      {
        ...REPO_ENTRY_BASE,
        extensions: [
          "packages/pi-subagent/extensions/**",
          "packages/piabyss-memo/extensions/**",
        ],
      },
    ]);
    expect(isRepoPluginEnabled(agentDir, MEMO_PLUGIN_ENTRY_FILE)).toBe(true);
    expect(isRepoPluginEnabled(agentDir, PIXIE_PLUGIN_ENTRY_FILE)).toBe(false);
  });

  it("is enabled by the +concrete-file form written by setPreferences and pluginLibraryApply enable", () => {
    agentDir = mkdtempSync(join(tmpdir(), "piabyss-gate-"));
    writeSettings(agentDir, [
      {
        ...REPO_ENTRY_BASE,
        extensions: [
          "packages/pi-subagent/extensions/**",
          "+packages/pi-pixie/extensions/pi-pixie.ts",
        ],
      },
    ]);
    expect(isRepoPluginEnabled(agentDir, PIXIE_PLUGIN_ENTRY_FILE)).toBe(true);
  });

  it("re-enabling removes the stale -concrete force-exclude (setPackageResourceFilter contract)", () => {
    // After the toggle's enable path runs, settings hold +concrete and no
    // -concrete; the gate must agree with the page's "enabled" display.
    agentDir = mkdtempSync(join(tmpdir(), "piabyss-gate-"));
    writeSettings(agentDir, [
      {
        ...REPO_ENTRY_BASE,
        extensions: [
          "packages/pi-subagent/extensions/**",
          "+packages/piabyss-memo/extensions/piabyss-memo.ts",
        ],
      },
    ]);
    expect(isRepoPluginEnabled(agentDir, MEMO_PLUGIN_ENTRY_FILE)).toBe(true);
  });

  it("a -concrete force-exclude wins over a wide include glob", () => {
    agentDir = mkdtempSync(join(tmpdir(), "piabyss-gate-"));
    writeSettings(agentDir, [
      {
        ...REPO_ENTRY_BASE,
        extensions: [
          "packages/*/extensions/**",
          "-packages/piabyss-memo/extensions/piabyss-memo.ts",
        ],
      },
    ]);
    expect(isRepoPluginEnabled(agentDir, MEMO_PLUGIN_ENTRY_FILE)).toBe(false);
    expect(isRepoPluginEnabled(agentDir, PIXIE_PLUGIN_ENTRY_FILE)).toBe(true);
  });

  it("returns a boolean without throwing when the settings file cannot be parsed", () => {
    agentDir = mkdtempSync(join(tmpdir(), "piabyss-gate-"));
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), "{ not json", "utf8");
    // The SDK tolerates malformed settings (defaults apply), so the gate
    // resolves to "no repo entry" => disabled. Either way it must not throw.
    expect(typeof isRepoPluginEnabled(agentDir, MEMO_PLUGIN_ENTRY_FILE)).toBe("boolean");
  });
});
