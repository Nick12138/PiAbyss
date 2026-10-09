import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, SquareDashed, SquareCheck, Wrench } from "lucide-react";
import { useAppStore } from "../../lib/stores/app-store";
import { useT } from "../../lib/i18n/use-t";
import { hostClient } from "../../lib/bridge/host-client";
import { activeSessionContext } from "../../lib/bridge/host-context";
import { requestWithRetry } from "../../lib/bridge/request-retry";
import { localizeHostError } from "../../lib/bridge/localize-host-error";
import { notifyOperationFailure } from "../../lib/notify-operation-error";
import { usePluginCatalogData } from "../plugin-library/plugin-gate";
import {
  buildPluginToolIndex,
  isGlobalOnlyPluginTool,
  pluginEntryForTool,
} from "../plugin-library/plugin-library-model";

/** Host-side attachment tool, force-appended to every active set by
 *  agent.setActiveTools (agent-controller.ts). Never user-togglable —
 *  hide it so the checkbox states match what the Host actually saves. */
const READ_ATTACHMENT_TOOL_NAME = "read_attachment";

/** Built-in tools pi ships (mirrors BUILTIN_TOOLS in DefaultToolsSetting).
 *  The per-conversation picker only offers plugin-provided tools: built-ins
 *  are managed globally in Settings → General → 默认工具. */
const BUILTIN_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

/** Tool selection for a brand-new conversation's composer toolbar.
 *
 * Visual twin of SubagentModelPicker (same trigger chrome, same
 * theme-floating-surface dropdown) but for the session tool allowlist.
 * Each checkbox applies immediately through agent.setActiveTools — the
 * welcome-state session is idle, so the mutation is always legal; the
 * next prompt then runs with exactly the checked tools.
 *
 * Only rendered while the conversation is still empty (isNewConversation
 * in ChatPage); once a conversation has started the tool set is fixed.
 *
 * Menu contents: plugin tools only, grouped one row per plugin — a plugin's
 * switch toggles all of its tools together (mirrors the plugin-library card
 * switch). The seven built-in tools and tools from global-only plugins
 * (`toggleScopes: ["user"]` in the plugin registry) are hidden — but their
 * active state is preserved on every mutation, so toggling a visible group
 * never silently disables a hidden tool. The trigger is icon-only until the
 * user changes the selection; afterwards it shows the enabled/total plugin
 * group ratio. The dropdown sizes to its content up to a max width. */
export function ComposerToolsPicker() {
  const t = useT();
  const host = useAppStore((s) => s.host);
  const workspace = useAppStore((s) => s.workspace);
  const session = useAppStore((s) => s.session);
  const tools = useAppStore((s) => s.tools);
  const { catalog, packages } = usePluginCatalogData();
  const [open, setOpen] = useState(false);
  /** Group key with an in-flight toggle; the row stays interactive-locked
   *  so rapid clicks can't race two setActiveTools mutations. */
  const [pendingName, setPendingName] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  /** Set once the user toggles any tool; the trigger counter only shows
   *  after an explicit selection change. */
  const [modified, setModified] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  /** Attribution index from the plugin catalog + package snapshot. Null while
   *  either is loading; the menu then shows every non-builtin tool rather
   *  than an empty (and wrong) list. */
  const pluginIndex = useMemo(
    () => buildPluginToolIndex(catalog, packages),
    [catalog, packages],
  );

  const menuTools = useMemo(() => {
    const all = tools?.tools ?? [];
    return all.filter((tool) => {
      if (tool.name === READ_ATTACHMENT_TOOL_NAME) return false;
      if (BUILTIN_TOOL_NAMES.has(tool.name)) return false;
      if (isGlobalOnlyPluginTool(pluginIndex, tool)) return false;
      return true;
    });
  }, [tools, pluginIndex]);

  const activeSet = useMemo(() => new Set(tools?.active ?? []), [tools]);
  /** Hidden tools that must ride along on every mutation untouched. */
  const hiddenActiveNames = useMemo(
    () =>
      (tools?.active ?? []).filter((name) => !menuTools.some((tool) => tool.name === name)),
    [tools, menuTools],
  );

  /** One menu row per plugin (registry name + icon), not per tool: a plugin's
   *  switch enables/disables all of its tools together. Tools that cannot be
   *  attributed to a registry entry fall back to one row per tool. */
  const toolGroups = useMemo(() => {
    const groups: Array<{
      key: string;
      name: string;
      icon?: string;
      description?: string;
      toolNames: string[];
    }> = [];
    const indexByKey = new Map<string, number>();
    for (const tool of menuTools) {
      const entry = pluginEntryForTool(pluginIndex, tool);
      const key = entry ? entry.id : `tool:${tool.name}`;
      const existing = indexByKey.get(key);
      if (existing !== undefined) {
        groups[existing]!.toolNames.push(tool.name);
        continue;
      }
      indexByKey.set(key, groups.length);
      groups.push(
        entry
          ? {
              key,
              name: entry.name,
              icon: entry.icon.includes("/") || entry.icon.includes("\\") ? undefined : entry.icon,
              description: entry.description,
              toolNames: [tool.name],
            }
          : {
              key,
              name: tool.label ?? tool.name,
              description: tool.description,
              toolNames: [tool.name],
            },
      );
    }
    return groups;
  }, [menuTools, pluginIndex]);

  const disabled = !host || !workspace || !session || toolGroups.length === 0;

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

  /** Toggle one plugin group and apply the resulting allowlist immediately.
   *  read_attachment is excluded from the submitted names because the
   *  Host re-appends it unconditionally; hidden-but-active tools are
   *  re-submitted so they stay enabled. A group switch replaces every tool
   *  of that plugin at once (enabling adds all, disabling removes all). */
  async function toggleGroup(group: { key: string; toolNames: string[] }) {
    if (!host || !workspace || !session || !tools || pendingName) return;
    const enabled = group.toolNames.every((name) => activeSet.has(name));
    const groupSet = new Set(group.toolNames);
    const nextNames = [
      ...hiddenActiveNames,
      ...menuTools
        .map((tool) => tool.name)
        .filter((name) => {
          if (groupSet.has(name)) return !enabled;
          return activeSet.has(name);
        }),
    ];
    setPendingName(group.key);
    setMutationError(null);
    setModified(true);
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

  /** Counters over plugin groups: a group counts as enabled when every tool
   *  of the plugin is active. */
  const enabledGroupCount = toolGroups.filter((group) =>
    group.toolNames.every((name) => activeSet.has(name)),
  ).length;
  const enabledGroupNames = toolGroups
    .filter((group) => group.toolNames.every((name) => activeSet.has(name)))
    .map((group) => group.name);

  const triggerTitle =
    enabledGroupNames.length > 0 ? enabledGroupNames.join(", ") : t("composerToolsPicker");

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
        {modified && (
          <span className="whitespace-nowrap leading-none">
            {`${enabledGroupCount}/${toolGroups.length}`}
          </span>
        )}
        <ChevronDown
          className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          size={13}
        />
      </button>
      {open && (
        <div className="absolute bottom-full right-0 z-50 mb-2 w-max min-w-40 max-w-md">
          <div className="theme-floating-surface w-full rounded-md border border-border bg-surface-raised shadow-lg">
            <div
              className="max-h-80 w-full overflow-y-auto rounded-t-md py-0.5"
              role="menu"
              aria-label={t("composerToolsMenu")}
            >
              {toolGroups.map((group) => {
                const checked = group.toolNames.every((name) => activeSet.has(name));
                // Only the clicked row dims while its mutation is in flight;
                // concurrent clicks are already guarded inside toggleGroup,
                // so rows must not flip the whole menu to disabled (that read
                // as a flash on every click).
                const pending = pendingName === group.key;
                return (
                  <button
                    key={group.key}
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={checked}
                    className={`flex h-8 w-full items-center gap-1.5 px-2.5 text-left text-xs text-muted transition-colors hover:bg-surface-overlay hover:text-foreground ${
                      pending ? "pointer-events-none opacity-60" : ""
                    }`}
                    title={`${group.name}${group.description ? `\n${group.description}` : ""}`}
                    onClick={() => void toggleGroup(group)}
                  >
                    {checked ? (
                      <SquareCheck size={14} className="shrink-0 text-foreground" />
                    ) : (
                      <SquareDashed size={14} className="shrink-0" />
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      {group.icon ? `${group.icon} ${group.name}` : group.name}
                    </span>
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
