import type { HostContextMap, HostRequestParams } from "./contracts.js";
import {
  MAX_AGENT_IMAGE_BYTES,
  MAX_AGENT_REQUEST_IMAGES,
  MAX_PASTED_TEXT_ATTACHMENT_BYTES,
  MAX_GIT_COMMIT_MESSAGE_BYTES,
  MAX_GIT_BRANCH_NAME_BYTES,
  MAX_GIT_HISTORY_PAGE_SIZE,
  MAX_GIT_PATH_BYTES,
} from "./limits.js";
import {
  hasExactKeys,
  isHostErrorRecord,
  isHostStatusSnapshot,
  isPackageSnapshot,
  isPlainObject,
  isProviderDraft,
  isSafeRevision,
  isSerializableAgentContent,
  isSessionSnapshot,
  isToolSnapshot,
  isUuid,
  isWorkspaceSnapshot,
  validateEventPayloadShape,
  validateMethodResultShape,
} from "./dto-validate.js";
import { createHostError, type HostError, type JsonValue } from "./errors.js";
import { isHostEventName, type HostEventName } from "./events.js";
import type { HostEventEnvelope, HostResponseEnvelope } from "./envelopes.js";
import {
  isHostMethod,
  METHOD_CONTEXT_SCOPE,
  type HostMethod,
  type MethodContextScope,
} from "./methods.js";

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: HostError };

function fail(message: string, details?: JsonValue): ValidationResult<never> {
  return {
    ok: false,
    error: createHostError("INVALID_REQUEST", message, { details }),
  };
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isValidAttachmentText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !value.includes("\u0000") &&
    new TextEncoder().encode(value).byteLength <= MAX_PASTED_TEXT_ATTACHMENT_BYTES
  );
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isValidGitPath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const segments = value.split(/[\\/]/);
  return (
    value.length > 0 &&
    !value.includes("\u0000") &&
    utf8Bytes(value) <= MAX_GIT_PATH_BYTES &&
    !value.startsWith("/") &&
    !value.startsWith("\\") &&
    !/^[A-Za-z]:[\\/]/.test(value) &&
    !segments.includes("..")
  );
}

function isValidCommitMessage(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !value.includes("\u0000") &&
    utf8Bytes(value) <= MAX_GIT_COMMIT_MESSAGE_BYTES
  );
}

function isValidGitBranchName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    utf8Bytes(value) <= MAX_GIT_BRANCH_NAME_BYTES
  );
}

function isGitSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40,64}$/.test(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/** Reject plugin-library patterns that could escape the package root. */
function paramsPatternUnsafe(pattern: string): boolean {
  return (
    pattern.includes("\\") ||
    pattern.startsWith("/") ||
    pattern.includes("..") ||
    pattern.includes("\0")
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  return isPlainObject(value) && hasExactKeys(value, required, optional);
}

const SCHEDULE_PERMISSIONS = ["read_only", "write", "full"];
const SCHEDULE_MISSED_WINDOWS = ["catch_up_one", "skip"];
const SCHEDULE_NOTIFY_MODES = ["none", "system", "tg"];

function isSchedulePermission(value: unknown): boolean {
  return typeof value === "string" && (SCHEDULE_PERMISSIONS as readonly string[]).includes(value);
}

function isScheduleModelRef(value: unknown): boolean {
  return (
    exactObject(value, ["provider", "id"], ["thinkingLevel"]) &&
    isNonEmptyString(value.provider) &&
    value.provider.length <= 200 &&
    isNonEmptyString(value.id) &&
    value.id.length <= 200 &&
    (value.thinkingLevel === undefined ||
      (typeof value.thinkingLevel === "string" && value.thinkingLevel.length <= 16))
  );
}

function isScheduleTrigger(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  switch (value.type) {
    case "manual":
      return hasExactKeys(value, ["type"]);
    case "once":
      return (
        hasExactKeys(value, ["type", "at"]) && isNonEmptyString(value.at) && value.at.length <= 40
      );
    case "interval":
      return (
        hasExactKeys(value, ["type", "every"]) &&
        isNonEmptyString(value.every) &&
        value.every.length <= 16
      );
    case "cron":
      return (
        hasExactKeys(value, ["type", "cron"], ["timezone"]) &&
        isNonEmptyString(value.cron) &&
        value.cron.length <= 100 &&
        (value.timezone === undefined ||
          (typeof value.timezone === "string" && value.timezone.length <= 64))
      );
    default:
      return false;
  }
}

function isScheduleTagArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 20 &&
    value.every((tag) => isNonEmptyString(tag) && tag.length <= 100)
  );
}

function isScheduleTimeoutMs(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 5_000 &&
    value <= 6 * 60 * 60 * 1000
  );
}

function isScheduleLimit(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 200;
}

/** Shared field validators for schedule.createJob / schedule.updateJob. */
function isScheduleJobFields(params: Record<string, unknown>): boolean {
  return (
    (params.name === undefined || (isNonEmptyString(params.name) && params.name.length <= 200)) &&
    (params.prompt === undefined ||
      (typeof params.prompt === "string" && params.prompt.length <= 20_000)) &&
    (params.command === undefined ||
      params.command === null ||
      (typeof params.command === "string" && params.command.length <= 2_000)) &&
    (params.cwd === undefined || (isNonEmptyString(params.cwd) && params.cwd.length <= 1_024)) &&
    (params.trigger === undefined || isScheduleTrigger(params.trigger)) &&
    (params.permission === undefined || isSchedulePermission(params.permission)) &&
    (params.model === undefined || params.model === null || isScheduleModelRef(params.model)) &&
    (params.missedWindow === undefined ||
      (typeof params.missedWindow === "string" &&
        (SCHEDULE_MISSED_WINDOWS as readonly string[]).includes(params.missedWindow))) &&
    (params.timeoutMs === undefined || isScheduleTimeoutMs(params.timeoutMs)) &&
    (params.maxRuns === undefined ||
      params.maxRuns === null ||
      (typeof params.maxRuns === "number" &&
        Number.isSafeInteger(params.maxRuns) &&
        params.maxRuns >= 1 &&
        params.maxRuns <= 10_000)) &&
    (params.loadExtensions === undefined || typeof params.loadExtensions === "boolean") &&
    (params.tags === undefined || isScheduleTagArray(params.tags)) &&
    (params.enabled === undefined || typeof params.enabled === "boolean") &&
    (params.notify === undefined ||
      (typeof params.notify === "string" &&
        (SCHEDULE_NOTIFY_MODES as readonly string[]).includes(params.notify)))
  );
}

/** schedule.agentStart 可选的「AI 优化」原计划上下文：必填字段 + 复用
 *  isScheduleJobFields 校验可选字段。刻意不限制额外键 —— 桌面端直接传
 *  完整的 ScheduleJob（含 createdAt/runCount 等运行统计），宿主只取需要
 *  的字段。 */
function isScheduleAgentEditJob(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return (
    isNonEmptyString(value.id) &&
    value.id.length <= 128 &&
    typeof value.enabled === "boolean" &&
    typeof value.loadExtensions === "boolean" &&
    isScheduleJobFields(value)
  );
}

const SCHEDULE_JOB_OPTIONAL_KEYS = [
  "name",
  "prompt",
  "command",
  "cwd",
  "trigger",
  "permission",
  "model",
  "missedWindow",
  "timeoutMs",
  "maxRuns",
  "loadExtensions",
  "tags",
  "enabled",
  "notify",
] as const;

/** Optional keys for create (name/prompt/cwd/trigger are required there). */
const SCHEDULE_JOB_CREATE_OPTIONAL_KEYS = [
  "command",
  "permission",
  "model",
  "missedWindow",
  "timeoutMs",
  "maxRuns",
  "loadExtensions",
  "tags",
  "enabled",
  "notify",
] as const;

function requireRevision(
  obj: Record<string, unknown>,
  key: string,
  method: HostMethod,
): ValidationResult<number> {
  const value = obj[key];
  return isSafeRevision(value)
    ? { ok: true, value }
    : fail(`${key} must be a non-negative safe integer`, { method });
}

function validateImages(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= MAX_AGENT_REQUEST_IMAGES &&
      value.every(
        (image) =>
          exactObject(image, ["mediaType", "data"]) &&
          isNonEmptyString(image.mediaType) &&
          isNonEmptyString(image.data) &&
          validateBase64ImageData(image.data),
      ))
  );
}

function validateAttachmentIds(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) && new Set(value).size === value.length && value.every(isUuid))
  );
}

function validateBase64ImageData(data: string): boolean {
  const decodedBytes = base64DecodedByteLength(data);
  return decodedBytes !== null && decodedBytes <= MAX_AGENT_IMAGE_BYTES;
}

function base64DecodedByteLength(data: string): number | null {
  const maxEncodedCharacters = Math.ceil(MAX_AGENT_IMAGE_BYTES / 3) * 4;
  if (data.length > maxEncodedCharacters) return null;

  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const contentLength = data.length - padding;
  if (contentLength % 4 === 1 || (padding > 0 && data.length % 4 !== 0)) return null;

  for (let index = 0; index < contentLength; index += 1) {
    const code = data.charCodeAt(index);
    const isBase64Character =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!isBase64Character) return null;
  }
  return Math.floor((contentLength * 3) / 4);
}

/** 备忘录记录类型白名单。 */
function isMemoNoteType(value: unknown): boolean {
  return value === "memo" || value === "idea" || value === "task";
}

/** 备忘录状态白名单。 */
function isMemoNoteStatus(value: unknown): boolean {
  return value === "open" || value === "done" || value === "archived";
}

/** 备忘录图片载荷：base64 解码后不超过 8 MiB。 */
function isMemoImageInput(value: unknown): boolean {
  if (!exactObject(value, [], ["fileName", "mediaType", "dataBase64"])) return false;
  if (value.fileName !== undefined && (!isString(value.fileName) || value.fileName.length > 260)) {
    return false;
  }
  if (!isNonEmptyString(value.mediaType) || value.mediaType.length > 100) return false;
  if (!value.mediaType.startsWith("image/")) return false;
  if (!isString(value.dataBase64) || value.dataBase64.length > 12_000_000) return false;
  return /^[A-Za-z0-9+/]*={0,2}$/.test(value.dataBase64);
}

/** memo.setSyncConfig / memo.testSync 共用的 R2 配置字段级校验。 */
function isMemoSyncConfigInput(value: unknown): boolean {
  if (
    !exactObject(value, [], ["accountId", "accessKeyId", "secretAccessKey", "bucket", "autoSync"])
  ) {
    return false;
  }
  return (
    isNonEmptyString(value.accountId) &&
    value.accountId.length <= 128 &&
    isNonEmptyString(value.accessKeyId) &&
    value.accessKeyId.length <= 256 &&
    isNonEmptyString(value.secretAccessKey) &&
    value.secretAccessKey.length <= 256 &&
    isNonEmptyString(value.bucket) &&
    value.bucket.length <= 63 &&
    typeof value.autoSync === "boolean"
  );
}

/** memo.update / memo.create 共用的字段级校验。 */
function isMemoNoteFields(value: Record<string, unknown>): boolean {
  return (
    (value.type === undefined || isMemoNoteType(value.type)) &&
    (value.title === undefined || (isNonEmptyString(value.title) && value.title.length <= 300)) &&
    (value.contentMd === undefined ||
      (isString(value.contentMd) && value.contentMd.length <= 200_000)) &&
    (value.status === undefined || isMemoNoteStatus(value.status)) &&
    (value.tags === undefined ||
      (isStringArray(value.tags) &&
        value.tags.length <= 20 &&
        value.tags.every((tag) => tag.length <= 60))) &&
    (value.workspaceHint === undefined ||
      value.workspaceHint === null ||
      (isString(value.workspaceHint) && value.workspaceHint.length <= 300))
  );
}

function isResourcePreferenceUpdate(value: unknown): boolean {
  if (
    !exactObject(value, ["resourceId", "targetScope", "preference"]) ||
    !isNonEmptyString(value.resourceId)
  ) {
    return false;
  }
  if (value.targetScope === "user") {
    return value.preference === "enabled" || value.preference === "disabled";
  }
  return (
    value.targetScope === "project" &&
    ["inherit", "enabled", "disabled"].includes(String(value.preference))
  );
}

export function validateMethodContext<M extends HostMethod>(
  method: M,
  context: unknown,
): ValidationResult<HostContextMap[M]> {
  const scope: MethodContextScope = METHOD_CONTEXT_SCOPE[method];
  if (scope === "empty") {
    if (context === undefined || context === null) {
      return { ok: true, value: {} as HostContextMap[M] };
    }
    return exactObject(context, [])
      ? { ok: true, value: {} as HostContextMap[M] }
      : fail("system.hello context must be an exact empty object", { method });
  }

  if (!isPlainObject(context)) return fail("context must be an object", { method });
  const workspaceFields = [
    "expectedHostInstanceId",
    "expectedWorkspaceId",
    "expectedWorkspaceRevision",
  ] as const;
  const sessionFields = [
    ...workspaceFields,
    "expectedSessionId",
    "expectedSessionRevision",
  ] as const;

  const allowed =
    scope === "host"
      ? ["expectedHostInstanceId"]
      : scope === "workspace"
        ? [...workspaceFields]
        : scope === "nullableSession" || scope === "activeSession" || scope === "sessionTarget"
          ? [...sessionFields]
          : scope === "toolMutation"
            ? [...sessionFields, "expectedToolRevision"]
            : scope === "workspacePackage"
              ? [...workspaceFields, "expectedPackageRevision"]
              : [...sessionFields, "expectedPackageRevision"];
  if (!hasExactKeys(context, allowed)) {
    return fail("context has missing or unexpected fields", { method, allowed });
  }
  if (!isUuid(context.expectedHostInstanceId)) {
    return fail("expectedHostInstanceId must be UUID", { method });
  }

  if (scope === "host") return { ok: true, value: context as HostContextMap[M] };

  if (context.expectedWorkspaceId !== null && !isUuid(context.expectedWorkspaceId)) {
    return fail("expectedWorkspaceId must be UUID or null", { method });
  }
  const workspaceRevision = requireRevision(context, "expectedWorkspaceRevision", method);
  if (!workspaceRevision.ok) return workspaceRevision;

  if (scope === "workspace") return { ok: true, value: context as HostContextMap[M] };
  if (scope === "workspacePackage") {
    const packageRevision = requireRevision(context, "expectedPackageRevision", method);
    if (!packageRevision.ok) return packageRevision;
    return { ok: true, value: context as HostContextMap[M] };
  }

  if (scope === "activeSession" || scope === "sessionTarget" || scope === "toolMutation") {
    if (!isUuid(context.expectedSessionId)) {
      return fail("expectedSessionId must be UUID", { method });
    }
  } else if (context.expectedSessionId !== null && !isUuid(context.expectedSessionId)) {
    return fail("expectedSessionId must be UUID or null", { method });
  }
  const sessionRevision = requireRevision(context, "expectedSessionRevision", method);
  if (!sessionRevision.ok) return sessionRevision;
  if (scope === "toolMutation") {
    const toolRevision = requireRevision(context, "expectedToolRevision", method);
    if (!toolRevision.ok) return toolRevision;
  }
  if (scope === "sessionPackage") {
    const packageRevision = requireRevision(context, "expectedPackageRevision", method);
    if (!packageRevision.ok) return packageRevision;
  }
  return { ok: true, value: context as HostContextMap[M] };
}

function isTelegramAssistantConfig(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    exactObject(
      obj,
      [],
      ["draftPreviews", "rendering", "proactivePush", "activity", "timeInjection"],
    ) &&
    (obj.draftPreviews === undefined || isBoolean(obj.draftPreviews)) &&
    (obj.rendering === undefined || obj.rendering === "rich" || obj.rendering === "html") &&
    (obj.proactivePush === undefined || isBoolean(obj.proactivePush)) &&
    (obj.activity === undefined ||
      obj.activity === "quiet" ||
      obj.activity === "thinking" ||
      obj.activity === "tools" ||
      obj.activity === "verbose") &&
    (obj.timeInjection === undefined ||
      obj.timeInjection === "hidden" ||
      obj.timeInjection === "always" ||
      obj.timeInjection === "interval")
  );
}

function isTelegramVoiceConfig(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    exactObject(obj, [], ["replyMode"]) &&
    (obj.replyMode === undefined ||
      obj.replyMode === "manual" ||
      obj.replyMode === "hidden" ||
      obj.replyMode === "mirror" ||
      obj.replyMode === "always")
  );
}

function isTelegramThreadsConfig(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    exactObject(obj, [], ["automaticCleanup"]) &&
    (obj.automaticCleanup === undefined || isBoolean(obj.automaticCleanup))
  );
}

export function validateRequestParams<M extends HostMethod>(
  method: M,
  params: unknown,
): ValidationResult<HostRequestParams[M]> {
  const ok = (value: unknown) => ({ ok: true, value: value as HostRequestParams[M] }) as const;
  switch (method) {
    case "system.hello":
      return exactObject(
        params,
        ["clientName", "clientVersion", "protocolVersion"],
        ["extensionDecisionPresentation"],
      ) &&
        isNonEmptyString(params.clientName) &&
        isNonEmptyString(params.clientVersion) &&
        params.protocolVersion === 1 &&
        (params.extensionDecisionPresentation === undefined ||
          ["legacy-modal", "auto", "inline-first"].includes(
            String(params.extensionDecisionPresentation),
          ))
        ? ok(params)
        : fail("invalid system.hello params", { method });
    case "system.getStatus":
    case "system.rehydrate":
    case "system.shutdown":
    case "piSettings.get":
    case "workspace.getCurrent":
    case "git.getStatus":
    case "git.listBranches":
    case "git.push":
    case "git.pull":
    case "session.list":
    case "session.cleanupArchived":
    case "session.reload":
    case "session.getSnapshot":
    case "session.getTree":
    case "session.getStats":
    case "session.getForkPoints":
    case "session.usageReport":
    case "session.getCommands":
    case "telegram.getProfiles":
    case "telegram.listSessions":
    case "telegram.getConfig":
    case "telegram.reset":
    case "telegram.status":
      return params === null ? ok(null) : fail("params must be null", { method });
    case "telegram.getSession":
      return exactObject(params, ["sessionPath"]) && isNonEmptyString(params.sessionPath)
        ? ok(params)
        : fail("invalid telegram.getSession params", { method });
    case "telegram.updateConfig":
      return exactObject(params, [], ["assistant", "voice", "threads"]) &&
        (params.assistant === undefined || isTelegramAssistantConfig(params.assistant)) &&
        (params.voice === undefined || isTelegramVoiceConfig(params.voice)) &&
        (params.threads === undefined || isTelegramThreadsConfig(params.threads))
        ? ok(params)
        : fail("invalid telegram.updateConfig params", { method });
    case "telegram.saveProfile":
      return exactObject(params, ["token"], ["botId", "botUsername", "botName"]) &&
        isNonEmptyString(params.token) &&
        (params.botId === undefined ||
          (typeof params.botId === "number" &&
            Number.isSafeInteger(params.botId) &&
            params.botId >= 0)) &&
        (params.botUsername === undefined || isNonEmptyString(params.botUsername)) &&
        (params.botName === undefined || isString(params.botName))
        ? ok(params)
        : fail("invalid telegram.saveProfile params", { method });
    case "subagents.getSession":
    case "subagents.stop":
    case "subagents.pause":
    case "subagents.continue":
    case "subagents.resume":
      return exactObject(params, ["nodeId"], []) &&
        isNonEmptyString(params.nodeId) &&
        params.nodeId.length <= 160
        ? ok(params)
        : fail(`invalid ${method} params`, { method });
    case "agent.abort":
    case "agent.abortCompaction":
    case "agent.abortRetry":
    case "agent.getTools":
    case "provider.list":
    case "provider.authStatus":
    case "model.list":
    case "package.updateAll":
    case "package.reloadResources":
      return params === null ? ok(null) : fail("params must be null", { method });
    case "workspace.searchFiles":
      return exactObject(params, ["query"], ["limit"]) &&
        isString(params.query) &&
        (params.limit === undefined ||
          (typeof params.limit === "number" &&
            Number.isInteger(params.limit) &&
            params.limit >= 1 &&
            params.limit <= 5000))
        ? ok(params)
        : fail("invalid workspace.searchFiles params", { method });
    case "session.searchAll":
      return exactObject(params, ["query"], ["limit", "includeArchived"]) &&
        isString(params.query) &&
        params.query.trim().length >= 1 &&
        params.query.length <= 256 &&
        (params.limit === undefined ||
          (typeof params.limit === "number" &&
            Number.isInteger(params.limit) &&
            params.limit >= 1 &&
            params.limit <= 200)) &&
        (params.includeArchived === undefined || typeof params.includeArchived === "boolean")
        ? ok(params)
        : fail("invalid session.searchAll params", { method });
    case "workspace.listDirectory":
    case "workspace.readFilePreview":
      return exactObject(params, ["path"]) && isString(params.path)
        ? ok(params)
        : fail("invalid workspace.listDirectory params", { method });
    case "workspace.writeTextFile":
      return exactObject(params, ["path", "text", "expectedVersion"]) &&
        isString(params.path) &&
        isString(params.text) &&
        params.text.length <= 1024 * 1024 &&
        isString(params.expectedVersion) &&
        /^[a-f0-9]{64}$/.test(params.expectedVersion)
        ? ok(params)
        : fail("invalid workspace.writeTextFile params", { method });
    case "workspace.setDirectoryWatches":
      return exactObject(params, ["paths"]) &&
        Array.isArray(params.paths) &&
        params.paths.length <= 128 &&
        params.paths.every(isString)
        ? ok(params)
        : fail("invalid workspace.setDirectoryWatches params", { method });
    case "git.setWatching":
      return exactObject(params, ["enabled"]) && isBoolean(params.enabled)
        ? ok(params)
        : fail("invalid git.setWatching params", { method });
    case "git.getDiff":
      return exactObject(params, ["path", "area", "expectedRevision"]) &&
        isValidGitPath(params.path) &&
        (params.area === "staged" || params.area === "unstaged") &&
        isSafeRevision(params.expectedRevision)
        ? ok(params)
        : fail("invalid git.getDiff params", { method });
    case "git.mutateHunk":
      return exactObject(params, [
        "path",
        "area",
        "hunkId",
        "operation",
        "expectedRevision",
        "expectedContentGeneration",
      ]) &&
        isValidGitPath(params.path) &&
        (params.area === "staged" || params.area === "unstaged") &&
        (params.operation === "stage" ||
          params.operation === "unstage" ||
          params.operation === "discard") &&
        typeof params.hunkId === "string" &&
        /^[0-9a-f]{64}$/.test(params.hunkId) &&
        isSafeRevision(params.expectedRevision) &&
        typeof params.expectedContentGeneration === "string" &&
        /^[0-9a-f]{64}$/.test(params.expectedContentGeneration)
        ? ok(params)
        : fail("invalid git.mutateHunk params", { method });
    case "git.stage":
    case "git.unstage":
    case "git.discard":
      return exactObject(params, ["path", "expectedRevision"]) &&
        isValidGitPath(params.path) &&
        isSafeRevision(params.expectedRevision)
        ? ok(params)
        : fail(`invalid ${method} params`, { method });
    case "git.stageAll":
    case "git.unstageAll":
      return exactObject(params, ["expectedRevision"]) && isSafeRevision(params.expectedRevision)
        ? ok(params)
        : fail(`invalid ${method} params`, { method });
    case "git.commit":
      return exactObject(params, ["message", "expectedIndexGeneration"]) &&
        isValidCommitMessage(params.message) &&
        typeof params.expectedIndexGeneration === "string" &&
        /^[0-9a-f]{64}$/.test(params.expectedIndexGeneration)
        ? ok(params)
        : fail("invalid git.commit params", { method });
    case "git.createBranch":
    case "git.switchBranch":
      return exactObject(params, ["name", "expectedRevision"]) &&
        isValidGitBranchName(params.name) &&
        isSafeRevision(params.expectedRevision)
        ? ok(params)
        : fail(`invalid ${method} params`, { method });
    case "git.listHistory":
      return exactObject(params, ["limit"], ["cursor"]) &&
        typeof params.limit === "number" &&
        Number.isInteger(params.limit) &&
        params.limit >= 1 &&
        params.limit <= MAX_GIT_HISTORY_PAGE_SIZE &&
        (params.cursor === undefined || isGitSha(params.cursor))
        ? ok(params)
        : fail("invalid git.listHistory params", { method });
    case "git.getCommitDiff":
      return exactObject(params, ["commitSha"]) && isGitSha(params.commitSha)
        ? ok(params)
        : fail("invalid git.getCommitDiff params", { method });
    case "git.generateCommitMessage":
      return exactObject(params, ["expectedIndexGeneration"]) &&
        typeof params.expectedIndexGeneration === "string" &&
        /^[0-9a-f]{64}$/.test(params.expectedIndexGeneration)
        ? ok(params)
        : fail("invalid git.generateCommitMessage params", { method });
    case "attachment.create":
      return exactObject(params, ["path"]) && isNonEmptyString(params.path)
        ? ok(params)
        : fail("invalid attachment.create params", { method });
    case "attachment.createText":
      return exactObject(params, ["text"]) && isValidAttachmentText(params.text)
        ? ok(params)
        : fail("invalid attachment.createText params", { method });
    case "attachment.get":
    case "attachment.remove":
      return exactObject(params, ["attachmentId"]) && isUuid(params.attachmentId)
        ? ok(params)
        : fail(`invalid ${method} params`, { method });
    case "workspace.setCurrent":
      return exactObject(params, ["cwd"], ["optimistic"]) && isNonEmptyString(params.cwd)
        ? ok(params)
        : fail("params must be { cwd: string, optimistic?: boolean }", { method });
    case "session.create":
      return exactObject(params, [], ["name"]) &&
        (params.name === undefined || isNonEmptyString(params.name))
        ? ok(params)
        : fail("session.create params must contain optional non-empty name", { method });
    case "session.open":
      return exactObject(params, ["sessionPath"]) && isNonEmptyString(params.sessionPath)
        ? ok(params)
        : fail("invalid session.open params", { method });
    case "session.archive":
    case "session.restore":
    case "session.delete":
      return exactObject(params, ["sessionId", "sessionPath"]) &&
        isUuid(params.sessionId) &&
        isNonEmptyString(params.sessionPath)
        ? ok(params)
        : fail(`invalid ${method} params`, { method });
    case "session.setName":
      return exactObject(params, ["name"]) && isNonEmptyString(params.name)
        ? ok(params)
        : fail("invalid session.setName params", { method });
    case "session.rename":
      return exactObject(params, ["sessionId", "sessionPath", "name"]) &&
        isUuid(params.sessionId) &&
        isNonEmptyString(params.sessionPath) &&
        isNonEmptyString(params.name)
        ? ok(params)
        : fail("invalid session.rename params", { method });
    case "session.getEntries":
      return params === null ||
        (exactObject(params, [], ["sinceEntryId"]) &&
          (params.sinceEntryId === undefined || isNonEmptyString(params.sinceEntryId)))
        ? ok(params)
        : fail("invalid session.getEntries params", { method });
    case "agent.prompt":
      return exactObject(
        params,
        ["text"],
        ["images", "attachmentIds", "streamingBehavior", "attachQueuedImages"],
      ) &&
        isString(params.text) &&
        validateImages(params.images) &&
        validateAttachmentIds(params.attachmentIds) &&
        (params.attachQueuedImages === undefined ||
          typeof params.attachQueuedImages === "boolean") &&
        (params.streamingBehavior === undefined ||
          params.streamingBehavior === "steer" ||
          params.streamingBehavior === "followUp")
        ? ok(params)
        : fail("invalid agent.prompt params", { method });
    case "agent.steer":
    case "agent.followUp":
      return exactObject(params, ["text"], ["images", "attachmentIds"]) &&
        isString(params.text) &&
        validateImages(params.images) &&
        validateAttachmentIds(params.attachmentIds)
        ? ok(params)
        : fail(`invalid ${method} params`, { method });
    case "agent.clearQueue":
      return exactObject(params, ["expectedRevision"]) && isSafeRevision(params.expectedRevision)
        ? ok(params)
        : fail("invalid agent.clearQueue params", { method });
    case "agent.setQueue":
      return exactObject(params, ["expectedRevision", "steering", "followUp"]) &&
        isSafeRevision(params.expectedRevision) &&
        Array.isArray(params.steering) &&
        params.steering.every(isNonEmptyString) &&
        Array.isArray(params.followUp) &&
        params.followUp.every(isNonEmptyString)
        ? ok(params)
        : fail("invalid agent.setQueue params", { method });
    case "agent.runNow": {
      if (
        !exactObject(params, ["expectedRevision"], ["followUpIndex", "steeringIndex"]) ||
        !isSafeRevision(params.expectedRevision)
      ) {
        return fail("invalid agent.runNow params", { method });
      }
      const hasFollowUp = params.followUpIndex !== undefined;
      const hasSteering = params.steeringIndex !== undefined;
      if (hasFollowUp === hasSteering) {
        // Exactly one queue kind must be targeted.
        return fail("invalid agent.runNow params", { method });
      }
      const targetIndex = hasFollowUp ? params.followUpIndex : params.steeringIndex;
      return isSafeRevision(targetIndex)
        ? ok(params)
        : fail("invalid agent.runNow params", { method });
    }
    case "agent.compact":
      return params === null ||
        (exactObject(params, [], ["instructions"]) &&
          (params.instructions === undefined || isString(params.instructions)))
        ? ok(params)
        : fail("invalid agent.compact params", { method });
    case "agent.navigateTree":
      return exactObject(params, ["targetId"]) &&
        isString(params.targetId) &&
        params.targetId.length > 0
        ? ok(params)
        : fail("invalid agent.navigateTree params", { method });
    case "session.fork":
      return exactObject(params, ["entryId"], ["position"]) &&
        isString(params.entryId) &&
        params.entryId.length > 0 &&
        (params.position === undefined || params.position === "before" || params.position === "at")
        ? ok(params)
        : fail("invalid session.fork params", { method });
    case "session.export":
      return exactObject(params, ["format"], ["sessionId", "sessionPath", "path"]) &&
        (params.format === "html" || params.format === "jsonl") &&
        (params.path === undefined || (isString(params.path) && params.path.length > 0)) &&
        (params.sessionId === undefined || isNonEmptyString(params.sessionId)) &&
        (params.sessionPath === undefined || isNonEmptyString(params.sessionPath)) &&
        // The target is either the active Session (no locator) or one fully
        // identified Session file; a partial locator would be ambiguous.
        (params.sessionId === undefined) === (params.sessionPath === undefined)
        ? ok(params)
        : fail("invalid session.export params", { method });
    case "agent.setAutoCompaction":
    case "agent.setAutoRetry":
      return exactObject(params, ["enabled"]) && isBoolean(params.enabled)
        ? ok(params)
        : fail(`invalid ${method} params`, { method });
    case "agent.setActiveTools":
      return exactObject(params, ["names"]) && isStringArray(params.names)
        ? ok(params)
        : fail("agent.setActiveTools names must be string[]", { method });
    case "provider.save":
      return exactObject(params, ["provider"], ["originalId", "apiKey", "clearApiKey"]) &&
        isProviderDraft(params.provider) &&
        (params.originalId === undefined || isNonEmptyString(params.originalId)) &&
        (params.apiKey === undefined || isNonEmptyString(params.apiKey)) &&
        (params.clearApiKey === undefined || isBoolean(params.clearApiKey)) &&
        !(params.apiKey !== undefined && params.clearApiKey === true)
        ? ok(params)
        : fail("invalid provider.save params", { method });
    case "provider.setEnabled":
      return exactObject(params, ["providerId", "enabled"]) &&
        isNonEmptyString(params.providerId) &&
        isBoolean(params.enabled)
        ? ok(params)
        : fail("invalid provider.setEnabled params", { method });
    case "provider.remove":
    case "provider.fetchModels":
    case "provider.logout":
    case "provider.builtinModels":
      return exactObject(params, ["providerId"]) && isNonEmptyString(params.providerId)
        ? ok(params)
        : fail(`invalid ${method} params`, { method });
    case "provider.getApiKey":
      return exactObject(params, ["providerId"], ["reveal"]) &&
        isNonEmptyString(params.providerId) &&
        (params.reveal === undefined || isBoolean(params.reveal))
        ? ok(params)
        : fail("invalid provider.getApiKey params", { method });
    case "provider.setBuiltinModels":
      return exactObject(params, ["providerId", "modelIds"]) &&
        isNonEmptyString(params.providerId) &&
        Array.isArray(params.modelIds) &&
        params.modelIds.every(isNonEmptyString)
        ? ok(params)
        : fail("invalid provider.setBuiltinModels params", { method });
    case "provider.loginStart":
      return exactObject(params, ["providerId", "authType"]) &&
        isNonEmptyString(params.providerId) &&
        (params.authType === "oauth" || params.authType === "api_key")
        ? ok(params)
        : fail("invalid provider.loginStart params", { method });
    case "provider.loginRespond":
      return exactObject(params, ["loginId", "promptId", "value"]) &&
        isNonEmptyString(params.loginId) &&
        isNonEmptyString(params.promptId) &&
        isString(params.value)
        ? ok(params)
        : fail("invalid provider.loginRespond params", { method });
    case "provider.loginCancel":
      return exactObject(params, ["loginId"]) && isNonEmptyString(params.loginId)
        ? ok(params)
        : fail("invalid provider.loginCancel params", { method });
    case "provider.checkConnection":
      return exactObject(params, ["providerId"], ["modelId"]) &&
        isNonEmptyString(params.providerId) &&
        (params.modelId === undefined || isNonEmptyString(params.modelId))
        ? ok(params)
        : fail("invalid provider.checkConnection params", { method });
    case "model.setCurrent":
      return exactObject(params, ["provider", "modelId"]) &&
        isNonEmptyString(params.provider) &&
        isNonEmptyString(params.modelId)
        ? ok(params)
        : fail("invalid model.setCurrent params", { method });
    case "piSettings.patch":
      return exactObject(
        params,
        [],
        [
          "defaultProvider",
          "defaultModel",
          "defaultThinkingLevel",
          "retryMaxRetries",
          "defaultProjectTrust",
          "steeringMode",
          "followUpMode",
          "defaultTools",
          "askUserQuestionEnabled",
        ],
      ) &&
        (params.defaultProvider === undefined || isNonEmptyString(params.defaultProvider)) &&
        (params.defaultModel === undefined || isNonEmptyString(params.defaultModel)) &&
        (params.defaultThinkingLevel === undefined ||
          ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
            String(params.defaultThinkingLevel),
          )) &&
        (params.retryMaxRetries === undefined ||
          (typeof params.retryMaxRetries === "number" &&
            Number.isSafeInteger(params.retryMaxRetries) &&
            params.retryMaxRetries >= 0 &&
            params.retryMaxRetries <= 20)) &&
        (params.defaultProjectTrust === undefined ||
          ["ask", "always", "never"].includes(String(params.defaultProjectTrust))) &&
        (params.steeringMode === undefined ||
          ["all", "one-at-a-time"].includes(String(params.steeringMode))) &&
        (params.followUpMode === undefined ||
          ["all", "one-at-a-time"].includes(String(params.followUpMode))) &&
        (params.defaultTools === undefined ||
          (Array.isArray(params.defaultTools) &&
            params.defaultTools.every((name) => typeof name === "string"))) &&
        (params.askUserQuestionEnabled === undefined ||
          typeof params.askUserQuestionEnabled === "boolean")
        ? ok(params)
        : fail("invalid piSettings.patch params", { method });
    case "model.setThinkingLevel":
      return exactObject(params, ["level"]) && isNonEmptyString(params.level)
        ? ok(params)
        : fail("invalid model.setThinkingLevel params", { method });
    case "skill.list":
    case "prompt.list":
      return params === null ? ok(null) : fail("params must be null", { method });
    case "skill.addPath":
    case "skill.removePath":
      return exactObject(params, ["path", "scope"]) &&
        isNonEmptyString(params.path) &&
        ["user", "project"].includes(String(params.scope))
        ? ok(params)
        : fail(`invalid ${method} params`, { method });
    case "package.list":
      return exactObject(params, ["scope"], ["includeResources"]) &&
        ["user", "project", "all"].includes(String(params.scope)) &&
        (params.includeResources === undefined || isBoolean(params.includeResources))
        ? ok(params)
        : fail("invalid package.list params", { method });
    case "package.catalog": {
      if (!exactObject(params, [], ["refresh", "page", "query", "type", "sort"])) {
        return fail("invalid package.catalog params", { method });
      }
      const pageOk =
        params.page === undefined ||
        (typeof params.page === "number" &&
          Number.isSafeInteger(params.page) &&
          params.page >= 1 &&
          params.page <= 10_000);
      const queryOk =
        params.query === undefined ||
        (typeof params.query === "string" && params.query.length > 0 && params.query.length <= 200);
      const typeOk =
        params.type === undefined ||
        params.type === "extension" ||
        params.type === "skill" ||
        params.type === "theme" ||
        params.type === "prompt";
      const sortOk =
        params.sort === undefined || params.sort === "downloads" || params.sort === "recent";
      return (params.refresh === undefined || isBoolean(params.refresh)) &&
        pageOk &&
        queryOk &&
        typeOk &&
        sortOk
        ? ok(params)
        : fail("invalid package.catalog params", { method });
    }
    case "package.install":
      return exactObject(params, ["source", "scope"]) &&
        isNonEmptyString(params.source) &&
        ["user", "project"].includes(String(params.scope))
        ? ok(params)
        : fail("invalid package.install params", { method });
    case "package.remove":
    case "package.update":
    case "package.getResources":
      return exactObject(params, ["packageId"]) && isNonEmptyString(params.packageId)
        ? ok(params)
        : fail(`invalid ${method} params`, { method });
    case "package.checkUpdates":
      return params === null ||
        (exactObject(params, [], ["packageId"]) &&
          (params.packageId === undefined || isNonEmptyString(params.packageId)))
        ? ok(params)
        : fail("invalid package.checkUpdates params", { method });
    case "resource.setPreference":
      return isResourcePreferenceUpdate(params)
        ? ok(params)
        : fail("invalid resource.setPreference params", { method });
    case "resource.setPreferences":
      return exactObject(params, ["updates"]) &&
        Array.isArray(params.updates) &&
        params.updates.every(isResourcePreferenceUpdate)
        ? ok(params)
        : fail("invalid resource.setPreferences params", { method });
    case "pluginLibrary.catalog":
      return params === null ||
        (exactObject(params, [], ["refresh"]) &&
          (params.refresh === undefined || isBoolean(params.refresh)))
        ? ok(params)
        : fail("invalid pluginLibrary.catalog params", { method });
    case "pluginLibrary.apply":
      return exactObject(params, ["source", "pattern", "enabled"]) &&
        isNonEmptyString(params.source) &&
        typeof params.pattern === "string" &&
        params.pattern.length > 0 &&
        params.pattern.length <= 512 &&
        !paramsPatternUnsafe(params.pattern) &&
        isBoolean(params.enabled)
        ? ok(params)
        : fail("invalid pluginLibrary.apply params", { method });
    case "pluginLibrary.setEnv":
      return exactObject(params, ["vars"]) &&
        isPlainObject(params.vars) &&
        Object.entries(params.vars).every(
          ([name, value]) =>
            /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) &&
            (value === null || (typeof value === "string" && value.length <= 8192)),
        )
        ? ok(params)
        : fail("invalid pluginLibrary.setEnv params", { method });
    case "extensionUi.configure":
      return exactObject(params, ["extensionDecisionPresentation"]) &&
        ["legacy-modal", "auto", "inline-first"].includes(
          String(params.extensionDecisionPresentation),
        )
        ? ok(params)
        : fail("invalid extensionUi.configure params", { method });
    case "extensionUi.respond":
      return exactObject(params, ["requestId", "status"], ["value"]) &&
        isUuid(params.requestId) &&
        (params.status === "resolved" || params.status === "cancelled") &&
        (params.value === undefined || isJsonValue(params.value))
        ? ok(params)
        : fail("invalid extensionUi.respond params", { method });
    case "extensionUi.customInput":
      return exactObject(params, ["requestId", "data"]) &&
        isUuid(params.requestId) &&
        isNonEmptyString(params.data)
        ? ok(params)
        : fail("invalid extensionUi.customInput params", { method });
    case "extensionUi.customResize":
      return exactObject(params, ["requestId", "cols", "rows"]) &&
        isUuid(params.requestId) &&
        typeof params.cols === "number" &&
        Number.isInteger(params.cols) &&
        params.cols >= 20 &&
        params.cols <= 1000 &&
        typeof params.rows === "number" &&
        Number.isInteger(params.rows) &&
        params.rows >= 4 &&
        params.rows <= 1000
        ? ok(params)
        : fail("invalid extensionUi.customResize params", { method });
    case "telegram.validateToken":
      return exactObject(params, ["token"]) && isNonEmptyString(params.token)
        ? ok(params)
        : fail("invalid telegram.validateToken params", { method });
    case "schedule.status":
    case "schedule.listJobs":
      return params === null ? ok(null) : fail("params must be null", { method });
    case "schedule.createJob":
      return exactObject(
        params,
        ["name", "prompt", "cwd", "trigger"],
        SCHEDULE_JOB_CREATE_OPTIONAL_KEYS,
      ) &&
        isNonEmptyString(params.name) &&
        params.name.length <= 200 &&
        typeof params.prompt === "string" &&
        params.prompt.length <= 20_000 &&
        isNonEmptyString(params.cwd) &&
        params.cwd.length <= 1_024 &&
        isScheduleTrigger(params.trigger) &&
        isScheduleJobFields(params)
        ? ok(params)
        : fail("invalid schedule.createJob params", { method });
    case "schedule.updateJob":
      return exactObject(params, ["id"], SCHEDULE_JOB_OPTIONAL_KEYS) &&
        isNonEmptyString(params.id) &&
        params.id.length <= 32 &&
        isScheduleJobFields(params)
        ? ok(params)
        : fail("invalid schedule.updateJob params", { method });
    case "schedule.deleteJob":
      return exactObject(params, ["id"], ["purge"]) &&
        isNonEmptyString(params.id) &&
        params.id.length <= 32 &&
        (params.purge === undefined || typeof params.purge === "boolean")
        ? ok(params)
        : fail("invalid schedule.deleteJob params", { method });
    case "schedule.setJobEnabled":
      return exactObject(params, ["id", "enabled"]) &&
        isNonEmptyString(params.id) &&
        params.id.length <= 32 &&
        typeof params.enabled === "boolean"
        ? ok(params)
        : fail("invalid schedule.setJobEnabled params", { method });
    case "schedule.runJobNow":
      return exactObject(params, ["id"], ["permission", "timeoutMs"]) &&
        isNonEmptyString(params.id) &&
        params.id.length <= 32 &&
        (params.permission === undefined || isSchedulePermission(params.permission)) &&
        (params.timeoutMs === undefined || isScheduleTimeoutMs(params.timeoutMs))
        ? ok(params)
        : fail("invalid schedule.runJobNow params", { method });
    case "schedule.listRuns":
      return exactObject(params, [], ["jobId", "limit"]) &&
        (params.jobId === undefined || params.jobId === null || isNonEmptyString(params.jobId)) &&
        (params.limit === undefined || isScheduleLimit(params.limit))
        ? ok(params)
        : fail("invalid schedule.listRuns params", { method });
    case "schedule.getRunTranscript":
      return exactObject(params, ["runId"]) &&
        isNonEmptyString(params.runId) &&
        params.runId.length <= 64
        ? ok(params)
        : fail("invalid schedule.getRunTranscript params", { method });
    case "schedule.replyToRun":
      return exactObject(params, ["runId", "text"]) &&
        isNonEmptyString(params.runId) &&
        params.runId.length <= 64 &&
        isNonEmptyString(params.text) &&
        params.text.trim().length > 0 &&
        params.text.length <= 20_000
        ? ok(params)
        : fail("invalid schedule.replyToRun params", { method });
    case "schedule.validateCron":
      return exactObject(params, ["cron"], ["timezone"]) &&
        isNonEmptyString(params.cron) &&
        params.cron.length <= 100 &&
        (params.timezone === undefined ||
          (typeof params.timezone === "string" && params.timezone.length <= 64))
        ? ok(params)
        : fail("invalid schedule.validateCron params", { method });
    case "schedule.listNotifications":
      return exactObject(params, [], ["limit"]) &&
        (params.limit === undefined || isScheduleLimit(params.limit))
        ? ok(params)
        : fail("invalid schedule.listNotifications params", { method });
    case "schedule.agentStart":
      return exactObject(params, ["cwd", "requirement"], ["model", "job"]) &&
        isNonEmptyString(params.cwd) &&
        params.cwd.length <= 1_024 &&
        isNonEmptyString(params.requirement) &&
        params.requirement.trim().length > 0 &&
        params.requirement.length <= 20_000 &&
        (params.model === undefined || params.model === null || isScheduleModelRef(params.model)) &&
        (params.job === undefined || params.job === null || isScheduleAgentEditJob(params.job))
        ? ok(params)
        : fail("invalid schedule.agentStart params", { method });
    case "schedule.agentList":
      return params === null ? ok(params) : fail("invalid schedule.agentList params", { method });
    case "schedule.agentSend":
      return exactObject(params, ["sessionId", "text"]) &&
        isNonEmptyString(params.sessionId) &&
        params.sessionId.length <= 128 &&
        isNonEmptyString(params.text) &&
        params.text.trim().length > 0 &&
        params.text.length <= 20_000
        ? ok(params)
        : fail("invalid schedule.agentSend params", { method });
    case "schedule.agentContinue":
      return exactObject(params, ["sessionPath", "cwd", "text"]) &&
        isNonEmptyString(params.sessionPath) &&
        params.sessionPath.length <= 1_024 &&
        isNonEmptyString(params.cwd) &&
        params.cwd.length <= 1_024 &&
        isNonEmptyString(params.text) &&
        params.text.trim().length > 0 &&
        params.text.length <= 20_000
        ? ok(params)
        : fail("invalid schedule.agentContinue params", { method });
    case "schedule.agentState":
      return exactObject(params, ["sessionId"]) &&
        isNonEmptyString(params.sessionId) &&
        params.sessionId.length <= 128
        ? ok(params)
        : fail("invalid schedule.agentState params", { method });
    case "schedule.agentTranscript":
      return exactObject(params, ["sessionPath"]) &&
        isNonEmptyString(params.sessionPath) &&
        params.sessionPath.length <= 1_024
        ? ok(params)
        : fail("invalid schedule.agentTranscript params", { method });
    case "schedule.agentAbort":
      return exactObject(params, ["sessionId"]) &&
        isNonEmptyString(params.sessionId) &&
        params.sessionId.length <= 128
        ? ok(params)
        : fail("invalid schedule.agentAbort params", { method });
    case "schedule.agentDelete":
      return exactObject(params, ["sessionPath"]) &&
        isNonEmptyString(params.sessionPath) &&
        params.sessionPath.length <= 1_024
        ? ok(params)
        : fail("invalid schedule.agentDelete params", { method });
    case "memo.list":
      return params === null ? ok(null) : fail("params must be null", { method });
    case "memo.create":
      return exactObject(
        params,
        ["type", "title", "contentMd"],
        ["tags", "workspaceHint", "images"],
      ) &&
        isMemoNoteType(params.type) &&
        isNonEmptyString(params.title) &&
        params.title.length <= 300 &&
        isString(params.contentMd) &&
        params.contentMd.length <= 200_000 &&
        (params.tags === undefined ||
          (isStringArray(params.tags) &&
            params.tags.length <= 20 &&
            params.tags.every((tag) => tag.length <= 60))) &&
        (params.workspaceHint === undefined ||
          params.workspaceHint === null ||
          (isString(params.workspaceHint) && params.workspaceHint.length <= 300)) &&
        (params.images === undefined ||
          (Array.isArray(params.images) &&
            params.images.length <= 20 &&
            params.images.every(isMemoImageInput)))
        ? ok(params)
        : fail("invalid memo.create params", { method });
    case "memo.update":
      return exactObject(params, ["id", "patch"]) &&
        isNonEmptyString(params.id) &&
        params.id.length <= 128 &&
        exactObject(
          params.patch,
          [],
          [
            "type",
            "title",
            "contentMd",
            "status",
            "tags",
            "workspaceHint",
            "addImages",
            "removeImageIds",
          ],
        ) &&
        isMemoNoteFields(params.patch) &&
        (params.patch.addImages === undefined ||
          (Array.isArray(params.patch.addImages) &&
            params.patch.addImages.length <= 20 &&
            params.patch.addImages.every(isMemoImageInput))) &&
        (params.patch.removeImageIds === undefined ||
          (isStringArray(params.patch.removeImageIds) && params.patch.removeImageIds.length <= 20))
        ? ok(params)
        : fail("invalid memo.update params", { method });
    case "memo.delete":
      return exactObject(params, ["id"]) && isNonEmptyString(params.id) && params.id.length <= 128
        ? ok(params)
        : fail("invalid memo.delete params", { method });
    case "memo.readImage":
      return exactObject(params, ["noteId", "imageId"]) &&
        isNonEmptyString(params.noteId) &&
        params.noteId.length <= 128 &&
        isNonEmptyString(params.imageId) &&
        params.imageId.length <= 128
        ? ok(params)
        : fail("invalid memo.readImage params", { method });
    case "memo.getSyncConfig":
      return params === null ? ok(null) : fail("params must be null", { method });
    case "memo.setSyncConfig":
    case "memo.testSync":
      return exactObject(params, ["settings"]) && isMemoSyncConfigInput(params.settings)
        ? ok(params)
        : fail("invalid memo sync settings params", { method });
    case "memo.syncNow":
      return params === null ? ok(null) : fail("params must be null", { method });
    default:
      // Exhaustiveness guard: adding a HostMethod without a params validator
      // is a compile error here, not a silently-undefined result at runtime.
      return assertNeverMethod(method);
  }
}

function assertNeverMethod(method: never): never {
  throw new Error(`No params validator registered for method: ${String(method)}`);
}

export type ParsedHostRequest = {
  [M in HostMethod]: {
    protocolVersion: 1;
    id: string;
    method: M;
    context: HostContextMap[M];
    params: HostRequestParams[M];
  };
}[HostMethod];

export function parseHostRequest(raw: unknown): ValidationResult<ParsedHostRequest> {
  if (!exactObject(raw, ["protocolVersion", "id", "method", "context", "params"])) {
    return fail("request envelope has missing or unexpected fields");
  }
  if (raw.protocolVersion !== 1) return fail("protocolVersion must be 1");
  if (!isUuid(raw.id)) return fail("request id must be UUID");
  if (!isHostMethod(raw.method)) {
    return {
      ok: false,
      error: createHostError("UNSUPPORTED_METHOD", `Unknown method: ${String(raw.method)}`, {
        details: { method: String(raw.method) },
      }),
    };
  }
  const context = validateMethodContext(raw.method, raw.context);
  if (!context.ok) return context;
  const params = validateRequestParams(raw.method, raw.params);
  if (!params.ok) return params;
  return {
    ok: true,
    value: {
      protocolVersion: 1,
      id: raw.id,
      method: raw.method,
      context: context.value,
      params: params.value,
    } as ParsedHostRequest,
  };
}

export type HostResponseMessage = HostResponseEnvelope;
export type HostEventMessage = HostEventEnvelope;

const identityKeys = [
  "hostInstanceId",
  "workspaceId",
  "workspaceRevision",
  "sessionId",
  "sessionRevision",
  "packageRevision",
] as const;

function hasHostIdentity(value: Record<string, unknown>): boolean {
  return (
    isUuid(value.hostInstanceId) &&
    (value.workspaceId === null || isUuid(value.workspaceId)) &&
    isSafeRevision(value.workspaceRevision) &&
    (value.sessionId === null || isUuid(value.sessionId)) &&
    isSafeRevision(value.sessionRevision) &&
    isSafeRevision(value.packageRevision)
  );
}

export function isHostResponse(value: unknown): value is HostResponseMessage {
  if (
    !isPlainObject(value) ||
    value.protocolVersion !== 1 ||
    !isUuid(value.id) ||
    !isHostMethod(value.method)
  ) {
    return false;
  }
  if (!hasHostIdentity(value) || typeof value.ok !== "boolean") return false;
  if (value.ok) {
    if (
      !hasExactKeys(value, ["protocolVersion", ...identityKeys, "id", "method", "ok", "result"])
    ) {
      return false;
    }
    return validateMethodResultShape(value.method, value.result) === null;
  }
  if (!hasExactKeys(value, ["protocolVersion", ...identityKeys, "id", "method", "ok", "error"])) {
    return false;
  }
  return isHostErrorRecord(value.error);
}

export function isHostEvent(value: unknown): value is HostEventMessage {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "protocolVersion",
      ...identityKeys,
      "event",
      "sequence",
      "timestamp",
      "payload",
    ]) ||
    value.protocolVersion !== 1 ||
    !isHostEventName(value.event) ||
    !hasHostIdentity(value) ||
    !isSafeRevision(value.sequence) ||
    value.sequence < 1 ||
    typeof value.timestamp !== "number" ||
    !Number.isFinite(value.timestamp) ||
    value.timestamp < 0
  ) {
    return false;
  }
  return validateEventPayloadShape(value.event, value.payload) === null;
}

export function validateSuccessResult(
  method: HostMethod,
  result: unknown,
): ValidationResult<unknown> {
  const error = validateMethodResultShape(method, result);
  return error ? fail(error, { method }) : { ok: true, value: result };
}

export function validateEventPayload(
  event: HostEventName,
  payload: unknown,
): ValidationResult<unknown> {
  const error = validateEventPayloadShape(event, payload);
  return error ? fail(error, { event }) : { ok: true, value: payload };
}

export function parseHostResponse(raw: unknown): ValidationResult<HostResponseMessage> {
  return isHostResponse(raw) ? { ok: true, value: raw } : fail("invalid Host response");
}

export function parseHostEvent(raw: unknown): ValidationResult<HostEventMessage> {
  return isHostEvent(raw) ? { ok: true, value: raw } : fail("invalid Host event");
}

export function validateSerializableAgentToolResult(value: unknown): ValidationResult<{
  content: unknown[];
  details: JsonValue;
  addedToolNames?: string[];
  terminate?: boolean;
}> {
  if (!exactObject(value, ["content", "details"], ["addedToolNames", "terminate"])) {
    return fail("tool result has missing or unexpected fields");
  }
  if (!Array.isArray(value.content) || !value.content.every(isSerializableAgentContent)) {
    return fail("content must contain valid agent content parts");
  }
  if (!isJsonValue(value.details)) return fail("details must be JSON-serializable");
  if (value.addedToolNames !== undefined && !isStringArray(value.addedToolNames)) {
    return fail("addedToolNames must be string[]");
  }
  if (value.terminate !== undefined && !isBoolean(value.terminate)) {
    return fail("terminate must be boolean");
  }
  return {
    ok: true,
    value: {
      content: value.content,
      details: value.details,
      ...(value.addedToolNames !== undefined ? { addedToolNames: value.addedToolNames } : {}),
      ...(value.terminate !== undefined ? { terminate: value.terminate } : {}),
    },
  };
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isPlainObject(value) && Object.values(value).every(isJsonValue);
}

export function toJsonValue(value: unknown, seen = new WeakSet<object>()): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    if (typeof value === "number" && !Number.isFinite(value)) return String(value);
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return `[${typeof value}]`;
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return { type: "Buffer", length: value.length, base64: value.toString("base64") };
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return value.map((item) => toJsonValue(item, seen));
  }
  if (typeof value === "object") {
    if (seen.has(value as object)) return "[Circular]";
    seen.add(value as object);
    const output: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      // Omit undefined-valued keys like JSON.stringify does, so live objects
      // serialize identically to their persisted round-trip. Mapping them to
      // null instead breaks strict payload validators (e.g. message usage).
      if (item === undefined) continue;
      output[key] = toJsonValue(item, seen);
    }
    return output;
  }
  return String(value);
}

// Narrow helpers exported for focused tests and Host outbound checks.
export const protocolDto = {
  isHostStatusSnapshot,
  isWorkspaceSnapshot,
  isSessionSnapshot,
  isToolSnapshot,
  isPackageSnapshot,
};
