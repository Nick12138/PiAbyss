import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  Check,
  CircleAlert,
  LoaderCircle,
  MessageCircleQuestion,
  Search,
  Send,
  X,
} from "lucide-react";
import { useT } from "../../lib/i18n/use-t";
import type { ExtensionUiRequestState } from "../../lib/stores/extension-ui-state";
import { hasOptionPreviews, OptionPreview } from "./OptionPreview";
import type { ExtensionUiResponseController } from "./use-extension-ui-response";

type KnownExtensionUiOrigin = Exclude<
  NonNullable<ExtensionUiRequestState["origin"]>,
  { invocationKind: "unknown" }
>;

const OPTION_SEARCH_THRESHOLD = 12;
const OPTION_VIRTUALIZATION_THRESHOLD = 100;
/** Pane width (px) at or above which previews sit beside the options. */
const PREVIEW_SIDE_BY_SIDE_MIN_WIDTH = 720;

function originActivity(origin: KnownExtensionUiOrigin): string | undefined {
  switch (origin.invocationKind) {
    case "tool":
      return origin.toolName;
    case "command":
      return origin.commandName;
    case "shortcut":
      return origin.shortcut;
    case "event":
      return origin.eventType;
    case "background":
      return undefined;
  }
}

function ExpiryLabel({ expiresAt }: { expiresAt?: number }) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!expiresAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);

  if (!expiresAt) return null;
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1_000));
  if (seconds >= 3_600) {
    return (
      <span className="tabular-nums">
        {t("extUiExpiresInHours", { hours: Math.ceil(seconds / 3_600) })}
      </span>
    );
  }
  if (seconds >= 60) {
    return (
      <span className="tabular-nums">
        {t("extUiExpiresInMinutes", { minutes: Math.ceil(seconds / 60) })}
      </span>
    );
  }
  return <span className="tabular-nums">{t("extUiExpiresIn", { seconds })}</span>;
}

function SubmitLabel({ label, submitting }: { label: string; submitting: boolean }) {
  const t = useT();
  return submitting ? (
    <>
      <LoaderCircle size={13} className="animate-spin" />
      <span>{t("extUiSubmitting")}</span>
    </>
  ) : (
    <>
      <Check size={13} />
      <span>{label}</span>
    </>
  );
}

export function ExtensionUiRequestContent({
  request,
  controller,
  titleId,
  variant,
}: {
  request: ExtensionUiRequestState;
  controller: ExtensionUiResponseController;
  titleId: string;
  variant: "inline" | "modal";
}) {
  const t = useT();
  const fieldId = useId();
  const errorId = useId();
  const optionSearchId = useId();
  const { input, setInput, submitting, error, respond } = controller;
  const [optionQuery, setOptionQuery] = useState("");
  const optionScrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [sideBySide, setSideBySide] = useState(false);
  const [focusedOptionId, setFocusedOptionId] = useState<string | null>(null);
  const [selectSubmitSource, setSelectSubmitSource] = useState<
    { kind: "option"; id: string } | { kind: "freeform" } | null
  >(null);
  const highRisk = request.risk === "high";
  const trustedOrigin = request.origin?.invocationKind === "unknown" ? undefined : request.origin;
  const sourceLabel = trustedOrigin?.extensionDisplayName ?? request.sourceLabel;
  const sourceActivity = trustedOrigin ? originActivity(trustedOrigin) : undefined;
  const sourceTitle = sourceActivity ? `${sourceLabel} · ${sourceActivity}` : sourceLabel;
  const options = useMemo(() => request.options ?? [], [request.options]);
  const normalizedOptionQuery = optionQuery.trim().toLocaleLowerCase();
  const filteredOptions = useMemo(
    () =>
      normalizedOptionQuery
        ? options.filter((option) =>
            [option.label, option.description]
              .filter(Boolean)
              .join("\n")
              .toLocaleLowerCase()
              .includes(normalizedOptionQuery),
          )
        : options,
    [normalizedOptionQuery, options],
  );
  const virtualizeOptions = filteredOptions.length >= OPTION_VIRTUALIZATION_THRESHOLD;
  const optionVirtualizer = useVirtualizer({
    count: virtualizeOptions ? filteredOptions.length : 0,
    getScrollElement: () => optionScrollRef.current,
    estimateSize: (index) => (filteredOptions[index]?.description ? 58 : 44),
    getItemKey: (index) => filteredOptions[index]?.id ?? index,
    overscan: 6,
    initialRect: { width: 640, height: 240 },
  });

  useEffect(() => {
    setSelectSubmitSource(null);
    setOptionQuery("");
    setFocusedOptionId(null);
  }, [request.requestId]);

  // Previews are ASCII layouts: side-by-side keeps them readable, but a narrow
  // pane would clip them, so the layout stacks below the options instead.
  const previewsAvailable = request.kind === "select" && hasOptionPreviews(options);
  useEffect(() => {
    const node = contentRef.current;
    if (!previewsAvailable || !node) {
      setSideBySide(false);
      return;
    }
    const update = () => setSideBySide(node.clientWidth >= PREVIEW_SIDE_BY_SIDE_MIN_WIDTH);
    update();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [previewsAvailable, request.requestId]);

  // Only the focused option's preview is shown. Rendering every option's preview
  // at once buries the list and makes comparison harder, not easier.
  const previewOption = useMemo(() => {
    if (!previewsAvailable) return undefined;
    if (focusedOptionId) {
      const focused = options.find((option) => option.id === focusedOptionId);
      if (focused) return focused;
    }
    return options[0];
  }, [focusedOptionId, options, previewsAvailable]);

  useEffect(() => {
    if (optionScrollRef.current) optionScrollRef.current.scrollTop = 0;
  }, [optionQuery]);

  async function respondToSelect(source: NonNullable<typeof selectSubmitSource>, value: string) {
    setSelectSubmitSource(source);
    if (!(await respond("resolved", value))) setSelectSubmitSource(null);
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing || submitting) return;
    const shouldSubmit =
      request.kind === "input"
        ? event.key === "Enter" && !event.shiftKey
        : event.key === "Enter" && (event.metaKey || event.ctrlKey);
    if (!shouldSubmit) return;
    event.preventDefault();
    void respond("resolved", input);
  }

  function renderOption(option: (typeof options)[number], index: number) {
    const optionSubmitting =
      submitting && selectSubmitSource?.kind === "option" && selectSubmitSource.id === option.id;
    return (
      <button
        type="button"
        aria-label={option.description ? `${option.label}. ${option.description}` : option.label}
        aria-posinset={virtualizeOptions ? index + 1 : undefined}
        aria-setsize={virtualizeOptions ? filteredOptions.length : undefined}
        data-option-focused={previewOption?.id === option.id ? "true" : undefined}
        className={`flex min-h-10 w-full flex-col justify-center rounded-md border px-2.5 py-1.5 text-left transition-colors disabled:cursor-not-allowed ${
          optionSubmitting
            ? option.destructive
              ? "border-danger/50 bg-danger/10 text-danger disabled:opacity-100"
              : "border-accent/45 bg-accent/8 text-foreground disabled:opacity-100"
            : option.destructive
              ? "border-danger/30 text-danger hover:bg-danger/10 disabled:opacity-45"
              : "border-border text-foreground/90 hover:bg-surface-overlay disabled:opacity-45"
        }`}
        onClick={() => void respondToSelect({ kind: "option", id: option.id }, option.id)}
        onFocus={() => setFocusedOptionId(option.id)}
        onMouseEnter={() => setFocusedOptionId(option.id)}
      >
        <span className="text-xs font-medium">{option.label}</span>
        {option.description && (
          <span className="mt-0.5 text-[11px] leading-4 text-muted">{option.description}</span>
        )}
        {optionSubmitting && (
          <span role="status" className="mt-1 flex items-center gap-1 text-[11px] text-muted">
            <LoaderCircle size={12} className="animate-spin" />
            <span>{t("extUiSubmitting")}</span>
          </span>
        )}
      </button>
    );
  }

  const cancelButton = (
    <button
      type="button"
      disabled={submitting}
      className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md border border-border px-3 text-xs text-foreground/80 transition-colors hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-45"
      onClick={() => void respond("cancelled")}
    >
      <X size={13} />
      <span>{t("commonCancel")}</span>
    </button>
  );

  return (
    <div ref={contentRef} className="min-w-0" aria-busy={submitting}>
      <div className="flex min-w-0 items-start gap-2.5">
        {highRisk ? (
          <CircleAlert size={17} className="mt-0.5 shrink-0 text-warning" />
        ) : (
          <MessageCircleQuestion size={17} className="mt-0.5 shrink-0 text-foreground/75" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h2
              id={titleId}
              className={
                variant === "modal"
                  ? "break-words text-base font-semibold"
                  : "break-words text-sm font-semibold"
              }
            >
              {request.title ?? t("extUiDefaultTitle")}
            </h2>
            {sourceLabel && (
              <span className="max-w-48 truncate text-[10px] text-muted" title={sourceTitle}>
                {sourceLabel}
              </span>
            )}
            {highRisk && (
              <span className="text-[10px] font-medium text-warning">{t("extUiHighRisk")}</span>
            )}
            <span className="ml-auto shrink-0 text-[10px] text-muted">
              <ExpiryLabel expiresAt={request.expiresAt} />
            </span>
          </div>
          {request.message && (
            <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-muted">
              {request.message}
            </p>
          )}
        </div>
      </div>

      {error && (
        <div
          id={errorId}
          role="alert"
          className="mt-3 border-l-2 border-danger/70 bg-danger/8 px-3 py-2 text-xs text-foreground"
        >
          <p className="font-medium text-danger">{error}</p>
          <p className="mt-0.5 text-muted">{t("extUiRetryHint")}</p>
        </div>
      )}

      {request.kind === "confirm" && (
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          {cancelButton}
          <button
            type="button"
            disabled={submitting}
            className={`inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md px-3 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
              highRisk
                ? "bg-danger text-white hover:bg-danger/85"
                : "bg-accent text-accent-foreground hover:bg-accent-hover"
            }`}
            onClick={() => void respond("resolved", true)}
          >
            <SubmitLabel label={t("extUiConfirm")} submitting={submitting} />
          </button>
        </div>
      )}

      {request.kind === "select" && (
        <div className="mt-3">
          <fieldset disabled={submitting}>
            <legend className="mb-1.5 text-xs font-medium text-foreground/80">
              {t("extUiChooseOption")}
            </legend>
            {options.length > 0 ? (
              <>
                {options.length >= OPTION_SEARCH_THRESHOLD ? (
                  <div className="relative mb-2">
                    <label htmlFor={optionSearchId} className="sr-only">
                      {t("extUiSearchOptions")}
                    </label>
                    <Search
                      size={13}
                      className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted"
                      aria-hidden="true"
                    />
                    <input
                      id={optionSearchId}
                      type="search"
                      value={optionQuery}
                      placeholder={t("extUiSearchOptions")}
                      className="h-8 w-full rounded-md border border-border bg-surface pl-7 pr-8 text-xs outline-none focus:border-focus"
                      onChange={(event) => setOptionQuery(event.target.value)}
                    />
                    {optionQuery ? (
                      <button
                        type="button"
                        title={t("extUiClearOptionSearch")}
                        aria-label={t("extUiClearOptionSearch")}
                        className="absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-foreground"
                        onClick={() => setOptionQuery("")}
                      >
                        <X size={12} aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {filteredOptions.length === 0 ? (
                  <p role="status" className="py-3 text-center text-xs text-muted">
                    {t("extUiNoMatchingOptions")}
                  </p>
                ) : virtualizeOptions && !previewOption ? (
                  <div
                    ref={optionScrollRef}
                    className="max-h-60 overflow-y-auto pr-1"
                    data-extension-option-list="virtualized"
                  >
                    <div
                      className="relative w-full"
                      style={{ height: optionVirtualizer.getTotalSize() }}
                    >
                      {optionVirtualizer.getVirtualItems().map((virtualOption) => {
                        const option = filteredOptions[virtualOption.index]!;
                        return (
                          <div
                            key={option.id}
                            ref={optionVirtualizer.measureElement}
                            data-index={virtualOption.index}
                            className="absolute left-0 top-0 w-full pb-1"
                            style={{ transform: `translateY(${virtualOption.start}px)` }}
                          >
                            {renderOption(option, virtualOption.index)}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : !previewOption ? (
                  <div className="max-h-60 space-y-1 overflow-y-auto pr-1">
                    {filteredOptions.map((option, index) => (
                      <div key={option.id}>{renderOption(option, index)}</div>
                    ))}
                  </div>
                ) : null}

                {previewOption ? (
                  <div
                    className={`max-h-[22rem] overflow-y-auto pr-1 ${
                      sideBySide
                        ? "grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
                        : "space-y-3"
                    }`}
                    data-extension-option-pane="true"
                  >
                    <div
                      className={
                        sideBySide ? "max-h-[22rem] space-y-1 overflow-y-auto" : "space-y-1"
                      }
                    >
                      {filteredOptions.map((option, index) => (
                        <div key={option.id}>{renderOption(option, index)}</div>
                      ))}
                    </div>
                    <OptionPreview
                      option={previewOption}
                      fallbackLabel={t("extUiPreviewFallback")}
                    />
                  </div>
                ) : null}
              </>
            ) : (
              <p className="py-2 text-xs text-muted">{t("extUiNoOptions")}</p>
            )}
          </fieldset>

          {request.allowFreeform && (
            <div className="mt-3 border-t border-border/70 pt-3">
              <label
                htmlFor={fieldId}
                className="mb-1.5 block text-xs font-medium text-foreground/80"
              >
                {t("extUiCustomResponse")}
              </label>
              <div className="flex items-end gap-2">
                <textarea
                  id={fieldId}
                  rows={2}
                  value={input}
                  disabled={submitting}
                  aria-describedby={error ? errorId : undefined}
                  aria-invalid={error ? true : undefined}
                  className="min-h-10 min-w-0 flex-1 resize-y rounded-md border border-border bg-surface px-2.5 py-2 text-xs"
                  onChange={(event) => setInput(event.target.value)}
                />
                <button
                  type="button"
                  title={
                    submitting && selectSubmitSource?.kind === "freeform"
                      ? t("extUiSubmitting")
                      : t("extUiSendResponse")
                  }
                  aria-label={
                    submitting && selectSubmitSource?.kind === "freeform"
                      ? t("extUiSubmitting")
                      : t("extUiSendResponse")
                  }
                  disabled={submitting || !input.trim()}
                  className="flex size-9 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-45"
                  onClick={() => void respondToSelect({ kind: "freeform" }, input)}
                >
                  {submitting && selectSubmitSource?.kind === "freeform" ? (
                    <LoaderCircle size={14} className="animate-spin" />
                  ) : (
                    <Send size={14} />
                  )}
                </button>
              </div>
            </div>
          )}

          <div className="mt-3 flex justify-end">{cancelButton}</div>
        </div>
      )}

      {(request.kind === "input" || request.kind === "editor") && (
        <div className="mt-3">
          <label htmlFor={fieldId} className="mb-1.5 block text-xs font-medium text-foreground/80">
            {t("extUiResponseLabel")}
          </label>
          <textarea
            id={fieldId}
            rows={request.kind === "editor" ? 7 : 2}
            value={input}
            disabled={submitting}
            aria-describedby={error ? errorId : undefined}
            aria-invalid={error ? true : undefined}
            className={`w-full resize-y rounded-md border border-border bg-surface px-2.5 py-2 text-sm ${
              request.kind === "editor" ? "min-h-40" : "min-h-10"
            }`}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleInputKeyDown}
          />
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            {cancelButton}
            <button
              type="button"
              disabled={submitting}
              className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md bg-accent px-3 text-xs text-accent-foreground transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-45"
              onClick={() => void respond("resolved", input)}
            >
              <SubmitLabel label={t("extUiOk")} submitting={submitting} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
