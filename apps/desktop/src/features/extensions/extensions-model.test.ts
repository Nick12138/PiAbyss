import { describe, expect, it } from "vitest";
import type {
  PackageRecord,
  PackageSnapshot,
  PackageUpdateSummary,
  PluginLibraryCatalog,
  ResourceRecord,
} from "@piabyss/protocol";
import {
  buildLibraryItems,
  buildPackageToggleUpdates,
  computeExtensionUpdateRows,
  effectiveResourceEnabled,
  filterLibraryItems,
  findLibraryItem,
  groupResourcesByType,
  installBlockReason,
  itemResources,
  packagePreferenceState,
} from "./extensions-model";

const REPO_SOURCE = "git:github.com/example/my-pi-plugins";

function catalog(): PluginLibraryCatalog {
  return {
    specVersion: 1,
    registryUrl: "https://example.test/plugins.json",
    repoSource: REPO_SOURCE,
    fetchedAt: 0,
    warnings: [],
    plugins: [
      {
        id: "pi-web",
        name: "Web search",
        description: "Search the web.",
        icon: "🔍",
        version: "0.1.0",
        install: { type: "repo", path: "packages/pi-web" },
        tags: ["search"],
        config: [{ key: "key", type: "text", label: "Key", env: "WEB_KEY" }],
      },
      {
        id: "pi-browser",
        name: "Browser",
        description: "Browser automation.",
        icon: "🌐",
        version: "1.0.0",
        install: { type: "npm", source: "npm:betterwright" },
      },
    ],
  };
}

function pkg(overrides: Partial<PackageRecord> = {}): PackageRecord {
  return {
    id: "pkg-repo",
    identity: REPO_SOURCE,
    source: REPO_SOURCE,
    kind: "git",
    scope: "user",
    filtered: false,
    installed: true,
    displayName: "my-pi-plugins",
    versionOrRef: "1.0.0",
    effective: true,
    resourceCounts: null,
    resourceCountsState: "resolvedEffective",
    ...overrides,
  };
}

function resource(overrides: Partial<ResourceRecord> = {}): ResourceRecord {
  return {
    id: "res-web",
    type: "extension",
    name: "pi-web.ts",
    path: "C:/agent/git/github.com/example/my-pi-plugins/packages/pi-web/extensions/pi-web.ts",
    scope: "user",
    origin: "package",
    source: REPO_SOURCE,
    packageId: "pkg-repo",
    enabled: true,
    preferences: {},
    control: { kind: "preference", scopes: ["user", "project"] },
    diagnostics: [],
    ...overrides,
  };
}

function snapshot(overrides: Partial<PackageSnapshot> = {}): PackageSnapshot {
  return {
    revision: 1,
    workspaceId: "w1",
    scope: "all",
    configured: [pkg()],
    resources: [
      resource(),
      resource({
        id: "res-web-skill",
        type: "skill",
        name: "web-fetch",
        path: "C:/agent/git/github.com/example/my-pi-plugins/packages/pi-web/skills/web-fetch/SKILL.md",
      }),
      resource({
        id: "res-ocr",
        type: "extension",
        name: "pi-ocr.ts",
        path: "C:/agent/git/github.com/example/my-pi-plugins/packages/pi-ocr/extensions/pi-ocr.ts",
      }),
    ],
    updateCheck: { supported: true },
    diagnostics: [],
    ...overrides,
  };
}

const globalScope = { kind: "global" } as const;
const workspaceScope = { kind: "workspace", current: true } as const;
const previewScope = { kind: "workspace", current: false } as const;

function updates(...entries: Array<[string, string, string]>): PackageUpdateSummary[] {
  return entries.map(([packageId, current, available]) => ({
    packageId,
    source: `npm:${packageId}`,
    current,
    available,
  }));
}

describe("buildLibraryItems", () => {
  it("keeps uninstalled registry plugins visible and scopes repo resources to their folder", () => {
    const items = buildLibraryItems({
      catalog: catalog(),
      packages: snapshot(),
      scope: globalScope,
      updates: new Map(),
    });

    const web = items.find((item) => item.id === "pi-web")!;
    expect(web.installed).toBe(true);
    expect(web.resourceTypes).toEqual(["extension", "skill"]);
    expect(web.hasConfig).toBe(true);
    // The sibling repo plugin's resources do not leak into this card.
    expect(itemResources(web, snapshot().resources).map((entry) => entry.id)).toEqual([
      "res-web",
      "res-web-skill",
    ]);

    const browser = items.find((item) => item.id === "pi-browser")!;
    expect(browser.installed).toBe(false);
    expect(browser.toggleable).toBe(false);
  });

  it("does not treat a configured-but-missing package as an installed plugin", () => {
    const phantom = pkg({
      id: "pkg-browser",
      identity: "npm:betterwright",
      source: "npm:betterwright",
      kind: "npm",
      installed: false,
      displayName: "betterwright",
    });
    const packages = snapshot({ configured: [phantom], resources: [] });

    for (const scope of [globalScope, workspaceScope, previewScope]) {
      const browser = buildLibraryItems({
        catalog: catalog(),
        packages,
        scope,
        updates: new Map(),
      }).find((item) => item.id === "pi-browser")!;
      expect(browser.installed, scope.kind).toBe(false);
      expect(browser.toggleable).toBe(false);
    }
  });

  it("lists packages in every scope and reads the layer the scope manages", () => {
    const resources = [
      resource({ preferences: { user: "enabled", project: "disabled" } }),
      resource({ id: "res-web-skill", preferences: { user: "disabled", project: "disabled" } }),
      resource({
        id: "res-ocr",
        path: "C:/agent/git/github.com/example/my-pi-plugins/packages/pi-ocr/extensions/pi-ocr.ts",
      }),
    ];
    const packages = snapshot({ resources });

    const [globalItem] = buildLibraryItems({
      catalog: null,
      packages,
      scope: globalScope,
      updates: new Map(),
    }).filter((item) => item.kind === "package");
    expect(globalItem!.kind).toBe("package");
    expect(globalItem!.enabled).toBe(true);

    const [projectItem] = buildLibraryItems({
      catalog: null,
      packages,
      scope: workspaceScope,
      updates: new Map(),
    }).filter((item) => item.kind === "package");
    expect(projectItem!.enabled).toBe(true);
    expect(projectItem!.toggleable).toBe(true);
  });

  it("marks items updatable from either the update check or the snapshot", () => {
    const packages = snapshot({
      configured: [pkg({ updateAvailable: true })],
    });
    const items = buildLibraryItems({
      catalog: catalog(),
      packages,
      scope: globalScope,
      updates: new Map([["pkg-repo", updates(["pkg-repo", "1.0.0", "1.2.0"])[0]!]]),
    });

    const web = items.find((item) => item.id === "pi-web")!;
    expect(web.updatable).toBe(true);
    expect(web.latestVersion).toBe("1.2.0");
    const record = items.find((item) => item.kind === "package")!;
    expect(record.updatable).toBe(true);
  });
});

describe("filterLibraryItems", () => {
  const items = buildLibraryItems({
    catalog: catalog(),
    packages: snapshot(),
    scope: globalScope,
    updates: new Map(),
  });

  it("filters by status, type and query", () => {
    expect(
      filterLibraryItems(items, { query: "", status: "not-installed", type: "all" }).map(
        (item) => item.id,
      ),
    ).toEqual(["pi-browser"]);
    expect(
      filterLibraryItems(items, { query: "", status: "all", type: "package" }).map(
        (item) => item.id,
      ),
    ).toEqual(["pkg-repo"]);
    expect(
      filterLibraryItems(items, { query: "", status: "all", type: "skill" }).map((item) => item.id),
    ).toEqual(["pi-web", "pkg-repo"]);
    expect(
      filterLibraryItems(items, { query: "browser", status: "all", type: "all" }).map(
        (item) => item.id,
      ),
    ).toEqual(["pi-browser"]);
  });

  it("finds an item by its grid identity", () => {
    expect(findLibraryItem(items, "pkg-repo")?.name).toBe("my-pi-plugins");
    expect(findLibraryItem(items, "missing")).toBeUndefined();
    expect(findLibraryItem(items, null)).toBeUndefined();
  });
});

describe("resource preferences", () => {
  it("layers project over user over the resolved state", () => {
    const inherited = resource({ enabled: true, preferences: { user: "disabled" } });
    expect(effectiveResourceEnabled(inherited, "user")).toBe(false);
    expect(effectiveResourceEnabled(inherited, "project")).toBe(false);
    expect(
      effectiveResourceEnabled(
        resource({ enabled: false, preferences: { user: "disabled", project: "enabled" } }),
        "project",
      ),
    ).toBe(true);
  });

  it("derives the package segmented state and skips no-op writes", () => {
    const resources = [
      resource({ preferences: { user: "enabled" } }),
      resource({ id: "res-web-skill", preferences: { user: "disabled" } }),
    ];
    expect(packagePreferenceState(resources, "user")).toBe("mixed");
    expect(packagePreferenceState([], "user")).toBeNull();

    expect(buildPackageToggleUpdates(resources, "user", true)).toEqual([
      { resourceId: "res-web-skill", targetScope: "user", preference: "enabled" },
    ]);
    // Project scope only writes an override where the effective state differs.
    expect(buildPackageToggleUpdates(resources, "project", true)).toEqual([
      { resourceId: "res-web-skill", targetScope: "project", preference: "enabled" },
    ]);
  });

  it("groups resources in package order", () => {
    expect(groupResourcesByType(snapshot().resources).map((group) => group.type)).toEqual([
      "extension",
      "skill",
    ]);
  });
});

describe("computeExtensionUpdateRows", () => {
  it("collapses repo plugins and adds packages the registry does not cover", () => {
    const packages = snapshot({
      configured: [pkg(), pkg({ id: "pkg-tools", displayName: "Tools", source: "npm:tools" })],
    });
    const rows = computeExtensionUpdateRows(
      catalog(),
      packages,
      updates(["pkg-repo", "1.0.0", "1.2.0"], ["pkg-tools", "0.9.0", "1.0.0"]),
    );

    expect(rows.map((row) => row.key)).toEqual(["repo:pkg-repo", "package:pkg-tools"]);
    expect(rows[0]!.repoPluginCount).toBe(1);
    expect(rows[1]!.label).toBe("Tools");
  });
});

describe("installBlockReason", () => {
  it("only allows installing from the global scope", () => {
    expect(installBlockReason(globalScope)).toBeNull();
    expect(installBlockReason(workspaceScope)).toBe("global-only");
    expect(installBlockReason(previewScope)).toBe("global-only");
  });
});
