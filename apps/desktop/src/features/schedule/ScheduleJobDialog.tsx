import { useEffect, useState } from "react";
import { CalendarClock, ChevronDown, ChevronRight, FolderOpen, FileCode } from "lucide-react";
import type { ModelSummary, ScheduleJob } from "@piabyss/protocol";
import { useT } from "../../lib/i18n/use-t";
import { Dialog, primaryButton, secondaryButton } from "../../components/Dialog";
import { Select } from "../../components/Select";
import { Switch } from "../../components/Switch";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { hostContext } from "../../lib/bridge/host-context";
import {
  defaultScheduleForm,
  jobToForm,
  scheduleFormErrors,
  formToJobInput,
  SCHEDULE_MAX_TIMEOUT_MINUTES,
  type ScheduleFormState,
} from "./schedule-model";

const CREATE_TIMEOUT_MS = 15_000;
const MODEL_LIST_TIMEOUT_MS = 15_000;

const MODEL_DEFAULT_VALUE = "__default__";
const CWD_OPEN_VALUE = "__open__";

/** Quote a shell path only when it contains whitespace. */
function quoteIfNeeded(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path;
}

/** Create/edit dialog for a schedule plan. Prompt plans and command plans are
 *  mutually exclusive; command plans skip permission/model (the plugin ignores
 *  them there). */
export function ScheduleJobDialog({
  job,
  onClose,
  onSaved,
  onStartSmart,
}: {
  job: ScheduleJob | null;
  onClose: () => void;
  onSaved: (job: ScheduleJob) => void;
  /** Smart mode: (cwd, requirement) → null on success (the dialog unmounts
   *  as the app navigates to the agent page) or an error message to display. */
  onStartSmart?: (cwd: string, requirement: string) => Promise<string | null>;
}) {
  const t = useT();
  const host = useAppStore((s) => s.host);
  const workspace = useAppStore((s) => s.workspace);
  const knownWorkspaces = useAppStore((s) => s.desktopSettings?.knownWorkspaces);
  const [form, setForm] = useState<ScheduleFormState>(() =>
    job ? jobToForm(job) : defaultScheduleForm(workspace?.cwd ?? ""),
  );
  const [pending, setPending] = useState(false);
  const [mode, setMode] = useState<"smart" | "manual">("smart");
  const [smartCwd, setSmartCwd] = useState(workspace?.cwd ?? "");
  const [smartRequirement, setSmartRequirement] = useState("");
  const [smartPending, setSmartPending] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [cronCheck, setCronCheck] = useState<{ valid: boolean; reason: string | null } | null>(
    null,
  );
  const [cronChecking, setCronChecking] = useState(false);
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [hostDefaultModel, setHostDefaultModel] = useState<{ provider: string; id: string } | null>(
    null,
  );

  // Model list — same source as the settings page's default-model picker:
  // piSettings.get is host-scoped (no active session required) and returns the
  // full ModelRuntime snapshot. The chat model picker's session-scoped
  // model.list needs a live session, which the schedule page can't guarantee.
  useEffect(() => {
    if (!host) return;
    let cancelled = false;
    void hostClient
      .request("piSettings.get", hostContext(host), null, MODEL_LIST_TIMEOUT_MS)
      .then((response) => {
        if (cancelled || !response.ok) return;
        setModels(response.result.models);
        const provider = response.result.defaultProvider;
        const id = response.result.defaultModel;
        if (provider && id) setHostDefaultModel({ provider, id });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [host]);

  function patch(next: Partial<ScheduleFormState>) {
    setSaveError(null);
    setForm((current) => ({ ...current, ...next }));
  }

  const errors = scheduleFormErrors(form);

  async function pickFolderSmart() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ directory: true, defaultPath: smartCwd || undefined });
      if (typeof picked === "string" && picked.length > 0) setSmartCwd(picked);
    } catch {
      /* non-Tauri environment */
    }
  }

  async function pickFolder() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ directory: true, defaultPath: form.cwd || undefined });
      if (typeof picked === "string" && picked.length > 0) patch({ cwd: picked });
    } catch {
      /* non-Tauri environment */
    }
  }

  async function pickScript() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ multiple: false });
      if (typeof picked === "string" && picked.length > 0) {
        const quoted = quoteIfNeeded(picked);
        patch({
          command: form.command.trim() ? `${form.command.trim()}\n${quoted}` : quoted,
        });
      }
    } catch {
      /* non-Tauri environment */
    }
  }

  async function validateCron() {
    if (!host) return;
    setCronChecking(true);
    try {
      const response = await hostClient.request(
        "schedule.validateCron",
        hostContext(host),
        {
          cron: form.cron.trim(),
          ...(form.cronTimezone.trim() ? { timezone: form.cronTimezone.trim() } : {}),
        },
        10_000,
      );
      if (response.ok) {
        setCronCheck({ valid: response.result.valid, reason: response.result.reason });
      } else {
        setCronCheck({ valid: false, reason: response.error?.message ?? null });
      }
    } catch {
      setCronCheck({ valid: false, reason: null });
    } finally {
      setCronChecking(false);
    }
  }

  async function submit() {
    if (!host || pending || Object.keys(errors).length > 0) return;
    const parsed = formToJobInput(form);
    if (!parsed.ok) {
      setSaveError(t(parsed.errorKey));
      return;
    }
    setPending(true);
    setSaveError(null);
    try {
      const response = job
        ? await hostClient.request(
            "schedule.updateJob",
            hostContext(host),
            { id: job.id, ...parsed.input },
            CREATE_TIMEOUT_MS,
          )
        : await hostClient.request(
            "schedule.createJob",
            hostContext(host),
            parsed.input,
            CREATE_TIMEOUT_MS,
          );
      if (response.ok) {
        onSaved(response.result.job);
      } else {
        setSaveError(response.error?.message ?? t("scheduleLoadFailed"));
      }
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : t("scheduleLoadFailed"));
    } finally {
      setPending(false);
    }
  }

  const canSubmit = Object.keys(errors).length === 0 && !pending;

  // Workspace presets: current workspace first, then the known list (deduped).
  const cwdPresets = Array.from(
    new Set([workspace?.cwd, ...(knownWorkspaces ?? [])].filter(Boolean) as string[]),
  );
  const cwdValue = cwdPresets.includes(form.cwd) ? form.cwd : CWD_OPEN_VALUE;

  const defaultModelLabel = hostDefaultModel
    ? t("scheduleModelDefault", {
        name:
          models.find(
            (model) =>
              model.provider === hostDefaultModel.provider &&
              model.modelId === hostDefaultModel.id,
          )?.name ?? `${hostDefaultModel.provider}/${hostDefaultModel.id}`,
      })
    : t("scheduleModelDefaultPlain");
  const modelValue = form.model ? `${form.model.provider}/${form.model.id}` : MODEL_DEFAULT_VALUE;

  return (
    <Dialog
      title={
        job
          ? t("scheduleFormTitleEdit")
          : mode === "smart"
            ? t("scheduleFormTitleSmart")
            : t("scheduleFormTitleNew")
      }
      confirmLabel={t("scheduleFormSave")}
      maxWidthClass="max-w-3xl"
      icon={CalendarClock}
      showCloseIcon
      showCancel={false}
      hideActions
      onCancel={onClose}
      onConfirm={submit}
    >
      <div
        data-testid="schedule-job-form"
        className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto px-1 text-sm"
      >
        {!job && (
          <div className="grid grid-cols-2 gap-2">
            {(["smart", "manual"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                data-state={mode === value ? "active" : "inactive"}
                className={`rounded-md border px-3 py-2 text-left ${
                  mode === value
                    ? "border-accent bg-accent/10"
                    : "border-border hover:bg-surface-overlay"
                }`}
              >
                <div className="text-[13px] font-medium">
                  {value === "smart"
                    ? t("scheduleFormModeSmart")
                    : t("scheduleFormModeManual")}
                </div>
                <div className="text-xs text-muted">
                  {value === "smart"
                    ? t("scheduleFormModeSmartHint")
                    : t("scheduleFormModeManualHint")}
                </div>
              </button>
            ))}
          </div>
        )}

        {mode === "smart" && !job && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted">{t("scheduleFormCwd")}</span>
              <Select
                value={cwdPresets.includes(smartCwd) ? smartCwd : CWD_OPEN_VALUE}
                onChange={(value) => {
                  if (value === CWD_OPEN_VALUE) void pickFolderSmart();
                  else setSmartCwd(value);
                }}
                ariaLabel={t("scheduleFormCwd")}
                options={[
                  ...cwdPresets.map((path) => ({ value: path, label: path })),
                  { value: CWD_OPEN_VALUE, label: t("scheduleFormOpenFolder") },
                ]}
              />
            </div>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted">
                {t("scheduleFormSmartRequirement")}
              </span>
              <textarea
                data-testid="schedule-form-smart-requirement"
                value={smartRequirement}
                onChange={(event) => setSmartRequirement(event.target.value)}
                rows={8}
                placeholder={t("scheduleFormSmartRequirementPlaceholder")}
                className="rounded-md border border-border bg-surface px-2 py-1.5"
              />
            </label>
            {saveError && (
              <span className="text-xs text-danger" data-testid="schedule-smart-error">
                {saveError}
              </span>
            )}
            <div className="flex items-center justify-end gap-2">
              <button type="button" className={secondaryButton} onClick={onClose}>
                {t("scheduleFormCancel")}
              </button>
              <button
                type="button"
                className={primaryButton}
                disabled={smartPending || !smartRequirement.trim() || !smartCwd.trim()}
                onClick={() => {
                  if (!onStartSmart) return;
                  setSmartPending(true);
                  setSaveError(null);
                  void onStartSmart(smartCwd.trim(), smartRequirement.trim())
                    .then((error) => {
                      if (error) setSaveError(error);
                    })
                    .catch((error: unknown) => {
                      setSaveError(
                        error instanceof Error ? error.message : t("scheduleLoadFailed"),
                      );
                    })
                    .finally(() => setSmartPending(false));
                }}
              >
                {smartPending ? t("scheduleAgentAnalyzing") : t("scheduleAgentAnalyze")}
              </button>
            </div>
          </div>
        )}

        {(job || mode === "manual") && (
        <>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">{t("scheduleFormName")}</span>
          <input
            data-testid="schedule-form-name"
            value={form.name}
            onChange={(event) => patch({ name: event.target.value })}
            className="h-8 rounded-md border border-border bg-surface px-2"
          />
          {errors.name && <ErrorLine text={t(errors.name)} />}
        </label>

        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">{t("scheduleFormKind")}</span>
          <div className="grid grid-cols-2 gap-2">
            {(["prompt", "command"] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                onClick={() => patch({ kind })}
                data-state={form.kind === kind ? "active" : "inactive"}
                className={`rounded-md border px-3 py-2 text-left ${
                  form.kind === kind
                    ? "border-accent bg-accent/10"
                    : "border-border hover:bg-surface-overlay"
                }`}
              >
                <div className="text-[13px] font-medium">
                  {kind === "prompt" ? t("scheduleFormKindPrompt") : t("scheduleFormKindCommand")}
                </div>
                <div className="text-xs text-muted">
                  {kind === "prompt"
                    ? t("scheduleFormKindPromptHint")
                    : t("scheduleFormKindCommandHint")}
                </div>
              </button>
            ))}
          </div>
        </div>

        {form.kind === "prompt" ? (
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">{t("scheduleFormPrompt")}</span>
            <textarea
              data-testid="schedule-form-prompt"
              value={form.prompt}
              onChange={(event) => patch({ prompt: event.target.value })}
              rows={5}
              className="rounded-md border border-border bg-surface px-2 py-1.5"
            />
            {errors.prompt && <ErrorLine text={t(errors.prompt)} />}
          </label>
        ) : (
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted">{t("scheduleFormCommand")}</span>
              <button
                type="button"
                className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
                onClick={() => void pickScript()}
              >
                <FileCode size={12} />
                {t("scheduleFormPickScript")}
              </button>
            </div>
            <textarea
              data-testid="schedule-form-command"
              value={form.command}
              onChange={(event) => patch({ command: event.target.value })}
              rows={3}
              className="rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-xs"
            />
            {errors.command && <ErrorLine text={t(errors.command)} />}
          </div>
        )}

        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">{t("scheduleFormCwd")}</span>
          <div className="flex items-center gap-2">
            <Select
              value={cwdValue}
              onChange={(value) => {
                if (value === CWD_OPEN_VALUE) void pickFolder();
                else patch({ cwd: value });
              }}
              ariaLabel={t("scheduleFormCwd")}
              triggerClassName="flex-1"
              options={[
                ...cwdPresets.map((path) => ({ value: path, label: path })),
                { value: CWD_OPEN_VALUE, label: t("scheduleFormOpenFolder") },
              ]}
            />
            <button
              type="button"
              className={secondaryButton}
              aria-label={t("scheduleFormOpenFolder")}
              onClick={() => void pickFolder()}
            >
              <FolderOpen size={13} />
            </button>
          </div>
          {errors.cwd && <ErrorLine text={t(errors.cwd)} />}
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">{t("scheduleFormTrigger")}</span>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ["manual", t("scheduleTriggerManual"), t("scheduleFormTriggerHintManual")],
                ["once", t("scheduleTriggerOnce"), t("scheduleFormTriggerHintOnce")],
                ["interval", t("scheduleTriggerInterval"), t("scheduleFormTriggerHintInterval")],
                ["cron", t("scheduleTriggerCron"), t("scheduleFormTriggerHintCron")],
              ] as const
            ).map(([value, label, hint]) => (
              <button
                key={value}
                type="button"
                onClick={() => patch({ triggerType: value })}
                data-state={form.triggerType === value ? "active" : "inactive"}
                className={`rounded-md border px-3 py-2 text-left ${
                  form.triggerType === value
                    ? "border-accent bg-accent/10"
                    : "border-border hover:bg-surface-overlay"
                }`}
              >
                <div className="text-[13px] font-medium">{label}</div>
                <div className="text-xs text-muted">{hint}</div>
              </button>
            ))}
          </div>

          {form.triggerType === "once" && (
            <div className="flex flex-col gap-1">
              <input
                type="datetime-local"
                value={form.onceAt}
                onChange={(event) => patch({ onceAt: event.target.value })}
                className="h-8 rounded-md border border-border bg-surface px-2"
              />
              {errors.onceAt && <ErrorLine text={t(errors.onceAt)} />}
            </div>
          )}
          {form.triggerType === "interval" && (
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                value={form.intervalValue}
                onChange={(event) => patch({ intervalValue: Number(event.target.value) })}
                className="h-8 w-24 rounded-md border border-border bg-surface px-2"
              />
              <Select
                value={form.intervalUnit}
                onChange={(value) =>
                  patch({ intervalUnit: value as ScheduleFormState["intervalUnit"] })
                }
                ariaLabel={t("scheduleFormIntervalUnit")}
                options={[
                  { value: "s", label: t("scheduleIntervalSeconds") },
                  { value: "m", label: t("scheduleIntervalMinutes") },
                  { value: "h", label: t("scheduleIntervalHours") },
                  { value: "d", label: t("scheduleIntervalDays") },
                  { value: "w", label: t("scheduleIntervalWeeks") },
                  { value: "mo", label: t("scheduleIntervalMonths") },
                ]}
              />
              {errors.interval && <ErrorLine text={t(errors.interval)} />}
            </div>
          )}
          {form.triggerType === "cron" && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <input
                  data-testid="schedule-form-cron"
                  value={form.cron}
                  onChange={(event) => patch({ cron: event.target.value })}
                  className="h-8 flex-1 rounded-md border border-border bg-surface px-2 font-mono"
                  placeholder="0 9 * * 1-5"
                />
                <button
                  type="button"
                  className={secondaryButton}
                  disabled={cronChecking || !form.cron.trim()}
                  onClick={() => void validateCron()}
                >
                  {t("scheduleFormValidateCron")}
                </button>
              </div>
              <input
                value={form.cronTimezone}
                onChange={(event) => patch({ cronTimezone: event.target.value })}
                className="h-8 rounded-md border border-border bg-surface px-2 text-xs"
                placeholder={t("scheduleFormTimezonePlaceholder")}
              />
              {errors.cron && <ErrorLine text={t(errors.cron)} />}
              {cronCheck && (
                <span className={`text-xs ${cronCheck.valid ? "text-success" : "text-danger"}`}>
                  {cronCheck.valid
                    ? t("scheduleFormCronValid")
                    : (cronCheck.reason ?? t("scheduleFormCronInvalid"))}
                </span>
              )}
            </div>
          )}
        </div>

        {form.kind === "prompt" && (
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">{t("scheduleFormModel")}</span>
            {models.length > 0 ? (
              <Select
                value={modelValue}
                onChange={(value) => {
                  if (value === MODEL_DEFAULT_VALUE) patch({ model: null });
                  else {
                    const slash = value.indexOf("/");
                    patch({
                      model: {
                        provider: value.slice(0, slash),
                        id: value.slice(slash + 1),
                      },
                    });
                  }
                }}
                ariaLabel={t("scheduleFormModel")}
                options={[
                  { value: MODEL_DEFAULT_VALUE, label: defaultModelLabel },
                  ...models.map((model) => ({
                    value: `${model.provider}/${model.modelId}`,
                    label: `${model.providerName ?? model.provider} · ${model.name}`,
                  })),
                ]}
              />
            ) : (
              <div className="flex h-8 items-center rounded-md border border-border bg-surface px-2 text-xs text-muted">
                {defaultModelLabel}
              </div>
            )}
          </div>
        )}

        {form.kind === "prompt" && (
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">{t("scheduleFormPermission")}</span>
            <Select
              value={form.permission}
              onChange={(value) => patch({ permission: value as ScheduleFormState["permission"] })}
              ariaLabel={t("scheduleFormPermission")}
              options={[
                { value: "read_only", label: t("schedulePermissionReadOnly") },
                { value: "write", label: t("schedulePermissionWrite") },
                { value: "full", label: t("schedulePermissionFull") },
              ]}
            />
          </div>
        )}

        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">{t("scheduleFormNotify")}</span>
          <Select
            value={form.notify}
            onChange={(value) => patch({ notify: value as ScheduleFormState["notify"] })}
            ariaLabel={t("scheduleFormNotify")}
            options={[
              { value: "none", label: t("scheduleNotifyNone") },
              { value: "system", label: t("scheduleNotifySystem") },
            ]}
          />
        </div>

        {/* Advanced settings (collapsed by default) */}
        <div className="flex flex-col gap-2 rounded-md border border-border p-2">
          <button
            type="button"
            className="flex items-center gap-1.5 text-xs font-medium text-muted hover:text-foreground"
            onClick={() => setAdvancedOpen((open) => !open)}
          >
            {advancedOpen ? (
              <ChevronDown size={13} />
            ) : (
              <ChevronRight size={13} />
            )}
            {t("scheduleFormAdvanced")}
          </button>
          {advancedOpen && (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted">
                    {t("scheduleFormTimeoutMinutes")}
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={SCHEDULE_MAX_TIMEOUT_MINUTES}
                    value={form.timeoutMinutes}
                    onChange={(event) => patch({ timeoutMinutes: Number(event.target.value) })}
                    className="h-8 rounded-md border border-border bg-surface px-2"
                  />
                  {errors.timeout && <ErrorLine text={t(errors.timeout)} />}
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted">{t("scheduleFormMaxRuns")}</span>
                  <input
                    type="number"
                    min={1}
                    value={form.maxRuns}
                    onChange={(event) => patch({ maxRuns: event.target.value })}
                    placeholder={t("scheduleFormMaxRunsPlaceholder")}
                    className="h-8 rounded-md border border-border bg-surface px-2"
                  />
                  {errors.maxRuns && <ErrorLine text={t(errors.maxRuns)} />}
                </label>
              </div>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted">
                  {t("scheduleFormMissedWindow")}
                </span>
                <Select
                  value={form.missedWindow}
                  onChange={(value) =>
                    patch({ missedWindow: value as ScheduleFormState["missedWindow"] })
                  }
                  ariaLabel={t("scheduleFormMissedWindow")}
                  options={[
                    { value: "catch_up_one", label: t("scheduleMissedWindowCatchUp") },
                    { value: "skip", label: t("scheduleMissedWindowSkip") },
                  ]}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted">{t("scheduleFormTags")}</span>
                <input
                  value={form.tags}
                  onChange={(event) => patch({ tags: event.target.value })}
                  placeholder={t("scheduleFormTagsPlaceholder")}
                  className="h-8 rounded-md border border-border bg-surface px-2"
                />
              </label>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Switch
            checked={form.enabled}
            onChange={(enabled) => patch({ enabled })}
            label={t("scheduleFormEnabled")}
          />
          <span className="text-xs text-muted">{t("scheduleFormEnabled")}</span>
        </div>

        <div className="flex items-center justify-between">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {saveError && (
              <span className="text-xs text-danger" data-testid="schedule-form-error">
                {saveError}
              </span>
            )}
          </div>
          <div className="flex shrink-0 gap-2">
            <button type="button" className={secondaryButton} onClick={onClose}>
              {t("scheduleFormCancel")}
            </button>
            <button
              type="button"
              className={primaryButton}
              disabled={!canSubmit}
              onClick={() => void submit()}
            >
              {pending ? t("scheduleSaving") : t("scheduleFormSave")}
            </button>
          </div>
        </div>
        </>
        )}
      </div>
    </Dialog>
  );
}

function ErrorLine({ text }: { text: string }) {
  return <span className="text-xs text-danger">{text}</span>;
}
