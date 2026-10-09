import { useEffect, useRef, useState } from "react";
import { Brain, Check, ChevronDown, ChevronRight, LoaderCircle } from "lucide-react";
import type { ModelSummary } from "@piabyss/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { useT } from "../../lib/i18n/use-t";
import { hostClient } from "../../lib/bridge/host-client";
import { hostContext } from "../../lib/bridge/host-context";
import { requestWithRetry } from "../../lib/bridge/request-retry";
import { localizeHostError } from "../../lib/bridge/localize-host-error";
import { thinkingLevelLabel } from "../chat/ModelControls";
import type { SubagentModelOverride } from "./subagent-pending-model";

/** Model + thinking-depth picker for the subagent composer toolbar.
 *
 * Visual twin of the main session's ModelControls menu (same trigger
 * chrome, same theme-floating-surface dropdown, provider-grouped rows with
 * a trailing check, thinking-depth entry pinned below the scrolling list
 * with a nested level submenu) minus the session-coupled extras (relay
 * pricing, model testing).
 *
 * Selection semantics: picking a model or thinking level only records it
 * as the run's pending override — it silently applies to the child's next
 * spawn (next send/resume). No notification, no immediate request.
 *
 * The catalog comes from `piSettings.get` (the same source as the Settings
 * → General → default-model dropdown), NOT `model.list`: the latter
 * requires a stable read of the main session's graph with a fresh session
 * revision, and while a subagent runs the orchestrator turn keeps bumping
 * that revision — responses would always arrive already stale. The
 * settings snapshot only needs the Host-level context, so it is immune to
 * both the graph-lock collisions and the revision race. */
export function SubagentModelPicker({
  currentModel,
  currentThinking,
  override,
  onChange,
}: {
  /** Model string (provider/id) the run currently uses, from the run status. */
  currentModel: string | undefined;
  /** Thinking level the run was spawned with (unset = pi's global default). */
  currentThinking: string | undefined;
  /** Pending override picked in this view; shown instead of currentModel. */
  override: SubagentModelOverride | undefined;
  onChange: (next: SubagentModelOverride | undefined) => void;
}) {
  const t = useT();
  const host = useAppStore((s) => s.host);
  const [open, setOpen] = useState(false);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [models, setModels] = useState<ModelSummary[] | null>(null);
  const [defaultThinkingLevel, setDefaultThinkingLevel] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const thinkingOpenRef = useRef(false);
  thinkingOpenRef.current = thinkingOpen;
  /** Catalog cache key (host identity); refetched after a Host restart. */
  const loadedForKey = useRef<string | null>(null);

  const disabled = !host;

  // Load the model catalog on first open. The freshness guard only tracks
  // the Host instance — never the main session's revision (see the doc
  // comment above). A failed load clears the cache key so reopening retries.
  useEffect(() => {
    if (!open || !host) return;
    const cacheKey = host.hostInstanceId;
    if (loadedForKey.current === cacheKey && models) return;
    let cancelled = false;
    const isCurrent = () =>
      !cancelled && useAppStore.getState().host?.hostInstanceId === host.hostInstanceId;
    setLoading(true);
    setListError(null);
    loadedForKey.current = cacheKey;
    void (async () => {
      let res;
      try {
        res = await requestWithRetry(
          () => hostClient.request("piSettings.get", hostContext(host), null),
          undefined,
          isCurrent,
        );
      } catch {
        return;
      }
      if (!isCurrent()) return;
      setLoading(false);
      if (res?.ok) {
        setModels(Array.isArray(res.result.models) ? res.result.models : []);
        if (typeof res.result.defaultThinkingLevel === "string") {
          setDefaultThinkingLevel(res.result.defaultThinkingLevel);
        }
      } else if (res) {
        loadedForKey.current = null;
        setListError(localizeHostError(res.error, t));
      }
    })();
    return () => {
      cancelled = true;
    };
    // `models` is intentionally not a dependency: the cache key guards reloads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, host, t]);

  // Close on outside pointerdown / Escape — same pattern as SubagentTitleMenu.
  // Escape dismisses the nested thinking submenu first, the menu itself second.
  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (thinkingOpenRef.current) {
        setThinkingOpen(false);
        return;
      }
      setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  // Reset the nested submenu whenever the model menu itself closes.
  useEffect(() => {
    if (!open && thinkingOpen) setThinkingOpen(false);
  }, [open, thinkingOpen]);

  const modelOptions = models ?? [];
  const groups = modelOptions.reduce<{ provider: string; label: string; models: ModelSummary[] }[]>(
    (result, model) => {
      const label = model.providerName || model.provider;
      const group = result.find((candidate) => candidate.provider === model.provider);
      if (group) group.models.push(model);
      else result.push({ provider: model.provider, label, models: [model] });
      return result;
    },
    [],
  );

  const activeKey = override?.model ?? currentModel;
  const activeModel = modelOptions.find(
    (model) => `${model.provider}/${model.modelId}` === activeKey,
  );
  const activeLabel = activeKey ? modelKeyLabel(modelOptions, activeKey) : t("modelNone");
  const pendingThinking = override?.thinking;
  /** What the run will actually think at: the pending override when set,
   *  otherwise the level the run was spawned with, otherwise pi's global
   *  default thinking level (the child uses it whenever the spawn omits
   *  --thinking). Shown on the trigger and the footer row. */
  const effectiveThinking = pendingThinking ?? currentThinking ?? defaultThinkingLevel;
  const thinkingLevels = activeModel?.thinkingLevels ?? [];
  const thinkingDisabled = loading || Boolean(listError) || thinkingLevels.length === 0;

  /** Selecting a different model keeps the pending thinking level only when
   *  the new model supports it; otherwise the plugin default applies. */
  function selectModel(key: string) {
    const levels = modelOptions.find(
      (model) => `${model.provider}/${model.modelId}` === key,
    )?.thinkingLevels;
    const keepThinking =
      pendingThinking !== undefined && levels !== undefined && levels.includes(pendingThinking);
    setThinkingOpen(false);
    onChange({ model: key, ...(keepThinking ? { thinking: pendingThinking } : {}) });
  }

  // Center the selected row when the menu opens.
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const selected = panel?.querySelector<HTMLElement>(
      '[role="menuitemradio"][aria-checked="true"]',
    );
    if (!panel || !selected) return;
    const panelRect = panel.getBoundingClientRect();
    const selectedRect = selected.getBoundingClientRect();
    const offsetInView = selectedRect.top - panelRect.top + panel.scrollTop;
    panel.scrollTop = Math.max(0, offsetInView - panel.clientHeight / 2 + selectedRect.height / 2);
  }, [open, activeKey, modelOptions.length]);

  return (
    <div ref={menuRef} className="relative flex h-7 min-w-0 max-w-[240px] items-center">
      <button
        type="button"
        className="composer-control flex h-7 min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-md border border-border-subtle px-1.5 text-xs text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:cursor-default disabled:opacity-40"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("subagentsModelPicker")}
        title={activeKey ?? undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="truncate leading-none">{activeLabel}</span>
        {effectiveThinking !== undefined && (
          <span className="shrink-0 whitespace-nowrap leading-none text-foreground/70">
            {thinkingLevelLabel(effectiveThinking)}
          </span>
        )}
        <ChevronDown
          className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          size={13}
        />
      </button>
      {open && (
        <div className="absolute bottom-full right-0 z-50 mb-2 w-64">
          <div className="theme-floating-surface w-full rounded-md border border-border bg-surface-raised shadow-lg">
            <div
              ref={panelRef}
              className="max-h-80 w-full overflow-y-auto rounded-t-md py-0.5"
              role="menu"
              aria-label={t("modelMenuLabel")}
            >
              {loading ? (
                <p className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-muted">
                  <LoaderCircle size={13} className="animate-spin" aria-hidden="true" />
                  {t("modelListLoading")}
                </p>
              ) : listError ? (
                <p className="px-2 py-1.5 text-xs text-danger">{listError}</p>
              ) : groups.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-muted">{t("modelNoneEnabled")}</p>
              ) : (
                groups.map((group) => (
                  <div key={group.provider}>
                    <div className="flex h-7 items-center px-2.5 pt-1 text-xs font-medium text-foreground">
                      {group.label}
                    </div>
                    {group.models.map((model) => {
                      const key = `${model.provider}/${model.modelId}`;
                      const selected = key === activeKey;
                      return (
                        <button
                          key={key}
                          type="button"
                          role="menuitemradio"
                          aria-checked={selected}
                          className={`flex h-8 w-full items-center gap-1.5 pl-2.5 pr-2 text-left text-xs text-muted hover:bg-surface-overlay hover:text-foreground ${
                            selected ? "font-medium" : ""
                          }`}
                          title={`${group.label}/${model.name || model.modelId}`}
                          onClick={() => {
                            if (selected) {
                              setOpen(false);
                              return;
                            }
                            selectModel(key);
                            setOpen(false);
                          }}
                        >
                          <span className="min-w-0 flex-1 truncate">
                            {model.name || model.modelId}
                          </span>
                          {selected && (
                            <span className="flex shrink-0 items-center justify-center text-foreground">
                              <Check size={16} strokeWidth={2.5} />
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
            {/* Fixed thinking-depth entry pinned below the scrolling model
                list; clicking it opens the nested level submenu — same
                interaction as the main composer's ModelControls. */}
            <div className="relative">
              {thinkingOpen && (
                <div
                  className="theme-floating-surface absolute bottom-full right-0 z-10 mb-1 min-w-[150px] rounded-md border border-border bg-surface-raised py-1 shadow-lg"
                  role="menu"
                  aria-label={t("modelThinkingDepth")}
                >
                  {/* "Default" clears the pending level; the plugin then
                      spawns with its own default for the model. */}
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={pendingThinking === undefined}
                    className="flex h-8 w-full items-center gap-1.5 whitespace-nowrap px-2.5 text-left text-[11px] text-muted hover:bg-surface-overlay hover:text-foreground"
                    onClick={() => {
                      setThinkingOpen(false);
                      onChange(
                        override?.model !== undefined ? { model: override.model } : undefined,
                      );
                    }}
                  >
                    {t("subagentsThinkingDefault")}
                    {pendingThinking === undefined && (
                      <span className="ml-auto flex shrink-0 items-center justify-center">
                        <Check size={16} strokeWidth={2.5} />
                      </span>
                    )}
                  </button>
                  {thinkingLevels.map((level) => {
                    const active = level === pendingThinking;
                    return (
                      <button
                        key={level}
                        type="button"
                        className={`flex h-8 w-full items-center gap-1.5 whitespace-nowrap px-2.5 text-left text-[11px] capitalize text-muted hover:bg-surface-overlay hover:text-foreground ${
                          active ? "font-medium" : ""
                        }`}
                        role="menuitemradio"
                        aria-checked={active}
                        onClick={() => {
                          setThinkingOpen(false);
                          onChange({
                            ...(override?.model !== undefined ? { model: override.model } : {}),
                            thinking: level,
                          });
                        }}
                      >
                        {thinkingLevelLabel(level)}
                        {active && (
                          <span className="ml-auto flex shrink-0 items-center justify-center">
                            <Check size={16} strokeWidth={2.5} />
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
              <button
                type="button"
                className="flex h-8 w-full items-center gap-1.5 rounded-b-md border-t border-border px-2.5 text-left text-xs text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:cursor-default disabled:opacity-40"
                disabled={thinkingDisabled}
                aria-haspopup="menu"
                aria-expanded={thinkingOpen}
                title={t("modelThinkingDepth")}
                onClick={() => setThinkingOpen((value) => !value)}
              >
                <Brain size={13} className="shrink-0" />
                <span className="whitespace-nowrap">{t("modelThinkingDepth")}</span>
                <span className="ml-auto flex shrink-0 items-center gap-1">
                  <span className="whitespace-nowrap capitalize text-foreground">
                    {effectiveThinking !== undefined ? thinkingLevelLabel(effectiveThinking) : "—"}
                  </span>
                  <ChevronRight
                    size={13}
                    className={`shrink-0 transition-transform ${thinkingOpen ? "rotate-90" : ""}`}
                  />
                </span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Display name for a `provider/id` model string, resolved against the
 * fetched catalog; falls back to the id segment when the catalog has not
 * loaded or the model is unknown. */
function modelKeyLabel(models: readonly ModelSummary[], key: string): string {
  const found = models.find((model) => `${model.provider}/${model.modelId}` === key);
  if (found) return found.name || found.modelId;
  const slash = key.lastIndexOf("/");
  return slash >= 0 ? key.slice(slash + 1) : key;
}
