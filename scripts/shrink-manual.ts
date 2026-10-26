#!/usr/bin/env tsx
/**
 * manual 层瘦身脚本（本轮新增）：把 data/cities/<city>.manual.json 里「主文件全量副本」
 * 砍成「只含与主文件不同的字段」，最常见形态就是 `{ id, importance }`。
 *
 * 背景：批量打星旧实现（scripts/rate-places.ts）把整条 Place 复制进 manual 层——北京 116 条、
 * 辽阳 141 条全是主文件的重复副本，后台「来源」列因此全显示「手工」。manual 层现在是
 * 「部分字段覆盖」（lib/cityData.ts 的 ManualPlaceEntrySchema），只留差异字段就够了。
 *
 * 用法（项目根）：
 *   npx tsx scripts/shrink-manual.ts                       # dry-run（默认）：只打印计划，不写盘
 *   npx tsx scripts/shrink-manual.ts --apply               # 落盘（备份 + 合并不变式断言）
 *   npx tsx scripts/shrink-manual.ts --city=beijing,liaoyang
 *
 * 安全保证（按优先级）：
 * 1. 默认 dry-run；只有显式 --apply 才写盘；
 * 2. 只碰 .manual.json，主文件 data/cities/<city>.json 一个字节都不改；
 * 3. --apply 前把原件逐字节备份到 build/reports/manual-shrink/<city>.manual.orig.json；
 * 4. 写盘后重新 loadCity，断言「瘦身前后的合并结果 JSON 完全相等」（顺序 / 字段 / 值），
 *    不相等就用备份回滚并 exit 1 —— 数据内容不允许因为这轮清理发生任何变化；
 * 5. 幂等：对已经瘦身的文件再跑 dry-run 应该显示 0 变更。
 *
 * 规则（与 build/manual-layer-contract.md 一致）：
 * - manual 条目在主文件里没有同 id → 手工新增点，必须完整 Place，原样保留；
 * - 与主文件逐字段相同 → 丢弃（纯副本，不承载任何覆盖）；
 * - 有差异 → 只保留 `{ id, ...有差异的字段 }`，键序 id 最前、其余按 PlaceSchema 字段顺序；
 * - 输出顺序按主文件 places 顺序（手工新增点排最后，保持原相对顺序）。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ManualCityDataSchema,
  ManualPlaceEntrySchema,
  listCities,
  loadCity,
  loadMainCityData,
  manualCityDataFilePath,
  readJsonFile,
  saveManualPlaces,
} from "../lib/cityData";
import type { ManualPlaceEntry } from "../lib/cityData";
import { PlaceSchema } from "../types/schema";
import type { Place } from "../types/schema";

/** 只打印计划、不写盘（默认行为）；加 --apply 才落盘。 */
const APPLY = process.argv.slice(2).includes("--apply");

/** 报告 / 备份目录（gitignore 范围内）。 */
const REPORT_DIR = join(process.cwd(), "build", "reports", "manual-shrink");

/** 输出键序：id 最前，其余按 PlaceSchema 的字段定义顺序（输出的 JSON 因此稳定、可 diff）。 */
const FIELD_ORDER: readonly string[] = ["id", ...Object.keys(PlaceSchema.shape)];

function fieldRank(field: string): number {
  const index = FIELD_ORDER.indexOf(field);
  return index === -1 ? FIELD_ORDER.length : index;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 字段值比较口径：undefined 与「字段缺失」等价；其余按 JSON 字面量比（null 是有效值）。 */
function sameValue(left: unknown, right: unknown): boolean {
  return (left === undefined ? "<missing>" : JSON.stringify(left)) === (right === undefined ? "<missing>" : JSON.stringify(right));
}

function readField(record: Place | ManualPlaceEntry, field: string): unknown {
  return (record as unknown as Record<string, unknown>)[field];
}

/**
 * 手工条目里「真正承载覆盖」的字段：只比对**条目里出现的字段**。
 *
 * 关键：manual 条目现在是部分字段覆盖，条目里没有的字段 = 从主文件继承，不是「被改成 undefined」。
 * 所以这里只遍历 entry 的键；entry 里出现但与主文件值相同的字段算冗余，不保留。
 */
function diffFields(main: Place, entry: ManualPlaceEntry): string[] {
  const changed: string[] = [];
  for (const field of Object.keys(entry)) {
    if (field === "id") continue;
    if (!sameValue(readField(main, field), readField(entry, field))) changed.push(field);
  }
  return changed.sort((left, right) => fieldRank(left) - fieldRank(right));
}

/** 条目规范化字符串：只保留字段顺序稳定后的键值对，用来判断「这次跑会不会改动文件」。 */
function canonicalEntry(entry: ManualPlaceEntry): string {
  const record = entry as unknown as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const field of FIELD_ORDER) {
    if (Object.prototype.hasOwnProperty.call(record, field)) ordered[field] = record[field];
  }
  for (const field of Object.keys(record)) {
    if (!Object.prototype.hasOwnProperty.call(ordered, field)) ordered[field] = record[field];
  }
  return JSON.stringify(ordered);
}

function canonicalEntries(entries: ManualPlaceEntry[]): string {
  return entries.map((entry) => canonicalEntry(entry)).join("\n");
}

type CityPlan = {
  city: string;
  manualPath: string;
  fileExists: boolean;
  originalText: string;
  entriesBefore: number;
  entriesAfter: number;
  /** 纯副本、直接丢弃的条目 id */
  dropped: string[];
  /** 主文件没有同 id 的手工新增点（原样保留） */
  manualOnly: string[];
  /** 「哪些字段组合需要覆盖」的直方图，例如 {"importance": 116} */
  changedFieldSets: Record<string, number>;
  /** 这次跑会不会改动文件（按规范化后的条目内容判断，而不是条目数）。 */
  changed: boolean;
  planned: ManualPlaceEntry[];
};

function planCity(city: string): CityPlan {
  const mainPlaces = loadMainCityData(city).places;
  const mainById = new Map<string, Place>();
  const mainOrder = new Map<string, number>();
  for (let index = 0; index < mainPlaces.length; index += 1) {
    mainById.set(mainPlaces[index].id, mainPlaces[index]);
    mainOrder.set(mainPlaces[index].id, index);
  }

  const manualPath = manualCityDataFilePath(city);
  const fileExists = existsSync(manualPath);
  const originalText = fileExists ? readFileSync(manualPath, "utf8") : "";
  const rawEntries: ManualPlaceEntry[] = fileExists
    ? ManualCityDataSchema.parse(readJsonFile(manualPath, "手工地点")).places
    : [];

  const seen = new Set<string>();
  for (const entry of rawEntries) {
    if (seen.has(entry.id)) throw new Error(`手工地点里 id 重复：${entry.id}（文件：${manualPath}）`);
    seen.add(entry.id);
  }

  const plan: CityPlan = {
    city,
    manualPath,
    fileExists,
    originalText,
    entriesBefore: rawEntries.length,
    entriesAfter: 0,
    dropped: [],
    manualOnly: [],
    changedFieldSets: {},
    changed: false,
    planned: [],
  };

  for (const entry of rawEntries) {
    const main = mainById.get(entry.id);
    if (main === undefined) {
      // 手工新增点：主文件没有同 id，必须保留完整数据，否则合并时无字段可继承。
      const complete = PlaceSchema.safeParse(entry);
      if (!complete.success) {
        throw new Error(
          `手工新增地点不是完整 Place，拒绝处理：${entry.id}（${manualPath}）：${complete.error.issues
            .map((issue) => `${issue.path.join(".") || "根"} ${issue.message}`)
            .join("；")}`,
        );
      }
      plan.manualOnly.push(entry.id);
      plan.planned.push(complete.data);
      continue;
    }

    const changed = diffFields(main, entry);
    if (changed.length === 0) {
      // 与主文件完全一致：纯副本，不承载任何覆盖，直接丢弃。
      plan.dropped.push(entry.id);
      continue;
    }

    const minimal: Record<string, unknown> = { id: entry.id };
    for (const field of changed) minimal[field] = readField(entry, field);
    const parsed = ManualPlaceEntrySchema.parse(minimal);
    plan.planned.push(parsed);
    const key = changed.join(",");
    plan.changedFieldSets[key] = (plan.changedFieldSets[key] ?? 0) + 1;
  }

  // 顺序 = 主文件顺序（手工新增点排最后，保持原有相对顺序；Array#sort 稳定）。
  plan.planned.sort((left, right) => {
    const leftRank = mainOrder.get(left.id);
    const rightRank = mainOrder.get(right.id);
    const leftKey = leftRank === undefined ? Number.MAX_SAFE_INTEGER : leftRank;
    const rightKey = rightRank === undefined ? Number.MAX_SAFE_INTEGER : rightRank;
    return leftKey - rightKey;
  });
  plan.entriesAfter = plan.planned.length;
  plan.changed = canonicalEntries(plan.planned) !== canonicalEntries(rawEntries);
  return plan;
}

function printPlan(plan: CityPlan): void {
  console.log(`\n===== ${plan.city} =====`);
  console.log(`  文件：${plan.manualPath}${plan.fileExists ? "" : "（不存在）"}`);
  console.log(`  条目：${plan.entriesBefore} → ${plan.entriesAfter}（丢弃纯副本 ${plan.dropped.length}，手工新增保留 ${plan.manualOnly.length}）`);
  console.log(`  是否改动文件：${plan.changed ? "是" : "否（已是最小格式）"}`);
  console.log(`  需要覆盖的字段组合：${Object.keys(plan.changedFieldSets).length === 0 ? "（无）" : JSON.stringify(plan.changedFieldSets)}`);
  if (plan.manualOnly.length > 0) console.log(`  手工新增点（原样保留）：${plan.manualOnly.join(", ")}`);
  const preview = plan.planned.slice(0, 3);
  if (preview.length > 0) {
    console.log("  首 3 条：");
    for (const entry of preview) console.log(`    ${JSON.stringify(entry)}`);
  }
}

/** 用备份把 manual 文件恢复原状（写盘后断言失败时调用）。 */
function restoreFromBackup(plan: CityPlan): void {
  if (plan.fileExists) {
    writeFileSync(plan.manualPath, plan.originalText, "utf8");
  } else if (existsSync(plan.manualPath)) {
    unlinkSync(plan.manualPath);
  }
  console.log(`  已回滚：${plan.manualPath}`);
}

function applyPlan(plan: CityPlan): void {
  mkdirSync(REPORT_DIR, { recursive: true });

  // 瘦身前的合并结果（清缓存后重新读盘，确保拿的是当前磁盘状态）。
  const before = loadCity(plan.city);
  const beforePlacesJson = JSON.stringify(before.places);
  const beforeConfigJson = JSON.stringify({ ...before, places: [] });

  // 备份原件（逐字节）+ 把「瘦身前合并结果」落成证据文件，验收脚本据此做独立比对。
  const backupPath = join(REPORT_DIR, `${plan.city}.manual.orig.json`);
  if (plan.fileExists) writeFileSync(backupPath, plan.originalText, "utf8");
  writeFileSync(join(REPORT_DIR, `${plan.city}.merged-before.json`), `${JSON.stringify(before.places, null, 2)}\n`, "utf8");

  // 落盘：saveManualPlaces 内部过 zod + 完整性校验 + 原子写 + 清进程内缓存。
  const written = saveManualPlaces(plan.city, plan.planned);
  const after = loadCity(plan.city);
  const afterPlacesJson = JSON.stringify(after.places);
  const afterConfigJson = JSON.stringify({ ...after, places: [] });

  // 不变式：合并结果（含顺序）与瘦身前完全一致，城市配置也一致。
  if (beforePlacesJson !== afterPlacesJson || beforeConfigJson !== afterConfigJson) {
    restoreFromBackup(plan);
    throw new Error(`[${plan.city}] 瘦身前后的合并数据不一致，已回滚。请把 build/reports/manual-shrink 下的备份保留并排查。`);
  }

  // 新文件内容存成「干净基线」，验收脚本做可逆写入测试后从这里还原。
  const cleanText = readFileSync(plan.manualPath, "utf8");
  writeFileSync(join(REPORT_DIR, `${plan.city}.manual.clean.json`), cleanText, "utf8");
  writeFileSync(
    join(REPORT_DIR, `${plan.city}.sha256.txt`),
    [
      `city=${plan.city}`,
      `manual.orig=${plan.fileExists ? sha256(plan.originalText) : "(不存在)"}`,
      `manual.clean=${sha256(cleanText)}`,
      `merged.before.sha256=${sha256(beforePlacesJson)}`,
      `merged.after.sha256=${sha256(afterPlacesJson)}`,
      `entries=${written.length}`,
      "",
    ].join("\n"),
    "utf8",
  );

  console.log(
    `  [apply] 写盘完成：${written.length} 条（${plan.entriesBefore} → ${plan.entriesAfter}），` +
      `合并不变式 ✓（places json sha256 ${sha256(afterPlacesJson).slice(0, 16)}…）`,
  );
  console.log(`  备份：${backupPath}`);
}

function main(): number {
  const cityArg = process.argv.slice(2).find((argument) => argument.startsWith("--city="));
  const cities = cityArg === undefined
    ? listCities().map((entry) => entry.city)
    : cityArg
        .slice("--city=".length)
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value !== "");
  if (cities.length === 0) throw new Error("--city= 后面没有城市 id");

  console.log(`[shrink-manual] 模式=${APPLY ? "APPLY（会写盘）" : "dry-run（不写盘）"}，城市=${cities.join(", ")}`);

  let changedCities = 0;
  for (const city of cities) {
    const plan = planCity(city);
    printPlan(plan);
    if (!plan.changed) {
      console.log("  已是最小格式，无需写盘。");
      continue;
    }
    if (APPLY) {
      applyPlan(plan);
      changedCities += 1;
    } else {
      changedCities += 1;
    }
  }

  if (!APPLY) {
    console.log(`\n[shrink-manual] dry-run 结束：${changedCities} 个城市有变化（未写盘）。确认后加 --apply 落盘。`);
  } else {
    console.log(`\n[shrink-manual] 落盘结束：${cities.length} 个城市已处理（${changedCities} 个条目数有变化），合并数据不变式全部通过。`);
  }
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[shrink-manual] FAIL：${message}`);
  process.exitCode = 1;
}
