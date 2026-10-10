/**
 * 备忘录「交给 Agent 处理」流程（从 MemoPage 抽出，供多处复用）：
 *
 *   - 备忘录页详情的「执行」按钮（原 openWithAgent）；
 *   - 桌面速记小窗的机器人按钮：App.tsx 收到小窗跳转事件（action=agent）后
 *     直接调用 openMemoWithAgentById —— 不经过备忘录页，直接切到会话页。
 *
 * 流程：解析记录关联的工作区（必要时切换）→ 新建会话 → 注入 `@备忘录`
 * 引用胶囊 → 切到对话页。记录置为「进行中」并绑定会话推迟到消息真正发出时
 * （见 memo-handoff.ts）。
 */
import type { MemoNote } from "@piabyss/protocol";
import {
  draftKeyForTarget,
  draftTargetFor,
  type DraftReference,
  type DraftTarget,
} from "../../lib/draft-target";
import { setDraftReferencesPersisted } from "../../lib/draft-persistence";
import { activateWorkspaceAcrossWorkspaces } from "../../lib/bridge/session-navigation";
import { waitForWorkspaceServicesReady } from "../workspaces/workspace-switch-policy";
import { buildInjectedReferenceEnvelope } from "../chat/injected-references";
import { createNewSession } from "../../lib/commands/actions";
import { useAppStore } from "../../lib/stores/app-store";
import { tCurrent } from "../../lib/i18n/use-t";
import { listMemoNotes } from "./memo-client";
import {
  composeMemoPrompt,
  defaultProjectWorkspacePath,
  noteMatchesWorkspace,
  resolveWorkspaceHint,
  withMemoPrompt,
} from "./memo-model";

type WorkspaceSettingsSnapshot =
  | {
      defaultWorkspace?: string | null;
      lastWorkspace?: string | null;
      knownWorkspaces?: string[];
    }
  | null
  | undefined;

/**
 * 解析备忘录应落入的工作区路径：提示在「当前工作区 + knownWorkspaces +
 * 内置默认工作区」里匹配（精确路径 > 末段 > 包含，见 resolveWorkspaceHint）；
 * 匹配不上（名称写错 / 工作区从未激活过等）回退默认工作区：用户配置的
 * defaultWorkspace → 内置 DefaultProject（<agentDir>/piabyss/DefaultProject）
 * → lastWorkspace → 当前工作区。提示为空时调用方应直接用当前。
 */
export function resolveMemoTargetCwd(
  hint: string,
  currentCwd: string | null,
  settings: WorkspaceSettingsSnapshot,
  agentDir: string | null,
): string | null {
  const known = settings?.knownWorkspaces ?? [];
  const defaultProject = defaultProjectWorkspacePath(agentDir);
  const candidates = [...known];
  if (currentCwd) candidates.unshift(currentCwd);
  if (
    defaultProject &&
    !candidates.some((entry) => entry.toLowerCase() === defaultProject.toLowerCase())
  ) {
    candidates.push(defaultProject);
  }
  const resolved = resolveWorkspaceHint(hint, candidates);
  if (resolved) return resolved;
  if (settings?.defaultWorkspace) return settings.defaultWorkspace;
  if (defaultProject) return defaultProject;
  if (settings?.lastWorkspace) return settings.lastWorkspace;
  return currentCwd ?? null;
}

/**
 * 把一条备忘录引用注入指定草稿：composer 只显示 `@备忘录 · 标题` 胶囊，
 * 提示词原文（引用块 + 指令）在发送时才展开进消息。
 */
export function injectMemoReference(target: DraftTarget, note: MemoNote, payload: string) {
  const state = useAppStore.getState();
  const key = draftKeyForTarget(target);
  const reference: DraftReference = {
    id: `memo:${note.id}`,
    kind: "memo",
    label: note.title,
    payload: buildInjectedReferenceEnvelope({
      kind: "memo",
      title: note.title,
      body: payload,
    }),
  };
  const existing = state.draftReferences[key] ?? [];
  setDraftReferencesPersisted(target, [
    ...existing.filter((item) => item.id !== reference.id),
    reference,
  ]);
}

/**
 * 把记录以引用胶囊注入新会话草稿，并切到对话页（总是新开会话，不影响当前选中的会话）。
 * 会先跳转到记录关联的工作区（workspaceHint 匹配 knownWorkspaces；匹配不上
 * 回退默认工作区），再在目标工作区里新建会话。
 * 注入的是结构化引用（composer 渲染成 `@备忘录` 胶囊），提示词原文只在发送时展开，
 * 不会显示在输入框里。
 */
export async function openMemoWithAgent(note: MemoNote): Promise<void> {
  const before = useAppStore.getState();
  const pushNotification = before.pushNotification;
  if (!before.workspace) {
    pushNotification(tCurrent("memoAgentNoWorkspace"), "warning");
    return;
  }
  const hint = note.workspaceHint?.trim();
  // 提示就是当前工作区（含不区分大小写的 basename 匹配）时无需切换。
  const targetCwd =
    !hint || noteMatchesWorkspace(note, before.workspace.canonicalCwd)
      ? before.workspace.canonicalCwd
      : resolveMemoTargetCwd(
          hint,
          before.workspace.canonicalCwd,
          before.desktopSettings,
          before.host?.agentDir ?? null,
        );
  if (!targetCwd) {
    pushNotification(tCurrent("memoAgentNoWorkspace"), "warning");
    return;
  }
  if (targetCwd !== before.workspace.canonicalCwd) {
    // 切换必须等到构建稳定（optimistic: false），否则 session.create 会撞锁。
    const activation = await activateWorkspaceAcrossWorkspaces(targetCwd, {
      optimistic: false,
    });
    if (activation.status !== "opened" && activation.status !== "already-active") return;
  }
  // 刚提交的乐观切换可能还在后台建图（servicesReady=false），等就绪再建会话，
  // 避免 session.create 静默失败。
  if (!(await waitForWorkspaceServicesReady())) {
    pushNotification(tCurrent("memoAgentCreateFailed"), "error");
    return;
  }
  const created = await createNewSession();
  if (!created) {
    pushNotification(tCurrent("memoAgentCreateFailed"), "error");
    return;
  }
  const state = useAppStore.getState();
  const target = draftTargetFor(state.workspace, state.session);
  if (!target) {
    pushNotification(tCurrent("memoAgentCreateFailed"), "error");
    return;
  }
  // 这里只「预约」：注入引用胶囊并跳转聊天。记录置为「进行中」并绑定会话
  // 推迟到消息真正发出时（见 memo-handoff.ts）——否则用户没发消息就离开、
  // 或把新会话删掉，记录就会卡在「进行中」并指向一个打不开的会话。
  injectMemoReference(
    target,
    note,
    withMemoPrompt(
      "",
      composeMemoPrompt(note, state.host?.agentDir ?? null),
      tCurrent("memoAgentPrompt"),
    ),
  );
  state.setPage("chat");
}

/**
 * 按 id 交给 Agent 处理（速记小窗机器人按钮入口）：拉一次最新列表找到记录
 * 后走 openMemoWithAgent；记录已不存在则静默返回（小窗数据可能滞后）。
 */
export async function openMemoWithAgentById(noteId: string): Promise<void> {
  let note: MemoNote | undefined;
  try {
    note = (await listMemoNotes()).find((entry) => entry.id === noteId);
  } catch {
    note = undefined;
  }
  if (!note) return;
  await openMemoWithAgent(note);
}
