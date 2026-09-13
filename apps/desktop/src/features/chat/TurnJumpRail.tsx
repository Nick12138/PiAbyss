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
};

/** Viewport-clamped tooltip text budget (characters). */
const TOOLTIP_LIMIT = 96;

/** Popup row excerpt budget before CSS truncation takes over. */
const POPUP_EXCERPT_LIMIT = 240;

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
  const railRef = useRef<HTMLDivElement>(null);
  const hoveredRowRef = useRef<HTMLButtonElement | null>(null);

  // Dismiss the popup on Escape or a pointerdown outside the rail.
  useEffect(() => {
    if (hovered === null) return;
    const onPointerDown = (event: PointerEvent) => {
      if (railRef.current?.contains(event.target as Node)) return;
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
  }, [hovered]);

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
        event.key === "ArrowUp"
          ? Math.max(0, anchor - 1)
          : Math.min(stops.length - 1, anchor + 1);
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
      className="absolute right-5 top-1/2 z-10 flex -translate-y-1/2 rounded-full p-1.5 transition-colors hover:bg-surface-overlay/40"
    >
      <div className="flex max-h-[50vh] flex-col items-center justify-center gap-2">
        {hovered !== null && (
          <div
            data-turn-rail-popup
            className="theme-floating-surface absolute right-full top-1/2 z-20 mr-1.5 max-h-[60vh] w-64 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-surface-raised py-1 shadow-xl"
          >
            {stops.map((stop, index) => {
              const excerpt =
                stop.excerpt.length > POPUP_EXCERPT_LIMIT
                  ? `${stop.excerpt.slice(0, POPUP_EXCERPT_LIMIT - 1)}…`
                  : stop.excerpt;
              const isHovered = index === hovered;
              const isReading = index === activeIndex;
              return (
                <button
                  key={stop.sourceId}
                  type="button"
                  ref={isHovered ? hoveredRowRef : undefined}
                  aria-label={turnRailTooltip(stop, index, total)}
                  data-hovered={isHovered ? "true" : undefined}
                  className={`relative flex w-full items-baseline gap-1 px-3 py-1.5 text-left text-xs transition-colors ${
                    isHovered
                      ? "bg-accent/15 text-accent"
                      : "text-muted hover:bg-surface-overlay hover:text-foreground"
                  }`}
                  onPointerEnter={() => setHovered(index)}
                  onClick={() => {
                    setHovered(null);
                    onJump(stop.sourceId);
                  }}
                >
                  {/* The reading mark lives in the reserved left inset and is
                      absolutely positioned, so it never shifts the numbers:
                      every row indents its index uniformly. */}
                  {isReading && (
                    <span
                      className="absolute left-[9px] top-1/2 size-1.5 -translate-y-1/2 rounded-full bg-accent/60"
                      aria-label={t("turnRailReadingMark")}
                    />
                  )}
                  <span className="ml-3 shrink-0 text-[10px] tabular-nums opacity-70">
                    #{index + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {excerpt || "(empty message)"}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {stops.map((stop, index) => {
          const tooltip = turnRailTooltip(stop, index, total);
          const active = index === activeIndex;
          const isHovered = index === hovered;
          return (
            <button
              key={stop.sourceId}
              type="button"
              aria-label={tooltip}
              data-active={active ? "true" : undefined}
              className={`size-2.5 shrink-0 rounded-full border transition-colors ${
                active || isHovered
                  ? "border-accent/70 bg-accent/40"
                  : "border-border bg-transparent hover:border-accent/50 hover:bg-accent/20"
              }`}
              onPointerEnter={() => setHovered(index)}
              onFocus={() => setHovered(index)}
              onBlur={() => setHovered((current) => (current === index ? null : current))}
              onClick={() => {
                setHovered(null);
                onJump(stop.sourceId);
              }}
            >
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
  rows: readonly { role: string; key: string; sourceId?: string; copyText: string }[],
): TurnRailStop[] {
  const stops: TurnRailStop[] = [];
  for (const row of rows) {
    if (row.role !== "user" || !row.sourceId) continue;
    const line = row.copyText.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
    stops.push({ sourceId: row.sourceId, rowKey: row.key, excerpt: line.trim() });
  }
  return stops;
}
