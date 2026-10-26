import { readdirSync } from "node:fs";
import { join } from "node:path";
import { loadCity, listCities } from "../lib/cityData";
import type { CityData, CityIndexEntry } from "../lib/cityData";
import { CITY_CATEGORY_ORDER, countCategories, evaluateTierRules } from "../lib/cityTier";
import type { TierCheck } from "../lib/cityTier";

/**
 * 城市数据只读校验（npm run check:city）：换 / 改城市数据后、提交前先跑它。
 *
 * 校验四层：
 * 1. index ↔ 城市文件：索引里的每个 id 都有对应 data/cities/<id>.json；
 *    data/cities 下也不许有索引没登记的城市文件（孤立文件）。
 * 2. zod：index 过 CityIndexSchema、每个城市文件过 CityDataSchema（含每一条 PlaceSchema）。
 * 3. 一致性：文件里的 city / displayName 必须与索引一致；城市 id 不许重复。
 * 4. places 数量：按城市 tier（lib/cityTier.ts，与 fetch:seed 共用同一套规则）校验
 *    总数上下限、类目覆盖 / 核心 6 类、原点 3km 免费点；并检查 place id 不重复。
 *
 * 用法：
 *   npm run check:city                # 校验全部城市
 *   npm run check:city -- liaoyang    # 只校验 liaoyang（索引 / 孤立文件仍全局检查）
 *
 * ACTIVE_CITY：进程环境变量里有时会一起校验它是否命中索引；没有就跳过（不读 .env.local，
 * 这样没配环境文件也能跑；想连默认城市一起校验可用：
 *   npx tsx --env-file=.env.local scripts/check-city.ts）。
 */

const CITY_DATA_DIR = join(process.cwd(), "data", "cities");

type CheckResult = { label: string; measured: string; failures: string[] };

let passCount = 0;
let failCount = 0;
const allFailures: string[] = [];

/** 打印一条检查并累计结果。 */
function report(result: CheckResult): void {
  if (result.failures.length === 0) {
    passCount += 1;
    console.log(`  [PASS] ${result.label}：${result.measured}`);
    return;
  }
  failCount += 1;
  console.log(`  [FAIL] ${result.label}：${result.measured}`);
  for (const failure of result.failures) {
    console.log(`         - ${failure}`);
    allFailures.push(failure);
  }
}

function pass(label: string, measured: string): void {
  report({ label, measured, failures: [] });
}

function fail(label: string, measured: string, failures: string[]): void {
  report({ label, measured, failures });
}

/** 命令行指定要校验的城市 id（可选）。 */
function readCityFilter(): string | null {
  const fromArgv = process.argv[2];
  if (fromArgv === undefined) return null;
  const trimmed = fromArgv.trim();
  return trimmed === "" ? null : trimmed;
}

/** 索引里登记的城市文件之外，data/cities 下还有没有多余的城市文件。 */
function findOrphanCityFiles(entries: CityIndexEntry[]): string[] {
  let fileNames: string[];
  try {
    fileNames = readdirSync(CITY_DATA_DIR);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return [`读不到城市目录 ${CITY_DATA_DIR}（${reason}）`];
  }
  const indexed = new Set(entries.map((entry) => `${entry.city}.json`));
  const orphans: string[] = [];
  for (const fileName of fileNames) {
    if (!fileName.endsWith(".json")) continue;
    if (fileName === "index.json") continue;
    // 数据分层：data/cities/<city>.manual.json 是主城市文件的手工维护层，
    // 由 lib/cityData.ts 的 loadCity 按 id 合并，不是独立城市，不要求在 index.json 登记。
    if (fileName.endsWith(".manual.json")) continue;
    // 事件数据：data/cities/<city>.events.json 由 lib/events.ts 按城市 id 单独读取，
    // 也不是独立城市（此前漏了这条豁免，导致 check:city 每次都误报它未登记）。
    if (fileName.endsWith(".events.json")) continue;
    // 数据归档：`_archived-*.json`（例如片区合并后保留的旧城市文件）只是留档、不是活动城市，
    // 不要求在 index.json 登记。下划线前缀 = 数据目录里「非活动文件」的约定（planner 也不会读它）。
    if (fileName.startsWith("_")) continue;
    if (!indexed.has(fileName)) orphans.push(fileName);
  }
  return orphans;
}

/** 检查同一座城市里的 place id 是否重复。 */
function findDuplicatePlaceIds(city: CityData): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const place of city.places) {
    if (seen.has(place.id)) duplicates.add(place.id);
    seen.add(place.id);
  }
  return Array.from(duplicates);
}

/** 校验一个城市的完整数据（zod 已在 loadCity 里做掉，这里做一致性与 tier 规则）。 */
function checkCity(entry: CityIndexEntry, city: CityData): void {
  console.log(`\n  --- ${city.city}（${city.displayName}，tier=${city.thresholds.tier}）---`);

  const displayNameOk = city.displayName === entry.displayName;
  report({
    label: "index ↔ 文件一致",
    measured: `index 登记 ${entry.displayName} / 文件 ${city.city}（${city.displayName}，cityCode=${city.cityCode}，transferCityName=${city.transferCityName}）`,
    failures: displayNameOk
      ? []
      : [`index 里 displayName=${entry.displayName}，文件里是 ${city.displayName}（${city.city}）`],
  });

  const duplicates = findDuplicatePlaceIds(city);
  report({
    label: "places 数量 / id 唯一",
    measured: `${city.places.length} 条，place id ${duplicates.length === 0 ? "无重复" : `重复 ${duplicates.length} 个`}`,
    failures: duplicates.length === 0 ? [] : [`place id 重复：${duplicates.join("、")}`],
  });

  const tierChecks: TierCheck[] = evaluateTierRules(city, city.places);
  for (const check of tierChecks) {
    report(check);
  }

  // 报告用：分类分布（tier 规则已覆盖覆盖情况，这里只是给人看的明细）。
  const categoryCounts = countCategories(city.places);
  const orderedCategories = [
    ...CITY_CATEGORY_ORDER,
    ...Array.from(categoryCounts.keys()).filter((category) => CITY_CATEGORY_ORDER.indexOf(category) === -1),
  ];
  const categoryText = orderedCategories
    .filter((category) => (categoryCounts.get(category) ?? 0) > 0)
    .map((category) => `${category} ${categoryCounts.get(category) ?? 0}`)
    .join(" / ");
  console.log(`        分类：${categoryText}`);
}

async function main(): Promise<void> {
  console.log("=== 城市数据校验（npm run check:city：index ↔ 城市文件 ↔ zod ↔ places 数量）===");
  console.log(`城市目录：${CITY_DATA_DIR}`);

  const filter = readCityFilter();

  // 第 1 层：索引本身（listCities 内部走 CityIndexSchema）。
  console.log("\n[1/3] 城市索引 data/cities/index.json");
  let entries: CityIndexEntry[];
  try {
    entries = listCities();
    pass("index.json 合法", `${entries.length} 个城市（${entries.map((entry) => entry.city).join("、")}）`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    fail("index.json 合法", reason, [reason]);
    console.log(`\n结果：FAIL（${failCount} 项失败）`);
    process.exit(1);
  }

  const indexIds = entries.map((entry) => entry.city);
  const duplicateIndexIds = indexIds.filter((id, index) => indexIds.indexOf(id) !== index);
  report({
    label: "索引 id 唯一",
    measured: `${indexIds.length} 条`,
    failures:
      duplicateIndexIds.length === 0 ? [] : [`索引里城市 id 重复：${Array.from(new Set(duplicateIndexIds)).join("、")}`],
  });

  const orphans = findOrphanCityFiles(entries);
  report({
    label: "无孤立城市文件",
    measured: orphans.length === 0 ? "data/cities 下没有索引未登记的城市文件" : `发现 ${orphans.length} 个`,
    failures: orphans.length === 0 ? [] : [`索引未登记的城市文件：${orphans.join("、")}（请在 index.json 登记）`],
  });

  // 第 2 层：逐个城市文件（zod 在 loadCity 里做，失败直接算 FAIL 并继续下一个）。
  console.log("\n[2/3] 城市数据文件");
  const targets = filter === null ? entries : entries.filter((entry) => entry.city === filter);
  if (filter !== null && targets.length === 0) {
    fail("指定城市存在", `索引里没有 ${filter}`, [`指定城市 ${filter} 不在 index.json 里`]);
  }
  const checkedCities: string[] = [];
  for (const entry of targets) {
    try {
      const city = loadCity(entry.city);
      checkCity(entry, city);
      checkedCities.push(city.city);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      fail(`城市 ${entry.city} 文件 / zod 校验`, reason, [reason]);
    }
  }

  // 第 3 层：默认城市（只有环境变量真的有时才校验，避免依赖 .env.local）。
  console.log("\n[3/3] 默认城市（ACTIVE_CITY）");
  const activeCity = process.env.ACTIVE_CITY === undefined ? "" : process.env.ACTIVE_CITY.trim();
  if (activeCity === "") {
    pass("ACTIVE_CITY", "未设置（跳过；可用 npx tsx --env-file=.env.local scripts/check-city.ts 一起校验）");
  } else if (indexIds.indexOf(activeCity) !== -1) {
    pass("ACTIVE_CITY 命中索引", `${activeCity}（文件存在 = 已在上面的城市校验里）`);
  } else {
    fail("ACTIVE_CITY 命中索引", `ACTIVE_CITY=${activeCity}`, [
      `ACTIVE_CITY=${activeCity} 不在 index.json（可用：${indexIds.join("、")}）`,
    ]);
  }

  // 汇总。
  console.log("");
  if (failCount === 0) {
    console.log(
      `结果：PASS（索引 ${indexIds.length} 个城市；本次校验 ${checkedCities.length} 个：${checkedCities.join("、")}；共 ${passCount} 项检查）`,
    );
    process.exit(0);
  }
  console.log(`结果：FAIL（${failCount} 项失败，${passCount} 项通过）`);
  console.log("失败明细：");
  for (const failure of allFailures) {
    console.log(`  - ${failure}`);
  }
  process.exit(1);
}

main().catch((error: unknown) => {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
