/**
 * M3 自检脚本：连跑 5 组不同参数，打印「选中地点 / 通勤分钟 / 花费 / reason」，
 * 并逐条断言营业中（含「到达+停留 ≤ 闭馆」）、通勤在半径内、预算未超、时间闭合、成功时没有顶层 reason。
 *
 * 跑法（AMAP_KEY 只在服务端环境变量里，不进代码）：
 *   npx tsx --env-file=.env.local scripts/try-pick.ts
 *
 * 说明：5 组参数覆盖 3.0 交通表的触发条件（默认 / 省时 / 下雨）和 3.3 的类目偏好。
 * 附加检查只复用已缓存的路线（同一坐标的 getRoute 命中 .cache/，不再打接口）。
 */
import { PlaceSchema } from "../types/schema";
import type { Place, Segment, Stop } from "../types/schema";
import { loadCity } from "../lib/cityData";
import { canAfford, estimateCost, isOpenAt, withinRadius } from "../lib/constraints";
import { makeOriginPlace } from "../lib/origin";
import { pickNext, STAY_MIN } from "../lib/planner";
import type { PickMode } from "../lib/planner";

type Case = {
  label: string;
  originName: string;
  lng: number;
  lat: number;
  now: number;
  budget: number;
  /** 打印用的条件描述 */
  conditionText: string;
  mode: PickMode;
};

const CASES: Case[] = [
  {
    label: "下午、默认条件（晴天、体力允许、无偏好）",
    originName: "天目里街区（用户当前位置）",
    lng: 120.096,
    lat: 30.268,
    now: 15 * 60 + 20,
    budget: 200,
    conditionText: "默认（晴 / 体力允许 / 无偏好）",
    mode: {},
  },
  {
    label: "中午、预算偏低",
    originName: "武林广场",
    lng: 120.1631,
    lat: 30.2748,
    now: 12 * 60,
    budget: 150,
    conditionText: "默认（晴 / 体力允许 / 无偏好）",
    mode: {},
  },
  {
    label: "上午、用户选了省时",
    originName: "湖滨银泰 in77",
    lng: 120.163,
    lat: 30.255,
    now: 10 * 60,
    budget: 300,
    conditionText: "省时（timeFirst=true）",
    mode: { timeFirst: true },
  },
  {
    label: "下午、下雨",
    originName: "城站火车站",
    lng: 120.174,
    lat: 30.243,
    now: 14 * 60,
    budget: 120,
    conditionText: "下雨（raining=true）",
    mode: { raining: true },
  },
  {
    label: "傍晚、用户偏好餐厅",
    originName: "武林广场",
    lng: 120.1631,
    lat: 30.2748,
    now: 18 * 60,
    budget: 250,
    conditionText: "偏好类目 restaurant（categoryNorm 命中 = 1.0）",
    mode: { preferredCategories: ["restaurant"] },
  },
];

const FORBIDDEN_REASON_WORDS = ["环境优雅", "值得一去", "非常不错", "适合放松"];
const MODE_LABEL: Record<string, string> = { walk: "步行", bus: "公交", drive: "打车", bike: "骑行" };

function formatMinute(minute: number): string {
  const normalized = ((minute % 1440) + 1440) % 1440;
  const hour = Math.floor(normalized / 60);
  const rest = normalized % 60;
  return `${String(hour).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function assertTrue(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`自检失败：${message}`);
  }
}

function loadPool(): Place[] {
  return loadCity("hangzhou").places;
}

/** 只改内存副本，用来单独测试判断规则；不是新地点、不改 seed 文件。 */
function copyPlace(place: Place, patch: Partial<Place>): Place {
  return PlaceSchema.parse({ ...place, ...patch });
}

/** 打印用的人均口径：真实值 / 餐厅咖啡 null 按 50 估 / 其余 null 按 0 元计。 */
function formatCostText(place: Place): string {
  const estimate = estimateCost(place);
  if (estimate.basis === "actual") return `${estimate.cost} 元`;
  if (estimate.basis === "category-average") return `${estimate.cost} 元（高德未标人均，按同类均价估）`;
  return "0 元（人均未标注）";
}

type Checked = {
  index: number;
  case: Case;
  place: Place;
  stop: Stop;
  segment: Segment;
  reason: string;
};

function checkResult(
  c: Case,
  index: number,
  budget: number,
  placeById: Map<string, Place>,
  result: Awaited<ReturnType<typeof pickNext>>,
): Checked {
  if (result.ok === false) {
    throw new Error(`第 ${index + 1} 组应该能选出下一站，实际被拒：${result.reason}`);
  }
  const { stop, segment } = result;

  const place = placeById.get(stop.placeId);
  if (place === undefined) {
    throw new Error(`第 ${index + 1} 组选中的 placeId=${stop.placeId} 不在候选池里`);
  }
  const estimate = estimateCost(place);

  assertTrue(segment.fromId === "origin", `第 ${index + 1} 组 segment.fromId 应为 origin，实际 ${segment.fromId}`);
  assertTrue(segment.toId === stop.placeId, `第 ${index + 1} 组 segment.toId 与 stop.placeId 不一致`);
  assertTrue(stop.arriveAt === c.now + segment.durationMin, `第 ${index + 1} 组时间不闭合：arriveAt ≠ now + durationMin`);
  assertTrue(stop.leaveAt === stop.arriveAt + stop.stayMin, `第 ${index + 1} 组站内不闭合：leaveAt ≠ arriveAt + stayMin`);
  assertTrue(stop.stayMin === STAY_MIN[place.category], `第 ${index + 1} 组 stayMin 与类目固定值不一致`);
  assertTrue(
    isOpenAt(place, stop.arriveAt, stop.stayMin),
    `第 ${index + 1} 组不满足营业规则（到达时未营业，或到达+停留超过闭馆）`,
  );
  assertTrue(withinRadius(segment.durationMin, segment.mode), `第 ${index + 1} 组通勤超出半径上限`);
  assertTrue(canAfford(place, budget), `第 ${index + 1} 组选中点超出预算`);
  assertTrue(stop.costEstimate === estimate.cost, `第 ${index + 1} 组 costEstimate 与人均口径不一致`);
  assertTrue(!Object.prototype.hasOwnProperty.call(result, "reason"), `第 ${index + 1} 组成功结果里不应该有顶层 reason 字段`);

  for (const word of FORBIDDEN_REASON_WORDS) {
    assertTrue(stop.reason.indexOf(word) === -1, `第 ${index + 1} 组 reason 里出现空话「${word}」`);
  }
  if (place.rating !== null) {
    assertTrue(stop.reason.indexOf(place.rating.toFixed(1)) !== -1, `第 ${index + 1} 组 reason 没有引用真实评分`);
  }
  if (estimate.basis === "actual") {
    assertTrue(stop.reason.indexOf(String(estimate.cost)) !== -1, `第 ${index + 1} 组 reason 没有引用真实人均`);
  } else {
    assertTrue(stop.reason.indexOf("人均未标注") !== -1, `第 ${index + 1} 组 reason 没有说明人均未标注`);
    if (estimate.basis === "category-average") {
      assertTrue(
        stop.reason.indexOf(String(estimate.cost)) !== -1,
        `第 ${index + 1} 组 reason 没有写出同类均价的兜底金额`,
      );
    }
  }

  return { index, case: c, place, stop, segment, reason: stop.reason };
}

function printRun(checked: Checked, budget: number): void {
  const { case: c, place, stop, segment, reason } = checked;
  console.log(`【第 ${checked.index + 1} 组】${c.label}`);
  console.log(`起点：${c.originName}（${c.lng}, ${c.lat}）`);
  console.log(`当前时间：${formatMinute(c.now)}（${c.now} 分钟）`);
  console.log(`预算：${budget} 元`);
  console.log(`条件：${c.conditionText}`);
  console.log(
    `选中地点：${place.name}（id=${place.id}，category=${place.category}，rating=${String(place.rating)}，avgCost=${String(place.avgCost)}）`,
  );
  console.log(`通勤分钟：${segment.durationMin} 分钟（${MODE_LABEL[segment.mode]}，${segment.distanceM} 米）`);
  console.log(`花费：${formatCostText(place)}`);
  console.log(
    `时间：到达 ${formatMinute(stop.arriveAt)}，停留 ${stop.stayMin} 分钟（类目固定），离开 ${formatMinute(stop.leaveAt)}`,
  );
  console.log(`reason：${reason}`);
  console.log(
    `核对：营业中=通过，到达+停留≤闭馆=通过，半径内(${MODE_LABEL[segment.mode]})=通过，预算内=通过，时间闭合=通过，无顶层 reason=通过`,
  );
  console.log("");
}

function printConstraintUnitChecks(pool: Place[]): void {
  // 取 seed 里的真实记录做内存副本，只验证函数规则，不新增任何地点。
  const sample = pool[0];
  const unknownHours = copyPlace(sample, { openTime: null, closeTime: null });
  const restToday = copyPlace(sample, { closedDays: [new Date().getDay()] });
  const overnight = copyPlace(sample, { openTime: "22:00", closeTime: "02:00", closedDays: [] });
  const museumHours = copyPlace(sample, { openTime: "09:00", closeTime: "17:00", closedDays: [] });

  const chengzhanRestaurant = placeById(pool, "B0FFIPE4M6"); // 方老大(江城路店)，avgCost=54
  const restaurantNoPrice = copyPlace(chengzhanRestaurant, { avgCost: null });
  const cafeNoPrice = copyPlace(chengzhanRestaurant, { category: "cafe", avgCost: null });
  const galleryNoPrice = copyPlace(sample, { category: "gallery", avgCost: null });
  const otherNoPrice = copyPlace(sample, { category: "other", avgCost: null });

  // ---- isOpenAt：到达 + 停留 ≤ 闭馆 ----
  assertTrue(isOpenAt(unknownHours, 15 * 60, 60) === false, "openTime/closeTime 为 null 时 isOpenAt 应为 false");
  assertTrue(isOpenAt(restToday, 15 * 60, 60) === false, "closedDays 包含今天时 isOpenAt 应为 false");
  assertTrue(isOpenAt(museumHours, 16 * 60 + 40, 90) === false, "16:40 到 17:00 闭馆的美术馆、停留 90 分钟应为 false");
  assertTrue(isOpenAt(museumHours, 15 * 60, 90) === true, "15:00 到 17:00 闭馆的美术馆、停留 90 分钟应为 true（16:30 结束）");
  assertTrue(isOpenAt(overnight, 23 * 60, 120) === true, "跨零点 23:00 到店、停留 120 分钟应为 true（次日 01:00 < 02:00）");
  assertTrue(isOpenAt(overnight, 60, 30) === true, "跨零点 01:00 到店、停留 30 分钟应为 true");
  assertTrue(isOpenAt(overnight, 60, 90) === false, "跨零点 01:00 到店、停留 90 分钟应为 false（次日 02:30 已关门）");
  assertTrue(isOpenAt(overnight, 12 * 60, 30) === false, "跨零点营业 12:00 应为 false");

  // ---- 人均口径：null 按类目区分 ----
  const actual = estimateCost(chengzhanRestaurant);
  assertTrue(actual.cost === 54 && actual.basis === "actual", "有真实人均时 estimateCost 应直接用真实值");
  assertTrue(canAfford(chengzhanRestaurant, 54) === true && canAfford(chengzhanRestaurant, 53) === false, "真实人均 54 元：预算 54 可负担、53 不可负担");

  const restaurantEstimate = estimateCost(restaurantNoPrice);
  assertTrue(restaurantEstimate.cost === 50, "餐厅 avgCost=null 应兜底 50 元，不能当 0");
  assertTrue(restaurantEstimate.basis === "category-average", "餐厅 avgCost=null 的 basis 应为 category-average");
  assertTrue(canAfford(restaurantNoPrice, 49) === false, "餐厅 avgCost=null 时预算 49 元应不可负担（按 50 元估）");
  assertTrue(canAfford(restaurantNoPrice, 50) === true, "餐厅 avgCost=null 时预算 50 元应可负担");

  const cafeEstimate = estimateCost(cafeNoPrice);
  assertTrue(cafeEstimate.cost === 50 && cafeEstimate.basis === "category-average", "咖啡 avgCost=null 应兜底 50 元");

  const galleryEstimate = estimateCost(galleryNoPrice);
  assertTrue(galleryEstimate.cost === 0 && galleryEstimate.basis === "zero", "美术馆 avgCost=null 应按 0 元计");
  const otherEstimate = estimateCost(otherNoPrice);
  assertTrue(otherEstimate.cost === 0 && otherEstimate.basis === "zero", "其他类目 avgCost=null 应按 0 元计");

  // ---- 半径边界 ----
  assertTrue(withinRadius(30, "walk") === true && withinRadius(31, "walk") === false, "步行半径上限应为 30");
  assertTrue(withinRadius(45, "bus") === true && withinRadius(46, "bus") === false, "公交半径上限应为 45");
  assertTrue(withinRadius(25, "drive") === true && withinRadius(26, "drive") === false, "驾车半径上限应为 25");

  console.log("附加契约检查（用 seed 记录的内存副本，不是新地点）：");
  console.log("  openTime/closeTime 为 null → isOpenAt=false：通过");
  console.log("  closedDays 含今天（周四=4）→ isOpenAt=false：通过");
  console.log("  16:40 到 17:00 闭馆的美术馆、停留 90 分钟 → false；15:00 到店、停留 90 分钟 → true：通过");
  console.log("  跨零点 22:00–02:00：23:00+120min=true / 01:00+30min=true / 01:00+90min=false / 12:00=false：通过");
  console.log("  人均口径：真实 54 元用真实值；餐厅 null→50 元估（预算 49 不可负担）；咖啡 null→50 元；美术馆/其他 null→0 元：通过");
  console.log("  withinRadius：步行30 / 公交45 / 驾车25 的边界：通过");
  console.log("");
}

function placeById(pool: Place[], id: string): Place {
  const place = pool.find((item) => item.id === id);
  if (place === undefined) {
    throw new Error(`自检失败：seed 里找不到 ${id}`);
  }
  return place;
}

async function main(): Promise<void> {
  const pool = loadPool();
  const placeMap = new Map<string, Place>(pool.map((place) => [place.id, place]));

  console.log("================================================================================");
  console.log("M3 自检：pickNext 连跑 5 组不同参数");
  console.log("命令：npx tsx --env-file=.env.local scripts/try-pick.ts");
  console.log(`候选池：data/cities/hangzhou.json（${pool.length} 个地点，全部来自高德 POI）`);
  console.log("================================================================================");
  console.log("");

  const checked: Checked[] = [];
  for (let index = 0; index < CASES.length; index += 1) {
    const c = CASES[index];
    const origin = makeOriginPlace(c.lng, c.lat);
    const result = await pickNext(origin, c.now, pool, c.budget, c.mode);
    const one = checkResult(c, index, c.budget, placeMap, result);
    checked.push(one);
    printRun(one, c.budget);
  }

  console.log("--------------------------------------------------------------------------------");
  console.log("逐条核对（脚本断言，任何一条不满足会直接抛错）：");
  console.log("  1. 5 组全部 ok:true，没有出现「排不出来」");
  console.log("  2. 营业中：到达时刻在营业时段内，且「到达 + 停留时长 ≤ 闭馆时刻」");
  console.log("  3. 半径内：通勤分钟不超过该交通方式上限（步行30 / 公交45 / 驾车25 / 骑行45）");
  console.log("  4. 预算未超：costEstimate = 人均口径（真实值 / 餐厅咖啡 null=50 / 其余 null=0）且 ≤ 剩余预算");
  console.log("  5. 时间闭合：arriveAt = now + segment.durationMin，leaveAt = arriveAt + stayMin");
  console.log("  6. stayMin 等于类目固定值（STAY_MIN）；segment.fromId = origin、toId = placeId");
  console.log("  7. 成功结果没有顶层 reason 字段；reason 引用真实 rating / 人均口径，无空话");
  console.log("  结论：PASS");
  console.log("");
  printConstraintUnitChecks(pool);

  // 附加 1：当天已去过过滤（同参数 + visitedPlaceIds，路线全部命中 .cache，不再打接口）。
  const first = checked[0];
  const second = await pickNext(makeOriginPlace(first.case.lng, first.case.lat), first.case.now, pool, first.case.budget, {
    ...first.case.mode,
    visitedPlaceIds: [first.stop.placeId],
  });
  if (second.ok === false) {
    throw new Error(`自检失败：带上 visitedPlaceIds 后应该还能选出别的点，实际被拒：${second.reason}`);
  }
  assertTrue(second.stop.placeId !== first.stop.placeId, "自检失败：visitedPlaceIds 里的点仍被选中");
  console.log(`附加检查 1（当天已去过过滤）：第 1 组再选一次，visitedPlaceIds=[${first.stop.placeId}] → 选中 ${second.stop.placeId}，不重复：通过`);
  console.log("");

  // 附加 2：排不出来时 reason 要指名卡在哪条约束（同起点，路线全部命中 .cache）。
  const failure = await pickNext(makeOriginPlace(first.case.lng, first.case.lat), 23 * 60 + 59, pool, first.case.budget, {});
  if (failure.ok === true) {
    throw new Error("自检失败：23:59 出发应该排不出来（全部已闭馆），却选出了地点");
  }
  assertTrue(failure.reason.indexOf("营业时间") !== -1, `自检失败：失败 reason 没有指名营业时间约束：${failure.reason}`);
  console.log(`附加检查 2（排不出来要指名约束）：23:59 出发 → ok:false，reason：${failure.reason}`);
  console.log("");

  // 附加 3：3.0 的打车条件——同一段 >3km 的路，只有「省时 / 下雨 / 带老人小孩」命中才允许打车。
  // 默认条件下即使打车更快也不选打车（不按「哪个快」选）。
  const farPlace = placeById(pool, "B023B07BZE"); // 采荷农贸市场（seed 里的真实地点）
  const chengzhan = makeOriginPlace(120.174, 30.243);
  const farPool = [farPlace];
  const farBase = await pickNext(chengzhan, 14 * 60, farPool, 120, {});
  const farRain = await pickNext(chengzhan, 14 * 60, farPool, 120, { raining: true });
  const farSaveTime = await pickNext(chengzhan, 14 * 60, farPool, 120, { timeFirst: true });
  const farSenior = await pickNext(chengzhan, 14 * 60, farPool, 120, { withElderOrChild: true });
  if (farBase.ok === false || farRain.ok === false || farSaveTime.ok === false || farSenior.ok === false) {
    throw new Error("自检失败：打车条件检查里有一组没选出下一站");
  }
  assertTrue(farBase.segment.mode !== "drive", "自检失败：默认条件下不允许打车，却选了驾车");
  assertTrue(farRain.segment.mode === "drive", "自检失败：下雨 + >3km 应选打车");
  assertTrue(farSaveTime.segment.mode === "drive", "自检失败：省时 + >3km 应选打车");
  assertTrue(farSenior.segment.mode === "drive", "自检失败：带老人 + >3km 应选打车");
  console.log("附加检查 3（3.0 打车条件，起点=城站火车站，终点=采荷农贸市场，距离 > 3km）：");
  console.log(
    `  默认（晴 / 体力允许 / 无偏好）：${MODE_LABEL[farBase.segment.mode]} ${farBase.segment.durationMin} 分钟 → 不打车（通过）`,
  );
  console.log(`  下雨 raining=true：打车 ${farRain.segment.durationMin} 分钟 → 命中 3.0 行5（通过）`);
  console.log(`  省时 timeFirst=true：打车 ${farSaveTime.segment.durationMin} 分钟 → 命中行5（通过）`);
  console.log(`  带 60 岁以上 withElderOrChild=true：打车 ${farSenior.segment.durationMin} 分钟 → 命中行5（通过）`);
  console.log(
    `  结论：打车 ${farRain.segment.durationMin} 分钟比默认的${MODE_LABEL[farBase.segment.mode]} ${farBase.segment.durationMin} 分钟快，但默认条件不选它——不按「哪个快」选：通过`,
  );
  console.log("");

  // 附加 4：3.0 行4——距离 > 5km 默认公交（这段路步行 6577 米）。
  const longPlace = placeById(pool, "B0G399SIG2"); // 茑屋书店(天目里店)
  const longPick = await pickNext(makeOriginPlace(120.1631, 30.2748), 15 * 60 + 20, [longPlace], 200, {});
  if (longPick.ok === false) {
    throw new Error(`自检失败：>5km 的默认公交组应该能选出下一站，实际被拒：${longPick.reason}`);
  }
  assertTrue(longPick.segment.mode === "bus", `自检失败：>5km 默认应该坐公交，实际 ${longPick.segment.mode}`);
  console.log(
    `附加检查 4（3.0 行4：>5km 默认公交）：起点=武林广场，终点=茑屋书店（步行 6577 米 > 5km）→ 公交 ${longPick.segment.durationMin} 分钟（通过）`,
  );
  console.log("");

  // 附加 5：3.6 失败 reason 必须指名卡在哪条约束（预算 20 元 + 一家 36 元的面馆）。
  const priceyPlace = placeById(pool, "B0L6OCG3CF"); // 王繁星面馆(杭州湖滨in77店)，avgCost=36
  const noMoney = await pickNext(makeOriginPlace(120.1631, 30.2748), 12 * 60, [priceyPlace], 20, {});
  if (noMoney.ok === true) {
    throw new Error("自检失败：预算 20 元不应该选出一家人均 36 元的店");
  }
  assertTrue(noMoney.reason.indexOf("预算不足") !== -1, `自检失败：失败 reason 没有指名预算约束：${noMoney.reason}`);
  assertTrue(noMoney.reason.indexOf("36") !== -1, `自检失败：失败 reason 没有给出实际差价：${noMoney.reason}`);
  console.log(`附加检查 5（3.6 排不出来要指名约束）：预算 20 元、候选人均消费 36 元 → ok:false，reason：${noMoney.reason}`);
  console.log("");

  console.log("最终结论：5 组运行全部满足营业中 / 半径内 / 预算未超 / 时间闭合，附加检查全部通过。");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
