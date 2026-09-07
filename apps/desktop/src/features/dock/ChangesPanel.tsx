import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type {
  GitBranchList,
  GitChangeKind,
  GitCommitDiffSnapshot,
  GitCommitSummary,
  GitDiffHunk,
  GitDiffSnapshot,
  GitFileChange,
  GitStatusSnapshot,
  HostError,
} from "@piabyss/protocol";
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ArrowUpToLine,
  ArrowDownToLine,
  Check,
  ChevronDown,
  FileCode2,
  GitBranch,
  GitBranchPlus,
  GitCommitHorizontal,
  GitCompareArrows,
  LoaderCircle,
  History,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Undo2,
} from "lucide-react";
import { Dialog } from "../../components/Dialog";
import { hostClient } from "../../lib/bridge/host-client";
import { workspaceContext } from "../../lib/bridge/host-context";
import { subscribeValidatedHostEvent } from "../../lib/bridge/validated-host-events";
import { contextMenuTrigger, openContextMenu } from "../../lib/context-menu";
import { useLocale, useT, type Translate } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";

type ReadyStatus = Extract<GitStatusSnapshot, { state: "ready" }>;
type DiffSelection = { path: string; area: "staged" | "unstaged" };
type GitView = "changes" | "history";
type ListRow =
  | { kind: "header"; area: "staged" | "unstaged"; count: number }
  | { kind: "file"; area: "staged" | "unstaged"; file: GitFileChange };

type DiffLine = {
  content: string;
  kind: "addition" | "deletion" | "hunk" | "meta" | "context";
  oldLine: number | null;
  newLine: number | null;
};

function splitPath(path: string): { name: string; directory: string } {
  const index = path.lastIndexOf("/");
  return index < 0
    ? { name: path, directory: "" }
    : { name: path.slice(index + 1), directory: path.slice(0, index) };
}

export function gitChangeLetter(change: GitChangeKind): string {
  switch (change) {
    case "added":
      return "A";
    case "modified":
      return "M";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "type_changed":
      return "T";
    case "untracked":
      return "U";
    case "conflicted":
      return "!";
  }
}

function changeLabel(change: GitChangeKind, t: Translate): string {
  switch (change) {
    case "added":
      return t("gitChangeAdded");
    case "modified":
      return t("gitChangeModified");
    case "deleted":
      return t("gitChangeDeleted");
    case "renamed":
      return t("gitChangeRenamed");
    case "copied":
      return t("gitChangeCopied");
    case "type_changed":
      return t("gitChangeTypeChanged");
    case "untracked":
      return t("gitChangeUntracked");
    case "conflicted":
      return t("gitChangeConflicted");
  }
}

function errorMessage(error: HostError | undefined, fallback: string, t: Translate): string {
  if (!error) return fallback;
  switch (error.code) {
    case "GIT_UNAVAILABLE":
      return t("gitUnavailable");
    case "GIT_OUTPUT_LIMIT":
      return t("gitOutputTooLarge");
    case "STALE_REVISION":
      return t("gitStatusStale");
    case "SERVICE_GRAPH_BUSY":
      return t("gitBusy");
    default:
      return error.message || fallback;
  }
}

function pullErrorMessage(error: HostError | undefined, t: Translate): string {
  const message = error?.message ?? "";
  if (
    /cannot pull with rebase|please commit or stash|local changes.*would be overwritten/i.test(
      message,
    )
  ) {
    return t("gitPullRequiresCleanWorktree");
  }
  return errorMessage(error, t("gitPullFailed"), t);
}

export function buildGitListRows(status: ReadyStatus): ListRow[] {
  const unstaged = status.files.filter((file) => file.unstaged !== null);
  const staged = status.files.filter((file) => file.staged !== null);
  const rows: ListRow[] = [];
  if (unstaged.length > 0) {
    rows.push({ kind: "header", area: "unstaged", count: unstaged.length });
    rows.push(
      ...unstaged.map((file) => ({ kind: "file" as const, area: "unstaged" as const, file })),
    );
  }
  if (staged.length > 0) {
    rows.push({ kind: "header", area: "staged", count: staged.length });
    rows.push(...staged.map((file) => ({ kind: "file" as const, area: "staged" as const, file })));
  }
  return rows;
}

export function parseUnifiedDiffLines(patch: string): DiffLine[] {
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  return patch.split("\n").map((content) => {
    if (content.startsWith("diff --git ")) {
      inHunk = false;
      return { content, kind: "meta", oldLine: null, newLine: null };
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(content);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      return { content, kind: "hunk", oldLine: null, newLine: null };
    }
    if (!inHunk || content.startsWith("\\ No newline")) {
      return { content, kind: "meta", oldLine: null, newLine: null };
    }
    if (content.startsWith("+") && !content.startsWith("+++")) {
      const line = { content, kind: "addition" as const, oldLine: null, newLine };
      newLine += 1;
      return line;
    }
    if (content.startsWith("-") && !content.startsWith("---")) {
      const line = { content, kind: "deletion" as const, oldLine, newLine: null };
      oldLine += 1;
      return line;
    }
    const line = { content, kind: "context" as const, oldLine, newLine };
    oldLine += 1;
    newLine += 1;
    return line;
  });
}

export function canDiscardGitChange(file: GitFileChange): boolean {
  return Boolean(
    file.pathSupported &&
    !file.conflict &&
    !file.submodule &&
    file.unstaged !== null &&
    !["untracked", "conflicted", "renamed", "copied"].includes(file.unstaged),
  );
}

function isSelectionPresent(status: ReadyStatus, selection: DiffSelection): boolean {
  const file = status.files.find((candidate) => candidate.path === selection.path);
  return Boolean(file && file[selection.area] !== null);
}

export function ChangesPanel({ visible }: { visible: boolean }) {
  const t = useT();
  const locale = useLocale();
  const host = useAppStore((state) => state.host);
  const workspace = useAppStore((state) => state.workspace);
  const pushNotification = useAppStore((state) => state.pushNotification);
  const [snapshot, setSnapshot] = useState<GitStatusSnapshot | null>(null);
  const [view, setView] = useState<GitView>("changes");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<DiffSelection | null>(null);
  const [diff, setDiff] = useState<GitDiffSnapshot | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [operation, setOperation] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [generatingMessage, setGeneratingMessage] = useState(false);
  const [commitSha, setCommitSha] = useState<string | null>(null);
  const [discardTarget, setDiscardTarget] = useState<GitFileChange | null>(null);
  const [hunkDiscardTarget, setHunkDiscardTarget] = useState<GitDiffHunk | null>(null);
  const [branchLoading, setBranchLoading] = useState(false);
  const [createBranchOpen, setCreateBranchOpen] = useState(false);
  const [branchName, setBranchName] = useState("");
  const [history, setHistory] = useState<GitCommitSummary[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [selectedCommit, setSelectedCommit] = useState<GitCommitSummary | null>(null);
  const [commitDiff, setCommitDiff] = useState<GitCommitDiffSnapshot | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const workspaceKey =
    host && workspace ? `${host.hostInstanceId}:${workspace.id}:${workspace.revision}` : "none";
  // workspaceContext() reads only hostInstanceId/workspaceId/workspaceRevision
  // — all embodied by workspaceKey. The host/workspace objects themselves are
  // rebuilt by the store on every streamed agent event, so memoizing the
  // context on workspaceKey keeps the watch effects below from tearing down
  // and re-arming the Git watcher once per animation frame.
  const gitWatchContext = useMemo(
    () => (host && workspace ? workspaceContext(host, workspace) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspaceKey],
  );
  const historyHeadKey =
    snapshot?.state === "ready"
      ? `${snapshot.branch ?? "detached"}:${snapshot.headSha ?? "unborn"}`
      : "none";

  const acceptSnapshot = useCallback((next: GitStatusSnapshot) => {
    setSnapshot((current) => (current && current.revision > next.revision ? current : next));
    setError(null);
  }, []);

  useEffect(() => {
    if (!selection || (snapshot?.state === "ready" && isSelectionPresent(snapshot, selection))) {
      return;
    }
    setSelection(null);
    setDiff(null);
  }, [selection, snapshot]);

  useEffect(() => {
    generation.current += 1;
    setSnapshot(null);
    setView("changes");
    setLoading(false);
    setError(null);
    setSelection(null);
    setDiff(null);
    setDiffLoading(false);
    setOperation(null);
    setCommitMessage("");
    setGeneratingMessage(false);
    setCommitSha(null);
    setDiscardTarget(null);
    setHunkDiscardTarget(null);
    setBranchLoading(false);
    setCreateBranchOpen(false);
    setBranchName("");
    setHistory([]);
    setHistoryCursor(null);
    setHistoryLoading(false);
    setHistoryLoaded(false);
    setSelectedCommit(null);
    setCommitDiff(null);
  }, [workspaceKey]);

  useEffect(() => {
    setHistory([]);
    setHistoryCursor(null);
    setHistoryLoaded(false);
  }, [historyHeadKey]);

  const refresh = useCallback(async () => {
    if (!host || !workspace) return;
    const requestGeneration = generation.current;
    setLoading(true);
    try {
      const response = await hostClient.request(
        "git.getStatus",
        workspaceContext(host, workspace),
        null,
        12_000,
      );
      if (requestGeneration !== generation.current) return;
      if (!response.ok) {
        setError(errorMessage(response.error, t("gitLoadFailed"), t));
        return;
      }
      acceptSnapshot(response.result);
    } catch (requestError) {
      if (requestGeneration === generation.current) {
        setError(requestError instanceof Error ? requestError.message : t("gitLoadFailed"));
      }
    } finally {
      if (requestGeneration === generation.current) setLoading(false);
    }
  }, [acceptSnapshot, host, t, workspace]);

  useEffect(() => {
    if (!visible || !gitWatchContext) return;
    const requestGeneration = ++generation.current;
    const context = gitWatchContext;
    setLoading(true);
    void hostClient
      .request("git.setWatching", context, { enabled: true }, 12_000)
      .then((response) => {
        if (requestGeneration !== generation.current) return;
        if (!response.ok) {
          setError(errorMessage(response.error, t("gitLoadFailed"), t));
          return;
        }
        if (response.result.snapshot) acceptSnapshot(response.result.snapshot);
      })
      .catch((requestError) => {
        if (requestGeneration === generation.current) {
          setError(requestError instanceof Error ? requestError.message : t("gitLoadFailed"));
        }
      })
      .finally(() => {
        if (requestGeneration === generation.current) setLoading(false);
      });
    return () => {
      generation.current += 1;
      void hostClient
        .request("git.setWatching", context, { enabled: false }, 12_000)
        .catch(() => undefined);
    };
  }, [visible, gitWatchContext, acceptSnapshot, t]);

  useEffect(
    () =>
      gitWatchContext
        ? subscribeValidatedHostEvent("git.changed", gitWatchContext, (event) => {
            if (visible) acceptSnapshot(event.payload.snapshot);
          })
        : undefined,
    [acceptSnapshot, gitWatchContext, visible],
  );

  const ready = snapshot?.state === "ready" ? snapshot : null;
  const rows = useMemo(() => (ready ? buildGitListRows(ready) : []), [ready]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listRef.current,
    estimateSize: (index) => (rows[index]?.kind === "header" ? 30 : 36),
    getItemKey: (index) => {
      const row = rows[index];
      return row?.kind === "file" ? `${row.area}:${row.file.path}` : `header:${row?.area ?? index}`;
    },
    overscan: 12,
  });

  const loadDiff = async (next: DiffSelection) => {
    if (!host || !workspace || !ready) return;
    const requestGeneration = generation.current;
    setSelection(next);
    setDiff(null);
    setDiffLoading(true);
    setError(null);
    try {
      const response = await hostClient.request(
        "git.getDiff",
        workspaceContext(host, workspace),
        { ...next, expectedRevision: ready.revision },
        12_000,
      );
      if (requestGeneration !== generation.current) return;
      if (!response.ok) {
        setError(errorMessage(response.error, t("gitDiffFailed"), t));
        if (response.error?.code === "STALE_REVISION") void refresh();
        return;
      }
      setDiff(response.result);
    } catch (requestError) {
      if (requestGeneration === generation.current) {
        setError(requestError instanceof Error ? requestError.message : t("gitDiffFailed"));
      }
    } finally {
      if (requestGeneration === generation.current) setDiffLoading(false);
    }
  };

  const loadHistory = async (append = false) => {
    if (!host || !workspace || historyLoading) return;
    const requestGeneration = generation.current;
    setHistoryLoading(true);
    setError(null);
    try {
      const response = await hostClient.request(
        "git.listHistory",
        workspaceContext(host, workspace),
        { limit: 50, ...(append && historyCursor ? { cursor: historyCursor } : {}) },
        12_000,
      );
      if (requestGeneration !== generation.current) return;
      if (!response.ok) {
        setError(errorMessage(response.error, t("gitHistoryFailed"), t));
        return;
      }
      setHistory((current) =>
        append ? [...current, ...response.result.commits] : response.result.commits,
      );
      setHistoryCursor(response.result.nextCursor);
      setHistoryLoaded(true);
    } catch (requestError) {
      if (requestGeneration === generation.current) {
        setError(requestError instanceof Error ? requestError.message : t("gitHistoryFailed"));
      }
    } finally {
      if (requestGeneration === generation.current) setHistoryLoading(false);
    }
  };

  const loadCommitDiff = async (commit: GitCommitSummary) => {
    if (!host || !workspace) return;
    const requestGeneration = generation.current;
    setSelectedCommit(commit);
    setCommitDiff(null);
    setDiffLoading(true);
    setError(null);
    try {
      const response = await hostClient.request(
        "git.getCommitDiff",
        workspaceContext(host, workspace),
        { commitSha: commit.sha },
        12_000,
      );
      if (requestGeneration !== generation.current) return;
      if (!response.ok) {
        setError(errorMessage(response.error, t("gitDiffFailed"), t));
        return;
      }
      setCommitDiff(response.result);
    } catch (requestError) {
      if (requestGeneration === generation.current) {
        setError(requestError instanceof Error ? requestError.message : t("gitDiffFailed"));
      }
    } finally {
      if (requestGeneration === generation.current) setDiffLoading(false);
    }
  };

  const mutateHunk = async (hunk: GitDiffHunk, hunkOperation: "stage" | "unstage" | "discard") => {
    if (!host || !workspace || !ready || !selection || !diff) return;
    const requestGeneration = generation.current;
    const key = `hunk:${hunkOperation}:${hunk.id}`;
    setOperation(key);
    setError(null);
    try {
      const response = await hostClient.request(
        "git.mutateHunk",
        workspaceContext(host, workspace),
        {
          ...selection,
          hunkId: hunk.id,
          operation: hunkOperation,
          expectedRevision: ready.revision,
          expectedContentGeneration: diff.contentGeneration,
        },
        32_000,
      );
      if (requestGeneration !== generation.current) return;
      if (!response.ok) {
        setError(errorMessage(response.error, t("gitOperationFailed"), t));
        if (response.error?.code === "STALE_REVISION") void refresh();
        return;
      }
      const next = response.result.snapshot;
      if (next) acceptSnapshot(next);
      if (response.result.warning) pushNotification(response.result.warning, "warning");
      if (hunkOperation === "discard") pushNotification(t("gitDiscardHunkSuccess"), "success");
      if (next?.state !== "ready" || !isSelectionPresent(next, selection)) {
        setSelection(null);
        setDiff(null);
        return;
      }
      const nextDiff = await hostClient.request(
        "git.getDiff",
        workspaceContext(host, workspace),
        { ...selection, expectedRevision: next.revision },
        12_000,
      );
      if (requestGeneration !== generation.current) return;
      if (nextDiff.ok) setDiff(nextDiff.result);
      else {
        setError(errorMessage(nextDiff.error, t("gitDiffFailed"), t));
        setDiff(null);
      }
    } catch (requestError) {
      if (requestGeneration === generation.current) {
        setError(requestError instanceof Error ? requestError.message : t("gitOperationFailed"));
      }
    } finally {
      if (requestGeneration === generation.current) setOperation(null);
    }
  };

  const mutateBranch = async (
    method: "git.createBranch" | "git.switchBranch",
    name: string,
    expectedRevision: number,
  ) => {
    if (!host || !workspace) return;
    const requestGeneration = generation.current;
    setOperation(method);
    setError(null);
    try {
      const response = await hostClient.request(
        method,
        workspaceContext(host, workspace),
        { name, expectedRevision },
        32_000,
      );
      if (requestGeneration !== generation.current) return;
      if (!response.ok) {
        setError(errorMessage(response.error, t("gitBranchOperationFailed"), t));
        if (response.error?.code === "STALE_REVISION") void refresh();
        return;
      }
      if (response.result.snapshot) acceptSnapshot(response.result.snapshot);
      else void refresh();
      setHistory([]);
      setHistoryCursor(null);
      setHistoryLoaded(false);
      setSelectedCommit(null);
      setCommitDiff(null);
      pushNotification(
        method === "git.createBranch"
          ? t("gitBranchCreated", { branch: name })
          : t("gitBranchSwitched", { branch: name }),
        "success",
      );
    } catch (requestError) {
      if (requestGeneration === generation.current) {
        setError(
          requestError instanceof Error ? requestError.message : t("gitBranchOperationFailed"),
        );
      }
    } finally {
      if (requestGeneration === generation.current) setOperation(null);
    }
  };

  const openBranchChooser = async (trigger: HTMLElement) => {
    if (!host || !workspace || branchLoading || operation) return;
    const requestGeneration = generation.current;
    const rect = trigger.getBoundingClientRect();
    setBranchLoading(true);
    setError(null);
    try {
      const response = await hostClient.request(
        "git.listBranches",
        workspaceContext(host, workspace),
        null,
        12_000,
      );
      if (requestGeneration !== generation.current) return;
      if (!response.ok) {
        setError(errorMessage(response.error, t("gitBranchLoadFailed"), t));
        return;
      }
      const result: GitBranchList = response.result;
      openContextMenu({
        x: rect.left,
        y: rect.bottom + 4,
        trigger,
        items: [
          ...result.branches.map((branch) => ({
            id: `git-branch:${branch.name}`,
            label: branch.name,
            icon: branch.current ? Check : GitBranch,
            disabled: branch.current || Boolean(operation),
            onSelect: () => mutateBranch("git.switchBranch", branch.name, result.statusRevision),
          })),
          {
            id: "git-create-branch",
            label: t("gitCreateBranch"),
            icon: GitBranchPlus,
            separatorBefore: result.branches.length > 0,
            onSelect: () => {
              setBranchName("");
              setCreateBranchOpen(true);
            },
          },
        ],
      });
      if (result.truncated) pushNotification(t("gitBranchListTruncated"), "warning");
    } catch (requestError) {
      if (requestGeneration === generation.current) {
        setError(requestError instanceof Error ? requestError.message : t("gitBranchLoadFailed"));
      }
    } finally {
      if (requestGeneration === generation.current) setBranchLoading(false);
    }
  };

  const mutate = async (file: GitFileChange, area: "staged" | "unstaged") => {
    if (!host || !workspace || !ready) return;
    const method = area === "unstaged" ? "git.stage" : "git.unstage";
    const key = `${method}:${file.path}`;
    const requestGeneration = generation.current;
    setOperation(key);
    setError(null);
    try {
      const response = await hostClient.request(
        method,
        workspaceContext(host, workspace),
        { path: file.path, expectedRevision: ready.revision },
        32_000,
      );
      if (requestGeneration !== generation.current) return;
      if (!response.ok) {
        setError(errorMessage(response.error, t("gitOperationFailed"), t));
        if (response.error?.code === "STALE_REVISION") void refresh();
        return;
      }
      if (response.result.snapshot) acceptSnapshot(response.result.snapshot);
      else void refresh();
      if (response.result.warning) pushNotification(response.result.warning, "warning");
    } catch (requestError) {
      if (requestGeneration === generation.current) {
        setError(requestError instanceof Error ? requestError.message : t("gitOperationFailed"));
      }
    } finally {
      if (requestGeneration === generation.current) setOperation(null);
    }
  };

  const mutateAll = async (area: "staged" | "unstaged") => {
    if (!host || !workspace || !ready) return;
    const method = area === "unstaged" ? "git.stageAll" : "git.unstageAll";
    const requestGeneration = generation.current;
    setOperation(method);
    setError(null);
    try {
      const response = await hostClient.request(
        method,
        workspaceContext(host, workspace),
        { expectedRevision: ready.revision },
        32_000,
      );
      if (requestGeneration !== generation.current) return;
      if (!response.ok) {
        setError(errorMessage(response.error, t("gitOperationFailed"), t));
        if (response.error?.code === "STALE_REVISION") void refresh();
        return;
      }
      if (response.result.snapshot) acceptSnapshot(response.result.snapshot);
      else void refresh();
      if (response.result.warning) pushNotification(response.result.warning, "warning");
    } catch (requestError) {
      if (requestGeneration === generation.current) {
        setError(requestError instanceof Error ? requestError.message : t("gitOperationFailed"));
      }
    } finally {
      if (requestGeneration === generation.current) setOperation(null);
    }
  };

  const discard = async (file: GitFileChange) => {
    if (!host || !workspace || !ready || !canDiscardGitChange(file)) return;
    const key = `git.discard:${file.path}`;
    const requestGeneration = generation.current;
    setOperation(key);
    setError(null);
    try {
      const response = await hostClient.request(
        "git.discard",
        workspaceContext(host, workspace),
        { path: file.path, expectedRevision: ready.revision },
        32_000,
      );
      if (requestGeneration !== generation.current) return;
      if (!response.ok) {
        setError(errorMessage(response.error, t("gitOperationFailed"), t));
        if (response.error?.code === "STALE_REVISION") void refresh();
        return;
      }
      if (response.result.snapshot) acceptSnapshot(response.result.snapshot);
      else void refresh();
      if (response.result.warning) pushNotification(response.result.warning, "warning");
      pushNotification(t("gitDiscardSuccess", { path: file.path }), "success");
    } catch (requestError) {
      if (requestGeneration === generation.current) {
        setError(requestError instanceof Error ? requestError.message : t("gitOperationFailed"));
      }
    } finally {
      if (requestGeneration === generation.current) setOperation(null);
    }
  };

  const stagedCount = ready?.files.filter((file) => file.staged !== null).length ?? 0;
  const hasConflicts = ready?.files.some((file) => file.conflict) ?? false;
  const canCommit = Boolean(
    ready &&
    stagedCount > 0 &&
    !hasConflicts &&
    commitMessage.trim() &&
    !operation &&
    !generatingMessage,
  );

  const generateCommitMessage = async () => {
    if (!host || !workspace || !ready || generatingMessage || stagedCount === 0) return;
    const requestGeneration = generation.current;
    setGeneratingMessage(true);
    setError(null);
    try {
      const response = await hostClient.request(
        "git.generateCommitMessage",
        workspaceContext(host, workspace),
        { expectedIndexGeneration: ready.indexGeneration },
        60_000,
      );
      if (requestGeneration !== generation.current) return;
      if (!response.ok) {
        setError(errorMessage(response.error, t("gitGenerateCommitMessageFailed"), t));
        if (response.error?.code === "STALE_REVISION") void refresh();
        return;
      }
      setCommitMessage(response.result.message);
      if (response.result.truncated) {
        pushNotification(t("gitGenerateCommitMessageTruncated"), "warning");
      }
      if (response.result.fallback) {
        pushNotification(t("gitGenerateCommitMessageFallback"), "warning");
      }
    } catch (requestError) {
      if (requestGeneration === generation.current) {
        setError(
          requestError instanceof Error
            ? requestError.message
            : t("gitGenerateCommitMessageFailed"),
        );
      }
    } finally {
      if (requestGeneration === generation.current) setGeneratingMessage(false);
    }
  };

  const commit = async () => {
    if (!host || !workspace || !ready || !canCommit) return;
    const requestGeneration = generation.current;
    setOperation("commit");
    setCommitSha(null);
    setError(null);
    try {
      const response = await hostClient.request(
        "git.commit",
        workspaceContext(host, workspace),
        { message: commitMessage.trim(), expectedIndexGeneration: ready.indexGeneration },
        65_000,
      );
      if (requestGeneration !== generation.current) return;
      if (!response.ok) {
        setError(errorMessage(response.error, t("gitCommitFailed"), t));
        if (response.error?.code === "STALE_REVISION") void refresh();
        return;
      }
      const shortSha = response.result.commitSha?.slice(0, 8) ?? t("gitCommitCreated");
      setCommitSha(shortSha);
      setCommitMessage("");
      setHistory([]);
      setHistoryCursor(null);
      setHistoryLoaded(false);
      if (response.result.snapshot) acceptSnapshot(response.result.snapshot);
      else void refresh();
      if (response.result.warning) pushNotification(response.result.warning, "warning");
    } catch (requestError) {
      if (requestGeneration === generation.current) {
        setError(requestError instanceof Error ? requestError.message : t("gitCommitFailed"));
      }
    } finally {
      if (requestGeneration === generation.current) setOperation(null);
    }
  };

  const hasUnpushedCommits = Boolean(ready && ready.ahead > 0);

  const push = async () => {
    if (!host || !workspace || !ready) return;
    const requestGeneration = generation.current;
    setOperation("push");
    setError(null);
    try {
      const response = await hostClient.request(
        "git.push",
        workspaceContext(host, workspace),
        null,
        90_000,
      );
      if (requestGeneration !== generation.current) return;
      if (!response.ok) {
        setError(errorMessage(response.error, t("gitPushFailed"), t));
        return;
      }
      if (response.result.snapshot) acceptSnapshot(response.result.snapshot);
      else void refresh();
      pushNotification(t("gitPushSuccess"), "success");
    } catch (requestError) {
      if (requestGeneration === generation.current) {
        setError(requestError instanceof Error ? requestError.message : t("gitPushFailed"));
      }
    } finally {
      if (requestGeneration === generation.current) setOperation(null);
    }
  };

  const pull = async () => {
    if (!host || !workspace || !ready) return;
    if (ready.files.length > 0) {
      setError(t("gitPullRequiresCleanWorktree"));
      return;
    }
    const requestGeneration = generation.current;
    setOperation("pull");
    setError(null);
    try {
      const response = await hostClient.request(
        "git.pull",
        workspaceContext(host, workspace),
        null,
        90_000,
      );
      if (requestGeneration !== generation.current) return;
      if (!response.ok) {
        setError(pullErrorMessage(response.error, t));
        return;
      }
      if (response.result.snapshot) acceptSnapshot(response.result.snapshot);
      else void refresh();
      setHistory([]);
      setHistoryCursor(null);
      setHistoryLoaded(false);
      pushNotification(t("gitPullSuccess"), "success");
    } catch (requestError) {
      if (requestGeneration === generation.current) {
        setError(requestError instanceof Error ? requestError.message : t("gitPullFailed"));
      }
    } finally {
      if (requestGeneration === generation.current) setOperation(null);
    }
  };

  if (!host || !workspace) {
    return <GitEmptyState title={t("gitNoWorkspace")} detail={t("gitNoWorkspaceDetail")} />;
  }

  if (!snapshot && loading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-muted">
        <LoaderCircle className="animate-spin" size={20} aria-label={t("gitLoading")} />
      </div>
    );
  }

  if (!ready) {
    const title =
      snapshot?.state === "not_repository"
        ? t("gitNotRepository")
        : snapshot?.state === "unavailable"
          ? t("gitUnavailable")
          : t("gitLoadFailed");
    const detail =
      snapshot && "message" in snapshot ? snapshot.message : (error ?? t("gitNotRepositoryDetail"));
    return (
      <GitEmptyState
        title={title}
        detail={detail}
        loading={loading}
        onRefresh={() => void refresh()}
      />
    );
  }

  if (selectedCommit) {
    return (
      <DiffView
        title={selectedCommit.subject || selectedCommit.shortSha}
        detail={selectedCommit.shortSha}
        diff={commitDiff}
        loading={diffLoading}
        error={error}
        backLabel={t("gitBackToHistory")}
        onBack={() => {
          setSelectedCommit(null);
          setCommitDiff(null);
          setError(null);
        }}
        t={t}
      />
    );
  }

  if (selection) {
    return (
      <>
        <DiffView
          title={selection.path}
          diff={diff}
          loading={diffLoading}
          error={error}
          backLabel={t("gitBackToChanges")}
          area={selection.area}
          operation={operation}
          onMutateHunk={(hunk, hunkOperation) => {
            if (hunkOperation === "discard") setHunkDiscardTarget(hunk);
            else void mutateHunk(hunk, hunkOperation);
          }}
          onBack={() => {
            setSelection(null);
            setDiff(null);
            setError(null);
          }}
          t={t}
        />
        {hunkDiscardTarget && (
          <Dialog
            title={t("gitDiscardHunkTitle")}
            confirmLabel={t("gitDiscardHunk")}
            tone="danger"
            icon={Trash2}
            onCancel={() => setHunkDiscardTarget(null)}
            onConfirm={() => {
              const target = hunkDiscardTarget;
              setHunkDiscardTarget(null);
              void mutateHunk(target, "discard");
            }}
          >
            <p>{t("gitDiscardHunkConfirm", { path: selection.path })}</p>
            <p className="mt-2 font-mono text-xs">{hunkDiscardTarget.header}</p>
          </Dialog>
        )}
      </>
    );
  }

  const branchLabel = ready.unborn
    ? t("gitUnbornBranch", { branch: ready.branch ?? t("gitUnknownBranch") })
    : ready.detached
      ? t("gitDetached", { sha: ready.headSha?.slice(0, 8) ?? "?" })
      : (ready.branch ?? t("gitUnknownBranch"));

  return (
    <>
      <div className="flex min-h-0 min-w-0 w-full flex-1 flex-col text-sm">
        <header className="shrink-0 border-b border-border px-3 py-2.5">
          <div className="flex items-center gap-2">
            <GitCompareArrows size={16} className="mt-0.5 shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <button
                  type="button"
                  title={t("gitChooseBranch")}
                  aria-label={t("gitChooseBranch")}
                  disabled={branchLoading || Boolean(operation)}
                  className="flex min-w-0 items-center gap-1 truncate rounded px-1 py-0.5 font-medium hover:bg-surface-overlay focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus disabled:opacity-50"
                  onClick={(event) => {
                    const trigger = contextMenuTrigger(event.currentTarget);
                    if (trigger) void openBranchChooser(trigger);
                  }}
                >
                  {branchLoading ? (
                    <LoaderCircle size={12} className="shrink-0 animate-spin" />
                  ) : (
                    <GitBranch size={12} className="shrink-0" />
                  )}
                  <span className="truncate">{branchLabel}</span>
                  <ChevronDown size={11} className="shrink-0 text-muted" />
                </button>
                {ready.ahead > 0 && (
                  <span className="inline-flex items-center gap-0.5 text-xs text-muted">
                    <ArrowUp size={11} />
                    {ready.ahead}
                  </span>
                )}
                {ready.behind > 0 && (
                  <span className="inline-flex items-center gap-0.5 text-xs text-muted">
                    <ArrowDown size={11} />
                    {ready.behind}
                  </span>
                )}
              </div>
              <p
                className="mt-0.5 truncate font-mono text-[10px] text-muted"
                title={ready.repositoryRoot}
              >
                {ready.repositoryRoot}
              </p>
            </div>
            <span className="shrink-0 text-xs tabular-nums text-muted">
              {view === "changes"
                ? t("gitChangeCount", { count: ready.files.length })
                : t("gitCommitCount", { count: history.length })}
            </span>
            <button
              type="button"
              title={t("gitRefresh")}
              aria-label={t("gitRefresh")}
              disabled={loading || historyLoading || Boolean(operation)}
              className="flex size-7 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus disabled:opacity-40"
              onClick={() => {
                if (view === "history") void loadHistory(false);
                else void refresh();
              }}
            >
              <RefreshCw size={14} className={loading || historyLoading ? "animate-spin" : ""} />
            </button>
            <button
              type="button"
              title={t("gitPull")}
              aria-label={t("gitPull")}
              disabled={loading || historyLoading || Boolean(operation) || !ready}
              className="flex size-7 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus disabled:opacity-40"
              onClick={() => void pull()}
            >
              {operation === "pull" ? (
                <LoaderCircle size={14} className="animate-spin" />
              ) : (
                <ArrowDownToLine size={14} />
              )}
            </button>
          </div>
        </header>

        <div
          role="tablist"
          aria-label={t("gitViews")}
          className="interface-density-nav-row grid h-9 shrink-0 grid-cols-2 border-b border-border bg-surface-raised/25 p-1"
        >
          <button
            type="button"
            role="tab"
            aria-selected={view === "changes"}
            data-ui="tab"
            data-state={view === "changes" ? "active" : "inactive"}
            className={`flex items-center justify-center gap-1.5 rounded text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus ${view === "changes" ? "bg-surface-raised text-foreground shadow-sm" : "text-muted hover:text-foreground"}`}
            onClick={() => setView("changes")}
          >
            <GitCompareArrows size={13} />
            {t("gitChanges")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "history"}
            data-ui="tab"
            data-state={view === "history" ? "active" : "inactive"}
            className={`flex items-center justify-center gap-1.5 rounded text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus ${view === "history" ? "bg-surface-raised text-foreground shadow-sm" : "text-muted hover:text-foreground"}`}
            onClick={() => {
              setView("history");
              if (!historyLoaded) void loadHistory(false);
            }}
          >
            <History size={13} />
            {t("gitHistory")}
          </button>
        </div>

        {!ready.workspaceIsRepositoryRoot && (
          <div className="flex shrink-0 items-start gap-2 border-b border-warning/35 bg-warning/10 px-3 py-2 text-xs text-warning">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>{t("gitParentRepositoryWarning")}</span>
          </div>
        )}
        {ready.warnings.map((warning) => (
          <div
            key={warning}
            className="shrink-0 border-b border-warning/35 bg-warning/10 px-3 py-1.5 text-xs text-warning"
          >
            {warning}
          </div>
        ))}
        {error && (
          <div
            role="alert"
            className="shrink-0 border-b border-danger/35 bg-danger/10 px-3 py-2 text-xs text-danger"
          >
            {error}
          </div>
        )}

        {view === "changes" ? (
          <>
            <div
              ref={listRef}
              role="list"
              className="min-h-0 flex-1 overflow-auto"
              aria-label={t("gitChangesList")}
            >
              {rows.length === 0 ? (
                <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 px-6 text-center text-muted">
                  <Check size={24} />
                  <p className="text-sm">{t("gitClean")}</p>
                </div>
              ) : (
                <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
                  {virtualizer.getVirtualItems().map((virtualRow) => {
                    const row = rows[virtualRow.index]!;
                    return (
                      <div
                        key={virtualRow.key}
                        className="absolute left-0 top-0 w-full"
                        style={{
                          height: virtualRow.size,
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                      >
                        {row.kind === "header" ? (
                          <div className="flex h-full items-center border-b border-border bg-surface-raised/55 px-3 text-[11px] font-semibold uppercase text-muted">
                            <span>
                              {row.area === "staged" ? t("gitStagedChanges") : t("gitChanges")}
                            </span>
                            <span className="ml-auto tabular-nums">{row.count}</span>
                            <button
                              type="button"
                              title={row.area === "staged" ? t("gitUnstageAll") : t("gitStageAll")}
                              aria-label={
                                row.area === "staged" ? t("gitUnstageAll") : t("gitStageAll")
                              }
                              disabled={
                                Boolean(operation) ||
                                ready.files.some(
                                  (file) => file[row.area] !== null && !file.pathSupported,
                                )
                              }
                              className="ml-1 flex size-6 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-30"
                              onClick={() => void mutateAll(row.area)}
                            >
                              {operation ===
                              (row.area === "staged" ? "git.unstageAll" : "git.stageAll") ? (
                                <LoaderCircle size={12} className="animate-spin" />
                              ) : row.area === "staged" ? (
                                <Undo2 size={12} />
                              ) : (
                                <Plus size={12} />
                              )}
                            </button>
                          </div>
                        ) : (
                          <FileRow
                            row={row}
                            busy={Boolean(operation)}
                            active={
                              operation ===
                              `${row.area === "unstaged" ? "git.stage" : "git.unstage"}:${row.file.path}`
                            }
                            onOpen={() => void loadDiff({ path: row.file.path, area: row.area })}
                            onMutate={() => void mutate(row.file, row.area)}
                            onDiscard={
                              row.area === "unstaged" && canDiscardGitChange(row.file)
                                ? () => setDiscardTarget(row.file)
                                : undefined
                            }
                            discardActive={operation === `git.discard:${row.file.path}`}
                            t={t}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <footer className="shrink-0 border-t border-border bg-surface p-3">
              {hasConflicts && (
                <p className="mb-2 text-xs text-warning">{t("gitResolveConflicts")}</p>
              )}
              {commitSha && (
                <p role="status" className="mb-2 flex items-center gap-1.5 text-xs text-success">
                  <Check size={12} />
                  {t("gitCommitSuccess", { sha: commitSha })}
                </p>
              )}
              {hasUnpushedCommits && stagedCount === 0 ? (
                <button
                  type="button"
                  disabled={Boolean(operation) || loading}
                  className="flex h-8 w-full items-center justify-center gap-2 rounded bg-accent px-3 text-xs font-medium text-accent-foreground hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/50 disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={() => void push()}
                >
                  {operation === "push" ? (
                    <LoaderCircle size={13} className="animate-spin" />
                  ) : (
                    <ArrowUpToLine size={13} />
                  )}
                  {operation === "push" ? t("gitPushing") : t("gitPush")}
                </button>
              ) : (
                <>
                  <div className="mb-1.5 flex items-center gap-2">
                    <label
                      htmlFor="git-commit-message"
                      className="block text-[11px] font-medium text-muted"
                    >
                      {t("gitCommitMessage")}
                    </label>
                    <button
                      type="button"
                      title={t("gitGenerateCommitMessage")}
                      disabled={
                        stagedCount === 0 || hasConflicts || Boolean(operation) || generatingMessage
                      }
                      className="ml-auto flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-muted hover:bg-surface-overlay hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-40"
                      onClick={() => void generateCommitMessage()}
                    >
                      {generatingMessage ? (
                        <LoaderCircle size={12} className="animate-spin" />
                      ) : (
                        <Sparkles size={12} />
                      )}
                      {generatingMessage
                        ? t("gitGeneratingCommitMessage")
                        : t("gitGenerateCommitMessage")}
                    </button>
                  </div>
                  <textarea
                    id="git-commit-message"
                    value={commitMessage}
                    maxLength={16 * 1024}
                    rows={3}
                    disabled={Boolean(operation) || generatingMessage}
                    placeholder={
                      stagedCount > 0 ? t("gitCommitPlaceholder") : t("gitStageBeforeCommit")
                    }
                    className="commit-message-input w-full resize-none rounded border border-border bg-surface-raised px-2.5 py-2 text-sm outline-none placeholder:text-muted focus:border-focus disabled:opacity-50"
                    onChange={(event) => setCommitMessage(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault();
                        void commit();
                      }
                    }}
                  />
                  <button
                    type="button"
                    disabled={!canCommit}
                    className="mt-2 flex h-8 w-full items-center justify-center gap-2 rounded bg-accent px-3 text-xs font-medium text-accent-foreground hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/50 disabled:cursor-not-allowed disabled:opacity-40"
                    onClick={() => void commit()}
                  >
                    {operation === "commit" ? (
                      <LoaderCircle size={13} className="animate-spin" />
                    ) : (
                      <GitCommitHorizontal size={13} />
                    )}
                    {operation === "commit" ? t("gitCommitting") : t("gitCommit")}
                  </button>
                </>
              )}
            </footer>
          </>
        ) : (
          <HistoryView
            commits={history}
            loading={historyLoading}
            loaded={historyLoaded}
            hasMore={historyCursor !== null}
            onOpen={(commit) => void loadCommitDiff(commit)}
            onLoadMore={() => void loadHistory(true)}
            locale={locale}
            t={t}
          />
        )}
      </div>
      {discardTarget && (
        <Dialog
          title={t("gitDiscardTitle")}
          confirmLabel={t("gitDiscard")}
          tone="danger"
          icon={Trash2}
          onCancel={() => setDiscardTarget(null)}
          onConfirm={() => {
            const target = discardTarget;
            setDiscardTarget(null);
            void discard(target);
          }}
        >
          <p>{t("gitDiscardConfirm", { path: discardTarget.path })}</p>
          {discardTarget.staged !== null && <p className="mt-2">{t("gitDiscardKeepsStaged")}</p>}
        </Dialog>
      )}
      {createBranchOpen && (
        <Dialog
          title={t("gitCreateBranch")}
          confirmLabel={
            operation === "git.createBranch" ? t("gitCreatingBranch") : t("gitCreateBranch")
          }
          icon={GitBranchPlus}
          onCancel={() => {
            if (operation !== "git.createBranch") setCreateBranchOpen(false);
          }}
          onConfirm={() => {
            const name = branchName.trim();
            if (!name || operation) return;
            setCreateBranchOpen(false);
            void mutateBranch("git.createBranch", name, ready.revision);
          }}
        >
          <label
            htmlFor="git-branch-name"
            className="mb-1.5 block text-xs font-medium text-foreground"
          >
            {t("gitBranchName")}
          </label>
          <input
            id="git-branch-name"
            value={branchName}
            maxLength={255}
            placeholder={t("gitBranchNamePlaceholder")}
            className="h-9 w-full rounded border border-border bg-surface px-2.5 text-sm text-foreground outline-none placeholder:text-muted focus:border-focus"
            onChange={(event) => setBranchName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              const name = branchName.trim();
              if (!name || operation) return;
              setCreateBranchOpen(false);
              void mutateBranch("git.createBranch", name, ready.revision);
            }}
          />
        </Dialog>
      )}
    </>
  );
}

function FileRow({
  row,
  busy,
  active,
  discardActive,
  onOpen,
  onMutate,
  onDiscard,
  t,
}: {
  row: Extract<ListRow, { kind: "file" }>;
  busy: boolean;
  active: boolean;
  discardActive: boolean;
  onOpen: () => void;
  onMutate: () => void;
  onDiscard?: () => void;
  t: Translate;
}) {
  const { name, directory } = splitPath(row.file.path);
  const change = row.file[row.area]!;
  const actionLabel =
    row.area === "unstaged"
      ? t("gitStageFile", { path: row.file.path })
      : t("gitUnstageFile", { path: row.file.path });
  const diffLabel = `${row.area === "staged" ? t("gitStagedChanges") : t("gitChanges")}: ${row.file.path}`;
  const ActionIcon = row.area === "unstaged" ? Plus : Undo2;
  return (
    <div
      role="listitem"
      className="group flex h-full min-w-0 items-center border-b border-border/60 px-2 hover:bg-surface-overlay"
    >
      <button
        type="button"
        aria-label={diffLabel}
        disabled={!row.file.pathSupported}
        className="flex min-w-0 flex-1 items-center gap-2 self-stretch text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-55"
        title={row.file.path}
        onClick={onOpen}
      >
        <FileCode2 size={14} className="shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate text-xs">
          <span className="text-foreground">{name}</span>
          {directory && <span className="ml-1.5 text-[10px] text-muted">{directory}</span>}
        </span>
        {row.file.submodule && (
          <span className="shrink-0 text-[9px] uppercase text-muted">{t("gitSubmodule")}</span>
        )}
        <span
          title={changeLabel(change, t)}
          aria-label={changeLabel(change, t)}
          className={`w-4 shrink-0 text-center font-mono text-xs font-semibold ${change === "conflicted" ? "text-warning" : change === "deleted" ? "text-danger" : "text-accent"}`}
        >
          {gitChangeLetter(change)}
        </span>
      </button>
      {onDiscard && (
        <button
          type="button"
          title={t("gitDiscardFile", { path: row.file.path })}
          aria-label={t("gitDiscardFile", { path: row.file.path })}
          disabled={busy}
          className={`ml-1 flex size-7 shrink-0 items-center justify-center rounded text-muted hover:bg-danger/10 hover:text-danger focus:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-danger disabled:cursor-not-allowed disabled:opacity-30 ${discardActive ? "opacity-100 text-danger" : "opacity-0 group-hover:opacity-100"}`}
          onClick={onDiscard}
        >
          {discardActive ? (
            <LoaderCircle size={13} className="animate-spin" />
          ) : (
            <Trash2 size={13} />
          )}
        </button>
      )}
      <button
        type="button"
        title={actionLabel}
        aria-label={actionLabel}
        disabled={busy || !row.file.pathSupported}
        className="ml-1 flex size-7 shrink-0 items-center justify-center rounded text-muted opacity-0 hover:bg-surface-raised hover:text-foreground focus:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-30 group-hover:opacity-100"
        onClick={onMutate}
      >
        {active ? <LoaderCircle size={13} className="animate-spin" /> : <ActionIcon size={13} />}
      </button>
    </div>
  );
}

function GitEmptyState({
  title,
  detail,
  loading = false,
  onRefresh,
}: {
  title: string;
  detail: string;
  loading?: boolean;
  onRefresh?: () => void;
}) {
  const t = useT();
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      <GitCompareArrows size={28} className="text-muted" />
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 text-xs leading-5 text-muted">{detail}</p>
      </div>
      {onRefresh && (
        <button
          type="button"
          disabled={loading}
          className="flex h-8 items-center gap-2 rounded border border-border px-3 text-xs text-muted hover:bg-surface-overlay hover:text-foreground disabled:opacity-40"
          onClick={onRefresh}
        >
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
          {t("gitRefresh")}
        </button>
      )}
    </div>
  );
}

function HistoryView({
  commits,
  loading,
  loaded,
  hasMore,
  onOpen,
  onLoadMore,
  locale,
  t,
}: {
  commits: GitCommitSummary[];
  loading: boolean;
  loaded: boolean;
  hasMore: boolean;
  onOpen: (commit: GitCommitSummary) => void;
  onLoadMore: () => void;
  locale: "en" | "zh";
  t: Translate;
}) {
  if (loading && commits.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-muted">
        <LoaderCircle size={20} className="animate-spin" aria-label={t("gitHistoryLoading")} />
      </div>
    );
  }
  if (loaded && commits.length === 0) {
    return <GitEmptyState title={t("gitHistoryEmpty")} detail={t("gitHistoryEmptyDetail")} />;
  }
  return (
    <div role="list" aria-label={t("gitHistoryList")} className="min-h-0 flex-1 overflow-auto">
      {commits.map((commit) => {
        const date = new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(commit.authoredAt));
        return (
          <div key={commit.sha} role="listitem" className="border-b border-border/60">
            <button
              type="button"
              className="group flex w-full items-start gap-2 px-3 py-2.5 text-left hover:bg-surface-overlay focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus"
              aria-label={t("gitOpenCommit", { subject: commit.subject || commit.shortSha })}
              onClick={() => onOpen(commit)}
            >
              <GitCommitHorizontal
                size={14}
                className="mt-0.5 shrink-0 text-muted group-hover:text-accent"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-foreground">
                  {commit.subject || t("gitCommitWithoutSubject")}
                </span>
                <span className="mt-1 flex min-w-0 items-center gap-2 text-[10px] text-muted">
                  <span className="shrink-0 font-mono text-accent">{commit.shortSha}</span>
                  <span className="truncate">{commit.authorName}</span>
                  <span className="ml-auto shrink-0">{date}</span>
                </span>
                {commit.refs.length > 0 && (
                  <span className="mt-1 flex items-center gap-1 truncate text-[10px] text-muted">
                    <GitBranch size={10} className="shrink-0" />
                    {commit.refs.join(", ")}
                  </span>
                )}
              </span>
            </button>
          </div>
        );
      })}
      {hasMore && (
        <div className="p-3">
          <button
            type="button"
            disabled={loading}
            className="flex h-8 w-full items-center justify-center gap-2 rounded border border-border text-xs text-muted hover:bg-surface-overlay hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus disabled:opacity-40"
            onClick={onLoadMore}
          >
            {loading && <LoaderCircle size={13} className="animate-spin" />}
            {t("gitLoadMoreHistory")}
          </button>
        </div>
      )}
    </div>
  );
}

function DiffView({
  title,
  detail,
  diff,
  loading,
  error,
  backLabel,
  area,
  operation,
  onMutateHunk,
  onBack,
  t,
}: {
  title: string;
  detail?: string;
  diff: GitDiffSnapshot | GitCommitDiffSnapshot | null;
  loading: boolean;
  error: string | null;
  backLabel: string;
  area?: "staged" | "unstaged";
  operation?: string | null;
  onMutateHunk?: (hunk: GitDiffHunk, operation: "stage" | "unstage" | "discard") => void;
  onBack: () => void;
  t: Translate;
}) {
  const lines = useMemo(() => parseUnifiedDiffLines(diff?.patch ?? ""), [diff?.patch]);
  const hunks = diff && "hunks" in diff ? diff.hunks : [];
  const hunkOperations = diff && "hunkOperations" in diff ? diff.hunkOperations : [];
  let hunkIndex = 0;
  return (
    <div className="flex min-h-0 min-w-0 w-full flex-1 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-2">
        <button
          type="button"
          title={backLabel}
          aria-label={backLabel}
          className="flex size-7 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus"
          onClick={onBack}
        >
          <ArrowLeft size={14} />
        </button>
        <span className="min-w-0 flex-1 truncate text-xs" title={title}>
          {title}
        </span>
        {detail && <span className="shrink-0 font-mono text-[10px] text-muted">{detail}</span>}
        {diff && (
          <span className="shrink-0 text-[11px]">
            <span className="text-success">+{diff.additions}</span>
            <span className="ml-1.5 text-danger">-{diff.deletions}</span>
          </span>
        )}
      </header>
      {diff?.truncated && (
        <div className="shrink-0 border-b border-warning/35 bg-warning/10 px-3 py-2 text-xs text-warning">
          {t("gitDiffTruncated")}
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="shrink-0 border-b border-danger/35 bg-danger/10 px-3 py-2 text-xs text-danger"
        >
          {error}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto bg-surface-raised/25">
        {loading ? (
          <div className="flex h-full items-center justify-center text-muted">
            <LoaderCircle size={20} className="animate-spin" />
          </div>
        ) : diff?.binary ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted">
            <FileCode2 size={24} />
            <p className="text-sm">{t("gitBinaryDiff")}</p>
          </div>
        ) : diff && !diff.patch ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted">
            {t("gitEmptyDiff")}
          </div>
        ) : (
          <div className="min-w-max py-1 font-mono text-[11px] leading-5">
            {lines.map((line, index) => {
              const hunk = line.kind === "hunk" ? hunks[hunkIndex++] : null;
              const hunkOperation = area === "staged" ? "unstage" : "stage";
              const canMutate = hunkOperations.includes(hunkOperation);
              const busy = Boolean(operation);
              return (
                <div
                  key={`${index}:${line.content}`}
                  className={`grid grid-cols-[3rem_3rem_minmax(max-content,1fr)] ${line.kind === "addition" ? "bg-success/10 text-success" : line.kind === "deletion" ? "bg-danger/10 text-danger" : line.kind === "hunk" ? "bg-accent/10 text-accent" : line.kind === "meta" ? "text-muted" : "text-foreground/80"}`}
                >
                  <span className="select-none border-r border-border/50 px-1.5 text-right text-muted/65">
                    {line.oldLine ?? ""}
                  </span>
                  <span className="select-none border-r border-border/50 px-1.5 text-right text-muted/65">
                    {line.newLine ?? ""}
                  </span>
                  {hunk && onMutateHunk && (canMutate || hunkOperations.includes("discard")) ? (
                    <span className="flex min-w-0 items-center">
                      <pre className="min-w-0 flex-1 px-2 whitespace-pre">
                        {line.content || " "}
                      </pre>
                      {hunkOperations.includes("discard") && (
                        <button
                          type="button"
                          title={t("gitDiscardHunk")}
                          aria-label={t("gitDiscardHunk")}
                          disabled={busy}
                          className="sticky right-7 flex size-6 shrink-0 items-center justify-center bg-surface-raised text-muted hover:text-danger focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-danger disabled:opacity-40"
                          onClick={() => onMutateHunk(hunk, "discard")}
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                      {canMutate && (
                        <button
                          type="button"
                          title={
                            hunkOperation === "stage" ? t("gitStageHunk") : t("gitUnstageHunk")
                          }
                          aria-label={
                            hunkOperation === "stage" ? t("gitStageHunk") : t("gitUnstageHunk")
                          }
                          disabled={busy}
                          className="sticky right-0 flex size-7 shrink-0 items-center justify-center bg-surface-raised text-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus disabled:opacity-40"
                          onClick={() => onMutateHunk(hunk, hunkOperation)}
                        >
                          {operation === `hunk:${hunkOperation}:${hunk.id}` ? (
                            <LoaderCircle size={12} className="animate-spin" />
                          ) : hunkOperation === "stage" ? (
                            <Plus size={12} />
                          ) : (
                            <Undo2 size={12} />
                          )}
                        </button>
                      )}
                    </span>
                  ) : (
                    <pre className="px-2 whitespace-pre">{line.content || " "}</pre>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
