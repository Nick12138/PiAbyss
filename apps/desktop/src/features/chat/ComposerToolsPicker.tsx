import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, SquareDashed, SquareCheck, Wrench } from "lucide-react";
import { useAppStore } from "../../lib/stores/app-store";
import { useT } from "../../lib/i18n/use-t";
import { hostClient } from "../../lib/bridge/host-client";
import { activeSessionContext } from "../../lib/bridge/host-context";
import { requestWithRetry } from "../../lib/bridge/request-retry";
import { localizeHostError } from "../../lib/bridge/localize-host-error";
import { notifyOperationFailure } from "../../lib/notify-operation-error";

/** Host-side attachment tool, force-appended to every active set by
 *  agent.setActiveTools (agent-controller.ts). Never user-togglable —
 *  hide it so the checkbox states match what the Host actually saves. */
const READ_ATTACHMENT_TOOL_NAME = "read_attachment";

/** Tool selection for a brand-new conversation's composer toolbar.
 *
 * Visual twin of SubagentModelPicker (same trigger chrome, same
 * theme-floating-surface dropdown) but for the session tool allowlist.
 * Each checkbox applies immediately through agent.setActiveTools — the
 * welcome-state session is idle, so the mutation is always legal; the
 * next prompt then runs with exactly the checked tools.
 *
 * Only rendered while the conversation is still empty (isNewConversation
 * in ChatPage); once a conversation has started the tool set is fixed. */
export function ComposerToolsPicker() {
  const t = useT();
  const host = useAppStore((s) => s.host);
  const workspace = useAppStore((s) => s.workspace);
  const session = useAppStore((s) => s.session);
  const tools = useAppStore((s) => s.tools);
  const [open, setOpen] = useState(false);
  /** Tool name with an in-flight toggle; the row stays interactive-locked
   *  so rapid clicks can't race two setActiveTools mutations. */
  const [pendingName, setPendingName] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const menuTools = (tools?.tools ?? []).filter(
    (tool) => tool.name !== READ_ATTACHMENT_TOOL_NAME,
  );
  const activeSet = new Set(tools?.active ?? []);
  const activeMenuNames = menuTools.filter((tool) => activeSet.has(tool.name)).map((tool) => tool.name);
  const disabled = !host || !workspace || !session || menuTools.length === 0;

  // Close on outside pointerdown / Escape — same pattern as SubagentModelPicker.
  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
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

  // Drop a stale mutation error whenever the menu closes.
  useEffect(() => {
    if (!open && mutationError) setMutationError(null);
  }, [open, mutationError]);

  /** Toggle one tool and apply the resulting allowlist immediately.
   *  read_attachment is excluded from the submitted names because the
   *  Host re-appends it unconditionally. */
  async function toggleTool(name: string) {
    if (!host || !workspace || !session || !tools || pendingName) return;
    const nextNames = activeMenuNames.includes(name)
      ? activeMenuNames.filter((candidate) => candidate !== name)
      : [...activeMenuNames, name];
    setPendingName(name);
    setMutationError(null);
    const res = await requestWithRetry(() =>
      hostClient.request(
        "agent.setActiveTools",
        {
          ...activeSessionContext(host, workspace, session),
          expectedToolRevision: tools.revision,
        },
        { names: nextNames },
      ),
    );
    setPendingName(null);
    if (!res) return;
    if (res.ok) {
      useAppStore.getState().setTools(res.result);
    } else {
      setMutationError(localizeHostError(res.error, t));
      notifyOperationFailure(res.error, t("composerToolsSetFailed"));
    }
  }

  const triggerTitle =
    activeMenuNames.length > 0 ? activeMenuNames.join(", ") : t("composerToolsPicker");

  return (
    <div ref={menuRef} className="relative flex h-7 items-center">
      <button
        type="button"
        className="composer-control flex h-7 cursor-pointer items-center gap-1 rounded-md border border-border-subtle px-1.5 text-xs text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:cursor-default disabled:opacity-40"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("composerToolsPicker")}
        title={triggerTitle}
        onClick={() => setOpen((value) => !value)}
      >
        <Wrench size={13} className="shrink-0" />
        <span className="whitespace-nowrap leading-none">
          {activeMenuNames.length}/{menuTools.length}
        </span>
        <ChevronDown
          className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          size={13}
        />
      </button>
      {open && (
        <div className="absolute bottom-full right-0 z-50 mb-2 w-64">
          <div className="theme-floating-surface w-full rounded-md border border-border bg-surface-raised shadow-lg">
            <div
              className="max-h-80 w-full overflow-y-auto rounded-t-md py-0.5"
              role="menu"
              aria-label={t("composerToolsMenu")}
            >
              {menuTools.map((tool) => {
                const checked = activeSet.has(tool.name);
                const pending = pendingName === tool.name;
                const rowLocked = pendingName !== null;
                return (
                  <button
                    key={tool.name}
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={checked}
                    disabled={rowLocked}
                    className="flex h-8 w-full items-center gap-1.5 px-2.5 text-left text-xs text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:cursor-default disabled:opacity-50"
                    title={tool.description ?? tool.name}
                    onClick={() => void toggleTool(tool.name)}
                  >
                    {checked ? (
                      <SquareCheck size={14} className="shrink-0 text-foreground" />
                    ) : (
                      <SquareDashed size={14} className="shrink-0" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{tool.name}</span>
                    {pending && (
                      <Check size={13} className="shrink-0 animate-pulse text-foreground" />
                    )}
                  </button>
                );
              })}
            </div>
            {mutationError && (
              <p className="border-t border-border px-2.5 py-1.5 text-xs text-danger">
                {mutationError}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
