import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { useT } from "../../lib/i18n/use-t";
import { parseUserAttachments } from "./transcript-model";

/** One jump target on the rail: a user message turn in conversation order. */
export type TurnRailStop = {
  /** Session entry id — `requestTranscriptScroll`'s `sourceId` format. */
  sourceId: string;
  /** Stable transcript row key — locates the row DOM node for active tracking. */
  rowKey: string;
  /** First line of the message, for the hover tooltip. */
  excerpt: string;
  /** Agent response excerpt (first few lines). */
  agentExcerpt?: string;
  /** Whether agent is still processing this turn. */
  agentPending?: boolean;
};

/** Viewport-clamped tooltip text budget (characters). */
const TOOLTIP_LIMIT = 96;

/** Row tops at or above this fraction of the viewport count as "passed". */
const ACTIVE_LINE = 0.25;

/** Comfortable tick pitch: 8px tick + 8px gap, the rail's original spacing. */
const PITCH_MAX = 12;

/** Smallest rail height kept for a handful of turns. */
const MIN_RAIL_HEIGHT = 160;

/** Share of the visible chat area a long rail may occupy. */
const RAIL_HEIGHT_RATIO = 0.5;

/**
 * How tall the rail may get: half the window, but never past the chat area it
 * is centered in. Turns beyond this are compressed instead of spilling off the
 * top and bottom of the window (the old `max-h-[50vh]` did not clip: the ticks
 * are `shrink-0` and `justify-center` overflows both ways).
 */
function railBudget(viewport: HTMLElement | null): number {
  const windowHalf = typeof window === "undefined" ? 400 : window.innerHeight * RAIL_HEIGHT_RATIO;
  const areaLimit = viewport ? viewport.clientHeight - 32 : Number.POSITIVE_INFINITY;
  return Math.max(MIN_RAIL_HEIGHT, Math.min(windowHalf, areaLimit));
}

/**
 * The last user turn whose row top sits above the viewport's active line.
 *
 * Rows are in transcript order, so their tops increase monotonically: scanning
 * from the tail and returning the first hit is O(1) for a reader at the bottom
 * of a long chat, where the old forward scan ran a `querySelector` plus a
 * layout read for every turn on every scroll frame.
 */
function activeStopIndex(stops: TurnRailStop[], element: HTMLElement): number | null {
  const scrollerRect = element.getBoundingClientRect();
  const line = scrollerRect.top + scrollerRect.height * ACTIVE_LINE;
  // Resolve every mounted row in a single query instead of one selector parse
  // per turn, then walk stops from the tail (row tops increase with order, so
  // the first hit from the back is the answer).
  const mounted = new Map<string, HTMLElement>();
  for (const node of element.querySelectorAll<HTMLElement>("[data-row-key]")) {
    const key = node.dataset.rowKey;
    if (key !== undefined) mounted.set(key, node);
  }
  for (let index = stops.length - 1; index >= 0; index -= 1) {
    const rowElement = mounted.get(stops[index]!.rowKey);
    // Unmounted rows (progressive mounting above the visible batch) don't
    // resolve and are skipped.
    if (!rowElement) continue;
    if (rowElement.getBoundingClientRect().top <= line) return index;
  }
  return null;
}

function turnRailTooltip(stop: TurnRailStop, index: number, total: number): string {
  const excerpt =
    stop.excerpt.length > TOOLTIP_LIMIT
      ? `${stop.excerpt.slice(0, TOOLTIP_LIMIT - 1)}…`
      : stop.excerpt;
  return `#${index + 1}/${total} ${excerpt}`;
}

/**
 * Turn jump rail: one subtle tick per user message, docked to the transcript's
 * right edge. For long conversations (10+ sends) it answers "jump back to the
 * first / the Nth message" in one click — no dialog, no tree view. Hovering a
 * tick opens a custom popup left of the rail showing that turn (speaker line
 * plus the agent's reply); clicking a tick scrolls the turn into view through
 * the transcript-navigation bus (unmounted progressive rows mount first). The
 * active tick tracks the turn the reader is in. Hidden below two turns, where
 * scrolling is already fast enough.
 *
 * The rail never grows past its budget (half the window / the chat area): once
 * turns outgrow it the pitch shrinks and every turn stays on screen and
 * clickable, so a 200-turn chat does not push the first and last turns off the
 * window where they cannot be hovered at all.
 */
export function TurnJumpRail({
  stops,
  onJump,
  viewport,
}: {
  stops: TurnRailStop[];
  onJump: (sourceId: string) => void;
  /** The transcript scrollport — locates row nodes and tracks scrolling. */
  viewport: RefObject<HTMLElement | null>;
}) {
  const t = useT();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [budget, setBudget] = useState(() => railBudget(null));
  const lastHoveredRef = useRef<number | null>(null);
  const railRef = useRef<HTMLDivElement>(null);

  // Track the last hovered item even when pointer moves to gaps
  useEffect(() => {
    if (hovered !== null) {
      lastHoveredRef.current = hovered;
    }
  }, [hovered]);

  // Dismiss the popup on Escape or a pointerdown outside the rail.
  useEffect(() => {
    if (hovered === null) return;
    const onPointerDown = (event: PointerEvent) => {
      // If clicking on the rail itself, let the button handle it
      if (railRef.current?.contains(event.target as Node)) return;
      // Otherwise, jump to the hovered item and dismiss
      onJump(stops[hovered]!.sourceId);
      setHovered(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setHovered(null);
    };
    window.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [hovered, onJump, stops]);

  // Measure the rail's height budget against the live chat area (window
  // resizes change both halves of the min()).
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const update = () => setBudget(railBudget(element));
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [viewport]);

  // Center the rail inside the gutter between the scrollport's content edge
  // and the native scrollbar, measured at runtime: scrollbar width differs by
  // platform (Windows ~17px, macOS overlay 0px) and the content gutter is the
  // scrollport's computed padding-right. Both side gaps end up equal.
  const [right, setRight] = useState<number | null>(null);
  useEffect(() => {
    const element = viewport.current;
    const rail = railRef.current;
    if (!element || !rail) return;
    const update = () => {
      const scrollbar = element.offsetWidth - element.clientWidth;
      const padding = parseFloat(getComputedStyle(element).paddingRight) || 0;
      setRight(scrollbar + Math.max(6, (padding - rail.offsetWidth) / 2));
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [viewport, stops]);

  // The last user turn whose row top sits above the viewport's active line is
  // "where the reader is". Unmounted rows (progressive mounting above the
  // visible batch) simply don't resolve and are skipped.
  useEffect(() => {
    const element = viewport.current;
    if (!element || stops.length === 0) {
      setActiveIndex(null);
      return;
    }
    let raf = 0;
    const measure = () => {
      setActiveIndex(activeStopIndex(stops, element));
    };
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    measure();
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      element.removeEventListener("scroll", onScroll);
    };
  }, [viewport, stops]);

  // Alt+↑/↓ moves between user message turns — the keyboard twin of the rail.
  // Bound while the rail is meaningful (2+ turns) and works with the composer
  // focused, the common state after a burst of sends.
  useEffect(() => {
    if (stops.length < 2) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      const element = viewport.current;
      const base = (element ? activeStopIndex(stops, element) : null) ?? -1;
      const anchor = base < 0 ? 0 : base;
      const next =
        event.key === "ArrowUp" ? Math.max(0, anchor - 1) : Math.min(stops.length - 1, anchor + 1);
      onJump(stops[next]!.sourceId);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [stops, onJump, viewport]);

  if (stops.length < 2) return null;

  const total = stops.length;
  // Compress the pitch once the turns outgrow the budget. Ticks tile the track
  // exactly (no gaps, no negative margins), so every turn keeps a real hit
  // area and the whole rail stays inside the window.
  const pitch = Math.min(PITCH_MAX, budget / total);
  const railHeight = pitch * total;
  const tickThickness = Math.max(1, Math.min(2, pitch - 1));
  const hoveredCenter = hovered === null ? 0 : hovered * pitch + pitch / 2;
  return (
    <div
      ref={railRef}
      role="navigation"
      aria-label={t("turnRailLabel")}
      data-turn-rail
      style={right !== null ? { right } : undefined}
      // right-5 fallback clears the native scrollbar (~17px on Windows) until
      // the measured centering offset lands.
      className="absolute right-5 top-1/2 z-10 flex -translate-y-1/2"
    >
      <div
        data-turn-rail-track
        className="relative w-7"
        style={{ height: railHeight }}
        onPointerMove={(event) => {
          // Ticks tile the track and own their hover; this only catches the
          // sub-pixel seams between them (and avoids recomputing the hovered
          // index while the pointer is over the popup, which would make the
          // popup chase the cursor).
          if (event.target !== event.currentTarget) return;
          const box = event.currentTarget.getBoundingClientRect();
          const offset = event.clientY - box.top;
          const index = Math.floor(offset / pitch);
          setHovered(Math.min(total - 1, Math.max(0, index)));
        }}
        onPointerLeave={() => {
          setHovered(null);
          lastHoveredRef.current = null;
        }}
        onClick={() => {
          // If clicking anywhere, use the last hovered item
          if (lastHoveredRef.current !== null) {
            onJump(stops[lastHoveredRef.current]!.sourceId);
            setHovered(null);
            lastHoveredRef.current = null;
          }
        }}
      >
        {hovered !== null && (
          <div
            data-turn-rail-popup
            className="theme-floating-surface absolute right-full z-20 mr-2 w-80 -translate-y-1/2 rounded-lg border border-border bg-surface-raised p-3 shadow-xl"
            style={{ top: hoveredCenter }}
          >
            {/* User message with # prefix */}
            <div className="mb-2 text-sm leading-relaxed text-foreground">
              <div className="line-clamp-1">
                <span className="font-medium">#{hovered + 1}</span>{" "}
                {stops[hovered]?.excerpt || "(empty message)"}
              </div>
            </div>
            {/* Agent response */}
            <div className="text-sm leading-relaxed text-muted">
              {stops[hovered]?.agentPending ? (
                <div className="flex items-center gap-2">
                  <svg
                    className="size-3 animate-spin text-accent"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                  <span className="text-xs">处理中...</span>
                </div>
              ) : (
                <div className="line-clamp-3">{stops[hovered]?.agentExcerpt || "无回复"}</div>
              )}
            </div>
          </div>
        )}
        {stops.map((stop, index) => {
          const tooltip = turnRailTooltip(stop, index, total);
          const active = index === activeIndex;
          const isHovered = index === hovered;

          // When hovering, focus effect follows mouse; otherwise show active
          const shouldHighlight = hovered !== null ? isHovered : active;

          // Calculate mountain peak effect: only on hover, not on active
          let lineWidth = 8; // default: shortest (8px)
          if (isHovered) {
            lineWidth = 28; // hovered: longest (28px)
          } else if (hovered !== null) {
            const distance = Math.abs(index - hovered);
            if (distance === 1)
              lineWidth = 20; // adjacent: medium (20px)
            else if (distance === 2) lineWidth = 14; // near: short (14px)
          }

          return (
            <button
              key={stop.sourceId}
              type="button"
              aria-label={tooltip}
              data-turn-rail-index={index}
              data-active={active ? "true" : undefined}
              className="absolute right-0 flex w-full items-center justify-end"
              style={{ top: index * pitch, height: pitch }}
              onPointerEnter={() => setHovered(index)}
              onFocus={() => setHovered(index)}
              onBlur={() => setHovered((current) => (current === index ? null : current))}
              onClick={(e) => {
                e.stopPropagation();
                setHovered(null);
                onJump(stop.sourceId);
              }}
            >
              <span
                className={`absolute right-0 rounded-full transition-all duration-200 ${
                  shouldHighlight
                    ? "bg-accent" // highlight follows hover, or shows active when not hovering
                    : "bg-border/60"
                }`}
                style={{
                  width: shouldHighlight && !isHovered ? 8 : lineWidth,
                  height: tickThickness,
                }}
              />
              <span className="sr-only">{tooltip}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** One transcript row as far as the rail cares — structural, so tests can fake it. */
export type TurnRailRow = {
  role: string;
  key: string;
  sourceId?: string;
  copyText: string;
  status?: string;
  blocks?: readonly { kind: string }[];
};

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .find((candidate) => candidate.trim().length > 0)
      ?.trim() ?? ""
  );
}

/**
 * Extract rail stops (user message turns) from transcript rows, in order.
 *
 * 摘要一律取「用户自己说的话」：`[pixie|ui]` 标记行、`<pixie-context>` 前导、
 * 委派回执信封都先剥掉（否则小精灵的第一条消息在轨道上显示成 `[pixie|ui]`）。
 * 只有委派回执、没有用户可见内容的消息不占跳转位——轨道是「跳到我说过的话」，
 * 不是系统事件列表。
 */
export function turnRailStops(
  rows: readonly TurnRailRow[],
  options?: { attachmentLabel?: string },
): TurnRailStop[] {
  const stops: TurnRailStop[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.role !== "user" || !row.sourceId) continue;

    // 先剥注入块再取第一行；纯回执行（callbacks）不当跳转目标。
    const parsed = parseUserAttachments(row.copyText);
    const references = parsed.references.filter((reference) => reference.kind !== "pixie-callback");
    const userLine =
      firstLine(parsed.text) ||
      parsed.files[0]?.name ||
      parsed.documents[0]?.name ||
      references[0]?.title ||
      (row.blocks?.some((block) => block.kind === "image") ? (options?.attachmentLabel ?? "") : "");
    if (!userLine) continue;

    // Find the next assistant message(s) to extract agent response
    let agentExcerpt = "";
    let agentPending = false;
    const agentLines: string[] = [];

    for (let j = i + 1; j < rows.length && j < i + 10; j++) {
      const nextRow = rows[j]!;
      if (nextRow.role === "user") break; // Stop at next user message
      if (nextRow.role === "assistant") {
        // Check if agent is still processing
        if (nextRow.status === "pending" || nextRow.status === "streaming") {
          agentPending = true;
          break;
        }
        // Collect first few non-empty lines
        const lines = nextRow.copyText.split("\n").filter((line) => line.trim().length > 0);
        agentLines.push(...lines.slice(0, 4 - agentLines.length));
        if (agentLines.length >= 4) break;
      }
    }

    agentExcerpt = agentLines.join("\n").trim();

    stops.push({
      sourceId: row.sourceId,
      rowKey: row.key,
      excerpt: userLine,
      agentExcerpt: agentExcerpt || undefined,
      agentPending,
    });
  }
  return stops;
}
