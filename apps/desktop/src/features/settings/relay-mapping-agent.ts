/**
 * 「映射机器人」入口的行为：取站点事实 → 解析默认工作区 → 切换/激活工作区 →
 * 新建会话 → 为每个选中的站点注入一个引用胶囊 → 跳聊天页。
 * 导航与注入复用备忘录「用 Agent 处理」的同一套机制。
 *
 * 入口在「中转站价格总表」右上角：多选站点后一次性派发，一条会话里挂多个
 * 站点胶囊（每个胶囊带该站自己的任务书）。空会话的草稿键是
 * `new:<cwd>`，多个空会话共用同一个键，所以一次派发只能落在一个会话里；
 * 想分多次派发就再点一次按钮。
 */
import type { RelayMappingHandoffResult } from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { hostContext } from "../../lib/bridge/host-context";
import { tCurrent } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { createNewSession } from "../../lib/commands/actions";
import { activateWorkspaceAcrossWorkspaces } from "../../lib/bridge/session-navigation";
import { draftKeyForTarget, draftTargetFor } from "../../lib/draft-target";
import { setDraftReferencesPersisted } from "../../lib/draft-persistence";
import { waitForWorkspaceServicesReady } from "../workspaces/workspace-switch-policy";
import { defaultProjectWorkspacePath } from "../memo/memo-model";
import { relayMappingReference } from "./relay-mapping-handoff";

/** 一个待映射的站点（合并后的候选，名字可能是多个镜像 provider）。 */
export type RelayMappingTarget = {
  stationId: string;
  providerName: string;
};

/** 向 host 请求站点事实（映射路径/baseUrl/key 位置/现有映射）。 */
async function fetchHandoff(stationId: string): Promise<RelayMappingHandoffResult | null> {
  const host = useAppStore.getState().host;
  if (!host) return null;
  try {
    const response = await hostClient.request(
      "provider.mapping.handoff",
      hostContext(host),
      { stationId },
      15_000,
    );
    if (!response?.ok) return null;
    return response.result as RelayMappingHandoffResult;
  } catch {
    return null;
  }
}

/**
 * 机器人图标按钮入口。返回 false 表示未能发起（错误已提示），
 * true 表示已注入草稿并跳转聊天页。
 */
export async function openRelayMappingAgents(
  targets: readonly RelayMappingTarget[],
): Promise<boolean> {
  const t = tCurrent;
  const state = useAppStore.getState();
  if (targets.length === 0) return false;

  const handoffs = await Promise.all(targets.map((target) => fetchHandoff(target.stationId)));
  const resolved = targets
    .map((target, index) => ({ target, handoff: handoffs[index] }))
    .filter(
      (item): item is { target: RelayMappingTarget; handoff: RelayMappingHandoffResult } =>
        item.handoff !== null && item.handoff !== undefined,
    );
  if (resolved.length === 0) {
    state.pushNotification(t("providersMappingHandoffFailed"), "error");
    return false;
  }
  if (resolved.length < targets.length) {
    // 部分站点取不到事实：仍然派发能派发的，并如实提示。
    state.pushNotification(
      t("providersMappingPartialHandoff", { count: targets.length - resolved.length }),
      "warning",
    );
  }

  // 目标：默认工作区（DefaultProject）。当前就在那里则无需切换。
  const targetCwd = defaultProjectWorkspacePath(state.host?.agentDir ?? null);
  if (!targetCwd) {
    state.pushNotification(t("providersMappingNoWorkspace"), "warning");
    return false;
  }
  if (state.workspace?.canonicalCwd !== targetCwd) {
    // optimistic:false —— 注入草稿前工作区图必须稳定。
    const activation = await activateWorkspaceAcrossWorkspaces(targetCwd, {
      optimistic: false,
    });
    if (activation.status !== "opened" && activation.status !== "already-active") return false;
  }
  if (!(await waitForWorkspaceServicesReady())) {
    state.pushNotification(t("providersMappingHandoffFailed"), "error");
    return false;
  }
  if (!(await createNewSession())) {
    state.pushNotification(t("providersMappingHandoffFailed"), "error");
    return false;
  }

  const after = useAppStore.getState();
  // 与 memo「用 Agent 处理」同一判定：新建会话消息为空时草稿键是
  // new-conversation（new:<cwd>），必须用 draftTargetFor 而不是看 session 是否存在。
  const target = draftTargetFor(after.workspace, after.session);
  if (!target) {
    after.pushNotification(t("providersMappingHandoffFailed"), "error");
    return false;
  }
  const existing = after.draftReferences[draftKeyForTarget(target)] ?? [];
  const injected = resolved.map(({ target: entry, handoff }) =>
    relayMappingReference(
      { stationId: entry.stationId, providerName: entry.providerName, handoff },
      t("providersMappingPrompt"),
    ),
  );
  const injectedIds = new Set(injected.map((reference) => reference.id));
  setDraftReferencesPersisted(target, [
    ...existing.filter((reference) => !injectedIds.has(reference.id)),
    ...injected,
  ]);
  after.setPage("chat");
  return true;
}
