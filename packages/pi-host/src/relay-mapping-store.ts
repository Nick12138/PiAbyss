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
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RelayFieldMap } from "@piabyss/protocol";
import { isObject } from "./provider-models-config.js";

/**
 * 归一化站点地址：scheme+host(+port)+path，host 小写、默认端口省略、
 * 路径去尾斜杠。同一站点在 models.json 里被配置成多个 provider 时
 * （例如一个 key 跑不同模型），归一化结果一致即可共享映射表。
 */
export type RelayMappingShareScope =
  /** 归一化地址完全一致才算同一站（默认）。 */
  | "url"
  /** 主域一致（hetune.top ≈ cf.hetune.top）即同一站；子域仅作入口镜像。 */
  | "domain";

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

export class RelayMappingStore {
  private readonly root: string;

  constructor(agentDir: string) {
    this.root = join(agentDir, "piabyss", "relay-pricing", "mappings");
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
   * 解析某站生效的映射表：本站显式表优先；否则按共享声明找 ——
   * shareScope "url"（默认）只在归一化地址完全一致时共享；
   * "domain" 覆盖同主域镜像入口（cf.x/api.x/cdn.x）。都不存在返回 null。
   */
  resolve(stationId: string, baseUrl: string): RelayFieldMap | null {
    const own = this.getActive(stationId);
    if (own) return own;
    const normalized = normalizeRelayBaseUrl(baseUrl);
    if (!normalized) return null;
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
    return domainMatch;
  }

  /** 仅接受 enabled !== false 且结构完整的表；其余一律视为无映射。 */
  getActive(stationId: string): RelayFieldMap | null {
    const mapping = this.get(stationId);
    if (!mapping || mapping.enabled === false) return null;
    return mapping;
  }

  set(stationId: string, mapping: RelayFieldMap | null): RelayFieldMap | null {
    const path = this.mappingPath(stationId);
    if (mapping === null) {
      if (existsSync(path)) {
        try {
          renameSync(path, `${path}.removed-${Date.now()}`);
        } catch {
          /* best-effort */
        }
      }
      return null;
    }
    mkdirSync(this.root, { recursive: true });
    const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tempPath, JSON.stringify(mapping, null, 2), "utf8");
    renameSync(tempPath, path);
    return mapping;
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
