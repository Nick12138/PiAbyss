/**
 * `@`-style chip for an injected reference (memo handling, schedule preamble,
 * plan context). The raw prompt stays available behind the disclosure, but the
 * transcript never renders it inline — that is the whole point of the chip.
 */
import { useState } from "react";
import { CalendarClock, ChevronDown, ChevronUp, ListTodo, NotebookPen } from "lucide-react";
import { useT, type Translate } from "../../lib/i18n/use-t";
import type { InjectedReference, InjectedReferenceKind } from "./injected-references";

function referenceIcon(kind: InjectedReferenceKind) {
  if (kind === "memo") return ListTodo;
  if (kind === "memo-result") return NotebookPen;
  return CalendarClock;
}

function referenceLabel(kind: InjectedReferenceKind, t: Translate): string {
  switch (kind) {
    case "memo":
      return t("injectedRefMemo");
    case "memo-result":
      return t("injectedRefMemoResult");
    case "schedule-preamble":
      return t("injectedRefSchedulePreamble");
    case "schedule-job":
      return t("injectedRefScheduleJob");
  }
}

/** Chip caption, e.g. `@备忘录 · 修复登录按钮`. */
function injectedReferenceCaption(
  reference: Pick<InjectedReference, "kind" | "title">,
  t: Translate,
): string {
  const label = `@${referenceLabel(reference.kind, t)}`;
  return reference.title ? `${label} · ${reference.title}` : label;
}

export function InjectedReferenceChip({
  reference,
  /** `end` right-aligns the chip in the transcript's user column. */
  align = "start",
}: {
  reference: InjectedReference;
  align?: "start" | "end";
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const Icon = referenceIcon(reference.kind);
  return (
    <div
      className={`flex w-full min-w-0 flex-col ${align === "end" ? "items-end" : "items-start"}`}
      data-injected-reference={reference.kind}
    >
      <button
        type="button"
        className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-accent/35 bg-accent/5 px-2 text-xs text-muted transition-colors hover:bg-accent/10 hover:text-foreground"
        title={open ? t("injectedRefHideDetail") : t("injectedRefShowDetail")}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon size={12} className="shrink-0 text-accent" aria-hidden="true" />
        <span className="max-w-56 truncate sm:max-w-80">
          {injectedReferenceCaption(reference, t)}
        </span>
        {open ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
      </button>
      {open && (
        <pre className="mt-1 max-h-64 w-full overflow-auto whitespace-pre-wrap break-words rounded-md border border-dashed border-border bg-surface px-2 py-1.5 text-left text-[11px] leading-5 text-muted">
          {reference.body}
        </pre>
      )}
    </div>
  );
}
