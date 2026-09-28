import {
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  LoaderCircle,
  MessageCircleQuestion,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { ExtensionUiRequestContent } from "./ExtensionUiRequestContent";
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
  const collapseButton = (
    <button
      type="button"
      aria-expanded={true}
      aria-controls={contentId}
      aria-label={t("extUiCollapseQuestion")}
      title={t("extUiCollapseQuestion")}
      className="inline-flex size-6 shrink-0 items-center justify-center self-center rounded text-muted transition-colors hover:bg-surface-overlay hover:text-foreground"
      onClick={() => setCollapsed(true)}
    >
      <ChevronUp size={14} aria-hidden="true" />
    </button>
  );

  return (
    <section
      role="region"
      aria-labelledby={titleId}
      className="shrink-0 px-5 pt-2"
      data-extension-ui-surface="inline"
    >
      <div
        className={`conversation-content-width mx-auto w-full rounded-md border bg-surface-raised px-3.5 py-3 shadow-sm ${
          highRisk
            ? "border-warning/40"
            : collapsed && request
              ? "border-accent/40"
              : "border-border"
        }`}
        data-extension-ui-group={group?.groupKey}
        data-extension-ui-collapsed={collapsed ? "true" : undefined}
      >
        <div
          id={contentId}
          hidden={collapsed}
          className="max-h-[min(32rem,50dvh)] overflow-y-auto overscroll-contain"
        >
          {group && answeredCount > 0 ? (
            <div className="mb-3 flex min-h-6 items-center gap-1.5 border-b border-border pb-2 text-xs text-muted">
              <Check className="size-3.5 shrink-0 text-success" aria-hidden="true" />
              <span>{t("extUiGroupAnswered", { count: answeredCount })}</span>
            </div>
          ) : null}
          {request ? (
            <ExtensionUiRequestContent
              request={request}
              controller={controller}
              titleId={contentTitleId}
              variant="inline"
              headerAction={collapseButton}
            />
          ) : (
            <div className="flex min-h-20 items-center gap-2 text-sm text-muted">
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
              {collapseButton}
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
            <span id={collapsedTitleId} className="min-w-0 flex-1 truncate text-xs font-semibold">
              {request ? (request.title ?? t("extUiDefaultTitle")) : t("extUiGroupWaiting")}
            </span>
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
