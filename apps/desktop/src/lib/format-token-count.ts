const compactNumber = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  minimumFractionDigits: 0,
});

export function formatTokenCount(tokens: number): string {
  const absolute = Math.abs(tokens);
  if (absolute >= 1_000_000) {
    return `${compactNumber.format(tokens / 1_000_000)}M`;
  }
  if (absolute >= 1_000) {
    const formatted = compactNumber.format(tokens / 1_000);
    return formatted === "1,000" ? "1M" : `${formatted}k`;
  }
  return tokens.toLocaleString("en-US");
}

/** Parse a token count from raw input, accepting plain numbers ("200000"),
 * thousands ("127K") and millions ("1.05M") suffixes, case-insensitive.
 * Returns null when the input is not a positive token count. */
export function parseTokenCount(raw: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(k|m)?\s*$/i.exec(raw);
  if (!match) return null;
  const magnitude = Number(match[1]);
  if (!Number.isFinite(magnitude)) return null;
  const unit = match[2]?.toLowerCase();
  const scale = unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1;
  const tokens = Math.round(magnitude * scale);
  if (!Number.isSafeInteger(tokens) || tokens < 1) return null;
  return tokens;
}

/** Lossless compact form for editable token inputs: "1M", "1.05M", "128k",
 * "131072". Unlike formatTokenCount the result always parses back to the
 * exact same value. */
export function formatTokenCountExact(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    if (Number.isInteger(millions)) return `${millions}M`;
    const text = millions.toFixed(2).replace(/\.?0+$/, "");
    if (Math.round(Number(text) * 1_000_000) === tokens) return `${text}M`;
  }
  if (tokens % 1_000 === 0) return `${tokens / 1_000}k`;
  return String(tokens);
}
