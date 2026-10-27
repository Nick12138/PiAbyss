/**
 * 随行面板 ·「待办 · 速记」页签（三块横排的第一块）。
 *
 * 备忘的整套实现都在这上面复用：`memo-client` 的 memo.* RPC、
 * `memo-model` 的判定与派生、`memo-agent` 的引用胶囊注入、`MemoEditor` 的编辑实现。
 * 区别只在形态——这里是右栏里的**待办中心**：「待处理 / 已完成」两页签 + 每行三层
 * （标题 / 摘要 / 标签·工作区·截止·图片数）+ 就地展开的 Markdown 正文与图片 + 两个新建入口
 * （速记框、`MemoNoteDialog` 的完整表单）。
 *
 * ## 二级页签是筛选，不是导航
 *
 * 「待处理 / 已完成」两边数据同源、行渲染完全一样，只差一个 status 谓词，所以这一行刻意
 * 做得比一级页签（`h-10` 下划线导航）更轻：`h-7` 文字按钮、无边框无底色，12px 标签 +
 * 10px 计数，当前项只给文字加 1px accent 下划线（**只划标签，不划计数**）+ 颜色，
 * 字重全程不变（换 weight 会改字宽，行内会蹭着挪位）；两端也不 `flex-1` 等分——
 * 已完成是低频回看入口，没道理长期占掉半行。同形态也用在「自动化」那一行的
 * 「当前活跃 / 已失效」上，改一处要连带改另一处，别再把实心块搬回来。
 *
 * ## 数据新鲜度
 *
 * 备忘的写入方有三处，前端只听得到其中一路：桌面小窗（Tauri `memo-notes-changed`）、云同步
 * 落地（`MEMO_SYNCED_EVENT`，由 `useMemoSyncStatus` 的 30s 轮询发出），以及**小精灵自己在
 * Host 侧改备忘**——那是插件写盘，没有任何推送通道。所以这里事件监听负责「立刻」，另挂一条
 * 慢轮询兜住没有事件的那一路：本块是当前页签时 15s，被摘到背后时 60s（三块都常驻挂载，
 * 不轮询就再也发现不了 agent 刚记下的那条）。
 *
 * ## 行首一个状态，行尾一个悬停图标
 *
 * 行首圆圈 = 状态（待处理行点它标记完成；已完成行它已经是选中态，点它退回待处理）。
 * 中间整块 = 展开/收起正文。摊开时整行连同正文合成**同一张卡片**（正文与标题左对齐，中间一条
 * 虚线分隔），不是再叠一张大小不一的卡片。行尾只留 ✨（引用给小精灵），**悬停或键盘
 * 落到这一行才现形**，平时行尾是空的——列表读起来仍然只有文字。
 * **编辑 / 复制 / 删除全收进右键菜单**，展开区里不再画动作按钮——正文才是展开的意义。
 * 编辑与新建开同一个 `MemoNoteDialog`（差别只在给不给 `note`），删除走一次 danger 确认
 * 弹窗；菜单本身已经是「主动作二阶」，不再叠第二次点击确认。
 * 进行中的记录另有「转回待处理」：它解掉会话绑定再退回待处理——绑定那条会话可能早被删掉，
 * 而原先挂在「打开关联会话」失败分支上的自愈已经随待办 · 速记页一起撤了，没有这一项就出不来。
 * 带 Agent 总结的已完成记录，菜单第一行是「完成总结」，开 `MemoResultDialog`；
 * 里面的「继续讨论」**不跳回产出总结的会话**——用户就坐在小精灵会话里，直接把「记录 + 总结」
 * 引用进当前输入框（与 ✨ 同一条通道）。
 *
 * 已完成页签另有**勾选式批量删除**：入口是页签行尾的删除图标，点它进入；进入后行首圆圈
 * 换成复选框、点整行即选中，页签下方出现「全选 / 已选 N / 删除所选 / ✕ 退出」，删完自动退出。
 *
 * 「进行中」不单独分区也不单独计数：它混在「待处理」里，用转圈 + 强调色文字标识。
 * 逾期不单列计数——页签行右侧原来那枚「N 逾期」提示已去掉，逾期只看每条行尾的红色徽章；
 * 待处理数同时挂在随行面板的页签上（`onCount`），所以顶部也不放概览格。
 * 日期只用来排序（逾期在前、无日期沉底），不渲染分段标题——10 条时两个标题行
 * 吃掉的高度抵不上它们提供的信息。两个页签用**同一条截断规则**：先给前 10 条，
 * 其余收进列表下方的「查看更多」（待处理也是——不再单独豁免「已定日期」那几档），
 * 摊开后同一个位置换成「收起」，不再挂第二个入口；
 * 新建有两条路：列表下方的速记框（先记下来，虚线框常驻）与页签行尾 ＋ 打开的完整表单弹窗
 * （正文 / 图片 / 截止 / 周期 / ✨整理都在里面，与编辑同一条通道）。
 *
 * 展开区的正文按 Markdown 渲染（`MemoMarkdown` + `panel-markdown` 的 11px 档），
 * 与详情视图同源；记录带图时图排在正文之前，`data URL` 只给摊开的那条按需取，
 * 行上先报一个张数。只有标题一行、既没正文也没图的记录展开不出任何东西，点了不动——
 * 例外是**标题被截断**（`scrollWidth > clientWidth`）：那行原本只能靠右键编辑才读得全，
 * 现在照样可点，展开区把整条标题补在正文之前（`pixie-todo-title-full`）。
 *
 * 插件门在 `PixieSidePanel`：待办 · 速记插件没启用时，这一块连同它的页签一起不渲染。
 * `active` = 这块是不是当前页签；不是的时候只把显示摘掉（数据与展开状态都留着）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import {
  Circle,
  CircleCheck,
  Copy,
  Image as ImageIcon,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  ScrollText,
  Sparkles,
  Square,
  SquareCheck,
  Trash2,
  X,
} from "lucide-react";
import type { MemoNote } from "@piabyss/protocol";
import { CollapsibleRegion } from "../../components/CollapsibleRegion";
import { Dialog } from "../../components/Dialog";
import { LightboxImage } from "../../components/ImageLightbox";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { matchesEitherPrimaryChord } from "../../lib/commands/keymap";
import { contextMenuTrigger, openContextMenu, type MenuItem } from "../../lib/context-menu";
import { shouldKeepNativeContextMenu } from "../../lib/context-menu-policy";
import { draftTargetFor } from "../../lib/draft-target";
import {
  completeMemoNote,
  createMemoNote,
  deleteMemoNote,
  listMemoNotes,
  readMemoImageDataUrl,
  updateMemoNote,
} from "../memo/memo-client";
import { injectMemoReference } from "../memo/memo-agent";
import { MEMO_SYNCED_EVENT } from "../memo/memo-sync-status";
import {
  buildWorkspaceComboOptions,
  collectWorkspaces,
  composeMemoPrompt,
  composeMemoResultSection,
  deriveTitle,
  extractTags,
  isMemoOverdue,
  memoFullContentMd,
  noteExcerpt,
  pathBasename,
  sortNotesForList,
  withMemoPrompt,
} from "../memo/memo-model";
import { MemoNoteDialog } from "../memo/MemoNoteDialog";
import { MemoResultDialog } from "../memo/MemoResultDialog";
import { TagChip, WorkspaceChip } from "../memo/MemoChips";
import { MemoMarkdown } from "../memo/MemoMarkdown";
import { formatMemoDue } from "../memo/MemoScheduleEditor";
import { PixiePanelBody } from "./PixiePanelTabs";
import { groupTodoNotes, todoOverview, todoTabNotes, todoTargetAt } from "./pixie-todo-model";

/** 排序 + 时间重算周期（分钟级就够：排序只到「今天/明天/本周」这一档）。 */
const NOW_TICK_MS = 60_000;

/**
 * 兜底轮询的两档节奏。两条事件都覆盖不到「小精灵在 Host 侧改备忘」（那是插件写盘，
 * 没有推送通道），所以必须有条轮询：本块是当前页签时 15s，被摘到背后时 60s——
 * 页签上的待处理数也靠它保持新鲜。
 */
const TODO_POLL_ACTIVE_MS = 15_000;
const TODO_POLL_IDLE_MS = 60_000;

/** 一屏先给几条：面板高度有限，剩下的收进「查看更多」（两个页签同一条规则，见下）。 */
const TODO_PREVIEW = 10;

/**
 * selector 里不能新建数组：`?? []` 在字段还没加载完时每次都返回新引用，
 * `useSyncExternalStore` 会判定快照一直在变 → forceStoreRerender 无限循环
 * （同 `PixiePage` 顶部那条注释）。
 */
const EMPTY_WORKSPACES: string[] = [];

export function PixieTodoSection({
  active,
  onCount,
}: {
  active: boolean;
  /** 待处理数报给随行面板的页签徽章（插件门也在那里）。 */
  onCount: (count: number) => void;
}) {
  const t = useT();
  const hostInstanceId = useAppStore((s) => s.host?.hostInstanceId ?? null);
  const workspace = useAppStore((s) => s.workspace);
  const knownWorkspaces = useAppStore(
    (s) => s.desktopSettings?.knownWorkspaces ?? EMPTY_WORKSPACES,
  );
  const pushNotification = useAppStore((s) => s.pushNotification);

  const [notes, setNotes] = useState<MemoNote[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"open" | "done">("open");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** 编辑弹窗：`{ note }` 改这条，`{ note: null }` 新建一条，null = 没开。 */
  const [dialog, setDialog] = useState<{ note: MemoNote | null } | null>(null);
  /** 完成总结弹窗里的那条记录；null = 没开。 */
  const [resultNote, setResultNote] = useState<MemoNote | null>(null);
  /** 待确认删除的 id 集合（右键单删与批量删共用这一次确认）。 */
  const [pendingDelete, setPendingDelete] = useState<string[] | null>(null);
  /** 已完成页签的勾选模式与勾选集合（切页签即退出）。 */
  const [batchMode, setBatchMode] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [quickText, setQuickText] = useState("");
  // 「查看更多」两个页签各记一份：切页签就重新收起来，不会一边点开、另一边也跟着摊平。
  const [expandedTab, setExpandedTab] = useState<"open" | "done" | null>(null);
  const showAll = expandedTab === tab;
  const [busy, setBusy] = useState(false);
  /** 摊开那条记录的图片 data URL（键 `noteId:imageId`）：只按需取摊开的这一条。 */
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    try {
      setNotes(await listMemoNotes());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    if (!hostInstanceId) return;
    void refresh();
  }, [hostInstanceId, refresh]);

  // 外部写入的两条事件通道：云同步落地（`useMemoSyncStatus` 的轮询发现 lastSyncAt
  // 变了就广播），以及桌面速记小窗改过备忘。
  useEffect(() => {
    const onSynced = () => void refresh();
    window.addEventListener(MEMO_SYNCED_EVENT, onSynced);
    return () => window.removeEventListener(MEMO_SYNCED_EVENT, onSynced);
  }, [refresh]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const { isTauri } = await import("@tauri-apps/api/core");
        if (!isTauri()) return;
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen("memo-notes-changed", () => {
          if (!cancelled) void refresh();
        });
      } catch {
        // 非桌面环境没有小窗：这条通道本来就不存在。
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [refresh]);

  // 兜底轮询：小精灵自己记一条、或把一条做完，都是 Host 侧落盘，前端收不到。
  useEffect(() => {
    const timer = setInterval(
      () => void refresh(),
      active ? TODO_POLL_ACTIVE_MS : TODO_POLL_IDLE_MS,
    );
    return () => clearInterval(timer);
  }, [active, refresh]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const all = useMemo(() => notes ?? [], [notes]);
  const overview = useMemo(() => todoOverview(all, now), [all, now]);
  useEffect(() => {
    onCount(overview.open);
  }, [overview.open, onCount]);
  const visible = useMemo(() => {
    const sorted = sortNotesForList(todoTabNotes(all, tab), tab === "done" ? "done" : "open");
    // 待处理按日期桶重排（逾期 → 今天 → 明天 → 本周 → 更晚 → 无日期沉底，桶内仍是 updatedAt
    // 倒序），不渲染分段标题；已完成只看 completedAt 倒序，不再分组。
    return tab === "done" ? sorted : groupTodoNotes(sorted, now).flatMap((group) => group.notes);
  }, [all, tab, now]);
  // 两个页签用同一套截断：前 10 条常驻，剩下的进「查看更多」。
  // `hiddenCount` 一律是「收起来时藏了几条」，与当前是否摊开无关：摊开后列表下方的位置
  // 换成「收起」继续占着，不出现第二个「查看更多」，也不会把计数清零、连收起的入口一起弄没。
  const { ordered, hiddenCount } = useMemo(
    () => ({
      ordered: showAll ? visible : visible.slice(0, TODO_PREVIEW),
      hiddenCount: Math.max(0, visible.length - TODO_PREVIEW),
    }),
    [visible, showAll],
  );

  // 编辑弹窗的工作区候选：当前工作区排第一，其后是从各记录提示里去重出来的历史候选。
  const workspaceOptions = useMemo(
    () =>
      buildWorkspaceComboOptions(
        workspace?.canonicalCwd ? pathBasename(workspace.canonicalCwd) : "",
        collectWorkspaces(all),
      ),
    [all, workspace],
  );
  const availableWorkspaces = useMemo(() => {
    const current = workspace?.canonicalCwd;
    const candidates = current ? [current, ...knownWorkspaces] : knownWorkspaces;
    return candidates.map((cwd, index) => ({ id: `workspace-${index}`, name: pathBasename(cwd) }));
  }, [knownWorkspaces, workspace]);

  /** 摊开的那条记录（收起时 null）：图片只给它取 data URL，列表里几十条一起拉不值。 */
  const expandedNote = useMemo(
    () => all.find((note) => note.id === expandedId) ?? null,
    [all, expandedId],
  );
  useEffect(() => {
    if (!expandedNote || expandedNote.images.length === 0) return;
    let cancelled = false;
    for (const image of expandedNote.images) {
      const key = `${expandedNote.id}:${image.id}`;
      void readMemoImageDataUrl(expandedNote.id, image.id)
        .then((url) => {
          if (cancelled) return;
          setImageUrls((current) => (current[key] ? current : { ...current, [key]: url }));
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [expandedNote]);

  const runAction = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await action();
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const submitQuick = useCallback(async () => {
    const text = quickText.trim();
    if (!text || busy) return;
    await runAction(async () => {
      await createMemoNote({
        title: deriveTitle(text),
        contentMd: text,
        tags: extractTags(text),
      });
      setQuickText("");
    });
  }, [busy, quickText, runAction]);

  /**
   * 「交给小精灵」：不新开会话（用户本来就坐在小精灵会话里），把记录以引用胶囊
   * 注入当前草稿——输入框里只显示 `@备忘录 · 标题`，提示词原文发送时才展开，
   * 发送那一刻才把记录置为「进行中」并绑定会话（见 memo-handoff）。
   */
  const handOff = useCallback(
    (note: MemoNote) => {
      const state = useAppStore.getState();
      const target = draftTargetFor(state.workspace, state.session);
      if (!target) {
        pushNotification(t("memoAgentNoWorkspace"), "warning");
        return;
      }
      injectMemoReference(
        target,
        note,
        withMemoPrompt(
          "",
          composeMemoPrompt(note, state.host?.memoDataDir ?? null),
          t("memoAgentPrompt"),
        ),
      );
      pushNotification(t("pixieTodoHandOffHint"), "info");
    },
    [pushNotification, t],
  );

  /** 复制整条记录（标题 + 正文，口径同编辑态的 `memoFullContentMd`），不只是正文。 */
  const copyNote = useCallback(
    (note: MemoNote) => {
      // 剪贴板在某些环境不可用：与代码块的复制一样静默失败，不为它造一条错误提示。
      void navigator.clipboard.writeText(memoFullContentMd(note)).then(
        () => pushNotification(t("commonCopied"), "info"),
        () => undefined,
      );
    },
    [pushNotification, t],
  );

  /**
   * 「继续讨论」：不跳回产出总结的那条会话（那个动作随待办 · 速记页一起撤了），而是把「记录 + 总结」
   * 以引用胶囊放进当前小精灵草稿——与 ✨ 同一条通道，发送那一刻才展开并绑定会话。
   */
  const continueWithResult = useCallback(
    (note: MemoNote) => {
      const state = useAppStore.getState();
      const target = draftTargetFor(state.workspace, state.session);
      if (!target) {
        pushNotification(t("memoAgentNoWorkspace"), "warning");
        return;
      }
      const block = [
        composeMemoPrompt(note, state.host?.memoDataDir ?? null),
        composeMemoResultSection(note),
      ]
        .filter(Boolean)
        .join("\n\n");
      injectMemoReference(target, note, withMemoPrompt("", block, t("memoFollowupPrompt")));
      setResultNote(null);
      pushNotification(t("pixieTodoHandOffHint"), "info");
    },
    [pushNotification, t],
  );

  /** 右键菜单：完成总结 / 转回待处理 / 编辑 / 复制 / 删除。 */
  const openRowMenu = useCallback(
    (event: MouseEvent<HTMLDivElement>, note: MemoNote) => {
      if (shouldKeepNativeContextMenu(event.nativeEvent)) return;
      event.preventDefault();
      event.stopPropagation();
      const items: MenuItem[] = [];
      // 手动标记完成不产生总结，所以这一项只以有没有 result 为准。
      if (note.status === "done" && note.result !== null) {
        items.push({
          id: "memo.result",
          label: t("memoActionResult"),
          icon: ScrollText,
          onSelect: () => setResultNote(note),
        });
      }
      // 「转回待处理」只给进行中那几条：行首圆圈对进行中只能往「已完成」走，而绑定着
      // 会话的记录一旦那条会话被人删掉，就再也没有入口能把它解绑放回待处理了
      // （待办 · 速记页原来的解绑挂在「打开关联会话」失败分支上，那条路已经撤掉）。
      if (note.status === "in_progress") {
        items.push({
          id: "memo.reclaim",
          label: t("pixieTodoReclaim"),
          icon: RotateCcw,
          onSelect: () =>
            void runAction(() => updateMemoNote(note.id, { status: "open", sessionId: null })),
        });
      }
      items.push(
        {
          id: "memo.edit",
          label: t("memoActionEdit"),
          icon: Pencil,
          onSelect: () => setDialog({ note }),
        },
        { id: "memo.copy", label: t("pixieTodoCopy"), icon: Copy, onSelect: () => copyNote(note) },
        {
          id: "memo.delete",
          label: t("memoActionDelete"),
          icon: Trash2,
          danger: true,
          separatorBefore: true,
          onSelect: () => setPendingDelete([note.id]),
        },
      );
      openContextMenu({
        x: event.clientX,
        y: event.clientY,
        trigger: contextMenuTrigger(event.target),
        items,
      });
    },
    [copyNote, runAction, t],
  );

  /** 进入勾选模式前「查看更多」的展开态：退出时原样还回去，不把这次被迫的摊开留下。 */
  const expandedBeforeBatch = useRef<"open" | "done" | null>(null);

  const exitBatch = useCallback(() => {
    setBatchMode(false);
    setSelected([]);
    setExpandedTab(expandedBeforeBatch.current);
  }, []);

  const switchTab = useCallback(
    (next: "open" | "done") => {
      setTab(next);
      // 切页签即退出勾选模式；展开态也还回进入前那份，不跟着页签漂。
      exitBatch();
    },
    [exitBatch],
  );

  const toggleBatch = useCallback(() => {
    if (batchMode) {
      exitBatch();
      return;
    }
    // 进入勾选模式先把整列摊开：「全选」要覆盖这一档全部记录，不能只覆盖屏上先给的那 10 条。
    expandedBeforeBatch.current = expandedTab;
    setExpandedTab("done");
    setBatchMode(true);
    setSelected([]);
  }, [batchMode, expandedTab, exitBatch]);

  const visibleIds = useMemo(() => ordered.map((note) => note.id), [ordered]);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.includes(id));
  const toggleSelectAll = useCallback(() => {
    setSelected(allSelected ? [] : visibleIds);
  }, [allSelected, visibleIds]);

  /** 逐条 `memo.delete`：协议没有批量入口，顺序删完再一次性刷新，失败条数如实报。 */
  const confirmDelete = useCallback(async () => {
    const ids = pendingDelete ?? [];
    setPendingDelete(null);
    exitBatch();
    setExpandedId((current) => (current && ids.includes(current) ? null : current));
    if (ids.length === 0) return;
    let failed = 0;
    await runAction(async () => {
      for (const id of ids) {
        try {
          await deleteMemoNote(id);
        } catch {
          failed += 1;
        }
      }
      if (failed > 0) {
        pushNotification(
          t("pixieTodoBatchPartFail", { done: ids.length - failed, failed }),
          "warning",
        );
      }
    });
  }, [pendingDelete, exitBatch, pushNotification, runAction, t]);

  return (
    <PixiePanelBody tab="todo" active={active}>
      {/* 这一行既是「待处理 / 已完成」二级页签，也是这一块的**工具条**：页签靠左成文字，
        两个动作贴右。
        它**不是**导航而是一次筛选：两边数据同源、行渲染完全一样，只差一个 status 谓词，
        所以刻意比上一行的一级页签（`h-10` 下划线）更轻——不要实心底色、不要边框，
        12px 标签 + 10px 计数，当前项只给文字加 1px accent 下划线（只划标签、不划计数）
        + 颜色，靠颜色而不是色块说话。
        两端不再 `flex-1` 等分：已完成是低频回看入口，「已完成 34」没有理由长期占掉半行。 */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2.5">
          {(["open", "done"] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              data-testid={`pixie-todo-tab-${candidate}`}
              aria-pressed={tab === candidate}
              className={`flex h-7 items-center gap-1.5 text-[12px] font-medium transition-colors focus-visible:outline-none ${
                tab === candidate ? "text-foreground" : "text-muted hover:text-foreground"
              }`}
              onClick={() => switchTab(candidate)}
            >
              {/* 下划线只画在标签上：计数是附属信息，不该跟着一起划线（像链接）；
               * 字重也不跟着选中变——换 weight 会改字宽，两个页签会蹭着挪位。 */}
              <span
                className={
                  tab === candidate
                    ? "underline decoration-accent decoration-1 underline-offset-[3px]"
                    : undefined
                }
              >
                {candidate === "open" ? t("memoFilterTodo") : t("memoFilterDone")}
              </span>
              <span className="text-[10px] tabular-nums opacity-75">
                {candidate === "open" ? overview.open : all.length - overview.open}
              </span>
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-0.5">
          {tab === "done" && visible.length > 0 ? (
            <button
              type="button"
              data-testid="pixie-todo-batch-toggle"
              aria-pressed={batchMode}
              title={t("pixieTodoBatch")}
              aria-label={t("pixieTodoBatch")}
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-danger focus-visible:outline-none"
              onClick={toggleBatch}
            >
              <Trash2 size={12} aria-hidden="true" />
            </button>
          ) : null}
          <button
            type="button"
            data-testid="pixie-todo-new"
            title={t("pixieTodoNew")}
            aria-label={t("pixieTodoNew")}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground focus-visible:outline-none"
            onClick={() => setDialog({ note: null })}
          >
            <Plus size={12} />
          </button>
        </div>
      </div>

      {batchMode ? (
        <div
          data-testid="pixie-todo-batch-bar"
          className="flex items-center gap-1.5 border-b border-dashed border-border pb-1.5 text-[10px] text-muted"
        >
          <button
            type="button"
            data-testid="pixie-todo-select-all"
            className="flex h-7 items-center rounded px-1 transition-colors hover:text-foreground focus-visible:outline-none"
            onClick={toggleSelectAll}
          >
            {allSelected ? t("pixieTodoBatchDeselectAll") : t("pixieTodoBatchSelectAll")}
          </button>
          <span className="ml-auto tabular-nums">
            {t("pixieTodoBatchSelected", { count: selected.length })}
          </span>
          <button
            type="button"
            data-testid="pixie-todo-batch-delete"
            disabled={selected.length === 0 || busy}
            title={selected.length === 0 ? t("pixieTodoBatchNothingSelected") : undefined}
            className="flex h-7 items-center gap-1 rounded border border-danger/40 px-1.5 text-danger transition-colors hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => setPendingDelete(selected)}
          >
            <Trash2 size={10} aria-hidden="true" />
            {t("pixieTodoBatchDeleteSelected")}
          </button>
          <button
            type="button"
            data-testid="pixie-todo-batch-exit"
            title={t("pixieTodoBatchExit")}
            aria-label={t("pixieTodoBatchExit")}
            className="flex size-7 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-surface-overlay hover:text-foreground focus-visible:outline-none"
            onClick={toggleBatch}
          >
            <X size={11} aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {error ? <p className="px-1 text-[11px] text-danger">{error}</p> : null}

      {ordered.length === 0 ? (
        <p className="px-1 py-2 text-center text-[11px] text-muted">
          {tab === "open" ? t("memoEmptyList") : t("pixieTodoDoneEmpty")}
        </p>
      ) : (
        <div className="flex flex-col gap-0.5">
          {ordered.map((note) => (
            <TodoRow
              key={note.id}
              note={note}
              now={now}
              expanded={expandedId === note.id}
              imageUrls={imageUrls}
              selecting={batchMode}
              checked={selected.includes(note.id)}
              busy={busy}
              onToggleDetail={() => {
                setExpandedId((current) => (current === note.id ? null : note.id));
              }}
              onToggleSelect={() =>
                setSelected((current) =>
                  current.includes(note.id)
                    ? current.filter((id) => id !== note.id)
                    : [...current, note.id],
                )
              }
              onToggleComplete={() =>
                void runAction(() =>
                  note.status === "done"
                    ? updateMemoNote(note.id, { status: "open" })
                    : completeMemoNote(note.id),
                )
              }
              onHandOff={() => handOff(note)}
              onContextMenu={(event) => openRowMenu(event, note)}
            />
          ))}
        </div>
      )}

      {hiddenCount > 0 ? (
        <button
          type="button"
          data-testid={showAll ? "pixie-todo-show-less" : "pixie-todo-show-more"}
          className="w-full py-1 text-center text-[11px] text-muted transition-colors hover:text-foreground focus-visible:outline-none"
          onClick={() => setExpandedTab(showAll ? null : tab)}
        >
          {/* hiddenCount 记的是「收起来时藏了几条」，不随摊开清零，所以按钮靠 showAll 换含义，
           * 而不是摊开后继续挂着第二个「查看更多」。 */}
          {showAll ? t("pixieTodoShowLess") : t("pixieTodoShowMore", { count: hiddenCount })}
        </button>
      ) : null}

      {/* 速记框常驻在列表下面（虚线框不等悬停才显形）：先记下来这条轻路径留着，
        「要分好类再记」交给 ＋ 打开的完整表单弹窗。 */}
      <textarea
        data-testid="pixie-todo-quick"
        rows={3}
        value={quickText}
        placeholder={t("memoWidgetInputPlaceholder")}
        className="w-full resize-none rounded-md border border-dashed border-border bg-transparent px-1.5 py-1 text-[12px] leading-5 outline-none transition-colors placeholder:text-muted focus-visible:outline-none"
        onChange={(event) => setQuickText(event.target.value)}
        onKeyDown={(event) => {
          // Ctrl+S / ⌘S 与 Enter 走同一条提交路径（空内容、busy、组词都由 submitQuick 与本分支挡住）；
          // preventDefault 是硬要求：WebView 里不拦就弹「另存为」。文本框里本地优先，不让全局层抢。
          if (matchesEitherPrimaryChord(event.nativeEvent, "mod+s")) {
            if (event.nativeEvent.isComposing) return;
            event.preventDefault();
            event.stopPropagation();
            void submitQuick();
            return;
          }
          if (event.key !== "Enter" || event.shiftKey) return;
          // 输入法组词中的回车是「选字」，不是「保存」。
          if (event.nativeEvent.isComposing) return;
          event.preventDefault();
          void submitQuick();
        }}
      />

      {dialog ? (
        <MemoNoteDialog
          key={dialog.note?.id ?? "new"}
          note={dialog.note}
          workspaceOptions={workspaceOptions}
          availableWorkspaces={availableWorkspaces}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void refresh();
          }}
        />
      ) : null}

      {resultNote ? (
        <MemoResultDialog
          note={resultNote}
          onClose={() => setResultNote(null)}
          onContinue={() => continueWithResult(resultNote)}
          onCleared={() => void refresh()}
        />
      ) : null}

      {pendingDelete ? (
        <Dialog
          title={t("pixieTodoDeleteConfirmTitle")}
          tone="danger"
          confirmLabel={t("memoActionDelete")}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void confirmDelete()}
        >
          {t("pixieTodoDeleteConfirmHint", { count: pendingDelete.length })}
        </Dialog>
      ) : null}
    </PixiePanelBody>
  );
}

function TodoRow({
  note,
  now,
  expanded,
  imageUrls,
  selecting,
  checked,
  busy,
  onToggleDetail,
  onToggleSelect,
  onToggleComplete,
  onHandOff,
  onContextMenu,
}: {
  note: MemoNote;
  now: number;
  expanded: boolean;
  /** 已取到的图片 data URL（键 `noteId:imageId`）；没有的先画占位。 */
  imageUrls: Record<string, string>;
  /** 批量删除的勾选模式：整行改成选中 / 取消选中，行首圆圈换成复选框。 */
  selecting: boolean;
  checked: boolean;
  busy: boolean;
  onToggleDetail: () => void;
  onToggleSelect: () => void;
  onToggleComplete: () => void;
  onHandOff: () => void;
  onContextMenu: (event: MouseEvent<HTMLDivElement>) => void;
}) {
  const t = useT();
  const overdue = isMemoOverdue(note, now);
  const target = todoTargetAt(note);
  const inProgress = note.status === "in_progress";
  const done = note.status === "done";
  // 正文去掉首行（首行是标题）——标题行已经在上面的列表里显示了。
  const body = note.contentMd.split("\n").slice(1).join("\n").trim();
  // 行内只给一行摘要，完整正文留在展开区；两者同源，摘要不会和正文各说一套。
  const excerpt = noteExcerpt(note);
  // 标题只有一行、用 truncate 收着：真的被截断时（scrollWidth > clientWidth）把整条标题
  // 摊进展开区，并让这一行可点——“只有标题”的记录不能只剩「右键 → 编辑」一条读全文的路。
  const titleRef = useRef<HTMLDivElement>(null);
  const [titleTruncated, setTitleTruncated] = useState(false);
  useEffect(() => {
    const element = titleRef.current;
    if (!element) return;
    const measure = () => {
      // 1px 容差：zoom / 分数像素会让 scrollWidth 比 clientWidth 大一点点。
      setTitleTruncated(element.scrollWidth > element.clientWidth + 1);
    };
    measure();
    // 面板拖宽拖窄、换字号都会改折行，所以跟着元素尺寸重量。jsdom 没有这个 API。
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [note.title]);
  /** 摊得出东西才算可点：有正文、有图，或者标题本身就被截断了。 */
  const expandable = body.length > 0 || note.images.length > 0 || titleTruncated;

  /** 行主体点下去：勾选模式里是选中，否则是展开（只有真的有正文时才展开得出东西）。 */
  const onToggleBody = () => {
    if (selecting) {
      onToggleSelect();
      return;
    }
    if (expandable) onToggleDetail();
  };

  // 行尾的 ✨ 只在悬停 / 键盘落到这一行时才现形：平时行尾是空的，整块读起来就是纯列表。
  const cornerClass =
    "pointer-events-none mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded text-muted opacity-0 transition-[opacity,color] group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100";

  return (
    <div
      data-testid="pixie-todo-row"
      className={`rounded-md ${expanded ? "bg-surface-inset" : ""}`}
      onContextMenu={onContextMenu}
    >
      <div className="group flex items-start gap-2 rounded-md px-1.5 py-1.5 transition-colors hover:bg-surface-overlay">
        {selecting ? (
          <button
            type="button"
            data-testid="pixie-todo-select"
            aria-pressed={checked}
            title={checked ? t("pixieTodoBatchUnselect") : t("pixieTodoBatchSelect")}
            aria-label={checked ? t("pixieTodoBatchUnselect") : t("pixieTodoBatchSelect")}
            disabled={busy}
            className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-muted transition-colors hover:text-accent disabled:opacity-40"
            onClick={onToggleSelect}
          >
            {checked ? (
              <SquareCheck size={15} className="text-accent" aria-hidden="true" />
            ) : (
              <Square size={15} aria-hidden="true" />
            )}
          </button>
        ) : (
          <button
            type="button"
            data-testid="pixie-todo-complete"
            title={done ? t("memoActionReopen") : t("memoActionDone")}
            aria-label={done ? t("memoActionReopen") : t("memoActionDone")}
            disabled={busy}
            className="group/tick mt-0.5 flex size-4 shrink-0 items-center justify-center text-muted transition-colors hover:text-accent disabled:opacity-40"
            onClick={onToggleComplete}
          >
            {/* 已完成行直接给选中态（点它转回待处理）；未完成行仍是空圈，悬停预览打勾。 */}
            {done ? (
              <CircleCheck size={15} className="text-accent" aria-hidden="true" />
            ) : (
              <>
                <Circle size={15} className="group-hover/tick:hidden" aria-hidden="true" />
                <CircleCheck
                  size={15}
                  className="hidden group-hover/tick:block"
                  aria-hidden="true"
                />
              </>
            )}
          </button>
        )}
        <button
          type="button"
          data-testid="pixie-todo-open-detail"
          aria-expanded={expanded}
          className="min-w-0 flex-1 text-left"
          onClick={onToggleBody}
        >
          <div
            ref={titleRef}
            data-testid="pixie-todo-title"
            className="truncate text-[12px] font-medium leading-5 text-foreground"
          >
            {note.title}
          </div>
          {excerpt ? (
            <div
              data-testid="pixie-todo-excerpt"
              className="truncate text-[11px] leading-4 text-muted"
            >
              {excerpt}
            </div>
          ) : null}
          <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-muted">
            {overdue ? (
              <span className="rounded bg-danger/15 px-1 font-medium text-danger">
                {t("memoOverdueBadge")}
              </span>
            ) : null}
            {inProgress ? (
              <span className="flex items-center gap-1 text-accent">
                <Loader2 size={10} className="animate-spin" aria-hidden="true" />
                {t("memoFilterInProgress")}
              </span>
            ) : null}
            {target !== null ? (
              <span data-testid="pixie-todo-due" className="tabular-nums">
                {formatMemoDue(target, now, t)}
              </span>
            ) : null}
            {/* 带图的记录先在这一行报个数：不摊开也知道这条还有东西要看。 */}
            {note.images.length > 0 ? (
              <span
                data-testid="pixie-todo-images"
                className="flex items-center gap-0.5 tabular-nums"
                title={t("pixieTodoImageCount", { count: note.images.length })}
              >
                <ImageIcon size={10} aria-hidden="true" />
                {note.images.length}
              </span>
            ) : null}
            {note.tags.map((tag) => (
              <TagChip key={tag} tag={tag} size="compact" />
            ))}
            {note.workspaceHint ? <WorkspaceChip name={note.workspaceHint} size="compact" /> : null}
          </div>
        </button>
        <button
          type="button"
          data-testid="pixie-todo-handoff"
          title={t("pixieTodoHandOff")}
          aria-label={t("pixieTodoHandOff")}
          className={`${cornerClass} hover:bg-surface-overlay hover:text-accent focus-visible:outline-none`}
          onClick={onHandOff}
        >
          <Sparkles size={12} aria-hidden="true" />
        </button>
      </div>

      <CollapsibleRegion open={expanded}>
        {/* 摊开不是另起一张卡片：整行连同正文就是这一张（外层的 bg-surface-inset），正文与标题
         * 左对齐——行内边距 6px + 圆圈 16px + 间距 8px = 30px——中间一条虚线分开。 */}
        <div
          data-testid="pixie-todo-detail"
          className="mb-1.5 ml-[30px] mr-1.5 break-words border-t border-dashed border-border pt-1.5 text-[11px] leading-5 text-foreground/90"
        >
          {/* 图在正文之前：贴图往往是这条记录的主信息，文字是说明。data URL 按需取，
           * 没取到先画占位方框，取的过程不在行里露出来。 */}
          {note.images.length > 0 ? (
            <div data-testid="pixie-todo-image-list" className="flex flex-wrap gap-1.5 pb-1.5">
              {note.images.map((image) => {
                const url = imageUrls[`${note.id}:${image.id}`];
                return url ? (
                  <LightboxImage
                    key={image.id}
                    url={url}
                    alt={image.fileName}
                    className="size-16 rounded-md border border-border object-cover"
                  />
                ) : (
                  <div
                    key={image.id}
                    className="flex size-16 items-center justify-center rounded-md border border-border text-muted"
                  >
                    <Loader2 size={13} className="animate-spin" />
                  </div>
                );
              })}
            </div>
          ) : null}
          {/* 标题被截断时（行上只看得见前半条）把整条标题补进展开区：这一行原本只有一条
           * 单行标题的记录，原来只能右键编辑才读得全。它排在正文之前，读起来就是「首行 +
           * 其余正文」，与记录本身的形状一致。 */}
          {titleTruncated ? (
            <p
              data-testid="pixie-todo-title-full"
              className="whitespace-pre-wrap pb-1 font-medium text-foreground"
            >
              {note.title}
            </p>
          ) : null}
          {body ? <MemoMarkdown content={body} className="panel-markdown" /> : null}
        </div>
      </CollapsibleRegion>
    </div>
  );
}
