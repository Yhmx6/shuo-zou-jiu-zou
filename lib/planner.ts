import { z } from "zod";
import { ItinerarySchema, MealInfoSchema, PlaceCategorySchema, PlaceSchema, SegmentSchema, StopSchema } from "../types/schema";
import type { Itinerary, MealInfo, Place, PlaceCategory, Segment, SegmentMode, Stop, WaitLevel } from "../types/schema";
import { getRoute } from "./amap";
import type { RouteSummary } from "./amap";
import { declareDislike, getWeight } from "./preference";
import {
  assertItineraryClosed,
  assertSegmentClosed,
  assertStopClosed,
  canAfford,
  estimateCost,
  isOpenAt,
  isOutdoorPlace,
  RADIUS_LIMIT_MIN,
  withinRadius,
} from "./constraints";
import type { CostBasis } from "./constraints";
// M18 出行画像：**只 import type**（运行时不会加载 lib/profile.ts，服务端 / 离线脚本都不会因此多拉依赖）。
import type { TravelProfile, TravelScene, TravelStyle } from "./profile";

/**
 * M3：单站推荐（纯规则）。
 *
 * 输入：当前所在点、当前时间、候选池、剩余预算、选点上下文（偏好 / 天气 / 同行人 / 已去过）。
 * 输出：下一站（Stop + 连接它的 Segment），或者 `{ ok:false, reason }` 说明卡在哪条约束。
 *
 * **不接 LLM。** 交通方式按 M3 3.0 的距离阈值 + 条件优先级判定，
 * 不过滤步骤不合并、打分权重不改（0.4 / 0.3 / 0.2 / 0.1）、停留时长按类目固定。
 */

const MINUTES_PER_DAY = 1440;

/** M3 3.4：每个类目的停留时长（分钟），固定值，不许按分数临时调。 */
export const STAY_MIN: Record<PlaceCategory, number> = {
  bookstore: 60,
  museum: 90,
  gallery: 90,
  restaurant: 60,
  cafe: 45,
  park: 45,
  market: 45,
  mall: 60,
  theater: 120,
  other: 60,
};

/** 最短停留（分钟）：夜间上限预判用「连最短的一站都装不下」提前收尾，不再空算路线。 */
const MIN_STAY_MIN = Math.min(...Object.values(STAY_MIN));

/* ------------------------------------------------------------------ *
 * 时间锚点（M1 3.3.6：bestTime === '日落' 的地点）
 *
 * 原则（第四轮修正）：锚点只能改「待多久」，不能改「去哪」。
 * 选点阶段完全忽略日落；3 站按正常打分/距离/预算选完之后，再做后处理：
 *   - 日落点的自然到达时间落在锚定窗口（默认 17:32–17:52）→ 直接锚定，reason 里说明；
 *   - 与窗口差 ≤20 分钟 → 调整前一站的停留时长（45–95 区间内）把到达拉进窗口；
 *   - 差 >20 分钟 / 第一站没有「前一站」/ 调整会破坏闭合或用餐约束 → 放弃锚点，按普通行程返回。
 * 日落时刻由城市数据传入（buildItinerary 的 constraints.sunsetMinute / replaceStop 的 options.sunsetMinute），
 * 未传时默认杭州 17:42；M10 再接按日期 / 经纬度的天文计算。
 * ------------------------------------------------------------------ */

/** 默认日落时刻（当日分钟数）：17:42。城市数据未给 sunsetMinute 时用它。 */
const DEFAULT_SUNSET_MINUTE = 17 * 60 + 42;
/** 锚定到达目标 = 日落前 10 分钟（默认 17:32）；这是机制常量，不随日落时刻变。 */
const SUNSET_ARRIVE_LEAD_MIN = 10;

/**
 * 当天硬性结束上限的默认值：23:30（当日分钟数 1410）。城市配置可用 lastEndMinute 覆盖。
 * 晚间出发时不再把站排到 24:00 之后；跨午夜是正常业务场景，不再用「now 越界」抛错表达。
 */
const DEFAULT_LAST_END_MINUTE = 23 * 60 + 30;

/**
 * 一站都排不下（时间已经贴着当天上限）时的统一原因。
 * 必须是人话：不出现 now / 越界 / 1439 这些程序词（验收口径）。
 */
const LATE_NIGHT_FAILURE_REASON = "这个点出门，走一趟就快 24 点了。明天早点？";

/**
 * 0 站失败时的「位置」类人话（本轮新增）：
 *
 * 起点在数据覆盖范围之外时（例如城市数据只有房山，用户从三里屯出发），
 * 原来的失败原因全是时间文案（深夜 / 时长上限），用户会以为「换个时间再来」就行；
 * 实际是「这一带没有数据」。所以 stops.length === 0 时先看位置：
 *   - 候选池是空的 → 附近没有可去的地方；
 *   - 最近候选直线距离 > 15km → 明说最近也有 X 公里、这一带没覆盖；
 *   - 否则返回 null，继续用原来的时间文案（时间是真的不够，例如 23:50 出发）。
 *
 * 只在「一站都没排出来」时使用；已经排过站的失败仍然是时间文案（那是真排满了）。
 */
const EMPTY_POOL_FAILURE_REASON = "这个位置附近没有可去的地方，换个起点试试？";
const NO_COVERAGE_DISTANCE_M = 15000;

function buildEmptyStartFailureReason(
  pool: Place[],
  origin: { lng: number; lat: number },
): string | null {
  if (pool.length === 0) return EMPTY_POOL_FAILURE_REASON;
  let minDistanceM = Number.POSITIVE_INFINITY;
  for (const place of pool) {
    const distanceM = haversineMeters(origin, place);
    if (distanceM < minDistanceM) minDistanceM = distanceM;
  }
  if (minDistanceM > NO_COVERAGE_DISTANCE_M) {
    const kilometers = Math.round(minDistanceM / 1000);
    return `离你最近的地方也有 ${kilometers} 公里，这一带还没覆盖到。换个起点试试？`;
  }
  return null;
}

/**
 * 「再来一条」把本会话出现过的站点全排除后，候选池真的空了时的统一原因（任务书逐字）。
 * 铁律：不许为了「总能换」而偷偷忽略 exclude；换不出来就如实返回这句人话。
 */
export const EXCLUDE_EXHAUSTED_REASON = "这一带能换的组合就这些了，换个时间或起点试试？";

/**
 * 候选预判的短路余量（分钟）：直线返程估算距当天上限还有这么多余量时，判定必装得下，
 * 不去算真实返程——保证白天路径不新增任何 getRoute 请求（性能与行为都不变）。
 */
const LAST_END_SHORTCUT_MARGIN_MIN = 30;

/** 一次排程用的日落参数：sunsetMinute 是日落时刻，arriveEarliest 是锚定到达目标。 */
type SunsetAnchor = { sunsetMinute: number; arriveEarliest: number };

/**
 * 解析本次排程的日落参数：没传就用默认 17:42；显式传入时必须是 0–1439 的整数分钟。
 * 该参数只影响「日落锚点」这条后处理，不改任何选点 / 打分 / 预算 / 用餐判定。
 */
function resolveSunsetAnchor(sunsetMinute: number | undefined): SunsetAnchor {
  const resolved = sunsetMinute === undefined ? DEFAULT_SUNSET_MINUTE : sunsetMinute;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved >= MINUTES_PER_DAY) {
    throw new Error(`sunsetMinute 必须是 0–1439 的整数分钟，收到：${String(sunsetMinute)}`);
  }
  return { sunsetMinute: resolved, arriveEarliest: resolved - SUNSET_ARRIVE_LEAD_MIN };
}

/** 调整前一站停留时长时允许的区间（保持「正常停留」）。 */
const SUNSET_STAY_MIN_FLOOR = 45;
const SUNSET_STAY_MIN_CEILING = 95;
/**
 * 「日落锚点前置」的触发窗口：出发时间距日落到达窗口 ≤90 分钟才先占位。
 * 更早出发（默认口径下 15:20 距 17:32 还有 132 分钟）保持普通行程，不为了日落改排程。
 */
const SUNSET_PREPLACE_LEAD_MIN = 90;

/** 锚点场景允许 4 站（普通场景 3–6 站）：前缀活动 + 日落 + 晚餐 + 收尾。 */
const MAX_ANCHOR_STOPS = 4;

function isSunsetPlace(place: Place): boolean {
  return place.scenery !== undefined && place.scenery.bestTime === "日落";
}

/**
 * 日落锚点只接受**户外**地点（isOutdoorPlace 同一口径）：
 *   - category === 'park'（公园 / 绿道 / 江边 / 观景步道）；
 *   - category === 'other' 且 sceneryType ∈ {江景, 森林, 田野, 建筑}；
 *   - category === 'other' 且名称含「观景 / 平台 / 天台 / 露台」（不依赖 sceneryType，
 *     例如「湖山最胜观景平台」被 LLM 标成「其他」也能用）。
 * 书店 / 美术馆 / 博物馆 / 剧场 / 餐厅 / 咖啡 / 商场哪怕 bestTime 标了日落也不锚定。
 */
function isSunsetAnchorEligible(place: Place): boolean {
  return isOutdoorPlace(place);
}

/* ------------------------------------------------------------------ *
 * 正餐时段（M5 收尾修复：餐厅去重）
 *
 * 规则：
 *   1. 记录今天**已被餐厅占用**的正餐时段（lunch / dinner），每个时段最多一家餐厅；
 *   2. 餐厅的停留窗口与哪个正餐时段有交集，就占用哪个时段；和两个时段都没有交集
 *      → 这是「非正餐时段」，直接排除 restaurant（否则会出现 10:18 一家、13:14 又一家的重复）；
 *   3. 全天最多 2 家，且必须分别落在午餐 / 晚餐。
 *
 * 先定义在这里，是因为 pickNext 的单站过滤要用到它们（M3 的选点循环本身没变）。
 * ------------------------------------------------------------------ */

export const MealSlotSchema = z.enum(["lunch", "dinner"]);

export type MealSlot = z.infer<typeof MealSlotSchema>;

/** 一个正餐时段：slot 是时段标识，start/end 是当日分钟数（左闭右开）。 */
type MealWindow = { slot: MealSlot; label: string; start: number; end: number };

/** M9 3.1 的两个正餐时段（M4 组 2 的失败用例依赖它；M9 到时可复用/收紧）。 */
const MEAL_WINDOWS: MealWindow[] = [
  { slot: "lunch", label: "午餐", start: 11 * 60 + 30, end: 13 * 60 + 30 },
  { slot: "dinner", label: "晚餐", start: 17 * 60 + 30, end: 19 * 60 + 30 },
];

function mealWindowOf(slot: MealSlot): MealWindow {
  const window = MEAL_WINDOWS.filter((item) => item.slot === slot)[0];
  if (window === undefined) {
    throw new Error(`未知的正餐时段："${String(slot)}"`);
  }
  return window;
}

/**
 * 餐厅停在这一站会占用哪个正餐时段：停留窗口 [arriveAt, arriveAt + stayMin) 与哪个时段有交集。
 *
 * - 有交集 → 这一站就是那个时段的正餐（11:20 到店、吃到 12:20 算午餐，不要求到店时间正好在时段内）；
 * - 没有交集 → 非正餐时段，这个餐厅不能选（10:18–11:18 这种就是必须排除的情况）；
 * - 两个时段不可能同时命中：餐厅停留 60 分钟，午餐和晚餐之间隔了 4 小时。
 */
function mealSlotFor(arriveAt: number, stayMin: number): MealWindow | null {
  for (const window of MEAL_WINDOWS) {
    if (arriveAt < window.end && arriveAt + stayMin > window.start) return window;
  }
  return null;
}

/**
 * pickNext 的第 5 个参数 `mode`：影响这次选点的上下文。
 *
 * 3.0 的交通表里出现了「用户选了省时 / 下雨 / 带 60 岁以上或 10 岁以下同行」这些条件，
 * 3.2 第 4 步又要求过滤「当天已去过」，但它们都不在五个入参的其他位置，所以统一放在这里。
 * 所有字段可省略：不传 = 默认（晴天、体力允许、无偏好、没有已去过的点）。
 */
export const PickModeSchema = z
  .object({
    /** 用户偏好类目：命中 = 1.0，相近 = 0.6，无关 = 0.2；不传 = 无偏好，统一 0.6 */
    preferredCategories: z.array(PlaceCategorySchema).optional(),
    /** 用户明确说了「省时」→ 距离 > 3km 时允许打车 */
    timeFirst: z.boolean().optional(),
    /** 今天下雨 → 距离 > 3km 时允许打车，且不骑行 */
    raining: z.boolean().optional(),
    /** 同行人里有 60 岁以上 / 10 岁以下 → 距离 > 3km 时允许打车 */
    withElderOrChild: z.boolean().optional(),
    /** 体力；low 时不允许骑行。不传视为体力允许（M10 才接真实选择器） */
    energy: z.enum(["low", "mid", "high"]).optional(),
    /** 当天已经去过的地点 id（3.2 第 4 步过滤用） */
    visitedPlaceIds: z.array(z.string().min(1)).optional(),
    /**
     * M5 收尾修复：今天已经被餐厅占用的正餐时段（每个时段最多一家餐厅）。
     * 由 buildItinerary 的选站循环维护；单独调 pickNext 不传 = 两个时段都还空着。
     */
    occupiedMealSlots: z.array(MealSlotSchema).optional(),
    /** 这一轮必须把哪个正餐时段安排掉（用餐修复 / 提前安排用）；不传 = 不限定时段。 */
    requiredMealSlot: MealSlotSchema.optional(),
    /**
     * M20 类目多样性：这条行程**已经用过的 category**（硬过滤，命中即排除）。
     * 由 planner 的选站循环维护；单独调 pickNext 不传 = 不做类目去重（旧行为）。
     */
    usedCategories: z.array(PlaceCategorySchema).optional(),
    /**
     * M20 类目多样性：cafe + restaurant 已经出现的次数（≥2 时再出现的 cafe / restaurant 排除，
     * 即全天最多两次「吃喝」）。同样由选站循环维护；不传 = 0。
     */
    usedDiningCount: z.number().int().min(0).optional(),
    /**
     * M21 跨两餐餐厅差异化：这条行程**已经排过的餐厅店名前两个字**。
     * 第二家餐厅命中同前缀时只做重降权（换不出来仍可选），因此不是硬过滤；
     * 由 planRounds 维护，不传 = 不做差异化（旧行为）。
     */
    usedRestaurantPrefixes: z.array(z.string().min(1)).optional(),
    /**
     * M18 内部字段（不对外，/api/plan、/api/swap 不会传）：
     * powerful 画像「用体力换钱」→ 规划时排除公交，只走步行 / 骑行（契约验收 #4「全步行/骑行」）。
     * 由 planner 在「规划用 mode 副本」里写 true（planningPickMode）；不传 = 原来的公交规则。
     */
    profileNoBus: z.boolean().optional(),
  })
  .strict();

export type PickMode = z.infer<typeof PickModeSchema>;

/** 出参契约：成功只有 stop + segment，失败只有 reason（M3 3.6）。 */
export const PickResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), stop: StopSchema, segment: SegmentSchema }),
  z.object({ ok: z.literal(false), reason: z.string().min(1) }),
]);

export type PickResult = z.infer<typeof PickResultSchema>;

/* ------------------------------------------------------------------ *
 * 3.0 交通方式判定
 * ------------------------------------------------------------------ */

/** 3.0 的距离阈值（米）。距离口径统一用「步行路线的 distanceM」，原因见 decideCommute。 */
const DRIVE_MIN_DISTANCE_M = 3000;
const WALK_MAX_DISTANCE_M = 1200;
const BUS_WORTH_MAX_DISTANCE_M = 5000;
/** 公交值不值得坐的相对阈值：公交 ≤ 步行 × 0.7（不是「公交比步行快」）。 */
const BUS_WORTH_RATIO = 0.7;
const BIKE_MIN_DISTANCE_M = 2000;
const BIKE_MAX_DISTANCE_M = 6000;

/**
 * M4.5 3.1：直线距离估算（纯本地计算，不调接口、不消耗配额）。
 *
 * 估算步行分钟 = 直线米数 × 1.3 / 75：
 *   × 1.3 —— 城市步行实际路径比直线长约 30%；
 *   / 75  —— 步行速度 75 米/分钟。
 *
 * 估算距离 = 直线米数 × 1.3，用来在**调接口之前**判断这一段大概率落在 M3 3.0 的哪个距离档，
 * 从而决定「哪几种交通方式根本用不着算」（见 decideCommute）。
 */
const EST_PATH_FACTOR = 1.3;
const WALK_SPEED_M_PER_MIN = 75;

const EARTH_RADIUS_M = 6371000;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** 两端之间的直线距离（米）。 */
function haversineMeters(
  from: { lng: number; lat: number },
  to: { lng: number; lat: number },
): number {
  const dLat = toRadians(to.lat - from.lat);
  const dLng = toRadians(to.lng - from.lng);
  const lat1 = toRadians(from.lat);
  const lat2 = toRadians(to.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * 同区域重复判据（环线形状改造再收紧：500 → 800 米）：
 * **同类目 + 直线距离 < 800 米 → 视为同一片地方**，只保留打分更高的一个。
 * 跨类目不判重（公园旁边的面馆是合理的）。
 * 相邻站也适用本判据（同类目的两站挨着仍然是「同一片区域去两次」）。
 */
const SAME_CATEGORY_DUPLICATE_DISTANCE_M = 800;

function isSameAreaDuplicate(candidate: Place, selectedPlaces: Place[]): boolean {
  return selectedPlaces.some(
    (selected) =>
      selected.category === candidate.category &&
      haversineMeters(selected, candidate) < SAME_CATEGORY_DUPLICATE_DISTANCE_M,
  );
}

/**
 * 跨站绕回（本轮收紧：500 → 800 米）：第 3 站及以后，不得出现在前序任一站的 800 米内。
 * 第 1、2 站之间不限制（相邻站挨着反而少走路，公园旁边就是书店不该拆）。
 */
const NON_ADJACENT_LOOPBACK_DISTANCE_M = 800;

function isNonAdjacentLoopback(candidate: Place, selectedPlaces: Place[]): boolean {
  // candidate 的序号 = selectedPlaces.length + 1；只有第 3 站及以后才检查前序站。
  if (selectedPlaces.length < 2) return false;
  return selectedPlaces.some(
    (selected) => haversineMeters(selected, candidate) < NON_ADJACENT_LOOPBACK_DISTANCE_M,
  );
}

/**
 * 候选池里的同区域重复（同类目 + 直线 <800m）只保留打分上界更高的一个。
 * 通勤还没算，先用 scoreUpperBound 比较（纯本地，0 请求）。
 * M18：比较口径带上画像调参（否则 rich/powerful 的去重取舍会和选点打分不一致）。
 */
function dedupeSameAreaCandidates(places: Place[], mode: PickMode, profile?: ProfileTuning): Place[] {
  const kept: Place[] = [];
  for (const place of places) {
    const duplicateIndex = kept.findIndex(
      (item) =>
        item.category === place.category &&
        haversineMeters(item, place) < SAME_CATEGORY_DUPLICATE_DISTANCE_M,
    );
    if (duplicateIndex === -1) {
      kept.push(place);
      continue;
    }
    if (scoreUpperBound(place, mode, profile) > scoreUpperBound(kept[duplicateIndex], mode, profile)) {
      kept[duplicateIndex] = place;
    }
  }
  return kept;
}

/** 估算步行分钟（M4.5 3.1）：直线米数 × 1.3 / 75。 */
export function estimateWalkMinutes(
  from: { lng: number; lat: number },
  to: { lng: number; lat: number },
): number {
  return (haversineMeters(from, to) * EST_PATH_FACTOR) / WALK_SPEED_M_PER_MIN;
}

/** 估算的实际路程米数（直线 × 1.3）。 */
function estimateDistanceMeters(
  from: { lng: number; lat: number },
  to: { lng: number; lat: number },
): number {
  return haversineMeters(from, to) * EST_PATH_FACTOR;
}

/** 打车条件：省时 / 下雨 / 带 60 岁以上或 10 岁以下同行，命中任一即可。 */
function wantsDrive(mode: PickMode): boolean {
  return mode.timeFirst === true || mode.raining === true || mode.withElderOrChild === true;
}

/** 骑行条件里的「天气好 + 体力允许」。 */
function canRideBike(mode: PickMode): boolean {
  return mode.raining !== true && mode.energy !== "low";
}

type Commute = {
  mode: SegmentMode;
  durationMin: number;
  distanceM: number;
  /**
   * 这一段「起步那条路」的路名（本轮新增，可选）：来自 lib/amap.ts getRoute 的 RouteSummary.road。
   * 公交 / 高德没给路名时**不出现这个字段**——绝不允许空串流进 Segment.road。
   */
  road?: string;
};

/**
 * getRoute 结果 → Commute 的唯一出口（本轮新增）：road 有值才带，没值就不带这个字段。
 * 这样 10 个 return 分支不用各写一遍 `...(road ? {road} : {})`，也不会漏掉某个分支。
 */
function commuteOf(mode: SegmentMode, summary: RouteSummary): Commute {
  const base: Commute = {
    mode,
    durationMin: summary.durationMin,
    distanceM: summary.distanceM,
  };
  return summary.road === undefined ? base : { ...base, road: summary.road };
}

/**
 * Commute → Segment 的唯一出口（本轮新增）：durationM 取整、road 有值才带。
 * 站间段 / 返程段 / 换站的进出段全部走这里，避免 7 处 SegmentSchema.parse 漏带 road。
 */
function segmentOf(fromId: string, toId: string, commute: Commute): Segment {
  const base = {
    fromId,
    toId,
    mode: commute.mode,
    durationMin: commute.durationMin,
    distanceM: Math.round(commute.distanceM),
  };
  return SegmentSchema.parse(commute.road === undefined ? base : { ...base, road: commute.road });
}

/**
 * M3 3.0：按距离阈值和条件优先级判定这一段怎么走。
 *
 * 规则表（照抄，命中哪一行就用哪个，**绝不比较几种方式的时长挑最快**——
 * 那样驾车永远最快，结果就是全程打车）：
 *   行1  距离 ≤ 1.2km                                  → 步行（哪怕公交只要 3 分钟）
 *   行2  1.2km < 距离 ≤ 5km，且公交 ≤ 步行 × 0.7       → 公交
 *   行3  1.2km < 距离 ≤ 5km，其他情况                   → 步行
 *   行4  距离 > 5km（默认）                             → 公交
 *   行5  距离 > 3km 且（省时 / 下雨 / 带 60 岁以上或 10 岁以下）→ 打车（只在这里出现）
 *   行6  天气好 + 体力允许 + 2km < 距离 ≤ 6km           → 骑行（备选，不优先于公交）
 *
 * 距离口径：用**步行路线的 distanceM** 判阈值。公交方案的 distanceM 含绕行和接驳步行，
 * 同一个地点换个公交方案就可能多出几百米、跨过 1.2km / 5km 边界；步行距离才是「这段路有多长」。
 *
 * M4.5 3.2：**先看直线估算距离，再决定要算几种方式**，不「三种都算一遍再比」：
 *   - 估算距离 > 5km：M3 行4 / 行5 只会用公交或打车，所以**不查步行路线**；
 *   - 估算距离 ≤ 5km：必须先拿步行路线（行1 / 行2 / 行3 的距离口径就是它），
 *     后面的公交 / 骑行照原规则判，一条都不能少；
 *   - 估算距离 ≤ 1.2km：行1 必然步行，但步行时长要用来打分，所以步行这一条照查。
 * 估算只是决定「哪些接口根本不用打」，判定规则本身一个字没改。
 *
 * M18 内部开关（mode.profileNoBus，只有 planner 自己写）：powerful 画像「用体力换钱」，
 * 公交不参与选点——本来要选公交的分支改成「走得到就步行、走不到退骑行」；
 * 走不动的远点会由 pickNext 的半径过滤（powerful 步行 50 分钟）丢掉，绝不硬凑公交。
 * 不传这个开关时规则表一个字没变（既有验收基线依赖这一点）。
 */
async function decideCommute(
  from: { lng: number; lat: number },
  to: { lng: number; lat: number },
  mode: PickMode,
  cityCode?: string,
): Promise<Commute | null> {
  const estDistanceM = estimateDistanceMeters(from, to);

  // 估算 > 5km：M3 行4（公交）/ 行5（打车），步行路线用不上，省掉一次请求。
  if (estDistanceM > BUS_WORTH_MAX_DISTANCE_M) {
    // 行5 是整张表里唯一的打车入口：不满足条件时，不会去查驾车路线。
    if (wantsDrive(mode)) {
      const drive = await getRouteWithRetry(from, to, "drive", cityCode);
      if (drive !== null) {
        return commuteOf("drive", drive);
      }
    }
    // M18：powerful 不坐公交——远距离先看骑行（45 分钟内）/ 步行，走不动就返回步行让半径过滤掉。
    if (mode.profileNoBus === true) {
      const walk = await getRouteWithRetry(from, to, "walk", cityCode);
      if (walk === null) return null;
      if (canRideBike(mode)) {
        const bike = await getRouteWithRetry(from, to, "bike", cityCode);
        if (bike !== null && bike.durationMin <= RADIUS_LIMIT_MIN.bike) {
          return commuteOf("bike", bike);
        }
      }
      return commuteOf("walk", walk);
    }
    const bus = await getRouteWithRetry(from, to, "bus", cityCode);
    if (bus !== null) {
      return commuteOf("bus", bus);
    }
    // 公交也算不出来时，回到原口径补齐步行距离，行6 的「≤ 6km 骑行兜底」才判得准。
    const walk = await getRouteWithRetry(from, to, "walk", cityCode);
    if (walk === null) return null;
    if (walk.distanceM <= BIKE_MAX_DISTANCE_M && canRideBike(mode)) {
      const bike = await getRouteWithRetry(from, to, "bike", cityCode);
      if (bike !== null) {
        return commuteOf("bike", bike);
      }
    }
    return null;
  }

  const walk = await getRouteWithRetry(from, to, "walk", cityCode);

  // 步行都算不出来（太远 / 没有步行路线）：距离口径退回公交方案，只能看公交能不能到。
  if (walk === null) {
    // M18：powerful 不坐公交 → 步行路线都没有就是到不了。
    if (mode.profileNoBus === true) return null;
    const bus = await getRouteWithRetry(from, to, "bus", cityCode);
    return bus === null ? null : commuteOf("bus", bus);
  }

  // 行5 是整张表里唯一的打车入口：不满足条件时，下面不会去查驾车路线。
  // 打车永远不是默认值，也不因为「驾车最快」而被选中。
  if (walk.distanceM > DRIVE_MIN_DISTANCE_M && wantsDrive(mode)) {
    const drive = await getRouteWithRetry(from, to, "drive", cityCode);
    if (drive !== null) {
      return commuteOf("drive", drive);
    }
    // 驾车路线算不出来就落回默认规则，不硬凑打车。
  }

  // 行1：≤ 1.2km 一律步行，连公交都不查（哪怕公交 3 分钟）。
  if (walk.distanceM <= WALK_MAX_DISTANCE_M) {
    return commuteOf("walk", walk);
  }

  // 行2 / 行3：1.2–5km。用「公交 ≤ 步行 × 0.7」判断公交值不值得坐：
  // 有些路段等车 + 绕行确实比步行慢，这不是 bug，所以不能按「公交比步行快」判。
  if (walk.distanceM <= BUS_WORTH_MAX_DISTANCE_M) {
    if (mode.profileNoBus !== true) {
      const bus = await getRouteWithRetry(from, to, "bus", cityCode);
      if (bus !== null && bus.durationMin <= walk.durationMin * BUS_WORTH_RATIO) {
        return commuteOf("bus", bus);
      }
    }
    // 行6（备选）：2–5km 公交不划算时，天气好 + 体力允许可以骑行替代长距离步行；
    // 它永远不优先于公交（上面公交先判过）。
    if (walk.distanceM > BIKE_MIN_DISTANCE_M && canRideBike(mode)) {
      const bike = await getRouteWithRetry(from, to, "bike", cityCode);
      if (bike !== null) {
        return commuteOf("bike", bike);
      }
    }
    return commuteOf("walk", walk);
  }

  // 行4：> 5km 默认公交。
  // M18：powerful 不坐公交——远距离只能骑行（≤45 分钟半径）或步行（超出 50 分钟步行半径会被过滤掉）。
  if (mode.profileNoBus === true) {
    if (canRideBike(mode)) {
      const bike = await getRouteWithRetry(from, to, "bike", cityCode);
      if (bike !== null && bike.durationMin <= RADIUS_LIMIT_MIN.bike) {
        return commuteOf("bike", bike);
      }
    }
    return commuteOf("walk", walk);
  }
  const bus = await getRouteWithRetry(from, to, "bus", cityCode);
  if (bus !== null) {
    return commuteOf("bus", bus);
  }

  // 行6（备选兜底）：公交算不出来、距离又没超过 6km，天气好 + 体力允许可以骑过去。
  if (walk.distanceM <= BIKE_MAX_DISTANCE_M && canRideBike(mode)) {
    const bike = await getRouteWithRetry(from, to, "bike", cityCode);
    if (bike !== null) {
      return commuteOf("bike", bike);
    }
  }

  // 没有可用的交通方式：这一站在第 2 步（半径）会被当成到不了。
  return null;
}

/* ------------------------------------------------------------------ *
 * 3.3 打分（权重固定 0.4 / 0.3 / 0.2 / 0.1，不要自己调）
 * ------------------------------------------------------------------ */

const FRESH_WINDOW_DAYS = 180;
/** rating 为 null 时的 ratingNorm（M3 3.3 规定 0.6，不是 0）。 */
const RATING_FALLBACK_NORM = 0.6;
const NO_PREFERENCE_NORM = 0.6;

/** 「相近类目」关系：命中用户偏好 = 1.0；只是相近 = 0.6；无关 = 0.2。 */
const SIMILAR_CATEGORIES: Record<PlaceCategory, PlaceCategory[]> = {
  bookstore: ["gallery", "museum"],
  gallery: ["museum", "bookstore"],
  museum: ["gallery", "bookstore"],
  theater: ["gallery", "museum"],
  market: ["mall", "park"],
  park: ["market"],
  mall: ["market"],
  restaurant: ["cafe"],
  cafe: ["restaurant"],
  other: [],
};

function categoryNormFor(category: PlaceCategory, preferred: PlaceCategory[] | undefined): number {
  if (preferred === undefined || preferred.length === 0) return NO_PREFERENCE_NORM;
  if (preferred.indexOf(category) !== -1) return 1.0;
  for (const item of preferred) {
    if (SIMILAR_CATEGORIES[item].indexOf(category) !== -1) return 0.6;
  }
  return 0.2;
}

/** 今天 0 点（本机时区）的时间戳；freshNorm 只按自然日算。 */
function startOfTodayMs(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/** freshNorm = 1 - min(距 lastVerified 天数 / 180, 1)。 */
function freshNormFor(lastVerified: string): number {
  const verified = new Date(`${lastVerified}T00:00:00`);
  if (Number.isNaN(verified.getTime())) {
    throw new Error(`lastVerified 不是合法日期："${lastVerified}"`);
  }
  const days = Math.max(0, Math.round((startOfTodayMs() - verified.getTime()) / 86400000));
  return 1 - Math.min(days / FRESH_WINDOW_DAYS, 1);
}

function scoreCandidate(
  place: Place,
  commute: Commute,
  categoryNorm: number,
  profile?: ProfileTuning,
): number {
  const ratingNorm = place.rating === null ? RATING_FALLBACK_NORM : place.rating / 5;
  // distanceNorm 的半径上限按所选交通方式取（步行30 / 公交45 / 驾车25 / 骑行45）。
  const distanceNorm = 1 - Math.min(commute.durationMin / RADIUS_LIMIT_MIN[commute.mode], 1);
  const freshNorm = freshNormFor(place.lastVerified);
  // 3.3 权重：照抄，0.4 / 0.3 / 0.2 / 0.1。
  // M18：只有 rating 这一项按画像调（rich 0.45 / powerful 0.2，其余权重不变；排名等效于归一化）。
  // 不传 profile（既有调用方 / 无画像请求）时恒为原来的 0.4，逐字一致。
  const ratingWeight = profile === undefined ? DEFAULT_RATING_WEIGHT : profile.ratingWeight;
  return ratingWeight * ratingNorm + 0.3 * distanceNorm + 0.2 * categoryNorm + 0.1 * freshNorm;
}

/**
 * M4.5 3.1：候选的**打分上界**（本地算，0 请求、0 配额）。
 * 通勤时长最短是 0 分钟，所以 distanceNorm ≤ 1，把这一项拉满就得到严格上界：
 * 任何真实通勤都只会让分数 ≤ 这个值。
 * 用途：先算出当前最佳，再把「上界都打不过最佳」的候选直接丢掉——它们连接口都不用调，
 * 而且不会影响选谁（上界是严格上界，不是估算近似）。
 *
 * M18 画像：画像里的所有加权都是「乘在打分上的系数」，这里必须**同步乘到上界**，
 * 否则真实分可能 > 上界、剪枝会漏掉真正的赢家。乘数都是正常数，所以
 * 真实分 = base × m × routeShape(≤1) × jitter(≤1) ≤ (上界 base) × m = 上界 × m。
 * 不传 profile 时系数恒 1，与改造前逐字一致。
 */
function scoreUpperBound(place: Place, mode: PickMode, profile?: ProfileTuning): number {
  const ratingNorm = place.rating === null ? RATING_FALLBACK_NORM : place.rating / 5;
  const categoryNorm = categoryNormFor(place.category, mode.preferredCategories);
  const freshNorm = freshNormFor(place.lastVerified);
  const ratingWeight = profile === undefined ? DEFAULT_RATING_WEIGHT : profile.ratingWeight;
  return ratingWeight * ratingNorm + 0.3 + 0.2 * categoryNorm + 0.1 * freshNorm;
}

/* ------------------------------------------------------------------ *
 * M18：出行画像（开屏问答的 style + scene）调参
 *
 * 两种 style 回答的是「去什么样的地方」，scene 是「今天想看什么」。
 * 两个维度都只通过下面这一个乘数进入打分：命中就乘、多命中连乘（例如 rich 的
 * 「重要性高 + 评分高」再叠加 scene=scenery 的江景公园 = 1.25 × 1.5）。
 *
 * 三条安全边界（与 routeShapeMultiplier / routeJitter 同一套纪律）：
 * 1. 所有乘数都是**正常数**（不是 0/负），所以「真实分 ≤ 上界」依旧成立：
 *    乘数同时出现在 scoreCandidate 和 scoreUpperBound 两边（见上面的分数注释）。
 * 2. 过滤（avgCost / 评分底线 / 站数 / 停留）都发生在打分**之前**，随机种子只能在
 *    通过约束的候选里换人，绝不可能绕过画像约束。
 * 3. profile === undefined 时下面每个函数都走「原值 / 恒 1 / 放行」分支，
 *    无画像请求的行为与改造前逐字一致（check-loopshape / try-itinerary 基线依赖这一点）。
 * ------------------------------------------------------------------ */

/** 画像派生出的「调参表」：只有 buildItinerary 收到 profile 时才创建；undefined = 旧行为。 */
type ProfileTuning = {
  style: TravelStyle;
  scene: TravelScene;
  /** rating 权重：默认 0.4；rich 0.45 / powerful 0.2（其余权重不变）。 */
  ratingWeight: number;
  /** 站数硬上限：rich 3 / powerful 6（= 现有 MAX_STOPS）。 */
  maxStops: number;
  /** 非餐厅站停留时长（分钟）：rich 90；powerful 不覆盖（undefined = 按类目原值）。 */
  nonRestaurantStayMin?: number;
  /**
   * 「这一趟要不要安排吃饭」（开屏第 5 题）：false = 不排餐厅、不套用餐硬约束；cafe 保留。
   * profile 未设置 / mealIncluded === true 时恒为 true（行为与改造前逐字一致）。
   */
  mealIncluded: boolean;
  /**
   * M18 rich 专用兜底开关（内部）：true = 本次尝试**不执行**「餐厅 avgCost <60 排除」这条硬下限。
   * 只在「按原规则正餐排不进去」时由 planStops 自动放宽重排一次，绝不作为默认行为。
   */
  restaurantFloorDisabled?: boolean;
};

/** 无画像时 scoreCandidate / scoreUpperBound 的 rating 权重（3.3 的 0.4 / 0.3 / 0.2 / 0.1）。 */
const DEFAULT_RATING_WEIGHT = 0.4;

/**
 * 画像的 rating 权重：契约口径是「rich 0.3 → 0.45、powerful 0.3 → 0.2」（其余权重不变；
 * 排名等价于归一化）。现有代码的 rating 权重实际是 0.4，这里按契约给出的**目标值**
 * 0.45 / 0.2 落地（绝对值），报告里记录这处与任务书数字的偏差。
 */
const PROFILE_RATING_WEIGHT: Record<TravelStyle, number> = { rich: 0.45, powerful: 0.2 };

/** 画像的站数硬上限：rich 3；powerful 沿用 MAX_STOPS（下面用字面量 6，避免 const 顺序耦合）。 */
const PROFILE_MAX_STOPS: Record<TravelStyle, number> = { rich: 3, powerful: 6 };

/** rich：非餐厅站停留 90 分钟（餐厅保持类目原值，避免顶穿正餐窗口）。 */
const RICH_NON_RESTAURANT_STAY_MIN = 90;

/** rich：优先加权（非过滤）——importance ≥3 且 rating ≥4.3。 */
const RICH_PRIORITY_MIN_IMPORTANCE = 3;
const RICH_PRIORITY_MIN_RATING = 4.3;
/** powerful：优先加权（非过滤）——老街/工业/市井/森林，或 market/other。 */
const POWERFUL_PRIORITY_SCENERY_TYPES: readonly string[] = ["老街", "工业", "市井", "森林"];
const POWERFUL_PRIORITY_CATEGORIES: readonly PlaceCategory[] = ["market", "other"];
/** 画像优先加权系数（两种 style 共用同一个 ×1.25）。 */
const STYLE_PRIORITY_MULTIPLIER = 1.25;

/** scene 优先加权系数（×1.5）：scenery / culture 各自命中的条件见下。 */
const SCENE_PRIORITY_MULTIPLIER = 1.5;
/**
 * M18：带 scene 画像时，预筛池给「场景匹配候选」预留的名额（总共仍只取 PREFILTER_LIMIT=6 个）。
 * - scenery 取 3：够让第 1 站和后续轮次看到风光点，又不把预筛全换成远处候选；
 * - culture 取 5：用户验收 6 的严格名单（书店/博物馆/美术馆/市场/老街）在杭州很稀疏、
 *   且不少场馆下午就关门，多留名额才能保证挑到一个「还开着 + 到得了」的严格目标站。
 */
const SCENE_PREFILTER_RESERVED = 3;
const CULTURE_PREFILTER_RESERVED = 5;
/** scenery：江景 / 森林 / 田野 / 园林，或 park。 */
const SCENERY_SCENE_TYPES: readonly string[] = ["江景", "森林", "田野", "园林"];
/**
 * culture：用户验收 6 的严格名单 = 书店 / 博物馆 / 美术馆 / 市场 或 sceneryType=老街（×1.5，主目标）；
 * 契约 §3 额外纳入的 建筑 / 市井 降为次级 ×1.2（只参与打分，不参与第 1 站优先 / 预筛预留）。
 */
const CULTURE_SCENE_CATEGORIES: readonly PlaceCategory[] = ["bookstore", "museum", "gallery", "market"];
const CULTURE_SECONDARY_SCENERY_TYPES: readonly string[] = ["建筑", "市井"];
const CULTURE_SECONDARY_MULTIPLIER = 1.2;

/** rich：餐厅人均 <60 元排除（avgCost === null 视为未知，保留）。 */
const RICH_MIN_RESTAURANT_AVG_COST = 60;
/** powerful：餐厅人均 >60 元排除（avgCost === null 视为未知，保留）。 */
const POWERFUL_MAX_RESTAURANT_AVG_COST = 60;
/** powerful：所有候选的硬底线——rating ≥3.5 或 importance ≥2（满足其一）。 */
const POWERFUL_MIN_RATING = 3.5;
const POWERFUL_MIN_IMPORTANCE = 2;
/** powerful：步行半径 30 → 50 分钟（只改半径判定，不改 lib/constraints.ts）。 */
const POWERFUL_WALK_RADIUS_MIN = 50;

/** 把请求里的 profile 变成 planner 内部调参表；没有 profile 返回 undefined（= 旧行为）。 */
function buildProfileTuning(profile: TravelProfile | undefined): ProfileTuning | undefined {
  if (profile === undefined) return undefined;
  return {
    style: profile.style,
    scene: profile.scene,
    ratingWeight: PROFILE_RATING_WEIGHT[profile.style],
    maxStops: PROFILE_MAX_STOPS[profile.style],
    nonRestaurantStayMin: profile.style === "rich" ? RICH_NON_RESTAURANT_STAY_MIN : undefined,
    // 旧画像没有这个字段（zod default 会补 true）；这里再兜一层「不是 false 就算 true」。
    mealIncluded: profile.mealIncluded !== false,
  };
}

/**
 * 这次排程要不要安排吃饭。
 * - 没有 profile（老调用方 / 离线脚本）→ true（行为与改造前逐字一致）；
 * - mealIncluded === true → true；
 * - mealIncluded === false → false：候选池剔除 restaurant、跳过所有用餐硬约束（cafe 保留）。
 */
function wantsMeal(profile: ProfileTuning | undefined): boolean {
  return profile === undefined || profile.mealIncluded !== false;
}

/** 一个地点是否命中 style 的优先加权（只看「去什么样的地方」，不做过滤）。 */
function stylePriorityHit(place: Place, profile: ProfileTuning): boolean {
  if (profile.style === "rich") {
    const importance = place.importance;
    return (
      importance !== undefined &&
      importance >= RICH_PRIORITY_MIN_IMPORTANCE &&
      place.rating !== null &&
      place.rating >= RICH_PRIORITY_MIN_RATING
    );
  }
  const sceneryType = place.scenery === undefined ? null : place.scenery.sceneryType;
  if (sceneryType !== null && POWERFUL_PRIORITY_SCENERY_TYPES.indexOf(sceneryType) !== -1) return true;
  return POWERFUL_PRIORITY_CATEGORIES.indexOf(place.category) !== -1;
}

/**
 * culture 的**主目标（用户验收 6 的严格名单）**：category ∈ [bookstore,museum,gallery,market]
 * 或 sceneryType=老街。用户原文「至少 3 站是书店/博物馆/美术馆/市场/老街」以此为准；
 * 契约 §3 额外纳入的 建筑 / 市井 只作为**次级加权**（见 CULTURE_SECONDARY_MULTIPLIER）。
 */
function cultureStrictHit(place: Place): boolean {
  const sceneryType = place.scenery === undefined ? null : place.scenery.sceneryType;
  return CULTURE_SCENE_CATEGORIES.indexOf(place.category) !== -1 || sceneryType === "老街";
}

/**
 * 一个地点是否命中 scene 的「优先目标」（第 1 站优先扫描 / 预筛预留名额用；scene=any 恒不命中）。
 * - scenery：park 或 风光类 sceneryType；
 * - culture：**只用严格名单**（用户验收 6），建筑 / 市井 不参与第 1 站与预筛优先，
 *   避免它们把 4 站里宝贵的名额占掉。
 */
function scenePriorityHit(place: Place, profile: ProfileTuning): boolean {
  if (profile.scene === "any") return false;
  const sceneryType = place.scenery === undefined ? null : place.scenery.sceneryType;
  if (profile.scene === "scenery") {
    if (sceneryType !== null && SCENERY_SCENE_TYPES.indexOf(sceneryType) !== -1) return true;
    return place.category === "park";
  }
  return cultureStrictHit(place);
}

/**
 * scene 的打分乘数（恒为正）：
 * - scenery：命中 ×1.5；
 * - culture：严格名单 ×1.5（用户验收 6 的主目标），建筑 / 市井 次级 ×1.2（契约 §3 的补充口径）；
 * - any / 不命中：×1。
 * 永远乘在 scoreCandidate 与 scoreUpperBound 两边（剪枝安全）。
 */
function sceneScoreMultiplier(place: Place, profile: ProfileTuning): number {
  if (profile.scene === "any") return 1;
  if (scenePriorityHit(place, profile)) return SCENE_PRIORITY_MULTIPLIER;
  if (profile.scene === "culture") {
    const sceneryType = place.scenery === undefined ? null : place.scenery.sceneryType;
    if (sceneryType !== null && CULTURE_SECONDARY_SCENERY_TYPES.indexOf(sceneryType) !== -1) {
      return CULTURE_SECONDARY_MULTIPLIER;
    }
  }
  return 1;
}

/**
 * 画像打分乘数（恒为正常数）：style 优先 ×1.25、scene 优先（见 sceneScoreMultiplier），多命中连乘。
 * 不传 profile 时恒为 1（调用方会先判 undefined，这里再兜一层）。
 */
function profileScoreMultiplier(place: Place, profile?: ProfileTuning): number {
  if (profile === undefined) return 1;
  let multiplier = 1;
  if (stylePriorityHit(place, profile)) multiplier *= STYLE_PRIORITY_MULTIPLIER;
  multiplier *= sceneScoreMultiplier(place, profile);
  return multiplier;
}

/**
 * 画像硬过滤（进候选池之前生效，随机种子无法绕过）：
 * - rich：餐厅 avgCost <60 排除；null（未知）保留，否则小城市会没有餐厅可用；
 * - powerful：餐厅 avgCost >60 排除；所有候选必须 rating ≥3.5 或 importance ≥2。
 * 不传 profile 时一律放行（0 行为变化）。
 */
function profileAllowsPlace(place: Place, profile?: ProfileTuning): boolean {
  if (profile === undefined) return true;
  if (place.category === "restaurant" && place.avgCost !== null) {
    if (
      profile.style === "rich" &&
      profile.restaurantFloorDisabled !== true &&
      place.avgCost < RICH_MIN_RESTAURANT_AVG_COST
    ) {
      return false;
    }
    if (profile.style === "powerful" && place.avgCost > POWERFUL_MAX_RESTAURANT_AVG_COST) return false;
  }
  if (profile.style === "powerful") {
    const ratingOk = place.rating !== null && place.rating >= POWERFUL_MIN_RATING;
    const importanceOk = place.importance !== undefined && place.importance >= POWERFUL_MIN_IMPORTANCE;
    return ratingOk || importanceOk;
  }
  return true;
}

/** 一站停留时长：rich 的非餐厅站 90 分钟；其余（含餐厅）一律按类目原值 STAY_MIN。 */
function stayMinForPlace(place: Place, profile?: ProfileTuning): number {
  if (profile?.nonRestaurantStayMin !== undefined && place.category !== "restaurant") {
    return profile.nonRestaurantStayMin;
  }
  return STAY_MIN[place.category];
}

/**
 * 画像感知的通勤半径判定：powerful 的步行上限从 30 提到 50 分钟。
 * lib/constraints.ts 的 withinRadius / RADIUS_LIMIT_MIN 一个字不改——override 只在这里做。
 */
function withinProfileRadius(durationMin: number, mode: SegmentMode, profile?: ProfileTuning): boolean {
  if (profile?.style === "powerful" && mode === "walk") {
    return durationMin <= POWERFUL_WALK_RADIUS_MIN;
  }
  return withinRadius(durationMin, mode);
}

/** 画像的站数硬上限；不传 profile = 现有 MAX_STOPS（6）。 */
function profileMaxStops(profile?: ProfileTuning): number {
  return profile === undefined ? MAX_STOPS : profile.maxStops;
}

/**
 * rich 允许打车：只构造一份**规划用的 mode 副本**（timeFirst=true → decideCommute 的
 * 行5 会在 >3km 时用 drive），绝不改 constraintsInput / 用户偏好本身。
 * powerful「用体力换钱」：规划用的 mode 副本打开 profileNoBus（公交不参与选点，
 * 只走步行 / 骑行），对应契约验收 #4「powerful 全步行/骑行」。
 */
function planningPickMode(mode: PickMode, profile?: ProfileTuning): PickMode {
  if (profile === undefined) return mode;
  if (profile.style === "rich") return { ...mode, timeFirst: true };
  // powerful：禁公交 + 禁打车（timeFirst/下雨/带老小 三条打车入口一律关掉，只留步行 / 骑行）。
  return { ...mode, timeFirst: false, raining: false, withElderOrChild: false, profileNoBus: true };
}

/**
 * 任务2：路线方位单调性上下文。
 * - origin：行程起点（每站到它的直线距离构成序列）；
 * - priorDistances：已经选中的站点按访问顺序到起点的直线距离（米）。
 * pickNext 的候选池只含预筛后的候选、不含已选站，所以 priorDistances 必须由调用方算好传来。
 *
 * 环线形状改造（本轮）：新增可选字段 firstStop。
 */
export type RouteShape = {
  origin: { lng: number; lat: number };
  priorDistances: number[];
  /**
   * 第 1 站规则（可选，只应由「第 1 轮」的调用方传 true）：
   * 候选按到 origin 的直线距离升序扫，取第一个**通过全部过滤**且满足
   * 「importance ≥2 或 rating ≥3.5」的点；没有这样的点就退回原来的打分逻辑。
   *
   * 不传 = 旧行为（纯打分），所以 replaceStop / 日落锚点路径里的其它调用点行为不变。
   */
  firstStop?: boolean;
  /**
   * 随机种子（可选，「再来一条」用）：
   * 给了它，候选打分就会乘一个由 (seed, placeId) 决定的伪随机系数（恒 ≤1，落在 [0.75, 1]），
   * 让同样合规的候选换出不同的组合；同一个 seed 永远得到同一条路线（可复现）。
   *
   * 不传 = 完全确定性，行为与改造前**逐字一致**——所有既有验收（check-loopshape 的
   * placeId 基线、try-itinerary 的三组结果）都依赖这一点。
   * 硬规则不受影响：第 1 站「最近的合规点」、距离带 / 距离递增、800m 去重、用餐时段、
   * 预算与营业时间全部照旧，种子只改「在合规候选里选谁」。
   *
   * 本轮起 seed 也影响第 1 站：带 seed 时按「最近 5 个合规候选 + 权重 1/(1+名次)」加权随机，
   * 不再永远从最近的合规点出发；不带 seed 时行为逐字不变。
   */
  seed?: number;
  /**
   * 「再来一条」可选：本会话已经出现过的 stops placeId 列表。
   * **作用于所有站的候选过滤**（第 1 站、后续站、补站轮、强制用餐轮、用餐兜底重排、日落锚点路径、
   * 远区预筛统一排除），只缩小候选池，不改任何硬约束；排除后候选池为空会如实返回
   * `EXCLUDE_EXHAUSTED_REASON`，绝不静默忽略。
   * 不传 / 空数组 = 不排除，行为与改造前逐字一致。
   */
  excludePlaceIds?: string[];
  /**
   * M21 远区预筛：远区候选 → 已经判定过的通勤（由 planRounds 的远区预筛在「进候选池前」
   * 用该 style 允许的交通方式算好）。pickNext 对这些候选**直接复用**这一步的结果，
   * 不重复调接口、也不会在打分后再按交通方式反悔。不传 = 没有远区候选（旧行为）。
   */
  farZoneCommutes?: ReadonlyMap<string, Commute>;
};

/**
 * 第 1 站「合规」口径（任务书第一步第 1 条，逐字）：
 * importance ≥2 或 rating ≥3.5。星数 / 评分缺失不算命中。
 * 导出给 scripts/check-loopshape.ts 复算「最近的合规点」用，避免两处口径漂移。
 */
export const FIRST_STOP_MIN_IMPORTANCE = 2;
export const FIRST_STOP_MIN_RATING = 3.5;

export function isFirstStopQualified(place: Place): boolean {
  const ratingOk = place.rating !== null && place.rating >= FIRST_STOP_MIN_RATING;
  const importanceOk = place.importance !== undefined && place.importance >= FIRST_STOP_MIN_IMPORTANCE;
  return ratingOk || importanceOk;
}

/**
 * 任务2：路线方位单调性扣分（只作用于选站打分，返程段天然往回走、不参与）。
 *
 * 距离序列 = 已选站点按访问顺序到起点的直线距离 + 新站距离；
 * 「拐点」= 相邻差值（增 / 减）方向改变的次数，差值 0 不改变方向、也不计数。
 * 拐点 0-1 次 → ×1；2 次 → ×0.8；3+ 次 → ×0.6（不硬排除，只降分）。
 *
 * 环线形状改造（本轮）：系数从 0.5 / 0.2 降为 0.8 / 0.6——主形状已由
 * 「第 i 站距离 ≥ 上一站 ×0.9」的硬过滤保证，拐点扣分退成弱兜底。
 *
 * 安全性：乘数恒在 (0, 1]，所以新分 = base × m ≤ base ≤ scoreUpperBound（未乘的严格上界），
 * pickNext 里按上界剪枝仍然成立——**不要**把乘数乘到 scoreUpperBound 上，那会过度剪枝。
 */
function routeShapeMultiplier(routeShape: RouteShape | undefined, place: Place): number {
  if (routeShape === undefined) return 1;
  const distances = [...routeShape.priorDistances, haversineMeters(routeShape.origin, place)];
  let turns = 0;
  let previousDirection = 0;
  for (let index = 1; index < distances.length; index += 1) {
    const diff = distances[index] - distances[index - 1];
    if (diff === 0) continue;
    const direction = diff > 0 ? 1 : -1;
    if (previousDirection !== 0 && direction !== previousDirection) turns += 1;
    previousDirection = direction;
  }
  if (turns >= 3) return 0.6;
  if (turns === 2) return 0.8;
  return 1;
}

/* ------------------------------------------------------------------ *
 * 「再来一条」的随机扰动（M16 新增；本轮调整）
 *
 * 目的：同一组条件下，让「再来一条」给出一条**不同但同样合规**的路线。
 * 做法：候选打分乘一个由 (seed, placeId) 决定的伪随机系数，范围 [1 - 0.25, 1] = [0.75, 1]。
 *
 * 三条安全边界：
 * 1. 系数恒 ≤1：pickNext 的按「打分上界」剪枝仍安全（真实分 ≤ 上界，不会漏掉真正的赢家）。
 * 2. 只影响「选谁」，不影响任何硬规则（过滤发生在打分之前）。
 * 3. 不用 Math.random：纯哈希，所以同一个 seed 每次结果相同（可复现、可测）。
 * seed 不传 → 系数恒 1 → 行为与改造前逐字一致。
 *
 * 历史说明：本常量曾长期写作 0.35（实际区间 [0.65,1]），但文件里的注释一直写 0.15（[0.85,1]）——
 * 文档与实现不一致。本轮按任务书目标值统一为 [0.75,1]（RANGE = 0.25）。
 * ------------------------------------------------------------------ */

/** 随机扰动的最大跌幅（0.25 = 最多降 25% 分 → 系数落在 [0.75, 1]）。 */
const RANDOM_ROUTE_JITTER_RANGE = 0.25;

/** (seed, salt) → [0, 1] 的确定性伪随机数（FNV-1a 哈希；无随机源，同一输入永远同一输出）。 */
function seededUnit(seed: number, salt: string): number {
  let hash = (seed >>> 0) ^ 0x811c9dc5;
  for (let index = 0; index < salt.length; index += 1) {
    hash ^= salt.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % 1000) / 999;
}

/** (seed, placeId) → [1 - RANGE, 1] 的确定性系数；seed 未传时恒 1。FNV-1a 哈希，无随机源。 */
function routeJitter(seed: number | undefined, placeId: string): number {
  if (seed === undefined) return 1;
  return 1 - seededUnit(seed, placeId) * RANDOM_ROUTE_JITTER_RANGE;
}

/* ------------------------------------------------------------------ *
 * 「再来一条」的第 1 站加权随机（本轮新增）
 *
 * 根因：第 1 站走的是「距离最近的合规点」规则，根本不经过打分，而 seed 的随机系数
 * 只乘在打分上 → 第 1 站完全不受 seed 影响，「再来一条」永远从同一个地方出发。
 *
 * 做法（只在带 seed 时生效）：
 *   1. 按到 origin 的直线距离升序，收集**通过全部硬过滤**且合规的前 5 个候选；
 *   2. 权重 = 1 / (1 + 名次)（第 1 名 1、第 2 名 0.5、第 3 名 0.33…），用 seed 加权随机；
 *      → 最近的那个仍然最可能被选中，但不是必然；同一 seed 可复现。
 *
 * 硬约束一条都不松：候选必须已经通过 evaluateCached 里的营业时间 / 半径 / 预算 / 已去过 /
 * 用餐时段 / 类目多样性 / 画像过滤；第 1 站的「合规」（importance≥2 或 rating≥3.5）口径也不变。
 * 无 seed 时完全走旧逻辑（最近合规点），行为逐字不变。
 * ------------------------------------------------------------------ */

/** 第 1 站加权随机的候选窗口大小：按距离升序取前 N 个「合规且通过全部过滤」的候选。 */
const FIRST_STOP_RANDOM_WINDOW = 5;

/**
 * 用 seed 在 [0, count) 里按「权重 = 1/(1+名次)」选一个下标。
 * 名次按传入顺序（调用方传距离升序的候选）从 0 开始：权重 1、1/2、1/3、1/4、1/5。
 */
function weightedFirstStopIndex(seed: number, count: number): number {
  const weights: number[] = [];
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    const weight = 1 / (index + 1);
    weights.push(weight);
    total += weight;
  }
  let remaining = seededUnit(seed, "first-stop") * total;
  for (let index = 0; index < count; index += 1) {
    remaining -= weights[index];
    if (remaining < 0) return index;
  }
  return count - 1;
}

/* ------------------------------------------------------------------ *
 * 环线形状：第 i 站（i≥2）的距离单调上涨
 *
 * 任务书第一步第 2 条：打分前先过滤，只保留
 *   distance_from_origin ≥ 上一站距离 × 0.9 的候选；
 * 过滤后为空 → 放宽到 ×0.75；再空 → 调用方停止排站（不加这一站）。
 *
 * 过滤放在 selectNearby 之前（planRounds 里）：预筛的 6 个候选全都在合规集合内，
 * 不会出现「预筛把合规点筛掉、再拿不合规的点凑数」。
 * 日落锚点路径（tryPlanSunsetReserved）在锚点站之后的选站也复用这个函数。
 * ------------------------------------------------------------------ */

/** 正常要求：新站到起点距离 ≥ 上一站距离 × 0.9。 */
const ROUTE_DISTANCE_KEEP_RATIO = 0.9;
/** 放宽要求：× 0.9 无候选时降到 × 0.75，再空才停止排站。 */
const ROUTE_DISTANCE_RELAX_RATIO = 0.75;

/** 「往外走也没地方了」的人话原因（只在两档过滤都为空、停止加站时使用）。 */
const ROUTE_DISTANCE_EXHAUSTED_REASON = "往外的方向已经走到头了，附近没有更远一点的落脚处";

type RouteDistanceFilterResult = {
  pool: Place[];
  /** true = 用了 ×0.75 的放宽档（报告 / 调试可用）。 */
  relaxed: boolean;
};

/**
 * 按「到起点的直线距离」过滤候选：先 ×0.9，空则 ×0.75，再空返回 null（= 停止排站）。
 * previousDistance 是上一站到起点的直线距离（米）。
 */
function filterByRouteDistance(
  pool: Place[],
  originPoint: { lng: number; lat: number },
  previousDistance: number,
): RouteDistanceFilterResult | null {
  const strict = pool.filter(
    (place) => haversineMeters(originPoint, place) >= previousDistance * ROUTE_DISTANCE_KEEP_RATIO,
  );
  if (strict.length > 0) return { pool: strict, relaxed: false };
  const relaxed = pool.filter(
    (place) => haversineMeters(originPoint, place) >= previousDistance * ROUTE_DISTANCE_RELAX_RATIO,
  );
  if (relaxed.length > 0) return { pool: relaxed, relaxed: true };
  return null;
}

/* ------------------------------------------------------------------ *
 * 3.5 reason：只引用真实字段值
 * ------------------------------------------------------------------ */

const MODE_LABEL: Record<SegmentMode, string> = {
  walk: "步行",
  bus: "公交",
  drive: "打车",
  bike: "骑行",
};

/**
 * 形如「评分 4.4，步行 6 分钟能到，人均 58 在预算内」；只引用真实字段值，不写没有信息量的形容词。
 * 人均为 null 时不装成真实价格：
 * - 文化场馆 / 其他 →「人均未标注」；
 * - 餐厅 / 咖啡 →「人均未标注，按同类均价 50 元估」（和 estimateCost 的兜底口径一致）。
 */
function buildReason(place: Place, commute: Commute, costBasis: CostBasis, costEstimate: number): string {
  const ratingText = place.rating === null ? "评分未标注" : `评分 ${place.rating.toFixed(1)}`;
  const durationText = commute.durationMin === 0 ? "不到 1 分钟" : ` ${commute.durationMin} 分钟`;
  let costText: string;
  if (costBasis === "actual") {
    costText = `人均 ${costEstimate} 在预算内`;
  } else if (costBasis === "category-average") {
    costText = `人均未标注，按同类均价 ${costEstimate} 元估`;
  } else {
    costText = "人均未标注";
  }
  return `${ratingText}，${MODE_LABEL[commute.mode]}${durationText}能到，${costText}`;
}

/* ------------------------------------------------------------------ *
 * 过滤 / 失败原因
 * ------------------------------------------------------------------ */

type Rejections = {
  hours: number;
  radius: number;
  budget: number;
  visited: number;
  noRoute: number;
  /** M5 收尾修复：餐厅处在非正餐时段，或该正餐时段今天已经有餐厅了。 */
  mealSlot: number;
};

type Candidate = {
  place: Place;
  commute: Commute;
  arriveAt: number;
  stayMin: number;
  costEstimate: number;
  costBasis: CostBasis;
  score: number;
};

function buildFailureReason(
  rejections: Rejections,
  cheapestBudgetNeed: number | null,
  budgetLeft: number,
  poolSize: number,
): string {
  if (poolSize === 0) return "候选池是空的：没有可推荐的地点";

  const totalRejected =
    rejections.hours +
    rejections.radius +
    rejections.budget +
    rejections.visited +
    rejections.noRoute +
    rejections.mealSlot;

  // 只有预算卡住时，单独把「差多少钱」说清楚（M3 3.6 的例子：预算不足，…需 45 元）。
  if (rejections.budget > 0 && rejections.budget === totalRejected) {
    const need = cheapestBudgetNeed === null ? "未知" : `${cheapestBudgetNeed} 元`;
    return `预算不足：剩余 ${budgetLeft} 元，最便宜的候选点要 ${need}`;
  }

  const parts: string[] = [];
  if (rejections.hours > 0) parts.push(`${rejections.hours} 个点到达时不在营业时间`);
  if (rejections.radius > 0) parts.push(`${rejections.radius} 个点通勤超过半径上限`);
  if (rejections.budget > 0) {
    const need = cheapestBudgetNeed === null ? "" : `，最便宜也要 ${cheapestBudgetNeed} 元`;
    parts.push(`${rejections.budget} 个点超出剩余预算 ${budgetLeft} 元${need}`);
  }
  if (rejections.visited > 0) parts.push(`${rejections.visited} 个点今天已经去过`);
  if (rejections.mealSlot > 0) parts.push(`${rejections.mealSlot} 个餐厅不在正餐时段或该时段已有餐厅`);
  if (rejections.noRoute > 0) parts.push(`${rejections.noRoute} 个点算不出可用路线`);
  return `没有可选的下一站：${parts.join("，")}`;
}

function compareCandidates(a: Candidate, b: Candidate): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a.commute.durationMin !== b.commute.durationMin) {
    return a.commute.durationMin - b.commute.durationMin;
  }
  return a.place.id.localeCompare(b.place.id);
}

/* ------------------------------------------------------------------ *
 * 并发查路线
 * ------------------------------------------------------------------ */

/** 高德接口并发上限：太高会被限流（表现为部分候选「算不出路线」，一次抖动不该让整片候选失效）。 */
const ROUTE_CONCURRENCY = 2;

/**
 * getRoute 失败（网络抖动 / 限流）返回 null；重试一次再放弃。
 * 注意：这里只重试「算不出来」的请求，不改时长、不改方式，也不把失败当 0 分钟用。
 */
async function getRouteWithRetry(
  from: { lng: number; lat: number },
  to: { lng: number; lat: number },
  mode: SegmentMode,
  cityCode?: string,
): Promise<{ durationMin: number; distanceM: number } | null> {
  // 公交（bus）必须带城市码（cityCode），否则 lib/amap.ts 直接返回 null；其它方式不需要。
  const first = await getRoute(from, to, mode, { cityCode });
  if (first !== null) return first;
  return getRoute(from, to, mode, { cityCode });
}

/* ------------------------------------------------------------------ *
 * 当天硬性结束上限（夜间跨午夜修复）
 * ------------------------------------------------------------------ */

/** pickNext 的当日上限参数：超过 lastEndMinute 的候选直接丢弃（跨午夜是正常场景，不抛错）。 */
export type PickLimits = {
  /** 当天硬性结束上限（当日分钟数，1410 = 23:30）。 */
  lastEndMinute: number;
  /** 返程终点坐标（默认 = 起点）；只有接近上限时才用来算真实返程。 */
  destination: { lng: number; lat: number };
  /**
   * 任务5（可选）：短窗口的停留下限（分钟）。只有可用时长 <90 时由 planRounds 传入；
   * 不传 = 按候选真实停留 full-stay 预判（白天行为与改造前一致）。
   */
  minStayMin?: number;
};

/**
 * 候选是否会撑破当天硬性结束上限：leaveAt（= 到达 + 停留）+ 返程时长 > lastEndMinute。
 *
 * 两级判定，保证白天不新增任何 getRoute 请求：
 * 1. 直线返程估算 + 余量仍然装得下 → 直接放行（白天所有候选都走这条，选点结果与改造前一致）；
 * 2. 接近上限（晚间）才用与返程段同一套 decideCommute 算真实返程；算不出路线按装不下处理。
 */
async function exceedsLastEnd(
  candidatePoint: { lng: number; lat: number },
  arriveAt: number,
  stayMin: number,
  mode: PickMode,
  cityCode: string | undefined,
  limits: PickLimits,
): Promise<boolean> {
  // 任务5：短窗口传了 minStayMin 时，用「动态下限 vs 真实停留」较小值做当天上限预判，
  // 避免候选被 full-stay 的 lastEnd 预判全杀掉（例如 22:30 辽阳）；白天不传 = 原行为。
  const stayForCheck =
    limits.minStayMin === undefined ? stayMin : Math.min(limits.minStayMin, stayMin);
  const leaveAt = arriveAt + stayForCheck;
  const estimatedReturnMin = Math.ceil(estimateWalkMinutes(candidatePoint, limits.destination));
  if (leaveAt + estimatedReturnMin + LAST_END_SHORTCUT_MARGIN_MIN <= limits.lastEndMinute) {
    return false;
  }
  const returnCommute = await decideCommute(candidatePoint, limits.destination, mode, cityCode);
  if (returnCommute === null) return true;
  return leaveAt + returnCommute.durationMin > limits.lastEndMinute;
}

/* ------------------------------------------------------------------ *
 * M20 类目多样性（本轮新增约束）
 *
 * 产品口径：一条行程里每一站的类目互不相同，吃喝（cafe + restaurant）全天最多两站。
 * 三条规则：
 *   1. 候选 category 已经在 mode.usedCategories 里 → 排除（硬过滤）；
 *   2. mode.usedDiningCount >= 2 且候选是 cafe / restaurant → 排除（硬过滤）；
 *   3. 名称含「得来速 / 外卖 / 配送 / 自提 / 打包」→ 打分 ×0.3（**软降权，不排除**）。
 *
 * 三条规则和「800m 同区域去重 / 距离递增 / 营业时间」并列，都是候选过滤阶段的硬约束
 * （第 3 条除外，它只影响排序），不受 profile / 用户偏好影响；过滤后为空就由调用方停站，
 * 绝不为了凑数放行重复类目。
 * ------------------------------------------------------------------ */

/** 算「吃喝」的类目：cafe + restaurant 合计最多 2 次。 */
const DINING_CATEGORIES: readonly PlaceCategory[] = ["cafe", "restaurant"];

/** 名称里带这些词的候选「不适合坐下待一会儿」：打分 ×0.3 降权（不排除）。 */
const LOW_PRIORITY_NAME_KEYWORDS: readonly string[] = ["得来速", "外卖", "配送", "自提", "打包"];

/** 软降权系数（只压分，不放宽任何硬约束）。 */
const LOW_PRIORITY_NAME_MULTIPLIER = 0.3;

function isDiningCategory(category: PlaceCategory): boolean {
  return DINING_CATEGORIES.indexOf(category) !== -1;
}

/**
 * 类目多样性硬过滤：true = 这个候选本轮不能排（没有任何例外 / 不放宽档位）。
 *
 * restaurant 是「用餐硬约束」的专属类目：跨午餐 + 晚餐的长行程必须在两个正餐时段各安排
 * 一家餐厅，所以「类目已经用过」不能挡 restaurant（否则第二顿饭永远排不进来，旧行为里
 * 午餐 + 晚餐各一家餐厅的行程会退化成只有午餐）。餐厅总数仍由规则 2（usedDiningCount>=2）
 * 和 assertRestaurantSlots（全天最多 2 家、且必须分别落在午餐 / 晚餐）共同约束。
 * cafe 不豁免：房山 / 顺义的验收要求「4 站类目互不相同」，第二家咖啡必须被规则 1 挡掉。
 */
function isCategoryExcluded(
  place: Place,
  usedCategories: readonly PlaceCategory[] | undefined,
  usedDiningCount: number | undefined,
): boolean {
  if (
    place.category !== "restaurant" &&
    usedCategories !== undefined &&
    usedCategories.indexOf(place.category) !== -1
  ) {
    return true;
  }
  const diningCount = usedDiningCount === undefined ? 0 : usedDiningCount;
  return diningCount >= 2 && isDiningCategory(place.category);
}

/** 名称软降权：外卖 / 自提这类店仍然可以入选，只是排序时排在普通店后面。 */
function namePriorityMultiplier(place: Place): number {
  for (const keyword of LOW_PRIORITY_NAME_KEYWORDS) {
    if (place.name.indexOf(keyword) !== -1) return LOW_PRIORITY_NAME_MULTIPLIER;
  }
  return 1;
}

/* ------------------------------------------------------------------ *
 * M21 跨两餐餐厅差异化
 *
 * 任务书：第二家餐厅的「名称前两个字」不能和第一家相同；不满足就换一家，
 * 换不出来就接受（不能因此少站）。因此这里是**软约束**：
 *   - 命中已用前缀 → 打分 ×0.02（正常餐厅之间几乎必输，能换就换）；
 *   - 全城真的只有同前缀餐厅时，同前缀候选仍可胜出 → 不会少站；
 *   - 最终确实重复时由 planRounds 在控制台注明（任务书要求）。
 * 用 Array.from 取前两个字符，避免把 emoji / 代理对切成半个字符。
 * ------------------------------------------------------------------ */

/** 餐厅店名前两个字。 */
function restaurantNamePrefix(name: string): string {
  return Array.from(name.trim()).slice(0, 2).join("");
}

/** 同名前缀的软降权系数（只压分，不排除）。 */
const DUPLICATE_RESTAURANT_PREFIX_MULTIPLIER = 0.02;

/** 第二家餐厅命中已用前缀时的打分系数；其它情况恒 1（不影响旧行为）。 */
function restaurantPrefixMultiplier(place: Place, usedPrefixes: readonly string[] | undefined): number {
  if (place.category !== "restaurant" || usedPrefixes === undefined || usedPrefixes.length === 0) return 1;
  return usedPrefixes.indexOf(restaurantNamePrefix(place.name)) === -1
    ? 1
    : DUPLICATE_RESTAURANT_PREFIX_MULTIPLIER;
}

/* ------------------------------------------------------------------ *
 * 3.2 主函数
 * ------------------------------------------------------------------ */

/**
 * 选出下一站。
 *
 * 必须按这个顺序走，不许合并步骤（M3 3.2）：
 *   1. 过滤：若到达时刻不在营业时间 / 停留会拖过闭馆 → 剔除
 *   2. 过滤：通勤时长超出该交通方式半径上限 → 剔除
 *   3. 过滤：canAfford 为 false → 剔除
 *   4. 过滤：当天已去过 → 剔除
 *   5. 过滤：餐厅不在未占用的正餐时段 → 剔除（M5 收尾修复，见 mealSlotFor）
 *   6. 打分
 *   7. 取 top1，算出 arriveAt / stayMin / costEstimate，生成 reason
 *
 * M4.5 性能改造（只改「怎么拿数据」，判定一条没动）：
 *   - 先按**打分上界**从高到低排，再按估算步行分钟从近到远；
 *   - 先算最可能胜出的那 1 个，拿到真实最高分后，把「上界都打不过它」的候选
 *     直接剪掉，**不调接口**（上界是严格上界，所以不会影响选谁）；
 *   - 剩下的按原并发上限 2 个一批算，避免为了剪枝把并发降到 1 把冷启动拖慢。
 *
 * 任务2（可选 routeShape）：把「已选站到起点的距离序列」带进来做方位单调性扣分；不传 = 不扣分。
 * 乘数恒 ≤1，scoreUpperBound 仍是未乘的严格上界，按上界剪枝安全。
 *
 * 环线形状改造（可选 routeShape.firstStop）：只由「第 1 轮」的调用方传 true——候选按到 origin 的
 * 直线距离升序扫，取第一个通过全部过滤且合规（importance ≥2 或 rating ≥3.5）的点；没有就走原打分。
 * 第 i 站（i≥2）的「距离 ≥ 上一站×0.9」过滤不在这里做，由调用方在预筛前过滤候选池（见 filterByRouteDistance）。
 *
 * 注意：函数是 async 的——M2 的 getRoute 是异步请求。返回结构里的成功分支不带 reason。
 */
export async function pickNext(
  currentPlace: Place,
  now: number,
  pool: Place[],
  budgetLeft: number,
  mode: PickMode = {},
  cityCode?: string,
  /** 本轮新增（夜间跨午夜修复）：当天硬性结束上限；不传 = 不做上限预判（旧调用方行为不变）。 */
  limits?: PickLimits,
  /**
   * 任务2（可选）：路线方位单调性上下文（起点 + 已选站按访问顺序到起点的直线距离）。
   * 环线形状改造：还带可选的 firstStop（第 1 站规则）。
   * 不传 = 不扣分、不套第 1 站规则——日落锚点前置 / replaceStop 等其他调用点都不传。
   */
  routeShape?: RouteShape,
  /**
   * M18（内部，可选）：画像调参表。不传 = 与改造前逐字一致（既有调用方 / check-loopshape 基线）。
   * 画像的过滤（avgCost / 评分底线）在这里再兜一层——调用方（planRounds）已经预筛过，
   * 这里兜底保证「直接调 pickNext 并传 tuning」也不会把不合画像的点排进去。
   */
  profile?: ProfileTuning,
): Promise<PickResult> {
  const from = PlaceSchema.parse(currentPlace);
  const parsedPlaces = z.array(PlaceSchema).parse(pool);
  const pickMode = PickModeSchema.parse(mode);
  /**
   * 「再来一条」（本轮修复根因 2）：excludePlaceIds 影响**所有站**的候选过滤，不只是第 1 站。
   * 与「当天已去过」同一层级：先把本会话出现过的站点整体剔除，再走画像 / 类目多样性 /
   * 同区域去重 / 距离递增 / 打分。只缩小候选池，不改任何硬约束。
   * 排除后候选池为空 → 如实返回 EXCLUDE_EXHAUSTED_REASON（绝不为了「总能换」而静默忽略 exclude）。
   * 不传 / 空数组 = 不排除，行为与改造前逐字一致（既有基线全部依赖这一点）。
   */
  const excludedHistoryIds = new Set<string>(
    routeShape === undefined || routeShape.excludePlaceIds === undefined ? [] : routeShape.excludePlaceIds,
  );
  const historyPlaces =
    excludedHistoryIds.size === 0
      ? parsedPlaces
      : parsedPlaces.filter((place) => !excludedHistoryIds.has(place.id));
  if (excludedHistoryIds.size > 0 && historyPlaces.length === 0) {
    return PickResultSchema.parse({ ok: false, reason: EXCLUDE_EXHAUSTED_REASON });
  }
  // M18：画像硬过滤（不传 profile 时 profileAllowsPlace 恒放行 → 与原数组内容一致）。
  const profilePlaces =
    profile === undefined ? historyPlaces : historyPlaces.filter((place) => profileAllowsPlace(place, profile));
  // M20 类目多样性硬过滤（在 800m 同区域去重之前：类目已经用过就整类不参与本轮，
  // 也不参与第 1 站的「最近合规点」扫描——它和营业时间 / 预算一样是硬过滤，不是打分偏好）。
  const categoryPlaces = profilePlaces.filter((place) =>
    !isCategoryExcluded(place, pickMode.usedCategories, pickMode.usedDiningCount),
  );
  // 同区域重复：同类目 + 直线 <800m 的候选只保留打分上界更高的一个。
  const places = dedupeSameAreaCandidates(categoryPlaces, pickMode, profile);
  if (!Number.isInteger(now) || now < 0) {
    throw new Error(`now 必须是 0–1439 的整数分钟，收到：${String(now)}`);
  }
  // 夜间跨午夜是正常业务场景，不是程序错误：now ≥ 1440 不再抛错，直接让调用方「停止加站」。
  if (now >= MINUTES_PER_DAY) {
    return PickResultSchema.parse({ ok: false, reason: LATE_NIGHT_FAILURE_REASON });
  }
  if (typeof budgetLeft !== "number" || !Number.isFinite(budgetLeft)) {
    throw new Error(`budgetLeft 必须是有限数字，收到：${String(budgetLeft)}`);
  }

  const visitedPlaceIdSet = new Set<string>(
    pickMode.visitedPlaceIds === undefined ? [] : pickMode.visitedPlaceIds,
  );
  // M5 收尾修复：今天已被餐厅占用的正餐时段（每个时段最多一家餐厅）。
  const occupiedMealSlotSet = new Set<MealSlot>(
    pickMode.occupiedMealSlots === undefined ? [] : pickMode.occupiedMealSlots,
  );
  const requiredMealSlot = pickMode.requiredMealSlot;
  const fromPoint = { lng: from.lng, lat: from.lat };

  const rejections: Rejections = { hours: 0, radius: 0, budget: 0, visited: 0, noRoute: 0, mealSlot: 0 };
  let cheapestBudgetNeed: number | null = null;
  /** 夜间修复：因为「装上这一站会超过当天上限」被丢弃的候选数（白天恒为 0）。 */
  let lastEndRejections = 0;

  /** 算一个候选：通勤（3.0 定方式）→ 第 1–5 步过滤 → 第 6 步打分。不合格返回 null。 */
  async function evaluate(place: Place): Promise<Candidate | null> {
    // M21 远区预筛：远区候选的交通方式与时长已经在「进候选池前」按该 style 的规则判定过
    // （见 planRounds 的 selectFarZoneCandidates），这里直接复用，不再重复调接口；
    // 没有远区上下文（旧调用方 / 近区候选）时与改造前逐字一致。
    const farZoneCommute = routeShape?.farZoneCommutes?.get(place.id);
    const commute =
      farZoneCommute === undefined
        ? await decideCommute(fromPoint, { lng: place.lng, lat: place.lat }, pickMode, cityCode)
        : farZoneCommute;
    if (commute === null) {
      rejections.noRoute += 1;
      return null;
    }
    const arriveAt = now + commute.durationMin;
    // M18：rich 的非餐厅站停留 90 分钟（餐厅保持类目原值）；不传 profile = STAY_MIN 原值。
    const stayMin = stayMinForPlace(place, profile);

    // 0. 过滤（夜间修复）：装上这一站会超过当天硬性结束上限 → 丢弃，交给下一个候选。
    //    白天离上限很远时走直线估算短路，不新增任何 getRoute 请求，选点结果与改造前一致。
    if (
      limits !== undefined &&
      (await exceedsLastEnd({ lng: place.lng, lat: place.lat }, arriveAt, stayMin, pickMode, cityCode, limits))
    ) {
      lastEndRejections += 1;
      return null;
    }

    // 1. 过滤：营业时间（isOpenAt 同时要求「到达 + 停留时长 ≤ 闭馆时刻」）。
    if (!isOpenAt(place, arriveAt, stayMin)) {
      rejections.hours += 1;
      return null;
    }

    // 2. 过滤：通勤时长超出半径上限（步行30 / 公交45 / 驾车25）。
    //    M18：powerful 的步行半径 override 到 50 分钟（lib/constraints.ts 不改）；
    //    不传 profile = 原来的 withinRadius。
    if (!withinProfileRadius(commute.durationMin, commute.mode, profile)) {
      rejections.radius += 1;
      return null;
    }

    // 3. 过滤：剩余预算不够（餐厅/咖啡 avgCost=null 按 50 元估，不按 0 元放行）。
    if (!canAfford(place, budgetLeft)) {
      rejections.budget += 1;
      const cost = estimateCost(place).cost;
      if (cheapestBudgetNeed === null || cost < cheapestBudgetNeed) cheapestBudgetNeed = cost;
      return null;
    }

    // 4. 过滤：当天已去过。
    if (visitedPlaceIdSet.has(place.id)) {
      rejections.visited += 1;
      return null;
    }

    // 5. 过滤（M5 收尾修复）：餐厅只能占用今天还没被占用的正餐时段。
    //    非正餐时段（停留窗口和两个正餐时段都没交集）直接排除 restaurant，
    //    否则就会出现「10:18 一家餐厅 + 13:14 又一家餐厅」的重复。
    if (place.category === "restaurant") {
      const slot = mealSlotFor(arriveAt, stayMin);
      if (slot === null || occupiedMealSlotSet.has(slot.slot)) {
        rejections.mealSlot += 1;
        return null;
      }
      // 用餐修复轮：这一轮必须把指定的正餐时段安排掉，别的时段不算。
      if (requiredMealSlot !== undefined && slot.slot !== requiredMealSlot) {
        rejections.mealSlot += 1;
        return null;
      }
    }

    // 6. 打分。
    const cost = estimateCost(place);
    return {
      place,
      commute,
      arriveAt,
      stayMin,
      costEstimate: cost.cost,
      costBasis: cost.basis,
      // 任务2：乘上路线方位单调性系数（恒 ≤1，只降不升；上界未乘，所以剪枝仍安全）。
      // 「再来一条」：再乘一个由 (seed, placeId) 决定的伪随机系数（同样恒 ≤1，剪枝仍安全）；
      // seed 不传时 routeJitter 恒为 1，行为与改造前逐字一致。
      // M18：再乘画像优先系数（正常数，同时乘在 scoreUpperBound 上，剪枝仍安全）；
      // 不传 profile 时系数恒 1，乘 1 不改变浮点结果 → 无画像路径逐字一致。
      // M20：外卖 / 自提这类名称再乘一个恒 ≤1 的软降权系数（只压分，不排除；上界未乘，剪枝仍安全）。
      score:
        scoreCandidate(place, commute, categoryNormFor(place.category, pickMode.preferredCategories), profile) *
        profileScoreMultiplier(place, profile) *
        routeShapeMultiplier(routeShape, place) *
        routeJitter(routeShape?.seed, place.id) *
        namePriorityMultiplier(place) *
        restaurantPrefixMultiplier(place, pickMode.usedRestaurantPrefixes),
    };
  }

  /**
   * 每个候选的真实评估结果（含 null）按 id 缓存。
   * 第 1 站会按距离顺序扫描候选，扫过的点如果又落回下面的打分逻辑，不重复算路线。
   */
  const evaluatedCache = new Map<string, Candidate | null>();
  async function evaluateCached(place: Place): Promise<Candidate | null> {
    if (evaluatedCache.has(place.id)) {
      const cached = evaluatedCache.get(place.id);
      return cached === undefined ? null : cached;
    }
    const candidate = await evaluate(place);
    evaluatedCache.set(place.id, candidate);
    return candidate;
  }

  // 排序：打分上界高的先算（更可能是赢家），同分时直线估算近的先算（估算不消耗配额）。
  const ordered = places.slice().sort((a, b) => {
    const upperDiff = scoreUpperBound(b, pickMode, profile) - scoreUpperBound(a, pickMode, profile);
    if (upperDiff !== 0) return upperDiff;
    const estDiff = estimateWalkMinutes(fromPoint, a) - estimateWalkMinutes(fromPoint, b);
    return estDiff !== 0 ? estDiff : a.id.localeCompare(b.id);
  });

  let best: Candidate | null = null;

  // 第 1 站规则（只在调用方传 routeShape.firstStop=true 时生效）：
  //   候选按「到 origin 的直线距离」升序，取第一个通过全部过滤且合规
  //   （importance ≥2 或 rating ≥3.5）的点。
  // 注意「合规」不等于「可排」：营业时间 / 半径 / 预算 / 已去过 / 用餐时段这 5 步过滤照常先过，
  // 所以真正选中的是「最近的、能排进去的合规点」；不合格的候选直接跳过看下一个。
  // 扫描用**去重前**的候选池 parsedPlaces：上面的 dedupeSameAreaCandidates 是「同类目 800m 内
  // 先留打分上界高的一个，少算几条路线」的性能优化，它的取舍依据是分数不是距离；
  // 第 1 站的规则恰恰是「按距离取最近」，所以不能被它把更近的合规点换掉。
  // 所有合规候选都过不了过滤（或压根没有合规候选）→ 退回下面的原打分逻辑，
  // 保证新规则只可能改变「选谁」，不可能把原本能排的行程变成排不出来。
  if (routeShape?.firstStop === true) {
    const originPoint = routeShape.origin;
    // M18：扫描已经过画像硬过滤的候选（不传 profile 时 profilePlaces 与 parsedPlaces 内容一致）。
    // M20：同时扫描已经过类目多样性硬过滤的候选（不传 usedCategories / usedDiningCount 时与 profilePlaces 一致）。
    const byDistance = categoryPlaces.slice().sort((a, b) => {
      const distanceDiff = haversineMeters(originPoint, a) - haversineMeters(originPoint, b);
      return distanceDiff !== 0 ? distanceDiff : a.id.localeCompare(b.id);
    });
    /**
     * 收集第 1 站随机窗口：按距离升序，取前 FIRST_STOP_RANDOM_WINDOW 个
     * 「合规 + 通过全部硬过滤（evaluateCached 里的营业时间 / 半径 / 预算 / 用餐 / 类目多样性等）」的候选。
     * 不合格 / 不可排的候选直接跳过，不会进入窗口。
     *
     * 「再来一条」的 excludePlaceIds 已经在本函数开头把历史站点整体剔掉了（影响所有站，
     * 不只是第 1 站），所以这里看到的候选全部都是可以选的，不需要再区分 fresh / 兜底重复。
     */
    const collectFirstStopWindow = async (places: Place[]): Promise<Candidate[]> => {
      const window: Candidate[] = [];
      for (const place of places) {
        if (window.length >= FIRST_STOP_RANDOM_WINDOW) break;
        if (!isFirstStopQualified(place)) continue;
        const candidate = await evaluateCached(place);
        if (candidate === null) continue;
        window.push(candidate);
      }
      return window;
    };

    if (routeShape.seed !== undefined) {
      // 「再来一条」：第 1 站也吃 seed——最近 5 个合规候选里按 1/(1+名次) 加权随机。
      // 1、0.5、0.33… 最近的那个仍最可能，但不是必然；同一 seed 可复现。
      let window: Candidate[] = [];
      // 带 scene 画像时仍优先「场景匹配」的近处候选（与无 seed 的既有规则一致），一个都没有再看全量。
      if (profile !== undefined && profile.scene !== "any") {
        window = await collectFirstStopWindow(
          byDistance.filter((place) => scenePriorityHit(place, profile)),
        );
      }
      if (window.length === 0) window = await collectFirstStopWindow(byDistance);
      if (window.length > 0) {
        best = window[weightedFirstStopIndex(routeShape.seed, window.length)];
      }
    } else {
      // 无 seed：原逻辑逐字不变（最近合规点）；excludePlaceIds 已在开头过滤，这里不再有排除点。
      if (profile !== undefined && profile.scene !== "any") {
        for (const place of byDistance) {
          if (!scenePriorityHit(place, profile)) continue;
          if (!isFirstStopQualified(place)) continue;
          const candidate = await evaluateCached(place);
          if (candidate !== null) {
            best = candidate;
            break;
          }
        }
      }
      if (best === null) {
        for (const place of byDistance) {
          if (!isFirstStopQualified(place)) continue;
          const candidate = await evaluateCached(place);
          if (candidate !== null) {
            best = candidate;
            break;
          }
        }
      }
    }
  }

  if (best === null) {
    if (ordered.length > 0) {
      // 第一枪：最可能胜出的候选单独先算，尽早拿到「真实最高分」这个剪枝门槛。
      const firstCandidate = await evaluateCached(ordered[0]);
      if (firstCandidate !== null) best = firstCandidate;
    }

    // 剩下的按上界从高到低分批算；上界都打不过当前最佳的，接口都不调。
    for (let index = 1; index < ordered.length; index += ROUTE_CONCURRENCY) {
      const batch = ordered
        .slice(index, index + ROUTE_CONCURRENCY)
        .filter((place) => best === null || scoreUpperBound(place, pickMode, profile) >= best.score);
      if (batch.length === 0) break;
      const evaluated = await Promise.all(batch.map((place) => evaluateCached(place)));
      for (const item of evaluated) {
        if (item === null) continue;
        if (best === null || compareCandidates(item, best) < 0) best = item;
      }
    }
  }

  if (best === null) {
    // 夜间修复：确实有候选因为「会排到 23:30 之后」被丢弃 → 用日常人话作原因；
    // 白天不会有这种拒绝，失败原因与改造前逐字一致。
    if (lastEndRejections > 0) {
      return PickResultSchema.parse({ ok: false, reason: LATE_NIGHT_FAILURE_REASON });
    }
    return PickResultSchema.parse({
      ok: false,
      reason: buildFailureReason(rejections, cheapestBudgetNeed, budgetLeft, places.length),
    });
  }

  // 6. 取 top1，算出 arriveAt / stayMin / costEstimate，生成 reason。
  const stop: Stop = StopSchema.parse({
    placeId: best.place.id,
    arriveAt: best.arriveAt,
    leaveAt: best.arriveAt + best.stayMin,
    stayMin: best.stayMin,
    reason: buildReason(best.place, best.commute, best.costBasis, best.costEstimate),
    costEstimate: best.costEstimate,
  });
  const segment: Segment = segmentOf(from.id, best.place.id, best.commute);

  // 契约校验：返回值必须过 zod；成功时 **不带** reason 字段。
  return PickResultSchema.parse({ ok: true, stop, segment });
}
/* ------------------------------------------------------------------ *
 * M4：把 pickNext 串成多站（任务1 起 3–6 站，实际站数由可用时长算出的 targetStops 决定）
 *
 * 主函数 buildItinerary：
 *   1. 每轮先用**直线距离估算**预筛，只把估算最近的 6 个候选交给 pickNext
 *      （M4.5 3.1：原先是直线最近的 8 个；估算纯本地计算，不消耗配额）；
 *   2. 最多 MAX_STOPS=6 站（实际站数由可用时长算出的 targetStops 决定）；排不满不算失败，如实返回已排好的部分（3.2）；
 *   3. 每轮结束断言「上一站.leaveAt + 本段.durationMin === 本站.arriveAt」，不通过抛错（3.3）；
 *   4. 最后断言 totalCost = 各站之和且 ≤ budget、totalMin = endAt - startAt = 各段之和（3.4）。
 *
 * 用餐硬约束（M4 §4 组 2 要求「时间窗覆盖午餐 + 预算 0 → 必须 ok:false，reason 说餐饮预算不足」，
 * 否则 0 元免费场馆能排出 3 站，这个用例永远不可能失败；规则采用 M9 3.1 的口径）：
 *   - 行程 [startAt, endAt] 与 11:30–13:30 或 17:30–19:30 有交集 → 必须有一站 category === 'restaurant'；
 *   - 排不出来时返回 {ok:false}，预算卡住时 reason 写成「餐饮预算不足：…」，不返回违反约束的行程。
 *
 * M4.5 3.3：用餐需求**提前到选站时**（见 autoMealWindow）——判断这一轮必须选餐厅时直接把候选池
 * 过滤成餐厅，不再「先排满 3 站、发现缺餐厅、整盘重排一次」；原来的重排逻辑只作为极端情况的兜底保留。
 *
 * M5 收尾修复（餐厅去重）：餐厅只能占用今天还没被占用的正餐时段，非正餐时段直接排除；
 * 覆盖正餐时段却排不进餐厅时，兜底重排 -> 再不行就把行程收在该正餐时段之前，仍不行才返回 ok:false。
 * ------------------------------------------------------------------ */

/**
 * 任务1（站数动态化 3–6）：MAX_STOPS 只作**硬上限**，实际站数由 targetStopsForBudget 按可用时长算。
 * 日落锚点场景仍用 MAX_ANCHOR_STOPS=4（锚点逻辑本轮不动）。
 */
const MAX_STOPS = 6;

/** 任务1 站数估算口径：平均每站停留 60 分钟、每站之间（含最后返程）平均 12 分钟。 */
const AVG_STAY_MIN = 60;
const AVG_COMMUTE_MIN = 12;

/**
 * 任务5（深夜回归修复）：停留下限按「可用时长」动态取值——
 * 可用时长 ≥90 分钟用正常下限 45（MIN_STAY_MIN）；<90 分钟放宽到 30，
 * 让「22:30 只剩 48 分钟可用」这类短窗口仍能排下 1 站，同时 23:00（available=18）仍给深夜人话。
 */
const SHORT_WINDOW_MIN_STAY_MIN = 30;

function minStayForBudget(budgetMin: number): number {
  return budgetMin >= 90 ? MIN_STAY_MIN : SHORT_WINDOW_MIN_STAY_MIN;
}

/**
 * 任务1：可用时长（= 留给站点的时间预算，不含返程）→ 可排站数（clamp 1..MAX_STOPS）。
 *
 * 可用时长由 buildItinerary 按「想走多久」口径换算好，当作 constraints.maxTotalMin 传下来：
 *   自动 = min(maxTotalMin, lastEndMinute - startAt) - 返程估算
 *   指定 = min(durationMin, lastEndMinute - startAt) - 返程估算
 *   一整天 = lastEndMinute - startAt - 返程估算
 * 所以这里只按 budgetMin 折算，不重新读城市阈值。
 */
function targetStopsForBudget(budgetMin: number): number {
  const raw = Math.floor(budgetMin / (AVG_STAY_MIN + AVG_COMMUTE_MIN));
  return Math.min(MAX_STOPS, Math.max(1, raw));
}

/**
 * M4.5 3.1：每轮只把**估算**最近的 6 个候选交给 pickNext（纯本地计算）。
 * 原先是 8 个；估算预筛 + pickNext 内部的上界剪枝会把真正调接口的数量压到 6 个以下。
 */
const PREFILTER_LIMIT = 6;

/** 一轮里最多换几个候选去试「排得进总时长」——只影响同轮候选顺序，不放宽任何上限。 */
const MAX_FIT_ATTEMPTS_PER_ROUND = 3;

/**
 * M4.5 3.1 的预筛（原 M4 3.2.5）：按**估算步行分钟**升序取前 limit 个。
 * 估算 = 直线米数 × 1.3 / 75，纯本地计算，不调接口、不消耗配额。
 * 已去过的点先剔掉再排序（否则白占名额，还会让后面几轮无点可选）。
 * 这一步不发任何请求；export 出来是给自检脚本复算「45 → 6」用的。
 */
export function selectNearby(
  pool: Place[],
  from: { lng: number; lat: number },
  excludeIds: ReadonlySet<string>,
  limit: number = PREFILTER_LIMIT,
): Place[] {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`预筛数量必须是 >= 1 的整数，收到：${String(limit)}`);
  }
  return pool
    .filter((place) => !excludeIds.has(place.id))
    .slice()
    .sort((a, b) => {
      const estDiff = estimateWalkMinutes(from, a) - estimateWalkMinutes(from, b);
      return estDiff !== 0 ? estDiff : a.id.localeCompare(b.id);
    })
    .slice(0, limit);
}

/**
 * M18：带 scene 画像的预筛（契约 §3：scene 加权是「非过滤，在预筛前生效」）。
 *
 * 预筛仍然只取最近的 `limit` 个候选、绝不删候选，但把 scene 加权落在**预筛组成**上：
 * 1. 先给「scene 优先目标」的候选留名额（按估算步行分钟升序，最近的先占）：
 *    scenery 留 SCENE_PREFILTER_RESERVED=3 个（park / 风光类）；
 *    culture 留 CULTURE_PREFILTER_RESERVED=5 个（**用户验收 6 的严格名单**：书店/博物馆/美术馆/
 *    市场/老街——杭州这类目标稀疏且不少场馆下午就关门，多留名额才挑得到「还开着 + 到得了」的）；
 * 2. 剩余名额用原来的「离当前点最近」补齐（不与已入选重复）。
 * 这样场景目标点再远只要排进最近的几个目标候选就能被 pickNext 评估到；不匹配的点排序口径不变。
 * 之后 pickNext 的硬过滤 / 距离单调 / 用餐 / 预算 / 打分全部照旧。
 *
 * 无 profile 或 scene=any → 直接走原来的 selectNearby，行为与改造前逐字一致。
 */
function selectNearbyForScene(
  pool: Place[],
  from: { lng: number; lat: number },
  excludeIds: ReadonlySet<string>,
  limit: number,
  profile?: ProfileTuning,
): Place[] {
  if (profile === undefined || profile.scene === "any") {
    return selectNearby(pool, from, excludeIds, limit);
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`预筛数量必须是 >= 1 的整数，收到：${String(limit)}`);
  }
  const byWalkMinutes = pool
    .filter((place) => !excludeIds.has(place.id))
    .slice()
    .sort((a, b) => {
      const diff = estimateWalkMinutes(from, a) - estimateWalkMinutes(from, b);
      return diff !== 0 ? diff : a.id.localeCompare(b.id);
    });
  const picked: Place[] = [];
  const seen = new Set<string>();
  const reservedLimit = profile.scene === "culture" ? CULTURE_PREFILTER_RESERVED : SCENE_PREFILTER_RESERVED;
  const reserved = Math.min(reservedLimit, limit);
  for (const place of byWalkMinutes) {
    if (picked.length >= reserved) break;
    if (!scenePriorityHit(place, profile)) continue;
    picked.push(place);
    seen.add(place.id);
  }
  for (const place of byWalkMinutes) {
    if (picked.length >= limit) break;
    if (seen.has(place.id)) continue;
    picked.push(place);
    seen.add(place.id);
  }
  return picked;
}

/* ------------------------------------------------------------------ *
 * M21：两段式预筛（近区 0–5km 取最近 6 + 远区取 style 合格的前 N 个）
 *
 * 任务2 的根因：每轮预筛只把「直线最近的 6 个」交给 pickNext，离起点 5km 外的好地方
 * （北京 5–12km 有 14 个 POI）永远进不了候选池，所以不是「没考虑地铁」，是「远的点压根没进来」。
 *
 * 规则（有 profile 才启用；没有 profile 时整条远区逻辑不存在，行为与改造前逐字一致）：
 *   rich（花钱买时间）    远区 5–12km：importance≥3 或 rating≥4.3；最多 3 个；交通只允许 drive；
 *                          单程 >15 分钟 → 该候选排除；默认预算抬到 400。
 *   powerful（花时间省钱）远区 5–15km：importance≥2；最多 4 个；交通 bus（含地铁）优先，
 *                          bike 次之，单程 ≤30 分钟；drive 仅当「公交 >40 分钟且打车 <15 分钟」。
 * 远区候选**必须**先经真实路线判定为「该 style 允许的交通方式」才进候选池
 *（不要放进池子再在打分后过滤——那会白算一堆路线，也会让打分口径不一致）。
 * 远区点的通勤结果随候选池一起交给 pickNext（RouteShape.farZoneCommutes），不重复调接口。
 * ------------------------------------------------------------------ */

/** 近区半径（米）：有 profile 时「附近走走」的范围。 */
const NEAR_ZONE_RADIUS_M = 5000;
/** rich 远区：5–12km、最多 3 个、单程 ≤15 分钟。 */
const RICH_FAR_ZONE_MAX_DISTANCE_M = 12000;
const RICH_FAR_ZONE_LIMIT = 3;
const RICH_FAR_ZONE_MAX_ONE_WAY_MIN = 15;
const RICH_FAR_ZONE_MIN_IMPORTANCE = 3;
const RICH_FAR_ZONE_MIN_RATING = 4.3;
/** powerful 远区：5–15km、最多 4 个、单程 ≤30 分钟。 */
const POWERFUL_FAR_ZONE_MAX_DISTANCE_M = 15000;
const POWERFUL_FAR_ZONE_LIMIT = 4;
/**
 * powerful 远区：单程上限按「30 分钟 + 允许为省钱多花 10–15 分钟」落地。
 * 取 45 这个上限端：任务书的「多花 10–15 分钟」意味着 powerful 可以接受到 40–45 分钟的公交/骑行；
 * 而「公交方案 >40 分钟」这个条件只用于判断**要不要改打车**（打车 <15 才换，见下），不是禁止坐公交。
 */
const POWERFUL_FAR_ZONE_MAX_ONE_WAY_MIN = 45;
const POWERFUL_FAR_ZONE_MIN_IMPORTANCE = 2;
/** powerful：公交 >40 分钟且打车 <15 分钟时才允许打车（远区里唯一的打车入口）。 */
const POWERFUL_FAR_ZONE_DRIVE_BUS_FLOOR_MIN = 40;
const POWERFUL_FAR_ZONE_DRIVE_MAX_MIN = 15;
/**
 * 远区扫描上限（按「离起点由近到远」扫）：最多检查 limit × 2 个合格候选就停。
 * 只是性能上限（远区交通判定是真实接口调用），不影响任何硬约束：
 * 任务书要求的「前 N 个」远区候选本来就该在离起点最近的一批里。
 */
const FAR_ZONE_SCAN_FACTOR = 2;

/** 有 profile 时 rich 的默认预算下限（任务书：defaultBudget 200 → 400，打车花钱）。 */
const RICH_DEFAULT_BUDGET = 400;

function farZoneMaxDistanceM(style: TravelStyle): number {
  return style === "rich" ? RICH_FAR_ZONE_MAX_DISTANCE_M : POWERFUL_FAR_ZONE_MAX_DISTANCE_M;
}

function farZoneLimit(style: TravelStyle): number {
  return style === "rich" ? RICH_FAR_ZONE_LIMIT : POWERFUL_FAR_ZONE_LIMIT;
}

/** 远区候选的「值不值得跑这么远」门槛（只看数据字段）。 */
function farZoneEligible(place: Place, style: TravelStyle): boolean {
  if (style === "rich") {
    const importanceOk = place.importance !== undefined && place.importance >= RICH_FAR_ZONE_MIN_IMPORTANCE;
    const ratingOk = place.rating !== null && place.rating >= RICH_FAR_ZONE_MIN_RATING;
    return importanceOk || ratingOk;
  }
  return place.importance !== undefined && place.importance >= POWERFUL_FAR_ZONE_MIN_IMPORTANCE;
}

/**
 * 远区候选的交通判定（**只给远区候选用**；近区仍走原 decideCommute，powerful 近区仍然不坐公交）。
 * 返回 null = 这个点不符合该 style 的远区交通规则，不放进候选池。
 * rich：只允许 drive，且单程 ≤15 分钟（即使地铁更快也不坐：等车 / 换乘 / 接驳都算体验损失）。
 * powerful：bus（含地铁）优先、bike 次之，单程 ≤30 分钟；drive 只在公交 >40 且打车 <15 时兜底。
 */
async function resolveFarZoneCommute(
  from: { lng: number; lat: number },
  to: { lng: number; lat: number },
  style: TravelStyle,
  mode: PickMode,
  cityCode: string | undefined,
): Promise<Commute | null> {
  if (style === "rich") {
    const drive = await getRouteWithRetry(from, to, "drive", cityCode);
    if (drive === null || drive.durationMin > RICH_FAR_ZONE_MAX_ONE_WAY_MIN) return null;
    return commuteOf("drive", drive);
  }
  const bus = await getRouteWithRetry(from, to, "bus", cityCode);
  if (bus !== null && bus.durationMin <= POWERFUL_FAR_ZONE_MAX_ONE_WAY_MIN) return commuteOf("bus", bus);
  if (canRideBike(mode)) {
    const bike = await getRouteWithRetry(from, to, "bike", cityCode);
    if (bike !== null && bike.durationMin <= POWERFUL_FAR_ZONE_MAX_ONE_WAY_MIN) return commuteOf("bike", bike);
  }
  const busDurationMin = bus === null ? Number.POSITIVE_INFINITY : bus.durationMin;
  if (bus !== null && busDurationMin > POWERFUL_FAR_ZONE_DRIVE_BUS_FLOOR_MIN) {
    const drive = await getRouteWithRetry(from, to, "drive", cityCode);
    if (drive !== null && drive.durationMin < POWERFUL_FAR_ZONE_DRIVE_MAX_MIN) return commuteOf("drive", drive);
  }
  return null;
}

type FarZonePrefilter = {
  places: Place[];
  commutes: Map<string, Commute>;
};

/** 无远区上下文时的空通勤表（同一份只读常量，避免每轮新建对象）。 */
const EMPTY_FAR_COMMUTES: ReadonlyMap<string, Commute> = new Map<string, Commute>();

/**
 * 远区预筛：从当前候选池（已经过画像硬过滤 / 800m 去重 / 距离递增过滤）里挑出远区候选。
 * - 只看「离起点 5–12|15km」的点；
 * - 先按到起点直线距离由近到远排序，再逐个做真实路线判定（该 style 允许的交通方式 + 单程上限）；
 *   判定通过的才进候选池，最多 limit 个；
 * - 已去过 / 当前站 / 类目多样性已用类目 的点不浪费路线请求。
 * 不传 profile = 没有远区（返回空，行为与改造前逐字一致）。
 */
async function selectFarZoneCandidates(
  pool: Place[],
  from: { lng: number; lat: number },
  originPoint: { lng: number; lat: number },
  excluded: ReadonlySet<string>,
  profile: ProfileTuning | undefined,
  mode: PickMode,
  cityCode: string | undefined,
): Promise<FarZonePrefilter> {
  const empty: FarZonePrefilter = { places: [], commutes: new Map<string, Commute>() };
  if (profile === undefined) return empty;
  const maxDistanceM = farZoneMaxDistanceM(profile.style);
  const limit = farZoneLimit(profile.style);
  const usedCategories = mode.usedCategories;
  const usedDiningCount = mode.usedDiningCount;
  const candidates = pool
    .filter((place) => {
      if (excluded.has(place.id)) return false;
      if (!farZoneEligible(place, profile.style)) return false;
      if (isCategoryExcluded(place, usedCategories, usedDiningCount)) return false;
      const distanceM = haversineMeters(originPoint, place);
      return distanceM >= NEAR_ZONE_RADIUS_M && distanceM <= maxDistanceM;
    })
    .sort((a, b) => {
      const diff = haversineMeters(originPoint, a) - haversineMeters(originPoint, b);
      return diff !== 0 ? diff : a.id.localeCompare(b.id);
    });
  const picked: Place[] = [];
  const commutes = new Map<string, Commute>();
  const scanLimit = Math.min(candidates.length, limit * FAR_ZONE_SCAN_FACTOR);
  for (let index = 0; index < scanLimit && picked.length < limit; index += 1) {
    const place = candidates[index];
    const commute = await resolveFarZoneCommute(
      from,
      { lng: place.lng, lat: place.lat },
      profile.style,
      mode,
      cityCode,
    );
    if (commute === null) continue;
    picked.push(place);
    commutes.set(place.id, commute);
  }
  return { places: picked, commutes };
}

/**
 * 返程通勤：与站间段同一套规则，唯一例外是 powerful 的「远区 bus 优先」——
 * 末站离终点 >5km 时按远区规则找 bus / bike（否则会算成 80 分钟步行，让 homeBy 重排把整站裁掉）。
 * rich / 无 profile 仍走 decideCommute，行为与改造前逐字一致。
 */
async function decideReturnCommute(
  lastPlace: Place,
  destinationPoint: { lng: number; lat: number },
  mode: PickMode,
  profile: ProfileTuning | undefined,
  cityCode: string | undefined,
): Promise<Commute | null> {
  const from = { lng: lastPlace.lng, lat: lastPlace.lat };
  if (profile !== undefined && profile.style === "powerful") {
    const straightDistanceM = haversineMeters(from, destinationPoint);
    if (straightDistanceM > NEAR_ZONE_RADIUS_M) {
      const farCommute = await resolveFarZoneCommute(from, destinationPoint, profile.style, mode, cityCode);
      if (farCommute !== null) return farCommute;
    }
  }
  return decideCommute(from, destinationPoint, mode, cityCode);
}

/** M4 3.1 的 constraints：budget / maxTotalMin（默认 300）/ mode / pool。M9 追加 people（默认 1）。 */
export const ItineraryConstraintsSchema = z
  .object({
    budget: z.number().min(0),
    maxTotalMin: z.number().int().min(1).default(300),
    mode: PickModeSchema.default({}),
    pool: z.array(PlaceSchema).min(1),
    /** M9 3.4：点菜建议按人数给。V1 首屏没有人数选择器，默认 1 人（上限 10 纯粹防呆）。 */
    people: z.number().int().min(1).max(10).default(1),
    /**
     * 城市数据模块化（新增可选字段）：当地日落时刻（当日分钟数，默认 1062 = 17:42）。
     * 只用于日落锚点后处理（锚定到达目标 = 日落前 10 分钟）；不传时与改动前逐字一致。
     */
    sunsetMinute: z.number().int().min(0).max(1439).optional(),
    /**
     * 城市数据模块化（新增可选字段）：高德城市码（公交算路参数 city / cityd）。
     * 由 /api/plan 从 data/cities/<city>.json 的 cityCode 传入；不传时公交一律算不出来（降级）。
     */
    cityCode: z.string().regex(/^\d{4,6}$/, "cityCode 必须是 4–6 位数字（高德城市码）").optional(),
    /**
     * 本轮新增可选字段：返程终点（不是 POI、不进候选池）。
     * 不传 = 回到起点（origin）；传了 = 用户自定义终点（id 固定 "destination"）。
     * 只影响返程段的终点 / 返程时长与 Itinerary 的末端快照，不参与任何选点。
     */
    destination: PlaceSchema.optional(),
    /**
     * 本轮新增可选字段：几点到家（当日分钟数，1080 = 18:00）。不传 = 不限制（向后兼容）。
     * 传了就按「homeBy − 现在 − 返程耗时」倒排时长，排不满如实返回少几站。
     */
    homeBy: z.number().int().min(0).max(1439).optional(),
    /**
     * 当天硬性结束上限（当日分钟数，默认 1410 = 23:30）：候选「到达 + 停留 + 返程」超过它
     * 就不加站；所有候选都不行就停止加站（晚间返回人话原因，不再抛「now 越界」）。
     * 由 /api/plan 从城市配置 thresholds.lastEndMinute 传入。
     */
    lastEndMinute: z.number().int().min(0).max(1439).default(DEFAULT_LAST_END_MINUTE),
    /**
     * 任务1 新增可选字段：想走多久（分钟，1–720）。指定时长「直接当 maxTotalMin 用」：
     * 可用时长 = min(durationMin, lastEndMinute - startAt) - 返程估算；与 wholeDay 互斥（调用方保证）。
     */
    durationMin: z.number().int().min(1).max(720).optional(),
    /**
     * 任务1 新增可选字段：一整天——不套 maxTotalMin 上限，一直排到 lastEndMinute；
     * 可用时长 = lastEndMinute - startAt - 返程估算。与 durationMin 互斥（调用方保证）。
     */
    wholeDay: z.boolean().optional(),
    /**
     * 任务5 内部字段：本次排程的停留下限（分钟）。buildItinerary 每次 attempt 按可用时长重算
     * （≥90→45、<90→30）后写进来，planRounds 用它做夜间守卫 / 循环保护 / 短窗口停留压缩。
     */
    minStayMin: z.number().int().min(1).max(120).optional(),
    /**
     * 随机种子（M16 新增可选字段）：「再来一条」用。
     * 给了它 → 同一组输入得到一条不同但同样合规的路线（同一个 seed 结果可复现）；
     * 本轮起 seed 也影响第 1 站（最近 5 个合规候选加权随机）；不传 → 完全确定性，既有行为逐字不变。
     */
    seed: z.number().int().min(0).max(2_147_483_647).optional(),
    /**
     * 「再来一条」可选（本轮扩展）：本会话已经出现过的 stops placeId 列表。
     * **影响所有站的候选过滤**（第 1 站 / 后续站 / 补站轮 / 用餐轮 / 日落锚点路径），只缩小候选池；
     * 排除后候选池为空会返回 EXCLUDE_EXHAUSTED_REASON。不传 / 空数组 = 不排除（行为与改造前逐字一致）。
     * 上限 24（页面按「最近 24 个」发送，约 6 轮 × 4 站）。
     */
    excludePlaceIds: z.array(z.string().min(1)).max(24).optional(),
  })
  .strict();

/** buildItinerary 的入参（除 pool 外都可省略默认值；pool 必传）。 */
export type ItineraryConstraints = {
  budget: number;
  pool: Place[];
  maxTotalMin?: number;
  mode?: PickMode;
  people?: number;
  /** 当地日落时刻（当日分钟数）；省略 = 默认 1062（17:42）。 */
  sunsetMinute?: number;
  /** 高德城市码（公交算路用）；省略 = 公交算不出来，只能步行 / 骑行 / 打车。 */
  cityCode?: string;
  /** 返程终点（不是 POI，不进候选池）；省略 = 回到起点。 */
  destination?: Place;
  /** 几点到家（当日分钟数）；省略 = 不限制时长（与改造前行为一致）。 */
  homeBy?: number;
  /** 当天硬性结束上限（当日分钟数）；省略 = 默认 1410（23:30）。 */
  lastEndMinute?: number;
  /** 任务1：想走多久（分钟，1–720）；省略 = 自动。与 wholeDay 互斥（buildItinerary 会抛错）。 */
  durationMin?: number;
  /** 任务1：一整天（不套 maxTotalMin 上限）；省略 = 自动。与 durationMin 互斥（buildItinerary 会抛错）。 */
  wholeDay?: boolean;
  /** 任务5 内部字段：停留下限（分钟）。buildItinerary 每次 attempt 按可用时长重算后传入；省略 = 旧口径 45。 */
  minStayMin?: number;
  /** 「再来一条」的随机种子；省略 = 完全确定性（既有行为逐字不变）。 */
  seed?: number;
  /**
   * 「再来一条」可选：本会话已经出现过的 placeId 列表（上限 24）。
   * **影响所有站的候选过滤**，只缩小候选池；排除后候选池为空返回 EXCLUDE_EXHAUSTED_REASON。
   * 省略 = 不排除（既有行为逐字不变）。
   */
  excludePlaceIds?: string[];
};

type ParsedConstraints = z.infer<typeof ItineraryConstraintsSchema>;

/** M4 返回值契约：成功是完整 Itinerary，失败只有 { ok:false, reason }。 */
export const BuildItineraryResultSchema = z.union([
  ItinerarySchema,
  z.object({ ok: z.literal(false), reason: z.string().min(1) }),
]);

type ItineraryFailure = { ok: false; reason: string };

type RoundsPlan = {
  stops: Stop[];
  segments: Segment[];
  endAt: number;
  /** 某一轮 pickNext 失败的原因；null 表示 3 轮都排上了（或到了时间上限） */
  stopReason: string | null;
  /**
   * 强制餐厅那一轮失败时的原因、当时剩余预算与对应的正餐时段
   * （用于拼「餐饮预算不足：午餐时段需要安排餐厅，最便宜的 30 元超过预算 0 元」）。
   */
  mealFailure: { reason: string; budgetLeft: number; windows: MealWindow[] } | null;
};

type PlanRoundsOptions = {
  origin: Place;
  startAt: number;
  constraints: ParsedConstraints;
  visitedPlaceIds: string[];
  /**
   * null = 正常排；否则这一轮只从餐厅里选，且必须落在指定的正餐时段
   * （用餐硬约束的兜底修复用；M4.5 之后只作兜底）。
   */
  forcedMeal: { round: number; slot: MealSlot } | null;
  /**
   * true = M4.5 3.3 的「把用餐需求提前到选站时」：
   * 轮到该吃正餐时直接把这一轮候选池过滤成餐厅，不再整盘重排。
   * 修复重排那一遍传 false，避免和兜底逻辑互相打架。
   */
  mealAuto: boolean;
  /**
   * M18（可选）：出行画像调参表。影响站数上限（rich 3）、候选硬过滤（餐厅人均 / 评分底线）、
   * 停留时长（rich 非餐厅 90）与打分加权；不传 = 与改造前逐字一致。
   */
  profile?: ProfileTuning;
};

function failure(reason: string): ItineraryFailure {
  return BuildItineraryResultSchema.parse({ ok: false, reason }) as ItineraryFailure;
}

/** [startAt, endAt] 与哪些正餐时段有交集（空数组 = 不要求餐厅）。 */
function coveredMealWindows(startAt: number, endAt: number): MealWindow[] {
  return MEAL_WINDOWS.filter((window) => startAt < window.end && endAt > window.start);
}

function hasRestaurant(stops: Stop[], placeById: Map<string, Place>): boolean {
  return stops.some((stop) => placeById.get(stop.placeId)?.category === "restaurant");
}

/**
 * M21（任务2 用餐安全阀）：列出「行程覆盖了、但没有任何餐厅站落在里面」的正餐时段。
 *
 * 用餐硬约束的完整口径是「被覆盖的每个正餐时段都必须有餐厅」（跨两餐 = 两家）。
 * 远区站（5–15km）之后的下一站受「距离递增」约束，而北京 5km 外没有餐厅——
 * 所以远区站一旦把某个还没安排餐厅的正餐时段包住，后面就再也补不出餐厅。
 * 本函数用于 profile 路径的兜底拦截；无 profile 路径不调用（保持改造前行为逐字一致）。
 */
function uncoveredMealWindows(
  stops: Stop[],
  startAt: number,
  endAt: number,
  placeById: Map<string, Place>,
): MealWindow[] {
  return MEAL_WINDOWS.filter((window) => {
    if (!(startAt < window.end && endAt > window.start)) return false;
    return !stops.some((stop) => {
      const place = placeById.get(stop.placeId);
      return (
        place !== undefined &&
        place.category === "restaurant" &&
        stop.arriveAt < window.end &&
        stop.arriveAt + stop.stayMin > window.start
      );
    });
  });
}

/**
 * M5 收尾修复的回归断言：全天最多 2 家餐厅，且必须分别占用午餐 / 晚餐时段。
 *
 * 违反说明选站逻辑有 bug，直接抛错，不静默放过——之前「10:18 一家 + 13:14 一家」
 * 就是没有这条检查才漏到界面上的。
 */
function assertRestaurantSlots(stops: Stop[], placeById: Map<string, Place>): void {
  const usedSlots: MealSlot[] = [];
  for (const stop of stops) {
    const place = placeById.get(stop.placeId);
    if (place === undefined) {
      throw new Error(`行程里出现候选池外的 placeId=${stop.placeId}`);
    }
    if (place.category !== "restaurant") continue;
    const window = mealSlotFor(stop.arriveAt, stop.stayMin);
    if (window === null) {
      throw new Error(
        `餐厅站「${place.name}」${formatClockText(stop.arriveAt)}–${formatClockText(stop.leaveAt)} 不在正餐时段内`,
      );
    }
    if (usedSlots.indexOf(window.slot) !== -1) {
      throw new Error(`一天出现两家占用同一正餐时段（${window.label}）的餐厅：${place.name}`);
    }
    usedSlots.push(window.slot);
  }
  if (usedSlots.length > 2) {
    throw new Error(`全天最多 2 家餐厅，实际排了 ${usedSlots.length} 家`);
  }
}

/**
 * 修复时的餐厅站优先放在「原行程里正好压着用餐时段的站」，其次压在用时段之后的站，最后按 0/1/2 兜底。
 * 同时带上要安排的正餐时段（slot）：修复轮只接受落在该时段的餐厅。
 */
function suggestMealRounds(
  stops: Stop[],
  windows: MealWindow[],
  targetStops: number,
): { round: number; window: MealWindow }[] {
  const order: { round: number; window: MealWindow }[] = [];
  for (const window of windows) {
    for (let index = 0; index < stops.length; index += 1) {
      if (stops[index].arriveAt < window.end && stops[index].leaveAt > window.start) {
        order.push({ round: index, window });
      }
    }
    for (let index = 0; index < stops.length; index += 1) {
      if (stops[index].arriveAt >= window.start) order.push({ round: index, window });
    }
  }
  const fallbackWindow = windows[0];
  for (let index = 0; index < targetStops; index += 1) {
    order.push({ round: index, window: fallbackWindow });
  }
  return order.filter((item, index) => {
    const key = `${item.round}:${item.window.slot}`;
    return order.findIndex((other) => `${other.round}:${other.window.slot}` === key) === index;
  });
}

/**
 * M4.5 3.3：**选站时**就判断这一轮是不是必须选餐厅（不再排完再整盘重排）。
 *
 * M5 收尾修复后，「当前时间 ≤ 13:30 就把午餐排掉」这条旧规则必须收紧：
 * 那样会在 10:18 这种非正餐时段塞一家餐厅，等真到午餐时段又会选第二家（实测 bug）。
 * 现在只在「这一轮的餐厅停留窗口确实能压到某个**未占用**的正餐时段」时才强制：
 *   1. 午餐还没被占用，且 now + 餐厅停留时长 > 午餐开始
 *      （到达只会比 now 更晚，所以停留结束才有可能跨进午餐时段）；
 *   2. 已经是最后一轮 + 晚餐还没被占用 + 行程结束时间必然 ≥ 17:30。
 * 都不满足时返回 null（这一轮正常按全类目选）；餐厅只在正餐时段出现的硬性过滤
 * 由 pickNext 的第 5 步兜底，这里只负责别漏掉正餐。
 */
function autoMealWindow(
  round: number,
  now: number,
  startAt: number,
  constraints: ParsedConstraints,
  occupiedSlots: ReadonlySet<MealSlot>,
  targetStops: number,
): MealWindow | null {
  const lunch = mealWindowOf("lunch");
  const dinner = mealWindowOf("dinner");
  // 条件 1：午餐还没被占用，且这一轮的停留窗口有机会跨进午餐时段。
  if (!occupiedSlots.has("lunch") && now < lunch.end && now + STAY_MIN.restaurant > lunch.start) {
    return lunch;
  }
  // 条件 2：最后一轮 + 晚餐还没被占用 + 行程结束时间必然 ≥ 17:30 —— 晚餐窗口必然被覆盖。
  // 任务1：最后一轮 = targetStops - 1（由可用时长算出的站数，不再引用全局 MAX_STOPS）。
  if (!occupiedSlots.has("dinner") && round === targetStops - 1) {
    let minStay = Number.POSITIVE_INFINITY;
    for (const place of constraints.pool) minStay = Math.min(minStay, STAY_MIN[place.category]);
    const earliestEnd = now + (Number.isFinite(minStay) ? minStay : 0);
    if (startAt < dinner.end && earliestEnd > dinner.start) return dinner;
  }
  return null;
}

/** 「餐饮预算不足 / 餐饮排不进去」都要指名卡在哪条约束（M4 3.5 / M4.5 顺手改：说清哪一餐、差多少钱）。 */
/**
 * M20：补站轮（round ≥ targetStops）的用餐判定。
 *
 * 主循环的 autoMealWindow 只在「最后一轮」把晚餐塞进来；补站会继续往后排，
 * 所以补站轮要自己判断：这一站的停留窗口会不会让行程覆盖一个还没安排餐厅的正餐时段？
 * 会 → 只能从餐厅里选（与主循环的强制用餐轮同一口径），否则用餐硬约束会被补站破坏。
 */
function extraRoundMealWindow(
  now: number,
  occupiedSlots: ReadonlySet<MealSlot>,
): MealWindow | null {
  const lunch = mealWindowOf("lunch");
  if (!occupiedSlots.has("lunch") && now < lunch.end && now + STAY_MIN.restaurant > lunch.start) {
    return lunch;
  }
  const dinner = mealWindowOf("dinner");
  if (!occupiedSlots.has("dinner") && now < dinner.end && now + STAY_MIN.restaurant > dinner.start) {
    return dinner;
  }
  return null;
}

function buildMealFailureReason(
  mealFailure: { reason: string; budgetLeft: number; windows: MealWindow[] } | null,
  windows: MealWindow[],
  constraints: ParsedConstraints,
): string {
  const effectiveWindows = mealFailure !== null ? mealFailure.windows : windows;
  const labels = effectiveWindows.map((window) => window.label).join("、");
  const restaurants = constraints.pool.filter((place) => place.category === "restaurant");
  let cheapest: { name: string; cost: number } | null = null;
  for (const restaurant of restaurants) {
    const cost = estimateCost(restaurant).cost;
    if (cheapest === null || cost < cheapest.cost) cheapest = { name: restaurant.name, cost };
  }
  // 失败原因里只要出现「预算」（预算不足 / 超出剩余预算），就归到餐饮预算卡住：
  // 说清是哪一餐、最便宜多少钱、超过预算多少（M4.5 顺手改，不再只写「排不出来」）。
  if (mealFailure !== null && mealFailure.reason.indexOf("预算") !== -1) {
    const cheapestCost = cheapest === null ? "未知" : `${cheapest.cost} 元`;
    const cheapestName = cheapest === null ? "" : `（${cheapest.name}）`;
    return `餐饮预算不足：${labels}时段需要安排餐厅，最便宜的 ${cheapestCost}超过预算 ${mealFailure.budgetLeft} 元${cheapestName}`;
  }
  const detail = mealFailure === null ? "" : `（${mealFailure.reason}）`;
  return `餐饮排不进去：${labels}时段需要安排餐厅，但没有能排进去的餐厅${detail}`;
}

/* ------------------------------------------------------------------ *
 * M9：餐厅卡（排队只估、点菜按人数、预约只提醒）
 *
 * 这里没有、也拿不到任何实时排队 / 订座数据。estimateWait 只是
 * 「评分 × 时段」的经验估计，文案严格限制在 M9 3.3 允许的两种句式里。
 * ------------------------------------------------------------------ */

/** M9 3.2 的用餐高峰：只有这两个小时段算「可能要等」。 */
const WAIT_PEAK_WINDOWS: { start: number; end: number }[] = [
  { start: 12 * 60, end: 13 * 60 },
  { start: 18 * 60, end: 19 * 60 },
];

/** M9 3.2 的两条评分线。 */
const WAIT_HIGH_RATING = 4.5;
const WAIT_MID_RATING = 4.2;

/** M9 3.2 的三档等待区间（分钟）：文案照抄这个区间，不临场编数字。 */
const WAIT_RANGE: Record<WaitLevel, { min: number; max: number }> = {
  low: { min: 0, max: 5 },
  mid: { min: 15, max: 20 },
  high: { min: 30, max: 40 },
};

const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 行程是「今天」的，所以文案里的周几按当天算。 */
export function weekdayLabelOf(date: Date): string {
  return WEEKDAY_LABELS[date.getDay()];
}

export type WaitEstimate = { min: number; level: WaitLevel };

/**
 * M9 3.2：排队预估（只能估，不报实时人数）。
 *
 * - 评分 ≥ 4.5 且落在 12:00–13:00 / 18:00–19:00 → high，30–40 分钟
 * - 评分 ≥ 4.2 且在同一时段                     → mid，15–20 分钟
 * - 其他                                       → low，0–5 分钟
 *
 * 评分缺失按 low 处理：没有评分依据就不该估出「要排队」。
 */
export function estimateWait(place: Place, arriveAt: number): WaitEstimate {
  const inPeak = WAIT_PEAK_WINDOWS.some((window) => arriveAt >= window.start && arriveAt < window.end);
  const rating = place.rating;
  if (inPeak && rating !== null && rating >= WAIT_HIGH_RATING) {
    return { min: WAIT_RANGE.high.min, level: "high" };
  }
  if (inPeak && rating !== null && rating >= WAIT_MID_RATING) {
    return { min: WAIT_RANGE.mid.min, level: "mid" };
  }
  return { min: WAIT_RANGE.low.min, level: "low" };
}

/** M9 3.4：点菜建议按人数给，句式固定，不发挥。 */
export function suggestDishes(people: number): string {
  if (people <= 1) return "1 份主食 + 1 个小菜";
  if (people === 2) return "1 道主菜 + 1 个青菜 + 2 份主食";
  return `每人 1 道菜，约 ${people} 道`;
}

function formatClockText(minute: number): string {
  const hour = Math.floor(minute / 60);
  const rest = minute % 60;
  return `${String(hour).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

/**
 * M9 3.3 文案红线：只允许这两种句式。
 * low →「这个点人少」；mid / high →「周五 18:00 后通常要等 30–40 分钟」。
 */
function buildWaitText(level: WaitLevel, arriveAt: number, weekdayLabel: string): string {
  if (level === "low") return "这个点人少";
  const range = WAIT_RANGE[level];
  return `${weekdayLabel} ${formatClockText(arriveAt)} 后通常要等 ${range.min}–${range.max} 分钟`;
}

/**
 * M9 3.5：只提醒、不代订、不代付。
 * 跳转用高德搜索页（能看到店铺电话）；城市数据里没有电话字段，也不编造号码。
 */
function buildBookingText(level: WaitLevel, arriveAt: number): string | null {
  if (level === "low") return null;
  return `这家 ${Math.floor(arriveAt / 60)} 点后要排队，建议现在打电话或线上取号（自行预约）`;
}

function buildBookingUrl(place: Place): string {
  return `https://uri.amap.com/search?keyword=${encodeURIComponent(place.name)}`;
}

/** 把餐厅站要展示的四件事（到店 / 等多久 / 吃什么 / 花多少）算成 MealInfo。 */
export function buildMealInfo(place: Place, arriveAt: number, people: number, weekdayLabel: string): MealInfo {
  const wait = estimateWait(place, arriveAt);
  return MealInfoSchema.parse({
    waitMin: wait.min,
    waitLevel: wait.level,
    waitText: buildWaitText(wait.level, arriveAt, weekdayLabel),
    bookingText: buildBookingText(wait.level, arriveAt),
    bookingUrl: wait.level === "low" ? null : buildBookingUrl(place),
    people,
    dishText: suggestDishes(people),
    perPersonCost: estimateCost(place).cost,
  });
}

/**
 * 按可用时长算出的 targetStops 循环，返回已排好的部分（排不满不算失败）。
 * 每轮只把估算预筛后的 ≤6 个候选传给 pickNext；每轮结束立刻跑 3.3 的闭合断言。
 *
 * M4.5 3.3：轮到该吃正餐时这一轮候选池直接过滤成餐厅（不再排完再整盘重排）；
 * 若过滤后仍排不出来，只有「预算不足」是结论性的（预算只会更少），其余原因退回全类目候选池兜底。
 *
 * M5 收尾修复：循环里维护「今天已经被餐厅占用的正餐时段」。餐厅站只在未占用的正餐时段出现，
 * 每选中一家餐厅就把对应时段记下来，所以同一时段 / 非正餐时段都不可能再选第二家。
 */
async function planRounds(options: PlanRoundsOptions): Promise<RoundsPlan> {
  const { origin, startAt, constraints, visitedPlaceIds, forcedMeal, mealAuto, profile } = options;
  // 返程终点（夜间上限预判要知道「最后一站回到哪」）：默认 = 起点。
  const destination = constraints.destination === undefined ? origin : constraints.destination;
  // 环线形状：所有「到起点距离」一律用同一份起点坐标算（与 pickNext 的 routeShape.origin 一致）。
  const originPoint = { lng: origin.lng, lat: origin.lat };
  // 任务5：停留下限按可用时长动态（buildItinerary 每次 attempt 传入；直调方不传 = 旧口径 45）。
  const minStayMin = constraints.minStayMin ?? MIN_STAY_MIN;
  const pickLimits: PickLimits = {
    lastEndMinute: constraints.lastEndMinute,
    destination: { lng: destination.lng, lat: destination.lat },
    // 只有短窗口（minStayMin<45）才把动态下限带进 lastEnd 预判；白天不传 = 原 full-stay 行为。
    minStayMin: minStayMin < MIN_STAY_MIN ? minStayMin : undefined,
  };
  const placeById = new Map<string, Place>(constraints.pool.map((place) => [place.id, place]));
  /**
   * 「再来一条」历史站点（本轮修复根因 2）：**所有站**的候选池都要排除它们，不只是第 1 站。
   * 这里在 planRounds 层先剔一遍（餐厅池 + 每轮 sourcePool），保证预筛拿到的都是 fresh 候选；
   * pickNext 里还有一层同样的过滤兜底（直接调用 pickNext / 日落路径也覆盖）。
   */
  const historyExcludedPlaceIds = new Set<string>(
    constraints.excludePlaceIds === undefined ? [] : constraints.excludePlaceIds,
  );
  // M18：强制用餐轮的餐厅候选也要过画像硬过滤（rich 排除便宜餐厅 / powerful 排除贵餐厅）。
  // 开屏第 5 题选「不用了」时（wantsMeal=false）不安排吃饭：餐厅池为空、也不会有强制用餐轮。
  const mealIncludedForRounds = wantsMeal(profile);
  const restaurants = mealIncludedForRounds
    ? constraints.pool.filter(
        (place) =>
          place.category === "restaurant" &&
          profileAllowsPlace(place, profile) &&
          !historyExcludedPlaceIds.has(place.id),
      )
    : [];
  // 任务1：本轮排站硬上限——可用时长已经由 buildItinerary 折算成 constraints.maxTotalMin。
  // M18：再叠加画像的站数上限（rich 3；powerful 与 MAX_STOPS 相同），两者取小。
  const targetStops = Math.min(profileMaxStops(profile), targetStopsForBudget(constraints.maxTotalMin));
  /**
   * M20：跨午餐 + 晚餐的长行程，「吃喝」名额只有 2 个（规则 2），必须留给两顿正餐。
   * 这类行程里如果先选了一家 cafe，第二个名额就被占掉，强制晚餐轮会因为没有餐厅可选
   * 而降级成非餐厅站（老行为是午餐 + 晚餐各一家餐厅）。所以在候选池里直接排除 cafe：
   * 两顿正餐 = 两个 restaurant（restaurant 两站是「用餐硬约束」允许的例外，见 isCategoryExcluded）。
   * 判定用「出发时刻 + 本站时间预算 + 一段平均通勤」估算行程是否会跨进晚餐时段；
   * 只影响跨两餐的整天 / 长时长行程，单餐行程（15:20 / loopback / sunset / postfill / profile）不受影响。
   */
  const lunchWindow = mealWindowOf("lunch");
  const dinnerWindow = mealWindowOf("dinner");
  // 开屏第 5 题选「不用了」时跳过「跨两餐先排除 cafe」：不安排吃饭就没有把两个吃喝名额留给餐厅的必要。
  const spansBothMeals =
    mealIncludedForRounds &&
    startAt < lunchWindow.end &&
    startAt + constraints.maxTotalMin + AVG_COMMUTE_MIN > dinnerWindow.start;
  /**
   * M20 补站（post-fill）：**只在传了 homeBy 时启用**（不传 homeBy 时行为与改造前逐字一致）。
   *
   * 站数原本按 floor(可用时长 / 72) 估算，但真实每站停留 45–90 分钟、通勤 3–9 分钟，
   * 估算偏保守 → 排完常常还剩一大段。这里在 targetStops 之外继续用**同一套**
   * 「候选过滤 + 打分 + pickNext」补站，直到：剩余时间不够最短一站 / 候选都装不下 /
   * 到站数硬上限（rich 3、powerful 6）。
   * 距离递增、营业时间、预算、800m 去重、用餐硬约束全部沿用主循环的同一套判定，一条都不放松。
   * 日落锚点场景（tryPlanSunsetReserved）不走本函数，所以不会把新站插到锚点后面。
   */
  const postFillEnabled = constraints.homeBy !== undefined;
  const postFillStopCap = profileMaxStops(profile);
  /**
   * 任务1（本轮）：补站轮**不再**用固定的「最短停留 + 12 分钟通勤余量」当提前停止阈值。
   * 真实通勤（到候选那一段）由 pickNext 实测、返程由 decideReturnCommute 实测，
   * 两者都在 pickFrom 里参与判定；这里只守住「连最短的一站都放不下」这条硬底。
   */
  const visited = new Set<string>(visitedPlaceIds);
  /**
   * 今天已经被餐厅占用的正餐时段（每个时段最多一家餐厅）。
   * 允许调用方通过 mode.occupiedMealSlots 预置（例如接续一份业已排好的行程），默认两个时段都空着。
   */
  const occupiedMealSlots = new Set<MealSlot>(
    constraints.mode.occupiedMealSlots === undefined ? [] : constraints.mode.occupiedMealSlots,
  );
  /**
   * M20 类目多样性：这条行程已经排过的 category / cafe+restaurant 次数。
   * 每选出一站就更新（recordPickedCategory），同一份状态传给后续每一次 pickNext
   * （重试轮、补站轮都用同一份，不各自从空开始）。允许调用方通过 mode 预置（接续已排好的行程）。
   */
  const usedCategories: PlaceCategory[] =
    constraints.mode.usedCategories === undefined ? [] : constraints.mode.usedCategories.slice();
  let usedDiningCount = constraints.mode.usedDiningCount === undefined ? 0 : constraints.mode.usedDiningCount;
  /**
   * M21 跨两餐餐厅差异化：这条行程已经排过的餐厅店名前两个字。
   * 每次 pickNext 都带进 mode（命中同前缀只做重降权），选中后追加一份。
   */
  const usedRestaurantPrefixes: string[] =
    constraints.mode.usedRestaurantPrefixes === undefined
      ? []
      : constraints.mode.usedRestaurantPrefixes.slice();
  const recordPickedCategory = (place: Place): void => {
    if (usedCategories.indexOf(place.category) === -1) usedCategories.push(place.category);
    if (isDiningCategory(place.category)) usedDiningCount += 1;
  };

  const stops: Stop[] = [];
  const segments: Segment[] = [];
  let currentPlace = origin;
  let now = startAt;
  let budgetLeft = constraints.budget;
  let stopReason: string | null = null;
  let mealFailure: { reason: string; budgetLeft: number; windows: MealWindow[] } | null = null;

  /**
   * 从给定候选里挑下一站：若 top1 的停留会撑破 maxTotalMin，就剔掉它换下一个候选。
   * requiredMealSlot：这一轮必须安排的正餐时段（强制用餐轮 / 修复轮才有）。
   * extraRound：这一轮是补站轮（任务1：用真实返程判定 + 允许把停留压到 MIN_STAY_MIN，不丢站）。
   * farZoneCommutes：远区候选已经判定好的通勤（M21），交给 pickNext 复用。
   */
  async function pickFrom(
    pool: Place[],
    requiredMealSlot: MealSlot | null,
    extraRound: boolean,
    farZoneCommutes: ReadonlyMap<string, Commute>,
  ): Promise<{ picked: { stop: Stop; segment: Segment } | null; lastReason: string | null }> {
    // 任务2：路线方位单调性——已选站到起点的直线距离（按访问顺序）。
    // pickNext 的 pool 只含预筛候选、不含已选站，所以 priorDistances 必须由这里算好传进去。
    const routeShape: RouteShape = {
      origin: { lng: origin.lng, lat: origin.lat },
      priorDistances: stops.map((stop) => {
        const place = placeById.get(stop.placeId);
        if (place === undefined) {
          throw new Error(`行程里出现候选池外的 placeId=${stop.placeId}`);
        }
        return haversineMeters(origin, place);
      }),
      // 还没有已选站 = 这一轮就是第 1 站：交给 pickNext 按「最近的合规点」扫。
      // 第 2 站及以后由主循环里的 filterByRouteDistance 保证距离单调，不再套第 1 站规则。
      firstStop: stops.length === 0,
      // 「再来一条」的随机种子：不传就是 undefined（确定性，与改造前逐字一致）。
      seed: constraints.seed,
      // 「再来一条」：本会话出现过的 placeId，pickNext 会把它们从**所有站**的候选池排除
      //（不是只避第 1 站；排除空了会返回 EXCLUDE_EXHAUSTED_REASON，不回退允许重复）。
      excludePlaceIds: constraints.excludePlaceIds,
      // M21：远区候选的已判定通勤（无远区时是空 Map，pickNext 走原 decideCommute）。
      farZoneCommutes,
    };
    let remaining = pool;
    let lastReason: string | null = null;
    for (let attempt = 0; attempt < MAX_FIT_ATTEMPTS_PER_ROUND && remaining.length > 0; attempt += 1) {
      const mode: PickMode = {
        ...constraints.mode,
        visitedPlaceIds: Array.from(visited),
        occupiedMealSlots: Array.from(occupiedMealSlots),
        // M20：把这条行程「已用类目 / 吃喝次数」带给本次选点（类目多样性硬过滤）。
        usedCategories: usedCategories.slice(),
        usedDiningCount,
        // M21：跨两餐餐厅差异化（同前缀餐厅只做重降权，不排除）。
        usedRestaurantPrefixes: usedRestaurantPrefixes.slice(),
      };
      if (requiredMealSlot !== null) mode.requiredMealSlot = requiredMealSlot;
      const result = await pickNext(
        currentPlace,
        now,
        remaining,
        budgetLeft,
        mode,
        constraints.cityCode,
        pickLimits,
        routeShape,
        profile,
      );
      if (result.ok === false) {
        return { picked: null, lastReason: result.reason };
      }
      // 任务1（本轮）：补站轮用**真实通勤 + 真实返程**判定这一站还能不能排进来。
      // 旧逻辑只看「离开时刻 ≤ maxTotalMin」（返程按固定 12 分钟估算），
      // 真实返程 30–37 分钟时就会「先补站 → 到家超时 → 重排 → 少一站」。
      // 现在：候选的真实通勤已由 pickNext 算进 arriveAt；这里再算一次真实返程，
      // 若 remaining 落在 [MIN_STAY_MIN + 通勤, …] 区间，允许把停留压到 MIN_STAY_MIN（不丢站）。
      if (extraRound) {
        const candidatePlace = placeById.get(result.stop.placeId);
        if (candidatePlace === undefined) {
          remaining = remaining.filter((place) => place.id !== result.stop.placeId);
          lastReason = `候选池里找不到 placeId=${result.stop.placeId}`;
          continue;
        }
        const returnCommute = await decideReturnCommute(
          candidatePlace,
          pickLimits.destination,
          constraints.mode,
          profile,
          constraints.cityCode,
        );
        if (returnCommute === null) {
          remaining = remaining.filter((place) => place.id !== result.stop.placeId);
          lastReason = `算不出 ${candidatePlace.name} 回到终点的路线`;
          continue;
        }
        const homeByMinute = constraints.homeBy;
        const homeLeaveCap =
          homeByMinute === undefined ? Number.POSITIVE_INFINITY : homeByMinute - returnCommute.durationMin;
        const latestLeave = Math.min(startAt + constraints.maxTotalMin, homeLeaveCap);
        if (result.stop.leaveAt <= latestLeave) {
          return { picked: { stop: result.stop, segment: result.segment }, lastReason };
        }
        const trimmedStayMin = Math.floor(latestLeave - result.stop.arriveAt);
        if (candidatePlace.category !== "restaurant" && trimmedStayMin >= MIN_STAY_MIN) {
          const trimmedStop: Stop = StopSchema.parse({
            ...result.stop,
            stayMin: trimmedStayMin,
            leaveAt: result.stop.arriveAt + trimmedStayMin,
          });
          return { picked: { stop: trimmedStop, segment: result.segment }, lastReason };
        }
        remaining = remaining.filter((place) => place.id !== result.stop.placeId);
        lastReason =
          homeByMinute === undefined
            ? "候选点都会超过本次可用时长"
            : `候选点都赶不上 ${formatClockText(homeByMinute)} 回到家`;
        continue;
      }
      if (result.stop.leaveAt - startAt <= constraints.maxTotalMin) {
        return { picked: { stop: result.stop, segment: result.segment }, lastReason };
      }
      // 任务5：短窗口（minStayMin<45）允许把**非餐厅**候选的停留压到刚好装进可用时长；
      // 白天 minStayMin=45 不会进这个分支，15:20 / 11:00 行为逐字不变。
      if (minStayMin < MIN_STAY_MIN) {
        const candidatePlace = placeById.get(result.stop.placeId);
        const maxStayMin = constraints.maxTotalMin - (result.stop.arriveAt - startAt);
        const trimmedStayMin = Math.floor(maxStayMin);
        if (
          candidatePlace !== undefined &&
          candidatePlace.category !== "restaurant" &&
          trimmedStayMin >= minStayMin
        ) {
          const trimmedStop: Stop = StopSchema.parse({
            ...result.stop,
            stayMin: trimmedStayMin,
            leaveAt: result.stop.arriveAt + trimmedStayMin,
          });
          return { picked: { stop: trimmedStop, segment: result.segment }, lastReason };
        }
      }
      remaining = remaining.filter((place) => place.id !== result.stop.placeId);
      lastReason = `候选点都会超过 ${constraints.maxTotalMin} 分钟的总时长上限`;
    }
    return { picked: null, lastReason };
  }

  for (let round = 0; ; round += 1) {
    // 超出估算站数的轮次 = 补站轮（只有 homeBy 场景才会进来）。
    const isExtraRound = round >= targetStops;
    if (isExtraRound && (!postFillEnabled || stops.length >= postFillStopCap)) break;
    if (now - startAt >= constraints.maxTotalMin) break;

    // 任务1 + 任务5：通用守卫——剩余可用时长连「动态最短停留 + 一段通勤」都放不下时停止加站。
    // 补站轮（本轮任务1）：不再用固定的「+12 分钟」估算——真实通勤 / 返程在 pickFrom 里实测，
    // 这里只守住「连最短的一站都放不下」这条硬底，避免为了一次根本装不下的补站白跑路线。
    const remainingMin = constraints.maxTotalMin - (now - startAt);
    const roundGuardMin = isExtraRound ? MIN_STAY_MIN : minStayMin + AVG_COMMUTE_MIN;
    if (remainingMin < roundGuardMin) {
      // 补站轮只是「还能不能多排一站」的优化，不写失败原因（行程本身已经成立）。
      if (!isExtraRound) stopReason = LATE_NIGHT_FAILURE_REASON;
      break;
    }

    // 夜间修复：连最短的一站（动态下限）都装不进当天硬上限 → 不再尝试，直接给人话原因。
    // 白天（now + 45 ≤ 1410）永远不进这个分支，行为与改造前逐字一致。
    if (now + minStayMin > constraints.lastEndMinute) {
      stopReason = LATE_NIGHT_FAILURE_REASON;
      break;
    }

    // 这一轮要不要强制餐厅（选站时判定，不整盘重排）。
    // 开屏第 5 题选「不用了」时（wantsMeal=false）永远不强制餐厅。
    let forcedMealWindow: MealWindow | null = null;
    if (mealIncludedForRounds) {
      if (forcedMeal !== null && forcedMeal.round === round) {
        // 兜底重排：这一轮只从餐厅里选，且必须落在指定的正餐时段。
        forcedMealWindow = mealWindowOf(forcedMeal.slot);
      } else if (mealAuto) {
        forcedMealWindow = isExtraRound
          ? extraRoundMealWindow(now, occupiedMealSlots)
          : autoMealWindow(round, now, startAt, constraints, occupiedMealSlots, targetStops);
      }
    }
    // 这个时段今天已经安排过餐厅了：这一轮不再重复安排。
    if (forcedMealWindow !== null && occupiedMealSlots.has(forcedMealWindow.slot)) {
      forcedMealWindow = null;
    }

    const excluded = new Set<string>(visited);
    excluded.add(origin.id);
    excluded.add(currentPlace.id);
    const point = { lng: currentPlace.lng, lat: currentPlace.lat };

    // 同区域重复 + 跨站绕回：同类目 <800m 的已选地点不重复；
    // 第 3 站及以后还不能落回前序任一站的 800m 内。
    const selectedPlaces = stops
      .map((stop) => placeById.get(stop.placeId))
      .filter((place): place is Place => place !== undefined);
    const isBlockedCandidate = (place: Place): boolean =>
      isSameAreaDuplicate(place, selectedPlaces) || isNonAdjacentLoopback(place, selectedPlaces);

    /**
     * 构造本轮候选池：去重 / 绕回过滤 →（第 2 站及以后）距离单调过滤。
     * 返回 null = 距离两档（×0.9 / ×0.75）都为空，调用方停止加站。
     */
    const buildSourcePool = (base: Place[]): Place[] | null => {
      // M18：画像硬过滤在「预筛前」生效——否则最近 6 个候选可能全是画像不允许的点，
      // 预筛把合规点筛掉、再拿不合规的点凑数。不传 profile 时该谓词恒 true。
      let filtered = base.filter(
        (place) =>
          profileAllowsPlace(place, profile) &&
          !isBlockedCandidate(place) &&
          // 「再来一条」：本会话出现过的站点不进任何一轮的候选池（第 1 站 / 后续站 / 补站轮都一样）。
          !historyExcludedPlaceIds.has(place.id),
      );
      // M20：跨两餐的行程先排除 cafe，把两个「吃喝」名额留给午餐 / 晚餐两家餐厅。
      if (spansBothMeals) {
        filtered = filtered.filter((place) => place.category !== "cafe");
      }
      if (stops.length > 0) {
        const previousDistance = haversineMeters(origin, currentPlace);
        const distanceFiltered = filterByRouteDistance(filtered, originPoint, previousDistance);
        if (distanceFiltered === null) return null;
        filtered = distanceFiltered.pool;
      }
      return filtered;
    };

    // 选点阶段完全不考虑日落锚点：打分、距离、预算、用餐约束全部按原逻辑走。
    // 时间锚点已在 buildItinerary 最开头「先占位」处理（tryPlanSunsetReserved）。
    let sourcePool = buildSourcePool(forcedMealWindow !== null ? restaurants : constraints.pool);
    if (sourcePool === null) {
      // 环线形状：第 i 站（i≥2）距离两档都空 → 不再加站，给一句人话（不编造地点）。
      stopReason = ROUTE_DISTANCE_EXHAUSTED_REASON;
      break;
    }
    /**
     * 「再来一条」的历史站点已经在 buildSourcePool 里剔除了（第 1 站 / 后续站都一样），
     * 所以预筛不需要再放大来「挤掉」被排除的候选——预筛看到的最近 6 个全是 fresh 的。
     * 不带 excludePlaceIds 时仍是原 PREFILTER_LIMIT=6，行为逐字不变。
     */
    /**
     * M21：两段式预筛（有 profile 时）：
     *   近区 0–5km 取最近 limit 个；远区按 style 规则取合格的前 N 个（交通方式已在进池前判定）。
     * 无 profile / 强制用餐轮 → 就是原来的 selectNearbyForScene，行为与改造前逐字一致。
     */
    const farZoneMode: PickMode = {
      ...constraints.mode,
      usedCategories: usedCategories.slice(),
      usedDiningCount,
    };
    const prefilterCandidates = async (
      limit: number,
    ): Promise<{ places: Place[]; farCommutes: ReadonlyMap<string, Commute> }> => {
      // 闭包里读 sourcePool 会丢掉上面的判空收窄（TS 不对闭包捕获的可变变量做控制流分析）。
      // 这里按「调用时刻」取一次快照再显式判空：语义仍然是「用当前那一轮的 sourcePool」，
      // 只是把 null 收干净——后面 2900+ 行把 sourcePool 换成 fallbackPool 时，下次调用会重新取快照。
      const pool = sourcePool;
      if (pool === null) {
        return { places: [], farCommutes: EMPTY_FAR_COMMUTES };
      }
      if (profile === undefined || forcedMealWindow !== null) {
        return {
          places: selectNearbyForScene(pool, point, excluded, limit, profile),
          farCommutes: EMPTY_FAR_COMMUTES,
        };
      }
      const nearPool = pool.filter((place) => haversineMeters(origin, place) < NEAR_ZONE_RADIUS_M);
      const near = selectNearbyForScene(nearPool, point, excluded, limit, profile);
      const far = await selectFarZoneCandidates(
        pool,
        point,
        originPoint,
        excluded,
        profile,
        farZoneMode,
        constraints.cityCode,
      );
      const merged = near.slice();
      const seenIds = new Set(merged.map((place) => place.id));
      for (const place of far.places) {
        if (seenIds.has(place.id)) continue;
        merged.push(place);
        seenIds.add(place.id);
      }
      return { places: merged, farCommutes: far.commutes };
    };

    const firstPrefiltered = await prefilterCandidates(PREFILTER_LIMIT);
    let nearby = firstPrefiltered.places;
    let farZoneCommutes = firstPrefiltered.farCommutes;
    if (nearby.length === 0) {
      /**
       * 「再来一条」把历史站点全排除后候选池真的空了 → 返回任务书指定的人话，
       * 不为了「总能换」而偷偷忽略 exclude（铁律 5）。
       * 无 exclude / 普通空池 → 保持改造前的原有文案。
       */
      stopReason =
        historyExcludedPlaceIds.size > 0 && sourcePool.length === 0
          ? EXCLUDE_EXHAUSTED_REASON
          : forcedMealWindow !== null
            ? "候选池里没有可用的餐厅"
            : "候选池是空的：没有可推荐的地点";
      if (forcedMealWindow !== null) mealFailure = { reason: stopReason, budgetLeft, windows: [forcedMealWindow] };
      break;
    }

    let outcome = await pickFrom(
      nearby,
      forcedMealWindow === null ? null : forcedMealWindow.slot,
      isExtraRound,
      farZoneCommutes,
    );

    // 提前过滤成餐厅后仍排不出来：预算类失败是结论性的（预算只会更少），直接按用餐约束失败返回；
    // 其他原因（餐厅都关门 / 都超出半径 / 这个时段压不进去）退回全类目候选池，交给后面的兜底重排处理，
    // 保证用餐修复不会因为一次提前强制失败就丢掉整份行程。
    if (
      outcome.picked === null &&
      forcedMealWindow !== null &&
      forcedMeal === null &&
      outcome.lastReason !== null &&
      outcome.lastReason.indexOf("预算") === -1
    ) {
      forcedMealWindow = null;
      const fallbackPool = buildSourcePool(constraints.pool);
      if (fallbackPool === null) {
        outcome = { picked: null, lastReason: ROUTE_DISTANCE_EXHAUSTED_REASON };
      } else {
        sourcePool = fallbackPool;
        nearby = selectNearby(sourcePool, point, excluded);
        farZoneCommutes = EMPTY_FAR_COMMUTES;
        outcome =
          nearby.length === 0
            ? { picked: null, lastReason: stopReason }
            : await pickFrom(nearby, null, isExtraRound, farZoneCommutes);
      }
    }

    // M20 类目多样性：预筛只取最近的 6 个。如果这一轮最终排不出来（outcome 为空），
    // 而可见的预筛候选里确实有被类目多样性排除的点，很可能是「6 个候选里重复类目占满、
    // 其它类目的合规点没进预筛」导致的提前停站。此时把预筛数量翻倍再试，直到候选池全量：
    // 只是让 pickNext 看到更多候选，类目过滤 / 打分 / 距离 / 预算 / 营业时间一条都没放宽；
    // 正常轮次（第一次就排到）完全不受影响，所以已有基线（如辽阳）的 placeId 不会变。
    let prefilterLimit = PREFILTER_LIMIT;
    while (
      outcome.picked === null &&
      forcedMealWindow === null &&
      prefilterLimit < sourcePool.length &&
      nearby.some((place) => isCategoryExcluded(place, usedCategories, usedDiningCount))
    ) {
      prefilterLimit = Math.min(sourcePool.length, prefilterLimit * 2);
      const nextPrefiltered = await prefilterCandidates(prefilterLimit);
      nearby = nextPrefiltered.places;
      farZoneCommutes = nextPrefiltered.farCommutes;
      outcome = await pickFrom(nearby, null, isExtraRound, farZoneCommutes);
    }

    const picked = outcome.picked;
    if (picked === null) {
      stopReason = outcome.lastReason === null ? "没有可选的下一站" : outcome.lastReason;
      if (forcedMealWindow !== null) mealFailure = { reason: stopReason, budgetLeft, windows: [forcedMealWindow] };
      break;
    }

    const pickedPlace = placeById.get(picked.stop.placeId);
    if (pickedPlace === undefined) {
      throw new Error(`pickNext 返回了候选池外的 placeId=${picked.stop.placeId}`);
    }

    // M4 3.3：每轮结束都跑闭合校验，不通过直接抛错（不静默修正）。
    assertSegmentClosed(now, picked.segment, picked.stop, `第 ${stops.length + 1} 段`);
    assertStopClosed(picked.stop, `第 ${stops.length + 1} 站`);
    if (picked.segment.fromId !== currentPlace.id) {
      throw new Error(`第 ${stops.length + 1} 段 fromId=${picked.segment.fromId}，应为 ${currentPlace.id}`);
    }
    if (picked.segment.toId !== picked.stop.placeId) {
      throw new Error(`第 ${stops.length + 1} 段 toId=${picked.segment.toId} 与 stop.placeId=${picked.stop.placeId} 不一致`);
    }

    // M5 收尾修复：餐厅站必须落在今天还没被占用的正餐时段，选中后立刻占用这个时段。
    if (pickedPlace.category === "restaurant") {
      const slot = mealSlotFor(picked.stop.arriveAt, picked.stop.stayMin);
      if (slot === null) {
        throw new Error(`第 ${stops.length + 1} 站「${pickedPlace.name}」不在正餐时段内，选站逻辑有 bug`);
      }
      if (occupiedMealSlots.has(slot.slot)) {
        throw new Error(`第 ${stops.length + 1} 站「${pickedPlace.name}」落在已经安排过餐厅的${slot.label}时段`);
      }
      occupiedMealSlots.add(slot.slot);
    }

    // M20：这一站排定了 → 记下它的类目 / 吃喝次数，后续每一轮都不能再选同类目。
    recordPickedCategory(pickedPlace);

    // M21 跨两餐餐厅差异化：记下餐厅店名前两个字；第二家同前缀时在控制台注明（任务3 要求）。
    if (pickedPlace.category === "restaurant") {
      const prefix = restaurantNamePrefix(pickedPlace.name);
      if (usedRestaurantPrefixes.indexOf(prefix) !== -1) {
        console.warn(
          `[planner] 跨两餐餐厅差异化：第二家餐厅「${pickedPlace.name}」与已选餐厅前两个字相同（${prefix}），` +
            "当前城市没有别的同类选择，接受重复",
        );
      }
      usedRestaurantPrefixes.push(prefix);
    }

    stops.push(picked.stop);
    segments.push(picked.segment);
    visited.add(picked.stop.placeId);
    now = picked.stop.leaveAt;
    budgetLeft -= picked.stop.costEstimate;
    currentPlace = pickedPlace;
  }

  return {
    stops,
    segments,
    endAt: stops.length === 0 ? startAt : stops[stops.length - 1].leaveAt,
    stopReason,
    mealFailure,
  };
}

/**
 * 日落锚点前置（本轮核心）：不再「排完再碰运气」，而是排之前先占位。
 *
 * 触发条件：池子里有户外日落点，且出发时间距日落到达窗口 ≤90 分钟
 * （更早出发，例如 15:20，保持普通行程不变）。
 *
 * 结构固定为 3 站：前缀站（正常打分，1 站，排除日落候选）→ 户外日落站（锚定到达目标到，默认 17:32）
 * → 晚餐（行程会跨进晚餐时段，必须含餐厅；否则过不了 M4 的用餐硬约束）。
 * 前缀站的停留时长会被调整到能接上锚定到达目标（45–95 分钟区间），这就是「围绕它排前面的站」。
 * 任何一个候选凑不出合法行程就换下一个；全部失败则返回 null，回退普通排程。
 *
 * 日落参数由调用方传入（resolveSunsetAnchor 解析后的本次调用值），函数内不再有任何硬编码时刻。
 *
 * 任务2：本函数里的 pickNext 调用**不传** routeShape 的拐点扣分（方位单调性扣分只作用于普通选站），
 * 所以日落锚点场景的打分与改造前逐字一致。
 *
 * 环线形状改造（本轮）——锚点场景怎么接距离规则：
 *   1) 前缀站是第 1 站 → 套第 1 站规则（pickNext 的 routeShape.firstStop，候选池 = 排除日落候选后的
 *      全部候选）：按到起点直线距离升序取第一个「通过全部过滤 + 合规」的点；
 *   2) 锚点站是第 2 站，**设计内例外**：到达时刻由「日落前 10 分钟」倒推，允许违反距离单调
 *      （锚点比前缀站近也照旧占位，这是为了赶日落）；
 *   3) 晚餐是第 3 站，以锚点站为「上一站」套 ×0.9 / ×0.75 的距离过滤；
 *   4) 收尾站是第 4 站，以晚餐站为「上一站」套同一套过滤；收尾站过滤为空就不加（保留 3 站版本）。
 * 任何一步过滤为空导致这个日落候选凑不出合法行程时，就换下一个日落候选；全部失败返回 null、
 * 回退普通排程（不抛错、不返回违反用餐 / 闭合约束的行程）。
 */
async function tryPlanSunsetReserved(
  origin: Place,
  startAt: number,
  constraints: ParsedConstraints,
  placeById: Map<string, Place>,
  sunset: SunsetAnchor,
  /** M18（可选）：画像调参表；不传 = 与改造前逐字一致。 */
  profile?: ProfileTuning,
): Promise<RoundsPlan | null> {
  const toWindow = sunset.arriveEarliest - startAt;
  if (toWindow <= 0 || toWindow > SUNSET_PREPLACE_LEAD_MIN) return null;

  /**
   * 「再来一条」历史站点（本轮修复根因 2）：日落锚点路径的每一个候选池都要排除它们
   *（前缀 / 日落候选 / 晚餐 / 收尾站），不能只在第 1 站避让。
   */
  const historyExcludedPlaceIds = new Set<string>(
    constraints.excludePlaceIds === undefined ? [] : constraints.excludePlaceIds,
  );

  const sunsetCandidates = constraints.pool.filter(
    (place) =>
      isSunsetPlace(place) &&
      isSunsetAnchorEligible(place) &&
      profileAllowsPlace(place, profile) &&
      !historyExcludedPlaceIds.has(place.id),
  );
  if (sunsetCandidates.length === 0) return null;
  const sunsetCandidateIds = new Set<string>(sunsetCandidates.map((place) => place.id));

  // 1) 前缀：这是日落行程的第 1 站 → 套第 1 站规则（按到起点距离升序取最近的合规点，
  //    排除日落候选，避免它们占掉锚点位）。pickNext 里仍会走完整的营业时间 / 预算 / 半径过滤。
  const originPoint = { lng: origin.lng, lat: origin.lat };
  const prefixPool = constraints.pool.filter(
    (place) =>
      !sunsetCandidateIds.has(place.id) &&
      profileAllowsPlace(place, profile) &&
      !historyExcludedPlaceIds.has(place.id),
  );
  /**
   * M20 类目多样性：前缀站是这条日落行程的第 1 站。
   * base = 调用方预置的已用类目（接续行程时用）；前缀 / 锚点 / 晚餐 / 收尾共用同一份派生状态，
   * 但每个日落候选重试时用各自的副本（失败候选不能污染下一条尝试）。
   */
  const baseUsedCategories: PlaceCategory[] =
    constraints.mode.usedCategories === undefined ? [] : constraints.mode.usedCategories.slice();
  const baseUsedDiningCount = constraints.mode.usedDiningCount === undefined ? 0 : constraints.mode.usedDiningCount;
  const prefixMode: PickMode = {
    ...constraints.mode,
    visitedPlaceIds: [],
    occupiedMealSlots: [],
    usedCategories: baseUsedCategories.slice(),
    usedDiningCount: baseUsedDiningCount,
  };
  const prefixRouteShape: RouteShape = {
    origin: originPoint,
    priorDistances: [],
    firstStop: true,
    seed: constraints.seed,
    excludePlaceIds: constraints.excludePlaceIds,
  };
  const prefixResult = await pickNext(
    origin,
    startAt,
    prefixPool,
    constraints.budget,
    prefixMode,
    constraints.cityCode,
    undefined,
    prefixRouteShape,
    profile,
  );
  if (prefixResult.ok === false) return null;
  const prefixPlace = placeById.get(prefixResult.stop.placeId);
  if (prefixPlace === undefined) return null;
  const prefixArrive = prefixResult.stop.arriveAt;
  const prefixCost = prefixResult.stop.costEstimate;
  // M20：前缀站的类目 / 吃喝次数 → 传给「到日落点的路线复算」「晚餐」「收尾」三处 pickNext。
  const prefixUsedCategories: PlaceCategory[] = [...baseUsedCategories, prefixPlace.category];
  const prefixUsedDiningCount = baseUsedDiningCount + (isDiningCategory(prefixPlace.category) ? 1 : 0);

  // 2) 逐个日落候选尝试：反推前缀站要待到几点，才能按本次的锚定到达目标到日落点。
  for (const candidate of sunsetCandidates) {
    // 同区域重复：日落候选不能和前缀站同类目且直线 <800m。
    if (isSameAreaDuplicate(candidate, [prefixPlace])) continue;
    const travelMode: PickMode = {
      ...constraints.mode,
      visitedPlaceIds: [prefixPlace.id],
      occupiedMealSlots: [],
      // M20：锚点站是设计内例外（和「锚点允许违反距离单调」同一条纪律）——日落锚点必须占位，
      // 即使它的类目和前缀站相同也不能被类目多样性挡掉；除它自己以外的已用类目照常硬过滤。
      usedCategories: prefixUsedCategories.filter((category) => category !== candidate.category),
      usedDiningCount: prefixUsedDiningCount,
    };
    const travelResult = await pickNext(
      prefixPlace,
      prefixResult.stop.leaveAt,
      [candidate],
      constraints.budget - prefixCost,
      travelMode,
      constraints.cityCode,
      undefined,
      // 日落路径原来不传 routeShape（不算拐点扣分）；这里只带「历史站点排除」，priorDistances 留空
      // → routeShapeMultiplier 恒为 1，打分与改造前逐字一致，只是多一层 exclude 兜底。
      { origin: originPoint, priorDistances: [], excludePlaceIds: constraints.excludePlaceIds },
      profile,
    );
    if (travelResult.ok === false) continue;
    // M18：rich 的非餐厅站 90 分钟（日落站都是户外 park/other → rich 下 90 分钟）。
    const sunsetStay = stayMinForPlace(candidate, profile);
    const prefixLeaveNeeded = sunset.arriveEarliest - travelResult.segment.durationMin;
    const adjustedPrefixStay = prefixLeaveNeeded - prefixArrive;
    if (adjustedPrefixStay < SUNSET_STAY_MIN_FLOOR || adjustedPrefixStay > SUNSET_STAY_MIN_CEILING) {
      continue;
    }
    if (prefixLeaveNeeded <= prefixArrive) continue;
    if (!isOpenAt(prefixPlace, prefixArrive, adjustedPrefixStay)) continue;

    // 前缀站若自己占正餐时段，记录下来（后续晚餐不能重复占同一个时段）。
    let prefixSlot: MealWindow | null = null;
    if (prefixPlace.category === "restaurant") {
      prefixSlot = mealSlotFor(prefixArrive, adjustedPrefixStay);
      if (prefixSlot === null) continue;
    }

    const prefixStop: Stop = StopSchema.parse({
      ...prefixResult.stop,
      stayMin: adjustedPrefixStay,
      leaveAt: prefixLeaveNeeded,
    });

    // 用调整后的出发时刻再算一次到日落点的路线，确保到达就是本次的锚定到达目标。
    const candidateAtAnchor = await pickNext(
      prefixPlace,
      prefixLeaveNeeded,
      [candidate],
      constraints.budget - prefixCost,
      {
        ...constraints.mode,
        visitedPlaceIds: [prefixPlace.id],
        occupiedMealSlots: [],
        // M20：同 travelMode——锚点站自己不受「类目已用」限制（锚点必须占位），其它类目照常过滤。
        usedCategories: prefixUsedCategories.filter((category) => category !== candidate.category),
        usedDiningCount: prefixUsedDiningCount,
      },
      constraints.cityCode,
      undefined,
      { origin: originPoint, priorDistances: [], excludePlaceIds: constraints.excludePlaceIds },
      profile,
    );
    if (candidateAtAnchor.ok === false) continue;
    if (candidateAtAnchor.stop.arriveAt !== sunset.arriveEarliest) continue;

    const candidateCost = estimateCost(candidate);
    const baseReason = buildReason(
      candidate,
      {
        mode: candidateAtAnchor.segment.mode,
        durationMin: candidateAtAnchor.segment.durationMin,
        distanceM: candidateAtAnchor.segment.distanceM,
      },
      candidateCost.basis,
      candidateCost.cost,
    );
    const outdoorHoursNote =
      candidate.openTime === null || candidate.closeTime === null
        ? ""
        : "（户外公共空间，开放时间仅供参考）";
    const sunsetStop: Stop = StopSchema.parse({
      placeId: candidate.id,
      arriveAt: sunset.arriveEarliest,
      leaveAt: sunset.arriveEarliest + sunsetStay,
      stayMin: sunsetStay,
      reason: `${baseReason}，赶得上 ${formatClockText(sunset.sunsetMinute)} 的日落${outdoorHoursNote}`,
      costEstimate: candidateCost.cost,
    });

    // M20：日落站也是这条行程的一站，它的类目 / 吃喝次数继续往晚餐、收尾传。
    // 锚点站允许和前缀站同类目（上面的设计内例外），这里去重后再记录，避免 usedCategories 出现重复项。
    const anchorUsedCategories: PlaceCategory[] =
      prefixUsedCategories.indexOf(candidate.category) === -1
        ? [...prefixUsedCategories, candidate.category]
        : prefixUsedCategories.slice();
    const anchorUsedDiningCount = prefixUsedDiningCount + (isDiningCategory(candidate.category) ? 1 : 0);

    // 3) 晚餐：日落站结束时间已跨进晚餐时段，必须再排一家餐厅。
    //    环线形状：晚餐是第 3 站，以锚点站为「上一站」套距离过滤（锚点本身是设计内例外，
    //    但「第 3 站比第 2 站更远」这条规则照样成立）；两档都空则这个日落候选作废。
    const anchorDistance = haversineMeters(origin, candidate);
    const dinnerPool = filterByRouteDistance(
      // M18：晚餐候选同样要过画像硬过滤（rich 排除便宜餐厅 / powerful 排除贵餐厅 + 评分底线）。
      constraints.pool.filter(
        (place) =>
          place.category === "restaurant" &&
          profileAllowsPlace(place, profile) &&
          !historyExcludedPlaceIds.has(place.id),
      ),
      originPoint,
      anchorDistance,
    );
    if (dinnerPool === null) continue;
    const occupiedSlots: MealSlot[] = prefixSlot === null ? [] : [prefixSlot.slot];
    const dinnerMode: PickMode = {
      ...constraints.mode,
      visitedPlaceIds: [prefixPlace.id, candidate.id],
      occupiedMealSlots: occupiedSlots,
      usedCategories: anchorUsedCategories.slice(),
      usedDiningCount: anchorUsedDiningCount,
    };
    // 「再来一条」：只带 seed、priorDistances 留空 —— 保持日落路径原来「不算拐点」的行为，
    // 不给锚点设计内例外再叠一层拐点惩罚；excludePlaceIds 兜底排除本会话出现过的站点。
    const dinnerResult = await pickNext(
      candidate,
      sunsetStop.leaveAt,
      dinnerPool.pool,
      constraints.budget - prefixCost - candidateCost.cost,
      dinnerMode,
      constraints.cityCode,
      undefined,
      { origin: originPoint, priorDistances: [], seed: constraints.seed, excludePlaceIds: constraints.excludePlaceIds },
      profile,
    );
    if (dinnerResult.ok === false) continue;
    const dinnerPlace = placeById.get(dinnerResult.stop.placeId);
    if (dinnerPlace === undefined) continue;
    if (isSameAreaDuplicate(dinnerPlace, [prefixPlace, candidate])) continue;
    // 晚餐是第 3 站：不能落回前两站的 800m 内（跨站绕回）。
    if (isNonAdjacentLoopback(dinnerPlace, [prefixPlace, candidate])) continue;
    const dinnerSlot = mealSlotFor(dinnerResult.stop.arriveAt, dinnerResult.stop.stayMin);
    if (dinnerSlot === null || occupiedSlots.indexOf(dinnerSlot.slot) !== -1) continue;

    // M20：晚餐站同样计入类目 / 吃喝次数（收尾站不能再用这些类目）。
    const dinnerUsedCategories: PlaceCategory[] = [...anchorUsedCategories, dinnerPlace.category];
    const dinnerUsedDiningCount = anchorUsedDiningCount + (isDiningCategory(dinnerPlace.category) ? 1 : 0);

    const baseStops: Stop[] = [prefixStop, sunsetStop, dinnerResult.stop];
    const baseSegments: Segment[] = [prefixResult.segment, candidateAtAnchor.segment, dinnerResult.segment];
    const dinnerEnd = dinnerResult.stop.leaveAt;
    if (dinnerEnd - startAt > constraints.maxTotalMin) continue;

    // 4) 收尾站：只有「日落锚点场景」允许第 4 站（普通场景由 targetStops 决定，不由这里加站）。
    //    环线形状：收尾站是第 4 站，以晚餐站为「上一站」套 ×0.9 / ×0.75 距离过滤；
    //    两档都空就不加收尾站（保留 3 站版本），不影响锚点和用餐约束。
    //    M18：画像站数上限比锚点场景的 4 还小（rich 3）时不加收尾站。
    let finalStops: Stop[] = baseStops;
    let finalSegments: Segment[] = baseSegments;
    let finalEnd = dinnerEnd;
    if (baseStops.length < Math.min(MAX_ANCHOR_STOPS, profileMaxStops(profile))) {
      const closingMode: PickMode = {
        ...constraints.mode,
        visitedPlaceIds: [prefixPlace.id, candidate.id, dinnerPlace.id],
        occupiedMealSlots: [...occupiedSlots, dinnerSlot.slot],
        // M20：收尾站是这条日落行程的第 4 站，必须沿用前缀 / 锚点 / 晚餐的类目状态。
        usedCategories: dinnerUsedCategories.slice(),
        usedDiningCount: dinnerUsedDiningCount,
      };
      const closingPool = filterByRouteDistance(
        constraints.pool.filter(
          (place) =>
            profileAllowsPlace(place, profile) &&
            !historyExcludedPlaceIds.has(place.id) &&
            !isSameAreaDuplicate(place, [prefixPlace, candidate, dinnerPlace]) &&
            !isNonAdjacentLoopback(place, [prefixPlace, candidate, dinnerPlace]),
        ),
        originPoint,
        haversineMeters(origin, dinnerPlace),
      );
      const closingResult =
        closingPool === null
          ? null
          : await pickNext(
              dinnerPlace,
              dinnerEnd,
              closingPool.pool,
              constraints.budget - prefixCost - candidateCost.cost - dinnerResult.stop.costEstimate,
              closingMode,
              constraints.cityCode,
              undefined,
              { origin: originPoint, priorDistances: [], seed: constraints.seed, excludePlaceIds: constraints.excludePlaceIds },
              profile,
            );
      if (closingResult !== null && closingResult.ok === true) {
        const closingEnd = closingResult.stop.leaveAt;
        if (closingEnd - startAt <= constraints.maxTotalMin) {
          const candidateStops = [...baseStops, closingResult.stop];
          const candidateSegments = [...baseSegments, closingResult.segment];
          try {
            assertItineraryClosed(
              ItinerarySchema.parse({
                startAt,
                endAt: closingEnd,
                totalMin: closingEnd - startAt,
                totalCost: candidateStops.reduce((sum, stop) => sum + stop.costEstimate, 0),
                stops: candidateStops,
                segments: candidateSegments,
              }),
              origin.id,
              constraints.budget,
            );
            assertRestaurantSlots(candidateStops, placeById);
            finalStops = candidateStops;
            finalSegments = candidateSegments;
            finalEnd = closingEnd;
          } catch {
            // 收尾站不合法就保留 3 站版本。
          }
        }
      }
    }

    // 最后一道保险：任意两站不能同类目且直线 <800m（跨类目不算重复）；
    // 且第 3 站及以后不能落回前序任一站的 800m 内（第 1、2 站相邻不限制）。
    const finalPlaces = finalStops
      .map((stop) => placeById.get(stop.placeId))
      .filter((place): place is Place => place !== undefined);
    let hasInvalidOverlap = false;
    for (let left = 0; left < finalPlaces.length; left += 1) {
      for (let right = left + 1; right < finalPlaces.length; right += 1) {
        const distance = haversineMeters(finalPlaces[left], finalPlaces[right]);
        if (
          finalPlaces[left].category === finalPlaces[right].category &&
          distance < SAME_CATEGORY_DUPLICATE_DISTANCE_M
        ) {
          hasInvalidOverlap = true;
        }
        // right 是第 3 站及以后（0-based >=2）时，left 都是前序站。
        if (right >= 2 && distance < NON_ADJACENT_LOOPBACK_DISTANCE_M) {
          hasInvalidOverlap = true;
        }
      }
    }
    if (hasInvalidOverlap) continue;

    // 整体校验：闭合 / 预算 / 用餐时段；任何一条不过就换下一个候选。
    try {
      assertItineraryClosed(
        ItinerarySchema.parse({
          startAt,
          endAt: finalEnd,
          totalMin: finalEnd - startAt,
          totalCost: finalStops.reduce((sum, stop) => sum + stop.costEstimate, 0),
          stops: finalStops,
          segments: finalSegments,
        }),
        origin.id,
        constraints.budget,
      );
      assertRestaurantSlots(finalStops, placeById);
    } catch {
      continue;
    }

    return { stops: finalStops, segments: finalSegments, endAt: finalEnd, stopReason: null, mealFailure: null };
  }
  return null;
}

/**
 * 一轮完整排程的中间结果（**不含返程段**）：站点 + 站间段 + 最后一站离开时刻。
 * 返程由 buildItinerary 统一追加，这样地图 / 换站都只依赖「末站 → 终点」这一段。
 */
type PlannedStops = {
  stops: Stop[];
  segments: Segment[];
  endAt: number;
};

/** homeBy 倒排时最多重排几次（真实返程比直线估算长时，按超出量收紧预算再排）。 */
const MAX_HOMEBY_REPLAN = 3;

/** 「几点到家」排不下时的统一原因（验收口径：离 X 点只剩 Y 分钟，不够走一趟）。 */
function homeByFailureReason(homeBy: number, remainingMin: number): string {
  return `离 ${formatClockText(homeBy)} 只剩 ${Math.max(0, remainingMin)} 分钟，不够走一趟`;
}

/** 行程端点快照（Itinerary 的可选字段）：起点 / 终点都不是 POI，不进候选池，只随行程下发坐标。 */
function endpointSnapshot(place: Place): { placeId: string; name: string; lng: number; lat: number } {
  return { placeId: place.id, name: place.name, lng: place.lng, lat: place.lat };
}

/**
 * M18：一次排站尝试的结果 +「正餐是不是没排进去」的标记（只有 rich 的兜底包装层用）。
 * 标记为 true 说明「行程覆盖正餐时段却没有餐厅」被兜底成了「收在正餐前」或直接失败；
 * 对 rich 来说这通常意味着「餐厅人均≥60」下限把可选餐厅排除了，需要放宽重排一次。
 */
type PlanStopsAttemptResult = {
  result: PlannedStops | ItineraryFailure;
  restaurantFloorBlocked: boolean;
};

/**
 * 排「站点 + 站间段」（不含返程段）——单次尝试。
 *
 * 从 buildItinerary 抽出来的原因：homeBy 倒排时长时，要用不同的 maxTotalMin 重排几次
 * （先用直线估算，拿到真实返程时长后再按超出量收紧预算）。除 maxTotalMin 外，其余判定
 * 与改造前逐字一致——日落锚点前置、普通排程、用餐硬约束兜底重排、每站快照全部照旧。
 *
 * M18：profile 只影响 planRounds / tryPlanSunsetReserved 的选点，本函数的排程流程不变。
 */
async function planStopsAttempt(
  origin: Place,
  startAt: number,
  constraints: ParsedConstraints,
  placeById: Map<string, Place>,
  sunset: SunsetAnchor,
  /** M18（可选）：画像调参表；不传 = 与改造前逐字一致。 */
  profile?: ProfileTuning,
): Promise<PlanStopsAttemptResult> {
  const initialVisited =
    constraints.mode.visitedPlaceIds === undefined ? [] : constraints.mode.visitedPlaceIds.slice();
  /** M18：正餐没排进去（rich 兜底重排的触发标记）；普通排程恒为 false。 */
  let restaurantFloorBlocked = false;

  // 任务1：用餐兜底重排的候选轮次上限与 planRounds 同一口径（按可用时长折算的 targetStops）。
  // M18：再叠加画像站数上限（rich 3），兜底重排也不能超。
  const targetStops = Math.min(profileMaxStops(profile), targetStopsForBudget(constraints.maxTotalMin));

  // 日落锚点前置：先占位（户外日落点放到第 2 站、按本次的锚定到达目标到站），再围绕它排前缀和晚餐；
  // 凑不出合法行程就回退普通排程（15:20 这类出发时间不进入前置逻辑，行程保持不变）。
  const reservedSunset = await tryPlanSunsetReserved(origin, startAt, constraints, placeById, sunset, profile);
  let rounds: RoundsPlan;
  if (reservedSunset !== null) {
    rounds = reservedSunset;
  } else {
    rounds = await planRounds({
      origin,
      startAt,
      constraints,
      visitedPlaceIds: initialVisited,
      forcedMeal: null,
      mealAuto: true,
      profile,
    });
  }

  // 「再来一条」：历史站点排除到候选池为空 → 整份行程如实失败，不返回「少站版」假装换了一条。
  // （任务书兜底：排除后候选池为空必须返回指定人话，不许静默忽略 exclude。）
  if (rounds.stopReason === EXCLUDE_EXHAUSTED_REASON) {
    return { result: failure(EXCLUDE_EXHAUSTED_REASON), restaurantFloorBlocked: false };
  }

  // 第一站都排不出来 → 返回原因（已指名卡在哪条约束）。
  // M4.5 3.3：如果卡在「这一轮必须选餐厅」上，reason 要说清是哪一餐、最便宜多少钱、超预算多少。
  if (rounds.stops.length === 0) {
    // 本轮新增：0 站失败先判「位置」——候选池空 / 最近候选 >15km 用位置文案，
    // 只有 pool 非空且最近候选 ≤15km（时间真的不够）才继续走下面的时间文案。
    const emptyStartReason = buildEmptyStartFailureReason(constraints.pool, origin);
    if (emptyStartReason !== null) {
      return { result: failure(emptyStartReason), restaurantFloorBlocked: false };
    }
    if (rounds.mealFailure !== null) {
      return {
        result: failure(buildMealFailureReason(rounds.mealFailure, [], constraints)),
        restaurantFloorBlocked: true,
      };
    }
    return {
      result: failure(rounds.stopReason === null ? "没有可选的下一站：候选池里没有可用地点" : rounds.stopReason),
      restaurantFloorBlocked: false,
    };
  }

  // 用餐硬约束：行程覆盖正餐时段就必须有一站 restaurant。
  // M4.5 3.3 起，正常情况下选站时已经提前过滤成餐厅；这里只剩极端情况下的兜底重排。
  // 开屏第 5 题选「不用了」时（wantsMeal=false）整段跳过：不安排吃饭就没有「必须有餐厅」这条约束。
  const coveredWindows = wantsMeal(profile) ? coveredMealWindows(startAt, rounds.endAt) : [];
  if (coveredWindows.length > 0 && !hasRestaurant(rounds.stops, placeById)) {
    let repaired: RoundsPlan | null = null;
    let mealFailure = rounds.mealFailure;
    for (const candidate of suggestMealRounds(rounds.stops, coveredWindows, targetStops)) {
      const attempt = await planRounds({
        origin,
        startAt,
        constraints,
        visitedPlaceIds: initialVisited,
        forcedMeal: { round: candidate.round, slot: candidate.window.slot },
        mealAuto: false,
        profile,
      });
      if (attempt.mealFailure !== null) mealFailure = attempt.mealFailure;
      if (attempt.stops.length > 0 && hasRestaurant(attempt.stops, placeById)) {
        repaired = attempt;
        break;
      }
    }
    if (repaired === null) {
      // 兜底重排 2（M5 收尾修复）：餐厅实在塞不进正餐时段时，宁可把行程收在正餐时段之前，
      // 也不要返回一份「覆盖午餐 / 晚餐却没有对应餐厅」的行程。
      // 只有出发时还在这顿饭开始之前才可能「提前收尾」；13:00 / 19:00 这种出发时已经
      // 在正餐时段里的情况躲不开覆盖，只能如实返回排不出来（不违反约束）。
      const earliestWindow = coveredWindows[0];
      const trimLimit = earliestWindow.start - startAt;
      if (trimLimit >= 1) {
        const trimmed = await planRounds({
          origin,
          startAt,
          constraints: { ...constraints, maxTotalMin: Math.min(constraints.maxTotalMin, trimLimit) },
          visitedPlaceIds: initialVisited,
          forcedMeal: null,
          mealAuto: false,
          profile,
        });
        // 复核：收尾后的行程必须真的不覆盖任何正餐时段，才允许采用。
        if (trimmed.stops.length > 0 && coveredMealWindows(startAt, trimmed.endAt).length === 0) {
          repaired = trimmed;
          // M18：这是「宁可收在正餐前」的兜底 → 正餐没排进去，rich 包装层据此决定是否放宽餐厅下限重排。
          restaurantFloorBlocked = true;
        }
      }
    }
    if (repaired === null) {
      // 兜底重排的失败原因用「实际覆盖的正餐时段」，而不是强制轮里的占位时段。
      const reasonFailure =
        mealFailure === null ? null : { reason: mealFailure.reason, budgetLeft: mealFailure.budgetLeft, windows: coveredWindows };
      return {
        result: failure(buildMealFailureReason(reasonFailure, coveredWindows, constraints)),
        restaurantFloorBlocked: true,
      };
    }
    rounds = repaired;
  }

  // M5 收尾修复的回归断言：全天最多 2 家餐厅，且必须分别落在午餐 / 晚餐时段。
  assertRestaurantSlots(rounds.stops, placeById);

  // M9：只给餐厅站挂 meal（其余站点不挂，卡片因此不会渲染成餐厅卡）。
  // 城市数据模块化：每站统一补地点快照（placeName / lng / lat / placeCloseTime），
  // 页面 / 地图只依赖这些字段渲染，不再静态 import 地点数据；地点必须来自候选池，缺失直接抛错。
  const weekdayLabel = weekdayLabelOf(new Date());
  const stopsWithMeal: Stop[] = rounds.stops.map((stop) => {
    const place = placeById.get(stop.placeId);
    if (place === undefined) {
      throw new Error(`行程里出现候选池外的 placeId=${stop.placeId}`);
    }
    const withSnapshot: Stop = {
      ...stop,
      placeName: place.name,
      lng: place.lng,
      lat: place.lat,
      placeCloseTime: place.closeTime,
    };
    if (place.category !== "restaurant") return withSnapshot;
    return { ...withSnapshot, meal: buildMealInfo(place, stop.arriveAt, constraints.people, weekdayLabel) };
  });

  return {
    result: { stops: stopsWithMeal, segments: rounds.segments, endAt: rounds.endAt },
    restaurantFloorBlocked,
  };
}

/**
 * M18 rich 专用兜底：默认执行「餐厅 avgCost≥60（null 保留）」硬下限；
 * **只有**当这条下限导致正餐排不进去（晚餐 / 午餐轮没有合规餐厅）时，
 * 才用「不限下限的餐厅池」重排一次；兜底结果必须通过全部既有断言、且确实把正餐排上了才采用，
 * 并在 console 留一条 `[planner] rich 餐厅下限兜底：…` 方便排查。
 *
 * 其它 style / 无 profile / 已经放宽过（restaurantFloorDisabled）时直接返回第一次的结果，
 * 行为与改造前逐字一致。放宽只影响「哪些餐厅能进候选池」，闭合 / 预算 / 营业时间 /
 * 用餐时段 / 半径 / 距离单调 / 画像其它约束全部照旧。
 */
async function planStops(
  origin: Place,
  startAt: number,
  constraints: ParsedConstraints,
  placeById: Map<string, Place>,
  sunset: SunsetAnchor,
  profile?: ProfileTuning,
): Promise<PlannedStops | ItineraryFailure> {
  const attempt = await planStopsAttempt(origin, startAt, constraints, placeById, sunset, profile);
  if (
    profile === undefined ||
    profile.style !== "rich" ||
    profile.restaurantFloorDisabled === true ||
    !attempt.restaurantFloorBlocked
  ) {
    return attempt.result;
  }

  const relaxedProfile: ProfileTuning = { ...profile, restaurantFloorDisabled: true };
  const relaxed = await planStopsAttempt(origin, startAt, constraints, placeById, sunset, relaxedProfile);
  if ("ok" in relaxed.result) {
    console.warn(
      `[planner] rich 餐厅下限兜底：放宽「餐厅人均≥60」后仍未排出正餐（${relaxed.result.reason}），保留原结果`,
    );
    return attempt.result;
  }
  const normalStopCount = "ok" in attempt.result ? 0 : attempt.result.stops.length;
  if (relaxed.result.stops.length < normalStopCount) {
    console.warn(
      `[planner] rich 餐厅下限兜底：放宽后反而更少（${relaxed.result.stops.length} < ${normalStopCount} 站），保留原结果`,
    );
    return attempt.result;
  }
  if (!hasRestaurant(relaxed.result.stops, placeById)) {
    console.warn("[planner] rich 餐厅下限兜底：放宽后仍未排上餐厅，保留原结果");
    return attempt.result;
  }
  const stopNames = relaxed.result.stops
    .map((stop) => placeById.get(stop.placeId)?.name ?? stop.placeId)
    .join("、");
  console.warn(
    `[planner] rich 餐厅下限兜底：按「餐厅人均≥60」正餐排不进去，放宽下限后采用 ${relaxed.result.stops.length} 站行程（${stopNames}）`,
  );
  return relaxed.result;
}

/** 末站补时上限（分钟）：沿用 M20 的 30。 */
const POST_FILL_MAX_STAY_EXTEND = 30;
/** 更早站点补时上限（分钟）：整站停留最多加 45，避免把一站拖成半天。 */
const POST_FILL_CASCADE_STAY_EXTEND = 45;
/** 「到家时刻」和 homeBy 的差值大于这个数时才值得补时（≤30 已经算贴近了）。 */
const POST_FILL_MAX_GAP_MIN = 30;

/**
 * M21 补时（任务1 的收尾，替代 M20 的 extendLastStopForHomeBy）：
 *
 * 补站轮停下来后常常还剩零头，但**真实数据里可能根本不存在**「停留 + 真实通勤 + 真实返程」
 * 装得下的下一站（本轮实测：15:20 / homeBy 20:00、21:00 两组，穷举全部北京 POI 都没有
 * 合法的第 4/5 站——最近的可补点都在 1km 外、真实返程 37–47 分钟，塞进去必然过 homeBy）。
 * 这时不该硬塞一站（会违反 homeBy / 营业时间），也不该就这么少 58/66 分钟；
 * 正确做法是**把已经排好的站多待一会儿**：
 *   1. 先补末站（餐厅也可以：正餐时段内多坐一会儿不违反任何硬约束，但停留不跨出该正餐时段）；
 *   2. 还不够就把前一站也补一点，后面各站整段平移；
 *   3. 每次补时都重新校验：营业时间 / 餐厅正餐时段 / 未安排餐厅的正餐时段不被跨进 /
 *      不超过 homeBy 与本轮可用时长；会平移日落锚点站的补时一律不做。
 *
 * 本函数只让 endAt 变大（更接近 homeBy），不会新增 / 删除 / 替换任何地点。
 * 不传 homeBy / 已经 ≤30 分钟差 / 补不动 → 原样返回（不限时场景逐字一致）。
 */
function fillHomeByGap(
  planned: PlannedStops,
  placeById: Map<string, Place>,
  options: {
    /** 本次排程的出发时刻（覆盖正餐时段判定要用）。 */
    startAt: number;
    homeBy: number;
    returnMin: number;
    /** 本轮可用时长的最晚离开时刻（startAt + attemptBudget）。 */
    latestLeaveCap?: number;
    /** 日落锚点的锚定到达时刻：任何会平移锚点站的补时都不做（保持「日落锚点前置」不变）。 */
    anchorArriveAt?: number;
    /**
     * 这次排程要不要安排吃饭（默认 true）。false = 不守「未安排餐厅的正餐时段不能跨进」这条边界
     * （开屏第 5 题选「不用了」时，补时可以正常跨过 17:30 等时段）。
     */
    mealIncluded?: boolean;
  },
): PlannedStops {
  if (planned.stops.length === 0) return planned;
  const lastIndex = planned.stops.length - 1;
  if (options.homeBy - (planned.endAt + options.returnMin) <= POST_FILL_MAX_GAP_MIN) return planned;

  let stops = planned.stops.slice();
  const mealIncluded = options.mealIncluded !== false;

  /**
   * 还没安排餐厅的正餐时段：final endAt 不能跨进它的开始（coveredMealWindows 口径：endAt > start 就算覆盖）。
   * 这是旧 extendLastStopForHomeBy 就有的硬边界，补时（含前序站级联平移）必须继续守。
   * 开屏第 5 题选「不用了」（mealIncluded=false）时不存在用餐约束，这段直接跳过。
   */
  let latestAllowedEndAt = options.homeBy;
  if (mealIncluded) {
    for (const window of MEAL_WINDOWS) {
      const coveredByRestaurant = planned.stops.some((stop) => {
        const place = placeById.get(stop.placeId);
        return (
          place !== undefined &&
          place.category === "restaurant" &&
          stop.arriveAt < window.end &&
          stop.arriveAt + stop.stayMin > window.start
        );
      });
      if (coveredByRestaurant) continue;
      if (planned.endAt + options.returnMin < window.start && latestAllowedEndAt > window.start) {
        latestAllowedEndAt = window.start;
      }
    }
  }
  const latestLeaveForMeal = latestAllowedEndAt - options.returnMin;

  /** 补时后必须成立：营业时间 / （安排吃饭时）餐厅停留仍落在某个正餐时段、不跨进没安排餐厅的正餐时段。 */
  const isValidAfterShift = (candidate: Stop[]): boolean => {
    for (const stop of candidate) {
      const place = placeById.get(stop.placeId);
      if (place === undefined) return false;
      if (!isOpenAt(place, stop.arriveAt, stop.stayMin)) return false;
      if (mealIncluded && place.category === "restaurant" && mealSlotFor(stop.arriveAt, stop.stayMin) === null) {
        return false;
      }
    }
    if (!mealIncluded) return true;
    const newEndAt = candidate[candidate.length - 1].leaveAt + options.returnMin;
    const windows = coveredMealWindows(options.startAt, newEndAt);
    if (windows.length > 0 && !hasRestaurant(candidate, placeById)) return false;
    return true;
  };
  /** 会平移日落锚点站的补时一律不做（锚定到达目标必须原样保持）。 */
  const shiftsSunsetAnchor = (fromIndex: number): boolean => {
    if (options.anchorArriveAt === undefined) return false;
    for (let index = fromIndex; index < stops.length; index += 1) {
      const stop = stops[index];
      const place = placeById.get(stop.placeId);
      if (place !== undefined && isSunsetPlace(place) && stop.arriveAt === options.anchorArriveAt) return true;
    }
    return false;
  };
  /** 某站的停留最多还能加多少分钟：餐厅不跨出它现在占用的正餐时段；总时长不越过本轮可用时长。 */
  const stayExtendRoom = (index: number, cap: number): number => {
    const stop = stops[index];
    const place = placeById.get(stop.placeId);
    if (place === undefined) return 0;
    let room = cap;
    if (place.category === "restaurant") {
      const window = mealSlotFor(stop.arriveAt, stop.stayMin);
      if (window === null) return 0;
      // 餐厅补时不超过末站同口径的 30 分钟（只是在正餐时段内多坐一会儿，不把它拖成两小时）。
      room = Math.min(room, POST_FILL_MAX_STAY_EXTEND, window.end - stop.leaveAt);
    }
    if (options.latestLeaveCap !== undefined) {
      room = Math.min(room, options.latestLeaveCap - stops[lastIndex].leaveAt);
    }
    room = Math.min(room, latestLeaveForMeal - stops[lastIndex].leaveAt);
    return Math.max(0, room);
  };
  const applyExtend = (index: number, delta: number): boolean => {
    if (delta <= 0) return false;
    const candidate: Stop[] = stops.map((stop, position) => {
      if (position < index) return stop;
      if (position === index) {
        return StopSchema.parse({ ...stop, stayMin: stop.stayMin + delta, leaveAt: stop.leaveAt + delta });
      }
      return StopSchema.parse({ ...stop, arriveAt: stop.arriveAt + delta, leaveAt: stop.leaveAt + delta });
    });
    if (!isValidAfterShift(candidate)) return false;
    stops = candidate;
    return true;
  };

  // 1) 末站补时：最多 30 分钟，且不能越过 homeBy − 返程 / 本轮可用时长 / 正餐时段。
  const lastRoom = Math.min(
    stayExtendRoom(lastIndex, POST_FILL_MAX_STAY_EXTEND),
    Math.max(0, options.homeBy - options.returnMin - stops[lastIndex].leaveAt),
  );
  applyExtend(lastIndex, lastRoom);
  if (options.homeBy - (stops[lastIndex].leaveAt + options.returnMin) <= POST_FILL_MAX_GAP_MIN) {
    return { ...planned, stops, endAt: stops[lastIndex].leaveAt };
  }

  // 2) 还不够：从倒数第二站开始往前补（后面各站整段平移），每站最多 45 分钟。
  for (let index = lastIndex - 1; index >= 0; index -= 1) {
    const gap = options.homeBy - (stops[lastIndex].leaveAt + options.returnMin);
    if (gap <= POST_FILL_MAX_GAP_MIN) break;
    if (shiftsSunsetAnchor(index)) continue;
    const room = stayExtendRoom(index, Math.min(gap, POST_FILL_CASCADE_STAY_EXTEND));
    applyExtend(index, room);
  }
  return { ...planned, stops, endAt: stops[lastIndex].leaveAt };
}

/**
 * 把「站点 + 返程」拼成最终 Itinerary：补端点快照、算 endAt / totalMin（含返程）、跑闭合断言。
 *
 * 返程段固定追加在 segments 末尾：fromId = 最后一站，toId = 终点
 * （默认回到起点时就是 "origin"，自定义终点是 "destination"）。
 */
function finishItinerary(
  origin: Place,
  destination: Place,
  startAt: number,
  planned: PlannedStops,
  returnCommute: Commute,
  constraints: ParsedConstraints,
): Itinerary {
  const lastStop = planned.stops[planned.stops.length - 1];
  const returnSegment: Segment = segmentOf(lastStop.placeId, destination.id, returnCommute);
  const endAt = planned.endAt + returnSegment.durationMin;
  const totalCost = planned.stops.reduce((sum, stop) => sum + stop.costEstimate, 0);
  const itinerary: Itinerary = ItinerarySchema.parse({
    startAt,
    endAt,
    totalMin: endAt - startAt,
    totalCost,
    stops: planned.stops,
    segments: [...planned.segments, returnSegment],
    origin: endpointSnapshot(origin),
    destination: endpointSnapshot(destination),
  });

  // M4 3.4：totalCost / totalMin / 预算 / 首尾相接（含返程段）都断言，不通过抛错（不静默修正）。
  assertItineraryClosed(itinerary, origin.id, constraints.budget);
  return itinerary;
}

/** 夜间兜底：把排好的站点从末尾裁掉一站（planned 不含返程段，段数组同步去尾）。 */
function trimLastStop(planned: PlannedStops): PlannedStops {
  const stops = planned.stops.slice(0, -1);
  const segments = planned.segments.slice(0, -1);
  return {
    stops,
    segments,
    endAt: stops.length === 0 ? planned.endAt : stops[stops.length - 1].leaveAt,
  };
}

/**
 * M4 3.1 主函数：起点 + 出发时刻 + constraints → 闭合的 Itinerary，或 { ok:false, reason }。
 *
 * 本轮新增【返程】：排完最后一站后追加「最后一站 → 终点（默认 = 起点）」一段，
 * endAt 改成回到终点的时刻、totalMin 含返程，所以 segments.length = stops.length + 1。
 * 自定义终点由 constraints.destination 指定（id 固定 "destination"），不影响选点。
 *
 * 本轮新增【homeBy】：几点到家（可选）。先按「起点 → 终点」的直线估算返程得到可用时长，
 * 用 min(默认上限, 可用时长) 当本次 maxTotalMin 排站；拿到真实返程路线后如果仍然超时，
 * 按超出量收紧预算再排（最多 MAX_HOMEBY_REPLAN 次）。排不满如实返回少几站；
 * 一次都排不出来返回「离 X 点只剩 Y 分钟，不够走一趟」。不传 homeBy = 不限制（向后兼容）。
 *
 * 任务1【站数动态化 3–6 / 想走多久】：先把「自动 / durationMin / wholeDay」换算成**站点时间预算**
 * （= 可用时长，不含返程）：自动 min(maxTotalMin, lastEnd-start)−返程估算、指定
 * min(durationMin, lastEnd-start)−返程估算、一整天 lastEnd-start−返程估算；它作为 maxTotalMin
 * 传给 planStops/planRounds，由 targetStopsForBudget 折算成 1–6 站。homeBy 再与它取 min。
 *
 * M18【出行画像】（第 4 个参数，可选）：
 *   - style=rich：餐厅人均 <60 排除、importance/评分优先 ×1.25、rating 权重 0.45、
 *     允许打车（规划用的 mode 副本 timeFirst=true）、站数 ≤3、非餐厅站停留 90 分钟；
 *   - style=powerful：餐厅人均 >60 排除、全候选 rating≥3.5 或 importance≥2、评分优先 ×1.25、
 *     rating 权重 0.2、步行半径 30→50 分钟；
 *   - scene=scenery/culture：风光 / 人文类地点 ×1.5；
 *   - 所有加权同时乘到 scoreUpperBound（剪枝安全），所有过滤都在打分与随机之前生效。
 * 不传 profile = 与改造前逐字一致（既有 check-loopshape / try-itinerary 基线依赖这一点）。
 */
export async function buildItinerary(
  originInput: Place,
  startAt: number,
  constraintsInput: ItineraryConstraints,
  /** M18（可选）：出行画像（开屏问答结果）。不传 = 旧行为逐字一致。 */
  profileInput?: TravelProfile,
): Promise<Itinerary | ItineraryFailure> {
  const origin = PlaceSchema.parse(originInput);
  const constraints = ItineraryConstraintsSchema.parse(constraintsInput);
  // M18：画像 → 内部调参表（undefined = 没有画像，后续全部走原值分支）。
  const profile = buildProfileTuning(profileInput);
  // M21（任务2）：rich 的默认预算 200 → 400（花钱买时间：打车 + 吃好点）。
  // 只对 rich 生效；无 profile / powerful 的预算一个数字都不动（验收 3 依赖这一点）。
  if (profile !== undefined && profile.style === "rich") {
    constraints.budget = Math.max(constraints.budget, RICH_DEFAULT_BUDGET);
  }
  // 任务1：durationMin 与 wholeDay 互斥——/api/plan 已经返回 400；这里防御直调方传错（不静默二选一）。
  if (constraints.durationMin !== undefined && constraints.wholeDay === true) {
    throw new Error("durationMin 与 wholeDay 不能同时传：一个是「想走多久」，一个是「一整天」");
  }
  // 数据分层：hidden===true 的点只出现在管理后台，永远不进行程候选池。
  // 过滤放在 zod 解析之后：pool 的 min(1) 校验的是调用方传进来的池，
  // 全部被隐藏时会得到空池，planStops 按「候选池是空的」返回失败（不抛错、不兜底）。
  constraints.pool = constraints.pool.filter((place) => place.hidden !== true);
  /**
   * 开屏第 5 题「这一趟要安排吃饭吗？」= 不用了：
   * 候选池直接剔除 restaurant（cafe 保留 = 歇脚），后面的用餐硬约束（正餐强制 / 跨两餐 /
   * 用餐兜底重排 / 日落晚餐 / 用餐安全阀）全部跳过（见下方 wantsMeal 门控）。
   * profile 未设置或 mealIncluded === true 时这里一个字节都不动（验收 4：行为与改造前逐字一致）。
   */
  if (profile !== undefined && !wantsMeal(profile)) {
    constraints.pool = constraints.pool.filter((place) => place.category !== "restaurant");
  }
  if (!Number.isInteger(startAt) || startAt < 0 || startAt >= MINUTES_PER_DAY) {
    throw new Error(`startAt 必须是 0–1439 的整数分钟，收到：${String(startAt)}`);
  }
  // 本次调用的日落参数：不传 = 默认 1062（17:42）；下面所有日落锚点判定都用这两个值。
  const sunset = resolveSunsetAnchor(constraints.sunsetMinute);
  const placeById = new Map<string, Place>(constraints.pool.map((place) => [place.id, place]));
  // 返程终点：没传就是起点（默认「回到起点」）。
  const destination = constraints.destination === undefined ? origin : PlaceSchema.parse(constraints.destination);

  // M18：rich 允许打车——只把「规划用的 mode」换成 timeFirst=true 的副本交给选点 / 返程判定，
  // constraintsInput / 用户偏好本身一个字节都不改；不传 profile 时直接用原 constraints。
  const planningConstraints: ParsedConstraints =
    profile === undefined
      ? constraints
      : { ...constraints, mode: planningPickMode(constraints.mode, profile) };

  // 任务1：把「想走多久」换算成**站点时间预算**（= 可用时长，不含返程），planRounds 再据此算 targetStops。
  // 返程估算 returnEstimate：默认回起点时直线估算恒 0（origin→origin），所以固定用 AVG_COMMUTE_MIN；
  // 自定义终点时用 origin→destination 的直线步行估算，至少 AVG_COMMUTE_MIN。
  const returnEstimateMin =
    constraints.destination === undefined
      ? AVG_COMMUTE_MIN
      : Math.max(AVG_COMMUTE_MIN, Math.ceil(estimateWalkMinutes(origin, destination)));
  const dayRemainMin = constraints.lastEndMinute - startAt;
  const requestedBudgetMin =
    constraints.wholeDay === true
      ? dayRemainMin
      : constraints.durationMin !== undefined
        ? Math.min(constraints.durationMin, dayRemainMin)
        : Math.min(constraints.maxTotalMin, dayRemainMin);
  const availableMin = Math.max(1, requestedBudgetMin - returnEstimateMin);

  // homeBy 倒排：最终站点预算 = min(上面算出的可用时长, homeBy − 现在 − 直线返程估算)。
  // （直线返程默认回起点是 0；拿到真实返程路线后如果仍然超时，下面的重排循环再收紧。）
  const homeBy = constraints.homeBy;
  const straightReturnMin = Math.ceil(estimateWalkMinutes(origin, destination));
  let attemptBudget = availableMin;
  if (homeBy !== undefined) {
    if (homeBy <= startAt) return failure(homeByFailureReason(homeBy, 0));
    const available = homeBy - startAt - straightReturnMin;
    // 失败文案里的 Y 用「离 X 点还剩多少分钟」（homeBy − now），不扣返程估算：
    // 文案口径是「现在到 X 点只剩 Y 分钟」，验收用例 16:00 / 15:20 → 40 分钟。
    if (available < 1) return failure(homeByFailureReason(homeBy, homeBy - startAt));
    attemptBudget = Math.min(attemptBudget, available);
  }

  for (let attempt = 0; attempt < MAX_HOMEBY_REPLAN; attempt += 1) {
    // 任务5：每次 attempt 按当前可用时长重算停留下限（homeBy 收紧预算后也要用新值）。
    const minStayMin = minStayForBudget(attemptBudget);
    const planned = await planStops(
      origin,
      startAt,
      { ...planningConstraints, maxTotalMin: attemptBudget, minStayMin },
      placeById,
      sunset,
      profile,
    );
    if ("ok" in planned) {
      // 时间预算卡住（候选都超过 maxTotalMin）时用 homeBy 口径的原因说清差多少；
      // 预算 / 营业时间等其它原因原样返回，不拿时间原因掩盖真实卡点。
      // 任务5：短窗口通用守卫触发的 LATE_NIGHT 也是「时间不够」的一种，homeBy 场景仍用
      // 「离 X 点只剩 Y 分钟，不够走一趟」的旧文案（保持 M5 验收用例 16:00 / 15:20 → 40 分钟不变）。
      if (
        homeBy !== undefined &&
        (planned.reason.indexOf("总时长上限") !== -1 || planned.reason === LATE_NIGHT_FAILURE_REASON)
      ) {
        return failure(homeByFailureReason(homeBy, homeBy - startAt));
      }
      return planned;
    }

    // 返程用真实路线（与站间段同一套交通规则）；算不出来就如实返回，不拿直线估算糊弄。
    // 夜间修复：候选择站时已按「到达 + 停留 + 返程」预判过当天上限，这里再按**真实返程**兜底一次；
    // 白天 endAt 远小于上限、下面的循环一次都不进，行为与改造前逐字一致。
    let plannedForFinish = planned;
    let returnCommute: Commute | null = null;
    let endAt = plannedForFinish.endAt;
    for (;;) {
      const lastStop = plannedForFinish.stops[plannedForFinish.stops.length - 1];
      const lastPlace = placeById.get(lastStop.placeId);
      if (lastPlace === undefined) {
        throw new Error(`行程里出现候选池外的 placeId=${lastStop.placeId}`);
      }
      // M21：powerful 的末站落在远区（>5km）时按「远区 bus 优先 / bike 次之」算返程，
      // 否则会算成 80 分钟步行、让 homeBy 重排把整站裁掉；其它 style / 无 profile 走原规则。
      returnCommute = await decideReturnCommute(
        lastPlace,
        { lng: destination.lng, lat: destination.lat },
        planningConstraints.mode,
        profile,
        planningConstraints.cityCode,
      );
      if (returnCommute === null) {
        return failure(`算不出回到终点的路线：${lastPlace.name} → ${destination.name}`);
      }
      endAt = plannedForFinish.endAt + returnCommute.durationMin;
      /**
       * M21（任务2 用餐安全阀）：profile 路径多一道「被覆盖的正餐时段必须有餐厅」的兜底。
       * 远区站 + 真实返程可能把行程推进用餐时段却没有餐厅；此时从末站开始裁，直到合规或裁空。
       * 只对 powerful 生效：它是「远区 + 长返程 + 多站」最容易踩到这条的组合；
       * rich 的 3 站上限由既有用餐硬约束兜底，保持改造前行为，避免把正常行程误裁。
       * 开屏第 5 题选「不用了」（wantsMeal=false）时没有用餐约束，这段跳过。
       * 无 profile 路径不进入这段（保持改造前行为逐字一致）。
       */
      const mealGapWindows =
        wantsMeal(profile) && profile?.style === "powerful"
          ? uncoveredMealWindows(plannedForFinish.stops, startAt, endAt, placeById)
          : [];
      if (endAt <= constraints.lastEndMinute && mealGapWindows.length === 0) break;
      // 夜间兜底（原有）：真实返程比估算长、越过当天硬上限 → 从末站开始裁掉一站再算。
      // M21 用餐兜底：裁到「覆盖的正餐时段都有餐厅」为止；裁空则如实返回排不出来。
      plannedForFinish = trimLastStop(plannedForFinish);
      if (plannedForFinish.stops.length === 0) {
        if (mealGapWindows.length > 0) {
          return failure(buildMealFailureReason(null, mealGapWindows, constraints));
        }
        return failure(LATE_NIGHT_FAILURE_REASON);
      }
    }
    if (plannedForFinish !== planned) {
      // 裁站后复核用餐硬约束（白天永远不触发）：删掉末站可能把唯一的餐厅删掉。
      // 开屏第 5 题选「不用了」（wantsMeal=false）时没有这条约束，跳过。
      const trimmedWindows = wantsMeal(profile) ? coveredMealWindows(startAt, plannedForFinish.endAt) : [];
      if (trimmedWindows.length > 0 && !hasRestaurant(plannedForFinish.stops, placeById)) {
        return failure(LATE_NIGHT_FAILURE_REASON);
      }
      assertRestaurantSlots(plannedForFinish.stops, placeById);
    }

    if (homeBy === undefined || endAt <= homeBy) {
      // M21 补时（任务1）：补站之后还剩零头 → 把末站 / 前序站的停停留长一点，把到家时刻贴近 homeBy。
      const extended =
        homeBy === undefined
          ? plannedForFinish
          : fillHomeByGap(plannedForFinish, placeById, {
              startAt,
              homeBy,
              returnMin: returnCommute.durationMin,
              // 不能超过本轮可用时长（例如用户同时指定「想走多久」和 homeBy 时，以更紧的那个为准）。
              latestLeaveCap: startAt + attemptBudget,
              // 日落锚点站的时间不许被补时平移。
              anchorArriveAt: sunset.arriveEarliest,
              // 开屏第 5 题选「不用了」时补时可以正常跨过正餐时段（没有用餐约束）。
              mealIncluded: wantsMeal(profile),
            });
      return finishItinerary(origin, destination, startAt, extended, returnCommute, planningConstraints);
    }

    // 真实返程比直线估算长：用「真实返程」重算本轮可用时长（homeBy − 现在 − 返程），再排一次。
    // 注意不能只扣「超出量」：本轮最后一站的离开时刻不一定正好用满预算，只扣超出量会原地打转。
    const nextBudget = homeBy - startAt - returnCommute.durationMin;
    if (nextBudget < 1) break;
    attemptBudget = Math.min(attemptBudget, nextBudget);
  }

  if (homeBy !== undefined) {
    return failure(homeByFailureReason(homeBy, homeBy - startAt));
  }
  throw new Error("buildItinerary 内部错误：既没有行程也没有失败原因");
}

/* ------------------------------------------------------------------ *
 * M7：只替换一站（/api/swap 复用）
 *
 * 两种动作的信号方向相反：
 *   - reroll ：「换一个」= 中性 / 发散。只影响这一次候选排序（同类目优先），
 *              **绝不写偏好**：preference.getWeight 全程保持原值（默认 1）。
 *   - dislike：「不感兴趣」= 负反馈 / 收敛。先把该类目权重 × 0.2（仅本次进程内存），
 *              再用降权后的分数挑新地点。
 *
 * 替换的硬约束（任何一条不满足就换下一个候选，全部不满足返回 ok:false）：
 *   1. 只动 stopIndex 这一站；其余站点的 placeId 与顺序逐字不变（时间可以整体平移）；
 *   2. 时间闭合：上一站.leaveAt + 新前段.durationMin = 新站.arriveAt；
 *      新站.leaveAt + 新后段.durationMin = 下一站.arriveAt；
 *   3. 总花费 ≤ budget；
 *   4. 同区域去重：同类目 <800m 不重复；第 3 站及以后不落回前序任一站的 800m 内；
 *   5. 营业时间 / 半径 / 餐厅正餐时段仍然成立；
 *   6. 日落锚点：被换掉的是锚定到达目标（默认 17:32）到站的户外日落点时，优先换成同样能锚在该
 *      目标的户外日落点（通过调整前一站停留 45–95 分钟把到达拉回目标）；做不到就把锚点
 *      降级成普通站并重算整份时间，绝不返回「reason 声称赶得上日落、时间却不在锚定目标」的行程。
 *
 * 日落参数由调用方（/api/swap 的城市 thresholds）传入 options.sunsetMinute，省略时默认 17:42；
 * 函数内不再有任何硬编码时刻。
 *
 * 这里只**追加**函数，pickNext / buildItinerary 的判定逻辑一行没改。
 * 任务2：replaceStop 不调用 pickNext（单点替换有自己的 scoreOf 排序），因此方位扣分不影响 /api/swap。
 * ------------------------------------------------------------------ */

export const SwapActionSchema = z.enum(["reroll", "dislike"]);

export type SwapAction = z.infer<typeof SwapActionSchema>;

/** /api/swap 的返回契约：成功是完整 Itinerary，失败只有 { ok:false, reason }。 */
export const ReplaceStopResultSchema = z.union([
  ItinerarySchema,
  z.object({ ok: z.literal(false), reason: z.string().min(1) }),
]);

/** replaceStop 的入参。 */
export type ReplaceStopOptions = {
  /** 起点；id 必须与行程第一段的 fromId 一致，只在替换第 1 站时用来算第一段路线。 */
  origin: Place;
  /** 候选池（data/cities/<city>.json 里的 places）；新地点只能来自这里。 */
  pool: Place[];
  /** 原始预算（元）；替换后 totalCost 必须 ≤ 它。 */
  budget: number;
  /** 人数只影响餐厅卡文案，默认 1 人（与首屏一致）。 */
  people?: number;
  /** 原来的排程模式（偏好 / 天气 / 体力）；M7 的请求没带这些字段时用空模式。 */
  mode?: PickMode;
  /**
   * 本次会话已经换出过的 placeId（页面把历史带上来）。
   * 这些地点从候选池里排除，连点「换一个」就不会 A→B→A 来回跳。
   */
  avoidPlaceIds?: string[];
  /**
   * 当地日落时刻（当日分钟数）；省略 = 默认 1062（17:42）。与 /api/plan 同一口径，
   * 只影响日落锚点判断（锚定到达目标 = 日落前 10 分钟）。
   */
  sunsetMinute?: number;
  /** 高德城市码（公交算路用）；省略 = 公交算不出来。与 /api/plan 同一口径。 */
  cityCode?: string;
};

/**
 * 日落锚点站 = 户外日落点，且原排程正好锚在本次调用的到达目标（默认 17:32）到站。
 * 到达目标由调用方按本次日落参数算好后传入，绝不用硬编码时刻。
 */
function isAnchoredStop(stop: Stop, place: Place, sunsetArriveEarliest: number): boolean {
  return isSunsetPlace(place) && isSunsetAnchorEligible(place) && stop.arriveAt === sunsetArriveEarliest;
}

/** 在 stopIndex 之后找原来的日落锚点站（最多一个；buildItinerary 一次只锚一个点）。 */
function findAnchoredIndexAfter(
  stops: Stop[],
  placeById: Map<string, Place>,
  afterIndex: number,
  sunsetArriveEarliest: number,
): number | null {
  for (let index = afterIndex + 1; index < stops.length; index += 1) {
    const place = placeById.get(stops[index].placeId);
    if (place !== undefined && isAnchoredStop(stops[index], place, sunsetArriveEarliest)) return index;
  }
  return null;
}

function commuteFromSegment(segment: Segment): Commute {
  const base: Commute = { mode: segment.mode, durationMin: segment.durationMin, distanceM: segment.distanceM };
  return segment.road === undefined ? base : { ...base, road: segment.road };
}

function swapFailure(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

/**
 * M7：单点替换的候选范围。
 * 比整份排程的 PREFILTER_LIMIT（6）多放几个：加上「本次会话已换出」的排除后，
 * 仍要保证连点 5 次有足够多没出现过的候选。
 */
const SWAP_PREFILTER_LIMIT = 24;
const SWAP_SAME_CATEGORY_LIMIT = 4;
const SWAP_DIFFERENT_CATEGORY_LIMIT = 6;

/** 「不感兴趣」换不回别类目时，返回给界面的固定文案（M7 验收要求原样显示）。 */
const DISLIKE_NO_OTHER_CATEGORY_REASON = "附近没有其他类型的地方了";

/* ------------------------------------------------------------------ *
 * 换一个的「距离带」（本轮新增）
 *
 * 为什么要有：换一个原先只看打分，可能把某一站换成 5 公里外的点，
 * 整条线「从家出发、越走越远、再走回来」的形状就被换坏了。
 *
 * 距离带 = [上一站到 origin 的直线距离 × 0.9, 下一站到 origin 的直线距离 ÷ 0.9]
 *   - 第一站没有上一站 → 下界 0
 *   - 最后一站没有下一站 → 上界无限
 * 例（辽阳 0.22 → 0.67 → 1.38 → 2.28 km）：
 *   换第 1 站 [0, 0.74]；第 2 站 [0.20, 1.53]；第 3 站 [0.60, 2.53]；第 4 站 [1.24, ∞]
 *
 * 系数 0.9 与 buildItinerary 的距离递增规则（新站距离 ≥ 上一站 × 0.9）同源：
 * 带内的点换进来之后，与左右相邻站之间最多只有 10% 的回退，序列仍算单调。
 *
 * 只作用于「换一个」（reroll）。「不感兴趣」是降权信号（让别类目有机会顶上来），
 * 任务书明确不要求距离带，所以那条路径不受影响。
 * ------------------------------------------------------------------ */

const SWAP_DISTANCE_BAND_RATIO = 0.9;

/** 距离带内一个候选都没有时的固定人话（任务书指定文案）：说清是「这一带没有」，不是系统坏了。 */
const SWAP_BAND_EMPTY_REASON = "这一带没有别的选择，换个时间试试？";

/** 某一站允许的「到 origin 的直线距离」区间（米）。maxM 可以是 Infinity（末站）。 */
type DistanceBand = { minM: number; maxM: number };

/**
 * 算某一站的距离带：上下界都用该站**当前**的相邻站到 origin 的直线距离，不用任何硬编码。
 * 端点站用 0 / Infinity 兜住，调用方不用再判空。
 */
function distanceBandOf(previousDistanceM: number | null, nextDistanceM: number | null): DistanceBand {
  return {
    minM: previousDistanceM === null ? 0 : previousDistanceM * SWAP_DISTANCE_BAND_RATIO,
    maxM: nextDistanceM === null ? Number.POSITIVE_INFINITY : nextDistanceM / SWAP_DISTANCE_BAND_RATIO,
  };
}

function withinDistanceBand(distanceM: number, band: DistanceBand): boolean {
  return distanceM >= band.minM && distanceM <= band.maxM;
}

/**
 * 只替换 itinerary 的第 stopIndex 站。
 *
 * 返回：新的完整 Itinerary（已过 zod + 闭合 + 预算 + 用餐时段断言），
 * 或 { ok:false, reason } 说明卡在哪条约束。输入非法（越界 / id 不在池里）直接抛错。
 */
export async function replaceStop(
  itineraryInput: Itinerary,
  stopIndex: number,
  action: SwapAction,
  options: ReplaceStopOptions,
): Promise<Itinerary | { ok: false; reason: string }> {
  const itinerary = ItinerarySchema.parse(itineraryInput);
  const swapAction = SwapActionSchema.parse(action);
  const origin = PlaceSchema.parse(options.origin);
  const pool = z.array(PlaceSchema).parse(options.pool);
  // 数据分层：hidden===true 的点不进「替换候选」；placeById 仍用完整 pool，
  // 这样隐藏之前已经排进行程的点还能被正常解析（作为原站保留，不会被换掉）。
  const candidatePool = pool.filter((place) => place.hidden !== true);
  const mode = PickModeSchema.parse(options.mode === undefined ? {} : options.mode);
  const people = options.people === undefined ? 1 : options.people;
  if (!Number.isInteger(people) || people < 1 || people > 10) {
    throw new Error(`people 必须是 1–10 的整数，收到：${String(people)}`);
  }
  // 日落参数：与 buildItinerary 同一口径（不传 = 默认 1062 / 17:42）。
  // 本函数里所有锚点判断（含下面的嵌套函数）都用这一次调用解析出来的值，不用任何硬编码时刻。
  const sunset = resolveSunsetAnchor(options.sunsetMinute);
  if (typeof options.budget !== "number" || !Number.isFinite(options.budget) || options.budget < 0) {
    throw new Error(`budget 必须是 >= 0 的有限数字，收到：${String(options.budget)}`);
  }
  const budget = options.budget;
  // 城市码（公交算路用）：与 /api/plan 同一口径，由调用方从城市配置传入；不传则公交算不出来。
  const cityCode =
    options.cityCode === undefined
      ? undefined
      : z.string().regex(/^\d{4,6}$/, "cityCode 必须是 4–6 位数字（高德城市码）").parse(options.cityCode);
  // 「连点不来回跳」：页面把本次会话换出过的 placeId 带上来，这里从候选池里排除。
  const avoidPlaceIds =
    options.avoidPlaceIds === undefined ? [] : z.array(z.string().min(1)).parse(options.avoidPlaceIds);
  const avoidPlaceIdSet = new Set<string>(avoidPlaceIds);
  if (!Number.isInteger(stopIndex) || stopIndex < 0 || stopIndex >= itinerary.stops.length) {
    throw new Error(
      `stopIndex 必须是 0–${itinerary.stops.length - 1} 的整数，收到：${String(stopIndex)}`,
    );
  }

  const originId = itinerary.segments[0].fromId;
  if (originId !== origin.id) {
    throw new Error(`origin.id=${origin.id} 与行程第一段 fromId=${originId} 不一致`);
  }

  const placeById = new Map<string, Place>(pool.map((place) => [place.id, place]));
  const placeOf = (stop: Stop): Place => {
    const place = placeById.get(stop.placeId);
    if (place === undefined) throw new Error(`行程里出现候选池外的 placeId=${stop.placeId}`);
    return place;
  };

  const stops = itinerary.stops;
  const segments = itinerary.segments;
  const target = stops[stopIndex];
  const targetPlace = placeOf(target);
  const prevPlace = stopIndex === 0 ? null : placeOf(stops[stopIndex - 1]);
  const nextPlace = stopIndex === stops.length - 1 ? null : placeOf(stops[stopIndex + 1]);
  const fromPoint = prevPlace === null ? { lng: origin.lng, lat: origin.lat } : { lng: prevPlace.lng, lat: prevPlace.lat };
  const fromId = prevPlace === null ? origin.id : prevPlace.id;
  const departAt = prevPlace === null ? itinerary.startAt : stops[stopIndex - 1].leaveAt;
  const nextPoint = nextPlace === null ? null : { lng: nextPlace.lng, lat: nextPlace.lat };
  const pointOf = (place: Place) => ({ lng: place.lng, lat: place.lat });

  /**
   * 距离带（本轮新增）：把「换一个」限制在这一站原来的距离段里，别把环线形状换坏。
   * 只有 reroll 要求；dislike 是降权信号，按任务书第 5 条不做距离限制（swapBand 为 null）。
   * 上下界的相邻站都取**换之前**的行程：换一站不改别的站的位置，所以换完仍然落在带里。
   */
  const distanceFromOriginOf = (place: Place): number => haversineMeters(origin, place);
  const previousDistanceM = prevPlace === null ? null : distanceFromOriginOf(prevPlace);
  const nextDistanceM = nextPlace === null ? null : distanceFromOriginOf(nextPlace);
  const swapBand = swapAction === "reroll" ? distanceBandOf(previousDistanceM, nextDistanceM) : null;
  const withinSwapBand = (place: Place): boolean =>
    swapBand === null || withinDistanceBand(distanceFromOriginOf(place), swapBand);

  // 本轮新增（返程）：segments 比 stops 多一段时，最后一段是「末站 → 终点」的返程。
  // 换掉最后一站时返程段必须从新站重算；换其它站时返程段原样保留（末站没变）。
  const hasReturn = segments.length === stops.length + 1;
  const returnSegment: Segment | null = hasReturn ? segments[segments.length - 1] : null;
  let destinationPoint: { lng: number; lat: number } | null = null;
  if (returnSegment !== null) {
    if (itinerary.destination !== undefined) {
      destinationPoint = { lng: itinerary.destination.lng, lat: itinerary.destination.lat };
    } else if (returnSegment.toId === origin.id) {
      // 老数据没有 endpoint 快照：默认终点就是起点，用起点坐标兜住（不是猜，是契约里的默认值）。
      destinationPoint = { lng: origin.lng, lat: origin.lat };
    } else {
      throw new Error(
        `这份行程有返程段但终点 ${returnSegment.toId} 缺少坐标快照，无法只替换一站`,
      );
    }
  }

  // 「不感兴趣」先记负反馈：这次换不出来，信号也已经生效（仅本次会话内存）。
  if (swapAction === "dislike") declareDislike(targetPlace.category);

  // 预算只和「其他站点」有关：被替换那站的开销由新站替换。
  const otherCosts = stops.reduce(
    (sum, stop, index) => (index === stopIndex ? sum : sum + stop.costEstimate),
    0,
  );
  const budgetLeftForCandidate = budget - otherCosts;

  // 换一个 = 同类目优先（categoryNorm 命中 1.0），但这不是偏好权重，preference 不会被写。
  const scoringMode: PickMode = {
    ...mode,
    preferredCategories: swapAction === "reroll" ? [targetPlace.category] : mode.preferredCategories,
  };
  const scoreOf = (place: Place, commute: Commute): number =>
    scoreCandidate(place, commute, categoryNormFor(place.category, scoringMode.preferredCategories)) *
    getWeight(place.category);

  const weekdayLabel = weekdayLabelOf(new Date());
  const scopeNote = swapAction === "dislike" ? "；该类目已记为不感兴趣（仅本次会话内存生效）" : "";
  const withScope = (reason: string): string => `${reason}${scopeNote}`;

  /**
   * 换掉最后一站时重算返程段（新站 → 终点）。返程段没变（换的不是最后一站）返回 null。
   * 路线算不出来返回 null，由调用方按「这个候选不行」处理，不拿直线估算顶替。
   */
  async function rebuildReturnSegment(place: Place): Promise<Segment | null> {
    if (returnSegment === null || destinationPoint === null) return null;
    const commute = await decideCommute(pointOf(place), destinationPoint, mode, cityCode);
    if (commute === null) return null;
    return segmentOf(place.id, returnSegment.toId, commute);
  }

  const existingIds = new Set<string>(stops.map((stop) => stop.placeId));
  existingIds.add(origin.id);

  const rejects = { hours: 0, radius: 0, noRoute: 0, constraints: 0 };

  /** 同区域去重：新地点必须和「其余站点」保持 buildItinerary 的同一条规则。 */
  function isBlockedByDedup(candidate: Place): boolean {
    for (let index = 0; index < stops.length; index += 1) {
      if (index === stopIndex) continue;
      const other = placeOf(stops[index]);
      const distance = haversineMeters(other, candidate);
      // 同类目 <800m 视为同一片地方（任意两站都不许重复）。
      if (other.category === candidate.category && distance < SAME_CATEGORY_DUPLICATE_DISTANCE_M) {
        return true;
      }
      // 第 3 站及以后，不得落在前序任一站的 800m 内。
      if (stopIndex >= 2 && index < stopIndex && distance < NON_ADJACENT_LOOPBACK_DISTANCE_M) {
        return true;
      }
      // 替换靠前的站时，后面的第 3 站及以后也不能落回新站的 800m 内。
      if (index > stopIndex && index >= 2 && distance < NON_ADJACENT_LOOPBACK_DISTANCE_M) {
        return true;
      }
    }
    return false;
  }

  // 候选池：先排掉「当天已选 / 同区域重复」，再排掉「本次会话已经换出过的」。
  // hidden 的点在 candidatePool 里已经被剔除。
  const dedupedPool = candidatePool.filter((place) => !existingIds.has(place.id) && !isBlockedByDedup(place));
  const available = dedupedPool.filter((place) => !avoidPlaceIdSet.has(place.id));
  const affordable = available.filter((place) => canAfford(place, budgetLeftForCandidate));
  if (available.length > 0 && affordable.length === 0) {
    let cheapest: number | null = null;
    for (const place of available) {
      const cost = estimateCost(place).cost;
      if (cheapest === null || cost < cheapest) cheapest = cost;
    }
    return swapFailure(
      withScope(
        `这一站换不出来：剩余预算 ${budgetLeftForCandidate} 元，最便宜的候选也要 ${String(cheapest)} 元`,
      ),
    );
  }

  // 距离带过滤（本轮新增，只对「换一个」生效）：候选池先按距离带过滤，再走原来的打分逻辑。
  // available / affordable 保持原样——后面判断失败原因时还要用它们区分「预算不够」和「都换过了」。
  // bandFallbackAffordable 是「连本次会话换出过的点也算上」的带内候选，给下面的兜底重试用。
  const bandAvailable = available.filter(withinSwapBand);
  const bandAffordable = affordable.filter(withinSwapBand);
  const bandFallbackAffordable = dedupedPool.filter(
    (place) => canAfford(place, budgetLeftForCandidate) && withinSwapBand(place),
  );
  // 带内一个候选都没有 → 说清是「这一带没有别的选择」，而不是含糊的「换不出来」或抛错。
  // 只有 available.length > 0（不是因为「都换过了」）时才这样报；否则让下面的兜底 / 既有原因接管。
  if (swapBand !== null && available.length > 0 && bandAvailable.length === 0 && bandFallbackAffordable.length === 0) {
    return swapFailure(SWAP_BAND_EMPTY_REASON);
  }

  /**
   * 单点替换的候选排序：同时看两段——
   *   上一站 → 候选（换进来要多久） + 候选 → 下一站（换完之后还要走多久）。
   * 紧凑行程里只看「离上一站近」很容易换进来一个把下一段撑长的点，
   * 后面的正餐 / 闭馆窗口就被推出去了；两段都短的候选才更可能换得进去。估算只用直线距离，0 请求。
   */
  const orderCandidates = (places: Place[]): Place[] =>
    places.slice().sort((left, right) => {
      const leftCost =
        estimateWalkMinutes(fromPoint, left) + (nextPoint === null ? 0 : estimateWalkMinutes(left, nextPoint));
      const rightCost =
        estimateWalkMinutes(fromPoint, right) + (nextPoint === null ? 0 : estimateWalkMinutes(right, nextPoint));
      if (leftCost !== rightCost) return leftCost - rightCost;
      return left.id.localeCompare(right.id);
    });

  /**
   * 组装最终行程：重算 reason（新站 / 后一站 / 被降级的锚点）、重算餐厅卡、补地点快照、重算 totalCost，
   * 再跑闭合 / 预算 / 用餐时段 / 营业时间断言。返回 Itinerary，或一句失败原因（候选作废）。
   */
  function assembleFinal(
    layoutStops: Stop[],
    layoutSegments: Segment[],
    assembleOptions: { droppedAnchorIndexes: number[] },
  ): Itinerary | string {
    const reasonIndexes = new Set<number>([stopIndex]);
    if (stopIndex + 1 < layoutStops.length) reasonIndexes.add(stopIndex + 1);
    for (const index of assembleOptions.droppedAnchorIndexes) reasonIndexes.add(index);

    const finalStops: Stop[] = layoutStops.map((stop, index) => {
      const place = placeOf(stop);
      const cost = estimateCost(place);
      let reason = stop.reason;
      if (reasonIndexes.has(index)) {
        reason = buildReason(place, commuteFromSegment(layoutSegments[index]), cost.basis, cost.cost);
      }
      // 锚定到达目标（本次调用解析出来的值，默认 17:32）到站的户外日落点：reason 必须说明「赶得上日落」；
      // 反过来，时间被平移后不再落在目标的，不许保留这句话（见 droppedAnchorIndexes 的重建）。
      if (
        stop.arriveAt === sunset.arriveEarliest &&
        isSunsetPlace(place) &&
        isSunsetAnchorEligible(place) &&
        reason.indexOf("赶得上") === -1
      ) {
        const outdoorNote =
          place.openTime === null || place.closeTime === null ? "" : "（户外公共空间，开放时间仅供参考）";
        reason = `${reason}，赶得上 ${formatClockText(sunset.sunsetMinute)} 的日落${outdoorNote}`;
      }
      const meal =
        place.category === "restaurant"
          ? buildMealInfo(place, stop.arriveAt, people, weekdayLabel)
          : undefined;
      // 城市数据模块化：每站补地点快照（placeName / lng / lat / placeCloseTime），
      // 页面 / 地图只依赖这些字段渲染；place 缺失时 placeOf 已按「候选池外」口径抛错。
      return {
        ...stop,
        reason,
        meal,
        placeName: place.name,
        lng: place.lng,
        lat: place.lat,
        placeCloseTime: place.closeTime,
      };
    });

    // 本轮新增（返程）：layoutSegments 比 finalStops 多一段时，最后一段是返程，endAt 要算到终点。
    const layoutReturnSegment =
      layoutSegments.length === finalStops.length + 1 ? layoutSegments[layoutSegments.length - 1] : null;
    const lastLeaveAt = finalStops[finalStops.length - 1].leaveAt;
    const endAt = layoutReturnSegment === null ? lastLeaveAt : lastLeaveAt + layoutReturnSegment.durationMin;
    if (endAt > MINUTES_PER_DAY) return "换完后会超过当天 24:00";
    const totalCost = finalStops.reduce((sum, stop) => sum + stop.costEstimate, 0);
    const finalItinerary: Itinerary = ItinerarySchema.parse({
      startAt: itinerary.startAt,
      endAt,
      totalMin: endAt - itinerary.startAt,
      totalCost,
      stops: finalStops,
      segments: layoutSegments,
      // 端点快照按原样带回（自定义起点 / 终点要靠它画地图、换站），旧行程没有这两个字段。
      origin: itinerary.origin,
      destination: itinerary.destination,
    });
    try {
      assertItineraryClosed(finalItinerary, originId, budget);
      for (let index = 0; index < finalStops.length; index += 1) {
        const place = placeOf(finalStops[index]);
        if (!isOpenAt(place, finalStops[index].arriveAt, finalStops[index].stayMin)) {
          return `换完后第 ${index + 1} 站不在营业时间内`;
        }
      }
      assertRestaurantSlots(finalStops, placeById);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return finalItinerary;
  }

  type SwapCandidateResult = { itinerary: Itinerary; score: number; durationMin: number; id: string };

  let best: SwapCandidateResult | null = null;
  /** 「不感兴趣」专用：把「别类目」的候选单独留一个最优的（分数低一点也优先听用户的）。 */
  let bestDifferentCategory: SwapCandidateResult | null = null;
  const isBetter = (candidate: SwapCandidateResult, current: SwapCandidateResult | null): boolean => {
    if (current === null) return true;
    if (candidate.score > current.score + 1e-9) return true;
    if (Math.abs(candidate.score - current.score) > 1e-9) return false;
    if (candidate.durationMin !== current.durationMin) return candidate.durationMin < current.durationMin;
    return candidate.id.localeCompare(current.id) < 0;
  };
  const consider = (result: SwapCandidateResult | null): void => {
    if (result === null) return;
    if (isBetter(result, best)) best = result;
    if (swapAction === "dislike") {
      const resultPlace = placeOf(result.itinerary.stops[stopIndex]);
      if (resultPlace.category !== targetPlace.category && isBetter(result, bestDifferentCategory)) {
        bestDifferentCategory = result;
      }
    }
  };

  /**
   * 普通替换（非锚点分支，或锚点实在锚不住的兜底）：
   * 新站按正常 STAY_MIN 停留，后续站点整体平移。若后面还有原日落锚点站，优先把它的
   * 前一站停留调回 45–95 分钟、让锚点仍然锚在本次的到达目标（默认 17:32）；调不动就把锚点降级成普通站并重算整份时间。
   */
  async function evaluateNormalCandidate(candidate: Place): Promise<SwapCandidateResult | null> {
    const inbound = await decideCommute(fromPoint, pointOf(candidate), mode, cityCode);
    if (inbound === null) {
      rejects.noRoute += 1;
      return null;
    }
    if (!withinRadius(inbound.durationMin, inbound.mode)) {
      rejects.radius += 1;
      return null;
    }
    const arriveAt = departAt + inbound.durationMin;
    if (!isOpenAt(candidate, arriveAt, STAY_MIN[candidate.category])) {
      rejects.hours += 1;
      return null;
    }
    let outbound: Commute | null = null;
    if (nextPoint !== null) {
      outbound = await decideCommute(pointOf(candidate), nextPoint, mode, cityCode);
      if (outbound === null) {
        rejects.noRoute += 1;
        return null;
      }
      if (!withinRadius(outbound.durationMin, outbound.mode)) {
        rejects.radius += 1;
        return null;
      }
    }

    // 换的是最后一站时，返程段必须从新站重新算（否则返程段 fromId / 时长都对不上）。
    let newReturnSegment: Segment | null = null;
    if (nextPlace === null && returnSegment !== null) {
      newReturnSegment = await rebuildReturnSegment(candidate);
      if (newReturnSegment === null) {
        rejects.noRoute += 1;
        return null;
      }
    }

    const cost = estimateCost(candidate);
    const inboundSegment: Segment = segmentOf(fromId, candidate.id, inbound);
    const outboundSegment: Segment | null =
      outbound === null || nextPlace === null
        ? null
        : segmentOf(candidate.id, nextPlace.id, outbound);

    let newStayMin = STAY_MIN[candidate.category];
    let newLeaveAt = arriveAt + newStayMin;
    const outboundDuration = outbound === null ? 0 : outbound.durationMin;
    // 后续站点整体平移量 = 新后段到达时刻 - 原后段到达时刻。
    // 注意要把「新后段本身的时长变化」算进去，否则下一站会不闭合。
    const downstreamShiftFor = (leaveAt: number): number =>
      nextPlace === null || stops[stopIndex + 1] === undefined
        ? 0
        : leaveAt + outboundDuration - stops[stopIndex + 1].arriveAt;
    const baseShift = downstreamShiftFor(newLeaveAt);

    // 后面还有原来的日落锚点站时，优先把它重新锚回本次的到达目标（最多一个）。
    const anchorIndex = findAnchoredIndexAfter(stops, placeById, stopIndex, sunset.arriveEarliest);
    const droppedAnchorIndexes: number[] = [];
    let anchorStayIndex: number | null = null;
    let anchorStayValue = 0;
    if (anchorIndex !== null) {
      // 锚点紧跟在被替换站后面时，它进站那一段就是新的后段（时长已经变了）。
      const anchorInboundDuration =
        anchorIndex === stopIndex + 1 ? outboundDuration : segments[anchorIndex].durationMin;
      const desiredLeave = sunset.arriveEarliest - anchorInboundDuration;
      const stayIndex = anchorIndex - 1;
      if (stayIndex === stopIndex) {
        const candidateStay = desiredLeave - arriveAt;
        if (
          candidateStay >= SUNSET_STAY_MIN_FLOOR &&
          candidateStay <= SUNSET_STAY_MIN_CEILING &&
          desiredLeave > arriveAt &&
          isOpenAt(candidate, arriveAt, candidateStay)
        ) {
          newStayMin = candidateStay;
          newLeaveAt = desiredLeave;
        } else {
          droppedAnchorIndexes.push(anchorIndex);
        }
      } else {
        const arriveThen = stops[stayIndex].arriveAt + baseShift;
        const stayThen = desiredLeave - arriveThen;
        if (
          stayThen >= SUNSET_STAY_MIN_FLOOR &&
          stayThen <= SUNSET_STAY_MIN_CEILING &&
          desiredLeave > arriveThen &&
          isOpenAt(placeOf(stops[stayIndex]), arriveThen, stayThen)
        ) {
          anchorStayIndex = stayIndex;
          anchorStayValue = stayThen;
        } else {
          droppedAnchorIndexes.push(anchorIndex);
        }
      }
    }

    const finalShift = downstreamShiftFor(newLeaveAt);
    const newStop: Stop = {
      placeId: candidate.id,
      arriveAt,
      leaveAt: newLeaveAt,
      stayMin: newStayMin,
      reason: "换一个",
      costEstimate: cost.cost,
    };

    // 整份平移会让目标站之后的所有站一起动。若后面没有需要保留的日落锚点，
    // 先尝试用「下一站的停留时长」吸收这次平移（和日落锚点调整前一站停留是同一机制）：
    // 下一站的离开时间和再后面的站都不变，餐厅正餐时段 / 闭馆时间就不会被推出去，换站成功率也高。
    if (anchorIndex === null && nextPlace !== null && finalShift !== 0) {
      const nextStopIndex = stopIndex + 1;
      const nextStop = stops[nextStopIndex];
      const nextArriveAt = newLeaveAt + outboundDuration;
      const absorbedStay = nextStop.stayMin - finalShift;
      const absorbedMax = Math.max(SUNSET_STAY_MIN_CEILING, nextStop.stayMin);
      if (
        absorbedStay >= SUNSET_STAY_MIN_FLOOR &&
        absorbedStay <= absorbedMax &&
        isOpenAt(nextPlace, nextArriveAt, absorbedStay)
      ) {
        const absorbedStops: Stop[] = stops.map((stop, index) => {
          if (index < stopIndex) return { ...stop };
          if (index === stopIndex) return newStop;
          if (index === nextStopIndex) {
            return {
              ...stop,
              arriveAt: nextArriveAt,
              stayMin: absorbedStay,
              leaveAt: nextArriveAt + absorbedStay,
            };
          }
          return { ...stop };
        });
        const absorbedSegments: Segment[] = segments.map((segment, index) => {
          if (index === stopIndex) return inboundSegment;
          if (index === stopIndex + 1 && outboundSegment !== null) return outboundSegment;
          if (newReturnSegment !== null && index === segments.length - 1) return newReturnSegment;
          return { ...segment };
        });
        const absorbed = assembleFinal(absorbedStops, absorbedSegments, { droppedAnchorIndexes: [] });
        if (typeof absorbed !== "string") {
          return {
            itinerary: absorbed,
            score: scoreOf(candidate, inbound),
            durationMin: inbound.durationMin,
            id: candidate.id,
          };
        }
      }
    }

    const layoutStops: Stop[] = stops.map((stop, index) => {
      if (index < stopIndex) return { ...stop };
      if (index === stopIndex) return newStop;
      if (anchorStayIndex !== null && index === anchorStayIndex) {
        const arriveThen = stop.arriveAt + finalShift;
        return { ...stop, arriveAt: arriveThen, leaveAt: arriveThen + anchorStayValue, stayMin: anchorStayValue };
      }
      if (anchorIndex !== null && droppedAnchorIndexes.length === 0 && index >= anchorIndex) {
        return { ...stop };
      }
      return { ...stop, arriveAt: stop.arriveAt + finalShift, leaveAt: stop.leaveAt + finalShift };
    });
    const layoutSegments: Segment[] = segments.map((segment, index) => {
      if (index === stopIndex) return inboundSegment;
      if (index === stopIndex + 1 && outboundSegment !== null) return outboundSegment;
      if (newReturnSegment !== null && index === segments.length - 1) return newReturnSegment;
      return { ...segment };
    });

    const assembled = assembleFinal(layoutStops, layoutSegments, {
      droppedAnchorIndexes,
    });
    if (typeof assembled === "string") {
      rejects.constraints += 1;
      return null;
    }
    return {
      itinerary: assembled,
      score: scoreOf(candidate, inbound),
      durationMin: inbound.durationMin,
      id: candidate.id,
    };
  }

  /**
   * 日落锚点替换：新点也必须是户外日落点，并通过调整前一站的停留（45–95 分钟）
   * 让它仍然锚在本次的到达目标（默认 17:32）；后续站点按新的锚点离开时间整体平移。
   */
  async function evaluateAnchorCandidate(candidate: Place): Promise<SwapCandidateResult | null> {
    if (stopIndex === 0) return null;
    if (!isSunsetPlace(candidate) || !isSunsetAnchorEligible(candidate)) return null;
    const inbound = await decideCommute(fromPoint, pointOf(candidate), mode, cityCode);
    if (inbound === null) {
      rejects.noRoute += 1;
      return null;
    }
    if (!withinRadius(inbound.durationMin, inbound.mode)) {
      rejects.radius += 1;
      return null;
    }
    let outbound: Commute | null = null;
    if (nextPoint !== null) {
      outbound = await decideCommute(pointOf(candidate), nextPoint, mode, cityCode);
      if (outbound === null) {
        rejects.noRoute += 1;
        return null;
      }
      if (!withinRadius(outbound.durationMin, outbound.mode)) {
        rejects.radius += 1;
        return null;
      }
    }

    // 锚点站恰好是最后一站时（少见），返程段同样要从新锚点站重算。
    let newReturnSegment: Segment | null = null;
    if (nextPlace === null && returnSegment !== null) {
      newReturnSegment = await rebuildReturnSegment(candidate);
      if (newReturnSegment === null) {
        rejects.noRoute += 1;
        return null;
      }
    }

    const predecessor = stops[stopIndex - 1];
    const predecessorPlace = placeOf(predecessor);
    const desiredPrevLeave = sunset.arriveEarliest - inbound.durationMin;
    const adjustedPrevStay = desiredPrevLeave - predecessor.arriveAt;
    if (
      adjustedPrevStay < SUNSET_STAY_MIN_FLOOR ||
      adjustedPrevStay > SUNSET_STAY_MIN_CEILING ||
      desiredPrevLeave <= predecessor.arriveAt ||
      !isOpenAt(predecessorPlace, predecessor.arriveAt, adjustedPrevStay)
    ) {
      rejects.constraints += 1;
      return null;
    }

    const stayMin = STAY_MIN[candidate.category];
    const leaveAt = sunset.arriveEarliest + stayMin;
    // 后续站点平移量 = 新锚点站离开后走到下一站的到达时刻 - 原来的下一站到达时刻。
    const downstreamShift =
      nextPlace === null || stops[stopIndex + 1] === undefined
        ? 0
        : leaveAt + (outbound === null ? 0 : outbound.durationMin) - stops[stopIndex + 1].arriveAt;
    const cost = estimateCost(candidate);
    const newStop: Stop = {
      placeId: candidate.id,
      arriveAt: sunset.arriveEarliest,
      leaveAt,
      stayMin,
      reason: "换一个",
      costEstimate: cost.cost,
    };
    const inboundSegment: Segment = segmentOf(fromId, candidate.id, inbound);
    const outboundSegment: Segment | null =
      outbound === null || nextPlace === null
        ? null
        : segmentOf(candidate.id, nextPlace.id, outbound);

    const layoutStops: Stop[] = stops.map((stop, index) => {
      if (index === stopIndex - 1) {
        return {
          ...stop,
          stayMin: adjustedPrevStay,
          leaveAt: desiredPrevLeave,
        };
      }
      if (index < stopIndex) return { ...stop };
      if (index === stopIndex) return newStop;
      return { ...stop, arriveAt: stop.arriveAt + downstreamShift, leaveAt: stop.leaveAt + downstreamShift };
    });
    const layoutSegments: Segment[] = segments.map((segment, index) => {
      if (index === stopIndex) return inboundSegment;
      if (index === stopIndex + 1 && outboundSegment !== null) return outboundSegment;
      if (newReturnSegment !== null && index === segments.length - 1) return newReturnSegment;
      return { ...segment };
    });

    const assembled = assembleFinal(layoutStops, layoutSegments, {
      droppedAnchorIndexes: [],
    });
    if (typeof assembled === "string") {
      rejects.constraints += 1;
      return null;
    }
    return {
      itinerary: assembled,
      score: scoreOf(candidate, inbound),
      durationMin: inbound.durationMin,
      id: candidate.id,
    };
  }

  const targetIsAnchor = isAnchoredStop(target, targetPlace, sunset.arriveEarliest);

  // 锚点站替换：先只试「能继续锚在本次到达目标（默认 17:32）的户外日落点」。
  if (targetIsAnchor && stopIndex > 0) {
    const sunsetCandidates = bandAffordable.filter(
      (place) => isSunsetPlace(place) && isSunsetAnchorEligible(place),
    );
    const ordered = orderCandidates(sunsetCandidates).slice(0, SWAP_PREFILTER_LIMIT);
    for (const candidate of ordered) {
      consider(await evaluateAnchorCandidate(candidate));
    }
  }

  // 锚点换不出来（或本来就不是锚点站）→ 走普通替换：这是「放弃锚点、重算整份时间」的那条路。
  if (best === null) {
    // 普通替换候选：按「上一站→候选 + 候选→下一站」两段估算排序取前 24 个。
    // 「换一个」再补最多 4 个同类目候选，避免同类目换新被距离预筛掉；
    // 「不感兴趣」补最多 6 个别类目候选，让降权后的类目真的有机会被别的类目顶掉
    // （只是补候选，不是剔除——被降权的类目仍然在池子里，符合 M12「降权而不是删除」）。
    const prefiltered = orderCandidates(bandAffordable).slice(0, SWAP_PREFILTER_LIMIT);
    const candidatePool: Place[] = prefiltered.slice();
    if (swapAction === "reroll" || swapAction === "dislike") {
      const extra =
        swapAction === "reroll"
          ? orderCandidates(bandAffordable.filter((place) => place.category === targetPlace.category)).slice(
              0,
              SWAP_SAME_CATEGORY_LIMIT,
            )
          : orderCandidates(bandAffordable.filter((place) => place.category !== targetPlace.category)).slice(
              0,
              SWAP_DIFFERENT_CATEGORY_LIMIT,
            );
      const seen = new Set<string>(candidatePool.map((place) => place.id));
      for (const place of extra) {
        if (!seen.has(place.id)) {
          candidatePool.push(place);
          seen.add(place.id);
        }
      }
    }

    for (const candidate of candidatePool) {
      consider(await evaluateNormalCandidate(candidate));
    }

    // 「优先选没出现过的」的兜底：这次会话没出现过的都试过、仍换不出来时，
    // 才允许回到换出过的地点（当前站始终在 existingIds 里，所以不会原地不动）。
    // 这样连点不会在某一站直接卡死，同时仍然优先没出现过的候选。
    if (best === null && swapAction === "reroll" && avoidPlaceIds.length > 0 && dedupedPool.length > 0) {
      const fallbackAffordable = bandFallbackAffordable;
      const fallbackPool = orderCandidates(fallbackAffordable).slice(0, SWAP_PREFILTER_LIMIT);
      for (const candidate of fallbackPool) {
        consider(await evaluateNormalCandidate(candidate));
      }
    }
  }

  // TS 的控制流分析看不到 consider 闭包对这两个变量的赋值 —— 在 CFG 上它们只有声明时的 null，
  // 于是下面每个 `!== null` 都被判成恒假，属性访问退化成 never（严格模式才暴露）。
  // 这里用类型断言把「闭包里已经发生过的赋值」补回类型层：运行时没有任何额外操作。
  const bestCandidate = best as SwapCandidateResult | null;
  const likeAlternative = bestDifferentCategory as SwapCandidateResult | null;

  if (swapAction === "dislike") {
    // 有能通过的别类目就换过去；只有同类目能换时返回固定失败文案。
    if (likeAlternative !== null) {
      return ReplaceStopResultSchema.parse(likeAlternative.itinerary) as Itinerary;
    }
    if (bestCandidate !== null) return swapFailure(DISLIKE_NO_OTHER_CATEGORY_REASON);
  } else if (bestCandidate !== null) {
    return ReplaceStopResultSchema.parse(bestCandidate.itinerary) as Itinerary;
  }

  if (available.length === 0) {
    if (dedupedPool.length > 0) {
      return swapFailure(withScope("这一站换不出来：附近能换的地方这次会话都换过了"));
    }
    return swapFailure(withScope("这一站换不出来：候选池里没有可替换的地点（已排除当天已选与同区域重复）"));
  }
  const parts: string[] = [];
  if (rejects.hours > 0) parts.push(`${rejects.hours} 个点营业时间对不上`);
  if (rejects.radius > 0) parts.push(`${rejects.radius} 个点通勤超出半径上限`);
  if (rejects.noRoute > 0) parts.push(`${rejects.noRoute} 个点算不出可用路线`);
  if (rejects.constraints > 0) parts.push(`${rejects.constraints} 个点会破坏前后时间或正餐 / 锚点约束`);
  if (parts.length === 0) parts.push("没有同时满足时间、预算与去重约束的候选");
  return swapFailure(withScope(`这一站换不出来：${parts.join("，")}`));
}

