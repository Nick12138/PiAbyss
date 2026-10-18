/**
 * 云同步状态的共享订阅层：
 * - 小精灵页顶栏那一个云同步图标是唯一挂载方，30s 轮询由它维持；
 * - 轮询发现 lastSyncAt 变化（后台 autoSync/启动同步刚发生）时广播
 *   MEMO_SYNCED_EVENT，随行面板「待办 · 速记」据此刷新列表。轮询只在有挂载者时活着
 *   （`stopPollingIfIdle`），所以顶栏这一处也是「同步落地有人播报」的前提。
 */
import { useEffect, useState } from "react";
import type { MemoSyncSettings } from "@piabyss/protocol";
import { getMemoSyncSettings } from "./memo-client";

/** 同步完成后广播的事件名（随行面板「待办 · 速记」监听后刷新列表）。 */
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
