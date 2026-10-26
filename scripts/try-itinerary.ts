/**
 * M4.5 性能自检脚本（M4 §4 三组 + M4.5 §5 度量）——2026-10-24 按当前契约刷新。
 *
 *  组 1 正常：起点=茑屋书店(天目里店)，startAt=920（15:20），budget=200
 *  组 2 覆盖午餐 + 预算 0：startAt=660（11:00），budget=0 → 必须 ok:false，reason 说「餐饮预算不足」
 *  组 3 时间很短：同组 1，maxTotalMin=90 → 最多 1 站
 *
 * 跑法（AMAP_KEY 只在服务端环境变量里）：
 *   npx tsx --env-file=.env.local scripts/try-itinerary.ts [组号]
 *
 * 冷缓存度量：每组单独起进程，先删 .cache/ 再跑：
 *   Remove-Item .cache -Recurse -Force; npx tsx --env-file=.env.local scripts/try-itinerary.ts 1
 *
 * 脚本只读 data/cities/hangzhou.json（经 lib/cityData.loadCity 读盘 + zod 校验）里的真实地点，
 * 不生成任何地点。
 *
 * 当前契约（本脚本原先是 M4 时代的，2026-10-24 刷新到现在的口径）：
 *   - `segments.length === stops.length + 1`：最后一段是「末站 → 终点（默认回起点）」的返程；
 *   - 站数由可用时长算出的 targetStops 决定（1–6），不再固定 ≤3；
 *   - `maxTotalMin` 是**站点时间预算**（不含返程），所以校验的是「末站离开 − 出发 ≤ maxTotalMin」，
 *     totalMin（含返程）按「各站停留 + 各段通勤（含返程）」复算；
 *   - 去重收紧：同类目 <800m 任意两站都算重复；第 3 站及以后不落回前序任一站的 800m 内；
 *   - 环线形状（本轮）：第 1 站 = 最近的、能排进去的合规点；第 i 站（i≥2）到起点距离
 *     ≥ 上一站 ×0.9（空则 ×0.75）；拐点系数 0.8 / 0.6。本脚本只做**结果回归**（placeId 基线），
 *     环线形状的逐项判定由 scripts/check-loopshape.ts 负责。
 * 三组都校验：结构过 zod、时间闭合、营业中、半径内、预算内、总额=各段之和；
 * 唯一请求 ≤ 30、placeId 与当前基线逐字一致（硬指标，不通过直接抛错）。
 */
import { PlaceSchema } from "../types/schema";
import type { Itinerary, Place, Stop } from "../types/schema";
import {
  assertItineraryClosed,
  assertSegmentClosed,
  assertStopClosed,
  canAfford,
  estimateCost,
  isOpenAt,
  withinRadius,
} from "../lib/constraints";
import { getCacheStats, resetCacheStats } from "../lib/cache";
import { loadCity } from "../lib/cityData";
import { buildItinerary, estimateWalkMinutes, selectNearby, STAY_MIN } from "../lib/planner";
import type { ItineraryConstraints } from "../lib/planner";

/** 起点书店：用城市数据里的真实 POI 当原点；它本身标记为「当天已去过」，避免从原地再选一次自己。 */
const ORIGIN_BOOKSTORE_ID = "B0G399SIG2"; // 茑屋书店(天目里店)

/** M4.5 硬指标：一次 buildItinerary 的唯一请求上限（数据扩展前是 52–102 条，预筛限 6 后应 ≤30）。 */
const MAX_UNIQUE_REQUESTS = 30;

/**
 * 当前基线（2026-10-24 环线形状改造后的实际结果；数据/选点逻辑再变时必须跟着更新并说明原因）：
 *   第 1 组 15:20：茶园绿云 → 宋姐之望江面馆 → 竹素园 → 宝石山（4 站，monotonic 1039→2879→3690→4053）；
 *   第 2 组 11:00 / 预算 0：仍返回「餐饮预算不足」；
 *   第 3 组 maxTotalMin=90：只排 1 站（茶园绿云）。
 * 这三组是当前回归基线；以后再改数据/选点逻辑，这里必须跟着更新并说明原因。
 */
const BASELINE_PLACE_IDS: Record<string, string[]> = {
  "第 1 组": ["B0FFH5FFC1", "B0KGCC8TEV", "B023B072Q8", "B023B0224D"],
  "第 2 组": [],
  "第 3 组": ["B0FFH5FFC1"],
};

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

/** 站点去重半径（环线形状改造后 800m）：同类目任意两站、以及第 3 站及以后对前序任一站。 */
const SAME_CATEGORY_RADIUS_M = 800;

/** 跨站绕回半径：第 3 站及以后不得落入前序任一站的 800 米内。 */
const NON_ADJACENT_LOOPBACK_RADIUS_M = 800;

function haversineMeters(
  left: { lng: number; lat: number },
  right: { lng: number; lat: number },
): number {
  const toRadians = (value: number): number => (value * Math.PI) / 180;
  const dLat = toRadians(right.lat - left.lat);
  const dLng = toRadians(right.lng - left.lng);
  const lat1 = toRadians(left.lat);
  const lat2 = toRadians(right.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function placeByIdMap(pool: Place[]): Map<string, Place> {
  const map = new Map<string, Place>();
  for (const place of pool) map.set(place.id, place);
  return map;
}

function requirePlace(map: Map<string, Place>, id: string): Place {
  const place = map.get(id);
  if (place === undefined) throw new Error(`自检失败：候选池里找不到 placeId=${id}`);
  return place;
}

/** 只改内存副本，用来验证「闭合校验不通过必须抛错」；不是新地点，也不改任何数据文件。 */
function copyPlace(place: Place, patch: Partial<Place>): Place {
  return PlaceSchema.parse({ ...place, ...patch });
}

function printStop(
  index: number,
  stop: Stop,
  place: Place,
  segment: Itinerary["segments"][number],
  map: Map<string, Place>,
): void {
  const estimate = estimateCost(place);
  const fromName = segment.fromId === "origin" ? "origin（出发地）" : requirePlace(map, segment.fromId).name;
  console.log(
    `  第 ${index + 1} 站：${place.name}（id=${place.id}，category=${place.category}，rating=${String(place.rating)}，avgCost=${String(place.avgCost)}）`,
  );
  console.log(
    `    前往：${fromName} → ${place.name}，${MODE_LABEL[segment.mode]} ${segment.durationMin} 分钟，${segment.distanceM} 米`,
  );
  console.log(
    `    时间：到达 ${formatMinute(stop.arriveAt)}，停留 ${stop.stayMin} 分钟，离开 ${formatMinute(stop.leaveAt)}`,
  );
  console.log(`    花费：${estimate.cost} 元（${estimate.basis}）`);
  console.log(`    reason：${stop.reason}`);
}

type CheckedItinerary = {
  itinerary: Itinerary;
  places: Place[];
};

/** 单组的度量结果：唯一请求数 / 耗时 / placeId 列表（M4.5 §5 要求逐组打印并对比）。 */
type RunSummary = {
  group: string;
  ok: boolean;
  placeIds: string[];
  uniqueRequests: number;
  cacheMisses: number;
  cacheHits: number;
  elapsedMs: number;
  reason: string | null;
};

/**
 * 三组共用的逐条核对：结构 / 时间闭合 / 营业中 / 半径内 / 预算内 / 总额 / 不重复 / 用餐时段。
 * 任何一条不满足直接抛错。
 */
function checkItinerary(args: {
  label: string;
  origin: Place;
  pool: Place[];
  initialVisited: string[];
  constraints: { budget: number; maxTotalMin: number };
  itinerary: Itinerary;
}): CheckedItinerary {
  const { label, origin, pool, initialVisited, constraints, itinerary } = args;
  const map = placeByIdMap(pool);

  // 结构：buildItinerary 已 zod 校验过，这里再断言一次关键字段。
  // 当前契约：segments = stops + 1（最后一段是返程「末站 → 终点」）。
  assertTrue(itinerary.stops.length >= 1, `${label}：行程至少要有一站`);
  assertTrue(
    itinerary.segments.length === itinerary.stops.length + 1,
    `${label}：段数应等于站数 + 1（含返程段），实际 ${itinerary.segments.length} 段 / ${itinerary.stops.length} 站`,
  );
  const returnSegment = itinerary.segments[itinerary.segments.length - 1];
  assertTrue(
    returnSegment.toId === origin.id,
    `${label}：最后一段应是返程（toId=${origin.id}），实际 toId=${returnSegment.toId}`,
  );
  assertTrue(
    itinerary.stops.length <= 6,
    `${label}：超过 6 站（MAX_STOPS）`,
  );
  // maxTotalMin 是站点时间预算（不含返程）：末站离开 − 出发必须装得下；totalMin 是含返程的整段时长。
  const lastStop = itinerary.stops[itinerary.stops.length - 1];
  assertTrue(
    lastStop.leaveAt - itinerary.startAt <= constraints.maxTotalMin,
    `${label}：站点时间（末站离开 ${lastStop.leaveAt} − 出发 ${itinerary.startAt}）超过 maxTotalMin=${constraints.maxTotalMin}`,
  );
  const stayAndCommute =
    itinerary.stops.reduce((sum, stop) => sum + stop.stayMin, 0) +
    itinerary.segments.reduce((sum, segment) => sum + segment.durationMin, 0);
  assertTrue(
    itinerary.totalMin === stayAndCommute,
    `${label}：totalMin=${itinerary.totalMin} 应等于各站停留 + 各段通勤（含返程）=${stayAndCommute}`,
  );
  assertItineraryClosed(itinerary, origin.id, constraints.budget);

  const usedIds = new Set<string>();
  const places: Place[] = [];
  for (let index = 0; index < itinerary.stops.length; index += 1) {
    const stop = itinerary.stops[index];
    const segment = itinerary.segments[index];
    const place = requirePlace(map, stop.placeId);
    places.push(place);

    assertTrue(!usedIds.has(stop.placeId), `${label}：placeId=${stop.placeId} 重复出现`);
    usedIds.add(stop.placeId);

    assertTrue(stop.arriveAt >= itinerary.startAt, `${label}：第 ${index + 1} 站到达早于出发`);
    assertTrue(
      stop.stayMin === STAY_MIN[place.category] || (stop.stayMin >= 45 && stop.stayMin <= 95),
      `${label}：第 ${index + 1} 站停留时长不符合「类目固定值或时间锚点调整后的 45–95 区间」`,
    );
    assertTrue(isOpenAt(place, stop.arriveAt, stop.stayMin), `${label}：第 ${index + 1} 站到达时不在营业时间/停留超过闭馆`);
    assertTrue(withinRadius(segment.durationMin, segment.mode), `${label}：第 ${index + 1} 段超出半径上限`);
    assertTrue(canAfford(place, constraints.budget), `${label}：第 ${index + 1} 站人均超出总预算`);
    assertTrue(stop.costEstimate === estimateCost(place).cost, `${label}：第 ${index + 1} 站 costEstimate 与人均口径不一致`);
  }

  // 站点去重（环线形状改造后的口径）：
  //   1) 同类目 + 直线 <800m 的任意两站都不允许（含第 1、2 站）；
  //   2) 第 3 站及以后，不能落回前序任一站的 800m 内（不分类目）。
  for (let index = 0; index < places.length; index += 1) {
    for (let prior = 0; prior < index; prior += 1) {
      const distance = haversineMeters(places[prior], places[index]);
      const sameCategory = places[prior].category === places[index].category;
      // 第 1、2 站之间只受「同类目」约束；第 3 站及以后（index>=2）对前序任一站都不许 <800m。
      const nonAdjacent = index >= 2;
      if (sameCategory && distance < SAME_CATEGORY_RADIUS_M) {
        assertTrue(
          false,
          `${label}：第 ${index + 1} 站「${places[index].name}」与第 ${prior + 1} 站「${places[prior].name}」同类目且仅 ${Math.round(distance)} 米（<${SAME_CATEGORY_RADIUS_M}m）`,
        );
      }
      if (nonAdjacent && distance < NON_ADJACENT_LOOPBACK_RADIUS_M) {
        assertTrue(
          false,
          `${label}：第 ${index + 1} 站「${places[index].name}」距第 ${prior + 1} 站「${places[prior].name}」仅 ${Math.round(distance)} 米，属于跨站绕回（<${NON_ADJACENT_LOOPBACK_RADIUS_M}m）`,
        );
      }
    }
  }

  console.log(`  合计：totalCost=${itinerary.totalCost} 元（预算 ${constraints.budget} 元），totalMin=${itinerary.totalMin} 分钟，endAt=${formatMinute(itinerary.endAt)}`);
  console.log("  闭合核对（逐段）：");
  let prevLeaveAt = itinerary.startAt;
  for (let index = 0; index < itinerary.stops.length; index += 1) {
    const stop = itinerary.stops[index];
    const segment = itinerary.segments[index];
    console.log(
      `    ${formatMinute(prevLeaveAt)}（上一站离开 ${prevLeaveAt}）+ ${segment.durationMin}（${MODE_LABEL[segment.mode]}）= ` +
        `${formatMinute(stop.arriveAt)}（本站到达 ${stop.arriveAt}）→ 差 ${stop.arriveAt - (prevLeaveAt + segment.durationMin)} 分钟`,
    );
    prevLeaveAt = stop.leaveAt;
  }
  console.log(
    `    返程：${formatMinute(prevLeaveAt)}（末站离开）+ ${returnSegment.durationMin}（${MODE_LABEL[returnSegment.mode]}）= ` +
      `${formatMinute(itinerary.endAt)}（回到终点 ${returnSegment.toId}）`,
  );
  console.log(
    `    totalMin ${itinerary.totalMin} = ${itinerary.stops.map((stop) => `停留 ${stop.stayMin}`).join(" + ")} + ` +
      `${itinerary.segments.map((segment) => `通勤 ${segment.durationMin}`).join(" + ")} = ` +
      `${itinerary.stops.reduce((sum, stop) => sum + stop.stayMin, 0) + itinerary.segments.reduce((sum, segment) => sum + segment.durationMin, 0)}`,
  );

  // 用餐时段硬约束：覆盖正餐时段就必须有一站 restaurant。
  const mealWindows = [
    { label: "午餐", start: 11 * 60 + 30, end: 13 * 60 + 30 },
    { label: "晚餐", start: 17 * 60 + 30, end: 19 * 60 + 30 },
  ].filter((window) => itinerary.startAt < window.end && itinerary.endAt > window.start);
  if (mealWindows.length > 0) {
    const hasRestaurant = places.some((place) => place.category === "restaurant");
    assertTrue(hasRestaurant, `${label}：行程覆盖${mealWindows.map((window) => window.label).join("、")}时段，却没有餐厅`);
    console.log(`  用餐时段：覆盖${mealWindows.map((window) => window.label).join("、")} → 含餐厅站（通过）`);
  } else {
    console.log("  用餐时段：未覆盖正餐时段，不要求餐厅");
  }

  // M4.5 3.1 预筛核对：按实际站点复算每一轮的预筛数量，每轮都必须 ≤6。
  console.log("  预筛核对（每轮只把估算步行分钟最近的 6 个候选传给 pickNext）：");
  const visited: string[] = initialVisited.slice();
  for (let index = 0; index < itinerary.stops.length; index += 1) {
    const from = index === 0 ? origin : requirePlace(map, itinerary.stops[index - 1].placeId);
    const excluded = new Set<string>(visited);
    excluded.add(origin.id);
    excluded.add(from.id);
    const nearby = selectNearby(pool, from, excluded);
    assertTrue(nearby.length <= 6, `${label}：第 ${index + 1} 轮预筛超过 6 个候选`);
    console.log(`    第 ${index + 1} 轮：候选池 ${pool.length} 个 → 预筛 ${nearby.length} 个（只对这 ${nearby.length} 个调 getRoute）`);
    visited.push(itinerary.stops[index].placeId);
  }

  return { itinerary, places };
}

async function runGroup(args: {
  label: string;
  subtitle: string;
  originName: string;
  origin: Place;
  startAt: number;
  constraints: ItineraryConstraints;
  expect: "ok" | "failure";
}): Promise<{ itinerary: Itinerary | null; places: Place[]; summary: RunSummary }> {
  const { label, subtitle, originName, origin, startAt, constraints, expect } = args;
  console.log(`【${label}】${subtitle}`);
  console.log(`  起点：${originName}（${origin.lng}, ${origin.lat}）`);
  console.log(`  出发时刻：${formatMinute(startAt)}（${startAt} 分钟）`);
  console.log(`  预算：${constraints.budget} 元；maxTotalMin：${constraints.maxTotalMin === undefined ? "默认 300" : constraints.maxTotalMin} 分钟`);
  console.log(`  条件：默认（晴 / 体力允许 / 无偏好）；候选池：${constraints.pool.length} 个（起点书店在预筛时排除）`);
  console.log(`  候选池来自 data/cities/hangzhou.json（${constraints.pool.length} 个真实 POI）`);

  resetCacheStats();
  const startedAt = Date.now();
  const result = await buildItinerary(origin, startAt, constraints);
  const elapsedMs = Date.now() - startedAt;
  const stats = getCacheStats();
  console.log(
    `  请求：唯一请求 ${stats.uniqueMisses} 条（cache-miss ${stats.misses} 次，disk-hit ${stats.diskHits} 次，memory-hit ${stats.memoryHits} 次）；耗时 ${elapsedMs} ms`,
  );

  if (expect === "failure") {
    assertTrue(!("startAt" in result), `${label}：应该返回 ok:false，实际返回了行程`);
    const failed = result as { ok: false; reason: string };
    assertTrue(failed.ok === false, `${label}：失败结果必须带 ok:false`);
    assertTrue(failed.reason.indexOf("餐饮预算不足") !== -1, `${label}：reason 没有说明「餐饮预算不足」：${failed.reason}`);
    console.log(`  结果：ok:false`);
    console.log(`  reason：${failed.reason}`);
    console.log(`  核对：返回排不出来、reason 指名「餐饮预算不足」、没有返回违反约束的行程 → 通过`);
    console.log("");
    return {
      itinerary: null,
      places: [],
      summary: {
        group: label,
        ok: false,
        placeIds: [],
        uniqueRequests: stats.uniqueMisses,
        cacheMisses: stats.misses,
        cacheHits: stats.diskHits,
        elapsedMs,
        reason: failed.reason,
      },
    };
  }

  assertTrue("startAt" in result, `${label}：应该返回行程，实际 ok:false：${(result as { ok: false; reason: string }).reason}`);
  const itinerary = result as Itinerary;
  const map = placeByIdMap(constraints.pool);
  console.log(`  结果：ok:true，${itinerary.stops.length} 站`);
  for (let index = 0; index < itinerary.stops.length; index += 1) {
    printStop(index, itinerary.stops[index], requirePlace(map, itinerary.stops[index].placeId), itinerary.segments[index], map);
  }
  const checked = checkItinerary({
    label,
    origin,
    pool: constraints.pool,
    initialVisited: constraints.mode?.visitedPlaceIds ?? [],
    constraints: { budget: constraints.budget, maxTotalMin: constraints.maxTotalMin === undefined ? 300 : constraints.maxTotalMin },
    itinerary,
  });
  console.log(`  核对：营业中 / 半径内 / 预算内 / 时间闭合 / 总额=各段之和 / 不重复 → 通过`);
  console.log("");
  return {
    itinerary,
    places: checked.places,
    summary: {
      group: label,
      ok: true,
      placeIds: itinerary.stops.map((stop) => stop.placeId),
      uniqueRequests: stats.uniqueMisses,
      cacheMisses: stats.misses,
      cacheHits: stats.diskHits,
      elapsedMs,
      reason: null,
    },
  };
}

/** 验证「闭合校验不通过必须抛错，不许静默修正」：给断言函数喂错数，必须在断言里抛错。 */
function checkClosureThrows(sample: Itinerary, originId: string, budget: number): void {
  console.log("附加检查 1（闭合校验不通过必须抛错，不许静默修正）：");
  const stop = sample.stops[0];
  const segment = sample.segments[0];

  const cases: { name: string; run: () => void }[] = [
    {
      name: "段闭合：把 arriveAt 加 2 分钟",
      run: () =>
        assertSegmentClosed(sample.startAt, segment, { ...stop, arriveAt: stop.arriveAt + 2 }, "测试段"),
    },
    {
      name: "站内闭合：把 leaveAt 加 1 分钟",
      run: () => assertStopClosed({ ...stop, leaveAt: stop.leaveAt + 1 }, "测试站"),
    },
    {
      name: "总额：把 totalCost 加 1 元",
      run: () => assertItineraryClosed({ ...sample, totalCost: sample.totalCost + 1 }, originId, budget),
    },
    {
      name: "总时长：把 totalMin 加 1 分钟",
      run: () => assertItineraryClosed({ ...sample, totalMin: sample.totalMin + 1 }, originId, budget),
    },
    {
      name: "预算：把预算改成总花费 - 1 元",
      run: () => assertItineraryClosed(sample, originId, sample.totalCost - 1),
    },
    {
      name: "段方向：把第一段 fromId 改错",
      run: () =>
        assertItineraryClosed(
          { ...sample, segments: [{ ...sample.segments[0], fromId: "wrong" }, ...sample.segments.slice(1)] },
          originId,
          budget,
        ),
    },
  ];

  for (const item of cases) {
    let error: Error | null = null;
    try {
      item.run();
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught));
    }
    assertTrue(error !== null, `附加检查 1：${item.name} 应该抛错，实际没有抛错（说明被静默修正了）`);
    console.log(`  ${item.name} → 抛错「${(error as Error).message}」（通过）`);
  }
  console.log("");
}

/** 附加：预筛函数本身的边界检查（只做直线估算，不发请求）。 */
function checkPrefilter(origin: Place, pool: Place[]): void {
  console.log("附加检查 2（M4.5 3.1 预筛：按估算步行分钟只取最近 6 个，全程不调 getRoute）：");
  const excluded = new Set<string>([origin.id]);
  const eligible = pool.length - 1;
  const nearby = selectNearby(pool, { lng: origin.lng, lat: origin.lat }, excluded);
  assertTrue(nearby.length === 6, `预筛应返回 6 个候选，实际 ${nearby.length}`);
  const estMinutes = nearby.map((place) => estimateWalkMinutes(origin, place));
  const sorted = estMinutes.slice().sort((a, b) => a - b);
  assertTrue(
    estMinutes.every((minutes, index) => minutes === sorted[index]),
    "预筛结果没有按估算步行分钟升序",
  );
  console.log(`  候选池 ${pool.length} 个（起点书店排除后 ${eligible} 个）→ 预筛 ${nearby.length} 个，且按估算步行分钟升序：通过`);
  for (let index = 0; index < nearby.length; index += 1) {
    console.log(`    ${index + 1}. ${nearby[index].name}（估算步行 ${estMinutes[index].toFixed(1)} 分钟）`);
  }
  const all = selectNearby(pool, { lng: origin.lng, lat: origin.lat }, excluded, 1000);
  assertTrue(all.length === eligible, `limit 大于候选数时应返回全部 ${eligible} 个，实际 ${all.length}`);
  console.log(`  全部候选 ${all.length} 个；buildItinerary 每轮只把估算最近的 ${nearby.length} 个传给 pickNext（通过）`);
  console.log("");
}

/** 附加：组 2 的失败 reason 只能来自「行程覆盖午餐 + 需要正餐」这条约束。 */
function printMealWindowProof(): void {
  console.log("附加检查 3（组 2 的前提是「时间窗覆盖午餐」）：");
  console.log("  reason 明确写了「午餐时段需要安排餐厅，最便宜的 X 元超过预算 0 元」——只有行程窗口与 11:30–13:30 有交集时才会走到用餐约束；");
  console.log("  预算 0 元时没有任何餐厅可负担（最便宜的也要十几元）→ 返回餐饮预算不足，而不是返回一份免费行程。");
  console.log("  组 2 的实际返回见上方 reason。");
  console.log("");
}

async function main(): Promise<void> {
  const city = loadCity("hangzhou");
  const pool = city.places;
  // 起点=data/cities 里的真实书店 POI（M4 §4 组 1「起点=某书店」）；它作为 origin，不进入候选。
  const origin = requirePlace(placeByIdMap(pool), ORIGIN_BOOKSTORE_ID);
  const originName = origin.name;

  // 只跑某一组：`npx tsx --env-file=.env.local scripts/try-itinerary.ts 1`
  // 冷缓存度量时每组单独起进程，先删 .cache/ 再跑，避免组间缓存互相加热。
  const groupArg = process.argv[2];
  const groupFilter = groupArg === undefined ? null : Number(groupArg);
  if (groupFilter !== null && [1, 2, 3].indexOf(groupFilter) === -1) {
    throw new Error(`组号只能是 1 / 2 / 3，收到：${groupArg}`);
  }

  console.log("================================================================================");
  console.log(`M4.5 性能自检：buildItinerary 三组（正常 / 覆盖午餐+预算 0 / 时间很短）${groupFilter === null ? "" : `（本次只跑第 ${groupFilter} 组）`}`);
  console.log("命令：npx tsx --env-file=.env.local scripts/try-itinerary.ts [组号]");
  console.log(
    `候选池：data/cities/hangzhou.json（${pool.length} 个真实地点；cityCode=${city.cityCode}；起点书店本身在预筛时排除）`,
  );
  console.log(`起点：${originName}（城市数据里的真实 POI，作为本次 origin）`);
  console.log("================================================================================");
  console.log("");

  const baseConstraints: ItineraryConstraints = {
    budget: 200,
    pool,
    mode: {},
    // 公交算路城市码（杭州 0571）来自城市配置，不写死在 planner/amap 里。
    cityCode: city.cityCode,
  };

  const summaries: RunSummary[] = [];

  let group1: { itinerary: Itinerary | null; places: Place[]; summary: RunSummary } | null = null;
  let group3: { itinerary: Itinerary | null; places: Place[]; summary: RunSummary } | null = null;

  if (groupFilter === null || groupFilter === 1) {
    group1 = await runGroup({
      label: "第 1 组",
      subtitle: "正常：某书店 15:20 出发，预算 200 元",
      originName,
      origin,
      startAt: 920,
      constraints: baseConstraints,
      expect: "ok",
    });
    summaries.push(group1.summary);
  }

  if (groupFilter === null || groupFilter === 2) {
    const group2 = await runGroup({
      label: "第 2 组",
      subtitle: "覆盖午餐 + 预算 0（必须吃饭但吃不起）",
      originName,
      origin,
      startAt: 660,
      constraints: { ...baseConstraints, budget: 0 },
      expect: "failure",
    });
    summaries.push(group2.summary);
  }

  if (groupFilter === null || groupFilter === 3) {
    group3 = await runGroup({
      label: "第 3 组",
      subtitle: "时间很短：同组 1，maxTotalMin=90",
      originName,
      origin,
      startAt: 920,
      constraints: { ...baseConstraints, maxTotalMin: 90 },
      expect: "ok",
    });
    summaries.push(group3.summary);
    assertTrue(group3.itinerary !== null, "第 3 组应该返回行程");
    const group3Stops = (group3.itinerary as Itinerary).stops.length;
    assertTrue(group3Stops >= 1 && group3Stops <= 2, `第 3 组应只排出 1–2 站，实际 ${group3Stops} 站`);
  }

  if (group1 !== null && group1.itinerary !== null) {
    checkClosureThrows(group1.itinerary, origin.id, 200);
    checkPrefilter(origin, pool);
    printMealWindowProof();
  }

  // 用城市数据记录的内存副本验证「免费场馆按 0 元算」这条口径，不新增任何地点。
  const freePlace = copyPlace(origin, { category: "bookstore", avgCost: null });
  assertTrue(estimateCost(freePlace).cost === 0, "免费场馆中的 null 人均应按 0 元计");
  // 用一座真实存在的餐厅（宋姐之望江面馆）做内存副本，只验证 estimateCost 的取值口径。
  const cheapRestaurant = copyPlace(requirePlace(placeByIdMap(pool), "B0KGCC8TEV"), { avgCost: 23 });
  assertTrue(estimateCost(cheapRestaurant).cost === 23, "有真实人均的餐厅应直接使用真实值");
  console.log("附加检查 4（人均口径提醒，地点内存副本验证）：免费场馆 null → 0 元；");
  console.log("  餐厅 null → 50 元兜底（不会被当成 0 元）；组 2 预算 0 元、最便宜的餐厅也要十几元 → 必然排不出来。");
  console.log("");

  // 机读汇总：便于与当前基线逐组对比（唯一请求数 / 耗时 / placeId 逐字一致）。
  console.log("---------------- M4.5 机读汇总 ----------------");
  for (const summary of summaries) {
    console.log(
      `M45_RESULT ${summary.group} ok=${summary.ok} uniqueRequests=${summary.uniqueRequests} ` +
        `cacheMisses=${summary.cacheMisses} cacheHits=${summary.cacheHits} elapsedMs=${summary.elapsedMs} ` +
        `placeIds=${summary.placeIds.length === 0 ? "-" : summary.placeIds.join(",")}`,
    );
    if (summary.reason !== null) console.log(`M45_REASON ${summary.group} ${summary.reason}`);
  }

  // M4.5 硬指标：唯一请求 ≤ 30；placeId 与当前基线逐字一致（这是「只许变快、不许变样」的底线）。
  console.log("---------------- M4.5 硬指标核对 ----------------");
  for (const summary of summaries) {
    const baseline = BASELINE_PLACE_IDS[summary.group];
    assertTrue(
      baseline !== undefined,
      `${summary.group}：没有登记当前 placeId 基线`,
    );
    assertTrue(
      JSON.stringify(summary.placeIds) === JSON.stringify(baseline),
      `${summary.group}：placeId 与当前基线不一致（基线 ${baseline.join(",") || "-"}，实际 ${summary.placeIds.join(",") || "-"}）`,
    );
    assertTrue(
      summary.uniqueRequests <= MAX_UNIQUE_REQUESTS,
      `${summary.group}：唯一请求 ${summary.uniqueRequests} 超过上限 ${MAX_UNIQUE_REQUESTS}`,
    );
    console.log(
      `  ${summary.group}：唯一请求 ${summary.uniqueRequests} ≤ ${MAX_UNIQUE_REQUESTS}，placeId 与当前基线一致（${summary.placeIds.join(",") || "-"}）→ 通过`,
    );
  }

  console.log("最终结论：三组结果符合当前契约（segments = stops + 1 含返程；站数由可用时长决定；800m 去重 + 环线形状）；闭合校验不通过会抛错；每轮只对估算预筛后的候选算路线；唯一请求 ≤ 30 且 placeId 与当前基线一致。");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
