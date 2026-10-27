#!/usr/bin/env node
/**
 * PiAbyss Host entry — owns all Pi SDK services.
 * Transport: JSONL on stdin/stdout; logs on stderr.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
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
import { createRelayPricingHandlers } from "./relay-pricing-controller.js";
import { createExtensionUiHandlers } from "./extension-ui-bridge.js";
import { createTelegramHandlers } from "./telegram-controller.js";
import { createTelegramSessionHandlers } from "./telegram-sessions-controller.js";
import { createAutomationHandlers } from "./automation-controller.js";
import { automationRoot } from "./automation-api.js";
import { startAutomationNotifyWatcher } from "./automation-notify-watcher.js";
import { createMemoHandlers } from "./memo-controller.js";
import { createShellJobHandlers } from "./shelljob-controller.js";
import { RemoteService } from "./remote/remote-service.js";
import { createRemoteHandlers } from "./remote/remote-controller.js";
import { startShellJobWatcher } from "./shelljob-watcher.js";
import {
  configurePixieRuntime,
  configurePixieEventEmitter,
  pixieDir,
  startPixieStaleWatcher,
  stopPixieStaleWatcher,
} from "./pixie-agent-runner.js";
import { createPixieHandlers, createPixieControlPlaneDeps } from "./pixie-controller.js";
import { startPixieControlPlane, type PixieControlPlane } from "./pixie-control-plane.js";
import { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import { applyKnownThinkingProfiles } from "./model-thinking.js";
import { FileCredentialStore } from "./credential-store.js";
import { ExtensionProviderOwnership } from "./extension-provider-ownership.js";
import { refreshModelsLocal } from "./model-runtime-refresh.js";
import { ensureMigrationBackup, MIGRATION_ID } from "./migration-backup.js";
import { migrateLegacyPiAbyssData } from "./piabyss-data.js";
import { applyHostNetworkSettings, ensureGlobalSettingsFile } from "./network-bootstrap.js";
import { migratePluginLibraryRenames } from "./plugin-library-migration.js";
import { applyPluginEnvAliases } from "./plugin-env-aliases.js";
import { AttachmentStore } from "./attachment-store.js";
import { createAttachmentHandlers } from "./attachment-controller.js";
import { createGitHandlers } from "./git-controller.js";
import { GitAsyncTaskRunner } from "./git-async-tasks.js";
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
  const resolved = arg ? arg.slice("--agent-dir=".length) : join(homedir(), ".pi", "agent");
  // Align plugins that resolve the agent dir via the SDK (getAgentDir reads
  // this env): without the write-back, a Host started with --agent-dir= would
  // disagree with the memo plugin about the memo data directory.
  process.env.PI_CODING_AGENT_DIR ??= resolved;
  return resolved;
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
 * Pixie control-plane token: generated once per agent dir, re-read on every
 * Host start. The value is shared with the pi-pixie plugin through the
 * process environment (PI_PIXIE_HTTP_TOKEN, with the legacy PIABYSS_* copy for
 * older plugin builds) and enforced by the loopback control plane on every
 * request.
 */
function ensurePixieControlToken(agentDir: string): string {
  const tokenPath = join(pixieDir(agentDir), "control-token");
  try {
    const existing = readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch {
    /* first run */
  }
  const token = randomBytes(24).toString("hex");
  try {
    mkdirSync(dirname(tokenPath), { recursive: true });
    writeFileSync(tokenPath, `${token}\n`, "utf8");
  } catch (err) {
    logger.warn("Failed to persist the pixie control token", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return token;
}

/**
 * pi-automation control-plane token, pinned before the runtime loads extensions.
 *
 * The plugin resolves its token lazily (first authenticated request): env →
 * `<automationRoot>/token` → generate and persist, best effort. When that persist
 * does not land the plugin keeps a secret no file-reading caller can obtain,
 * and every automation.* call 401s for the whole life of the process — all the
 * panel can show is "鉴权失败". Env wins on both sides, so publishing the
 * resolved value here takes the file out of the handshake; the file is still
 * written for callers outside this process.
 */
function ensureAutomationControlToken(): void {
  const provided = process.env.PI_AUTOMATION_TOKEN?.trim() || process.env.PI_SCHEDULE_TOKEN?.trim();
  if (provided) {
    // Pin under the current name so the plugin (new name first) and Host read
    // the same value even when the caller still uses the pre-rename variable.
    process.env.PI_AUTOMATION_TOKEN = provided;
    return;
  }
  const root = automationRoot();
  const tokenPath = join(root, "token");
  let token = "";
  try {
    token = readFileSync(tokenPath, "utf8").trim();
  } catch {
    /* first run */
  }
  if (!token) {
    token = randomBytes(24).toString("hex");
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(tokenPath, token, { encoding: "utf8", mode: 0o600 });
    } catch (err) {
      logger.warn("Failed to persist the automation control token", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  process.env.PI_AUTOMATION_TOKEN = token;
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

  // Generic plugin names read PI_MEMO_* / PI_PIXIE_*; desktop settings written
  // before the rename only hold the PIABYSS_* copies. Needs to run before any
  // extension is loaded by a workspace graph.
  const aliasedEnvCount = applyPluginEnvAliases();
  if (aliasedEnvCount > 0) {
    logger.info("Copied legacy plugin env vars to generic names", { count: aliasedEnvCount });
  }

  // The plugin library persists repo-relative extension filters. Rewrite the
  // renamed plugin paths once the new checkout is on disk; an older repo keeps
  // its old paths and stays loadable.
  try {
    await migratePluginLibraryRenames(agentDir);
  } catch (err) {
    logger.warn("Plugin library rename migration failed; keeping existing settings", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  logger.info("Starting Pi Host", {
    agentDir,
    sdkVersion: SDK_VERSION,
    node: process.version,
  });

  // Keep the shared Pi directory native-compatible: adopt PiAbyss-owned data
  // into one private namespace before recovery reads any persisted state.
  // Best-effort: a migration failure degrades to a warning (the next start
  // retries; recovery paths handle missing adoptions safely) — it must never
  // brick Host startup.
  try {
    const migration = await migrateLegacyPiAbyssData(agentDir, MIGRATION_ID);
    if (migration.quarantined.length > 0) {
      logger.warn("Quarantined conflicting legacy PiAbyss data", {
        quarantined: migration.quarantined,
      });
    }
  } catch (err) {
    logger.warn("Legacy PiAbyss data migration failed; continuing with existing state", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const attachmentStore = new AttachmentStore({ agentDir });
  await attachmentStore.initialize();

  // Before anything can rewrite user data. The 0.82.1 runtime introduces
  // models-store.json and recomposes providers, so a downgrade is only safe
  // while the pre-migration bytes still exist.
  const migrationBackup = await ensureMigrationBackup(agentDir);

  // PiAbyss 0.1.x used to filter superseded packages here; the built-in tools
  // moved to my-pi-plugins so nothing is superseded anymore.

  // Pin the pi-automation control-plane token before the runtime loads any
  // extension: the plugin resolves it lazily and the Host reads it per call.
  ensureAutomationControlToken();

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
  // Every session open/switch asks for a model-health refresh, and each run
  // re-registers every provider and re-reads models.json (measured p50 31ms,
  // p90 117ms, worst 2.3s on the switch critical path). The result cannot
  // change while models.json/auth.json are untouched, so remember the health
  // together with the config signature and skip the redundant pass inside the
  // TTL. Config writes change the signature (or the controllers invalidate
  // explicitly), so a real edit still refreshes immediately.
  // The signature — not the TTL — is what keeps this honest: models.json and
  // auth.json are stat'ed on every call, so a real edit refreshes immediately
  // no matter how long the TTL is. The TTL only bounds how often an unchanged
  // config is re-registered, and 2s was short enough that nearly every session
  // open paid it again.
  const MODEL_HEALTH_TTL_MS = 15_000;
  let modelHealthSignature = "";
  let modelHealthAt = 0;
  const modelHealthConfigSignature = (): string => {
    const parts: string[] = [];
    for (const name of ["models.json", "auth.json"]) {
      try {
        const stat = statSync(join(agentDir, name));
        parts.push(`${name}:${Math.trunc(stat.mtimeMs)}:${stat.size}`);
      } catch {
        parts.push(`${name}:missing`);
      }
    }
    return parts.join("|");
  };
  const refreshModelHealthNow = (signal?: AbortSignal): Promise<ModelConfigHealth> => {
    const signature = modelHealthConfigSignature();
    if (signature === modelHealthSignature && Date.now() - modelHealthAt < MODEL_HEALTH_TTL_MS) {
      return Promise.resolve(modelConfigHealth);
    }
    const run = refreshChain.then(() => runRefreshModelHealth(signal));
    refreshChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run.then((health) => {
      modelHealthSignature = signature;
      modelHealthAt = Date.now();
      return health;
    });
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
  const gitAsyncTasks = new GitAsyncTaskRunner(gitService, gitService.gitExecutable, () =>
    graphFactory.getServer(),
  );

  // The pixie (小精灵) resident session shares the same authoritative runtime.
  configurePixieRuntime(modelRuntime);

  // Loopback control plane for the pi-pixie plugin (dispatch/report/ask/rest/
  // inject forward here). Must exist before ANY agent session is created — the
  // port and token are discovered by the plugin through the process env.
  let pixieControlPlane: PixieControlPlane | null = null;
  try {
    const pixieToken = ensurePixieControlToken(agentDir);
    // New generic names first; legacy copies keep pre-rename plugin builds working.
    process.env.PI_PIXIE_HTTP_TOKEN = pixieToken;
    process.env.PIABYSS_PIXIE_HTTP_TOKEN = pixieToken;
    pixieControlPlane = await startPixieControlPlane(createPixieControlPlaneDeps(graphFactory), {
      token: pixieToken,
    });
    process.env.PI_PIXIE_HTTP_PORT = String(pixieControlPlane.port);
    process.env.PIABYSS_PIXIE_HTTP_PORT = String(pixieControlPlane.port);
    // v4.1 失联提醒：定时扫描 dispatches.json，超时未回调的委派推送
    // pixie.staleWarning（每条仅一次）。事件发射器在下方才接线，扫描在
    // 首个 60s tick 时触发，届时 emitter 早已就绪。
    startPixieStaleWatcher(graphFactory);
  } catch (err) {
    // Non-fatal: the plugin's tools degrade to readable errors; everything
    // else keeps working.
    logger.warn("Failed to start the pixie loopback control plane", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 远程控制：安装/配对/Connector 进程都归 Host 管，页面只通过 remote.* 读写。
  const remoteService = new RemoteService({ agentDir });

  const handlers = {
    ...createWorkspaceHandlers(graphFactory, workspaceFiles, gitService),
    ...createGitHandlers(graphFactory, gitService, gitAsyncTasks),
    ...createAttachmentHandlers(graphFactory),
    ...createSessionHandlers(graphFactory),
    ...createAgentHandlers(graphFactory),
    ...createProviderHandlers(graphFactory),
    ...createRelayPricingHandlers(graphFactory),
    ...createPackageHandlers(graphFactory),
    ...createExtensionUiHandlers(graphFactory),
    ...createTelegramHandlers(agentDir),
    ...createTelegramSessionHandlers(agentDir),
    ...createAutomationHandlers(),
    ...createMemoHandlers(agentDir, modelRuntime, modelRegistry),
    ...createPixieHandlers(graphFactory),
    ...createShellJobHandlers(),
    ...createPiSettingsHandlers(graphFactory, agentDir),
    ...createSkillHandlers(graphFactory),
    ...createPromptHandlers(graphFactory),
    ...createRemoteHandlers(remoteService),
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
      await remoteService.dispose();
      workspaceFiles.dispose();
      gitAsyncTasks.abortAll("Host shutdown");
      gitService.dispose();
      if (pixieControlPlane) {
        await pixieControlPlane.close();
        delete process.env.PI_PIXIE_HTTP_PORT;
        delete process.env.PIABYSS_PIXIE_HTTP_PORT;
        delete process.env.PI_PIXIE_HTTP_TOKEN;
        delete process.env.PIABYSS_PIXIE_HTTP_TOKEN;
      }
      stopPixieStaleWatcher();
      const { cancelAllPending } = await import("./extension-ui-bridge.js");
      cancelAllPending("Host shutdown");
      const g = graphFactory.getGraph();
      if (g) {
        await graphFactory.disposeGraph(g);
      }
      await graphFactory.disposeRetainedGraphs();
      await attachmentStore.waitForIdle();
      stopAutomationNotifyWatcher();
      stopShellJobWatcher();
      // Last milestone: only a clean teardown proves the migrated runtime did
      // not leave the agent directory in a state that needs the backup.
      await migrationBackup?.recordMilestone("cleanShutdown");
    },
  });

  graphFactory.bindServer(server);
  // Pixie host events (report/ask/segment timeline) ride the standard event
  // channel; the runner module emits through this indirection because it has
  // no server reference of its own.
  configurePixieEventEmitter((event, payload) => {
    server.emit(event as Parameters<typeof server.emit>[0], payload);
  });
  // Real-time automation notification signal → push host event to the desktop.
  const stopAutomationNotifyWatcher = startAutomationNotifyWatcher((event, payload) =>
    server.emit(event, payload),
  );
  // Background shell job status bar → periodic snapshot push to the desktop.
  const stopShellJobWatcher = startShellJobWatcher((event, payload) => server.emit(event, payload));

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
  // 已授权且开启自动启动时，恢复本机 Connector。放启动末尾：host.ready 已经发出，
  // 安装探测/进程拉起不阻塞桌面首屏。
  void remoteService.ensureAutoStart().catch((err) => {
    logger.warn("Remote control auto-start failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
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
