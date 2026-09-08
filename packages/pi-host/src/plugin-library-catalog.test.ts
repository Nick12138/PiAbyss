import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PLUGIN_LIBRARY_REGISTRY_URL,
  PLUGIN_LIBRARY_REPO_SOURCE,
  getPluginLibraryCatalog,
  resetPluginLibraryCatalogCache,
} from "./plugin-library-catalog.js";

type TestCatalogFetcher = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

function fetchJson(body: unknown, status = 200) {
  return vi.fn<TestCatalogFetcher>(async (_url, _init) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  }));
}

const VALID_REGISTRY = {
  specVersion: 1,
  plugins: [
    {
      id: "pi-web",
      name: "联网搜索",
      description: "Tavily + Exa MCP.",
      icon: "🔍",
      version: "0.1.0",
      author: "Nick12138",
      tags: ["搜索", "web"],
      install: { type: "repo", path: "packages/pi-web" },
      config: [
        {
          key: "tavilyApiKey",
          type: "text",
          label: "Tavily API Key",
          env: "TAVILY_API_KEY",
          secret: true,
          required: false,
        },
        {
          key: "defaultProvider",
          type: "select",
          label: "默认搜索引擎",
          env: "PI_WEB_PROVIDER",
          default: "auto",
          options: [
            { value: "auto", label: "自动" },
            { value: "tavily", label: "仅 Tavily" },
          ],
        },
      ],
    },
    {
      id: "pi-browser",
      name: "浏览器",
      description: "BetterWright.",
      icon: "🌐",
      version: "1.10.0",
      install: { type: "npm", source: "npm:betterwright" },
    },
  ],
};

afterEach(() => {
  resetPluginLibraryCatalogCache();
});

describe("getPluginLibraryCatalog", () => {
  it("fetches and sanitizes a valid registry", async () => {
    const fetchImpl = fetchJson(VALID_REGISTRY);
    const out = await getPluginLibraryCatalog({ fetchImpl });
    if (!("catalog" in out)) throw new Error(out.error.message);
    expect(fetchImpl).toHaveBeenCalledWith(
      PLUGIN_LIBRARY_REGISTRY_URL,
      expect.objectContaining({ headers: { accept: "application/json" } }),
    );
    expect(out.catalog.repoSource).toBe(PLUGIN_LIBRARY_REPO_SOURCE);
    expect(out.catalog.specVersion).toBe(1);
    expect(out.catalog.plugins.map((p) => p.id)).toEqual(["pi-web", "pi-browser"]);
    expect(out.catalog.plugins[0]).toMatchObject({
      install: { type: "repo", path: "packages/pi-web" },
      config: [
        expect.objectContaining({ key: "tavilyApiKey", secret: true }),
        expect.objectContaining({ key: "defaultProvider", default: "auto" }),
      ],
    });
    expect(out.catalog.warnings).toEqual([]);
  });

  it("serves the cached catalog within the TTL", async () => {
    const fetchImpl = fetchJson(VALID_REGISTRY);
    await getPluginLibraryCatalog({ fetchImpl, nowMs: 1_000 });
    fetchImpl.mockClear();
    const out = await getPluginLibraryCatalog({ fetchImpl, nowMs: 1_001 });
    expect("catalog" in out).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("bypasses the cache and the remote URL cache when refresh is requested", async () => {
    const fetchImpl = fetchJson(VALID_REGISTRY);
    await getPluginLibraryCatalog({ fetchImpl, nowMs: 1_000 });
    await getPluginLibraryCatalog({ fetchImpl, refresh: true, nowMs: 1_001 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      `${PLUGIN_LIBRARY_REGISTRY_URL}?_piabyss_refresh=1001`,
    );
    expect(fetchImpl.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        headers: { accept: "application/json", "cache-control": "no-cache" },
      }),
    );
  });

  it("propagates HTTP failures as retryable errors", async () => {
    const out = await getPluginLibraryCatalog({ fetchImpl: fetchJson("nope", 500) });
    expect("error" in out).toBe(true);
    if ("error" in out) {
      expect(out.error.code).toBe("CATALOG_UNAVAILABLE");
      expect(out.error.retryable).toBe(true);
    }
  });

  it("rejects non-JSON bodies", async () => {
    const out = await getPluginLibraryCatalog({ fetchImpl: fetchJson("<html>nope</html>") });
    expect("error" in out).toBe(true);
  });

  it("drops invalid entries and duplicate ids with warnings", async () => {
    const registry = {
      specVersion: 1,
      plugins: [
        VALID_REGISTRY.plugins[0],
        {
          id: "Bad Id",
          name: "x",
          description: "x",
          icon: "x",
          version: "1",
          install: { type: "npm", source: "npm:x" },
        },
        {
          id: "pi-web",
          name: "dup",
          description: "dup",
          icon: "x",
          version: "1",
          install: { type: "git", source: "git:github.com/a/b" },
        },
        {
          id: "pi-evil",
          name: "x",
          description: "x",
          icon: "x",
          version: "1",
          install: { type: "repo", path: "../escape" },
        },
      ],
    };
    const out = await getPluginLibraryCatalog({ fetchImpl: fetchJson(registry) });
    if (!("catalog" in out)) throw new Error(out.error.message);
    expect(out.catalog.plugins.map((p) => p.id)).toEqual(["pi-web"]);
    expect(out.catalog.warnings).toHaveLength(3);
  });

  it("accepts a select with optionsSource but no static options", async () => {
    const registry = {
      specVersion: 1,
      plugins: [
        {
          id: "pi-vision",
          name: "视觉",
          description: "x",
          icon: "👁️",
          version: "1",
          install: { type: "repo", path: "packages/pi-vision" },
          config: [
            {
              key: "visionModel",
              type: "select",
              label: "默认视觉模型",
              env: "PI_VISION_MODEL",
              default: "",
              optionsSource: "pi:vision-models",
            },
          ],
        },
      ],
    };
    const out = await getPluginLibraryCatalog({ fetchImpl: fetchJson(registry) });
    if (!("catalog" in out)) throw new Error(out.error.message);
    expect(out.catalog.warnings).toEqual([]);
    expect(out.catalog.plugins).toHaveLength(1);
    expect(out.catalog.plugins[0]?.config?.[0]).toEqual({
      key: "visionModel",
      type: "select",
      label: "默认视觉模型",
      env: "PI_VISION_MODEL",
      default: "",
      optionsSource: "pi:vision-models",
    });
  });

  it("accepts empty static options when optionsSource is set, keeps them otherwise", async () => {
    const registry = {
      specVersion: 1,
      plugins: [
        {
          id: "pi-vision",
          name: "视觉",
          description: "x",
          icon: "👁️",
          version: "1",
          install: { type: "repo", path: "packages/pi-vision" },
          config: [
            {
              key: "visionModel",
              type: "select",
              label: "默认视觉模型",
              env: "PI_VISION_MODEL",
              optionsSource: "pi:vision-models",
              options: [],
            },
            {
              key: "hybrid",
              type: "select",
              label: "混合",
              env: "PI_VISION_HYBRID",
              optionsSource: "pi:future-source",
              options: [{ value: "a", label: "A" }],
            },
          ],
        },
      ],
    };
    const out = await getPluginLibraryCatalog({ fetchImpl: fetchJson(registry) });
    if (!("catalog" in out)) throw new Error(out.error.message);
    expect(out.catalog.warnings).toEqual([]);
    const [visionModel, hybrid] = out.catalog.plugins[0]?.config ?? [];
    expect(visionModel).toMatchObject({ optionsSource: "pi:vision-models" });
    expect(visionModel?.options).toBeUndefined();
    expect(hybrid).toMatchObject({
      optionsSource: "pi:future-source",
      options: [{ value: "a", label: "A" }],
    });
  });

  it("rejects config items with a non-string optionsSource", async () => {
    const registry = {
      specVersion: 1,
      plugins: [
        {
          id: "pi-broken",
          name: "x",
          description: "x",
          icon: "x",
          version: "1",
          install: { type: "npm", source: "npm:x" },
          config: [{ key: "k", type: "select", label: "l", env: "X_OK", optionsSource: 42 }],
        },
      ],
    };
    const out = await getPluginLibraryCatalog({ fetchImpl: fetchJson(registry) });
    if (!("catalog" in out)) throw new Error(out.error.message);
    expect(out.catalog.plugins).toHaveLength(0);
    expect(out.catalog.warnings).toHaveLength(1);
  });

  it("rejects select config items without options", async () => {
    const registry = {
      specVersion: 1,
      plugins: [
        {
          id: "pi-broken",
          name: "x",
          description: "x",
          icon: "x",
          version: "1",
          install: { type: "npm", source: "npm:x" },
          config: [{ key: "k", type: "select", label: "l", env: "X_OK" }],
        },
      ],
    };
    const out = await getPluginLibraryCatalog({ fetchImpl: fetchJson(registry) });
    if (!("catalog" in out)) throw new Error(out.error.message);
    expect(out.catalog.plugins).toHaveLength(0);
    expect(out.catalog.warnings).toHaveLength(1);
  });

  it("rejects config items with invalid env variable names", async () => {
    const registry = {
      specVersion: 1,
      plugins: [
        {
          id: "pi-broken",
          name: "x",
          description: "x",
          icon: "x",
          version: "1",
          install: { type: "npm", source: "npm:x" },
          config: [{ key: "k", type: "text", label: "l", env: "NOT A VAR" }],
        },
      ],
    };
    const out = await getPluginLibraryCatalog({ fetchImpl: fetchJson(registry) });
    if (!("catalog" in out)) throw new Error(out.error.message);
    expect(out.catalog.plugins).toHaveLength(0);
    expect(out.catalog.warnings).toHaveLength(1);
  });
});
