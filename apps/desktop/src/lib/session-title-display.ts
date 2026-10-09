/**
 * Display-only clamp for session titles. The host-side generation budget is
 * emoji + separator + up to 15 text characters (`MAX_SESSION_TITLE_LENGTH =
 * 18` in pi-host/src/session-title.ts); this display cap is intentionally a
 * bit larger so titles keep their information while staying one-line friendly
 * in the sidebar, whose rows are much narrower than the top bar.
 * Titles generated before the caps existed can still be longer on disk, so
 * render sites trim them to match; tooltips keep the untruncated text.
 */
const MAX_SESSION_TITLE_DISPLAY_LENGTH = 22;

export function clampSessionTitleForDisplay(value: string): string {
  const chars = Array.from(value);
  if (chars.length <= MAX_SESSION_TITLE_DISPLAY_LENGTH) return value;
  return `${chars.slice(0, MAX_SESSION_TITLE_DISPLAY_LENGTH - 1).join("")}…`;
}
