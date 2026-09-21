import type { SessionSnapshot, WorkspaceSnapshot } from "@piabyss/protocol";

type DraftKind = "session" | "new-conversation";
export type DraftKey = string;

export type DraftTarget =
  | { kind: Extract<DraftKind, "session">; canonicalCwd: string; sessionId: string }
  | {
      kind: Extract<DraftKind, "new-conversation">;
      canonicalCwd: string;
      sessionId?: never;
    };

export type DraftRecord = DraftTarget & {
  text: string;
  /** Absent when empty (the Rust store skips empty arrays on write). */
  attachments?: StoredDraftAttachment[];
  /** Absent when empty (the Rust store skips empty arrays on write). */
  references?: DraftReference[];
  updatedAt: number;
};

/**
 * A restorable composer attachment persisted alongside the draft text.
 * Path-backed entries only keep the absolute source path so restore can
 * re-read (or re-upload) them; content-backed entries keep the payload and
 * are individually size-capped by `pruneStoredDraftAttachments` before write
 * and re-validated by the Rust draft store.
 */
export type StoredDraftAttachment =
  | {
      type: "image";
      id: string;
      name?: string;
      /** When present, restore re-reads the file instead of using `data`. */
      sourcePath?: string;
      mediaType?: string;
      /** Base64 payload (clipboard images only, size-capped). */
      data?: string;
    }
  | {
      type: "file";
      id: string;
      name: string;
      size: number;
      kind: "text" | "path";
      text?: string;
      sourcePath?: string;
      isDirectory?: boolean;
      unlimited?: boolean;
    }
  | { type: "document"; sourcePath: string }
  | { type: "pasted-text"; text: string };

export type DraftWorkspaceSnapshot = {
  schemaVersion: number;
  drafts: DraftRecord[];
  warning?: string;
  recoveredFrom?: string;
};

export type DraftMutation =
  /**
   * Full-state upsert: replaces the record's text, attachments, and
   * references together. An upsert whose payload is entirely empty deletes
   * the target instead. Omitted fields mean "empty", not "unchanged".
   */
  | {
      op: "upsert";
      target: DraftTarget;
      text: string;
      attachments?: StoredDraftAttachment[];
      references?: DraftReference[];
    }
  | { op: "delete"; target: DraftTarget };

/**
 * Prompt payload the app injected into a draft on the user's behalf (e.g. the
 * memo "handle now" action), or a transcript-selection quote capsule. The
 * composer renders it as a capsule and only expands `payload` into the
 * outgoing text at send time, so the payload never shows up in the input box.
 */
export type DraftReference = {
  /** Unique within one draft; used as the React key and for removal. */
  id: string;
  /** "memo" renders an `@Memo · title` capsule; "quote" a `Quote · preview` one. */
  kind: "memo" | "quote";
  /** Capsule caption: the memo title or the quote preview. */
  label: string;
  /** Full prompt text (memo) or blockquote (quote) prepended to the message. */
  payload: string;
};

export function draftKeyForTarget(target: DraftTarget): DraftKey {
  return target.kind === "session"
    ? `session:${target.sessionId ?? ""}`
    : `new:${target.canonicalCwd}`;
}

export function draftTargetFor(
  workspace: Pick<WorkspaceSnapshot, "canonicalCwd"> | null,
  session: Pick<SessionSnapshot, "sessionId" | "messages"> | null,
): DraftTarget | null {
  if (!workspace || !session) return null;
  if (session.messages.length === 0) {
    return {
      kind: "new-conversation",
      canonicalCwd: workspace.canonicalCwd,
    };
  }
  return {
    kind: "session",
    canonicalCwd: workspace.canonicalCwd,
    sessionId: session.sessionId,
  };
}

export function draftTargetFromRecord(record: DraftRecord): DraftTarget {
  return record.kind === "session"
    ? {
        kind: "session",
        canonicalCwd: record.canonicalCwd,
        sessionId: record.sessionId,
      }
    : {
        kind: "new-conversation",
        canonicalCwd: record.canonicalCwd,
      };
}
