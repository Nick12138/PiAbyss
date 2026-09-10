import { tCurrent } from "./i18n/use-t";

const DEFAULT_MAX_LENGTH = 220;

// Not anchored: auto-restart failures arrive as
// "Auto-restart failed: Pi Host exited (...)..." and still deserve the exit code.
const EXIT_PATTERN = /Pi Host exited \(([^)]+)\)/;

// Plain-text markers emitted by V8/the OS right before a hard death. These
// never appear as structured JSON, and a silent crash may produce no
// level:"error" record at all — they are the only real clue then.
const CRASH_MARKER_PATTERN =
  /\bFATAL ERROR\b|\bout of memory\b|\bSegmentation fault\b|\bstack overflow\b|\bcore dumped\b/i;

type StderrRecord = { level?: unknown; message?: unknown; meta?: { error?: unknown } };

function firstSentence(value: string): string {
  const sentenceEnd = value.indexOf(". ");
  return sentenceEnd >= 0 ? value.slice(0, sentenceEnd + 1) : value;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function parseRecord(segment: string): StderrRecord | null {
  if (!segment.startsWith("{")) return null;
  try {
    const record = JSON.parse(segment) as StderrRecord;
    return typeof record === "object" && record !== null ? record : null;
  } catch {
    return null;
  }
}

function recordDetail(record: StderrRecord, fallback: string): string {
  return typeof record.meta?.error === "string"
    ? record.meta.error
    : typeof record.message === "string"
      ? record.message
      : fallback;
}

/**
 * Keeps fatal UI text readable while native stderr remains available in the console.
 *
 * The stderr ring holds the host's whole recent life, so the exit cause is at
 * its END. Candidates are therefore scanned newest-first, preferring structured
 * errors over native crash markers over warn records; plain debug/info records
 * never mask them. If nothing meaningful exists, the newest stderr line wins —
 * never the oldest one.
 */
export function summarizeHostFailure(message: string, maxLength = DEFAULT_MAX_LENGTH): string {
  const exitMatch = message.match(EXIT_PATTERN);
  const prefix = exitMatch
    ? tCurrent("hostFailureExited", { code: exitMatch[1] })
    : tCurrent("hostFailureFailed");
  const stderrMarker = ". stderr: ";
  const stderr = message.includes(stderrMarker)
    ? message.slice(message.indexOf(stderrMarker) + stderrMarker.length)
    : message;
  let errorDetail: string | null = null;
  let crashDetail: string | null = null;
  let warnDetail: string | null = null;
  let plainDetail: string | null = null;
  let newestDetail: string | null = null;
  for (const segment of stderr.split(" | ").reverse()) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    newestDetail ??= trimmed;
    const record = parseRecord(trimmed);
    if (record) {
      const level = typeof record.level === "string" ? record.level : "";
      if (level === "error") {
        errorDetail = recordDetail(record, trimmed);
        break;
      }
      if (level === "warn") warnDetail ??= recordDetail(record, trimmed);
      continue;
    }
    if (CRASH_MARKER_PATTERN.test(trimmed)) crashDetail ??= trimmed;
    else plainDetail ??= trimmed;
  }
  const detail = errorDetail ?? crashDetail ?? warnDetail ?? plainDetail ?? newestDetail ?? stderr;
  return truncate(`${prefix}: ${firstSentence(detail.trim())}`, maxLength);
}
