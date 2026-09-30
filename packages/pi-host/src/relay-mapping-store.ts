/**
 * 中转站字段映射表存储层。
 *
 * 每个站点一张表：<agentDir>/piabyss/relay-pricing/mappings/<stationId>.json。
 * 拆成按站点的独立文件而不是塞进一个大 JSON：Agent 直接改写单站文件即可
 * 生效，不用整表加锁；损坏/缺失都视为「无自定义映射」（走内置默认）。
 *
 * 同 baseUrl 共享：映射表可带 shareByBaseUrl（归一化后的站点地址），
 * 所有 baseUrl 相同的 provider 自动复用这张表——Agent 只需探测/生成一次。
 * 解析顺序：本站显式表 > 同 baseUrl 共享表 > 内置默认。
 *
 * 写入与 RelayPricingStore 同策略：临时文件 + rename 原子替换。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { RelayFieldMap } from "@piabyss/protocol";
import { isObject } from "./provider-models-config.js";

/**
 * 归一化站点地址：scheme+host(+port)+path，host 小写、默认端口省略、
 * 路径去尾斜杠。返回 null 表示无法解析（非 http(s) 或格式非法）。
 */
export function normalizeRelayBaseUrl(baseUrl: string): string | null {
  const trimmed = baseUrl.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    let path = url.pathname.replace(/\/+$/, "");
    if (path === "/") path = "";
    return `${url.protocol}//${url.host}${path}`.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * 主域键：取 host 的末两段（x.top → x.top，cf.hetune.top → hetune.top；
 * IP/localhost 原样）。配合 shareScope="domain" 让 CDN 镜像入口
 * （cf.x / api.x / cdn.x）复用主站的映射表。
 */
export function relayMainDomain(baseUrl: string): string | null {
  const trimmed = baseUrl.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    // IPv6 字面量带冒号；纯数字为 IPv4；单段 localhost —— 都不拆分。
    if (host.includes(":") || /^\d+(\.\d+)*$/.test(host) || !host.includes(".")) return host;
    const parts = host.split(".");
    return parts.slice(-2).join(".");
  } catch {
    return null;
  }
}

/** 是否为可抓取价格的中转站地址（http/https）。 */
export function isRelayBaseUrl(baseUrl: string): boolean {
  return normalizeRelayBaseUrl(baseUrl) !== null;
}

/**
 * 两地址是否指向同一站点：归一化后完全一致，或主域一致（cf.x ≈ x.top）。
 * 与 shareScope "domain" / 站点合并选择器同一套语义。
 */
export function sameRelayStation(a: string, b: string): boolean {
  const na = normalizeRelayBaseUrl(a);
  const nb = normalizeRelayBaseUrl(b);
  if (na !== null && na === nb) return true;
  const da = relayMainDomain(a);
  const db = relayMainDomain(b);
  return da !== null && da === db;
}

export class RelayMappingStore {
  private readonly root: string;

  constructor(agentDir: string) {
    this.root = join(agentDir, "piabyss", "relay-pricing", "mappings");
  }

  /** 映射文件根目录（测试与诊断用）。 */
  rootDir(): string {
    return this.root;
  }

  mappingPath(stationId: string): string {
    // stationId 即 provider id（models.json 键），含路径分隔符时拒绝，防逃逸。
    if (!/^[A-Za-z0-9._-]+$/.test(stationId)) {
      throw new Error(`invalid station id: ${stationId}`);
    }
    return join(this.root, `${stationId}.json`);
  }

  get(stationId: string): RelayFieldMap | null {
    let path: string;
    try {
      path = this.mappingPath(stationId);
    } catch {
      return null;
    }
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (isObject(parsed) && typeof parsed.schemaVersion === "number") {
        return parsed as RelayFieldMap;
      }
    } catch {
      // 损坏视为无映射（保留原文件便于排查，不主动删除）。
    }
    return null;
  }

  /**
   * 解析某站生效的映射表：本站显式表优先（但声明了 shareByBaseUrl 且声明
   * 站点与当前地址不同站的表视为旧站遗留，让位给共享表）；否则按共享声明
   * 找 —— shareScope "url"（默认）只在归一化地址完全一致时共享；
   * "domain" 覆盖同主域镜像入口（cf.x/api.x/cdn.x）。都不存在返回 null。
   */
  resolve(stationId: string, baseUrl: string): RelayFieldMap | null {
    const own = this.getActive(stationId);
    // 本站表通常直接生效；但 provider 换站后遗留的旧声明表（如域名迁移前
    // 生成的表）缺新站才有的端点，应让位给同站共享表，而不是继续挡住它。
    const ownIsStale =
      own !== null &&
      own.shareByBaseUrl !== undefined &&
      isRelayBaseUrl(own.shareByBaseUrl) &&
      !sameRelayStation(own.shareByBaseUrl, baseUrl);
    if (own && !ownIsStale) return own;
    const normalized = normalizeRelayBaseUrl(baseUrl);
    if (!normalized) return own;
    const domain = relayMainDomain(baseUrl);
    let domainMatch: RelayFieldMap | null = null;
    for (const candidateId of this.listStationIds()) {
      if (candidateId === stationId) continue;
      const candidate = this.getActive(candidateId);
      if (!candidate?.shareByBaseUrl) continue;
      if (normalizeRelayBaseUrl(candidate.shareByBaseUrl) === normalized) {
        return candidate;
      }
      if (
        !domainMatch &&
        candidate.shareScope === "domain" &&
        domain &&
        relayMainDomain(candidate.shareByBaseUrl) === domain
      ) {
        domainMatch = candidate;
      }
    }
    // 失配本站表没有可用共享表时仍回退生效（聊胜于无，好过完全没映射）。
    return domainMatch ?? own;
  }

  /** 仅接受 enabled !== false 且结构完整的表；其余一律视为无映射。 */
  getActive(stationId: string): RelayFieldMap | null {
    const mapping = this.get(stationId);
    if (!mapping || mapping.enabled === false) return null;
    return mapping;
  }

  set(stationId: string, mapping: RelayFieldMap | null): RelayFieldMap | null {
    if (mapping === null) {
      const path = this.mappingPath(stationId);
      if (existsSync(path)) {
        try {
          renameSync(path, `${path}.removed-${Date.now()}`);
        } catch {
          /* best-effort */
        }
      }
      return null;
    }
    this.write(stationId, mapping);
    return mapping;
  }

  private write(stationId: string, mapping: RelayFieldMap): void {
    const path = this.mappingPath(stationId);
    mkdirSync(this.root, { recursive: true });
    const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tempPath, JSON.stringify(mapping, null, 2), "utf8");
    renameSync(tempPath, path);
  }

  /**
   * 软停用一张映射表（provider 被删除时调用）：文件与字段全部保留，
   * 仅置 enabled=false 使 resolve/getActive 视为无映射 —— 防止 stationId
   * 被新站点 provider 复用后串站。notes 里留下 `[site] <url>` 标记，
   * 之后同 id 同站的新 provider 可用 reactivate 无损复活。
   * 已停用/不存在的表不做任何事，返回是否发生了写入。
   */
  retire(stationId: string, opts?: { lastBaseUrl?: string }): boolean {
    const mapping = this.get(stationId);
    if (!mapping) return false;
    const site = opts?.lastBaseUrl?.trim();
    if (site) {
      const marker = `[site] ${site}`;
      if (mapping.enabled === false && mapping.notes?.includes(marker)) return false;
      const notes = mapping.notes?.includes(marker)
        ? mapping.notes
        : `${mapping.notes ? `${mapping.notes}\n` : ""}${marker}`;
      this.write(stationId, { ...mapping, enabled: false, notes });
      return true;
    }
    // 无可靠站点标记：仅停用（reactivate 不会触发，避免同 id 串站）。
    if (mapping.enabled === false) return false;
    this.write(stationId, { ...mapping, enabled: false });
    return true;
  }

  /**
   * 尝试复活一张已停用的表：仅当 notes 里的 `[site]` 标记与给定 baseUrl
   * 指向同一站点时才重新启用（enabled=true + 补共享声明），避免复用的
   * id 误接别人的表。返回是否复活。
   */
  reactivate(stationId: string, baseUrl: string): boolean {
    if (!isRelayBaseUrl(baseUrl)) return false;
    const mapping = this.get(stationId);
    if (!mapping || mapping.enabled !== false) return false;
    const site = /\[site\]\s*(\S+)/.exec(mapping.notes ?? "")?.[1];
    if (!site || !sameRelayStation(site, baseUrl)) return false;
    this.write(stationId, {
      ...mapping,
      enabled: true,
      shareByBaseUrl: site,
      shareScope: "domain",
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  /**
   * 把 from 的映射表迁给 to（provider 改名或删除时把表交给同站幸存者）。
   * to 已有自己的表（本站表优先，无需迁移）或 from 无表时返回 false。
   * 表内容有效时改写 stationId 后原子写入；损坏文件原样改名保留。
   */
  reassign(fromId: string, toId: string): boolean {
    let fromPath: string;
    let toPath: string;
    try {
      fromPath = this.mappingPath(fromId);
      toPath = this.mappingPath(toId);
    } catch {
      return false;
    }
    if (fromPath === toPath || !existsSync(fromPath) || existsSync(toPath)) return false;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(readFileSync(fromPath, "utf8")) as unknown;
    } catch {
      // 损坏文件：原样改名保留，便于排查。
    }
    try {
      if (isObject(parsed) && typeof (parsed as { schemaVersion?: unknown }).schemaVersion === "number") {
        const mapping = parsed as RelayFieldMap;
        this.write(toId, { ...mapping, stationId: toId, updatedAt: new Date().toISOString() });
        renameSync(fromPath, `${fromPath}.removed-${Date.now()}`);
      } else {
        renameSync(fromPath, toPath);
      }
    } catch {
      return false;
    }
    return true;
  }

  /**
   * 把 base 表的共享声明补齐为覆盖其它 provider（仅在指向同一站点时）。
   * 幂等：已有等价声明时不写入。返回是否发生了写入。
   */
  ensureSharedByBaseUrl(baseId: string, baseUrl: string): boolean {
    if (!isRelayBaseUrl(baseUrl)) return false;
    const mapping = this.getActive(baseId);
    if (!mapping) return false;
    const normalized = normalizeRelayBaseUrl(baseUrl);
    if (
      mapping.shareByBaseUrl !== undefined &&
      normalizeRelayBaseUrl(mapping.shareByBaseUrl) === normalized &&
      mapping.shareScope === "domain"
    ) {
      return false;
    }
    this.write(baseId, {
      ...mapping,
      shareByBaseUrl: baseUrl.replace(/\/+$/, ""),
      shareScope: "domain",
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  /**
   * 同站镜像依赖者清单：除 baseId 外，还有哪些 provider 当前实际解析到
   * base 的表（含自己有过期旧站表而落到共享表的）。
   * 供删除/改名时判断「表是否还有人用」。
   */
  dependentProviderIds(
    baseId: string,
    baseUrl: string,
    others: ReadonlyArray<{ id: string; baseUrl: string }>,
  ): string[] {
    const base = this.getActive(baseId);
    if (!base || !isRelayBaseUrl(baseUrl)) return [];
    return others
      .filter(
        (entry) =>
          entry.id !== baseId &&
          isRelayBaseUrl(entry.baseUrl) &&
          this.resolve(entry.id, entry.baseUrl)?.stationId === baseId,
      )
      .map((entry) => entry.id);
  }

  /** 现有映射表的 stationId 清单（共享解析与 Agent 提示词用）。 */
  listStationIds(): string[] {
    if (!existsSync(this.root)) return [];
    try {
      return readdirSync(this.root)
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice(0, -".json".length));
    } catch {
      return [];
    }
  }
}
