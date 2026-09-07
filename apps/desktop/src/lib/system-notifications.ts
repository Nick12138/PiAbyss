import type { HostEventEnvelope } from "@piabyss/protocol";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { tCurrent } from "./i18n/use-t";

export type SystemNotificationKind =
  "response-ready" | "session-failed" | "input-required" | "host-fatal";

export type SystemNotificationTarget = {
  workspaceId: string | null;
  workspaceRevision: number | undefined;
  workspacePath?: string;
  sessionId?: string;
  sessionPath?: string;
  sessionRevision?: number;
  /** Fork addition: catalog display name, appended to the OS body copy. */
  sessionName?: string;
  /** Fork addition: catalog archived flag for the click router's hint. */
  archived?: boolean;
};

export type SystemNotificationCandidate = {
  kind: SystemNotificationKind;
  target?: SystemNotificationTarget;
};

type SystemNotificationAttentionState = "foreground" | "background" | "unknown";

export type SystemNotificationObservationContext = {
  attention: SystemNotificationAttentionState;
  targetForSession: (sessionId: string, envelope: HostEventEnvelope) => SystemNotificationTarget;
};

type RunState = { failed: boolean; deliveredFailure: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function terminalAssistantOutcome(messages: unknown): "aborted" | "error" | "success" {
  if (!Array.isArray(messages)) return "success";
  const assistant = [...messages].reverse().find((message) => {
    return isRecord(message) && message.role === "assistant";
  });
  if (!isRecord(assistant)) return "success";
  if (assistant.stopReason === "aborted") return "aborted";
  if (assistant.stopReason === "error") return "error";
  return "success";
}

function runKey(event: HostEventEnvelope<"agent.event">): string {
  return [
    event.hostInstanceId,
    event.workspaceId ?? "",
    event.sessionId ?? "",
    event.payload.runId,
  ].join("/");
}

/** Stateful event classifier kept independent from notification delivery. */
export class SystemNotificationTracker {
  private readonly runs = new Map<string, RunState>();
  private readonly delivered = new Set<string>();
  private readonly deliveredAttention = new Set<string>();

  reset(): void {
    this.runs.clear();
    this.delivered.clear();
    this.deliveredAttention.clear();
  }

  observe(
    event: HostEventEnvelope,
    context: SystemNotificationObservationContext,
  ): SystemNotificationCandidate | null {
    const shouldNotify = context.attention === "background";

    if (event.event === "host.fatal") {
      if (!shouldNotify || this.deliveredAttention.has("host-fatal")) return null;
      this.deliveredAttention.add("host-fatal");
      return { kind: "host-fatal" };
    }

    if (event.event === "extensionUi.request" && event.sessionId) {
      const requestId =
        isRecord(event.payload) && typeof event.payload.requestId === "string"
          ? event.payload.requestId
          : `${event.hostInstanceId}/${event.sessionId}/${event.sequence}`;
      if (!shouldNotify || this.deliveredAttention.has(`input/${requestId}`)) return null;
      this.deliveredAttention.add(`input/${requestId}`);
      return {
        kind: "input-required",
        target: context.targetForSession(event.sessionId, event),
      };
    }

    if (event.event !== "agent.event" || !event.sessionId) return null;

    const key = runKey(event);
    if (this.delivered.has(key)) return null;
    const state = this.runs.get(key) ?? { failed: false, deliveredFailure: false };
    const agentEvent = event.payload.event;

    if (agentEvent.type === "error") {
      state.failed = true;
      this.runs.set(key, state);
      if (state.deliveredFailure) return null;
      state.deliveredFailure = true;
      this.delivered.add(key);
      if (!shouldNotify) return null;
      return {
        kind: "session-failed",
        target: context.targetForSession(event.sessionId, event),
      };
    }

    if (agentEvent.type === "agent_end") {
      if (agentEvent.willRetry === true) {
        this.runs.set(key, state);
        return null;
      }
      const outcome = terminalAssistantOutcome(agentEvent.messages);
      this.runs.delete(key);
      if (outcome === "aborted") return null;
      if (state.deliveredFailure) return null;
      this.delivered.add(key);
      if (!shouldNotify) return null;
      if (state.failed || outcome === "error") {
        return {
          kind: "session-failed",
          target: context.targetForSession(event.sessionId, event),
        };
      }
      return {
        kind: "response-ready",
        target: context.targetForSession(event.sessionId, event),
      };
    }

    if (agentEvent.type === "agent_settled") this.runs.delete(key);
    return null;
  }
}

export function systemNotificationCopy(
  kind: SystemNotificationKind,
  sessionName?: string,
): {
  title: string;
  body: string;
} {
  let body: string;
  switch (kind) {
    case "response-ready":
      body = tCurrent("systemNotificationReady");
      break;
    case "session-failed":
      body = tCurrent("systemNotificationFailed");
      break;
    case "input-required":
      body = tCurrent("systemNotificationInput");
      break;
    case "host-fatal":
      body = tCurrent("systemNotificationHostUnavailable");
      break;
  }
  // Fork addition: identify which session produced the event. Session names are
  // catalog metadata (never extension-controlled content), and the separator is
  // locale-neutral punctuation rather than embedded copy.
  const trimmedName = sessionName?.trim();
  if (trimmedName) body = `${body} — ${trimmedName}`;
  return { title: tCurrent("systemNotificationTitle"), body };
}

type NotificationPayload = {
  kind: SystemNotificationKind;
  target?: SystemNotificationTarget;
};

function isNotificationPayload(value: unknown): value is NotificationPayload {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (
    !(["response-ready", "session-failed", "input-required", "host-fatal"] as string[]).includes(
      value.kind,
    )
  ) {
    return false;
  }
  if (value.target === undefined) return true;
  if (!isRecord(value.target)) return false;
  const extraTarget = value.target as Record<string, unknown>;
  return (
    (extraTarget.workspaceId === null || typeof extraTarget.workspaceId === "string") &&
    (extraTarget.workspaceRevision === undefined ||
      typeof extraTarget.workspaceRevision === "number") &&
    (extraTarget.sessionId === undefined || typeof extraTarget.sessionId === "string") &&
    (extraTarget.sessionPath === undefined || typeof extraTarget.sessionPath === "string") &&
    (extraTarget.sessionName === undefined || typeof extraTarget.sessionName === "string")
  );
}

export type SystemNotificationControllerOptions = {
  enabled: () => boolean;
  attention: () => SystemNotificationAttentionState;
  targetForSession: (sessionId: string, envelope: HostEventEnvelope) => SystemNotificationTarget;
  openTarget: (target: SystemNotificationTarget) => Promise<void>;
};

export class SystemNotificationController {
  private readonly tracker = new SystemNotificationTracker();
  private readonly options: SystemNotificationControllerOptions;
  private permissionDenied = false;
  private disposed = false;
  private actionDisposer: (() => void) | null = null;
  private sendQueue: Promise<void> = Promise.resolve();

  constructor(options: SystemNotificationControllerOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (!isTauri() || this.disposed) return;
    try {
      const api = await import("@tauri-apps/plugin-notification");
      const listener = await api.onAction((notification) => {
        const extra = notification.extra;
        if (!isNotificationPayload(extra)) return;
        if (this.disposed) return;
        void this.options
          .openTarget(extra.target ?? { workspaceId: null, workspaceRevision: undefined })
          .catch(() => undefined);
      });
      if (this.disposed) {
        void listener.unregister().catch(() => undefined);
        return;
      }
      this.actionDisposer = () => void listener.unregister().catch(() => undefined);
    } catch {
      // The desktop plugin can send notifications without implementing action
      // listeners. Missing click support must never disable notification delivery.
    }
  }

  dispose(): void {
    this.disposed = true;
    this.actionDisposer?.();
    this.actionDisposer = null;
    this.tracker.reset();
  }

  reset(): void {
    this.tracker.reset();
  }

  observe(event: HostEventEnvelope): void {
    if (this.disposed || !isTauri()) return;
    const candidate = this.tracker.observe(event, {
      attention: this.options.attention(),
      targetForSession: this.options.targetForSession,
    });
    if (candidate) this.deliver(candidate);
  }

  /**
   * Deliver an already-classified candidate. Used by the cross-workspace
   * activity observer, whose completions never appear as renderer-visible
   * host events (background Host stdout is not routed) and therefore cannot
   * go through observe().
   */
  deliver(candidate: SystemNotificationCandidate): void {
    if (this.disposed || !isTauri()) return;
    if (!this.options.enabled() || this.permissionDenied) return;
    this.sendQueue = this.sendQueue.then(() => this.send(candidate));
  }

  private async send(candidate: SystemNotificationCandidate): Promise<void> {
    if (
      this.disposed ||
      this.permissionDenied ||
      this.options.attention() !== "background" ||
      !this.options.enabled()
    )
      return;
    try {
      const api = await import("@tauri-apps/plugin-notification");
      let granted = await api.isPermissionGranted();
      if (!granted) {
        const permission = await api.requestPermission();
        granted = permission === "granted";
        this.permissionDenied = permission === "denied";
      }
      // Permission checks may finish after focus changes or the controller is
      // disposed. Do not deliver a queued background alert in that case.
      if (this.disposed || this.options.attention() !== "background" || !this.options.enabled())
        return;
      if (!granted) return;
      const copy = systemNotificationCopy(candidate.kind, candidate.target?.sessionName);
      // The JS sendNotification facade returns void. Await the desktop command
      // so command failures settle this queue instead of escaping it. The OS
      // may still suppress a notification after the command has accepted it.
      await invoke("plugin:notification|notify", {
        options: {
          title: copy.title,
          body: copy.body,
          autoCancel: true,
          extra: {
            kind: candidate.kind,
            ...(candidate.target ? { target: candidate.target } : {}),
          },
        },
      });
    } catch {
      // A transient native delivery error is not a permission denial. Keep the
      // queue usable so a later response can still notify the user.
    }
  }
}
