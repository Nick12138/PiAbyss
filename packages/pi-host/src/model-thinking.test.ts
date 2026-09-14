import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentSession, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { applyKnownThinkingProfiles, rebindCurrentSessionModel } from "./model-thinking.js";

describe("applyKnownThinkingProfiles", () => {
  it("applies Grok 4.5 levels without replacing an explicit map", async () => {
    const registry = new ModelRegistry(
      await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        allowModelNetwork: false,
      }),
    );
    registry.registerProvider("test-profile", {
      baseUrl: "http://localhost:8317/v1",
      apiKey: "test",
      api: "openai-completions",
      models: [
        {
          id: "grok-4.5",
          name: "Grok 4.5",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 16384,
        },
        {
          id: "grok-4.5-custom",
          name: "Grok custom",
          reasoning: true,
          thinkingLevelMap: { minimal: "tiny" },
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 16384,
        },
        {
          id: "glm-5.2",
          name: "GLM 5.2",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 272000,
          maxTokens: 65536,
        },
      ],
    });

    expect(await applyKnownThinkingProfiles(registry)).toBeGreaterThanOrEqual(1);
    expect(registry.find("test-profile", "grok-4.5")?.thinkingLevelMap).toMatchObject({
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
    });
    expect(registry.find("test-profile", "grok-4.5-custom")?.thinkingLevelMap).toEqual({
      minimal: "tiny",
    });
    expect(registry.find("test-profile", "glm-5.2")?.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    });
  });

  it("folds unknown OpenAI-compatible reasoning models to common effort levels", async () => {
    const registry = new ModelRegistry(
      await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        allowModelNetwork: false,
      }),
    );
    registry.registerProvider("test-sglang", {
      baseUrl: "http://localhost:30000/v1",
      apiKey: "test",
      api: "openai-completions",
      models: [
        {
          id: "my-sglang-model",
          name: "SGLang server model",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 16384,
        },
      ],
    });

    expect(await applyKnownThinkingProfiles(registry)).toBeGreaterThanOrEqual(1);
    expect(registry.find("test-sglang", "my-sglang-model")?.thinkingLevelMap).toEqual({
      off: "none",
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "high",
      max: "max",
    });
  });

  it("folds a models.json reasoning model like agnes-2.5-flash", async () => {
    const registry = new ModelRegistry(
      await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        allowModelNetwork: false,
      }),
    );
    registry.registerProvider("agnes", {
      baseUrl: "https://apihub.agnes-ai.com/v1",
      apiKey: "test",
      authHeader: true,
      api: "openai-completions",
      models: [
        {
          id: "agnes-2.5-flash",
          name: "agnes-2.5-flash",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 272000,
          maxTokens: 65536,
        },
      ],
    });

    expect(await applyKnownThinkingProfiles(registry)).toBe(1);
    expect(registry.find("agnes", "agnes-2.5-flash")?.thinkingLevelMap).toEqual({
      off: "none",
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "high",
      max: "max",
    });
  });

  it("folds models.json providers surfaced through the runtime", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "piabyss-thinking-"));
    const modelsPath = join(agentDir, "models.json");
    const modelsStorePath = join(agentDir, "models-store.json");
    writeFileSync(
      modelsPath,
      JSON.stringify({
        providers: {
          agn: {
            name: "agn",
            baseUrl: "https://apihub.agnes-ai.com/v1",
            apiKey: "test",
            authHeader: true,
            api: "openai-completions",
            models: [
              {
                id: "agnes-2.5-flash",
                name: "agnes-2.5-flash",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 272000,
                maxTokens: 65536,
              },
            ],
          },
        },
      }),
    );
    try {
      const runtime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath,
        modelsStorePath,
        allowModelNetwork: false,
      });
      const registry = new ModelRegistry(runtime);

      expect(await applyKnownThinkingProfiles(registry, runtime, modelsPath)).toBe(1);
      expect(runtime.getModel("agn", "agnes-2.5-flash")?.thinkingLevelMap).toEqual({
        off: "none",
        minimal: "low",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "high",
        max: "max",
      });
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("re-reads a models.json provider after the config changes on disk", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "piabyss-thinking-"));
    const modelsPath = join(agentDir, "models.json");
    const modelsStorePath = join(agentDir, "models-store.json");
    const writeProvider = (baseUrl: string, modelId: string) =>
      writeFileSync(
        modelsPath,
        JSON.stringify({
          providers: {
            agn: {
              name: "agn",
              baseUrl,
              apiKey: "test",
              api: "openai-completions",
              models: [
                {
                  id: modelId,
                  name: modelId,
                  reasoning: true,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128000,
                  maxTokens: 16384,
                },
              ],
            },
          },
        }),
      );
    try {
      writeProvider("https://old.example.com/v1", "agn-old");
      const runtime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath,
        modelsStorePath,
        allowModelNetwork: false,
      });
      const registry = new ModelRegistry(runtime);

      // First pass pins the extension overlay from the config as loaded.
      expect(await applyKnownThinkingProfiles(registry, runtime, modelsPath)).toBe(1);
      expect(runtime.getModel("agn", "agn-old")?.baseUrl).toBe("https://old.example.com/v1");

      // The provider.save mutation path: rewrite models.json, then a local
      // refresh (recompose against the new file).
      writeProvider("https://new.example.com/v1", "agn-new");
      await runtime.refresh({ allowNetwork: false });

      // The pass must follow the on-disk edit: a stale overlay keeps serving
      // the old model list — and each model's pinned old baseUrl — otherwise.
      await applyKnownThinkingProfiles(registry, runtime, modelsPath);
      expect(runtime.getModel("agn", "agn-old")).toBeUndefined();
      expect(runtime.getModel("agn", "agn-new")?.baseUrl).toBe("https://new.example.com/v1");

      // Steady state: a third pass over an unchanged config must not
      // churn (re-registering on every refresh would fork model objects).
      expect(await applyKnownThinkingProfiles(registry, runtime, modelsPath)).toBe(0);
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("drops a models.json overlay after the provider is removed from the config", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "piabyss-thinking-"));
    const modelsPath = join(agentDir, "models.json");
    const modelsStorePath = join(agentDir, "models-store.json");
    const writeProviders = (providers: Record<string, unknown>) =>
      writeFileSync(modelsPath, JSON.stringify({ providers }));
    try {
      writeProviders({
        agn: {
          name: "agn",
          baseUrl: "https://apihub.agnes-ai.com/v1",
          apiKey: "test",
          api: "openai-completions",
          models: [
            {
              id: "agnes-2.5-flash",
              name: "agnes-2.5-flash",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 16384,
            },
          ],
        },
      });
      const runtime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath,
        modelsStorePath,
        allowModelNetwork: false,
      });
      const registry = new ModelRegistry(runtime);

      expect(await applyKnownThinkingProfiles(registry, runtime, modelsPath)).toBe(1);
      expect(registry.getRegisteredProviderConfig("agn")).toBeDefined();

      // provider.remove committed: the provider is gone from models.json.
      writeProviders({});
      await runtime.refresh({ allowNetwork: false });
      await applyKnownThinkingProfiles(registry, runtime, modelsPath);

      // The overlay must not keep the deleted provider and its models alive.
      expect(registry.getRegisteredProviderConfig("agn")).toBeUndefined();
      expect(runtime.getModel("agn", "agnes-2.5-flash")).toBeUndefined();
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("leaves unknown non-OpenAI reasoning models without a fallback map", async () => {
    const registry = new ModelRegistry(
      await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        allowModelNetwork: false,
      }),
    );
    registry.registerProvider("test-native", {
      baseUrl: "https://api.example.com",
      apiKey: "test",
      api: "anthropic-messages",
      models: [
        {
          id: "claude-custom-unknown",
          name: "Custom Claude",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200000,
          maxTokens: 32000,
        },
      ],
    });

    expect(await applyKnownThinkingProfiles(registry)).toBe(0);
    expect(registry.find("test-native", "claude-custom-unknown")?.thinkingLevelMap).toBeUndefined();
  });

  it("rebinds a live session to the refreshed registry model", () => {
    const previous = { provider: "muapi", id: "grok-4.5" };
    const refreshed = {
      provider: "muapi",
      id: "grok-4.5",
      thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
    };
    const state = { model: previous };
    const setThinkingLevel = vi.fn();
    const session = {
      model: previous,
      state,
      thinkingLevel: "high",
      setThinkingLevel,
    } as unknown as AgentSession;
    const registry = {
      find: () => refreshed,
    } as unknown as ModelRegistry;

    expect(rebindCurrentSessionModel(session, registry)).toBe(true);
    expect(state.model).toBe(refreshed);
    expect(setThinkingLevel).toHaveBeenCalledWith("high");
  });
});
