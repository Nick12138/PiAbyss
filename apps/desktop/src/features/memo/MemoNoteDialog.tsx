/**
 * 备忘录编辑弹窗：在随行面板「方寸间」里改一条记录，不用跳到方寸间页。
 *
 * 编辑实现仍然是 `MemoEditor` 那一份（正文源码 / 工作区 / 计划 / 图片 / ✨整理），
 * 弹窗只是换了个宿主：`toolbarPlacement="bottom"` 把控件挪成正文下方的动作条
 * （左 ✨整理记录、右 ✓保存，都带文字），工作区与「计划 / 重复」并成同一排，头部这一行只留
 * 「编写 / 预览」与 ✕；Ctrl+S 仍然直接落盘。`fillBody` 让头尾两排固定在视野里，只有
 * 正文自己滚。落盘走 `saveMemoEditorNote`——patch 的拼法（标题与标签从正文
 * 派生、计划字段仅在变化时提交）也只有一份。
 *
 * 图片只支持粘贴：方寸间页接的是 Tauri 窗口级 `onDragDropEvent`，两处同时挂会互相抢。
 */
import { useCallback, useEffect, useState } from "react";
import { StickyNote } from "lucide-react";
import type { MemoNote } from "@piabyss/protocol";
import { Dialog } from "../../components/Dialog";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { readMemoImageDataUrl } from "./memo-client";
import {
  addEditorImages,
  editorStateFromNote,
  type EditorState,
  MemoEditor,
  removeEditorImage,
  saveMemoEditorNote,
} from "./MemoEditor";

export function MemoNoteDialog({
  note,
  workspaceOptions,
  availableWorkspaces,
  onClose,
  onSaved,
}: {
  note: MemoNote;
  /** 工作区输入框的下拉选项（当前工作区 + 历史提示）。 */
  workspaceOptions: { value: string; current?: boolean }[];
  /** ✨整理用来挑工作区的候选（id 为 knownWorkspaces 的下标）。 */
  availableWorkspaces: { id: string; name: string }[];
  onClose: () => void;
  /** 保存成功后回调：调用方刷新列表并关掉弹窗。 */
  onSaved: () => void;
}) {
  const t = useT();
  const pushNotification = useAppStore((s) => s.pushNotification);
  const [editor, setEditor] = useState<EditorState>(() => editorStateFromNote(note, {}));
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(false);

  // 已有图片是先取 data URL 才看得见缩略图：与方寸间页同一套补拉，只是缓存活在自己这里。
  useEffect(() => {
    for (const image of note.images) {
      void readMemoImageDataUrl(note.id, image.id)
        .then((url) =>
          setEditor((current) =>
            current.id === note.id
              ? {
                  ...current,
                  pendingImages: current.pendingImages.map((entry) =>
                    entry.key === `existing:${image.id}` ? { ...entry, previewUrl: url } : entry,
                  ),
                }
              : current,
          ),
        )
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id, note.images.length]);

  const addImages = useCallback(
    (files: File[]) =>
      addEditorImages(files, setEditor, () => pushNotification(t("memoImageTooLarge"), "warning")),
    [pushNotification, t],
  );

  const handleSave = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      if (!(await saveMemoEditorNote(editor, note))) return;
      onSaved();
    } catch (error) {
      pushNotification(
        `${t("memoSaveFailed")}: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    } finally {
      setSaving(false);
    }
  }, [editor, note, onSaved, pushNotification, saving, t]);

  return (
    <Dialog
      title={t("memoDialogTitle")}
      icon={StickyNote}
      maxWidthClass="max-w-2xl"
      maxHeightClass="max-h-[min(860px,92vh)]"
      fillBody
      showCloseIcon
      hideActions
      confirmLabel={t("memoActionSave")}
      onCancel={onClose}
      onConfirm={() => void handleSave()}
      headerExtra={
        <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-surface-overlay p-0.5">
          {(
            [
              ["edit", "memoDialogModeEdit"],
              ["preview", "memoDialogModePreview"],
            ] as const
          ).map(([mode, labelKey]) => (
            <button
              key={mode}
              type="button"
              data-testid={`memo-dialog-mode-${mode}`}
              aria-pressed={preview === (mode === "preview")}
              className={`flex h-6 items-center rounded px-2 text-[11px] transition-colors focus-visible:outline-none ${
                preview === (mode === "preview")
                  ? "bg-surface-raised font-semibold text-foreground"
                  : "text-muted hover:text-foreground"
              }`}
              onClick={() => setPreview(mode === "preview")}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>
      }
    >
      <MemoEditor
        editor={editor}
        saving={saving}
        preview={preview}
        showBack={false}
        toolbarPlacement="bottom"
        workspaceOptions={workspaceOptions}
        availableWorkspaces={availableWorkspaces}
        onChange={setEditor}
        onSave={() => void handleSave()}
        onAddImages={addImages}
        onRemoveImage={(key) => removeEditorImage(key, setEditor)}
        onBack={onClose}
      />
    </Dialog>
  );
}
