/**
 * 环线形状自检（本轮新增脚本，对应「下一步指令.md」第一步验收 1–5 与回归 16）。
 *
 * 目的：把「每站到 origin 的直线距离序列」打印出来，并逐组判定
 *   1) 距离序列单调不减（允许 ≤10% 回退）；
 *   2) 第 1 站是否就是最近的合规点（importance ≥2 或 rating ≥3.5）；
 *   3) 站点之间不出现「同一片区域去两次」（同类目 800m / 非相邻 800m）。
 *
 * 用法（AMAP_KEY 只在服务端环境变量里，不进代码）：
 *   npx tsx --env-file=.env.local scripts/check-loopshape.ts                 # 只报告
 *   npx tsx --env-file=.env.local scripts/check-loopshape.ts --strict        # 不通过则退出码 1
 *   npx tsx --env-file=.env.local scripts/check-loopshape.ts --save <path>   # 额外落一份 JSON 快照
 *   npx tsx --env-file=.env.local scripts/check-loopshape.ts --sunset [--strict]
 *                                                                           # 傍晚 / 日落锚点冒烟
 *
 * 脚本只读 data/cities/<city>.json（经 lib/cityData.loadCity 读盘 + zod 校验）里的真实地点，
 * 不生成任何地点；起点要么是城市数据里的真实 POI，要么是城市配置里的圆心坐标。
 *
 * 2026-10-24 修订（本轮第一步）：第 1 站判定口径从「不看过滤的最近合规点」改成
 * 「最近的、能通过营业时间/预算/用餐时段过滤的合规点」，理由见 nearestFeasibleQualified 注释；
 * 另新增 --sunset 傍晚 / 日落锚点冒烟组（验收 17）。
 */
import { writeFileSync } from "node:fs";
import { loadCity } from "../lib/cityData";
import { makeOriginPlace } from "../lib/origin";
import { buildItinerary, estimateWalkMinutes, isFirstStopQualified, selectNearby, STAY_MIN } from "../lib/planner";
import { canAfford, isOpenAt, isOutdoorPlace } from "../lib/constraints";
import type { ItineraryConstraints } from "../lib/planner";
import type { CityData } from "../lib/cityData";
import type { Itinerary, Place } from "../types/schema";

const EARTH_RADIUS_M = 6371000;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function haversineMeters(
  left: { lng: number; lat: number },
  right: { lng: number; lat: number },
): number {
  const dLat = toRadians(right.lat - left.lat);
  const dLng = toRadians(right.lng - left.lng);
  const lat1 = toRadians(left.lat);
  const lat2 = toRadians(right.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function formatMinute(minute: number): string {
  const normalized = ((minute % 1440) + 1440) % 1440;
  const hour = Math.floor(normalized / 60);
  const rest = normalized % 60;
  return `${String(hour).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

const MODE_LABEL: Record<string, string> = { walk: "步行", bus: "公交", drive: "打车", bike: "骑行" };

/** 距离序列允许的回退比例（≤10%）。 */
const MAX_BACKTRACK_RATIO = 0.1;

/** 站点去重半径（本步收紧后是 800m：同类目、非相邻站都适用）。 */
const DEDUPE_RADIUS_M = 800;

/** 第 1 轮预筛数量：lib/planner.ts 的 PREFILTER_LIMIT（selectNearby 默认值就是 6）。 */
const FIRST_ROUND_PREFILTER_LIMIT = 6;

/** 正餐时段（与 lib/planner.ts 的 MEAL_WINDOWS 同口径，只在自检里复算可行性用）。 */
const MEAL_WINDOWS = [
  { start: 11 * 60 + 30, end: 13 * 60 + 30 },
  { start: 17 * 60 + 30, end: 19 * 60 + 30 },
];

type Group = {
  key: string;
  label: string;
  city: string;
  /** 城市数据里的真实 POI 当起点；省略 = 用城市配置的圆心坐标。 */
  originPlaceId?: string;
  /** 自定义起点坐标（与 originPlaceId 二选一）。 */
  originCoords?: { lng: number; lat: number; name: string };
  startAt: number;
  budget: number;
  /** 想走多久（分钟）；省略 = 用城市配置的 maxTotalMin。 */
  durationMin?: number;
};

const GROUPS: Group[] = [
  {
    key: "hz-1520",
    label: "杭州 15:20 起点=茑屋书店(天目里店)",
    city: "hangzhou",
    originPlaceId: "B0G399SIG2",
    startAt: 15 * 60 + 20,
    budget: 200,
  },
  {
    key: "hz-1100",
    label: "杭州 11:00 起点=武林广场（覆盖午餐）",
    city: "hangzhou",
    originCoords: { lng: 120.1631, lat: 30.2748, name: "武林广场" },
    startAt: 11 * 60,
    budget: 150,
  },
  {
    key: "hz-0900",
    label: "杭州 09:00 起点=湖滨银泰 in77",
    city: "hangzhou",
    originCoords: { lng: 120.163, lat: 30.255, name: "湖滨银泰 in77" },
    startAt: 9 * 60,
    budget: 300,
    durationMin: 240,
  },
  {
    key: "ly-1520",
    label: "辽阳 15:20 起点=城市配置圆心（回归 16）",
    city: "liaoyang",
    startAt: 15 * 60 + 20,
    budget: 200,
  },
  {
    key: "ly-0900",
    label: "辽阳 09:00 起点=城市配置圆心",
    city: "liaoyang",
    startAt: 9 * 60,
    budget: 200,
    durationMin: 240,
  },
];

type StopRecord = {
  placeId: string;
  placeName: string;
  category: string;
  rating: number | null;
  importance: number | null;
  arriveAt: number;
  stayMin: number;
  distanceFromOriginM: number;
  mode: string;
  durationMin: number;
};

type GroupResult = {
  key: string;
  label: string;
  city: string;
  startAt: number;
  ok: boolean;
  reason: string | null;
  origin: { name: string; lng: number; lat: number };
  stops: StopRecord[];
  placeIds: string[];
  distances: number[];
  totalMin: number;
  totalCost: number;
  endAt: number;
  /** 单调性判定：false 时 backtracked 指出第一个违反的位置。 */
  monotonic: boolean;
  backtrackText: string | null;
  /** 第 1 站是否就是最近的合规点。 */
  firstStopNearestQualified: boolean;
  firstStopText: string;
  /** 去重判定：非相邻站之间是否出现 800m 内重复。 */
  dedupeOk: boolean;
  dedupeText: string | null;
  elapsedMs: number;
};

/**
 * 第 1 站的候选池（与 planner 第 1 轮完全同口径）：
 * 剔掉 origin 后按「估算步行分钟」取最近的 6 个（lib/planner.ts 导出的 selectNearby，
 * 默认 limit 就是 PREFILTER_LIMIT=6）。第 1 站只可能从这 6 个里选。
 */
function firstRoundPool(pool: Place[], origin: Place): Place[] {
  const excluded = new Set<string>();
  excluded.add(origin.id);
  return selectNearby(pool, origin, excluded, FIRST_ROUND_PREFILTER_LIMIT);
}

/** 餐厅停留窗口是否压到某个正餐时段（与 lib/planner.ts 的 mealSlotFor 同口径）。 */
function mealSlotOf(arriveAt: number, stayMin: number): number | null {
  for (const window of MEAL_WINDOWS) {
    if (arriveAt < window.end && arriveAt + stayMin > window.start) return window.start;
  }
  return null;
}

/**
 * 「最近的合规点」判定口径（本脚本 2026-10-24 修订，**比原口径更严**）：
 *
 * 任务书原文是「第 1 站必须是最近的合规点（importance ≥2 或 rating ≥3.5）」，
 * 而 Lead 给 planner 的落地口径是「最近的**通过全部过滤**的合规点」——即「合规」必须和「排得进去」
 * 一致。原口径（纯直线距离、不看过滤）会拿永远排不进去的点当基准，例如 hz-1520 的
 * 浙江省工业创意产业中心（788m，importance=2，但 category=other + openTime=null → 营业时间过滤恒 false），
 * 这样「最近合规点」和「通过营业时间过滤」两条要求自相矛盾。
 *
 * 所以这里按 pickNext 第 1–5 步过滤做本地复算，取「最近的、真的能排进去的合规点」：
 *   - 合规：importance ≥2 或 rating ≥3.5（直接复用 lib/planner.ts 导出的 isFirstStopQualified，
 *     避免两处口径漂移）；
 *   - 营业时间：用「出发 + 估算步行分钟」近似到达时刻（估算比真实骑行/公交偏慢，只会更严格）；
 *   - 预算：canAfford 同口径；
 *   - 用餐时段：餐厅的停留窗口必须压到某个正餐时段（mealSlotOf 同口径）。
 * 半径 / 已去过这两步没法在本地精确复算；但第 1 轮池子里都是 3–4km 内最近的点，
 * 实际实现若选了别的点，检查会 FAIL 并同时打印「实际 / 基准」两边距离，便于人工核对。
 *
 * 另：planner 的 pickNext 内部还有「同类目 800m 只留高分一个」的候选去重，会让基准点在同片区里
 * 换成另一个点；两者直线距离差通常 <1%，所以下面沿用 ≤5% 的容差，不因此放宽判定。
 */
function nearestFeasibleQualified(
  pool: Place[],
  origin: Place,
  startAt: number,
  budget: number,
): { place: Place; distanceM: number } | null {
  let best: { place: Place; distanceM: number } | null = null;
  for (const place of pool) {
    if (!isFirstStopQualified(place)) continue;
    const arriveAt = startAt + Math.ceil(estimateWalkMinutes(origin, place));
    const stayMin = STAY_MIN[place.category];
    if (!isOpenAt(place, arriveAt, stayMin)) continue;
    if (!canAfford(place, budget)) continue;
    if (place.category === "restaurant" && mealSlotOf(arriveAt, stayMin) === null) continue;
    const distanceM = haversineMeters(origin, place);
    if (best === null || distanceM < best.distanceM) best = { place, distanceM };
  }
  return best;
}

/** 参照信息：完全不看过滤的「最近的合规点」（只用于打印说明，不参与判定）。 */
function nearestQualifiedRaw(pool: Place[], origin: Place): { place: Place; distanceM: number } | null {
  let best: { place: Place; distanceM: number } | null = null;
  for (const place of pool) {
    if (!isFirstStopQualified(place)) continue;
    const distanceM = haversineMeters(origin, place);
    if (best === null || distanceM < best.distanceM) best = { place, distanceM };
  }
  return best;
}

async function runGroup(group: Group): Promise<GroupResult> {
  const city: CityData = loadCity(group.city);
  const pool = city.places;
  const originConfig = city.origin;

  let origin: Place;
  if (group.originPlaceId !== undefined) {
    const found = pool.find((place) => place.id === group.originPlaceId);
    if (found === undefined) throw new Error(`候选池里找不到起点 placeId=${group.originPlaceId}`);
    origin = found;
  } else if (group.originCoords !== undefined) {
    origin = makeOriginPlace(group.originCoords.lng, group.originCoords.lat, group.originCoords.name);
  } else {
    // 城市配置里的圆心（data/cities/<city>.json 的 origin）。
    origin = makeOriginPlace(originConfig.longitude, originConfig.latitude, `${city.displayName}（城市圆心）`);
  }

  const constraints: ItineraryConstraints = {
    budget: group.budget,
    pool,
    maxTotalMin: city.thresholds.maxTotalMin,
    mode: {},
    cityCode: city.cityCode,
    sunsetMinute: city.thresholds.sunsetMinute,
    lastEndMinute: city.thresholds.lastEndMinute,
  };
  if (group.durationMin !== undefined) constraints.durationMin = group.durationMin;

  const startedAt = Date.now();
  const result = await buildItinerary(origin, group.startAt, constraints);
  const elapsedMs = Date.now() - startedAt;

  const placeById = new Map<string, Place>(pool.map((place) => [place.id, place]));

  if (!("startAt" in result) || result.stops === undefined) {
    const failed = result as { ok: false; reason: string };
    return {
      key: group.key,
      label: group.label,
      city: group.city,
      startAt: group.startAt,
      ok: false,
      reason: failed.reason,
      origin: { name: origin.name, lng: origin.lng, lat: origin.lat },
      stops: [],
      placeIds: [],
      distances: [],
      totalMin: 0,
      totalCost: 0,
      endAt: group.startAt,
      monotonic: true,
      backtrackText: null,
      firstStopNearestQualified: false,
      firstStopText: "没有排出行程",
      dedupeOk: true,
      dedupeText: null,
      elapsedMs,
    };
  }

  const itinerary = result as Itinerary;
  const stops: StopRecord[] = [];
  const distances: number[] = [];
  for (let index = 0; index < itinerary.stops.length; index += 1) {
    const stop = itinerary.stops[index];
    const place = placeById.get(stop.placeId);
    if (place === undefined) throw new Error(`行程里出现候选池外的 placeId=${stop.placeId}`);
    const distanceM = haversineMeters(origin, place);
    const segment = itinerary.segments[index];
    distances.push(distanceM);
    stops.push({
      placeId: stop.placeId,
      placeName: place.name,
      category: place.category,
      rating: place.rating,
      importance: place.importance === undefined ? null : place.importance,
      arriveAt: stop.arriveAt,
      stayMin: stop.stayMin,
      distanceFromOriginM: Math.round(distanceM),
      mode: segment === undefined ? "-" : segment.mode,
      durationMin: segment === undefined ? 0 : segment.durationMin,
    });
  }

  // 单调不减（允许 ≤10% 回退）。
  let monotonic = true;
  let backtrackText: string | null = null;
  for (let index = 1; index < distances.length; index += 1) {
    const previous = distances[index - 1];
    const current = distances[index];
    if (previous === 0) continue;
    const ratio = (current - previous) / previous;
    if (ratio < -MAX_BACKTRACK_RATIO) {
      monotonic = false;
      if (backtrackText === null) {
        backtrackText = `第 ${index}→${index + 1} 站回退 ${(Math.abs(ratio) * 100).toFixed(1)}%（${Math.round(previous)}m → ${Math.round(current)}m）`;
      }
    }
  }

  // 第 1 站是不是「最近的、能排进去的合规点」。
  //
  // 判定口径（见 nearestFeasibleQualified 的注释）：
  // 1) 候选池 = 第 1 轮预筛后的 6 个（全局池 / 餐厅池各算一份）；
  // 2) 基准 = 池子里最近的「合规 + 通过营业时间/预算/用餐时段过滤」的点；
  // 3) 第一轮如果正好是「强制用餐轮」（autoMealWindow 判定这一轮必须把正餐时段安排掉），
  //    pickNext 的候选池只有餐厅，这时认餐厅基准；
  // 4) 参照池里没有「合规 + 可排」的点时，planner 会退回打分逻辑，最近性无法断言，
  //    退化成「首站必须合规」（这是任务书明确允许的兜底分支）。
  const firstPool = firstRoundPool(pool, origin);
  const firstRestaurantPool = firstRoundPool(
    pool.filter((place) => place.category === "restaurant"),
    origin,
  );
  const nearestFeasible = nearestFeasibleQualified(firstPool, origin, group.startAt, group.budget);
  const nearestRestaurantFeasible = nearestFeasibleQualified(
    firstRestaurantPool,
    origin,
    group.startAt,
    group.budget,
  );
  // 参照信息（不参与判定）：完全不看过滤的最近合规点——用来说明「为什么不是它」。
  const nearestRaw = nearestQualifiedRaw(firstPool, origin);
  const nearestRestaurantRaw = nearestQualifiedRaw(firstRestaurantPool, origin);
  let firstStopNearestQualified = false;
  let firstStopText: string;
  if (stops.length === 0) {
    firstStopText = "没有排出行程";
  } else {
    const firstStop = stops[0];
    const firstPlace = placeById.get(firstStop.placeId);
    const firstDistance = firstStop.distanceFromOriginM;
    const describe = (item: { place: Place; distanceM: number } | null): string =>
      item === null
        ? "无"
        : `${item.place.name}（${Math.round(item.distanceM)}m，rating=${String(item.place.rating)}，importance=${String(item.place.importance)}）`;
    // 距离相差 ≤5% 视为「同一个点或同一圈位置」（pickNext 内部同类目 800m 去重会换同片区的点）。
    const closeTo = (item: { place: Place; distanceM: number } | null): boolean =>
      item !== null && Math.abs(firstDistance - item.distanceM) / Math.max(1, item.distanceM) <= 0.05;
    const isRestaurant = firstPlace !== undefined && firstPlace.category === "restaurant";
    const matchedGlobal = closeTo(nearestFeasible);
    const matchedRestaurant = isRestaurant && closeTo(nearestRestaurantFeasible);
    // 参照池里没有合规 + 可排的点 → planner 退回打分逻辑，只要求首站本身合规。
    const fallbackScoring = isRestaurant ? nearestRestaurantFeasible === null : nearestFeasible === null;
    firstStopNearestQualified =
      matchedGlobal ||
      matchedRestaurant ||
      (fallbackScoring && firstPlace !== undefined && isFirstStopQualified(firstPlace));
    const which = matchedGlobal
      ? "全局最近的可排合规点"
      : matchedRestaurant
        ? "最近的可排合规餐厅（首轮为强制用餐轮）"
        : fallbackScoring
          ? "参照池无合规可排点，退回打分兜底（仅要求首站合规）"
          : "未命中";
    firstStopText =
      `第 1 站 ${firstStop.placeName} ${firstDistance}m（判定依据：${which}；` +
      `最近的**可排**合规点：${describe(nearestFeasible)}；最近的**可排**合规餐厅：${describe(nearestRestaurantFeasible)}；` +
      `不看过滤的最近合规点（参照）：${describe(nearestRaw)}；不看过滤的最近合规餐厅（参照）：${describe(nearestRestaurantRaw)}）`;
  }

  // 去重（任务书第一步「站点去重收紧」的口径，逐字对应）：
  //   1) 同类目 + 直线 <800m 的任意两站都不允许（含第 1、2 站）；
  //   2) 第 3 站及以后，不能出现在**前序任一站**的 800m 内（不分同类目）。
  // 第 1、2 站之间只受 (1) 约束——「相邻站 800m 内是合理的」指的就是这一段。
  let dedupeOk = true;
  let dedupeText: string | null = null;
  for (let index = 0; index < stops.length; index += 1) {
    const current = stops[index];
    const currentPlace = placeById.get(current.placeId);
    if (currentPlace === undefined) continue;
    for (let prior = 0; prior < index; prior += 1) {
      const previous = stops[prior];
      const previousPlace = placeById.get(previous.placeId);
      if (previousPlace === undefined) continue;
      const distanceM = haversineMeters(previousPlace, currentPlace);
      if (distanceM >= DEDUPE_RADIUS_M) continue;
      const stopNumber = index + 1;
      const sameCategory = previousPlace.category === currentPlace.category;
      const violation = stopNumber >= 3 || sameCategory;
      if (!violation) continue;
      dedupeOk = false;
      const kind = stopNumber >= 3 ? `第 ${stopNumber} 站，非相邻 ` : "同类目 ";
      if (dedupeText === null) {
        dedupeText = `第 ${prior + 1} 站「${previous.placeName}」与第 ${stopNumber} 站「${current.placeName}」相距 ${Math.round(distanceM)}m（${kind}<${DEDUPE_RADIUS_M}m）`;
      }
    }
  }

  return {
    key: group.key,
    label: group.label,
    city: group.city,
    startAt: group.startAt,
    ok: true,
    reason: null,
    origin: { name: origin.name, lng: origin.lng, lat: origin.lat },
    stops,
    placeIds: itinerary.stops.map((stop) => stop.placeId),
    distances: distances.map((value) => Math.round(value)),
    totalMin: itinerary.totalMin,
    totalCost: itinerary.totalCost,
    endAt: itinerary.endAt,
    monotonic,
    backtrackText,
    firstStopNearestQualified,
    firstStopText,
    dedupeOk,
    dedupeText,
    elapsedMs,
  };
}

function printGroup(result: GroupResult): void {
  console.log("");
  console.log(`【${result.key}】${result.label}`);
  console.log(
    `  起点：${result.origin.name}（${result.origin.lng}, ${result.origin.lat}）；出发 ${formatMinute(result.startAt)}`,
  );
  if (!result.ok) {
    console.log(`  结果：ok:false —— ${String(result.reason)}`);
    return;
  }
  console.log(
    `  结果：${result.stops.length} 站 / ${result.totalMin} 分钟 / ${result.totalCost} 元 / 回到终点 ${formatMinute(result.endAt)}（耗时 ${result.elapsedMs} ms）`,
  );
  console.log(`  placeId 列表：${result.placeIds.join(", ")}`);
  console.log("  逐站：");
  for (let index = 0; index < result.stops.length; index += 1) {
    const stop = result.stops[index];
    console.log(
      `    ${index + 1}. ${formatMinute(stop.arriveAt)}  ${stop.placeName}（${stop.category}，rating=${String(stop.rating)}，importance=${String(stop.importance)}）` +
        `  → 距起点 ${stop.distanceFromOriginM} 米，${MODE_LABEL[stop.mode] ?? stop.mode} ${stop.durationMin} 分钟，停 ${stop.stayMin} 分钟`,
    );
  }
  console.log(`  距离序列（米）：${result.distances.join(" → ")}`);
  console.log(
    `  [1] 单调不减（≤10% 回退）：${result.monotonic ? "PASS" : `FAIL —— ${String(result.backtrackText)}`}`,
  );
  console.log(`  [2] 第 1 站 = 最近合规点：${result.firstStopNearestQualified ? "PASS" : "FAIL"} —— ${result.firstStopText}`);
  console.log(`  [3] 站点去重（同类目/非相邻 800m）：${result.dedupeOk ? "PASS" : `FAIL —— ${String(result.dedupeText)}`}`);
}

/* ------------------------------------------------------------------ *
 * 傍晚 / 日落锚点冒烟（任务书第一步第 4 条 + 验收 17）
 *
 * 前置逻辑（tryPlanSunsetReserved）的触发窗口是「出发时刻距锚定到达目标（日落前 10 分钟）
 * ≤90 分钟」。结构要求前缀站停留 ≥45 分钟，所以出发越晚越装不下：
 *   杭州日落 17:42 → 锚定目标 17:32；16:40 出发时前缀到达 16:4x，
 *   最早也要 17:2x 才能出发去日落点，再留 45 分钟已经晚于 17:32 → 前置结构必然失败、
 *   回退普通排程。这是改造前就存在的设计约束，不是本轮引入的。
 * 因此冒烟分两类：
 *   - 16:10（城市圆心）：锚定窗口内且装得下 → 必须能出行程，且能看到锚点站；
 *   - 16:40 / 17:00（城市圆心）：验证**不抛错、能出行程**（走普通排程也不许报错）。
 * 日落锚点是设计内例外：锚点站允许违反距离单调，其余站（前缀 / 晚餐 / 收尾）遵守 ×0.9 规则。
 * ------------------------------------------------------------------ */

type SunsetCase = {
  key: string;
  label: string;
  city: string;
  startAt: number;
  /** true = 这一组必须能看到锚点站（到达 = 日落前 10 分钟 + 户外日落点）。 */
  expectAnchor: boolean;
};

const SUNSET_CASES: SunsetCase[] = [
  {
    key: "hz-sunset-1610",
    label: "杭州 16:10 城市圆心（锚定窗口内，验证锚点路径）",
    city: "hangzhou",
    startAt: 16 * 60 + 10,
    expectAnchor: true,
  },
  {
    key: "hz-sunset-1640",
    label: "杭州 16:40 城市圆心（冒烟：不抛错 + 能出行程）",
    city: "hangzhou",
    startAt: 16 * 60 + 40,
    expectAnchor: false,
  },
  {
    key: "hz-sunset-1700",
    label: "杭州 17:00 城市圆心（冒烟：不抛错 + 能出行程）",
    city: "hangzhou",
    startAt: 17 * 60,
    expectAnchor: false,
  },
];

async function runSunsetCase(testCase: SunsetCase): Promise<string[]> {
  const failures: string[] = [];
  const city = loadCity(testCase.city);
  const pool = city.places;
  const origin = makeOriginPlace(
    city.origin.longitude,
    city.origin.latitude,
    `${city.displayName}（城市圆心）`,
  );
  const constraints: ItineraryConstraints = {
    budget: city.thresholds.defaultBudget,
    pool,
    maxTotalMin: city.thresholds.maxTotalMin,
    mode: {},
    cityCode: city.cityCode,
    sunsetMinute: city.thresholds.sunsetMinute,
    lastEndMinute: city.thresholds.lastEndMinute,
  };
  const anchorArriveAt = city.thresholds.sunsetMinute - 10;

  console.log("");
  console.log(`【${testCase.key}】${testCase.label}`);
  console.log(`  起点：${origin.name}；出发 ${formatMinute(testCase.startAt)}；日落 ${formatMinute(city.thresholds.sunsetMinute)}（锚定到达 ${formatMinute(anchorArriveAt)}）`);

  let itinerary: Itinerary | null = null;
  const startedAt = Date.now();
  try {
    const result = await buildItinerary(origin, testCase.startAt, constraints);
    if ("stops" in result) {
      itinerary = result as Itinerary;
    } else {
      failures.push(`${testCase.key}：排不出行程（${(result as { reason: string }).reason}）`);
      console.log(`  结果：ok:false —— ${(result as { reason: string }).reason}`);
      return failures;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${testCase.key}：抛错 —— ${message}`);
    console.log(`  结果：抛错 —— ${message}`);
    return failures;
  }
  const elapsedMs = Date.now() - startedAt;

  const placeById = new Map<string, Place>(pool.map((place) => [place.id, place]));
  const stops = itinerary.stops.map((stop) => {
    const place = placeById.get(stop.placeId);
    if (place === undefined) throw new Error(`行程里出现候选池外的 placeId=${stop.placeId}`);
    return { stop, place, distanceM: haversineMeters(origin, place) };
  });
  if (stops.length === 0) {
    failures.push(`${testCase.key}：行程 0 站`);
    return failures;
  }

  const isAnchorStop = (item: { stop: Itinerary["stops"][number]; place: Place }): boolean =>
    item.stop.arriveAt === anchorArriveAt &&
    item.place.scenery !== undefined &&
    item.place.scenery.bestTime === "日落" &&
    isOutdoorPlace(item.place);
  const anchorIndexes = stops
    .map((item, index) => (isAnchorStop(item) ? index : -1))
    .filter((index) => index !== -1);

  console.log(
    `  结果：${stops.length} 站 / ${itinerary.totalMin} 分钟 / ${itinerary.totalCost} 元 / 回到终点 ${formatMinute(itinerary.endAt)}（耗时 ${elapsedMs} ms）`,
  );
  for (let index = 0; index < stops.length; index += 1) {
    const item = stops[index];
    const segment = itinerary.segments[index];
    console.log(
      `    ${index + 1}. ${formatMinute(item.stop.arriveAt)}-${formatMinute(item.stop.leaveAt)} ${item.place.name}（${item.place.category}）` +
        `  → 距起点 ${Math.round(item.distanceM)} 米，${segment === undefined ? "-" : (MODE_LABEL[segment.mode] ?? segment.mode)} ${segment === undefined ? 0 : segment.durationMin} 分钟，停 ${item.stop.stayMin} 分钟${isAnchorStop(item) ? "  <<< 日落锚点" : ""}`,
    );
  }
  console.log(`  距离序列（米）：${stops.map((item) => Math.round(item.distanceM)).join(" → ")}`);

  if (testCase.expectAnchor) {
    if (anchorIndexes.length === 0) {
      failures.push(`${testCase.key}：期望看到日落锚点站（到达 ${formatMinute(anchorArriveAt)} 的户外日落点），实际没有`);
      console.log("  [锚点] FAIL —— 期望看到锚点站，实际没有");
    } else {
      console.log(`  [锚点] PASS —— 第 ${anchorIndexes[0] + 1} 站是锚点（到达 ${formatMinute(anchorArriveAt)}）`);
    }
    // 锚点站是设计内例外；锚点之后的站要遵守「距离 ≥ 上一站 ×0.9（放宽档 0.75）」。
    if (anchorIndexes.length > 0) {
      const anchorIndex = anchorIndexes[0];
      let postAnchorOk = true;
      for (let index = anchorIndex + 1; index < stops.length; index += 1) {
        const ratio = stops[index].distanceM / Math.max(1, stops[index - 1].distanceM);
        if (ratio < 0.75 - 1e-9) {
          postAnchorOk = false;
          failures.push(
            `${testCase.key}：锚点之后的第 ${index + 1} 站距离回退到上一站的 ${(ratio * 100).toFixed(1)}%（<75%）`,
          );
        }
      }
      console.log(`  [锚点后距离] ${postAnchorOk ? "PASS" : "FAIL"} —— 锚点之后的站距离 ≥ 上一站 ×0.75`);
    }
  } else {
    console.log(
      `  [锚点] 不强制（本期出发时刻下前置结构装不下，按设计回退普通排程；看到锚点=${anchorIndexes.length > 0 ? "是" : "否"}）`,
    );
  }
  return failures;
}

async function runSunsetSmoke(strict: boolean): Promise<void> {
  console.log("=== 傍晚 / 日落锚点冒烟（不抛错 + 能出行程 + 锚点站可见性）===");
  const failures: string[] = [];
  for (const testCase of SUNSET_CASES) {
    failures.push(...(await runSunsetCase(testCase)));
  }
  console.log("");
  console.log("=== 日落冒烟汇总 ===");
  if (failures.length === 0) {
    console.log("结果：PASS（全部组不抛错、能出行程；16:10 组能看到日落锚点站）");
    return;
  }
  console.log(`结果：FAIL（${failures.length} 项）`);
  for (const failure of failures) console.log(`  - ${failure}`);
  if (strict) process.exit(1);
  console.log("（非 --strict 模式，仅供参考；验收时应加 --strict）");
}

function readFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  return value === undefined ? null : value;
}

async function main(): Promise<void> {
  const strict = process.argv.includes("--strict");
  const savePath = readFlag("--save");

  // --sunset：只跑傍晚 / 日落锚点冒烟组（验收 17）；不带参数：跑两城 5 组环线形状自检。
  if (process.argv.includes("--sunset")) {
    await runSunsetSmoke(strict);
    return;
  }

  console.log("=== 环线形状自检（每站到 origin 的直线距离序列 / 第 1 站合规性 / 站点去重）===");
  console.log(`组数：${GROUPS.length}（城市：${Array.from(new Set(GROUPS.map((group) => group.city))).join("、")}）`);

  const results: GroupResult[] = [];
  for (const group of GROUPS) {
    const result = await runGroup(group);
    results.push(result);
    printGroup(result);
  }

  const failures: string[] = [];
  for (const result of results) {
    if (!result.ok) continue;
    if (!result.monotonic) failures.push(`${result.key}：距离序列不单调（${String(result.backtrackText)}）`);
    if (!result.firstStopNearestQualified) failures.push(`${result.key}：第 1 站不是最近的合规点`);
    if (!result.dedupeOk) failures.push(`${result.key}：站点去重未通过（${String(result.dedupeText)}）`);
  }

  console.log("");
  console.log("=== 汇总 ===");
  for (const result of results) {
    if (!result.ok) {
      console.log(`  ${result.key}：ok:false（${String(result.reason)}）`);
      continue;
    }
    console.log(
      `  ${result.key}：距离 ${result.distances.join(" → ")}；单调 ${result.monotonic ? "PASS" : "FAIL"} / 首站 ${result.firstStopNearestQualified ? "PASS" : "FAIL"} / 去重 ${result.dedupeOk ? "PASS" : "FAIL"}`,
    );
  }

  if (savePath !== null) {
    writeFileSync(
      savePath,
      `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`,
      "utf8",
    );
    console.log(`\n快照已写入：${savePath}`);
  }

  if (failures.length > 0) {
    console.log(`\n结果：FAIL（${failures.length} 项）`);
    for (const failure of failures) console.log(`  - ${failure}`);
    if (strict) process.exit(1);
    console.log("（非 --strict 模式，仅供参考；验收时应加 --strict）");
    return;
  }
  console.log("\n结果：PASS（全部组通过单调性 / 首站合规 / 去重）");
}

main().catch((error: unknown) => {
  console.error(`FAIL: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
