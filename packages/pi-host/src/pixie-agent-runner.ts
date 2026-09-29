/**
 * Pixie (小精灵) resident agent session — the Host-owned singleton helper.
 *
 * Mirrors the schedule smart-create runner: a custom SessionManager directory
 * under the PiAbyss data root, never entering any workspace's session catalog,
 * built through `createHostAgentSession` on the Host-owned ModelRuntime with
 * extension/skill loading disabled so the toolset stays precisely controlled.
 *
 * Unlike the schedule flow this session is a long-lived singleton (one map
 * entry, restarted by forking its persisted file after a Host restart) and it
 * carries the delegation registry: `pixie_dispatch` enqueues tasks for
 * workspace sessions, their agents answer through the host-injected
 * `pixie_report` tool, and every report is fed back into this session as a
 * user message so the pixie can relay it to the user.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ModelRuntime,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { PixieAgentMessage, PixieDispatchRecord } from "@piabyss/protocol";
import { createHostAgentSession } from "./agent-session-factory.js";
import { piabyssDataDir } from "./piabyss-data.js";

/** Dispatch accepted but the target session has not reported back yet. */
type PixieDispatchStatus = "dispatched" | "reported" | "failed";

type PixieDispatch = {
  id: string;
  status: PixieDispatchStatus;
  cwd: string;
  sessionId: string | null;
  sessionPath: string | null;
  task: string;
  report: string | null;
  createdAt: number;
  reportedAt: number | null;
  stale: boolean;
};

type PixieSessionEntry = {
  session: AgentSession;
  sessionPath: string;
  lastError: string | null;
};

/** The resident session — at most one. Lost on host restart; the session file
 *  remains and `pixie.continue` forks from it. */
let resident: PixieSessionEntry | null = null;

/** The Host-owned runtime, injected once at startup (same contract as the
 *  schedule runner — see `model-runtime-refresh.test.ts`). */
let hostModelRuntime: ModelRuntime | null = null;

export function configurePixieRuntime(runtime: ModelRuntime): void {
  hostModelRuntime = runtime;
}

function requireHostModelRuntime(): ModelRuntime {
  if (!hostModelRuntime) {
    throw new Error("Pixie runtime is not configured (configurePixieRuntime)");
  }
  return hostModelRuntime;
}

/** Registry of delegation records, newest first, bounded. */
const dispatches: PixieDispatch[] = [];
const MAX_DISPATCHES = 50;
/** A dispatch older than this without a report is surfaced as stale. */
export const PIXIE_STALE_MS = 30 * 60 * 1000;

export function pixieDir(agentDir: string): string {
  const dir = join(piabyssDataDir(agentDir), "pixie");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function agentSessionsDir(agentDir: string): string {
  const dir = join(pixieDir(agentDir), "agent-sessions");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Session name so the singleton is recognizable in transcripts. */
const PIXIE_SESSION_NAME = "🧚 小精灵";

async function buildPixieSession(
  agentDir: string,
  sessionManager: SessionManager,
  customTools: ToolDefinition[] = [],
): Promise<AgentSession> {
  const cwd = agentDir; // Host-owned dir: the pixie never touches a workspace cwd.
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
    ...(customTools.length > 0 ? { customTools } : {}),
  });
  return created.session;
}

async function startResident(
  agentDir: string,
  customTools: ToolDefinition[] = [],
): Promise<PixieSessionEntry> {
  const sessionManager = SessionManager.create(agentDir, agentSessionsDir(agentDir));
  const session = await buildPixieSession(agentDir, sessionManager, customTools);
  try {
    session.setSessionName(PIXIE_SESSION_NAME);
  } catch {
    /* name is cosmetic */
  }
  const entry: PixieSessionEntry = {
    session,
    sessionPath: session.sessionFile ?? "",
    lastError: null,
  };
  resident = entry;
  return entry;
}

/** Ensure the resident session exists (idempotent). The dispatch tool is
 *  injected on first build so the pixie can delegate from turn one. */
async function ensurePixieSession(
  agentDir: string,
  customTools: ToolDefinition[] = [],
): Promise<PixieSessionEntry> {
  if (resident) return resident;
  return startResident(agentDir, customTools);
}

/** Send a user message to the resident pixie (fire-and-forget like the
 *  schedule runner: the frontend polls pixie.state for streaming output). */
export async function sendPixieMessage(args: {
  agentDir: string;
  text: string;
  /** Custom tools registered when the session is first built (dispatch). */
  customTools?: ToolDefinition[];
}): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
  const entry = await ensurePixieSession(args.agentDir, args.customTools ?? []);
  if (entry.session.isStreaming) {
    return { ok: false, error: "上一条回复还在生成中" };
  }
  entry.lastError = null;
  void entry.session.prompt(args.text).catch((error: unknown) => {
    entry.lastError = error instanceof Error ? error.message : String(error);
  });
  return { ok: true, sessionId: entry.session.sessionId };
}

/** Continue the persisted singleton after a Host restart: fork its session
 *  file and adopt the fork as the new resident. */
export async function continuePixieSession(args: {
  agentDir: string;
  sessionPath: string;
  text: string;
  customTools?: ToolDefinition[];
}): Promise<{ ok: true; sessionId: string; sessionPath: string } | { ok: false; error: string }> {
  if (!existsSync(args.sessionPath)) {
    return { ok: false, error: `会话文件不存在：${args.sessionPath}` };
  }
  const sessionManager = SessionManager.forkFrom(
    args.sessionPath,
    args.agentDir,
    agentSessionsDir(args.agentDir),
  );
  const session = await buildPixieSession(args.agentDir, sessionManager, args.customTools ?? []);
  try {
    session.setSessionName(PIXIE_SESSION_NAME);
  } catch {
    /* cosmetic */
  }
  const entry: PixieSessionEntry = {
    session,
    sessionPath: session.sessionFile ?? "",
    lastError: null,
  };
  resident = entry;
  void entry.session.prompt(args.text).catch((error: unknown) => {
    entry.lastError = error instanceof Error ? error.message : String(error);
  });
  return { ok: true, sessionId: entry.session.sessionId, sessionPath: entry.sessionPath };
}

/** Project a session message into the wire shape (same projection as the
 *  schedule runner so the desktop reuses one transcript renderer). */
function toPixieMessage(message: {
  role?: unknown;
  content?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  isError?: unknown;
}): PixieAgentMessage | null {
  const role = String(message.role ?? "unknown");
  let text = "";
  const thoughts: string[] = [];
  let blocks: unknown[] = [];
  const content = message.content;
  if (typeof content === "string") {
    text = content.trim();
    blocks = text ? [{ type: "text", text }] : [];
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    const kept: unknown[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: string; text?: string; thinking?: string };
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
      else if (b.type === "thinking" && typeof b.thinking === "string") thoughts.push(b.thinking);
      kept.push(block);
    }
    text = parts.join("\n").trim();
    blocks = kept;
  }
  if (!text && thoughts.length === 0 && blocks.length === 0) return null;
  const out: PixieAgentMessage = { role, text };
  if (thoughts.length > 0) out.reasoning = thoughts.join("\n\n").trim();
  if (blocks.length > 0) out.content = blocks;
  if (typeof message.toolCallId === "string") out.toolCallId = message.toolCallId;
  if (typeof message.toolName === "string") out.toolName = message.toolName;
  if (message.isError === true) out.isError = true;
  return out;
}

function messagesOf(session: AgentSession): PixieAgentMessage[] {
  const raw = session.messages as unknown as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(raw)) return [];
  const out: PixieAgentMessage[] = [];
  for (const message of raw) {
    const projected = toPixieMessage(message);
    if (projected) out.push(projected);
  }
  return out;
}

/** Full pixie state for the frontend: transcript + delegation registry. */
export function pixieState(): {
  resident: boolean;
  sessionPath: string | null;
  running: boolean;
  error: string | null;
  messages: PixieAgentMessage[];
  dispatches: PixieDispatchRecord[];
} {
  markStaleDispatches();
  if (!resident) {
    return {
      resident: false,
      sessionPath: null,
      running: false,
      error: null,
      messages: [],
      dispatches: dispatchRecords(),
    };
  }
  return {
    resident: true,
    sessionPath: resident.sessionPath,
    running: resident.session.isStreaming,
    error: resident.lastError,
    messages: messagesOf(resident.session),
    dispatches: dispatchRecords(),
  };
}

function dispatchRecords(): PixieDispatchRecord[] {
  return dispatches.slice(0, 20).map((d) => ({ ...d }));
}

function markStaleDispatches(): void {
  const now = Date.now();
  for (const d of dispatches) {
    if (d.status === "dispatched" && !d.stale && now - d.createdAt > PIXIE_STALE_MS) {
      d.stale = true;
    }
  }
}

/** Register a new delegation (called by the pixie_dispatch tool). */
export function registerDispatch(input: {
  cwd: string;
  sessionId: string | null;
  sessionPath: string | null;
  task: string;
}): PixieDispatch {
  const record: PixieDispatch = {
    id: `pix_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    status: "dispatched",
    cwd: input.cwd,
    sessionId: input.sessionId,
    sessionPath: input.sessionPath,
    task: input.task,
    report: null,
    createdAt: Date.now(),
    reportedAt: null,
    stale: false,
  };
  dispatches.unshift(record);
  if (dispatches.length > MAX_DISPATCHES) dispatches.length = MAX_DISPATCHES;
  return record;
}

/** Settle a delegation with the agent's report (called by pixie_report). */
export function settleDispatch(id: string, report: string): PixieDispatch | null {
  const record = dispatches.find((d) => d.id === id);
  if (!record || record.status !== "dispatched") return null;
  record.status = "reported";
  record.report = report;
  record.reportedAt = Date.now();
  return record;
}

/** Fail a delegation (target session rejected/aborted the task). */
export function failDispatch(id: string, reason: string): PixieDispatch | null {
  const record = dispatches.find((d) => d.id === id);
  if (!record || record.status !== "dispatched") return null;
  record.status = "failed";
  record.report = reason;
  record.reportedAt = Date.now();
  return record;
}

/** Does this workspace session have a live delegation awaiting its report? */
export function hasActiveDispatchFor(sessionId: string): boolean {
  return dispatches.some((d) => d.status === "dispatched" && d.sessionId === sessionId);
}

/** Find a dispatched record by session id (first match, oldest active wins). */
export function findDispatchBySession(sessionId: string): PixieDispatch | undefined {
  return dispatches.find((d) => d.status === "dispatched" && d.sessionId === sessionId);
}

export function listDispatches(limit: number): PixieDispatchRecord[] {
  markStaleDispatches();
  return dispatches.slice(0, Math.max(1, limit)).map((d) => ({ ...d }));
}

/** Deliver a report into the resident session as a user-turn message. */
export async function deliverReportToPixie(args: {
  agentDir: string;
  dispatchId: string;
  summary: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const record = settleDispatch(args.dispatchId, args.summary);
  if (!record) return { ok: false, error: "委派记录不存在或已结束" };
  const entry = resident ?? (await ensurePixieSession(args.agentDir).catch(() => null));
  if (!entry) return { ok: true }; // registry settled; nothing to feed back
  const message = [
    `<pixie-report dispatchId="${record.id}">`,
    `被委派会话已回调（目标 cwd：${record.cwd}）：`,
    args.summary,
    "</pixie-report>",
    "请把上述结果整理后转述给用户（只转述，不代写总结）。",
  ].join("\n");
  if (entry.session.isStreaming) {
    // The pixie is mid-turn: steer the report into the running turn so it is
    // not lost (the SDK delivers steering between steps of the same run).
    void entry.session.steer(message).catch(() => undefined);
    return { ok: true };
  }
  void entry.session.prompt(message).catch((error: unknown) => {
    entry.lastError = error instanceof Error ? error.message : String(error);
  });
  return { ok: true };
}

export function abortPixie(): boolean {
  if (!resident) return false;
  void resident.session.abort().catch(() => undefined);
  return true;
}

/** Minimal JSONL transcript read for a non-resident singleton. */
export function pixieTranscriptFrom(sessionPath: string): PixieAgentMessage[] {
  if (!existsSync(sessionPath)) return [];
  let raw = "";
  try {
    raw = readFileSync(sessionPath, "utf8");
  } catch {
    return [];
  }
  const out: PixieAgentMessage[] = [];
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
    const message = (parsed.message ?? {}) as Record<string, unknown>;
    const projected = toPixieMessage(message);
    if (projected) out.push(projected);
  }
  return out;
}

/** The persisted singleton file, if any (newest .jsonl in the pixie dir). */
export function latestPixieSessionFile(agentDir: string): string | null {
  const dir = agentSessionsDir(agentDir);
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  let best: { path: string; mtime: number } | null = null;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const fullPath = join(dir, name);
    try {
      const mtime = statSync(fullPath).mtimeMs;
      if (!best || mtime > best.mtime) best = { path: fullPath, mtime };
    } catch {
      continue;
    }
  }
  return best?.path ?? null;
}
