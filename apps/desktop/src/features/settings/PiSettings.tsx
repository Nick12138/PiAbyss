import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { PiSettingsPatch, PiSettingsSnapshot, ThinkingLevel } from "@piabyss/protocol";
import { Select } from "../../components/Select";
import { useT } from "../../lib/i18n/use-t";
import type { MessageKey } from "../../lib/i18n";
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

const THINKING_LABELS: Record<ThinkingLevel, MessageKey> = {
  off: "thinkingLevelOff",
  minimal: "thinkingLevelMinimal",
  low: "thinkingLevelLow",
  medium: "thinkingLevelMedium",
  high: "thinkingLevelHigh",
  xhigh: "thinkingLevelXhigh",
  max: "thinkingLevelMax",
};

const DEFAULT_SETTINGS: PiSettingsSnapshot = {
  defaultThinkingLevel: "medium",
  retryMaxRetries: 3,
  defaultProjectTrust: "ask",
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time",
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

  const providers = useMemo(
    () => [...new Set(settings.models.map((model) => model.provider))].sort(),
    [settings.models],
  );
  const selectedProvider = settings.defaultProvider ?? "";
  const modelsForProvider = settings.models.filter((model) => model.provider === selectedProvider);
  const selectedModel = settings.defaultModel ?? "";

  function selectProvider(provider: string) {
    const firstModel = settings.models.find((model) => model.provider === provider);
    if (!firstModel) return;
    void patch("defaultModel", { defaultProvider: provider, defaultModel: firstModel.modelId });
  }

  function selectModel(modelId: string) {
    if (!selectedProvider) return;
    void patch("defaultModel", { defaultProvider: selectedProvider, defaultModel: modelId });
  }

  return (
    <section>
      <h2 className="mb-2 text-sm font-medium text-muted">{t("generalPiSettingsGroup")}</h2>
      <div className="flex flex-col gap-4 rounded-lg border border-border p-4">
        <SettingRow
          label={t("generalDefaultModel")}
          description={t("generalDefaultModelDesc")}
          saving={saving === "defaultModel"}
        >
          <div className="flex min-w-0 gap-1.5">
            <Select
              className="min-w-32 max-w-48"
              ariaLabel={t("generalDefaultProvider")}
              value={selectedProvider}
              disabled={loading || providers.length === 0}
              onChange={selectProvider}
              options={providers.map((provider) => ({
                value: provider,
                label:
                  settings.models.find((model) => model.provider === provider)?.providerName ??
                  provider,
              }))}
            />
            <Select
              className="min-w-44 max-w-64"
              ariaLabel={t("generalDefaultModel")}
              value={selectedModel}
              disabled={loading || modelsForProvider.length === 0}
              onChange={selectModel}
              options={modelsForProvider.map((model) => ({
                value: model.modelId,
                label: model.name,
              }))}
            />
          </div>
        </SettingRow>

        <SettingRow
          label={t("generalDefaultThinkingLevel")}
          description={t("generalDefaultThinkingLevelDesc")}
          saving={saving === "defaultThinkingLevel"}
        >
          <Select
            className="min-w-36"
            ariaLabel={t("generalDefaultThinkingLevel")}
            value={settings.defaultThinkingLevel}
            disabled={loading}
            onChange={(value) =>
              void patch("defaultThinkingLevel", { defaultThinkingLevel: value as ThinkingLevel })
            }
            options={THINKING_LEVELS.map((level) => ({
              value: level,
              label: t(THINKING_LABELS[level]),
            }))}
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
    <div className="flex items-center justify-between gap-4">
      <span className="min-w-0">
        <span className="block text-sm">{label}</span>
        <span className="block text-xs text-muted">{description}</span>
      </span>
      <div className={saving ? "shrink-0 opacity-60" : "shrink-0"}>{children}</div>
    </div>
  );
}
