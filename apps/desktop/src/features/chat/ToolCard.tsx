import { useId, useState, type ReactNode } from "react";
import { Braces, ChevronRight, FileCode2, Search, Terminal, Wrench } from "lucide-react";
import type { ToolTraceStatus } from "./transcript-model";
import { useT, type Translate } from "../../lib/i18n/use-t";
import { CollapsibleRegion } from "../../components/CollapsibleRegion";
import { isWebSearchTool } from "./tool-names";

function limitToolText(value: string, truncatedLabel = "[tool data truncated]"): string {
  const limit = 100_000;
  return value.length <= limit ? value : `${value.slice(0, limit)}\n... ${truncatedLabel}`;
}

export function toolValueText(value: unknown, truncatedLabel = "[tool data truncated]"): string {
  if (value === undefined) return "";
  if (typeof value === "string") {
    try {
      return limitToolText(JSON.stringify(JSON.parse(value), null, 2), truncatedLabel);
    } catch {
      return limitToolText(value, truncatedLabel);
    }
  }
  try {
    return limitToolText(JSON.stringify(value, null, 2) ?? "null", truncatedLabel);
  } catch {
    return limitToolText(String(value), truncatedLabel);
  }
}

export function toolSummary(value: unknown): string {
  let record: Record<string, unknown> | null = null;
  if (value && typeof value === "object") {
    record = value as Record<string, unknown>;
  } else if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") record = parsed as Record<string, unknown>;
    } catch {
      return value.split("\n")[0]?.slice(0, 80) ?? "";
    }
  }
  if (!record) return "";
  for (const key of ["path", "filePath", "pattern", "query", "command", "url"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) {
      const firstLine = candidate.trim().split("\n")[0] ?? "";
      return firstLine.length > 80 ? `${firstLine.slice(0, 80)}...` : firstLine;
    }
  }
  return Object.entries(record)
    .slice(0, 2)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(" | ")
    .slice(0, 80);
}

function toolIcon(name: string) {
  const normalized = name.toLocaleLowerCase();
  if (["bash", "shell", "exec", "command"].some((part) => normalized.includes(part))) {
    return Terminal;
  }
  if (["read", "write", "edit", "file"].some((part) => normalized.includes(part))) {
    return FileCode2;
  }
  if (["find", "search", "grep", "glob"].some((part) => normalized.includes(part))) {
    return Search;
  }
  return Wrench;
}

export function statusLabel(status: ToolTraceStatus, t?: Translate): string {
  switch (status) {
    case "done":
      return t?.("toolStatusDone") ?? "Done";
    case "error":
      return t?.("toolStatusFailed") ?? "Failed";
    case "aborted":
      return t?.("toolStatusStopped") ?? "Stopped";
    case "running":
      return t?.("toolStatusRunning") ?? "Running";
    default:
      return t?.("toolStatusWaiting") ?? "Waiting";
  }
}

export type ToolCardProps = {
  name: string;
  args?: unknown;
  result?: unknown;
  resultContent?: ReactNode;
  details?: unknown;
  status: ToolTraceStatus;
  startedAt?: number;
  endedAt?: number;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
};

export function useToolDisclosure(
  props: Pick<ToolCardProps, "expanded" | "onExpandedChange">,
): [boolean, (expanded: boolean) => void] {
  const [localExpanded, setLocalExpanded] = useState(false);
  const expanded = props.expanded ?? localExpanded;
  const setExpanded = (next: boolean) => {
    if (props.expanded === undefined) setLocalExpanded(next);
    props.onExpandedChange?.(next);
  };
  return [expanded, setExpanded];
}

export function ToolCard(props: ToolCardProps) {
  const t = useT();
  const contentId = useId();
  const [open, setOpen] = useToolDisclosure(props);
  const Icon = toolIcon(props.name);
  // Web search keeps one localized name here too, so a degraded search card
  // (no parseable links, or an error) does not suddenly read as another tool.
  // The raw tool name stays available on the title attribute.
  const label = isWebSearchTool(props.name) ? t("toolSearch") : props.name;
  const canExpand =
    props.args !== undefined ||
    props.result !== undefined ||
    props.resultContent !== undefined ||
    props.details !== undefined;
  const summary = toolSummary(props.args);
  const statusClass =
    props.status === "running"
      ? "text-warning"
      : props.status === "error"
        ? "text-danger"
        : props.status === "done"
          ? "text-success"
          : "text-muted";

  return (
    <div className="group/tool min-w-0 max-w-full" data-ui="tool-card">
      <button
        type="button"
        className={`flex h-8 min-w-0 w-full items-center gap-2 rounded-md px-1.5 text-left transition-colors ${
          canExpand ? "hover:bg-surface-overlay/60" : "cursor-default"
        }`}
        onClick={() => {
          if (canExpand) setOpen(!open);
        }}
        aria-expanded={canExpand ? open : undefined}
        aria-controls={canExpand ? contentId : undefined}
      >
        <Icon size={14} className="shrink-0 text-muted" />
        <span
          className="min-w-0 max-w-[42%] truncate text-xs font-medium text-foreground/80"
          title={props.name}
        >
          {label}
        </span>
        {summary && (
          <span
            className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted"
            title={summary}
          >
            {summary}
          </span>
        )}
        {!summary && <span className="flex-1" />}
        <span className="shrink-0 text-[10px] text-muted max-[520px]:hidden">
          {formatDuration(props.startedAt, props.endedAt)}
        </span>
        <span className={`shrink-0 text-[10px] ${statusClass}`}>
          {statusLabel(props.status, t)}
        </span>
        {canExpand && (
          <ChevronRight
            size={13}
            className={`shrink-0 text-muted transition-transform duration-[160ms] motion-reduce:transition-none ${
              open ? "rotate-90" : ""
            }`}
          />
        )}
      </button>
      {canExpand && (
        <CollapsibleRegion open={open} id={contentId}>
          <div className="mb-2 ml-[22px] mt-1 flex flex-col gap-2">
            {props.args !== undefined && (
              <ToolSection label={t("toolArguments")} value={props.args} />
            )}
            {props.result !== undefined && (
              <ToolSection
                label={props.status === "error" ? t("toolError") : t("toolResult")}
                value={props.result}
                error={props.status === "error"}
                terminal={props.name.toLocaleLowerCase().includes("bash")}
              />
            )}
            {props.resultContent !== undefined && (
              <section>
                <div className="mb-1 text-[10px] font-medium text-muted">
                  {props.status === "error" ? t("toolError") : t("toolResult")}
                </div>
                <div
                  className={
                    props.status === "error"
                      ? "max-h-56 min-w-0 overflow-auto rounded-md bg-danger/10 px-3 py-2 text-danger"
                      : "max-h-56 min-w-0 overflow-auto rounded-md bg-surface-overlay/35 px-3 py-2 text-foreground/80"
                  }
                >
                  {props.resultContent}
                </div>
              </section>
            )}
            {props.details !== undefined && (
              <ToolSection label={t("toolDetails")} value={props.details} />
            )}
          </div>
        </CollapsibleRegion>
      )}
    </div>
  );
}

function ToolSection({
  label,
  value,
  error = false,
  terminal = false,
}: {
  label: string;
  value: unknown;
  error?: boolean;
  terminal?: boolean;
}) {
  const t = useT();
  return (
    <section>
      <div className="mb-1 text-[10px] font-medium text-muted">{label}</div>
      <pre
        className={`max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md px-3 py-2 font-mono text-[11px] leading-5 ${
          error
            ? "bg-danger/10 text-danger"
            : terminal
              ? "bg-[#171918] text-[#cbd5cc]"
              : "bg-surface-overlay/55 text-foreground/80"
        }`}
      >
        {toolValueText(value, t("transcriptToolDataTruncated"))}
      </pre>
    </section>
  );
}

export function ToolDetailsDisclosure({ details }: { details?: unknown }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (details === undefined || details === null) return null;
  return (
    <details
      className="mt-2 text-[10px] text-muted"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-1 hover:text-foreground [&::-webkit-details-marker]:hidden">
        <Braces size={12} />
        <span>{t("toolDetails")}</span>
      </summary>
      {open && (
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-overlay/50 px-2 py-1.5 font-mono text-[11px] leading-5 text-foreground/70">
          {toolValueText(details, t("transcriptToolDataTruncated"))}
        </pre>
      )}
    </details>
  );
}

export function formatDuration(startedAt?: number, endedAt?: number): string {
  if (!startedAt) return "";
  const end = endedAt ?? Date.now();
  const elapsed = Math.max(0, end - startedAt);
  return elapsed < 1_000 ? `${elapsed}ms` : `${(elapsed / 1_000).toFixed(1)}s`;
}
