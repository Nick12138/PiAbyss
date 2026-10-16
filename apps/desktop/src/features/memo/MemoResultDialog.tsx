/**
 * Agent 完成总结弹窗：看总结、继续讨论、清空总结。唯一宿主是随行面板「方寸间」的右键菜单。
 *
 * 「继续讨论」不跳回产出总结的那条会话——用户本来就坐在小精灵会话中，直接把这条以引用
 * 胶囊放进输入框，所以那一步由调用方传 `onContinue`。
 * 清空总结是同一个 `memo.update { clearResult: true }`，连「再点一次确认」的状态也收在
 * 这里，宿主只需要在 `onCleared` 里刷新列表。
 *
 * 尺寸与编辑弹窗同一套：`max-w-2xl`（672px）+ `max-h-[min(860px,92vh)]` + `fillBody`。默认的
 * 512px 装 Markdown 总结太窄、也压不住长总结；`fillBody` 让标题与底部按钮钉住，滚动落在正文里，
 * 短总结仍按内容高度收着。
 */
import { useState } from "react";
import { ScrollText, Trash2 } from "lucide-react";
import type { MemoNote } from "@piabyss/protocol";
import { Dialog } from "../../components/Dialog";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { updateMemoNote } from "./memo-client";
import { formatMemoDateTime } from "./memo-model";
import { MemoMarkdown } from "./MemoMarkdown";

export function MemoResultDialog({
  note,
  onClose,
  onContinue,
  onCleared,
}: {
  note: MemoNote;
  onClose: () => void;
  onContinue: () => void;
  /** 清空成功后回调：调用方刷新列表（弹窗自己已经关了）。 */
  onCleared: () => void;
}) {
  const t = useT();
  const pushNotification = useAppStore((s) => s.pushNotification);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const result = note.result;
  if (!result) return null;

  async function clear() {
    if (!confirmingClear) {
      setConfirmingClear(true);
      return;
    }
    try {
      await updateMemoNote(note.id, { clearResult: true });
      onClose();
      onCleared();
    } catch (error) {
      pushNotification(
        `${t("memoResultClearFail")}: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  }

  return (
    <Dialog
      title={t("memoResultTitle")}
      icon={ScrollText}
      maxWidthClass="max-w-2xl"
      maxHeightClass="max-h-[min(860px,92vh)]"
      fillBody
      showCancel={false}
      showCloseIcon
      confirmLabel={t("memoActionContinue")}
      footerExtra={
        <button
          type="button"
          onClick={() => void clear()}
          title={t("memoResultClearHint")}
          aria-label={t("memoResultClearHint")}
          data-testid="memo-result-clear"
          className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-2.5 text-xs ${
            confirmingClear
              ? "border border-danger bg-danger/10 text-danger"
              : "border border-border text-muted hover:border-danger hover:text-danger"
          }`}
        >
          <Trash2 size={14} className="shrink-0" />
          <span>{confirmingClear ? t("memoActionDeleteConfirm") : t("memoResultClear")}</span>
        </button>
      }
      onCancel={onClose}
      onConfirm={onContinue}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 text-left">
        <div className="flex shrink-0 flex-wrap items-center gap-2 text-[11px] text-muted">
          <span>
            {t("memoResultFromSession", { name: result.sessionTitle ?? result.sessionId })}
          </span>
          <span>·</span>
          <span>{t("memoResultAt", { time: formatMemoDateTime(result.at) })}</span>
        </div>
        {/* 总结同为 Markdown 文本，与详情正文共用渲染器（查看态即渲染态）。
         * fillBody 之后滚动条落在这里：总结长就自己滚，弹窗不再整块跟着滚。 */}
        <div className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto break-words rounded-md border border-border bg-surface-overlay px-3 py-2.5 text-[13px] leading-relaxed text-foreground">
          <MemoMarkdown content={result.resultMd} />
        </div>
      </div>
    </Dialog>
  );
}
