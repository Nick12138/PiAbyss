/**
 * Method/event maps for fully typed cross-process envelopes (R2).
 */
import type { HostError, JsonValue } from "./errors.js";
import type { WorkspaceFilePreview, WorkspaceTextFile } from "./file-preview.js";
import type { HostMethod } from "./methods.js";
import type { HostEventName } from "./events.js";
import type {
  EmptyContext,
  HostContext,
  WorkspaceContext,
  ActiveSessionContext,
  SessionTargetContext,
  NullableSessionContext,
  ToolMutationContext,
  WorkspacePackageContext,
  SessionPackageContext,
} from "./methods.js";
import type {
  HostStatusSnapshot,
  WorkspaceSnapshot,
  WorkspaceDirectoryEntry,
  SessionSnapshot,
  SessionSummary,
  SessionStatsSnapshot,
  SessionUsageReport,
  SessionSearchReport,
  ToolSnapshot,
  ModelSummary,
  ModelConfigHealth,
  PackageSnapshot,
  PackageCatalog,
  PackageMutationResult,
  PackageUpdateSummary,
  PackageRecord,
  ResourcePreferenceUpdate,
  ResourceRecord,
  ExtensionUiClosed,
  ExtensionUiGroupClosed,
  ExtensionUiRequest,
  ExtensionMessageRenderSnapshot,
  ExtensionDecisionPresentation,
  SerializableSessionEntry,
  SerializableSessionTreeNode,
  SerializableCompactionResult,
  SerializableImage,
  SubagentSessionSnapshot,
  SerializableAgentSessionEvent,
  SessionRuntimeState,
  ProviderDraft,
  ProviderSnapshot,
  DiscoveredProviderModel,
  ProviderConnectionResult,
  RelayPricingFetchParams,
  RelayPricingResult,
  RelayBalance,
  RelayRechargeRatio,
  RelayMappingResult,
  RelayMappingSetParams,
  RelayMappingHandoffResult,
  RelayMappingPickerResult,
  TelegramValidateTokenResult,
  TelegramProfileSummary,
  TelegramSessionListResult,
  TelegramSessionDetail,
  TelegramAssistantConfig,
  TelegramVoiceConfig,
  TelegramThreadsConfig,
  TelegramConfigResult,
  TelegramBridgeStatus,
  BuiltinProviderAuthStatus,
  BuiltinProviderModelsResult,
  ProviderLoginFlowEvent,
  CommandSummary,
  RehydrateSnapshot,
  QueueSnapshot,
  AttachmentSnapshot,
  GitStatusSnapshot,
  GitDiffSnapshot,
  GitBranchList,
  GitHistoryResult,
  GitCommitDiffSnapshot,
  GitMutationResult,
  GitAsyncAccepted,
  GitTaskFinishedPayload,
  GitCommitResult,
  GitCommitMessageResult,
  PiSettingsSnapshot,
  PiSettingsPatch,
  SkillPathMutation,
  WorkspaceTargetRef,
  SkillSnapshot,
  PromptSnapshot,
  PluginLibraryApplyParams,
  PluginLibraryCatalog,
  PluginLibraryEnvUpdate,
  SubagentsStatusSnapshot,
  ShellJobsSnapshot,
  ShellJobOutput,
  AutomationJob,
  AutomationJobInput,
  AutomationJobPatch,
  AutomationPermission,
  AutomationRunMessages,
  AutomationRunSummary,
  AutomationStatus,
  AutomationNotification,
  PixieDispatchKind,
  PixieDispatchRecord,
  PixieSessionAlive,
  PixieStopAction,
  PixieTaskTreeWorkspace,
  PixieUsageStats,
  PixieWorkspaceSessionSummary,
  MemoNote,
  MemoNoteStatus,
  MemoImageInput,
  MemoRecurrence,
  MemoDraft,
  MemoDraftInput,
  MemoSyncSettings,
} from "./types.js";

export type HostContextMap = {
  "system.hello": EmptyContext;
  "system.getStatus": HostContext;
  "system.rehydrate": HostContext;
  "system.shutdown": HostContext;
  "piSettings.get": HostContext;
  "piSettings.patch": HostContext;
  "workspace.setCurrent": WorkspaceContext;
  "workspace.getCurrent": WorkspaceContext;
  "workspace.searchFiles": WorkspaceContext;
  "workspace.listDirectory": WorkspaceContext;
  "workspace.readFilePreview": WorkspaceContext;
  "workspace.writeTextFile": WorkspaceContext;
  "workspace.setDirectoryWatches": WorkspaceContext;
  "git.getStatus": WorkspaceContext;
  "git.setWatching": WorkspaceContext;
  "git.getDiff": WorkspaceContext;
  "git.mutateHunk": WorkspaceContext;
  "git.stage": WorkspaceContext;
  "git.stageAll": WorkspaceContext;
  "git.unstage": WorkspaceContext;
  "git.unstageAll": WorkspaceContext;
  "git.discard": WorkspaceContext;
  "git.discardAll": WorkspaceContext;
  "git.commit": WorkspaceContext;
  "git.listBranches": WorkspaceContext;
  "git.createBranch": WorkspaceContext;
  "git.switchBranch": WorkspaceContext;
  "git.listHistory": WorkspaceContext;
  "git.getCommitDiff": WorkspaceContext;
  "git.generateCommitMessage": WorkspaceContext;
  "git.push": WorkspaceContext;
  "git.pull": WorkspaceContext;
  "attachment.create": ActiveSessionContext;
  "attachment.createText": ActiveSessionContext;
  "attachment.get": ActiveSessionContext;
  "attachment.remove": ActiveSessionContext;
  "session.list": WorkspaceContext;
  "session.create": NullableSessionContext;
  "session.open": NullableSessionContext;
  "session.reload": ActiveSessionContext;
  "session.archive": WorkspaceContext;
  "session.restore": WorkspaceContext;
  "session.delete": WorkspaceContext;
  "session.cleanupArchived": WorkspaceContext;
  "session.getSnapshot": WorkspaceContext;
  "session.setName": ActiveSessionContext;
  "session.appendCustomMessage": ActiveSessionContext;
  "session.rename": WorkspaceContext;
  "session.getEntries": ActiveSessionContext;
  "session.getTree": ActiveSessionContext;
  "session.getStats": ActiveSessionContext;
  "session.getForkPoints": ActiveSessionContext;
  "session.fork": ActiveSessionContext;
  "session.export": WorkspaceContext;
  "session.usageReport": WorkspaceContext;
  "session.searchAll": HostContext;
  "session.getCommands": ActiveSessionContext;
  "subagents.getSession": WorkspaceContext;
  "subagents.stop": WorkspaceContext;
  "subagents.pause": WorkspaceContext;
  "subagents.continue": WorkspaceContext;
  "subagents.resume": WorkspaceContext;
  "subagents.send": WorkspaceContext;
  "shelljobs.list": HostContext;
  "shelljobs.output": HostContext;
  "shelljobs.stop": HostContext;
  "agent.prompt": ActiveSessionContext;
  "agent.steer": ActiveSessionContext;
  "agent.followUp": ActiveSessionContext;
  "agent.abort": ActiveSessionContext;
  "agent.clearQueue": ActiveSessionContext;
  "agent.setQueue": ActiveSessionContext;
  "agent.runNow": ActiveSessionContext;
  "agent.compact": ActiveSessionContext;
  "agent.abortCompaction": ActiveSessionContext;
  "agent.navigateTree": ActiveSessionContext;
  "agent.setAutoCompaction": ActiveSessionContext;
  "agent.setAutoRetry": ActiveSessionContext;
  "agent.abortRetry": ActiveSessionContext;
  "agent.getTools": ActiveSessionContext;
  "agent.setActiveTools": ToolMutationContext;
  "provider.list": HostContext;
  "provider.setEnabled": HostContext;
  "provider.save": HostContext;
  "provider.remove": HostContext;
  "provider.fetchModels": HostContext;
  "provider.getApiKey": HostContext;
  "provider.checkConnection": HostContext;
  "provider.authStatus": HostContext;
  "provider.loginStart": HostContext;
  "provider.loginRespond": HostContext;
  "provider.loginCancel": HostContext;
  "provider.logout": HostContext;
  "provider.builtinModels": HostContext;
  "provider.setBuiltinModels": HostContext;
  "provider.pricing.fetch": HostContext;
  "provider.pricing.get": HostContext;
  "provider.balance.get": HostContext;
  "provider.pricing.setRechargeRatio": HostContext;
  "provider.mapping.get": HostContext;
  "provider.mapping.set": HostContext;
  "provider.mapping.handoff": HostContext;
  "provider.mapping.picker": HostContext;
  "model.list": ActiveSessionContext;
  "model.setCurrent": ActiveSessionContext;
  "model.setThinkingLevel": ActiveSessionContext;
  "skill.list": WorkspaceContext;
  "skill.addPath": WorkspaceContext;
  "skill.removePath": WorkspaceContext;
  "prompt.list": WorkspaceContext;
  "package.list": WorkspaceContext;
  "package.catalog": HostContext;
  "package.install": SessionPackageContext;
  "package.remove": SessionPackageContext;
  "package.checkUpdates": WorkspaceContext;
  "package.update": SessionPackageContext;
  "package.updateAll": SessionPackageContext;
  "package.getResources": WorkspacePackageContext;
  "package.reloadResources": SessionPackageContext;
  "resource.setPreference": SessionPackageContext;
  "resource.setPreferences": SessionPackageContext;
  "pluginLibrary.catalog": HostContext;
  "pluginLibrary.apply": SessionPackageContext;
  "pluginLibrary.setEnv": HostContext;
  "extensionUi.configure": HostContext;
  "extensionUi.respond": SessionTargetContext;
  "extensionUi.customInput": SessionTargetContext;
  "extensionUi.customResize": SessionTargetContext;
  "telegram.validateToken": HostContext;
  "telegram.getProfiles": HostContext;
  "telegram.listSessions": HostContext;
  "telegram.getSession": HostContext;
  "telegram.saveProfile": HostContext;
  "telegram.getConfig": HostContext;
  "telegram.updateConfig": HostContext;
  "telegram.reset": HostContext;
  "telegram.status": HostContext;
  "automation.status": HostContext;
  "automation.listJobs": HostContext;
  "automation.createJob": HostContext;
  "automation.updateJob": HostContext;
  "automation.deleteJob": HostContext;
  "automation.setJobEnabled": HostContext;
  "automation.runJobNow": HostContext;
  "automation.listRuns": HostContext;
  "automation.runMessages": HostContext;
  "automation.abortRun": HostContext;
  "automation.validateCron": HostContext;
  "automation.listNotifications": HostContext;
  "memo.list": HostContext;
  "memo.optimize": HostContext;
  "memo.create": HostContext;
  "memo.update": HostContext;
  "memo.complete": HostContext;
  "memo.delete": HostContext;
  "memo.readImage": HostContext;
  "memo.getDraft": HostContext;
  "memo.setDraft": HostContext;
  "memo.clearDraft": HostContext;
  "memo.getSyncConfig": HostContext;
  "memo.testSync": HostContext;
  "memo.syncNow": HostContext;
  "pixie.dispatches": HostContext;
  "pixie.usage": HostContext;
  "pixie.ensureCurrent": HostContext;
  "pixie.reply": HostContext;
  "pixie.setContext": HostContext;
  "pixie.interject": HostContext;
  "pixie.stopDispatch": HostContext;
  "pixie.retryDispatch": HostContext;
  "pixie.listSessions": HostContext;
  "pixie.taskTree": HostContext;
};

export type HostRequestParams = {
  "system.hello": {
    clientName: string;
    clientVersion: string;
    protocolVersion: 1;
    extensionDecisionPresentation?: ExtensionDecisionPresentation;
  };
  "system.getStatus": null;
  "system.rehydrate": null;
  "system.shutdown": null;
  "piSettings.get": null;
  "piSettings.patch": PiSettingsPatch;
  "workspace.setCurrent": { cwd: string; optimistic?: boolean };
  "workspace.getCurrent": null;
  "workspace.searchFiles": { query: string; limit?: number };
  "workspace.listDirectory": { path: string };
  "workspace.readFilePreview": { path: string };
  "workspace.writeTextFile": { path: string; text: string; expectedVersion: string };
  "workspace.setDirectoryWatches": { paths: string[] };
  "git.getStatus": null;
  "git.setWatching": { enabled: boolean };
  "git.getDiff": { path: string; area: "staged" | "unstaged"; expectedRevision: number };
  "git.mutateHunk": {
    path: string;
    area: "staged" | "unstaged";
    hunkId: string;
    operation: "stage" | "unstage" | "discard";
    expectedRevision: number;
    expectedContentGeneration: string;
  };
  "git.stage": { path: string; expectedRevision: number };
  "git.stageAll": { expectedRevision: number };
  "git.unstage": { path: string; expectedRevision: number };
  "git.unstageAll": { expectedRevision: number };
  "git.discard": { path: string; expectedRevision: number };
  "git.discardAll": { expectedRevision: number };
  "git.commit": { message: string; expectedIndexGeneration: string };
  "git.listBranches": null;
  "git.createBranch": { name: string; expectedRevision: number };
  "git.switchBranch": { name: string; expectedRevision: number };
  "git.listHistory": { limit: number; cursor?: string };
  "git.getCommitDiff": { commitSha: string };
  "git.generateCommitMessage": { expectedIndexGeneration: string };
  "git.push": null;
  "git.pull": null;
  "attachment.create": { path: string };
  "attachment.createText": { text: string };
  "attachment.get": { attachmentId: string };
  "attachment.remove": { attachmentId: string };
  "session.list": null;
  "session.create": { name?: string };
  "session.open": { sessionPath: string };
  "session.reload": null;
  "session.archive": { sessionId: string; sessionPath: string };
  "session.restore": { sessionId: string; sessionPath: string };
  "session.delete": { sessionId: string; sessionPath: string };
  "session.cleanupArchived": null;
  "session.getSnapshot": null;
  "session.setName": { name: string };
  /**
   * 往当前会话追加一条自定义消息，**不触发模型轮次**：小精灵确认后要把回执落在
   * 对话里（她下一轮看得到），但不能让她接着这条回执自己往下说。
   * `display` 不归调用方管——这条就是给人看的，恒为 true。
   */
  "session.appendCustomMessage": {
    customType: string;
    text: string;
    details?: Record<string, unknown>;
  };
  "session.rename": { sessionId: string; sessionPath: string; name: string };
  "session.getEntries": { sinceEntryId?: string } | null;
  "session.getTree": null;
  "session.getStats": null;
  "session.getForkPoints": null;
  "session.fork": { entryId: string; position?: "before" | "at" };
  "session.export": {
    format: "html" | "jsonl";
    sessionId?: string;
    sessionPath?: string;
    path?: string;
  };
  "session.usageReport": null;
  "session.searchAll": { query: string; limit?: number; includeArchived?: boolean };
  "session.getCommands": null;
  "subagents.getSession": { nodeId: string };
  "subagents.stop": { nodeId: string };
  "subagents.pause": { nodeId: string };
  "subagents.continue": { nodeId: string };
  /** `model` (provider/id) and `thinking` (level) ride along as the
   *  next-spawn overrides: applied when the send/resume respawns the child,
   *  ignored while it only steers a live process. */
  "subagents.resume": { nodeId: string; model?: string; thinking?: string };
  "subagents.send": { nodeId: string; message: string; model?: string; thinking?: string };
  "shelljobs.list": null;
  "shelljobs.output": { jobId: string; limit?: number };
  "shelljobs.stop": { jobId: string };
  "agent.prompt": {
    text: string;
    images?: SerializableImage[];
    attachmentIds?: string[];
    streamingBehavior?: "steer" | "followUp";
    /** Re-attach images remembered for this text in the host's queue
     * attachment table (used by run-now on queued items). */
    attachQueuedImages?: boolean;
  };
  "agent.steer": { text: string; images?: SerializableImage[]; attachmentIds?: string[] };
  "agent.followUp": { text: string; images?: SerializableImage[]; attachmentIds?: string[] };
  "agent.abort": null;
  "agent.clearQueue": { expectedRevision: number };
  "agent.setQueue": {
    expectedRevision: number;
    steering: string[];
    followUp: string[];
  };
  /** Run one queued item now: exactly one of followUpIndex / steeringIndex. */
  "agent.runNow": {
    expectedRevision: number;
    followUpIndex?: number;
    steeringIndex?: number;
  };
  "agent.compact": { instructions?: string } | null;
  "agent.abortCompaction": null;
  "agent.navigateTree": { targetId: string };
  "agent.setAutoCompaction": { enabled: boolean };
  "agent.setAutoRetry": { enabled: boolean };
  "agent.abortRetry": null;
  "agent.getTools": null;
  "agent.setActiveTools": { names: string[] };
  "provider.list": null;
  "provider.setEnabled": { providerId: string; enabled: boolean };
  "provider.save": {
    originalId?: string;
    provider: ProviderDraft;
    apiKey?: string;
    clearApiKey?: boolean;
  };
  "provider.remove": { providerId: string };
  "provider.fetchModels": { providerId: string };
  "provider.getApiKey": { providerId: string; reveal?: boolean };
  "provider.checkConnection": { providerId: string; modelId?: string };
  "provider.authStatus": null;
  "provider.loginStart": { providerId: string; authType: "oauth" | "api_key" };
  "provider.loginRespond": { loginId: string; promptId: string; value: string };
  "provider.loginCancel": { loginId: string };
  "provider.logout": { providerId: string };
  "provider.builtinModels": { providerId: string };
  "provider.setBuiltinModels": { providerId: string; modelIds: string[] };
  "provider.pricing.fetch": RelayPricingFetchParams | null;
  "provider.pricing.get": null;
  "provider.balance.get": { providerId: string; refresh?: boolean };
  "provider.pricing.setRechargeRatio": {
    providerId: string;
    ratio: RelayRechargeRatio;
  };
  "provider.mapping.get": { stationId: string };
  "provider.mapping.set": RelayMappingSetParams;
  "provider.mapping.handoff": { stationId: string };
  "provider.mapping.picker": null;
  "model.list": null;
  "model.setCurrent": { provider: string; modelId: string };
  "model.setThinkingLevel": { level: string };
  "skill.list": WorkspaceTargetRef | null;
  "skill.addPath": SkillPathMutation & WorkspaceTargetRef;
  "skill.removePath": SkillPathMutation & WorkspaceTargetRef;
  "prompt.list": WorkspaceTargetRef | null;
  "package.list": {
    scope: "user" | "project" | "all";
    includeResources?: boolean;
  } & WorkspaceTargetRef;
  "package.catalog": {
    refresh?: boolean;
    page?: number;
    query?: string;
    type?: string;
    sort?: "downloads" | "recent";
  };
  "package.install": { source: string; scope: "user" | "project" };
  "package.remove": { packageId: string };
  "package.checkUpdates": { packageId?: string } | null;
  "package.update": { packageId: string };
  "package.updateAll": null;
  "package.getResources": { packageId: string };
  "package.reloadResources": null;
  "resource.setPreference": ResourcePreferenceUpdate;
  "resource.setPreferences": { updates: ResourcePreferenceUpdate[] } & WorkspaceTargetRef;
  "pluginLibrary.catalog": { refresh?: boolean } | null;
  "pluginLibrary.apply": PluginLibraryApplyParams;
  "pluginLibrary.setEnv": PluginLibraryEnvUpdate;
  "extensionUi.configure": {
    extensionDecisionPresentation: ExtensionDecisionPresentation;
  };
  "extensionUi.respond": {
    requestId: string;
    status: "resolved" | "cancelled";
    value?: JsonValue;
  };
  "extensionUi.customInput": { requestId: string; data: string };
  "extensionUi.customResize": { requestId: string; cols: number; rows: number };
  "telegram.validateToken": { token: string };
  "telegram.getProfiles": null;
  "telegram.listSessions": null;
  "telegram.getSession": { sessionPath: string };
  "telegram.saveProfile": {
    token: string;
    botId?: number;
    botUsername?: string;
    botName?: string;
  };
  "telegram.getConfig": null;
  "telegram.updateConfig": {
    assistant?: TelegramAssistantConfig;
    voice?: TelegramVoiceConfig;
    threads?: TelegramThreadsConfig;
  };
  "telegram.reset": null;
  "telegram.status": null;
  "automation.status": null;
  "automation.listJobs": null;
  "automation.createJob": AutomationJobInput;
  "automation.updateJob": AutomationJobPatch;
  "automation.deleteJob": { id: string; purge?: boolean };
  "automation.setJobEnabled": { id: string; enabled: boolean };
  "automation.runJobNow": { id: string; permission?: AutomationPermission; timeoutMs?: number };
  "automation.listRuns": { jobId?: string | null; limit?: number };
  /** 一次执行的过程（Host 直读 run 的会话文件，保留思考块与工具调用）。 */
  "automation.runMessages": { runId: string };
  /** 叫停正在执行的那一轮：只中止这一轮，任务与排期不动。 */
  "automation.abortRun": { runId: string };
  "automation.validateCron": { cron: string; timezone?: string };
  "automation.listNotifications": { limit?: number };
  "memo.list": null;
  "memo.optimize": {
    contentMd: string;
    workspaceHint: string | null;
    workspaces: Array<{ id: string; name: string }>;
  };
  "memo.create": {
    title: string;
    contentMd: string;
    tags?: string[];
    workspaceHint?: string | null;
    images?: MemoImageInput[];
    /** 一次性截止时刻（epoch ms）。 */
    dueAt?: number | null;
    /** 周期规则；null/缺省 = 非周期记录（停用周期）。 */
    recurrence?: MemoRecurrence | null;
  };
  "memo.update": {
    id: string;
    patch: {
      title?: string;
      contentMd?: string;
      status?: MemoNoteStatus;
      sessionId?: string | null;
      tags?: string[];
      workspaceHint?: string | null;
      addImages?: MemoImageInput[];
      removeImageIds?: string[];
      clearResult?: boolean;
      /** 一次性截止时刻（epoch ms）；null = 清除截止。 */
      dueAt?: number | null;
      /** 周期规则；null = 清除周期（停用，转普通记录并清空 nextDueAt）。 */
      recurrence?: MemoRecurrence | null;
    };
  };
  "memo.complete": { id: string };
  "memo.delete": { id: string };
  "memo.readImage": { noteId: string; imageId: string };
  "memo.getDraft": null;
  "memo.setDraft": { draft: MemoDraftInput };
  "memo.clearDraft": null;
  "memo.getSyncConfig": null;
  "memo.testSync": null;
  "memo.syncNow": null;
  /** 面板拉取：无参数，Host 按小精灵当前会话段返回全量关联委派。 */
  /**
   * 面板归属：用户当前打开的小精灵会话（前端在会话弹窗切换时立即带上）；
   * 缺省/null = Host 退回小精灵当前段指针。
   */
  "pixie.dispatches": { sessionId?: string | null };
  "pixie.usage": null;
  "pixie.ensureCurrent": null;
  /** 用户对 ask 询问的答复：路由回被委派会话（followUp）。 */
  "pixie.reply": { dispatchId: string; text: string };
  /** 前端推送已知工作区列表（新段 <pixie-context> 注入用）。 */
  "pixie.setContext": { workspaces: string[] };
  /** 向进行中委派的目标会话插话（补充/修正/进度检查点；非新任务，不建记录）。 */
  "pixie.interject": {
    dispatchId: string;
    text: string;
    mode: "append" | "checkpoint";
    /** checkpoint 后续：continue=汇报后自动继续；wait=汇报后暂停等指令。 */
    after?: "continue" | "wait";
    /**
     * 模型替换（"provider/id"）：下一轮起生效（turn 边界，与手动切换一致）。
     * 仅在用户明确授权时携带；缺省保持当前模型。
     */
    model?: string;
    /** 推理深度替换（off|minimal|low|medium|high|xhigh|max）；缺省保持当前。 */
    thinkingLevel?: string;
  };
  /** 叫停委派：运行中 abort 会话；排队中摘队列；已终态返回 already-stopped。 */
  "pixie.stopDispatch": { dispatchId: string };
  /** 失败/叫停后的重试：resume=活会话原地续跑；redispatch=死会话重派（缺省自动判定）。 */
  "pixie.retryDispatch": { dispatchId: string; mode?: "resume" | "redispatch" };
  /** 按工作区列出历史会话（找回旧会话继续派活）。 */
  "pixie.listSessions": { cwd: string };
  /**
   * 「工作区 → 会话 → 任务」分组树。归属过滤与 pixie.dispatches 同语义：
   * sessionId = 用户当前打开的小精灵会话；缺省/null = Host 退回当前段指针。
   */
  "pixie.taskTree": { sessionId?: string | null };
  /** 可选模型列表 + 当前段生效的模型选择（与普通会话 model.list 同源）。 */
};

export type HostResultMap = {
  "system.hello": HostStatusSnapshot;
  "system.getStatus": HostStatusSnapshot;
  "system.rehydrate": RehydrateSnapshot;
  "system.shutdown": { accepted: true };
  "piSettings.get": PiSettingsSnapshot;
  "piSettings.patch": PiSettingsSnapshot;
  "workspace.setCurrent": {
    workspace: WorkspaceSnapshot;
    session?: SessionSnapshot;
  };
  "workspace.getCurrent": WorkspaceSnapshot | null;
  "workspace.searchFiles": {
    files: { path: string; kind: "file" | "dir" }[];
    truncated: boolean;
  };
  "workspace.listDirectory": {
    path: string;
    entries: WorkspaceDirectoryEntry[];
  };
  "workspace.setDirectoryWatches": { paths: string[] };
  "git.getStatus": GitStatusSnapshot;
  "workspace.readFilePreview": WorkspaceFilePreview;
  "workspace.writeTextFile": WorkspaceTextFile;
  "git.setWatching": { watching: boolean; snapshot: GitStatusSnapshot | null };
  "git.getDiff": GitDiffSnapshot;
  "git.mutateHunk": GitMutationResult;
  "git.stage": GitMutationResult;
  "git.stageAll": GitMutationResult;
  "git.unstage": GitMutationResult;
  "git.unstageAll": GitMutationResult;
  "git.discard": GitMutationResult;
  "git.discardAll": GitMutationResult;
  "git.commit": GitCommitResult;
  "git.listBranches": GitBranchList;
  "git.createBranch": GitMutationResult;
  "git.switchBranch": GitMutationResult;
  "git.listHistory": GitHistoryResult;
  "git.getCommitDiff": GitCommitDiffSnapshot;
  "git.generateCommitMessage": GitCommitMessageResult;
  "git.push": GitAsyncAccepted;
  "git.pull": GitAsyncAccepted;
  "attachment.create": AttachmentSnapshot;
  "attachment.createText": AttachmentSnapshot;
  "attachment.get": AttachmentSnapshot;
  "attachment.remove": { attachmentId: string; removed: true };
  "session.list": { workspaceId: string; items: SessionSummary[] };
  "session.create": SessionSnapshot;
  "session.open": SessionSnapshot;
  "session.reload": SessionSnapshot;
  "session.archive": { sessionId: string; sessionPath: string; archived: true };
  "session.restore": { sessionId: string; sessionPath: string; archived: false };
  "session.delete": { sessionId: string; deleted: true };
  "session.cleanupArchived": { deletedCount: number; failedCount: number };
  "session.getSnapshot": SessionSnapshot | null;
  "session.setName": SessionSnapshot;
  "session.appendCustomMessage": { appended: true };
  "session.rename": { sessionId: string; name: string; session?: SessionSnapshot };
  "session.getEntries": {
    entries: SerializableSessionEntry[];
    leafId: string | null;
  };
  "session.getTree": {
    tree: SerializableSessionTreeNode[];
    leafId: string | null;
  };
  "session.getStats": SessionStatsSnapshot;
  "session.getForkPoints": { items: { entryId: string; text: string }[] };
  "session.fork": { session: SessionSnapshot; selectedText?: string };
  "session.export": { path: string };
  "session.usageReport": SessionUsageReport;
  "session.searchAll": SessionSearchReport;
  "session.getCommands": { commands: CommandSummary[] };
  "subagents.getSession": SubagentSessionSnapshot;
  "subagents.stop": { stopped: boolean };
  "subagents.pause": { paused: boolean };
  "subagents.continue": { continued: boolean };
  "subagents.resume": { resumed: boolean };
  "subagents.send": { sent: boolean; mode: "steer" | "resume" };
  "shelljobs.list": ShellJobsSnapshot;
  "shelljobs.output": ShellJobOutput;
  "shelljobs.stop": { stopped: boolean };
  "agent.prompt": { accepted: true; runId: string };
  "agent.steer": { accepted: true };
  "agent.followUp": { accepted: true };
  "agent.abort": {
    aborted: boolean;
    settled: boolean;
    queueRestored: boolean;
    partialFailure: boolean;
    queue: QueueSnapshot;
    session: SessionSnapshot;
    error?: HostError;
  };
  "agent.clearQueue": QueueSnapshot;
  "agent.setQueue": QueueSnapshot;
  "agent.runNow": {
    started: boolean;
    runId?: string;
    settled: boolean;
    queueRestored: boolean;
    partialFailure: boolean;
    queue: QueueSnapshot;
    error?: HostError;
  };
  "agent.compact": { result: SerializableCompactionResult; session: SessionSnapshot };
  "agent.abortCompaction": { accepted: true };
  "agent.navigateTree": {
    session: SessionSnapshot;
    editorText?: string;
    cancelled: boolean;
  };
  "agent.setAutoCompaction": SessionSnapshot;
  "agent.setAutoRetry": SessionSnapshot;
  "agent.abortRetry": { accepted: true };
  "agent.getTools": ToolSnapshot;
  "agent.setActiveTools": ToolSnapshot;
  "provider.list": { providers: ProviderSnapshot[] };
  "provider.setEnabled": { providerId: string; enabled: boolean };
  "provider.save": { provider: ProviderSnapshot };
  "provider.remove": { providerId: string; removed: true };
  "provider.fetchModels": {
    providerId: string;
    models: DiscoveredProviderModel[];
  };
  "provider.getApiKey": { masked: string | null; apiKey: string | null };
  "provider.checkConnection": ProviderConnectionResult;
  "provider.authStatus": { providers: BuiltinProviderAuthStatus[] };
  "provider.loginStart": { loginId: string; providerId: string };
  "provider.loginRespond": { accepted: true };
  "provider.loginCancel": { accepted: true };
  "provider.logout": { providerId: string; loggedOut: true };
  "provider.builtinModels": BuiltinProviderModelsResult;
  "provider.setBuiltinModels": BuiltinProviderModelsResult;
  "provider.pricing.fetch": RelayPricingResult;
  "provider.pricing.get": RelayPricingResult;
  "provider.balance.get": RelayBalance;
  "provider.pricing.setRechargeRatio": {
    providerId: string;
    ratio: RelayRechargeRatio | null;
  };
  "provider.mapping.get": RelayMappingResult;
  "provider.mapping.set": RelayMappingResult;
  "provider.mapping.handoff": RelayMappingHandoffResult;
  "provider.mapping.picker": RelayMappingPickerResult;
  "model.list": {
    models: ModelSummary[];
    current?: ModelSummary;
    enabledProviders?: string[];
    thinkingLevels: string[];
    configHealth: ModelConfigHealth;
  };
  "model.setCurrent": {
    model: ModelSummary;
    thinkingLevels: string[];
    /**
     * Full session snapshot. Omitted when the switch was accepted while a run
     * is in flight: a mid-stream snapshot would race the desktop's streamed
     * transcript draft, so only `model.changed` carries the update there.
     */
    session?: SessionSnapshot;
    /**
     * True when the Agent was running and the switch takes effect from the
     * next turn boundary instead of immediately (the in-flight LLM call keeps
     * the previous model). Mirrors the queued steer/follow-up behaviour.
     */
    deferred?: boolean;
  };
  "model.setThinkingLevel": SessionSnapshot;
  "skill.list": SkillSnapshot;
  "skill.addPath": SkillSnapshot;
  "skill.removePath": SkillSnapshot;
  "prompt.list": PromptSnapshot;
  "package.list": PackageSnapshot;
  "package.catalog": PackageCatalog;
  "package.install": PackageMutationResult;
  "package.remove": PackageMutationResult;
  "package.checkUpdates": { supported: boolean; updates: PackageUpdateSummary[] };
  "package.update": PackageMutationResult;
  "package.updateAll": PackageMutationResult;
  "package.getResources": { package: PackageRecord; resources: ResourceRecord[] };
  "package.reloadResources": PackageMutationResult;
  "resource.setPreference": PackageMutationResult;
  "resource.setPreferences": PackageMutationResult;
  "pluginLibrary.catalog": PluginLibraryCatalog;
  "pluginLibrary.apply": PackageMutationResult;
  "pluginLibrary.setEnv": { applied: number };
  "extensionUi.configure": {
    extensionDecisionPresentation: ExtensionDecisionPresentation;
  };
  "extensionUi.respond": { accepted: true };
  "extensionUi.customInput": { accepted: true };
  "extensionUi.customResize": { accepted: true };
  "telegram.validateToken": TelegramValidateTokenResult;
  "telegram.getProfiles": { default: TelegramProfileSummary | null };
  "telegram.listSessions": TelegramSessionListResult;
  "telegram.getSession": TelegramSessionDetail;
  "telegram.saveProfile": { saved: true };
  "telegram.getConfig": TelegramConfigResult;
  "telegram.updateConfig": { saved: true };
  "telegram.reset": { reset: true };
  "telegram.status": TelegramBridgeStatus;
  "automation.status": AutomationStatus;
  "automation.listJobs": { jobs: AutomationJob[]; activeJobIds: string[]; root: string };
  "automation.createJob": { job: AutomationJob };
  "automation.updateJob": { job: AutomationJob };
  "automation.deleteJob": { removed: boolean; purged: boolean };
  "automation.setJobEnabled": { job: AutomationJob };
  "automation.runJobNow": { run: AutomationRunSummary };
  "automation.listRuns": { runs: AutomationRunSummary[] };
  "automation.runMessages": AutomationRunMessages;
  "automation.abortRun": { aborted: boolean; run: AutomationRunSummary };
  "automation.validateCron": { valid: boolean; reason: string | null };
  "automation.listNotifications": { entries: AutomationNotification[] };
  "memo.list": { notes: MemoNote[] };
  "memo.optimize": {
    contentMd: string;
    workspaceId: string | null;
  };
  "memo.create": { note: MemoNote };
  "memo.update": { note: MemoNote };
  "memo.complete": { note: MemoNote };
  "memo.delete": { ok: boolean };
  "memo.readImage": { dataBase64: string; mediaType: string };
  "memo.getDraft": { draft: MemoDraft | null };
  "memo.setDraft": { draft: MemoDraft };
  "memo.clearDraft": { ok: boolean };
  "memo.getSyncConfig": { settings: MemoSyncSettings };
  "memo.testSync": { ok: boolean; error: string | null };
  "memo.syncNow": {
    uploadedNotes: number;
    uploadedImages: number;
    downloadedNotes: number;
    downloadedImages: number;
    bytes: number;
    at: number;
  };
  "pixie.dispatches": { dispatches: PixieDispatchRecord[] };
  "pixie.usage": PixieUsageStats;
  "pixie.ensureCurrent": { cwd: string; sessionId: string; sessionPath: string };
  "pixie.reply": { ok: boolean };
  "pixie.setContext": { ok: true };
  "pixie.interject": { ok: boolean; error: string | null };
  "pixie.stopDispatch": { ok: boolean; action: PixieStopAction };
  "pixie.retryDispatch": { ok: boolean; dispatchId: string | null; error: string | null };
  "pixie.listSessions": { sessions: PixieWorkspaceSessionSummary[] };
  "pixie.taskTree": { groups: PixieTaskTreeWorkspace[] };
};

export type HostEventPayloadMap = {
  "host.ready": HostStatusSnapshot;
  "host.statusChanged": HostStatusSnapshot;
  "host.fatal": { error: HostError };
  "workspace.changed": WorkspaceSnapshot;
  "workspace.filesChanged": { directories: string[] };
  "git.changed": { snapshot: GitStatusSnapshot };
  "git.taskFinished": GitTaskFinishedPayload;
  "automation.notificationsChanged": { total: number };
  "attachment.changed": { attachment: AttachmentSnapshot };
  "session.snapshot": SessionSnapshot | null;
  "session.infoChanged": { sessionId: string; name?: string };
  "session.runtimeChanged": {
    sessionId: string;
    sessionRevision: number;
    state: SessionRuntimeState;
    updatedAt: number;
    error?: string;
  };
  "agent.event": { runId: string; event: SerializableAgentSessionEvent };
  "agent.toolsChanged": ToolSnapshot;
  "agent.queueChanged": QueueSnapshot;
  "agent.compactionChanged": {
    active: boolean;
    reason?: string;
    result?: SerializableCompactionResult;
    error?: HostError;
  };
  "agent.retryChanged": {
    active: boolean;
    attempt?: number;
    maxAttempts?: number;
    delayMs?: number;
    errorMessage?: string;
  };
  "subagents.statusChanged": SubagentsStatusSnapshot;
  "shelljobs.changed": ShellJobsSnapshot;
  "model.changed": {
    model?: ModelSummary;
    thinkingLevel: string;
    availableThinkingLevels: string[];
  };
  "provider.loginEvent": {
    loginId: string;
    providerId: string;
    event: ProviderLoginFlowEvent;
  };
  "package.progress": {
    operationId: string;
    type: "start" | "progress" | "complete" | "error";
    action: string;
    source: string;
    message?: string;
  };
  "package.snapshot": PackageSnapshot;
  "package.resourcesChanged": {
    packages: PackageSnapshot;
    session?: SessionSnapshot;
  };
  "package.diagnostic": {
    severity: "info" | "warning" | "error";
    source?: string;
    message: string;
  };
  "extensionUi.request": ExtensionUiRequest;
  "extensionUi.closed": ExtensionUiClosed;
  "extensionUi.groupClosed": ExtensionUiGroupClosed;
  "extensionUi.statusChanged": { key?: string; text: string };
  "extensionUi.widgetChanged": {
    key?: string;
    widget: JsonValue;
    placement?: "aboveEditor" | "belowEditor";
  };
  "extensionUi.widgetAttentionRequested": {
    key: string;
    runId: string;
    invocation: string;
  };
  "extensionUi.messageRendered": {
    entryId: string;
    render: ExtensionMessageRenderSnapshot | null;
  };
  "extensionUi.notification": { message: string; level: string };
  "extensionUi.customStarted": {
    requestId: string;
    title?: string;
    cols: number;
    rows: number;
  };
  "extensionUi.customFrame": { requestId: string; data: string };
  "extensionUi.customClosed": { requestId: string };
  /**
   * 小精灵收到委派回调（结果回流，前端刷新对话与委派列表）。
   * - done：终态完成；error：终态报错（payload 附失败决策流字段）
   * - progress：进度检查点非终态汇报（委派继续运行/暂停）
   * - stopped：委派被叫停（小精灵知情回执）
   */
  "pixie.reportReceived": {
    dispatchId: string;
    summary: string;
    kind: PixieDispatchKind;
    /** 回调携带的产物/变更文件清单（无则缺省）。 */
    files?: string[];
    /** error 专用：被委派会话存活状态（驱动「继续/重派/评估」决策流）。 */
    sessionAlive?: PixieSessionAlive;
    /** error 专用：连续失败计数（≥3 时小精灵升级给用户）。 */
    failCount?: number;
    /** error 专用：错误类型短标签（如 tool_error / rate_limit / aborted）。 */
    errorType?: string;
    /** error 专用：已完成进度摘要（失败前做到哪一步）。 */
    progress?: string;
  };
  /** 小精灵收到 ask 询问（待用户答复；前端刷新并切换 composer）。 */
  "pixie.askReceived": { dispatchId: string; question: string; options: string[] };
  /** 会话段时间线变化（新段开始或旧段收尾；前端刷新时间线）。 */
  "pixie.segmentChanged": { segmentId: string; phase: "started" | "ended" };
  /** 失联提醒：委派超时未收到任何回调（每条仅推送一次；前端横幅提示）。 */
  "pixie.staleWarning": {
    dispatchId: string;
    /** 距最后活跃的分钟数。 */
    minutes: number;
    task: string;
    cwd: string;
  };
};

// Compile-time completeness: every HostMethod/HostEventName key present
type _AssertMethods = keyof HostRequestParams extends HostMethod
  ? HostMethod extends keyof HostRequestParams
    ? true
    : never
  : never;
type _AssertEvents = keyof HostEventPayloadMap extends HostEventName
  ? HostEventName extends keyof HostEventPayloadMap
    ? true
    : never
  : never;
const _m: _AssertMethods = true;
const _e: _AssertEvents = true;
void _m;
void _e;
