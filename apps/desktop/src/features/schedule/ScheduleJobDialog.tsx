import { useEffect, useState, type ReactNode } from "react";
import {
  Bot,
  Brain,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  FileCode,
  FolderOpen,
  Info,
  Loader2,
  Settings2,
  Sparkles,
  Terminal,
} from "lucide-react";
import type { ModelSummary, ScheduleJob } from "@piabyss/protocol";
import { useT } from "../../lib/i18n/use-t";
import { Dialog, primaryButton, secondaryButton } from "../../components/Dialog";
import { Select } from "../../components/Select";
import { Switch } from "../../components/Switch";
import { useAppStore } from "../../lib/stores/app-store";
import type { ScheduleModelChoice } from "./schedule-agent-flow";
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
 *  keep one height, one radius and one focus treatment. Note: no width here —
 *  callers pick w-full (default) or a fixed width. */
const fieldClass =
  "box-border rounded-md border border-border bg-surface px-2.5 text-[13px] text-foreground outline-none transition-colors placeholder:text-muted focus:border-focus";
const inputClass = `${fieldClass} interface-density-control w-full`;
const textareaClass =
  "box-border w-full rounded-md border border-border bg-surface px-2.5 text-[12px] text-foreground outline-none transition-colors placeholder:text-muted focus:border-focus py-1.5 leading-[1.7]";
/** Borderless textarea for embedding inside a shared-border container whose
 *  toolbar row (cwd/permission/model) lives directly underneath it. */
const bareTextareaClass =
  "box-border w-full resize-y bg-transparent px-3 py-2.5 text-[12px] leading-[1.7] text-foreground outline-none placeholder:text-muted";

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

/** Labelled field row: label above, control below. Required-field errors are
 *  signalled with a red asterisk (hover for the reason) instead of a text
 *  message, so the form stays quiet. */
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
        <span className="flex items-center gap-1 text-xs font-medium text-muted">
          {label}
          {error && (
            <span className="text-sm leading-none text-danger" title={error}>
              *
            </span>
          )}
        </span>
        {hint}
      </span>
      {children}
    </label>
  );
}

/** Preferred default thinking depth: "high" when available, else the deepest
 *  advertised level ("medium" when nothing is known). */
function defaultThinkingLevel(levels: string[]): string {
  if (levels.includes("high")) return "high";
  return levels[levels.length - 1] ?? "medium";
}

/** Model picker with an embedded thinking-depth submenu (menu footer). Shared
 *  by the manual form's toolbar and the smart form. `value === null` selects
 *  the host default; picking a depth while on the host default pins the
 *  current default model so the level has something to attach to. */
function ModelSelectWithThinking({
  value,
  onChange,
  models,
  hostDefault,
  defaultLabel,
  label,
  ghost = false,
  className,
  /** Show “model name + thinking depth” on the trigger (smart form). */
  depthInTrigger = false,
}: {
  value: ScheduleModelChoice;
  onChange: (next: ScheduleModelChoice) => void;
  models: ModelSummary[];
  hostDefault: { provider: string; id: string } | null;
  defaultLabel: string;
  label: string;
  ghost?: boolean;
  className?: string;
  depthInTrigger?: boolean;
}) {
  const t = useT();
  const [thinkingOpen, setThinkingOpen] = useState(false);

  // Effective model: the explicit selection, or the host default when none is
  // chosen. Its catalog entry provides the available thinking levels.
  const effectiveRef = value ?? hostDefault;
  const catalog =
    models.find(
      (model) =>
        effectiveRef &&
        model.provider === effectiveRef.provider &&
        model.modelId === effectiveRef.id,
    ) ?? null;
  const levels = catalog?.thinkingLevels ?? [];
  const thinkingValue = value?.thinkingLevel ?? defaultThinkingLevel(levels);

  // Default depth is "high": write it into the choice as soon as a concrete
  // model is selected, so the stored value always matches what's displayed
  // and what actually runs.
  useEffect(() => {
    if (value && !value.thinkingLevel && levels.length > 0) {
      onChange({ ...value, thinkingLevel: defaultThinkingLevel(levels) });
    }
  });
  // Trigger text with the effective depth appended (smart form): the menu
  // itself keeps plain model names — the depth lives in the footer row.
  const triggerLabel =
    depthInTrigger && levels.length > 0
      ? `${catalog ? catalog.name || catalog.modelId : defaultLabel} ${thinkingValue}`
      : undefined;

  return (
    <Select
      value={value ? `${value.provider}/${value.id}` : MODEL_DEFAULT_VALUE}
      onChange={(next) => {
        if (next === MODEL_DEFAULT_VALUE) {
          onChange(null);
          return;
        }
        const slash = next.indexOf("/");
        onChange({ provider: next.slice(0, slash), id: next.slice(slash + 1) });
      }}
      ariaLabel={label}
      className={className}
      triggerClassName="w-full"
      ghost={ghost}
      selectedLabel={triggerLabel}
      options={[
        { value: MODEL_DEFAULT_VALUE, label: defaultLabel },
        ...models.map((model) => ({
          value: `${model.provider}/${model.modelId}`,
          label: model.name || model.modelId,
          group: model.providerName || model.provider,
        })),
      ]}
      footer={
        levels.length > 0 && effectiveRef ? (
          <div className="relative border-t border-border">
            {thinkingOpen && (
              <div
                role="menu"
                aria-label={t("modelThinkingDepth")}
                className="theme-solid-panel absolute bottom-full left-0 right-0 z-10 max-h-44 overflow-y-auto rounded-md border border-border py-1 shadow-lg"
              >
                {levels.map((level) => {
                  const active = level === thinkingValue;
                  return (
                    <button
                      key={level}
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      className={`flex h-8 w-full items-center gap-1.5 px-2.5 text-left text-xs transition-colors hover:bg-surface-overlay ${
                        active ? "font-medium text-foreground" : "text-muted"
                      }`}
                      onClick={() => {
                        onChange({
                          provider: effectiveRef.provider,
                          id: effectiveRef.id,
                          thinkingLevel: level,
                        });
                        setThinkingOpen(false);
                      }}
                    >
                      <span className="whitespace-nowrap">{level}</span>
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
              aria-expanded={thinkingOpen}
              className="flex h-8 w-full items-center gap-1.5 rounded-b-md px-2.5 text-left text-xs text-muted transition-colors hover:bg-surface-overlay hover:text-foreground"
              onClick={() => setThinkingOpen((current) => !current)}
            >
              <Brain size={13} className="shrink-0" aria-hidden="true" />
              <span className="whitespace-nowrap">{t("modelThinkingDepth")}</span>
              <span className="ml-auto flex shrink-0 items-center gap-1">
                <span className="whitespace-nowrap text-foreground">
                  {thinkingValue}
                </span>
                <ChevronRight
                  size={13}
                  className={`shrink-0 transition-transform ${
                    thinkingOpen ? "rotate-90" : ""
                  }`}
                  aria-hidden="true"
                />
              </span>
            </button>
          </div>
        ) : undefined
      }
    />
  );
}

/** Quote a shell path only when it contains whitespace. */
function quoteIfNeeded(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path;
}

/** Create/edit dialog for a schedule plan. Prompt plans and command plans are
 *  mutually exclusive; command plans skip permission/model (the plugin ignores
 *  them there).
 *
 *  `prefill` (with `job === null`) opens the manual form prefilled. With
 *  `onSaveDraft` the save button only hands the validated form back to the
 *  caller — no job is created (the smart-creation preview's manual edit);
 *  without it the save creates the plan through schedule.createJob. */
export function ScheduleJobDialog({
  job,
  prefill,
  onClose,
  onSaved,
  onSaveDraft,
  onOptimize,
  onStartSmart,
}: {
  job: ScheduleJob | null;
  /** Manual-form initial values when creating without an existing job. */
  prefill?: ScheduleFormState;
  onClose: () => void;
  /** Called after the plan was actually created/updated on the host. */
  onSaved?: (job: ScheduleJob) => void;
  /** Draft-only mode: submit returns the validated form instead of creating
   *  a job — the caller decides what "saving" means. */
  onSaveDraft?: (form: ScheduleFormState) => void;
  /** AI-optimize an existing plan: (job) → null on success (the dialog
   *  unmounts as the app navigates to the agent page) or an error message. */
  onOptimize?: (job: ScheduleJob) => Promise<string | null>;
  /** Smart mode: (cwd, requirement) → null on success (the dialog unmounts
   *  as the app navigates to the agent page) or an error message to display. */
  onStartSmart?: (
    cwd: string,
    requirement: string,
    model: ScheduleModelChoice,
  ) => Promise<string | null>;
}) {
  const t = useT();
  const host = useAppStore((s) => s.host);
  const workspace = useAppStore((s) => s.workspace);
  const knownWorkspaces = useAppStore((s) => s.desktopSettings?.knownWorkspaces);
  const prefilled = !job && prefill !== undefined;
  const [form, setForm] = useState<ScheduleFormState>(() =>
    job
      ? jobToForm(job)
      : (prefill ?? defaultScheduleForm(workspace?.cwd ?? "")),
  );
  const [pending, setPending] = useState(false);
  const [mode, setMode] = useState<"smart" | "manual">(prefilled ? "manual" : "smart");
  const [smartCwd, setSmartCwd] = useState(workspace?.cwd ?? "");
  const [smartRequirement, setSmartRequirement] = useState("");
  const [smartPending, setSmartPending] = useState(false);
  const [smartModel, setSmartModel] = useState<ScheduleModelChoice>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [optimizePending, setOptimizePending] = useState(false);
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
    if (pending || Object.keys(errors).length > 0) return;
    const parsed = formToJobInput(form);
    if (!parsed.ok) {
      setSaveError(t(parsed.errorKey));
      return;
    }
    // Draft-only mode: hand the validated form back without touching the
    // host — the plan is created exclusively by the preview's 确认创建.
    if (!job && onSaveDraft) {
      onSaveDraft(form);
      onClose();
      return;
    }
    if (!host) return;
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
        onSaved?.(response.result.job);
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
  // Human-readable one-line summary of the current trigger, shown at the right
  // edge of the trigger sentence row.
  const intervalUnitLabels: Record<ScheduleFormState["intervalUnit"], string> = {
    s: t("scheduleIntervalSeconds"),
    m: t("scheduleIntervalMinutes"),
    h: t("scheduleIntervalHours"),
    d: t("scheduleIntervalDays"),
    w: t("scheduleIntervalWeeks"),
    mo: t("scheduleIntervalMonths"),
  };
  const triggerSummary =
    form.triggerType === "manual"
      ? t("scheduleFormTriggerHintManual")
      : form.triggerType === "once"
        ? (() => {
            if (form.onceAt) {
              const date = new Date(form.onceAt);
              if (!Number.isNaN(date.getTime())) return date.toLocaleString();
            }
            return t("scheduleFormTriggerHintOnce");
          })()
        : form.triggerType === "interval"
          ? t("scheduleFormEverySummary", {
              value: String(form.intervalValue),
              unit: intervalUnitLabels[form.intervalUnit],
            })
          : cronCheck
            ? cronCheck.valid
              ? t("scheduleFormCronValid")
              : (cronCheck.reason ?? t("scheduleFormCronInvalid"))
            : t("scheduleFormTriggerHintCron");

  return (
    <Dialog
      title={
        job || prefilled
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
        job ? (
          onOptimize ? (
            <button
              type="button"
              data-testid="schedule-form-optimize"
              className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border bg-surface px-2 text-xs text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              title={t("scheduleAgentOptimizeHint")}
              disabled={optimizePending}
              onClick={() => {
                if (!onOptimize) return;
                setOptimizePending(true);
                setSaveError(null);
                void onOptimize(job)
                  .then((error) => {
                    if (error) setSaveError(error);
                  })
                  .catch((error: unknown) => {
                    setSaveError(
                      error instanceof Error ? error.message : t("scheduleLoadFailed"),
                    );
                  })
                  .finally(() => setOptimizePending(false));
              }}
            >
              {optimizePending ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Bot size={12} aria-hidden="true" />
              )}
              {t("scheduleAgentOptimize")}
            </button>
          ) : undefined
        ) : (
          !prefilled && (
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

              {/* Model for the smart-analysis session (default = host default). */}
              <Field label={t("scheduleFormAnalysisModel")}>
                {models.length > 0 ? (
                  <ModelSelectWithThinking
                    value={smartModel}
                    onChange={setSmartModel}
                    models={models}
                    hostDefault={hostDefaultModel}
                    defaultLabel={defaultModelLabel}
                    label={t("scheduleFormAnalysisModel")}
                    depthInTrigger
                  />
                ) : (
                  <div className={`${inputClass} flex items-center text-muted`}>
                    {defaultModelLabel}
                  </div>
                )}
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
                  // Default depth is "high": fill it in when the user never
                  // touched the picker, and pin the host default model so the
                  // level has a concrete ref to attach to.
                  const effectiveSmartModel: ScheduleModelChoice = smartModel
                    ? { ...smartModel, thinkingLevel: smartModel.thinkingLevel ?? "high" }
                    : hostDefaultModel
                      ? { ...hostDefaultModel, thinkingLevel: "high" }
                      : null;
                  void onStartSmart(smartCwd.trim(), smartRequirement.trim(), effectiveSmartModel)
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
            {/* Flat vertical flow — no section boxes: name → trigger sentence →
                content editor → more options. */}
            <div className="flex flex-col gap-5 px-5 py-5">
              <Field label={t("scheduleFormName")} error={errors.name && t(errors.name)}>
                <input
                  data-testid="schedule-form-name"
                  value={form.name}
                  onChange={(event) => patch({ name: event.target.value })}
                  placeholder={t("scheduleFormNamePlaceholder")}
                  className={inputClass}
                />
              </Field>

              {/* Trigger as a sentence: [type ▾] …inline parts… —— live summary. */}
              <Field
                label={t("scheduleFormTrigger")}
                error={
                  form.triggerType === "once"
                    ? errors.onceAt && t(errors.onceAt)
                    : form.triggerType === "interval"
                      ? errors.interval && t(errors.interval)
                      : form.triggerType === "cron"
                        ? errors.cron && t(errors.cron)
                        : undefined
                }
              >
                <>
                  <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-2 transition-colors focus-within:border-focus">
                    <Select
                      value={form.triggerType}
                      onChange={(value) =>
                        patch({ triggerType: value as ScheduleFormState["triggerType"] })
                      }
                      ariaLabel={t("scheduleFormTrigger")}
                      className="shrink-0"
                      triggerClassName="w-28"
                      options={[
                        { value: "manual", label: t("scheduleTriggerManual") },
                        { value: "once", label: t("scheduleTriggerOnce") },
                        { value: "interval", label: t("scheduleTriggerInterval") },
                        { value: "cron", label: t("scheduleTriggerCron") },
                      ]}
                    />

                    {form.triggerType === "once" && (
                      <>
                        <span className="text-xs text-muted">{t("scheduleFormAt")}</span>
                        <input
                          type="datetime-local"
                          value={form.onceAt}
                          onChange={(event) => patch({ onceAt: event.target.value })}
                          className={`${fieldClass} interface-density-control w-64 shrink-0`}
                        />
                      </>
                    )}

                    {form.triggerType === "interval" && (
                      <>
                        <span className="text-xs text-muted">{t("scheduleFormEveryPrefix")}</span>
                        <input
                          type="number"
                          min={1}
                          value={form.intervalValue}
                          onChange={(event) =>
                            patch({ intervalValue: Number(event.target.value) })
                          }
                          className={`${fieldClass} interface-density-control w-20 shrink-0 text-right`}
                        />
                        <Select
                          value={form.intervalUnit}
                          onChange={(value) =>
                            patch({ intervalUnit: value as ScheduleFormState["intervalUnit"] })
                          }
                          ariaLabel={t("scheduleFormIntervalUnit")}
                          className="shrink-0"
                          triggerClassName="w-28"
                          options={[
                            { value: "s", label: t("scheduleIntervalSeconds") },
                            { value: "m", label: t("scheduleIntervalMinutes") },
                            { value: "h", label: t("scheduleIntervalHours") },
                            { value: "d", label: t("scheduleIntervalDays") },
                            { value: "w", label: t("scheduleIntervalWeeks") },
                            { value: "mo", label: t("scheduleIntervalMonths") },
                          ]}
                        />
                      </>
                    )}

                    {form.triggerType === "cron" && (
                      <>
                        <input
                          data-testid="schedule-form-cron"
                          value={form.cron}
                          onChange={(event) => patch({ cron: event.target.value })}
                          className={`${fieldClass} interface-density-control w-44 shrink-0 font-mono`}
                          placeholder="0 9 * * 1-5"
                        />
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
                      </>
                    )}

                    <span
                      className="ml-auto min-w-0 max-w-[45%] truncate text-xs text-muted"
                      title={triggerSummary}
                    >
                      {triggerSummary}
                    </span>
                  </div>
                  {form.triggerType === "cron" && cronCheck && (
                    <span
                      className={`text-xs ${cronCheck.valid ? "text-success" : "text-danger"}`}
                    >
                      {cronCheck.valid
                        ? t("scheduleFormCronValid")
                        : (cronCheck.reason ?? t("scheduleFormCronInvalid"))}
                    </span>
                  )}
                </>
              </Field>

              {/* Content: Prompt vs command toggle sits in the label row; the
                  editor and its execution toolbar share one bordered container
                  so options read as part of the text, not as extra form rows. */}
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1 text-xs font-medium text-muted">
                    {t("scheduleFormContentLabel")}
                    {(form.kind === "prompt" ? errors.prompt : errors.command) && (
                      <span
                        className="text-sm leading-none text-danger"
                        title={
                          form.kind === "prompt"
                            ? errors.prompt && t(errors.prompt)
                            : errors.command && t(errors.command)
                        }
                      >
                        *
                      </span>
                    )}
                  </span>
                  <div
                    role="radiogroup"
                    aria-label={t("scheduleFormKind")}
                    className="interface-density-control flex shrink-0 overflow-hidden rounded-md border border-border"
                  >
                    {(
                      [
                        [
                          "prompt",
                          Sparkles,
                          t("scheduleFormKindPrompt"),
                          t("scheduleFormKindPromptHint"),
                        ],
                        [
                          "command",
                          Terminal,
                          t("scheduleFormKindCommand"),
                          t("scheduleFormKindCommandHint"),
                        ],
                      ] as const
                    ).map(([value, KindIcon, label, hint], index) => {
                      const active = form.kind === value;
                      return (
                        <button
                          key={value}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          data-testid={`schedule-form-kind-${value}`}
                          title={hint}
                          onClick={() => patch({ kind: value })}
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs transition-colors ${
                            index > 0 ? "border-l border-border" : ""
                          } ${
                            active
                              ? "bg-selection font-medium text-selection-foreground"
                              : "text-muted hover:bg-surface-overlay hover:text-foreground"
                          }`}
                        >
                          <KindIcon size={12} aria-hidden="true" />
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="overflow-hidden rounded-lg border border-border bg-surface transition-colors focus-within:border-focus">
                  {form.kind === "prompt" ? (
                    <textarea
                      data-testid="schedule-form-prompt"
                      value={form.prompt}
                      onChange={(event) => patch({ prompt: event.target.value })}
                      rows={7}
                      placeholder={t("scheduleFormPromptPlaceholder")}
                      className={bareTextareaClass}
                    />
                  ) : (
                    <textarea
                      data-testid="schedule-form-command"
                      value={form.command}
                      onChange={(event) => patch({ command: event.target.value })}
                      rows={5}
                      className={`${bareTextareaClass} font-mono`}
                    />
                  )}

                  <div className="flex flex-wrap items-center gap-1 border-t border-border-subtle px-1.5 py-1">
                    <div className="flex min-w-0 flex-1 basis-44 items-center gap-1 text-muted">
                      <FolderOpen size={13} className="shrink-0" aria-hidden="true" />
                      <Select
                        value={cwdValue}
                        onChange={(value) => {
                          if (value === CWD_OPEN_VALUE) void pickFolder();
                          else patch({ cwd: value });
                        }}
                        ariaLabel={t("scheduleFormCwd")}
                        className="min-w-0 flex-1"
                        triggerClassName="w-full"
                        ghost
                        options={[
                          ...cwdPresets.map((path) => ({ value: path, label: path })),
                          { value: CWD_OPEN_VALUE, label: t("scheduleFormOpenFolder") },
                        ]}
                      />
                    </div>

                    {form.kind === "prompt" && (
                      <Select
                        value={form.permission}
                        onChange={(value) =>
                          patch({ permission: value as ScheduleFormState["permission"] })
                        }
                        ariaLabel={t("scheduleFormPermission")}
                        className="shrink-0"
                        triggerClassName="w-24"
                        ghost
                        options={[
                          { value: "read_only", label: t("schedulePermissionReadOnly") },
                          { value: "write", label: t("schedulePermissionWrite") },
                          { value: "full", label: t("schedulePermissionFull") },
                        ]}
                      />
                    )}

                    <Select
                      value={form.notify}
                      onChange={(value) => patch({ notify: value as ScheduleFormState["notify"] })}
                      ariaLabel={t("scheduleFormNotify")}
                      className="shrink-0"
                      triggerClassName="w-28"
                      ghost
                      options={[
                        { value: "none", label: t("scheduleNotifyNone") },
                        { value: "system", label: t("scheduleNotifySystem") },
                      ]}
                    />

                    {form.kind === "prompt" ? (
                      models.length > 0 ? (
                        <ModelSelectWithThinking
                          value={form.model}
                          onChange={(model) => patch({ model })}
                          models={models}
                          hostDefault={hostDefaultModel}
                          defaultLabel={defaultModelLabel}
                          label={t("scheduleFormModel")}
                          ghost
                          className="ml-auto max-w-56 shrink-0"
                        />
                      ) : (
                        <span
                          className="ml-auto min-w-0 truncate text-xs text-muted"
                          title={defaultModelLabel}
                        >
                          {defaultModelLabel}
                        </span>
                      )
                    ) : (
                      <button
                        type="button"
                        className="ml-auto inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-muted transition-colors hover:bg-surface-overlay/60 hover:text-foreground"
                        onClick={() => void pickScript()}
                      >
                        <FileCode size={12} aria-hidden="true" />
                        {t("scheduleFormPickScript")}
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* More options: one low-key disclosure row. */}
              <div>
                <button
                  type="button"
                  className="flex items-center gap-1.5 text-xs font-medium text-muted transition-colors hover:text-foreground"
                  onClick={() => setAdvancedOpen((open) => !open)}
                >
                  {advancedOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  {t("scheduleFormMore")}
                </button>
                {advancedOpen && (
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <Field
                      label={t("scheduleFormTimeoutMinutes")}
                      error={errors.timeout && t(errors.timeout)}
                    >
                      <input
                        type="number"
                        min={1}
                        max={SCHEDULE_MAX_TIMEOUT_MINUTES}
                        value={form.timeoutMinutes}
                        onChange={(event) => patch({ timeoutMinutes: Number(event.target.value) })}
                        className={`${inputClass} text-right`}
                      />
                    </Field>
                    <Field
                      label={t("scheduleFormMaxRuns")}
                      error={errors.maxRuns && t(errors.maxRuns)}
                    >
                      <input
                        type="number"
                        min={1}
                        value={form.maxRuns}
                        onChange={(event) => patch({ maxRuns: event.target.value })}
                        placeholder={t("scheduleFormMaxRunsPlaceholder")}
                        className={`${inputClass} text-right`}
                      />
                    </Field>
                    <Field label={t("scheduleFormMissedWindow")}>
                      <Select
                        value={form.missedWindow}
                        onChange={(value) =>
                          patch({ missedWindow: value as ScheduleFormState["missedWindow"] })
                        }
                        ariaLabel={t("scheduleFormMissedWindow")}
                        triggerClassName="w-full"
                        options={[
                          { value: "catch_up_one", label: t("scheduleMissedWindowCatchUp") },
                          { value: "skip", label: t("scheduleMissedWindowSkip") },
                        ]}
                      />
                    </Field>
                    <Field label={t("scheduleFormTags")}>
                      <input
                        value={form.tags}
                        onChange={(event) => patch({ tags: event.target.value })}
                        placeholder={t("scheduleFormTagsPlaceholder")}
                        className={inputClass}
                      />
                    </Field>
                  </div>
                )}
              </div>

              {saveError && (
                <span className="text-xs text-danger" data-testid="schedule-form-error">
                  {saveError}
                </span>
              )}
            </div>

            {/* Sticky footer: enable toggle on the left, actions on the right. */}
            <div className="schedule-form-footer sticky bottom-0 flex items-center gap-3 px-5 py-3">
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
              <div className="ml-auto flex items-center gap-3">
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
