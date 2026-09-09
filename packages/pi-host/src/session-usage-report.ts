import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  SerializableUsage,
  SessionUsageModelItem,
  SessionUsageReport,
  SessionUsageReportItem,
  UsageRange,
} from "@piabyss/protocol";
import { sessionStorageDirs } from "./session-storage.js";

type ParsedSession = {
  item: SessionUsageReportItem;
  models: SessionUsageModelItem[];
};

type CachedSessionUsage = {
  mtimeMs: number;
  size: number;
  parsed: ParsedSession;
};

const usageCache = new Map<string, CachedSessionUsage>();

function emptyUsage(): SerializableUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function token(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function cost(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function addUsage(target: SerializableUsage, value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const usage = value as Record<string, unknown>;
  target.input += token(usage.input);
  target.output += token(usage.output);
  target.cacheRead += token(usage.cacheRead);
  target.cacheWrite += token(usage.cacheWrite);
  target.totalTokens += token(usage.totalTokens);

  if (usage.cacheWrite1h !== undefined) {
    target.cacheWrite1h = (target.cacheWrite1h ?? 0) + token(usage.cacheWrite1h);
  }
  if (usage.reasoning !== undefined) {
    target.reasoning = (target.reasoning ?? 0) + token(usage.reasoning);
  }

  if (!usage.cost || typeof usage.cost !== "object" || Array.isArray(usage.cost)) return;
  const usageCost = usage.cost as Record<string, unknown>;
  target.cost.input += cost(usageCost.input);
  target.cost.output += cost(usageCost.output);
  target.cost.cacheRead += cost(usageCost.cacheRead);
  target.cost.cacheWrite += cost(usageCost.cacheWrite);
  target.cost.total += cost(usageCost.total);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function rangeStart(range: UsageRange, now = Date.now()): number | null {
  if (range === "all") return null;
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  if (range === "7d") date.setDate(date.getDate() - 6);
  if (range === "30d") date.setDate(date.getDate() - 29);
  return date.getTime();
}

function messageTimestamp(
  entry: Record<string, unknown>,
  message: Record<string, unknown>,
): number {
  const messageTime = message.timestamp;
  if (typeof messageTime === "number" && Number.isFinite(messageTime)) return messageTime;
  if (typeof messageTime === "string") {
    const parsed = Date.parse(messageTime);
    if (Number.isFinite(parsed)) return parsed;
  }
  const entryTime = entry.timestamp;
  if (typeof entryTime === "number" && Number.isFinite(entryTime)) return entryTime;
  if (typeof entryTime === "string") {
    const parsed = Date.parse(entryTime);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

async function parseSessionFile(
  sessionPath: string,
  archived: boolean,
  mtimeMs: number,
  startTime: number | null,
  providerNames: ReadonlyMap<string, string>,
): Promise<ParsedSession | null> {
  let sessionId: string | null = null;
  let name: string | undefined;
  let messageCount = 0;
  const usage = emptyUsage();
  const models = new Map<string, SessionUsageModelItem>();

  const lines = createInterface({
    input: createReadStream(sessionPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      entry = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    if (entry.type === "session" && sessionId === null && isUuid(entry.id)) {
      sessionId = entry.id;
      continue;
    }
    if (entry.type === "session_info") {
      name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : undefined;
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const messageRecord = message as Record<string, unknown>;
    if (startTime !== null && messageTimestamp(entry, messageRecord) < startTime) continue;
    messageCount += 1;
    if (messageRecord.role === "assistant") {
      addUsage(usage, messageRecord.usage);
      const provider = typeof messageRecord.provider === "string" ? messageRecord.provider : null;
      const modelId = typeof messageRecord.model === "string" ? messageRecord.model : null;
      if (provider && modelId) {
        const key = `${provider}/${modelId}`;
        const modelUsage = models.get(key) ?? {
          provider,
          providerName: providerNames.get(provider),
          modelId,
          sessionCount: 0,
          usage: emptyUsage(),
        };
        addUsage(modelUsage.usage, messageRecord.usage);
        models.set(key, modelUsage);
      }
    }
  }

  if (!sessionId || (startTime !== null && messageCount === 0)) return null;
  return {
    item: {
      sessionId,
      sessionPath,
      ...(name ? { name } : {}),
      updatedAt: mtimeMs,
      archived,
      messageCount,
      usage,
      models: [...models.values()].map((model) => ({ ...model, sessionCount: 1 })),
    },
    models: [...models.values()].map((model) => ({ ...model, sessionCount: 1 })),
  };
}

async function scanDirectory(
  dir: string,
  archived: boolean,
  seen: Set<string>,
  startTime: number | null,
  providerNames: ReadonlyMap<string, string>,
): Promise<ParsedSession[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const files = entries.filter(
    (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl"),
  );
  const items: Array<ParsedSession | null> = [];
  for (let offset = 0; offset < files.length; offset += 8) {
    const batch = await Promise.all(
      files.slice(offset, offset + 8).map(async (entry) => {
        const sessionPath = join(dir, entry.name);
        seen.add(sessionPath);
        const fileStat = await stat(sessionPath);
        const cached = usageCache.get(sessionPath);
        if (
          startTime === null &&
          cached &&
          cached.mtimeMs === fileStat.mtimeMs &&
          cached.size === fileStat.size
        ) {
          return cached.parsed;
        }
        const parsed = await parseSessionFile(
          sessionPath,
          archived,
          fileStat.mtimeMs,
          startTime,
          providerNames,
        );
        if (parsed && startTime === null) {
          usageCache.set(sessionPath, {
            mtimeMs: fileStat.mtimeMs,
            size: fileStat.size,
            parsed,
          });
        } else if (!parsed) {
          usageCache.delete(sessionPath);
        }
        return parsed;
      }),
    );
    items.push(...batch);
  }
  return items.filter((item): item is ParsedSession => item !== null);
}

export async function buildSessionUsageReport(args: {
  agentDir: string;
  canonicalCwd: string;
  workspaceId: string;
  range?: UsageRange;
  now?: number;
  providerNames?: ReadonlyMap<string, string>;
}): Promise<SessionUsageReport> {
  const range = args.range ?? "all";
  const startTime = rangeStart(range, args.now);
  const providerNames = args.providerNames ?? new Map<string, string>();
  const dirs = sessionStorageDirs(args.agentDir, args.canonicalCwd);
  const seen = new Set<string>();
  const [active, archived] = await Promise.all([
    scanDirectory(dirs.activeDir, false, seen, startTime, providerNames),
    scanDirectory(dirs.archiveDir, true, seen, startTime, providerNames),
  ]);
  for (const path of usageCache.keys()) {
    if (!seen.has(path) && (path.startsWith(dirs.activeDir) || path.startsWith(dirs.archiveDir))) {
      usageCache.delete(path);
    }
  }

  const parsedSessions = [...active, ...archived].sort(
    (left, right) => right.item.updatedAt - left.item.updatedAt,
  );
  const sessions = parsedSessions.map(({ item }) => item);
  const totalsUsage = emptyUsage();
  const models = new Map<string, SessionUsageModelItem>();
  let messageCount = 0;
  for (const session of parsedSessions) {
    messageCount += session.item.messageCount;
    addUsage(totalsUsage, session.item.usage);
    for (const model of session.models) {
      const key = `${model.provider}/${model.modelId}`;
      const aggregate = models.get(key) ?? {
        provider: model.provider,
        providerName: model.providerName,
        modelId: model.modelId,
        sessionCount: 0,
        usage: emptyUsage(),
      };
      aggregate.sessionCount += model.sessionCount;
      addUsage(aggregate.usage, model.usage);
      models.set(key, aggregate);
    }
  }

  return {
    workspaceId: args.workspaceId,
    generatedAt: Date.now(),
    totals: {
      sessionCount: sessions.length,
      messageCount,
      usage: totalsUsage,
    },
    models: [...models.values()].sort(
      (left, right) => right.usage.totalTokens - left.usage.totalTokens,
    ),
    sessions,
  };
}
