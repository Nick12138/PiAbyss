import { randomUUID } from "node:crypto";
import { createHostError, type HostError } from "@piabyss/protocol";
import type { GraphOperationRegistry } from "./operation-lifecycle.js";
import type { GraphOperationKind, TryMutex } from "./locks.js";
import { acquireWithAbort } from "./locks.js";

/** Mutations queue briefly behind in-flight graph work instead of failing
 *  fast. A fail-fast tryAcquire starves whenever reads (session opens,
 *  model.list, rehydrates) hold the lock back-to-back — e.g. the startup
 *  burst of a shared host with several bound workspaces — turning every
 *  Provider save/test into SERVICE_GRAPH_BUSY. Holders always release in a
 *  `finally`, so a bounded abortable wait is safe: it only adds latency to
 *  genuinely busy moments, and cancellation (shutdown/supersede) breaks the
 *  wait via the operation signal.
 */
const MUTATION_LOCK_WAIT_MS = 2_000;

export type RegisteredGraphMutationContext = {
  operationId: string;
  signal: AbortSignal;
};

type RegisteredGraphMutationHost = {
  graphOperations: GraphOperationRegistry;
  serviceGraphLock: TryMutex;
};

export async function withRegisteredGraphMutation<T>(args: {
  server: RegisteredGraphMutationHost;
  operationKind: GraphOperationKind;
  requestId: string;
  /** Bounded wait for the graph mutex; 0 restores fail-fast semantics. */
  lockWaitMs?: number;
  run: (context: RegisteredGraphMutationContext) => Promise<T> | T;
}): Promise<T | { error: HostError }> {
  const { server, operationKind, requestId } = args;
  const operationId = randomUUID();
  const operation = server.graphOperations.begin({
    operationKind,
    requestId,
    operationId,
  });
  if (!operation) {
    return {
      error: createHostError("SERVICE_GRAPH_BUSY", "Service graph is busy", {
        retryable: true,
        details: {
          operationKind: server.graphOperations.getActive()?.operationKind ?? null,
        },
      }),
    };
  }

  let ownsGraphLock = false;
  try {
    const lockState = await acquireWithAbort(
      server.serviceGraphLock,
      { operationKind, requestId, operationId },
      args.lockWaitMs ?? MUTATION_LOCK_WAIT_MS,
      operation.signal,
    );
    if (lockState !== true) {
      const owner = server.serviceGraphLock.getOwner();
      return {
        error: createHostError("SERVICE_GRAPH_BUSY", "Service graph is busy", {
          retryable: true,
          details: {
            operationKind: owner?.operationKind ?? null,
            ...(lockState === "aborted"
              ? { cancelled: true }
              : { waitedMs: args.lockWaitMs ?? MUTATION_LOCK_WAIT_MS }),
          },
        }),
      };
    }
    ownsGraphLock = true;

    operation.signal.throwIfAborted();
    return await args.run({ operationId, signal: operation.signal });
  } finally {
    if (ownsGraphLock) server.serviceGraphLock.release(requestId);
    operation.finish();
  }
}
