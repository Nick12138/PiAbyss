/**
 * OutboundWriter — bounded, ordered stdout queue with backpressure (A3).
 *
 * All host output (responses + events) flows through one queue so ordering
 * is preserved while honoring stream backpressure (`write() === false` →
 * wait for drain) instead of letting Node buffer unboundedly when the pipe
 * consumer stalls.
 *
 * Event sequence numbers are normally allocated at WRITE time, not enqueue
 * time, so the pressure policies below never create accidental sequence gaps.
 * A recovery barrier is the exception: it seals all earlier live events with
 * sequences and captures that exact watermark before queuing the response.
 *
 * - Above the soft watermark, coalescible events collapse in place:
 *   customFrame data for the same panel concatenates (ANSI streams compose),
 *   and latest-wins snapshots (status/widget/progress/queue/host
 *   status) replace their queued predecessor.
 * - Above the hard cap, droppable events are discarded outright. Any shed
 *   deliberately skips one sequence number so the frontend resets from an
 *   authoritative rehydrate snapshot. If the queue remains over the cap, all
 *   queued events are dropped; responses are always kept.
 */
import type { HostEventName, HostIdentity } from "@piabyss/protocol";
import { createEvent, createHostError, MAX_HOST_JSONL_FRAME_BYTES } from "@piabyss/protocol";
import { logger } from "./logger.js";

export type WritableLike = {
  write(chunk: string): boolean;
  once(event: "drain", listener: () => void): unknown;
};

type EventEntry = {
  kind: "event";
  identity: HostIdentity;
  event: HostEventName;
  payload: unknown;
  bytes: number;
  coalesceKey: string | null;
  sequence?: number;
  dropped?: boolean;
};

type ResponseEntry = {
  kind: "response";
  line: string;
  bytes: number;
  dropped?: boolean;
};

type Entry = EventEntry | ResponseEntry;

const OUTBOUND_SOFT_WATERMARK_BYTES = 1024 * 1024;
const OUTBOUND_HARD_CAP_BYTES = 16 * 1024 * 1024;

function jsonLine(value: unknown): { line: string; bytes: number } {
  const line = `${JSON.stringify(value)}\n`;
  return { line, bytes: Buffer.byteLength(line, "utf8") };
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

function oversizedResponseFailure(body: unknown): unknown {
  const response =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  return {
    protocolVersion: 1,
    hostInstanceId: response.hostInstanceId,
    workspaceId: response.workspaceId,
    workspaceRevision: response.workspaceRevision,
    sessionId: response.sessionId,
    sessionRevision: response.sessionRevision,
    packageRevision: response.packageRevision,
    id: response.id,
    method: response.method,
    ok: false,
    error: createHostError("INTERNAL_ERROR", "Host response exceeded transport frame limit"),
  };
}

/** Latest-wins or mergeable event classes — safe to collapse under pressure. */
function sameIdentity(left: HostIdentity, right: HostIdentity): boolean {
  return (
    left.hostInstanceId === right.hostInstanceId &&
    left.workspaceId === right.workspaceId &&
    left.workspaceRevision === right.workspaceRevision &&
    left.sessionId === right.sessionId &&
    left.sessionRevision === right.sessionRevision &&
    left.packageRevision === right.packageRevision
  );
}

function sessionScope(identity: HostIdentity): string {
  return [
    identity.hostInstanceId,
    identity.workspaceId ?? "",
    identity.workspaceRevision,
    identity.sessionId ?? "",
    identity.sessionRevision,
  ].join(":");
}

const AGENT_EVENT_IMAGE_OMITTED = "[image omitted: event payload exceeded transport limit]";
const AGENT_EVENT_TRUNCATED_SUFFIX = "\n…[truncated: event payload exceeded transport limit]";
const MAX_EVENT_STRING_BYTES = 256 * 1024;

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let text = value.slice(0, maxBytes);
  while (Buffer.byteLength(text, "utf8") > maxBytes) {
    text = text.slice(0, Math.max(1, Math.floor(text.length * 0.9)));
  }
  return value.slice(0, text.length);
}

/**
 * Agent events carry full message bodies (user text, base64 images, tool
 * results). Streaming whole transcripts means any one of them — a huge tool
 * result or a set of images — can exceed the 32MiB frame cap. Previously such
 * a frame was dropped out of the write loop after its sequence had been
 * allocated, manufacturing a synthetic gap: the desktop then lost the entire
 * turn prefix until rehydrate. Instead shrink the payload in place while
 * preserving the event structure (roles, boundaries, ids), which is what the
 * desktop needs to keep the current turn consistent. Returns false when the
 * payload could not be shrunk.
 */
function shrinkAgentEventPayload(payload: unknown): unknown {
  const marker = { changed: false };
  const result = shrinkValue(payload, marker);
  return marker.changed ? result : payload;
}

function shrinkValue(value: unknown, marker: { changed: boolean }): unknown {
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") <= MAX_EVENT_STRING_BYTES) return value;
    marker.changed = true;
    return `${truncateUtf8(value, MAX_EVENT_STRING_BYTES)}${AGENT_EVENT_TRUNCATED_SUFFIX}`;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const shrunk = shrinkValue(item, marker);
      if (!Object.is(shrunk, item)) changed = true;
      return shrunk;
    });
    return changed ? next : value;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (
      record.type === "image" &&
      typeof record.data === "string" &&
      Buffer.byteLength(record.data, "utf8") > MAX_EVENT_STRING_BYTES
    ) {
      marker.changed = true;
      return { type: "text", text: AGENT_EVENT_IMAGE_OMITTED };
    }
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      const shrunk = shrinkValue(item, marker);
      if (!Object.is(shrunk, item)) changed = true;
      next[key] = shrunk;
    }
    return changed ? next : value;
  }
  return value;
}

function coalesceKeyFor(
  identity: HostIdentity,
  event: HostEventName,
  payload: unknown,
): string | null {
  const p = payload as Record<string, unknown> | null;
  switch (event) {
    case "extensionUi.customFrame":
      return `frame:${String(p?.requestId ?? "")}`;
    case "extensionUi.statusChanged":
      return `status:${sessionScope(identity)}:${String(p?.key ?? "")}`;
    case "extensionUi.widgetChanged":
      return `widget:${sessionScope(identity)}:${String(p?.key ?? "")}`;
    case "extensionUi.widgetAttentionRequested":
      return `widget-attention:${sessionScope(identity)}:${String(p?.runId ?? "")}`;
    case "extensionUi.messageRendered":
      return `message-renderer:${sessionScope(identity)}:${String(p?.entryId ?? "")}`;
    // Runtime transitions are edges, not replaceable snapshots. In particular,
    // collapsing running -> idle would make the Rust workspace activity tracker
    // see only idle and lose the completed-session marker for background Hosts.
    case "session.runtimeChanged":
      return null;
    case "package.progress":
      return "package.progress";
    case "agent.queueChanged":
      return "agent.queueChanged";
    case "host.statusChanged":
      return "host.statusChanged";
    case "subagents.statusChanged":
      return `subagents:${sessionScope(identity)}`;
    default:
      return null;
  }
}

export class OutboundWriter {
  private readonly stream: WritableLike;
  private readonly allocateSequence: () => number;
  private readonly getCurrentIdentity?: () => HostIdentity;
  private readonly softWatermark: number;
  private readonly hardCap: number;
  private readonly maxFrameBytes: number;
  private readonly queue: Entry[] = [];
  private readonly coalesceIndex = new Map<string, EventEntry>();
  private pendingBytes = 0;
  private pumping = false;
  private pressureLoggedAt = 0;
  private idleResolvers: Array<() => void> = [];
  private lastAllocatedSequence = 0;

  constructor(options: {
    stream: WritableLike;
    allocateSequence: () => number;
    getCurrentIdentity?: () => HostIdentity;
    softWatermark?: number;
    hardCap?: number;
    maxFrameBytes?: number;
  }) {
    this.stream = options.stream;
    this.allocateSequence = options.allocateSequence;
    this.getCurrentIdentity = options.getCurrentIdentity;
    this.softWatermark = options.softWatermark ?? OUTBOUND_SOFT_WATERMARK_BYTES;
    this.hardCap = options.hardCap ?? OUTBOUND_HARD_CAP_BYTES;
    this.maxFrameBytes = options.maxFrameBytes ?? MAX_HOST_JSONL_FRAME_BYTES;
  }

  get queuedBytes(): number {
    return this.pendingBytes;
  }

  /** Responses are never coalesced; oversized bodies become correlated failures. */
  enqueueResponse(body: unknown): void {
    let serialized = jsonLine(body);
    if (serialized.bytes > this.maxFrameBytes) {
      const fallback = jsonLine(oversizedResponseFailure(body));
      logger.error("Outbound response exceeded frame limit; returning bounded failure", {
        id:
          typeof body === "object" && body !== null
            ? (body as Record<string, unknown>).id
            : undefined,
        method:
          typeof body === "object" && body !== null
            ? (body as Record<string, unknown>).method
            : undefined,
        frameBytes: serialized.bytes,
        maxFrameBytes: this.maxFrameBytes,
      });
      if (fallback.bytes > this.maxFrameBytes) {
        logger.error("Correlated oversized-response failure exceeded frame limit", {
          fallbackBytes: fallback.bytes,
          maxFrameBytes: this.maxFrameBytes,
        });
        return;
      }
      serialized = fallback;
    }
    this.push({ kind: "response", ...serialized });
  }

  /**
   * Enqueue a response that separates an authoritative snapshot from later events.
   * Earlier queued events receive their final sequences now; clearing the coalesce
   * index prevents a later event from replacing an entry on the snapshot side.
   */
  enqueueBarrierResponse(createBody: (watermark: number) => unknown): void {
    for (const entry of this.queue) {
      if (entry.kind === "event" && !entry.dropped && entry.sequence === undefined) {
        entry.sequence = this.nextSequence();
      }
    }
    this.coalesceIndex.clear();
    this.enqueueResponse(createBody(this.lastAllocatedSequence));
  }

  enqueueEvent(identity: HostIdentity, event: HostEventName, payload: unknown): void {
    const bytes = jsonBytes(payload);
    const coalesceKey = coalesceKeyFor(identity, event, payload);

    if (event === "extensionUi.widgetAttentionRequested") {
      const widgetKey = `widget:${sessionScope(identity)}:${String(
        (payload as { key?: unknown } | null)?.key ?? "",
      )}`;
      const widgetSnapshot = this.coalesceIndex.get(widgetKey);
      // The Host emits attention immediately after the widget snapshot. If
      // that snapshot breached the hard cap and was shed on arrival, opening
      // the panel would reveal whatever stale widget content the client has.
      if (widgetSnapshot?.dropped) return;
      // Keep the causal pair ordered. Later same-key updates must be queued
      // after attention instead of replacing its snapshot in place.
      if (widgetSnapshot) this.coalesceIndex.delete(widgetKey);
    }

    if (coalesceKey && this.pendingBytes > this.softWatermark) {
      const existing = this.coalesceIndex.get(coalesceKey);
      if (existing && !existing.dropped) {
        if (event === "extensionUi.customFrame") {
          // ANSI streams compose — append instead of queueing another frame.
          const target = existing.payload as { data: string };
          const incoming = payload as { data: string };
          target.data += incoming.data;
          existing.bytes += bytes;
          this.pendingBytes += bytes;
        } else {
          // Latest wins for snapshot-style events.
          this.pendingBytes += bytes - existing.bytes;
          existing.identity = identity;
          existing.payload = payload;
          existing.bytes = bytes;
        }
        this.maybeEnforceHardCap();
        return;
      }
    }

    const entry: EventEntry = {
      kind: "event",
      identity,
      event,
      payload,
      bytes,
      coalesceKey,
    };
    if (coalesceKey) this.coalesceIndex.set(coalesceKey, entry);
    this.push(entry);
  }

  /** Resolves once the queue is fully written to the stream. */
  drain(): Promise<void> {
    if (this.queue.length === 0 && !this.pumping) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  private push(entry: Entry): void {
    this.queue.push(entry);
    this.pendingBytes += entry.bytes;
    this.maybeEnforceHardCap();
    this.maybeLogPressure();
    if (!this.pumping) {
      this.pumping = true;
      queueMicrotask(() => void this.pump());
    }
  }

  private maybeEnforceHardCap(): void {
    if (this.pendingBytes <= this.hardCap) return;

    // First pass: shed everything coalescible/droppable.
    let shed = 0;
    for (const entry of this.queue) {
      if (entry.kind === "event" && entry.coalesceKey && !entry.dropped) {
        entry.dropped = true;
        shed += entry.bytes;
        this.pendingBytes -= entry.bytes;
      }
    }
    if (shed > 0) this.nextSequence();

    if (this.pendingBytes > this.hardCap) {
      // Catastrophic: consumer is effectively gone. Drop all events (keep
      // responses) and burn one sequence number so the client's gap
      // detection triggers a full rehydrate once the pipe recovers.
      let droppedEvents = 0;
      for (const entry of this.queue) {
        if (entry.kind === "event" && !entry.dropped) {
          entry.dropped = true;
          droppedEvents += 1;
          this.pendingBytes -= entry.bytes;
        }
      }
      if (droppedEvents > 0 && shed === 0) this.nextSequence();
      if (droppedEvents > 0 || shed > 0) {
        logger.error("Outbound queue exceeded hard cap; events dropped, sequence gap forced", {
          shedBytes: shed,
          droppedEvents,
          pendingBytes: this.pendingBytes,
        });
      } else {
        logger.warn("Outbound queue exceeded hard cap with retained responses only", {
          pendingBytes: this.pendingBytes,
        });
      }
      return;
    }

    if (shed > 0) {
      logger.warn("Outbound queue over hard cap; coalescible events shed and recovery forced", {
        shedBytes: shed,
        pendingBytes: this.pendingBytes,
      });
    }
  }

  private maybeLogPressure(): void {
    if (this.pendingBytes <= this.softWatermark) return;
    const now = Date.now();
    if (now - this.pressureLoggedAt < 5_000) return;
    this.pressureLoggedAt = now;
    logger.warn("Outbound queue above soft watermark; coalescing latest-wins events", {
      pendingBytes: this.pendingBytes,
      queued: this.queue.length,
    });
  }

  private nextSequence(): number {
    const sequence = this.allocateSequence();
    this.lastAllocatedSequence = sequence;
    return sequence;
  }

  private async pump(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const entry = this.queue.shift()!;
        if (entry.kind === "event" && entry.coalesceKey) {
          if (this.coalesceIndex.get(entry.coalesceKey) === entry) {
            this.coalesceIndex.delete(entry.coalesceKey);
          }
        }
        if (entry.dropped) continue;
        this.pendingBytes -= entry.bytes;

        // Subagent status is a session-scoped projection. A session switch can
        // happen while stdout is backpressured, leaving an old status entry in
        // this queue. Do not let that entry reach the new desktop session.
        if (
          entry.kind === "event" &&
          entry.event === "subagents.statusChanged" &&
          this.getCurrentIdentity &&
          !sameIdentity(entry.identity, this.getCurrentIdentity())
        ) {
          continue;
        }

        let line: string;
        if (entry.kind === "response") {
          line = entry.line;
        } else {
          const sequence = entry.sequence ?? this.nextSequence();
          let serialized = jsonLine(
            createEvent(entry.identity, entry.event, sequence, entry.payload as never),
          );
          if (serialized.bytes > this.maxFrameBytes && entry.event === "agent.event") {
            // Shrink rather than drop: the desktop turn view depends on these
            // boundaries, and a dropped message_start forces a full rehydrate.
            const shrunk = shrinkAgentEventPayload(entry.payload);
            const resized = jsonLine(
              createEvent(entry.identity, entry.event, sequence, shrunk as never),
            );
            if (resized.bytes <= this.maxFrameBytes) {
              logger.warn(
                "Outbound event exceeded frame limit; downgraded agent event payload",
                {
                  event: entry.event,
                  sequence,
                  frameBytes: serialized.bytes,
                  downgradedBytes: resized.bytes,
                  maxFrameBytes: this.maxFrameBytes,
                },
              );
              serialized = resized;
            }
          }
          if (serialized.bytes > this.maxFrameBytes) {
            logger.error("Outbound event exceeded frame limit; event dropped", {
              event: entry.event,
              sequence,
              frameBytes: serialized.bytes,
              maxFrameBytes: this.maxFrameBytes,
            });
            continue;
          }
          line = serialized.line;
        }

        if (!this.stream.write(line)) {
          await new Promise<void>((resolve) => {
            this.stream.once("drain", resolve);
          });
        }
      }
    } catch (err) {
      // Broken pipe or similar — the peer is gone; drop the backlog so we
      // don't spin. The stdin-close path handles actual shutdown.
      logger.error("Outbound write failed; discarding queued output", {
        error: err instanceof Error ? err.message : String(err),
        discarded: this.queue.length,
      });
      this.queue.length = 0;
      this.coalesceIndex.clear();
      this.pendingBytes = 0;
    } finally {
      this.pumping = false;
      if (this.queue.length > 0) {
        // New entries arrived while the finally block unwound.
        this.pumping = true;
        queueMicrotask(() => void this.pump());
      } else {
        for (const resolve of this.idleResolvers.splice(0)) resolve();
      }
    }
  }
}
