import { Check, ChevronDown, CircleAlert, LoaderCircle, MessageCircleQuestion } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { ExtensionUiRequestContent, questionDisplayTitle } from "./ExtensionUiRequestContent";
import { useExtensionUiResponse } from "./use-extension-ui-response";

function isEmbeddedQuestionRequest(request: {
  origin?: { invocationKind: string; toolName?: string };
}): boolean {
  return (
    request.origin?.invocationKind === "tool" && request.origin.toolName === "ask_user_question"
  );
}

export function InlineExtensionUiRequest() {
  const t = useT();
  const activeRequest = useAppStore((state) => state.extensionUiRequest);
  // Older Hosts may still label this built-in request as modal. Keep the
  // questionnaire embedded so upgrading the desktop does not bring back the
  // full-screen prompt for an already-running turn.
  const request =
    activeRequest &&
    (activeRequest.presentation === "inline" || isEmbeddedQuestionRequest(activeRequest))
      ? activeRequest
      : null;
  const decisionGroups = useAppStore((state) => state.extensionDecisionGroups);
  const sessionId = useAppStore((state) => state.session?.sessionId ?? null);
  const requestGroup = request?.groupKey ? decisionGroups[request.groupKey] : undefined;
  const waitingGroup = activeRequest
    ? undefined
    : Object.values(decisionGroups)
        .filter(
          (group) =>
            group.status === "active" &&
            (group.presentation === "inline" ||
              (group.origin?.invocationKind === "tool" &&
                group.origin.toolName === "ask_user_question")) &&
            group.activeRequestId === null &&
            group.context.expectedSessionId === sessionId,
        )
        .at(-1);
  const group = requestGroup ?? waitingGroup;
  const controller = useExtensionUiResponse(request);
  const contentTitleId = useId();
  const collapsedTitleId = useId();
  const contentId = useId();
  const [collapsed, setCollapsed] = useState(false);
  const groupKey = group?.groupKey ?? null;

  // Sequential questions reuse one card shell, so a fold belongs to that shell:
  // it survives the next question in the same group but a new questionnaire
  // always starts expanded. Folding is local presentation state — it never
  // answers, dismisses, or re-owns the pending request.
  useEffect(() => {
    setCollapsed(false);
  }, [groupKey]);

  if (!request && !group) return null;
  const answeredCount = group?.answeredCount ?? 0;
  const highRisk = (request?.risk ?? group?.risk) === "high";
  const titleId = collapsed ? collapsedTitleId : contentTitleId;

  return (
    <section
      role="region"
      aria-labelledby={titleId}
      className="shrink-0 px-5 pt-2"
      data-extension-ui-surface="inline"
    >
      <div
        className={`conversation-content-width relative mx-auto flex max-h-[min(32rem,50dvh)] w-full flex-col overflow-hidden rounded-md border bg-surface-raised px-3.5 py-3 shadow-sm ${
          highRisk
            ? "border-warning/40"
            : collapsed && request
              ? "border-accent/40"
              : "border-border"
        }`}
        data-extension-ui-group={group?.groupKey}
        data-extension-ui-collapsed={collapsed ? "true" : undefined}
      >
        {/* Fold/unfold is driven by the header inside the content (the whole
            top row is the hit target) and by the summary row below. */}
        {/* One flex chain from the card down to the scroll region, with
            `min-h-0` at every step and no percentage heights — a `height:100%`
            wrapper resolves to `auto` inside a max-height-clamped flex column,
            which silently stops the body from shrinking and lets the action row
            fall outside `overflow-hidden`. Hidden with an inline style rather
            than the `hidden` attribute: Tailwind's `.flex` utility would beat
            the preflight `[hidden]` rule and never hide the content at all. */}
        <div
          id={contentId}
          className="flex min-h-0 flex-1 flex-col"
          style={{ display: collapsed ? "none" : undefined }}
        >
          {request ? (
            <ExtensionUiRequestContent
              request={request}
              controller={controller}
              titleId={contentTitleId}
              variant="inline"
              onToggleFold={() => setCollapsed(true)}
              foldExpanded={!collapsed}
              answeredCount={group?.answeredCount}
            />
          ) : (
            <div
              role="button"
              tabIndex={0}
              aria-expanded={!collapsed}
              aria-controls={contentId}
              aria-label={t("extUiCollapseQuestion")}
              title={t("extUiCollapseQuestion")}
              data-extension-ui-fold-toggle="true"
              className="flex min-h-20 cursor-pointer items-center gap-2 rounded-md pr-7 text-sm text-muted transition-colors hover:bg-surface-overlay/60"
              onClick={() => setCollapsed(true)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                setCollapsed(true);
              }}
            >
              <div
                id={contentTitleId}
                className="flex min-w-0 flex-1 items-center gap-2"
                role="status"
                aria-live="polite"
              >
                <LoaderCircle
                  className="size-4 shrink-0 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
                <span>{t("extUiGroupWaiting")}</span>
              </div>
              {answeredCount > 0 ? (
                <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted">
                  <Check className="size-3 shrink-0 text-success" aria-hidden="true" />
                  <span>{t("extUiGroupAnswered", { count: answeredCount })}</span>
                </span>
              ) : null}
            </div>
          )}
        </div>
        {collapsed ? (
          <button
            type="button"
            aria-expanded={false}
            aria-controls={contentId}
            title={t("extUiExpandQuestion")}
            className="group flex w-full items-center gap-2 rounded text-left"
            onClick={() => setCollapsed(false)}
          >
            {highRisk ? (
              <CircleAlert size={15} className="shrink-0 text-warning" aria-hidden="true" />
            ) : (
              <MessageCircleQuestion
                size={15}
                className="shrink-0 text-foreground/75"
                aria-hidden="true"
              />
            )}
            {/* Two lines instead of one: folding is also how the user reads a
                long question in full without expanding the card. The clamp box
                keeps its minimum height, so the text is centred inside it by a
                wrapper — a single line inside `min-h-6` would otherwise sit at
                the top of the box while the icon and badge beside it are
                centred on the row. */}
            {request ? (
              <span id={collapsedTitleId} className="flex min-h-6 min-w-0 flex-1 items-center">
                <span className="line-clamp-2 min-w-0 text-xs font-semibold">
                  {questionDisplayTitle(request, t("extUiDefaultTitle"))}
                </span>
              </span>
            ) : (
              <span className="min-w-0 flex-1 truncate text-xs">{t("extUiGroupWaiting")}</span>
            )}
            {request ? (
              <span className="shrink-0 text-[10px] font-medium text-accent">
                {t("extUiAwaitingAnswer")}
              </span>
            ) : answeredCount > 0 ? (
              <span className="shrink-0 text-[10px] text-muted">
                {t("extUiGroupAnswered", { count: answeredCount })}
              </span>
            ) : null}
            {highRisk ? (
              <span className="shrink-0 text-[10px] font-medium text-warning">
                {t("extUiHighRisk")}
              </span>
            ) : null}
            <ChevronDown
              size={14}
              className="shrink-0 text-muted transition-colors group-hover:text-foreground"
              aria-hidden="true"
            />
          </button>
        ) : null}
      </div>
    </section>
  );
}
