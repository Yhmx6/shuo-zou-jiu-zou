import { PlaceSchema } from "../types/schema";
import type { Place } from "../types/schema";

/** 本机当地的 "YYYY-MM-DD"（不用 UTC，避免跨日错位）。 */
function todayIsoDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 起点不是 POI，也永远不进入候选池。
 * 它只对应 Segment.fromId 里那个固定字符串 "origin"：
 * M1/M2 算距离时，先用它换算出起点的坐标，再交给行程计算。
 *
 * name 默认「出发地」；用户自定义起点时由 /api/plan 传入地址文本（只做展示，不影响排程）。
 */
export function makeOriginPlace(lng: number, lat: number, name: string = "出发地"): Place {
  return PlaceSchema.parse({
    id: "origin",
    name,
    lng,
    lat,
    category: "other",
    openTime: null,
    closeTime: null,
    closedDays: [],
    rating: null,
    avgCost: 0,
    source: "manual",
    lastVerified: todayIsoDate(),
  });
}

/**
 * 返程终点也不是 POI，不进候选池。
 * 固定 id "destination"：只在「用户自定义终点」时出现；默认回到起点时终点就是 origin 本身。
 * 坐标由 /api/plan 用高德 geocode 解析，名称用用户填写的地址文本（不做任何编造）。
 */
export function makeDestinationPlace(lng: number, lat: number, name: string): Place {
  return PlaceSchema.parse({
    id: "destination",
    name,
    lng,
    lat,
    category: "other",
    openTime: null,
    closeTime: null,
    closedDays: [],
    rating: null,
    avgCost: 0,
    source: "manual",
    lastVerified: todayIsoDate(),
  });
}
