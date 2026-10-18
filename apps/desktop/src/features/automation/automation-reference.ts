/**
 * 「让精灵改这条自动化」——照备忘录那条路走：注入一张 `@自动化 · 名称` 引用胶囊。
 *
 * 输入框里只有短标签，配置正文与要求被折在 payload 里、发送那一刻才展开进消息。
 * 这么做不只是好看：`<piabyss-ref>` / `<automation-job>` 都在注入块的剥离名单里
 * （`protocol/attachment-references.ts`），所以会话标题、搜索索引、队列行与复制
 * 按钮都不会看见这一大坨 JSON；而模型照样逐字读到。
 *
 * 新建计划不走这里——引用不出任何对象，做成胶囊是硬凑，直接用文本模板更诚实。
 */
import type { AutomationJob } from "@piabyss/protocol";
import { draftKeyForTarget, type DraftReference, type DraftTarget } from "../../lib/draft-target";
import { setDraftReferencesPersisted } from "../../lib/draft-persistence";
import { buildInjectedReferenceEnvelope } from "../chat/injected-references";
import { useAppStore } from "../../lib/stores/app-store";
import { tCurrent } from "../../lib/i18n/use-t";

/**
 * 这条自动化任务的现状。形状与插件的 AI 优化路径同源（id 既挂在标签上也写进体内），
 * `jobId` 一并给出：草案卡据此走 update 而不是又建一条重复的。
 */
function automationJobBlock(job: AutomationJob): string {
  const payload = {
    id: job.id,
    jobId: job.id,
    name: job.name,
    kind: job.command ? "command" : "prompt",
    prompt: job.prompt,
    command: job.command,
    cwd: job.cwd,
    trigger: job.trigger,
    permission: job.permission,
    model: job.model,
    missedWindow: job.missedWindow,
    timeoutMs: job.timeoutMs,
    maxRuns: job.maxRuns,
    tags: job.tags,
    notify: job.notify,
    enabled: job.enabled,
    loadExtensions: job.loadExtensions,
    // 已经跑过几次、有没有被判死：她谈改动时绕不开这两项（改 maxRuns、
    // 一次性任务要不要改期重开），不给就只能靠她再去 get 一次。
    runCount: job.runCount,
    terminated: job.terminated,
  };
  return `<automation-job id="${job.id}">\n${JSON.stringify(payload, null, 2)}\n</automation-job>`;
}

/** 引用胶囊的完整正文：现状 + 这一步要怎么谈。 */
export function composeAutomationJobPayload(job: AutomationJob): string {
  return [
    automationJobBlock(job),
    "",
    tCurrent("automationJobReferencePrompt", { name: job.name, id: job.id }),
  ].join("\n");
}

export function injectAutomationJobReference(target: DraftTarget, job: AutomationJob): void {
  const state = useAppStore.getState();
  const key = draftKeyForTarget(target);
  const reference: DraftReference = {
    id: `automation:${job.id}`,
    kind: "automation",
    label: job.name,
    payload: buildInjectedReferenceEnvelope({
      kind: "automation-job",
      title: job.name,
      body: composeAutomationJobPayload(job),
    }),
  };
  const existing = state.draftReferences[key] ?? [];
  setDraftReferencesPersisted(target, [
    ...existing.filter((item) => item.id !== reference.id),
    reference,
  ]);
}
