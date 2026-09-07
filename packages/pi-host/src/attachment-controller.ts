import { createHostError, type HostError, type AttachmentSnapshot } from "@piabyss/protocol";
import type { MethodHandler } from "./server.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import { AttachmentStoreError } from "./attachment-store.js";

export function attachmentHostError(error: unknown): HostError {
  if (error instanceof AttachmentStoreError) {
    return createHostError(
      error.kind === "not_found" ? "SESSION_NOT_FOUND" : "INVALID_REQUEST",
      error.message,
      { retryable: error.kind === "not_ready" },
    );
  }
  return createHostError(
    "INTERNAL_ERROR",
    error instanceof Error ? error.message : "Attachment operation failed",
  );
}

export function createAttachmentHandlers(
  factory: WorkspaceGraphFactory,
): Partial<Record<string, MethodHandler>> {
  return {
    "attachment.create": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
        requireSession: true,
      });
      if (stale) return { error: stale };
      const store = factory.deps.attachmentStore;
      const server = factory.getServer();
      const sessionId = server?.identity.sessionId;
      if (!store || !server || !sessionId) {
        return { error: createHostError("AGENT_NOT_READY", "Attachment service is not ready") };
      }
      const params = ctx.params as { path: string };
      const onChange = (attachment: AttachmentSnapshot) => {
        if (server.identity.sessionId !== sessionId) return;
        server.emit("attachment.changed", { attachment });
      };
      try {
        const attachment = await store.create({
          sourcePath: params.path,
          sessionId,
          onChange,
        });
        const staleAfterCopy = factory.checkIdentity(ctx.context, {
          requireWorkspace: true,
          requireSession: true,
        });
        if (staleAfterCopy) {
          await store.removeDraft(attachment.id, sessionId).catch(() => undefined);
          return { error: staleAfterCopy };
        }
        return { result: attachment };
      } catch (error) {
        return { error: attachmentHostError(error) };
      }
    },

    "attachment.createText": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
        requireSession: true,
      });
      if (stale) return { error: stale };
      const store = factory.deps.attachmentStore;
      const server = factory.getServer();
      const sessionId = server?.identity.sessionId;
      if (!store || !server || !sessionId) {
        return { error: createHostError("AGENT_NOT_READY", "Attachment service is not ready") };
      }
      const params = ctx.params as { text: string };
      const onChange = (attachment: AttachmentSnapshot) => {
        if (server.identity.sessionId !== sessionId) return;
        server.emit("attachment.changed", { attachment });
      };
      try {
        const attachment = await store.createText({
          text: params.text,
          sessionId,
          onChange,
        });
        const staleAfterCreate = factory.checkIdentity(ctx.context, {
          requireWorkspace: true,
          requireSession: true,
        });
        if (staleAfterCreate) {
          await store.removeDraft(attachment.id, sessionId).catch(() => undefined);
          return { error: staleAfterCreate };
        }
        return { result: attachment };
      } catch (error) {
        return { error: attachmentHostError(error) };
      }
    },

    "attachment.get": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
        requireSession: true,
      });
      if (stale) return { error: stale };
      const store = factory.deps.attachmentStore;
      const sessionId = factory.getServer()?.identity.sessionId;
      if (!store || !sessionId) {
        return { error: createHostError("AGENT_NOT_READY", "Attachment service is not ready") };
      }
      try {
        const params = ctx.params as { attachmentId: string };
        return { result: await store.get(params.attachmentId, sessionId) };
      } catch (error) {
        return { error: attachmentHostError(error) };
      }
    },

    "attachment.remove": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
        requireSession: true,
      });
      if (stale) return { error: stale };
      const store = factory.deps.attachmentStore;
      const sessionId = factory.getServer()?.identity.sessionId;
      if (!store || !sessionId) {
        return { error: createHostError("AGENT_NOT_READY", "Attachment service is not ready") };
      }
      try {
        const params = ctx.params as { attachmentId: string };
        await store.removeDraft(params.attachmentId, sessionId);
        return { result: { attachmentId: params.attachmentId, removed: true as const } };
      } catch (error) {
        return { error: attachmentHostError(error) };
      }
    },
  };
}
