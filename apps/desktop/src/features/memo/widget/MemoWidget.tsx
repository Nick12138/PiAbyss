/**
 * 备忘速记小窗（memo-widget）根组件。
 *
 * 独立于主窗口的轻量待办面板：
 *   - 顶部：拖拽区 + 标题 + 置顶开关 + 隐藏按钮；
 *   - 中部：未完成备忘（open / in_progress）列表，可标记完成、可跳回主窗口；
 *   - 底部：一行速记输入框（Enter 保存，Esc 隐藏窗口）。
 *
 * Host 连接：小窗拥有自己的 HostClient transport（同一 webview 进程内
 * `pi_host_send` 永远发往当前活跃路由，`pi-host-stdout` 为全局广播），
 * 每批请求前用 refreshActiveRoute() 同步路由，避免主窗口切换工作区后
 * 小窗收不到响应。备忘数据全部走 memo.* 协议，与主界面完全同源。
 */
import { Circle, CircleAlert, Lightbulb, ListChecks, Loader2, Monitor, Pin, Plus, StickyNote, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from "react";
import type { DesktopSettings, MemoNote, MemoNoteType } from "@piabyss/protocol";
import { hostClient } from "../../../lib/bridge/host-client";
import { createTauriTransport, refreshActiveRoute } from "../../../lib/bridge/tauri-transport";
import { useAppStore } from "../../../lib/stores/app-store";
import { useT } from "../../../lib/i18n/use-t";
import { createMemoNote, listMemoNotes, updateMemoNote } from "../memo-client";

/** 窗口几何（位置/大小）的持久化键（localStorage，同源跨窗口共享）。 */
const BOUNDS_STORAGE_KEY = "piabyss.memo-widget.bounds";
/** 存在模式（悬浮置顶 / 钉桌面）的持久化键。 */
const MODE_STORAGE_KEY = "piabyss.memo-widget.mode";
/** 小窗改动备忘后广播的事件名；主界面 MemoPage 监听后刷新列表。 */
const MEMO_NOTES_CHANGED_EVENT = "memo-notes-changed";
/** hello 重试间隔与上限（Host 冷启动时小窗可能先于 Host 就绪）。 */
const HELLO_RETRY_INTERVAL_MS = 2_000;
const HELLO_MAX_ATTEMPTS = 30;

type WidgetBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** 小窗存在模式：悬浮置顶 / 钉在桌面层（永远沉在普通窗口之下）。 */
type WidgetMode = "float" | "desktop";

const DEFAULT_MODE: WidgetMode = "float";

function readSavedMode(): WidgetMode {
  try {
    const raw = window.localStorage.getItem(MODE_STORAGE_KEY);
    return raw === "desktop" ? "desktop" : "float";
  } catch {
    return DEFAULT_MODE;
  }
}

function saveModeToStorage(mode: WidgetMode): void {
  try {
    window.localStorage.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    // 持久化失败不影响使用
  }
}

function readSavedBounds(): WidgetBounds | null {
  try {
    const raw = window.localStorage.getItem(BOUNDS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WidgetBounds>;
    if (
      typeof parsed.x !== "number" ||
      typeof parsed.y !== "number" ||
      typeof parsed.width !== "number" ||
      typeof parsed.height !== "number"
    ) {
      return null;
    }
    return { x: parsed.x, y: parsed.y, width: parsed.width, height: parsed.height };
  } catch {
    return null;
  }
}

function saveBoundsToStorage(bounds: WidgetBounds): void {
  try {
    window.localStorage.setItem(BOUNDS_STORAGE_KEY, JSON.stringify(bounds));
  } catch {
    // 持久化失败不影响使用
  }
}

function isOpenStatus(note: MemoNote): boolean {
  return note.status === "open" || note.status === "in_progress";
}

/** 广播备忘变更，让主界面的 MemoPage 保持最新。 */
async function emitNotesChanged(): Promise<void> {
  try {
    const { isTauri } = await import("@tauri-apps/api/core");
    if (!isTauri()) return;
    const { emit } = await import("@tauri-apps/api/event");
    await emit(MEMO_NOTES_CHANGED_EVENT, undefined);
  } catch {
    // 广播失败不影响小窗自身的操作结果
  }
}

async function isTauriRuntime(): Promise<boolean> {
  const { isTauri } = await import("@tauri-apps/api/core");
  return isTauri();
}

/** 小窗自身的 Host 连接生命周期：attach transport → hello（带重试）。 */
function useWidgetHost(): "connecting" | "ready" | "fatal" {
  const [phase, setPhase] = useState<"connecting" | "ready" | "fatal">("connecting");

  useEffect(() => {
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribeEvents: (() => void) | null = null;

    const helloWithRetry = async (attempt: number): Promise<void> => {
      if (disposed) return;
      try {
        await refreshActiveRoute();
        const status = await hostClient.hello();
        if (disposed) return;
        useAppStore.getState().setHost(status);
        setPhase("ready");
      } catch {
        if (disposed) return;
        if (attempt >= HELLO_MAX_ATTEMPTS) {
          setPhase("fatal");
          return;
        }
        retryTimer = setTimeout(() => void helloWithRetry(attempt + 1), HELLO_RETRY_INTERVAL_MS);
      }
    };

    void (async () => {
      const transport = await createTauriTransport();
      if (disposed) {
        transport.dispose?.();
        return;
      }
      hostClient.attach(transport);
      unsubscribeEvents = hostClient.onEvent((event) => {
        if (event.event === "host.ready") void helloWithRetry(0);
        else if (event.event === "host.fatal") setPhase("fatal");
      });
      void helloWithRetry(0);
    })();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      unsubscribeEvents?.();
      hostClient.detach("memo widget unmounted");
    };
  }, []);

  return phase;
}

/** 读取桌面设置（语言等），让小窗文案跟随主界面语言偏好。 */
function useDesktopSettingsBootstrap(): void {
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (!(await isTauriRuntime())) return;
        const { invoke } = await import("@tauri-apps/api/core");
        const snapshot = await invoke<{ settings: DesktopSettings }>("desktop_settings_get");
        if (!cancelled && snapshot?.settings) {
          useAppStore.getState().setDesktopSettings(snapshot.settings);
        }
      } catch {
        // 语言回退到系统 locale
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
}

/** 窗口几何持久化：恢复位置/大小/模式，之后跟随移动/缩放自动保存。 */
function useWindowBounds(onModeRestored: (mode: WidgetMode) => void): boolean {
  const restoredCallbackRef = useRef(onModeRestored);
  restoredCallbackRef.current = onModeRestored;
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    let unlistenMoved: (() => void) | undefined;
    let unlistenResized: (() => void) | undefined;
    let saveTimer: ReturnType<typeof setTimeout> | null = null;

    void (async () => {
      try {
        if (!(await isTauriRuntime())) {
          setRestored(true);
          return;
        }
        const [{ invoke }, { getCurrentWindow }, { LogicalPosition, LogicalSize }] =
          await Promise.all([
            import("@tauri-apps/api/core"),
            import("@tauri-apps/api/window"),
            import("@tauri-apps/api/dpi"),
          ]);
        const win = getCurrentWindow();

        const saved = readSavedBounds();
        if (saved) {
          await win.setPosition(new LogicalPosition(saved.x, saved.y)).catch(() => undefined);
          await win.setSize(new LogicalSize(saved.width, saved.height)).catch(() => undefined);
        }
        // 恢复上次的模式（悬浮置顶 / 钉桌面）；Rust 命令同时处理两层的 z-order。
        const savedMode = readSavedMode();
        await invoke("memo_widget_set_mode", { mode: savedMode }).catch(() => undefined);
        restoredCallbackRef.current(savedMode);

        // 首次创建流程：Rust 以隐藏状态建窗，前端恢复几何后再显示，
        // 避免窗口在默认位置闪跳。
        await invoke("memo_widget_show").catch(() => undefined);
        setRestored(true);

        const saveNow = async (): Promise<void> => {
          const [position, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
          saveBoundsToStorage({
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
          });
        };
        const scheduleSave = (): void => {
          if (saveTimer) clearTimeout(saveTimer);
          saveTimer = setTimeout(() => void saveNow().catch(() => undefined), 500);
        };

        unlistenMoved = await win.onMoved(scheduleSave);
        unlistenResized = await win.onResized(scheduleSave);
      } catch {
        setRestored(true);
      }
    })();

    return () => {
      if (saveTimer) clearTimeout(saveTimer);
      unlistenMoved?.();
      unlistenResized?.();
    };
  }, []);

  return restored;
}

const TYPE_ICONS: Record<MemoNoteType, typeof StickyNote> = {
  memo: StickyNote,
  idea: Lightbulb,
  task: ListChecks,
};

export function MemoWidget(): JSX.Element {
  const t = useT();
  const [mode, setMode] = useState<WidgetMode>(DEFAULT_MODE);
  const phase = useWidgetHost();
  useDesktopSettingsBootstrap();
  useWindowBounds(setMode);

  const [notes, setNotes] = useState<MemoNote[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      await refreshActiveRoute();
      const loaded = await listMemoNotes();
      setNotes(
        loaded
          .filter(isOpenStatus)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, 100),
      );
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  // 就绪后立即拉取；每次窗口获得焦点也刷新一次（主界面可能已改动）。
  useEffect(() => {
    if (phase !== "ready") return;
    void refresh();
  }, [phase, refresh]);

  useEffect(() => {
    if (phase !== "ready") return;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        if (!(await isTauriRuntime())) return;
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        unlisten = await getCurrentWindow().onFocusChanged(({ payload }) => {
          if (payload) {
            void refresh();
            inputRef.current?.focus();
          }
        });
      } catch {
        // 非关键路径
      }
    })();
    return () => unlisten?.();
  }, [phase, refresh]);

  const hideWindow = useCallback(async (): Promise<void> => {
    try {
      if (!(await isTauriRuntime())) return;
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("memo_widget_hide");
    } catch {
      // ignore
    }
  }, []);

  const openMainMemo = useCallback(async (): Promise<void> => {
    try {
      if (!(await isTauriRuntime())) return;
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("memo_widget_show_main");
    } catch {
      // ignore
    }
  }, []);

  const toggleMode = useCallback(async (): Promise<void> => {
    const next: WidgetMode = mode === "float" ? "desktop" : "float";
    const previous = mode;
    setMode(next);
    try {
      if (!(await isTauriRuntime())) return;
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("memo_widget_set_mode", { mode: next });
      saveModeToStorage(next);
    } catch {
      setMode(previous);
    }
  }, [mode]);

  const submitDraft = useCallback(async (): Promise<void> => {
    const text = draft.trim();
    if (!text || creating) return;
    setCreating(true);
    try {
      await refreshActiveRoute();
      await createMemoNote({ type: "memo", title: text, contentMd: text });
      setDraft("");
      void emitNotesChanged();
      await refresh();
    } catch (error) {
      setLoadError(`${t("memoWidgetCreateFailed")}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setCreating(false);
      inputRef.current?.focus();
    }
  }, [creating, draft, refresh, t]);

  const completeNote = useCallback(
    async (id: string): Promise<void> => {
      // 乐观更新：先从列表移除，失败再拉全量回滚。
      setNotes((prev) => prev?.filter((note) => note.id !== id) ?? prev);
      try {
        await refreshActiveRoute();
        await updateMemoNote(id, { status: "done" });
        void emitNotesChanged();
      } catch {
        void refresh();
      }
    },
    [refresh],
  );

  const onInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        void hideWindow();
      }
    },
    [hideWindow],
  );

  return (
    <div className="flex h-full flex-col bg-surface text-foreground">
      <div
        data-tauri-drag-region
        className="flex h-10 shrink-0 select-none items-center gap-2 border-b border-border px-3"
      >
        <StickyNote className="size-4 shrink-0 text-accent" />
        <h1 className="truncate text-sm font-semibold">{t("memoWidgetTitle")}</h1>
        {notes !== null && notes.length > 0 && (
          <span className="shrink-0 text-xs text-muted">
            {t("memoWidgetCount", { count: notes.length })}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => void toggleMode()}
            title={mode === "float" ? t("memoWidgetSwitchToDesktop") : t("memoWidgetSwitchToFloat")}
            aria-label={mode === "float" ? t("memoWidgetSwitchToDesktop") : t("memoWidgetSwitchToFloat")}
            className="rounded p-1.5 text-muted transition-colors hover:bg-surface-overlay hover:text-foreground"
          >
            {mode === "float" ? <Pin className="size-3.5" /> : <Monitor className="size-3.5" />}
          </button>
          <button
            type="button"
            onClick={() => void hideWindow()}
            title={t("memoWidgetHide")}
            aria-label={t("memoWidgetHide")}
            className="rounded p-1.5 text-muted transition-colors hover:bg-surface-overlay hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>

      {phase !== "ready" ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          {phase === "fatal" ? (
            <CircleAlert className="size-6 text-red-400" />
          ) : (
            <Loader2 className="size-5 animate-spin text-muted" />
          )}
          <p className="text-sm font-medium">{t("memoWidgetHostNotReady")}</p>
          <p className="text-xs leading-5 text-muted">{t("memoWidgetHostNotReadyHint")}</p>
        </div>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {loadError && (
              <div className="flex items-start gap-2 border-b border-border px-3 py-2 text-xs text-red-400">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0 break-words">
                  {t("memoWidgetLoadFailed")}: {loadError}
                </span>
                <button
                  type="button"
                  onClick={() => void refresh()}
                  className="ml-auto shrink-0 underline underline-offset-2 hover:text-foreground"
                >
                  {t("commonRetry")}
                </button>
              </div>
            )}
            {notes === null ? (
              <div className="flex items-center justify-center py-10">
                <Loader2 className="size-5 animate-spin text-muted" />
              </div>
            ) : notes.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-1.5 px-6 py-10 text-center">
                <StickyNote className="size-6 text-muted" />
                <p className="text-sm font-medium">{t("memoWidgetEmpty")}</p>
                <p className="text-xs leading-5 text-muted">{t("memoWidgetEmptyHint")}</p>
              </div>
            ) : (
              <ul className="divide-y divide-border-subtle">
                {notes.map((note) => {
                  const TypeIcon = TYPE_ICONS[note.type] ?? StickyNote;
                  return (
                    <li key={note.id} className="group flex items-start gap-2.5 px-3 py-2.5 hover:bg-surface-raised">
                      <button
                        type="button"
                        onClick={() => void completeNote(note.id)}
                        title={t("memoWidgetComplete")}
                        aria-label={t("memoWidgetComplete")}
                        className="mt-0.5 shrink-0 rounded-full p-0.5 text-muted transition-colors hover:text-accent"
                      >
                        <Circle className="size-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void openMainMemo()}
                        title={t("memoWidgetOpenApp")}
                        className="min-w-0 flex-1 text-left"
                      >
                        <div className="truncate text-sm leading-5">{note.title || note.contentMd}</div>
                        <div className="mt-0.5 flex items-center gap-2 text-xs text-muted">
                          <TypeIcon className="size-3 shrink-0" />
                          {note.status === "in_progress" && (
                            <span className="shrink-0 rounded-xs bg-surface-overlay px-1 py-px text-[10px]">
                              {t("memoFilterInProgress")}
                            </span>
                          )}
                          {note.workspaceHint && (
                            <span className="truncate">{note.workspaceHint}</span>
                          )}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <form
            className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-2.5"
            onSubmit={(event) => {
              event.preventDefault();
              void submitDraft();
            }}
          >
            <Plus className="size-4 shrink-0 text-muted" />
            <input
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onInputKeyDown}
              // biome-ignore lint/a11y/noAutofocus: 速记小窗的核心交互就是即开即输。
              autoFocus
              placeholder={t("memoWidgetInputPlaceholder")}
              className="w-full bg-transparent text-sm leading-5 outline-none placeholder:text-muted"
            />
            {creating && <Loader2 className="size-4 shrink-0 animate-spin text-muted" />}
          </form>
        </>
      )}
    </div>
  );
}
