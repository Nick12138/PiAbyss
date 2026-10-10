/**
 * 备忘录协议 handler（memo.* 方法）。
 *
 * v1 纯本地：所有操作直接落在 MemoStore（`<agentDir>/piabyss/memo/`）。
 * v2 云同步：由 piabyss-memo 插件自持的 R2 同步引擎处理，本文件只做两件事：
 *   - memo.getSyncConfig / memo.testSync / memo.syncNow 代理到插件进程内的
 *     环回控制面（memo-sync-api.ts，端口 127.0.0.1:18768）；密钥不进协议层；
 *   - memo.create / update / delete 落盘后经 /api/auto-sync 通知插件引擎
 *     防抖同步（autoSync 开启时生效）。
 * 参数校验在这里做一层，保证桌面端传入的载荷形状可信后再进存储层。
 */
import type { MethodHandler } from "./server.js";
import { createHostError, type HostError, type MemoSyncSettings } from "@piabyss/protocol";
import { completeSimple, type Context, type Model } from "@earendil-works/pi-ai/compat";
import { ModelRegistry, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getMemoStore, type MemoCreateInput, type MemoUpdatePatch } from "./memo-store.js";
import {
  fetchMemoSyncStatus,
  pokeMemoAutoSync,
  runMemoSyncNow,
  testMemoSyncConnection,
  type MemoSyncApiOutcome,
} from "./memo-sync-api.js";
import { isRepoPluginEnabled, MEMO_PLUGIN_ENTRY_FILE } from "./plugin-gate.js";

/** Error returned for every memo.* call while the piabyss-memo plugin is off. */
function memoPluginDisabledError() {
  return createHostError(
    "RESOURCE_NOT_FOUND",
    "The memo plugin (piabyss-memo) is disabled. Enable it in the plugin library to use the memo page.",
  );
}

/** 控制面不可达（插件未加载/控制面未启动）时的可读错误。 */
function mapMemoSyncHttpError(outcome: { status: number | null; error: string }): HostError {
  if (outcome.status === null) {
    return createHostError(
      "CATALOG_UNAVAILABLE",
      `备忘录同步插件不可用（piabyss-memo 控制面未启动或端口被占用）：${outcome.error}`,
      { retryable: true },
    );
  }
  switch (outcome.status) {
    case 400:
      return createHostError("INVALID_REQUEST", outcome.error);
    case 401:
      return createHostError("AUTH_REQUIRED", `备忘录同步控制面鉴权失败：${outcome.error}`);
    case 404:
      return createHostError("RESOURCE_NOT_FOUND", outcome.error);
    case 409:
      // 未配置 / 已有同步在进行中：可读的冲突语义。
      return createHostError("INVALID_REQUEST", outcome.error, { retryable: true });
    default:
      return createHostError(
        "INTERNAL_ERROR",
        `备忘录同步控制面错误（HTTP ${outcome.status}）：${outcome.error}`,
      );
  }
}

function expectMemoSyncOk<T>(outcome: MemoSyncApiOutcome<T>): { result: T } | { error: HostError } {
  if (outcome.ok) return { result: outcome.data };
  return { error: mapMemoSyncHttpError(outcome) };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

function asImageInputs(value: unknown): MemoCreateInput["images"] {
  if (!Array.isArray(value)) return undefined;
  const images: NonNullable<MemoCreateInput["images"]> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    if (typeof raw.dataBase64 !== "string") continue;
    images.push({
      fileName: asString(raw.fileName),
      mediaType: asString(raw.mediaType),
      dataBase64: raw.dataBase64,
    });
  }
  return images;
}

const VALID_MEMO_TYPES = new Set(["memo", "idea", "task"]);

/** 截断文本用于日志，避免刷屏。 */
function truncateForLog(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…(共 ${text.length} 字符)` : text;
}

function parseJsonLoose(text: string): Record<string, unknown> | null {
  // 1) 剥离可能包裹首尾的 Markdown 代码围栏后直接解析。
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(stripped) as Record<string, unknown>;
  } catch {
    // 忽略，进入下一级提取。
  }
  // 2) JSON 前后可能带有说明文字：提取首个 { 到最后一个 } 的子串。
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      // 忽略，交由调用方降级处理。
    }
  }
  return null;
}

/**
 * 解析模型输出。多级降级：围栏剥离 → 大括号提取 → 把纯散文输出当作
 * 整理后的正文直接返回（避免模型偶发无视 JSON 约束时整体报错）。
 * 返回 null 表示完全无法使用（如空输出）。
 */
function parseOptimizeResult(
  text: string,
  fallbackType: string,
): { contentMd: string; type: string; workspaceId: string | null } | null {
  const body = text.trim();
  if (!body) return null;
  const parsed = parseJsonLoose(body);
  if (
    parsed &&
    typeof parsed.contentMd === "string" &&
    parsed.contentMd.trim() &&
    VALID_MEMO_TYPES.has(String(parsed.type))
  ) {
    return {
      contentMd: parsed.contentMd,
      type: String(parsed.type),
      workspaceId:
        typeof parsed.workspaceId === "string" && parsed.workspaceId ? parsed.workspaceId : null,
    };
  }
  // 降级：模型输出不是合法 JSON（如纯散文/Markdown），将其视为整理后的正文，
  // 类别沿用请求中的原值，工作区保持不变。正文长度上限与正常路径一致。
  if (body.length > 200_000) return null;
  const type = VALID_MEMO_TYPES.has(fallbackType) ? fallbackType : "memo";
  return { contentMd: body, type, workspaceId: null };
}

export function createMemoHandlers(
  agentDir: string,
  modelRuntime?: ModelRuntime,
  modelRegistry?: ModelRegistry,
): Partial<Record<string, MethodHandler>> {
  const store = getMemoStore(agentDir);
  // 启动后的首次同步由插件引擎自己做（autoSync 开启且已配置时）；
  // Host 侧不再持有同步引擎。

  // The memo page's backend lives in the Host (memo.* handlers), but the
  // feature is owned by the piabyss-memo plugin: gate every method on the
  // plugin's user-level enablement so the plugin-library switch controls both
  // the agent tool and this page. Checked per call — toggling in the plugin
  // library takes effect without a Host restart.
  const gate = (): boolean => isRepoPluginEnabled(agentDir, MEMO_PLUGIN_ENTRY_FILE);

  return {
    "memo.list": async () => {
      if (!gate()) return { error: memoPluginDisabledError() };
      return { result: { notes: store.list() } };
    },

    "memo.optimize": async (ctx) => {
      if (!gate()) return { error: memoPluginDisabledError() };
      if (!modelRuntime || !modelRegistry) {
        return { error: createHostError("AGENT_NOT_READY", "AI model runtime is unavailable") };
      }
      try {
        const input = ctx.params as {
          contentMd: string;
          type: string;
          workspaceHint: string | null;
          workspaces: Array<{ id: string; name: string }>;
        };
        const settings = SettingsManager.create(process.cwd(), agentDir, { projectTrusted: false });
        const available = await modelRuntime.getAvailable();
        const provider = settings.getDefaultProvider();
        const modelId = settings.getDefaultModel();
        const model =
          (provider && modelId
            ? available.find((entry) => entry.provider === provider && entry.id === modelId)
            : undefined) ?? available[0];
        if (!model) return { error: createHostError("AGENT_NOT_READY", "No available AI model") };
        const auth = await modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok) return { error: createHostError("AUTH_REQUIRED", auth.error) };
        const context: Context = {
          systemPrompt: [
            "你是 PiAbyss 的开发备忘录整理助手。",
            "你不是普通的文字润色器，也不是客服提示语生成器。你的首要任务是识别用户真正想记录、解决或推进的问题，并将零散内容整理成准确、清晰、可执行、便于后续继续处理的开发备忘录。",
            "输入数据包含 contentMd（当前正文）、type（当前类别）、workspaceHint（当前工作区提示）和 workspaces（可选工作区列表）。请在内部完成判断，不要输出分析过程。",
            "如果正文包含失败、报错、异常、崩溃、无法、不工作、bug、修复等词，或包含错误信息、日志、堆栈、接口错误、运行时状态，并且表达了现有功能不符合预期，应将其识别为 Bug 或待修复问题。",
            "Bug、错误和需要修复的现有问题优先选择 type=task；明确的功能建议但尚未决定实施优先选择 type=idea；纯记录、说明或参考信息选择 type=memo。当前 type 只是参考，不是必须保留的值。",
            "对于错误信息、日志、异常和技术标识，不要默认改写成用户界面提示语。除非正文明确要求生成用户提示语或面向用户的文案，否则必须保留原始错误文本、错误码、方法名、变量名、接口名和其他关键技术信息。",
            "原始错误文本应尽量原样保留，可以放在 Markdown 的 text 代码块中。可以调整上下文、标题和结构，但不能删除导致问题定位所需的技术信息。",
            "不要凭空断言根因、修复方案、复现步骤、影响范围或修复已经完成。信息不足时，将未知内容标记为待确认，而不是编造事实。可以提出少量有助于推进问题的待确认事项，但不要为了增加内容而填充无关问题。",
            "对于 Bug 或任务，优先整理出问题现象、原始错误或已知信息、期望目标、待确认事项和下一步；只添加确实有依据的部分。对于功能需求，可以整理出需求目标、期望行为、相关约束和待确认事项。对于普通备忘或想法，只做必要的结构化和表达优化，不要强行改成任务。",
            "备忘录没有独立标题字段，正文的第一个非空行就是标题。优化后的 contentMd 必须以一行简洁明确的标题开头，标题后空一行，再开始正文。Bug 标题应描述需要解决的问题，例如“修复备忘录加载失败：Host 未就绪”，不要写成“备忘录加载失败，请稍后重试”这类客服提示语。",
            "保留正文中已有的有效 #标签。只有在内容意图非常明确时，才添加少量有帮助的标签；Bug 可以考虑添加 #bug，功能需求可以考虑添加 #feature，不要添加无法从正文判断的标签。标签必须写在正文中，不能通过额外字段返回。",
            "工作区只能从 workspaces 列表中选择，不能编造工作区 id 或名称。如果当前 workspaceHint 已对应某个候选工作区，且没有明确理由更换，应保持当前工作区。只有在正文内容明显与某个候选工作区相关且可以可靠判断时，才返回新的 workspaceId；无法判断时 workspaceId 必须返回 null，表示保持当前工作区不变。",
            "可以自由调整正文结构、措辞、标题、类别和标签，但必须保留用户原本的事实、问题意图和重要技术信息。不要把待修复的问题误写成已经解决的问题，不要把技术 Bug 自动改写成面向最终用户的说明文案。",
            "不要解释你做了哪些修改，不要输出 Markdown 代码围栏，不要输出 JSON 之外的任何文字。",
            '最终只返回一个合法 JSON 对象，字段必须且只能是 {"contentMd":"优化后的 Markdown 正文","type":"memo"|"idea"|"task","workspaceId":"候选工作区 id"|null}。',
          ].join(" "),
          messages: [
            {
              role: "user",
              timestamp: Date.now(),
              content: [
                "以下 JSON 是待整理的备忘录数据，请阅读后严格按系统要求返回整理结果 JSON，不要复述或续写正文内容：",
                JSON.stringify(input),
              ].join("\n"),
            },
          ],
        };
        const response = await completeSimple(model as Model<any>, context, {
          apiKey: auth.apiKey,
          headers: auth.headers,
          env: auth.env,
          maxTokens: 4_000,
          timeoutMs: 60_000,
          maxRetries: 0,
        });
        if (response.stopReason === "error" || response.stopReason === "aborted") {
          return {
            error: createHostError(
              "INTERNAL_ERROR",
              response.errorMessage ?? "AI optimization failed",
            ),
          };
        }
        const text = response.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
          .trim();
        const parsedResult = parseOptimizeResult(text, input.type);
        if (!parsedResult) {
          console.error(`[memo.optimize] AI returned unusable output: ${truncateForLog(text)}`);
          return { error: createHostError("INVALID_REQUEST", "AI returned unusable output") };
        }
        if (!parsedResult.contentMd.trim() || parsedResult.contentMd.length > 200_000) {
          console.error(`[memo.optimize] AI returned invalid memo fields: ${truncateForLog(text)}`);
          return { error: createHostError("INVALID_REQUEST", "AI returned invalid memo fields") };
        }
        const workspaceId =
          typeof parsedResult.workspaceId === "string" &&
          input.workspaces.some((entry) => entry.id === parsedResult.workspaceId)
            ? parsedResult.workspaceId
            : null;
        return {
          result: {
            contentMd: parsedResult.contentMd,
            type: parsedResult.type,
            workspaceId,
          },
        };
      } catch (error) {
        return {
          error: createHostError(
            "INTERNAL_ERROR",
            error instanceof Error ? error.message : String(error),
          ),
        };
      }
    },

    "memo.create": async (ctx) => {
      if (!gate()) return { error: memoPluginDisabledError() };
      const params = ctx.params as Record<string, unknown>;
      const input: MemoCreateInput = {
        type: asString(params.type) as MemoCreateInput["type"],
        title: asString(params.title),
        contentMd: asString(params.contentMd),
        tags: asStringArray(params.tags),
        workspaceHint:
          params.workspaceHint === undefined ? undefined : (params.workspaceHint as string | null),
        images: asImageInputs(params.images),
      };
      const note = store.create(input);
      // 通知插件内同步引擎：autoSync 开启时防抖同步（控制面不可达时静默）。
      pokeMemoAutoSync(agentDir);
      return { result: { note } };
    },
    "memo.update": async (ctx) => {
      if (!gate()) return { error: memoPluginDisabledError() };
      const params = ctx.params as Record<string, unknown>;
      const id = asString(params.id);
      const rawPatch = (params.patch ?? {}) as Record<string, unknown>;
      const patch: MemoUpdatePatch = {};
      if (rawPatch.type !== undefined)
        patch.type = asString(rawPatch.type) as MemoUpdatePatch["type"];
      if (rawPatch.title !== undefined) patch.title = asString(rawPatch.title);
      if (rawPatch.contentMd !== undefined) patch.contentMd = asString(rawPatch.contentMd);
      if (rawPatch.status !== undefined) {
        patch.status = asString(rawPatch.status) as MemoUpdatePatch["status"];
      }
      if (rawPatch.sessionId !== undefined) {
        patch.sessionId = rawPatch.sessionId === null ? null : asString(rawPatch.sessionId);
      }
      if (rawPatch.tags !== undefined) patch.tags = asStringArray(rawPatch.tags);
      if (rawPatch.workspaceHint !== undefined) {
        patch.workspaceHint = rawPatch.workspaceHint as string | null;
      }
      if (rawPatch.addImages !== undefined) patch.addImages = asImageInputs(rawPatch.addImages);
      if (Array.isArray(rawPatch.removeImageIds)) {
        patch.removeImageIds = rawPatch.removeImageIds.filter(
          (entry): entry is string => typeof entry === "string",
        );
      }
      if (rawPatch.clearResult !== undefined) patch.clearResult = rawPatch.clearResult === true;
      const note = store.update(id, patch);
      pokeMemoAutoSync(agentDir);
      return { result: { note } };
    },

    "memo.delete": async (ctx) => {
      if (!gate()) return { error: memoPluginDisabledError() };
      const params = ctx.params as Record<string, unknown>;
      store.remove(asString(params.id));
      pokeMemoAutoSync(agentDir);
      return { result: { ok: true } };
    },

    "memo.readImage": async (ctx) => {
      if (!gate()) return { error: memoPluginDisabledError() };
      const params = ctx.params as Record<string, unknown>;
      return {
        result: store.readImage(asString(params.noteId), asString(params.imageId)),
      };
    },

    // 草稿仅本地持久化（不参与云同步，也不触发 autoSync）。
    "memo.getDraft": async () => {
      if (!gate()) return { error: memoPluginDisabledError() };
      return { result: { draft: store.getDraft() } };
    },

    "memo.setDraft": async (ctx) => {
      if (!gate()) return { error: memoPluginDisabledError() };
      const params = ctx.params as {
        draft: { type: unknown; contentMd: unknown; workspaceHint?: unknown };
      };
      const draft = store.saveDraft({
        type: asString(params.draft.type) as MemoCreateInput["type"],
        contentMd: asString(params.draft.contentMd),
        workspaceHint:
          params.draft.workspaceHint === undefined
            ? undefined
            : (params.draft.workspaceHint as string | null),
      });
      return { result: { draft } };
    },

    "memo.clearDraft": async () => {
      if (!gate()) return { error: memoPluginDisabledError() };
      store.clearDraft();
      return { result: { ok: true } };
    },

    // v2 云同步：引擎由 piabyss-memo 插件自持，下面三个方法代理到插件的
    // 环回控制面；密钥与 autoSync 配置在「设置 → 插件 → PiAbyss 备忘录」。
    "memo.getSyncConfig": async () => {
      if (!gate()) return { error: memoPluginDisabledError() };
      const outcome = await fetchMemoSyncStatus(agentDir);
      const mapped = expectMemoSyncOk(outcome);
      if ("error" in mapped) return mapped;
      const settings: MemoSyncSettings = {
        accountId: typeof mapped.result.accountId === "string" ? mapped.result.accountId : "",
        bucket: typeof mapped.result.bucket === "string" ? mapped.result.bucket : "",
        configured: mapped.result.configured === true,
        autoSync: mapped.result.autoSync === true,
        lastSyncAt: typeof mapped.result.lastSyncAt === "number" ? mapped.result.lastSyncAt : null,
        lastSyncOk: typeof mapped.result.lastSyncOk === "boolean" ? mapped.result.lastSyncOk : null,
        lastSyncError:
          typeof mapped.result.lastSyncError === "string" ? mapped.result.lastSyncError : null,
      };
      return { result: { settings } };
    },

    "memo.testSync": async () => {
      if (!gate()) return { error: memoPluginDisabledError() };
      const outcome = await testMemoSyncConnection(agentDir);
      const mapped = expectMemoSyncOk(outcome);
      if ("error" in mapped) return mapped;
      return {
        result: {
          ok: mapped.result.ok === true,
          error: typeof mapped.result.error === "string" ? mapped.result.error : null,
        },
      };
    },

    "memo.syncNow": async () => {
      if (!gate()) return { error: memoPluginDisabledError() };
      const outcome = await runMemoSyncNow(agentDir);
      const mapped = expectMemoSyncOk(outcome);
      if ("error" in mapped) return mapped;
      return { result: mapped.result };
    },
  };
}
