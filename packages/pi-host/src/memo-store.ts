/**
 * 备忘录本地存储层。
 *
 * v1（纯本地）：数据落盘在 `<agentDir>/piabyss/memo/` 下：
 *   - `notes.json`  全量记录（单文件，原子写入）
 *   - `images/<noteId>/<imageId>.<ext>`  记录图片
 *
 * 设计取舍：
 *   - 每次操作都从磁盘读、写回磁盘，不持有内存缓存。备忘录的数据量很小
 *     （个人记录），磁盘读取代价可忽略；换来的好处是多个消费者（协议
 *     handler、agent 工具、v2 的同步引擎）各自持有实例也不会互相覆盖，
 *     天然多实例安全。
 *   - 删除是软删除（墓碑 deletedAt）：记录体与图片保留在磁盘上，供同步
 *     引擎把删除传播到其他设备；超过 TTL（30 天）的墓碑由 purgeDeleted
 *     物理清除。
 *   - 写入走「临时文件 + rename」原子替换，进程中断不会留下半截 JSON。
 *   - workspaceHint 只是字符串标签，不与工作区强绑定（目录可能移动/改名）。
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  MemoImage,
  MemoImageInput,
  MemoNote,
  MemoNoteStatus,
  MemoNoteType,
} from "@piabyss/protocol";
import { createHostError, type HostError } from "@piabyss/protocol";

/** 单张图片的 base64 解码后大小上限（8 MiB）。 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** 单条记录的图片数量上限。 */
const MAX_IMAGES_PER_NOTE = 20;
/** contentMd 长度上限。 */
const MAX_CONTENT_LENGTH = 200_000;
/** title 长度上限。 */
const MAX_TITLE_LENGTH = 300;
/** tag 单个长度上限 / 单条记录 tag 数量上限。 */
const MAX_TAG_LENGTH = 60;
const MAX_TAGS_PER_NOTE = 20;

const NOTE_TYPES: readonly MemoNoteType[] = ["memo", "idea", "task"];
const NOTE_STATUSES: readonly MemoNoteStatus[] = ["open", "done", "archived"];

/** mediaType → 扩展名（用于图片落盘命名）。 */
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/avif": "avif",
};

/** 持久化 JSON 的形状（带 schemaVersion，便于将来迁移）。 */
type MemoFile = {
  schemaVersion: 1;
  notes: MemoNote[];
};

function memoError(code: "INVALID_REQUEST" | "RESOURCE_NOT_FOUND", message: string): HostError {
  return createHostError(code, message);
}

function isValidBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function base64Bytes(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.floor(((value.length - padding) * 3) / 4);
}

export type MemoCreateInput = {
  type: MemoNoteType;
  title: string;
  contentMd: string;
  tags?: string[];
  workspaceHint?: string | null;
  images?: MemoImageInput[];
};

export type MemoUpdatePatch = {
  type?: MemoNoteType;
  title?: string;
  contentMd?: string;
  status?: MemoNoteStatus;
  tags?: string[];
  workspaceHint?: string | null;
  addImages?: MemoImageInput[];
  removeImageIds?: string[];
  /** 清空 Agent 结果总结（进行中恢复后重跑时使用）。 */
  clearResult?: boolean;
};

/** piabyss_memo 工具 complete 时提交的结果总结及会话关联。 */
export type MemoCompleteResultInput = {
  resultMd: string;
  sessionId: string;
  sessionPath: string | null;
  sessionTitle: string | null;
  sessionCwd: string | null;
};

function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().replace(/^#/, "");
    if (!tag || tag.length > MAX_TAG_LENGTH) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
    if (result.length >= MAX_TAGS_PER_NOTE) break;
  }
  return result;
}

/** 备忘录存储。目录懒创建；全部方法同步（数据量小，磁盘读取可忽略）。 */
export class MemoStore {
  private readonly root: string;
  private readonly imagesRoot: string;
  private readonly filePath: string;

  constructor(agentDir: string) {
    this.root = join(agentDir, "piabyss", "memo");
    this.imagesRoot = join(this.root, "images");
    this.filePath = join(this.root, "notes.json");
  }

  /** 存储根目录（诊断/展示用）。 */
  get rootDir(): string {
    return this.root;
  }

  /** 可见记录（不含墓碑；UI、协议、agent 工具都用这个）。 */
  list(): MemoNote[] {
    return this.readFile().notes.filter((note) => note.deletedAt === null);
  }

  /** 全量原始记录（含墓碑；同步引擎专用）。 */
  listAll(): MemoNote[] {
    return this.readFile().notes;
  }

  get(id: string): MemoNote | null {
    return this.list().find((note) => note.id === id) ?? null;
  }

  /** 不过滤墓碑的原始查找（同步引擎/图片文件定位用）。 */
  private getAny(id: string): MemoNote | null {
    return this.readFile().notes.find((note) => note.id === id) ?? null;
  }

  create(input: MemoCreateInput): MemoNote {
    const title = this.requireTitle(input.title);
    const contentMd = this.requireContent(input.contentMd);
    const now = Date.now();
    const note: MemoNote = {
      id: randomUUID(),
      type: this.requireType(input.type),
      title,
      contentMd,
      status: "open",
      tags: normalizeTags(input.tags),
      workspaceHint: this.normalizeHint(input.workspaceHint),
      images: [],
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      result: null,
      deletedAt: null,
    };
    note.images = this.storeImages(note.id, input.images ?? []);
    const file = this.readFile();
    file.notes.unshift(note);
    this.writeFile(file);
    return note;
  }

  update(id: string, patch: MemoUpdatePatch): MemoNote {
    const file = this.readFile();
    const note = file.notes.find((entry) => entry.id === id);
    if (!note) throw memoError("RESOURCE_NOT_FOUND", `备忘录记录不存在：${id}`);

    if (patch.type !== undefined) note.type = this.requireType(patch.type);
    if (patch.title !== undefined) note.title = this.requireTitle(patch.title);
    if (patch.contentMd !== undefined) note.contentMd = this.requireContent(patch.contentMd);
    if (patch.tags !== undefined) note.tags = normalizeTags(patch.tags);
    if (patch.workspaceHint !== undefined) {
      note.workspaceHint = this.normalizeHint(patch.workspaceHint);
    }
    if (patch.status !== undefined) {
      const status = this.requireStatus(patch.status);
      note.status = status;
      note.completedAt = status === "done" ? (note.completedAt ?? Date.now()) : null;
    }
    if (patch.clearResult) note.result = null;
    if (patch.removeImageIds?.length) {
      for (const imageId of patch.removeImageIds) this.removeImageFile(note, imageId);
      note.images = note.images.filter((image) => !patch.removeImageIds?.includes(image.id));
    }
    if (patch.addImages?.length) {
      note.images = [...note.images, ...this.storeImages(note.id, patch.addImages)];
    }
    note.updatedAt = Date.now();
    this.writeFile(file);
    return note;
  }

  /**
   * Agent 处理完成：标记 done 并写入/覆盖结果总结（含会话关联）。
   * 与手动标记完成（update status）不同，只有本方法会产生总结。
   */
  completeWithResult(id: string, input: MemoCompleteResultInput): MemoNote {
    const file = this.readFile();
    const note = file.notes.find((entry) => entry.id === id);
    if (!note) throw memoError("RESOURCE_NOT_FOUND", `备忘录记录不存在：${id}`);
    const resultMd = input.resultMd.trim();
    if (!resultMd) throw memoError("INVALID_REQUEST", "结果总结不能为空");
    if (resultMd.length > MAX_CONTENT_LENGTH) {
      throw memoError("INVALID_REQUEST", `结果总结过长（上限 ${MAX_CONTENT_LENGTH} 字符）`);
    }
    const sessionId = input.sessionId.trim();
    if (!sessionId) throw memoError("INVALID_REQUEST", "缺少提交总结的会话信息");
    const now = Date.now();
    note.status = "done";
    note.completedAt = note.completedAt ?? now;
    note.result = {
      resultMd,
      sessionId,
      sessionPath: input.sessionPath?.trim() || null,
      sessionTitle: input.sessionTitle?.trim() || null,
      sessionCwd: input.sessionCwd?.trim() || null,
      at: now,
    };
    note.updatedAt = now;
    this.writeFile(file);
    return note;
  }

  /** 删除 = 打墓碑（记录体与图片保留，供同步传播删除；见 purgeDeleted）。 */
  remove(id: string): MemoNote {
    const file = this.readFile();
    const note = file.notes.find((entry) => entry.id === id);
    if (!note) throw memoError("RESOURCE_NOT_FOUND", `备忘录记录不存在：${id}`);
    const now = Date.now();
    note.deletedAt = now;
    note.updatedAt = now;
    this.writeFile(file);
    return note;
  }

  /** 物理删除：移除记录体与图片目录（墓碑过期清理 / 恢复覆盖前使用）。 */
  hardRemove(id: string): void {
    const file = this.readFile();
    const index = file.notes.findIndex((entry) => entry.id === id);
    if (index < 0) return;
    const note = file.notes[index];
    if (note) rmSync(join(this.imagesRoot, note.id), { recursive: true, force: true });
    file.notes.splice(index, 1);
    this.writeFile(file);
  }

  /**
   * 清理超过 TTL 的墓碑：物理删除记录与图片目录。
   * 返回被清理的记录（含图片名列表），供同步引擎删除云端对应对象。
   */
  purgeDeleted(cutoff: number): MemoNote[] {
    const file = this.readFile();
    const expired = file.notes.filter(
      (note) => note.deletedAt !== null && note.deletedAt <= cutoff,
    );
    for (const note of expired) {
      rmSync(join(this.imagesRoot, note.id), { recursive: true, force: true });
    }
    if (expired.length > 0) {
      const expiredIds = new Set(expired.map((note) => note.id));
      file.notes = file.notes.filter((note) => !expiredIds.has(note.id));
      this.writeFile(file);
    }
    return expired;
  }

  /** 用给定记录集整体替换 notes.json（同步引擎合并结果落盘用；图片文件不动）。 */
  replaceAll(notes: MemoNote[]): void {
    this.writeFile({ schemaVersion: 1, notes });
  }

  readImage(noteId: string, imageId: string): { dataBase64: string; mediaType: string } {
    const note = this.list().find((entry) => entry.id === noteId);
    const image = note?.images.find((entry) => entry.id === imageId);
    if (!image) throw memoError("RESOURCE_NOT_FOUND", `备忘录图片不存在：${imageId}`);
    const path = join(this.imagesRoot, noteId, image.fileName);
    try {
      return { dataBase64: readFileSync(path).toString("base64"), mediaType: image.mediaType };
    } catch {
      throw memoError("RESOURCE_NOT_FOUND", `备忘录图片文件缺失：${image.fileName}`);
    }
  }

  /** 读取图片文件原始字节（云同步用；文件缺失抛 RESOURCE_NOT_FOUND）。 */
  readImageFile(noteId: string, fileName: string): Buffer {
    if (!this.getAny(noteId)?.images.some((entry) => entry.fileName === fileName)) {
      throw memoError("RESOURCE_NOT_FOUND", `备忘录图片不存在：${fileName}`);
    }
    const path = join(this.imagesRoot, noteId, fileName);
    try {
      return readFileSync(path);
    } catch {
      throw memoError("RESOURCE_NOT_FOUND", `备忘录图片文件缺失：${fileName}`);
    }
  }

  /** 图片文件是否已存在于本地（同步补图判断用）。 */
  hasImageFile(noteId: string, fileName: string): boolean {
    return existsSync(join(this.imagesRoot, noteId, fileName));
  }

  /** 写入图片文件（同步下载补图用；调用方保证 noteId 与 fileName 已在记录中）。 */
  writeImageFile(noteId: string, fileName: string, body: Buffer): void {
    const dir = join(this.imagesRoot, noteId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, fileName), body);
  }

  private readFile(): MemoFile {
    if (!existsSync(this.filePath)) return { schemaVersion: 1, notes: [] };
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as MemoFile;
      if (raw && raw.schemaVersion === 1 && Array.isArray(raw.notes)) {
        // 旧数据兼容：result / deletedAt 缺失时补齐为 null（下次写盘时落定）。
        for (const note of raw.notes) {
          if (note.result === undefined) note.result = null;
          if (note.deletedAt === undefined) note.deletedAt = null;
        }
        return raw;
      }
    } catch {
      // 损坏的 JSON 视为空库（备份损坏原文件，便于事后排查）。
      try {
        renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
      } catch {
        /* best-effort */
      }
    }
    return { schemaVersion: 1, notes: [] };
  }

  private writeFile(file: MemoFile): void {
    mkdirSync(this.root, { recursive: true });
    const tempPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tempPath, JSON.stringify(file, null, 2), "utf8");
    renameSync(tempPath, this.filePath);
  }

  private storeImages(noteId: string, inputs: MemoImageInput[]): MemoImage[] {
    if (inputs.length === 0) return [];
    const dir = join(this.imagesRoot, noteId);
    mkdirSync(dir, { recursive: true });
    const existing = this.get(noteId)?.images.length ?? 0;
    if (existing + inputs.length > MAX_IMAGES_PER_NOTE) {
      throw memoError("INVALID_REQUEST", `单条记录最多 ${MAX_IMAGES_PER_NOTE} 张图片`);
    }
    const stored: MemoImage[] = [];
    for (const input of inputs) {
      const mediaType = input.mediaType.trim() || "application/octet-stream";
      if (!mediaType.startsWith("image/")) {
        throw memoError("INVALID_REQUEST", `不支持的图片类型：${mediaType}`);
      }
      if (!isValidBase64(input.dataBase64)) {
        throw memoError("INVALID_REQUEST", "图片数据不是有效的 base64");
      }
      if (base64Bytes(input.dataBase64) > MAX_IMAGE_BYTES) {
        throw memoError(
          "INVALID_REQUEST",
          `图片超过大小上限（${MAX_IMAGE_BYTES / 1024 / 1024} MiB）`,
        );
      }
      const id = randomUUID();
      const ext =
        IMAGE_EXTENSIONS[mediaType] ??
        input.fileName
          .split(".")
          .pop()
          ?.toLowerCase()
          .replace(/[^a-z0-9]/g, "") ??
        "";
      const fileName = ext ? `${id}.${ext}` : id;
      writeFileSync(join(dir, fileName), Buffer.from(input.dataBase64, "base64"));
      stored.push({
        id,
        fileName,
        mediaType,
        bytes: base64Bytes(input.dataBase64),
      });
    }
    return stored;
  }

  private removeImageFile(note: MemoNote, imageId: string): void {
    const image = note.images.find((entry) => entry.id === imageId);
    if (!image) return;
    rmSync(join(this.imagesRoot, note.id, image.fileName), { force: true });
  }

  private requireType(value: MemoNoteType): MemoNoteType {
    if (!NOTE_TYPES.includes(value)) {
      throw memoError("INVALID_REQUEST", `无效的记录类型：${String(value)}`);
    }
    return value;
  }

  private requireStatus(value: MemoNoteStatus): MemoNoteStatus {
    if (!NOTE_STATUSES.includes(value)) {
      throw memoError("INVALID_REQUEST", `无效的记录状态：${String(value)}`);
    }
    return value;
  }

  private requireTitle(value: string): string {
    const title = value.trim();
    if (!title) throw memoError("INVALID_REQUEST", "标题不能为空");
    if (title.length > MAX_TITLE_LENGTH) {
      throw memoError("INVALID_REQUEST", `标题过长（上限 ${MAX_TITLE_LENGTH} 字符）`);
    }
    return title;
  }

  private requireContent(value: string): string {
    if (value.length > MAX_CONTENT_LENGTH) {
      throw memoError("INVALID_REQUEST", `正文过长（上限 ${MAX_CONTENT_LENGTH} 字符）`);
    }
    return value;
  }

  private normalizeHint(value: string | null | undefined): string | null {
    const hint = value?.trim();
    return hint ? hint.slice(0, 300) : null;
  }
}

/**
 * 模块级单例：协议 handler 与 agent 工具共享同一实例（键为 agentDir）。
 * 存储本身是磁盘权威（无内存缓存），多实例也安全，这里只是为了省掉重复构造。
 */
const memoStoreCache = new Map<string, MemoStore>();

export function getMemoStore(agentDir: string): MemoStore {
  let store = memoStoreCache.get(agentDir);
  if (!store) {
    store = new MemoStore(agentDir);
    memoStoreCache.set(agentDir, store);
  }
  return store;
}
