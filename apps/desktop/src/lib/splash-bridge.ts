/**
 * 主窗口 ↔ 启动开屏小窗（splash）的通信。
 *
 * 主窗口负责两件事：
 *   1. 把 `resolveStartupStage` 算出的阶段实时推给开屏（Rust 只报得到
 *      `starting-host` 为止，之后的工作区 / 会话恢复只有前端知道）；
 *   2. bootstrap 全部完成后通知宿主交接——显示主窗口、关闭开屏。
 *
 * 两者都是 best-effort：浏览器里跑 Vite dev 时没有宿主，调用直接短路；
 * 真出错也不该影响主窗口自己的启动，所以调用方一律 `catch` 掉。
 */
import type { StartupStage } from "../app/StartupScreen";

async function invokeDesktop(command: string, args?: Record<string, unknown>): Promise<boolean> {
  const { invoke, isTauri } = await import("@tauri-apps/api/core");
  if (!isTauri()) return false;
  await invoke(command, args);
  return true;
}

/** 把当前启动阶段推给开屏小窗。 */
export async function reportSplashStage(stage: StartupStage): Promise<boolean> {
  return invokeDesktop("splash_stage", { stage });
}

/**
 * 通知宿主：bootstrap 完成，可以交接了。
 *
 * Rust 侧负责保底停留（≥3s）与「主窗口先上屏、开屏稍后退场」的顺序，
 * 所以这个调用返回时开屏可能才刚开始关闭——调用方不需要等它。
 */
export async function finishSplash(): Promise<boolean> {
  return invokeDesktop("splash_finish");
}
