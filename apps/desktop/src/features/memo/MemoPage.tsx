/**
 * 备忘录页：主对话区内的一个常驻视图（遵守「单界面、不叠覆盖层」原则）。
 *
 * 布局：工具栏（状态归类页签 + 搜索 + 标签/工作区筛选 + 新建）
 *       宽屏（容器 ≥ @2xl/672px）左列表（卡片摘要）+ 右详情（查看/编辑一体）；
 *       窄屏自动切单栏：列表与详情互斥显示，详情左上角返回列表。
 * 数据全部经 pi-host 的 memo.* 协议方法落盘（v1 纯本地）。
 */
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Bot,
  Check,
  CheckCircle2,
  Circle,
  CircleAlert,
  Lightbulb,
  ListChecks,
  Loader2,
  Pencil,
  Plus,
  ScrollText,
  StickyNote,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type ReactNode,
} from "react";
import type { MemoNote, MemoNoteStatus, MemoNoteType } from "@piabyss/protocol";
import { Dialog, primaryButton, secondaryButton } from "../../components/Dialog";
import { LightboxImage } from "../../components/ImageLightbox";
import { Select } from "../../components/Select";
import { useT, type Translate } from "../../lib/i18n/use-t";
import { draftKeyForTarget, draftTargetFor } from "../../lib/draft-target";
import { isDesktopRuntime, readDesktopSmallFile } from "../../lib/desktop-file-access";
import { useContainerWide } from "../../lib/use-container-wide";
import { openSessionAcrossWorkspaces } from "../../lib/bridge/session-navigation";
import { createNewSession } from "../../lib/commands/actions";
import { useAppStore } from "../../lib/stores/app-store";
import {
  createMemoNote,
  deleteMemoNote,
  listMemoNotes,
  readMemoImageDataUrl,
  updateMemoNote,
} from "./memo-client";
import { MEMO_SYNCED_EVENT } from "./memo-sync-status";
import {
  collectTags,
  collectWorkspaces,
  composeMemoPrompt,
  composeMemoResultSection,
  deriveTitle,
  extractTags,
  filterNotes,
  formatMemoDateTime,
  noteExcerpt,
  pathBasename,
  sortNotesForList,
  statusCounts,
  tagHue,
  withMemoPrompt,
  workspaceMismatch,
  type MemoStatusFilter,
} from "./memo-model";

const STATUS_TABS: readonly MemoStatusFilter[] = ["open", "done", "archived"];

const TYPE_OPTIONS: readonly MemoNoteType[] = ["memo", "idea", "task"];

const TYPE_ICONS: Record<MemoNoteType, LucideIcon> = {
  memo: StickyNote,
  idea: Lightbulb,
  task: ListChecks,
};

/** 下拉选项/触发器共用：图标 + 文本。 */
function typeOptionLabel(type: MemoNoteType, t: Translate): ReactNode {
  const Icon = TYPE_ICONS[type];
  return (
    <span className="flex items-center gap-1.5">
      <Icon size={13} className="shrink-0 text-muted" aria-hidden />
      <span className="truncate">{memoTypeLabel(type, t)}</span>
    </span>
  );
}

/** 编辑器内图片：新上传的（保存时随请求上传）或已有图片的回显（existingId 非空）。 */
type PendingImage = {
  key: string;
  fileName: string;
  mediaType: string;
  dataBase64: string;
  previewUrl: string;
  /** 已保存图片的 id：删除时记入 removedImageIds，保存时不重复上传。 */
  existingId?: string;
};

type EditorState = {
  id: string | null;
  type: MemoNoteType;
  contentMd: string;
  workspaceHint: string;
  pendingImages: PendingImage[];
  removedImageIds: string[];
};

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** 可接受的图片 MIME 类型（也用于过滤粘贴/拖拽进来的非图片文件）。 */
const IMAGE_INPUT_TYPES = /image\/(png|jpeg|gif|webp|bmp|avif|svg\+xml)/;
/** 暂存图片的唯一键序号（粘贴的截图文件名可能重复）。 */
let pendingImageSeq = 0;

/** 粘贴的截图往往没有有意义的文件名，按 MIME 推断一个。 */
function imageFileName(file: File): string {
  if (file.name && /\.[a-z0-9]+$/i.test(file.name)) return file.name;
  const ext = file.type.split("/")[1]?.replace("svg+xml", "svg").replace("jpeg", "jpg");
  return `image.${ext || "png"}`;
}

export function MemoPage() {
  const t = useT();
  const workspace = useAppStore((s) => s.workspace);
  const pushNotification = useAppStore((s) => s.pushNotification);

  const [notes, setNotes] = useState<MemoNote[] | null>(null);
  const [statusFilter, setStatusFilter] = useState<MemoStatusFilter>("open");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [workspaceFilter, setWorkspaceFilter] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 速记流：默认常驻新建表单；null 表示正在查看选中记录的详情。
  const [editor, setEditor] = useState<EditorState | null>(() =>
    newEditorState(workspace?.canonicalCwd),
  );
  const [draftEpoch, setDraftEpoch] = useState(0);
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const [dragOver, setDragOver] = useState(false);
  const [resultModalOpen, setResultModalOpen] = useState(false);
  // 窄屏（<@2xl）单栏模式下当前显示哪栏：列表或详情/编辑器；宽屏下两栏常驻，此状态不生效。
  const [pane, setPane] = useState<"list" | "detail">("list");
  const rootRef = useRef<HTMLDivElement>(null);
  const isWide = useContainerWide(rootRef);
  const backToList = useCallback(() => setPane("list"), []);

  // 云同步发生在顶栏（MemoSyncHeaderActions）；同步成功后刷新本页列表。
  useEffect(() => {
    const onSynced = () => {
      void refreshRef.current?.();
    };
    window.addEventListener(MEMO_SYNCED_EVENT, onSynced);
    return () => window.removeEventListener(MEMO_SYNCED_EVENT, onSynced);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const loaded = await listMemoNotes();
      setNotes(loaded);
      return loaded;
    } catch (error) {
      setNotes([]);
      pushNotification(
        `${t("memoLoadFailed")}: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return [];
    }
  }, [pushNotification, t]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const counts = useMemo(() => statusCounts(notes ?? []), [notes]);
  const tagOptions = useMemo(() => collectTags(notes ?? []), [notes]);
  const workspaceOptions = useMemo(() => collectWorkspaces(notes ?? []), [notes]);

  const visibleNotes = useMemo(
    () =>
      sortNotesForList(
        filterNotes(notes ?? [], {
          status: statusFilter,
          tag: tagFilter,
          workspace: workspaceFilter,
          query,
        }),
        statusFilter,
      ),
    [notes, statusFilter, tagFilter, workspaceFilter, query],
  );

  const selectedNote = useMemo(
    () => notes?.find((note) => note.id === selectedId) ?? null,
    [notes, selectedId],
  );

  // 详情图片 → data URL（按 noteId:imageId 缓存，选中时按需拉取）。
  useEffect(() => {
    if (!selectedNote) return;
    let cancelled = false;
    for (const image of selectedNote.images) {
      const key = `${selectedNote.id}:${image.id}`;
      if (imageUrls[key]) continue;
      void readMemoImageDataUrl(selectedNote.id, image.id)
        .then((url) => {
          if (cancelled) return;
          setImageUrls((current) => ({ ...current, [key]: url }));
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNote?.id, selectedNote?.images.length]);

  /** 新建表单的初始状态。 */
  function newEditorState(cwd: string | null | undefined): EditorState {
    return {
      id: null,
      type: "memo",
      contentMd: "",
      workspaceHint: cwd ? pathBasename(cwd) : "",
      pendingImages: [],
      removedImageIds: [],
    };
  }

  /** 保存/取消查看后回到全新的新建表单（epoch 变化触发重新挂载以 autofocus）；窄屏下同时回到列表栏。 */
  function resetToCreate() {
    setConfirmingDelete(false);
    setConfirmingClear(false);
    setSelectedId(null);
    setPane("list");
    setDraftEpoch((epoch) => epoch + 1);
    setEditor(newEditorState(useAppStore.getState().workspace?.canonicalCwd));
  }

  function startEdit(note: MemoNote) {
    setConfirmingDelete(false);
    setPane("detail");
    // 旧数据标题独立存储：若正文首行不是标题，补一行作为标题种子。
    const seeded =
      deriveTitle(note.contentMd) === note.title
        ? note.contentMd
        : `${note.title}\n\n${note.contentMd}`;
    setEditor({
      id: note.id,
      type: note.type,
      contentMd: seeded,
      workspaceHint: note.workspaceHint ?? "",
      pendingImages: note.images.map((image) => ({
        key: `existing:${image.id}`,
        fileName: image.fileName,
        mediaType: image.mediaType,
        dataBase64: "",
        previewUrl: imageUrls[`${note.id}:${image.id}`] ?? "",
        existingId: image.id,
      })),
      removedImageIds: [],
    });
    setSelectedId(note.id);
    // 已有图片的 data URL 可能尚未加载：补拉并回填到编辑器状态。
    for (const image of note.images) {
      const key = `${note.id}:${image.id}`;
      if (imageUrls[key]) continue;
      void readMemoImageDataUrl(note.id, image.id)
        .then((url) => {
          setImageUrls((current) => ({ ...current, [key]: url }));
          setEditor((current) =>
            current?.id === note.id
              ? {
                  ...current,
                  pendingImages: current.pendingImages.map((entry) =>
                    entry.key === `existing:${image.id}` ? { ...entry, previewUrl: url } : entry,
                  ),
                }
              : current,
          );
        })
        .catch(() => {});
    }
  }

  /** 删除编辑器里的图片：新上传的直接移除，已有图片同时记入 removedImageIds。 */
  function removePendingImage(key: string) {
    setEditor((current) => {
      if (!current) return current;
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

  async function saveEditor() {
    if (!editor || saving) return;
    // 标题 = 正文首行；标签 = 正文内 #xxx。正文为空则无法派生标题。
    const title = deriveTitle(editor.contentMd);
    if (!title) return;
    const tags = extractTags(editor.contentMd);
    setSaving(true);
    try {
      const hint = editor.workspaceHint.trim() || null;
      if (editor.id === null) {
        await createMemoNote({
          type: editor.type,
          title,
          contentMd: editor.contentMd,
          tags,
          workspaceHint: hint,
          images: editor.pendingImages.map(({ fileName, mediaType, dataBase64 }) => ({
            fileName,
            mediaType,
            dataBase64,
          })),
        });
      } else {
        await updateMemoNote(editor.id, {
          type: editor.type,
          title,
          contentMd: editor.contentMd,
          tags,
          workspaceHint: hint,
          addImages: editor.pendingImages
            .filter((image) => image.existingId === undefined)
            .map(({ fileName, mediaType, dataBase64 }) => ({
              fileName,
              mediaType,
              dataBase64,
            })),
          removeImageIds: editor.removedImageIds,
        });
      }
      await refresh();
      if (editor.id === null) {
        // 新建：立刻回到全新的新建表单，继续下一条。
        resetToCreate();
      } else {
        // 编辑：回到该记录的详情。
        setConfirmingDelete(false);
        setEditor(null);
        setSelectedId(editor.id);
      }
    } catch (error) {
      pushNotification(
        `${t("memoSaveFailed")}: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(note: MemoNote, status: MemoNoteStatus) {
    try {
      const updated = await updateMemoNote(note.id, { status });
      setNotes((current) =>
        current ? current.map((entry) => (entry.id === updated.id ? updated : entry)) : current,
      );
      return updated;
    } catch (error) {
      pushNotification(
        `${t("memoSaveFailed")}: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return null;
    }
  }

  /** 列表内联归档/取消归档：成功后该记录离开当前页签，回到新建表单。 */
  async function toggleFromList(note: MemoNote, status: MemoNoteStatus) {
    const updated = await setStatus(note, status);
    if (updated && selectedId === note.id) resetToCreate();
  }

  /** 一键清空全部已归档记录（二次确认后执行）。 */
  async function clearArchived() {
    if (!confirmingClear) {
      setConfirmingClear(true);
      return;
    }
    const archived = (notes ?? []).filter((note) => note.status === "archived");
    await Promise.allSettled(archived.map((note) => deleteMemoNote(note.id)));
    setConfirmingClear(false);
    await refresh();
    resetToCreate();
  }

  async function removeNote(note: MemoNote) {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    try {
      await deleteMemoNote(note.id);
      setConfirmingDelete(false);
      await refresh();
      resetToCreate();
    } catch (error) {
      pushNotification(
        `${t("memoDeleteFailed")}: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  }

  /** 把记录以引用块注入新会话草稿，并切到对话页（总是新开会话，不影响当前选中的会话）。 */
  async function openWithAgent(note: MemoNote) {
    const before = useAppStore.getState();
    if (!before.workspace) {
      pushNotification(t("memoAgentNoWorkspace"), "warning");
      return;
    }
    const created = await createNewSession();
    if (!created) {
      pushNotification(t("memoAgentCreateFailed"), "error");
      return;
    }
    const state = useAppStore.getState();
    const target = draftTargetFor(state.workspace, state.session);
    if (!target) {
      pushNotification(t("memoAgentNoWorkspace"), "warning");
      return;
    }
    const key = draftKeyForTarget(target);
    const merged = withMemoPrompt(
      state.draftTexts[key] ?? "",
      composeMemoPrompt(note),
      t("memoAgentPrompt"),
    );
    state.setDraftTextLocal(target, merged);
    state.setPage("chat");
  }

  /**
   * 「继续讨论」：优先跳转提交总结时的原会话（跨工作区，复用全局搜索同款导航）；
   * 原会话已删除/不可达时新建会话，然后把引用块 + 最新总结 + 指令注入草稿。
   */
  async function continueWithAgent(note: MemoNote) {
    let opened = false;
    if (note.result?.sessionPath) {
      const cwd = note.result.sessionCwd ?? useAppStore.getState().workspace?.canonicalCwd ?? null;
      if (cwd) {
        const outcome = await openSessionAcrossWorkspaces({
          cwd,
          sessionId: note.result.sessionId,
          sessionPath: note.result.sessionPath,
          optimistic: false,
          quiet: true,
        });
        opened = outcome.status === "opened" || outcome.status === "already-active";
      }
    }
    if (!opened) {
      const created = await createNewSession();
      if (!created) {
        pushNotification(t("memoContinueFailed"), "error");
        return;
      }
    }
    const state = useAppStore.getState();
    const target = draftTargetFor(state.workspace, state.session);
    if (!target) {
      pushNotification(t("memoAgentNoWorkspace"), "warning");
      return;
    }
    const block = [composeMemoPrompt(note), composeMemoResultSection(note)]
      .filter(Boolean)
      .join("\n\n");
    const key = draftKeyForTarget(target);
    const merged = withMemoPrompt(state.draftTexts[key] ?? "", block, t("memoFollowupPrompt"));
    state.setDraftTextLocal(target, merged);
    setResultModalOpen(false);
    state.setPage("chat");
  }

  /** 把文件加入当前编辑器的待上传图片（粘贴/拖拽共用的入口）。 */
  const addImages = useCallback(
    (files: File[]) => {
      const valid = files.filter((file) => IMAGE_INPUT_TYPES.test(file.type));
      let remaining = valid.length;
      if (remaining === 0) return;
      const pending: PendingImage[] = [];
      for (const file of valid) {
        if (file.size > MAX_IMAGE_BYTES) {
          pushNotification(t("memoImageTooLarge"), "warning");
          remaining -= 1;
          continue;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const result = typeof reader.result === "string" ? reader.result : "";
          pending.push({
            key: `img-${(pendingImageSeq += 1)}`,
            fileName: imageFileName(file),
            mediaType: file.type || "image/png",
            dataBase64: result.split(",")[1] ?? "",
            previewUrl: result,
          });
          remaining -= 1;
          if (remaining === 0 && pending.length > 0) {
            setEditor((current) =>
              current
                ? { ...current, pendingImages: [...current.pendingImages, ...pending] }
                : current,
            );
          }
        };
        reader.readAsDataURL(file);
      }
    },
    [pushNotification, t],
  );

  /**
   * 拖拽落下的文件路径：复用对话输入框同款的 Rust 读取命令（desktop_read_small_file），
   * 返回嗅探后的图片字节（base64）。非图片文件忽略并提示。
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
            key: `img-${(pendingImageSeq += 1)}`,
            fileName: info.name,
            mediaType: info.mediaType,
            dataBase64: info.data,
            previewUrl: `data:${info.mediaType};base64,${info.data}`,
          };
          setEditor((current) =>
            current ? { ...current, pendingImages: [...current.pendingImages, pending] } : current,
          );
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

  // Tauri 在窗口层接管了系统文件拖拽（dragDropEnabled: true），DOM 拖拽事件
  // 收不到外部文件；与对话输入框一样监听 webview 的 onDragDropEvent。
  // 仅在编辑态监听，避免列表页误收拖拽。
  const editorOpen = editor !== null;
  useEffect(() => {
    if (!editorOpen) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
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
    };
  }, [editorOpen, addDroppedPaths]);

  const mismatch = selectedNote
    ? workspaceMismatch(selectedNote, workspace?.canonicalCwd ?? null)
    : null;
  return (
    <div
      ref={rootRef}
      className="@container flex h-full min-w-0 flex-col"
      data-testid="memo-page"
      data-memo-page
    >
      {/* 工具栏：归类页签 | 搜索与筛选。窄屏分两行（页签行 + 筛选行），宽屏合为一行。
          页面标题由 AppTopBar 承载。 */}
      <div className="flex shrink-0 flex-col gap-2 border-b border-border px-4 py-2 @2xl:h-12 @2xl:flex-row @2xl:items-center @2xl:gap-3 @2xl:py-0">
        <div
          className="flex min-w-0 items-center gap-1 overflow-x-auto @2xl:overflow-visible"
          role="tablist"
          aria-label={t("memoTitle")}
        >
          {STATUS_TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={statusFilter === tab}
              onClick={() => {
                setConfirmingClear(false);
                setStatusFilter(tab);
              }}
              className={`flex h-[28px] shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12px] transition-colors ${
                statusFilter === tab
                  ? "bg-nav-active text-nav-active-foreground"
                  : "text-muted hover:bg-surface-overlay hover:text-foreground"
              }`}
            >
              <span>{memoStatusLabel(tab, t)}</span>
              <span className="text-[11px] opacity-70">{counts[tab]}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 @2xl:ml-auto">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("memoSearchPlaceholder")}
            aria-label={t("memoSearchPlaceholder")}
            className="h-8 min-w-0 flex-1 rounded-md border border-border bg-transparent px-2.5 text-[12px] outline-none placeholder:text-muted focus-visible:ring-2 focus-visible:ring-focus @2xl:w-44 @2xl:flex-none"
          />
          <SelectFilter
            value={tagFilter ?? ""}
            ariaLabel={t("memoFieldTags")}
            placeholder={t("memoFieldTags")}
            options={tagOptions.map((tag) => ({ value: tag, label: `#${tag}` }))}
            onChange={setTagFilter}
          />
          <SelectFilter
            value={workspaceFilter ?? ""}
            ariaLabel={t("memoFieldWorkspace")}
            placeholder={t("memoFieldWorkspace")}
            options={workspaceOptions.map((hint) => ({ value: hint, label: hint }))}
            onChange={setWorkspaceFilter}
          />
          {statusFilter === "archived" && counts.archived > 0 && (
            <button
              type="button"
              onClick={() => void clearArchived()}
              data-state={confirmingClear ? "confirm" : "idle"}
              title={t("memoClearArchivedHint")}
              className={`${secondaryButton} h-8 shrink-0 gap-1.5 px-3 text-[12px] ${
                confirmingClear ? "border-destructive text-destructive" : ""
              }`}
            >
              <Trash2 size={13} className="shrink-0" />
              <span>{confirmingClear ? t("memoActionDeleteConfirm") : t("memoClearArchived")}</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              resetToCreate();
              setPane("detail");
            }}
            title={t("memoActionCreate")}
            aria-label={t("memoActionCreate")}
            className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border text-foreground transition-colors hover:bg-surface-overlay"
          >
            <Plus size={16} />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 列表：窄屏单栏只显示列表（与详情互斥），宽屏恢复左列表右详情。 */}
        <div
          data-testid="memo-list"
          className={`scrollbar-subtle overflow-y-auto border-border p-2 @2xl:w-80 @2xl:min-w-64 @2xl:shrink-0 @2xl:border-r ${
            pane === "detail" ? "hidden @2xl:block" : "w-full"
          }`}
        >
          {notes === null ? (
            <div className="flex h-full items-center justify-center text-muted">
              <Loader2 size={18} className="animate-spin" />
            </div>
          ) : visibleNotes.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center">
              <StickyNote size={22} className="text-muted" />
              <div className="text-[13px] text-foreground">{t("memoEmptyList")}</div>
              <div className="text-[12px] text-muted">{t("memoEmptyListHint")}</div>
            </div>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {visibleNotes.map((note) => (
                <MemoListItem
                  key={note.id}
                  note={note}
                  selected={note.id === (editor?.id ?? selectedId)}
                  onSelect={() => {
                    // 再点一次已选中的记录：宽屏回到新建表单；窄屏重新打开详情。
                    if (editor === null && selectedId === note.id) {
                      if (isWide) {
                        resetToCreate();
                      } else {
                        setPane("detail");
                      }
                      return;
                    }
                    // 正在编辑该条：切到详情。
                    if (editor?.id === note.id) {
                      setEditor(null);
                      setConfirmingDelete(false);
                      setPane("detail");
                      return;
                    }
                    // 查看历史：收起新建表单，展示详情。
                    setEditor(null);
                    setConfirmingDelete(false);
                    setSelectedId(note.id);
                    setPane("detail");
                  }}
                  onToggleStatus={(target) =>
                    void setStatus(target, target.status === "done" ? "open" : "done")
                  }
                  onArchive={(target) => void toggleFromList(target, "archived")}
                  onUnarchive={(target) => void toggleFromList(target, "open")}
                />
              ))}
            </ul>
          )}
        </div>

        {/* 详情 / 编辑器：窄屏单栏下与列表互斥显示。 */}
        <div
          className={`scrollbar-subtle min-w-0 flex-1 overflow-y-auto ${
            pane === "list" ? "hidden @2xl:block" : ""
          }`}
        >
          {editor ? (
            <MemoEditor
              key={editor.id ?? `new-${draftEpoch}`}
              editor={editor}
              saving={saving}
              onChange={setEditor}
              onSave={saveEditor}
              onAddImages={addImages}
              dragOver={dragOver}
              onRemoveImage={removePendingImage}
              onBack={backToList}
            />
          ) : selectedNote ? (
            <MemoDetail
              note={selectedNote}
              imageUrls={imageUrls}
              workspaceMismatchHint={mismatch}
              confirmingDelete={confirmingDelete}
              onBack={backToList}
              onEdit={() => startEdit(selectedNote)}
              onAgent={() => void openWithAgent(selectedNote)}
              onResult={() => setResultModalOpen(true)}
              onDelete={() => void removeNote(selectedNote)}
            />
          ) : (
            <MemoEditor
              key={`new-${draftEpoch}`}
              editor={newEditorState(useAppStore.getState().workspace?.canonicalCwd)}
              saving={saving}
              onChange={setEditor}
              onSave={saveEditor}
              onAddImages={addImages}
              dragOver={dragOver}
              onRemoveImage={removePendingImage}
              onBack={backToList}
            />
          )}
        </div>
      </div>

      {/* Agent 完成总结弹窗（轻量临时浮层）：查看总结 + 继续讨论。 */}
      {resultModalOpen && selectedNote?.result && (
        <Dialog
          title={t("memoResultTitle")}
          icon={ScrollText}
          showCancel={false}
          showCloseIcon
          confirmLabel={t("memoActionContinue")}
          onCancel={() => setResultModalOpen(false)}
          onConfirm={() => void continueWithAgent(selectedNote)}
        >
          <div className="flex flex-col gap-3 text-left">
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
              <span>
                {t("memoResultFromSession", {
                  name: selectedNote.result.sessionTitle ?? selectedNote.result.sessionId,
                })}
              </span>
              <span>·</span>
              <span>{t("memoResultAt", { time: formatMemoDateTime(selectedNote.result.at) })}</span>
            </div>
            <div className="scrollbar-subtle max-h-80 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-surface-overlay px-3 py-2.5 text-[13px] leading-relaxed text-foreground">
              {selectedNote.result.resultMd}
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}

/** 标签胶囊：按内容哈希固定色相（同色逻辑跨列表/详情一致）。 */
function TagChip({ tag }: { tag: string }) {
  const hue = tagHue(tag);
  return (
    <span
      className="rounded px-1.5 py-0.5 text-[11px] font-medium"
      style={{
        color: `hsl(${hue} 65% 42%)`,
        backgroundColor: `hsl(${hue} 70% 50% / 0.14)`,
      }}
    >
      #{tag}
    </span>
  );
}

/** 工作区胶囊：与标签同一套稳定配色逻辑。 */
function WorkspaceChip({ name }: { name: string }) {
  const hue = tagHue(name);
  return (
    <span
      className="rounded px-1.5 py-0.5 text-[11px] font-medium"
      style={{
        color: `hsl(${hue} 45% 48%)`,
        backgroundColor: `hsl(${hue} 45% 50% / 0.14)`,
      }}
    >
      {name}
    </span>
  );
}

function memoStatusLabel(status: MemoStatusFilter | MemoNoteStatus, t: Translate): string {
  const key =
    status === "open"
      ? "memoFilterOpen"
      : status === "done"
        ? "memoFilterDone"
        : status === "archived"
          ? "memoFilterArchived"
          : "memoFilterAll";
  return t(key);
}

/** 列表项：类型图标 + 标题 + 摘要 + 标签/工作区/时间。 */
function MemoListItem({
  note,
  selected,
  onSelect,
  onToggleStatus,
  onArchive,
  onUnarchive,
}: {
  note: MemoNote;
  selected: boolean;
  onSelect: () => void;
  onToggleStatus: (note: MemoNote) => void;
  onArchive: (note: MemoNote) => void;
  onUnarchive: (note: MemoNote) => void;
}) {
  const t = useT();
  const Icon = TYPE_ICONS[note.type];
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect();
          }
        }}
        data-state={selected ? "active" : "inactive"}
        data-testid="memo-list-item"
        className={`group flex w-full cursor-pointer flex-col gap-1 rounded-md border px-3 py-2.5 text-left transition-colors ${
          selected
            ? "border-focus bg-surface-overlay"
            : "border-transparent hover:bg-surface-overlay"
        }`}
      >
        <span className="flex w-full items-center gap-2">
          <Icon size={14} className="shrink-0 text-muted" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
            {note.title}
          </span>
          {/* 右上角状态图标区（悬浮行时显示归档/恢复入口）：
              进行中=圆圈(点击完成)；已完成=对勾(点击恢复)+归档(悬浮)；
              已归档=静态归档图标，悬浮换为恢复(点击取消归档)。 */}
          {note.status === "done" && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onArchive(note);
              }}
              title={t("memoActionArchive")}
              aria-label={t("memoActionArchive")}
              data-testid="memo-list-item-archive"
              className="hidden shrink-0 cursor-pointer items-center rounded text-muted transition-colors hover:text-foreground group-hover:flex group-focus-within:flex"
            >
              <Archive size={14} aria-hidden />
            </button>
          )}
          {note.status === "archived" ? (
            <>
              <Archive
                size={14}
                className="shrink-0 text-muted group-hover:hidden group-focus-within:hidden"
                aria-hidden
              />
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onUnarchive(note);
                }}
                title={t("memoActionUnarchive")}
                aria-label={t("memoActionUnarchive")}
                data-testid="memo-list-item-unarchive"
                className="hidden shrink-0 cursor-pointer items-center rounded text-muted transition-colors hover:text-foreground group-hover:flex group-focus-within:flex"
              >
                <ArchiveRestore size={14} aria-hidden />
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onToggleStatus(note);
              }}
              title={note.status === "done" ? t("memoActionReopen") : t("memoActionDone")}
              aria-label={note.status === "done" ? t("memoActionReopen") : t("memoActionDone")}
              data-testid="memo-list-item-status"
              className="flex shrink-0 cursor-pointer items-center rounded transition-colors hover:opacity-100"
            >
              {note.status === "done" ? (
                <CheckCircle2 size={14} className="text-success" aria-hidden />
              ) : (
                <Circle
                  size={14}
                  className="text-muted opacity-50 hover:text-success hover:opacity-100"
                  aria-hidden
                />
              )}
            </button>
          )}
        </span>
        {noteExcerpt(note) && (
          <span className="line-clamp-2 text-[12px] text-muted">{noteExcerpt(note)}</span>
        )}
        <span className="flex w-full flex-wrap items-center gap-1.5">
          {note.tags.slice(0, 4).map((tag) => (
            <TagChip key={tag} tag={tag} />
          ))}
          {note.workspaceHint && <WorkspaceChip name={note.workspaceHint} />}
          <span className="ml-auto shrink-0 text-[11px] text-muted">
            {formatMemoDateTime(note.updatedAt)}
          </span>
        </span>
        <span className="sr-only">{t("memoTitle")}</span>
      </div>
    </li>
  );
}

/** 窄屏单栏模式的返回列表按钮（宽屏自动隐藏）。 */
function BackToListButton({ onClick }: { onClick: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onClick}
      title={t("memoBackToList")}
      aria-label={t("memoBackToList")}
      data-testid="memo-back-to-list"
      className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border text-foreground transition-colors hover:bg-surface-overlay @2xl:hidden"
    >
      <ArrowLeft size={14} />
    </button>
  );
}

/** 详情只读视图。 */
function MemoDetail({
  note,
  imageUrls,
  workspaceMismatchHint,
  confirmingDelete,
  onBack,
  onEdit,
  onAgent,
  onResult,
  onDelete,
}: {
  note: MemoNote;
  imageUrls: Record<string, string>;
  workspaceMismatchHint: string | null;
  confirmingDelete: boolean;
  onBack: () => void;
  onEdit: () => void;
  onAgent: () => void;
  onResult: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const TypeIcon = TYPE_ICONS[note.type];
  // 已完成/已归档且有 Agent 总结 → 展示「Agent完成总结」；
  // 进行中或无总结（手动标记完成）→ 保持「用 Agent 处理」。
  const showResult = note.status !== "open" && note.result !== null;
  return (
    <div className="flex h-full flex-col" data-testid="memo-detail">
      {/* 标题行：返回（窄屏）+ 图标 + 单行标题（溢出省略），右侧常驻 Agent/编辑/删除。 */}
      <div className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <BackToListButton onClick={onBack} />
        <TypeIcon size={18} className="shrink-0 text-muted" aria-hidden />
        <h2 className="min-w-0 flex-1 truncate text-[16px] font-semibold text-foreground">
          {note.title}
        </h2>
        {showResult ? (
          <button
            type="button"
            onClick={onResult}
            className={`${primaryButton} h-8 shrink-0 gap-1.5 px-3 text-[12px]`}
            title={t("memoResultTitle")}
            data-testid="memo-detail-result"
          >
            <ScrollText size={14} className="shrink-0" />
            <span>{t("memoActionResult")}</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={onAgent}
            className={`${primaryButton} h-8 shrink-0 gap-1.5 px-3 text-[12px]`}
            title={t("memoAgentPrompt")}
          >
            <Bot size={14} className="shrink-0" />
            <span>{t("memoActionAgent")}</span>
          </button>
        )}
        <button
          type="button"
          onClick={onEdit}
          title={t("memoActionEdit")}
          aria-label={t("memoActionEdit")}
          className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border text-foreground transition-colors hover:bg-surface-overlay"
        >
          <Pencil size={14} className="shrink-0" />
        </button>
        <button
          type="button"
          onClick={onDelete}
          title={confirmingDelete ? t("memoActionDeleteConfirm") : t("memoActionDelete")}
          aria-label={confirmingDelete ? t("memoActionDeleteConfirm") : t("memoActionDelete")}
          data-state={confirmingDelete ? "confirm" : "idle"}
          className={`flex size-8 shrink-0 items-center justify-center rounded-md border transition-colors ${
            confirmingDelete
              ? "border-destructive text-destructive"
              : "border-border text-foreground hover:bg-surface-overlay"
          }`}
        >
          <Trash2 size={14} className="shrink-0" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 px-5 py-4">
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          {note.tags.map((tag) => (
            <TagChip key={tag} tag={tag} />
          ))}
          {note.workspaceHint && <WorkspaceChip name={note.workspaceHint} />}
          <span className="text-muted">{formatMemoDateTime(note.updatedAt)}</span>
        </div>

        {workspaceMismatchHint && (
          <div className="flex items-center gap-1.5 rounded-md bg-surface-overlay px-2.5 py-1.5 text-[12px] text-muted">
            <CircleAlert size={13} className="shrink-0" aria-hidden />
            <span>{t("memoWorkspaceMismatch", { workspace: workspaceMismatchHint })}</span>
          </div>
        )}

        {note.images.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {note.images.map((image) => {
              const url = imageUrls[`${note.id}:${image.id}`];
              return url ? (
                <LightboxImage
                  key={image.id}
                  url={url}
                  alt={image.fileName}
                  className="size-21 rounded-md border border-border object-cover"
                />
              ) : (
                <div
                  key={image.id}
                  className="flex size-21 items-center justify-center rounded-md border border-border text-muted"
                >
                  <Loader2 size={14} className="animate-spin" />
                </div>
              );
            })}
          </div>
        )}

        <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground">
          {note.contentMd}
        </div>
      </div>
    </div>
  );
}

/** 编辑器（新建 / 编辑共用）。 */
function MemoEditor({
  editor,
  saving,
  onChange,
  onSave,
  onAddImages,
  onRemoveImage,
  dragOver,
  onBack,
}: {
  editor: EditorState;
  saving: boolean;
  onChange: (next: EditorState) => void;
  onSave: () => void;
  onAddImages: (files: File[]) => void;
  onRemoveImage: (key: string) => void;
  dragOver: boolean;
  onBack: () => void;
}) {
  const t = useT();
  const canSave = editor.contentMd.trim().length > 0;
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
      onAddImages(files);
    }
  }

  function patch(partial: Partial<EditorState>) {
    onChange({ ...editor, ...partial });
  }
  return (
    <div className="flex h-full flex-col" data-testid="memo-editor" onPaste={handlePaste}>
      <div className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <BackToListButton onClick={onBack} />
        <Select
          value={editor.type}
          onChange={(value) => patch({ type: value as MemoNoteType })}
          options={TYPE_OPTIONS.map((type) => ({
            value: type,
            label: typeOptionLabel(type, t),
          }))}
          selectedLabel={typeOptionLabel(editor.type, t)}
          ariaLabel={t("memoFieldType")}
          className="w-28 shrink-0"
        />
        {/* 粘贴提示：窄屏隐藏，宽屏用 flex-1 把工作区输入和保存按钮推到右侧。 */}
        <span className="hidden min-w-0 flex-1 truncate text-[11px] text-muted @2xl:block">
          {t("memoImagePasteHint")}
        </span>
        <input
          value={editor.workspaceHint}
          onChange={(event) => patch({ workspaceHint: event.target.value })}
          placeholder={t("memoFieldWorkspacePlaceholder")}
          aria-label={t("memoFieldWorkspace")}
          className="h-8 w-28 shrink-0 rounded-md border border-border bg-transparent px-2.5 text-[12px] outline-none placeholder:text-muted focus-visible:ring-2 focus-visible:ring-focus @2xl:w-44"
        />
        <button
          type="button"
          onClick={onSave}
          disabled={saving || !canSave}
          title={t("memoActionSave")}
          aria-label={t("memoActionSave")}
          data-testid="memo-editor-save"
          className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border text-success transition-colors hover:border-success hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Check size={18} />}
        </button>
      </div>

      <div
        className="flex min-h-0 flex-1 flex-col gap-3 px-5 py-4"
        onClick={(event) => {
          // 点击输入框下方的空白区域时，把焦点还给输入框（纸面化后输入框不再铺满）。
          if (event.target === event.currentTarget) textareaRef.current?.focus();
        }}
      >
        <textarea
          ref={textareaRef}
          value={editor.contentMd}
          onChange={(event) => patch({ contentMd: event.target.value })}
          placeholder={t("memoFieldContentPlaceholder")}
          aria-label={t("memoFieldContentPlaceholder")}
          rows={2}
          autoFocus={editor.id === null}
          className={`memo-editor-input scrollbar-subtle field-sizing-content max-h-[70vh] min-h-32 w-full resize-none rounded-lg border border-dashed bg-transparent px-3 py-2.5 text-[13px] leading-relaxed outline-none caret-focus placeholder:text-muted ${
            dragOver ? "border-accent" : "border-transparent"
          }`}
        />

        {editor.pendingImages.length > 0 && (
          <div className="flex flex-wrap gap-2">
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
                  onClick={() => onRemoveImage(image.key)}
                  aria-label={t("memoActionDelete")}
                  className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full border border-border bg-background text-muted hover:text-destructive"
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** 工具栏的可清空下拉筛选（值为空 = 不过滤）。窄屏允许收缩，宽屏固定宽度。 */
function SelectFilter({
  value,
  options,
  placeholder,
  ariaLabel,
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  placeholder: string;
  ariaLabel: string;
  onChange: (value: string) => void;
}) {
  const t = useT();
  return (
    <Select
      value={value}
      onChange={onChange}
      ariaLabel={ariaLabel}
      className="w-28 min-w-0 @2xl:w-36 @2xl:shrink-0"
      options={[{ value: "", label: `${placeholder}: ${t("memoFilterAll")}` }, ...options]}
    />
  );
}

function memoTypeLabel(type: MemoNoteType, t: Translate): string {
  const key = type === "memo" ? "memoTypeMemo" : type === "idea" ? "memoTypeIdea" : "memoTypeTask";
  return t(key);
}
