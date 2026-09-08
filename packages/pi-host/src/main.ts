#!/usr/bin/env node
/**
 * PiAbyss Host entry — owns all Pi SDK services.
 * Transport: JSONL on stdin/stdout; logs on stderr.
 */
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ModelRegistry,
  ModelRuntime,
  VERSION as SDK_VERSION,
  DefaultPackageManager,
} from "@earendil-works/pi-coding-agent";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { createHostError, type HostCapabilities, type ModelConfigHealth } from "@piabyss/protocol";
import { buildDegradedModelConfigHealth, buildModelConfigHealth } from "./model-health.js";
import { recoverProviderJournals } from "./provider-journal.js";
import { logger } from "./logger.js";
import { PiHostServer } from "./server.js";
import { createWorkspaceHandlers } from "./workspace-controller.js";
import { WorkspaceFileService } from "./workspace-files.js";
import { createSessionHandlers } from "./session-controller.js";
import { createAgentHandlers } from "./agent-controller.js";
import { createPackageHandlers } from "./package-controller.js";
import { createProviderHandlers } from "./provider-controller.js";
import { createExtensionUiHandlers } from "./extension-ui-bridge.js";
import { createTelegramHandlers } from "./telegram-controller.js";
import { createTelegramSessionHandlers } from "./telegram-sessions-controller.js";
import { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import { applyKnownThinkingProfiles } from "./model-thinking.js";
import { FileCredentialStore } from "./credential-store.js";
import { ExtensionProviderOwnership } from "./extension-provider-ownership.js";
import { refreshModelsLocal } from "./model-runtime-refresh.js";
import { ensureMigrationBackup, MIGRATION_ID } from "./migration-backup.js";
import { migrateLegacyPiAbyssData } from "./piabyss-data.js";
import { applyHostNetworkSettings, ensureGlobalSettingsFile } from "./network-bootstrap.js";
import { AttachmentStore } from "./attachment-store.js";
import { createAttachmentHandlers } from "./attachment-controller.js";
import { createGitHandlers } from "./git-controller.js";
import { GitService } from "./git-service.js";
import { refreshActiveSessionSnapshot } from "./session-snapshot.js";
import { createPiSettingsHandlers } from "./pi-settings-controller.js";
import { createSkillHandlers } from "./skill-controller.js";
import { createPromptHandlers } from "./prompt-controller.js";
import { createSubagentStatusBridge } from "./subagent-status-extension.js";

function resolveAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir && envDir.trim()) return envDir.trim();
  const arg = process.argv.find((a) => a.startsWith("--agent-dir="));
  if (arg) return arg.slice("--agent-dir=".length);
  return join(homedir(), ".pi", "agent");
}

function resolveInitialCwd(): string | null {
  const arg = process.argv.find((a) => a.startsWith("--initial-cwd="));
  const value = arg?.slice("--initial-cwd=".length).trim();
  return value ? value : null;
}

/**
 * C1: how many workspace graphs the host may keep bound for instant return.
 * Parse int, clamp to 1..20, ignore anything non-numeric — absent or invalid
 * env keeps the lifecycle's built-in default.
 */
function resolveMaxBoundWorkspaces(): number | undefined {
  const raw = process.env.PIABYSS_MAX_BOUND_WORKSPACES;
  if (!raw?.trim()) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(20, Math.max(1, parsed));
}

/**
 * Deterministic core-release model. It is opt-in and never enabled for a
 * normal Host process; the desktop E2E runner sets PIABYSS_TEST_FAUX=1.
 */
function installTestFauxProvider(modelRegistry: ModelRegistry): void {
  if (process.env.PIABYSS_TEST_FAUX !== "1") return;

  const faux = createFauxCore({
    api: "piabyss-faux-api",
    provider: "piabyss-faux",
    models: [
      {
        id: "piabyss-core",
        name: "PiAbyss Core Test Model",
        reasoning: false,
        input: ["text"],
        contextWindow: 128_000,
        maxTokens: 16_384,
      },
    ],
    tokensPerSecond: 24,
    tokenSize: { min: 1, max: 4 },
  });

  // prompt: tool call -> tool result turn -> final answer -> title refinement
  // abort: a deliberately long response that remains observable while stopping
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read", { path: "piabyss-core-e2e.txt" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(
      [
        fauxText(
          "PIABYSS_STREAM_START Core chat stream completed after a deterministic tool call. PIABYSS_CORE_CHAT_COMPLETE",
        ),
      ],
      { stopReason: "stop" },
    ),
    fauxAssistantMessage(fauxText("Core chat smoke"), { stopReason: "stop" }),
    fauxAssistantMessage(
      fauxText(
        "PIABYSS_ABORT_STREAM " +
          "This deterministic response is intentionally long enough to exercise the Stop action and abort recovery. ".repeat(
            24,
          ),
      ),
      { stopReason: "stop" },
    ),
    fauxAssistantMessage(fauxText("PIABYSS_ABORT_RECOVERED"), {
      stopReason: "stop",
    }),
  ]);

  modelRegistry.registerProvider("piabyss-faux", {
    name: "PiAbyss Core Test Model",
    api: faux.api,
    apiKey: "piabyss-e2e",
    baseUrl: "http://piabyss-faux.invalid",
    streamSimple: faux.streamSimple,
    models: faux.models.map((model) => ({
      id: model.id,
      name: model.name,
      api: model.api,
      reasoning: model.reasoning,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })),
  });
  logger.info("Installed deterministic faux provider for core E2E");
}

async function main(): Promise<void> {
  const agentDir = resolveAgentDir();
  const maxBoundWorkspaces = resolveMaxBoundWorkspaces();
  mkdirSync(agentDir, { recursive: true });

  // Synchronous, before any network activity: proxy/idle-timeout from global
  // settings (never applied by the SDK on the library path) and a guaranteed
  // settings file for the desktop "Open settings.json" affordance.
  ensureGlobalSettingsFile(agentDir);
  applyHostNetworkSettings(agentDir);

  logger.info("Starting Pi Host", {
    agentDir,
    sdkVersion: SDK_VERSION,
    node: process.version,
  });

  // Keep the shared Pi directory native-compatible: adopt PiAbyss-owned data
  // into one private namespace before recovery reads any persisted state.
  await migrateLegacyPiAbyssData(agentDir, MIGRATION_ID);
  const attachmentStore = new AttachmentStore({ agentDir });
  await attachmentStore.initialize();

  // Before anything can rewrite user data. The 0.82.1 runtime introduces
  // models-store.json and recomposes providers, so a downgrade is only safe
  // while the pre-migration bytes still exist.
  const migrationBackup = await ensureMigrationBackup(agentDir);

  // Cwd-independent services (PROJECT_SPEC §8.1)
  const credentialStore = FileCredentialStore.forAgentDir(agentDir);

  // Resolve any provider mutation the previous run did not finish, before the
  // runtime reads models.json or auth.json. An unresolved journal means the two
  // files may disagree, which no amount of refreshing can detect.
  const unresolvedRecovery = await recoverProviderJournals(agentDir, credentialStore);

  // The single authoritative runtime. `allowModelNetwork: false` keeps startup
  // offline; only an explicit user refresh may reach the network later.
  const modelRuntime = await ModelRuntime.create({
    credentials: credentialStore,
    modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "models-store.json"),
    allowModelNetwork: false,
  });
  await migrationBackup?.recordMilestone("runtimeCreate");
  const modelRegistry = new ModelRegistry(modelRuntime);

  // Wraps the runtime's provider registration before anything registers:
  // startup registrations (faux provider) become host-owned; workspace
  // extension registrations become suspendable per graph.
  const providerOwnership = new ExtensionProviderOwnership(modelRuntime);

  installTestFauxProvider(modelRegistry);
  // Degraded outranks a parse check and is sticky: the Host cannot re-derive
  // whether the configuration became coherent, so it stops claiming health
  // until a restart finds no journal.
  const resolveModelConfigHealth = () =>
    unresolvedRecovery
      ? buildDegradedModelConfigHealth(unresolvedRecovery)
      : buildModelConfigHealth(modelRuntime.getError());
  let modelConfigHealth = resolveModelConfigHealth();

  // B1: the deferred startup refresh broadcasts through the same channel as
  // the controllers. A no-op until `graphFactory.onModelHealthChanged` is
  // bound below (after bindServer): before that there is no transport to
  // notify — the desktop reads full status on connect, so skipping is safe.
  let broadcastModelHealth: () => void = () => {};

  // Shared local reconcile pass (B1): exactly what the controllers'
  // refreshModelHealth dep runs, extracted so the deferred startup refresh
  // produces identical state. Reconciliation only — a network catalog fetch is
  // a separate, explicitly authorised call and must never happen here.
  const runRefreshModelHealth = async (signal?: AbortSignal): Promise<ModelConfigHealth> => {
    await refreshModelsLocal(modelRuntime, { signal });
    // Neutral: the profile pass re-registers existing providers and must
    // not become a co-owner that pins another workspace's provider alive.
    await providerOwnership.runNeutral(() =>
      applyKnownThinkingProfiles(modelRegistry, modelRuntime, join(agentDir, "models.json")),
    );
    modelConfigHealth = resolveModelConfigHealth();
    return modelConfigHealth;
  };

  // Serialized: refresh and the thinking-profile pass both re-register
  // providers on the same runtime, so concurrent invocations (startup IIFE vs
  // a controller-triggered health refresh) would expose a mid-state. Calls
  // queue behind each other instead of interleaving; each keeps its own
  // abort signal and rejection.
  let refreshChain: Promise<unknown> = Promise.resolve();
  const refreshModelHealthNow = (signal?: AbortSignal): Promise<ModelConfigHealth> => {
    const run = refreshChain.then(() => runRefreshModelHealth(signal));
    refreshChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  // Inline neutral profile pass FIRST: it must land before the first graph
  // reads the registry, and it must complete before the deferred refresh
  // below starts — both re-register providers on the same runtime, so
  // running them concurrently would expose a mid-state to the first graph.
  await providerOwnership.runNeutral(() =>
    applyKnownThinkingProfiles(modelRegistry, modelRuntime, join(agentDir, "models.json")),
  );

  // B1: the local model refresh is off the critical path. Startup no longer
  // waits for it. The IIFE serializes refresh → profiles → health so its own
  // steps can never interleave. The localRefresh milestone may now land after
  // server start — allowed, because a late or lost milestone only retains the
  // migration backup longer.
  void (async () => {
    await refreshModelHealthNow();
    await migrationBackup?.recordMilestone("localRefresh");
    broadcastModelHealth();
  })().catch((err: unknown) => {
    // Never trip the unhandledRejection fatal path: a failed local reconcile
    // only leaves the startup health snapshot stale until the next refresh.
    logger.warn("Deferred startup model refresh failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // Capability detection — check prototype without constructing full PackageManager
  const packageUpdateCheck =
    typeof (DefaultPackageManager.prototype as { checkForAvailableUpdates?: unknown })
      .checkForAvailableUpdates === "function";

  const capabilities: HostCapabilities = {
    packageUpdateCheck,
    extensionUi: true,
    sessionExport: true,
  };

  const graphFactory = new WorkspaceGraphFactory({
    agentDir,
    subagentStatusBridgeFactory: (emit, options) => createSubagentStatusBridge(emit, options),
    attachmentStore,
    credentialStore,
    modelRuntime,
    modelRegistry,
    providerOwnership,
    getModelConfigHealth: () => modelConfigHealth,
    refreshModelHealth: (signal) => refreshModelHealthNow(signal),
    ...(maxBoundWorkspaces !== undefined ? { maxBoundWorkspaces } : {}),
    ...(migrationBackup
      ? {
          recordMigrationMilestone: (milestone) => migrationBackup.recordMilestone(milestone),
        }
      : {}),
    packageUpdateCheck,
  });
  // Late Path-B registrations (an extension calling pi.registerProvider in
  // the middle of an agent turn) are attributed to the active workspace.
  providerOwnership.setFallbackOwnerSource(() => graphFactory.getGraph()?.providerOwner ?? null);
  const workspaceFiles = new WorkspaceFileService();
  const gitService = new GitService();

  const handlers = {
    ...createWorkspaceHandlers(graphFactory, workspaceFiles, gitService),
    ...createGitHandlers(graphFactory, gitService),
    ...createAttachmentHandlers(graphFactory),
    ...createSessionHandlers(graphFactory),
    ...createAgentHandlers(graphFactory),
    ...createProviderHandlers(graphFactory),
    ...createPackageHandlers(graphFactory),
    ...createExtensionUiHandlers(graphFactory),
    ...createTelegramHandlers(agentDir),
    ...createTelegramSessionHandlers(agentDir),
    ...createPiSettingsHandlers(graphFactory, agentDir),
    ...createSkillHandlers(graphFactory),
    ...createPromptHandlers(graphFactory),
  };

  const server = new PiHostServer({
    agentDir,
    sdkVersion: SDK_VERSION,
    getModelConfigHealth: () => modelConfigHealth,
    capabilities,
    handlers,
    getRehydrateState: () => {
      const graph = graphFactory.getGraph();
      const session = graph ? refreshActiveSessionSnapshot(graph) : null;
      return {
        workspace: graph ? graphFactory.buildWorkspaceSnapshot(graph) : null,
        session,
        tools: session?.tools ?? null,
        packages: graph?.packageSnapshot ?? null,
      };
    },
    onShutdown: async () => {
      workspaceFiles.dispose();
      gitService.dispose();
      const { cancelAllPending } = await import("./extension-ui-bridge.js");
      cancelAllPending("Host shutdown");
      const g = graphFactory.getGraph();
      if (g) {
        await graphFactory.disposeGraph(g);
      }
      await graphFactory.disposeRetainedGraphs();
      await attachmentStore.waitForIdle();
      // Last milestone: only a clean teardown proves the migrated runtime did
      // not leave the agent directory in a state that needs the backup.
      await migrationBackup?.recordMilestone("cleanShutdown");
    },
  });

  graphFactory.bindServer(server);

  // Re-emit status when model health is refreshed by controllers
  graphFactory.onModelHealthChanged = () => {
    server.emit("host.statusChanged", server.buildStatus());
  };
  // Now the deferred startup refresh (B1) can broadcast like a controller.
  broadcastModelHealth = () => graphFactory.onModelHealthChanged?.();

  // Unknown detached-task failures invalidate Host authority. Publish fatal,
  // perform bounded cleanup, and let the desktop apply its restart policy.
  process.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    logger.error("Unhandled promise rejection in Pi Host", {
      error: message,
      stack: reason instanceof Error ? reason.stack : undefined,
    });
    void server.requestFatalShutdown(
      createHostError("INTERNAL_ERROR", `Unhandled asynchronous failure: ${message}`),
      "unhandled promise rejection",
    );
  });
  process.on("uncaughtException", (err) => {
    logger.error("Uncaught exception in Pi Host", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    process.exit(1);
  });
  process.once("SIGINT", () => {
    void server.requestShutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void server.requestShutdown("SIGTERM");
  });

  // Preload the last-used workspace BEFORE the server starts reading stdin
  // and announces ready: the expensive first graph build (user packages,
  // extensions) overlaps WebView/frontend startup, and early client requests
  // simply wait in the stdin buffer — no identity races. Failures are
  // non-fatal: the frontend falls back to its own workspace.setCurrent.
  const initialCwd = resolveInitialCwd();
  // B1 opt-in switch (PIABYSS_DEFER_PRELOAD=1): skip the blocking preload so
  // host.ready lands before any graph is built and the frontend drives
  // workspace.setCurrent itself. Unset — the default — keeps today's
  // overlap-preload behaviour exactly.
  const deferPreload = process.env.PIABYSS_DEFER_PRELOAD === "1";
  if (initialCwd && deferPreload) {
    logger.info("initial workspace preload deferred", {
      cwd: initialCwd,
      phase: "waitingForWorkspace",
    });
  } else if (initialCwd) {
    const preloadStarted = Date.now();
    try {
      const preload = await graphFactory.setCurrent(initialCwd, randomUUID());
      if ("error" in preload) {
        logger.warn("initial workspace preload failed", {
          cwd: initialCwd,
          error: preload.error.message,
        });
      } else {
        logger.info("initial workspace preloaded", {
          cwd: initialCwd,
          ms: Date.now() - preloadStarted,
        });
      }
    } catch (err) {
      logger.warn("initial workspace preload crashed", {
        cwd: initialCwd,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const serverStartStarted = Date.now();
  await server.start();
  logger.info("host server started", {
    ms: Date.now() - serverStartStarted,
    initialWorkspace: initialCwd ? (deferPreload ? "deferred" : "preloaded") : "none",
  });
  await migrationBackup?.recordMilestone("serverStart");
}

main().catch((err) => {
  logger.error("Fatal host startup error", {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.stderr.write(
    JSON.stringify({
      protocolVersion: 1,
      event: "host.fatal",
      sequence: 0,
      timestamp: Date.now(),
      hostInstanceId: "startup-failed",
      workspaceId: null,
      workspaceRevision: 0,
      sessionId: null,
      sessionRevision: 0,
      packageRevision: 0,
      payload: {
        error: {
          code: "INTERNAL_ERROR",
          message: err instanceof Error ? err.message : String(err),
          retryable: false,
        },
      },
    }) + "\n",
  );
  process.exit(1);
});
