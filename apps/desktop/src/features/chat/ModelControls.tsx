import { Brain, Check, ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ModelSummary, SessionContextBreakdown } from "@piabyss/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { hostErrorLevel, localizeHostError } from "../../lib/bridge/localize-host-error";
import {
  activeSessionContext,
  captureRequestGeneration,
  isCurrentRequestGeneration,
} from "../../lib/bridge/host-context";
import { formatTokenCount } from "../../lib/format-token-count";
import { requestWithRetry } from "../../lib/bridge/request-retry";
import { requestCompact, setAutoCompaction } from "./compaction-actions";
import { Switch } from "../../components/Switch";
import { useT } from "../../lib/i18n/use-t";

const MODEL_MENU_MIN_WIDTH = 120;
const MODEL_MENU_DEFAULT_MAX_WIDTH = 640;
const MODEL_MENU_MAX_WIDTH = 640;
const MODEL_MENU_ROW_CONTROLS_WIDTH = 96;
const MODEL_MENU_VIEWPORT_GUTTER = 12;
const CONTEXT_POPOVER_CENTER_MAX_WIDTH = 560;

/** Frozen empty map shared for clearing the store's `providerNames`. */
const EMPTY_PROVIDER_NAMES: ReadonlyMap<string, string> = new Map<string, string>();

/** Build a provider id -> display name map from the model catalog. The catalog
 *  carries `providerName` per model (e.g. "天机阁"), so the historical
 *  `model_change` transcript rows can render the Provider name instead of the
 *  raw service id (e.g. "8"). */
function buildProviderNames(models: readonly ModelSummary[]): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const model of models) {
    const label = model.providerName || model.provider;
    if (!names.has(model.provider)) names.set(model.provider, label);
  }
  return names;
}

function subscribeToViewportWidth(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

function getViewportWidth(): number {
  return window.innerWidth;
}
const CONTEXT_BREAKDOWN_KEYS = [
  "systemPrompt",
  "toolDefinitions",
  "userPrompts",
  "assistantMessages",
  "toolResults",
  "summaries",
  "other",
] as const satisfies readonly (keyof SessionContextBreakdown)[];

function estimatedContextTokens(breakdown: SessionContextBreakdown | undefined): number | null {
  if (!breakdown) return null;
  return CONTEXT_BREAKDOWN_KEYS.reduce((sum, key) => sum + breakdown[key], 0);
}

export function modelMenuMaxWidth(menuLeft: number, boundaryRight: number): number {
  const boundaryLimit = boundaryRight - Math.max(0, menuLeft) - MODEL_MENU_VIEWPORT_GUTTER;
  return Math.max(MODEL_MENU_MIN_WIDTH, Math.min(MODEL_MENU_MAX_WIDTH, boundaryLimit));
}

export function modelMenuPlacement(args: {
  menuLeft: number;
  menuRight: number;
  boundaryLeft: number;
  boundaryRight: number;
  menuWidth: number;
}): { alignRight: boolean; availableWidth: number } {
  const spaceRight = args.boundaryRight - args.menuLeft - MODEL_MENU_VIEWPORT_GUTTER;
  const spaceLeft = args.menuRight - args.boundaryLeft - MODEL_MENU_VIEWPORT_GUTTER;
  const alignRight = args.menuWidth > spaceRight && spaceLeft >= spaceRight;
  return {
    alignRight,
    availableWidth: Math.max(MODEL_MENU_MIN_WIDTH, alignRight ? spaceLeft : spaceRight),
  };
}

export function clampModelMenuWidth(
  width: number,
  menuLeft: number,
  viewportWidth: number,
): number {
  return Math.min(
    modelMenuMaxWidth(menuLeft, viewportWidth),
    Math.max(MODEL_MENU_MIN_WIDTH, Math.round(width)),
  );
}

/** Backwards-compatible alias; the shared helper lives in lib/bridge. */
export { requestWithRetry as requestModelListWithRetry } from "../../lib/bridge/request-retry";

export function includeCurrentModel(
  models: ModelSummary[],
  current: ModelSummary | undefined,
  enabledProviders?: string[],
): ModelSummary[] {
  if (!current) return models;
  if (enabledProviders && !enabledProviders.includes(current.provider)) return models;
  const currentKey = `${current.provider}/${current.modelId}`;
  return models.some((model) => `${model.provider}/${model.modelId}` === currentKey)
    ? models
    : [current, ...models];
}

export function thinkingLevelsForModel(
  models: ModelSummary[],
  current: ModelSummary | undefined,
  fallback: string[],
): string[] {
  if (!current) return fallback;
  const selected = models.find(
    (model) => model.provider === current.provider && model.modelId === current.modelId,
  );
  return selected?.thinkingLevels ?? fallback;
}

/** Thinking levels for the session's current model. The session summary is
 *  preferred; when it omits levels (e.g. right after a rehydrate round-trip),
 *  the model-catalog entry for the same model fills in. */
export function resolveThinkingLevels(
  current: ModelSummary | undefined,
  models: ModelSummary[],
): string[] {
  if (current?.thinkingLevels?.length) return current.thinkingLevels;
  if (!current) return [];
  const catalogModel = models.find(
    (model) => model.provider === current.provider && model.modelId === current.modelId,
  );
  return catalogModel?.thinkingLevels ?? [];
}

export function modelOptionLabel(model: ModelSummary): string {
  const providerLabel = model.providerName || model.provider;
  return `${providerLabel}/${model.name || model.modelId}`;
}

/** Label for the session's current model, preferring the Provider display name
 *  from the fetched model catalog when the snapshot summary lacks it. */
export function currentModelLabel(
  model: ModelSummary | undefined,
  models: ModelSummary[],
  fallback: string,
): string {
  if (!model) return fallback;
  const catalogModel = models.find(
    (candidate) => candidate.provider === model.provider && candidate.modelId === model.modelId,
  );
  return modelOptionLabel(catalogModel ?? model);
}

/** Visible name for the current-model button: the model name alone, without
 *  the Provider prefix. The Provider is surfaced by the menu's group headers
 *  and by the button's tooltip, which keeps the full `Provider/name` label. */
function currentModelDisplayName(
  model: ModelSummary | undefined,
  models: ModelSummary[],
  fallback: string,
): string {
  if (!model) return fallback;
  const catalogModel = models.find(
    (candidate) => candidate.provider === model.provider && candidate.modelId === model.modelId,
  );
  const resolved = catalogModel ?? model;
  return resolved.name || resolved.modelId;
}

export function thinkingLevelLabel(level: string): string {
  const labels = {
    off: "Off",
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra high",
  } as const;
  return level in labels ? labels[level as keyof typeof labels] : level;
}

export function canRequestModelList(args: {
  hasHost: boolean;
  hasWorkspace: boolean;
  hasSession: boolean;
  connecting: boolean;
  rehydrating: boolean;
  desynchronized: boolean;
}): boolean {
  return (
    args.hasHost &&
    args.hasWorkspace &&
    args.hasSession &&
    !args.connecting &&
    !args.rehydrating &&
    !args.desynchronized
  );
}

export function ContextUsageRing() {
  const t = useT();
  const session = useAppStore((s) => s.session);
  const viewportWidth = useSyncExternalStore(
    subscribeToViewportWidth,
    getViewportWidth,
    getViewportWidth,
  );
  const centerPopover = viewportWidth <= CONTEXT_POPOVER_CENTER_MAX_WIDTH;
  const contextUsage = session?.contextUsage;
  const breakdown = contextUsage?.breakdown;
  const estimatedTokens = contextUsage?.tokens === null ? estimatedContextTokens(breakdown) : null;
  const displayTokens = contextUsage?.tokens ?? estimatedTokens;
  const isEstimated = contextUsage?.tokens === null && estimatedTokens !== null;
  const [open, setOpen] = useState(false);
  const [compactPending, setCompactPending] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);
  const percent =
    displayTokens === null || !contextUsage
      ? null
      : Math.min(100, Math.max(0, (displayTokens / contextUsage.contextWindow) * 100));
  const roundedPercent = percent === null ? null : Math.round(percent);
  const title = contextUsage
    ? displayTokens === null
      ? t("contextUsageUnknown", { window: formatTokenCount(contextUsage.contextWindow) })
      : t(isEstimated ? "contextUsageEstimated" : "contextUsageValue", {
          used: formatTokenCount(displayTokens),
          window: formatTokenCount(contextUsage.contextWindow),
        })
    : t("contextUnavailable");
  const autoCompactionEnabled = session?.autoCompactionEnabled ?? false;

  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
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

  async function compactNow() {
    setCompactPending(true);
    try {
      await requestCompact();
    } finally {
      setCompactPending(false);
    }
  }

  return (
    <span ref={containerRef} className="relative flex shrink-0 items-center">
      <button
        type="button"
        className="relative flex size-[18px] shrink-0 items-center justify-center rounded-full"
        style={{
          background: `conic-gradient(var(--color-accent) ${
            percent === null ? 0 : percent * 3.6
          }deg, var(--color-border) 0deg)`,
        }}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="absolute inset-2 rounded-full bg-surface-raised" />
        <span className="relative text-[6px] tabular-nums text-muted">
          {roundedPercent === null ? "--" : `${isEstimated ? "~" : ""}${roundedPercent}%`}
        </span>
      </button>
      {open && (
        <div
          className={`theme-floating-surface absolute bottom-full z-50 mb-2 flex w-64 flex-col rounded-md border border-border bg-surface-raised p-3 text-left text-[11px] leading-4 text-foreground shadow-lg ${
            centerPopover ? "left-1/2 -translate-x-1/2" : "left-0"
          }`}
        >
          <span className="font-medium">{t("contextUsageTitle")}</span>
          <span className="mt-0.5 tabular-nums text-muted">{title}</span>
          {breakdown && (
            <>
              <span className="my-2 h-px bg-border" />
              <span className="mb-1 text-[10px] font-medium uppercase text-muted">
                {t("contextEstimatedComposition")}
              </span>
              <span className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
                <span className="text-muted">{t("contextSystemPrompt")}</span>
                <span className="tabular-nums">~{formatTokenCount(breakdown.systemPrompt)}</span>
                <span className="text-muted">{t("contextToolDefinitions")}</span>
                <span className="tabular-nums">~{formatTokenCount(breakdown.toolDefinitions)}</span>
                <span className="text-muted">{t("contextUserPrompts")}</span>
                <span className="tabular-nums">~{formatTokenCount(breakdown.userPrompts)}</span>
                <span className="text-muted">{t("contextAssistant")}</span>
                <span className="tabular-nums">
                  ~{formatTokenCount(breakdown.assistantMessages)}
                </span>
                <span className="text-muted">{t("contextToolResults")}</span>
                <span className="tabular-nums">~{formatTokenCount(breakdown.toolResults)}</span>
                <span className="text-muted">{t("contextSummaries")}</span>
                <span className="tabular-nums">~{formatTokenCount(breakdown.summaries)}</span>
                <span className="text-muted">{t("contextOtherFraming")}</span>
                <span className="tabular-nums">~{formatTokenCount(breakdown.other)}</span>
              </span>
              <span className="mt-2 text-[10px] text-muted">
                {t(isEstimated ? "contextEstimatePendingNote" : "contextEstimateNote")}
              </span>
            </>
          )}
          <span className="my-2 h-px bg-border" />
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted">{t("contextAutoCompaction")}</span>
            <Switch
              checked={autoCompactionEnabled}
              label={t("contextToggleAutoCompaction")}
              disabled={!session}
              onChange={() => session && void setAutoCompaction(!session.autoCompactionEnabled)}
            />
          </div>
          <button
            type="button"
            className="mt-2 flex h-7 items-center justify-center rounded-md border border-border bg-surface px-2 font-medium transition-colors hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-40"
            disabled={compactPending || !session?.isIdle}
            onClick={() => void compactNow()}
          >
            {session?.isCompacting ? t("contextCompacting") : t("contextCompactNow")}
          </button>
        </div>
      )}
    </span>
  );
}

/** Model menu and context indicator for the composer's bottom bar. */
export function ModelControls() {
  const t = useT();
  const host = useAppStore((s) => s.host);
  const workspace = useAppStore((s) => s.workspace);
  const session = useAppStore((s) => s.session);
  const setSession = useAppStore((s) => s.applySessionSnapshot);
  const providerConfigRevision = useAppStore((s) => s.providerConfigRevision);
  const connecting = useAppStore((s) => s.connecting);
  const rehydrating = useAppStore((s) => s.rehydrating);
  const desynchronized = useAppStore((s) => s.desynchronized);
  const setThinkingLevels = useAppStore((s) => s.setThinkingLevels);
  const setProviderNames = useAppStore((s) => s.setProviderNames);
  const pushNotification = useAppStore((s) => s.pushNotification);
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [enabledProviders, setEnabledProviders] = useState<string[] | undefined>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [modelMenuWidth, setModelMenuWidth] = useState(MODEL_MENU_MIN_WIDTH);
  const [modelMenuAlignRight, setModelMenuAlignRight] = useState(false);
  const modelMenuWidthRef = useRef(modelMenuWidth);
  modelMenuWidthRef.current = modelMenuWidth;
  const thinkingOpenRef = useRef(false);
  thinkingOpenRef.current = thinkingOpen;
  const listRequest = useRef(0);
  const menuRef = useRef<HTMLDivElement>(null);
  const modelMenuMeasureRef = useRef<HTMLSpanElement>(null);
  const modelMenuPanelRef = useRef<HTMLDivElement>(null);
  const hostInstanceId = host?.hostInstanceId;
  const workspaceId = workspace?.id;
  const workspaceRevision = workspace?.revision;
  const sessionId = session?.sessionId;
  const sessionRevision = session?.revision;

  useEffect(() => {
    const current = useAppStore.getState();
    const requestHost = current.host;
    const requestWorkspace = current.workspace;
    const requestSession = current.session;
    if (
      !requestHost ||
      !requestWorkspace ||
      !requestSession ||
      requestHost.hostInstanceId !== hostInstanceId ||
      requestWorkspace.id !== workspaceId ||
      requestWorkspace.revision !== workspaceRevision ||
      requestSession.sessionId !== sessionId ||
      requestSession.revision !== sessionRevision ||
      !canRequestModelList({
        hasHost: hostInstanceId !== undefined,
        hasWorkspace: workspaceId !== undefined,
        hasSession: sessionId !== undefined,
        connecting,
        rehydrating,
        desynchronized,
      })
    ) {
      listRequest.current += 1;
      setModels([]);
      setEnabledProviders(undefined);
      setProviderNames(EMPTY_PROVIDER_NAMES);
      return;
    }
    let cancelled = false;
    const request = ++listRequest.current;
    const expectedHostId = requestHost.hostInstanceId;
    const expectedWorkspaceId = requestWorkspace.id;
    const expectedWorkspaceRevision = requestWorkspace.revision;
    const expectedSessionId = requestSession.sessionId;
    const expectedSessionRevision = requestSession.revision;
    const isCurrentRequest = () => {
      const current = useAppStore.getState();
      return (
        !cancelled &&
        request === listRequest.current &&
        current.host?.hostInstanceId === expectedHostId &&
        current.workspace?.id === expectedWorkspaceId &&
        current.workspace?.revision === expectedWorkspaceRevision &&
        current.session?.sessionId === expectedSessionId &&
        current.session?.revision === expectedSessionRevision
      );
    };
    void (async () => {
      let res;
      try {
        res = await requestWithRetry(
          () =>
            hostClient.request(
              "model.list",
              activeSessionContext(requestHost, requestWorkspace, requestSession),
              null,
            ),
          undefined,
          isCurrentRequest,
        );
      } catch {
        return;
      }
      if (!res || !isCurrentRequest()) return;
      const current = useAppStore.getState();
      if (res.ok) {
        setModels(res.result.models);
        setEnabledProviders(res.result.enabledProviders);
        setThinkingLevels(res.result.thinkingLevels);
        setProviderNames(buildProviderNames(res.result.models));
        if (res.result.current) {
          const latestSession = current.session;
          const selected = latestSession?.model;
          if (
            latestSession &&
            selected &&
            (selected.provider !== res.result.current.provider ||
              selected.modelId !== res.result.current.modelId ||
              !selected.providerName)
          ) {
            current.applySessionSnapshot({
              ...latestSession,
              model: {
                ...res.result.current,
                // Older hosts summarize `current` without per-model thinking
                // levels; keep the session's own rather than dropping them.
                thinkingLevels:
                  res.result.current.thinkingLevels &&
                  res.result.current.thinkingLevels.length > 0
                    ? res.result.current.thinkingLevels
                    : (selected.thinkingLevels ?? []),
              },
            });
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    hostInstanceId,
    workspaceId,
    workspaceRevision,
    sessionId,
    sessionRevision,
    providerConfigRevision,
    connecting,
    rehydrating,
    desynchronized,
    setThinkingLevels,
    setProviderNames,
  ]);

  const modelOptions = includeCurrentModel(models, session?.model, enabledProviders);
  const modelGroups = modelOptions.reduce<
    { provider: string; label: string; models: ModelSummary[] }[]
  >((groups, model) => {
    const label = model.providerName || model.provider;
    const group = groups.find((candidate) => candidate.provider === model.provider);
    if (group) group.models.push(model);
    else groups.push({ provider: model.provider, label, models: [model] });
    return groups;
  }, []);
  const activeModelLabel = currentModelLabel(session?.model, models, "");
  const activeModelDisplayName = currentModelDisplayName(session?.model, models, "");
  const selectedModelKey = session?.model
    ? `${session.model.provider}/${session.model.modelId}`
    : "";
  const modelMenuLabels =
    modelOptions.length > 0
      ? [
          ...modelGroups.map((group) => group.label),
          ...modelOptions.map((model) => model.name || model.modelId),
        ]
      : [t("modelNoneEnabled")];
  const modelMenuMeasureKey = modelMenuLabels.join("\n");

  const thinkingLevels = resolveThinkingLevels(session?.model, models);
  const currentThinkingLevel = session?.thinkingLevel ?? "";
  const thinkingDisabled = !session || thinkingLevels.length === 0;
  const thinkingMenuLabel = session?.model
    ? t("modelThinkingFor", { model: modelOptionLabel(session.model) })
    : t("modelThinkingDepth");

  // Menu width tracks the widest model name so the floated dropdown always
  // fits its contents — no manual drag handle.
  useLayoutEffect(() => {
    const contentWidth = modelMenuMeasureRef.current?.scrollWidth;
    if (contentWidth === undefined) return;
    const nextWidth = Math.min(
      MODEL_MENU_DEFAULT_MAX_WIDTH,
      Math.max(MODEL_MENU_MIN_WIDTH, Math.ceil(contentWidth) + MODEL_MENU_ROW_CONTROLS_WIDTH),
    );
    setModelMenuWidth((current) => (current === nextWidth ? current : nextWidth));
  }, [modelMenuMeasureKey, menuOpen]);

  // Keep the floated dropdown inside the conversation area. The right Dock is
  // a sibling of the chat page, so the window width includes space the menu
  // must not occupy while the Dock is open.
  useLayoutEffect(() => {
    if (!menuOpen) return;
    const clampToConversation = () => {
      const parentEl = menuRef.current;
      if (!parentEl) return;
      const parentRect = parentEl.getBoundingClientRect();
      const conversationEl = parentEl.closest<HTMLElement>("[data-chat-page]");
      const conversationRect = conversationEl?.getBoundingClientRect();
      const boundaryLeft = conversationRect?.left ?? 0;
      const boundaryRight = conversationRect?.right ?? window.innerWidth;
      const measuredContentWidth = modelMenuMeasureRef.current?.scrollWidth;
      const naturalWidth =
        measuredContentWidth === undefined
          ? modelMenuWidthRef.current
          : Math.min(
              MODEL_MENU_DEFAULT_MAX_WIDTH,
              Math.max(
                MODEL_MENU_MIN_WIDTH,
                Math.ceil(measuredContentWidth) + MODEL_MENU_ROW_CONTROLS_WIDTH,
              ),
            );
      const placement = modelMenuPlacement({
        menuLeft: parentRect.left,
        menuRight: parentRect.right,
        boundaryLeft,
        boundaryRight,
        menuWidth: naturalWidth,
      });
      setModelMenuAlignRight(placement.alignRight);
      setModelMenuWidth((prev) => {
        const next = Math.min(naturalWidth, placement.availableWidth);
        return prev === next ? prev : next;
      });
    };
    clampToConversation();
    window.addEventListener("resize", clampToConversation);
    const conversationEl = menuRef.current?.closest<HTMLElement>("[data-chat-page]");
    const resizeObserver =
      conversationEl && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(clampToConversation)
        : null;
    if (conversationEl) resizeObserver?.observe(conversationEl);
    return () => {
      window.removeEventListener("resize", clampToConversation);
      resizeObserver?.disconnect();
    };
  }, [menuOpen, modelMenuMeasureKey]);

  // Center the selected model in the dropdown viewport when the menu opens so
  // long catalogs don't require scrolling around to find the current model.
  // Re-runs when the catalog arrives after the menu is already open. Only the
  // panel's own scrollTop is touched — ancestors must not scroll.
  useLayoutEffect(() => {
    if (!menuOpen) return;
    const panel = modelMenuPanelRef.current;
    const selected = panel?.querySelector<HTMLElement>(
      '[role="menuitemradio"][aria-checked="true"]',
    );
    if (!panel || !selected) return;
    const panelRect = panel.getBoundingClientRect();
    const selectedRect = selected.getBoundingClientRect();
    const offsetInView = selectedRect.top - panelRect.top + panel.scrollTop;
    const target = offsetInView - panel.clientHeight / 2 + selectedRect.height / 2;
    panel.scrollTop = Math.max(0, target);
  }, [menuOpen, selectedModelKey, modelOptions.length]);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // The nested thinking-depth submenu closes first; a second press
        // dismisses the model menu itself.
        if (thinkingOpenRef.current) {
          setThinkingOpen(false);
          return;
        }
        setMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  // Reset the nested submenu whenever the model menu itself closes.
  useEffect(() => {
    if (!menuOpen && thinkingOpen) setThinkingOpen(false);
  }, [menuOpen, thinkingOpen]);

  async function setModel(provider: string, modelId: string): Promise<boolean> {
    if (!host || !workspace || !session) return false;
    const res = await hostClient.request(
      "model.setCurrent",
      activeSessionContext(host, workspace, session),
      { provider, modelId },
    );
    const current = useAppStore.getState();
    if (
      current.host?.hostInstanceId !== host.hostInstanceId ||
      current.workspace?.id !== workspace.id ||
      current.workspace?.revision !== workspace.revision ||
      current.session?.sessionId !== session.sessionId ||
      current.session?.revision !== session.revision
    ) {
      return false;
    }
    if (res.ok) {
      setSession(res.result.session);
      setThinkingLevels(res.result.thinkingLevels);
      return true;
    }
    pushNotification(localizeHostError(res.error, t), hostErrorLevel(res.error));
    return false;
  }

  async function setThinkingLevel(level: string): Promise<void> {
    if (!host || !workspace || !session) return;
    const generation = captureRequestGeneration(host);
    const res = await hostClient.request(
      "model.setThinkingLevel",
      activeSessionContext(host, workspace, session),
      { level },
    );
    if (!isCurrentRequestGeneration(useAppStore.getState().host, generation, { session: true })) {
      return;
    }
    if (res.ok) {
      setSession(res.result);
      setThinkingOpen(false);
      return;
    }
    pushNotification(localizeHostError(res.error, t), hostErrorLevel(res.error));
  }

  return (
    <div className="flex min-w-0 items-center">
      <div ref={menuRef} className="relative flex h-7 min-w-0 max-w-[480px] items-center">
        <span
          ref={modelMenuMeasureRef}
          aria-hidden="true"
          className="pointer-events-none invisible absolute flex w-max flex-col whitespace-nowrap text-xs"
        >
          {modelMenuLabels.map((label, index) => (
            <span key={`${index}:${label}`}>{label}</span>
          ))}
        </span>
        <button
          type="button"
          className="composer-control flex h-7 min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-md border border-border-subtle px-1.5 text-xs text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:cursor-default disabled:opacity-40"
          disabled={!session}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title={activeModelLabel || t("modelSelect")}
          onClick={() => {
            setMenuOpen((open) => !open);
          }}
        >
          <span className="truncate leading-none">{activeModelDisplayName || t("modelNone")}</span>
          <ChevronDown
            className={`shrink-0 transition-transform ${menuOpen ? "rotate-180" : ""}`}
            size={13}
          />
        </button>
        {menuOpen && (
          <div
            className={`absolute bottom-full z-50 mb-2 min-w-[120px] ${
              modelMenuAlignRight ? "right-0" : "left-0"
            }`}
            style={{ width: modelMenuWidth }}
          >
            <div className="theme-floating-surface w-full rounded-md border border-border bg-surface-raised shadow-lg">
              <div
                ref={modelMenuPanelRef}
                className="max-h-80 w-full overflow-y-auto rounded-t-md py-0.5"
                role="menu"
                aria-label={t("modelMenuLabel")}
              >
                {modelOptions.length === 0 ? (
                  <p className="px-2 py-1.5 text-xs text-muted">{t("modelNoneEnabled")}</p>
                ) : (
                  modelGroups.map((group) => (
                    <div key={group.provider}>
                      <div className="flex h-7 items-center px-2.5 pt-1 text-xs font-medium text-foreground">
                        {group.label}
                      </div>
                      {group.models.map((model) => {
                        const key = `${model.provider}/${model.modelId}`;
                        const selected =
                          session?.model?.provider === model.provider &&
                          session.model.modelId === model.modelId;
                        return (
                          <button
                            key={key}
                            type="button"
                            className={`flex h-8 w-full items-center gap-1.5 px-2.5 text-left text-xs text-muted ${
                              selected ? "font-medium" : ""
                            }`}
                            role="menuitemradio"
                            aria-checked={selected}
                            title={modelOptionLabel(model)}
                            onClick={() => {
                              if (selected) {
                                setMenuOpen(false);
                                return;
                              }
                              void setModel(model.provider, model.modelId).then((changed) => {
                                if (changed) setMenuOpen(false);
                              });
                            }}
                          >
                            <span className="whitespace-nowrap">{model.name || model.modelId}</span>
                            {selected && (
                              <span className="ml-auto flex shrink-0 items-center justify-center">
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
                  list; clicking it opens the nested level submenu. */}
              <div className="relative">
                {thinkingOpen && (
                  <div
                    className="theme-floating-surface absolute bottom-full right-0 z-10 mb-1 min-w-[150px] rounded-md border border-border bg-surface-raised py-1 shadow-lg"
                    role="menu"
                    aria-label={thinkingMenuLabel}
                  >
                    {thinkingLevels.map((level) => {
                      const active = currentThinkingLevel === level;
                      return (
                        <button
                          key={level}
                          type="button"
                          className={`flex h-8 w-full items-center gap-1.5 whitespace-nowrap px-2.5 text-left text-[11px] capitalize text-muted ${
                            active ? "font-medium" : ""
                          }`}
                          role="menuitemradio"
                          aria-checked={active}
                          onClick={() => void setThinkingLevel(level)}
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
                  title={
                    session?.model
                      ? t("modelThinkingFor", { model: modelOptionLabel(session.model) })
                      : t("modelThinkingDepth")
                  }
                  onClick={() => setThinkingOpen((open) => !open)}
                >
                  <Brain size={13} className="shrink-0" />
                  <span className="whitespace-nowrap">{t("modelThinkingDepth")}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-1">
                    <span className="whitespace-nowrap capitalize text-foreground">
                      {thinkingLevels.length > 0 && currentThinkingLevel
                        ? thinkingLevelLabel(currentThinkingLevel)
                        : "—"}
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
    </div>
  );
}

