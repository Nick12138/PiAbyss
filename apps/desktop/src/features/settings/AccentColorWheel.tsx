import { useEffect, useRef, useState } from "react";
import { hexToHsv, hsvToHex, type Hsv } from "../../lib/hsv";

/** Fixed geometry of the circular picker (px). */
const SIZE = 160;
const CENTER = SIZE / 2;
const RING_THICKNESS = 12;
const OUTER_RADIUS = CENTER;
const HUE_HANDLE_RADIUS = OUTER_RADIUS - RING_THICKNESS / 2;
const INNER_RADIUS = OUTER_RADIUS - RING_THICKNESS;
/** Saturation/value square inscribed in the inner circle. */
const TONE_SIDE = INNER_RADIUS * Math.SQRT2;
const TONE_TOP = CENTER - TONE_SIDE / 2;
const TONE_LEFT = TONE_TOP;

const HUE_KEY_STEP = 2;
const HUE_KEY_STEP_COARSE = 15;
const TONE_KEY_STEP = 0.02;
const TONE_KEY_STEP_COARSE = 0.1;

type DragRegion = "hue" | "tone";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/** Circular accent color picker: a draggable hue ring around a draggable
 *  saturation/brightness square. Pointer drags report every intermediate
 *  color with phase "drag" (live preview); releasing reports "commit"
 *  (persist). Keyboard handles adjust in fine steps and commit directly. */
export function AccentColorWheel({
  value,
  hueLabel,
  toneLabel,
  onChange,
}: {
  /** Canonical `#rrggbb` currently shown (applied or previewed). */
  value: string;
  hueLabel: string;
  toneLabel: string;
  onChange: (hex: string, phase: "drag" | "commit") => void;
}) {
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value));
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef<DragRegion | null>(null);
  // Mirror of `hsv` for pointer handlers: rapid pointermove events can fire
  // before a re-render, so closures must not rely on the state value.
  const hsvRef = useRef<Hsv>(hsv);

  // Follow external value changes (palette clicks, hex entry, resets) while
  // idle. Grays lose their hue in hex form, so the previous hue is kept to
  // avoid the ring handle jumping while dragging toward black/white.
  useEffect(() => {
    if (draggingRef.current) return;
    setHsv((previous) => {
      if (hsvToHex(previous) === value) return previous;
      const next = hexToHsv(value);
      return next.s === 0 && previous.s !== 0 ? { ...next, h: previous.h } : next;
    });
  }, [value]);

  function emit(next: Hsv, phase: "drag" | "commit") {
    hsvRef.current = next;
    setHsv(next);
    onChange(hsvToHex(next), phase);
  }

  /** Converts a pointer position into wheel-local coordinates (0..SIZE). */
  function toLocalPoint(event: React.PointerEvent): { x: number; y: number } {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return { x: CENTER, y: CENTER };
    return {
      x: ((event.clientX - rect.left) / rect.width) * SIZE,
      y: ((event.clientY - rect.top) / rect.height) * SIZE,
    };
  }

  function hsvFromPointer(event: React.PointerEvent): { region: DragRegion; hsv: Hsv } {
    const current = hsvRef.current;
    const { x, y } = toLocalPoint(event);
    const dx = x - CENTER;
    const dy = y - CENTER;
    if (Math.hypot(dx, dy) >= INNER_RADIUS) {
      // Hue ring: angle clockwise from the top, matching conic-gradient.
      const angle = (Math.atan2(dx, -dy) * 180) / Math.PI;
      return { region: "hue", hsv: { h: (angle + 360) % 360, s: current.s, v: current.v } };
    }
    return {
      region: "tone",
      hsv: {
        h: current.h,
        s: clamp01((x - TONE_LEFT) / TONE_SIDE),
        v: clamp01(1 - (y - TONE_TOP) / TONE_SIDE),
      },
    };
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const { region, hsv: next } = hsvFromPointer(event);
    draggingRef.current = region;
    // jsdom (used by the DOM tests) implements neither pointer-capture method.
    const container = containerRef.current;
    if (container && typeof container.setPointerCapture === "function") {
      container.setPointerCapture(event.pointerId);
    }
    emit(next, "drag");
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current || event.buttons === 0) return;
    emit(hsvFromPointer(event).hsv, "drag");
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    const next = hsvFromPointer(event).hsv;
    draggingRef.current = null;
    const container = containerRef.current;
    if (container && typeof container.releasePointerCapture === "function") {
      container.releasePointerCapture(event.pointerId);
    }
    emit(next, "commit");
  }

  function onHueKeyDown(event: React.KeyboardEvent) {
    const step = event.shiftKey ? HUE_KEY_STEP_COARSE : HUE_KEY_STEP;
    const deltas: Record<string, number> = {
      ArrowLeft: -step,
      ArrowDown: -step,
      ArrowRight: step,
      ArrowUp: step,
    };
    let hue: number;
    if (event.key in deltas) hue = hsv.h + deltas[event.key];
    else if (event.key === "Home") hue = 0;
    else if (event.key === "End") hue = 359;
    else return;
    event.preventDefault();
    emit({ ...hsv, h: (hue + 360) % 360 }, "commit");
  }

  function onToneKeyDown(event: React.KeyboardEvent) {
    const step = event.shiftKey ? TONE_KEY_STEP_COARSE : TONE_KEY_STEP;
    const deltas: Record<string, { s: number; v: number }> = {
      ArrowLeft: { s: -step, v: 0 },
      ArrowDown: { s: 0, v: -step },
      ArrowRight: { s: step, v: 0 },
      ArrowUp: { s: 0, v: step },
    };
    const delta = deltas[event.key];
    if (!delta) return;
    event.preventDefault();
    emit(
      { ...hsv, s: clamp01(hsv.s + delta.s), v: clamp01(hsv.v + delta.v) },
      "commit",
    );
  }

  const hueRadians = (hsv.h * Math.PI) / 180;
  const hueHandleStyle = {
    left: CENTER + HUE_HANDLE_RADIUS * Math.sin(hueRadians),
    top: CENTER - HUE_HANDLE_RADIUS * Math.cos(hueRadians),
  };
  const toneHandleStyle = {
    left: TONE_LEFT + hsv.s * TONE_SIDE,
    top: TONE_TOP + (1 - hsv.v) * TONE_SIDE,
  };
  const handleClassName =
    "absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.35),0_1px_3px_rgba(0,0,0,0.4)] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus";

  return (
    <div
      ref={containerRef}
      data-ui="accent-color-wheel"
      className="relative mx-auto touch-none select-none"
      style={{ width: SIZE, height: SIZE }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {/* Hue ring */}
      <div
        className="absolute inset-0 rounded-full"
        style={{
          background:
            "conic-gradient(#ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)",
          mask: `radial-gradient(circle, transparent ${INNER_RADIUS - 1}px, #000 ${INNER_RADIUS}px)`,
          WebkitMask: `radial-gradient(circle, transparent ${INNER_RADIUS - 1}px, #000 ${INNER_RADIUS}px)`,
        }}
        aria-hidden="true"
      />
      {/* Saturation/brightness square inscribed in the ring */}
      <div
        className="absolute rounded-[4px] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.25)]"
        style={{
          left: TONE_LEFT,
          top: TONE_TOP,
          width: TONE_SIDE,
          height: TONE_SIDE,
          backgroundColor: `hsl(${hsv.h} 100% 50%)`,
          backgroundImage:
            "linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, rgba(255,255,255,0))",
        }}
        aria-hidden="true"
      />
      <div
        role="slider"
        tabIndex={0}
        aria-label={hueLabel}
        aria-valuemin={0}
        aria-valuemax={359}
        aria-valuenow={Math.round(hsv.h)}
        aria-valuetext={`${Math.round(hsv.h)}°`}
        data-ui="accent-color-wheel-hue"
        className={handleClassName}
        style={{ ...hueHandleStyle, backgroundColor: `hsl(${hsv.h} 100% 50%)` }}
        onKeyDown={onHueKeyDown}
      />
      <div
        role="slider"
        tabIndex={0}
        aria-label={toneLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(hsv.v * 100)}
        aria-valuetext={`${Math.round(hsv.s * 100)}%, ${Math.round(hsv.v * 100)}%`}
        data-ui="accent-color-wheel-tone"
        className={handleClassName}
        style={{ ...toneHandleStyle, backgroundColor: hsvToHex(hsv) }}
        onKeyDown={onToneKeyDown}
      />
    </div>
  );
}
