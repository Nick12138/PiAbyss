/**
 * 备忘录纯模型层：过滤、分组、展示辅助与「用 Agent 处理」的提示词组装。
 * 全部为纯函数，便于单元测试。
 */
import type { MemoNote, MemoNoteStatus } from "@piabyss/protocol";

/** 状态归类筛选（每个页签对应一个具体状态）。 */
export type MemoStatusFilter = MemoNoteStatus;

/** 纯文本路径的目录名（兼容 / 与 \ 分隔符）。 */
export function pathBasename(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

/** 从正文中取一行作为列表摘要（跳过首行标题）。 */
export function noteExcerpt(note: MemoNote, maxLength = 96): string {
  const lines = note.contentMd.split("\n").map((entry) => entry.trim());
  const first = lines.findIndex((entry) => entry.length > 0);
  const line = lines.slice(first + 1).find((entry) => entry.length > 0);
  const text = (line ?? "").replace(/^#+\s*/, "");
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/** 标题派生：第一个非空行，去掉 Markdown 标题井号，超长截断。 */
export function deriveTitle(contentMd: string, maxLength = 100): string {
  const line = contentMd
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  const text = (line ?? "").replace(/^#+\s*/, "").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/**
 * 从正文提取标签：按行扫描，跳过代码块；词首 `#xxx` 记为标签，
 * 去掉词尾标点，大小写去重、保序。井号后带空格的标题行不会误识别。
 */
export function extractTags(contentMd: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  let inCodeFence = false;
  for (const line of contentMd.split("\n")) {
    if (/^\s*```/.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;
    for (const token of line.split(/\s+/)) {
      if (!token.startsWith("#")) continue;
      const tag = token
        .replace(/^#+/, "")
        .replace(/[，。；、！？：,.!?;:)）】\]】>#]+$/u, "")
        .trim();
      if (!tag) continue;
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(tag);
    }
  }
  return result;
}

export type MemoFilter = {
  status: MemoStatusFilter;
  /** 小写 tag；null = 不筛选。 */
  tag: string | null;
  /** 工作区提示（按目录名或路径包含匹配）；null = 不筛选。 */
  workspace: string | null;
  /** 标题/正文包含的查询词。 */
  query: string;
};

export function filterNotes(notes: MemoNote[], filter: MemoFilter): MemoNote[] {
  const query = filter.query.trim().toLowerCase();
  const tagKey = filter.tag?.toLowerCase() ?? null;
  const workspaceKey = filter.workspace?.toLowerCase() ?? null;
  return notes.filter((note) => {
    if (note.status !== filter.status) return false;
    if (tagKey && !note.tags.some((tag) => tag.toLowerCase() === tagKey)) return false;
    if (workspaceKey && !noteMatchesWorkspace(note, workspaceKey)) return false;
    if (query) {
      const haystack = `${note.title}\n${note.contentMd}\n${note.tags.join("\n")}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

/** 列表排序：进行中按 updatedAt 倒序；已完成按 completedAt 倒序。 */
export function sortNotesForList(notes: MemoNote[], status: MemoStatusFilter): MemoNote[] {
  const sorted = [...notes];
  if (status === "done") {
    sorted.sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
  } else {
    sorted.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  return sorted;
}

/** 状态计数（归类页签的角标）。 */
export function statusCounts(notes: MemoNote[]): Record<MemoNoteStatus, number> {
  const counts: Record<MemoNoteStatus, number> = {
    open: 0,
    done: 0,
    archived: 0,
  };
  for (const note of notes) counts[note.status] += 1;
  return counts;
}

/** 展示用标签串（#a #b）。 */
export function formatTags(tags: readonly string[]): string {
  return tags.map((tag) => `#${tag}`).join(" ");
}

/**
 * 标签的稳定色相：同一内容永远同一颜色（djb2 哈希 → 0-359）。
 * 展示层用 `hsl(hue … / alpha)` 半透明着色，兼容明暗主题。
 */
export function tagHue(tag: string): number {
  let hash = 5381;
  for (let index = 0; index < tag.length; index += 1) {
    hash = ((hash << 5) + hash + tag.charCodeAt(index)) >>> 0;
  }
  return hash % 360;
}

/** 记录是否匹配工作区提示（提示是目录名或路径片段）。 */
export function noteMatchesWorkspace(note: MemoNote, workspaceCwd: string): boolean {
  if (!note.workspaceHint) return false;
  const hint = note.workspaceHint.toLowerCase();
  const cwd = workspaceCwd.toLowerCase();
  if (cwd.includes(hint)) return true;
  return pathBasename(workspaceCwd).toLowerCase() === hint;
}

/** 详情页工作区关联提示：与当前工作区不一致时展示。 */
export function workspaceMismatch(note: MemoNote, workspaceCwd: string | null): string | null {
  if (!note.workspaceHint) return null;
  if (workspaceCwd && noteMatchesWorkspace(note, workspaceCwd)) return null;
  return note.workspaceHint;
}

/** 全部记录里出现过的标签（小写去重，保序）。 */
export function collectTags(notes: readonly MemoNote[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const note of notes) {
    for (const tag of note.tags) {
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(tag);
    }
  }
  return result;
}

/** 全部记录里出现过的工作区提示。 */
export function collectWorkspaces(notes: readonly MemoNote[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const note of notes) {
    const hint = note.workspaceHint;
    if (!hint) continue;
    const key = hint.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(hint);
  }
  return result;
}

/** 列表/详情用的时间格式：YYYY-MM-DD HH:mm（本地时区）。 */
export function formatMemoDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * 「用 Agent 处理」的引用块：结构化 XML 标签承载记录元数据与正文，
 * 图片以绝对路径列出，agent 可用自己的读取工具查看。
 */
export function composeMemoPrompt(note: MemoNote): string {
  const attributes = [
    `id="${note.id}"`,
    `type="${note.type}"`,
    `status="${note.status}"`,
    ...(note.tags.length ? [`tags="${note.tags.join(",")}"`] : []),
    ...(note.workspaceHint ? [`workspace="${note.workspaceHint}"`] : []),
  ].join(" ");
  const imageLines = note.images.map((image) => {
    const dir = `piabyss/memo/images/${note.id}`;
    return `- ${dir}/${image.fileName}`;
  });
  const sections = [
    `<piabyss-memo ${attributes}>`,
    `# ${note.title}`,
    "",
    note.contentMd.trim(),
    ...(imageLines.length ? ["", "图片：", ...imageLines] : []),
    "</piabyss-memo>",
  ];
  return sections.join("\n");
}

/**
 * 组装注入会话草稿的完整文本：引用块 + 指令 + 用户已有草稿。
 * 顺序为「块 → 指令 → 已有草稿」，保证用户自己的输入始终在最后。
 */
export function withMemoPrompt(existingDraft: string, block: string, instruction: string): string {
  const parts = [block, instruction];
  const existing = existingDraft.trim();
  if (existing) parts.push(existing);
  return parts.join("\n\n");
}

/**
 * 「继续讨论」的结果总结段：以独立的 XML 块承载最近一次 Agent 处理总结，
 * 与记录引用块（composeMemoPrompt）拼接后注入草稿。
 */
export function composeMemoResultSection(note: MemoNote): string {
  const result = note.result;
  if (!result) return "";
  const attributes = [
    `noteId="${note.id}"`,
    `sessionId="${result.sessionId}"`,
    ...(result.sessionTitle ? [`sessionTitle="${result.sessionTitle}"`] : []),
  ].join(" ");
  return [
    `<piabyss-memo-result ${attributes}>`,
    result.resultMd.trim(),
    "</piabyss-memo-result>",
  ].join("\n");
}
