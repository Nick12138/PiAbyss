import { randomUUID } from "node:crypto";
import { getSupportedThinkingLevels, type ImageContent, type Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  buildAttachmentGuideBlock,
  buildAttachmentReferenceBlock,
  createHostError,
  stripAttachmentReferenceBlocks,
  type AttachmentSnapshot,
  type HostError,
  type HostIdentity,
  type ModelSummary,
  type QueueSnapshot,
  type SerializableImage,
} from "@piabyss/protocol";
import type { AgentOperationLock } from "./locks.js";
import type { MethodHandler, PiHostServer } from "./server.js";
import type { BackgroundSessionRuntime, WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import { buildSessionSnapshot, buildToolSnapshot } from "./session-snapshot.js";
import { rebindCurrentSessionModel } from "./model-thinking.js";
import { getEnabledProviderIds, getProviderModelAllowLists } from "./provider-models-config.js";
import { withRegisteredGraphMutation } from "./registered-graph-mutation.js";
import { createProvisionalSessionTitle } from "./session-title.js";
import { withStableGraphRead } from "./stable-graph-read.js";
import {
  carryImagesAcrossEdit,
  pruneQueuedImages,
  recordQueuedImages,
  restoreQueuedImages,
  snapshotQueuedImages,
  takeQueuedImages,
} from "./queue-attachments.js";
import {
  resolveExtensionCommandInvocation,
  withExtensionCommandOrigin,
} from "./extension-invocation-context.js";
import { logger } from "./logger.js";
import { attachmentHostError } from "./attachment-controller.js";
import { READ_ATTACHMENT_TOOL_NAME } from "./attachment-tool.js";
import {
  buildPromptCacheFingerprint,
  diffPromptCacheFingerprints,
  type PromptCacheFingerprint,
} from "./prompt-cache-contract.js";

/** Protocol images ({mediaType,data}) → SDK ImageContent ({type,mimeType,data}). */
function toSdkImages(images: SerializableImage[] | undefined): ImageContent[] | undefined {
  if (!images?.length) return undefined;
  return images.map((image) => ({
    type: "image" as const,
    data: image.data,
    mimeType: image.mediaType,
  }));
}

/** Upper bound for waiting on session.abort() while holding the graph lock. */
const ABORT_SETTLE_TIMEOUT_MS = 15_000;

/** Last prompt-cache fingerprint attempt per session (A2 reconciliation). */
interface SessionPromptCacheState {
  hash: string;
  // Kept alongside `hash` so drift logs can name the changed components.
  parts: Record<string, string>;
  runId: string;
  at: number;
}

/**
 * Per-session memory of the last attempted prompt-cache fingerprint.
 * Overwritten at the start of every prompt, so a failed/aborted run leaves
 * no dirty state: the next run simply diffs against the last attempt.
 */
const promptCacheStates = new WeakMap<AgentSession, SessionPromptCacheState>();

/**
 * Fingerprint the request-prefix inputs that provider KV caches key on.
 * SDK surface verified against @earendil-works/pi-coding-agent 0.84.2:
 * `session.model` (Model<any> | undefined; provider + id), `session.systemPrompt`
 * (string getter), `session.getActiveToolNames()` (ordered string[]),
 * `session.thinkingLevel` (ThinkingLevel getter).
 */
function collectPromptCacheFingerprint(session: AgentSession): PromptCacheFingerprint {
  const model = session.model;
  return buildPromptCacheFingerprint({
    modelId: model?.id,
    provider: model?.provider,
    systemPrompt: session.systemPrompt,
    toolNames: session.getActiveToolNames(),
    thinkingLevel: session.thinkingLevel,
  });
}

/**
 * A2 prompt-cache contract: diff this run's cache-prefix fingerprint
 * against the session's previous attempt and log the drift. Pure
 * observability — never mutates the request. Coverage note: only the
 * agent.prompt path flows through startDetachedPrompt; steer/followUp/
 * compact call the session API directly with no host hook, so drift on
 * those paths stays invisible until the SDK gains a hook (patches/ SDK
 * patch mechanism — out of scope here).
 */
function reconcilePromptCache(
  session: AgentSession,
  sessionId: string | null,
  runId: string,
): void {
  const fingerprint = collectPromptCacheFingerprint(session);
  const previous = promptCacheStates.get(session);
  promptCacheStates.set(session, { hash: fingerprint.hash, parts: fingerprint.parts, runId, at: Date.now() });
  if (!previous) {
    logger.debug("Prompt cache fingerprint baseline", {
      sessionId,
      runId,
      hash: fingerprint.hash,
    });
  } else if (previous.hash !== fingerprint.hash) {
    logger.warn(
      "Prompt cache prefix drift: provider prompt cache will be invalidated for this run",
      {
        sessionId,
        runId,
        changed: diffPromptCacheFingerprints(previous.parts, fingerprint.parts),
        prevHash: previous.hash,
        nextHash: fingerprint.hash,
      },
    );
  } else {
    logger.debug("Prompt cache fingerprint unchanged", { sessionId, runId, hash: fingerprint.hash });
  }
}

export function summarizeModel(model: Model<any>, providerName?: string): ModelSummary {
  return {
    provider: model.provider,
    providerName,
    modelId: model.id,
    name: model.name ?? model.id,
    thinkingLevels: getSupportedThinkingLevels(model).map(String),
  };
}

function startDetachedPrompt(args: {
  requestId: string;
  factory: WorkspaceGraphFactory;
  server: PiHostServer;
  session: AgentSession;
  operationLock: AgentOperationLock;
  text: string;
  images?: ImageContent[];
  streamingBehavior?: "steer" | "followUp";
}): string {
  let runStatePublished = false;
  let detachedTaskStarted = false;
  const cleanup = (settledIdentity?: HostIdentity) => {
    args.operationLock.release(args.requestId);
    if (runStatePublished) {
      // agent_settled fires before AgentSession.prompt() resolves. Until this
      // lock is released, isSessionBusy() still reports running and suppresses
      // the idle edge. Publish once more after release so completion reaches
      // the desktop and the cross-workspace activity tracker.
      if (settledIdentity) {
        args.factory.publishCurrentRuntimeState(args.session, settledIdentity);
      }
      args.factory.clearSessionRunId(args.session);
      if (args.server.getPhase() === "agentBusy" && !args.factory.hasBusySessions()) {
        args.server.setPhase("ready");
      }
      args.factory.currentRunId = null;
    }
  };

  try {
    const runId = randomUUID();
    // C1: attribute every provider registration inside this turn to the graph
    // that started it, not to whichever graph happens to be active when a late
    // pi.registerProvider fires. Captured synchronously: the detached task
    // below may run after the active graph changed.
    const initiatingOwner = args.factory.getGraph()?.providerOwner ?? null;
    const runIdentity = args.server.getIdentity();
    const visibleText = stripAttachmentReferenceBlocks(args.text);
    const provisionalTitle =
      args.session.sessionName?.trim() || !visibleText.trim()
        ? null
        : createProvisionalSessionTitle(visibleText);
    const titleSessionId = args.server.identity.sessionId;
    const extensionCommandInvocation = resolveExtensionCommandInvocation(args.session, args.text);

    reconcilePromptCache(args.session, titleSessionId, runId);

    runStatePublished = true;
    args.factory.currentRunId = runId;
    args.factory.setSessionRunId(args.session, runId);
    args.server.setPhase("agentBusy");
    if (provisionalTitle) args.factory.setActiveSessionName(provisionalTitle);

    void (async () => {
      let completed = false;
      try {
        const runPrompt = () =>
          args.session.prompt(args.text, {
            streamingBehavior: args.streamingBehavior,
            ...(args.images ? { images: args.images } : {}),
          });
        // Outermost wrap (C1): withExtensionCommandOrigin stays inside the
        // ownership scope so the whole turn — extension-command invocations
        // included — registers against the initiating graph's owner.
        const runTurn = () =>
          extensionCommandInvocation
            ? withExtensionCommandOrigin(
                args.session,
                runId,
                extensionCommandInvocation,
                runPrompt,
              )
            : runPrompt();
        if (initiatingOwner) {
          await args.factory.deps.providerOwnership.runAsOwner(initiatingOwner, runTurn);
        } else {
          // No owner (e.g. failed graph): keep the ambient fallback behaviour.
          await runTurn();
        }
        completed = true;
      } catch (err) {
        args.server.emitForIdentity(runIdentity, "agent.event", {
          runId,
          event: {
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          },
        });
        args.server.emitForIdentity(runIdentity, "session.runtimeChanged", {
          sessionId: runIdentity.sessionId!,
          sessionRevision: runIdentity.sessionRevision,
          state: "error",
          updatedAt: Date.now(),
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        cleanup(completed ? runIdentity : undefined);
      }
      if (completed && provisionalTitle && titleSessionId) {
        await args.factory.refineActiveSessionName({
          session: args.session,
          sessionId: titleSessionId,
          provisionalTitle,
          userPrompt: args.text,
        });
      }
    })().catch((err: unknown) => {
      logger.error("Detached agent prompt task failed", {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    detachedTaskStarted = true;
    return runId;
  } finally {
    if (!detachedTaskStarted) cleanup();
  }
}

/** Hidden OCR instructions injected alongside attachments that need OCR. */
function buildOcrGuideText(attachments: readonly AttachmentSnapshot[]): string | null {
  const scanned = attachments.filter((attachment) => attachment.status === "needs_ocr");
  if (scanned.length === 0) return null;
  const list = scanned
    .map((attachment) => {
      const pages = attachment.unitCount !== undefined ? `（共 ${attachment.unitCount} 页）` : "";
      return `- ${attachment.name}${pages}`;
    })
    .join("\n");
  return [
    "【扫描版 PDF 处理指引】",
    "以下附件是扫描版 PDF（无文字层，read_attachment 读不到内容）：",
    list,
    "",
    "提取文字内容时按以下优先级处理：",
    "1. 优先使用 wpscli（WPS CLI 的 OCR 转换，如 wps_pdf2word 的 scanned 模式）；",
    "2. 其次使用 PyMuPDF（fitz）把 PDF 逐页渲染成图片，再用 ocr_image（百度 OCR）逐页识别；",
    "3. 兕底：使用视觉能力一张一张查看渲染出的图片；",
    "4. 若以上全部失败，请明确提示需要用户帮助并说明原因。",
    "",
    "提示：附件引用 JSON 中的 path 字段是原始文件的绝对路径，可直接用文件系统工具读取。",
  ].join("\n");
}

async function buildPromptWithAttachments(args: {
  factory: WorkspaceGraphFactory;
  sessionId: string;
  text: string;
  attachmentIds?: string[];
}): Promise<{ text: string; attachmentIds: string[] }> {
  if (!args.attachmentIds?.length) return { text: args.text, attachmentIds: [] };
  const store = args.factory.deps.attachmentStore;
  if (!store) throw new Error("Attachment service is not available");
  const attachments = await store.prepareForPrompt(args.attachmentIds, args.sessionId);
  const ocrGuide = buildOcrGuideText(attachments);
  return {
    text: [
      args.text.trimEnd(),
      buildAttachmentReferenceBlock(attachments),
      ...(ocrGuide ? [buildAttachmentGuideBlock(ocrGuide)] : []),
    ]
      .filter(Boolean)
      .join("\n\n"),
    attachmentIds: attachments.map((attachment) => attachment.id),
  };
}

function commitPromptAttachments(
  factory: WorkspaceGraphFactory,
  sessionId: string,
  attachmentIds: readonly string[],
): void {
  if (attachmentIds.length === 0) return;
  void factory.deps.attachmentStore
    ?.commitToSession(attachmentIds, sessionId)
    .catch((error: unknown) => {
      logger.warn("Failed to mark attachment references as committed", {
        sessionId,
        attachmentIds,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

type QueueTexts = Pick<QueueSnapshot, "steering" | "followUp">;

async function enqueueQueue(session: AgentSession, queue: QueueTexts): Promise<void> {
  for (const text of queue.steering) {
    const images = takeQueuedImages(session, text);
    try {
      await session.steer(text, images);
    } catch (err) {
      if (images) recordQueuedImages(session, text, images);
      throw err;
    }
    if (images) {
      recordQueuedImages(session, session.getSteeringMessages().at(-1) ?? text, images);
    }
  }
  for (const text of queue.followUp) {
    const images = takeQueuedImages(session, text);
    try {
      await session.followUp(text, images);
    } catch (err) {
      if (images) recordQueuedImages(session, text, images);
      throw err;
    }
    if (images) {
      recordQueuedImages(session, session.getFollowUpMessages().at(-1) ?? text, images);
    }
  }
}

async function replaceQueue(session: AgentSession, queue: QueueTexts): Promise<void> {
  session.clearQueue();
  await enqueueQueue(session, queue);
}

function queueConflictError(expectedRevision: number, queue: QueueSnapshot): HostError {
  return createHostError("STALE_REVISION", "Queue changed before the operation committed", {
    retryable: true,
    details: { expectedRevision, queue },
  });
}

async function abortAndWait(session: AgentSession): Promise<{
  settled: boolean;
  error?: unknown;
}> {
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const settled = await Promise.race([
      session.abort().then(() => true as const),
      new Promise<false>((resolve) => {
        settleTimer = setTimeout(() => resolve(false), ABORT_SETTLE_TIMEOUT_MS);
        settleTimer.unref?.();
      }),
    ]);
    return { settled };
  } catch (error) {
    return { settled: false, error };
  } finally {
    if (settleTimer) clearTimeout(settleTimer);
  }
}

export function createAgentHandlers(
  factory: WorkspaceGraphFactory,
): Partial<Record<string, MethodHandler>> {
  return {
    "agent.prompt": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
        requireSession: true,
      });
      if (stale) return { error: stale };

      const g = factory.getGraph();
      const server = factory.getServer();
      if (!g?.agentSession || !server) {
        return { error: createHostError("AGENT_NOT_READY", "No active agent session") };
      }

      if (g.resourceReloadRequired) {
        return {
          error: createHostError(
            "RESOURCE_RELOAD_FAILED",
            "Session resources require reload before prompting; run package.reloadResources",
            { retryable: true },
          ),
        };
      }

      if (server.serviceGraphLock.isHeld()) {
        const kind = server.serviceGraphLock.getOwner()?.operationKind;
        if (kind?.startsWith("package") || kind?.startsWith("resource.setPreference")) {
          return {
            error: createHostError("PACKAGE_MUTATION_BUSY", "Package mutation in progress", {
              retryable: true,
            }),
          };
        }
        return {
          error: createHostError("SERVICE_GRAPH_BUSY", "Service graph is busy", {
            retryable: true,
          }),
        };
      }

      const operationLock = factory.getSessionOperationLock(g.agentSession);
      if (!operationLock.tryAcquire(ctx.id)) {
        return {
          error: createHostError("AGENT_BUSY", "Agent operation already in progress", {
            retryable: true,
          }),
        };
      }

      if (server.serviceGraphLock.isHeld()) {
        const kind = server.serviceGraphLock.getOwner()?.operationKind;
        operationLock.release(ctx.id);
        return {
          error: createHostError(
            kind?.startsWith("package") || kind?.startsWith("resource.setPreference")
              ? "PACKAGE_MUTATION_BUSY"
              : "SERVICE_GRAPH_BUSY",
            kind?.startsWith("package") || kind?.startsWith("resource.setPreference")
              ? "Package mutation in progress"
              : "Service graph is busy",
            { retryable: true },
          ),
        };
      }

      // Re-check identity after both sides of the lock handoff.
      const stale2 = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
        requireSession: true,
      });
      if (stale2) {
        operationLock.release(ctx.id);
        return { error: stale2 };
      }

      // Pre-flight auth check: without credentials the SDK fails deep inside
      // the detached task below, and its CLI-era guidance ("/login") loops in
      // the GUI. checkAuth resolves stored/config/env credentials the same way
      // the request path does, so env-provided keys pass silently. A throw
      // means the check itself failed (e.g. a network probe) — fall through
      // and let the real request surface the truth instead of blocking on a
      // false negative.
      const currentModel = g.agentSession.model;
      if (currentModel) {
        let authConfigured: boolean | undefined;
        try {
          authConfigured =
            (await factory.deps.modelRuntime.checkAuth(currentModel.provider)) !== undefined;
        } catch {
          authConfigured = undefined;
        }
        if (authConfigured === false) {
          operationLock.release(ctx.id);
          return {
            error: createHostError(
              "AUTH_REQUIRED",
              `No credentials configured for provider "${currentModel.provider}". Sign in from Settings → Providers, then try again.`,
              { details: { providerId: currentModel.provider } },
            ),
          };
        }
      }

      const params = ctx.params as {
        text: string;
        images?: SerializableImage[];
        attachmentIds?: string[];
        streamingBehavior?: "steer" | "followUp";
        attachQueuedImages?: boolean;
      };
      let prompt: { text: string; attachmentIds: string[] };
      try {
        prompt = await buildPromptWithAttachments({
          factory,
          sessionId: server.identity.sessionId!,
          text: params.text,
          attachmentIds: params.attachmentIds,
        });
      } catch (error) {
        operationLock.release(ctx.id);
        return { error: attachmentHostError(error) };
      }
      const promptImages =
        toSdkImages(params.images) ??
        (params.attachQueuedImages ? takeQueuedImages(g.agentSession, params.text) : undefined);
      const runId = startDetachedPrompt({
        requestId: ctx.id,
        factory,
        server,
        session: g.agentSession,
        operationLock,
        text: prompt.text,
        images: promptImages,
        streamingBehavior: params.streamingBehavior,
      });
      commitPromptAttachments(factory, server.identity.sessionId!, prompt.attachmentIds);

      return { result: { accepted: true, runId } };
    },

    "agent.steer": async (ctx) => {
      const server = factory.getServer();
      if (!server) {
        return { error: createHostError("AGENT_NOT_READY", "No active session") };
      }
      const params = ctx.params as {
        text: string;
        images?: SerializableImage[];
        attachmentIds?: string[];
      };
      const out = await withStableGraphRead({
        requestId: ctx.id,
        identity: server.identity,
        serviceGraphLock: server.serviceGraphLock,
        precheck: () =>
          factory.checkIdentity(ctx.context, {
            requireWorkspace: true,
            requireSession: true,
          }),
        run: async () => {
          const session = factory.getGraph()?.agentSession;
          if (!session) throw new Error("No active session");
          const prompt = await buildPromptWithAttachments({
            factory,
            sessionId: server.identity.sessionId!,
            text: params.text,
            attachmentIds: params.attachmentIds,
          });
          factory.syncQueueState(session);
          const images = toSdkImages(params.images);
          await session.steer(prompt.text, images);
          if (images?.length) {
            // Key by the template-expanded mirror text — that is what
            // setQueue rebuilds send back.
            recordQueuedImages(
              session,
              session.getSteeringMessages().at(-1) ?? prompt.text,
              images,
            );
          }
          commitPromptAttachments(factory, server.identity.sessionId!, prompt.attachmentIds);
          factory.syncQueueState(session);
          return { accepted: true as const };
        },
      });
      return out.ok
        ? { result: out.result, identity: out.identity }
        : { error: out.error, identity: out.identity };
    },

    "agent.followUp": async (ctx) => {
      const server = factory.getServer();
      if (!server) {
        return { error: createHostError("AGENT_NOT_READY", "No active session") };
      }
      const params = ctx.params as {
        text: string;
        images?: SerializableImage[];
        attachmentIds?: string[];
      };
      const out = await withStableGraphRead({
        requestId: ctx.id,
        identity: server.identity,
        serviceGraphLock: server.serviceGraphLock,
        precheck: () =>
          factory.checkIdentity(ctx.context, {
            requireWorkspace: true,
            requireSession: true,
          }),
        run: async () => {
          const session = factory.getGraph()?.agentSession;
          if (!session) throw new Error("No active session");
          const prompt = await buildPromptWithAttachments({
            factory,
            sessionId: server.identity.sessionId!,
            text: params.text,
            attachmentIds: params.attachmentIds,
          });
          factory.syncQueueState(session);
          const images = toSdkImages(params.images);
          await session.followUp(prompt.text, images);
          if (images?.length) {
            recordQueuedImages(
              session,
              session.getFollowUpMessages().at(-1) ?? prompt.text,
              images,
            );
          }
          commitPromptAttachments(factory, server.identity.sessionId!, prompt.attachmentIds);
          factory.syncQueueState(session);
          return { accepted: true as const };
        },
      });
      return out.ok
        ? { result: out.result, identity: out.identity }
        : { error: out.error, identity: out.identity };
    },

    "agent.abort": async (ctx) => {
      const server = factory.getServer();
      if (!server) {
        return { error: createHostError("AGENT_NOT_READY", "No active session") };
      }
      const out = await withStableGraphRead({
        requestId: ctx.id,
        identity: server.identity,
        serviceGraphLock: server.serviceGraphLock,
        precheck: () =>
          factory.checkIdentity(ctx.context, {
            requireWorkspace: true,
            requireSession: true,
          }),
        run: async () => {
          const g = factory.getGraph();
          if (!g?.agentSession || !g.sessionManager) throw new Error("No active session");
          const session = g.agentSession;
          const originalQueue = factory.syncQueueState(session);
          let aborted = false;
          let settled = true;
          let queueRestored = true;
          let operationError: HostError | undefined;
          let queue = originalQueue;
          if (factory.isSessionBusy(session)) {
            pruneQueuedImages(session, [...originalQueue.steering, ...originalQueue.followUp]);
            const originalAttachments = snapshotQueuedImages(session);
            factory.beginQueueTransaction(session);
            session.clearQueue();
            const abort = await abortAndWait(session);
            aborted = true;
            settled = abort.settled;
            restoreQueuedImages(session, originalAttachments);
            try {
              await enqueueQueue(session, originalQueue);
            } catch (error) {
              queueRestored = false;
              operationError = createHostError(
                "QUEUE_TRANSACTION_FAILED",
                `The active run was interrupted, but its queue was only partially restored: ${error instanceof Error ? error.message : String(error)}`,
                { retryable: false },
              );
            }
            if (!settled && !operationError) {
              operationError = createHostError(
                abort.error ? "AGENT_ABORTED" : "AGENT_BUSY",
                abort.error
                  ? `Unable to abort the active run: ${abort.error instanceof Error ? abort.error.message : String(abort.error)}`
                  : "The active run did not settle before the abort deadline",
                { retryable: true },
              );
            }
            queue = factory.finishQueueTransaction(session);
          }
          const identity = server.getIdentity();
          const snap = buildSessionSnapshot({
            session,
            sessionManager: g.sessionManager,
            cwd: g.canonicalCwd,
            sessionId: identity.sessionId ?? "",
            revision: identity.sessionRevision,
            workspaceId: g.workspaceId,
            toolRevision: g.toolRevision,
          });
          g.sessionSnapshot = snap;
          return {
            aborted,
            settled,
            queueRestored,
            partialFailure: !queueRestored,
            queue,
            session: snap,
            ...(operationError ? { error: operationError } : {}),
          };
        },
      });
      return out.ok
        ? { result: out.result, identity: out.identity }
        : { error: out.error, identity: out.identity };
    },

    "agent.clearQueue": async (ctx) => {
      const server = factory.getServer();
      if (!server) {
        return { error: createHostError("AGENT_NOT_READY", "No active session") };
      }
      const params = ctx.params as { expectedRevision: number };
      const out = await withStableGraphRead({
        requestId: ctx.id,
        identity: server.identity,
        serviceGraphLock: server.serviceGraphLock,
        precheck: () =>
          factory.checkIdentity(ctx.context, {
            requireWorkspace: true,
            requireSession: true,
          }),
        run: async () => {
          const session = factory.getGraph()?.agentSession;
          if (!session) throw new Error("No active session");
          const current = factory.syncQueueState(session);
          if (current.revision !== params.expectedRevision) {
            factory.syncQueueState(session, true);
            return { error: queueConflictError(params.expectedRevision, current) };
          }
          factory.beginQueueTransaction(session);
          session.clearQueue();
          return { queue: factory.finishQueueTransaction(session) };
        },
      });
      if (!out.ok) return { error: out.error, identity: out.identity };
      return "error" in out.result
        ? { error: out.result.error!, identity: out.identity }
        : { result: out.result.queue, identity: out.identity };
    },

    "agent.setQueue": async (ctx) => {
      const server = factory.getServer();
      if (!server) {
        return { error: createHostError("AGENT_NOT_READY", "No active session") };
      }
      const params = ctx.params as {
        expectedRevision: number;
        steering: string[];
        followUp: string[];
      };
      const out = await withStableGraphRead({
        requestId: ctx.id,
        identity: server.identity,
        serviceGraphLock: server.serviceGraphLock,
        precheck: () =>
          factory.checkIdentity(ctx.context, {
            requireWorkspace: true,
            requireSession: true,
          }),
        run: async () => {
          const session = factory.getGraph()?.agentSession;
          if (!session) throw new Error("No active session");
          const current = factory.syncQueueState(session);
          if (current.revision !== params.expectedRevision) {
            factory.syncQueueState(session, true);
            return { error: queueConflictError(params.expectedRevision, current) };
          }
          const originalQueue: QueueTexts = {
            steering: [...current.steering],
            followUp: [...current.followUp],
          };
          const oldTexts = [...originalQueue.steering, ...originalQueue.followUp];
          pruneQueuedImages(session, oldTexts);
          const originalAttachments = snapshotQueuedImages(session);
          carryImagesAcrossEdit(session, oldTexts, [...params.steering, ...params.followUp]);
          factory.beginQueueTransaction(session);
          let mutationError: unknown;
          let rollbackError: unknown;
          try {
            await replaceQueue(session, params);
          } catch (err) {
            mutationError = err;
            restoreQueuedImages(session, originalAttachments);
            try {
              await replaceQueue(session, originalQueue);
            } catch (restoreError) {
              rollbackError = restoreError;
            }
          }
          const queue = factory.finishQueueTransaction(session);
          if (mutationError) {
            return {
              error: createHostError(
                "QUEUE_TRANSACTION_FAILED",
                rollbackError
                  ? "Queue update failed and the original queue could not be fully restored"
                  : "Queue update failed; the original queue was restored",
                {
                  retryable: false,
                  details: {
                    queueRestored: !rollbackError,
                    partialFailure: Boolean(rollbackError),
                    queue,
                    error:
                      mutationError instanceof Error
                        ? mutationError.message
                        : String(mutationError),
                    ...(rollbackError
                      ? {
                          rollbackError:
                            rollbackError instanceof Error
                              ? rollbackError.message
                              : String(rollbackError),
                        }
                      : {}),
                  },
                },
              ),
            };
          }
          return { queue };
        },
      });
      if (!out.ok) return { error: out.error, identity: out.identity };
      return "error" in out.result
        ? { error: out.result.error!, identity: out.identity }
        : { result: out.result.queue, identity: out.identity };
    },

    "agent.runNow": async (ctx) => {
      const server = factory.getServer();
      if (!server) {
        return { error: createHostError("AGENT_NOT_READY", "No active session") };
      }
      const params = ctx.params as {
        expectedRevision: number;
        followUpIndex?: number;
        steeringIndex?: number;
      };
      const runNowTarget =
        params.steeringIndex !== undefined
          ? ({ kind: "steering", index: params.steeringIndex } as const)
          : ({ kind: "followUp", index: params.followUpIndex! } as const);
      const out = await withStableGraphRead({
        requestId: ctx.id,
        identity: server.identity,
        serviceGraphLock: server.serviceGraphLock,
        precheck: () =>
          factory.checkIdentity(ctx.context, {
            requireWorkspace: true,
            requireSession: true,
          }),
        run: async () => {
          const session = factory.getGraph()?.agentSession;
          if (!session) throw new Error("No active session");
          const current = factory.syncQueueState(session);
          if (current.revision !== params.expectedRevision) {
            factory.syncQueueState(session, true);
            return { error: queueConflictError(params.expectedRevision, current) };
          }
          const item =
            runNowTarget.kind === "steering"
              ? current.steering[runNowTarget.index]
              : current.followUp[runNowTarget.index];
          if (!item) {
            return {
              error: createHostError(
                "INVALID_REQUEST",
                `Run Now item is no longer present in the ${runNowTarget.kind} queue`,
                { retryable: true, details: { queue: current } },
              ),
            };
          }

          const originalQueue: QueueTexts = {
            steering: [...current.steering],
            followUp: [...current.followUp],
          };
          pruneQueuedImages(session, [...originalQueue.steering, ...originalQueue.followUp]);
          const originalAttachments = snapshotQueuedImages(session);
          const remaining: QueueTexts =
            runNowTarget.kind === "steering"
              ? {
                  steering: originalQueue.steering.filter(
                    (_, index) => index !== runNowTarget.index,
                  ),
                  followUp: [...originalQueue.followUp],
                }
              : {
                  steering: [...originalQueue.steering],
                  followUp: originalQueue.followUp.filter(
                    (_, index) => index !== runNowTarget.index,
                  ),
                };

          factory.beginQueueTransaction(session);
          session.clearQueue();
          const promptImages = takeQueuedImages(session, item);

          const restoreOriginal = async (): Promise<unknown | undefined> => {
            restoreQueuedImages(session, originalAttachments);
            try {
              await replaceQueue(session, originalQueue);
              return undefined;
            } catch (error) {
              return error;
            }
          };

          if (!session.isIdle) {
            const abort = await abortAndWait(session);
            if (!abort.settled) {
              const restoreError = await restoreOriginal();
              const queue = factory.finishQueueTransaction(session);
              return {
                result: {
                  started: false,
                  settled: false,
                  queueRestored: !restoreError,
                  partialFailure: Boolean(restoreError),
                  queue,
                  error: createHostError(
                    abort.error ? "AGENT_ABORTED" : "AGENT_BUSY",
                    abort.error
                      ? `Unable to abort the active run: ${abort.error instanceof Error ? abort.error.message : String(abort.error)}`
                      : "The active run did not settle before the Run Now deadline",
                    { retryable: true },
                  ),
                },
              };
            }
          }

          const operationLock = factory.getSessionOperationLock(session);
          const acquired = await operationLock.acquire(ctx.id, 2_000);
          if (!acquired) {
            const restoreError = await restoreOriginal();
            const queue = factory.finishQueueTransaction(session);
            return {
              result: {
                started: false,
                settled: true,
                queueRestored: !restoreError,
                partialFailure: Boolean(restoreError),
                queue,
                error: createHostError(
                  "AGENT_BUSY",
                  "The previous agent operation did not release in time",
                  { retryable: true },
                ),
              },
            };
          }

          let runId: string;
          try {
            runId = startDetachedPrompt({
              requestId: ctx.id,
              factory,
              server,
              session,
              operationLock,
              text: item,
              images: promptImages,
            });
          } catch (error) {
            operationLock.release(ctx.id);
            const restoreError = await restoreOriginal();
            const queue = factory.finishQueueTransaction(session);
            return {
              result: {
                started: false,
                settled: true,
                queueRestored: !restoreError,
                partialFailure: Boolean(restoreError),
                queue,
                error: createHostError(
                  "QUEUE_TRANSACTION_FAILED",
                  error instanceof Error ? error.message : String(error),
                  { retryable: false },
                ),
              },
            };
          }

          let restoreError: unknown;
          try {
            await enqueueQueue(session, remaining);
          } catch (error) {
            restoreError = error;
          }
          const queue = factory.finishQueueTransaction(session);
          return {
            result: {
              started: true,
              runId,
              settled: true,
              queueRestored: !restoreError,
              partialFailure: Boolean(restoreError),
              queue,
              ...(restoreError
                ? {
                    error: createHostError(
                      "QUEUE_TRANSACTION_FAILED",
                      `The selected item started, but the remaining queue was only partially restored: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
                      { retryable: false },
                    ),
                  }
                : {}),
            },
          };
        },
      });
      if (!out.ok) return { error: out.error, identity: out.identity };
      return "error" in out.result
        ? { error: out.result.error!, identity: out.identity }
        : { result: out.result.result, identity: out.identity };
    },

    "agent.compact": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
        requireSession: true,
      });
      if (stale) return { error: stale };
      const g = factory.getGraph();
      const server = factory.getServer();
      if (!g?.agentSession || !g.sessionManager || !server) {
        return { error: createHostError("AGENT_NOT_READY", "No active session") };
      }
      if (server.serviceGraphLock.isHeld()) {
        return {
          error: createHostError("SERVICE_GRAPH_BUSY", "Service graph is busy", {
            retryable: true,
          }),
        };
      }
      if (!g.agentSession.isIdle) {
        return { error: createHostError("AGENT_BUSY", "Agent busy", { retryable: true }) };
      }
      const session = g.agentSession;
      const sessionManager = g.sessionManager;
      const requestIdentity = server.getIdentity();
      const originatingToolRevision = g.toolRevision;
      // Same per-session lock as agent.prompt — compaction and prompting are
      // mutually exclusive on one session.
      const operationLock = factory.getSessionOperationLock(session);
      if (!operationLock.tryAcquire(ctx.id)) {
        return { error: createHostError("AGENT_BUSY", "Agent busy", { retryable: true }) };
      }
      let backgroundAfterCompact: BackgroundSessionRuntime | undefined;
      try {
        if (server.serviceGraphLock.isHeld()) {
          return {
            error: createHostError("SERVICE_GRAPH_BUSY", "Service graph is busy", {
              retryable: true,
            }),
          };
        }
        const staleAfterLock = factory.checkIdentity(ctx.context, {
          requireWorkspace: true,
          requireSession: true,
        });
        if (staleAfterLock) return { error: staleAfterLock, identity: requestIdentity };

        const params = (ctx.params ?? {}) as { instructions?: string };
        // C1: compaction runs the session_before_compact extension window, so
        // a late registration must land on this graph's owner, same as a turn.
        const owner = g.providerOwner ?? null;
        const result = owner
          ? await factory.deps.providerOwnership.runAsOwner(owner, () =>
              session.compact(params.instructions),
            )
          : await session.compact(params.instructions);
        const stillCurrentGraph = factory.getGraph() === g;
        const active = stillCurrentGraph && g.agentSession === session;
        const background =
          stillCurrentGraph && !active
            ? [...g.backgroundSessions.values()].find((runtime) => runtime.agentSession === session)
            : undefined;
        const projectionIdentity = active ? server.getIdentity() : requestIdentity;
        backgroundAfterCompact = background;
        const snap = buildSessionSnapshot({
          session,
          sessionManager: background?.sessionManager ?? sessionManager,
          cwd: g.canonicalCwd,
          sessionId:
            background?.sessionId ?? projectionIdentity.sessionId ?? session.sessionId ?? "",
          revision: background?.sessionRevision ?? projectionIdentity.sessionRevision,
          workspaceId: g.workspaceId,
          toolRevision:
            background?.toolRevision ?? (active ? g.toolRevision : originatingToolRevision),
        });
        if (active) g.sessionSnapshot = snap;
        else if (background) background.sessionSnapshot = snap;
        return { result: { result, session: snap }, identity: requestIdentity };
      } finally {
        operationLock.release(ctx.id);
        if (backgroundAfterCompact) {
          factory.cacheSettledBackgroundRuntime(g, backgroundAfterCompact);
        }
      }
    },

    "agent.navigateTree": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
        requireSession: true,
      });
      if (stale) return { error: stale };
      const g = factory.getGraph();
      const server = factory.getServer();
      if (!g?.agentSession || !g.sessionManager || !server) {
        return { error: createHostError("AGENT_NOT_READY", "No active session") };
      }
      if (server.serviceGraphLock.isHeld()) {
        return {
          error: createHostError("SERVICE_GRAPH_BUSY", "Service graph is busy", {
            retryable: true,
          }),
        };
      }
      if (!g.agentSession.isIdle) {
        return { error: createHostError("AGENT_BUSY", "Agent busy", { retryable: true }) };
      }
      // Same per-session lock as agent.prompt — tree navigation rewires the
      // session leaf and must not race a run.
      const operationLock = factory.getSessionOperationLock(g.agentSession);
      if (!operationLock.tryAcquire(ctx.id)) {
        return { error: createHostError("AGENT_BUSY", "Agent busy", { retryable: true }) };
      }
      try {
        if (server.serviceGraphLock.isHeld()) {
          return {
            error: createHostError("SERVICE_GRAPH_BUSY", "Service graph is busy", {
              retryable: true,
            }),
          };
        }
        const staleAfterLock = factory.checkIdentity(ctx.context, {
          requireWorkspace: true,
          requireSession: true,
        });
        if (staleAfterLock) return { error: staleAfterLock };

        const params = ctx.params as { targetId: string };
        // summarize:false keeps navigation local — no LLM call, no abort path.
        const outcome = await g.agentSession.navigateTree(params.targetId, {
          summarize: false,
        });
        const identity = server.getIdentity();
        const snap = buildSessionSnapshot({
          session: g.agentSession,
          sessionManager: g.sessionManager,
          cwd: g.canonicalCwd,
          sessionId: identity.sessionId ?? "",
          revision: identity.sessionRevision,
          workspaceId: g.workspaceId,
          toolRevision: g.toolRevision,
        });
        g.sessionSnapshot = snap;
        return {
          result: {
            session: snap,
            cancelled: outcome.cancelled,
            ...(outcome.editorText !== undefined ? { editorText: outcome.editorText } : {}),
          },
        };
      } finally {
        operationLock.release(ctx.id);
      }
    },

    "agent.abortCompaction": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
        requireSession: true,
      });
      if (stale) return { error: stale };
      const g = factory.getGraph();
      const abort = (g?.agentSession as unknown as { abortCompaction?: () => void })
        ?.abortCompaction;
      abort?.call(g?.agentSession);
      return { result: { accepted: true } };
    },

    "agent.setAutoCompaction": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
        requireSession: true,
      });
      if (stale) return { error: stale };
      const g = factory.getGraph();
      const server = factory.getServer();
      if (!g?.agentSession || !server) {
        return { error: createHostError("AGENT_NOT_READY", "No active session") };
      }
      const params = ctx.params as { enabled: boolean };
      const fn = (
        g.agentSession as unknown as {
          setAutoCompactionEnabled?: (v: boolean) => void;
        }
      ).setAutoCompactionEnabled;
      fn?.call(g.agentSession, params.enabled);
      const snap = buildSessionSnapshot({
        session: g.agentSession,
        sessionManager: g.sessionManager!,
        cwd: g.canonicalCwd,
        sessionId: server.identity.sessionId ?? "",
        revision: server.identity.sessionRevision,
        workspaceId: g.workspaceId,
        toolRevision: g.toolRevision,
      });
      g.sessionSnapshot = snap;
      return { result: snap };
    },

    "agent.setAutoRetry": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
        requireSession: true,
      });
      if (stale) return { error: stale };
      const g = factory.getGraph();
      const server = factory.getServer();
      if (!g?.agentSession || !server) {
        return { error: createHostError("AGENT_NOT_READY", "No active session") };
      }
      const params = ctx.params as { enabled: boolean };
      g.agentSession.setAutoRetryEnabled(params.enabled);
      const snap = buildSessionSnapshot({
        session: g.agentSession,
        sessionManager: g.sessionManager!,
        cwd: g.canonicalCwd,
        sessionId: server.identity.sessionId ?? "",
        revision: server.identity.sessionRevision,
        workspaceId: g.workspaceId,
        toolRevision: g.toolRevision,
      });
      g.sessionSnapshot = snap;
      return { result: snap };
    },

    "agent.abortRetry": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
        requireSession: true,
      });
      if (stale) return { error: stale };
      factory.getGraph()?.agentSession?.abortRetry();
      return { result: { accepted: true } };
    },

    "agent.getTools": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
        requireSession: true,
      });
      if (stale) return { error: stale };
      const g = factory.getGraph();
      const server = factory.getServer();
      if (!g?.agentSession || !server) {
        return { error: createHostError("AGENT_NOT_READY", "No active session") };
      }
      const tools = buildToolSnapshot({
        session: g.agentSession,
        workspaceId: g.workspaceId,
        sessionId: server.identity.sessionId ?? "",
        sessionRevision: server.identity.sessionRevision,
        toolRevision: g.toolRevision,
      });
      return { result: tools };
    },

    "agent.setActiveTools": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
        requireSession: true,
        requireTool: true,
      });
      if (stale) return { error: stale };

      const g = factory.getGraph();
      const server = factory.getServer();
      if (!g?.agentSession || !server) {
        return { error: createHostError("AGENT_NOT_READY", "No active session") };
      }

      if (!g.agentSession.isIdle) {
        return { error: createHostError("AGENT_BUSY", "Agent is busy", { retryable: true }) };
      }

      if (
        !server.serviceGraphLock.tryAcquire({
          operationKind: "agent.setActiveTools",
          requestId: ctx.id,
        })
      ) {
        return {
          error: createHostError("SERVICE_GRAPH_BUSY", "Service graph busy", { retryable: true }),
        };
      }

      try {
        const stale2 = factory.checkIdentity(ctx.context, {
          requireWorkspace: true,
          requireSession: true,
          requireTool: true,
        });
        if (stale2) return { error: stale2 };
        if (factory.getSessionOperationLock(g.agentSession).isHeld() || !g.agentSession.isIdle) {
          return { error: createHostError("AGENT_BUSY", "Agent is busy", { retryable: true }) };
        }

        const params = ctx.params as { names: string[] };
        const names = factory.deps.attachmentStore
          ? [...new Set([...params.names, READ_ATTACHMENT_TOOL_NAME])]
          : params.names;
        g.agentSession.setActiveToolsByName(names);
        g.toolRevision += 1;
        const tools = buildToolSnapshot({
          session: g.agentSession,
          workspaceId: g.workspaceId,
          sessionId: server.identity.sessionId ?? "",
          sessionRevision: server.identity.sessionRevision,
          toolRevision: g.toolRevision,
        });
        if (g.sessionSnapshot) g.sessionSnapshot.tools = tools;
        server.emit("agent.toolsChanged", tools);
        return { result: tools };
      } finally {
        server.serviceGraphLock.release(ctx.id);
      }
    },

    "model.list": async (ctx) => {
      const server = factory.getServer();
      if (!server) {
        return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      }
      const { withStableGraphRead } = await import("./stable-graph-read.js");
      const out = await withStableGraphRead({
        requestId: ctx.id,
        identity: server.identity,
        serviceGraphLock: server.serviceGraphLock,
        precheck: () =>
          factory.checkIdentity(ctx.context, {
            requireWorkspace: true,
            requireSession: true,
          }),
        run: async () => {
          const g = factory.getGraph();
          if (!g?.agentSession) {
            throw new Error("No active session");
          }
          await Promise.resolve(factory.deps.refreshModelHealth());
          factory.onModelHealthChanged?.();

          const registry = factory.deps.modelRegistry;
          rebindCurrentSessionModel(g.agentSession, registry);
          const all = registry.getAvailable?.() ?? [];
          const current = g.agentSession.model;
          const enabledProviders = await getEnabledProviderIds(
            factory.deps.agentDir,
            current?.provider,
            factory.deps.modelRuntime.getProviders().map((provider) => provider.id),
          );
          const enabledProviderSet = enabledProviders ? new Set(enabledProviders) : undefined;
          const providerNames = new Map(
            factory.deps.modelRuntime
              .getProviders()
              .map((provider) => [provider.id, provider.name] as const),
          );
          const modelAllowLists = await getProviderModelAllowLists(factory.deps.agentDir);
          const models: ModelSummary[] = all
            .filter(
              (model: Model<any>) => !enabledProviderSet || enabledProviderSet.has(model.provider),
            )
            .filter((model: Model<any>) => {
              const allow = modelAllowLists?.[model.provider];
              if (!allow) return true;
              // The session's current model stays listed even when unchecked.
              if (current && model.provider === current.provider && model.id === current.id) {
                return true;
              }
              return allow.includes(model.id);
            })
            .map((model: Model<any>) => summarizeModel(model, providerNames.get(model.provider)));
          return {
            models,
            ...(enabledProviders ? { enabledProviders } : {}),
            current: current
              ? summarizeModel(current, providerNames.get(current.provider))
              : undefined,
            thinkingLevels: g.agentSession.getAvailableThinkingLevels().map(String),
            configHealth: factory.deps.getModelConfigHealth(),
          };
        },
      });
      if (!out.ok) return { error: out.error, identity: out.identity };
      return { result: out.result, identity: out.identity };
    },

    "model.setCurrent": async (ctx) => {
      const server = factory.getServer();
      if (!server) {
        return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      }
      return withRegisteredGraphMutation({
        server,
        operationKind: "model.setCurrent",
        requestId: ctx.id,
        run: async ({ signal }) => {
          const stale = factory.checkIdentity(ctx.context, {
            requireWorkspace: true,
            requireSession: true,
          });
          if (stale) return { error: stale };
          const g = factory.getGraph();
          if (!g?.agentSession || !g.sessionManager) {
            return { error: createHostError("AGENT_NOT_READY", "No active session") };
          }
          if (factory.getSessionOperationLock(g.agentSession).isHeld() || !g.agentSession.isIdle) {
            return { error: createHostError("AGENT_BUSY", "Agent is busy", { retryable: true }) };
          }

          const params = ctx.params as { provider: string; modelId: string };
          const registry = factory.deps.modelRegistry;
          const enabledProviders = await getEnabledProviderIds(
            factory.deps.agentDir,
            g.agentSession.model?.provider,
            factory.deps.modelRuntime.getProviders().map((provider) => provider.id),
          );
          if (enabledProviders && !enabledProviders.includes(params.provider)) {
            return {
              error: createHostError(
                "INVALID_REQUEST",
                `Provider ${params.provider} is disabled; enable it before selecting one of its models`,
              ),
            };
          }
          const isCurrentModel =
            g.agentSession.model?.provider === params.provider &&
            g.agentSession.model?.id === params.modelId;
          const modelAllow = (await getProviderModelAllowLists(factory.deps.agentDir))?.[
            params.provider
          ];
          if (!isCurrentModel && modelAllow && !modelAllow.includes(params.modelId)) {
            return {
              error: createHostError(
                "INVALID_REQUEST",
                `Model ${params.modelId} is hidden for Provider ${params.provider}; enable it in Provider settings first`,
              ),
            };
          }
          const all = registry.getAvailable?.() ?? [];
          const model = all.find(
            (m: { provider: string; id: string }) =>
              m.provider === params.provider && m.id === params.modelId,
          );
          if (!model) {
            return {
              error: createHostError(
                "MODEL_NOT_FOUND",
                `Model not found: ${params.provider}/${params.modelId}`,
              ),
            };
          }

          signal.throwIfAborted();
          await g.agentSession.setModel(model);
          const identity = server.getIdentity();
          const snap = buildSessionSnapshot({
            session: g.agentSession,
            sessionManager: g.sessionManager,
            cwd: g.canonicalCwd,
            sessionId: identity.sessionId ?? "",
            revision: identity.sessionRevision,
            workspaceId: g.workspaceId,
            toolRevision: g.toolRevision,
          });
          g.sessionSnapshot = snap;
          const thinkingLevels = g.agentSession.getAvailableThinkingLevels().map(String);
          server.emit("model.changed", {
            model: snap.model,
            thinkingLevel: snap.thinkingLevel,
            availableThinkingLevels: thinkingLevels,
          });
          return {
            result: {
              model: snap.model!,
              thinkingLevels,
              session: snap,
            },
            identity,
          };
        },
      });
    },

    "model.setThinkingLevel": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
        requireSession: true,
      });
      if (stale) return { error: stale };
      const g = factory.getGraph();
      const server = factory.getServer();
      if (!g?.agentSession || !server) {
        return { error: createHostError("AGENT_NOT_READY", "No active session") };
      }
      const params = ctx.params as { level: string };
      g.agentSession.setThinkingLevel(params.level as never);
      const snap = buildSessionSnapshot({
        session: g.agentSession,
        sessionManager: g.sessionManager!,
        cwd: g.canonicalCwd,
        sessionId: server.identity.sessionId ?? "",
        revision: server.identity.sessionRevision,
        workspaceId: g.workspaceId,
        toolRevision: g.toolRevision,
      });
      g.sessionSnapshot = snap;
      server.emit("model.changed", {
        model: snap.model,
        thinkingLevel: snap.thinkingLevel,
        availableThinkingLevels: g.agentSession.getAvailableThinkingLevels().map(String),
      });
      return { result: snap };
    },
  };
}
