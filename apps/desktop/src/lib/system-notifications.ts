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
    (extraTarget.workspacePath === undefined || typeof extraTarget.workspacePath === "string") &&
    (extraTarget.sessionId === undefined || typeof extraTarget.sessionId === "string") &&
    (extraTarget.sessionPath === undefined || typeof extraTarget.sessionPath === "string") &&
    (extraTarget.sessionRevision === undefined ||
      typeof extraTarget.sessionRevision === "number") &&
    (extraTarget.sessionName === undefined || typeof extraTarget.sessionName === "string") &&
    (extraTarget.archived === undefined || typeof extraTarget.archived === "boolean")
  );
}

export type SystemNotificationControllerOptions = {
  enabled: () => boolean;
  attention: () => SystemNotificationAttentionState;
  targetForSession: (sessionId: string, envelope: HostEventEnvelope) => SystemNotificationTarget;
  openTarget: (target: SystemNotificationTarget) => Promise<void>;
};

/** Emitted by the Rust `system_notify` command when a Windows toast is clicked. */
const SYSTEM_NOTIFICATION_CLICK_EVENT = "system-notification-click";

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
    const disposers: Array<() => void> = [];
    // Primary click path (Windows): the custom system_notify toast wires the
    // WinRT Activated callback to this event, carrying the notification's
    // extra payload. The stock desktop plugin backend never emits action
    // events (actionPerformed is mobile-only), so without this listener a
    // toast click would just dismiss the toast.
    try {
      const { listen } = await import("@tauri-apps/api/event");
      const unlisten = await listen<unknown>(SYSTEM_NOTIFICATION_CLICK_EVENT, (event) => {
        this.routeClick(event.payload);
      });
      if (this.disposed) {
        unlisten();
      } else {
        disposers.push(unlisten);
      }
    } catch {
      // A missing event listener degrades to click-to-dismiss only; delivery
      // is unaffected.
    }
    // Fallback click path: the plugin's onAction is dormant on current
    // desktop backends but lights up if a future release surfaces action
    // events. Missing click support must never disable notification delivery.
    try {
      const api = await import("@tauri-apps/plugin-notification");
      const listener = await api.onAction((notification) => {
        this.routeClick(notification.extra);
      });
      if (this.disposed) {
        void listener.unregister().catch(() => undefined);
      } else {
        disposers.push(() => void listener.unregister().catch(() => undefined));
      }
    } catch {
      // See above: click support is best-effort.
    }
    if (disposers.length > 0) {
      this.actionDisposer = () => {
        for (const dispose of disposers) dispose();
      };
    }
  }

  /** Validates and routes one click payload (extra: { kind, target }). */
  private routeClick(payload: unknown): void {
    if (!isNotificationPayload(payload)) return;
    if (this.disposed) return;
    void this.options
      .openTarget(payload.target ?? { workspaceId: null, workspaceRevision: undefined })
      .catch(() => undefined);
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
    if (!this.options.enabled()) return;
    this.sendQueue = this.sendQueue.then(() => this.send(candidate));
  }

  private async send(candidate: SystemNotificationCandidate): Promise<void> {
    if (this.disposed || this.options.attention() !== "background" || !this.options.enabled())
      return;
    try {
      const api = await import("@tauri-apps/plugin-notification");
      let granted = await api.isPermissionGranted();
      if (!granted) {
        // A hard denial must not turn every later alert into another
        // permission prompt, but the sticky flag must also not outlive the OS
        // setting: when the user re-enables notifications system-wide,
        // isPermissionGranted flips to granted and clears the flag here.
        if (this.permissionDenied) return;
        const permission = await api.requestPermission();
        granted = permission === "granted";
        this.permissionDenied = permission === "denied";
      } else {
        this.permissionDenied = false;
      }
      // Permission checks may finish after focus changes or the controller is
      // disposed. Do not deliver a queued background alert in that case.
      if (this.disposed || this.options.attention() !== "background" || !this.options.enabled())
        return;
      if (!granted) return;
      const copy = systemNotificationCopy(candidate.kind, candidate.target?.sessionName);
      // The desktop plugin's notify command drops the extra payload (and with
      // it any chance of click routing), so delivery goes through the app's
      // own command: on Windows it shows a WinRT toast whose Activated
      // callback emits system-notification-click with `extra`; other desktop
      // platforms fall back to the plugin's builder internally. The command
      // may still be accepted by the OS while the toast is later suppressed
      // by Focus Assist / Do Not Disturb — that part is not observable.
      await invoke("system_notify", {
        title: copy.title,
        body: copy.body,
        extra: {
          kind: candidate.kind,
          ...(candidate.target ? { target: candidate.target } : {}),
        },
      });
    } catch {
      // A transient native delivery error is not a permission denial. Keep the
      // queue usable so a later response can still notify the user.
    }
  }
}
