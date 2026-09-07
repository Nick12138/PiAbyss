import {
  Activity,
  AlertTriangle,
  Brain,
  Check,
  CircleCheck,
  Copy,
  Eye,
  EyeOff,
  Image as ImageIcon,
  LogIn,
  Plus,
  RefreshCw,
  Save,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DiscoveredProviderModel,
  ProviderConnectionResult,
  ProviderCompatibilityDraft,
  ProviderDraft,
  ProviderSnapshot,
} from "@piabyss/protocol";
import { THINKING_LEVELS } from "@piabyss/protocol";
import { hostClient, isHostEpochError } from "../../lib/bridge/host-client";
import { hostErrorLevel, localizeHostError } from "../../lib/bridge/localize-host-error";
import { hostContext } from "../../lib/bridge/host-context";
import { requestWithRetry } from "../../lib/bridge/request-retry";
import { useAppStore } from "../../lib/stores/app-store";
import { Dialog, secondaryButton } from "../../components/Dialog";
import { Select } from "../../components/Select";
import { Switch } from "../../components/Switch";
import type { MessageKey } from "../../lib/i18n";
import { useT, type Translate } from "../../lib/i18n/use-t";
import { useImeComposition } from "../../lib/use-ime-composition";
import { formatTokenCount } from "../../lib/format-token-count";
import { ProviderLoginPage } from "./ProviderLoginSection";
import {
  automaticThinkingConfig,
  customThinkingMap,
  emptyProviderDraft as emptyDraft,
  enabledProviderCatalog as enabledCatalog,
  newProviderModel,
  nextProviderId,
  providerDraftFingerprint as draftFingerprint,
  providerDraftForSave,
  providerLoadFailureMessage,
  providerSaveFailureMessage,
  providerThinkingMode as thinkingMode,
  providerThinkingSourceLabel as thinkingSourceLabel,
  snapshotToDraft,
  stripProviderModelState as stripEnabled,
  validateProviderDraft,
  type ProviderDraftState as DraftState,
} from "./provider-settings-model";

const API_OPTIONS: Array<{ value: ProviderDraft["api"]; label: string }> = [
  { value: "openai-completions", label: "OpenAI Chat Completions" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
  { value: "google-generative-ai", label: "Google Generative AI" },
];

function NumberField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (next: number) => void;
}) {
  // Keep the raw text while typing; committing on every keystroke would snap
  // a cleared field to the fallback and corrupt the value being entered.
  const [text, setText] = useState(String(value));
  const [committed, setCommitted] = useState(value);
  const skipCommitRef = useRef(false);
  if (value !== committed) {
    // The draft changed underneath us (catalog refetch, host reload): the
    // committed value is the source of truth, stale text must not survive.
    setCommitted(value);
    setText(String(value));
  }
  const commit = () => {
    const parsed = Math.floor(Number(text));
    if (Number.isFinite(parsed) && parsed >= 1) {
      onCommit(parsed);
      setCommitted(parsed);
      setText(String(parsed));
    } else {
      setText(String(value));
    }
  };
  return (
    <label className="flex flex-col gap-1 text-[11px] text-muted">
      {label}
      <input
        type="number"
        min={1}
        className="h-8 rounded-md border border-border bg-surface px-2 text-xs text-foreground outline-none focus:border-focus"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          if (skipCommitRef.current) {
            skipCommitRef.current = false;
            return;
          }
          commit();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") {
            // First Escape resolves the field (revert + leave) and must not
            // bubble on to close the whole Settings overlay.
            event.preventDefault();
            event.stopPropagation();
            skipCommitRef.current = true;
            setText(String(value));
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

function authLabel(t: Translate, provider: ProviderSnapshot | undefined): string {
  if (!provider?.auth.configured) {
    return provider?.auth.label
      ? t("providersKeyAvailableVia", { label: provider.auth.label })
      : t("providersKeyNone");
  }
  return provider.auth.source === "stored" ? t("providersKeyStored") : t("providersKeyConfigured");
}

export function ProvidersSettings() {
  const t = useT();
  const host = useAppStore((state) => state.host);
  const hostInstanceId = host?.hostInstanceId;
  const pushNotification = useAppStore((state) => state.pushNotification);
  const refreshProviderConfig = useAppStore((state) => state.refreshProviderConfig);
  const [providers, setProviders] = useState<ProviderSnapshot[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [catalog, setCatalog] = useState<DiscoveredProviderModel[]>([]);
  const [providerSearch, setProviderSearch] = useState("");
  const [modelSearch, setModelSearch] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [clearApiKey, setClearApiKey] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [testing, setTesting] = useState(false);
  const [connectionResult, setConnectionResult] = useState<ProviderConnectionResult | null>(null);
  const [updatingProviderId, setUpdatingProviderId] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualId, setManualId] = useState("");
  const ime = useImeComposition();
  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const [oauthOpen, setOauthOpen] = useState(false);
  const [pendingSwitch, setPendingSwitch] = useState<
    { kind: "select"; id: string } | { kind: "new" } | { kind: "oauth" } | null
  >(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  // Serialized shape of the draft as loaded/saved; any divergence means unsaved edits.
  const baselineRef = useRef<string | null>(null);
  // Bumped on every draft replacement. In-flight save/fetch/test continuations
  // compare it so a resolved request never writes into a different draft.
  const draftEpochRef = useRef(0);

  const selectedProvider = providers.find((provider) => provider.id === selectedId);
  const setProvidersDirty = useAppStore((state) => state.setProvidersDirty);
  const dirty = useMemo(
    () =>
      draft !== null &&
      (apiKey !== "" || clearApiKey || draftFingerprint(draft) !== baselineRef.current),
    [draft, apiKey, clearApiKey],
  );

  useEffect(() => {
    setProvidersDirty(dirty);
  }, [dirty, setProvidersDirty]);
  useEffect(() => () => setProvidersDirty(false), [setProvidersDirty]);

  useEffect(() => {
    if (!hostInstanceId) {
      setProviders([]);
      setDraft(null);
      setLoading(false);
      setLoadError(null);
      baselineRef.current = null;
      draftEpochRef.current += 1;
      setPendingSwitch(null);
      return;
    }
    const requestHost = useAppStore.getState().host;
    if (!requestHost || requestHost.hostInstanceId !== hostInstanceId) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void requestWithRetry(
      () => hostClient.request("provider.list", hostContext(requestHost), null),
      undefined,
      () => !cancelled,
    )
      .then((response) => {
        if (cancelled || !response) return;
        if (!response.ok) {
          const message = providerLoadFailureMessage(response.error, t("notifProviderLoadFailed"));
          setLoadError(message);
          pushNotification(message, "error");
          return;
        }
        setProviders(response.result.providers);
        // A pending switch confirmation refers to the pre-reload world.
        setPendingSwitch(null);
        if (useAppStore.getState().providersDirty) {
          // Host restarted mid-edit: keep the unsaved draft instead of
          // silently replacing it with the reloaded snapshot.
          return;
        }
        const preferred =
          response.result.providers.find((provider) => provider.id === selectedIdRef.current) ??
          response.result.providers[0];
        if (preferred) {
          const nextDraft = snapshotToDraft(preferred);
          setSelectedId(preferred.id);
          setDraft(nextDraft);
          baselineRef.current = draftFingerprint(nextDraft);
          draftEpochRef.current += 1;
          setCatalog(enabledCatalog(nextDraft.models));
        } else {
          setSelectedId(null);
          setDraft(null);
          baselineRef.current = null;
          draftEpochRef.current += 1;
          setCatalog([]);
        }
      })
      .catch((error) => {
        if (cancelled) return;
        // Host-epoch rejections abort the load with an internal reason
        // string; the user can retry via the reload action once recovery
        // settles, so stay silent instead of leaking it.
        if (isHostEpochError(error)) return;
        const message = error instanceof Error ? error.message : t("notifProviderLoadFailed");
        setLoadError(message);
        pushNotification(message, "error");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [hostInstanceId, loadAttempt, pushNotification, t]);

  const filteredProviders = useMemo(() => {
    const query = providerSearch.trim().toLowerCase();
    if (!query) return providers;
    return providers.filter((provider) =>
      `${provider.name} ${provider.id} ${provider.baseUrl}`.toLowerCase().includes(query),
    );
  }, [providerSearch, providers]);

  const filteredModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    if (!query) return catalog;
    return catalog.filter((model) => `${model.name} ${model.id}`.toLowerCase().includes(query));
  }, [catalog, modelSearch]);

  function selectProvider(provider: ProviderSnapshot) {
    const nextDraft = snapshotToDraft(provider);
    setOauthOpen(false);
    setSelectedId(provider.id);
    setDraft(nextDraft);
    baselineRef.current = draftFingerprint(nextDraft);
    draftEpochRef.current += 1;
    setCatalog(enabledCatalog(nextDraft.models));
    setApiKey("");
    setClearApiKey(false);
    setEditingModelId(null);
    setManualOpen(false);
    setFieldErrors({});
    setConnectionResult(null);
  }

  function startNewProvider() {
    const nextDraft = { ...emptyDraft(), id: nextProviderId(providers.map((p) => p.id)) };
    setOauthOpen(false);
    setSelectedId(null);
    setDraft(nextDraft);
    baselineRef.current = draftFingerprint(nextDraft);
    draftEpochRef.current += 1;
    setCatalog([]);
    setApiKey("");
    setClearApiKey(false);
    setEditingModelId(null);
    setManualOpen(false);
    setFieldErrors({});
    setConnectionResult(null);
  }

  /** Duplicates the current provider (including unsaved edits) into a new
   *  unsaved draft named "<name> copy". The stored API key cannot be copied,
   *  so the copy needs its own key before it can connect. */
  function copyProvider() {
    if (!draft || saving || fetching || testing) return;
    const copiedModels = draft.models.map((model) => ({
      ...model,
      ...(model.thinkingLevelMap
        ? { thinkingLevelMap: { ...model.thinkingLevelMap } }
        : {}),
      input: [...model.input],
    }));
    // Repeated copies keep a single " copy" suffix instead of stacking.
    const baseName = draft.name.trim().replace(/\s+copy$/i, "");
    const nextDraft: DraftState = {
      ...draft,
      id: nextProviderId(providers.map((p) => p.id)),
      originalId: undefined,
      name: `${baseName} copy`,
      headers: { ...draft.headers },
      ...(draft.compat ? { compat: { ...draft.compat } } : {}),
      models: copiedModels,
    };
    setOauthOpen(false);
    setSelectedId(null);
    setDraft(nextDraft);
    baselineRef.current = draftFingerprint(nextDraft);
    draftEpochRef.current += 1;
    setCatalog(enabledCatalog(nextDraft.models));
    setApiKey("");
    setClearApiKey(false);
    setEditingModelId(null);
    setManualOpen(false);
    setFieldErrors({});
    setConnectionResult(null);
  }

  function openOauthLogin() {
    // The OAuth page replaces the draft editor; drop any (non-dirty) draft so
    // closing the page lands back on the neutral hint or a clean selection.
    setSelectedId(null);
    setDraft(null);
    baselineRef.current = null;
    draftEpochRef.current += 1;
    setCatalog([]);
    setApiKey("");
    setClearApiKey(false);
    setEditingModelId(null);
    setManualOpen(false);
    setFieldErrors({});
    setConnectionResult(null);
    setOauthOpen(true);
  }

  function updateDraft(patch: Partial<ProviderDraft>) {
    setConnectionResult(null);
    setFieldErrors((current) => {
      const patched = Object.keys(patch).filter((key) => key in current);
      if (patched.length === 0) return current;
      const next = { ...current };
      for (const key of patched) delete next[key];
      return next;
    });
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }

  function validateUrlField(field: "baseUrl") {
    if (!draft) return;
    const errors = validateProviderDraft(draft);
    setFieldErrors((current) => {
      const next = { ...current };
      if (errors[field]) next[field] = errors[field];
      else delete next[field];
      return next;
    });
  }

  function syncModels(nextCatalog: DiscoveredProviderModel[]) {
    setCatalog(nextCatalog);
    updateDraft({ models: nextCatalog.filter((model) => model.enabled).map(stripEnabled) });
  }

  async function persistDraft(
    options: {
      notify?: boolean;
      includeKeyRemoval?: boolean;
      refreshModelCatalog?: boolean;
    } = {},
  ): Promise<ProviderSnapshot | null> {
    // Implicit saves (before Test/Fetch) must never commit a pending stored-key
    // removal: that deletion is irreversible and belongs to the explicit Save.
    const { notify = true, includeKeyRemoval = true, refreshModelCatalog = true } = options;
    // Fetch/Test persist their own input, but delay waking the hidden chat model
    // list until their follow-up request has released the same graph lock.
    if (!host || !draft || saving) return null;
    const errors = validateProviderDraft(draft);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      pushNotification(t("notifProvidersFixFields"), "error");
      return null;
    }
    const removeStoredKey = clearApiKey && includeKeyRemoval;
    const epoch = draftEpochRef.current;
    setSaving(true);
    try {
      const provider = providerDraftForSave(
        draft,
        providers.some((item) => item.id === draft.originalId && item.compat !== undefined),
      );
      const response = await hostClient.request("provider.save", hostContext(host), {
        ...(draft.originalId ? { originalId: draft.originalId } : {}),
        provider,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(removeStoredKey ? { clearApiKey: true } : {}),
      });
      if (!response.ok) {
        const message = localizeHostError(response.error, t);
        pushNotification(providerSaveFailureMessage(message, provider), "error");
        return null;
      }
      const saved = response.result.provider;
      setProviders((current) =>
        [
          ...current.filter(
            (provider) => provider.id !== draft.originalId && provider.id !== saved.id,
          ),
          saved,
        ].sort((left, right) => left.name.localeCompare(right.name)),
      );
      if (refreshModelCatalog) refreshProviderConfig();
      if (epoch === draftEpochRef.current) {
        // Only touch draft-local state when this is still the same draft the
        // request was made for; the user may have switched providers mid-save.
        setSelectedId(saved.id);
        const savedDraft = snapshotToDraft(saved);
        setDraft(savedDraft);
        baselineRef.current = draftFingerprint(savedDraft);
        setCatalog((current) => {
          const savedIds = new Set(saved.models.map((model) => model.id));
          const savedById = new Map(saved.models.map((model) => [model.id, model]));
          if (current.length === 0) return enabledCatalog(saved.models);
          return current.map((model) => ({
            ...model,
            ...(savedById.get(model.id) ?? {}),
            enabled: savedIds.has(model.id),
          }));
        });
        setApiKey("");
        if (removeStoredKey) setClearApiKey(false);
      }
      if (notify) pushNotification(t("notifProviderSaved"));
      return saved;
    } catch (error) {
      pushNotification(
        error instanceof Error ? error.message : t("notifProviderSaveFailed"),
        "error",
      );
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function fetchModels() {
    if (!host || !draft || fetching) return;
    const epoch = draftEpochRef.current;
    const saved = await persistDraft({
      notify: false,
      includeKeyRemoval: false,
      refreshModelCatalog: false,
    });
    if (!saved) return;
    setFetching(true);
    try {
      const response = await hostClient.request(
        "provider.fetchModels",
        hostContext(host),
        { providerId: saved.id },
        20_000,
      );
      if (!response.ok) {
        pushNotification(localizeHostError(response.error, t), hostErrorLevel(response.error));
        return;
      }
      // The user may have switched to another Provider while the fetch was in
      // flight; never write another Provider's models into the current draft.
      if (epoch !== draftEpochRef.current) return;
      setCatalog(response.result.models);
      setDraft((current) =>
        current
          ? {
              ...current,
              models: response.result.models.filter((model) => model.enabled).map(stripEnabled),
            }
          : current,
      );
    } catch (error) {
      pushNotification(
        error instanceof Error ? error.message : t("notifFetchModelsFailed"),
        "error",
      );
    } finally {
      setFetching(false);
      refreshProviderConfig();
    }
  }

  async function testConnection() {
    if (!host || !draft || testing) return;
    const epoch = draftEpochRef.current;
    const saved = await persistDraft({
      notify: false,
      includeKeyRemoval: false,
      refreshModelCatalog: false,
    });
    if (!saved) return;
    const modelId = saved.models[0]?.id;
    if (!modelId) {
      pushNotification(t("notifNeedModelToTest"), "error");
      refreshProviderConfig();
      return;
    }
    setTesting(true);
    setConnectionResult(null);
    try {
      const response = await hostClient.request(
        "provider.checkConnection",
        hostContext(host),
        { providerId: saved.id, modelId },
        25_000,
      );
      if (!response.ok) {
        pushNotification(localizeHostError(response.error, t), hostErrorLevel(response.error));
        return;
      }
      // Never render a result banner for a Provider the user switched away from.
      if (epoch !== draftEpochRef.current) return;
      setConnectionResult(response.result);
      if (response.result.ok)
        pushNotification(t("notifProviderResponded", { ms: response.result.latencyMs }));
    } catch (error) {
      pushNotification(
        error instanceof Error ? error.message : t("notifProviderTestFailed"),
        "error",
      );
    } finally {
      setTesting(false);
      refreshProviderConfig();
    }
  }

  function updateCompatibility(key: keyof ProviderCompatibilityDraft, value: boolean | null) {
    updateDraft({
      compat: {
        ...draft?.compat,
        [key]: value,
      },
    });
  }

  async function setProviderEnabled(provider: ProviderSnapshot, enabled: boolean) {
    if (!host || updatingProviderId) return;
    setUpdatingProviderId(provider.id);
    try {
      const response = await hostClient.request("provider.setEnabled", hostContext(host), {
        providerId: provider.id,
        enabled,
      });
      if (!response.ok) {
        pushNotification(localizeHostError(response.error, t), hostErrorLevel(response.error));
        return;
      }
      setProviders((current) =>
        current.map((item) =>
          item.id === response.result.providerId
            ? { ...item, enabled: response.result.enabled }
            : item,
        ),
      );
      refreshProviderConfig();
      pushNotification(
        enabled
          ? t("notifProviderEnabled", { name: provider.name })
          : t("notifProviderDisabled", { name: provider.name }),
      );
    } catch (error) {
      pushNotification(
        error instanceof Error ? error.message : t("notifProviderUpdateFailed"),
        "error",
      );
    } finally {
      setUpdatingProviderId(null);
    }
  }

  async function removeProvider() {
    if (!host || !draft?.originalId || saving || fetching || testing) return;
    setSaving(true);
    try {
      const response = await hostClient.request("provider.remove", hostContext(host), {
        providerId: draft.originalId,
      });
      if (!response.ok) {
        pushNotification(localizeHostError(response.error, t), hostErrorLevel(response.error));
        return;
      }
      const listResponse = await hostClient.request("provider.list", hostContext(host), null);
      const remaining = listResponse.ok
        ? listResponse.result.providers
        : providers.filter((provider) => provider.id !== draft.originalId);
      setProviders(remaining);
      const nextProvider = remaining.find((provider) => provider.enabled) ?? remaining[0];
      if (nextProvider) selectProvider(nextProvider);
      else {
        setSelectedId(null);
        setDraft(null);
        setCatalog([]);
      }
      refreshProviderConfig();
      pushNotification(t("notifProviderDeleted"));
    } catch (error) {
      pushNotification(
        error instanceof Error ? error.message : t("notifProviderDeleteFailed"),
        "error",
      );
    } finally {
      setSaving(false);
    }
  }

  function addManualModel() {
    const id = manualId.trim();
    if (!id) return;
    const existing = catalog.find((model) => model.id === id);
    const model = existing ?? newProviderModel(id);
    const next = [...catalog.filter((item) => item.id !== id), { ...model, enabled: true }].sort(
      (left, right) => left.id.localeCompare(right.id),
    );
    syncModels(next);
    setManualId("");
    setManualOpen(false);
    setEditingModelId(id);
  }

  function updateModel(id: string, patch: Partial<DiscoveredProviderModel>) {
    syncModels(catalog.map((model) => (model.id === id ? { ...model, ...patch } : model)));
  }

  function updateHeader(oldKey: string, nextKey: string, value: string) {
    if (!draft) return;
    const headers = { ...draft.headers };
    delete headers[oldKey];
    if (nextKey) headers[nextKey] = value;
    updateDraft({ headers });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-surface-raised/40">
          <div className="flex items-center gap-2 border-b border-border p-3">
            <div className="relative min-w-0 flex-1">
              <Search className="absolute left-2 top-2 text-muted" size={14} />
              <input
                className="h-8 w-full rounded-md border border-border bg-surface pl-7 pr-2 text-xs outline-none focus:border-focus"
                placeholder={t("providersSearch")}
                value={providerSearch}
                onChange={(event) => setProviderSearch(event.target.value)}
              />
            </div>
            <button
              type="button"
              className="theme-secondary-control flex size-8 shrink-0 items-center justify-center rounded-md border border-border hover:bg-surface-overlay"
              title={t("providersAdd")}
              aria-label={t("providersAdd")}
              onClick={() => {
                if (dirty) setPendingSwitch({ kind: "new" });
                else startNewProvider();
              }}
            >
              <Plus size={15} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2" data-settings-scroll>
            {loading ? (
              <p className="p-3 text-xs text-muted">{t("providersLoading")}</p>
            ) : loadError && providers.length === 0 ? (
              <div className="flex items-start gap-2 p-3 text-xs text-danger">
                <AlertTriangle className="mt-0.5 shrink-0" size={13} />
                <span>{t("providersLoadFailed")}</span>
              </div>
            ) : filteredProviders.length === 0 ? (
              <p className="p-3 text-xs text-muted">{t("providersNone")}</p>
            ) : (
              filteredProviders.map((provider) => (
                <div
                  key={provider.id}
                  data-ui="nav-item"
                  data-state={selectedId === provider.id ? "active" : "inactive"}
                  className={`mb-1 flex w-full items-center rounded-md ${
                    selectedId === provider.id
                      ? "theme-nav-active bg-nav-active text-nav-active-foreground"
                      : "text-muted hover:bg-control-hover hover:text-foreground"
                  }`}
                >
                  <button
                    type="button"
                    className="interface-density-compact-list-row flex min-w-0 flex-1 items-start gap-2 px-3 py-2 text-left"
                    aria-current={selectedId === provider.id ? "true" : undefined}
                    onClick={() =>
                      dirty
                        ? setPendingSwitch({ kind: "select", id: provider.id })
                        : selectProvider(provider)
                    }
                  >
                    <span
                      className={`mt-1.5 size-2 shrink-0 rounded-full ${
                        provider.auth.configured ? "bg-success" : "bg-muted"
                      }`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{provider.name}</span>
                      <span className="block truncate text-[11px]">
                        {provider.enabled
                          ? t("providersModelsCountEnabled", { count: provider.models.length })
                          : t("providersModelsCount", { count: provider.models.length })}
                      </span>
                    </span>
                  </button>
                  <span className="mr-2 flex size-8 shrink-0 items-center justify-center">
                    {updatingProviderId === provider.id ? (
                      <RefreshCw className="animate-spin text-muted" size={15} />
                    ) : (
                      <Switch
                        checked={provider.enabled}
                        label={`${provider.enabled ? "Disable" : "Enable"} ${provider.name}`}
                        disabled={updatingProviderId !== null}
                        onChange={(next) => void setProviderEnabled(provider, next)}
                      />
                    )}
                  </span>
                </div>
              ))
            )}
          </div>
          <div className="border-t border-border p-2">
            <button
              type="button"
              data-ui="nav-item"
              data-state={oauthOpen ? "active" : "inactive"}
              className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs font-medium ${
                oauthOpen
                  ? "theme-nav-active bg-nav-active text-nav-active-foreground"
                  : "text-muted hover:bg-control-hover hover:text-foreground"
              }`}
              aria-current={oauthOpen ? "true" : undefined}
              onClick={() => {
                if (oauthOpen) return;
                if (dirty) setPendingSwitch({ kind: "oauth" });
                else openOauthLogin();
              }}
            >
              <LogIn size={14} /> {t("providersLoginSection")}
            </button>
          </div>
        </aside>

        {oauthOpen ? (
          <ProviderLoginPage onClose={() => setOauthOpen(false)} />
        ) : !draft ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted">
            {loading && providers.length === 0 ? (
              <span role="status" className="flex items-center gap-2">
                <RefreshCw className="animate-spin motion-reduce:animate-none" size={15} />
                {t("providersLoading")}
              </span>
            ) : loadError && providers.length === 0 ? (
              <div role="alert" className="flex max-w-sm flex-col items-center gap-3 text-center">
                <AlertTriangle className="text-danger" size={20} />
                <div>
                  <p className="font-medium text-foreground">{t("providersLoadFailed")}</p>
                  <p className="mt-1 break-words text-xs text-muted">{loadError}</p>
                </div>
                <button
                  type="button"
                  className={secondaryButton}
                  disabled={loading}
                  onClick={() => setLoadAttempt((current) => current + 1)}
                >
                  <RefreshCw size={14} /> {t("providersRetry")}
                </button>
              </div>
            ) : providers.length === 0 ? (
              <>
                <p>{t("providersEmptyTitle")}</p>
                <div className="flex items-center gap-2">
                  <button type="button" className={secondaryButton} onClick={openOauthLogin}>
                    <LogIn size={14} /> {t("providersAddChoiceOauth")}
                  </button>
                  <button type="button" className={secondaryButton} onClick={startNewProvider}>
                    <Plus size={14} /> {t("providersAddChoiceCustom")}
                  </button>
                </div>
              </>
            ) : (
              t("providersSelectHint")
            )}
          </div>
        ) : (
          <div className="min-w-0 flex-1 overflow-auto">
            <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
              <header className="flex items-start justify-between gap-4">
                <div>
                  <h1 className="text-lg font-semibold">
                    {draft.originalId ? t("providersEditTitle") : t("providersAddTitle")}
                  </h1>
                  <p className="mt-1 text-xs text-muted">
                    {draft.originalId ?? t("providersCustom")}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {dirty && (
                    <span className="flex items-center gap-1 text-[11px] text-warning">
                      <AlertTriangle size={12} /> {t("providersUnsaved")}
                    </span>
                  )}
                  {draft.originalId && (
                    <button
                      type="button"
                      className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs hover:bg-surface-overlay disabled:opacity-50"
                      disabled={saving || fetching || testing}
                      title={t("providersCopyTitle")}
                      aria-label={t("providersCopy")}
                      onClick={copyProvider}
                    >
                      <Copy size={14} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs hover:bg-surface-overlay disabled:opacity-50"
                    disabled={saving || fetching || testing || draft.models.length === 0}
                    title={t("providersSaveAndTestTitle")}
                    aria-label={testing ? t("providersTesting") : t("providersSaveAndTest")}
                    onClick={() => void testConnection()}
                  >
                    {testing ? (
                      <RefreshCw className="animate-spin" size={14} />
                    ) : (
                      <Activity size={14} />
                    )}
                  </button>
                  {draft.originalId && (
                    <button
                      type="button"
                      className="flex h-8 items-center gap-1.5 rounded-md border border-danger/40 px-2.5 text-xs text-danger hover:bg-danger/10 disabled:opacity-50"
                      disabled={saving || fetching || testing}
                      title={t("commonDelete")}
                      aria-label={t("commonDelete")}
                      onClick={() => setConfirmDelete(true)}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-xs text-accent-foreground hover:bg-accent-hover disabled:opacity-50"
                    disabled={saving || fetching || testing}
                    title={t("commonSave")}
                    aria-label={t("commonSave")}
                    onClick={() => void persistDraft()}
                  >
                    {saving ? <RefreshCw className="animate-spin" size={14} /> : <Save size={14} />}
                  </button>
                </div>
              </header>

              {connectionResult && (
                <div
                  className={`rounded-lg border px-3 py-2 text-xs ${
                    connectionResult.ok
                      ? "border-success/35 bg-success/10"
                      : "border-danger/35 bg-danger/10"
                  }`}
                >
                  <div className="flex items-start gap-2">
                    {connectionResult.ok ? (
                      <CircleCheck className="mt-0.5 shrink-0 text-success" size={15} />
                    ) : (
                      <AlertTriangle className="mt-0.5 shrink-0 text-danger" size={15} />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="font-medium">
                          {connectionResult.ok
                            ? t("providersConnectionOk")
                            : connectionResult.category.replace("_", " ")}
                        </span>
                        <span className="font-mono text-[11px] text-muted">
                          {connectionResult.modelId} · {connectionResult.latencyMs} ms
                        </span>
                      </div>
                      <p className="mt-1 break-words text-muted">{connectionResult.message}</p>
                      {connectionResult.suggestion && (
                        <div className="mt-1.5 flex flex-wrap items-center gap-2">
                          <span>{connectionResult.suggestion}</span>
                          {connectionResult.category === "configuration" &&
                            draft.api === "openai-completions" && (
                              <>
                                {draft.compat?.supportsDeveloperRole !== false && (
                                  <button
                                    type="button"
                                    className="font-medium text-accent hover:underline"
                                    onClick={() =>
                                      updateCompatibility("supportsDeveloperRole", false)
                                    }
                                  >
                                    {t("providersUseSystemRole")}
                                  </button>
                                )}
                                {draft.compat?.supportsReasoningEffort !== false && (
                                  <button
                                    type="button"
                                    className="font-medium text-accent hover:underline"
                                    onClick={() =>
                                      updateCompatibility("supportsReasoningEffort", false)
                                    }
                                  >
                                    {t("providersOmitReasoningEffort")}
                                  </button>
                                )}
                              </>
                            )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              <section className="grid grid-cols-2 gap-4">
                <label className="flex flex-col gap-1.5 text-xs text-muted">
                  <span>
                    {t("providersVendorName")} <span className="text-danger">*</span>
                  </span>
                  <input
                    className={`h-8 rounded-md border bg-surface px-3 text-xs text-foreground outline-none focus:border-focus ${
                      fieldErrors.name ? "border-danger" : "border-border"
                    }`}
                    value={draft.name}
                    onChange={(event) => updateDraft({ name: event.target.value })}
                  />
                  {fieldErrors.name && (
                    <span className="text-[11px] text-danger">
                      {t(fieldErrors.name as MessageKey)}
                    </span>
                  )}
                </label>
                <label className="flex flex-col gap-1.5 text-xs text-muted">
                  {t("providersApiProtocol")}
                  <Select
                    ariaLabel={t("providersApiProtocol")}
                    value={draft.api}
                    onChange={(next) => updateDraft({ api: next as ProviderDraft["api"] })}
                    options={API_OPTIONS.map((option) => ({
                      value: option.value,
                      label: option.label,
                    }))}
                  />
                </label>
                <label className="col-span-2 flex flex-col gap-1.5 text-xs text-muted">
                  <span>
                    {t("providersBaseUrl")} <span className="text-danger">*</span>
                  </span>
                  <input
                    className={`h-8 rounded-md border bg-surface px-3 font-mono text-xs text-foreground outline-none focus:border-focus ${
                      fieldErrors.baseUrl ? "border-danger" : "border-border"
                    }`}
                    placeholder={
                      draft.api === "anthropic-messages"
                        ? "https://api.example.com"
                        : "https://api.example.com/v1"
                    }
                    value={draft.baseUrl}
                    onChange={(event) => updateDraft({ baseUrl: event.target.value })}
                    onBlur={() => validateUrlField("baseUrl")}
                  />
                  {fieldErrors.baseUrl && (
                    <span className="text-[11px] text-danger">
                      {t(fieldErrors.baseUrl as MessageKey)}
                    </span>
                  )}
                </label>
              </section>

              <section>
                <div className="mb-2 flex items-center justify-between">
                  <div>
                    <h2 className="text-sm font-medium">{t("providersApiKey")}</h2>
                    {clearApiKey ? (
                      <p className="flex items-center gap-1 text-[11px] text-danger">
                        <AlertTriangle size={12} /> {t("providersKeyWillBeRemoved")}
                      </p>
                    ) : (
                      <p className="text-[11px] text-muted">{authLabel(t, selectedProvider)}</p>
                    )}
                  </div>
                  {selectedProvider?.auth.configured && (
                    <button
                      type="button"
                      className="text-xs text-danger hover:underline"
                      onClick={() => {
                        setClearApiKey((current) => !current);
                        setApiKey("");
                      }}
                    >
                      {clearApiKey ? t("providersKeyKeep") : t("providersKeyRemove")}
                    </button>
                  )}
                </div>
                <div className="relative">
                  <input
                    type={showApiKey ? "text" : "password"}
                    className="h-8 w-full rounded-md border border-border bg-surface px-3 pr-10 font-mono text-xs outline-none focus:border-focus"
                    placeholder={
                      selectedProvider?.auth.configured
                        ? t("providersKeyPlaceholderKeep")
                        : t("providersKeyPlaceholderEnter")
                    }
                    value={apiKey}
                    onChange={(event) => {
                      setApiKey(event.target.value);
                      if (event.target.value) setClearApiKey(false);
                    }}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    className="absolute right-1 top-1 flex size-7 items-center justify-center text-muted hover:text-foreground"
                    title={showApiKey ? t("providersKeyHide") : t("providersKeyShow")}
                    onClick={() => setShowApiKey((current) => !current)}
                  >
                    {showApiKey ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </section>

              <section>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-medium">{t("providersModelsGroup")}</h2>
                    <p className="text-[11px] text-muted">
                      {t("providersModelsEnabledIn", { count: draft.models.length })}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      className="h-8 px-2 text-xs text-muted hover:text-foreground"
                      disabled={catalog.length === 0}
                      onClick={() => {
                        const enable = catalog.some((model) => !model.enabled);
                        syncModels(catalog.map((model) => ({ ...model, enabled: enable })));
                      }}
                    >
                      {catalog.length > 0 && catalog.every((model) => model.enabled)
                        ? t("providersSelectNone")
                        : t("providersSelectAll")}
                    </button>
                    <button
                      type="button"
                      className="flex size-8 items-center justify-center rounded-md hover:bg-surface-overlay disabled:opacity-50"
                      title={t("providersFetchModels")}
                      disabled={fetching || saving || testing}
                      onClick={() => void fetchModels()}
                    >
                      <RefreshCw className={fetching ? "animate-spin" : ""} size={15} />
                    </button>
                    <button
                      type="button"
                      className="flex size-8 items-center justify-center rounded-md hover:bg-surface-overlay"
                      title={t("providersAddModel")}
                      onClick={() => setManualOpen((current) => !current)}
                    >
                      <Plus size={15} />
                    </button>
                  </div>
                </div>
                <div className="relative mb-2">
                  <Search className="absolute left-2.5 top-2.5 text-muted" size={14} />
                  <input
                    className="h-8 w-full rounded-md border border-border bg-surface pl-8 pr-3 text-xs outline-none focus:border-focus"
                    placeholder={t("providersSearchModels")}
                    value={modelSearch}
                    onChange={(event) => setModelSearch(event.target.value)}
                  />
                </div>
                {manualOpen && (
                  <div className="mb-2 flex gap-2">
                    <input
                      className="h-8 min-w-0 flex-1 rounded-md border border-border bg-surface px-3 font-mono text-xs outline-none focus:border-focus"
                      placeholder={t("providersModelId")}
                      value={manualId}
                      onChange={(event) => setManualId(event.target.value)}
                      onCompositionStart={ime.onCompositionStart}
                      onCompositionEnd={ime.onCompositionEnd}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !ime.isImeKey(event)) addManualModel();
                      }}
                    />
                    <button
                      type="button"
                      className="flex size-8 items-center justify-center rounded-md bg-accent text-accent-foreground"
                      title={t("providersAddModelConfirm")}
                      onClick={addManualModel}
                    >
                      <Check size={14} />
                    </button>
                  </div>
                )}
                <div className="max-h-96 overflow-auto rounded-md border border-border">
                  {filteredModels.length === 0 ? (
                    <p className="p-4 text-center text-xs text-muted">
                      {t("providersModelsEmpty")}
                    </p>
                  ) : (
                    filteredModels.map((model) => (
                      <div key={model.id} className="border-b border-border last:border-b-0">
                        <div className="interface-density-primary-row flex h-10 items-center gap-3 px-3">
                          <input
                            type="checkbox"
                            checked={model.enabled}
                            aria-label={t("providersShowInChat", { name: model.name })}
                            onChange={(event) =>
                              updateModel(model.id, { enabled: event.target.checked })
                            }
                          />
                          <span className="min-w-0 flex-1 truncate text-sm" title={model.id}>
                            {model.name}
                          </span>
                          <span className="flex shrink-0 items-center gap-1.5 text-muted">
                            {model.reasoning && (
                              <span
                                className="flex items-center gap-1 text-[11px]"
                                title={thinkingSourceLabel(t, model)}
                              >
                                <Brain size={13} />
                              </span>
                            )}
                            {model.input.includes("image") && (
                              <span
                                className="flex items-center text-[11px]"
                                title={t("providersImages")}
                              >
                                <ImageIcon size={13} />
                              </span>
                            )}
                            {model.contextWindow > 0 && (
                              <span
                                className="text-[11px] tabular-nums"
                                title={t("providersContextWindow")}
                              >
                                {formatTokenCount(model.contextWindow)}
                              </span>
                            )}
                          </span>
                          <button
                            type="button"
                            className={`flex size-7 items-center justify-center rounded-md ${
                              editingModelId === model.id
                                ? "bg-accent/15 text-accent"
                                : "text-muted hover:text-foreground"
                            }`}
                            title={t("providersModelSettings")}
                            aria-expanded={editingModelId === model.id}
                            onClick={() =>
                              setEditingModelId((current) =>
                                current === model.id ? null : model.id,
                              )
                            }
                          >
                            <SlidersHorizontal size={14} />
                          </button>
                        </div>
                        {editingModelId === model.id && (
                          <div className="grid grid-cols-2 gap-3 border-t border-border bg-surface-raised/60 p-3">
                            <div className="col-span-2 flex items-center justify-between">
                              <span className="font-mono text-xs">{model.id}</span>
                              <button
                                type="button"
                                className="text-muted hover:text-foreground"
                                title={t("providersCloseModelSettings")}
                                aria-label={t("providersCloseModelSettings")}
                                onClick={() => setEditingModelId(null)}
                              >
                                <X size={14} />
                              </button>
                            </div>
                            <label className="flex flex-col gap-1 text-[11px] text-muted">
                              {t("providersDisplayName")}
                              <input
                                className="h-8 rounded-md border border-border bg-surface px-2 text-xs text-foreground outline-none focus:border-focus"
                                value={model.name}
                                onChange={(event) =>
                                  updateModel(model.id, { name: event.target.value })
                                }
                              />
                            </label>
                            <NumberField
                              key={`${model.id}:contextWindow`}
                              label={t("providersContextWindow")}
                              value={model.contextWindow}
                              onCommit={(next) => updateModel(model.id, { contextWindow: next })}
                            />
                            <NumberField
                              key={`${model.id}:maxTokens`}
                              label={t("providersMaxTokens")}
                              value={model.maxTokens}
                              onCommit={(next) => updateModel(model.id, { maxTokens: next })}
                            />
                            <label className="flex flex-col gap-1 text-[11px] text-muted">
                              {t("providersThinkingSupport")}
                              <Select
                                ariaLabel={t("providersThinkingSupport")}
                                value={thinkingMode(model)}
                                onChange={(next) => {
                                  const mode = next;
                                  if (mode === "disabled") {
                                    updateModel(model.id, {
                                      reasoning: false,
                                      thinkingLevelMap: undefined,
                                      thinkingSource: "manual",
                                    });
                                    return;
                                  }
                                  if (mode === "custom") {
                                    updateModel(model.id, {
                                      reasoning: true,
                                      thinkingLevelMap: customThinkingMap(model),
                                      thinkingSource: "manual",
                                    });
                                    return;
                                  }
                                  updateModel(model.id, automaticThinkingConfig(model.id));
                                }}
                                options={[
                                  { value: "auto", label: t("commonAuto") },
                                  { value: "custom", label: t("commonCustom") },
                                  { value: "disabled", label: t("commonDisabled") },
                                ]}
                              />
                            </label>
                            <div className="flex items-end gap-4 pb-1 text-xs">
                              <label className="flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={model.input.includes("image")}
                                  onChange={(event) =>
                                    updateModel(model.id, {
                                      input: event.target.checked ? ["text", "image"] : ["text"],
                                    })
                                  }
                                />{" "}
                                {t("providersImages")}
                              </label>
                            </div>
                            <p className="col-span-2 text-[11px] text-muted">
                              {thinkingSourceLabel(t, model)}
                            </p>
                            {thinkingMode(model) === "custom" && (
                              <div className="col-span-2 grid grid-cols-4 gap-2 border-t border-border pt-2">
                                {THINKING_LEVELS.map((level) => {
                                  const enabled = model.thinkingLevelMap?.[level] !== null;
                                  const enabledCount = THINKING_LEVELS.filter(
                                    (item) => model.thinkingLevelMap?.[item] !== null,
                                  ).length;
                                  return (
                                    <label key={level} className="flex items-center gap-2 text-xs">
                                      <input
                                        type="checkbox"
                                        checked={enabled}
                                        onChange={(event) => {
                                          if (!event.target.checked && enabledCount <= 1) return;
                                          updateModel(model.id, {
                                            reasoning: true,
                                            thinkingLevelMap: {
                                              ...customThinkingMap(model),
                                              [level]: event.target.checked ? level : null,
                                            },
                                            thinkingSource: "manual",
                                          });
                                        }}
                                      />
                                      {level}
                                    </label>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </section>

              <details className="border-t border-border pt-4">
                <summary className="cursor-pointer text-sm font-medium">
                  {t("providersHeadersGroup")}
                </summary>
                <div className="mt-3 flex flex-col gap-2">
                  {Object.entries(draft.headers).map(([key, value]) => (
                    <div key={key} className="grid grid-cols-[1fr_1.5fr_32px] gap-2">
                      <input
                        className="h-8 rounded-md border border-border bg-surface px-2 font-mono text-xs outline-none focus:border-focus"
                        value={key}
                        onChange={(event) => updateHeader(key, event.target.value, value)}
                      />
                      <input
                        className="h-8 rounded-md border border-border bg-surface px-2 font-mono text-xs outline-none focus:border-focus"
                        value={value}
                        onChange={(event) => updateHeader(key, key, event.target.value)}
                      />
                      <button
                        type="button"
                        className="flex size-8 items-center justify-center text-muted hover:text-danger"
                        title={t("providersHeaderRemove")}
                        onClick={() => updateHeader(key, "", "")}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="flex h-8 w-fit items-center gap-1.5 rounded-md border border-border px-2.5 text-xs hover:bg-surface-overlay"
                    onClick={() => {
                      let key = "X-Custom-Header";
                      let index = 2;
                      while (draft.headers[key] !== undefined) key = `X-Custom-Header-${index++}`;
                      updateDraft({ headers: { ...draft.headers, [key]: "" } });
                    }}
                  >
                    <Plus size={13} /> {t("providersHeaderAdd")}
                  </button>
                </div>
              </details>
            </div>
          </div>
        )}
      </div>
      {confirmDelete &&
        draft?.originalId &&
        (() => {
          const saved = providers.find((provider) => provider.id === draft.originalId);
          return (
            <Dialog
              title={t("providersDeleteTitle")}
              confirmLabel={t("providersDeleteTitle")}
              tone="danger"
              onCancel={() => setConfirmDelete(false)}
              onConfirm={() => {
                setConfirmDelete(false);
                void removeProvider();
              }}
            >
              <p>{t("providersDeleteBody", { name: saved?.name ?? draft.originalId ?? "" })}</p>
              <dl className="mt-3 grid grid-cols-[72px_1fr] gap-x-3 gap-y-1 rounded-md border border-border bg-surface p-3 text-xs">
                <dt>{t("providersBaseUrl")}</dt>
                <dd className="break-all font-mono text-foreground">{saved?.baseUrl ?? "—"}</dd>
                <dt>{t("providersDeleteModels")}</dt>
                <dd className="text-foreground">{saved?.models.length ?? 0}</dd>
              </dl>
            </Dialog>
          );
        })()}
      {pendingSwitch !== null && (
        <Dialog
          title={t("providersSwitchTitle")}
          confirmLabel={t("settingsDiscardConfirm")}
          tone="warning"
          onCancel={() => setPendingSwitch(null)}
          onConfirm={() => {
            const target = pendingSwitch;
            setPendingSwitch(null);
            if (target.kind === "new") {
              startNewProvider();
              return;
            }
            if (target.kind === "oauth") {
              openOauthLogin();
              return;
            }
            // Resolve against the live list; the provider may have vanished
            // (host reload) between opening and confirming the dialog.
            const live = providers.find((provider) => provider.id === target.id);
            if (live) selectProvider(live);
          }}
        >
          <p>
            {t("providersSwitchBody", { name: draft?.name?.trim() || t("providersThisProvider") })}
          </p>
        </Dialog>
      )}
    </div>
  );
}
