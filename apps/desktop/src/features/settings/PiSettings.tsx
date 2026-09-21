import { useEffect, useState, type ReactNode } from "react";
import { Brain, Check, ChevronRight } from "lucide-react";
import type { PiSettingsPatch, PiSettingsSnapshot, ThinkingLevel } from "@piabyss/protocol";
import { Select } from "../../components/Select";
import { useT } from "../../lib/i18n/use-t";
import { hostClient } from "../../lib/bridge/host-client";
import { hostContext } from "../../lib/bridge/host-context";
import { useAppStore } from "../../lib/stores/app-store";
import { notifyOperationFailure } from "../../lib/notify-operation-error";

const THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

// Always shown in English regardless of UI language.
const THINKING_LABELS: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

const DEFAULT_SETTINGS: PiSettingsSnapshot = {
  defaultThinkingLevel: "medium",
  retryMaxRetries: 3,
  defaultProjectTrust: "ask",
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time",
  askUserQuestionEnabled: true,
  models: [],
};

export function PiSettings() {
  const t = useT();
  const host = useAppStore((state) => state.host);
  const [settings, setSettings] = useState<PiSettingsSnapshot>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!host) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void hostClient
      .request("piSettings.get", hostContext(host), null)
      .then((response) => {
        if (cancelled) return;
        if (!response.ok) throw new Error(response.error.message);
        const result = response.result;
        setSettings({
          ...DEFAULT_SETTINGS,
          ...result,
          models: Array.isArray(result.models) ? result.models : [],
        });
      })
      .catch((error) => {
        if (!cancelled) {
          notifyOperationFailure(error, String(error));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [host]);

  async function patch(key: string, next: PiSettingsPatch) {
    if (!host || saving) return;
    setSaving(key);
    try {
      const response = await hostClient.request("piSettings.patch", hostContext(host), next);
      if (!response.ok) throw new Error(response.error.message);
      const result = response.result;
      setSettings({
        ...DEFAULT_SETTINGS,
        ...result,
        models: Array.isArray(result.models) ? result.models : [],
      });
    } catch (error) {
      notifyOperationFailure(error, String(error));
    } finally {
      setSaving(null);
    }
  }

  const selectedModelKey =
    settings.defaultProvider && settings.defaultModel
      ? `${settings.defaultProvider}/${settings.defaultModel}`
      : "";
  const selectedModelName =
    settings.models.find(
      (model) =>
        model.provider === settings.defaultProvider && model.modelId === settings.defaultModel,
    )?.name ?? settings.defaultModel;

  function selectModel(key: string) {
    const separator = key.indexOf("/");
    const provider = key.slice(0, separator);
    const modelId = key.slice(separator + 1);
    void patch("defaultModel", { defaultProvider: provider, defaultModel: modelId });
  }

  return (
    <section>
      <h2 className="mb-2 text-sm font-medium text-muted">{t("generalPiSettingsGroup")}</h2>
      <div className="flex flex-col gap-4 rounded-lg border border-border p-4">
        <SettingRow
          label={t("generalDefaultModel")}
          description={t("generalDefaultModelDesc")}
          saving={saving === "defaultModel" || saving === "defaultThinkingLevel"}
        >
          <Select
            className="w-56 max-w-full"
            ariaLabel={t("generalDefaultModel")}
            value={selectedModelKey}
            disabled={loading || settings.models.length === 0}
            onChange={selectModel}
            selectedLabel={
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate">{selectedModelName || t("modelNone")}</span>
                <span className="shrink-0 whitespace-nowrap text-muted">
                  {THINKING_LABELS[settings.defaultThinkingLevel]}
                </span>
              </span>
            }
            options={settings.models.map((model) => ({
              value: `${model.provider}/${model.modelId}`,
              label: model.name || model.modelId,
              group: model.providerName || model.provider,
            }))}
            footer={
              <ThinkingDepthFooter
                label={t("modelThinkingDepth")}
                value={settings.defaultThinkingLevel}
                disabled={loading}
                onSelect={(level) =>
                  void patch("defaultThinkingLevel", { defaultThinkingLevel: level })
                }
              />
            }
          />
        </SettingRow>

        <SettingRow
          label={t("generalRetryCount")}
          description={t("generalRetryCountDesc")}
          saving={saving === "retryMaxRetries"}
        >
          <input
            className="h-8 w-20 rounded-md border border-border bg-surface px-2 text-right text-xs text-foreground outline-none focus:border-focus"
            type="number"
            min={0}
            max={20}
            step={1}
            value={settings.retryMaxRetries}
            disabled={loading}
            onChange={(event) => {
              const value = Math.max(0, Math.min(20, Number(event.target.value)));
              if (Number.isInteger(value))
                void patch("retryMaxRetries", { retryMaxRetries: value });
            }}
          />
        </SettingRow>

        <SettingRow
          label={t("generalProjectTrust")}
          description={t("generalProjectTrustDesc")}
          saving={saving === "defaultProjectTrust"}
        >
          <Select
            className="min-w-32"
            ariaLabel={t("generalProjectTrust")}
            value={settings.defaultProjectTrust}
            disabled={loading}
            onChange={(value) =>
              void patch("defaultProjectTrust", {
                defaultProjectTrust: value as PiSettingsPatch["defaultProjectTrust"],
              })
            }
            options={[
              { value: "ask", label: t("generalProjectTrustAsk") },
              { value: "always", label: t("generalProjectTrustAlways") },
              { value: "never", label: t("generalProjectTrustNever") },
            ]}
          />
        </SettingRow>

        <SettingRow
          label={t("generalSteeringMode")}
          description={t("generalSteeringModeDesc")}
          saving={saving === "steeringMode"}
        >
          <Select
            className="min-w-40"
            ariaLabel={t("generalSteeringMode")}
            value={settings.steeringMode}
            disabled={loading}
            onChange={(value) =>
              void patch("steeringMode", { steeringMode: value as PiSettingsPatch["steeringMode"] })
            }
            options={[
              { value: "one-at-a-time", label: t("generalSteeringOneAtATime") },
              { value: "all", label: t("generalSteeringAll") },
            ]}
          />
        </SettingRow>

        <SettingRow
          label={t("generalFollowUpMode")}
          description={t("generalFollowUpModeDesc")}
          saving={saving === "followUpMode"}
        >
          <Select
            className="min-w-40"
            ariaLabel={t("generalFollowUpMode")}
            value={settings.followUpMode}
            disabled={loading}
            onChange={(value) =>
              void patch("followUpMode", { followUpMode: value as PiSettingsPatch["followUpMode"] })
            }
            options={[
              { value: "one-at-a-time", label: t("generalFollowUpOneAtATime") },
              { value: "all", label: t("generalFollowUpAll") },
            ]}
          />
        </SettingRow>
      </div>
    </section>
  );
}

/** Footer of the default-model dropdown: a pinned "thinking depth" entry that
 *  expands a nested level list, mirroring the chat composer's model menu. */
function ThinkingDepthFooter({
  label,
  value,
  disabled,
  onSelect,
}: {
  label: string;
  value: ThinkingLevel;
  disabled: boolean;
  onSelect: (level: ThinkingLevel) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {open && (
        <div
          role="listbox"
          aria-label={label}
          className="theme-floating-surface absolute bottom-full left-0 right-0 z-10 mb-1 max-h-44 overflow-y-auto rounded-md border border-border bg-surface-raised py-1 shadow-lg"
        >
          {THINKING_LEVELS.map((level) => {
            const active = level === value;
            return (
              <button
                key={level}
                type="button"
                role="option"
                aria-selected={active}
                className={`flex h-8 w-full items-center gap-1.5 whitespace-nowrap px-2.5 text-left text-xs transition-colors hover:bg-surface-overlay ${
                  active ? "font-medium text-foreground" : "text-muted"
                }`}
                onClick={() => {
                  setOpen(false);
                  onSelect(level);
                }}
              >
                <span className="min-w-0 flex-1 truncate">{THINKING_LABELS[level]}</span>
                {active && (
                  <span className="flex shrink-0 items-center justify-center">
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
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Brain size={13} className="shrink-0" />
        <span className="whitespace-nowrap">{label}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <span className="whitespace-nowrap text-foreground">{THINKING_LABELS[value]}</span>
          <ChevronRight
            size={13}
            className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
          />
        </span>
      </button>
    </>
  );
}

function SettingRow({
  label,
  description,
  saving,
  children,
}: {
  label: string;
  description: string;
  saving: boolean;
  children: ReactNode;
}) {
  return (
    // flex-wrap + basis on the label stacks the control below the text when the
    // settings column is too narrow for a side-by-side row (container query).
    <div className="flex flex-col items-start gap-2 @min-[40rem]:flex-row @min-[40rem]:items-center @min-[40rem]:justify-between">
      <span className="min-w-0">
        <span className="block text-sm">{label}</span>
        <span className="block text-xs text-muted">{description}</span>
      </span>
      <div className={`min-w-0 max-w-full ${saving ? "opacity-60" : ""}`}>{children}</div>
    </div>
  );
}
