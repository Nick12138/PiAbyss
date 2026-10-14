/**
 * 小精灵页期间的「之前工作区」记录 + 侧边栏「新会话」的小精灵分支。
 *
 * 进入小精灵页会把活动工作区临时切到 workspace/pixie（PixiePage 挂载时的
 * openSessionAcrossWorkspaces）；离开时由 PixiePage 的卸载清理恢复。侧边栏
 * 「新会话」按钮在小精灵页保持可见，但它的语义始终是「在普通工作区开新
 * 会话」：点击时先阻塞式切回进入小精灵前的工作区，再 session.create——
 * 绝不能在 pixie 工作区里直接建会话（那会造出一条多余的小精灵会话，并把
 * 「新会话」误落在小精灵语境里）。
 *
 * 记录放在模块级变量而不是 store：它只是 PixiePage 挂载/卸载之间的一次性
 * 交接数据，改它不该触发任何重渲（PixiePage 自己的恢复逻辑仍用局部 ref，
 * 这里只是给侧边栏按钮一面可读的镜子）。
 */
import { useAppStore } from "../../lib/stores/app-store";
import { activateWorkspaceAcrossWorkspaces } from "../../lib/bridge/session-navigation";
import { createNewSession } from "../../lib/commands/actions";

/** 进入小精灵页之前活动工作区的 canonicalCwd；null = 没有可回的工作区。 */
let previousWorkspaceCwd: string | null = null;

/** PixiePage 挂载锚定时记录；以最后一次调用为准。 */
export function rememberPixiePreviousWorkspace(cwd: string | null): void {
  previousWorkspaceCwd = cwd;
}

/** 侧边栏按钮读取：进入小精灵前的工作区（null = 未记录）。 */
export function getPixiePreviousWorkspace(): string | null {
  return previousWorkspaceCwd;
}

/** PixiePage 卸载时清掉，避免残留到下一次进入。 */
export function clearPixiePreviousWorkspace(): void {
  previousWorkspaceCwd = null;
}

/** 测试隔离：清掉模块级记录，避免用例之间互相污染。 */
export function resetPixiePreviousWorkspaceForTests(): void {
  previousWorkspaceCwd = null;
}

/**
 * 小精灵页里的「新会话」：作用于进入小精灵前的工作区。
 *
 * 目标工作区 = 进入前的工作区；冷启动直落小精灵页（没有记录）时退回
 * desktopSettings.lastWorkspace——App 从不把 pixie 页持久化为「最近位置」
 * （见 App.tsx persistRecentDesktopLocation 的 pixie 跳过），所以它一定是
 * 普通工作区。
 *
 * 切换用阻塞式（optimistic:false）：session.create 需要 serviceGraphLock
 * 释放后才能跑，与「切换后立即建会话」的备忘录执行路径同款约束。切回后
 * 再落回 chat 页并新建会话；PixiePage 卸载清理里的「恢复之前工作区」带
 * 同路径守卫（活动工作区已不是 pixie 就跳过），不会与这里竞争。
 *
 * blocked（连接/重hydrating 中）静默放弃；failed 的错误提示由激活路径
 * 自身上报（非 quiet），这里不重复报。
 */
export async function createNewSessionFromPixiePage(): Promise<boolean> {
  const app = useAppStore.getState();
  if (app.page !== "pixie") {
    // 非小精灵页不该走到这里；防御性退回普通路径。
    return createNewSession();
  }
  const target = previousWorkspaceCwd ?? app.desktopSettings?.lastWorkspace ?? null;
  if (!target) {
    // 极早期（无记录也无最近位置）：无处可回，宁可不建也不在 pixie 里误建。
    return false;
  }
  const outcome = await activateWorkspaceAcrossWorkspaces(target, { optimistic: false });
  if (outcome.status !== "opened" && outcome.status !== "already-active") {
    return false;
  }
  useAppStore.getState().setPage("chat");
  return createNewSession();
}
