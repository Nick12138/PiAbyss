import { randomUUID } from "node:crypto";
import { createHostError, type HostError } from "@piabyss/protocol";
import type { GraphOperationRegistry } from "./operation-lifecycle.js";
import type { GraphOperationKind, TryMutex } from "./locks.js";

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
    ownsGraphLock = server.serviceGraphLock.tryAcquire({
      operationKind,
      requestId,
      operationId,
    });
    if (!ownsGraphLock) {
      return {
        error: createHostError("SERVICE_GRAPH_BUSY", "Service graph is busy", {
          retryable: true,
          details: {
            operationKind: server.serviceGraphLock.getOwner()?.operationKind ?? null,
          },
        }),
      };
    }

    operation.signal.throwIfAborted();
    return await args.run({ operationId, signal: operation.signal });
  } finally {
    if (ownsGraphLock) server.serviceGraphLock.release(requestId);
    operation.finish();
  }
}
