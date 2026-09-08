import { createReadStream, readdirSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type {
  SerializableSessionEntry,
  TelegramAssistantConfig,
  TelegramBoundUser,
  TelegramBridgeStatus,
  TelegramConfigResult,
  TelegramProfileSummary,
  TelegramSessionDetail,
  TelegramSessionListResult,
  TelegramSessionSummary,
  TelegramThreadsConfig,
  TelegramVoiceConfig,
} from "@piabyss/protocol";
import { createHostError } from "@piabyss/protocol";
import type { MethodHandler } from "./server.js";
import { workspaceStorageKey } from "./piabyss-data.js";

/**
 * Telegram workspace views + thin config shell over the @llblab/pi-telegram
 * plugin.
 *
 * The plugin keeps no message archive of its own — its inbox journal is a
 * bounded queue that drops processed updates. Real history lives in the Pi
 * sessions the plugin delivered into: every telegram-originated prompt carries
 * a `[telegram|...]` marker in the user message text. Telegram runs as its own
 * dedicated workspace (`<agentDir>/workspace/telegram`), so this controller
 * scans only that workspace's session directory — TG turns never pollute other
 * workspaces. Config read/write/reset are thin shells over telegram.json (the
 * plugin owns the file's live semantics; manual edits are only safe while
 * disconnected).
 */

const TELEGRAM_CONFIG_FILE = "telegram.json";
const TELEGRAM_SESSIONS_DIR = "sessions";
const TELEGRAM_TMP_DIR = "tmp/telegram";
const TELEGRAM_WORKSPACE_SEGMENT = "workspace/telegram";
/** Plugin transport-ownership store; the default profile locks key `default`. */
const TELEGRAM_OWNERS_FILE = "owners.json";
const TELEGRAM_DEFAULT_OWNERS_KEY = "default";
/** Telegram origin marker written at the head of telegram user prompts
 *  (current `[telegram|...]` form and the legacy `[telegram]` form). */
const TELEGRAM_MARKER = "[telegram";
/** User text must carry the marker within the first characters. */
const TELEGRAM_MARKER_MAX_OFFSET = 64;

/** Marker must be `[telegram]` or `[telegram|...]`, not a longer prefix match. */
function isTelegramMarkerAt(text: string, offset: number): boolean {
  const rest = text.slice(offset + TELEGRAM_MARKER.length).trimStart();
  return rest.startsWith("]") || rest.startsWith("|");
}
const SESSION_LIST_CAP = 500;
const SESSION_ENTRY_CAP = 5000;
const PREVIEW_MAX_CHARS = 160;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

/** Best-effort liveness probe for a foreign process (mirrors the plugin's
 *  own check so a dead lock entry reads as disconnected). */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

/** Cheap line pre-filter before JSON.parse, mirroring session-search. */
function mayMatchTelegram(line: string): boolean {
  return (
    line.includes('"role":"user"') ||
    line.includes('"type":"session"') ||
    line.includes('"type":"session_info"')
  );
}

/** Strips telegram turn metadata lines (`[telegram]`, `[time]`, `[reply]`, …)
 *  so the sidebar preview shows the prompt the user actually sent. */
/** Strips telegram turn metadata (leading `[telegram...]` marker and
 *  `[time]`/`[reply]`-style lines) so the sidebar preview shows the prompt
 *  the user actually sent. */
function cleanTelegramPreview(rawText: string): string {
  const markerPrefix = /^\[telegram(\|[^\]]*)?\]\s*/u;
  const metadataLine = /^\[(time|reply|attachments|outputs|voice|thread)\b/u;
  const parts: string[] = [];
  for (const line of rawText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (metadataLine.test(trimmed)) continue;
    const stripped = trimmed.replace(markerPrefix, "").trim();
    if (stripped) parts.push(stripped);
  }
  const text = (parts.join(" ") || rawText.replace(/\s+/g, " ").trim()).trim();
  return text.length > PREVIEW_MAX_CHARS ? `${text.slice(0, PREVIEW_MAX_CHARS)}…` : text;
}

function textBlocksOf(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      texts.push(block);
      continue;
    }
    if (isRecord(block)) {
      if (typeof block.text === "string") texts.push(block.text);
      else if (Array.isArray(block.text)) {
        for (const part of block.text) if (typeof part === "string") texts.push(part);
      }
    }
  }
  return texts;
}

/** Whitelisted projection of the plugin's `assistant` config block. */
/** Masks a bot token for display: `head***tail`, never the raw value. */
function maskBotToken(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length <= 12) return "*".repeat(Math.min(trimmed.length, 12));
  return `${trimmed.slice(0, 8)}${"*".repeat(4)}${trimmed.slice(-4)}`;
}

/** Masked token of the default profile, when one is configured. */
function maskedToken(config: Record<string, unknown>): string | undefined {
  const profiles = isRecord(config.profiles) ? config.profiles : undefined;
  const profile = isRecord(profiles?.default) ? profiles.default : undefined;
  const token = typeof profile?.botToken === "string" ? profile.botToken : "";
  return token.trim() ? maskBotToken(token) : undefined;
}

/**
 * Bound owner lookup: the plugin stores only `profiles.default.allowedUserId`;
 * the display name comes from the first journaled update sent by that user
 * (from the inbox segments; a queue, so the name may be absent after churn).
 */
function boundUser(
  config: Record<string, unknown>,
  inboxDir: string,
): TelegramBoundUser | null | undefined {
  const profiles = isRecord(config.profiles) ? config.profiles : undefined;
  const profile = isRecord(profiles?.default) ? profiles.default : undefined;
  const userId = typeof profile?.allowedUserId === "number" ? profile.allowedUserId : undefined;
  if (userId === undefined) return undefined; // profile not configured yet
  return { userId, ...findBoundName(userId, inboxDir) };
}

function findBoundName(userId: number, inboxDir: string): { username?: string; name?: string } {
  const segmentsDir = join(inboxDir, "inbox.json.segments");
  let names: string[] = [];
  try {
    names = readdirSync(segmentsDir).filter((name) => name.endsWith(".json"));
  } catch {
    return {};
  }
  for (const name of names) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(segmentsDir, name), "utf8"));
    } catch {
      continue;
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.upsertedEntries)) continue;
    for (const entry of parsed.upsertedEntries) {
      const update = isRecord(entry) && isRecord(entry.update) ? entry.update : undefined;
      const message = update && isRecord(update.message) ? update.message : undefined;
      const callback =
        update && isRecord(update.callback_query) ? update.callback_query : undefined;
      const from = (message?.from ?? (callback ? callback.from : undefined)) as
        Record<string, unknown> | undefined;
      if (isRecord(from) && from.id === userId) {
        const username = typeof from.username === "string" ? from.username : undefined;
        const firstName = typeof from.first_name === "string" ? from.first_name : undefined;
        const lastName = typeof from.last_name === "string" ? from.last_name : undefined;
        const name = [firstName, lastName].join(" ").trim() || undefined;
        if (username || name) {
          return { ...(username ? { username } : {}), ...(name ? { name } : {}) };
        }
      }
    }
  }
  return {};
}

function sanitizeAssistantConfig(value: unknown): TelegramAssistantConfig {
  const out: TelegramAssistantConfig = {};
  if (!isRecord(value)) return out;
  if (typeof value.draftPreviews === "boolean") out.draftPreviews = value.draftPreviews;
  if (value.rendering === "rich" || value.rendering === "html") out.rendering = value.rendering;
  if (typeof value.proactivePush === "boolean") out.proactivePush = value.proactivePush;
  if (
    value.activity === "quiet" ||
    value.activity === "thinking" ||
    value.activity === "tools" ||
    value.activity === "verbose"
  ) {
    out.activity = value.activity;
  }
  if (
    value.timeInjection === "hidden" ||
    value.timeInjection === "always" ||
    value.timeInjection === "interval"
  ) {
    out.timeInjection = value.timeInjection;
  }
  return out;
}

function sanitizeVoiceConfig(value: unknown): TelegramVoiceConfig {
  const out: TelegramVoiceConfig = {};
  if (!isRecord(value)) return out;
  if (
    value.replyMode === "manual" ||
    value.replyMode === "hidden" ||
    value.replyMode === "mirror" ||
    value.replyMode === "always"
  ) {
    out.replyMode = value.replyMode;
  }
  return out;
}

function sanitizeThreadsConfig(value: unknown): TelegramThreadsConfig {
  const out: TelegramThreadsConfig = {};
  if (!isRecord(value)) return out;
  if (typeof value.automaticCleanup === "boolean") out.automaticCleanup = value.automaticCleanup;
  return out;
}

/** Counts telegram user messages in a session file and returns context. */
async function scanSession(sessionPath: string): Promise<{
  sessionId?: string;
  cwd?: string;
  name?: string;
  count: number;
  preview?: string;
} | null> {
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let name: string | undefined;
  let count = 0;
  let preview: string | undefined;

  const lines = createInterface({
    input: createReadStream(sessionPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!mayMatchTelegram(line)) continue;
    let entry: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed)) continue;
      entry = parsed;
    } catch {
      continue;
    }

    if (entry.type === "session" && sessionId === undefined && isUuid(entry.id)) {
      sessionId = entry.id;
      cwd = typeof entry.cwd === "string" ? entry.cwd : undefined;
      continue;
    }
    if (entry.type === "session_info") {
      if (name === undefined && typeof entry.name === "string" && entry.name.trim()) {
        name = entry.name.trim();
      }
      continue;
    }
    if (entry.type !== "message" || !isRecord(entry.message)) continue;
    const message = entry.message;
    if (message.role !== "user") continue;
    for (const rawText of textBlocksOf(message.content)) {
      const offset = rawText.indexOf(TELEGRAM_MARKER);
      if (
        offset >= 0 &&
        offset <= TELEGRAM_MARKER_MAX_OFFSET &&
        isTelegramMarkerAt(rawText, offset)
      ) {
        count += 1;
        if (preview === undefined) preview = cleanTelegramPreview(rawText);
        break;
      }
    }
  }
  if (count === 0) return null;
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(cwd ? { cwd } : {}),
    ...(name ? { name } : {}),
    count,
    ...(preview ? { preview } : {}),
  };
}

async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

export function createTelegramSessionHandlers(
  agentDir: string,
): Partial<Record<string, MethodHandler>> {
  const configPath = join(agentDir, TELEGRAM_CONFIG_FILE);
  const inboxDir = join(agentDir, TELEGRAM_TMP_DIR);
  const ownersPath = join(inboxDir, TELEGRAM_OWNERS_FILE);
  const sessionsRoot = join(agentDir, TELEGRAM_SESSIONS_DIR);
  const sessionsRootResolved = `${resolve(sessionsRoot)}${process.platform === "win32" ? "\\" : "/"}`;
  const workspacePath = join(agentDir, TELEGRAM_WORKSPACE_SEGMENT);
  /** Sessions dir of the dedicated telegram workspace (scoped scan target). */
  const telegramSessionsDir = join(sessionsRoot, workspaceStorageKey(workspacePath));

  /** Ensures the telegram workspace dir exists (open-folder target). */
  const ensureTelegramWorkspace = async (): Promise<string> => {
    await mkdir(workspacePath, { recursive: true });
    return workspacePath;
  };

  const readDefaultProfile = async (): Promise<TelegramProfileSummary | null> => {
    const raw = await readJson(configPath);
    if (!isRecord(raw)) return null;
    const profiles = isRecord(raw.profiles) ? raw.profiles : undefined;
    const profile = isRecord(profiles?.default) ? profiles.default : undefined;
    if (!profile) return null;
    const token = typeof profile.botToken === "string" ? profile.botToken.trim() : "";
    const botUsername =
      typeof profile.botUsername === "string" && profile.botUsername.length > 0
        ? profile.botUsername
        : undefined;
    const botName =
      typeof profile.botName === "string" && profile.botName.length > 0
        ? profile.botName
        : undefined;
    return {
      profile: "default",
      ...(typeof profile.botId === "number" ? { botId: profile.botId } : {}),
      ...(botUsername ? { botUsername } : {}),
      ...(botName ? { botName } : {}),
      configured: token.length > 0,
    };
  };

  /** Session files inside the dedicated telegram workspace's sessions dir. */
  const listTelegramWorkspaceSessionFiles = async (): Promise<string[]> => {
    const paths: string[] = [];
    try {
      const files = (await readdir(telegramSessionsDir)).filter((f) => f.endsWith(".jsonl"));
      for (const file of files) paths.push(join(telegramSessionsDir, file));
    } catch {
      /* telegram workspace has no sessions yet — nothing to list */
    }
    return paths;
  };

  /** Session files across every workspace (used by `telegram.reset` to also
   *  clean up telegram turns recorded before the dedicated workspace existed). */
  const listAllSessionFiles = async (): Promise<string[]> => {
    let workspaceDirs: string[] = [];
    try {
      workspaceDirs = (await readdir(sessionsRoot, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => join(sessionsRoot, d.name));
    } catch {
      return [];
    }
    const paths: string[] = [];
    for (const dir of workspaceDirs) {
      try {
        const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
        for (const file of files) paths.push(join(dir, file));
      } catch {
        /* unreadable workspace dir — skip */
      }
    }
    return paths;
  };

  return {
    "telegram.getProfiles": async () => {
      return { result: { default: await readDefaultProfile() } };
    },

    /**
     * Bridge transport state: best-effort read of the plugin's owners.json.
     * The default profile locks key `default`; an entry whose process is alive
     * means some Pi instance currently owns polling for the bridge.
     */
    "telegram.status": async (): Promise<{ result: TelegramBridgeStatus }> => {
      const raw = await readJson(ownersPath);
      if (!isRecord(raw)) return { result: { connected: false } };
      const entry = raw[TELEGRAM_DEFAULT_OWNERS_KEY];
      if (!isRecord(entry) || typeof entry.pid !== "number") {
        return { result: { connected: false } };
      }
      const profile = await readDefaultProfile();
      return {
        result: {
          connected: isProcessAlive(entry.pid),
          profile: TELEGRAM_DEFAULT_OWNERS_KEY,
          ...(profile?.botId !== undefined ? { botId: profile.botId } : {}),
          ownerPid: entry.pid,
        },
      };
    },

    /**
     * Writes the validated bot identity into the plugin's telegram.json
     * (`profiles.default`), preserving any other profiles/fields. The caller
     * (add-bot dialog) validates the token via `telegram.validateToken`
     * first; this only persists the result so the plugin's
     * `/telegram-connect` can start polling without re-entering the token.
     */
    "telegram.saveProfile": async (
      ctx,
    ): Promise<{ result: { saved: true } } | { error: ReturnType<typeof createHostError> }> => {
      const { token, botId, botUsername, botName } = ctx.params as {
        token: string;
        botId?: number;
        botUsername?: string;
        botName?: string;
      };
      const trimmed = token.trim();
      if (!trimmed) {
        return { error: createHostError("INVALID_REQUEST", "Bot token is required") };
      }
      try {
        const existing = await readJson(configPath);
        const config = isRecord(existing) ? existing : {};
        const profiles = isRecord(config.profiles) ? { ...config.profiles } : {};
        profiles.default = {
          ...(isRecord(profiles.default) ? profiles.default : {}),
          botToken: trimmed,
          ...(botId !== undefined ? { botId } : {}),
          ...(botUsername ? { botUsername } : {}),
          ...(botName ? { botName } : {}),
        };
        await writeFile(
          configPath,
          `${JSON.stringify({ ...config, profiles }, null, 2)}\n`,
          "utf8",
        );
        return { result: { saved: true } };
      } catch (err) {
        return {
          error: createHostError(
            "INTERNAL_ERROR",
            err instanceof Error ? err.message : String(err),
          ),
        };
      }
    },

    "telegram.getConfig": async (): Promise<{ result: TelegramConfigResult }> => {
      const defaultProfile = await readDefaultProfile();
      const raw = await readJson(configPath);
      const config = isRecord(raw) ? raw : {};
      const assistant = sanitizeAssistantConfig(config.assistant);
      const voice = sanitizeVoiceConfig(config.voice);
      const threads = sanitizeThreadsConfig(config.threads);
      const bound = boundUser(config, inboxDir);
      return {
        result: {
          default: defaultProfile,
          workspacePath: await ensureTelegramWorkspace(),
          ...(maskedToken(config) ? { tokenMasked: maskedToken(config) } : {}),
          ...(bound !== undefined ? { bound } : {}),
          ...(Object.keys(assistant).length > 0 ? { assistant } : {}),
          ...(Object.keys(voice).length > 0 ? { voice } : {}),
          ...(Object.keys(threads).length > 0 ? { threads } : {}),
        },
      };
    },

    "telegram.updateConfig": async (
      ctx,
    ): Promise<{ result: { saved: true } } | { error: ReturnType<typeof createHostError> }> => {
      const { assistant, voice, threads } = ctx.params as {
        assistant?: TelegramAssistantConfig;
        voice?: TelegramVoiceConfig;
        threads?: TelegramThreadsConfig;
      };
      try {
        const existing = await readJson(configPath);
        const config = isRecord(existing) ? existing : {};
        const next = { ...config };
        if (assistant !== undefined) {
          next.assistant = { ...(isRecord(next.assistant) ? next.assistant : {}), ...assistant };
        }
        if (voice !== undefined) {
          next.voice = { ...(isRecord(next.voice) ? next.voice : {}), ...voice };
        }
        if (threads !== undefined) {
          next.threads = { ...(isRecord(next.threads) ? next.threads : {}), ...threads };
        }
        await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
        return { result: { saved: true } };
      } catch (err) {
        return {
          error: createHostError(
            "INTERNAL_ERROR",
            err instanceof Error ? err.message : String(err),
          ),
        };
      }
    },

    "telegram.reset": async (): Promise<{ result: { reset: true } }> => {
      // Restore the pre-configuration state: plugin config, its temp state,
      // the workspace dir, and every telegram-driven session. The plugin
      // package itself is left installed.
      await rm(configPath, { force: true });
      await rm(join(agentDir, TELEGRAM_TMP_DIR), { recursive: true, force: true });
      await rm(join(agentDir, TELEGRAM_WORKSPACE_SEGMENT), { recursive: true, force: true });
      for (const sessionPath of await listAllSessionFiles()) {
        if ((await scanSession(sessionPath)) !== null) {
          await rm(sessionPath, { force: true });
        }
      }
      return { result: { reset: true } };
    },

    "telegram.listSessions": async (): Promise<{ result: TelegramSessionListResult }> => {
      const sessions: TelegramSessionSummary[] = [];
      for (const sessionPath of await listTelegramWorkspaceSessionFiles()) {
        const scanned = await scanSession(sessionPath);
        if (!scanned) continue;
        let updatedAt = 0;
        try {
          const info = await stat(sessionPath);
          // stat().mtimeMs is fractional; the protocol requires an integer.
          updatedAt = Math.round(info.mtimeMs);
        } catch {
          /* keep 0 when the file vanished mid-scan */
        }
        sessions.push({
          sessionPath,
          ...(scanned.sessionId ? { sessionId: scanned.sessionId } : {}),
          ...(scanned.name ? { name: scanned.name } : {}),
          ...(scanned.cwd ? { cwd: scanned.cwd } : {}),
          updatedAt,
          telegramMessageCount: scanned.count,
          ...(scanned.preview ? { preview: scanned.preview } : {}),
        });
        if (sessions.length >= SESSION_LIST_CAP) break;
      }
      sessions.sort((a, b) => b.updatedAt - a.updatedAt);
      return { result: { sessions } };
    },

    "telegram.getSession": async (
      ctx,
    ): Promise<
      { result: TelegramSessionDetail } | { error: ReturnType<typeof createHostError> }
    > => {
      const { sessionPath } = ctx.params as { sessionPath: string };
      const resolved = resolve(sessionPath);
      const inSessionsRoot =
        resolved === resolve(sessionsRoot) || resolved.startsWith(sessionsRootResolved);
      if (!inSessionsRoot || !sessionPath.endsWith(".jsonl")) {
        return {
          error: createHostError(
            "INVALID_REQUEST",
            "sessionPath must be inside the sessions directory",
          ),
        };
      }

      const scanned = await scanSession(resolved);
      if (!scanned) {
        return {
          error: createHostError("INVALID_REQUEST", "Session has no telegram messages"),
        };
      }
      let updatedAt = 0;
      try {
        const info = await stat(resolved);
        updatedAt = Math.round(info.mtimeMs);
      } catch {
        return { error: createHostError("SESSION_NOT_FOUND", "Session file is not readable") };
      }

      const entries: SerializableSessionEntry[] = [];
      const lines = createInterface({
        input: createReadStream(resolved, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });
      for await (const line of lines) {
        if (entries.length >= SESSION_ENTRY_CAP) break;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch {
          continue;
        }
        if (
          isRecord(parsed) &&
          parsed.type === "message" &&
          typeof parsed.id === "string" &&
          isRecord(parsed.message)
        ) {
          entries.push(parsed as SerializableSessionEntry);
        }
      }

      const summary: TelegramSessionSummary = {
        sessionPath: resolved,
        ...(scanned.sessionId ? { sessionId: scanned.sessionId } : {}),
        ...(scanned.name ? { name: scanned.name } : {}),
        ...(scanned.cwd ? { cwd: scanned.cwd } : {}),
        updatedAt,
        telegramMessageCount: scanned.count,
        ...(scanned.preview ? { preview: scanned.preview } : {}),
      };
      return { result: { summary, entries } };
    },
  };
}
