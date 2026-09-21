import { tCurrent } from "./i18n/use-t";
import { useAppStore } from "./stores/app-store";
import {
  draftKeyForTarget,
  type DraftKey,
  type DraftMutation,
  type DraftReference,
  type DraftTarget,
  type DraftWorkspaceSnapshot,
  type StoredDraftAttachment,
} from "./draft-target";

export const DRAFT_WRITE_DEBOUNCE_MS = 250;
const DRAFT_CLOSE_FLUSH_TIMEOUT_MS = 500;

export type DraftSendReceipt = {
  target: DraftTarget;
  text: string;
  version: number;
};

/**
 * Dirty-key set. Mutations are not queued eagerly — each flush rebuilds the
 * upsert payload (text + attachments + references) from the app store, so the
 * last state before the flush always wins and text/attachment/reference edits
 * can never clobber each other with a stale partial payload.
 */
let dirtyKeys = new Set<DraftKey>();
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let writeQueue: Promise<void> = Promise.resolve();
let persistenceFailureNotified = false;
let hydrationRequest = 0;

function markDraftDirty(key: DraftKey): void {
  dirtyKeys.add(key);
  if (writeTimer !== null) return;
  writeTimer = globalThis.setTimeout(() => {
    writeTimer = null;
    void flushDraftWrites();
  }, DRAFT_WRITE_DEBOUNCE_MS);
}

function buildMutations(): DraftMutation[] {
  const state = useAppStore.getState();
  const mutations: DraftMutation[] = [];
  for (const key of dirtyKeys) {
    const target = state.draftTargets[key];
    // Unknown target: nothing was ever persisted for this key — skip.
    if (!target) continue;
    const text = state.draftTexts[key] ?? "";
    const attachments = state.draftAttachments[key] ?? [];
    const references = state.draftReferences[key] ?? [];
    if (!text.trim() && attachments.length === 0 && references.length === 0) {
      mutations.push({ op: "delete", target });
    } else {
      mutations.push({ op: "upsert", target, text, attachments, references });
    }
  }
  return mutations;
}

async function applyNativeMutations(mutations: DraftMutation[]): Promise<void> {
  const { invoke, isTauri } = await import("@tauri-apps/api/core");
  if (!isTauri()) return;
  await invoke("desktop_drafts_apply", { mutations });
}

function notifyPersistenceFailure(error: unknown): void {
  if (persistenceFailureNotified) return;
  persistenceFailureNotified = true;
  const detail = error instanceof Error ? error.message : String(error);
  useAppStore
    .getState()
    .pushNotification(`${tCurrent("notifDraftPersistenceFailed")}: ${detail}`, "warning");
}

export function flushDraftWrites(): Promise<void> {
  if (writeTimer !== null) {
    globalThis.clearTimeout(writeTimer);
    writeTimer = null;
  }
  if (dirtyKeys.size === 0) return writeQueue;

  const mutations = buildMutations();
  dirtyKeys = new Set();
  writeQueue = writeQueue
    .catch(() => undefined)
    .then(() => applyNativeMutations(mutations))
    .then(() => {
      persistenceFailureNotified = false;
    })
    .catch((error) => {
      for (const mutation of mutations) {
        markDraftDirty(draftKeyForTarget(mutation.target));
      }
      notifyPersistenceFailure(error);
    });
  return writeQueue;
}

export async function settleDraftWritesWithin(
  timeoutMs = DRAFT_CLOSE_FLUSH_TIMEOUT_MS,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      flushDraftWrites(),
      new Promise<void>((resolve) => {
        timeout = globalThis.setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== null) globalThis.clearTimeout(timeout);
  }
}

export function editDraft(target: DraftTarget, text: string): number {
  const version = useAppStore.getState().setDraftTextLocal(target, text);
  markDraftDirty(draftKeyForTarget(target));
  return version;
}

/** Persist the composer's restorable attachment snapshot for one draft. */
export function setDraftAttachmentSnapshot(
  target: DraftTarget,
  attachments: readonly StoredDraftAttachment[],
): void {
  useAppStore.getState().setDraftAttachments(target, attachments);
  markDraftDirty(draftKeyForTarget(target));
}

/** Update the injected references of one draft and mark them for persistence. */
export function setDraftReferencesPersisted(
  target: DraftTarget,
  references: readonly DraftReference[],
): void {
  useAppStore.getState().setDraftReferences(target, references);
  markDraftDirty(draftKeyForTarget(target));
}

/** Clear the draft text; attachments/references (if any) stay persisted. */
export function deleteDraft(target: DraftTarget): number {
  const version = useAppStore.getState().setDraftTextLocal(target, "");
  markDraftDirty(draftKeyForTarget(target));
  return version;
}

/** Drop every persisted field (text + attachments + references) of a draft. */
export function deleteDraftEntirely(target: DraftTarget): void {
  useAppStore.getState().clearDraftState(target);
  markDraftDirty(draftKeyForTarget(target));
}

export function deleteSessionDrafts(canonicalCwd: string, sessionIds: readonly string[]): void {
  for (const sessionId of new Set(sessionIds)) {
    deleteDraftEntirely({ kind: "session", canonicalCwd, sessionId });
  }
}

export function stageDraftSend(target: DraftTarget): DraftSendReceipt {
  const key = draftKeyForTarget(target);
  const state = useAppStore.getState();
  const text = state.draftTexts[key] ?? "";
  const version = state.setDraftTextLocal(target, "");
  return { target, text, version };
}

export function commitDraftSend(receipt: DraftSendReceipt): boolean {
  const key = draftKeyForTarget(receipt.target);
  if ((useAppStore.getState().draftEditVersions[key] ?? 0) !== receipt.version) return false;
  // The composer clears its attachments/references before committing, so the
  // store now holds an empty payload and the flush resolves to a delete. If a
  // send failed and was restored instead, the re-added state persists again.
  markDraftDirty(key);
  return true;
}

export function restoreDraftSend(receipt: DraftSendReceipt): string {
  const key = draftKeyForTarget(receipt.target);
  const state = useAppStore.getState();
  const currentVersion = state.draftEditVersions[key] ?? 0;
  const currentText = state.draftTexts[key] ?? "";
  const restored =
    currentVersion === receipt.version || !currentText
      ? receipt.text
      : receipt.text
        ? `${receipt.text}\n\n${currentText}`
        : currentText;
  editDraft(receipt.target, restored);
  return restored;
}

export async function hydrateDraftWorkspace(canonicalCwd: string): Promise<void> {
  const request = ++hydrationRequest;
  const baselineVersions = { ...useAppStore.getState().draftEditVersions };
  try {
    const { invoke, isTauri } = await import("@tauri-apps/api/core");
    const snapshot = isTauri()
      ? await invoke<DraftWorkspaceSnapshot>("desktop_drafts_get", { canonicalCwd })
      : { schemaVersion: 2, drafts: [] };
    if (request !== hydrationRequest) return;
    const store = useAppStore.getState();
    store.mergeHydratedDrafts(canonicalCwd, snapshot.drafts, baselineVersions);
    if (snapshot.warning) {
      store.pushNotification(
        snapshot.recoveredFrom
          ? `${snapshot.warning}. ${tCurrent("notifBackupFrom", { path: snapshot.recoveredFrom })}`
          : snapshot.warning,
        "warning",
      );
    }
  } catch (error) {
    if (request === hydrationRequest) notifyPersistenceFailure(error);
  }
}

export function __resetDraftPersistenceForTests(): void {
  if (writeTimer !== null) globalThis.clearTimeout(writeTimer);
  dirtyKeys = new Set();
  writeTimer = null;
  writeQueue = Promise.resolve();
  persistenceFailureNotified = false;
  hydrationRequest = 0;
}
