import { describe, expect, it } from "vitest";
import type {
  PackageSnapshot,
  PackageUpdateSummary,
  PluginLibraryCatalog,
  ResourceRecord,
} from "@piabyss/protocol";
import { computePluginUpdateRows } from "./plugin-updates";

const REPO_SOURCE = "git:github.com/Nick12138/my-pi-plugins";

function catalog(): PluginLibraryCatalog {
  return {
    specVersion: 1,
    registryUrl: "https://example.com/plugins.json",
    repoSource: REPO_SOURCE,
    fetchedAt: 0,
    warnings: [],
    plugins: [
      {
        id: "pi-browser",
        name: "浏览器",
        description: "Browser.",
        icon: "🌐",
        version: "1.10.0",
        install: { type: "npm", source: "npm:betterwright" },
      },
      {
        id: "pi-web",
        name: "联网搜索",
        description: "Web search.",
        icon: "🔍",
        version: "0.1.0",
        install: { type: "repo", path: "packages/pi-web" },
      },
      {
        id: "pi-ocr",
        name: "文档提取",
        description: "OCR.",
        icon: "📄",
        version: "0.2.0",
        install: { type: "repo", path: "packages/pi-ocr" },
      },
    ],
  };
}

function record(
  overrides: Partial<PackageSnapshot["configured"][number]> & { id: string },
): PackageSnapshot["configured"][number] {
  return {
    identity: overrides.id,
    source: overrides.id,
    kind: "npm",
    scope: "user",
    filtered: false,
    installed: true,
    displayName: overrides.id,
    effective: true,
    resourceCounts: { extensions: 1, skills: 0, prompts: 0, themes: 0, enabled: 1, disabled: 0 },
    resourceCountsState: "resolvedEffective",
    ...overrides,
  } as PackageSnapshot["configured"][number];
}

function resource(id: string, packageId: string, path: string): ResourceRecord {
  return {
    id,
    packageId,
    path,
    type: "extension",
    enabled: true,
    origin: "package",
    mode: "user",
    userPreference: "enabled",
  } as unknown as ResourceRecord;
}

function snapshot(): PackageSnapshot {
  return {
    workspaceId: "w1",
    revision: 1,
    scope: "all",
    configured: [
      record({ id: "pkg-browser", identity: "npm:betterwright", source: "npm:betterwright" }),
      record({
        id: "pkg-repo",
        identity: REPO_SOURCE,
        source: REPO_SOURCE,
        kind: "git",
        displayName: "my-pi-plugins",
      }),
    ],
    resources: [
      resource("res-browser", "pkg-browser", "node_modules/betterwright/extensions/x.ts"),
      resource("res-web", "pkg-repo", "/git/myrepo/packages/pi-web/extensions/pi-web.ts"),
      resource("res-ocr", "pkg-repo", "/git/myrepo/packages/pi-ocr/extensions/pi-ocr.ts"),
    ],
    updateCheck: { supported: true },
    diagnostics: [],
  };
}

describe("computePluginUpdateRows", () => {
  it("maps npm plugin updates to individual rows", () => {
    const updates: PackageUpdateSummary[] = [
      {
        packageId: "pkg-browser",
        source: "npm:betterwright",
        current: "1.9.0",
        available: "1.10.0",
      },
    ];
    const rows = computePluginUpdateRows(catalog(), snapshot(), updates);
    expect(rows).toEqual([
      {
        key: "plugin:pkg-browser",
        packageId: "pkg-browser",
        label: "浏览器",
        current: "1.9.0",
        available: "1.10.0",
      },
    ]);
  });

  it("collapses every installed repo plugin into a single bundled repo row", () => {
    const updates: PackageUpdateSummary[] = [
      { packageId: "pkg-repo", source: REPO_SOURCE },
    ];
    const rows = computePluginUpdateRows(catalog(), snapshot(), updates);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: "repo:pkg-repo",
      packageId: "pkg-repo",
      label: "my-pi-plugins",
      repoPluginCount: 2,
    });
  });

  it("combines npm and repo updates in catalog order (npm first here)", () => {
    const updates: PackageUpdateSummary[] = [
      { packageId: "pkg-browser", source: "npm:betterwright", current: "1.0.0", available: "2.0.0" },
      { packageId: "pkg-repo", source: REPO_SOURCE },
    ];
    const rows = computePluginUpdateRows(catalog(), snapshot(), updates);
    expect(rows.map((row) => row.key)).toEqual(["plugin:pkg-browser", "repo:pkg-repo"]);
  });

  it("ignores updates for packages that map to no installed curated plugin", () => {
    const updates: PackageUpdateSummary[] = [
      { packageId: "pkg-unrelated", source: "npm:something-else" },
    ];
    expect(computePluginUpdateRows(catalog(), snapshot(), updates)).toEqual([]);
  });

  it("skips catalog entries whose package is no longer installed", () => {
    const packages = snapshot();
    packages.configured = packages.configured.filter((r) => r.id !== "pkg-browser");
    const updates: PackageUpdateSummary[] = [
      { packageId: "pkg-browser", source: "npm:betterwright", current: "1.0.0", available: "2.0.0" },
    ];
    expect(computePluginUpdateRows(catalog(), packages, updates)).toEqual([]);
  });
});
