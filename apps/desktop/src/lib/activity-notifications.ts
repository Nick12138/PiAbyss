import {
  fetchHostActivity,
  hostActivityCwds,
  subscribeHostActivity,
  type HostActivitySummary,
} from "./bridge/tauri-transport";
import type { SystemNotificationCandidate } from "./system-notifications";

type ActivityAttention = "foreground" | "background" | "unknown";

/**
 * Windows path comparison ignores case; the pool's cwd and the renderer's
 * canonicalCwd can otherwise disagree on drive-letter casing.
 */
export function activityPathKey(path: string): string {
  return /^win/i.test(navigator.platform) ? path.toLowerCase() : path;
}

export type ActivityNotificationObserverOptions = {
  isActiveWorkspace: (cwd: string) => boolean;
  attention: () => ActivityAttention;
  enabled: () => boolean;
  notify: (candidate: SystemNotificationCandidate) => void;
};

/**
 * Bridges the Rust Host pool's cross-workspace activity snapshots into system
 * notifications. Background workspace Hosts do not route their stdout to the
 * renderer, so their completions never reach the event-stream notification
 * tracker; the pool's busy-change signal plus this snapshot diff is the only
 * seam the renderer has.
 *
 * The first snapshot primes the baseline silently: unacknowledged markers
 * that already exist (app start, renderer reload) were visible through the
 * sidebar badges before this observer existed and must not replay as alerts.
 * Afterwards, every NEW terminal generation for a non-active workspace becomes
 * a candidate while the window is in the background. The active workspace is
 * always skipped — its completions already flow through the event-stream
 * tracker, and double-delivering them would duplicate every foreground alert.
 */
export class ActivityNotificationObserver {
  private readonly baselines = new Map<string, number>();
  private primed = false;
  private disposed = false;
  private readonly unsubscribe: () => void;
  /** Serializes snapshot fetches; a queued refresh coalesces pending ones. */
  private queue: Promise<void> = Promise.resolve();
  private queued = false;

  constructor(private readonly options: ActivityNotificationObserverOptions) {
    this.unsubscribe = subscribeHostActivity(() => void this.refresh());
  }

  /**
   * Fetch a fresh snapshot; also called on every pool busy-change.
   *
   * Fetches are strictly serialized (FIFO): each fetch happens after the
   * previous snapshot was applied, so sample times are monotonically
   * ordered and out-of-order snapshots can never regress the baseline.
   * This also makes the priming race-free: the first applied snapshot is
   * the true oldest sample, and any key appearing afterwards is a genuine
   * post-prime completion. Bursts of busy-changes coalesce into one queued
   * fetch — its later sample time already covers everything that happened.
   */
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.queued) return this.queue;
    this.queued = true;
    const run = this.queue
      .catch(() => undefined)
      .then(async () => {
        this.queued = false;
        if (this.disposed) return;
        try {
          const list = await fetchHostActivity();
          if (this.disposed) return;
          this.observeSnapshot(list);
        } catch {
          // Activity snapshots are best-effort; the badge flow still covers the UI.
        }
      });
    this.queue = run;
    return run;
  }

  observeSnapshot(entries: HostActivitySummary[]): void {
    for (const entry of entries) {
      // One entry covers every workspace its Host serves. In shared-host mode
      // that is all registered workspaces of the single active Host, whose
      // stdout IS routed to the renderer — so if any of them is the active
      // workspace, the event-stream tracker already delivered those
      // completions and the whole entry is skipped to avoid double alerts.
      const cwds = hostActivityCwds(entry);
      const coversActiveWorkspace = cwds.some((cwd) => this.options.isActiveWorkspace(cwd));
      for (const [sessionId, terminal] of Object.entries(entry.terminalSessions ?? {})) {
        // Every cwd of the entry mirrors the same generation for a session, so
        // "advanced" flips exactly once per session — never once per cwd.
        let advanced = false;
        for (const cwd of cwds) {
          const key = `${activityPathKey(cwd)}\u0000${sessionId}`;
          const previous = this.baselines.get(key);
          this.baselines.set(key, terminal.generation);
          // Equal or lower generation is either already seen or a Host restart
          // (generations reset when the Host is recreated); neither notifies.
          if (previous !== undefined && terminal.generation <= previous) continue;
          advanced = true;
        }
        if (!this.primed || !advanced) continue;
        if (
          coversActiveWorkspace ||
          this.options.attention() !== "background" ||
          !this.options.enabled()
        ) {
          continue;
        }
        this.options.notify({
          kind: terminal.state === "error" ? "session-failed" : "response-ready",
          target: {
            workspaceId: null,
            workspaceRevision: undefined,
            // entry.cwd stays the Host-canonical display path; cwds are pool
            // keys used for matching (lowercased on Windows) only.
            workspacePath: entry.cwd,
            sessionId,
          },
        });
      }
    }
    this.primed = true;
  }

  dispose(): void {
    this.disposed = true;
    this.baselines.clear();
    this.unsubscribe();
  }
}
