/**
 * 备忘录协议客户端：桌面端 → pi-host 的 memo.* 请求封装。
 * Host 上下文取自 app store（备忘录是全局数据，不走会话/工作区上下文）。
 */
import type {
  MemoImageInput,
  MemoNote,
  MemoNoteStatus,
  MemoNoteType,
  MemoSyncConfig,
  MemoSyncSettings,
} from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { hostContext } from "../../lib/bridge/host-context";
import { useAppStore } from "../../lib/stores/app-store";

const DEFAULT_TIMEOUT_MS = 15_000;
/** 带图片的创建/更新走更长的超时。 */
const IMAGE_TIMEOUT_MS = 60_000;

function requireHost() {
  const host = useAppStore.getState().host;
  if (!host) throw new Error("host not ready");
  return hostContext(host);
}

export type MemoCreateRequest = {
  type: MemoNoteType;
  title: string;
  contentMd: string;
  tags?: string[];
  workspaceHint?: string | null;
  images?: MemoImageInput[];
};

export type MemoUpdateRequest = {
  type?: MemoNoteType;
  title?: string;
  contentMd?: string;
  status?: MemoNoteStatus;
  tags?: string[];
  workspaceHint?: string | null;
  addImages?: MemoImageInput[];
  removeImageIds?: string[];
  /** 清空 Agent 结果总结。 */
  clearResult?: boolean;
};

export async function listMemoNotes(): Promise<MemoNote[]> {
  const response = await hostClient.request("memo.list", requireHost(), null, DEFAULT_TIMEOUT_MS);
  if (!response.ok) throw new Error(response.error?.message ?? "memo.list failed");
  return response.result.notes;
}

export async function createMemoNote(input: MemoCreateRequest): Promise<MemoNote> {
  const response = await hostClient.request("memo.create", requireHost(), input, IMAGE_TIMEOUT_MS);
  if (!response.ok) throw new Error(response.error?.message ?? "memo.create failed");
  return response.result.note;
}

export async function updateMemoNote(id: string, patch: MemoUpdateRequest): Promise<MemoNote> {
  const response = await hostClient.request(
    "memo.update",
    requireHost(),
    { id, patch },
    IMAGE_TIMEOUT_MS,
  );
  if (!response.ok) throw new Error(response.error?.message ?? "memo.update failed");
  return response.result.note;
}

export async function deleteMemoNote(id: string): Promise<void> {
  const response = await hostClient.request(
    "memo.delete",
    requireHost(),
    { id },
    DEFAULT_TIMEOUT_MS,
  );
  if (!response.ok) throw new Error(response.error?.message ?? "memo.delete failed");
}

/** 读取记录图片为 data URL（页面直接 <img src> 展示）。 */
export async function readMemoImageDataUrl(noteId: string, imageId: string): Promise<string> {
  const response = await hostClient.request(
    "memo.readImage",
    requireHost(),
    { noteId, imageId },
    DEFAULT_TIMEOUT_MS,
  );
  if (!response.ok) throw new Error(response.error?.message ?? "memo.readImage failed");
  return `data:${response.result.mediaType};base64,${response.result.dataBase64}`;
}

/** 云同步操作可能携带大量图片，走更长的超时。 */
const SYNC_TIMEOUT_MS = 300_000;

export async function getMemoSyncSettings(): Promise<MemoSyncSettings> {
  const response = await hostClient.request(
    "memo.getSyncConfig",
    requireHost(),
    null,
    DEFAULT_TIMEOUT_MS,
  );
  if (!response.ok) throw new Error(response.error?.message ?? "memo.getSyncConfig failed");
  return response.result.settings;
}

export async function setMemoSyncConfig(config: MemoSyncConfig): Promise<MemoSyncSettings> {
  const response = await hostClient.request(
    "memo.setSyncConfig",
    requireHost(),
    { settings: config },
    DEFAULT_TIMEOUT_MS,
  );
  if (!response.ok) throw new Error(response.error?.message ?? "memo.setSyncConfig failed");
  return response.result.settings;
}

export async function testMemoSync(
  config: MemoSyncConfig,
): Promise<{ ok: boolean; error: string | null }> {
  const response = await hostClient.request(
    "memo.testSync",
    requireHost(),
    { settings: config },
    30_000,
  );
  if (!response.ok) throw new Error(response.error?.message ?? "memo.testSync failed");
  return response.result;
}

export type MemoSyncStats = {
  uploadedNotes: number;
  uploadedImages: number;
  downloadedNotes: number;
  downloadedImages: number;
  bytes: number;
  at: number;
};

export async function syncMemoNow(): Promise<MemoSyncStats> {
  const response = await hostClient.request("memo.syncNow", requireHost(), null, SYNC_TIMEOUT_MS);
  if (!response.ok) throw new Error(response.error?.message ?? "memo.syncNow failed");
  return response.result;
}
