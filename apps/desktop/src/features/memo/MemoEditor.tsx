/**
 * 备忘录编辑器的共用实现：状态模型（`EditorState`）+ 编辑视图（`MemoEditor`）+ 图片入库。
 *
 * 当初从 `MemoPage` 里搬出来是因为编辑入口不止一个；待办 · 速记页下线之后，剩下的唯一宿主是
 * 随行面板的 `MemoNoteDialog`（新建与编辑同一份，差别只在 `note` 给不给）。这一层因此
 * 只留弹窗要的那套形态：底部动作条、编写/预览、计划行。
 *
 * 分工边界：这一层只管**编辑器**（正文源码、工作区、截止/周期、待保存图片、✨整理），
 * 落盘归调用方——`saveMemoEditorNote` 拼一次 `memo.update` 的 patch，新建走 `memo.create`。
 * 窗口级拖拽监听、保存后的导航也留在弹窗宿主里。
 */
import { ArrowLeft, Check, ChevronDown, Eraser, Loader2, Sparkles, X } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import type { MemoNote, MemoRecurrence } from "@piabyss/protocol";
import { LightboxImage } from "../../components/ImageLightbox";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { optimizeMemo, updateMemoNote } from "./memo-client";
import { deriveTitle, extractTags, memoFullContentMd, pathBasename } from "./memo-model";
import { MemoMarkdown } from "./MemoMarkdown";
import { emptySchedule, MemoScheduleEditor } from "./MemoScheduleEditor";

/** 编辑器内图片：新上传的（保存时随请求上传）或已有图片的回显（existingId 非空）。 */
export type PendingImage = {
  key: string;
  fileName: string;
  mediaType: string;
  dataBase64: string;
  previewUrl: string;
  /** 已保存图片的 id：删除时记入 removedImageIds，保存时不重复上传。 */
  existingId?: string;
};

export type EditorState = {
  id: string | null;
  contentMd: string;
  workspaceHint: string;
  /** 计划：一次性截止时刻（epoch ms）；null = 无截止。 */
  dueAt: number | null;
  /** 计划：周期规则；null = 非周期记录。 */
  recurrence: MemoRecurrence | null;
  pendingImages: PendingImage[];
  removedImageIds: string[];
};

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** 可接受的图片 MIME 类型（也用于过滤粘贴/拖拽进来的非图片文件）。 */
const IMAGE_INPUT_TYPES = /image\/(png|jpeg|gif|webp|bmp|avif|svg\+xml)/;
/** 暂存图片的唯一键序号（粘贴的截图文件名可能重复）。 */
let pendingImageSeq = 0;

/** 新暂存图片的唯一键。 */
export function newImageKey(): string {
  pendingImageSeq += 1;
  return `img-${pendingImageSeq}`;
}

/** 粘贴的截图往往没有有意义的文件名，按 MIME 推断一个。 */
function imageFileName(file: File): string {
  if (file.name && /\.[a-z0-9]+$/i.test(file.name)) return file.name;
  const ext = file.type.split("/")[1]?.replace("svg+xml", "svg").replace("jpeg", "jpg");
  return `image.${ext || "png"}`;
}

/** 新建表单的初始状态。 */
export function newEditorState(cwd: string | null | undefined): EditorState {
  return {
    id: null,
    contentMd: "",
    workspaceHint: cwd ? pathBasename(cwd) : "",
    ...emptySchedule(),
    pendingImages: [],
    removedImageIds: [],
  };
}

/**
 * 从记录进入编辑态。`imageUrls` 是调用方已缓存的图片 data URL（键 `${noteId}:${imageId}`）；
 * 没缓存到的先给空串，由调用方补拉后回填。
 */
export function editorStateFromNote(
  note: MemoNote,
  imageUrls: Record<string, string>,
): EditorState {
  return {
    id: note.id,
    contentMd: memoFullContentMd(note),
    workspaceHint: note.workspaceHint ?? "",
    dueAt: note.dueAt,
    recurrence: note.recurrence,
    pendingImages: note.images.map((image) => ({
      key: `existing:${image.id}`,
      fileName: image.fileName,
      mediaType: image.mediaType,
      dataBase64: "",
      previewUrl: imageUrls[`${note.id}:${image.id}`] ?? "",
      existingId: image.id,
    })),
    removedImageIds: [],
  };
}

/**
 * 把文件读成待上传图片并追加进编辑器（粘贴/文件选择共用）。
 * 超限时对每个被拒文件回调一次，由调用方决定怎么提示（页面 notification）。
 */
/**
 * 编辑器状态的写入函数：弹窗的 setState 包一层再交给下面的 helper——这一层只管
 * 「有一条记录在编辑」的形态。
 */
export type EditorUpdater = (update: (current: EditorState) => EditorState) => void;

export function addEditorImages(
  files: File[],
  setEditor: EditorUpdater,
  onOversize: () => void,
): void {
  const valid = files.filter((file) => IMAGE_INPUT_TYPES.test(file.type));
  let remaining = valid.length;
  if (remaining === 0) return;
  const pending: PendingImage[] = [];
  for (const file of valid) {
    if (file.size > MAX_IMAGE_BYTES) {
      onOversize();
      remaining -= 1;
      continue;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      pending.push({
        key: newImageKey(),
        fileName: imageFileName(file),
        mediaType: file.type || "image/png",
        dataBase64: result.split(",")[1] ?? "",
        previewUrl: result,
      });
      remaining -= 1;
      if (remaining === 0 && pending.length > 0) {
        setEditor((current) => ({
          ...current,
          pendingImages: [...current.pendingImages, ...pending],
        }));
      }
    };
    reader.readAsDataURL(file);
  }
}

/** 删除编辑器里的图片：新上传的直接移除，已有图片同时记入 removedImageIds。 */
export function removeEditorImage(key: string, setEditor: EditorUpdater): void {
  setEditor((current) => {
    const target = current.pendingImages.find((image) => image.key === key);
    return {
      ...current,
      pendingImages: current.pendingImages.filter((image) => image.key !== key),
      removedImageIds:
        target?.existingId && !current.removedImageIds.includes(target.existingId)
          ? [...current.removedImageIds, target.existingId]
          : current.removedImageIds,
    };
  });
}

/**
 * 把编辑器内容落成一次 `memo.update`——编辑已有记录的唯一实现（新建走 `memo.create`）。
 *
 * 标题 = 正文首行、标签 = 正文内 `#xxx`，都在这里派生，调用方不用再拼一遍 patch。
 * 返回 null 表示「没保存」（新建态没有记录 id，或正文空到派生不出标题），
 * 调用方据此不刷新、不跳转。
 */
export async function saveMemoEditorNote(
  editor: EditorState,
  original: MemoNote | null,
): Promise<MemoNote | null> {
  if (editor.id === null) return null;
  const title = deriveTitle(editor.contentMd);
  if (!title) return null;
  return updateMemoNote(editor.id, {
    title,
    contentMd: editor.contentMd,
    tags: extractTags(editor.contentMd),
    workspaceHint: editor.workspaceHint.trim() || null,
    // 计划字段仅在真正变化时提交：否则仅改正文也会触发 nextDueAt 重算
    // （Host 侧更新 recurrence 时会以当前时刻滚动下一轮）。
    ...(original && original.dueAt !== editor.dueAt ? { dueAt: editor.dueAt } : {}),
    ...(original && JSON.stringify(original.recurrence) !== JSON.stringify(editor.recurrence)
      ? { recurrence: editor.recurrence }
      : {}),
    addImages: editor.pendingImages
      .filter((image) => image.existingId === undefined)
      .map(({ fileName, mediaType, dataBase64 }) => ({ fileName, mediaType, dataBase64 })),
    removeImageIds: editor.removedImageIds,
  });
}

/**
 * 工作区输入框：可自由手输 + 下拉选择（combobox）。
 * 聚焦或点右侧箭头展开选项浮层（portal，不被工具栏裁剪），点选回填；不匹配时直接保留手输内容。
 */
function WorkspaceCombobox({
  value,
  onChange,
  options,
  placeholder,
  ariaLabel,
  className = "",
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; current?: boolean }[];
  placeholder: string;
  ariaLabel: string;
  className?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<{
    left: number;
    minWidth: number;
    maxHeight: number;
    top?: number;
    bottom?: number;
  } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // 打开时定位浮层：默认向下展开，下方空间不足时向上翻转（用 bottom 定位避免两段式修正）。
  useLayoutEffect(() => {
    if (!open) return;
    const reposition = () => {
      const input = inputRef.current;
      if (!input) return;
      const rect = input.getBoundingClientRect();
      const gutter = 8;
      const below = Math.max(0, window.innerHeight - rect.bottom - gutter);
      const above = Math.max(0, rect.top - gutter);
      const opensUpward = below < 160 && above > below;
      const maxHeight = Math.max(1, Math.min(240, (opensUpward ? above : below) || 240));
      setMenuStyle(
        opensUpward
          ? {
              left: rect.left,
              minWidth: rect.width,
              maxHeight,
              bottom: window.innerHeight - rect.top + 4,
            }
          : { left: rect.left, minWidth: rect.width, maxHeight, top: rect.bottom + 4 },
      );
    };
    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open]);

  // 浮层打开时：点外部 / Escape 关闭。
  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!wrapRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const closeOnEscape = (event: DocumentEventMap["keydown"]) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      // 弹窗宿主（MemoNoteDialog）认 defaultPrevented：浮层吃下这次 Esc，别顺手把弹窗也关了。
      event.preventDefault();
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className={`relative min-w-0 ${className}`}>
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        placeholder={placeholder}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        autoComplete="off"
        spellCheck={false}
        className="h-8 w-full rounded-md border border-border bg-transparent pl-2.5 pr-7 text-[12px] outline-none placeholder:text-muted focus-visible:ring-2 focus-visible:ring-focus"
      />
      <button
        type="button"
        tabIndex={-1}
        aria-hidden
        className="absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted transition-colors hover:text-foreground"
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronDown size={13} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open &&
        menuStyle &&
        options.length > 0 &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            aria-label={ariaLabel}
            className="theme-floating-surface scrollbar-subtle fixed z-[100] max-w-[calc(100vw-16px)] overflow-y-auto overscroll-contain rounded-md border border-border bg-surface-raised py-1 shadow-lg"
            style={menuStyle}
          >
            {options.map((option) => {
              const isSelected = option.value.toLowerCase() === value.trim().toLowerCase();
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  // 阻止 pointerdown 抢走输入框焦点（否则点击选项时输入框先失焦）。
                  onPointerDown={(event) => event.preventDefault()}
                  className={`flex h-8 w-full items-center gap-1.5 whitespace-nowrap px-2.5 text-left text-xs transition-colors hover:bg-surface-overlay ${
                    isSelected ? "font-medium text-foreground" : "text-muted"
                  }`}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{option.value}</span>
                  {option.current && (
                    <span className="shrink-0 text-[10px] text-muted">
                      {t("memoWorkspaceCurrent")}
                    </span>
                  )}
                  {isSelected && <Check size={14} strokeWidth={2.5} className="shrink-0" />}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}

/** 编辑器（新建 / 编辑共用）。 */
export function MemoEditor({
  editor,
  saving,
  workspaceOptions,
  availableWorkspaces,
  onChange,
  onSave,
  onClear,
  onAddImages,
  onRemoveImage,
  dragOver = false,
  preview = false,
}: {
  editor: EditorState;
  saving: boolean;
  /** 工作区输入框的下拉选项（当前工作区 + 历史提示）。 */
  workspaceOptions: { value: string; current?: boolean }[];
  availableWorkspaces: { id: string; name: string }[];
  onChange: (next: EditorState) => void;
  onSave: () => void;
  /** 仅新建模式传入（清空未保存的正文与图片）；编辑已有记录与弹窗不传，按钮也不出现。 */
  onClear?: () => void;
  onAddImages: (files: File[]) => void;
  onRemoveImage: (key: string) => void;
  /** 外部文件拖到写字区上方（窗口级 `onDragDropEvent` 由弹窗宿主在打开期间接）。 */
  dragOver?: boolean;
  /** 预览态：正文区换成渲染后的 Markdown，工具栏与计划区照旧（编辑弹窗的「编写 / 预览」）。 */
  preview?: boolean;
}) {
  const t = useT();
  const [optimizing, setOptimizing] = useState(false);
  const [undoSnapshot, setUndoSnapshot] = useState<EditorState | null>(null);
  const canSave = editor.contentMd.trim().length > 0;
  const canClear =
    editor.id === null && (editor.contentMd.trim().length > 0 || editor.pendingImages.length > 0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /** 只拦截图片粘贴；文本粘贴走默认行为。 */
  function handlePaste(event: ClipboardEvent<HTMLDivElement>) {
    const files = [...event.clipboardData.items]
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)
      .filter((file) => IMAGE_INPUT_TYPES.test(file.type));
    if (files.length > 0) {
      event.preventDefault();
      setUndoSnapshot(null);
      onAddImages(files);
    }
  }

  function patch(partial: Partial<EditorState>) {
    setUndoSnapshot(null);
    onChange({ ...editor, ...partial });
  }

  async function runOptimization() {
    if (optimizing || !editor.contentMd.trim()) return;
    setOptimizing(true);
    const before = {
      ...editor,
      pendingImages: [...editor.pendingImages],
      removedImageIds: [...editor.removedImageIds],
    };
    try {
      const result = await optimizeMemo({
        contentMd: editor.contentMd,
        workspaceHint: editor.workspaceHint ? pathBasename(editor.workspaceHint) : null,
        workspaces: availableWorkspaces,
      });
      const chosenIndex = result.workspaceId?.startsWith("workspace-")
        ? Number(result.workspaceId.slice("workspace-".length))
        : -1;
      const chosen = Number.isInteger(chosenIndex)
        ? availableWorkspaces[chosenIndex]?.name
        : undefined;
      setUndoSnapshot(before);
      onChange({
        ...editor,
        contentMd: result.contentMd,
        ...(chosen ? { workspaceHint: chosen } : {}),
      });
    } catch (error) {
      useAppStore
        .getState()
        .pushNotification(
          `${t("memoOptimizeFailed")}: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
    } finally {
      setOptimizing(false);
    }
  }

  /** Ctrl+S / ⌘S 快捷保存：输入框（正文/工作区）聚焦时也能触发，拦截浏览器默认保存。 */
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (canSave && !saving) onSave();
    }
  }

  /**
   * 唯一的形态：底部动作条。工作区挪去和「计划 / 重复」同排，条上左边只剩 ✨整理与
   * 橡皮擦、右边只剩 ✓保存——退出只由头部的 ✕ 与 Esc 承担。
   */
  /** 写字区的内缩：贴齐弹窗内边距，外层的边距由弹窗给。 */
  const fieldPad = "px-0";
  /**
   * 正文区的高度交给 flex 分配——短到 84px 起，长到吃掉弹窗剩余高度为止，再长就自己滚
   * （头尾那两排因此永远留在视野里）。
   */
  const fieldBox = "min-h-[84px] flex-auto overflow-y-auto";

  const workspaceField = (
    <WorkspaceCombobox
      value={editor.workspaceHint}
      onChange={(value) => patch({ workspaceHint: value })}
      options={workspaceOptions}
      placeholder={t("memoFieldWorkspacePlaceholder")}
      ariaLabel={t("memoFieldWorkspace")}
      className="w-32 shrink-0"
    />
  );

  const optimizeField = undoSnapshot ? (
    <button
      type="button"
      onClick={() => {
        onChange(undoSnapshot);
        setUndoSnapshot(null);
      }}
      title={t("memoUndoOptimize")}
      aria-label={t("memoUndoOptimize")}
      className="flex h-8 shrink-0 items-center gap-1 rounded-md border border-border px-2 text-xs text-muted hover:bg-surface-overlay"
    >
      <ArrowLeft size={14} />
      {t("memoUndoOptimize")}
    </button>
  ) : (
    editor.contentMd.trim() && (
      <button
        type="button"
        onClick={() => void runOptimization()}
        disabled={optimizing}
        title={t("memoOptimize")}
        aria-label={t("memoOptimize")}
        className="flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-border px-2 text-xs text-accent hover:bg-surface-overlay disabled:opacity-50"
      >
        {optimizing ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
        {t("memoOptimize")}
      </button>
    )
  );

  const clearField = canClear && (
    <button
      type="button"
      onClick={() => {
        setUndoSnapshot(null);
        onClear?.();
      }}
      title={t("memoActionClearHint")}
      aria-label={t("memoActionClearHint")}
      data-testid="memo-editor-clear"
      className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border text-danger transition-colors hover:border-danger hover:bg-surface-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger"
    >
      <Eraser size={16} />
    </button>
  );

  const saveField = (
    <button
      type="button"
      onClick={onSave}
      disabled={saving || !canSave}
      title={t("memoActionSaveHint")}
      aria-label={t("memoActionSaveHint")}
      data-testid="memo-editor-save"
      className="flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-border px-2 text-xs text-success transition-colors hover:border-success hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-40"
    >
      {saving ? <Loader2 size={16} className="animate-spin" /> : <Check size={15} />}
      {t("memoActionSave")}
    </button>
  );

  const toolbar = (
    <div className="-mx-5 -mb-5 flex shrink-0 items-center gap-2 border-t border-border px-5 py-2.5">
      {optimizeField}
      {clearField}
      <div className="min-w-0 flex-1" />
      {saveField}
    </div>
  );

  const body = (
    <div
      className="flex min-h-0 flex-1 flex-col gap-3 py-3"
      onClick={(event) => {
        // 点击输入框下方的空白区域时，把焦点还给输入框（纸面化后输入框不再铺满）。
        if (event.target === event.currentTarget) textareaRef.current?.focus();
      }}
    >
      {preview ? (
        <div
          data-testid="memo-editor-preview"
          className={`scrollbar-subtle w-full break-words rounded-lg border border-dashed border-transparent ${fieldPad} ${fieldBox} py-2.5 text-[13px] leading-relaxed text-foreground`}
        >
          {editor.contentMd.trim() ? (
            <MemoMarkdown content={editor.contentMd} />
          ) : (
            <span className="text-muted">{t("memoFieldContentPlaceholder")}</span>
          )}
        </div>
      ) : (
        <textarea
          ref={textareaRef}
          value={editor.contentMd}
          onChange={(event) => patch({ contentMd: event.target.value })}
          placeholder={t("memoFieldContentPlaceholder")}
          aria-label={t("memoFieldContentPlaceholder")}
          rows={2}
          autoFocus={editor.id === null}
          className={`memo-editor-input scrollbar-subtle field-sizing-content w-full resize-none rounded-lg border border-dashed bg-transparent ${fieldPad} ${fieldBox} py-2.5 text-[13px] leading-relaxed outline-none caret-focus placeholder:text-muted ${
            dragOver ? "border-accent" : "border-transparent"
          }`}
        />
      )}

      {editor.pendingImages.length > 0 && (
        <div className="flex shrink-0 flex-wrap gap-2">
          {editor.pendingImages.map((image) => (
            <div key={image.key} className="group relative">
              {image.previewUrl ? (
                <LightboxImage
                  url={image.previewUrl}
                  alt={image.fileName}
                  className="size-14 rounded-md border border-border object-cover"
                />
              ) : (
                <div className="flex size-14 items-center justify-center rounded-md border border-border text-muted">
                  <Loader2 size={14} className="animate-spin" />
                </div>
              )}
              <button
                type="button"
                onClick={() => {
                  setUndoSnapshot(null);
                  onRemoveImage(image.key);
                }}
                aria-label={t("memoActionDelete")}
                className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full border border-border bg-background text-muted hover:text-destructive"
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      <MemoScheduleEditor
        value={{ dueAt: editor.dueAt, recurrence: editor.recurrence }}
        onChange={(next) => patch({ dueAt: next.dueAt, recurrence: next.recurrence })}
        leading={workspaceField}
      />
    </div>
  );

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="memo-editor"
      onPaste={handlePaste}
      onKeyDown={handleKeyDown}
    >
      {body}
      {toolbar}
    </div>
  );
}
