import { z } from "zod";
import { ItinerarySchema } from "@/types/schema";
import type { Itinerary } from "@/types/schema";

/**
 * 「出发」状态机的持久化（本轮新增）。
 *
 * localStorage key = "szjz.trip"。三种状态：
 * - planned：刚生成行程、还没点「出发」。会落盘，但页面加载时**直接清掉**（上一次的行程不恢复）；
 * - traveling：已出发。页面加载时若 startedAt 距今 < 8 小时 → 直接恢复进行中视图（跳过问答）；
 *   超过 8 小时 → 清掉，走正常流程；
 * - null：没有行程状态（不写 storage）。
 *
 * 设计约束：
 * 1. 读的时候一律过 zod（复用 types/schema 的 ItinerarySchema）：坏数据当「没有」，绝不让半截
 *    数据把页面卡在进行中视图；
 * 2. 工具函数全部做 `typeof window` 保护：服务端 import 也不会炸；
 * 3. 任务书的 TravelingTrip 类型只列了 itinerary / startedAt；验收要求「切到下一站后刷新仍停在
 *    同一站」，所以这里**扩展**了 `currentStopIndex`；另外可选存 `cityId` 让刷新恢复时城市下拉
 *    跟着回来。两者都是持久化细节，不影响状态机语义。
 */

export const TRIP_STORAGE_KEY = "szjz.trip";

/** traveling 状态的最长有效期：超过 8 小时视为「上一趟」，清掉走正常流程。 */
export const TRIP_MAX_AGE_MS = 8 * 60 * 60 * 1000;

/** 刚生成行程、等待「出发」：刷新不恢复（页面加载时清掉）。 */
export type PlannedTrip = {
  phase: "planned";
  itinerary: Itinerary;
};

/** 进行中：startedAt = 点「出发」的时刻（Date.now()）。 */
export type TravelingTrip = {
  phase: "traveling";
  itinerary: Itinerary;
  startedAt: number;
  /** 当前站下标（0 起）。验收 2 要求刷新后仍停在同一站，故持久化。 */
  currentStopIndex: number;
  /** 可选：行程所属城市 id（恢复时把城市下拉带回同一座城市）。 */
  cityId?: string;
};

export type TripState = PlannedTrip | TravelingTrip | null;

const PlannedTripSchema = z
  .object({
    phase: z.literal("planned"),
    itinerary: ItinerarySchema,
  })
  .strict();

const TravelingTripSchema = z
  .object({
    phase: z.literal("traveling"),
    itinerary: ItinerarySchema,
    startedAt: z.number().int().min(0),
    currentStopIndex: z.number().int().min(0),
    cityId: z.string().min(1).max(40).optional(),
  })
  .strict();

const PersistedTripSchema = z.discriminatedUnion("phase", [PlannedTripSchema, TravelingTripSchema]);

/** 把越界的 currentStopIndex 夹到 [0, stops.length - 1]；没有站点则视为坏数据。 */
function normalizeTravelingIndex(trip: TravelingTrip): TravelingTrip | null {
  const stopCount = trip.itinerary.stops.length;
  if (stopCount === 0) return null;
  const index = Math.min(Math.max(trip.currentStopIndex, 0), stopCount - 1);
  return index === trip.currentStopIndex ? trip : { ...trip, currentStopIndex: index };
}

/**
 * 读 szjz.trip：没有 / 解析失败 / zod 不通过 → null（当「没有行程状态」处理）。
 * 服务端调用恒返回 null（没有 localStorage）。
 */
export function readTripFromStorage(): TripState {
  if (typeof window === "undefined") return null;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(TRIP_STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null || raw.trim() === "") return null;
  try {
    const parsed = PersistedTripSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    return parsed.data.phase === "traveling" ? normalizeTravelingIndex(parsed.data) : parsed.data;
  } catch {
    return null;
  }
}

/** 写 szjz.trip：成功返回 true；localStorage 不可用（隐私模式）返回 false，不抛错。 */
export function saveTrip(trip: PlannedTrip | TravelingTrip): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(TRIP_STORAGE_KEY, JSON.stringify(PersistedTripSchema.parse(trip)));
    return true;
  } catch {
    return false;
  }
}

/** 清掉 szjz.trip（结束这一趟 / 过期 / planned 不恢复时用）。 */
export function clearTripFromStorage(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(TRIP_STORAGE_KEY);
  } catch {
    /* 忽略 */
  }
}

/** traveling 是否还在 8 小时有效期内（距 startedAt 不足 8 小时；未来时间也按有效处理）。 */
export function isTravelingTripFresh(trip: TravelingTrip, nowMs: number = Date.now()): boolean {
  return nowMs - trip.startedAt < TRIP_MAX_AGE_MS;
}
