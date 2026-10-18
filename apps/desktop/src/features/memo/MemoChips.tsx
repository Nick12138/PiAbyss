/**
 * 标签 / 工作区胶囊。待办 · 速记列表与随行面板共用，配色走同一个 `tagHue`，
 * 保证同一条记录在两个页面里颜色一致。
 */
import { tagHue } from "./memo-model";

/** 紧凑档给右栏的窄列表用（面板里一行要塞下标签 + 工作区 + 时间）。 */
const CHIP_SIZE = {
  normal: "px-1.5 py-0.5 text-[11px]",
  compact: "px-1 py-px text-[10px]",
} as const;

export function TagChip({ tag, size = "normal" }: { tag: string; size?: keyof typeof CHIP_SIZE }) {
  const hue = tagHue(tag);
  return (
    <span
      className={`rounded font-medium ${CHIP_SIZE[size]}`}
      style={{
        color: `hsl(${hue} 65% 42%)`,
        backgroundColor: `hsl(${hue} 70% 50% / 0.14)`,
      }}
    >
      #{tag}
    </span>
  );
}

export function WorkspaceChip({
  name,
  size = "normal",
}: {
  name: string;
  size?: keyof typeof CHIP_SIZE;
}) {
  const hue = tagHue(name);
  return (
    <span
      className={`max-w-full truncate rounded font-medium ${CHIP_SIZE[size]}`}
      style={{
        color: `hsl(${hue} 45% 48%)`,
        backgroundColor: `hsl(${hue} 45% 50% / 0.14)`,
      }}
    >
      {name}
    </span>
  );
}
