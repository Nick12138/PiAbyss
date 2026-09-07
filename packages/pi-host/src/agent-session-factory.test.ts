import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createHostAgentSession } from "./agent-session-factory.js";
import { createTempAgentLayout, type TempAgentLayout } from "./test-helpers/temp-agent.js";
import { createTestModelServices } from "./test-helpers/model-runtime.js";

const layouts: TempAgentLayout[] = [];

afterEach(() => {
  for (const layout of layouts.splice(0)) layout.cleanup();
});

function provider(id: string, modelIds: string[]) {
  return {
    name: id,
    baseUrl: `https://${id}.example/v1`,
    api: "openai-completions",
    models: modelIds.map((modelId) => ({ id: modelId })),
  };
}

async function setup(
  config: Record<string, unknown>,
  credentials: Record<string, unknown> = {
    disabled: { type: "api_key", key: "disabled-test-key" },
    enabled: { type: "api_key", key: "enabled-test-key" },
  },
) {
  const layout = createTempAgentLayout("piabyss-agent-session-policy-");
  layouts.push(layout);
  writeFileSync(join(layout.agentDir, "models.json"), JSON.stringify(config));
  writeFileSync(join(layout.agentDir, "auth.json"), JSON.stringify(credentials));
  const { modelRuntime } = await createTestModelServices(layout.agentDir);
  return { layout, modelRuntime };
}

describe("createHostAgentSession Provider policy", () => {
  it("replaces a saved model whose Provider is disabled", async () => {
    const { layout, modelRuntime } = await setup({
      piabyssEnabledProviders: ["enabled"],
      providers: {
        disabled: provider("disabled", ["disabled-model"]),
        enabled: provider("enabled", ["enabled-model"]),
      },
    });
    const sessionManager = SessionManager.inMemory(layout.projectDir);
    sessionManager.appendModelChange("disabled", "disabled-model");
    sessionManager.appendMessage({ role: "user", content: "restore me", timestamp: Date.now() });
    const settingsManager = SettingsManager.inMemory(
      { defaultProvider: "disabled", defaultModel: "disabled-model" },
      { projectTrusted: true },
    );

    const { session } = await createHostAgentSession({
      cwd: layout.projectDir,
      agentDir: layout.agentDir,
      modelRuntime,
      settingsManager,
      sessionManager,
    });

    expect(session.model).toMatchObject({ provider: "enabled", id: "enabled-model" });
    session.dispose();
  });

  it("preserves the SDK-restored model when the enabled list is explicitly empty",
    async () => {
      const { layout, modelRuntime } = await setup({
        piabyssEnabledProviders: [],
        providers: {
          disabled: provider("disabled", ["disabled-model"]),
          enabled: provider("enabled", ["enabled-model"]),
        },
      });
      const sessionManager = SessionManager.inMemory(layout.projectDir);
      sessionManager.appendModelChange("disabled", "disabled-model");
      sessionManager.appendMessage({ role: "user", content: "restore me", timestamp: Date.now() });

      const { session } = await createHostAgentSession({
        cwd: layout.projectDir,
        agentDir: layout.agentDir,
        modelRuntime,
        settingsManager: SettingsManager.inMemory({}, { projectTrusted: true }),
        sessionManager,
      });

      // SDK has no clearModel API; without an eligible PiAbyss model the session
      // falls back to whatever was saved in the session history.
      expect(session.model).toMatchObject({ provider: "disabled", id: "disabled-model" });
      session.dispose();
    });



  it("honors a configured model allow-list during restoration", async () => {
    const { layout, modelRuntime } = await setup(
      {},
      { anthropic: { type: "api_key", key: "anthropic-test-key" } },
    );
    const [hidden, allowed] = modelRuntime.getModels("anthropic");
    if (!hidden || !allowed) throw new Error("Missing builtin Anthropic test models");
    writeFileSync(
      join(layout.agentDir, "models.json"),
      JSON.stringify({ piabyssProviderModels: { anthropic: [allowed.id] } }),
    );
    const sessionManager = SessionManager.inMemory(layout.projectDir);
    sessionManager.appendModelChange("anthropic", hidden.id);
    sessionManager.appendMessage({ role: "user", content: "restore me", timestamp: Date.now() });

    const { session } = await createHostAgentSession({
      cwd: layout.projectDir,
      agentDir: layout.agentDir,
      modelRuntime,
      settingsManager: SettingsManager.inMemory({}, { projectTrusted: true }),
      sessionManager,
    });

    expect(session.model).toMatchObject({ provider: "anthropic", id: allowed.id });
    session.dispose();
  });

  it("preserves SDK-native selection when no PiAbyss policy exists", async () => {
    const { layout, modelRuntime } = await setup(
      {},
      { anthropic: { type: "api_key", key: "anthropic-test-key" } },
    );
    const preferred = modelRuntime.getModels("anthropic")[0];
    if (!preferred) throw new Error("Missing builtin Anthropic test model");

    const { session } = await createHostAgentSession({
      cwd: layout.projectDir,
      agentDir: layout.agentDir,
      modelRuntime,
      settingsManager: SettingsManager.inMemory(
        { defaultProvider: "anthropic", defaultModel: preferred.id },
        { projectTrusted: true },
      ),
      sessionManager: SessionManager.inMemory(layout.projectDir),
    });

    expect(session.model).toMatchObject({ provider: "anthropic", id: preferred.id });
    session.dispose();
  });
});
