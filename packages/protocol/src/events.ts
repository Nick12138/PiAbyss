export const HOST_EVENT_NAMES = [
  "host.ready",
  "host.statusChanged",
  "host.fatal",
  "workspace.changed",
  "workspace.filesChanged",
  "git.changed",
  "git.taskFinished",
  "schedule.notificationsChanged",
  "attachment.changed",
  "session.snapshot",
  "session.infoChanged",
  "session.runtimeChanged",
  "agent.event",
  "agent.toolsChanged",
  "agent.queueChanged",
  "agent.compactionChanged",
  "agent.retryChanged",
  "subagents.statusChanged",
  "model.changed",
  "provider.loginEvent",
  "package.progress",
  "package.snapshot",
  "package.resourcesChanged",
  "package.diagnostic",
  "extensionUi.request",
  "extensionUi.closed",
  "extensionUi.groupClosed",
  "extensionUi.statusChanged",
  "extensionUi.widgetChanged",
  "extensionUi.widgetAttentionRequested",
  "extensionUi.messageRendered",
  "extensionUi.notification",
  "extensionUi.customStarted",
  "extensionUi.customFrame",
  "extensionUi.customClosed",
] as const;

export type HostEventName = (typeof HOST_EVENT_NAMES)[number];

export function isHostEventName(value: unknown): value is HostEventName {
  return typeof value === "string" && (HOST_EVENT_NAMES as readonly string[]).includes(value);
}
