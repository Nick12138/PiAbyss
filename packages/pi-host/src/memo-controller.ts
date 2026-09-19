/**
 * 备忘录协议 handler（memo.* 方法）。
 *
 * v1 纯本地：所有操作直接落在 MemoStore（`<agentDir>/piabyss/memo/`）。
 * v2 云同步：新增 memo.getSyncConfig / memo.setSyncConfig / memo.testSync /
 * memo.syncToCloud 四个方法（Cloudflare R2 上传），autoSync 开启时在每次
 * 变更后防抖触发后台上传。
 * 参数校验在这里做一层，保证桌面端传入的载荷形状可信后再进存储层。
 */
import type { MethodHandler } from "./server.js";
import type { MemoSyncConfig } from "@piabyss/protocol";
import { getMemoStore, type MemoCreateInput, type MemoUpdatePatch } from "./memo-store.js";
import { getMemoSync, scheduleMemoAutoSync, type MemoSyncStats } from "./memo-sync.js";

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

function asImageInputs(value: unknown): MemoCreateInput["images"] {
  if (!Array.isArray(value)) return undefined;
  const images: NonNullable<MemoCreateInput["images"]> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    if (typeof raw.dataBase64 !== "string") continue;
    images.push({
      fileName: asString(raw.fileName),
      mediaType: asString(raw.mediaType),
      dataBase64: raw.dataBase64,
    });
  }
  return images;
}

export function createMemoHandlers(agentDir: string): Partial<Record<string, MethodHandler>> {
  const store = getMemoStore(agentDir);
  // Host 启动：autoSync 开启时在后台先同步一次（多设备拉齐 / 补传积压变更）。
  getMemoSync(agentDir).startupSync();

  return {
    "memo.list": async () => ({ result: { notes: store.list() } }),

    "memo.create": async (ctx) => {
      const params = ctx.params as Record<string, unknown>;
      const input: MemoCreateInput = {
        type: asString(params.type) as MemoCreateInput["type"],
        title: asString(params.title),
        contentMd: asString(params.contentMd),
        tags: asStringArray(params.tags),
        workspaceHint:
          params.workspaceHint === undefined ? undefined : (params.workspaceHint as string | null),
        images: asImageInputs(params.images),
      };
      const note = store.create(input);
      scheduleMemoAutoSync(agentDir);
      return { result: { note } };
    },
    "memo.update": async (ctx) => {
      const params = ctx.params as Record<string, unknown>;
      const id = asString(params.id);
      const rawPatch = (params.patch ?? {}) as Record<string, unknown>;
      const patch: MemoUpdatePatch = {};
      if (rawPatch.type !== undefined)
        patch.type = asString(rawPatch.type) as MemoUpdatePatch["type"];
      if (rawPatch.title !== undefined) patch.title = asString(rawPatch.title);
      if (rawPatch.contentMd !== undefined) patch.contentMd = asString(rawPatch.contentMd);
      if (rawPatch.status !== undefined) {
        patch.status = asString(rawPatch.status) as MemoUpdatePatch["status"];
      }
      if (rawPatch.tags !== undefined) patch.tags = asStringArray(rawPatch.tags);
      if (rawPatch.workspaceHint !== undefined) {
        patch.workspaceHint = rawPatch.workspaceHint as string | null;
      }
      if (rawPatch.addImages !== undefined) patch.addImages = asImageInputs(rawPatch.addImages);
      if (Array.isArray(rawPatch.removeImageIds)) {
        patch.removeImageIds = rawPatch.removeImageIds.filter(
          (entry): entry is string => typeof entry === "string",
        );
      }
      const note = store.update(id, patch);
      scheduleMemoAutoSync(agentDir);
      return { result: { note } };
    },

    "memo.delete": async (ctx) => {
      const params = ctx.params as Record<string, unknown>;
      store.remove(asString(params.id));
      scheduleMemoAutoSync(agentDir);
      return { result: { ok: true } };
    },

    "memo.readImage": async (ctx) => {
      const params = ctx.params as Record<string, unknown>;
      return {
        result: store.readImage(asString(params.noteId), asString(params.imageId)),
      };
    },

    "memo.getSyncConfig": async () => {
      return { result: { settings: getMemoSync(agentDir).getSettings() } };
    },

    "memo.setSyncConfig": async (ctx) => {
      const params = ctx.params as { settings: MemoSyncConfig };
      return { result: { settings: getMemoSync(agentDir).setConfig(params.settings) } };
    },

    "memo.testSync": async (ctx) => {
      const params = ctx.params as { settings: MemoSyncConfig };
      return { result: await getMemoSync(agentDir).test(params.settings) };
    },

    "memo.syncNow": async () => {
      const stats: MemoSyncStats = await getMemoSync(agentDir).syncNow();
      return { result: stats };
    },
  };
}
