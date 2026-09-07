import { mkdtempSync, rmSync } from "node:fs";
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
