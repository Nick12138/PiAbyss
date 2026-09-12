import { Circle, CircleCheck, CircleDot } from "lucide-react";
import { useT } from "../../lib/i18n/use-t";
import type { TodoItem } from "./todo-model";

export function todoNumber(item: TodoItem, todos: readonly TodoItem[]): number {
  const index = todos.findIndex((candidate) => candidate.id === item.id);
  return index >= 0 ? index + 1 : 0;
}

export function TodoRow({
  item,
  active,
  number,
}: {
  item: TodoItem;
  active: boolean;
  number: number;
}) {
  const t = useT();
  const text = item.status === "in_progress" && item.activeForm ? item.activeForm : item.content;
  const Icon =
    item.status === "completed" ? CircleCheck : item.status === "in_progress" ? CircleDot : Circle;
  const statusLabel =
    item.status === "completed"
      ? t("todoStatusCompleted")
      : item.status === "in_progress"
        ? t("todoStatusInProgress")
        : t("todoStatusPending");

  return (
    <li
      data-todo-status={item.status}
      className={`flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-sm ${
        active ? "bg-surface-overlay/70" : ""
      }`}
      title={`${statusLabel}\n${text}`}
    >
      <span
        aria-hidden="true"
        className={`w-5 shrink-0 text-right font-mono text-xs tabular-nums ${
          item.status === "completed" ? "text-muted/70" : "text-muted"
        }`}
      >
        #{number}
      </span>
      <Icon
        size={15}
        aria-hidden="true"
        className={`shrink-0 ${
          item.status === "completed"
            ? "text-success"
            : item.status === "in_progress"
              ? "text-accent"
              : "text-muted"
        }`}
      />
      <span
        className={`min-w-0 flex-1 truncate leading-4 ${
          item.status === "completed" ? "text-muted line-through" : "text-foreground"
        }`}
        title={text}
      >
        {text}
      </span>
    </li>
  );
}
