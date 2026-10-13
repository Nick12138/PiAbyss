/**
 * PixieSessionsButton — 小精灵页自己的会话列表入口（顶栏 pixie 动作区）。
 *
 * 会话列表不再出现在侧边栏底部（那里会和顶栏 pixie 入口的选中态叠出
 * “双选中”的怪异感）：入口收进小精灵页面，点击弹窗内嵌标准 SessionList
 * （当前工作区就是 pixie 工作区，keepPage 留在 pixie 页完成选择与切换）。
 * 选中一条会话后弹窗自动收起，转写区随即切到该会话。
 *
 * 弹窗头部：列表自身的“最近会话”标题行隐藏（hideHeader），“新建会话”
 * 按钮挂在 Dialog 头部、关闭按钮左边。
 */
import { useEffect, useState } from "react";
import { MessagesSquare, Plus } from "lucide-react";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { Dialog } from "../../components/Dialog";
import { SessionList } from "../sessions/SessionList";
import {
  createNewSession,
  isCreateSessionPending,
  subscribeCreateSessionPending,
} from "../../lib/commands/actions";

export function PixieSessionsButton() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const hostReady = useAppStore((s) => s.host !== null);
  const servicesReady = useAppStore((s) => s.workspace?.servicesReady ?? false);
  const [createPending, setCreatePending] = useState(isCreateSessionPending);
  useEffect(() => subscribeCreateSessionPending(setCreatePending), []);

  return (
    <>
      <button
        type="button"
        data-testid="pixie-sessions-button"
        className="flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted transition-colors hover:border-primary/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        disabled={!hostReady}
        title={t("pixieSessionsTitle")}
        aria-label={t("pixieSessionsTitle")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <MessagesSquare size={11} />
        {t("pixieSessionsButton")}
      </button>
      {open && (
        <Dialog
          title={t("pixieSessionsTitle")}
          confirmLabel={t("commonClose")}
          hideActions
          showCloseIcon
          maxWidthClass="max-w-md"
          headerExtra={
            <button
              type="button"
              data-testid="pixie-new-session-button"
              className="mr-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!hostReady || !servicesReady || createPending}
              title={t("sessionsNew")}
              aria-label={t("sessionsNew")}
              onClick={() => {
                void createNewSession();
                setOpen(false);
              }}
            >
              <Plus size={16} />
            </button>
          }
          onCancel={() => setOpen(false)}
          onConfirm={() => setOpen(false)}
        >
          {/* 弹窗内嵌标准会话列表：当前工作区就是 pixie 工作区，直接复用。
              flatByDate：不分组、纯日期倒序、行内显示日期；
              hideHeader：列表不再带“最近会话”标题行（新建在弹窗头部）。 */}
          <div className="-mx-1 max-h-[60vh] overflow-y-auto px-1">
            <SessionList keepPage flatByDate hideHeader onSessionOpened={() => setOpen(false)} />
          </div>
        </Dialog>
      )}
    </>
  );
}
