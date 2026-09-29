/**
 * 「字段映射」机器人按钮的行为：取站点事实 → 解析默认工作区 →
 * 切换/激活工作区 → 新建会话 → 注入引用胶囊 → 跳聊天页。
 * 导航与注入复用备忘录「用 Agent 处理」的同一套机制。
 */
import type { RelayMappingHandoffResult } from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { hostContext } from "../../lib/bridge/host-context";
import { tCurrent } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { createNewSession } from "../../lib/commands/actions";
import { activateWorkspaceAcrossWorkspaces } from "../../lib/bridge/session-navigation";
import { setDraftReferencesPersisted } from "../../lib/draft-persistence";
import { draftTargetFor } from "../../lib/draft-target";
import { waitForWorkspaceServicesReady } from "../workspaces/workspace-switch-policy";
import { defaultProjectWorkspacePath } from "../memo/memo-model";
import { relayMappingReference } from "./relay-mapping-handoff";

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
export async function openRelayMappingAgent(
  stationId: string,
  providerName: string,
): Promise<boolean> {
  const t = tCurrent;
  const state = useAppStore.getState();
  const handoff = await fetchHandoff(stationId);
  if (!handoff) {
    state.pushNotification(t("providersMappingHandoffFailed"), "error");
    return false;
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
  const reference = relayMappingReference(
    { stationId, providerName, handoff },
    t("providersMappingPrompt"),
  );
  setDraftReferencesPersisted(target, [reference]);
  after.setPage("chat");
  return true;
}
