/**
 * File access to the my-pi-plugins pi-subagent run store
 * (`~/.pi/subagent/runs/<runId>/`).
 *
 * The plugin persists every run as task.json / status.json / result.json plus a
 * live `sessions/*.jsonl` pi session transcript (and events.jsonl for the raw
 * event stream). The PiAbyss panel needs the persisted session transcript to
 * render the expanded conversation, so this module reads it directly from
 * disk while status/control goes through the plugin's HTTP API.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { JsonValue, SerializableSessionEntry, SubagentStatusState } from "@piabyss/protocol";

const MAX_ENTRIES = 160;
const MAX_STRING_LENGTH = 64_000;
const MAX_TOTAL_TEXT = 240_000;
const MAX_TASK_TEXT = 24_000;
const MAX_OBJECT_KEYS = 96;
const MAX_ARRAY_ITEMS = 96;

type SubagentRunTranscript = {
  sessionId: string;
  name?: string;
  entries: SerializableSessionEntry[];
  truncated: boolean;
  updatedAt: number;
};

export function subagentRunsRoot(): string {
  return join(homedir(), ".pi", "subagent", "runs");
}

function subagentRunDir(runId: string): string {
  return join(subagentRunsRoot(), runId);
}

function subagentRunSessionsDir(runId: string): string {
  return join(subagentRunDir(runId), "sessions");
}

/** The panel nodes are keyed by the plugin's run id directly; tolerate the
 * legacy `external:<sessionId>:<runId>` node id shape too. */
export function resolveSubagentRunId(nodeId: string): string {
  const normalized = nodeId.trim();
  if (normalized.startsWith("external:")) {
    return normalized.split(":").filter(Boolean).at(-1) ?? normalized;
  }
  return normalized;
}

export function subagentRunExists(runId: string): boolean {
  try {
    return statSync(join(subagentRunDir(runId), "task.json")).isFile();
  } catch {
    return false;
  }
}

/** Read the run's task title (used as the transcript display name). */
export function readSubagentRunTitle(runId: string): string | undefined {
  try {
    const task = JSON.parse(readFileSync(join(subagentRunDir(runId), "task.json"), "utf8")) as {
      title?: unknown;
    };
    return typeof task.title === "string" && task.title.trim() ? task.title.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Read the run's live status (status.json) when it is not on the wire yet. */
export function readSubagentRunStatus(runId: string): string | undefined {
  try {
    const status = JSON.parse(readFileSync(join(subagentRunDir(runId), "status.json"), "utf8")) as {
      status?: unknown;
    };
    return typeof status.status === "string" ? status.status : undefined;
  } catch {
    return undefined;
  }
}

/** Map a my-pi-plugins pi-subagent run status to the panel's status states. */
export function mapSubagentRunState(status: string | undefined): SubagentStatusState {
  switch (status) {
    case "pending":
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "paused":
      return "paused";
    case "completed":
      return "complete";
    case "failed":
      return "failed";
    case "stopped":
    case "interrupted":
      return "stopped";
    default:
      // Unknown/absent status: assume alive; the next status poll corrects it.
      return "running";
  }
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 8) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every((item) => isJsonValue(item, depth + 1))
  );
}

/** Strip acceptance-report fences so they never reach the desktop transcript. */
function hideAcceptanceReports(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/```acceptance-report\s*[\s\S]*?```/gi, "");
  }
  if (Array.isArray(value)) return value.map(hideAcceptanceReports);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, hideAcceptanceReports(item)]),
    );
  }
  return value;
}

function boundedJson(value: unknown, budget: { value: number }, depth = 0): JsonValue | undefined {
  if (budget.value <= 0 || depth > 8) return undefined;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const text = value.slice(0, Math.min(MAX_STRING_LENGTH, budget.value));
    budget.value -= text.length;
    return text.length < value.length ? `${text}…` : text;
  }
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const item of value.slice(0, MAX_ARRAY_ITEMS)) {
      const next = boundedJson(item, budget, depth + 1);
      if (next !== undefined) result.push(next);
      if (budget.value <= 0) break;
    }
    return result;
  }
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
      const next = boundedJson(item, budget, depth + 1);
      if (next !== undefined) result[key.slice(0, 256)] = next;
      if (budget.value <= 0) break;
    }
    return result;
  }
  return undefined;
}

/** 清理 pi 的 @file 注入标记（`<file name="...">…</file>` 成对标签），它会在子代理
 * 会话里作为第一条 user 消息出现，面板显示时不该暴露这个工具细节。 */
function stripFileMarkers(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/<file name="[^"]*">\s*|\s*<\/file>/gi, "");
  }
  if (Array.isArray(value)) return value.map(stripFileMarkers);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, stripFileMarkers(item)]),
    );
  }
  return value;
}

/**
 * Read the live pi session transcript for a run. The child pi process is
 * launched with `--session-id sub-<runId> --session-dir <runs>/<runId>/sessions`,
 * so the newest `*.jsonl` there is the run's own conversation (it grows while
 * the run is running). Returns null when no session file exists yet.
 */
export function readSubagentRunTranscript(runId: string): SubagentRunTranscript | null {
  const sessionsDir = subagentRunSessionsDir(runId);
  let files: string[];
  try {
    files = readdirSync(sessionsDir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => join(sessionsDir, name));
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  files.sort((left, right) => {
    try {
      return statSync(right).mtimeMs - statSync(left).mtimeMs;
    } catch {
      return 0;
    }
  });

  const path = files[0];
  if (!path) return null;
  let lines: string[];
  try {
    lines = readFileSync(path, "utf8").split(/\r?\n/);
  } catch {
    return null;
  }

  // Session metadata lives in the header block at the start of the file and
  // must survive even when the tail window below excludes the first lines.
  let sessionId = `sub-${runId}`;
  let name: string | undefined;
  for (const line of lines) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      break;
    }
    if (!raw || typeof raw !== "object") break;
    const record = raw as Record<string, unknown>;
    if (record.type !== "session") break;
    if (typeof record.id === "string" && record.id) sessionId = record.id;
    if (typeof record.name === "string" && record.name) name = record.name;
  }

  // Keep the TAIL of the conversation: the panel renders the most recent
  // entries (including the run's final answer), and the desktop's "earlier
  // content omitted" hint assumes the tail is kept. Walk backwards and stop
  // once the raw size of the window reaches MAX_TOTAL_TEXT or MAX_ENTRIES
  // entries are collected. Raw line length is an upper bound on the bounded
  // pass below (string truncation only shrinks values), so the budget can
  // never exhaust mid-window and drop the newest entries again.
  //
  // The start is also snapped to a turn boundary: a window beginning on a
  // toolResult would render its assistant tool call as an orphan turn with
  // a misleading aborted-trace label, so the start moves forward to the
  // next user/assistant entry.
  const isBoundaryRecord = (record: Record<string, unknown>): boolean => {
    if (record.type !== "message") return false;
    const message = record.message as Record<string, unknown> | undefined;
    return (
      !!message &&
      (message.role === "user" ||
        message.role === "assistant" ||
        message.role === "bashExecution")
    );
  };

  const windowStartIndex = (() => {
    let keptEntries = 0;
    let rawChars = 0;
    let index = lines.length;
    while (index > 0) {
      index -= 1;
      const line = lines[index];
      if (!line || !line.trim()) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        continue;
      }
      if (!raw || typeof raw !== "object") continue;
      const record = raw as Record<string, unknown>;
      if (typeof record.id !== "string" || typeof record.type !== "string") continue;
      if (record.type === "session") continue;
      // Always include at least the newest entry, even if it alone exceeds
      // the budget; the bounded pass trims it.
      if (keptEntries > 0 && (keptEntries >= MAX_ENTRIES || rawChars + line.length > MAX_TOTAL_TEXT)) {
        return index + 1;
      }
      keptEntries += 1;
      rawChars += line.length;
    }
    return 0;
  })();

  // Snap the raw window start forward to the first turn-boundary entry so
  // the window never opens with an orphan toolResult.
  let snappedStart = windowStartIndex;
  while (snappedStart < lines.length) {
    const line = lines[snappedStart];
    if (line && line.trim()) {
      try {
        const raw = JSON.parse(line) as Record<string, unknown>;
        if (
          !raw ||
          typeof raw !== "object" ||
          typeof raw.id !== "string" ||
          typeof raw.type !== "string" ||
          raw.type === "session" ||
          isBoundaryRecord(raw)
        ) {
          break;
        }
      } catch {
        break;
      }
    }
    snappedStart += 1;
  }

  const entries: SerializableSessionEntry[] = [];
  const budget = { value: MAX_TOTAL_TEXT };
  let truncated = snappedStart > 0;
  for (let index = snappedStart; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || !line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      truncated = true;
      continue;
    }
    if (!raw || typeof raw !== "object") continue;
    const record = hideAcceptanceReports(stripFileMarkers(raw)) as Record<string, unknown>;
    if (record.type === "session") continue;
    if (typeof record.id !== "string" || typeof record.type !== "string") continue;
    const bounded = boundedJson(record, budget);
    if (
      !bounded ||
      !isJsonValue(bounded) ||
      typeof bounded !== "object" ||
      Array.isArray(bounded)
    ) {
      truncated = true;
      continue;
    }
    entries.push(bounded as SerializableSessionEntry);
    if (budget.value <= 0) {
      truncated = true;
      break;
    }
  }
  // The panel's collapsed view (task → folded process → final answer) needs
  // the run's first user message. Large transcripts truncate it away, so
  // prepend it (with its own small budget) when the tail window lacks one.
  if (!entries.some((entry) => {
    const message = (entry as { message?: { role?: unknown } }).message;
    return message?.role === "user";
  })) {
    for (const line of lines) {
      if (!line.trim()) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        continue;
      }
      if (!raw || typeof raw !== "object") continue;
      const record = hideAcceptanceReports(stripFileMarkers(raw)) as Record<string, unknown>;
      if (record.type !== "message") continue;
      const message = record.message as Record<string, unknown> | undefined;
      if (message?.role !== "user") continue;
      const taskBudget = { value: MAX_TASK_TEXT };
      const bounded = boundedJson(record, taskBudget);
      if (bounded && isJsonValue(bounded) && typeof bounded === "object" && !Array.isArray(bounded)) {
        entries.unshift(bounded as SerializableSessionEntry);
      }
      break;
    }
  }
  const updatedAt = (() => {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return Date.now();
    }
  })();
  return {
    sessionId,
    ...(name ? { name } : {}),
    entries,
    truncated,
    updatedAt,
  };
}
