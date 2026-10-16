/**
 * 随行面板 ·「方寸间」分组。
 *
 * 与方寸间页（`MemoPage`）共用同一套数据、模型与胶囊：`memo-client` 的 memo.* RPC、
 * `memo-model` 的判定与派生、`memo-agent` 的引用胶囊注入。区别只在形态——这里是
 * 右栏里的**待办中心**：「待处理 / 已完成」两页签 + 每行三层（标题 / 摘要 /
 * 标签·工作区·截止）+ 就地展开详情（完整正文 + 交给小精灵 / 编辑 / 删除）+
 * 两个新建入口（速记框、多功能表单）。
 *
 * 「进行中」不单独分区也不单独计数：它混在「待处理」里，用转圈 + 强调色文字标识。
 * 已完成页签里每行的圆圈直接是**选中态**，点它把记录转回待处理（`memo.update`），
 * 与待处理页签的「点空圈 = 标记完成」（`memo.complete`，周期记录会滚下一轮）对称。
 * 逾期数由区块标题右侧的提示承担、待处理数由页签角标承担，所以顶部不再放概览格。
 * 日期只用来排序（逾期在前、无日期沉底），不渲染分段标题——10 条时两个标题行
 * 吃掉的高度抵不上它们提供的信息。截断两档各一套：待处理只截排在最后的「无日期」
 * 那一档（前 5 条常驻），已完成整列只先给 5 条，其余收进列表下方的「查看更多」；
 * 两个新建入口也在列表下面（速记框的虚线框常驻）。
 *
 * 「编辑」不在这里重造编辑器——跳到方寸间页并就地展开那条记录（完整正文、图片、
 * 周期设置都在那边），这样两个页面永远只有一份编辑实现。
 *
 * 方寸间插件没启用时整块不渲染（与侧栏入口同一道门）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Circle,
  CircleCheck,
  ChevronRight,
  Loader2,
  ListTodo,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import type { MemoNote } from "@piabyss/protocol";
import { CollapsibleRegion } from "../../components/CollapsibleRegion";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { draftTargetFor } from "../../lib/draft-target";
import { usePluginEnabled } from "../plugin-library/plugin-gate";
import {
  completeMemoNote,
  createMemoNote,
  deleteMemoNote,
  listMemoNotes,
  updateMemoNote,
} from "../memo/memo-client";
import { injectMemoReference } from "../memo/memo-agent";
import { requestMemoReveal } from "../memo/memo-reveal";
import {
  composeMemoPrompt,
  deriveTitle,
  extractTags,
  isMemoOverdue,
  noteExcerpt,
  sortNotesForList,
  withMemoPrompt,
} from "../memo/memo-model";
import { TagChip, WorkspaceChip } from "../memo/MemoChips";
import { formatMemoDue } from "../memo/MemoScheduleEditor";
import { PixiePanelSection, usePanelSection } from "./PixiePanelSection";
import {
  datetimeLocalValue,
  groupTodoNotes,
  parseDatetimeLocal,
  parseTagInput,
  todoOverview,
  todoTabNotes,
  todoTargetAt,
} from "./pixie-todo-model";

const MEMO_PLUGIN_ID = "piabyss-memo";

/** 排序 + 时间重算周期（分钟级就够：排序只到「今天/明天/本周」这一档）。 */
const NOW_TICK_MS = 60_000;

/** 一屏先给几条：面板高度有限，剩下的收进「查看更多」（两个页签都截，见下）。 */
const TODO_PREVIEW = 5;

export function PixieTodoSection() {
  const t = useT();
  const memoEnabled = usePluginEnabled(MEMO_PLUGIN_ID);
  const hostInstanceId = useAppStore((s) => s.host?.hostInstanceId ?? null);
  const knownWorkspaces = useAppStore((s) => s.desktopSettings?.knownWorkspaces ?? []);
  const pushNotification = useAppStore((s) => s.pushNotification);

  const [open, toggle] = usePanelSection(true);
  const [notes, setNotes] = useState<MemoNote[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"open" | "done">("open");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [quickText, setQuickText] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  // 「查看更多」两个页签各记一份：切页签就重新收起来，不会一边点开、另一边也跟着摊平。
  const [expandedTab, setExpandedTab] = useState<"open" | "done" | null>(null);
  const showAll = expandedTab === tab;
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setNotes(await listMemoNotes());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    if (!hostInstanceId || !memoEnabled) return;
    void refresh();
  }, [hostInstanceId, memoEnabled, refresh]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const all = useMemo(() => notes ?? [], [notes]);
  const overview = useMemo(() => todoOverview(all, now), [all, now]);
  const visible = useMemo(
    () => sortNotesForList(todoTabNotes(all, tab), tab === "done" ? "done" : "open"),
    [all, tab],
  );
  // 日期分组只负责定顺序（逾期 → 今天 → 明天 → 本周 → 更晚 → 无日期沉底），不渲染分段
  // 标题。截断两个页签各一套：待处理只截排在最后的「无日期」那一档（逾期的、已经定了
  // 日期的必须全给），已完成整列只先给 5 条；剩下的都收进列表下方的「查看更多」。
  const { ordered, hiddenCount } = useMemo(() => {
    if (tab === "done") {
      return {
        ordered: showAll ? visible : visible.slice(0, TODO_PREVIEW),
        hiddenCount: Math.max(0, visible.length - TODO_PREVIEW),
      };
    }
    const list: MemoNote[] = [];
    let hidden = 0;
    for (const group of groupTodoNotes(visible, now)) {
      if (group.bucket === "none" && !showAll) {
        list.push(...group.notes.slice(0, TODO_PREVIEW));
        hidden = Math.max(0, group.notes.length - TODO_PREVIEW);
      } else {
        list.push(...group.notes);
      }
    }
    return { ordered: list, hiddenCount: hidden };
  }, [visible, now, tab, showAll]);

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
          composeMemoPrompt(note, state.host?.agentDir ?? null),
          t("memoAgentPrompt"),
        ),
      );
      pushNotification(t("pixieTodoHandOffHint"), "info");
    },
    [pushNotification, t],
  );

  if (!memoEnabled) return null;

  const hint = overview.overdue > 0 ? t("pixieTodoOverdueHint", { count: overview.overdue }) : "";

  return (
    <PixiePanelSection
      testId="pixie-todo-section"
      icon={ListTodo}
      title={t("pixieTodoSectionTitle")}
      count={overview.open}
      hint={hint}
      open={open}
      onToggle={toggle}
      action={
        <button
          type="button"
          data-testid="pixie-todo-new"
          title={t("pixieTodoNew")}
          aria-label={t("pixieTodoNew")}
          className="flex size-[22px] shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground focus-visible:outline-none"
          onClick={() => {
            if (!open) toggle();
            setFormOpen((current) => !current);
          }}
        >
          <Plus size={13} />
        </button>
      }
    >
      <div className="flex flex-col gap-2">
        {/* 计数只在这里出现一次：待处理数在页签角标上，逾期数在区块标题右侧的提示里。 */}
        <div className="flex items-center gap-0.5 pt-0.5">
          {(["open", "done"] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              data-testid={`pixie-todo-tab-${candidate}`}
              aria-pressed={tab === candidate}
              className={`flex h-6 items-center gap-1.5 rounded-md px-2 text-[11px] transition-colors ${
                tab === candidate
                  ? "bg-nav-active font-semibold text-foreground"
                  : "text-muted hover:bg-surface-overlay hover:text-foreground"
              }`}
              onClick={() => setTab(candidate)}
            >
              {candidate === "open" ? t("memoFilterTodo") : t("memoFilterDone")}
              <span className="text-[10px] tabular-nums opacity-75">
                {candidate === "open" ? overview.open : all.length - overview.open}
              </span>
            </button>
          ))}
        </div>

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
                confirmingDelete={confirmDeleteId === note.id}
                busy={busy}
                onToggleDetail={() => {
                  setConfirmDeleteId(null);
                  setExpandedId((current) => (current === note.id ? null : note.id));
                }}
                onToggleComplete={() =>
                  void runAction(() =>
                    note.status === "done"
                      ? updateMemoNote(note.id, { status: "open" })
                      : completeMemoNote(note.id),
                  )
                }
                onHandOff={() => handOff(note)}
                onEdit={() => {
                  requestMemoReveal(note.id);
                  useAppStore.getState().setPage("memo");
                }}
                onDelete={() => {
                  if (confirmDeleteId !== note.id) {
                    setConfirmDeleteId(note.id);
                    return;
                  }
                  setConfirmDeleteId(null);
                  setExpandedId(null);
                  void runAction(() => deleteMemoNote(note.id));
                }}
              />
            ))}
          </div>
        )}

        {hiddenCount > 0 ? (
          <button
            type="button"
            data-testid="pixie-todo-show-more"
            className="w-full py-1 text-center text-[11px] text-muted transition-colors hover:text-foreground focus-visible:outline-none"
            onClick={() => setExpandedTab(tab)}
          >
            {t("pixieTodoShowMore", { count: hiddenCount })}
          </button>
        ) : null}

        {/* 新建在列表下面：速记框（先记下来）与多功能表单（记的时候就分好类）互斥展开。
         * 虚线框常驻，不再等悬停 / 聚焦才显形。 */}
        {formOpen ? (
          <TodoForm
            workspaces={knownWorkspaces}
            busy={busy}
            onCancel={() => setFormOpen(false)}
            onSubmit={async (input) => {
              await runAction(async () => {
                await createMemoNote({
                  title: input.title,
                  contentMd: input.title,
                  tags: input.tags,
                  workspaceHint: input.workspaceHint,
                  dueAt: input.dueAt,
                });
                setFormOpen(false);
              });
            }}
          />
        ) : (
          <textarea
            data-testid="pixie-todo-quick"
            rows={2}
            value={quickText}
            placeholder={t("memoWidgetInputPlaceholder")}
            className="w-full resize-none rounded-md border border-dashed border-border bg-transparent px-1.5 py-1 text-[12px] leading-5 outline-none transition-colors placeholder:text-muted focus-visible:outline-none"
            onChange={(event) => setQuickText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey) return;
              // 输入法组词中的回车是「选字」，不是「保存」。
              if (event.nativeEvent.isComposing) return;
              event.preventDefault();
              void submitQuick();
            }}
          />
        )}
      </div>
    </PixiePanelSection>
  );
}

function TodoRow({
  note,
  now,
  expanded,
  confirmingDelete,
  busy,
  onToggleDetail,
  onToggleComplete,
  onHandOff,
  onEdit,
  onDelete,
}: {
  note: MemoNote;
  now: number;
  expanded: boolean;
  confirmingDelete: boolean;
  busy: boolean;
  onToggleDetail: () => void;
  onToggleComplete: () => void;
  onHandOff: () => void;
  onEdit: () => void;
  onDelete: () => void;
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

  const actionClass =
    "flex h-6 items-center gap-1 rounded-md border border-border px-1.5 text-[11px] text-muted transition-colors hover:bg-surface-overlay hover:text-foreground";

  return (
    <div data-testid="pixie-todo-row" className="rounded-md">
      <div className="flex items-start gap-2 rounded-md px-1.5 py-1.5 transition-colors hover:bg-surface-overlay">
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
              <CircleCheck size={15} className="hidden group-hover/tick:block" aria-hidden="true" />
            </>
          )}
        </button>
        <button
          type="button"
          data-testid="pixie-todo-open-detail"
          aria-expanded={expanded}
          className="min-w-0 flex-1 text-left"
          onClick={onToggleDetail}
        >
          <div className="truncate text-[12px] font-medium leading-5 text-foreground">
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
            {note.tags.map((tag) => (
              <TagChip key={tag} tag={tag} size="compact" />
            ))}
            {note.workspaceHint ? <WorkspaceChip name={note.workspaceHint} size="compact" /> : null}
          </div>
        </button>
        <ChevronRight
          size={11}
          aria-hidden="true"
          className={`mt-1 shrink-0 text-muted transition-transform duration-150 ${
            expanded ? "rotate-90" : ""
          }`}
        />
      </div>

      <CollapsibleRegion open={expanded}>
        <div
          data-testid="pixie-todo-detail"
          className="mx-1.5 mb-1.5 rounded-md border border-border bg-surface-inset p-2"
        >
          {body ? (
            <div className="whitespace-pre-wrap break-words text-[11px] leading-5 text-foreground/90">
              {body}
            </div>
          ) : null}
          <div
            className={`flex items-center gap-1.5 border-t border-dashed border-border pt-2 ${
              body ? "mt-2" : ""
            }`}
          >
            <button
              type="button"
              data-testid="pixie-todo-handoff"
              className={`${actionClass} border-primary/40 text-primary hover:bg-primary/10 hover:text-primary`}
              onClick={onHandOff}
            >
              <Sparkles size={12} aria-hidden="true" />
              {t("pixieTodoHandOff")}
            </button>
            <button
              type="button"
              data-testid="pixie-todo-edit"
              className={actionClass}
              onClick={onEdit}
            >
              <Pencil size={12} aria-hidden="true" />
              {t("memoActionEdit")}
            </button>
            <button
              type="button"
              data-testid="pixie-todo-delete"
              className={`${actionClass} ml-auto ${
                confirmingDelete ? "border-danger/40 text-danger" : ""
              }`}
              title={t("memoActionDelete")}
              aria-label={t("memoActionDelete")}
              onClick={onDelete}
            >
              <Trash2 size={12} aria-hidden="true" />
              {confirmingDelete ? t("memoActionDeleteConfirm") : null}
            </button>
          </div>
        </div>
      </CollapsibleRegion>
    </div>
  );
}

function TodoForm({
  workspaces,
  busy,
  onSubmit,
  onCancel,
}: {
  workspaces: readonly string[];
  busy: boolean;
  onSubmit: (input: {
    title: string;
    tags: string[];
    workspaceHint: string | null;
    dueAt: number | null;
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  const [title, setTitle] = useState("");
  const [due, setDue] = useState(() => datetimeLocalValue(null));
  const [tags, setTags] = useState("");
  const [workspace, setWorkspace] = useState("");

  const inputClass =
    "h-7 w-full rounded-md border border-border bg-transparent px-1.5 text-[12px] text-foreground outline-none focus:border-focus";

  return (
    <form
      data-testid="pixie-todo-form"
      className="flex flex-col gap-1.5 rounded-lg border border-border p-2"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = title.trim();
        if (!trimmed || busy) return;
        void onSubmit({
          title: trimmed,
          tags: parseTagInput(tags),
          workspaceHint: workspace || null,
          dueAt: parseDatetimeLocal(due),
        });
      }}
    >
      <input
        data-testid="pixie-todo-form-title"
        className={inputClass}
        value={title}
        placeholder={t("pixieTodoFormTitlePlaceholder")}
        aria-label={t("pixieTodoFormTitle")}
        onChange={(event) => setTitle(event.target.value)}
      />
      <label className="flex items-center gap-1.5 text-[10px] text-muted">
        <span className="w-9 shrink-0">{t("pixieTodoFormDue")}</span>
        <input
          type="datetime-local"
          data-testid="pixie-todo-form-due"
          className={`${inputClass} flex-1`}
          value={due}
          onChange={(event) => setDue(event.target.value)}
        />
      </label>
      <label className="flex items-center gap-1.5 text-[10px] text-muted">
        <span className="w-9 shrink-0">{t("memoFieldTags")}</span>
        <input
          data-testid="pixie-todo-form-tags"
          className={`${inputClass} flex-1`}
          value={tags}
          placeholder={t("scheduleFormTagsPlaceholder")}
          onChange={(event) => setTags(event.target.value)}
        />
      </label>
      <label className="flex items-center gap-1.5 text-[10px] text-muted">
        <span className="w-9 shrink-0">{t("memoFieldWorkspace")}</span>
        <select
          data-testid="pixie-todo-form-workspace"
          className={`${inputClass} flex-1`}
          value={workspace}
          aria-label={t("memoFieldWorkspace")}
          onChange={(event) => setWorkspace(event.target.value)}
        >
          <option value="">{t("pixieTodoFormNone")}</option>
          {workspaces.map((cwd) => (
            <option key={cwd} value={cwd}>
              {cwd.split(/[\\/]/).pop() || cwd}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-center gap-1.5 pt-0.5">
        <button
          type="submit"
          data-testid="pixie-todo-form-submit"
          disabled={busy || title.trim().length === 0}
          className="flex h-6 items-center rounded-md bg-accent px-2.5 text-[11px] text-accent-foreground transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t("pixieTodoFormCreate")}
        </button>
        <button
          type="button"
          className="flex h-6 items-center rounded-md px-2 text-[11px] text-muted transition-colors hover:bg-surface-overlay hover:text-foreground"
          onClick={onCancel}
        >
          {t("pixieTodoFormCancel")}
        </button>
      </div>
    </form>
  );
}
