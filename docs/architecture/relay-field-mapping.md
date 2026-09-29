# 中转站字段映射化改造

> 2026-09 · feat(settings) 后续 · 目标：接入新中转站不再改源码

## 是什么

模型服务的中转站余额/价格抓取，从「new-api 风格硬编码」改为**映射表驱动**：

- **本地标准字段集**（`RelayFieldKey`，protocol/types.ts）：分组倍率、分组描述、模型列表、
  每模型的输入/输出/缓存倍率与按次价格、key 可见模型、余额、已用等 —— 固定不变。
- **每站一张映射表**：`<agentDir>/piabyss/relay-pricing/mappings/<stationId>.json`，
  把该站响应字段映射到标准字段。Agent 探测生成 → 用户核对 → 生效。
- 没有映射表（或 `enabled: false`）时走内置 new-api 默认路径，与改造前行为一致。
- **同站共享**：一张表声明 `shareByBaseUrl`（站点地址）后，同址 provider 自动复用；
  `shareScope: "domain"` 进一步放宽到主域一致（`cf.hetune.top` ≈ `hetune.top` 的镜像
  入口共享主站映射）。解析顺序：本站显式表 > URL 一致的共享表 > 主域一致的共享表 >
  内置默认。同一站点只需探测/映射一次。

## 映射表格式

```json
{
  "schemaVersion": 1,
  "stationId": "12",
  "shareByBaseUrl": "https://hetune.top/v1",
  "shareScope": "domain",
  "endpoints": {
    "pricing": {
      "path": "api/pricing",
      "auth": false,
      "fieldsApplyTo": "items",
      "itemsField": "models",
      "itemsPath": "data",
      "fields": {
        "groups": { "path": "group_ratio", "reader": "entries" },
        "modelId": { "path": "model_name" },
        "modelInputRatio": { "path": "model_ratio" },
        "modelCompletionRatio": { "path": "completion_ratio" },
        "modelGroups": { "path": "enable_groups", "reader": "array" },
        "modelPerCallFlag": { "path": "quota_type" }
      }
    },
    "models": {
      "path": "v1/models",
      "auth": true,
      "fields": { "keyModels": { "path": "data", "reader": "array", "itemField": "id" } }
    },
    "balance": {
      "path": "api/user/self",
      "auth": true,
      "fields": {
        "balanceRemaining": { "path": "data.quota", "scale": 0.000002 },
        "balanceUsed": { "path": "data.used_quota", "scale": 0.000002 }
      }
    }
  }
}
```

字段规则：

- `path`：相对**响应根**的点路径（items 模式下相对每条记录）。
- `reader`：`entries` = 对象展开为键值对（分组表）；`array` = 字符串数组（`itemField`
  指定字段名）；缺省 `value` = 直取标量。
- `scale`：乘法换算（美分→美元 `0.01`；quota→美元 `1/500000` 等）；`offset`：先减后乘。
- `unlimitedAbove`：余额 ≥ 该值视为不限量。
- `fallback`：路径缺失时的兜底；`path: "$"` + `fallback` 可写常量。
- `fieldsApplyTo: "items"` 的端点：`path` 是端点 URL，`itemsPath` 是记录数组在响应内的
  位置（响应本体即数组时省略）。
- item 级字段（`modelId/modelInputRatio/...`）按记录解析；其余（`groups` 等）从响应根取。

## 机器人图标入口

编辑模型服务页头部（复制按钮旁）新增 **Bot 图标**：点击后

1. host 端 `provider.mapping.handoff` 返回站点事实（映射表写入路径、baseUrl、key 存放位置、现有映射）；
2. 桌面端拼装任务书（探测哪些接口、字段规则、写入路径、取不到就省略），以
   `@字段映射 · <站点名>` 引用胶囊注入**默认工作区（DefaultProject）**的新会话；
3. 跳转聊天页，用户发送后 Agent 开始探测、验证并直接写映射表文件；
4. 价格表/余额下次刷新即按新映射解析。Agent 回复探测结论，用户核对后可随时把
   映射表 `enabled` 置 false 回退内置默认，或直接删除文件。

## 协议与实现

| 层 | 内容 |
|---|---|
| protocol | `RelayFieldMap`/`RelayEndpointMapping`/`RelayFieldMapping` 类型；`provider.mapping.get/set/handoff` 三方法（params/result 校验齐全） |
| pi-host | `relay-field-mapping.ts`（路径解析 + items/root 双模式 + scale/offset 换算）；`relay-mapping-store.ts`（按站文件、原子写、防路径逃逸）；`relay-pricing-controller.ts` 接线（fetch/balance 全走映射路径） |
| desktop | 编辑页机器人按钮（`relay-mapping-agent.ts` + `relay-mapping-handoff.ts` 任务书）；composer `@字段映射` 胶囊；transcript `relay-mapping` chip |

## 测试

- protocol：771（含三个新方法的 params/result/coverage 用例）
- pi-host：1020（新增映射解析 8 例 + 控制器映射化抓取/交接/回退 1 例）
- desktop：1429（chip、引用、i18n 均绿）
