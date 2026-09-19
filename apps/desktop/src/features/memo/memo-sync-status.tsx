/**
 * 云同步状态的共享订阅层：
 * - 多个组件（顶栏标题旁的状态点、云同步设置按钮等）共用同一个 30s 轮询；
 * - 轮询发现 lastSyncAt 变化（后台 autoSync/启动同步刚发生）时广播
 *   MEMO_SYNCED_EVENT，备忘录列表据此刷新。
 */
import { useEffect, useState } from "react";
import type { MemoSyncSettings } from "@piabyss/protocol";
import { getMemoSyncSettings } from "./memo-client";

/** 同步完成后广播的事件名（备忘录页监听后刷新列表）。 */
export const MEMO_SYNCED_EVENT = "piabyss:memo-synced";

type Listener = (settings: MemoSyncSettings | null) => void;

const listeners = new Set<Listener>();
let current: MemoSyncSettings | null = null;
let lastSeenSyncAt: number | null = null;
let timer: number | null = null;

function poll() {
  getMemoSyncSettings()
    .then((settings) => {
      current = settings;
      if (
        lastSeenSyncAt !== null &&
        settings.lastSyncAt !== null &&
        settings.lastSyncAt !== lastSeenSyncAt
      ) {
        window.dispatchEvent(new Event(MEMO_SYNCED_EVENT));
      }
      lastSeenSyncAt = settings.lastSyncAt;
      for (const listener of listeners) listener(settings);
    })
    .catch(() => {
      current = null;
      for (const listener of listeners) listener(null);
    });
}

function ensurePolling() {
  if (timer === null) {
    poll();
    timer = window.setInterval(poll, 30_000);
  }
}

function stopPollingIfIdle() {
  if (listeners.size === 0 && timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
}

/** 订阅共享的云同步状态（挂载者全部卸载后轮询自动停止）。 */
export function useMemoSyncStatus(): MemoSyncSettings | null {
  const [status, setStatus] = useState<MemoSyncSettings | null>(current);
  useEffect(() => {
    listeners.add(setStatus);
    ensurePolling();
    return () => {
      listeners.delete(setStatus);
      stopPollingIfIdle();
    };
  }, []);
  return status;
}

/** 同步动作完成后立即刷新共享状态（不等下一个 30s 周期）。 */
export function refreshMemoSyncStatus(): void {
  poll();
}

/** 状态点本体：灰=未配置/未同步，绿=最近同步成功，红=最近同步失败。 */
export function MemoSyncStatusDot() {
  const status = useMemoSyncStatus();
  const configured =
    status !== null &&
    status.accountId !== "" &&
    status.bucket !== "" &&
    status.accessKeyId !== "" &&
    status.secretAccessKey !== "";
  const dotClass =
    !configured || status?.lastSyncOk === null
      ? "bg-muted"
      : status?.lastSyncOk === true
        ? "bg-success"
        : "bg-danger";
  const stateKey = !configured
    ? "memoSyncDotDisabled"
    : status?.lastSyncOk === true
      ? "memoSyncDotOk"
      : status?.lastSyncOk === false
        ? "memoSyncDotFail"
        : "memoSyncDotNone";
  return (
    <span
      aria-hidden
      data-sync-state={stateKey}
      className={`size-2 shrink-0 rounded-full ${dotClass}`}
    />
  );
}
