/**
 * 备忘录编辑弹窗：随行面板「方寸间」里改一条记录、或新建一条，都在这里完成。
 *
 * 编辑实现仍然是 `MemoEditor` 那一份（正文源码 / 工作区 / 计划 / 图片 / ✨整理），
 * 弹窗只是换了个宿主：控件排成正文下方的动作条
 * （左 ✨整理记录、右 ✓保存，都带文字），工作区与「计划 / 重复」并成同一排，头部这一行只留
 * 「编写 / 预览」与 ✕；Ctrl+S 仍然直接落盘。`fillBody` 让头尾两排固定在视野里，只有
 * 正文自己滚。落盘走 `saveMemoEditorNote`——patch 的拼法（标题与标签从正文
 * 派生、计划字段仅在变化时提交）也只有一份。
 *
 * `note` 传 null 就是**新建**：初始状态来自 `newEditorState`，保存走 `memo.create`
 * （含待保存图片与周期），橡皮擦清空也在这一档出现。面板的 ＋ 直接开这一档——
 * 行内那个只能填「标题 / 截止 / 标签 / 工作区」的小表单能表达的信息这一份全都能表达，
 * 留两个入口只是让人纠结点哪个。
 *
 * 图片支持粘贴与**外部文件拖入**：拖的是文件路径，走对话输入框同款 Rust 读取命令
 * （`desktop_read_small_file`）拿嗅探后的图片字节。窗口级 `onDragDropEvent` 只挂在弹窗
 * 打开期间——同一条通道不能两个宿主同时接。
 */
import { useCallback, useEffect, useState } from "react";
import { StickyNote } from "lucide-react";
import type { MemoNote } from "@piabyss/protocol";
import { Dialog } from "../../components/Dialog";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { isDesktopRuntime, readDesktopSmallFile } from "../../lib/desktop-file-access";
import { claimDesktopFileDrop } from "../../lib/desktop-file-drop";
import { createMemoNote, readMemoImageDataUrl } from "./memo-client";
import { deriveTitle, extractTags, pathBasename } from "./memo-model";
import {
  addEditorImages,
  editorStateFromNote,
  type EditorState,
  MemoEditor,
  newEditorState,
  newImageKey,
  type PendingImage,
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
  /** 要编辑的记录；null = 新建一条。 */
  note: MemoNote | null;
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
  const [editor, setEditor] = useState<EditorState>(() =>
    note
      ? editorStateFromNote(note, {})
      : newEditorState(useAppStore.getState().workspace?.canonicalCwd),
  );
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // 已有图片要先取成 data URL 才看得见缩略图：按 noteId:imageId 现取，缓存活在这里。
  useEffect(() => {
    if (!note) return;
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
  }, [note?.id, note?.images.length]);

  const addImages = useCallback(
    (files: File[]) =>
      addEditorImages(files, setEditor, () => pushNotification(t("memoImageTooLarge"), "warning")),
    [pushNotification, t],
  );

  /**
   * 拖拽落下的文件路径：非图片忽略并提示。图片按 MIME 造一条待保存记录，
   * 与粘贴进来的走同一个数组。
   */
  const addDroppedPaths = useCallback(
    async (paths: readonly string[]) => {
      for (const path of paths) {
        try {
          const info = await readDesktopSmallFile(path);
          if (info.kind !== "image") {
            pushNotification(t("memoDropIgnored", { name: info.name }), "warning");
            continue;
          }
          const pending: PendingImage = {
            key: newImageKey(),
            fileName: info.name,
            mediaType: info.mediaType,
            dataBase64: info.data,
            previewUrl: `data:${info.mediaType};base64,${info.data}`,
          };
          setEditor((current) => ({
            ...current,
            pendingImages: [...current.pendingImages, pending],
          }));
        } catch (error) {
          pushNotification(
            `${t("memoDropIgnored", { name: pathBasename(path) })}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            "warning",
          );
        }
      }
    },
    [pushNotification, t],
  );

  // Tauri 在窗口层接管了系统文件拖拽（dragDropEnabled: true），DOM 拖拽事件收不到
  // 外部文件；对话输入框也挂在这条通道上（小精灵页就在背后），所以挂载期间先**认领**
  // 它（`lib/desktop-file-drop`），退出弹窗再把通道还回去——否则拖一张图进去会既进
  // 这条记录又进输入框的附件区。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    const release = claimDesktopFileDrop();
    void isDesktopRuntime()
      .then(async (isDesktop) => {
        if (!isDesktop || cancelled) return;
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        unlisten = await getCurrentWebview().onDragDropEvent((event) => {
          if (cancelled) return;
          if (event.payload.type === "enter" || event.payload.type === "over") {
            setDragOver(true);
          } else if (event.payload.type === "leave") {
            setDragOver(false);
          } else if (event.payload.type === "drop") {
            setDragOver(false);
            void addDroppedPaths(event.payload.paths);
          }
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
      release();
    };
  }, [addDroppedPaths]);

  const handleSave = useCallback(async () => {
    if (saving) return;
    const title = deriveTitle(editor.contentMd);
    // 标题从正文首行派生：正文空到派生不出标题就不算一条记录，直接不动。
    if (!title) return;
    setSaving(true);
    try {
      if (note === null) {
        await createMemoNote({
          title,
          contentMd: editor.contentMd,
          tags: extractTags(editor.contentMd),
          workspaceHint: editor.workspaceHint.trim() || null,
          dueAt: editor.dueAt,
          recurrence: editor.recurrence,
          images: editor.pendingImages
            .filter((image) => image.existingId === undefined)
            .map(({ fileName, mediaType, dataBase64 }) => ({ fileName, mediaType, dataBase64 })),
        });
      } else if (!(await saveMemoEditorNote(editor, note))) {
        return;
      }
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
      title={note === null ? t("memoDialogCreateTitle") : t("memoDialogTitle")}
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
        dragOver={dragOver}
        workspaceOptions={workspaceOptions}
        availableWorkspaces={availableWorkspaces}
        onChange={setEditor}
        onSave={() => void handleSave()}
        onClear={
          note === null
            ? () => setEditor(newEditorState(useAppStore.getState().workspace?.canonicalCwd))
            : undefined
        }
        onAddImages={addImages}
        onRemoveImage={(key) => removeEditorImage(key, setEditor)}
      />
    </Dialog>
  );
}
