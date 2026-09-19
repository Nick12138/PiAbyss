/**
 * 备忘录云同步引擎（v2）：通过 Cloudflare R2 做多设备同步。
 *
 * 键布局（前缀固定，不开放配置）：
 *   piabyss/memo/notes.json
 *   piabyss/memo/images/<noteId>/<fileName>
 *
 * 同步策略 = 「逐条记录最后写入者胜（LWW）+ 删除墓碑」：
 *   1. 拉取云端 notes.json（不存在视为空库）；
 *   2. 与本地全量记录（含墓碑）按 id 逐条合并，updatedAt 新者胜；
 *   3. 合并结果整体回写本地 notes.json，并从云端补齐缺失的图片；
 *   4. 上传合并后的 notes.json 与图片，供其他设备拉取；
 *   5. 超过 30 天的删除墓碑物理清除（本地图片 + 云端对象）。
 *
 * 删除通过墓碑传播：remove 打 deletedAt 墓碑并保留记录体，其他设备合并时
 * 会把墓碑同步回来；若另一台设备在删除之后又编辑过该条（updatedAt 更新），
 * 则编辑胜出、记录复活。已知取舍：时钟漂移会影响胜负判断；图片跟随记录
 * 整体胜负，不做单图合并。
 *
 * 配置与同步状态持久化在 <agentDir>/piabyss/memo/sync-config.json
 * （与 notes.json 同目录、同套原子写策略）。autoSync 开启时，备忘录每次
 * 变更后防抖触发后台同步，结果写回 lastSync* 字段。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoNote, MemoSyncConfig, MemoSyncSettings } from "@piabyss/protocol";
import { logger } from "./logger.js";
import { getMemoStore } from "./memo-store.js";
import {
  deleteObject,
  getObject,
  putObject,
  testConnection,
  type R2Credentials,
} from "./r2-client.js";

const CONFIG_FILE_NAME = "sync-config.json";
/** 对象键前缀：固定值，不开放配置。 */
const OBJECT_KEY_PREFIX = "piabyss/memo";
/** autoSync 防抖窗口：连续变更合并为一次同步。 */
const AUTO_SYNC_DEBOUNCE_MS = 5_000;
/** Host 启动后的首次后台同步延迟：错开启动高峰。 */
const STARTUP_SYNC_DELAY_MS = 10_000;
/** 删除墓碑保留时长：过期后物理清除（本地与云端）。 */
const TOMBSTONE_TTL_MS = 30 * 24 * 3600 * 1000;

const EMPTY_CONFIG: MemoSyncConfig = {
  accountId: "",
  accessKeyId: "",
  secretAccessKey: "",
  bucket: "",
  autoSync: false,
};

type SyncStateFile = MemoSyncSettings;

/** 一次双向同步的统计。 */
export type MemoSyncStats = {
  /** 合并后仍可见（未删除）的记录数，即上传的记录数。 */
  uploadedNotes: number;
  /** 实际上传的图片对象数。 */
  uploadedImages: number;
  /** 从云端采纳（云端更新）的记录数。 */
  downloadedNotes: number;
  /** 从云端补齐到本地的图片数。 */
  downloadedImages: number;
  /** 上传字节总数。 */
  bytes: number;
  at: number;
};

function credentialsOf(config: MemoSyncConfig): R2Credentials {
  return {
    accountId: config.accountId.trim(),
    accessKeyId: config.accessKeyId.trim(),
    secretAccessKey: config.secretAccessKey.trim(),
    bucket: config.bucket.trim(),
  };
}

/** 配置文件路径（notes.json 同级）。 */
function configPath(agentDir: string): string {
  return join(agentDir, "piabyss", "memo", CONFIG_FILE_NAME);
}

/**
 * 从 notes.json 文本解析记录列表。
 * 容忍空/损坏文件；对每条记录做最小形状过滤（无有效 id 的条目丢弃），
 * 并为旧版本写入的记录补齐 result / deletedAt 缺省值 —— 否则缺字段的
 * 记录会被 list() 的墓碑过滤误判为已删除而"隐身"。
 */
function parseCloudNotes(body: Buffer | null): MemoNote[] {
  if (!body) return [];
  try {
    const parsed = JSON.parse(body.toString("utf8")) as { notes?: unknown };
    if (!Array.isArray(parsed.notes)) return [];
    const notes: MemoNote[] = [];
    for (const raw of parsed.notes) {
      const note = raw as MemoNote;
      if (typeof note?.id !== "string" || note.id === "") continue;
      if (typeof note?.createdAt !== "number" || typeof note?.updatedAt !== "number") continue;
      if (note.result === undefined) note.result = null;
      if (note.deletedAt === undefined) note.deletedAt = null;
      notes.push(note);
    }
    return notes;
  } catch {
    throw new Error("云端 notes.json 内容损坏，无法解析");
  }
}

/**
 * 逐条 LWW 合并（纯函数，便于单测）：
 * - 仅一方存在 → 保留该方（本地新记录 / 其他设备新增的记录）；
 * - 双方存在 → updatedAt 新者胜；打平保留本地；
 * - 墓碑也是一种「更新」（remove 会同时推进 updatedAt），
 *   因此另一台设备在删除之后的编辑（updatedAt 更新）会自然胜出并复活记录。
 *
 * adoptedNotes = 内容来自云端的记录数（云端新增 + 云端更新胜出）。
 */
function mergeNotes(
  local: MemoNote[],
  cloud: MemoNote[],
): { notes: MemoNote[]; adoptedNotes: number } {
  const byId = new Map<string, MemoNote>();
  for (const note of local) byId.set(note.id, note);
  let adoptedNotes = 0;
  for (const note of cloud) {
    const localNote = byId.get(note.id);
    if (!localNote || note.updatedAt > localNote.updatedAt) {
      byId.set(note.id, note);
      adoptedNotes += 1;
    }
  }
  const notes = [...byId.values()].sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );
  return { notes, adoptedNotes };
}

export class MemoSync {
  private readonly agentDir: string;
  private readonly store;
  private autoSyncTimer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private startupSyncDone = false;
  private syncing = false;

  constructor(agentDir: string) {
    this.agentDir = agentDir;
    this.store = getMemoStore(agentDir);
  }

  /** 读取配置与最近同步状态（文件缺失或损坏 → 空配置）。 */
  getSettings(): MemoSyncSettings {
    try {
      const raw = JSON.parse(
        readFileSync(configPath(this.agentDir), "utf8"),
      ) as Partial<SyncStateFile>;
      return {
        ...EMPTY_CONFIG,
        ...raw,
        autoSync: raw.autoSync === true,
        lastSyncAt: typeof raw.lastSyncAt === "number" ? raw.lastSyncAt : null,
        lastSyncOk: typeof raw.lastSyncOk === "boolean" ? raw.lastSyncOk : null,
        lastSyncError: typeof raw.lastSyncError === "string" ? raw.lastSyncError : null,
      } satisfies MemoSyncSettings;
    } catch {
      return { ...EMPTY_CONFIG, lastSyncAt: null, lastSyncOk: null, lastSyncError: null };
    }
  }

  /** 保存连接配置（保留既有同步状态；兼容清理旧配置中的多余键）。 */
  setConfig(config: MemoSyncConfig): MemoSyncSettings {
    const settings: SyncStateFile = {
      ...config,
      lastSyncAt: this.getSettings().lastSyncAt,
      lastSyncOk: this.getSettings().lastSyncOk,
      lastSyncError: this.getSettings().lastSyncError,
    };
    const path = configPath(this.agentDir);
    mkdirSync(join(path, ".."), { recursive: true });
    const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tempPath, JSON.stringify(settings, null, 2), "utf8");
    renameSync(tempPath, path);
    return settings;
  }

  /** 仅把最近一次同步状态写回配置文件（失败不影响主流程）。 */
  private recordState(at: number, ok: boolean, error: string | null): void {
    try {
      const path = configPath(this.agentDir);
      mkdirSync(join(path, ".."), { recursive: true });
      let raw: Partial<SyncStateFile> = {};
      try {
        raw = JSON.parse(readFileSync(path, "utf8")) as Partial<SyncStateFile>;
      } catch {
        /* 配置缺失时也允许写状态 */
      }
      const next: SyncStateFile = {
        accountId: raw.accountId ?? "",
        accessKeyId: raw.accessKeyId ?? "",
        secretAccessKey: raw.secretAccessKey ?? "",
        bucket: raw.bucket ?? "",
        autoSync: raw.autoSync === true,
        lastSyncAt: at,
        lastSyncOk: ok,
        lastSyncError: error,
      };
      const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tempPath, JSON.stringify(next, null, 2), "utf8");
      renameSync(tempPath, path);
    } catch (error) {
      logger.warn("[memo-sync] failed to record sync state", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 对象键：固定前缀下的相对路径。 */
  private objectKey(relative: string): string {
    return `${OBJECT_KEY_PREFIX}/${relative}`;
  }

  /** 测试连接（不落盘，不改动状态）。 */
  async test(config: MemoSyncConfig): Promise<{ ok: boolean; error: string | null }> {
    return testConnection(credentialsOf(config));
  }

  private requireCreds(): { creds: R2Credentials; config: MemoSyncConfig } {
    const config = this.getSettings();
    if (!config.accountId || !config.bucket) {
      throw new Error("尚未配置 R2 连接信息");
    }
    return { creds: credentialsOf(config), config };
  }

  /**
   * 立即同步：拉取 → 合并 → 回写本地 → 补图 → 上传。
   * 并发护栏下串行执行；结果写回 lastSync* 状态。
   */
  async syncNow(): Promise<MemoSyncStats> {
    if (this.syncing) throw new Error("已有一次同步在进行中");
    this.syncing = true;
    const at = Date.now();
    try {
      const { creds } = this.requireCreds();

      // 1. 拉取云端全量记录。
      const cloudBody = await getObject(creds, this.objectKey("notes.json"));
      const cloudNotes = parseCloudNotes(cloudBody);

      // 2. 逐条 LWW 合并（含墓碑）。
      const merged = mergeNotes(this.store.listAll(), cloudNotes);

      // 3. 清理过期墓碑：物理删除本地图片与记录，并删除云端图片对象。
      const cutoff = Date.now() - TOMBSTONE_TTL_MS;
      const purged = merged.notes.filter(
        (note) => note.deletedAt !== null && note.deletedAt <= cutoff,
      );
      if (purged.length > 0) {
        merged.notes = merged.notes.filter((note) => !purged.includes(note));
        for (const note of purged) {
          this.store.hardRemove(note.id);
          for (const image of note.images) {
            await deleteObject(creds, this.objectKey(`images/${note.id}/${image.fileName}`)).catch(
              (error: unknown) => {
                logger.warn("[memo-sync] failed to delete cloud image", {
                  error: error instanceof Error ? error.message : String(error),
                });
              },
            );
          }
        }
      }

      // 4. 合并结果回写本地（含墓碑，供其他设备学习删除）。
      this.store.replaceAll(merged.notes);

      // 5. 从云端补齐本地缺失的图片（云端 404 → 丢弃引用，避免悬空）。
      let downloadedImages = 0;
      const downloadedKeys = new Set<string>();
      for (const note of merged.notes) {
        if (note.deletedAt !== null) continue;
        for (const image of [...note.images]) {
          if (this.store.hasImageFile(note.id, image.fileName)) continue;
          const imageKey = `images/${note.id}/${image.fileName}`;
          const body = await getObject(creds, this.objectKey(imageKey));
          if (body) {
            this.store.writeImageFile(note.id, image.fileName, body);
            downloadedKeys.add(imageKey);
            downloadedImages += 1;
          } else {
            note.images = note.images.filter((entry) => entry.id !== image.id);
          }
        }
      }

      // 6. 上传合并后的 notes.json + 本地存在的图片。
      const notesBody = Buffer.from(
        JSON.stringify({ schemaVersion: 1, notes: merged.notes }, null, 2),
        "utf8",
      );
      await putObject(creds, this.objectKey("notes.json"), notesBody);
      let uploadedImages = 0;
      let bytes = notesBody.byteLength;
      for (const note of merged.notes) {
        if (note.deletedAt !== null) continue;
        for (const image of note.images) {
          const imageKey = `images/${note.id}/${image.fileName}`;
          if (downloadedKeys.has(imageKey)) continue; // 刚从云端补齐，无需回传
          const body = this.store.readImageFile(note.id, image.fileName);
          await putObject(creds, this.objectKey(imageKey), body);
          uploadedImages += 1;
          bytes += body.byteLength;
        }
      }

      const stats: MemoSyncStats = {
        uploadedNotes: merged.notes.filter((note) => note.deletedAt === null).length,
        uploadedImages,
        downloadedNotes: merged.adoptedNotes,
        downloadedImages,
        bytes,
        at: Date.now(),
      };
      this.recordState(stats.at, true, null);
      return stats;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.recordState(at, false, message);
      throw error;
    } finally {
      this.syncing = false;
    }
  }

  /** autoSync 开启时，防抖触发后台同步（吞错，状态写回 lastSync*）。 */
  scheduleAutoSync(): void {
    const config = this.getSettings();
    if (!config.autoSync) return;
    if (this.autoSyncTimer) clearTimeout(this.autoSyncTimer);
    this.autoSyncTimer = setTimeout(() => {
      this.autoSyncTimer = null;
      void this.syncNow().catch((error: unknown) => {
        logger.warn("[memo-sync] auto sync failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, AUTO_SYNC_DEBOUNCE_MS);
    this.autoSyncTimer.unref?.();
  }

  /**
   * Host 启动后的首次后台同步（autoSync 开启且已配置时；每次进程只做一次）。
   * 延迟执行以错开启动高峰；吞错，结果写回 lastSync* 状态。
   */
  startupSync(): void {
    if (this.startupSyncDone) return;
    this.startupSyncDone = true;
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      const config = this.getSettings();
      if (!config.autoSync || !config.accountId || !config.bucket) return;
      void this.syncNow().catch((error: unknown) => {
        logger.warn("[memo-sync] startup sync failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, STARTUP_SYNC_DELAY_MS);
    this.startupTimer.unref?.();
  }
}

const memoSyncCache = new Map<string, MemoSync>();

export function getMemoSync(agentDir: string): MemoSync {
  let sync = memoSyncCache.get(agentDir);
  if (!sync) {
    sync = new MemoSync(agentDir);
    memoSyncCache.set(agentDir, sync);
  }
  return sync;
}

/** 备忘录变更后调用：autoSync 开启则防抖同步。 */
export function scheduleMemoAutoSync(agentDir: string): void {
  try {
    getMemoSync(agentDir).scheduleAutoSync();
  } catch {
    /* best-effort */
  }
}
