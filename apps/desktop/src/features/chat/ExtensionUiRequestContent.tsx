import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CornerUpLeft,
  LoaderCircle,
  MessageCircleQuestion,
  Search,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type { ExtensionUiOption } from "@piabyss/protocol";
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

/**
 * Sentinel rows `ask_user_question` appends to every single-select question.
 *
 * The extension also declares `allowFreeform`, and that flag is what actually
 * gives the card a free-text box — so when both are present the row is pure
 * duplication and the user sees two ways to type the same answer. Absorb it
 * here rather than in the extension: hosts that ignore `allowFreeform` still
 * need the row.
 */
const FREEFORM_SENTINEL_LABEL = /^(?:type something\.?|other|其他|自定义(?:回复)?)$/i;

/**
 * `↩`-prefixed rows are rewind actions, not answers. The prefix is the
 * cross-process contract with the extension; the trailing text is localizable.
 */
const BACK_SENTINEL_LABEL = /^↩/;

/**
 * Value the card sends when the user asks to redo the previous question on a
 * request that has no rewind *row* to click (multi-select and plain inputs).
 * The extension matches it by the `↩` prefix, so only the prefix is binding.
 */
const REWIND_VALUE = "↩ 修改上一题";

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

/** A/B/C… for the first 26 options, then plain ordinals. */
function optionMarker(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

/** `"1,3"` → `[0, 2]`. Anything non-numeric or out of range is dropped. */
function parsePositionList(value: string | undefined, count: number): number[] {
  if (!value) return [];
  const positions: number[] = [];
  for (const token of value.split(/[,\s]+/)) {
    if (!/^\d+$/.test(token)) continue;
    const index = Number.parseInt(token, 10) - 1;
    if (index >= 0 && index < count && !positions.includes(index)) positions.push(index);
  }
  return positions;
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
  onToggleFold,
  foldExpanded,
  answeredCount,
}: {
  request: ExtensionUiRequestState;
  controller: ExtensionUiResponseController;
  titleId: string;
  variant: "inline" | "modal";
  /**
   * Shell-owned fold control. When present the whole header becomes the click
   * target — a small corner chevron is too small a hit area for something the
   * user reaches for to get the card out of the way.
   */
  onToggleFold?: () => void;
  foldExpanded?: boolean;
  /** Questions already answered in this questionnaire; rendered bottom-left. */
  answeredCount?: number;
}) {
  const t = useT();
  const fieldId = useId();
  const errorId = useId();
  const optionSearchId = useId();
  const { input, setInput, submitting, error, respond } = controller;
  const [optionQuery, setOptionQuery] = useState("");
  /** Single-select keeps at most one id here; multi-select keeps the checked set. */
  const [selectedOptionIds, setSelectedOptionIds] = useState<string[]>([]);
  const [focusedOptionId, setFocusedOptionId] = useState<string | null>(null);
  const [titleExpanded, setTitleExpanded] = useState(false);
  const [titleOverflows, setTitleOverflows] = useState(false);
  const [moreBelow, setMoreBelow] = useState(false);
  const [sideBySide, setSideBySide] = useState(false);
  const [selectSubmitSource, setSelectSubmitSource] = useState<
    { kind: "option"; id: string } | { kind: "freeform" } | null
  >(null);

  const titleRef = useRef<HTMLHeadingElement>(null);
  const bodyScrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());

  const highRisk = request.risk === "high";
  const trustedOrigin = request.origin?.invocationKind === "unknown" ? undefined : request.origin;
  const sourceLabel = trustedOrigin?.extensionDisplayName ?? request.sourceLabel;
  const sourceActivity = trustedOrigin ? originActivity(trustedOrigin) : undefined;
  const sourceTitle = sourceActivity ? `${sourceLabel} · ${sourceActivity}` : sourceLabel;
  const isSelect = request.kind === "select";
  const allOptions = useMemo(() => request.options ?? [], [request.options]);
  /**
   * The questionnaire's multi-select questions arrive as `input` requests with
   * structured options, because `ui.select` can only return one value.
   */
  const isMultiSelect =
    request.kind === "input" && request.multiSelect === true && allOptions.length > 0;
  const hasChoiceList = isSelect || isMultiSelect;
  /**
   * The extension prefixes the header into the title as well, so that hosts
   * without a chip slot still show it. Now that the chip exists, drop the
   * duplicate.
   */
  const headerPrefix = request.questionHeader ? `[${request.questionHeader}] ` : "";
  const rawTitle = request.title ?? t("extUiDefaultTitle");
  const displayTitle =
    headerPrefix && rawTitle.startsWith(headerPrefix)
      ? rawTitle.slice(headerPrefix.length)
      : rawTitle;
  // The built-in questionnaire always comes from the same plugin, so repeating
  // its name on every question is noise. Other extensions keep the row — for
  // them, knowing who is asking is the point of it.
  const showSource =
    Boolean(sourceLabel) &&
    !(request.origin?.invocationKind === "tool" && request.origin.toolName === "ask_user_question");
  /** Any question past the first can send the user back to the previous one. */
  const canRewind = typeof request.questionIndex === "number" && request.questionIndex > 1;
  const hasFreeformText = input.trim().length > 0;
  /** The last question submits the whole questionnaire, so it says so. */
  const isLastQuestion =
    typeof request.questionIndex === "number" &&
    typeof request.questionCount === "number" &&
    request.questionIndex >= request.questionCount;

  /**
   * Answer options only. The extension's freeform row is folded into the card's
   * own input, and its rewind row becomes a footer action — neither is a choice
   * the user should have to scan past.
   */
  const { choiceOptions, backOption } = useMemo(() => {
    const choice: ExtensionUiOption[] = [];
    let back: ExtensionUiOption | undefined;
    for (const option of allOptions) {
      if (BACK_SENTINEL_LABEL.test(option.label)) {
        back ??= option;
        continue;
      }
      if (request.allowFreeform && FREEFORM_SENTINEL_LABEL.test(option.label)) continue;
      choice.push(option);
    }
    return { choiceOptions: choice, backOption: back };
  }, [allOptions, request.allowFreeform]);

  /** 1-based position in the request's own option list — what the extension parses. */
  const optionPositionById = useMemo(() => {
    const positions = new Map<string, number>();
    allOptions.forEach((option, index) => positions.set(option.id, index + 1));
    return positions;
  }, [allOptions]);

  /**
   * The extension echoes the previous answer here when a question is re-asked:
   * an option id for single-select, a `"1,3"` position list for multi-select.
   */
  const preselectedOptionIds = useMemo(() => {
    const value = request.defaultValue;
    if (!value || !hasChoiceList) return [];
    if (isMultiSelect) {
      return parsePositionList(value, allOptions.length)
        .map((index) => allOptions[index]?.id)
        .filter((id): id is string => Boolean(id));
    }
    const match = choiceOptions.find((option) => option.id === value || option.label === value);
    return match ? [match.id] : [];
  }, [request.defaultValue, hasChoiceList, isMultiSelect, allOptions, choiceOptions]);

  const normalizedOptionQuery = optionQuery.trim().toLocaleLowerCase();
  const filteredOptions = useMemo(
    () =>
      normalizedOptionQuery
        ? choiceOptions.filter((option) =>
            [option.label, option.description]
              .filter(Boolean)
              .join("\n")
              .toLocaleLowerCase()
              .includes(normalizedOptionQuery),
          )
        : choiceOptions,
    [normalizedOptionQuery, choiceOptions],
  );
  const virtualizeOptions = filteredOptions.length >= OPTION_VIRTUALIZATION_THRESHOLD;
  const optionVirtualizer = useVirtualizer({
    count: virtualizeOptions ? filteredOptions.length : 0,
    getScrollElement: () => bodyScrollRef.current,
    estimateSize: (index) => (filteredOptions[index]?.description ? 58 : 44),
    getItemKey: (index) => filteredOptions[index]?.id ?? index,
    overscan: 6,
    initialRect: { width: 640, height: 240 },
  });

  // A new question starts clean — except for a rewind, where the extension tells
  // us which answer to restore.
  useEffect(() => {
    setSelectSubmitSource(null);
    setOptionQuery("");
    setFocusedOptionId(null);
    setSelectedOptionIds(preselectedOptionIds);
  }, [request.requestId, preselectedOptionIds]);

  // A rewound free-text answer matches no option, so it seeds the input instead.
  useEffect(() => {
    if (!hasChoiceList || !request.allowFreeform) return;
    const value = request.defaultValue;
    if (!value || preselectedOptionIds.length > 0) return;
    setInput(value);
  }, [
    request.requestId,
    hasChoiceList,
    request.allowFreeform,
    request.defaultValue,
    preselectedOptionIds,
    setInput,
  ]);

  // Previews are ASCII layouts: side-by-side keeps them readable, but a narrow
  // pane would clip them, so the layout stacks below the options instead.
  const previewsAvailable = isSelect && hasOptionPreviews(choiceOptions);
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
    const wanted = focusedOptionId ?? selectedOptionIds[0];
    if (wanted) {
      const match = choiceOptions.find((option) => option.id === wanted);
      if (match) return match;
    }
    return choiceOptions[0];
  }, [focusedOptionId, selectedOptionIds, choiceOptions, previewsAvailable]);

  // The title is clamped so a runaway question cannot push the options and the
  // input out of the card. The expand control only appears when it is clipped.
  useEffect(() => {
    if (titleExpanded) return;
    const node = titleRef.current;
    if (!node) return;
    const measure = () => setTitleOverflows(node.scrollHeight > node.clientHeight + 1);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [displayTitle, titleExpanded, variant]);

  const updateScrollEdges = useCallback(() => {
    const node = bodyScrollRef.current;
    setMoreBelow(node ? node.scrollTop + node.clientHeight < node.scrollHeight - 4 : false);
  }, []);

  useEffect(() => {
    updateScrollEdges();
    const node = bodyScrollRef.current;
    if (!node || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(updateScrollEdges);
    observer.observe(node);
    return () => observer.disconnect();
  }, [updateScrollEdges, filteredOptions.length, optionQuery, previewOption?.id]);

  useEffect(() => {
    if (bodyScrollRef.current) bodyScrollRef.current.scrollTop = 0;
  }, [optionQuery]);

  const submitValue = useCallback(
    async (value: string, source: NonNullable<typeof selectSubmitSource>) => {
      setSelectSubmitSource(source);
      if (!(await respond("resolved", value))) setSelectSubmitSource(null);
    },
    [respond],
  );

  /**
   * Picking and typing are two ways to answer the same question, and the card
   * has a single action button — so they stay mutually exclusive rather than
   * leaving the user to guess which one wins.
   */
  function toggleOption(optionId: string) {
    setInput("");
    setSelectedOptionIds((current) =>
      isMultiSelect
        ? current.includes(optionId)
          ? current.filter((id) => id !== optionId)
          : [...current, optionId]
        : [optionId],
    );
    setFocusedOptionId(optionId);
  }

  function handleFreeformChange(value: string) {
    setInput(value);
    setSelectedOptionIds([]);
  }

  /** Single-select sends the option id; multi-select sends its `"1,3"` positions. */
  function submitSelection() {
    if (isMultiSelect) {
      const positions = selectedOptionIds
        .map((id) => optionPositionById.get(id) ?? 0)
        .filter((position) => position > 0)
        .sort((left, right) => left - right);
      void submitValue(positions.join(","), { kind: "option", id: "" });
      return;
    }
    const only = selectedOptionIds[0];
    if (only) void submitValue(only, { kind: "option", id: only });
  }

  /** The one action button: a typed answer wins, otherwise the selection. */
  function submitPrimary() {
    if (!hasChoiceList) {
      void respond("resolved", input);
      return;
    }
    if (hasFreeformText) {
      void submitValue(input, { kind: "freeform" });
      return;
    }
    submitSelection();
  }

  function moveOptionFocus(delta: number) {
    if (filteredOptions.length === 0) return;
    const currentId = focusedOptionId ?? selectedOptionIds[0];
    const currentIndex = filteredOptions.findIndex((option) => option.id === currentId);
    const base = currentIndex < 0 ? 0 : currentIndex;
    const next = filteredOptions[Math.min(filteredOptions.length - 1, Math.max(0, base + delta))];
    if (!next) return;
    setFocusedOptionId(next.id);
    optionRefs.current.get(next.id)?.focus();
  }

  function handleRootKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape" || submitting) return;
    event.preventDefault();
    void respond("cancelled");
  }

  function handleOptionKeyDown(event: KeyboardEvent<HTMLButtonElement>, optionId: string) {
    if (event.nativeEvent.isComposing || submitting) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveOptionFocus(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    // Single-select: first Enter selects, second confirms — the same two-step
    // safety as the Confirm button, without forcing a mouse round-trip.
    if (isMultiSelect || selectedOptionIds[0] !== optionId) {
      toggleOption(optionId);
      return;
    }
    submitSelection();
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing || submitting) return;
    // A questionnaire's free-text box only holds a single-line answer, and the
    // action button is what commits it — Enter must stay free for line breaks so
    // nothing gets submitted behind the user's back.
    const modifiers = event.metaKey || event.ctrlKey;
    const shouldSubmit = hasChoiceList
      ? modifiers && event.key === "Enter"
      : request.kind === "input"
        ? event.key === "Enter" && !event.shiftKey
        : event.key === "Enter" && modifiers;
    if (!shouldSubmit) {
      // Enter in a questionnaire's answer box neither commits nor inserts a
      // line break — it is a one-line answer, and a stray newline would end up
      // in the answer the model reads.
      if (hasChoiceList && event.key === "Enter") event.preventDefault();
      return;
    }
    event.preventDefault();
    void respond("resolved", input);
  }

  function renderOption(option: ExtensionUiOption, index: number) {
    const selected = selectedOptionIds.includes(option.id);
    const optionSubmitting =
      submitting && selectSubmitSource?.kind === "option" && selectSubmitSource.id === option.id;
    return (
      <button
        type="button"
        ref={(node) => {
          if (node) optionRefs.current.set(option.id, node);
          else optionRefs.current.delete(option.id);
        }}
        aria-label={option.description ? `${option.label}. ${option.description}` : option.label}
        aria-pressed={selected}
        aria-posinset={virtualizeOptions ? index + 1 : undefined}
        aria-setsize={virtualizeOptions ? filteredOptions.length : undefined}
        data-option-id={option.id}
        data-option-selected={selected ? "true" : undefined}
        data-option-focused={previewOption?.id === option.id ? "true" : undefined}
        className={`flex w-full items-start gap-2.5 rounded-md border px-2.5 py-2 text-left transition-colors disabled:cursor-not-allowed ${
          optionSubmitting
            ? "border-accent/50 bg-accent/8 disabled:opacity-100"
            : selected
              ? "border-accent/60 bg-accent/8"
              : "border-transparent hover:bg-surface-overlay disabled:opacity-45"
        }`}
        onClick={() => toggleOption(option.id)}
        onDoubleClick={
          isMultiSelect
            ? undefined
            : () => void submitValue(option.id, { kind: "option", id: option.id })
        }
        onKeyDown={(event) => handleOptionKeyDown(event, option.id)}
        onFocus={() => setFocusedOptionId(option.id)}
        onMouseEnter={() => setFocusedOptionId(option.id)}
      >
        {isMultiSelect ? (
          <span
            aria-hidden="true"
            className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[4px] border ${
              selected
                ? "border-accent bg-accent text-accent-foreground"
                : "border-border-secondary bg-surface"
            }`}
          >
            {selected ? <Check size={11} /> : null}
          </span>
        ) : (
          <span
            aria-hidden="true"
            className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded text-[10px] font-medium ${
              selected ? "bg-accent text-accent-foreground" : "bg-surface-overlay text-muted"
            }`}
          >
            {optionMarker(index)}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block break-words text-[13px] font-medium text-foreground/90">
            {option.label}
          </span>
          {option.description && (
            <span className="mt-0.5 block break-words text-xs leading-5 text-muted">
              {option.description}
            </span>
          )}
          {optionSubmitting && (
            <span role="status" className="mt-1 flex items-center gap-1 text-[11px] text-muted">
              <LoaderCircle size={12} className="animate-spin" />
              <span>{t("extUiSubmitting")}</span>
            </span>
          )}
        </span>
        {selected && !isMultiSelect && !optionSubmitting ? (
          <Check size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
        ) : null}
      </button>
    );
  }

  const cancelButton = (
    <button
      type="button"
      disabled={submitting}
      className="inline-flex min-h-8 items-center justify-center gap-1.5 rounded-md border border-border px-3 text-xs text-foreground/80 transition-colors hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-45"
      onClick={() => void respond("cancelled")}
    >
      <X size={13} />
      <span>{t("commonCancel")}</span>
    </button>
  );

  const primaryButtonClass = `inline-flex min-h-8 items-center justify-center gap-1.5 rounded-md px-3.5 text-xs transition-colors disabled:cursor-not-allowed disabled:border disabled:border-border disabled:bg-surface-overlay disabled:text-muted disabled:opacity-100 ${
    highRisk
      ? "bg-danger text-white hover:bg-danger/85"
      : "bg-accent text-accent-foreground hover:bg-accent-hover"
  }`;

  const showRewind = Boolean(backOption) || canRewind;

  const footerActions = (
    <div className="flex flex-wrap items-center gap-2" data-extension-ui-actions="true">
      {answeredCount && answeredCount > 0 ? (
        <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted">
          <Check className="size-3 shrink-0 text-success" aria-hidden="true" />
          <span className="whitespace-nowrap">
            {t("extUiGroupAnswered", { count: answeredCount })}
          </span>
        </span>
      ) : showSource ? (
        <span className="flex min-w-0 max-w-44 items-center gap-1 text-[11px] text-muted">
          <span className="shrink-0 text-muted/70">{t("extUiSourceFrom")}</span>
          <span className="min-w-0 truncate" title={sourceTitle}>
            {sourceLabel}
          </span>
        </span>
      ) : null}
      <span className="shrink-0 text-[11px] text-muted">
        <ExpiryLabel expiresAt={request.expiresAt} />
      </span>
      <span className="ml-auto flex items-center gap-2">
        {showRewind ? (
          <button
            type="button"
            disabled={submitting}
            title={t("extUiBackToPreviousHint")}
            className="inline-flex min-h-8 items-center justify-center gap-1.5 rounded-md px-2.5 text-xs text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
            onClick={() =>
              void submitValue(backOption?.id ?? REWIND_VALUE, {
                kind: "option",
                id: backOption?.id ?? REWIND_VALUE,
              })
            }
          >
            <CornerUpLeft size={13} aria-hidden="true" />
            <span>{t("extUiBackToPrevious")}</span>
          </button>
        ) : null}
        {cancelButton}
        {request.kind === "confirm" && (
          <button
            type="button"
            disabled={submitting}
            className={primaryButtonClass}
            onClick={() => void respond("resolved", true)}
          >
            <SubmitLabel label={t("extUiConfirm")} submitting={submitting} />
          </button>
        )}
        {hasChoiceList && (
          <button
            type="button"
            // A multi-select question may legitimately commit nothing selected;
            // a single-select one has to be given either an option or text.
            disabled={
              submitting || (!isMultiSelect && !hasFreeformText && selectedOptionIds.length === 0)
            }
            className={primaryButtonClass}
            onClick={submitPrimary}
          >
            <SubmitLabel
              label={isLastQuestion ? t("extUiConfirmSend") : t("extUiContinue")}
              submitting={submitting}
            />
          </button>
        )}
        {(request.kind === "input" || request.kind === "editor") && !isMultiSelect && (
          <button
            type="button"
            disabled={submitting}
            className={primaryButtonClass}
            onClick={() => void respond("resolved", input)}
          >
            <SubmitLabel label={t("extUiOk")} submitting={submitting} />
          </button>
        )}
      </span>
    </div>
  );

  const titleClassName = `break-words font-semibold ${
    variant === "modal" ? "text-base" : "text-sm"
  }`;
  const chipsRow =
    request.questionIndex || request.questionHeader || isMultiSelect || highRisk ? (
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        {request.questionIndex ? (
          <span className="rounded-full bg-surface-overlay px-2 py-0.5 text-[11px] text-muted">
            {request.questionCount && request.questionCount > 1
              ? t("extUiQuestionProgress", {
                  index: request.questionIndex,
                  total: request.questionCount,
                })
              : t("extUiQuestionOrdinal", { index: request.questionIndex })}
          </span>
        ) : null}
        {request.questionHeader ? (
          <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-foreground/70">
            {request.questionHeader}
          </span>
        ) : null}
        {isMultiSelect ? (
          <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-foreground/70">
            {t("extUiMultiSelectHint")}
          </span>
        ) : null}
        {highRisk ? (
          <span className="text-[11px] font-medium text-warning">{t("extUiHighRisk")}</span>
        ) : null}
      </div>
    ) : null;

  /** The header doubles as the fold control; the chevron in the corner remains. */
  const canFold = typeof onToggleFold === "function";
  const headerRegion = (
    <>
      {highRisk ? (
        <CircleAlert size={17} className="mt-0.5 shrink-0 text-warning" />
      ) : (
        <MessageCircleQuestion size={17} className="mt-0.5 shrink-0 text-foreground/75" />
      )}
      <div className="min-w-0 flex-1">
        {chipsRow}
        <h2
          ref={titleRef}
          id={titleId}
          className={`${titleClassName} ${titleExpanded ? "" : "line-clamp-2"}`}
        >
          {displayTitle}
        </h2>
      </div>
      {/* Decoration only — the whole header above is the actual control, so
          this must not be a second focusable element with the same name. */}
      {canFold ? (
        <ChevronUp size={14} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
      ) : null}
    </>
  );
  const headerClassName = `flex min-w-0 items-start gap-2.5 rounded-md ${
    variant === "inline" ? "pr-7" : ""
  }`;

  return (
    <div
      ref={contentRef}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      aria-busy={submitting}
      onKeyDown={handleRootKeyDown}
    >
      <div className="shrink-0">
        {canFold ? (
          <div
            role="button"
            tabIndex={0}
            aria-expanded={foldExpanded}
            aria-label={t("extUiCollapseQuestion")}
            title={t("extUiCollapseQuestion")}
            data-extension-ui-fold-toggle="true"
            className={`${headerClassName} cursor-pointer transition-colors hover:bg-surface-overlay/60 focus-visible:outline focus-visible:outline-[1.5px] focus-visible:outline-focus`}
            onClick={() => onToggleFold?.()}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              onToggleFold?.();
            }}
          >
            {headerRegion}
          </div>
        ) : (
          <div className={headerClassName} data-extension-ui-header="true">
            {headerRegion}
          </div>
        )}
        {/* Kept out of the fold target above: expanding the title and folding
            the card are different actions, and a button inside a button would
            swallow the wrong one. */}
        {titleOverflows ? (
          <button
            type="button"
            className="mt-1 text-[11px] text-accent hover:underline"
            onClick={() => setTitleExpanded((current) => !current)}
          >
            {titleExpanded ? t("extUiCollapseTitle") : t("extUiExpandTitle")}
          </button>
        ) : null}
        {/* A multi-select question carries its numbered option list in
            `message` for hosts that cannot render checkboxes; here the list
            below replaces it, so showing both would just duplicate. */}
        {request.message && !isMultiSelect ? (
          <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-muted">
            {request.message}
          </p>
        ) : null}
      </div>

      {error && (
        <div
          id={errorId}
          role="alert"
          className="mt-3 shrink-0 border-l-2 border-danger/70 bg-danger/8 px-3 py-2 text-xs text-foreground"
        >
          <p className="font-medium text-danger">{error}</p>
          <p className="mt-0.5 text-muted">{t("extUiRetryHint")}</p>
        </div>
      )}

      {/* One scroll region for the whole card body — nested scroll areas made the
          wheel ambiguous between "scroll the options" and "scroll the card". */}
      <div
        ref={bodyScrollRef}
        onScroll={updateScrollEdges}
        className="relative mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain pr-0.5"
        data-extension-ui-scroll="true"
        data-extension-option-list={virtualizeOptions ? "virtualized" : undefined}
      >
        {hasChoiceList && (
          <fieldset disabled={submitting}>
            <legend className="sr-only">{t("extUiChooseOption")}</legend>
            {choiceOptions.length > 0 ? (
              <>
                {choiceOptions.length >= OPTION_SEARCH_THRESHOLD ? (
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
                ) : !previewOption ? (
                  <div className="space-y-1">
                    {filteredOptions.map((option, index) => (
                      <div key={option.id}>{renderOption(option, index)}</div>
                    ))}
                  </div>
                ) : null}

                {previewOption ? (
                  <div
                    className={
                      sideBySide
                        ? "grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
                        : "space-y-3"
                    }
                    data-extension-option-pane="true"
                  >
                    <div className="space-y-1">
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
        )}

        {(request.kind === "input" || request.kind === "editor") && !isMultiSelect && (
          <div>
            <label
              htmlFor={fieldId}
              className="mb-1.5 block text-xs font-medium text-foreground/80"
            >
              {t("extUiResponseLabel")}
            </label>
            <textarea
              id={fieldId}
              rows={request.kind === "editor" ? 7 : 2}
              value={input}
              disabled={submitting}
              aria-describedby={error ? errorId : undefined}
              aria-invalid={error ? true : undefined}
              className={`w-full resize-y rounded-md border border-border bg-surface px-2.5 py-2 text-sm outline-none focus:border-focus ${
                request.kind === "editor" ? "min-h-40" : "min-h-10"
              }`}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleInputKeyDown}
            />
          </div>
        )}

        {/* A truncated list gave no hint that more options existed below. */}
        {moreBelow ? (
          <div className="sticky bottom-0 flex justify-center pt-3" aria-hidden="true">
            <span className="flex items-center gap-1 rounded-full border border-border bg-surface-raised px-2.5 py-0.5 text-[11px] text-muted">
              <ChevronDown size={12} />
              {t("extUiMoreOptions")}
            </span>
          </div>
        ) : null}
      </div>

      {/* The action row never scrolls away: it is the only way to commit or
          cancel, and burying it below a long option list stranded the user. */}
      <div className="mt-3 shrink-0 border-t border-border pt-2.5" data-extension-ui-footer="true">
        {/* No send button of its own: the action row below is the single place
            an answer is committed, so a typed reply and a picked option cannot
            race each other. */}
        {hasChoiceList && request.allowFreeform ? (
          <textarea
            id={fieldId}
            rows={1}
            value={input}
            disabled={submitting}
            aria-label={t("extUiCustomResponse")}
            aria-describedby={error ? errorId : undefined}
            aria-invalid={error ? true : undefined}
            placeholder={t("extUiFreeformPlaceholder")}
            className="min-h-9 w-full resize-y rounded-md border border-border bg-surface px-2.5 py-2 text-xs outline-none focus:border-focus"
            onChange={(event) => handleFreeformChange(event.target.value)}
            onKeyDown={handleInputKeyDown}
          />
        ) : null}
        {isSelect && !request.allowFreeform ? (
          <p className="mb-2 text-[11px] text-muted">{t("extUiSelectThenConfirm")}</p>
        ) : null}
        <div className={hasChoiceList && request.allowFreeform ? "mt-2.5" : ""}>
          {footerActions}
        </div>
      </div>
    </div>
  );
}
