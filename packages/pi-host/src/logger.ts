/**
 * Structured logging to stderr only — never stdout (protocol channel).
 * A secondary file sink (`PI_HOST_LOG_FILE`, set by the desktop spawner)
 * persists the same redacted JSONL so deferred step timings (workspace graph
 * built / reactivated, retention fingerprints) stay measurable: stderr is a
 * bounded ring buffer in the renderer and never reaches disk.
 */

import { toJsonValue, type JsonValue } from "@piabyss/protocol";
import { appendFileSync, statSync, writeFileSync } from "node:fs";

export type LogLevel = "debug" | "info" | "warn" | "error";

const REDACTED = "[REDACTED]";
const UNSERIALIZABLE = "[UNSERIALIZABLE]";
const SENSITIVE_KEY_SUFFIXES = [
  "apikey",
  "token",
  "tokenhash",
  "authorization",
  "authheader",
  "password",
  "passwordhash",
  "secret",
  "secrethash",
  "credential",
  "credentials",
];
const TOKEN_PREFIX_PATTERN = /(?:sk-|key-)[A-Za-z0-9._\-/+=]{8,}/gi;
const AUTH_SCHEME_PATTERN = /(?:Bearer|Basic)\s+\S+/gi;
const SECRET_ASSIGNMENT_PATTERN =
  /\b(api[_-]?key|token|access[_-]?token|refresh[_-]?token|authorization|auth[_-]?header|password|client[_-]?secret|secret|credential)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi;

function redactText(value: string): string {
  return value
    .replace(TOKEN_PREFIX_PATTERN, REDACTED)
    .replace(AUTH_SCHEME_PATTERN, REDACTED)
    .replace(SECRET_ASSIGNMENT_PATTERN, (_match, label: string) => `${label}=${REDACTED}`);
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return (
    normalized === "auth" || SENSITIVE_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  );
}

function redactJsonValue(value: JsonValue): JsonValue {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactJsonValue);
  if (value && typeof value === "object") {
    const redacted: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      redacted[key] = isSensitiveKey(key) ? REDACTED : redactJsonValue(item);
    }
    return redacted;
  }
  return value;
}

function redactMeta(meta: Record<string, unknown>): JsonValue {
  try {
    return redactJsonValue(toJsonValue(meta));
  } catch {
    return UNSERIALIZABLE;
  }
}

const LOG_FILE_ENV = "PI_HOST_LOG_FILE";
const MAX_LOG_FILE_BYTES = 5 * 1024 * 1024;
/** undefined = not resolved yet; null = no file sink configured. */
let logFilePath: string | null | undefined;

function resolveLogFilePath(): string | null {
  if (logFilePath !== undefined) return logFilePath;
  const configured = process.env[LOG_FILE_ENV];
  logFilePath = typeof configured === "string" && configured.trim() ? configured : null;
  return logFilePath;
}

/**
 * Append the serialized entry to the file sink. Best-effort: file logging
 * must never break the protocol channel or the Host process.
 */
function appendToLogFile(serialized: string): void {
  const path = resolveLogFilePath();
  if (!path) return;
  try {
    try {
      if (statSync(path).size > MAX_LOG_FILE_BYTES) {
        // Simple cap: restart the file instead of growing without bound.
        writeFileSync(path, "", { encoding: "utf8" });
      }
    } catch {
      /* missing file — appendFileSync creates it */
    }
    appendFileSync(path, serialized + "\n", { encoding: "utf8" });
  } catch {
    /* unwritable sink — drop the line silently */
  }
}

export function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const safeMessage = redactText(message);
  const entry = {
    ts,
    level,
    message: safeMessage,
    ...(meta !== undefined ? { meta: redactMeta(meta) } : {}),
  };
  let serialized: string;
  try {
    serialized = JSON.stringify(entry);
  } catch {
    serialized = JSON.stringify({ ts, level, message: safeMessage, meta: UNSERIALIZABLE });
  }
  process.stderr.write(serialized + "\n");
  appendToLogFile(serialized);
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => log("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => log("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => log("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => log("error", msg, meta),
};
