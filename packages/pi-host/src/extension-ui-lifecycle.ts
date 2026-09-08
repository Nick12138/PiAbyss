import type { AgentSession, ExtensionCommandContextActions } from "@earendil-works/pi-coding-agent";
import type { HostIdentity } from "@piabyss/protocol";
import { bindExtensionUi, type ExtensionUiBinding } from "./extension-ui-bridge.js";
import type { PiHostServer } from "./server.js";

export type ExtensionUiSlots = {
  extensionUiActivate: (() => Promise<() => void>) | null;
  extensionUiCleanup: (() => void) | null;
  extensionUiUpdateIdentity: ((identity: HostIdentity) => void) | null;
  extensionUiReplayState: (() => void) | null;
};

/** Bind the existing bridge to a not-yet-committed Host identity. */
export function bindForCandidate(
  session: AgentSession,
  extensionsResult: unknown,
  server: PiHostServer,
  candidateIdentity: HostIdentity,
  commandContextActions?: ExtensionCommandContextActions,
): Promise<ExtensionUiBinding> {
  return bindExtensionUi(session, extensionsResult, {
    // The static emit closure carries the candidate identity. Between bind
    // and commit there is no emission point (the bridge queues events until
    // activation), and a re-bound parked graph still holds the old workspace
    // identity, so route through the relaxed bound-identity emit: identical
    // to emitForIdentity once the candidate is committed and current.
    emit: (event, payload) => server.emitForBoundIdentity(candidateIdentity, event, payload),
    emitForIdentity: (identity, event, payload) =>
      server.emitForBoundIdentity(identity, event, payload),
    getIdentity: () => candidateIdentity,
    getCurrentIdentity: () => server.getIdentity(),
    getExtensionDecisionPresentation: () => server.getExtensionDecisionPresentation(),
    ...(commandContextActions !== undefined ? { commandContextActions } : {}),
  });
}

/** Activate a prepared binding exactly once. Transaction rollback stays with the caller. */
export async function activateOnce(slots: ExtensionUiSlots): Promise<() => void> {
  const activate = slots.extensionUiActivate;
  slots.extensionUiActivate = null;
  if (!activate) return () => {};
  try {
    return await activate();
  } catch (error) {
    clearSlots(slots);
    throw error;
  }
}

/** Dispose a binding and clear every Extension UI lifecycle slot. */
export function clearSlots(slots: ExtensionUiSlots): void {
  slots.extensionUiActivate = null;
  try {
    slots.extensionUiCleanup?.();
  } finally {
    slots.extensionUiCleanup = null;
    slots.extensionUiUpdateIdentity = null;
    slots.extensionUiReplayState = null;
  }
}
