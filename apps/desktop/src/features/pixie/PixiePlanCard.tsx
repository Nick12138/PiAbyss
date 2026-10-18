/**
 * 小精灵转写里的**自动化草案卡**。
 *
 * ## 为什么确认在这里，而不是在她手里
 *
 * `pi-automation` 给 agent 注册了 `automation` 工具，`create/update/run_now` 全都能直接写。
 * 计划是**无人值守**的重复执行，所以写这一笔必须由人点头：卡片是唯一落库入口，
 * 提示词那头也已经约束她只能读（见 `pixie-agent-runner` 的 `<pixie-context>`）。
 * 她真调了写工具也只是多一条看得见的工具调用记录，不改这个口径。
 *
 * ## 四态从哪来
 *
 * 状态**不记在 localStorage**，而是从会话里的回执倒推（`automation-plan-receipt`
 * 自定义消息）：换段、重开会话、重启之后状态照样对，而且小精灵自己在对话里也读得到
 * 「这条草案后来建了哪个计划」。同一份草案只可能有一条回执（按 `planKey` 认）。
 * 「被取代」= 会话里更晚还有一份草案，老的待确认卡片就该失效而不是留着能点。
 */
import { useCallback, useMemo, useState } from "react";
import { AlertTriangle, Ban, Check, Pencil } from "lucide-react";
import type { AutomationJob } from "@piabyss/protocol";
import type { TranscriptBlock } from "../chat/transcript-model";
import { useT } from "../../lib/i18n/use-t";
import type { Translate } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { activeSessionContext, hostContext } from "../../lib/bridge/host-context";
import {
  PLAN_RECEIPT_CUSTOM_TYPE,
  extractPlanFences,
  parsePlanReceipt,
  type PlanReceipt,
} from "../automation/automation-plan-fence";
import {
  formToJobInput,
  planToForm,
  automationPlanMissingFields,
  automationPlanPreviewRows,
  type AutomationFormState,
} from "../automation/automation-model";
import { AutomationJobDialog } from "../automation/AutomationJobDialog";

const WRITE_TIMEOUT_MS = 20_000;

type PlanBlock = Extract<TranscriptBlock, { kind: "plan" }>;

type CardState =
  { kind: "pending" } | { kind: "superseded" } | { kind: "decided"; receipt: PlanReceipt };

/** store 里的消息带的是 `content`（字符串或块数组），不是拍平的 `text`。 */
function messageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const block = part as Record<string, unknown>;
        return block.type === "text" && typeof block.text === "string" ? block.text : "";
      })
      .join("");
  }
  return typeof message.text === "string" ? message.text : "";
}

/** 会话里所有回执 + 「这是不是最后一份草案」。一次遍历，卡片各自查表。 */
function usePlanCardState(key: string): CardState {
  const messages = useAppStore((s) => s.session?.messages);
  return useMemo<CardState>(() => {
    const list = messages ?? [];
    const receipts = new Map<string, PlanReceipt>();
    let lastPlanKey = "";
    for (let index = 0; index < list.length; index += 1) {
      const message = list[index] as unknown as Record<string, unknown>;
      const role = typeof message.role === "string" ? message.role : "";
      if (role === "custom") {
        if (message.customType === PLAN_RECEIPT_CUSTOM_TYPE) {
          const receipt = parsePlanReceipt(message.details);
          if (receipt) receipts.set(receipt.planKey, receipt);
        }
        continue;
      }
      if (role !== "assistant") continue;
      const fenceCount = extractPlanFences(messageText(message)).length;
      for (let ordinal = 1; ordinal <= fenceCount; ordinal += 1) {
        lastPlanKey = `${index}:${ordinal}`;
      }
    }
    const receipt = receipts.get(key);
    if (receipt) return { kind: "decided", receipt };
    // key 里的消息序号是会话里的绝对序号；比它晚还有草案就说明这份被取代了。
    const mine = Number(key.split(":")[0]);
    const last = Number(lastPlanKey.split(":")[0] || "-1");
    if (Number.isFinite(mine) && Number.isFinite(last) && last > mine) {
      return { kind: "superseded" };
    }
    return { kind: "pending" };
  }, [messages, key]);
}

/** 写一条回执进当前会话（turn-free：她读得到，但她不会接着这条往下说）。 */
async function appendReceipt(receipt: PlanReceipt, text: string): Promise<void> {
  const state = useAppStore.getState();
  const { host, workspace, session } = state;
  if (!host || !workspace || !session) return;
  await hostClient.request(
    "session.appendCustomMessage",
    activeSessionContext(host, workspace, session),
    {
      customType: PLAN_RECEIPT_CUSTOM_TYPE,
      text,
      details: receipt as unknown as Record<string, unknown>,
    },
    WRITE_TIMEOUT_MS,
  );
}

/** 落库：有 jobId 走 update（保住执行历史），没有才 create。 */
async function writeJob(
  plan: NonNullable<PlanBlock["plan"]>,
  form: AutomationFormState,
  translate: Translate,
): Promise<AutomationJob> {
  const host = useAppStore.getState().host;
  if (!host) throw new Error(translate("pixiePlanNoHost"));
  const built = formToJobInput(form);
  if (!built.ok) throw new Error(translate(built.errorKey));
  const jobId = typeof plan.jobId === "string" && plan.jobId ? plan.jobId : null;
  const response = await hostClient.request(
    jobId ? "automation.updateJob" : "automation.createJob",
    hostContext(host),
    jobId ? { id: jobId, ...built.input } : built.input,
    WRITE_TIMEOUT_MS,
  );
  if (!response.ok) throw new Error(response.error?.message ?? "write failed");
  return response.result.job as AutomationJob;
}

export function PixiePlanCard({ block }: { block: PlanBlock }) {
  const t = useT();
  const state = usePlanCardState(block.key);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const plan = block.plan;

  const missing = useMemo(() => (plan ? automationPlanMissingFields(plan) : []), [plan]);
  const rows = useMemo(
    () => (plan ? automationPlanPreviewRows(plan, t, t("automationModelDefaultPlain")) : []),
    [plan, t],
  );

  const finish = useCallback(async (receipt: PlanReceipt, text: string) => {
    // 先落库再写回执：反过来的话，落库失败会留下一张「已创建」的假回执。
    useAppStore.getState().bumpAutomationRevision();
    await appendReceipt(receipt, text);
  }, []);

  /**
   * 落库 + 写回执。**「确定」按钮和「修改」弹窗保存共用这一条路**——
   * 两个入口不该各写一套落库口径（那样一边改了另一边就会悄悄不一致）。
   */
  const commit = useCallback(
    async (form: AutomationFormState, updating: boolean) => {
      if (!plan) return;
      setBusy(true);
      setError(null);
      try {
        const job = await writeJob(plan, form, t);
        await finish(
          {
            planKey: block.key,
            action: updating ? "updated" : "created",
            jobId: job.id,
            name: job.name,
          },
          updating
            ? t("pixiePlanReceiptUpdated", { name: job.name })
            : t("pixiePlanReceiptCreated", { name: job.name }),
        );
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [block.key, finish, plan, t],
  );

  const confirm = useCallback(async () => {
    if (!plan || busy || missing.length > 0) return;
    const cwd = useAppStore.getState().workspace?.canonicalCwd ?? "";
    await commit(planToForm(plan, cwd), Boolean(plan.jobId));
  }, [busy, commit, missing.length, plan]);

  const cancel = useCallback(async () => {
    if (!plan || busy) return;
    setBusy(true);
    setError(null);
    try {
      await finish(
        { planKey: block.key, action: "cancelled", jobId: plan.jobId ?? null },
        t("pixiePlanReceiptCancelled", { name: plan.name?.trim() || t("pixiePlanUntitled") }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [block.key, busy, finish, plan, t]);

  if (!plan) {
    // 读不动的草案也要露出来：静默吞掉的话，用户只会看到小精灵说了一句「配置如下」然后什么都没有。
    return (
      <div
        data-testid="pixie-plan-card-invalid"
        className="my-1 rounded-lg border border-warning/40 bg-warning/10 p-2.5"
      >
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-warning">
          <AlertTriangle size={12} aria-hidden="true" />
          {t("pixiePlanUnreadable")}
        </div>
        <details className="mt-1">
          <summary className="cursor-pointer text-[10px] text-muted">
            {t("pixiePlanUnreadableRaw")}
          </summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] text-muted">
            {block.raw}
          </pre>
        </details>
      </div>
    );
  }

  const decided = state.kind === "decided";
  const badge = decided
    ? state.receipt.action === "created"
      ? t("pixiePlanStateCreated")
      : state.receipt.action === "updated"
        ? t("pixiePlanStateUpdated")
        : t("pixiePlanStateCancelled")
    : state.kind === "superseded"
      ? t("pixiePlanStateSuperseded")
      : null;

  return (
    <div
      data-testid="pixie-plan-card"
      data-plan-key={block.key}
      data-state={decided ? state.receipt.action : state.kind}
      className={`my-1.5 rounded-lg border p-3 ${
        decided || state.kind === "superseded"
          ? "border-border/70 bg-surface/50 opacity-80"
          : "border-accent/50 bg-accent/5"
      }`}
    >
      <div className="flex items-baseline gap-2">
        <h4 className="min-w-0 flex-1 truncate text-[12px] font-semibold">
          {plan.name?.trim() || t("pixiePlanUntitled")}
        </h4>
        {badge ? (
          <span className="shrink-0 rounded bg-surface-overlay px-1.5 py-0.5 text-[10px] text-muted">
            {badge}
          </span>
        ) : null}
      </div>

      <dl className="mt-2 divide-y divide-border-subtle">
        {rows.map((row) => (
          <div key={row.label} className="flex gap-3 py-1">
            <dt className="w-24 shrink-0 text-[10px] text-muted">{t(row.label)}</dt>
            <dd className="min-w-0 flex-1 break-words text-[11px]">
              {row.value ?? <span className="text-warning">{t("pixiePlanFieldOpen")}</span>}
            </dd>
          </div>
        ))}
      </dl>

      {missing.length > 0 && !decided && state.kind !== "superseded" ? (
        <p className="mt-2 flex items-start gap-1.5 rounded bg-warning/10 px-2 py-1.5 text-[10px] text-warning">
          <AlertTriangle size={11} className="mt-0.5 shrink-0" aria-hidden="true" />
          {t("pixiePlanMissing", { fields: missing.map((key) => t(key)).join("、") })}
        </p>
      ) : null}

      {error ? <p className="mt-2 text-[10px] text-danger">{error}</p> : null}

      {!decided && state.kind !== "superseded" ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            data-testid="pixie-plan-confirm"
            disabled={busy || missing.length > 0}
            title={missing.length > 0 ? t("pixiePlanMissingHint") : undefined}
            className="flex h-7 items-center gap-1.5 rounded-md bg-accent px-2.5 text-[11px] font-medium text-accent-foreground transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => void confirm()}
          >
            <Check size={13} aria-hidden="true" />
            {plan.jobId ? t("pixiePlanConfirmUpdate") : t("pixiePlanConfirmCreate")}
          </button>
          <button
            type="button"
            data-testid="pixie-plan-edit"
            disabled={busy}
            className="flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-[11px] transition-colors hover:bg-surface-overlay disabled:opacity-40"
            onClick={() => setEditing(true)}
          >
            <Pencil size={12} aria-hidden="true" />
            {t("pixiePlanEdit")}
          </button>
          <button
            type="button"
            data-testid="pixie-plan-cancel"
            disabled={busy}
            className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[11px] text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:opacity-40"
            onClick={() => void cancel()}
          >
            <Ban size={12} aria-hidden="true" />
            {t("pixiePlanCancel")}
          </button>
        </div>
      ) : null}

      {editing && state.kind === "pending" ? (
        <AutomationJobDialog
          job={null}
          prefill={planToForm(plan, useAppStore.getState().workspace?.canonicalCwd ?? "")}
          onClose={() => setEditing(false)}
          onSaveDraft={(form) => {
            setEditing(false);
            void commit(form, Boolean(plan.jobId));
          }}
        />
      ) : null}
    </div>
  );
}
