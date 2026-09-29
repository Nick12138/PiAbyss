/**
 * 中转站字段映射的 Agent 交接：编辑模型服务页的机器人图标按钮把
 * 「探测该站点 → 生成映射表」任务交给默认工作区（DefaultProject）里的
 * Agent 处理。注入方式与备忘录「用 Agent 处理」一致：引用胶囊 + 发送时
 * 展开的提示词，任务书里带上 host 端提供的事实（映射路径 / baseUrl /
 * key 位置 / 现有映射），Agent 探测后直接写映射表文件。
 *
 * 用户核对（删除 enabled 字段或置 false 即回退内置默认）后，价格表刷新
 * 时按映射表解析，无需改任何源码。
 */
import type { RelayMappingHandoffResult } from "@piabyss/protocol";
import type { DraftReference } from "../../lib/draft-target";
import { buildInjectedReferenceEnvelope } from "../../features/chat/injected-references";

/** Provider 展示名（无法拿到时的回退是 stationId）。 */
export type RelayMappingHandoff = {
  stationId: string;
  providerName: string;
  handoff: RelayMappingHandoffResult;
};

/**
 * 组装发给 Agent 的任务书（中文为主，键名/路径保持原样）。
 * 要求 Agent：探测 API → 本地测试 → 写映射表文件 → 汇报字段结论。
 */
function composeRelayMappingPrompt(handoff: RelayMappingHandoff): string {
  const { stationId, providerName, handoff: info } = handoff;
  const attributes = [
    `stationId="${stationId}"`,
    ...(info.mapping ? [`hasExistingMapping="true"`] : []),
  ].join(" ");
  const mappingBlock = info.mapping
    ? [
        "## 现有映射表（更新它，保留仍正确的字段）",
        "```json",
        JSON.stringify(info.mapping, null, 2),
        "```",
      ].join("\n")
    : "尚无映射表 —— 全新生成。";
  const sections = [
    `<piabyss-relay-mapping ${attributes}>`,
    `# 任务：为中转站「${providerName}」（stationId: \`${stationId}\`）生成字段映射表`,
    "",
    "## 站点事实（由桌面端提供，直接可用）",
    `- Base URL：\`${info.baseUrl}\``,
    `- API Key：${info.hasApiKey ? `已配置，存于 \`${info.authJsonPath}\`（JSON，providers → ${stationId} → key；敏感信息不要写进回复）` : "未配置——只探测无需鉴权的接口，余额字段标记为无法获取"}`,
    `- 映射表写入路径（必须原样使用）：\`${info.mappingPath}\`${info.sharedWith.length ? `
- 同站镜像入口：provider ${info.sharedWith.join("、")} 指向同一站点（主域或地址相同）——写入映射表时加上 \`shareByBaseUrl\`（站点地址）与 \`shareScope: "domain"\`，它们会自动复用这张表，无需逐个映射` : ""}`,
    "",
    mappingBlock,
    "",
    "## 你要做的事",
    "1. 用 curl/fetch 探测该站点的公开接口（常见形态：new-api/one-api 系 `GET /api/pricing`、`GET /v1/models`、`GET /v1/dashboard/billing/subscription`、`GET /v1/dashboard/billing/usage`；veloera/其它系可能是 `GET /api/user/self`、`GET /api/user/models` 等）。有 key 的接口带上 Bearer 测试。",
    "2. 找出能取到以下本地标准字段的接口与字段路径：",
    "   - 分组倍率表（groups，groupName → 倍率）",
    "   - 分组描述（groupDescriptions，可选）",
    "   - 模型列表及每模型的：输入倍率（modelInputRatio）、输出倍率（modelCompletionRatio）、缓存倍率（modelCacheRatio）、按次价格（modelCallPrice）、按次标记（modelPerCallFlag）、可用分组（modelGroups）",
    "   - Key 可见模型列表（keyModels）",
    "   - 余额（balanceRemaining）与已用（balanceUsed），注意单位换算用 scale（如美分→美元 scale=0.01，quota→美元 scale=1/500000）",
    "3. 测试确认每个字段真的能取到数据；取不到的字段不要编造路径，直接省略（该功能对该站不可用）。",
    "4. 按「映射表格式」写出完整 JSON，写入上述映射表路径（UTF-8，2 空格缩进）。",
    "5. 回复：每个端点的探测结论（HTTP 状态 + 是否取到数据）、字段路径清单、无法获取的字段及原因。",
    "",
    "## 映射表格式",
    "```json",
    JSON.stringify(
      {
        schemaVersion: 1,
        stationId,
        shareByBaseUrl: "https://站点地址（同站镜像自动复用时填写）",
        shareScope: "domain",
        endpoints: {
          pricing: {
            path: "api/pricing 或实际路径（注意 URL 相对语义：baseUrl 带 /v1 时根路径需写 /api/pricing）",
            auth: false,
            fieldsApplyTo: "items（响应是模型记录数组时）/ root",
            itemsField: "models",
            itemsPath: "记录数组在响应内的位置：响应本体就是数组时省略；形如 {data:[...]} 时填 data",
            fields: {
              groups: { path: "group_ratio", reader: "entries" },
              groupDescriptions: { path: "usable_group", reader: "entries" },
              modelId: { path: "model_name" },
              modelInputRatio: { path: "model_ratio" },
              modelCompletionRatio: { path: "completion_ratio" },
              modelCacheRatio: { path: "cache_ratio" },
              modelCallPrice: { path: "model_price" },
              modelPerCallFlag: { path: "quota_type" },
              modelGroups: { path: "enable_groups", reader: "array" },
              modelEndpoints: { path: "supported_endpoint_types", reader: "array" },
            },
          },
          models: {
            path: "v1/models",
            auth: true,
            fields: { keyModels: { path: "data", reader: "array", itemField: "id" } },
          },
          balance: {
            path: "v1/dashboard/billing/subscription 或合并接口",
            auth: true,
            fields: {
              balanceRemaining: { path: "hard_limit_usd" },
              balanceUsed: { path: "total_usage", scale: 0.01 },
              balanceUnlimitedValue: { path: "$", fallback: 1000000 },
            },
          },
          usage: {
            path: "v1/dashboard/billing/usage（已用与余额分离时的独立端点）",
            auth: true,
            fields: { balanceUsed: { path: "total_usage", scale: 0.01 } },
          },
        },
      },
      null,
      2,
    ),
    "```",
    "",
    '字段规则：`path` 为端点路径，遵循 URL 相对语义 —— baseUrl 形如 `https://x.top/v1` 时，`api/pricing` 拼成 `/v1/api/pricing`，而 `/api/pricing`（以 / 开头）相对站点根拼成 `/api/pricing`；响应内字段路径相对响应根（items 模式下相对每条记录，记录数组位置用 itemsPath）。`reader`：entries=对象展开为键值对，array=取字符串数组（itemField 指定字段）；`scale` 乘法换算；`fallback` 缺失时的兜底；`path: "$"` 表示常量（配 fallback 用）。探测时若相对路径 404，先试站点根的 /api/... 变体。',
    "不要修改映射表路径、stationId 与 schemaVersion 以外的任何系统文件。",
    "</piabyss-relay-mapping>",
  ];
  return sections.join("\n");
}

/** 发送时的完整 payload：引用块 + 指令。 */
function relayMappingPayload(handoff: RelayMappingHandoff, instruction: string): string {
  return buildInjectedReferenceEnvelope({
    kind: "relay-mapping",
    title: `字段映射 · ${handoff.providerName}`,
    body: `${composeRelayMappingPrompt(handoff)}\n\n${instruction}`,
  });
}

/** 组装引用胶囊（composer 里只显示 label）。 */
export function relayMappingReference(
  handoff: RelayMappingHandoff,
  instruction: string,
): DraftReference {
  return {
    id: `relay-mapping:${handoff.stationId}`,
    kind: "relay-mapping",
    label: handoff.providerName,
    payload: relayMappingPayload(handoff, instruction),
  };
}
