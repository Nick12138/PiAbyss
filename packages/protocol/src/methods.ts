/** All P0 Host methods — PROJECT_SPEC §7.3 */
export const HOST_METHODS = [
  "system.hello",
  "system.getStatus",
  "system.rehydrate",
  "system.shutdown",
  "piSettings.get",
  "piSettings.patch",
  "workspace.setCurrent",
  "workspace.getCurrent",
  "workspace.searchFiles",
  "workspace.listDirectory",
  "workspace.readFilePreview",
  "workspace.writeTextFile",
  "workspace.setDirectoryWatches",
  "git.getStatus",
  "git.setWatching",
  "git.getDiff",
  "git.mutateHunk",
  "git.stage",
  "git.stageAll",
  "git.unstage",
  "git.unstageAll",
  "git.discard",
  "git.commit",
  "git.listBranches",
  "git.createBranch",
  "git.switchBranch",
  "git.listHistory",
  "git.getCommitDiff",
  "git.generateCommitMessage",
  "git.push",
  "git.pull",
  "attachment.create",
  "attachment.createText",
  "attachment.get",
  "attachment.remove",
  "session.list",
  "session.create",
  "session.open",
  "session.reload",
  "session.archive",
  "session.restore",
  "session.delete",
  "session.cleanupArchived",
  "session.getSnapshot",
  "session.setName",
  "session.rename",
  "session.getEntries",
  "session.getTree",
  "session.getStats",
  "session.getForkPoints",
  "session.fork",
  "session.export",
  "session.usageReport",
  "session.searchAll",
  "session.getCommands",
  "subagents.getSession",
  "subagents.stop",
  "subagents.pause",
  "subagents.continue",
  "subagents.resume",
  "agent.prompt",
  "agent.steer",
  "agent.followUp",
  "agent.abort",
  "agent.clearQueue",
  "agent.setQueue",
  "agent.runNow",
  "agent.compact",
  "agent.abortCompaction",
  "agent.navigateTree",
  "agent.setAutoCompaction",
  "agent.setAutoRetry",
  "agent.abortRetry",
  "agent.getTools",
  "agent.setActiveTools",
  "provider.list",
  "provider.setEnabled",
  "provider.save",
  "provider.remove",
  "provider.fetchModels",
  "provider.checkConnection",
  "provider.authStatus",
  "provider.loginStart",
  "provider.loginRespond",
  "provider.loginCancel",
  "provider.logout",
  "provider.builtinModels",
  "provider.setBuiltinModels",
  "model.list",
  "model.setCurrent",
  "model.setThinkingLevel",
  "skill.list",
  "skill.addPath",
  "skill.removePath",
  "prompt.list",
  "package.list",
  "package.catalog",
  "package.install",
  "package.remove",
  "package.checkUpdates",
  "package.update",
  "package.updateAll",
  "package.getResources",
  "package.reloadResources",
  "resource.setPreference",
  "resource.setPreferences",
  "pluginLibrary.catalog",
  "pluginLibrary.apply",
  "pluginLibrary.setEnv",
  "extensionUi.configure",
  "extensionUi.respond",
  "extensionUi.customInput",
  "extensionUi.customResize",
  "telegram.validateToken",
  "telegram.getProfiles",
  "telegram.listSessions",
  "telegram.getSession",
  "telegram.saveProfile",
  "telegram.getConfig",
  "telegram.updateConfig",
  "telegram.reset",
  "telegram.status",
] as const;

export type HostMethod = (typeof HOST_METHODS)[number];

export function isHostMethod(value: unknown): value is HostMethod {
  return typeof value === "string" && (HOST_METHODS as readonly string[]).includes(value);
}

export type EmptyContext = Record<never, never>;

export type HostContext = {
  expectedHostInstanceId: string;
};

export type WorkspaceContext = HostContext & {
  expectedWorkspaceId: string | null;
  expectedWorkspaceRevision: number;
};

export type ActiveSessionContext = WorkspaceContext & {
  expectedSessionId: string;
  expectedSessionRevision: number;
};

/** Identifies a concrete foreground or background Session generation. */
export type SessionTargetContext = ActiveSessionContext;

export type NullableSessionContext = WorkspaceContext & {
  expectedSessionId: string | null;
  expectedSessionRevision: number;
};

export type ToolMutationContext = ActiveSessionContext & {
  expectedToolRevision: number;
};

export type WorkspacePackageContext = WorkspaceContext & {
  expectedPackageRevision: number;
};

export type SessionPackageContext = NullableSessionContext & {
  expectedPackageRevision: number;
};

export type HostOnlyMethod =
  | "system.getStatus"
  | "system.rehydrate"
  | "system.shutdown"
  | "piSettings.get"
  | "piSettings.patch"
  | "provider.list"
  | "provider.setEnabled"
  | "provider.save"
  | "provider.remove"
  | "provider.fetchModels"
  | "provider.checkConnection"
  | "provider.authStatus"
  | "provider.loginStart"
  | "provider.loginRespond"
  | "provider.loginCancel"
  | "provider.logout"
  | "provider.builtinModels"
  | "provider.setBuiltinModels"
  | "session.searchAll"
  | "package.catalog"
  | "pluginLibrary.catalog"
  | "pluginLibrary.setEnv"
  | "extensionUi.configure"
  | "telegram.validateToken"
  | "telegram.getProfiles"
  | "telegram.listSessions"
  | "telegram.getSession"
  | "telegram.saveProfile"
  | "telegram.getConfig"
  | "telegram.updateConfig"
  | "telegram.reset"
  | "telegram.status";
export type WorkspaceOnlyMethod =
  | "workspace.setCurrent"
  | "workspace.getCurrent"
  | "workspace.searchFiles"
  | "workspace.listDirectory"
  | "workspace.readFilePreview"
  | "workspace.writeTextFile"
  | "workspace.setDirectoryWatches"
  | "git.getStatus"
  | "git.setWatching"
  | "git.getDiff"
  | "git.mutateHunk"
  | "git.stage"
  | "git.stageAll"
  | "git.unstage"
  | "git.unstageAll"
  | "git.discard"
  | "git.commit"
  | "git.listBranches"
  | "git.createBranch"
  | "git.switchBranch"
  | "git.listHistory"
  | "git.getCommitDiff"
  | "git.generateCommitMessage"
  | "git.push"
  | "git.pull"
  | "session.list"
  | "session.archive"
  | "session.restore"
  | "session.delete"
  | "session.cleanupArchived"
  | "session.getSnapshot"
  | "session.rename"
  | "session.export"
  | "session.usageReport"
  | "subagents.getSession"
  | "subagents.stop"
  | "subagents.pause"
  | "subagents.continue"
  | "subagents.resume"
  | "skill.list"
  | "skill.addPath"
  | "skill.removePath"
  | "package.list"
  | "package.checkUpdates";
export type NullableSessionMethod = "session.create" | "session.open";
export type ActiveSessionMethod =
  | "attachment.create"
  | "attachment.createText"
  | "attachment.get"
  | "attachment.remove"
  | "session.setName"
  | "session.reload"
  | "session.getEntries"
  | "session.getTree"
  | "session.getStats"
  | "session.getForkPoints"
  | "session.fork"
  | "session.getCommands"
  | "agent.prompt"
  | "agent.steer"
  | "agent.followUp"
  | "agent.abort"
  | "agent.clearQueue"
  | "agent.setQueue"
  | "agent.runNow"
  | "agent.compact"
  | "agent.abortCompaction"
  | "agent.navigateTree"
  | "agent.setAutoCompaction"
  | "agent.setAutoRetry"
  | "agent.abortRetry"
  | "agent.getTools"
  | "model.list"
  | "model.setCurrent"
  | "model.setThinkingLevel";
export type SessionTargetMethod =
  "extensionUi.respond" | "extensionUi.customInput" | "extensionUi.customResize";
export type ToolMutationMethod = "agent.setActiveTools";
export type SessionPackageMethod =
  | "package.install"
  | "package.remove"
  | "package.update"
  | "package.updateAll"
  | "package.reloadResources"
  | "resource.setPreference"
  | "resource.setPreferences"
  | "pluginLibrary.apply";

export type HostRequestContext<M extends HostMethod> = M extends "system.hello"
  ? EmptyContext
  : M extends HostOnlyMethod
    ? HostContext
    : M extends WorkspaceOnlyMethod
      ? WorkspaceContext
      : M extends NullableSessionMethod
        ? NullableSessionContext
        : M extends ActiveSessionMethod
          ? ActiveSessionContext
          : M extends SessionTargetMethod
            ? SessionTargetContext
            : M extends ToolMutationMethod
              ? ToolMutationContext
              : M extends "package.getResources"
                ? WorkspacePackageContext
                : M extends SessionPackageMethod
                  ? SessionPackageContext
                  : never;

/** Context scope for each method — used by runtime validators */
export type MethodContextScope =
  | "empty"
  | "host"
  | "workspace"
  | "nullableSession"
  | "activeSession"
  | "sessionTarget"
  | "toolMutation"
  | "workspacePackage"
  | "sessionPackage";

export const METHOD_CONTEXT_SCOPE: Record<HostMethod, MethodContextScope> = {
  "system.hello": "empty",
  "system.getStatus": "host",
  "system.rehydrate": "host",
  "system.shutdown": "host",
  "piSettings.get": "host",
  "piSettings.patch": "host",
  "workspace.setCurrent": "workspace",
  "workspace.getCurrent": "workspace",
  "workspace.searchFiles": "workspace",
  "workspace.listDirectory": "workspace",
  "workspace.readFilePreview": "workspace",
  "workspace.writeTextFile": "workspace",
  "workspace.setDirectoryWatches": "workspace",
  "git.getStatus": "workspace",
  "git.setWatching": "workspace",
  "git.getDiff": "workspace",
  "git.mutateHunk": "workspace",
  "git.stage": "workspace",
  "git.stageAll": "workspace",
  "git.unstage": "workspace",
  "git.unstageAll": "workspace",
  "git.discard": "workspace",
  "git.commit": "workspace",
  "git.listBranches": "workspace",
  "git.createBranch": "workspace",
  "git.switchBranch": "workspace",
  "git.listHistory": "workspace",
  "git.getCommitDiff": "workspace",
  "git.generateCommitMessage": "workspace",
  "git.push": "workspace",
  "git.pull": "workspace",
  "attachment.create": "activeSession",
  "attachment.createText": "activeSession",
  "attachment.get": "activeSession",
  "attachment.remove": "activeSession",
  "session.list": "workspace",
  "session.create": "nullableSession",
  "session.open": "nullableSession",
  "session.reload": "activeSession",
  "session.archive": "workspace",
  "session.restore": "workspace",
  "session.delete": "workspace",
  "session.cleanupArchived": "workspace",
  "session.getSnapshot": "workspace",
  "session.setName": "activeSession",
  "session.rename": "workspace",
  "session.getEntries": "activeSession",
  "session.getTree": "activeSession",
  "session.getStats": "activeSession",
  "session.getForkPoints": "activeSession",
  "session.fork": "activeSession",
  "session.export": "workspace",
  "session.usageReport": "workspace",
  "session.searchAll": "host",
  "session.getCommands": "activeSession",
  "subagents.getSession": "workspace",
  "subagents.stop": "workspace",
  "subagents.pause": "workspace",
  "subagents.continue": "workspace",
  "subagents.resume": "workspace",
  "agent.prompt": "activeSession",
  "agent.steer": "activeSession",
  "agent.followUp": "activeSession",
  "agent.abort": "activeSession",
  "agent.clearQueue": "activeSession",
  "agent.setQueue": "activeSession",
  "agent.runNow": "activeSession",
  "agent.compact": "activeSession",
  "agent.abortCompaction": "activeSession",
  "agent.navigateTree": "activeSession",
  "agent.setAutoCompaction": "activeSession",
  "agent.setAutoRetry": "activeSession",
  "agent.abortRetry": "activeSession",
  "agent.getTools": "activeSession",
  "agent.setActiveTools": "toolMutation",
  "provider.list": "host",
  "provider.setEnabled": "host",
  "provider.save": "host",
  "provider.remove": "host",
  "provider.fetchModels": "host",
  "provider.checkConnection": "host",
  "provider.authStatus": "host",
  "provider.loginStart": "host",
  "provider.loginRespond": "host",
  "provider.loginCancel": "host",
  "provider.logout": "host",
  "provider.builtinModels": "host",
  "provider.setBuiltinModels": "host",
  "model.list": "activeSession",
  "model.setCurrent": "activeSession",
  "model.setThinkingLevel": "activeSession",
  "skill.list": "workspace",
  "skill.addPath": "workspace",
  "skill.removePath": "workspace",
  "prompt.list": "workspace",
  "package.list": "workspace",
  "package.catalog": "host",
  "package.install": "sessionPackage",
  "package.remove": "sessionPackage",
  "package.checkUpdates": "workspace",
  "package.update": "sessionPackage",
  "package.updateAll": "sessionPackage",
  "package.getResources": "workspacePackage",
  "package.reloadResources": "sessionPackage",
  "resource.setPreference": "sessionPackage",
  "resource.setPreferences": "sessionPackage",
  "pluginLibrary.catalog": "host",
  "pluginLibrary.apply": "sessionPackage",
  "pluginLibrary.setEnv": "host",
  "extensionUi.configure": "host",
  "telegram.validateToken": "host",
  "telegram.getProfiles": "host",
  "telegram.listSessions": "host",
  "telegram.getSession": "host",
  "telegram.saveProfile": "host",
  "telegram.getConfig": "host",
  "telegram.updateConfig": "host",
  "telegram.reset": "host",
  "telegram.status": "host",
  "extensionUi.respond": "sessionTarget",
  "extensionUi.customInput": "sessionTarget",
  "extensionUi.customResize": "sessionTarget",
};
