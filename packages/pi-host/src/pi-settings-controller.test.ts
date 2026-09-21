import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { PiSettingsSnapshot } from "@piabyss/protocol";
import {
  createPiSettingsHandlers,
  removeSupersededPackages,
  SUPERSEDED_PACKAGES,
  withoutSupersededPackages,
} from "./pi-settings-controller.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";

/** Minimal ModelRuntime stand-in: modelSummaries only touches these two. */
function fakeRuntime(
  models: Array<{ provider: string; id: string; name?: string; input?: string[] }>,
  providers: Record<string, string> = {},
): ModelRuntime {
  return {
    getAvailableSnapshot: () => models,
    getProvider: (id: string) =>
      providers[id] !== undefined ? { name: providers[id] } : undefined,
  } as unknown as ModelRuntime;
}

function fakeFactory(runtime: ModelRuntime, agentDir: string): WorkspaceGraphFactory {
  return {
    deps: { modelRuntime: runtime, agentDir },
    getGraph: () => null,
  } as unknown as WorkspaceGraphFactory;
}

describe("piSettings.get model summaries", () => {
  let agentDir = "";

  afterEach(() => {
    if (agentDir) rmSync(agentDir, { recursive: true, force: true });
    agentDir = "";
  });

  async function getSettings(runtime: ModelRuntime): Promise<PiSettingsSnapshot> {
    agentDir = mkdtempSync(join(tmpdir(), "piabyss-pi-settings-"));
    const handlers = createPiSettingsHandlers(fakeFactory(runtime, agentDir), agentDir);
    const response = (await handlers["piSettings.get"]!({} as never)) as {
      result?: PiSettingsSnapshot;
      error?: { message: string };
    };
    if (!response.result) throw new Error(response.error?.message ?? "no result");
    return response.result;
  }

  it("includes the model input modalities in each summary", async () => {
    const snapshot = await getSettings(
      fakeRuntime(
        [
          {
            provider: "openai",
            id: "gpt-4o-mini",
            name: "GPT-4o mini",
            input: ["text", "image"],
          },
          { provider: "test", id: "text-only", input: ["text"] },
        ],
        { openai: "OpenAI" },
      ),
    );
    expect(snapshot.models).toEqual([
      {
        provider: "openai",
        providerName: "OpenAI",
        modelId: "gpt-4o-mini",
        name: "GPT-4o mini",
        thinkingLevels: ["off"],
        input: ["text", "image"],
      },
      {
        provider: "test",
        providerName: undefined,
        modelId: "text-only",
        name: "text-only",
        thinkingLevels: ["off"],
        input: ["text"],
      },
    ]);
  });

  it("falls back to an empty input array for models without modality metadata", async () => {
    const snapshot = await getSettings(fakeRuntime([{ provider: "x", id: "legacy" }]));
    expect(snapshot.models[0]).toMatchObject({ modelId: "legacy", input: [] });
  });
});

describe("piSettings defaultTools", () => {
  let agentDir = "";

  afterEach(() => {
    if (agentDir) rmSync(agentDir, { recursive: true, force: true });
    agentDir = "";
  });

  function setup() {
    agentDir = mkdtempSync(join(tmpdir(), "piabyss-pi-settings-tools-"));
    const handlers = createPiSettingsHandlers(fakeFactory(fakeRuntime([]), agentDir), agentDir);
    return handlers;
  }

  async function patch(
    handlers: ReturnType<typeof createPiSettingsHandlers>,
    params: unknown,
  ): Promise<PiSettingsSnapshot> {
    const response = (await handlers["piSettings.patch"]!({ params } as never)) as {
      result?: PiSettingsSnapshot;
      error?: { message: string };
    };
    if (!response.result) throw new Error(response.error?.message ?? "no result");
    return response.result;
  }

  it("omits defaultTools until it is configured", async () => {
    const handlers = setup();
    const response = (await handlers["piSettings.get"]!({} as never)) as {
      result?: PiSettingsSnapshot;
    };
    expect(response.result?.defaultTools).toBeUndefined();
  });

  it("persists a de-duplicated selection and reads it back", async () => {
    const handlers = setup();
    const result = await patch(handlers, {
      defaultTools: ["read", "bash", "grep", "grep", "ls"],
    });
    expect(result.defaultTools).toEqual(["read", "bash", "grep", "ls"]);

    const written = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as {
      defaultTools?: string[];
    };
    expect(written.defaultTools).toEqual(["read", "bash", "grep", "ls"]);

    const reread = (await handlers["piSettings.get"]!({} as never)) as {
      result?: PiSettingsSnapshot;
    };
    expect(reread.result?.defaultTools).toEqual(["read", "bash", "grep", "ls"]);
  });

  it("persists an empty selection so pi can fall back to its own defaults", async () => {
    const handlers = setup();
    const result = await patch(handlers, { defaultTools: [] });
    expect(result.defaultTools).toEqual([]);
  });
});

describe("piSettings httpProxy", () => {
  let agentDir = "";

  afterEach(() => {
    if (agentDir) rmSync(agentDir, { recursive: true, force: true });
    agentDir = "";
  });

  function setup() {
    agentDir = mkdtempSync(join(tmpdir(), "piabyss-pi-settings-proxy-"));
    return createPiSettingsHandlers(fakeFactory(fakeRuntime([]), agentDir), agentDir);
  }

  async function patch(handlers: ReturnType<typeof createPiSettingsHandlers>, params: unknown) {
    const response = (await handlers["piSettings.patch"]!({ params } as never)) as {
      result?: PiSettingsSnapshot;
      error?: { code?: string; message: string };
    };
    return response;
  }

  it("omits httpProxy until it is configured", async () => {
    const handlers = setup();
    const response = (await handlers["piSettings.get"]!({} as never)) as {
      result?: PiSettingsSnapshot;
    };
    expect(response.result?.httpProxy).toBeUndefined();
  });

  it("persists a valid proxy URL and reads it back", async () => {
    const handlers = setup();
    const response = await patch(handlers, { httpProxy: " http://127.0.0.1:7890 " });
    expect(response.result?.httpProxy).toBe("http://127.0.0.1:7890");

    const written = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as {
      httpProxy?: string;
    };
    expect(written.httpProxy).toBe("http://127.0.0.1:7890");

    const reread = (await handlers["piSettings.get"]!({} as never)) as {
      result?: PiSettingsSnapshot;
    };
    expect(reread.result?.httpProxy).toBe("http://127.0.0.1:7890");
  });

  it("rejects a value that is not a URL without writing settings.json", async () => {
    const handlers = setup();
    const response = await patch(handlers, { httpProxy: "not a url" });
    expect(response.result).toBeUndefined();
    expect(response.error?.code).toBe("INVALID_REQUEST");
  });

  it("rejects a non-http scheme without writing settings.json", async () => {
    const handlers = setup();
    const response = await patch(handlers, { httpProxy: "socks5://127.0.0.1:1080" });
    expect(response.result).toBeUndefined();
    expect(response.error?.code).toBe("INVALID_REQUEST");
  });

  it("clears the setting when patched with an empty value", async () => {
    const handlers = setup();
    const first = await patch(handlers, { httpProxy: "http://127.0.0.1:7890" });
    expect(first.result?.httpProxy).toBe("http://127.0.0.1:7890");

    const cleared = await patch(handlers, { httpProxy: "  " });
    expect(cleared.result?.httpProxy).toBeUndefined();

    const written = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as {
      httpProxy?: string;
    };
    expect("httpProxy" in written).toBe(false);
  });
});

describe("superseded extension packages", () => {
  it("drops only the exact superseded entries and keeps everything else", () => {
    const packages = [
      "npm:betterwright",
      { source: "git:github.com/example/mono", extensions: ["packages/a/**"] },
      SUPERSEDED_PACKAGES[0],
      "npm:@llblab/pi-telegram",
    ];
    const next = withoutSupersededPackages(packages);
    expect(next).toEqual([
      "npm:betterwright",
      { source: "git:github.com/example/mono", extensions: ["packages/a/**"] },
      "npm:@llblab/pi-telegram",
    ]);
  });

  it("reports no change when nothing is superseded", () => {
    expect(withoutSupersededPackages(["npm:betterwright"])).toBeNull();
    expect(withoutSupersededPackages([])).toBeNull();
    // Not an array (absent or malformed settings) is never rewritten.
    expect(withoutSupersededPackages(undefined)).toBeNull();
    expect(withoutSupersededPackages({ source: "x" })).toBeNull();
  });

  it("rewrites settings.json once and is idempotent afterwards", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "piabyss-superseded-"));
    try {
      writeFileSync(
        join(agentDir, "settings.json"),
        JSON.stringify(
          {
            theme: "dark",
            packages: ["npm:betterwright", SUPERSEDED_PACKAGES[0]],
          },
          null,
          2,
        ),
      );
      expect(removeSupersededPackages(agentDir)).toBe(true);
      const after = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as {
        theme?: string;
        packages?: string[];
      };
      expect(after.packages).toEqual(["npm:betterwright"]);
      // Unrelated keys survive the rewrite.
      expect(after.theme).toBe("dark");
      // Second run has nothing left to do.
      expect(removeSupersededPackages(agentDir)).toBe(false);
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("leaves a settings file without a packages key untouched", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "piabyss-superseded-none-"));
    try {
      writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }, null, 2));
      expect(removeSupersededPackages(agentDir)).toBe(false);
      expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toEqual({
        theme: "dark",
      });
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
});

describe("piSettings askUserQuestionEnabled", () => {
  let agentDir = "";

  afterEach(() => {
    if (agentDir) rmSync(agentDir, { recursive: true, force: true });
    agentDir = "";
  });

  it("defaults to enabled and round-trips an explicit disable", async () => {
    agentDir = mkdtempSync(join(tmpdir(), "piabyss-pi-settings-ask-"));
    const handlers = createPiSettingsHandlers(fakeFactory(fakeRuntime([]), agentDir), agentDir);

    const initial = (await handlers["piSettings.get"]!({} as never)) as {
      result?: PiSettingsSnapshot;
    };
    expect(initial.result?.askUserQuestionEnabled).toBe(true);

    const patched = (await handlers["piSettings.patch"]!({
      params: { askUserQuestionEnabled: false },
    } as never)) as { result?: PiSettingsSnapshot };
    expect(patched.result?.askUserQuestionEnabled).toBe(false);

    const written = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as {
      askUserQuestionEnabled?: boolean;
    };
    expect(written.askUserQuestionEnabled).toBe(false);

    const reread = (await handlers["piSettings.get"]!({} as never)) as {
      result?: PiSettingsSnapshot;
    };
    expect(reread.result?.askUserQuestionEnabled).toBe(false);
  });
});
