import {
  createFailureResponse,
  createHostError,
  createSuccessResponse,
  parseHostRequest,
  validateEventPayload,
  validateSuccessResult,
  type BoundWorkspaceRef,
  type HostError,
  type HostEventName,
  type HostIdentity,
  type HostMethod,
  type HostPhase,
  type RehydrateSnapshot,
  type HostStatusSnapshot,
  type ModelConfigHealth,
  type HostCapabilities,
  type ExtensionDecisionPresentation,
} from "@piabyss/protocol";
import { IdentityState } from "./identity.js";
import { acquireWithAbort, AgentOperationLock, TryMutex } from "./locks.js";
import { logger } from "./logger.js";
import { GraphOperationRegistry } from "./operation-lifecycle.js";
import { OutboundWriter } from "./outbound-queue.js";
import { createLineReader } from "./transport.js";

export const HOST_SHUTDOWN_QUIESCE_TIMEOUT_MS = 8_000;

/**
 * How long `system.rehydrate` queues behind an in-flight graph mutation before
 * failing with SERVICE_GRAPH_BUSY. Recovery usually lands while a workspace
 * switch holds the exclusive graph lock; failing fast here made the UI paint
 * the terminal "Host unavailable" panel for a transient collision that its
 * retry loop was about to self-heal anyway.
 */
const REHYDRATE_LOCK_WAIT_MS = 2_000;

async function completesWithin(operation: Promise<void>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  const completed = operation.then(
    () => ({ kind: "completed" as const }),
    (error: unknown) => ({ kind: "failed" as const, error }),
  );
  const result = await Promise.race([completed, expired]);
  if (timer) clearTimeout(timer);
  if (result === false) return false;
  if (result.kind === "failed") throw result.error;
  return true;
}

export type HostRuntimeDeps = {
  agentDir: string;
  sdkVersion: string;
  getModelConfigHealth: () => ModelConfigHealth;
  capabilities: HostCapabilities;
  /** Method handlers registered by controllers */
  handlers: Partial<Record<HostMethod, MethodHandler>>;
  getRehydrateState?: () => Pick<RehydrateSnapshot, "workspace" | "session" | "tools" | "packages">;
  /** Optional graceful cleanup before process exit */
  onShutdown?: () => Promise<void>;
};

export type MethodHandler = (
  ctx: HandlerContext,
) => Promise<
  { result: unknown; identity?: HostIdentity } | { error: HostError; identity?: HostIdentity }
>;

export type HandlerContext = {
  id: string;
  method: HostMethod;
  params: unknown;
  context: Record<string, unknown>;
  identity: IdentityState;
  serviceGraphLock: TryMutex;
  agentOperationLock: AgentOperationLock;
  getStatus: () => HostStatusSnapshot;
  setPhase: (phase: HostPhase) => void;
  emit: (event: HostEventName, payload: unknown) => void;
  writeResponse: (body: unknown) => void;
};

export class PiHostServer {
  readonly identity = new IdentityState();
  readonly serviceGraphLock = new TryMutex();
  readonly agentOperationLock = new AgentOperationLock();
  readonly graphOperations = new GraphOperationRegistry();
  private readonly shutdownController = new AbortController();
  private sequence = 0;
  private phase: HostPhase = "booting";
  private extensionDecisionPresentation: ExtensionDecisionPresentation = "auto";
  private shuttingDown = false;
  private lastError?: HostError;
  private fatalError?: HostError;
  /** Decides whether a non-current workspace identity is still bound (parked). */
  private boundWorkspaceChecker?: (workspaceId: string, revision: number) => boolean;
  /** Projects the currently bound (active + parked) workspace graphs into status. */
  private boundWorkspacesProvider?: () => BoundWorkspaceRef[] | undefined;
  private readonly deps: HostRuntimeDeps;
  private stopReader: (() => void) | null = null;
  private cleanupPromise: Promise<boolean> | null = null;
  private shutdownRequestPromise: Promise<void> | null = null;
  private transportShutdownPromise: Promise<void> | null = null;
  /** Bounded outbound queue (A3) — allocates event sequences at write time. */
  private readonly outbound = new OutboundWriter({
    stream: process.stdout,
    allocateSequence: () => {
      this.sequence += 1;
      return this.sequence;
    },
    getCurrentIdentity: () => this.identity.snapshot(),
  });

  constructor(deps: HostRuntimeDeps) {
    this.deps = deps;
  }

  getIdentity(): HostIdentity {
    return this.identity.snapshot();
  }

  /** Injected by the graph factory: is (workspaceId, revision) still bound? */
  setBoundWorkspaceChecker(fn: (workspaceId: string, revision: number) => boolean): void {
    this.boundWorkspaceChecker = fn;
  }

  /** Injected by the graph factory: lists the bound workspace graphs for status. */
  setBoundWorkspacesProvider(fn: () => BoundWorkspaceRef[] | undefined): void {
    this.boundWorkspacesProvider = fn;
  }

  getExtensionDecisionPresentation(): ExtensionDecisionPresentation {
    return this.extensionDecisionPresentation;
  }

  setExtensionDecisionPresentation(mode: ExtensionDecisionPresentation): void {
    this.extensionDecisionPresentation = mode;
  }

  setPhase(phase: HostPhase): void {
    this.phase = phase;
  }

  getPhase(): HostPhase {
    return this.phase;
  }

  getShutdownSignal(): AbortSignal {
    return this.shutdownController.signal;
  }

  setLastError(error: HostError | undefined): void {
    this.lastError = error;
  }

  setFatalError(error: HostError): void {
    this.fatalError = error;
    this.phase = "fatal";
  }

  buildStatus(): HostStatusSnapshot {
    const boundWorkspaces = this.boundWorkspacesProvider?.();
    return {
      ...this.identity.snapshot(),
      protocolVersion: 1,
      sdkVersion: this.deps.sdkVersion,
      nodeVersion: process.version,
      agentDir: this.deps.agentDir,
      phase: this.phase,
      capabilities: this.deps.capabilities,
      modelConfigHealth: this.deps.getModelConfigHealth(),
      extensionDecisionPresentation: this.extensionDecisionPresentation,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.fatalError ? { fatalError: this.fatalError } : {}),
      ...(boundWorkspaces ? { boundWorkspaces } : {}),
    };
  }

  emit(event: HostEventName, payload: unknown): void {
    this.emitForIdentity(this.identity.snapshot(), event, payload);
  }

  emitForIdentity(identity: HostIdentity, event: HostEventName, payload: unknown): void {
    const current = this.identity.snapshot();
    if (
      identity.hostInstanceId !== current.hostInstanceId ||
      identity.workspaceId !== current.workspaceId ||
      identity.workspaceRevision !== current.workspaceRevision
    ) {
      throw new Error("Cannot emit an event for a stale Host or Workspace identity");
    }
    const validation = validateEventPayload(event, payload);
    if (!validation.ok) {
      const error = createHostError("INTERNAL_ERROR", `Invalid outbound ${event} payload`, {
        details: { event, validation: validation.error.message },
      });
      this.setFatalError(error);
      logger.error("Rejected invalid outbound Host event", {
        event,
        validation: validation.error.message,
      });
      throw new Error(error.message);
    }

    this.outbound.enqueueEvent(identity, event, payload);
  }

  /**
   * Relaxed emit path for events that originate from a parked (background)
   * workspace graph. The identity must still belong to this Host instance;
   * its workspace must either be the current one — exactly the
   * `emitForIdentity` contract — or a graph currently bound (parked) to the
   * Host, as decided by the injected bound-workspace checker. Everything else
   * (payload validation, enqueue) matches `emitForIdentity`.
   */
  emitForBoundIdentity(identity: HostIdentity, event: HostEventName, payload: unknown): void {
    const current = this.identity.snapshot();
    if (identity.hostInstanceId !== current.hostInstanceId) {
      throw new Error("Cannot emit an event for a stale Host or Workspace identity");
    }
    const workspaceMatches =
      identity.workspaceId === current.workspaceId &&
      identity.workspaceRevision === current.workspaceRevision;
    if (!workspaceMatches) {
      const bound =
        identity.workspaceId !== null &&
        this.boundWorkspaceChecker?.(identity.workspaceId, identity.workspaceRevision) === true;
      if (!bound) {
        throw new Error("Cannot emit an event for a stale Host or Workspace identity");
      }
    }

    const validation = validateEventPayload(event, payload);
    if (!validation.ok) {
      const error = createHostError("INTERNAL_ERROR", `Invalid outbound ${event} payload`, {
        details: { event, validation: validation.error.message },
      });
      this.setFatalError(error);
      logger.error("Rejected invalid outbound Host event", {
        event,
        validation: validation.error.message,
      });
      throw new Error(error.message);
    }

    this.outbound.enqueueEvent(identity, event, payload);
  }

  writeResponse(body: unknown): void {
    this.outbound.enqueueResponse(body);
  }

  async start(): Promise<void> {
    this.phase = "waitingForWorkspace";
    this.emit("host.ready", this.buildStatus());
    logger.info("Pi Host ready", {
      hostInstanceId: this.identity.hostInstanceId,
      sdkVersion: this.deps.sdkVersion,
      agentDir: this.deps.agentDir,
    });

    this.stopReader = createLineReader(process.stdin, (line) => {
      void this.handleLine(line);
    });

    // Exit when the peer closes stdin — otherwise a crashed/killed UI leaves
    // an orphaned host holding the SDK and its child processes (no parent-death
    // signal exists on Windows).
    const onStdinClosed = () => {
      void this.requestShutdown("stdin closed by peer");
    };
    process.stdin.once("end", onStdinClosed);
    process.stdin.once("close", onStdinClosed);
  }

  /** Graceful shutdown for transport loss / signals — mirrors system.shutdown cleanup. */
  async requestShutdown(reason: string, exitCode = 0): Promise<void> {
    if (this.shutdownRequestPromise) return this.shutdownRequestPromise;
    const requestId = `shutdown:${reason}`;
    this.shutdownRequestPromise = (async () => {
      let cleanupCompleted = false;
      try {
        cleanupCompleted = await this.quiesceAndCleanup(reason, requestId);
        if (!cleanupCompleted) {
          logger.error("Shutdown cleanup deadline expired", {
            reason,
            operationKind: this.serviceGraphLock.getOwner()?.operationKind ?? null,
          });
        }
      } catch (err) {
        logger.error("Cleanup during shutdown failed", {
          reason,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      await this.stopTransport(cleanupCompleted ? exitCode : 1);
    })();
    return this.shutdownRequestPromise;
  }

  requestFatalShutdown(error: HostError, reason: string): Promise<void> {
    if (!this.shutdownRequestPromise) {
      this.setFatalError(error);
      try {
        this.emit("host.fatal", { error });
      } catch (emitError) {
        logger.error("Failed to publish fatal Host state", {
          error: emitError instanceof Error ? emitError.message : String(emitError),
        });
      }
    }
    return this.requestShutdown(reason, 1);
  }

  private quiesceAndCleanup(reason: string, requestId: string): Promise<boolean> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.shuttingDown = true;
    this.phase = "shuttingDown";
    this.shutdownController.abort(new Error(`Host shutdown: ${reason}`));
    logger.warn("Quiescing Pi Host", { reason });
    this.cleanupPromise = (async () => {
      const deadline = Date.now() + HOST_SHUTDOWN_QUIESCE_TIMEOUT_MS;
      const active = this.graphOperations.cancelActive(`Host shutdown: ${reason}`);
      if (active) {
        logger.warn("Cancelling active graph operation for shutdown", {
          operationKind: active.operationKind,
          operationId: active.operationId,
        });
        const operationCompleted = await completesWithin(active.completion, deadline - Date.now());
        if (!operationCompleted) return false;
      }

      const ownsGraphLock = await this.serviceGraphLock.acquire(
        { operationKind: "system.shutdown", requestId },
        Math.max(0, deadline - Date.now()),
      );
      if (!ownsGraphLock) return false;
      let releaseGraphLock = true;
      try {
        if (!this.deps.onShutdown) return true;
        const cleanupCompleted = await completesWithin(
          this.deps.onShutdown(),
          deadline - Date.now(),
        );
        if (!cleanupCompleted) releaseGraphLock = false;
        return cleanupCompleted;
      } finally {
        if (releaseGraphLock) this.serviceGraphLock.release(requestId);
      }
    })();
    return this.cleanupPromise;
  }

  async handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;

    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      logger.warn("Invalid JSON on stdin", { preview: trimmed.slice(0, 200) });
      this.writeResponse(
        createFailureResponse(
          this.identity.snapshot(),
          "unknown",
          "unknown",
          createHostError("INVALID_REQUEST", "Invalid JSON on stdin"),
        ),
      );
      return;
    }

    let parsed: ReturnType<typeof parseHostRequest>;
    try {
      parsed = parseHostRequest(raw);
    } catch (err) {
      // Validator internal failure must degrade to a protocol error, never an
      // unhandled rejection that kills the host.
      logger.error("parseHostRequest threw", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.writeResponse(
        createFailureResponse(
          this.identity.snapshot(),
          "unknown",
          "unknown",
          createHostError("INTERNAL_ERROR", "Request validation failed internally"),
        ),
      );
      return;
    }
    if (!parsed.ok) {
      const id =
        typeof raw === "object" &&
        raw !== null &&
        "id" in raw &&
        typeof (raw as { id: unknown }).id === "string"
          ? (raw as { id: string }).id
          : "unknown";
      const method =
        typeof raw === "object" &&
        raw !== null &&
        "method" in raw &&
        typeof (raw as { method: unknown }).method === "string"
          ? (raw as { method: string }).method
          : "unknown";
      this.writeResponse(createFailureResponse(this.identity.snapshot(), id, method, parsed.error));
      return;
    }

    const { id, method, context, params } = parsed.value;

    if (this.shuttingDown && method !== "system.shutdown") {
      this.writeResponse(
        createFailureResponse(
          this.identity.snapshot(),
          id,
          method,
          createHostError("HOST_SHUTTING_DOWN", "Host is shutting down"),
        ),
      );
      return;
    }

    // Built-in system handlers
    if (method === "system.hello") {
      const requestedMode = (
        params as {
          extensionDecisionPresentation?: ExtensionDecisionPresentation;
        }
      ).extensionDecisionPresentation;
      if (requestedMode) this.setExtensionDecisionPresentation(requestedMode);
      this.writeResponse(
        createSuccessResponse(this.identity.snapshot(), id, method, this.buildStatus()),
      );
      return;
    }

    if (method === "system.getStatus") {
      const expected = context.expectedHostInstanceId;
      if (expected !== this.identity.hostInstanceId) {
        this.writeResponse(
          createFailureResponse(
            this.identity.snapshot(),
            id,
            method,
            createHostError("STALE_REVISION", "expectedHostInstanceId does not match"),
          ),
        );
        return;
      }
      this.writeResponse(
        createSuccessResponse(this.identity.snapshot(), id, method, this.buildStatus()),
      );
      return;
    }

    if (method === "system.rehydrate") {
      const expected = context.expectedHostInstanceId;
      if (expected !== this.identity.hostInstanceId) {
        this.writeResponse(
          createFailureResponse(
            this.identity.snapshot(),
            id,
            method,
            createHostError("STALE_REVISION", "expectedHostInstanceId does not match"),
          ),
        );
        return;
      }

      // Uncontended fast path stays synchronous: the rehydrate response must
      // be enqueued between the preceding and following events (atomic
      // snapshot-at-watermark semantics pinned by tests). Only a real
      // contention (a workspace switch holding the lock) takes the awaited
      // bounded wait — ordering there is handled by the response watermark.
      if (
        !this.serviceGraphLock.tryAcquire({
          operationKind: "system.rehydrate",
          requestId: id,
        })
      ) {
        const lockState = await acquireWithAbort(
          this.serviceGraphLock,
          { operationKind: "system.rehydrate", requestId: id },
          REHYDRATE_LOCK_WAIT_MS,
          this.shutdownController.signal,
        );
        if (lockState !== true) {
          this.writeResponse(
            createFailureResponse(
              this.identity.snapshot(),
              id,
              method,
              lockState === "aborted"
                ? createHostError("HOST_SHUTTING_DOWN", "Host is shutting down")
                : createHostError("SERVICE_GRAPH_BUSY", "Service graph is busy", {
                    retryable: true,
                    details: {
                      operationKind: this.serviceGraphLock.getOwner()?.operationKind ?? null,
                      waitedMs: REHYDRATE_LOCK_WAIT_MS,
                    },
                  }),
            ),
          );
          return;
        }
      }

      try {
        const identity = this.identity.snapshot();
        const host = this.buildStatus();
        const state = this.deps.getRehydrateState?.() ?? {
          workspace: null,
          session: null,
          tools: null,
          packages: null,
        };
        this.outbound.enqueueBarrierResponse((watermark) => {
          const result: RehydrateSnapshot = { watermark, host, ...state };
          const validation = validateSuccessResult(method, result);
          if (!validation.ok) {
            logger.error("Rejected invalid atomic rehydrate snapshot", {
              validation: validation.error.message,
            });
            return createFailureResponse(
              identity,
              id,
              method,
              createHostError("INTERNAL_ERROR", "Host recovery snapshot is inconsistent", {
                details: { validation: validation.error.message },
              }),
            );
          }
          return createSuccessResponse(identity, id, method, result);
        });
      } finally {
        this.serviceGraphLock.release(id);
      }
      return;
    }

    if (method === "system.shutdown") {
      const expected = context.expectedHostInstanceId;
      if (expected !== this.identity.hostInstanceId) {
        this.writeResponse(
          createFailureResponse(
            this.identity.snapshot(),
            id,
            method,
            createHostError("STALE_REVISION", "expectedHostInstanceId does not match"),
          ),
        );
        return;
      }
      let cleanupCompleted = false;
      try {
        cleanupCompleted = await this.quiesceAndCleanup("system.shutdown", id);
        if (cleanupCompleted) {
          this.writeResponse(
            createSuccessResponse(this.identity.snapshot(), id, method, { accepted: true }),
          );
        } else {
          this.writeResponse(
            createFailureResponse(
              this.identity.snapshot(),
              id,
              method,
              createHostError(
                "HOST_RESTART_REQUIRED",
                "Host cleanup did not complete before the shutdown deadline",
                { details: { timeoutMs: HOST_SHUTDOWN_QUIESCE_TIMEOUT_MS } },
              ),
            ),
          );
        }
      } catch (err) {
        this.writeResponse(
          createFailureResponse(
            this.identity.snapshot(),
            id,
            method,
            createHostError(
              "INTERNAL_ERROR",
              err instanceof Error ? err.message : "shutdown cleanup failed",
            ),
          ),
        );
      }
      await this.stopTransport(cleanupCompleted ? 0 : 1);
      return;
    }

    // Identity pre-check for host instance
    if (
      typeof context.expectedHostInstanceId === "string" &&
      context.expectedHostInstanceId !== this.identity.hostInstanceId
    ) {
      this.writeResponse(
        createFailureResponse(
          this.identity.snapshot(),
          id,
          method,
          createHostError("STALE_REVISION", "expectedHostInstanceId does not match"),
        ),
      );
      return;
    }

    const handler = this.deps.handlers[method];
    if (!handler) {
      this.writeResponse(
        createFailureResponse(
          this.identity.snapshot(),
          id,
          method,
          createHostError("UNSUPPORTED_METHOD", `Method not implemented: ${method}`, {
            details: { method },
          }),
        ),
      );
      return;
    }

    const handlerCtx: HandlerContext = {
      id,
      method,
      params,
      context,
      identity: this.identity,
      serviceGraphLock: this.serviceGraphLock,
      agentOperationLock: this.agentOperationLock,
      getStatus: () => this.buildStatus(),
      setPhase: (p) => this.setPhase(p),
      emit: (e, p) => this.emit(e, p),
      writeResponse: (b) => this.writeResponse(b),
    };

    try {
      const outcome = await handler(handlerCtx);
      // Prefer identity captured by stable graph helpers — never re-label old results
      const idForResponse = outcome.identity ?? this.identity.snapshot();
      if (outcome.identity) {
        const cur = this.identity.snapshot();
        if (
          outcome.identity.workspaceRevision !== cur.workspaceRevision ||
          outcome.identity.sessionRevision !== cur.sessionRevision ||
          outcome.identity.packageRevision !== cur.packageRevision ||
          outcome.identity.workspaceId !== cur.workspaceId ||
          outcome.identity.sessionId !== cur.sessionId
        ) {
          // Generation moved after handler finished without capturing correctly
          if ("error" in outcome) {
            this.writeResponse(createFailureResponse(cur, id, method, outcome.error));
          } else {
            this.writeResponse(
              createFailureResponse(
                cur,
                id,
                method,
                createHostError("STALE_REVISION", "Graph replaced before response write"),
              ),
            );
          }
          return;
        }
      }
      if ("error" in outcome) {
        this.writeResponse(createFailureResponse(idForResponse, id, method, outcome.error));
      } else {
        const validation = validateSuccessResult(method, outcome.result);
        if (!validation.ok) {
          logger.error("Rejected invalid outbound Host result", {
            method,
            validation: validation.error.message,
          });
          this.writeResponse(
            createFailureResponse(
              idForResponse,
              id,
              method,
              createHostError("INTERNAL_ERROR", `Handler returned invalid ${method} result`, {
                details: { method, validation: validation.error.message },
              }),
            ),
          );
          return;
        }
        this.writeResponse(
          createSuccessResponse(idForResponse, id, method, outcome.result as never),
        );
      }
    } catch (err) {
      logger.error("Handler threw", {
        method,
        error: err instanceof Error ? err.message : String(err),
      });
      this.writeResponse(
        createFailureResponse(
          this.identity.snapshot(),
          id,
          method,
          createHostError("INTERNAL_ERROR", err instanceof Error ? err.message : "Internal error"),
        ),
      );
    }
  }

  async shutdown(exitCode = 0): Promise<void> {
    logger.info("Pi Host shutting down");
    this.phase = "shuttingDown";
    this.shuttingDown = true;
    // onShutdown may already have run from system.shutdown handler
    this.stopReader?.();
    // Drain the outbound queue and stdout before exit, with a hard deadline
    // so a blocked pipe cannot prevent process exit.
    await Promise.race([
      this.outbound.drain(),
      new Promise<void>((resolve) => setTimeout(resolve, 500)),
    ]);
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      if (process.stdout.write("")) {
        // schedule microtask so response flush can complete
        setImmediate(done);
      } else {
        process.stdout.once("drain", done);
        setTimeout(done, 500);
      }
    });
    process.exitCode = exitCode;
    process.exit(exitCode);
  }

  private stopTransport(exitCode: number): Promise<void> {
    if (!this.transportShutdownPromise) {
      this.transportShutdownPromise = this.shutdown(exitCode);
    }
    return this.transportShutdownPromise;
  }
}
