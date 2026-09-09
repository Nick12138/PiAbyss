import type { Translate } from "../i18n/use-t";

type HostErrorLike = { code?: string; message?: string };

/** Host error codes that represent a transient "busy" condition. These surface
 *  as a one-shot toast but are not retained in the notification center history
 *  (they use the non-persistent `info` level that the bell badge ignores).
 *  See `apps/desktop/src/components/NotificationCenter.tsx`. */
export const TRANSIENT_HOST_ERROR_CODES: ReadonlySet<string> = new Set([
  "AGENT_BUSY",
  "PACKAGE_MUTATION_BUSY",
  // SERVICE_GRAPH_BUSY is the shared serviceGraphLock refusing a request while
  // another graph operation holds it. Host mutations now queue briefly and the
  // UI retries retryable busy responses, so anything that still reaches the
  // user is a momentary collision — not a persistent failure worth history.
  "SERVICE_GRAPH_BUSY",
]);

/** Choose the notification level for a host error. Transient "busy" conditions
 *  return `info` so they don't linger in the notification history; everything
 *  else returns `error`. */
export function hostErrorLevel(error: HostErrorLike | null | undefined): "info" | "error" {
  return error && TRANSIENT_HOST_ERROR_CODES.has(error.code ?? "") ? "info" : "error";
}

/** Package mutation failures carry raw npm/git stderr in `message`. Detect the
 *  common user-actionable causes and map them to friendly localized text. */
const PACKAGE_FAILURE_CODES: ReadonlySet<string> = new Set([
  "PACKAGE_INSTALL_FAILED",
  "PACKAGE_REMOVE_FAILED",
  "PACKAGE_UPDATE_FAILED",
  "PACKAGE_PARTIAL_FAILURE",
  "PACKAGE_RESOLVE_FAILED",
]);

/** Map raw package-manager output (npm/git stderr) to a friendly localized
 *  message, or return undefined when no known cause is detected. Also used for
 *  bare progress-event messages that have no error code. */
export function localizePackageMessage(
  message: string | null | undefined,
  t: Translate,
): string | undefined {
  if (!message) return undefined;
  if (
    /\bEBUSY\b|resource busy|being used by another process|file is in use|locked/iu.test(message)
  ) {
    return t("hostErrPackageFileBusy");
  }
  if (
    /\bEPERM\b|\bEACCES\b|operation not permitted|permission denied|access is denied/iu.test(
      message,
    )
  ) {
    return t("hostErrPackagePermission");
  }
  if (/\bE404\b|404 Not Found|No matching version|not in this registry/iu.test(message)) {
    return t("hostErrPackageNotInRegistry");
  }
  if (
    /\bENOTFOUND\b|\bEAI_AGAIN\b|\bETIMEDOUT\b|\bECONNRESET\b|\bECONNREFUSED\b|network|fetch failed|socket hang up/iu.test(
      message,
    )
  ) {
    return t("hostErrPackageNetwork");
  }
  return undefined;
}

const CODE_TO_KEY: Record<
  string,
  | "hostErrAgentBusy"
  | "hostErrAgentNotReady"
  | "hostErrNoActiveSession"
  | "hostErrWorkspaceServicesNotReady"
  | "hostErrServiceBusy"
  | "hostErrNoWorkspace"
  | "hostErrPackageMutationBusy"
  | "hostErrPackageNotFound"
  | "hostErrModelNotFound"
  | "hostErrSessionSwitchFailed"
  | "hostErrWorkspaceSwitchFailed"
  | "hostErrWorkspaceDirMissing"
  | "hostErrSessionArchived"
  | "hostErrHostShuttingDown"
  | "hostErrInvalidRequest"
  | "hostErrAuthRequired"
  | "hostErrSessionNotFound"
  | "hostErrSessionNotInWorkspace"
  | "hostErrUnknown"
> = {
  AGENT_BUSY: "hostErrAgentBusy",
  AGENT_NOT_READY: "hostErrAgentNotReady",
  SERVICE_GRAPH_BUSY: "hostErrServiceBusy",
  PROJECT_NOT_SELECTED: "hostErrNoWorkspace",
  PACKAGE_MUTATION_BUSY: "hostErrPackageMutationBusy",
  PACKAGE_NOT_FOUND: "hostErrPackageNotFound",
  MODEL_NOT_FOUND: "hostErrModelNotFound",
  SESSION_SWITCH_FAILED: "hostErrSessionSwitchFailed",
  WORKSPACE_SWITCH_FAILED: "hostErrWorkspaceSwitchFailed",
  HOST_SHUTTING_DOWN: "hostErrHostShuttingDown",
  INVALID_REQUEST: "hostErrInvalidRequest",
  AUTH_REQUIRED: "hostErrAuthRequired",
  SESSION_NOT_FOUND: "hostErrSessionNotFound",
};

/**
 * Host errors surface raw English strings. Map the known user-facing error
 * codes to the current locale so notifications render in the UI language.
 * Falls back to the raw message when the code is unknown or carries detail
 * (e.g. a path or provider id) that a generic translation would discard.
 */
export function localizeHostError(error: HostErrorLike | null | undefined, t: Translate): string {
  if (!error) return t("hostErrUnknown");
  const code = error.code ?? "";
  if (code === "SESSION_NOT_FOUND" && error.message) {
    if (/not in the current workspace|switch workspace first/iu.test(error.message)) {
      return t("hostErrSessionNotInWorkspace");
    }
  }
  if (code === "WORKSPACE_SWITCH_FAILED" && error.message) {
    const dir = error.message.match(/Directory does not exist: (.+)$/iu)?.[1];
    if (dir) return t("hostErrWorkspaceDirMissing", { path: dir });
  }
  if (code === "SESSION_SWITCH_FAILED" && /already archived/iu.test(error.message ?? "")) {
    return t("hostErrSessionArchived");
  }
  if (code === "AGENT_NOT_READY" && error.message) {
    if (/no active session/iu.test(error.message)) return t("hostErrNoActiveSession");
    if (/workspace services/iu.test(error.message)) return t("hostErrWorkspaceServicesNotReady");
  }
  if (PACKAGE_FAILURE_CODES.has(code)) {
    return localizePackageMessage(error.message, t) ?? t("hostErrPackageFailed");
  }
  const key = CODE_TO_KEY[code];
  if (key) return t(key);
  return error.message || t("hostErrUnknown");
}
