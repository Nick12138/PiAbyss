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
  updatedAt: number;
};

export type DraftWorkspaceSnapshot = {
  schemaVersion: number;
  drafts: DraftRecord[];
  warning?: string;
  recoveredFrom?: string;
};

export type DraftMutation =
  { op: "upsert"; target: DraftTarget; text: string } | { op: "delete"; target: DraftTarget };

/**
 * Prompt payload the app injected into a draft on the user's behalf (e.g. the
 * memo "handle now" action). The composer renders it as an `@` chip and only
 * expands `payload` into the outgoing text at send time, so the prompt never
 * shows up in the input box.
 */
export type DraftReference = {
  /** Unique within one draft; used as the React key and for removal. */
  id: string;
  kind: "memo";
  /** Chip caption: the memo title. */
  label: string;
  /** Full prompt text prepended to the message (reference block + instruction). */
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
