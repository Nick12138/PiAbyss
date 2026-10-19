/**
 * 会话开场卡：把首条用户消息之前的三块系统物料（系统提示词 / `<pixie-context>`
 * 运行规则 / 上一段回顾）折成一行，展开后是三个各自可展开的小节。
 *
 * 默认全部收起——这些内容用户既没写、也改不了，只有"这次开场带了什么"值得
 * 一眼看到；回顾卡的一行摘要（上一段标题）直接印在标题行上，不点开也有用。
 */
import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, History, Sparkles, Terminal } from "lucide-react";
import { useT, type Translate } from "../../lib/i18n/use-t";
import type { PixieSegmentsRecap, TranscriptPreambleModel } from "./transcript-preamble";

function stringifyDetails(value: unknown, truncatedLabel: string): string {
  const limit = 100_000;
  let formatted: string;
  if (typeof value === "string") {
    formatted = value;
  } else {
    try {
      formatted = JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      formatted = String(value);
    }
  }
  return formatted.length <= limit
    ? formatted
    : `${formatted.slice(0, limit)}\n... ${truncatedLabel}`;
}

function PreambleBody({ children, mono = false }: { children: ReactNode; mono?: boolean }) {
  return (
    <pre
      className={`mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-raised/60 px-2 py-1.5 text-[11px] leading-5 text-foreground/70 ${
        mono ? "font-mono" : "font-sans"
      }`}
    >
      {children}
    </pre>
  );
}

function RecapBody({ recap }: { recap: PixieSegmentsRecap }) {
  if (recap.entries.length === 0) return <PreambleBody>{recap.text}</PreambleBody>;
  return (
    <div className="mt-1 space-y-2 rounded-md bg-surface-raised/60 px-2 py-1.5 text-[11px] leading-5">
      {recap.intro && <p className="whitespace-pre-wrap break-words text-muted">{recap.intro}</p>}
      <ul className="space-y-0.5">
        {recap.entries.map((entry) => (
          <li
            key={`${entry.index}:${entry.title}`}
            className="flex min-w-0 items-baseline gap-2"
            data-pixie-recap-entry
          >
            <span className="w-4 shrink-0 text-right tabular-nums text-muted">{entry.index}</span>
            <span className="min-w-0 flex-1 truncate text-foreground/80">{entry.title}</span>
            <span className="shrink-0 text-muted">{entry.meta}</span>
          </li>
        ))}
      </ul>
      {recap.tailHeading && <div className="pt-1 text-muted">{recap.tailHeading}</div>}
      {recap.tail && <PreambleBody>{recap.tail}</PreambleBody>}
    </div>
  );
}

function PreambleSection({
  icon,
  label,
  meta,
  children,
}: {
  icon: ReactNode;
  label: string;
  meta?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-w-0" data-transcript-preamble-section>
      <button
        type="button"
        className="flex min-h-7 w-full cursor-pointer items-center gap-2 rounded-md px-1 text-left text-[11px] text-muted transition-colors hover:bg-surface-overlay/40 hover:text-foreground"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="shrink-0 text-muted" aria-hidden="true">
          {icon}
        </span>
        <span className="min-w-0 truncate">{label}</span>
        {meta && <span className="shrink-0 text-[10px] text-muted/80">{meta}</span>}
        <ChevronRight
          size={11}
          aria-hidden="true"
          className={`ml-auto shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && <div className="ml-[22px] min-w-0">{children}</div>}
    </div>
  );
}

/** 标题行摘要：优先报上一段的标题（最有用），否则说明规则已注入。 */
function preambleSummary(model: TranscriptPreambleModel, t: Translate): string {
  const previous = model.recap?.entries[0]?.title;
  if (previous) return t("transcriptPreambleWithRecap", { title: previous });
  if (model.rules) return t("transcriptPreambleWithRules");
  return t("transcriptPreamble");
}

export function TranscriptPreamble({ model }: { model: TranscriptPreambleModel }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const summary = preambleSummary(model, t);
  return (
    <div className="min-w-0" data-transcript-preamble>
      <button
        type="button"
        className="flex min-h-8 w-full min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-surface-raised/30 px-3 py-1.5 text-left text-[11px] text-muted transition-colors hover:bg-surface-raised/60 hover:text-foreground"
        aria-expanded={open}
        title={open ? t("transcriptPreambleHide") : t("transcriptPreambleShow")}
        onClick={() => setOpen((value) => !value)}
      >
        <Sparkles size={12} className="shrink-0 text-accent" aria-hidden="true" />
        <span className="min-w-0 truncate">{summary}</span>
        <ChevronDown
          size={12}
          aria-hidden="true"
          className={`ml-auto shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="mt-1.5 space-y-0.5 rounded-lg border border-border/60 bg-surface-raised/20 p-1.5">
          {model.rules && (
            <PreambleSection
              icon={<Sparkles size={11} />}
              label={t("transcriptPreambleRules")}
              meta={t("transcriptPreambleAutoInjected")}
            >
              <PreambleBody>{model.rules}</PreambleBody>
            </PreambleSection>
          )}
          {model.recap && (
            <PreambleSection
              icon={<History size={11} />}
              label={t("pixieSegmentsDivider")}
              meta={
                model.recap.entries.length > 0
                  ? t("transcriptPreambleSegmentCount", { count: model.recap.entries.length })
                  : undefined
              }
            >
              <RecapBody recap={model.recap} />
            </PreambleSection>
          )}
          {model.systemPrompt !== undefined && (
            <PreambleSection
              icon={<Terminal size={11} />}
              label={t("transcriptSystemPrompt")}
              meta={t("transcriptPreambleRaw")}
            >
              <PreambleBody mono>
                {stringifyDetails(model.systemPrompt, t("transcriptDetailsTruncated"))}
              </PreambleBody>
            </PreambleSection>
          )}
        </div>
      )}
    </div>
  );
}
