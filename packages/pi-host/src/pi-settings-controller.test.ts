import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { PiSettingsSnapshot } from "@piabyss/protocol";
import { createPiSettingsHandlers } from "./pi-settings-controller.js";
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
        input: ["text", "image"],
      },
      {
        provider: "test",
        providerName: undefined,
        modelId: "text-only",
        name: "text-only",
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
