import { ItinerarySchema } from "@/types/schema";
import type { Itinerary } from "@/types/schema";

/**
 * 文案控制台（/admin/prompt）预览用的固定样例行程。
 *
 * 来源：/api/plan 对辽阳（city=liaoyang, nowMinute=920, budget=200）的真实返回，
 * 三站正是任务书点名的 鑫语书店(八一街店) / U咪Coffee&Bar / 李先生牛肉面餐厅(辽阳东兴路餐厅)，
 * 时间、花费、reason、路段全部逐字取自那次响应，不是手编的假数据。
 *
 * 用途：POST /api/admin/prompt?action=preview 时，服务端固定用这份行程 + 请求体里的
 * 「正在编辑的 prompt」调一次 LLM，因此调 prompt 时看到的输出与真实行程的输入分布一致。
 *
 * 铁律：本文件只提供预览输入，不参与排程；里面没有任何编造的地点 / 时间 / 花费。
 * 形状由 ItinerarySchema 在模块加载时校验一次，坏数据会让构建直接失败（不兜底修补）。
 */

/** 预览行程所在城市名（只做展示，例如「辽阳 · 15:20 出发」）。 */
export const SAMPLE_ITINERARY_CITY = "辽阳";

const SAMPLE_ITINERARY_RAW = {
  startAt: 920,
  endAt: 1122,
  totalMin: 202,
  totalCost: 113,
  stops: [
    {
      placeId: "B0HRCZKQIF",
      placeName: "鑫语书店(八一街店)",
      lng: 123.184339,
      lat: 41.249797,
      arriveAt: 923,
      leaveAt: 983,
      stayMin: 60,
      reason: "评分 4.3，步行 3 分钟能到，人均未标注",
      costEstimate: 0,
      placeCloseTime: "21:00",
    },
    {
      placeId: "B0KR4Z14IU",
      placeName: "U咪Coffee&Bar",
      lng: 123.191525,
      lat: 41.249917,
      arriveAt: 992,
      leaveAt: 1037,
      stayMin: 45,
      reason: "评分 4.5，步行 9 分钟能到，人均 84 在预算内",
      costEstimate: 84,
      placeCloseTime: "22:00",
    },
    {
      placeId: "B0FFIJKINQ",
      placeName: "李先生牛肉面餐厅(辽阳东兴路餐厅)",
      lng: 123.190813,
      lat: 41.254537,
      arriveAt: 1045,
      leaveAt: 1105,
      stayMin: 60,
      reason: "评分 4.3，步行 8 分钟能到，人均 29 在预算内",
      costEstimate: 29,
      meal: {
        waitMin: 0,
        waitLevel: "low",
        waitText: "这个点人少",
        bookingText: null,
        bookingUrl: null,
        people: 1,
        dishText: "1 份主食 + 1 个小菜",
        perPersonCost: 29,
      },
      placeCloseTime: "22:00",
    },
  ],
  segments: [
    { fromId: "origin", toId: "B0HRCZKQIF", mode: "walk", durationMin: 3, distanceM: 215 },
    { fromId: "B0HRCZKQIF", toId: "B0KR4Z14IU", mode: "walk", durationMin: 9, distanceM: 674 },
    { fromId: "B0KR4Z14IU", toId: "B0FFIJKINQ", mode: "walk", durationMin: 8, distanceM: 619 },
    { fromId: "B0FFIJKINQ", toId: "origin", mode: "walk", durationMin: 17, distanceM: 1248 },
  ],
  origin: { placeId: "origin", name: "出发地", lng: 123.184017, lat: 41.247878 },
  destination: { placeId: "origin", name: "出发地", lng: 123.184017, lat: 41.247878 },
};

/** 固定样例行程（已过 zod 校验的只读对象；调用方不要修改）。 */
export const SAMPLE_ITINERARY: Itinerary = ItinerarySchema.parse(SAMPLE_ITINERARY_RAW);
