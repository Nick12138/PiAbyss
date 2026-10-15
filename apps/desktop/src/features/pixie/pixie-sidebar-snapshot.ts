/**
 * 小精灵页的侧边栏冻结快照。
 *
 * 进入小精灵页会把活动工作区临时切到 workspace/pixie，app-store 的会话
 * 目录也会随 pixie 会话快照重建（upsertSessionSnapshot 换 workspaceId
 * 即整目录替换）——侧边栏会话列表若照常渲染，就会变成「小精灵会话列表」。
 * 需求（Nick）恰恰相反：选中小精灵时，侧边栏保持进入前的样子——上一个
 * 工作区的会话列表仍可见、上一个会话仍带选中态。
 *
 * 因此 PixiePage 挂载锚定时把「当时的工作区快照 + 会话目录 + 选中会话」
 * 冻结进本 store，小精灵页期间侧边栏 SessionList 以 frozen 模式渲染这份
 * 快照；点击某条会话 = 离开小精灵、切回该工作区并打开它。冻结期间不刷新
 * 目录、禁用一切会话 RPC（改名/归档/删除/导出），避免把请求打着 pixie
 * 工作区的上下文发出去。
 *
 * 条目对象在目录层都是不可变替换（replace/update 均产新对象），所以浅拷
 * 数组即安全快照；workspace 快照同理（app-store 的 setWorkspace 整体换
 * 引用）。
 */
import { create } from "zustand";
import type { WorkspaceSnapshot } from "@piabyss/protocol";
import type { SessionCatalogEntry } from "../../lib/stores/session-catalog";

type PixieSidebarSnapshot = {
  /** 进入小精灵前的工作区快照（列表归属 + pinned/终端标记的 workspaceId 键）。 */
  workspace: WorkspaceSnapshot;
  /** 进入小精灵前的会话目录（按目录排序原样冻结）。 */
  items: SessionCatalogEntry[];
  /** 进入小精灵时选中的会话；冻结期间该行保持选中态。 */
  activeSessionId: string | null;
};

type PixieSidebarSnapshotState = {
  snapshot: PixieSidebarSnapshot | null;
  /** PixiePage 挂载锚定时捕获；以最后一次调用为准。 */
  capture: (snapshot: PixieSidebarSnapshot) => void;
  /** PixiePage 卸载时清除，避免残留到下一次进入。 */
  clear: () => void;
};

export const usePixieSidebarSnapshot = create<PixieSidebarSnapshotState>((set) => ({
  snapshot: null,
  capture: (snapshot) => set({ snapshot }),
  clear: () => set({ snapshot: null }),
}));

/** 测试隔离：清掉冻结快照，避免用例之间互相污染。 */
export function resetPixieSidebarSnapshotForTests(): void {
  usePixieSidebarSnapshot.getState().clear();
}
