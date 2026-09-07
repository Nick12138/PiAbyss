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
