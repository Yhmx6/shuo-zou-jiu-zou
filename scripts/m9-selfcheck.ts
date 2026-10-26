/**
 * M9 自检脚本（M9 §4 的三条）：
 *   1. 跑一组覆盖 12:00 的行程，确认有一站是餐厅；
 *   2. 贴出餐厅卡的完整内容（含排队判断和点菜建议）；
 *   3. 文案红线 —— 禁用词 grep（脚本里也对生成结果做一次正则校验）。
 *
 * 跑法（AMAP_KEY 只在服务端环境变量里）：
 *   npx tsx --env-file=.env.local scripts/m9-selfcheck.ts
 *
 * 只读 data/cities/hangzhou.json 里的真实地点，不生成任何地点、不编造排队人数。
 */
import type { Itinerary, Place, Stop } from "../types/schema";
import { loadCity } from "../lib/cityData";
import { buildItinerary, estimateWait, suggestDishes, weekdayLabelOf } from "../lib/planner";

const ORIGIN_BOOKSTORE_ID = "B0G399SIG2"; // 茑屋书店(天目里店)，与 M4/M4.5 自检同一原点

/** M9 3.3 只允许这两种句式。 */
const ALLOWED_WAIT_TEXT = [/^这个点人少$/, /^周[一二三四五六日] \d{2}:\d{2} 后通常要等 (15–20|30–40) 分钟$/];
const FORBIDDEN = ["无需排队", "已为你预约", "保证有位", "现在不用等"];

function formatMinute(minute: number): string {
  const hour = Math.floor(minute / 60);
  const rest = minute % 60;
  return `${String(hour).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function loadPool(): Place[] {
  return loadCity("hangzhou").places;
}

function printRestaurantStop(stop: Stop, place: Place | undefined, title: string): void {
  console.log(`\n--- ${title} ---`);
  console.log(`地点        ${place === undefined ? "?" : place.name}（${stop.placeId}）`);
  console.log(`到店        ${formatMinute(stop.arriveAt)}–${formatMinute(stop.leaveAt)}（停留 ${stop.stayMin} 分钟）`);
  if (stop.meal === undefined || stop.meal === null) {
    console.log("餐厅卡      没有 meal 字段（不符合 M9）");
    return;
  }
  const meal = stop.meal;
  console.log(`排队        ${meal.waitText}   [level=${meal.waitLevel}, min=${meal.waitMin}]`);
  console.log(`吃什么      ${meal.dishText}（按 ${meal.people} 人）`);
  console.log(`花多少      人均 ${meal.perPersonCost} 元`);
  console.log(`预约提醒    ${meal.bookingText === null ? "（这个点不用提醒）" : meal.bookingText}`);
  console.log(`跳转        ${meal.bookingUrl === null ? "（无）" : meal.bookingUrl}`);

  const okText = ALLOWED_WAIT_TEXT.some((pattern) => pattern.test(meal.waitText));
  console.log(`句式校验    ${okText ? "通过（符合 3.3 允许的两种句式）" : "不通过"}`);
  if (!okText) process.exitCode = 1;
  const hitForbidden = FORBIDDEN.filter(
    (word) => meal.waitText.includes(word) || (meal.bookingText ?? "").includes(word),
  );
  if (hitForbidden.length > 0) {
    console.log(`禁用词      ${hitForbidden.join("、")}`);
    process.exitCode = 1;
  }
}

async function runCase(label: string, startAt: number, people: number): Promise<void> {
  const pool = loadPool();
  const origin = pool.find((place) => place.id === ORIGIN_BOOKSTORE_ID);
  if (origin === undefined) throw new Error(`seed 里找不到原点 ${ORIGIN_BOOKSTORE_ID}`);

  const result: Itinerary | { ok: false; reason: string } = await buildItinerary(origin, startAt, {
    budget: 200,
    pool,
    mode: { visitedPlaceIds: [origin.id] },
    people,
  });

  console.log(`\n================ ${label} ================`);
  console.log(`出发 ${formatMinute(startAt)}，人数 ${people}，周几 ${weekdayLabelOf(new Date())}`);

  if ("ok" in result) {
    console.log(`排不出来：${result.reason}`);
    process.exitCode = 1;
    return;
  }

  const placeById = new Map(pool.map((place) => [place.id, place]));
  console.log(`行程 ${formatMinute(result.startAt)}–${formatMinute(result.endAt)}，${result.stops.length} 站，共 ${result.totalCost} 元`);
  result.stops.forEach((stop, index) => {
    const place = placeById.get(stop.placeId);
    console.log(
      `  ${index + 1}. ${place?.name ?? stop.placeId}（${place?.category ?? "?"}）  ` +
        `${formatMinute(stop.arriveAt)}–${formatMinute(stop.leaveAt)}  ${stop.costEstimate} 元  ${stop.reason}`,
    );
  });

  const restaurantStops = result.stops.filter((stop) => placeById.get(stop.placeId)?.category === "restaurant");
  console.log(`餐厅站数量  ${restaurantStops.length}`);
  // 只有餐厅站才许挂 meal：非餐厅站挂了 meal，卡片会被错渲染成餐厅卡。
  const mealStops = result.stops.filter((stop) => stop.meal !== undefined && stop.meal !== null);
  console.log(
    `meal 一致性   有 meal 的站 ${mealStops.length} / 餐厅站 ${restaurantStops.length} → ` +
      `${mealStops.length === restaurantStops.length ? "一致" : "不一致（不通过）"}`,
  );
  if (mealStops.length !== restaurantStops.length) process.exitCode = 1;
  const coversLunch = startAt < 13 * 60 + 30 && result.endAt > 11 * 60 + 30;
  if (coversLunch && restaurantStops.length === 0) {
    console.log("不通过：覆盖午餐时段却没有餐厅");
    process.exitCode = 1;
  }
  if (restaurantStops.length === 0) {
    console.log("注意：这一组没有餐厅站，无法展示餐厅卡");
    return;
  }
  restaurantStops.forEach((stop, index) => {
    printRestaurantStop(stop, placeById.get(stop.placeId), `${label} · 餐厅站 ${index + 1}`);
  });
}

async function main(): Promise<void> {
  // 组 1：10:30 出发 → 必然覆盖 11:30–13:30 午餐窗口（M9 3.1 的主场景）
  await runCase("组 1 覆盖午餐（10:30 出发）", 10 * 60 + 30, 1);
  // 组 2：17:00 出发 → 覆盖晚餐窗口，且大概率落在 18:00–19:00 高峰（排队预估的 high 档）
  await runCase("组 2 覆盖晚餐（17:00 出发，2 人）", 17 * 60, 2);
  // 组 3：12:20 出发 → 到店时间落在 12:00–13:00 高峰，用来验 high 档文案 + 预约提醒
  await runCase("组 3 正午高峰到店（12:20 出发）", 12 * 60 + 20, 1);
  // 组 4：15:00 出发 → 第一站通常不是餐厅，用来验「非餐厅站不挂 meal、不渲染餐厅卡」
  await runCase("组 4 下午出发（15:00，首站非餐厅）", 15 * 60, 1);

  // 3.4 三档点菜建议的直接校验（规则函数，不依赖排程）
  console.log("\n--- 点菜建议（3.4）---");
  for (const people of [1, 2, 3, 5]) {
    console.log(`  ${people} 人 → ${suggestDishes(people)}`);
  }

  // 3.2 排队预估的两条评分线（同一条街上的两家店，只为验证分档，不代表真实排队）
  console.log("\n--- 排队预估分档（3.2）---");
  const sample = loadPool().find((place) => place.category === "restaurant");
  if (sample !== undefined) {
    for (const minute of [11 * 60, 12 * 60 + 30, 15 * 60, 18 * 60 + 30]) {
      const wait = estimateWait(sample, minute);
      console.log(`  ${sample.name} 评分 ${sample.rating} 于 ${formatMinute(minute)} 到店 → ${wait.level}（${wait.min} 分钟起）`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
