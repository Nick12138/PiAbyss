import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { useT } from "../../lib/i18n/use-t";

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

/** The last user turn whose row top sits above the viewport's active line. */
function activeStopIndex(stops: TurnRailStop[], element: HTMLElement): number | null {
  const scrollerRect = element.getBoundingClientRect();
  const line = scrollerRect.top + scrollerRect.height * ACTIVE_LINE;
  let best: number | null = null;
  for (let index = 0; index < stops.length; index += 1) {
    const rowElement = element.querySelector<HTMLElement>(
      `[data-row-key="${CSS.escape(stops[index]!.rowKey)}"]`,
    );
    if (!rowElement) continue;
    if (rowElement.getBoundingClientRect().top <= line) best = index;
  }
  return best;
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
 * tick opens a custom popup left of the rail listing every turn (the hovered
 * one highlighted, the reading position marked); clicking a popup row — or the
 * tick itself — scrolls that turn into view through the transcript-navigation
 * bus (unmounted progressive rows mount first). The active tick tracks the
 * turn the reader is in. Hidden below two turns, where scrolling is already
 * fast enough.
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
  const lastHoveredRef = useRef<number | null>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const hoveredRowRef = useRef<HTMLButtonElement | null>(null);

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

  // Keep the hovered popup row in view when the list is taller than the clamp.
  useEffect(() => {
    hoveredRowRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [hovered]);

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
        ref={hoveredRowRef as any}
        className="flex max-h-[50vh] w-7 flex-col items-end justify-center gap-2"
        onPointerMove={(e) => {
          // Find the closest button element
          const buttons = e.currentTarget.querySelectorAll('button');
          let closestIndex = -1;
          let minDistance = Infinity;
          
          buttons.forEach((btn, index) => {
            const rect = btn.getBoundingClientRect();
            const centerY = rect.top + rect.height / 2;
            const distance = Math.abs(e.clientY - centerY);
            if (distance < minDistance) {
              minDistance = distance;
              closestIndex = index;
            }
          });
          
          if (closestIndex >= 0 && closestIndex < stops.length) {
            setHovered(closestIndex);
          }
        }}
        onPointerLeave={() => {
          setHovered(null);
          lastHoveredRef.current = null;
        }}
        onClick={(e) => {
          // If clicking anywhere, use the last hovered item
          if (lastHoveredRef.current !== null) {
            onJump(stops[lastHoveredRef.current]!.sourceId);
            setHovered(null);
            lastHoveredRef.current = null;
          }
        }}
      >
        {lastHoveredRef.current !== null && (
          <div
            data-turn-rail-popup
            className="theme-floating-surface absolute right-full top-0 z-20 mr-2 w-80 rounded-lg border border-border bg-surface-raised p-3 shadow-xl"
            style={{
              transform: `translateY(${lastHoveredRef.current * 16 - 8}px)`,
            }}
          >
            {/* User message with # prefix */}
            <div className="mb-2 text-sm leading-relaxed text-foreground">
              <div className="line-clamp-1">
                <span className="font-medium">#{lastHoveredRef.current + 1}</span>{" "}
                {stops[lastHoveredRef.current]?.excerpt || "(empty message)"}
              </div>
            </div>
            {/* Agent response */}
            <div className="text-sm leading-relaxed text-muted">
              {stops[lastHoveredRef.current]?.agentPending ? (
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
                <div className="line-clamp-3">{stops[lastHoveredRef.current]?.agentExcerpt || "无回复"}</div>
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
              data-active={active ? "true" : undefined}
              className="relative h-2 w-full shrink-0 flex items-center -my-0.5"
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
                className={`absolute right-0 h-0.5 rounded-full transition-all duration-200 ${
                  shouldHighlight
                    ? "bg-accent" // highlight follows hover, or shows active when not hovering
                    : "bg-border/60 group-hover:bg-accent/60"
                }`}
                style={{ width: shouldHighlight && !isHovered ? 8 : lineWidth }}
              />
              <span className="sr-only">{tooltip}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Extract rail stops (user message turns) from transcript rows, in order. */
export function turnRailStops(
  rows: readonly {
    role: string;
    key: string;
    sourceId?: string;
    copyText: string;
    status?: string;
  }[],
): TurnRailStop[] {
  const stops: TurnRailStop[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.role !== "user" || !row.sourceId) continue;

    // Extract user message excerpt
    const userLine =
      row.copyText.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";

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
      excerpt: userLine.trim(),
      agentExcerpt: agentExcerpt || undefined,
      agentPending,
    });
  }
  return stops;
}
