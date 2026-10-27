/**
 * 备忘录协议客户端：桌面端 → pi-host 的 memo.* 请求封装。
 * Host 上下文取自 app store（备忘录是全局数据，不走会话/工作区上下文）。
 * 云同步由 pi-memo 插件自持：这里只保留状态读取 / 连接测试 / 立即同步，
 * R2 密钥在「设置 → 插件 → PiAbyss 备忘录」里配置，不再走协议层。
 */
import type {
  MemoImageInput,
  MemoNote,
  MemoNoteStatus,
  MemoRecurrence,
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

export type MemoOptimizeRequest = {
  contentMd: string;
  workspaceHint: string | null;
  workspaces: Array<{ id: string; name: string }>;
};

export type MemoOptimizeResult = {
  contentMd: string;
  workspaceId: string | null;
};

export async function optimizeMemo(input: MemoOptimizeRequest): Promise<MemoOptimizeResult> {
  const response = await hostClient.request("memo.optimize", requireHost(), input, null);
  if (!response.ok) throw new Error(response.error?.message ?? "memo.optimize failed");
  return response.result;
}

export type MemoCreateRequest = {
  title: string;
  contentMd: string;
  tags?: string[];
  workspaceHint?: string | null;
  images?: MemoImageInput[];
  /** 一次性截止时刻（epoch ms）。 */
  dueAt?: number | null;
  /** 周期规则；null/缺省 = 非周期记录（停用周期）。 */
  recurrence?: MemoRecurrence | null;
};

export type MemoUpdateRequest = {
  title?: string;
  contentMd?: string;
  status?: MemoNoteStatus;
  sessionId?: string | null;
  tags?: string[];
  workspaceHint?: string | null;
  addImages?: MemoImageInput[];
  removeImageIds?: string[];
  /** 清空 Agent 结果总结。 */
  clearResult?: boolean;
  /** 一次性截止时刻（epoch ms）；null = 清除截止。 */
  dueAt?: number | null;
  /** 周期规则；null = 清除周期（停用，转普通记录）。 */
  recurrence?: MemoRecurrence | null;
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

/**
 * 完成一条记录（桌面端「完成 / 完成本轮」按钮）。
 * 周期记录由 Host 滚动到下一轮（status 保持 open），非周期记录置 done；
 * 与 `memo.update { status: "done" }` 不同，对周期记录不会报错。
 */
export async function completeMemoNote(id: string): Promise<MemoNote> {
  const response = await hostClient.request(
    "memo.complete",
    requireHost(),
    { id },
    DEFAULT_TIMEOUT_MS,
  );
  if (!response.ok) throw new Error(response.error?.message ?? "memo.complete failed");
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

/** 同步状态（密钥不回传：只报 configured 与 lastSync*）。 */
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

/** 用插件当前保存的配置测一次 R2 连通性（配置在设置的插件配置里管理）。 */
export async function testMemoSync(): Promise<{ ok: boolean; error: string | null }> {
  const response = await hostClient.request("memo.testSync", requireHost(), null, 30_000);
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
