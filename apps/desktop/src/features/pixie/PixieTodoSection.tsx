/**
 * 随行面板 ·「待办 · 方寸间」分组。
 *
 * 与方寸间页（`MemoPage`）共用同一套数据与模型：`memo-client` 的 memo.* RPC、
 * `memo-model` 的判定与派生、`memo-agent` 的引用胶囊注入。区别只在形态——这里是
 * 右栏里的**待办中心**：概览三格 + 「待处理 / 已完成」两页签 + 按日期分组 +
 * 就地展开详情（正文 / 标签 / 工作区 / 截止 + 交给小精灵 / 编辑 / 删除）+
 * 两个新建入口（速记框、多功能表单）。
 *
 * 「进行中」不单独分区：它混在「待处理」里，用转圈 + 强调色文字标识（设计稿口径）。
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
} from "../memo/memo-client";
import { injectMemoReference } from "../memo/memo-agent";
import { requestMemoReveal } from "../memo/memo-reveal";
import {
  composeMemoPrompt,
  deriveTitle,
  extractTags,
  formatMemoDateTime,
  formatTags,
  isMemoOverdue,
  sortNotesForList,
  withMemoPrompt,
} from "../memo/memo-model";
import { PixiePanelSection, usePanelSection } from "./PixiePanelSection";
import {
  datetimeLocalValue,
  groupTodoNotes,
  parseDatetimeLocal,
  parseTagInput,
  todoOverview,
  todoTabNotes,
  todoTargetAt,
  type TodoBucket,
} from "./pixie-todo-model";

const MEMO_PLUGIN_ID = "piabyss-memo";

/** 分组展开状态 + 时间重算周期（分钟级就够：分组只到「今天/明天/本周」）。 */
const TODO_EXPANDED_PREF = "piabyss.pixie.todoExpanded";
const NOW_TICK_MS = 60_000;

const BUCKET_LABEL_KEY = {
  overdue: "pixieTodoBucketOverdue",
  today: "pixieTodoBucketToday",
  tomorrow: "pixieTodoBucketTomorrow",
  week: "pixieTodoBucketWeek",
  later: "pixieTodoBucketLater",
  none: "pixieTodoBucketNone",
} as const satisfies Record<TodoBucket, string>;

export function PixieTodoSection() {
  const t = useT();
  const memoEnabled = usePluginEnabled(MEMO_PLUGIN_ID);
  const hostInstanceId = useAppStore((s) => s.host?.hostInstanceId ?? null);
  const knownWorkspaces = useAppStore((s) => s.desktopSettings?.knownWorkspaces ?? []);
  const pushNotification = useAppStore((s) => s.pushNotification);

  const [open, toggle] = usePanelSection(TODO_EXPANDED_PREF, true);
  const [notes, setNotes] = useState<MemoNote[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"open" | "done">("open");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [quickText, setQuickText] = useState("");
  const [formOpen, setFormOpen] = useState(false);
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
  const groups = useMemo(() => groupTodoNotes(visible, now), [visible, now]);

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
          className="flex size-[22px] shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground"
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
        {/* 概览：折叠态由标题上的计数徽章承担，展开态看这三格。 */}
        <div className="grid grid-cols-3 gap-1.5 pt-0.5">
          <OverviewCell cell="open" value={overview.open} label={t("memoFilterTodo")} tone="hot" />
          <OverviewCell
            cell="inProgress"
            value={overview.inProgress}
            label={t("memoFilterInProgress")}
          />
          <OverviewCell
            cell="overdue"
            value={overview.overdue}
            label={t("pixieTodoOverviewOverdue")}
            tone="warn"
          />
        </div>

        <div className="flex items-center gap-0.5">
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

        {groups.length === 0 ? (
          <p className="px-1 py-2 text-center text-[11px] text-muted">
            {tab === "open" ? t("memoEmptyList") : t("pixieTodoDoneEmpty")}
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.bucket} className="flex flex-col gap-0.5">
              <div
                data-testid="pixie-todo-bucket"
                data-bucket={group.bucket}
                className="flex items-center gap-1.5 px-1 pt-1 text-[10px] font-semibold tracking-wide text-muted"
              >
                <span className={group.bucket === "overdue" ? "text-danger" : ""}>
                  {t(BUCKET_LABEL_KEY[group.bucket])}
                </span>
                <span className="h-px flex-1 bg-border" />
              </div>
              {group.notes.map((note) => (
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
                  onComplete={() => void runAction(() => completeMemoNote(note.id))}
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
          ))
        )}

        {/* 新建：速记框（管「先记下来」）与多功能表单（管「记的时候就分好类」）
         * 互斥展开，避免两块新建 UI 叠在一起。 */}
        <div className="mt-1 border-t border-dashed border-border pt-2">
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
              rows={1}
              value={quickText}
              placeholder={t("memoWidgetInputPlaceholder")}
              className="w-full resize-none rounded-md border border-dashed border-transparent bg-transparent px-1.5 py-1 text-[12px] leading-5 outline-none transition-colors placeholder:text-muted hover:border-border focus:border-border"
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
      </div>
    </PixiePanelSection>
  );
}

function OverviewCell({
  cell,
  value,
  label,
  tone,
}: {
  cell: "open" | "inProgress" | "overdue";
  value: number;
  label: string;
  tone?: "hot" | "warn";
}) {
  const toneClass = tone === "hot" ? "text-accent" : tone === "warn" ? "text-warning" : "";
  return (
    <div
      data-testid="pixie-todo-overview"
      data-cell={cell}
      className="rounded-md border border-border px-1.5 py-1"
    >
      <div className={`text-[15px] font-semibold leading-tight tabular-nums ${toneClass}`}>
        {value}
      </div>
      <div className="mt-px truncate text-[10px] text-muted">{label}</div>
    </div>
  );
}

function TodoRow({
  note,
  now,
  expanded,
  confirmingDelete,
  busy,
  onToggleDetail,
  onComplete,
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
  onComplete: () => void;
  onHandOff: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const overdue = isMemoOverdue(note, now);
  const target = todoTargetAt(note);
  const inProgress = note.status === "in_progress";
  // 正文去掉首行（首行是标题）——标题行已经在上面的列表里显示了。
  const body = note.contentMd.split("\n").slice(1).join("\n").trim();

  const actionClass =
    "flex h-6 items-center gap-1 rounded-md border border-border px-1.5 text-[11px] text-muted transition-colors hover:bg-surface-overlay hover:text-foreground";

  return (
    <div data-testid="pixie-todo-row" className="rounded-md">
      <div className="flex items-start gap-2 rounded-md px-1.5 py-1.5 transition-colors hover:bg-surface-overlay">
        <button
          type="button"
          data-testid="pixie-todo-complete"
          title={t("memoActionDone")}
          aria-label={t("memoActionDone")}
          disabled={busy}
          className="group/tick mt-0.5 flex size-4 shrink-0 items-center justify-center text-muted transition-colors hover:text-accent disabled:opacity-40"
          onClick={onComplete}
        >
          <Circle size={15} className="group-hover/tick:hidden" aria-hidden="true" />
          <CircleCheck size={15} className="hidden group-hover/tick:block" aria-hidden="true" />
        </button>
        <button
          type="button"
          data-testid="pixie-todo-open-detail"
          aria-expanded={expanded}
          className="min-w-0 flex-1 text-left"
          onClick={onToggleDetail}
        >
          <div className="break-words text-[12px] leading-5 text-foreground/90">{note.title}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted">
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
            {note.workspaceHint ? <span className="truncate">{note.workspaceHint}</span> : null}
            {target !== null ? <span>{formatMemoDateTime(target)}</span> : null}
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
        <div className="mx-1.5 mb-1.5 rounded-md border border-border bg-surface-inset p-2">
          {body ? (
            <div className="whitespace-pre-wrap break-words text-[11px] leading-5 text-foreground/90">
              {body}
            </div>
          ) : null}
          <dl
            data-testid="pixie-todo-detail"
            className="mt-1.5 grid grid-cols-[52px_1fr] gap-x-2 gap-y-0.5 text-[10px]"
          >
            <dt className="text-muted">{t("memoFieldTags")}</dt>
            <dd className="break-words text-foreground/90">
              {note.tags.length > 0 ? formatTags(note.tags) : "—"}
            </dd>
            <dt className="text-muted">{t("memoFieldWorkspace")}</dt>
            <dd className="break-words text-foreground/90">{note.workspaceHint ?? "—"}</dd>
            <dt className="text-muted">{t("memoPlanDue")}</dt>
            <dd className="text-foreground/90">
              {target !== null ? formatMemoDateTime(target) : t("memoPlanNone")}
            </dd>
          </dl>
          <div className="mt-2 flex items-center gap-1.5 border-t border-dashed border-border pt-2">
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
