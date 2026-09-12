import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
} from "react";
import {
  ArrowUp,
  CircleAlert,
  CircleCheck,
  ClipboardPaste,
  FileArchive,
  FileText,
  Folder,
  LoaderCircle,
  MessageCircleQuestion,
  Paperclip,
  Puzzle,
  RefreshCw,
  Square,
  Undo2,
  X,
} from "lucide-react";
import { busySendMethod } from "../../lib/busy-send";
import { useAppStore } from "../../lib/stores/app-store";
import { isExtensionDecisionBlockingSession } from "../../lib/stores/extension-ui-state";
import { hostClient, isHostEpochError } from "../../lib/bridge/host-client";
import { hostErrorLevel, localizeHostError } from "../../lib/bridge/localize-host-error";
import { notifyOperationFailure } from "../../lib/notify-operation-error";
import {
  MAX_AGENT_ATTACHMENT_BYTES,
  MAX_AGENT_IMAGE_BYTES,
  MAX_AGENT_REQUEST_IMAGES,
  MAX_PASTED_TEXT_ATTACHMENT_BYTES,
  PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES,
  type AttachmentSnapshot,
  type JsonValue,
  type SerializableImage,
} from "@piabyss/protocol";
import {
  buildAttachedFileBlock,
  buildAttachedImageBlock,
  buildAttachedPathBlock,
} from "./transcript-model";
import { ContextUsageRing, ModelControls } from "./ModelControls";
import { QueuePanel } from "./QueuePanel";
import {
  ExtensionWidgetsPopover,
  ExtensionWidgetsButton,
  TodoPopoverButton,
} from "./ExtensionWidgets";
import { PiMark } from "../../components/PiMark";
import {
  activeSessionContext,
  captureRequestGeneration,
  isCurrentRequestGeneration,
  workspaceContext,
} from "../../lib/bridge/host-context";
import { subscribeValidatedHostEvent } from "../../lib/bridge/validated-host-events";
import { subscribeComposerInsert } from "../../lib/composer-insert";
import { BUILTIN_COMMANDS, matchBuiltinCommand } from "./builtin-commands";
import { abortCompaction, requestCompact } from "./compaction-actions";
import { SessionStatsModal } from "./SessionStatsModal";
import { ForkModal } from "./ForkModal";
import { requestTreeOverlay } from "../../lib/tree-overlay";
import {
  appendOptimisticUserMessage,
  removeOptimisticUserMessage,
} from "../../lib/chat/optimistic-echo";
import { requestExport } from "../../lib/export-actions";
import { useImeComposition } from "../../lib/use-ime-composition";
import { useLocale, useT, type Translate } from "../../lib/i18n/use-t";
import type { MessageKey } from "../../lib/i18n";
import {
  getDesktopFileInfo,
  isDesktopRuntime,
  isDocumentPath,
  pickDesktopAttachmentPaths,
  readDesktopSmallFile,
  type DesktopFileInfo,
} from "../../lib/desktop-file-access";
import { contextMenuTrigger, openContextMenu } from "../../lib/context-menu";
import { shouldKeepNativeContextMenu } from "../../lib/context-menu-policy";
import { buildTextContextMenuItems } from "../../lib/text-context-menu";
import { readClipboardText } from "../../lib/desktop-clipboard";
import { draftKeyForTarget, draftTargetFor } from "../../lib/draft-target";
import {
  commitDraftSend,
  deleteDraft,
  editDraft,
  restoreDraftSend,
  stageDraftSend,
} from "../../lib/draft-persistence";

const MAX_FILES = 4;
const MAX_FILE_BYTES = 256 * 1024;

function ExtensionStatusStrip() {
  const statuses = useAppStore((state) => state.extensionStatuses);
  const entries = Object.entries(statuses);
  if (entries.length === 0) return null;
  return (
    <div className="mb-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-2 text-[10px] text-muted">
      {entries.map(([key, text]) => (
        <span key={key} className="flex min-w-0 items-center gap-1.5" title={text}>
          <Puzzle size={11} className="shrink-0 text-accent" />
          <span className="max-w-[18rem] truncate">
            {key !== "default" && <span className="mr-1 text-foreground/70">{key}</span>}
            {text}
          </span>
        </span>
      ))}
    </div>
  );
}

type PendingImage = SerializableImage & { id: string; name?: string; sourcePath?: string };
type PendingFile = {
  id: string;
  name: string;
  size: number;
  kind: "text" | "path";
  text?: string;
  sourcePath?: string;
  isDirectory?: boolean;
  /** Large document paths are not subject to the regular file-chip cap. */
  unlimited?: boolean;
};
type PasteRecovery = {
  sessionId: string;
  text: string;
  draft: string;
  selectionStart: number;
  selectionEnd: number;
};
type PendingPathDocument = AttachmentSnapshot & {
  kind: "path";
  sourcePath: string;
};
type PendingPastedText = AttachmentSnapshot & {
  kind: "pasted-text";
  remote: boolean;
  recovery: PasteRecovery;
};
type PendingDocument = PendingPathDocument | PendingPastedText;

function localPathName(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

const WELCOME_MORNING: readonly MessageKey[] = [
  "composerWelcomeMorning1",
  "composerWelcomeMorning2",
  "composerWelcomeMorning3",
  "composerWelcomeMorning4",
  "composerWelcomeMorning5",
];
const WELCOME_AFTERNOON: readonly MessageKey[] = [
  "composerWelcomeAfternoon1",
  "composerWelcomeAfternoon2",
  "composerWelcomeAfternoon3",
  "composerWelcomeAfternoon4",
  "composerWelcomeAfternoon5",
];
const WELCOME_EVENING: readonly MessageKey[] = [
  "composerWelcomeEvening1",
  "composerWelcomeEvening2",
  "composerWelcomeEvening3",
  "composerWelcomeEvening4",
  "composerWelcomeEvening5",
];
const WELCOME_NIGHT: readonly MessageKey[] = [
  "composerWelcomeNight1",
  "composerWelcomeNight2",
  "composerWelcomeNight3",
  "composerWelcomeNight4",
  "composerWelcomeNight5",
];
const WELCOME_GENERAL: readonly MessageKey[] = [
  "composerWelcomeGeneral1",
  "composerWelcomeGeneral2",
  "composerWelcomeGeneral3",
  "composerWelcomeGeneral4",
  "composerWelcomeGeneral5",
];

function pickWelcomeKey(): MessageKey {
  const hour = new Date().getHours();
  const pool: readonly MessageKey[] =
    hour >= 6 && hour < 12
      ? [...WELCOME_MORNING, ...WELCOME_GENERAL]
      : hour >= 12 && hour < 18
        ? [...WELCOME_AFTERNOON, ...WELCOME_GENERAL]
        : hour >= 18 && hour < 21
          ? [...WELCOME_EVENING, ...WELCOME_GENERAL]
          : [...WELCOME_NIGHT, ...WELCOME_GENERAL];
  return pool[Math.floor(Math.random() * pool.length)];
}

function localizedDocumentError(message: string | undefined, t: Translate): string {
  if (!message) return t("composerDocumentParseFailed");
  if (/password|encrypted/iu.test(message)) return t("composerDocumentEncrypted");
  if (/genuine|valid docx|only.*pdf|unsupported.*type/iu.test(message)) {
    return t("composerDocumentTypeMismatch");
  }
  if (/damaged|invalid pdf|bad xref|formaterror|structure/iu.test(message)) {
    return t("composerDocumentDamaged");
  }
  return t("composerDocumentParseFailedDetail", { error: message });
}

function documentStatusText(document: PendingDocument, t: Translate): string {
  if (document.status === "copying") {
    return document.kind === "pasted-text"
      ? t("composerPastedTextSaving")
      : t("composerDocumentCopying");
  }
  if (document.status === "parsing") {
    if (document.unitCount !== undefined && document.processedUnits !== undefined) {
      return t("composerDocumentParsingProgress", {
        done: document.processedUnits,
        total: document.unitCount,
      });
    }
    return t("composerDocumentParsing");
  }
  if (document.status === "failed") return localizedDocumentError(document.error, t);
  const count = document.unitCount ?? 0;
  return document.unit === "page"
    ? t("composerDocumentPages", { count })
    : t("composerDocumentChunks", { count });
}

function fileToImage(file: File): Promise<PendingImage | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const base64 = result.slice(result.indexOf(",") + 1);
      if (!base64) return resolve(null);
      resolve({
        id: crypto.randomUUID(),
        mediaType: file.type,
        data: base64,
      });
    };
    reader.readAsDataURL(file);
  });
}

/** UTF-8 decoded content that still contains NULs or a high density of
 * replacement chars is binary, not text. */
function looksBinary(text: string): boolean {
  if (text.includes("\u0000")) return true;
  let bad = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 0xfffd) bad += 1;
  }
  return text.length > 0 && bad / text.length > 0.02;
}

type CompletionItem = { insert: string; label: string; detail?: string };

function builtinCompletionItems(t: Translate): CompletionItem[] {
  const descriptions = {
    compact: "composerBuiltinCompact",
    session: "composerBuiltinSession",
    tree: "composerBuiltinTree",
    fork: "composerBuiltinFork",
    export: "composerBuiltinExport",
    login: "composerBuiltinLogin",
  } as const;
  return BUILTIN_COMMANDS.map((command) => ({
    insert: `/${command.name} `,
    label: `/${command.name}`,
    detail: [
      command.name === "compact" ? t("composerBuiltinInstructionsHint") : command.argumentHint,
      t(descriptions[command.name as keyof typeof descriptions]),
      `(${t("composerCommandKindBuiltin")})`,
    ]
      .filter(Boolean)
      .join(" — "),
  }));
}
type CompletionState = {
  kind: "command" | "file";
  /** Index in the draft where the trigger token (incl. `/` or `@`) starts. */
  tokenStart: number;
  query: string;
  items: CompletionItem[];
  selected: number;
};

/** `/name` at the very start of the draft, token touching the caret. */
export function commandTokenAt(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = /^\/([\w:-]*)$/.exec(before);
  return match ? { start: 0, query: match[1] } : null;
}

/** `@token` preceded by whitespace/start, token touching the caret. */
export function fileTokenAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!match) return null;
  return { start: before.length - match[2].length - 1, query: match[2] };
}

/** LiveAgent-style rank: filename prefix < path prefix < filename substring
 * < rest, then shallower, then dirs before files. */
function fileSortKey(
  entry: { path: string; kind: "file" | "dir" },
  query: string,
): [number, number, number] {
  const path = entry.path.toLocaleLowerCase();
  const name = path.slice(path.lastIndexOf("/") + 1);
  const rank = !query
    ? 3
    : name.startsWith(query)
      ? 0
      : path.startsWith(query)
        ? 1
        : name.includes(query)
          ? 2
          : 3;
  return [rank, entry.path.split("/").length, entry.kind === "dir" ? 0 : 1];
}

export function Composer({
  disabled,
  welcomeWorkspaceName,
}: {
  disabled?: boolean;
  welcomeWorkspaceName?: string;
}) {
  const t = useT();
  const locale = useLocale();
  const host = useAppStore((s) => s.host);
  const workspace = useAppStore((s) => s.workspace);
  const session = useAppStore((s) => s.session);
  const busySendBehavior = useAppStore((s) => s.desktopSettings?.busySendBehavior);
  // Re-pick a greeting whenever a new conversation (session) is opened.
  const welcomeKey = useMemo(
    () => (welcomeWorkspaceName ? pickWelcomeKey() : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [welcomeWorkspaceName, session?.sessionId],
  );
  const extensionUiRequest = useAppStore((s) => s.extensionUiRequest);
  const extensionDecisionGroups = useAppStore((s) => s.extensionDecisionGroups);
  const draftTarget = draftTargetFor(workspace, session);
  const draftKey = draftTarget ? draftKeyForTarget(draftTarget) : null;
  const text = useAppStore((s) => (draftKey ? (s.draftTexts[draftKey] ?? "") : ""));
  const extensionWidgetsOpen = useAppStore((s) => s.extensionWidgetsOpen);
  const setExtensionWidgetsOpen = useAppStore((s) => s.setExtensionWidgetsOpen);
  const setSession = useAppStore((s) => s.applySessionSnapshot);
  const pushNotification = useAppStore((s) => s.pushNotification);
  const openSettingsSection = useAppStore((s) => s.openSettingsSection);
  const setAuthBlocked = useAppStore((s) => s.setAuthBlocked);
  const [images, setImages] = useState<PendingImage[]>([]);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [documents, setDocuments] = useState<PendingDocument[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [completion, setCompletion] = useState<CompletionState | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const [forkOpen, setForkOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previousBlockedSessionRef = useRef<string | null>(null);
  const documentsRef = useRef<PendingDocument[]>([]);

  // autoresize the composer textarea: grow with content, never shrink below
  // the user's current height, clamp to [60px, 280px] via CSS min-h/max-h.
  // manual resize is handled by the top-edge ns-resize handle (see JSX).
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const prevHeight = el.clientHeight;
    el.style.height = "auto";
    const target = Math.min(el.scrollHeight, 280);
    // After a send the draft is cleared (text === ""); reset to the initial
    // height instead of preserving the previous (grown) height, so the box
    // visibly shrinks back to its resting size.
    if (text.trim().length === 0) {
      el.style.height = ``;
    } else {
      el.style.height = `${Math.max(target, Math.min(prevHeight, 280))}px`;
    }
  }, [text]);
  const composerResizeStart = useRef<{ pointerId: number; y: number; height: number } | null>(null);

  function finishComposerResize(target: HTMLDivElement, pointerId: number) {
    if (composerResizeStart.current?.pointerId !== pointerId) return;
    composerResizeStart.current = null;
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
  }

  function applyComposerResize(nextHeight: number) {
    const el = textareaRef.current;
    if (!el) return;
    const clamped = Math.min(280, Math.max(60, Math.round(nextHeight)));
    el.style.height = `${clamped}px`;
  }
  const recoveringPastedTextRef = useRef(new Set<string>());
  const recoverFailedPastedTextCallbackRef = useRef<
    (document: PendingPastedText, error?: string) => Promise<void>
  >(async () => undefined);
  const addLocalPathsCallbackRef = useRef<(paths: readonly string[]) => Promise<void>>(
    async () => undefined,
  );
  const decisionHintId = useId();
  const extensionWidgetAnchorRef = useRef<HTMLDivElement>(null);
  const templatesRef = useRef<{ key: string; items: CompletionItem[] } | null>(null);
  const fileSnapshotRef = useRef<{
    query: string;
    entries: { path: string; kind: "file" | "dir" }[];
    truncated: boolean;
  } | null>(null);
  const completionGeneration = useRef(0);
  const ime = useImeComposition();
  const busy = session ? !session.isIdle : false;
  const sessionId = session?.sessionId ?? null;
  const decisionBlocked = isExtensionDecisionBlockingSession(
    extensionUiRequest,
    extensionDecisionGroups,
    sessionId,
  );
  const blockedSessionId = decisionBlocked ? sessionId : null;

  const dismissCompletion = useCallback(() => {
    completionGeneration.current += 1;
    setCompletion(null);
  }, []);

  function updateDocuments(
    updater: (current: PendingDocument[]) => PendingDocument[],
  ): PendingDocument[] {
    const next = updater(documentsRef.current);
    documentsRef.current = next;
    setDocuments(next);
    return next;
  }

  function insertRecoveredText(recovery: PasteRecovery) {
    const state = useAppStore.getState();
    if (state.session?.sessionId !== recovery.sessionId) return;
    const target = draftTargetFor(state.workspace, state.session);
    if (!target) return;
    const key = draftKeyForTarget(target);
    const currentDraft = state.draftTexts[key] ?? "";
    const textarea = textareaRef.current;
    const draftIsUnchanged = currentDraft === recovery.draft;
    const start = draftIsUnchanged
      ? recovery.selectionStart
      : (textarea?.selectionStart ?? currentDraft.length);
    const end = draftIsUnchanged ? recovery.selectionEnd : start;
    const next = currentDraft.slice(0, start) + recovery.text + currentDraft.slice(end);
    editDraft(target, next);
    dismissCompletion();
    const caret = start + recovery.text.length;
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(caret, caret);
    });
  }

  useEffect(() => {
    const previousBlockedSessionId = previousBlockedSessionRef.current;
    previousBlockedSessionRef.current = blockedSessionId;
    if (
      !previousBlockedSessionId ||
      blockedSessionId !== null ||
      previousBlockedSessionId !== sessionId ||
      disabled
    ) {
      return;
    }
    const frame = window.requestAnimationFrame(() => textareaRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [blockedSessionId, disabled, sessionId]);

  // Auto-focus the textarea when switching to a new session (e.g. clicking "New Conversation")
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => textareaRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [sessionId]);

  useEffect(
    () =>
      subscribeComposerInsert((insert) => {
        const current = useAppStore.getState();
        const target = draftTargetFor(current.workspace, current.session);
        if (!target) return false;
        const draft = current.draftTexts[draftKeyForTarget(target)] ?? "";
        const textarea = textareaRef.current;
        const start = textarea?.selectionStart ?? draft.length;
        const end = textarea?.selectionEnd ?? start;
        const before = draft.slice(0, start);
        const after = draft.slice(end);
        const prefix = before && !/\s$/.test(before) ? " " : "";
        const suffix = after && !/^\s/.test(after) ? " " : "";
        const inserted = `${prefix}${insert}${suffix}`;
        const next = before + inserted + after;
        editDraft(target, next);
        const caret = before.length + inserted.length;
        requestAnimationFrame(() => {
          textareaRef.current?.focus();
          textareaRef.current?.setSelectionRange(caret, caret);
        });
        return true;
      }),
    [],
  );

  // Attachments are per-conversation; drop them when the session changes.
  useEffect(() => {
    setImages([]);
    setFiles([]);
    documentsRef.current = [];
    setDocuments([]);
    recoveringPastedTextRef.current.clear();
    setDragOver(false);
    dismissCompletion();
    setStatsOpen(false);
    setForkOpen(false);
    fileSnapshotRef.current = null;
  }, [dismissCompletion, sessionId]);

  useEffect(() => {
    if (!host || !workspace || !session) return;
    return subscribeValidatedHostEvent(
      "attachment.changed",
      activeSessionContext(host, workspace, session),
      (event) => {
        if (event.sessionId !== sessionId) return;
        const current = documentsRef.current.find(
          (document) => document.id === event.payload.attachment.id,
        );
        if (current?.kind === "pasted-text" && event.payload.attachment.status === "failed") {
          void recoverFailedPastedTextCallbackRef.current(current, event.payload.attachment.error);
          return;
        }
        updateDocuments((current) =>
          current.map((document) =>
            document.id === event.payload.attachment.id
              ? { ...document, ...event.payload.attachment }
              : document,
          ),
        );
      },
    );
  }, [host, workspace, session, sessionId]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void isDesktopRuntime()
      .then(async (isDesktop) => {
        if (!isDesktop || cancelled) return;
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        unlisten = await getCurrentWebview().onDragDropEvent((event) => {
          if (cancelled || disabled) return;
          if (event.payload.type === "enter" || event.payload.type === "over") {
            setDragOver(true);
          } else if (event.payload.type === "leave") {
            setDragOver(false);
          } else if (event.payload.type === "drop") {
            setDragOver(false);
            void addLocalPathsCallbackRef.current(event.payload.paths);
          }
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [disabled, sessionId]);

  function closeExtensionWidgets() {
    setExtensionWidgetsOpen(false);
  }

  function toggleExtensionWidgets() {
    setExtensionWidgetsOpen(!extensionWidgetsOpen);
  }

  async function loadCommandItems(): Promise<{
    cacheKey: string | null;
    items: CompletionItem[];
  }> {
    if (!host || !workspace || !session) return { cacheKey: null, items: [] };
    const key = `${locale}:${session.sessionId}:${session.revision}`;
    if (templatesRef.current?.key === key) {
      return { cacheKey: key, items: templatesRef.current.items };
    }
    const res = await hostClient.request(
      "session.getCommands",
      activeSessionContext(host, workspace, session),
      null,
    );
    const builtins = builtinCompletionItems(t);
    if (!res.ok) return { cacheKey: null, items: builtins };
    const kindLabel = {
      template: t("composerCommandKindPrompt"),
      command: t("composerCommandKindExtension"),
      skill: t("composerCommandKindSkill"),
    } as const;
    const items = [
      ...res.result.commands.map((command) => ({
        insert: `/${command.invocation} `,
        label: `/${command.invocation}`,
        detail: [command.argumentHint, command.description, `(${kindLabel[command.kind]})`]
          .filter(Boolean)
          .join(" — "),
      })),
      ...builtins,
    ];
    return { cacheKey: key, items };
  }

  function updateCompletion(nextText: string, caret: number) {
    const generation = ++completionGeneration.current;
    const command = commandTokenAt(nextText, caret);
    if (command) {
      void loadCommandItems()
        .then(({ cacheKey, items: all }) => {
          if (generation !== completionGeneration.current) return;
          if (cacheKey) templatesRef.current = { key: cacheKey, items: all };
          const query = command.query.toLocaleLowerCase();
          // Prefix matches rank first, substring matches anywhere follow
          // (so /con still finds fast-context); stable sort keeps the
          // template/command/skill grouping within each rank.
          const items = all
            .map((item) => {
              const name = item.label.toLocaleLowerCase();
              const rank = !query
                ? 0
                : name.startsWith(`/${query}`)
                  ? 0
                  : name.includes(query)
                    ? 1
                    : 2;
              return { item, rank };
            })
            .filter(({ rank }) => rank < 2)
            .sort((a, b) => a.rank - b.rank)
            .map(({ item }) => item);
          setCompletion(
            items.length > 0
              ? {
                  kind: "command",
                  tokenStart: command.start,
                  query: command.query,
                  items,
                  selected: 0,
                }
              : null,
          );
        })
        .catch(() => {
          if (generation === completionGeneration.current) setCompletion(null);
        });
      return;
    }
    const file = fileTokenAt(nextText, caret);
    if (file && host && workspace) {
      const query = file.query.toLocaleLowerCase();

      const applySnapshot = (snapshot: {
        query: string;
        entries: { path: string; kind: "file" | "dir" }[];
        truncated: boolean;
      }) => {
        if (generation !== completionGeneration.current) return;
        const matches = snapshot.entries
          .filter((entry) => entry.path.toLocaleLowerCase().includes(query))
          .map((entry) => ({ entry, key: fileSortKey(entry, query) }))
          .sort(
            (a, b) =>
              a.key[0] - b.key[0] ||
              a.key[1] - b.key[1] ||
              a.key[2] - b.key[2] ||
              (a.entry.path < b.entry.path ? -1 : 1),
          )
          .slice(0, 30)
          .map(({ entry }) => ({
            // Files replace the whole @token with the bare path; directories
            // keep the @ so the mention stays active for drilling deeper.
            insert: entry.kind === "dir" ? `@${entry.path}/` : `${entry.path} `,
            label: entry.kind === "dir" ? `${entry.path}/` : entry.path,
          }));
        setCompletion(
          matches.length > 0
            ? {
                kind: "file",
                tokenStart: file.start,
                query: file.query,
                items: matches,
                selected: 0,
              }
            : null,
        );
      };

      // Session snapshot: one host fetch per @-session; keystrokes filter the
      // snapshot client-side. Refetch only when the query stops extending the
      // snapshot's query (or the snapshot was truncated).
      const cached = fileSnapshotRef.current;
      if (cached && !cached.truncated && query.startsWith(cached.query)) {
        applySnapshot(cached);
        return;
      }
      const context = workspaceContext(host, workspace);
      void hostClient
        .request("workspace.searchFiles", context, { query: file.query, limit: 3000 })
        .then((res) => {
          if (!res.ok) return;
          if (generation !== completionGeneration.current) return;
          const snapshot = {
            query,
            entries: res.result.files,
            truncated: res.result.truncated,
          };
          fileSnapshotRef.current = snapshot;
          applySnapshot(snapshot);
        })
        .catch(() => undefined);
      return;
    }
    setCompletion(null);
  }

  function acceptCompletion(state: CompletionState, index: number) {
    const item = state.items[index];
    if (!item || !draftTarget) return;
    const caret = textareaRef.current?.selectionStart ?? text.length;
    const nextText = text.slice(0, state.tokenStart) + item.insert + text.slice(caret);
    editDraft(draftTarget, nextText);
    dismissCompletion();
    const nextCaret = state.tokenStart + item.insert.length;
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCaret, nextCaret);
    });
    // Accepting a directory keeps the mention open so the user drills deeper.
    if (state.kind === "file" && item.insert.endsWith("/")) {
      updateCompletion(nextText, nextCaret);
    }
  }

  async function addDocumentPath(path: string, info?: DesktopFileInfo) {
    if (!host || !workspace || !session) return;
    let fileInfo: DesktopFileInfo;
    try {
      fileInfo = info ?? (await getDesktopFileInfo(path));
    } catch (error) {
      pushNotification(
        t("composerReadFileFailedDetail", {
          name: localPathName(path),
          error: error instanceof Error ? error.message : String(error),
        }),
        "warning",
      );
      return;
    }
    if (fileInfo.sizeBytes > MAX_AGENT_ATTACHMENT_BYTES) {
      // Do not copy or parse documents above the parser's per-file safety
      // threshold. Keep them as path attachments so they remain visible and
      // the Agent can choose an appropriate external tool.
      await addPathOnlyAttachment(path, fileInfo, true);
      return;
    }
    const context = activeSessionContext(host, workspace, session);
    const generation = captureRequestGeneration(host);
    try {
      const response = await hostClient.request("attachment.create", context, { path }, 120_000);
      if (!response.ok) {
        // The file may have grown after desktop_file_info(). Preserve the same
        // large-document path behavior if the Host observes that race.
        if (/50 mib|file limit/iu.test(response.error?.message ?? "")) {
          await addPathOnlyAttachment(path, undefined, true);
        } else {
          pushNotification(localizedDocumentError(response.error?.message, t), "error");
        }
        return;
      }
      if (
        !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
          session: true,
        })
      ) {
        return;
      }
      updateDocuments((current) => [
        ...current,
        { ...response.result, kind: "path", sourcePath: path },
      ]);

      // Parsing can finish before the create response reaches the renderer.
      // Fetch once after insertion so no final state event can be lost.
      void hostClient
        .request("attachment.get", context, { attachmentId: response.result.id })
        .then((latest) => {
          if (!latest.ok) return;
          updateDocuments((current) =>
            current.map((document) =>
              document.id === latest.result.id ? { ...document, ...latest.result } : document,
            ),
          );
        })
        .catch(() => undefined);
    } catch (error) {
      if (isHostEpochError(error)) return;
      pushNotification(
        localizedDocumentError(error instanceof Error ? error.message : String(error), t),
        "error",
      );
    }
  }

  async function removeDocument(document: PendingDocument): Promise<boolean> {
    if (!host || !workspace || !session) return false;
    try {
      const response = await hostClient.request(
        "attachment.remove",
        activeSessionContext(host, workspace, session),
        { attachmentId: document.id },
      );
      if (!response.ok) {
        pushNotification(localizeHostError(response.error, t), hostErrorLevel(response.error));
        return false;
      }
      updateDocuments((current) => current.filter((item) => item.id !== document.id));
      return true;
    } catch (error) {
      notifyOperationFailure(error, t("composerDocumentRemoveFailed"));
      return false;
    }
  }

  async function retryDocument(document: PendingPathDocument) {
    if (!(await removeDocument(document))) return;
    await addDocumentPath(document.sourcePath);
  }

  async function recoverFailedPastedText(
    document: PendingPastedText,
    error?: string,
  ): Promise<void> {
    if (recoveringPastedTextRef.current.has(document.id)) return;
    recoveringPastedTextRef.current.add(document.id);
    try {
      if (document.remote && host && workspace && session) {
        await hostClient
          .request("attachment.remove", activeSessionContext(host, workspace, session), {
            attachmentId: document.id,
          })
          .catch(() => undefined);
      }
      updateDocuments((current) => current.filter((item) => item.id !== document.id));
      insertRecoveredText(document.recovery);
      if (error !== undefined) {
        pushNotification(
          t("composerPastedTextCreateFailed", {
            error: error || t("composerDocumentParseFailed"),
          }),
          "error",
        );
      }
    } finally {
      recoveringPastedTextRef.current.delete(document.id);
    }
  }
  recoverFailedPastedTextCallbackRef.current = recoverFailedPastedText;

  async function restorePastedText(document: PendingPastedText): Promise<void> {
    if (!document.remote) return;
    if (!(await removeDocument(document))) return;
    insertRecoveredText(document.recovery);
  }

  async function addPastedText(recovery: PasteRecovery) {
    if (!host || !workspace || !session) return;
    const localId = crypto.randomUUID();
    const pending: PendingPastedText = {
      id: localId,
      name: t("composerPastedTextName"),
      mediaType: "text/plain",
      sizeBytes: utf8ByteLength(recovery.text),
      status: "copying",
      unit: "chunk",
      kind: "pasted-text",
      remote: false,
      recovery,
    };
    updateDocuments((current) => [...current, pending]);
    const context = activeSessionContext(host, workspace, session);
    const generation = captureRequestGeneration(host);
    const generationIsCurrent = () =>
      isCurrentRequestGeneration(useAppStore.getState().host, generation, {
        session: true,
      });
    try {
      const response = await hostClient.request(
        "attachment.createText",
        context,
        { text: recovery.text },
        120_000,
      );
      if (!response.ok) {
        if (!generationIsCurrent()) {
          updateDocuments((current) => current.filter((item) => item.id !== localId));
          return;
        }
        await recoverFailedPastedText(pending, response.error?.message);
        return;
      }
      if (!generationIsCurrent()) {
        await hostClient
          .request("attachment.remove", context, { attachmentId: response.result.id })
          .catch(() => undefined);
        updateDocuments((current) => current.filter((item) => item.id !== localId));
        return;
      }
      const created: PendingPastedText = {
        ...response.result,
        kind: "pasted-text",
        remote: true,
        recovery,
      };
      updateDocuments((current) =>
        current.map((document) => (document.id === localId ? created : document)),
      );

      void hostClient
        .request("attachment.get", context, { attachmentId: created.id })
        .then((latest) => {
          if (!latest.ok) return;
          const current = documentsRef.current.find((document) => document.id === latest.result.id);
          if (current?.kind === "pasted-text" && latest.result.status === "failed") {
            void recoverFailedPastedText(current, latest.result.error);
            return;
          }
          updateDocuments((documents) =>
            documents.map((document) =>
              document.id === latest.result.id ? { ...document, ...latest.result } : document,
            ),
          );
        })
        .catch(() => undefined);
    } catch (error) {
      if (!generationIsCurrent()) {
        updateDocuments((current) => current.filter((item) => item.id !== localId));
        return;
      }
      await recoverFailedPastedText(
        pending,
        isHostEpochError(error)
          ? undefined
          : error instanceof Error
            ? error.message
            : String(error),
      );
    }
  }

  async function addLocalPaths(paths: readonly string[]) {
    for (const path of paths) {
      let info: DesktopFileInfo;
      try {
        info = await getDesktopFileInfo(path);
      } catch (error) {
        pushNotification(
          t("composerReadFileFailedDetail", {
            name: localPathName(path),
            error: error instanceof Error ? error.message : String(error),
          }),
          "warning",
        );
        continue;
      }
      if (info.isDirectory) {
        await addPathOnlyAttachment(path, info);
        continue;
      }
      if (info.sizeBytes > MAX_AGENT_ATTACHMENT_BYTES && /\.(?:pdf|docx|txt)$/iu.test(path)) {
        // Files above the parser threshold stay visible as paths. This avoids
        // copying or reading a large document merely to display it.
        await addPathOnlyAttachment(path, info, true);
        continue;
      }
      if (isDocumentPath(path)) {
        await addDocumentPath(path, info);
        continue;
      }
      try {
        const file = await readDesktopSmallFile(path);
        if (file.kind === "image") {
          setImages((current) => {
            if (current.length >= MAX_AGENT_REQUEST_IMAGES) {
              pushNotification(
                t("composerImageLimit", { max: MAX_AGENT_REQUEST_IMAGES }),
                "warning",
              );
              return current;
            }
            return [
              ...current,
              {
                id: crypto.randomUUID(),
                mediaType: file.mediaType,
                data: file.data,
                name: file.name,
                sourcePath: path,
              },
            ];
          });
        } else {
          setFiles((current) => {
            const unlimited = path.toLowerCase().endsWith(".txt");
            if (!unlimited && current.filter((file) => !file.unlimited).length >= MAX_FILES) {
              pushNotification(t("composerFileLimit", { max: MAX_FILES }), "warning");
              return current;
            }
            const next = [
              ...current,
              {
                id: crypto.randomUUID(),
                name: file.name,
                size: file.sizeBytes,
                kind: "text" as const,
                text: file.text,
                sourcePath: path,
                ...(unlimited ? { unlimited: true as const } : {}),
              },
            ];
            if (unlimited) return next;
            let regularCount = 0;
            return next.filter((item) => item.unlimited || regularCount++ < MAX_FILES);
          });
        }
      } catch {
        // Unknown/binary/oversized file: keep it as a path-only attachment
        // (no content read, no parsing) so the agent can still operate on it.
        const isDocumentPathOnly = /\.(?:pdf|docx|txt)$/iu.test(path.trim());
        await addPathOnlyAttachment(path, info, isDocumentPathOnly);
      }
    }
  }
  addLocalPathsCallbackRef.current = addLocalPaths;

  async function addPathOnlyAttachment(path: string, info?: DesktopFileInfo, unlimited = false) {
    let name: string;
    let size: number;
    let isDirectory: boolean;
    try {
      const resolved = info ?? (await getDesktopFileInfo(path));
      name = resolved.name;
      size = resolved.sizeBytes;
      isDirectory = resolved.isDirectory;
    } catch (error) {
      pushNotification(
        t("composerReadFileFailedDetail", {
          name: localPathName(path),
          error: error instanceof Error ? error.message : String(error),
        }),
        "warning",
      );
      return;
    }
    setFiles((current) => {
      if (!unlimited && current.filter((file) => !file.unlimited).length >= MAX_FILES) {
        pushNotification(t("composerFileLimit", { max: MAX_FILES }), "warning");
        return current;
      }
      const next = [
        ...current,
        {
          id: crypto.randomUUID(),
          name,
          size,
          kind: "path" as const,
          sourcePath: path,
          ...(isDirectory ? { isDirectory: true as const } : {}),
          ...(unlimited ? { unlimited: true as const } : {}),
        },
      ];
      if (unlimited) return next;
      let regularCount = 0;
      return next.filter((file) => file.unlimited || regularCount++ < MAX_FILES);
    });
  }

  async function chooseAttachments() {
    try {
      const paths = await pickDesktopAttachmentPaths();
      if (paths === null) {
        fileInputRef.current?.click();
        return;
      }
      await addLocalPaths(paths);
    } catch (error) {
      pushNotification(
        error instanceof Error ? error.message : t("composerFilePickerFailed"),
        "error",
      );
    }
  }

  async function addFiles(incoming: Iterable<File>) {
    const imageFiles: File[] = [];
    const textFiles: File[] = [];
    for (const file of incoming) {
      if (/\.(?:pdf|docx)$/iu.test(file.name)) {
        pushNotification(t("composerDocumentDesktopOnly", { name: file.name }), "warning");
        continue;
      }
      if (file.type.startsWith("image/")) {
        if (file.size > MAX_AGENT_IMAGE_BYTES) {
          pushNotification(
            t("composerImageTooLarge", {
              max: Math.round(MAX_AGENT_IMAGE_BYTES / 1024 / 1024),
            }),
            "warning",
          );
          continue;
        }
        imageFiles.push(file);
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        pushNotification(
          t("composerFileTooLarge", {
            name: file.name,
            max: Math.round(MAX_FILE_BYTES / 1024),
          }),
          "warning",
        );
        continue;
      }
      textFiles.push(file);
    }

    if (imageFiles.length > 0) {
      const loaded = (await Promise.all(imageFiles.map(fileToImage))).filter(
        (image): image is PendingImage => image !== null,
      );
      setImages((current) => {
        const next = [...current, ...loaded];
        if (next.length > MAX_AGENT_REQUEST_IMAGES) {
          pushNotification(t("composerImageLimit", { max: MAX_AGENT_REQUEST_IMAGES }), "warning");
        }
        return next.slice(0, MAX_AGENT_REQUEST_IMAGES);
      });
    }

    if (textFiles.length > 0) {
      const loaded: PendingFile[] = [];
      for (const file of textFiles) {
        try {
          const text = await file.text();
          if (looksBinary(text)) {
            pushNotification(t("composerBinaryUnsupported", { name: file.name }), "warning");
            continue;
          }
          loaded.push({
            id: crypto.randomUUID(),
            name: file.name,
            size: file.size,
            kind: "text",
            text,
            ...(file.name.toLowerCase().endsWith(".txt") ? { unlimited: true } : {}),
          });
        } catch {
          pushNotification(t("composerReadFileFailed", { name: file.name }), "warning");
        }
      }
      if (loaded.length > 0) {
        setFiles((current) => {
          const next = [...current, ...loaded];
          const regularFiles = next.filter((file) => !file.unlimited);
          if (regularFiles.length > MAX_FILES) {
            pushNotification(t("composerFileLimit", { max: MAX_FILES }), "warning");
          }
          let regularCount = 0;
          return next.filter((file) => file.unlimited || regularCount++ < MAX_FILES);
        });
      }
    }
  }

  function pasteTextAsAttachment(
    pastedText: string,
    selectionStart: number,
    selectionEnd: number,
  ): boolean {
    const sizeBytes = utf8ByteLength(pastedText);
    if (pastedText.trim().length === 0 || pastedText.includes("\u0000")) {
      pushNotification(t("composerPastedTextInvalid"), "warning");
      return false;
    }
    if (sizeBytes > MAX_PASTED_TEXT_ATTACHMENT_BYTES) {
      pushNotification(
        t("composerPastedTextTooLarge", {
          max: Math.round(MAX_PASTED_TEXT_ATTACHMENT_BYTES / 1024 / 1024),
        }),
        "warning",
      );
      return false;
    }
    if (!session) return false;
    void addPastedText({
      sessionId: session.sessionId,
      text: pastedText,
      draft: text,
      selectionStart,
      selectionEnd,
    });
    return true;
  }

  function handleComposerPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const pastedFiles = [...event.clipboardData.items]
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (pastedFiles.length > 0) {
      event.preventDefault();
      void addFiles(pastedFiles);
      return;
    }

    const pastedText = event.clipboardData.getData("text/plain");
    const sizeBytes = utf8ByteLength(pastedText);
    if (sizeBytes < PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES) return;

    event.preventDefault();
    const selectionStart = event.currentTarget.selectionStart ?? text.length;
    const selectionEnd = event.currentTarget.selectionEnd ?? selectionStart;
    pasteTextAsAttachment(pastedText, selectionStart, selectionEnd);
  }

  /** Documents that are ready, or scanned PDFs the agent can handle via its own OCR tooling. */
  function isDocumentSendable(status: PendingDocument["status"]): boolean {
    return status === "ready" || status === "needs_ocr";
  }

  async function send() {
    if (!host || !workspace || !session || !draftTarget || disabled || decisionBlocked) return;
    if (
      documents.some((document) => !isDocumentSendable(document.status)) ||
      (!text.trim() && images.length === 0 && files.length === 0 && documents.length === 0)
    ) {
      return;
    }

    const builtin = matchBuiltinCommand(text);
    if (builtin?.name === "session") {
      deleteDraft(draftTarget);
      dismissCompletion();
      setStatsOpen(true);
      return;
    }
    if (builtin?.name === "tree") {
      deleteDraft(draftTarget);
      dismissCompletion();
      requestTreeOverlay();
      return;
    }
    if (builtin?.name === "fork") {
      deleteDraft(draftTarget);
      dismissCompletion();
      setForkOpen(true);
      return;
    }
    if (builtin?.name === "export") {
      const arg = builtin.args?.trim().toLowerCase();
      if (arg && arg !== "html" && arg !== "jsonl") {
        pushNotification(t("composerExportUsage"), "error");
        return;
      }
      deleteDraft(draftTarget);
      dismissCompletion();
      void requestExport(arg === "jsonl" ? "jsonl" : "html");
      return;
    }
    if (builtin?.name === "compact") {
      if (busy) {
        // requestCompact surfaces the busy notification; keep the draft.
        void requestCompact(builtin.args);
        return;
      }
      const receipt = stageDraftSend(draftTarget);
      dismissCompletion();
      if (!(await requestCompact(builtin.args))) {
        restoreDraftSend(receipt);
      } else {
        commitDraftSend(receipt);
      }
      return;
    }
    if (builtin?.name === "login") {
      // The Pi CLI's /login has no meaning here — without this interception it
      // would go to the model as plain text and, in the no-credentials case,
      // echo back the same "run /login" guidance forever.
      deleteDraft(draftTarget);
      dismissCompletion();
      openSettingsSection("providers");
      pushNotification(t("composerLoginGuidance"), "info");
      return;
    }

    const value = text;
    const sentImages = images;
    const sentFiles = files;
    const sentDocuments = documents;
    const sendReceipt = stageDraftSend(draftTarget);
    dismissCompletion();
    setImages([]);
    setFiles([]);
    documentsRef.current = [];
    setDocuments([]);
    const context = activeSessionContext(host, workspace, session);
    const attachmentBlocks: string[] = sentFiles.map((f) =>
      f.kind === "path"
        ? buildAttachedPathBlock(f.name, f.sourcePath ?? "")
        : buildAttachedFileBlock(f.name, f.text ?? "", f.sourcePath),
    );
    for (const image of sentImages) {
      if (image.name && image.sourcePath) {
        attachmentBlocks.push(buildAttachedImageBlock(image.name, image.sourcePath));
      }
    }
    const outgoingText =
      attachmentBlocks.length > 0
        ? [value.trimEnd(), ...attachmentBlocks].filter(Boolean).join("\n\n")
        : value;
    const imageParams =
      sentImages.length > 0
        ? { images: sentImages.map(({ mediaType, data }) => ({ mediaType, data })) }
        : {};
    const attachmentParams =
      sentDocuments.length > 0
        ? { attachmentIds: sentDocuments.map((document) => document.id) }
        : {};
    const restoreDraft = () => {
      restoreDraftSend(sendReceipt);
      setImages(sentImages);
      setFiles(sentFiles);
      documentsRef.current = sentDocuments;
      setDocuments(sentDocuments);
    };
    // Optimistic echo (idle prompt path only): show the user's bubble
    // immediately instead of waiting for the Host to echo message_start (which
    // can lag behind model preflight/compaction). The authoritative event
    // later replaces the marker in place, so there is never a duplicate row.
    let optimisticKey: string | null = null;
    const appendOptimisticMessage = () => {
      optimisticKey = appendOptimisticUserMessage(
        outgoingText,
        session?.sessionId,
        sentImages.map(({ mediaType, data }) => ({ mediaType, data })),
      );
    };
    const removeOptimisticMessage = () => {
      removeOptimisticUserMessage(optimisticKey);
      optimisticKey = null;
    };
    // AUTH_REQUIRED gets the persistent banner (with a Providers-settings
    // path) instead of a vanishing toast; anything else keeps the toast.
    const handleSendFailure = (
      error: { code: string; message: string; details?: JsonValue } | undefined,
    ) => {
      if (error?.code === "AUTH_REQUIRED") {
        const details = error.details;
        setAuthBlocked({
          providerId:
            details && typeof details === "object" && !Array.isArray(details)
              ? typeof details.providerId === "string"
                ? details.providerId
                : null
              : null,
        });
      } else {
        pushNotification(localizeHostError(error, t), hostErrorLevel(error));
      }
      restoreDraft();
    };

    try {
      if (busy) {
        // Running-session sends use the configured steer or follow-up behavior.
        // No optimistic bubble here: the QueuePanel waiting area already echoes
        // the queued text via pending.steering/followUp, and echoing it into the
        // transcript would render the message twice (and pin it at a stale
        // position when the queued run later starts).
        const res = await hostClient.request(busySendMethod(busySendBehavior), context, {
          text: outgoingText,
          ...imageParams,
          ...attachmentParams,
        });
        if (!res.ok) {
          handleSendFailure(res.error);
        } else {
          commitDraftSend(sendReceipt);
        }
        return;
      }

      appendOptimisticMessage();
      const res = await hostClient.request(
        "agent.prompt",
        context,
        { text: outgoingText, ...imageParams, ...attachmentParams },
        null,
      );
      if (!res.ok) {
        removeOptimisticMessage();
        handleSendFailure(res.error);
      } else {
        commitDraftSend(sendReceipt);
        // An accepted prompt means credentials resolved; drop any stale banner.
        setAuthBlocked(null);
      }
    } catch (error) {
      removeOptimisticMessage();
      notifyOperationFailure(error, t("composerSendFailed"));
      restoreDraft();
    }
  }

  async function abort() {
    if (!host || !workspace || !session) return;
    const generation = captureRequestGeneration(host);
    const res = await hostClient.request(
      "agent.abort",
      activeSessionContext(host, workspace, session),
      null,
    );
    if (
      !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
        session: true,
      })
    ) {
      return;
    }
    if (!res.ok) {
      pushNotification(localizeHostError(res.error, t), hostErrorLevel(res.error));
      return;
    }
    setSession(res.result.session);
    if (res.result.error) {
      pushNotification(res.result.error.message, "error");
    }
  }

  const hasDraftContent =
    Boolean(text.trim()) || images.length > 0 || files.length > 0 || documents.length > 0;
  const documentsReady = documents.every((document) => isDocumentSendable(document.status));
  const canSend = !disabled && !decisionBlocked && documentsReady && hasDraftContent;

  return (
    <div
      // "welcome" is the vertically centered empty-conversation layout; only
      // the docked composer trims its bottom padding when the stats pills
      // render below it (see the `:has(+ …)` rule in styles/index.css).
      data-composer-footer={welcomeWorkspaceName ? "welcome" : "docked"}
      className={
        welcomeWorkspaceName
          ? "flex min-h-0 flex-1 flex-col justify-center px-5 pb-14 pt-6"
          : "shrink-0 px-5 pb-5 pt-2"
      }
    >
      {welcomeWorkspaceName && welcomeKey && (
        <div className="conversation-content-width new-conversation-copy mx-auto mb-6 flex flex-col items-center text-center">
          <PiMark className="mb-4 size-20" />
          <h2 className="max-w-full truncate text-xl font-medium text-foreground">
            {t(welcomeKey)}
          </h2>
          <p className="h-4" aria-hidden />
        </div>
      )}
      <QueuePanel />
      <div
        ref={extensionWidgetAnchorRef}
        className="conversation-content-width relative mx-auto w-full"
        data-extension-widget-anchor
      >
        <ExtensionStatusStrip />
        <div
          className={`chat-composer-surface rounded-xl border-[1.5px] bg-surface-raised p-2 shadow-sm transition-colors ${
            dragOver ? "border-accent" : "border-border"
          }`}
          onDragOver={(event) => {
            if (disabled) return;
            if ([...event.dataTransfer.items].some((item) => item.kind === "file")) {
              event.preventDefault();
              setDragOver(true);
            }
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(event) => {
            if (disabled) return;
            event.preventDefault();
            setDragOver(false);
            void addFiles(event.dataTransfer.files);
          }}
        >
          <div
            role="separator"
            tabIndex={0}
            aria-label={t("composerResize")}
            aria-orientation="horizontal"
            aria-valuemin={60}
            aria-valuemax={280}
            className="group/composer-resize -mx-2 -mt-2 mb-1 h-1.5 touch-none rounded-t-xl cursor-ns-resize bg-transparent"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              const el = textareaRef.current;
              if (!el) return;
              event.preventDefault();
              composerResizeStart.current = {
                pointerId: event.pointerId,
                y: event.clientY,
                height: el.clientHeight,
              };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const start = composerResizeStart.current;
              if (!start || start.pointerId !== event.pointerId) return;
              // handle is at the top of the textarea: dragging up (clientY shrinks) grows it.
              applyComposerResize(start.height + (start.y - event.clientY));
            }}
            onPointerUp={(event) => finishComposerResize(event.currentTarget, event.pointerId)}
            onPointerCancel={(event) => finishComposerResize(event.currentTarget, event.pointerId)}
            onLostPointerCapture={() => {
              composerResizeStart.current = null;
            }}
            onKeyDown={(event) => {
              if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
              event.preventDefault();
              const el = textareaRef.current;
              if (!el) return;
              applyComposerResize(el.clientHeight + (event.key === "ArrowUp" ? 12 : -12));
            }}
          />
          {documents.length > 0 && (
            <div
              className="grid gap-1.5 px-2 pt-1.5 sm:grid-cols-2"
              aria-live="polite"
              aria-label={t("composerDocuments")}
            >
              {documents.map((document) => {
                const active = document.status === "copying" || document.status === "parsing";
                const failed = document.status === "failed";
                const progress =
                  document.unitCount && document.processedUnits !== undefined
                    ? Math.min(
                        100,
                        Math.round((document.processedUnits / document.unitCount) * 100),
                      )
                    : 0;
                const status = documentStatusText(document, t);
                return (
                  <div
                    key={document.id}
                    className={`relative min-w-0 overflow-hidden rounded-md border bg-surface px-2 py-1.5 text-xs ${
                      failed ? "border-danger/35" : "border-border"
                    }`}
                    title={`${document.name} · ${formatFileSize(document.sizeBytes)} · ${status}`}
                    {...(failed ? { role: "alert" as const } : {})}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      {active ? (
                        <LoaderCircle
                          size={14}
                          className="shrink-0 animate-spin text-accent motion-reduce:animate-none"
                        />
                      ) : failed ? (
                        <CircleAlert size={14} className="shrink-0 text-danger" />
                      ) : (
                        <CircleCheck size={14} className="shrink-0 text-success" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{document.name}</div>
                        <div
                          className={`truncate text-[10px] ${failed ? "text-danger" : "text-muted"}`}
                        >
                          {formatFileSize(document.sizeBytes)} · {status}
                        </div>
                      </div>
                      {document.kind === "path" && document.status === "failed" && (
                        <button
                          type="button"
                          title={t("composerDocumentRetry")}
                          aria-label={t("composerDocumentRetryNamed", { name: document.name })}
                          className="flex size-6 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-foreground"
                          onClick={() => void retryDocument(document)}
                        >
                          <RefreshCw size={12} />
                        </button>
                      )}
                      {document.kind === "pasted-text" &&
                        document.remote &&
                        document.status === "ready" && (
                          <button
                            type="button"
                            title={t("composerPastedTextRestore")}
                            aria-label={t("composerPastedTextRestoreNamed", {
                              name: document.name,
                            })}
                            className="flex size-6 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-foreground"
                            onClick={() => void restorePastedText(document)}
                          >
                            <Undo2 size={12} />
                          </button>
                        )}
                      <button
                        type="button"
                        title={t("composerRemoveFile")}
                        aria-label={t("composerRemoveNamedFile", { name: document.name })}
                        className="flex size-6 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"
                        disabled={document.kind === "pasted-text" && !document.remote}
                        onClick={() => void removeDocument(document)}
                      >
                        <X size={12} />
                      </button>
                    </div>
                    {active && document.unitCount !== undefined && (
                      <div
                        className="mt-1 h-0.5 overflow-hidden rounded-full bg-surface-overlay"
                        role="progressbar"
                        aria-label={status}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={progress}
                      >
                        <div className="h-full bg-accent" style={{ width: `${progress}%` }} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {files.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-2 pt-1.5">
              {files.map((file) => (
                <div
                  key={file.id}
                  className="group flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface px-2 text-xs"
                  title={`${file.name} · ${
                    file.isDirectory
                      ? t("composerPathFolder")
                      : `${Math.max(1, Math.round(file.size / 1024))} KB`
                  }${file.sourcePath ? `\n${file.sourcePath}` : ""}`}
                >
                  {file.kind === "path" ? (
                    file.isDirectory ? (
                      <Folder size={12} className="shrink-0 text-muted" />
                    ) : (
                      <FileArchive size={12} className="shrink-0 text-muted" />
                    )
                  ) : (
                    <FileText size={12} className="shrink-0 text-muted" />
                  )}
                  <span className="max-w-40 truncate">{file.name}</span>
                  <button
                    type="button"
                    title={t("composerRemoveFile")}
                    aria-label={t("composerRemoveNamedFile", { name: file.name })}
                    className="text-muted hover:text-danger"
                    onClick={() => setFiles((current) => current.filter((it) => it.id !== file.id))}
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2 px-2 pt-1.5">
              {images.map((image) => (
                <div key={image.id} className="group relative">
                  <img
                    src={`data:${image.mediaType};base64,${image.data}`}
                    alt={t("transcriptAttachmentAlt")}
                    className="size-16 rounded-md border border-border object-cover"
                  />
                  <button
                    type="button"
                    title={t("composerRemoveImage")}
                    aria-label={t("composerRemoveImage")}
                    className="absolute -right-1.5 -top-1.5 hidden size-5 items-center justify-center rounded-full border border-border bg-surface-raised text-muted shadow group-hover:flex hover:text-danger"
                    onClick={() =>
                      setImages((current) => current.filter((it) => it.id !== image.id))
                    }
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {decisionBlocked ? (
            <div
              id={decisionHintId}
              role="status"
              aria-live="polite"
              className="flex min-h-8 items-center gap-1.5 px-2 pb-1 text-xs text-muted"
            >
              <MessageCircleQuestion
                size={13}
                className="shrink-0 text-accent"
                aria-hidden="true"
              />
              <span>{t("composerDecisionPending")}</span>
            </div>
          ) : null}
          <div className="relative">
            {completion && (
              <div
                data-composer-completion
                className="theme-floating-surface absolute bottom-full left-2 z-30 mb-1 max-h-64 w-[420px] max-w-[90%] overflow-y-auto rounded-md border border-border bg-surface-raised py-1 shadow-lg"
              >
                {completion.items.map((item, index) => (
                  <button
                    key={`${item.label}:${index}`}
                    type="button"
                    title={item.detail ? `${item.label}\n${item.detail}` : item.label}
                    ref={(node) => {
                      if (node && index === completion.selected) {
                        node.scrollIntoView({ block: "nearest" });
                      }
                    }}
                    className={`flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left text-xs ${
                      index === completion.selected
                        ? "bg-surface-overlay text-foreground"
                        : "text-foreground/85 hover:bg-surface-overlay/60"
                    }`}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      acceptCompletion(completion, index);
                    }}
                  >
                    <span className="shrink-0 font-medium">{item.label}</span>
                    {item.detail && (
                      <span className="min-w-0 truncate text-muted">{item.detail}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
            <textarea
              ref={textareaRef}
              className="chat-composer-input min-h-[60px] max-h-[280px] w-full resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted"
              placeholder={disabled ? t("composerUnavailable") : t("composerPlaceholder")}
              value={text}
              disabled={disabled}
              aria-describedby={decisionBlocked ? decisionHintId : undefined}
              onChange={(event) => {
                if (!draftTarget) return;
                editDraft(draftTarget, event.target.value);
                updateCompletion(
                  event.target.value,
                  event.target.selectionStart ?? event.target.value.length,
                );
              }}
              onBlur={dismissCompletion}
              onPaste={handleComposerPaste}
              onContextMenu={(event) => {
                if (shouldKeepNativeContextMenu(event.nativeEvent)) return;
                event.preventDefault();
                event.stopPropagation();
                const selectionStart = event.currentTarget.selectionStart ?? text.length;
                const selectionEnd = event.currentTarget.selectionEnd ?? selectionStart;
                openContextMenu({
                  x: event.clientX,
                  y: event.clientY,
                  trigger: contextMenuTrigger(event.target),
                  items: buildTextContextMenuItems(event.currentTarget, t, [
                    {
                      id: "composer.pasteAsAttachment",
                      label: t("menuPasteAsAttachment"),
                      icon: ClipboardPaste,
                      separatorBefore: true,
                      disabled: disabled || !session,
                      onSelect: async () => {
                        const pastedText = await readClipboardText();
                        pasteTextAsAttachment(pastedText, selectionStart, selectionEnd);
                      },
                    },
                  ]),
                });
              }}
              onCompositionStart={ime.onCompositionStart}
              onCompositionEnd={ime.onCompositionEnd}
              onKeyDown={(event) => {
                if (ime.isImeKey(event)) return;
                if (completion) {
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    const delta = event.key === "ArrowDown" ? 1 : -1;
                    setCompletion((current) =>
                      current
                        ? {
                            ...current,
                            selected:
                              (current.selected + delta + current.items.length) %
                              current.items.length,
                          }
                        : null,
                    );
                    return;
                  }
                  if (event.key === "Enter" || event.key === "Tab") {
                    event.preventDefault();
                    acceptCompletion(completion, completion.selected);
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    dismissCompletion();
                    return;
                  }
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
          </div>
          <div className="composer-toolbar flex h-8 items-center gap-2.5 px-1">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,.pdf,.docx,text/*,.md,.mdx,.json,.jsonl,.yaml,.yml,.toml,.csv,.tsv,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.rs,.go,.java,.kt,.swift,.c,.h,.cpp,.hpp,.sh,.sql,.log,*"
              className="hidden"
              onChange={(event) => {
                if (event.target.files) void addFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <button
              type="button"
              title={t("composerAttach")}
              aria-label={t("composerAttach")}
              className="composer-control flex size-7 items-center justify-center rounded-md border border-border-subtle text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:opacity-40"
              disabled={disabled}
              onClick={() => void chooseAttachments()}
            >
              <Paperclip size={14} />
            </button>
            <ContextUsageRing />
            <TodoPopoverButton />
            <ExtensionWidgetsButton open={extensionWidgetsOpen} onToggle={toggleExtensionWidgets} />
            <div className="ml-auto flex items-center gap-2.5">
              <ModelControls />
              {busy ? (
                canSend ? (
                  <button
                    type="button"
                    title={t("composerQueueMessageShortcut")}
                    aria-label={t("composerQueueMessage")}
                    className="theme-send-control flex size-7 items-center justify-center rounded-full bg-foreground text-surface transition-colors hover:opacity-85"
                    onClick={() => void send()}
                  >
                    <ArrowUp size={18} strokeWidth={2.25} className="block shrink-0" />
                  </button>
                ) : (
                  <button
                    type="button"
                    title={session?.isCompacting ? t("composerStopCompaction") : t("composerStop")}
                    aria-label={
                      session?.isCompacting ? t("composerStopCompaction") : t("composerStop")
                    }
                    className="flex size-7 items-center justify-center rounded-full bg-danger/15 text-danger hover:bg-danger/20"
                    onClick={() => void (session?.isCompacting ? abortCompaction() : abort())}
                  >
                    <Square size={14} fill="currentColor" className="block shrink-0" />
                  </button>
                )
              ) : (
                <button
                  type="button"
                  title={t("composerSend")}
                  aria-label={t("composerSend")}
                  className="theme-send-control flex size-7 items-center justify-center rounded-full bg-foreground text-surface transition-colors hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-30"
                  disabled={!canSend}
                  onClick={() => void send()}
                >
                  <ArrowUp size={18} strokeWidth={2.25} className="block shrink-0" />
                </button>
              )}
            </div>
          </div>
        </div>
        <ExtensionWidgetsPopover
          anchorRef={extensionWidgetAnchorRef}
          open={extensionWidgetsOpen}
          onClose={closeExtensionWidgets}
        />
        <SessionStatsModal open={statsOpen} onClose={() => setStatsOpen(false)} />
        <ForkModal open={forkOpen} onClose={() => setForkOpen(false)} />
      </div>
    </div>
  );
}
