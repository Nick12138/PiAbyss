/** Minimal HSV ↔ hex conversions for the circular accent color picker.
 *
 *  Hue is kept in CSS-conic degrees (0° = red at the top, increasing
 *  clockwise), which maps directly onto a `conic-gradient` hue ring.
 *  Saturation and value are 0–1. */

export type Hsv = { h: number; s: number; v: number };

const HUE_PRESETS: ReadonlyArray<{ angle: number; hex: [number, number, number] }> = [
  { angle: 0, hex: [255, 0, 0] }, // red
  { angle: 60, hex: [255, 255, 0] }, // yellow
  { angle: 120, hex: [0, 255, 0] }, // lime
  { angle: 180, hex: [0, 255, 255] }, // cyan
  { angle: 240, hex: [0, 0, 255] }, // blue
  { angle: 300, hex: [255, 0, 255] }, // magenta
];

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function channelToHex(value: number): string {
  return Math.round(clamp01(value) * 255)
    .toString(16)
    .padStart(2, "0");
}

/** Converts an HSV triple to a canonical lowercase `#rrggbb` string. */
export function hsvToHex({ h, s, v }: Hsv): string {
  const hue = ((h % 360) + 360) % 360;
  const saturation = clamp01(s);
  const value = clamp01(v);
  const sector = Math.floor(hue / 60) % 6;
  const fraction = (hue % 60) / 60;
  const [startR, startG, startB] = HUE_PRESETS[sector].hex;
  const [endR, endG, endB] = HUE_PRESETS[(sector + 1) % 6].hex;
  const r = (startR + (endR - startR) * fraction) * value;
  const g = (startG + (endG - startG) * fraction) * value;
  const b = (startB + (endB - startB) * fraction) * value;
  // Desaturate toward the value-scaled gray, exactly like CSS hsl().
  const mix = (channel: number) => channel + (value - channel) * (1 - saturation);
  return `#${channelToHex(mix(r / 255))}${channelToHex(mix(g / 255))}${channelToHex(mix(b / 255))}`;
}

/** Converts a `#rrggbb` string to HSV. Grayscale inputs keep hue 0 so the
 *  ring handle lands somewhere predictable. */
export function hexToHsv(hex: string): Hsv {
  const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h: number;
  if (delta === 0) {
    h = 0;
  } else if (max === r) {
    h = ((g - b) / delta) % 6;
  } else if (max === g) {
    h = (b - r) / delta + 2;
  } else {
    h = (r - g) / delta + 4;
  }
  h *= 60;
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : delta / max, v: max };
}
