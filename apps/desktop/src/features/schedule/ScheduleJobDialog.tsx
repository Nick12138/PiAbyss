import { useEffect, useState, type ReactNode } from "react";
import {
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Clock,
  FileCode,
  FolderOpen,
  Hand,
  Info,
  Loader2,
  RotateCw,
  Settings2,
  Sparkles,
  Terminal,
  type LucideIcon,
} from "lucide-react";
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

/** Shared control styling for every input/textarea in the form, so the fields
 *  keep one height, one radius and one focus treatment. */
const fieldClass =
  "box-border w-full rounded-md border border-border bg-surface px-2.5 text-[13px] text-foreground outline-none transition-colors placeholder:text-muted focus:border-focus";
const inputClass = `${fieldClass} interface-density-control`;
const textareaClass =
  "box-border w-full rounded-md border border-border bg-surface px-2.5 text-[12px] text-foreground outline-none transition-colors placeholder:text-muted focus:border-focus py-1.5 leading-[1.7]";

/** Section wrapper: a labelled block with an optional one-line description. */
function FormSection({
  title,
  description,
  headerExtra,
  children,
}: {
  title: string;
  description?: string;
  /** Optional content pinned to the right edge of the header row. */
  headerExtra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 border-b border-border-subtle px-4 py-4 last:border-b-0 [&:has(+.schedule-form-footer)]:border-b-0">
      <header className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-[13px] font-semibold">{title}</h3>
          {description && <p className="text-xs leading-4 text-muted">{description}</p>}
        </div>
        {headerExtra && <div className="shrink-0">{headerExtra}</div>}
      </header>
      {children}
    </section>
  );
}

/** Labelled field row: label above, control below, error underneath. */
function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted">{label}</span>
        {hint}
      </span>
      {children}
      {error && <span className="text-xs text-danger">{error}</span>}
    </label>
  );
}

/** Settings-style row: text on the left, control pinned to the right edge. */
function FieldRow({
  label,
  description,
  error,
  children,
}: {
  label: string;
  description?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="min-w-0">
        <span className="block text-sm">{label}</span>
        {description && (
          <span className="block text-xs leading-4 text-muted">{description}</span>
        )}
        {error && <span className="block text-xs text-danger">{error}</span>}
      </span>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

/** One trigger chip; the selected chip expands its own editor below the row. */
function TriggerChip({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-state={active ? "active" : "inactive"}
      className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border px-2 py-2 text-xs font-medium transition-colors ${
        active
          ? "border-accent bg-accent/10 text-accent"
          : "border-border text-muted hover:bg-surface-overlay hover:text-foreground"
      }`}
    >
      <Icon size={13} aria-hidden="true" />
      {label}
    </button>
  );
}

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
              model.provider === hostDefaultModel.provider && model.modelId === hostDefaultModel.id,
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
      maxWidthClass="max-w-2xl"
      icon={CalendarClock}
      showCloseIcon
      showCancel={false}
      hideActions
      headerExtra={
        !job && (
          <div
            data-ui="segmented"
            role="group"
            aria-label={t("scheduleFormModeGroup")}
            className="interface-density-control grid shrink-0 grid-cols-2 overflow-hidden rounded-md border border-border bg-surface"
          >
            {(["smart", "manual"] as const).map((value, index) => (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                aria-pressed={mode === value}
                data-ui="segmented-item"
                data-state={mode === value ? "active" : "inactive"}
                title={
                  value === "smart"
                    ? t("scheduleFormModeSmartHint")
                    : t("scheduleFormModeManualHint")
                }
                className={`inline-flex h-full min-w-16 items-center justify-center gap-1.5 px-2.5 text-xs transition-colors ${
                  index > 0 ? "border-l border-border" : ""
                } ${
                  mode === value
                    ? "bg-selection font-medium text-selection-foreground"
                    : "text-muted hover:bg-surface-overlay/70 hover:text-foreground"
                }`}
              >
                {value === "smart" ? (
                  <Sparkles size={12} aria-hidden="true" />
                ) : (
                  <Settings2 size={12} aria-hidden="true" />
                )}
                {value === "smart" ? t("scheduleFormModeSmart") : t("scheduleFormModeManual")}
              </button>
            ))}
          </div>
        )
      }
      onCancel={onClose}
      onConfirm={submit}
    >
      <div
        data-testid="schedule-job-form"
        className="flex max-h-[72vh] flex-col overflow-y-auto overscroll-contain"
      >
        {mode === "smart" && !job && (
          <>
            <FormSection
              title={t("scheduleFormModeSmart")}
              description={t("scheduleFormModeSmartHint")}
            >
              <div className="flex items-start gap-2.5 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2.5">
                <Info size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
                <p className="text-xs leading-5 text-muted">{t("scheduleFormSmartFlowHint")}</p>
              </div>

              <Field label={t("scheduleFormCwd")}>
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
              </Field>

              <Field label={t("scheduleFormSmartRequirement")}>
                <textarea
                  data-testid="schedule-form-smart-requirement"
                  value={smartRequirement}
                  onChange={(event) => setSmartRequirement(event.target.value)}
                  rows={7}
                  placeholder={t("scheduleFormSmartRequirementPlaceholder")}
                  className={textareaClass}
                />
              </Field>

              {saveError && (
                <span className="text-xs text-danger" data-testid="schedule-smart-error">
                  {saveError}
                </span>
              )}
            </FormSection>

            {/* Sticky footer: the submit action never scrolls out of reach. */}
            <div className="schedule-form-footer sticky bottom-0 flex items-center justify-end gap-2 px-4 py-3">
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
                {smartPending ? (
                  <>
                    <Loader2 size={13} className="animate-spin" />
                    {t("scheduleAgentAnalyzing")}
                  </>
                ) : (
                  <>
                    <Sparkles size={13} />
                    {t("scheduleAgentAnalyze")}
                  </>
                )}
              </button>
            </div>
          </>
        )}

        {(job || mode === "manual") && (
          <>
            {/* ① Basics: identity, kind, payload, working directory. */}
            <FormSection
              title={t("scheduleFormSectionBasics")}
              description={t("scheduleFormSectionBasicsDesc")}
              headerExtra={
                <div className="flex items-center gap-2">
                  <Switch
                    checked={form.enabled}
                    onChange={(enabled) => patch({ enabled })}
                    label={t("scheduleFormEnabled")}
                  />
                  <span className="text-[13px] font-medium text-foreground">
                    {t("scheduleFormEnabled")}
                  </span>
                </div>
              }
            >
              <FieldRow label={t("scheduleFormName")} error={errors.name && t(errors.name)}>
                <input
                  data-testid="schedule-form-name"
                  value={form.name}
                  onChange={(event) => patch({ name: event.target.value })}
                  className={`${inputClass} w-64`}
                />
              </FieldRow>

              <FieldRow label={t("scheduleFormKind")}>
                <TriggerChip
                  active={form.kind === "prompt"}
                  icon={Sparkles}
                  label={t("scheduleFormKindPrompt")}
                  onClick={() => patch({ kind: "prompt" })}
                />
                <TriggerChip
                  active={form.kind === "command"}
                  icon={Terminal}
                  label={t("scheduleFormKindCommand")}
                  onClick={() => patch({ kind: "command" })}
                />
              </FieldRow>

              {form.kind === "prompt" ? (
                <Field label={t("scheduleFormPrompt")} error={errors.prompt && t(errors.prompt)}>
                  <textarea
                    data-testid="schedule-form-prompt"
                    value={form.prompt}
                    onChange={(event) => patch({ prompt: event.target.value })}
                    rows={5}
                    className={textareaClass}
                  />
                </Field>
              ) : (
                <Field
                  label={t("scheduleFormCommand")}
                  error={errors.command && t(errors.command)}
                  hint={
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
                      onClick={(event) => {
                        event.preventDefault();
                        void pickScript();
                      }}
                    >
                      <FileCode size={12} />
                      {t("scheduleFormPickScript")}
                    </button>
                  }
                >
                  <textarea
                    data-testid="schedule-form-command"
                    value={form.command}
                    onChange={(event) => patch({ command: event.target.value })}
                    rows={3}
                    className={`${textareaClass} font-mono text-xs`}
                  />
                </Field>
              )}

              <FieldRow label={t("scheduleFormCwd")} error={errors.cwd && t(errors.cwd)}>
                <Select
                  value={cwdValue}
                  onChange={(value) => {
                    if (value === CWD_OPEN_VALUE) void pickFolder();
                    else patch({ cwd: value });
                  }}
                  ariaLabel={t("scheduleFormCwd")}
                  className="w-64"
                  triggerClassName="w-full"
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
              </FieldRow>
            </FormSection>

            {/* ② Trigger: a chip row, with only the selected editor expanded. */}
            <FormSection title={t("scheduleFormTrigger")}>
              <div className="flex items-center gap-1.5">
                {(
                  [
                    ["manual", t("scheduleTriggerManual"), Hand],
                    ["once", t("scheduleTriggerOnce"), Clock],
                    ["interval", t("scheduleTriggerInterval"), RotateCw],
                    ["cron", t("scheduleTriggerCron"), CalendarClock],
                  ] as const
                ).map(([value, label, icon]) => (
                  <TriggerChip
                    key={value}
                    active={form.triggerType === value}
                    icon={icon}
                    label={label}
                    onClick={() => patch({ triggerType: value })}
                  />
                ))}
              </div>

              <p className="text-xs leading-4 text-muted">
                {form.triggerType === "manual"
                  ? t("scheduleFormTriggerHintManual")
                  : form.triggerType === "once"
                    ? t("scheduleFormTriggerHintOnce")
                    : form.triggerType === "interval"
                      ? t("scheduleFormTriggerHintInterval")
                      : t("scheduleFormTriggerHintCron")}
              </p>

              {form.triggerType === "once" && (
                <FieldRow
                  label={t("scheduleTriggerOnce")}
                  error={errors.onceAt && t(errors.onceAt)}
                >
                  <input
                    type="datetime-local"
                    value={form.onceAt}
                    onChange={(event) => patch({ onceAt: event.target.value })}
                    className={`${inputClass} w-56`}
                  />
                </FieldRow>
              )}

              {form.triggerType === "interval" && (
                <FieldRow
                  label={t("scheduleTriggerInterval")}
                  error={errors.interval && t(errors.interval)}
                >
                  <input
                    type="number"
                    min={1}
                    value={form.intervalValue}
                    onChange={(event) => patch({ intervalValue: Number(event.target.value) })}
                    className={`${inputClass} w-20 text-right`}
                  />
                  <Select
                    value={form.intervalUnit}
                    onChange={(value) =>
                      patch({ intervalUnit: value as ScheduleFormState["intervalUnit"] })
                    }
                    ariaLabel={t("scheduleFormIntervalUnit")}
                    triggerClassName="w-32"
                    options={[
                      { value: "s", label: t("scheduleIntervalSeconds") },
                      { value: "m", label: t("scheduleIntervalMinutes") },
                      { value: "h", label: t("scheduleIntervalHours") },
                      { value: "d", label: t("scheduleIntervalDays") },
                      { value: "w", label: t("scheduleIntervalWeeks") },
                      { value: "mo", label: t("scheduleIntervalMonths") },
                    ]}
                  />
                </FieldRow>
              )}

              {form.triggerType === "cron" && (
                <>
                  <FieldRow
                    label={t("scheduleTriggerCron")}
                    description={
                      <button
                        type="button"
                        className="text-xs text-accent hover:underline disabled:cursor-not-allowed disabled:opacity-40"
                        disabled={cronChecking || !form.cron.trim()}
                        onClick={(event) => {
                          event.preventDefault();
                          void validateCron();
                        }}
                      >
                        {cronChecking
                          ? t("scheduleFormValidating")
                          : t("scheduleFormValidateCron")}
                      </button>
                    }
                    error={errors.cron && t(errors.cron)}
                  >
                    <input
                      data-testid="schedule-form-cron"
                      value={form.cron}
                      onChange={(event) => patch({ cron: event.target.value })}
                      className={`${inputClass} w-56 font-mono`}
                      placeholder="0 9 * * 1-5"
                    />
                  </FieldRow>
                  <FieldRow label={t("scheduleFormTimezone")}>
                    <input
                      value={form.cronTimezone}
                      onChange={(event) => patch({ cronTimezone: event.target.value })}
                      className={`${inputClass} w-56`}
                      placeholder={t("scheduleFormTimezonePlaceholder")}
                    />
                  </FieldRow>
                  {cronCheck && (
                    <p
                      className={`text-xs ${cronCheck.valid ? "text-success" : "text-danger"}`}
                    >
                      {cronCheck.valid
                        ? t("scheduleFormCronValid")
                        : (cronCheck.reason ?? t("scheduleFormCronInvalid"))}
                    </p>
                  )}
                </>
              )}
            </FormSection>

            {/* ③ Execution config: model/permission (prompt only) + push. */}
            <FormSection title={t("scheduleFormSectionExecution")}>
              {form.kind === "prompt" && (
                <>
                  <FieldRow label={t("scheduleFormModel")}>
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
                        className="min-w-56 max-w-72"
                        triggerClassName="w-full"
                        options={[
                          { value: MODEL_DEFAULT_VALUE, label: defaultModelLabel },
                          ...models.map((model) => ({
                            value: `${model.provider}/${model.modelId}`,
                            label: model.name || model.modelId,
                            group: model.providerName || model.provider,
                          })),
                        ]}
                      />
                    ) : (
                      <div className={`${inputClass} flex w-56 items-center text-muted`}>
                        {defaultModelLabel}
                      </div>
                    )}
                  </FieldRow>

                  <FieldRow label={t("scheduleFormPermission")}>
                    <Select
                      value={form.permission}
                      onChange={(value) =>
                        patch({ permission: value as ScheduleFormState["permission"] })
                      }
                      ariaLabel={t("scheduleFormPermission")}
                      triggerClassName="w-40"
                      options={[
                        { value: "read_only", label: t("schedulePermissionReadOnly") },
                        { value: "write", label: t("schedulePermissionWrite") },
                        { value: "full", label: t("schedulePermissionFull") },
                      ]}
                    />
                  </FieldRow>
                </>
              )}

              <FieldRow label={t("scheduleFormNotify")}>
                <Select
                  value={form.notify}
                  onChange={(value) => patch({ notify: value as ScheduleFormState["notify"] })}
                  ariaLabel={t("scheduleFormNotify")}
                  triggerClassName="w-40"
                  options={[
                    { value: "none", label: t("scheduleNotifyNone") },
                    { value: "system", label: t("scheduleNotifySystem") },
                  ]}
                />
              </FieldRow>
            </FormSection>

            {/* ④ Advanced: collapsed by default. */}
            <FormSection title={t("scheduleFormSectionAdvanced")}>
              <button
                type="button"
                className="flex w-full items-center gap-1.5 text-xs font-medium text-muted transition-colors hover:text-foreground"
                onClick={() => setAdvancedOpen((open) => !open)}
              >
                {advancedOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                {t("scheduleFormAdvanced")}
              </button>
              {advancedOpen && (
                <div className="flex flex-col gap-3 pt-1">
                  <FieldRow
                    label={t("scheduleFormTimeoutMinutes")}
                    error={errors.timeout && t(errors.timeout)}
                  >
                    <input
                      type="number"
                      min={1}
                      max={SCHEDULE_MAX_TIMEOUT_MINUTES}
                      value={form.timeoutMinutes}
                      onChange={(event) => patch({ timeoutMinutes: Number(event.target.value) })}
                      className={`${inputClass} w-20 text-right`}
                    />
                  </FieldRow>
                  <FieldRow
                    label={t("scheduleFormMaxRuns")}
                    error={errors.maxRuns && t(errors.maxRuns)}
                  >
                    <input
                      type="number"
                      min={1}
                      value={form.maxRuns}
                      onChange={(event) => patch({ maxRuns: event.target.value })}
                      placeholder={t("scheduleFormMaxRunsPlaceholder")}
                      className={`${inputClass} w-20 text-right`}
                    />
                  </FieldRow>
                  <FieldRow label={t("scheduleFormMissedWindow")}>
                    <Select
                      value={form.missedWindow}
                      onChange={(value) =>
                        patch({ missedWindow: value as ScheduleFormState["missedWindow"] })
                      }
                      ariaLabel={t("scheduleFormMissedWindow")}
                      triggerClassName="w-40"
                      options={[
                        { value: "catch_up_one", label: t("scheduleMissedWindowCatchUp") },
                        { value: "skip", label: t("scheduleMissedWindowSkip") },
                      ]}
                    />
                  </FieldRow>
                  <FieldRow label={t("scheduleFormTags")}>
                    <input
                      value={form.tags}
                      onChange={(event) => patch({ tags: event.target.value })}
                      placeholder={t("scheduleFormTagsPlaceholder")}
                      className={`${inputClass} w-56`}
                    />
                  </FieldRow>
                </div>
              )}
            </FormSection>

            {/* Sticky footer: actions on the right. */}
            <div className="schedule-form-footer sticky bottom-0 flex items-center gap-3 px-4 py-3">
              <div className="ml-auto flex min-w-0 items-center gap-3">
                {saveError && (
                  <span
                    className="min-w-0 truncate text-xs text-danger"
                    data-testid="schedule-form-error"
                    title={saveError}
                  >
                    {saveError}
                  </span>
                )}
                <button type="button" className={secondaryButton} onClick={onClose}>
                  {t("scheduleFormCancel")}
                </button>
                <button
                  type="button"
                  className={primaryButton}
                  disabled={!canSubmit}
                  onClick={() => void submit()}
                >
                  {pending ? (
                    <>
                      <Loader2 size={13} className="animate-spin" />
                      {t("scheduleSaving")}
                    </>
                  ) : (
                    t("scheduleFormSave")
                  )}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
