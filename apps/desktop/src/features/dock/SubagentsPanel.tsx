import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import {
  Bot,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Copy,
  LoaderCircle,
  Pause,
  Play,
  RotateCcw,
  Square,
} from "lucide-react";
import type { SubagentSessionSnapshot, SubagentStatusNode } from "@piabyss/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { useT } from "../../lib/i18n/use-t";
import { hostClient } from "../../lib/bridge/host-client";
import { workspaceContext } from "../../lib/bridge/host-context";
import { requestDockCommand } from "../../lib/commands/events";
import { contextMenuTrigger, openContextMenu } from "../../lib/context-menu";
import { shouldKeepNativeContextMenu } from "../../lib/context-menu-policy";
import { buildTranscriptRows, type TranscriptRow } from "../chat/transcript-model";
import { TranscriptRowView } from "../chat/Transcript";

function subagentStateLabel(
  state: SubagentStatusNode["state"],
  t: ReturnType<typeof useT>,
): string {
  switch (state) {
    case "running":
      return t("subagentsStateRunning");
    case "queued":
      return t("subagentsStateQueued");
    case "complete":
      return t("subagentsStateComplete");
    case "failed":
      return t("subagentsStateFailed");
    case "paused":
      return t("subagentsStatePaused");
    case "stopped":
      return t("subagentsStateStopped");
    default:
      return t("subagentsStateRejected");
  }
}

function subagentStateClass(state: SubagentStatusNode["state"]): string {
  if (state === "running") return "text-accent";
  if (state === "complete") return "text-success";
  if (state === "failed" || state === "rejected") return "text-danger";
  if (state === "paused" || state === "stopped") return "text-warning";
  return "text-muted";
}

function subagentRoleLabel(
  role: string | undefined,
  t: ReturnType<typeof useT>,
): string | undefined {
  switch (role?.trim().toLowerCase()) {
    case "scout":
      return t("subagentsRoleScout");
    case "researcher":
      return t("subagentsRoleResearcher");
    case "worker":
      return t("subagentsRoleWorker");
    case "reviewer":
      return t("subagentsRoleReviewer");
    case "delegate":
      return t("subagentsRoleDelegate");
    case "oracle":
    case "advisor":
      return t("subagentsRoleAdvisor");
    default:
      return role?.trim() || undefined;
  }
}

/** Badge glyphs: emoji for the built-in roles, undefined (fall back to the
 * localized text label) for anything else. */
function subagentRoleEmoji(role: string | undefined): string | undefined {
  switch (role?.trim().toLowerCase()) {
    case "scout":
    case "researcher":
      return "🕵️";
    case "worker":
      return "🧑‍💻";
    case "reviewer":
      return "👀";
    default:
      return undefined;
  }
}

function flattenNodes(
  nodes: SubagentStatusNode[],
  depth = 0,
): Array<{ node: SubagentStatusNode; depth: number }> {
  return nodes.flatMap((node) => [
    { node, depth },
    ...(node.children ? flattenNodes(node.children, depth + 1) : []),
  ]);
}

/** Human-readable elapsed time between the first user turn and the final
 * assistant turn, e.g. "2分钟" / "under 1 min". */
function runDurationLabel(
  start: number | undefined,
  end: number | undefined,
  t: ReturnType<typeof useT>,
): string | undefined {
  if (
    typeof start !== "number" ||
    typeof end !== "number" ||
    !Number.isFinite(start) ||
    !Number.isFinite(end)
  ) {
    return undefined;
  }
  const diffMs = Math.max(0, end - start);
  if (diffMs < 60_000) return t("subagentsRunUnderMinute");
  return t("subagentsRunMinutes", { count: Math.round(diffMs / 60_000) });
}

/** Collapsed summary for a finished run, e.g. "执行2分钟后已完成". */
function runSummaryLabel(
  state: SubagentSessionSnapshot["state"],
  duration: string | undefined,
  t: ReturnType<typeof useT>,
): string {
  if (!duration) return t("subagentsRunSummaryFallback");
  switch (state) {
    case "complete":
      return t("subagentsRunSummaryComplete", { duration });
    case "failed":
      return t("subagentsRunSummaryFailed", { duration });
    case "stopped":
      return t("subagentsRunSummaryStopped", { duration });
    default:
      return t("subagentsRunSummaryFallback");
  }
}

function isMessageEntry(entry: { type: string; message?: unknown }): entry is {
  type: "message";
  message?: { role?: string };
} {
  return entry.type === "message" && typeof entry.message === "object" && entry.message !== null;
}

function entryTimeMs(entry: { timestamp?: unknown }): number | undefined {
  const ts = entry.timestamp;
  if (typeof ts === "number" && Number.isFinite(ts)) return ts;
  if (typeof ts === "string") {
    const parsed = Date.parse(ts);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function WorkingIndicator({ t }: { t: ReturnType<typeof useT> }) {
  return (
    <div className="flex items-center gap-3 text-xs text-muted">
      <LoaderCircle size={14} className="animate-spin text-muted" aria-hidden="true" />
      <span>{t("transcriptPiWorking")}</span>
    </div>
  );
}

function TranscriptView({ snapshot }: { snapshot: SubagentSessionSnapshot }) {
  const t = useT();
  const [expandedUserRows, setExpandedUserRows] = useState<ReadonlySet<string>>(new Set());
  const [historyExpanded, setHistoryExpanded] = useState(false);
  // The final-answer row starts collapsed as a clamped summary bubble and
  // expands on click (mirroring the collapsible task message).
  const [resultExpanded, setResultExpanded] = useState(false);
  const isRunning = snapshot.state === "running";
  const entries = snapshot.entries;
  const rows = useMemo(
    () =>
      buildTranscriptRows([], {
        entries,
        turnActive: snapshot.state === "running",
      }),
    [entries, snapshot.state],
  );
  const firstUserRowKey = useMemo(() => rows.find((row) => row.role === "user")?.key, [rows]);

  // Only finished runs collapse their intermediate tool/thinking history.
  // Splitting happens at the entry level: consecutive assistant messages are
  // merged into one transcript row, so the row model alone cannot separate
  // the intermediate operations from the final answer.
  const collapsible = snapshot.state !== "running";
  const firstUserIndex = useMemo(
    () => entries.findIndex((entry) => isMessageEntry(entry) && entry.message?.role === "user"),
    [entries],
  );
  const lastAssistantIndex = useMemo(() => {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (isMessageEntry(entry) && entry.message?.role === "assistant") return index;
    }
    return -1;
  }, [entries]);
  const collapsedMode = collapsible && firstUserIndex >= 0 && lastAssistantIndex > firstUserIndex;

  const userRows = useMemo(
    () =>
      collapsedMode
        ? buildTranscriptRows([], {
            entries: entries.slice(0, firstUserIndex + 1),
            turnActive: false,
          })
        : [],
    [collapsedMode, entries, firstUserIndex],
  );
  const middleRows = useMemo(
    () =>
      collapsedMode
        ? buildTranscriptRows([], {
            entries: entries.slice(firstUserIndex + 1, lastAssistantIndex),
            turnActive: false,
          })
        : [],
    [collapsedMode, entries, firstUserIndex, lastAssistantIndex],
  );
  const resultRows = useMemo(
    () =>
      collapsedMode
        ? buildTranscriptRows([], { entries: entries.slice(lastAssistantIndex), turnActive: false })
        : [],
    [collapsedMode, entries, lastAssistantIndex],
  );
  const firstUserRow = [...userRows].reverse().find((row) => row.role === "user");
  const resultRow = [...resultRows].reverse().find((row) => row.role === "assistant");
  const duration = runDurationLabel(
    firstUserIndex >= 0
      ? entryTimeMs(entries[firstUserIndex] as { timestamp?: unknown })
      : undefined,
    lastAssistantIndex >= 0
      ? entryTimeMs(entries[lastAssistantIndex] as { timestamp?: unknown })
      : undefined,
    t,
  );
  const summary = runSummaryLabel(snapshot.state, duration, t);

  // DSH-style fold summary: counts of the folded process ride the run summary,
  // consistent with the main session's turn fold ("N tool calls · M messages").
  const foldToolCount = middleRows.reduce(
    (count, row) =>
      count +
      row.blocks.filter((block) => block.kind === "tool" || block.kind === "extension").length,
    0,
  );
  const foldMessageCount = middleRows.reduce(
    (count, row) => count + row.blocks.filter((block) => block.kind === "text").length,
    0,
  );
  const foldCounts =
    foldToolCount + foldMessageCount > 0
      ? t("transcriptTurnFoldSummary", { tools: foldToolCount, messages: foldMessageCount })
      : undefined;

  useEffect(() => {
    setExpandedUserRows((current) => {
      if (!firstUserRowKey) return current.size === 0 ? current : new Set();
      if (current.size === 0 || (current.size === 1 && current.has(firstUserRowKey))) {
        return current;
      }
      return current.has(firstUserRowKey) ? new Set([firstUserRowKey]) : new Set();
    });
  }, [firstUserRowKey]);

  // While the run is active, the tail assistant row renders in the main
  // session's streaming style: live caret, working header and an active
  // execution-trace spinner. Finished runs stay fully static.
  const tailRow = rows[rows.length - 1];
  const workingRowKey = isRunning && tailRow?.role === "assistant" ? tailRow.key : undefined;

  // The final answer row: the collapsed layout renders it from its own
  // `resultRows` slice, whose key is the LAST assistant entry of the turn,
  // while the full row list keys the merged turn by its FIRST entry. Match on
  // the sliced row when the collapsed layout is active, and fall back to the
  // tail assistant row (a finished run without a task message to anchor it).
  const tailAssistantRowKey = collapsible
    ? [...rows].reverse().find((row) => row.role === "assistant")?.key
    : undefined;
  const resultRowKey = collapsedMode && resultRow ? resultRow.key : tailAssistantRowKey;
  const renderRow = (row: TranscriptRow, isFirstUser = row.key === firstUserRowKey) => {
    const working = row.key === workingRowKey;
    const isResult = row.key === resultRowKey;
    return (
      <div className="transcript-row" data-row-key={row.key} key={row.key}>
        <TranscriptRowView
          row={row}
          mode={working ? "streaming" : "static"}
          showCaret={working}
          working={working}
          turnFold={false}
          retryableTurn={undefined}
          retryVisible={false}
          goOnVisible={false}
          onRetry={async () => undefined}
          readOnly
          userCollapsible={isFirstUser}
          userExpanded={isFirstUser && expandedUserRows.has(row.key)}
          onToggleUser={
            isFirstUser
              ? () =>
                  setExpandedUserRows((current) =>
                    current.has(row.key) ? new Set() : new Set([row.key]),
                  )
              : undefined
          }
          resultCollapsible={isResult && collapsible}
          resultExpanded={isResult ? resultExpanded : true}
          onToggleResult={
            isResult && collapsible ? () => setResultExpanded((current) => !current) : undefined
          }
        />
      </div>
    );
  };

  return (
    <div className="border-t border-border bg-surface/60">
      {snapshot.truncated && (
        <div className="mx-3 mt-3 rounded border border-border bg-surface-overlay px-2 py-1.5 text-[10px] text-muted">
          {t("subagentsConversationTruncated")}
        </div>
      )}
      <div className="conversation-content-width mx-auto flex flex-col gap-5 px-3 py-4 sm:gap-6">
        {rows.length === 0 ? (
          <div className="flex min-h-20 items-center justify-center text-center text-xs text-muted">
            {isRunning ? <WorkingIndicator t={t} /> : t("subagentsNoConversation")}
          </div>
        ) : collapsedMode && firstUserRow && resultRow ? (
          <>
            {renderRow(firstUserRow, true)}
            <button
              type="button"
              className="flex w-full items-center justify-center gap-1.5 rounded border border-border bg-surface-overlay px-3 py-2 text-xs text-muted transition-colors hover:text-foreground"
              aria-expanded={historyExpanded}
              onClick={() => setHistoryExpanded((current) => !current)}
            >
              <span className="font-medium">{summary}</span>
              {foldCounts && <span className="ml-2 font-medium text-muted/80">{foldCounts}</span>}
              {historyExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
            {historyExpanded && middleRows.map((row) => renderRow(row, false))}
            {renderRow(resultRow, false)}
          </>
        ) : (
          <>
            {rows.map((row) => renderRow(row))}
            {isRunning && !workingRowKey && (
              <div className="transcript-row">
                <WorkingIndicator t={t} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function InlineNode({
  node,
  depth,
  expanded,
  snapshot,
  loading,
  loadError,
  pendingAction,
  onToggle,
  onAction,
  onRetry,
}: {
  node: SubagentStatusNode;
  depth: number;
  expanded: boolean;
  snapshot: SubagentSessionSnapshot | null;
  loading: boolean;
  loadError: boolean;
  pendingAction: (action: string) => boolean;
  onToggle: () => void;
  onAction: (action: "stop" | "pause" | "continue" | "resume") => void;
  onRetry: () => void;
}) {
  const t = useT();
  const displayName = node.name ?? node.label;
  const role = node.role?.trim();
  const localizedRole = subagentRoleLabel(role, t);
  const badge = subagentRoleEmoji(role) ?? localizedRole;
  const showRole = Boolean(badge && role !== displayName);
  return (
    <div
      className="group"
      data-subagent-node={node.id}
      onContextMenu={(event) => {
        if (shouldKeepNativeContextMenu(event.nativeEvent)) return;
        event.preventDefault();
        event.stopPropagation();
        openContextMenu({
          x: event.clientX,
          y: event.clientY,
          trigger: contextMenuTrigger(event.target),
          items: [
            {
              id: "subagents.copyId",
              label: t("subagentsCopyId"),
              icon: Copy,
              onSelect: () => navigator.clipboard.writeText(node.id),
            },
          ],
        });
      }}
    >
      <div
        className={`flex w-full min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-surface-overlay ${expanded ? "bg-surface-overlay" : ""}`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={expanded}
          aria-label={displayName}
          onClick={onToggle}
          title={
            [
              node.label !== displayName ? node.label : undefined,
              node.model ? t("subagentsModel", { model: node.model }) : undefined,
            ]
              .filter(Boolean)
              .join("\n") || undefined
          }
        >
          {showRole && (
            <span
              className="max-w-24 shrink-0 truncate rounded px-1 py-0.5 text-[11px] text-muted"
              title={t("subagentsRole", { role: localizedRole ?? "" })}
              aria-label={t("subagentsRole", { role: localizedRole ?? "" })}
            >
              {badge}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate font-medium text-foreground">{displayName}</span>
          {node.activity?.currentTool && (
            <span className="max-w-24 truncate text-[10px] text-muted">
              {node.activity.currentTool}
            </span>
          )}
        </button>
        {node.state === "running" && (
          <button
            type="button"
            className="flex size-6 shrink-0 items-center justify-center rounded text-warning opacity-0 transition-opacity hover:bg-warning/15 hover:text-warning group-hover:opacity-100 focus-visible:opacity-100 disabled:cursor-wait disabled:opacity-60"
            title={t("subagentsPause")}
            aria-label={t("subagentsPause")}
            disabled={pendingAction("pause")}
            onClick={(event) => {
              event.stopPropagation();
              onAction("pause");
            }}
          >
            <Pause size={12} fill="currentColor" />
          </button>
        )}
        {node.state === "paused" && (
          <button
            type="button"
            className="flex size-6 shrink-0 items-center justify-center rounded text-success opacity-0 transition-opacity hover:bg-success/15 hover:text-success group-hover:opacity-100 focus-visible:opacity-100 disabled:cursor-wait disabled:opacity-60"
            title={t("subagentsContinue")}
            aria-label={t("subagentsContinue")}
            disabled={pendingAction("continue")}
            onClick={(event) => {
              event.stopPropagation();
              onAction("continue");
            }}
          >
            <Play size={12} fill="currentColor" />
          </button>
        )}
        {node.state === "failed" && (
          <button
            type="button"
            className="flex size-6 shrink-0 items-center justify-center rounded text-success opacity-0 transition-opacity hover:bg-success/15 hover:text-success group-hover:opacity-100 focus-visible:opacity-100 disabled:cursor-wait disabled:opacity-60"
            title={t("subagentsResume")}
            aria-label={t("subagentsResume")}
            disabled={pendingAction("resume")}
            onClick={(event) => {
              event.stopPropagation();
              onAction("resume");
            }}
          >
            <RotateCcw size={12} />
          </button>
        )}
        {(node.state === "running" || node.state === "paused" || node.state === "queued") && (
          <button
            type="button"
            className="flex size-6 shrink-0 items-center justify-center rounded text-danger opacity-0 transition-opacity hover:bg-danger/15 hover:text-danger group-hover:opacity-100 focus-visible:opacity-100 disabled:cursor-wait disabled:opacity-60"
            title={t("subagentsStop")}
            aria-label={t("subagentsStop")}
            disabled={pendingAction("stop")}
            onClick={(event) => {
              event.stopPropagation();
              onAction("stop");
            }}
          >
            <Square size={12} fill="currentColor" />
          </button>
        )}
        <span
          className={`shrink-0 ${subagentStateClass(node.state)}`}
          aria-label={subagentStateLabel(node.state, t)}
          title={subagentStateLabel(node.state, t)}
        >
          {node.state === "running" ? (
            <LoaderCircle size={13} className="animate-spin" aria-hidden="true" />
          ) : (
            <span className="text-[10px]">{subagentStateLabel(node.state, t)}</span>
          )}
        </span>
      </div>
      <div
        className={`grid overflow-hidden transition-[grid-template-rows] duration-150 ease-out ${expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
        aria-hidden={!expanded}
      >
        <div className="min-h-0 overflow-hidden" style={{ marginLeft: `${depth * 14}px` }}>
          {snapshot ? (
            <TranscriptView snapshot={snapshot} />
          ) : (
            <div className="border-t border-border px-6 py-4 text-xs">
              {loading ? (
                <div className="text-muted">{t("subagentsLoadingConversation")}</div>
              ) : loadError ? (
                <div className="flex flex-col items-start gap-2">
                  <span className="text-danger">{t("subagentsLoadFailed")}</span>
                  <button
                    type="button"
                    className="rounded border border-border px-2 py-1 text-muted hover:bg-surface-overlay hover:text-foreground"
                    onClick={onRetry}
                  >
                    {t("transcriptRetryMessage")}
                  </button>
                </div>
              ) : (
                <div className="text-muted">{t("subagentsLoadingConversation")}</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function SubagentsPanel() {
  const t = useT();
  const status = useAppStore((state) => state.subagentsStatus);
  const subagentsFocusNodeId = useAppStore((state) => state.subagentsFocusNodeId);
  const focusSubagent = useAppStore((state) => state.focusSubagent);
  const host = useAppStore((state) => state.host);
  const workspace = useAppStore((state) => state.workspace);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<Record<string, SubagentSessionSnapshot>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);
  const [pendingActions, setPendingActions] = useState<ReadonlySet<string>>(new Set());
  const isPending = useCallback(
    (nodeId: string, action: string) => pendingActions.has(`${nodeId}:${action}`),
    [pendingActions],
  );
  const hasRuns = status.runs.length > 0;
  const activeCount = useMemo(
    () => flattenNodes(status.runs).filter(({ node }) => node.state === "running").length,
    [status.runs],
  );
  const nodes = useMemo(() => flattenNodes(status.runs), [status.runs]);

  useEffect(() => {
    if (expandedId && !nodes.some(({ node }) => node.id === expandedId)) {
      setExpandedId(null);
    }
  }, [expandedId, nodes]);

  // A popover/click request (see SubagentsPopoverButton) hands over the node
  // to expand; consume it so later tab visits don't re-expand.
  useEffect(() => {
    if (!subagentsFocusNodeId) return;
    setExpandedId(subagentsFocusNodeId);
    focusSubagent(null);
  }, [subagentsFocusNodeId, focusSubagent]);

  const loadSession = useCallback(
    async (target: SubagentStatusNode) => {
      if (!host || !workspace) return;
      setLoadingId(target.id);
      try {
        const response = await hostClient.request(
          "subagents.getSession",
          workspaceContext(host, workspace),
          { nodeId: target.id },
          15_000,
        );
        if (response.ok) {
          setSnapshots((current) => ({ ...current, [target.id]: response.result }));
          setErrorId((current) => (current === target.id ? null : current));
        } else {
          setErrorId(target.id);
        }
      } catch {
        setErrorId(target.id);
      } finally {
        setLoadingId((current) => (current === target.id ? null : current));
      }
    },
    [host, workspace],
  );

  const expandedNode = useMemo(
    () => (expandedId ? (nodes.find(({ node }) => node.id === expandedId)?.node ?? null) : null),
    [expandedId, nodes],
  );
  // The expanded run's primitive state drives the load/poll lifecycle: status
  // updates that merely replace the node object identity must not re-run the
  // effect, or a finished conversation would be re-fetched on every status
  // poll while a sibling keeps running. The node object itself is read
  // through the ref; only expansion, state change or a host switch re-arms.
  const expandedState = expandedNode?.state;
  const expandedNodeRef = useRef(expandedNode);
  expandedNodeRef.current = expandedNode;
  useEffect(() => {
    const target = expandedNodeRef.current;
    if (!expandedId || !target || !host || !workspace) return;
    void loadSession(target);
    const interval =
      target.state === "running"
        ? window.setInterval(() => void loadSession(target), 1_500)
        : undefined;
    return () => {
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [expandedId, expandedState, host, workspace, loadSession]);

  const runControl = useCallback(
    async (node: SubagentStatusNode, action: "stop" | "pause" | "continue" | "resume") => {
      if (!host || !workspace) return;
      const key = `${node.id}:${action}`;
      setPendingActions((current) => new Set(current).add(key));
      try {
        const method = {
          stop: "subagents.stop",
          pause: "subagents.pause",
          continue: "subagents.continue",
          resume: "subagents.resume",
        }[action] as
          "subagents.stop" | "subagents.pause" | "subagents.continue" | "subagents.resume";
        await hostClient.request(
          method,
          workspaceContext(host, workspace),
          { nodeId: node.id },
          15_000,
        );
      } finally {
        setPendingActions((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [host, workspace],
  );

  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      aria-label={t("dockSubagents")}
      data-subagents-panel
    >
      <div className="flex shrink-0 items-center border-b border-border px-3 py-2">
        <span className="text-[10px] text-white">
          {t("subagentsActiveCount", { count: activeCount })}
        </span>
      </div>
      {!status.available ? (
        <div className="flex h-full min-h-32 flex-col items-center justify-center gap-2 px-6 text-center text-xs text-muted">
          <CircleAlert size={18} />
          <p>{t("subagentsUnavailableBody")}</p>
        </div>
      ) : !hasRuns ? (
        <div className="flex h-full min-h-32 items-center justify-center px-6 text-center text-xs text-muted">
          {t("subagentsEmpty")}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-1.5">
          {nodes.map(({ node, depth }) => (
            <InlineNode
              key={node.id}
              node={node}
              depth={depth}
              expanded={expandedId === node.id}
              snapshot={snapshots[node.id] ?? null}
              loading={loadingId === node.id}
              loadError={errorId === node.id}
              pendingAction={(action) => isPending(node.id, action)}
              onToggle={() => setExpandedId((current) => (current === node.id ? null : node.id))}
              onAction={(action) => void runControl(node, action)}
              onRetry={() => void loadSession(node)}
            />
          ))}
        </div>
      )}
      {status.omitted > 0 && (
        <div className="shrink-0 border-t border-border px-3 py-1.5 text-[10px] text-muted">
          {t("subagentsOmitted", { count: status.omitted })}
        </div>
      )}
    </section>
  );
}

/** Composer-toolbar trigger next to the todo button. Shows a compact fleet
 * overview popover so subagent activity stays visible even when the right
 * dock (and its subagents tab) is closed; the "view" action opens the tab. */
export function SubagentsPopoverButton() {
  const t = useT();
  const status = useAppStore((state) => state.subagentsStatus);
  const focusSubagent = useAppStore((state) => state.focusSubagent);
  const [open, setOpen] = useState(false);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLElement>(null);
  const contentId = useId();

  const nodes = useMemo(() => flattenNodes(status.runs), [status.runs]);
  const runningCount = useMemo(
    () => nodes.filter(({ node }) => node.state === "running").length,
    [nodes],
  );
  const failedCount = useMemo(
    () => nodes.filter(({ node }) => node.state === "failed" || node.state === "rejected").length,
    [nodes],
  );

  const openSubagent = (nodeId: string) => {
    setOpen(false);
    focusSubagent(nodeId);
    requestDockCommand({ kind: "activate-subagents" });
  };

  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || nodes.length === 0) return;

    const updatePosition = () => {
      const button = buttonRef.current;
      if (!button) return;
      const rect = button.getBoundingClientRect();
      const margin = 8;
      const gap = 8;
      const maxWidth = Math.min(384, Math.max(1, window.innerWidth - margin * 2));
      const right = Math.min(
        Math.max(margin, window.innerWidth - rect.right),
        Math.max(margin, window.innerWidth - maxWidth - margin),
      );
      const availableHeight = Math.max(1, rect.top - gap - margin);
      setPopoverStyle({
        right,
        bottom: Math.max(margin, window.innerHeight - rect.top + gap),
        maxWidth,
        maxHeight: Math.min(280, availableHeight),
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, nodes.length]);

  // Keep the popover meaningful: hide the trigger when the extension is
  // missing or no run exists (mirrors the todo button's visibility rule).
  if (!status.available || nodes.length === 0) return null;

  const button = (
    <button
      ref={buttonRef}
      type="button"
      aria-expanded={open}
      aria-controls={contentId}
      aria-label={t("subagentsTitle")}
      title={t("subagentsTitle")}
      className={`relative flex size-7 items-center justify-center rounded-md transition-colors ${
        open
          ? "bg-accent/15 text-accent"
          : "text-muted hover:bg-surface-overlay hover:text-foreground"
      }`}
      onClick={() => setOpen((value) => !value)}
    >
      <Bot size={15} />
      {runningCount > 0 ? (
        <span
          className="absolute -right-1 -top-1 flex min-w-3.5 items-center justify-center rounded-full bg-accent px-0.5 text-[9px] font-medium leading-3.5 text-white"
          aria-hidden="true"
        >
          {runningCount}
        </span>
      ) : failedCount > 0 ? (
        <span
          className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-danger"
          aria-hidden="true"
        />
      ) : null}
    </button>
  );
  const popover = open ? (
    <section
      ref={popoverRef}
      id={contentId}
      className="theme-floating-surface fixed z-50 flex flex-col overflow-hidden rounded-lg border border-border bg-surface-raised shadow-xl"
      style={popoverStyle ?? { visibility: "hidden", right: 0, bottom: 0 }}
      aria-label={t("subagentsTitle")}
    >
      <div className="flex min-h-9 shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <Bot size={15} className="shrink-0 text-accent" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {t("subagentsTitle")}
        </span>
        {runningCount > 0 && (
          <span className="shrink-0 rounded-full bg-surface-overlay px-2 py-0.5 text-xs text-muted">
            {t("subagentsActiveCount", { count: runningCount })}
          </span>
        )}
      </div>
      <div className="scrollbar-subtle min-h-0 overflow-y-auto p-2">
        {nodes.length === 0 ? (
          <div className="px-2 py-3 text-center text-xs text-muted">{t("subagentsEmpty")}</div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {nodes.map(({ node, depth }) => {
              const displayName = node.name ?? node.label;
              const role = node.role?.trim();
              const localizedRole = subagentRoleLabel(role, t);
              const badge = subagentRoleEmoji(role) ?? localizedRole;
              const showRole = Boolean(badge && role !== displayName);
              return (
                <li key={node.id}>
                  <button
                    type="button"
                    className="flex w-full min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-surface-overlay"
                    style={{ paddingLeft: `${8 + depth * 14}px` }}
                    title={displayName}
                    onClick={() => openSubagent(node.id)}
                  >
                    {showRole && (
                      <span
                        className="max-w-16 shrink-0 truncate text-[11px] text-muted"
                        title={t("subagentsRole", { role: localizedRole ?? "" })}
                      >
                        {badge}
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                      {displayName}
                    </span>
                    {node.activity?.currentTool && (
                      <span className="max-w-20 truncate text-[10px] text-muted">
                        {node.activity.currentTool}
                      </span>
                    )}
                    <span
                      className={`shrink-0 ${subagentStateClass(node.state)}`}
                      aria-label={subagentStateLabel(node.state, t)}
                      title={subagentStateLabel(node.state, t)}
                    >
                      {node.state === "running" ? (
                        <LoaderCircle size={13} className="animate-spin" aria-hidden="true" />
                      ) : (
                        <span className="text-[10px]">{subagentStateLabel(node.state, t)}</span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {status.omitted > 0 && (
        <div className="shrink-0 border-t border-border px-3 py-1.5 text-[10px] text-muted">
          {t("subagentsOmitted", { count: status.omitted })}
        </div>
      )}
    </section>
  ) : null;

  return (
    <>
      {button}
      {typeof document === "undefined" || !popoverStyle || !popover
        ? null
        : createPortal(popover, document.body)}
    </>
  );
}
