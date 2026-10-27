import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migratePluginLibraryRenames } from "./plugin-library-migration.js";

const REPO_SOURCE = "git:github.com/Nick12138/my-pi-plugins";

let agentDir = "";

afterEach(() => {
  if (agentDir) rmSync(agentDir, { recursive: true, force: true });
  agentDir = "";
});

function prepare(packages: unknown[], installedMarkers: string[]): void {
  agentDir = mkdtempSync(join(tmpdir(), "piabyss-plugin-migration-"));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages }, null, 2), "utf8");
  const repoRoot = join(agentDir, "git", "github.com", "Nick12138", "my-pi-plugins");
  for (const marker of installedMarkers) {
    const file = join(repoRoot, marker);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "", "utf8");
  }
}

function readPackages(): Array<{ source: string; extensions?: string[] }> {
  const raw = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as {
    packages: Array<{ source: string; extensions?: string[] }>;
  };
  return raw.packages;
}

describe("migratePluginLibraryRenames", () => {
  it("rewrites renamed repo plugin paths once the new checkout exists", async () => {
    prepare(
      [
        {
          source: REPO_SOURCE,
          extensions: [
            "packages/pi-subagent/extensions/**",
            "packages/piabyss-memo/extensions/**",
            "-packages/piabyss-present-files/extensions/piabyss-present-files.ts",
          ],
        },
      ],
      [
        "packages/pi-memo/extensions/pi-memo.ts",
        "packages/pi-present-files/extensions/pi-present-files.ts",
      ],
    );

    expect(await migratePluginLibraryRenames(agentDir)).toHaveLength(2);
    expect(readPackages()[0]?.extensions).toEqual([
      "packages/pi-subagent/extensions/**",
      "packages/pi-memo/extensions/**",
      "-packages/pi-present-files/extensions/pi-present-files.ts",
    ]);
  });

  it("keeps old paths when the new checkout is not installed yet", async () => {
    prepare(
      [
        {
          source: REPO_SOURCE,
          extensions: ["packages/piabyss-memo/extensions/**"],
        },
      ],
      [],
    );

    expect(await migratePluginLibraryRenames(agentDir)).toEqual([]);
    expect(readPackages()[0]?.extensions).toEqual(["packages/piabyss-memo/extensions/**"]);
  });

  it("is a no-op for unrelated repo filters", async () => {
    prepare(
      [
        {
          source: REPO_SOURCE,
          extensions: ["packages/pi-subagent/extensions/**"],
        },
      ],
      ["packages/pi-memo/extensions/pi-memo.ts"],
    );

    expect(await migratePluginLibraryRenames(agentDir)).toEqual([]);
    expect(readPackages()[0]?.extensions).toEqual(["packages/pi-subagent/extensions/**"]);
  });
});
