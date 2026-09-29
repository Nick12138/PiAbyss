/**
 * 中转站字段映射表存储层。
 *
 * 每个站点一张表：<agentDir>/piabyss/relay-pricing/mappings/<stationId>.json。
 * 拆成按站点的独立文件而不是塞进一个大 JSON：Agent 直接改写单站文件即可
 * 生效，不用整表加锁；损坏/缺失都视为「无自定义映射」（走内置默认）。
 *
 * 写入与 RelayPricingStore 同策略：临时文件 + rename 原子替换。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RelayFieldMap } from "@piabyss/protocol";
import { isObject } from "./provider-models-config.js";

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

  /** 是否存在任何映射文件（Agent 提示词里判断「全新 vs 更新」）。 */
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
