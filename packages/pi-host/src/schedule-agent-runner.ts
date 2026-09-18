/**
 * Smart-plan creation conversation runner — a schedule-owned independent
 * agent session, mirroring how the pi-schedule plugin runs job sessions:
 * a custom SessionManager directory under the schedule root. These sessions
 * never enter any workspace's session catalog, never touch the workspace
 * service graph, and survive in the backlog across host restarts via their
 * persisted session files. They are still built through
 * `createHostAgentSession` on the Host-owned ModelRuntime (see
 * `model-runtime-refresh.test.ts`) so provider/auth state is never duplicated.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { createHostAgentSession } from "./agent-session-factory.js";
import { scheduleRoot } from "./schedule-api.js";

type AgentEntry = {
  session: AgentSession;
  sessionPath: string;
  cwd: string;
  lastError: string | null;
};

/** Resident sessions, keyed by sessionId. Lost on host restart; the session
 *  file remains and agentContinue forks from it. */
const sessions = new Map<string, AgentEntry>();

/**
 * The Host-owned runtime, injected once at startup. Schedule conversations are
 * user-visible agent sessions, so they must share the single authoritative
 * runtime (provider registrations, credentials, model catalog) instead of
 * building a private one — see `model-runtime-refresh.test.ts`.
 */
let hostModelRuntime: ModelRuntime | null = null;

export function configureScheduleAgentRuntime(runtime: ModelRuntime): void {
  hostModelRuntime = runtime;
}

function requireHostModelRuntime(): ModelRuntime {
  if (!hostModelRuntime) {
    throw new Error("Schedule agent runtime is not configured (configureScheduleAgentRuntime)");
  }
  return hostModelRuntime;
}

function agentSessionsDir(): string {
  const dir = join(scheduleRoot(), "agent-sessions");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; text?: string; thinking?: string; name?: string };
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b.type === "thinking" && typeof b.thinking === "string")
      parts.push(`[thinking] ${b.thinking}`);
    else if (b.type === "toolCall" && typeof b.name === "string") parts.push(`[tool] ${b.name}`);
  }
  return parts.join("\n").trim();
}

function messagesOf(session: AgentSession): Array<{ role: string; text: string }> {
  const messages = session.messages as Array<{ role?: string; content?: unknown }> | undefined;
  if (!Array.isArray(messages)) return [];
  const out: Array<{ role: string; text: string }> = [];
  for (const message of messages) {
    const role = String(message.role ?? "unknown");
    if (role === "toolResult") continue;
    const text = extractText(message.content);
    if (!text) continue;
    out.push({ role, text: text.length > 20_000 ? `${text.slice(0, 20_000)}…(已截断)` : text });
  }
  return out;
}

async function buildSession(
  cwd: string,
  agentDir: string,
  sessionManager: SessionManager,
): Promise<AgentSession> {
  const settings = SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await resourceLoader.reload();
  const created = await createHostAgentSession({
    cwd,
    agentDir,
    modelRuntime: requireHostModelRuntime(),
    resourceLoader,
    settingsManager: settings,
    sessionManager,
  });
  return created.session;
}

/** Start a fresh conversation: create the session and run the analysis
 *  prompt in the background (the frontend polls schedule.agentState). */
export async function startAgentConversation(args: {
  cwd: string;
  requirement: string;
  agentDir: string;
}): Promise<{ sessionId: string; sessionPath: string }> {
  const dir = agentSessionsDir();
  const sessionManager = SessionManager.create(args.cwd, dir);
  const session = await buildSession(args.cwd, args.agentDir, sessionManager);
  try {
    session.setSessionName("⏰ 周期计划 · 智能创建");
  } catch {
    /* name is cosmetic */
  }
  const sessionId = session.sessionId;
  const sessionPath = session.sessionFile ?? "";
  const entry: AgentEntry = { session, sessionPath, cwd: args.cwd, lastError: null };
  sessions.set(sessionId, entry);
  entry.lastError = null;
  void session
    .prompt(
      [
        // <schedule-preamble> sentinels: the frontend splits this injected
        // preamble from the user's requirement for separate rendering.
        "<schedule-preamble>",
        "你是「周期计划」智能创建助手，帮用户把需求变成一个定时任务（计划）配置。",
        "",
        "规则：",
        "1. 通过对话逐步确认配置；信息足够时可直接给出完整配置让用户确认。",
        "2. 每当你确定或更新了任何配置，都在回复里输出一个 ```schedule-plan 代码块，内容为完整配置的 JSON（未确定的字段用 null）。每次都输出完整配置，不要只输出增量。",
        "3. 配置 JSON 字段：",
        "   name: string 计划名；",
        '   kind: "prompt" | "command"（prompt=走模型的计划书任务；command=直接执行 shell 命令）；',
        '   prompt: string（kind=prompt 时的计划书，kind=command 时为 ""）；',
        "   command: string | null（kind=command 时的 shell 命令，否则 null）；",
        "   cwd: string 工作目录绝对路径；",
        '   trigger: { "type": "manual" } | { "type": "once", "at": "<ISO时间>" } | { "type": "interval", "every": "<数字><s|m|h|d|w|mo>" } | { "type": "cron", "cron": "<5段表达式>", "timezone"?: string }；',
        '   permission: "read_only" | "write" | "full"（仅 kind=prompt 有意义）；',
        '   model: { "provider": string, "id": string } | null（null=宿主默认模型）；',
        '   missedWindow: "catch_up_one" | "skip"；',
        "   timeoutMs: number（毫秒，默认 1800000）；",
        "   maxRuns: number | null；",
        "   tags: string[]；",
        '   notify: "none" | "system" | "tg"（运行结束的推送方式）。',
        "4. 用户没有明确表达的字段保持 null，不要臆造。",
        "5. 最终创建由用户在预览面板点「确认创建」完成，你不要声称已经创建成功。",
        "",
        `计划的默认工作目录（cwd）：${args.cwd}`,
        "</schedule-preamble>",
        "用户需求：",
        args.requirement,
      ].join("\n"),
    )
    .catch((error: unknown) => {
      entry.lastError = error instanceof Error ? error.message : String(error);
    });
  return { sessionId, sessionPath };
}

/** Send a follow-up to a resident conversation. */
export async function sendAgentMessage(args: {
  sessionId: string;
  text: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const entry = sessions.get(args.sessionId);
  if (!entry) {
    return { ok: false, error: "会话不在内存中（宿主可能已重启），请从待办重新打开" };
  }
  if (entry.session.isStreaming) {
    return { ok: false, error: "上一条回复还在生成中" };
  }
  entry.lastError = null;
  void entry.session.prompt(args.text).catch((error: unknown) => {
    entry.lastError = error instanceof Error ? error.message : String(error);
  });
  return { ok: true };
}

/** Continue a persisted (non-resident) conversation: fork its session file
 *  and keep going — mirrors the plugin's reply semantics. */
export async function continueAgentConversation(args: {
  sessionPath: string;
  cwd: string;
  text: string;
  agentDir: string;
}): Promise<{ sessionId: string; sessionPath: string } | { ok: false; error: string }> {
  if (!existsSync(args.sessionPath)) {
    return { ok: false, error: `会话文件不存在：${args.sessionPath}` };
  }
  const dir = agentSessionsDir();
  const sessionManager = SessionManager.forkFrom(args.sessionPath, args.cwd, dir);
  const session = await buildSession(args.cwd, args.agentDir, sessionManager);
  const sessionId = session.sessionId;
  const entry: AgentEntry = {
    session,
    sessionPath: session.sessionFile ?? "",
    cwd: args.cwd,
    lastError: null,
  };
  sessions.set(sessionId, entry);
  void entry.session.prompt(args.text).catch((error: unknown) => {
    entry.lastError = error instanceof Error ? error.message : String(error);
  });
  // The fork is a new session file; report it so the caller can track it and
  // retire the old path in the backlog.
  return { sessionId, sessionPath: entry.sessionPath };
}

export function agentState(sessionId: string): {
  found: boolean;
  running: boolean;
  error: string | null;
  messages: Array<{ role: string; text: string }>;
} {
  const entry = sessions.get(sessionId);
  if (!entry) return { found: false, running: false, error: null, messages: [] };
  return {
    found: true,
    running: entry.session.isStreaming,
    error: entry.lastError,
    messages: messagesOf(entry.session),
  };
}

/** All smart-creation sessions on disk (plus resident in-memory ones),
 *  newest first. This is the source of truth for the backlog list — the
 *  previous localStorage-only backlog lost sessions whenever the user left
 *  the agent page without pressing its back button. */
export function listAgentSessions(): Array<{
  sessionId: string;
  sessionPath: string;
  title: string;
  updatedAt: string;
  resident: boolean;
}> {
  const dir = agentSessionsDir();
  const byPath = new Map<string, { mtime: number; sessionId: string }>();
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    names = [];
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const fullPath = join(dir, name);
    let mtime = 0;
    try {
      mtime = statSync(fullPath).mtimeMs;
    } catch {
      continue;
    }
    // Session id from the header line; fall back to the filename suffix.
    let sessionId = name.slice(name.lastIndexOf("_") + 1).replace(/\.jsonl$/, "");
    try {
      const head = readFileSync(fullPath, "utf8").slice(0, 512);
      const match = head.match(/"type":"session"[\s\S]*?"id":"([^"]+)"/);
      if (match?.[1]) sessionId = match[1];
    } catch {
      /* keep the filename-derived id */
    }
    byPath.set(fullPath, { mtime, sessionId });
  }
  // Resident sessions may not have flushed their file yet; still list them.
  for (const [sessionId, entry] of sessions) {
    if (entry.sessionPath && !byPath.has(entry.sessionPath)) {
      byPath.set(entry.sessionPath, { mtime: Date.now(), sessionId });
    }
  }
  const out: Array<{
    sessionId: string;
    sessionPath: string;
    title: string;
    updatedAt: string;
    resident: boolean;
  }> = [];
  for (const [path, info] of byPath) {
    const resident = [...sessions.values()].some((s) => s.sessionPath === path);
    const title = extractTitle(path);
    if (!title) continue; // empty/unreadable transcript: skip
    out.push({
      sessionId: info.sessionId,
      sessionPath: path,
      title,
      updatedAt: new Date(info.mtime).toISOString(),
      resident,
    });
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return out;
}

/** Requirement text from the session's first user message (preamble
 *  stripped), used as the backlog entry title. */
function extractTitle(sessionPath: string): string {
  const messages = agentTranscriptFrom(sessionPath);
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return "";
  const marker = firstUser.text.lastIndexOf("用户需求：");
  let requirement =
    marker >= 0 ? firstUser.text.slice(marker + "用户需求：".length) : firstUser.text;
  // Older prompts append the cwd line after the requirement; drop it.
  requirement = requirement.replace(/\n+计划的默认工作目录（cwd）：[\s\S]*$/, "").trim();
  return (requirement || firstUser.text).slice(0, 120);
}

/** Minimal JSONL transcript read for non-resident sessions. */
export function agentTranscriptFrom(sessionPath: string): Array<{ role: string; text: string }> {
  if (!existsSync(sessionPath)) return [];
  let raw = "";
  try {
    raw = readFileSync(sessionPath, "utf8");
  } catch {
    return [];
  }
  const out: Array<{ role: string; text: string }> = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed.type !== "message") continue;
    const message = (parsed.message ?? {}) as { role?: unknown; content?: unknown };
    const role = String(message.role ?? "unknown");
    if (role === "toolResult") continue;
    const text = extractText(message.content);
    if (!text) continue;
    out.push({ role, text: text.length > 20_000 ? `${text.slice(0, 20_000)}…(已截断)` : text });
  }
  return out;
}

export function abortAgent(sessionId: string): boolean {
  const entry = sessions.get(sessionId);
  if (!entry) return false;
  void entry.session.abort().catch(() => undefined);
  return true;
}
