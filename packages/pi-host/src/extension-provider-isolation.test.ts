/**
 * Extension provider isolation.
 *
 * Part 1 pins the SDK behaviour that motivates the ownership layer: 0.82.1
 * keeps extension providers in one process-wide map and nothing unregisters
 * them, so a provider registered while workspace A's session loads is still
 * registered — config, credentials and all — after that session is gone.
 * This is the demonstrated leak the handoff document requires before any
 * owner/ref-count infrastructure; it must stay green against the raw SDK.
 *
 * Part 2 proves ExtensionProviderOwnership closes the leak with the semantics
 * the workspace lifecycle depends on: suspend/resume across retention,
 * co-ownership, maintenance neutrality, and host-owned permanence.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ExtensionProviderOwnership } from "./extension-provider-ownership.js";
import { applyKnownThinkingProfiles } from "./model-thinking.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function createRuntime(): Promise<ModelRuntime> {
  return ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
}

function providerConfig(modelId = "leak-model") {
  return {
    baseUrl: "http://localhost:8317/v1",
    apiKey: "test-not-a-real-key",
    api: "openai-completions" as const,
    models: [
      {
        id: modelId,
        name: modelId,
        reasoning: false,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
      },
    ],
  };
}

/**
 * A workspace whose extension registers a provider at load time, driven
 * through the real SDK path: DefaultResourceLoader discovers the extension,
 * createAgentSession flushes its queued registration into the runtime.
 */
async function buildWorkspaceSession(runtime: ModelRuntime, providerId: string) {
  const root = mkdtempSync(join(tmpdir(), "piabyss-provider-iso-"));
  roots.push(root);
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "auth.json"), "{}");
  writeFileSync(join(agentDir, "models.json"), "{}");
  writeFileSync(join(agentDir, "settings.json"), "{}");

  const extensionPath = join(root, "register-provider.js");
  writeFileSync(
    extensionPath,
    [
      "export default function (pi) {",
      `  pi.registerProvider(${JSON.stringify(providerId)}, ${JSON.stringify(providerConfig())});`,
      "}",
    ].join("\n"),
  );

  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [extensionPath],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  expect(resourceLoader.getExtensions().errors).toEqual([]);

  const sessionManager = SessionManager.create(cwd, join(agentDir, "sessions"));
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    settingsManager,
    resourceLoader,
    sessionManager,
  });
  return session;
}

describe("SDK 0.82.1 extension provider lifetime (the leak)", () => {
  it("keeps a workspace extension's provider registered after its session is gone", async () => {
    const runtime = await createRuntime();
    const registry = new ModelRegistry(runtime);

    const session = await buildWorkspaceSession(runtime, "ws-a-leaked-provider");
    expect(registry.getRegisteredProviderIds()).toContain("ws-a-leaked-provider");

    await session.dispose();

    // Nothing in the SDK or a dispose path unregisters: the provider —
    // including the credential material inside its config — remains visible
    // to every later consumer of the shared runtime. This is the leak the
    // ownership layer exists for.
    expect(registry.getRegisteredProviderIds()).toContain("ws-a-leaked-provider");
    expect(registry.find("ws-a-leaked-provider", "leak-model")).toBeDefined();
  }, 30_000);
});

describe("ExtensionProviderOwnership", () => {
  it("attributes the real extension registration path and closes the leak", async () => {
    const runtime = await createRuntime();
    const registry = new ModelRegistry(runtime);
    const ownership = new ExtensionProviderOwnership(runtime);
    const workspaceA = ownership.createOwner("ws-a");

    const session = await ownership.runAsOwner(workspaceA, () =>
      buildWorkspaceSession(runtime, "ws-a-provider"),
    );
    expect(registry.getRegisteredProviderIds()).toContain("ws-a-provider");
    expect(ownership.ownersOf("ws-a-provider")).toEqual(["ws-a"]);

    await session.dispose();
    const suspended = ownership.suspendOwner(workspaceA);

    // Workspace B never sees it.
    expect(registry.getRegisteredProviderIds()).not.toContain("ws-a-provider");
    expect(registry.find("ws-a-provider", "leak-model")).toBeUndefined();

    // Reactivating workspace A restores it.
    ownership.resumeOwner(workspaceA, suspended);
    expect(registry.getRegisteredProviderIds()).toContain("ws-a-provider");
    expect(registry.find("ws-a-provider", "leak-model")).toBeDefined();
  }, 30_000);

  it("keeps a co-owned provider alive until the last owner departs", async () => {
    const runtime = await createRuntime();
    const registry = new ModelRegistry(runtime);
    const ownership = new ExtensionProviderOwnership(runtime);
    const a = ownership.createOwner("ws-a");
    const b = ownership.createOwner("ws-b");

    ownership.runAsOwner(a, () => registry.registerProvider("shared", providerConfig()));
    ownership.runAsOwner(b, () => registry.registerProvider("shared", { name: "Shared from B" }));
    expect([...ownership.ownersOf("shared")].sort()).toEqual(["ws-a", "ws-b"]);

    // A parks; B still needs the provider.
    const suspendedA = ownership.suspendOwner(a);
    expect(registry.getRegisteredProviderIds()).toContain("shared");

    // A comes back while B is alive: merge, no duplicate.
    ownership.resumeOwner(a, suspendedA);
    expect([...ownership.ownersOf("shared")].sort()).toEqual(["ws-a", "ws-b"]);

    // Both gone: unregistered.
    ownership.releaseOwner(a);
    expect(registry.getRegisteredProviderIds()).toContain("shared");
    ownership.releaseOwner(b);
    expect(registry.getRegisteredProviderIds()).not.toContain("shared");
  });

  it("keeps maintenance re-registration ownership-neutral", async () => {
    const runtime = await createRuntime();
    const registry = new ModelRegistry(runtime);
    const ownership = new ExtensionProviderOwnership(runtime);
    const a = ownership.createOwner("ws-a");

    const config = providerConfig("grok-4.5");
    config.models[0]!.reasoning = true;
    ownership.runAsOwner(a, () => registry.registerProvider("profiled", config));

    // The thinking-profile pass re-registers every provider it touches; it
    // must not become a co-owner, or retention could never unregister.
    await ownership.runNeutral(async () => {
      expect(await applyKnownThinkingProfiles(registry)).toBeGreaterThanOrEqual(1);
    });
    expect(ownership.ownersOf("profiled")).toEqual(["ws-a"]);

    const suspended = ownership.suspendOwner(a);
    expect(registry.getRegisteredProviderIds()).not.toContain("profiled");

    // The suspended snapshot carries the maintenance merge back.
    ownership.resumeOwner(a, suspended);
    expect(registry.find("profiled", "grok-4.5")?.thinkingLevelMap).toMatchObject({
      low: "low",
      medium: "medium",
      high: "high",
    });
  });

  it("attributes unscoped registrations to the fallback owner, else the host", async () => {
    const runtime = await createRuntime();
    const registry = new ModelRegistry(runtime);
    const ownership = new ExtensionProviderOwnership(runtime);
    const active = ownership.createOwner("active-graph");

    // No fallback yet: startup registrations (faux provider) are host-owned.
    registry.registerProvider("startup-provider", providerConfig());
    expect(ownership.ownersOf("startup-provider")).toEqual(["host"]);

    // With an active graph, a late Path-B registration (an extension calling
    // pi.registerProvider mid-turn) lands on that graph.
    ownership.setFallbackOwnerSource(() => active);
    registry.registerProvider("mid-turn-provider", providerConfig());
    expect(ownership.ownersOf("mid-turn-provider")).toEqual(["active-graph"]);

    ownership.suspendOwner(active);
    expect(registry.getRegisteredProviderIds()).not.toContain("mid-turn-provider");
    // Host-owned registrations are permanent.
    expect(registry.getRegisteredProviderIds()).toContain("startup-provider");
  });

  it("treats an explicit extension unregister as final", async () => {
    const runtime = await createRuntime();
    const registry = new ModelRegistry(runtime);
    const ownership = new ExtensionProviderOwnership(runtime);
    const a = ownership.createOwner("ws-a");

    ownership.runAsOwner(a, () => registry.registerProvider("short-lived", providerConfig()));
    registry.unregisterProvider("short-lived");
    expect(registry.getRegisteredProviderIds()).not.toContain("short-lived");
    expect(ownership.ownersOf("short-lived")).toEqual([]);

    // Suspending the former owner afterwards must not resurrect or throw.
    const suspended = ownership.suspendOwner(a);
    expect(suspended.classic).toEqual([]);
    expect(registry.getRegisteredProviderIds()).not.toContain("short-lived");
  });
});
