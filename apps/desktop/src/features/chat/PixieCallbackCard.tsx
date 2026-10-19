/**
 * 委派回执卡：Host 把 `<pixie-report>` / `<pixie-error>` / `<pixie-progress>` /
 * `<pixie-stopped>` / `<pixie-ask>` 等信封当用户消息投回来。它们是系统事件、
 * 不是用户说的话，所以按工具卡的样子折叠成一行（图标 + 标题 + 一行摘要），
 * 不再占一个用户气泡。
 */
import { useId, useState } from "react";
import {
  Activity,
  Ban,
  Bot,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  MessageCircleQuestion,
  MessageSquare,
  RotateCcw,
} from "lucide-react";
import { CollapsibleRegion } from "../../components/CollapsibleRegion";
import { useT } from "../../lib/i18n/use-t";
import type { InjectedReference } from "./injected-references";
import { pixieCallbackLabel, pixieCallbackSummary } from "./pixie-callbacks";

function callbackIcon(variant: string | undefined) {
  switch (variant) {
    case "error":
      return CircleAlert;
    case "stopped":
      return Ban;
    case "ask":
      return MessageCircleQuestion;
    case "progress":
      return Activity;
    case "report":
      return CircleCheck;
    case "reply":
    case "interject":
      return MessageSquare;
    case "resume":
      return RotateCcw;
    default:
      return Bot;
  }
}

function callbackTone(variant: string | undefined): string {
  switch (variant) {
    case "error":
      return "text-danger";
    case "stopped":
      return "text-warning";
    case "report":
      return "text-success";
    case "ask":
      return "text-accent";
    default:
      return "text-muted";
  }
}

export function PixieCallbackCard({ reference }: { reference: InjectedReference }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const Icon = callbackIcon(reference.variant);
  const label = pixieCallbackLabel(reference.variant, t);
  const summary = pixieCallbackSummary(reference.body, reference.variant);
  return (
    <div
      className="min-w-0 max-w-full"
      data-pixie-callback={reference.variant ?? "unknown"}
      data-dispatch-id={reference.title || undefined}
    >
      <button
        type="button"
        className="flex h-8 min-w-0 w-full items-center gap-2 rounded-md px-1.5 text-left transition-colors hover:bg-surface-overlay/60"
        aria-expanded={open}
        aria-controls={contentId}
        title={open ? t("pixieCallbackHide") : t("pixieCallbackShow")}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon
          size={14}
          className={`shrink-0 ${callbackTone(reference.variant)}`}
          aria-hidden="true"
        />
        <span className="shrink-0 text-xs font-medium text-foreground/80">{label}</span>
        {summary ? (
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted" title={summary}>
            {summary}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <ChevronRight
          size={13}
          aria-hidden="true"
          className={`shrink-0 text-muted transition-transform duration-150 motion-reduce:transition-none ${
            open ? "rotate-90" : ""
          }`}
        />
      </button>
      <CollapsibleRegion open={open} id={contentId}>
        <div className="mb-2 ml-[22px] mt-1 min-w-0">
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-overlay/50 px-3 py-2 font-mono text-[11px] leading-5 text-foreground/70">
            {reference.body}
          </pre>
          {reference.title && (
            <div className="mt-1 break-all text-[10px] text-muted">
              dispatchId · {reference.title}
            </div>
          )}
        </div>
      </CollapsibleRegion>
    </div>
  );
}
