import { useEffect, useState } from "react";
import { Check, Settings2, Wrench } from "lucide-react";
import type { PiSettingsPatch } from "@piabyss/protocol";
import { Dialog, secondaryButton } from "../../components/Dialog";
import { useT } from "../../lib/i18n/use-t";
import type { MessageKey } from "../../lib/i18n";
import { hostClient } from "../../lib/bridge/host-client";
import { hostContext } from "../../lib/bridge/host-context";
import { useAppStore } from "../../lib/stores/app-store";
import { notifyOperationFailure } from "../../lib/notify-operation-error";

/** Built-in tools pi ships; mirrors the SDK's `allToolNames` registry. */
export const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

export type BuiltinTool = (typeof BUILTIN_TOOLS)[number];

/** The SDK default when `defaultTools` is absent from settings.json. */
export const DEFAULT_TOOLS: readonly string[] = ["read", "bash", "edit", "write"];

const TOOL_LABELS: Record<BuiltinTool, MessageKey> = {
  read: "toolRead",
  bash: "toolRun",
  edit: "toolEdit",
  write: "toolWrite",
  grep: "toolGrep",
  find: "toolFind",
  ls: "toolLs",
};

const TOOL_DESCRIPTIONS: Record<BuiltinTool, MessageKey> = {
  read: "generalDefaultToolsReadDesc",
  bash: "generalDefaultToolsBashDesc",
  edit: "generalDefaultToolsEditDesc",
  write: "generalDefaultToolsWriteDesc",
  grep: "generalDefaultToolsGrepDesc",
  find: "generalDefaultToolsFindDesc",
  ls: "generalDefaultToolsLsDesc",
};

/**
 * Normalize a stored `defaultTools` array for the checkbox UI: unknown names are
 * dropped (a newer pi may add tools this build does not know), then order is
 * restored to BUILTIN_TOOLS so the list never reshuffles between saves.
 */
export function normalizeSelectedTools(stored: readonly string[] | undefined): BuiltinTool[] {
  const set = new Set(stored ?? DEFAULT_TOOLS);
  return BUILTIN_TOOLS.filter((tool) => set.has(tool));
}

export function DefaultToolsSetting() {
  const t = useT();
  const host = useAppStore((state) => state.host);
  const [selected, setSelected] = useState<BuiltinTool[]>(() => normalizeSelectedTools(undefined));
  const [draft, setDraft] = useState<BuiltinTool[]>(() => normalizeSelectedTools(undefined));
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);

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
        setSelected(normalizeSelectedTools(response.result.defaultTools));
      })
      .catch((error) => {
        if (!cancelled) notifyOperationFailure(error, String(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [host]);

  function openDialog() {
    // The dialog edits a copy; closing without saving never touches settings.
    setDraft(selected);
    setDialogOpen(true);
  }

  async function save() {
    if (!host || saving) return;
    setSaving(true);
    const previous = selected;
    setSelected(draft);
    setDialogOpen(false);
    try {
      const patch: PiSettingsPatch = { defaultTools: draft };
      const response = await hostClient.request("piSettings.patch", hostContext(host), patch);
      if (!response.ok) throw new Error(response.error.message);
      setSelected(normalizeSelectedTools(response.result.defaultTools));
    } catch (error) {
      setSelected(previous);
      notifyOperationFailure(error, String(error));
    } finally {
      setSaving(false);
    }
  }

  function toggle(tool: BuiltinTool) {
    setDraft((current) =>
      current.includes(tool) ? current.filter((item) => item !== tool) : [...current, tool],
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span className="min-w-0 flex-1 basis-52">
          <span className="block text-sm">{t("generalDefaultTools")}</span>
          <span className="block text-xs text-muted">{t("generalDefaultToolsDesc")}</span>
        </span>
        <button
          type="button"
          className={secondaryButton}
          disabled={loading || saving}
          onClick={openDialog}
        >
          <Settings2 size={14} />
          {selected.length > 0
            ? t("generalDefaultToolsConfigure", { count: selected.length })
            : t("generalDefaultToolsConfigureEmpty")}
        </button>
      </div>
      <p className="text-xs text-muted">{t("generalDefaultToolsRestartHint")}</p>
      {dialogOpen && (
        <Dialog
          title={t("generalDefaultTools")}
          confirmLabel={t("commonSave")}
          icon={Wrench}
          onCancel={() => setDialogOpen(false)}
          onConfirm={() => void save()}
        >
          <div className="flex flex-col gap-2">
            <p className="text-xs">{t("generalDefaultToolsDesc")}</p>
            <div
              className={`flex flex-col gap-1 ${loading ? "pointer-events-none opacity-60" : ""}`}
              role="group"
              aria-label={t("generalDefaultTools")}
            >
              {BUILTIN_TOOLS.map((tool) => {
                const checked = draft.includes(tool);
                return (
                  <label
                    key={tool}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-overlay/60"
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={checked}
                      disabled={loading}
                      onChange={() => toggle(tool)}
                    />
                    <span
                      aria-hidden="true"
                      className={`flex size-3.5 shrink-0 items-center justify-center rounded border ${
                        checked ? "border-accent bg-accent text-surface" : "border-border"
                      }`}
                    >
                      {checked && <Check size={10} strokeWidth={3} />}
                    </span>
                    <span className="w-16 shrink-0 text-xs">{t(TOOL_LABELS[tool])}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">
                      {tool}
                    </span>
                    <span className="min-w-0 max-w-[52%] truncate text-[11px] text-muted">
                      {t(TOOL_DESCRIPTIONS[tool])}
                    </span>
                  </label>
                );
              })}
            </div>
            <p className="text-xs text-muted">{t("generalDefaultToolsRestartHint")}</p>
          </div>
        </Dialog>
      )}
    </div>
  );
}
