/**
 * 小精灵会话缓存（`<agentDir>/piabyss/pixie/sessions-cache.json`）。
 *
 * 两个用途：
 *
 * 1. **归属判定**——小精灵默认只能使用/复用「自己创建的会话」。凡由委派引擎
 *    新建的会话（`createTargetSession`）都登记为 `owner: "pixie"`；用户自己在 UI
 *    里创建的会话不会出现在本缓存里，所以自动落点永远挑不到它们。只有用户在对话
 *    中明确给出会话 id 时，才会以 `owner: "user"` 登记并被委派使用。
 * 2. **交代**——缓存每个小精灵会话（`role: "pixie"`：小精灵自己的工作区段会话）
 *    与每个被委托会话（`role: "delegated"`）的 id / 工作区 / 简介 / 结果，
 *    供小精灵挑选可复用会话与向用户交代。
 *
 * 只存简洁摘要：**不存消息正文，不存工具调用信息**。单条摘要截断 120 字。
 *
 * 本模块是叶子依赖（只用 node:fs / node:path），不 import runner，避免循环依赖。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { piabyssDataDir } from "./piabyss-data.js";
import type { PixieDispatchRecord } from "@piabyss/protocol";

/** 会话归属：pixie = 小精灵创建（可自动复用）；user = 用户自己创建（仅显式指定时可委托）。 */
export type PixieSessionOwner = "pixie" | "user";

/** 会话角色：pixie = 小精灵自己的工作区会话；delegated = 被委托干活的工作区会话。 */
export type PixieSessionRole = "pixie" | "delegated";

export type PixieSessionCacheEntry = {
  sessionId: string;
  /** 会话 JSONL 路径（归属判定的主键，按规范化的路径比较）。 */
  sessionPath: string;
  /** 所属工作区（规范化的 cwd）。 */
  cwd: string;
  owner: PixieSessionOwner;
  role: PixieSessionRole;
  /** 会话简介（≤120 字；创建时取任务摘要，之后可更新）。 */
  summary: string;
  /** 最近一次结果摘要（来自委派回调；未回调为 null）。 */
  result: string | null;
  createdAt: number;
  lastActiveAt: number;
  /** 关联的委派记录 id（按时间追加，去重）。 */
  dispatchIds: string[];
  /** 被复用次数（用于交代"这个会话被派过几次活"）。 */
  reuseCount: number;
};

export type PixieSessionCacheFile = {
  version: 1;
  updatedAt: number;
  sessions: PixieSessionCacheEntry[];
};

/** 缓存条目上限：超出时按 lastActiveAt 保留最近的（缓存是交代用的，不是档案）。 */
const MAX_ENTRIES = 200;
const SUMMARY_LIMIT = 120;

export function pixieSessionCachePath(agentDir: string): string {
  return join(piabyssDataDir(agentDir), "pixie", "sessions-cache.json");
}

/**
 * 会话路径比较键：Windows 盘符大小写、`\` 与 `/`、结尾斜杠都不应影响同一性判定。
 */
export function sessionLookupKey(sessionPath: string): string {
  return sessionPath.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function truncate(text: string, limit = SUMMARY_LIMIT): string {
  const flat = text.replaceAll(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

function emptyCache(): PixieSessionCacheFile {
  return { version: 1, updatedAt: 0, sessions: [] };
}

function isEntry(value: unknown): value is PixieSessionCacheEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.sessionId === "string" &&
    typeof entry.sessionPath === "string" &&
    (entry.owner === "pixie" || entry.owner === "user")
  );
}

function normalizeEntry(entry: PixieSessionCacheEntry): PixieSessionCacheEntry {
  return {
    sessionId: entry.sessionId,
    sessionPath: entry.sessionPath,
    cwd: entry.cwd ?? "",
    owner: entry.owner,
    role: entry.role === "pixie" ? "pixie" : "delegated",
    summary: typeof entry.summary === "string" ? entry.summary : "",
    result: typeof entry.result === "string" && entry.result ? entry.result : null,
    createdAt: typeof entry.createdAt === "number" ? entry.createdAt : 0,
    lastActiveAt: typeof entry.lastActiveAt === "number" ? entry.lastActiveAt : 0,
    dispatchIds: Array.isArray(entry.dispatchIds)
      ? entry.dispatchIds.filter((id): id is string => typeof id === "string")
      : [],
    reuseCount: typeof entry.reuseCount === "number" ? entry.reuseCount : 0,
  };
}

/** 容错读取：文件缺失/损坏一律回退为空缓存（缓存丢了不影响委派，只是少一份交代）。 */
export function loadPixieSessionCache(agentDir: string): PixieSessionCacheFile {
  const path = pixieSessionCachePath(agentDir);
  if (!existsSync(path)) return emptyCache();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return emptyCache();
    const raw = (parsed as { sessions?: unknown }).sessions;
    if (!Array.isArray(raw)) return emptyCache();
    const sessions = raw.filter(isEntry).map(normalizeEntry);
    return {
      version: 1,
      updatedAt:
        typeof (parsed as { updatedAt?: unknown }).updatedAt === "number"
          ? (parsed as { updatedAt: number }).updatedAt
          : 0,
      sessions,
    };
  } catch {
    return emptyCache();
  }
}

export function savePixieSessionCache(agentDir: string, cache: PixieSessionCacheFile): void {
  try {
    const path = pixieSessionCachePath(agentDir);
    mkdirSync(join(piabyssDataDir(agentDir), "pixie"), { recursive: true });
    const kept =
      cache.sessions.length <= MAX_ENTRIES
        ? cache.sessions
        : [...cache.sessions]
            .sort((left, right) => right.lastActiveAt - left.lastActiveAt)
            .slice(0, MAX_ENTRIES);
    writeFileSync(
      path,
      `${JSON.stringify({ version: 1, updatedAt: Date.now(), sessions: kept }, null, 2)}\n`,
      "utf8",
    );
  } catch {
    // 缓存写入失败不阻断委派（委派本身已在 dispatches.json 留痕）。
  }
}

/**
 * 登记/更新一个会话条目。已存在时只补字段、不改归属（归属一经确定不再翻转）。
 * 返回落库后的条目。
 */
export function upsertPixieSession(
  agentDir: string,
  input: {
    sessionId: string;
    sessionPath: string;
    cwd: string;
    owner: PixieSessionOwner;
    role: PixieSessionRole;
    summary?: string;
    result?: string | null;
    now?: number;
    /** true = 记一次复用（命中既有会话时调用）。 */
    reused?: boolean;
  },
): PixieSessionCacheEntry {
  const now = input.now ?? Date.now();
  const cache = loadPixieSessionCache(agentDir);
  const key = sessionLookupKey(input.sessionPath);
  const existing = cache.sessions.find((entry) => sessionLookupKey(entry.sessionPath) === key);
  if (existing) {
    if (input.summary) existing.summary = truncate(input.summary);
    if (input.result) existing.result = truncate(input.result, 200);
    existing.lastActiveAt = now;
    if (input.reused) existing.reuseCount += 1;
    if (input.cwd) existing.cwd = input.cwd;
    savePixieSessionCache(agentDir, cache);
    return existing;
  }
  const entry: PixieSessionCacheEntry = {
    sessionId: input.sessionId,
    sessionPath: input.sessionPath,
    cwd: input.cwd,
    owner: input.owner,
    role: input.role,
    summary: input.summary ? truncate(input.summary) : "",
    result: input.result ? truncate(input.result, 200) : null,
    createdAt: now,
    lastActiveAt: now,
    dispatchIds: [],
    reuseCount: input.reused ? 1 : 0,
  };
  cache.sessions.push(entry);
  savePixieSessionCache(agentDir, cache);
  return entry;
}

export function findPixieSessionByPath(
  agentDir: string,
  sessionPath: string,
): PixieSessionCacheEntry | null {
  const key = sessionLookupKey(sessionPath);
  return (
    loadPixieSessionCache(agentDir).sessions.find(
      (entry) => sessionLookupKey(entry.sessionPath) === key,
    ) ?? null
  );
}

/** 归属判定：该会话是否由小精灵创建（自动落点唯一允许的复用来源）。 */
export function isPixieOwnedSessionPath(agentDir: string, sessionPath: string): boolean {
  if (!sessionPath) return false;
  return findPixieSessionByPath(agentDir, sessionPath)?.owner === "pixie";
}

export function isPixieOwnedSessionId(agentDir: string, sessionId: string): boolean {
  if (!sessionId) return false;
  return loadPixieSessionCache(agentDir).sessions.some(
    (entry) => entry.sessionId === sessionId && entry.owner === "pixie",
  );
}

/** 列出缓存条目（可按工作区过滤），按最后活跃倒序。 */
export function listPixieSessions(agentDir: string, cwd?: string): PixieSessionCacheEntry[] {
  const key = cwd ? sessionLookupKey(cwd) : null;
  const sessions = loadPixieSessionCache(agentDir).sessions.filter(
    (entry) => !key || sessionLookupKey(entry.cwd) === key,
  );
  return [...sessions].sort((left, right) => right.lastActiveAt - left.lastActiveAt);
}

/**
 * 把委派记录的结果同步进缓存（结果/进度/活跃时间/关联 id）。
 *
 * 只更新**已登记**的会话：缓存里没有的会话说明不是小精灵创建的，不凭空造条目、
 * 也不修改归属——归属只能由创建点或显式指定时登记。
 */
export function applyDispatchRecordsToSessionCache(
  agentDir: string,
  records: PixieDispatchRecord[],
): void {
  if (records.length === 0) return;
  const cache = loadPixieSessionCache(agentDir);
  if (cache.sessions.length === 0) return;
  let dirty = false;
  for (const record of records) {
    if (!record.sessionId && !record.sessionPath) continue;
    const entry = cache.sessions.find(
      (item) =>
        (record.sessionId && item.sessionId === record.sessionId) ||
        (record.sessionPath &&
          sessionLookupKey(item.sessionPath) === sessionLookupKey(record.sessionPath)),
    );
    if (!entry) continue;
    if (!entry.dispatchIds.includes(record.id)) {
      entry.dispatchIds.push(record.id);
      dirty = true;
    }
    const result = record.report ?? record.progressSummary ?? null;
    if (result && result !== entry.result) {
      entry.result = truncate(result, 200);
      dirty = true;
    }
    if (!entry.summary && record.task) {
      entry.summary = truncate(record.task);
      dirty = true;
    }
    const activeAt = record.lastActiveAt ?? record.startedAt ?? record.createdAt;
    if (typeof activeAt === "number" && activeAt > entry.lastActiveAt) {
      entry.lastActiveAt = activeAt;
      dirty = true;
    }
  }
  if (dirty) savePixieSessionCache(agentDir, cache);
}
