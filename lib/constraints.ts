import type { Itinerary, Place, Segment, SegmentMode, Stop } from "../types/schema";

/**
 * M3：选点前的三个判断函数（纯函数，不发请求、不读缓存）。
 *
 * 所有时间一律是「当日分钟数」整数：920 = 15:20，和 types/schema.ts 的口径一致。
 * 返回值只做 true / false；数据本身不合法（比如 openTime 写成 "晚上十点"）直接抛错，
 * 不做兜底修补（00-common 铁律 4）。
 */

const MINUTES_PER_DAY = 1440;

/**
 * "HH:mm" → 当日分钟数（M5 起也接受 "24:00" → 1440，用于全天营业地点的 closeTime）。
 * 格式不合法直接抛错，不返回兜底值。
 *
 * 说明：用户指令里把这个函数叫 timeToMinute，本项目实际沿用 lib/constraints.ts 里的
 * parseClockMinute（M3 起的函数名，只有这一处实现，不新增别名，避免同一逻辑两份）。
 */
export function parseClockMinute(clock: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(clock.trim());
  if (match === null) {
    throw new Error(`营业时间格式不合法："${clock}"，应为 "HH:mm"`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const isEndOfDay = hour === 24 && minute === 0;
  if (
    !Number.isInteger(hour) ||
    hour < 0 ||
    hour > 24 ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59 ||
    (hour === 24 && !isEndOfDay)
  ) {
    throw new Error(`营业时间超出范围："${clock}"`);
  }
  // 24:00 = 当日结束（1440），全天营业地点的 closeTime 用它表示，跨零点判断不受影响。
  return hour === 24 ? MINUTES_PER_DAY : hour * 60 + minute;
}

/** 今天星期几，0 = 周日，和 schema 里 closedDays 的定义一致。 */
function todayWeekday(): number {
  return new Date().getDay();
}

/** 把「当日分钟数」折回 0–1439（跨零点营业判断时，1440 应等价于 0）。 */
function normalizeMinute(minuteOfDay: number): number {
  return ((minuteOfDay % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/** 户外公共空间的 sceneryType（与日落锚点的准入口径一致）。 */
const OUTDOOR_SCENERY_TYPES = ["江景", "森林", "田野", "建筑"] as const;

/** 名称里带这些词的 other 类地点按户外观景平台处理（不依赖 sceneryType）。 */
const OUTDOOR_VIEWPOINT_NAME_PATTERN = /(观景|平台|天台|露台)/;

/**
 * 户外公共空间：`category === 'park'`，或 `category === 'other'` 且：
 *   - sceneryType ∈ {江景, 森林, 田野, 建筑}；或
 *   - 名称含「观景 / 平台 / 天台 / 露台」（观景平台这类地点 LLM 常误标 sceneryType=其他）。
 *
 * 这类地点的 openTime / closeTime 只作参考：
 * 高德常把「城市阳台」的江堤步道标成里面展馆的 09:00–16:00，导致杭州最好的日落点
 * 在排程里永远不可用。户外空间到达时间超出营业时段不拒绝，但 reason 里不承诺任何服务。
 */
export function isOutdoorPlace(place: Place): boolean {
  if (place.category === "park") return true;
  if (place.category !== "other") return false;
  if (place.scenery !== undefined) {
    if ((OUTDOOR_SCENERY_TYPES as readonly string[]).indexOf(place.scenery.sceneryType) !== -1) {
      return true;
    }
  }
  return OUTDOOR_VIEWPOINT_NAME_PATTERN.test(place.name);
}

/**
 * 营业时段 + 闭馆日 + 停留窗口判断。
 *
 * 规则：
 * - 户外公共空间（isOutdoorPlace）→ 营业时间只作参考，到达时间超出时段也不拒绝；
 * - 室内地点 openTime / closeTime 为 null → 视为「未知 → 不可去」；
 * - 室内地点 closedDays 包含今天星期几 → false；
 * - 跨零点营业（如 22:00–02:00）按跨天处理；
 * - **到达 + 停留时长必须 ≤ 闭馆时刻**：16:40 到一家 17:00 闭馆的美术馆、排 90 分钟 → false。
 */
export function isOpenAt(place: Place, arriveAt: number, stayMin: number): boolean {
  if (!Number.isInteger(arriveAt)) {
    throw new Error(`到达时刻必须是整数分钟，收到：${String(arriveAt)}`);
  }
  if (!Number.isInteger(stayMin) || stayMin < 0) {
    throw new Error(`停留时长必须是 >= 0 的整数分钟，收到：${String(stayMin)}`);
  }

  // 户外公共空间：营业时间（含闭馆日字段）一律不作硬过滤。
  // 高德常把城市阳台的江堤步道标成里面展馆的 09:00–16:00；17:30 去江边看日落必须放行。
  if (isOutdoorPlace(place)) return true;

  if (place.closedDays.indexOf(todayWeekday()) !== -1) return false;

  if (place.openTime === null || place.closeTime === null) return false;

  const open = parseClockMinute(place.openTime);
  const close = parseClockMinute(place.closeTime);
  const minute = normalizeMinute(arriveAt);

  // open === close 视为 24 小时营业（否则区间为空，没有别的合理解释）。
  if (open === close) return true;

  if (open < close) {
    if (minute < open || minute >= close) return false;
    return minute + stayMin <= close;
  }

  // 跨零点：窗口是 [open, 24:00) ∪ [0:00, close)。
  if (minute >= open) {
    // 当天深夜进店，可以跨到次日凌晨；停留结束不能超过「次日 close」。
    return minute + stayMin <= MINUTES_PER_DAY + close;
  }
  // 次日凌晨进店：停留结束不能超过当天的 close。
  if (minute < close) return minute + stayMin <= close;
  return false;
}

/**
 * 人均消费口径（改版：null 不能一刀切当 0）。
 *
 * - avgCost 有值 → 直接用真实值；
 * - 书店 / 博物馆 / 美术馆 / 公园 / 市场 / 剧场 / 其他：null 按 0 元计（这些多是免费开放；
 *   剧场 null 极少见，但高德没给价时按 0 元不虚构价格）；
 * - 餐厅 / 咖啡：null 按杭州同类均价 50 元兜底——**不能当 0**，
 *   否则一份人均 120 的日料会变免费，预算约束当场失效。
 */
const MEAL_FALLBACK_COST = 50;

export type CostBasis = "actual" | "category-average" | "zero";

export type CostEstimate = {
  cost: number;
  /** actual = 高德真实人均；category-average = null 时按同类均价估；zero = null 时按 0 元计 */
  basis: CostBasis;
};

export function estimateCost(place: Place): CostEstimate {
  if (place.avgCost !== null) {
    return { cost: place.avgCost, basis: "actual" };
  }
  if (place.category === "restaurant" || place.category === "cafe") {
    return { cost: MEAL_FALLBACK_COST, basis: "category-average" };
  }
  return { cost: 0, basis: "zero" };
}

/** 剩余预算能不能负担这一站（口径见 estimateCost：餐厅/咖啡 null 按 50 元估）。 */
export function canAfford(place: Place, budgetLeft: number): boolean {
  return estimateCost(place).cost <= budgetLeft;
}

/** 单段通勤时长上限（分钟）：步行 30 / 公交 45 / 驾车 25；骑行按 45 处理（M3 3.1 只写了前三种）。 */
export const RADIUS_LIMIT_MIN: Record<SegmentMode, number> = {
  walk: 30,
  bus: 45,
  drive: 25,
  bike: 45,
};

/** 通勤时长是否在该交通方式的半径上限之内（M3 3.2 第 2 步过滤用）。 */
export function withinRadius(durationMin: number, mode: SegmentMode): boolean {
  if (!Number.isInteger(durationMin) || durationMin < 0) {
    throw new Error(`通勤时长必须是 >= 0 的整数分钟，收到：${String(durationMin)}`);
  }
  const limit = RADIUS_LIMIT_MIN[mode];
  if (typeof limit !== "number") {
    throw new Error(`未知的交通方式："${String(mode)}"`);
  }
  return durationMin <= limit;
}

/* ------------------------------------------------------------------ *
 * M4：行程时间闭合 / 总额校验
 *
 * 只做断言，不返回修正后的时间：任何一条不满足就抛错（M4 3.3 / 铁律 5）。
 * "不返回修正值"是刻意的——静默修正会让后面所有时间都错，而且查不出来。
 * ------------------------------------------------------------------ */

/** M4 3.3 的时间闭合容差（分钟）。整数分钟运算，正常情况下差额恒为 0。 */
const CLOSURE_TOLERANCE_MIN = 1;

/**
 * M4 3.3：上一站.leaveAt + 本段.durationMin 必须等于本站.arriveAt，容差 ≤ 1 分钟。
 * 不满足直接抛错，不修正 arriveAt。
 */
export function assertSegmentClosed(prevLeaveAt: number, segment: Segment, stop: Stop, label: string): void {
  if (!Number.isInteger(prevLeaveAt) || !Number.isInteger(stop.arriveAt)) {
    throw new Error(`闭合校验的入参必须是整数分钟（${label}）`);
  }
  const expectedArriveAt = prevLeaveAt + segment.durationMin;
  const diff = stop.arriveAt - expectedArriveAt;
  if (Math.abs(diff) > CLOSURE_TOLERANCE_MIN) {
    throw new Error(
      `时间不闭合（${label}）：上一站离开 ${prevLeaveAt} + 本段 ${segment.durationMin} 分钟 = ${expectedArriveAt}，` +
        `实际到达 ${stop.arriveAt}（差 ${diff} 分钟）`,
    );
  }
}

/** 站内闭合：leaveAt 必须等于 arriveAt + stayMin，不满足抛错。 */
export function assertStopClosed(stop: Stop, label: string): void {
  const expectedLeaveAt = stop.arriveAt + stop.stayMin;
  if (stop.leaveAt !== expectedLeaveAt) {
    throw new Error(
      `站内时间不闭合（${label}）：到达 ${stop.arriveAt} + 停留 ${stop.stayMin} 分钟 = ${expectedLeaveAt}，` +
        `实际离开 ${stop.leaveAt}`,
    );
  }
}

/**
 * M4 3.4：整份行程的总额校验（本轮扩展：支持末尾返程段）。
 *
 * - totalCost = 所有 costEstimate 之和，且 ≤ budget；
 * - 段与站一一对应、首尾相接（第一段 fromId = originId）；
 * - **返程**：segments 可以比 stops 多一段（只允许多最后一段），
 *   此时最后一段必须是「末站 → 终点」：fromId = 末站 placeId，
 *   endAt = 末站 leaveAt + 返程 durationMin；
 * - totalMin = endAt - startAt = 所有段 durationMin + 所有站 stayMin 之和（含返程段）。
 *
 * 任何一条不满足抛错（不钳制、不四舍五入、不把超预算的行程"顺手"返回）。
 */
export function assertItineraryClosed(itinerary: Itinerary, originId: string, budget: number): void {
  const { stops, segments } = itinerary;
  // 四种合法形态：0 站 0 段、站段一一对应（改造前）、或「站数 + 1」且最后一段是返程。
  const hasReturn = segments.length === stops.length + 1;
  if (segments.length !== stops.length && !hasReturn) {
    throw new Error(`行程结构不闭合：${stops.length} 站却有 ${segments.length} 段`);
  }
  if (hasReturn && stops.length === 0) {
    throw new Error("行程结构不闭合：没有站点却出现了返程段");
  }

  let expectedFromId = originId;
  let totalMinFromParts = 0;
  for (let index = 0; index < stops.length; index += 1) {
    const segment = segments[index];
    const stop = stops[index];
    const label = `第 ${index + 1} 段 / 第 ${index + 1} 站`;
    if (segment.fromId !== expectedFromId) {
      throw new Error(`行程不连续（${label}）：本段 fromId=${segment.fromId}，应为 ${expectedFromId}`);
    }
    if (segment.toId !== stop.placeId) {
      throw new Error(`行程结构不闭合（${label}）：segment.toId=${segment.toId}，stop.placeId=${stop.placeId}`);
    }
    assertStopClosed(stop, `第 ${index + 1} 站`);
    totalMinFromParts += segment.durationMin + stop.stayMin;
    expectedFromId = stop.placeId;
  }

  const returnSegment = hasReturn ? segments[segments.length - 1] : null;
  if (returnSegment !== null) {
    const lastStop = stops[stops.length - 1];
    if (returnSegment.fromId !== lastStop.placeId) {
      throw new Error(
        `返程段不连续：fromId=${returnSegment.fromId}，应为最后一站 ${lastStop.placeId}`,
      );
    }
    totalMinFromParts += returnSegment.durationMin;
  }

  let prevLeaveAt = itinerary.startAt;
  for (let index = 0; index < stops.length; index += 1) {
    assertSegmentClosed(prevLeaveAt, segments[index], stops[index], `第 ${index + 1} 段`);
    prevLeaveAt = stops[index].leaveAt;
  }

  const lastLeaveAt = stops.length === 0 ? itinerary.startAt : stops[stops.length - 1].leaveAt;
  const expectedEndAt =
    returnSegment === null ? lastLeaveAt : lastLeaveAt + returnSegment.durationMin;
  if (itinerary.endAt !== expectedEndAt) {
    throw new Error(
      returnSegment === null
        ? `endAt 不闭合：lastLeaveAt=${expectedEndAt}，实际 endAt=${itinerary.endAt}`
        : `endAt 不闭合：末站离开 ${lastLeaveAt} + 返程 ${returnSegment.durationMin} = ${expectedEndAt}，实际 endAt=${itinerary.endAt}`,
    );
  }
  if (itinerary.totalMin !== itinerary.endAt - itinerary.startAt) {
    throw new Error(`totalMin 不闭合：endAt - startAt = ${itinerary.endAt - itinerary.startAt}，实际 ${itinerary.totalMin}`);
  }
  if (itinerary.totalMin !== totalMinFromParts) {
    throw new Error(
      `totalMin 不等于各段之和：段时长 + 停留${returnSegment === null ? "" : " + 返程"} = ${totalMinFromParts}，实际 totalMin=${itinerary.totalMin}`,
    );
  }

  const totalCost = stops.reduce((sum, stop) => sum + stop.costEstimate, 0);
  if (Math.abs(totalCost - itinerary.totalCost) > 1e-9) {
    throw new Error(`totalCost 不等于各站之和：各站合计 ${totalCost}，实际 totalCost=${itinerary.totalCost}`);
  }
  if (totalCost > budget) {
    throw new Error(`totalCost 超预算：${totalCost} > ${budget}`);
  }
}
