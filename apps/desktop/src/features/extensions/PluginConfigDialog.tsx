import { useEffect, useState } from "react";
import { Eye, EyeOff, Minus, Plus } from "lucide-react";
import { Dialog } from "../../components/Dialog";
import { Select } from "../../components/Select";
import type { ModelSummary, PluginLibraryConfigItem, PluginLibraryEntry } from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { localizeHostError } from "../../lib/bridge/localize-host-error";
import { hostContext } from "../../lib/bridge/host-context";
import { useAppStore } from "../../lib/stores/app-store";
import { useT } from "../../lib/i18n/use-t";
import {
  buildPluginEnvPatch,
  initialConfigValues,
  isVisionCapable,
  missingRequiredConfig,
  modelOption,
  modelOptionsKind,
  wantsModelListOptions,
  wantsModelOptions,
} from "../plugin-library/plugin-library-model";
import {
  notifyDesktopSettingsSaveFailure,
  persistDesktopSettings,
} from "../../lib/desktop-settings";

const inputClass =
  "box-border interface-density-control h-8 min-w-0 rounded-md border border-border bg-surface px-2 text-xs text-foreground placeholder:text-muted focus:border-focus";

/** Hook fetching the runtime's available models for dynamic select config
 *  items (`optionsSource: "pi:vision-models" | "pi:models"`). Returns the
 *  full list; the caller filters by `modelOptionsKind` when it needs the
 *  vision-only subset. */
function useRuntimeModels(enabled: boolean): readonly ModelSummary[] | null {
  const host = useAppStore((s) => s.host);
  const hostId = host?.hostInstanceId;
  const [models, setModels] = useState<readonly ModelSummary[] | null>(null);

  useEffect(() => {
    if (!enabled || !hostId) {
      setModels(null);
      return;
    }
    const currentHost = useAppStore.getState().host;
    if (!currentHost) {
      setModels([]);
      return;
    }
    let cancelled = false;
    setModels(null);
    void hostClient
      .request("piSettings.get", hostContext(currentHost), null)
      .then((response) => {
        if (cancelled) return;
        if (!response.ok) {
          setModels([]);
          return;
        }
        const raw = response.result?.models;
        setModels(Array.isArray(raw) ? raw : []);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, hostId]);

  return models;
}

function listRows(value: string): string[] {
  const rows = value.split(",").map((part) => part.trim());
  return rows.length > 0 ? rows : [""];
}

/** Ordered fallback-model list control (one Select row per fallback entry).
 *  `models` must already be filtered to the config item's kind
 *  (`modelOptionsKind`); `loading` drives the disabled placeholder state. */
function ModelFallbackListControl({
  item,
  value,
  models,
  loading,
  onChange,
}: {
  item: PluginLibraryConfigItem;
  value: string;
  models: readonly ModelSummary[];
  loading: boolean;
  onChange: (value: string) => void;
}) {
  const t = useT();
  const rows = listRows(value);
  const options = [
    { value: "", label: t("pluginsModelFallbackChoose") },
    ...models.map(modelOption),
  ];
  const knownValues = new Set(options.map((option) => option.value));
  for (const row of rows) {
    if (row && !knownValues.has(row)) {
      options.push({ value: row, label: row });
      knownValues.add(row);
    }
  }
  const noModels = !loading && models.length === 0;

  function updateRow(index: number, next: string) {
    const nextRows = [...rows];
    nextRows[index] = next;
    onChange(nextRows.join(","));
  }

  function removeRow(index: number) {
    const nextRows = rows.filter((_, rowIndex) => rowIndex !== index);
    onChange(nextRows.join(","));
  }

  return (
    <div className="flex flex-col gap-1.5" data-model-fallback-models={item.env}>
      {rows.map((row, index) => {
        const rowOptions = options.some((option) => option.value === row)
          ? options
          : [...options, { value: row, label: row }];
        return (
          <div className="flex items-center gap-1.5" key={`${index}-${row}`}>
            <Select
              className="h-8 min-w-0 flex-1"
              ariaLabel={`${item.label} ${index + 1}`}
              value={row}
              disabled={loading || (noModels && !row)}
              onChange={(next) => updateRow(index, next)}
              options={rowOptions}
            />
            <button
              type="button"
              className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border text-muted hover:bg-surface-overlay hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              aria-label={t("pluginsModelFallbackRemove")}
              disabled={rows.length === 1 && !row}
              onClick={() => removeRow(index)}
            >
              <Minus size={14} />
            </button>
            {index === rows.length - 1 && (
              <button
                type="button"
                className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border text-muted hover:bg-surface-overlay hover:text-foreground"
                aria-label={t("pluginsModelFallbackAdd")}
                onClick={() => onChange([...rows, ""].join(","))}
              >
                <Plus size={14} />
              </button>
            )}
          </div>
        );
      })}
      {noModels && (
        <p className="text-[11px] leading-4 text-muted">{t("pluginsModelFallbackNoModels")}</p>
      )}
    </div>
  );
}

/** Shared configuration dialog: one instance serves every plugin card. */
export function PluginConfigDialog({
  entry,
  onClose,
}: {
  entry: PluginLibraryEntry;
  onClose: () => void;
}) {
  const t = useT();
  const host = useAppStore((s) => s.host);
  const pushNotification = useAppStore((s) => s.pushNotification);
  const desktopSettings = useAppStore((s) => s.desktopSettings);
  const [values, setValues] = useState<Record<string, string>>(() =>
    initialConfigValues(entry, desktopSettings?.pluginEnv),
  );
  const [saving, setSaving] = useState(false);
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});

  const needsRuntimeModels = (entry.config ?? []).some(
    (item) => wantsModelOptions(item) || wantsModelListOptions(item),
  );
  const runtimeModels = useRuntimeModels(needsRuntimeModels);

  async function save() {
    const missing = missingRequiredConfig(entry, values);
    if (missing.length > 0) {
      pushNotification(t("pluginsConfigRequiredMissing", { label: missing[0]!.label }), "error");
      return;
    }
    setSaving(true);
    try {
      const persistedValues = { ...values };
      for (const item of entry.config ?? []) {
        if (wantsModelListOptions(item)) {
          persistedValues[item.env] = listRows(values[item.env] ?? "")
            .filter(Boolean)
            .join(",");
        }
      }
      await persistDesktopSettings({
        pluginEnv: buildPluginEnvPatch(desktopSettings?.pluginEnv, entry.id, persistedValues),
      });
      // Extensions run inside the Host process, so env vars land live; the
      // desktop-settings copy is what the next Host spawn re-injects.
      if (host) {
        const vars: Record<string, string | null> = {};
        for (const item of entry.config ?? []) {
          const value = persistedValues[item.env] ?? "";
          vars[item.env] = value.length > 0 ? value : null;
        }
        if (Object.keys(vars).length > 0) {
          const response = await hostClient.request(
            "pluginLibrary.setEnv",
            hostContext(host),
            { vars },
            15_000,
          );
          if (!response.ok)
            throw new Error(
              response.error ? localizeHostError(response.error, t) : "pluginLibrary.setEnv",
            );
        }
      }
      pushNotification(t("pluginsConfigSaved"));
      onClose();
    } catch (error) {
      notifyDesktopSettingsSaveFailure(error);
    } finally {
      setSaving(false);
    }
  }

  function renderControl(item: PluginLibraryConfigItem) {
    const id = `plugin-${entry.id}-${item.key}`;
    // Runtime model list narrowed to the config item's kind (vision / all).
    const kindModels = (model: readonly ModelSummary[] | null): readonly ModelSummary[] =>
      modelOptionsKind(item) === "vision" ? (model ?? []).filter(isVisionCapable) : (model ?? []);
    // 1. Dynamic model single-select.
    if (wantsModelOptions(item)) {
      const loading = runtimeModels === null;
      const filtered = kindModels(runtimeModels);
      if (loading) {
        return (
          <Select
            className="h-8"
            ariaLabel={item.label}
            value=""
            disabled
            onChange={() => {}}
            options={[{ value: "", label: t("pluginsLoading") }]}
          />
        );
      }
      if (filtered.length === 0) {
        return (
          <>
            <input
              id={id}
              className={inputClass}
              type="text"
              autoComplete="off"
              placeholder={item.placeholder ?? "provider/modelId"}
              value={values[item.env] ?? ""}
              onChange={(event) =>
                setValues((prev) => ({ ...prev, [item.env]: event.target.value }))
              }
            />
            <p className="text-[11px] leading-4 text-muted">
              {modelOptionsKind(item) === "vision"
                ? t("pluginsVisionModelFallbackHelp")
                : t("pluginsModelFallbackHelp")}
            </p>
          </>
        );
      }
      const current = values[item.env] ?? item.default ?? "";
      const options = [
        { value: "", label: t("pluginsVisionModelAuto") },
        ...filtered.map(modelOption),
      ];
      // Keep a previously-persisted custom/stale value visible in the dropdown.
      if (current && !options.some((opt) => opt.value === current)) {
        options.push({ value: current, label: current });
      }
      return (
        <Select
          className="h-8"
          ariaLabel={item.label}
          value={current}
          onChange={(next) => setValues((prev) => ({ ...prev, [item.env]: next }))}
          options={options}
        />
      );
    }

    // 2. Ordered fallback model list. The env-name check keeps older catalogs
    // working while the registry migrates items from text to the dynamic
    // source declaration.
    if (wantsModelListOptions(item)) {
      return (
        <ModelFallbackListControl
          item={item}
          value={values[item.env] ?? item.default ?? ""}
          models={kindModels(runtimeModels)}
          loading={runtimeModels === null}
          onChange={(next) => setValues((prev) => ({ ...prev, [item.env]: next }))}
        />
      );
    }

    // 3. Static select with options (or unknown optionsSource that has static fallback options).
    if (item.type === "select" && (item.options?.length ?? 0) > 0) {
      return (
        <Select
          className="h-8"
          ariaLabel={item.label}
          value={values[item.env] ?? item.default ?? ""}
          onChange={(next) => setValues((prev) => ({ ...prev, [item.env]: next }))}
          options={(item.options ?? []).map((option) => ({
            value: option.value,
            label: option.label,
          }))}
        />
      );
    }

    // 4. Fallback for unknown optionsSource without static options or regular text items.
    if (item.secret) {
      const shown = showSecrets[item.key] ?? false;
      return (
        <div className="relative">
          <input
            id={id}
            className={`${inputClass} w-full pr-8`}
            type={shown ? "text" : "password"}
            autoComplete="off"
            placeholder={item.placeholder}
            value={values[item.env] ?? ""}
            onChange={(event) => setValues((prev) => ({ ...prev, [item.env]: event.target.value }))}
          />
          <button
            type="button"
            className="absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center text-muted hover:text-foreground"
            title={shown ? t("providersKeyHide") : t("providersKeyShow")}
            onClick={() => setShowSecrets((prev) => ({ ...prev, [item.key]: !shown }))}
          >
            {shown ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        </div>
      );
    }
    return (
      <input
        id={id}
        className={inputClass}
        type="text"
        autoComplete="off"
        placeholder={item.placeholder}
        value={values[item.env] ?? ""}
        onChange={(event) => setValues((prev) => ({ ...prev, [item.env]: event.target.value }))}
      />
    );
  }

  return (
    <Dialog
      title={t("pluginsConfigDialogTitle", { name: entry.name })}
      confirmLabel={t("commonSave")}
      onCancel={onClose}
      onConfirm={() => void save()}
    >
      <div data-plugin-config-form={entry.id} className="flex flex-col gap-3">
        {(entry.config ?? []).map((item) => (
          <div key={item.key} className="flex flex-col gap-1">
            <label className="text-xs" htmlFor={`plugin-${entry.id}-${item.key}`}>
              {item.label}
              {item.required ? <span className="text-danger"> *</span> : null}
              <span className="ml-1 font-mono text-[10px] text-muted">{item.env}</span>
            </label>
            {renderControl(item)}
            {item.description && (
              <p className="text-[11px] leading-4 text-muted">{item.description}</p>
            )}
          </div>
        ))}
        {saving && <span className="sr-only">{t("pluginsConfigSaved")}</span>}
      </div>
    </Dialog>
  );
}
