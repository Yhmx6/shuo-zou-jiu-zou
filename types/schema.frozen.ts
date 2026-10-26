import { z } from "zod";

/**
 * 数据契约（M0 冻结，之后只允许新增可选字段）。
 * 所有时间一律是「当日分钟数整数」：920 = 15:20。不允许出现字符串时间。
 */

export const PlaceCategorySchema = z.enum([
  "bookstore",
  "museum",
  "gallery",
  "theater",
  "market",
  "park",
  "mall",
  "restaurant",
  "cafe",
  "other",
]);

export const PlaceSourceSchema = z.enum(["amap", "seed", "manual"]);

export const SegmentModeSchema = z.enum(["walk", "bus", "drive", "bike"]);

/** 地点。只能来自高德 API 或 data/seed-places.json，不允许凭空生成。 */
export const PlaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  lng: z.number(),
  lat: z.number(),
  category: PlaceCategorySchema,
  /** "HH:mm"；与 closeTime 同时为 null 表示全天开放 */
  openTime: z.string().nullable(),
  closeTime: z.string().nullable(),
  /** 每周休息的星期，0 = 周日 */
  closedDays: z.array(z.number().int().min(0).max(6)),
  rating: z.number().nullable(),
  /** 人均消费（元） */
  avgCost: z.number().nullable(),
  source: PlaceSourceSchema,
  /** 最后核验日期，"YYYY-MM-DD" */
  lastVerified: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/** 两点之间的一段路。durationMin 是整数分钟。 */
export const SegmentSchema = z.object({
  fromId: z.string().min(1),
  toId: z.string().min(1),
  mode: SegmentModeSchema,
  durationMin: z.number().int().min(0),
  distanceM: z.number().min(0),
});

/** 行程中的一站。arriveAt / leaveAt 是当日分钟数整数。 */
export const StopSchema = z.object({
  placeId: z.string().min(1),
  arriveAt: z.number().int(),
  leaveAt: z.number().int(),
  stayMin: z.number().int().min(0),
  reason: z.string().min(1),
  costEstimate: z.number().min(0),
});

/** 一份完整行程。startAt / endAt / totalMin 均为当日分钟数或分钟数整数。 */
export const ItinerarySchema = z.object({
  startAt: z.number().int(),
  endAt: z.number().int(),
  totalMin: z.number().int().min(0),
  totalCost: z.number().min(0),
  stops: z.array(StopSchema),
  segments: z.array(SegmentSchema),
});

export type PlaceCategory = z.infer<typeof PlaceCategorySchema>;
export type PlaceSource = z.infer<typeof PlaceSourceSchema>;
export type SegmentMode = z.infer<typeof SegmentModeSchema>;

export type Place = z.infer<typeof PlaceSchema>;
export type Segment = z.infer<typeof SegmentSchema>;
export type Stop = z.infer<typeof StopSchema>;
export type Itinerary = z.infer<typeof ItinerarySchema>;
