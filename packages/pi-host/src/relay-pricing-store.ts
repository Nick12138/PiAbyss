/**
 * 中转站价格表/余额/充值比例本地存储层。
 *
 * 数据落盘在 `<agentDir>/piabyss/relay-pricing/` 下，与 models.json 完全隔离：
 *   - `pricing.json`        价格表快照（schemaVersion 1，原子写入）
 *   - `pricing-config.json` 充值比例配置（providerId → ratio）
 *
 * 设计取舍（与 memo-store 一致）：
 *   - 每次操作都从磁盘读、写回磁盘，不持有内存缓存。数据量小（几百 KB），
 *     磁盘读取代价可忽略；换来多实例安全。
 *   - 写入走「临时文件 + rename」原子替换，进程中断不会留下半截 JSON。
 *   - 损坏的 JSON 视为空数据（备份损坏原文件为 .corrupt-<ts>，便于排查）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  RelayBalance,
  RelayPricingTable,
  RelayRechargeRatio,
} from "@piabyss/protocol";

type PricingFile = RelayPricingTable;

const SCHEMA_VERSION = 1;

type PricingConfigFile = {
  schemaVersion: 1;
  /** providerId → CNY paid per balance unit received. */
  ratios: Record<string, RelayRechargeRatio>;
};

export const DEFAULT_RECHARGE_RATIO: RelayRechargeRatio = { cny: 1, balance: 1 };

/** Ratio considered "unlimited" — station hard limits at/above this USD value. */
export const UNLIMITED_LIMIT_USD = 1_000_000;

export class RelayPricingStore {
  private readonly root: string;
  private readonly pricingPath: string;
  private readonly configPath: string;

  constructor(agentDir: string) {
    this.root = join(agentDir, "piabyss", "relay-pricing");
    this.pricingPath = join(this.root, "pricing.json");
    this.configPath = join(this.root, "pricing-config.json");
  }

  getTable(): RelayPricingTable {
    if (!existsSync(this.pricingPath)) {
      return { schemaVersion: SCHEMA_VERSION, stations: [] };
    }
    try {
      const parsed = JSON.parse(readFileSync(this.pricingPath, "utf8")) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as { schemaVersion?: unknown }).schemaVersion === SCHEMA_VERSION &&
        Array.isArray((parsed as { stations?: unknown }).stations)
      ) {
        return parsed as RelayPricingTable;
      }
    } catch {
      // 损坏的 JSON 视为空表（备份损坏原文件，便于事后排查）。
      try {
        renameSync(this.pricingPath, `${this.pricingPath}.corrupt-${Date.now()}`);
      } catch {
        /* best-effort */
      }
    }
    return { schemaVersion: SCHEMA_VERSION, stations: [] };
  }

  saveTable(table: RelayPricingTable): void {
    this.writeFile(this.pricingPath, { ...table, schemaVersion: SCHEMA_VERSION });
  }

  /** Upsert one station's snapshot into the persisted table. */
  upsertStation(station: RelayPricingTable["stations"][number]): void {
    const table = this.getTable();
    const stations = table.stations.filter((entry) => entry.stationId !== station.stationId);
    stations.push(station);
    this.saveTable({ schemaVersion: SCHEMA_VERSION, stations });
  }

  getRatios(): Record<string, RelayRechargeRatio> {
    if (!existsSync(this.configPath)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.configPath, "utf8")) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as { schemaVersion?: unknown }).schemaVersion === SCHEMA_VERSION &&
        typeof (parsed as { ratios?: unknown }).ratios === "object" &&
        (parsed as { ratios?: unknown }).ratios !== null
      ) {
        return (parsed as PricingConfigFile).ratios;
      }
    } catch {
      try {
        renameSync(this.configPath, `${this.configPath}.corrupt-${Date.now()}`);
      } catch {
        /* best-effort */
      }
    }
    return {};
  }

  /**
   * Set (or clear with null) the recharge ratio for a provider. A cleared
   * entry falls back to the default 1:1.
   */
  setRatio(providerId: string, ratio: RelayRechargeRatio | null): RelayRechargeRatio | null {
    const file = this.readConfigFile();
    if (ratio === null) delete file.ratios[providerId];
    else file.ratios[providerId] = ratio;
    this.writeFile(this.configPath, file);
    return ratio;
  }

  getRatio(providerId: string): RelayRechargeRatio {
    return this.getRatios()[providerId] ?? DEFAULT_RECHARGE_RATIO;
  }

  /** Cached balance for a provider, when present and fresh enough to show. */
  getCachedBalance(providerId: string): RelayBalance | null {
    const table = this.getTable();
    const station = table.stations.find((entry) => entry.providerId === providerId);
    return station?.balance ?? null;
  }

  private readConfigFile(): PricingConfigFile {
    if (!existsSync(this.configPath)) {
      return { schemaVersion: SCHEMA_VERSION, ratios: {} };
    }
    try {
      const parsed = JSON.parse(readFileSync(this.configPath, "utf8")) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as { schemaVersion?: unknown }).schemaVersion === SCHEMA_VERSION &&
        typeof (parsed as { ratios?: unknown }).ratios === "object" &&
        (parsed as { ratios?: unknown }).ratios !== null
      ) {
        return parsed as PricingConfigFile;
      }
    } catch {
      try {
        renameSync(this.configPath, `${this.configPath}.corrupt-${Date.now()}`);
      } catch {
        /* best-effort */
      }
    }
    return { schemaVersion: SCHEMA_VERSION, ratios: {} };
  }

  private writeFile(filePath: string, file: PricingFile | PricingConfigFile): void {
    mkdirSync(this.root, { recursive: true });
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tempPath, JSON.stringify(file, null, 2), "utf8");
    renameSync(tempPath, filePath);
  }
}
