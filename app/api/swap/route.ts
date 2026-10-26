import { NextResponse } from "next/server";
import { z } from "zod";
import { loadCity, resolveCityId } from "@/lib/cityData";
import type { CityData } from "@/lib/cityData";
import { findUpcomingEventsForPlaces } from "@/lib/events";
import { makeOriginPlace } from "@/lib/origin";
import { replaceStop, SwapActionSchema } from "@/lib/planner";
import { ItinerarySchema } from "@/types/schema";
import type { Itinerary, Place, StopEvent } from "@/types/schema";

/**
 * 城市数据模块化：M7「换一个 / 不感兴趣」的唯一后端入口。
 *
 * POST { itinerary, stopIndex, action, city?, latitude?, longitude?, budget?, swapHistory? }
 *   → 新的 Itinerary（200）| { ok:false, reason }（200，换不出来）
 *
 * 三条硬约束：
 * 1. 只替换 stopIndex 这一站；其余站点的 placeId 与顺序完全不变（时间由 planner 重算）。
 * 2. 地点只来自 data/cities/<city>.json（服务端读文件 + zod 校验）；本文件不生成任何地点，也不做任何排程判断。
 * 3. 参数非法按契约返回 400 + { ok:false, reason }；「换不出来」是 200 + 原因（不是 500）。
 *
 * city 省略时默认读 process.env.ACTIVE_CITY（再没有就用城市索引里的第一个），
 * 必须与生成这份行程的城市一致，否则候选池对不上。
 *
 * 两个可选参数是给「替换第 1 站」和「预算」用的：
 * - latitude / longitude：第 1 站的上一段是「起点 → 第 1 站」，起点不在 itinerary 里；
 *   不传时用城市数据里的 origin（页面就是这么调的），传了就用传入的坐标。
 * - budget：Itinerary 契约里没有预算字段（M0 冻结，不许改），所以由调用方带上原始预算；
 *   不传时按「总花费不能比原来多」处理（budget = itinerary.totalCost）。
 * - swapHistory：页面维护的「本次会话已经换出过的 placeId」。带上来后这些点不再参与候选，
 *   连点「换一个」不会 A→B→A 来回跳。只影响这一次请求，不落盘（仅本次会话内存）。
 *
 * action 的两种信号严格分开：
 * - reroll：中性的「换一个」，只调用 planner.replaceStop，**不碰** preference 的任何写方法；
 * - dislike：先把该类目权重 × 0.2（lib/preference.ts，仅本次会话内存），再替换。
 *
 * M7 的偏好只在内存里（进程重启即清空）；落盘是 M12 的事，这里不写任何文件。
 */

const SwapRequestSchema = z
  .object({
    itinerary: ItinerarySchema,
    stopIndex: z.number().int().min(0),
    action: SwapActionSchema,
    /** 城市 id（data/cities/<city>.json 的文件名）；省略 = 服务端默认城市。 */
    city: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/, "城市 id 只能是小写字母、数字和连字符")
      .max(64)
      .optional(),
    /** 只有替换第 1 站时可能用到：起点的纬度 / 经度；不传 = 用城市数据里的 origin。 */
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    /** 原始预算（元）；不传 = 用 itinerary.totalCost。 */
    budget: z.number().min(0).optional(),
    /** 本次会话已经换出过的 placeId（页面维护；只用于避免连点来回跳，不落盘）。 */
    swapHistory: z.array(z.string().min(1)).max(200).optional(),
  })
  .strict()
  .refine((value) => (value.latitude === undefined) === (value.longitude === undefined), {
    message: "latitude 和 longitude 必须同时提供",
    path: ["latitude"],
  });

type SwapRequest = z.infer<typeof SwapRequestSchema>;

type ResolvedCity = { city: CityData } | { failure: { status: number; reason: string } };

/** 解析并加载城市数据（与 /api/plan 同一口径：显式 city 找不到 → 400；默认城市坏了 → 200 + 原因）。 */
function resolveCity(body: SwapRequest): ResolvedCity {
  const requested = body.city === undefined ? undefined : body.city.trim();
  try {
    return { city: loadCity(resolveCityId(requested)) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (requested !== undefined) {
      return { failure: { status: 400, reason: `请求参数不合法：${message}` } };
    }
    console.error(`[api/swap] 默认城市数据加载失败：${message}`);
    return { failure: { status: 200, reason: `城市数据加载失败：${message}` } };
  }
}

function failureResponse(reason: string, status: number) {
  return NextResponse.json({ ok: false as const, reason }, { status });
}

/** 把 zod 的报错拼成一句人话（字段名 + 原因），不把整个 ZodError 丢给前端。 */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length === 0 ? "请求体" : issue.path.join(".")} ${issue.message}`)
    .join("；");
}

/**
 * 本轮新增：给换站后的行程补展示字段（importance / upcomingEvent），与 /api/plan 完全同一套逻辑。
 *
 * - 「现在」用 itinerary.startAt：Itinerary 的 startAt 就是这份行程的 nowMinute（与 /api/plan
 *   的入参一致），换站后卡片文案才不会跟首屏「现在是 15:20」打架；
 * - 只读补字段，不碰 planner 的结果（铁律：活动 / 重要性都不参与排程）；
 * - 活动数据读失败只降级成「不展示活动」，换站本身照常返回（展示不能拖垮主流程）。
 */
function attachDisplayFields(city: CityData, itinerary: Itinerary): Itinerary {
  const placeById = new Map(city.places.map((place) => [place.id, place]));
  let eventsByPlace = new Map<string, StopEvent>();
  try {
    eventsByPlace = findUpcomingEventsForPlaces(
      city.city,
      itinerary.stops.map((stop) => stop.placeId),
      itinerary.startAt,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[api/swap] 活动数据读取失败，本次不展示活动（换站不受影响）：${message}`);
  }
  const stops = itinerary.stops.map((stop) => {
    const place = placeById.get(stop.placeId);
    const event = eventsByPlace.get(stop.placeId);
    const importance = place === undefined ? undefined : place.importance;
    return {
      ...stop,
      ...(importance === undefined ? {} : { importance }),
      ...(event === undefined ? {} : { upcomingEvent: event }),
    };
  });
  return ItinerarySchema.parse({ ...itinerary, stops });
}

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return failureResponse("请求体不是合法 JSON", 400);
  }

  const parsed = SwapRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return failureResponse(`请求参数不合法：${describeIssues(parsed.error)}`, 400);
  }
  const body: SwapRequest = parsed.data;
  const { itinerary, stopIndex, action } = body;

  if (stopIndex >= itinerary.stops.length) {
    return failureResponse(
      `请求参数不合法：stopIndex ${stopIndex} 超出范围（这份行程只有 ${itinerary.stops.length} 站）`,
      400,
    );
  }

  const resolved = resolveCity(body);
  if ("failure" in resolved) {
    return failureResponse(resolved.failure.reason, resolved.failure.status);
  }
  const city = resolved.city;
  const pool: Place[] = city.places;

  // 起点：第 1 站的上一段必须从起点出发。itinerary 里没有起点坐标，
  // 所以优先用 itinerary.origin 快照（自定义起点时 /api/plan 会带上）；
  // 老行程没有快照时用调用方带上来的 latitude / longitude，再没有就用该城市的演示起点。
  const originId = itinerary.segments[0].fromId;
  let origin: Place;
  if (originId === "origin") {
    if (itinerary.origin !== undefined) {
      origin = makeOriginPlace(itinerary.origin.lng, itinerary.origin.lat, itinerary.origin.name);
    } else {
      const longitude = body.longitude === undefined ? city.origin.longitude : body.longitude;
      const latitude = body.latitude === undefined ? city.origin.latitude : body.latitude;
      origin = makeOriginPlace(longitude, latitude);
    }
  } else {
    const originPlace = pool.filter((place) => place.id === originId)[0];
    if (originPlace === undefined) {
      return failureResponse(`这份行程的起点 ${originId} 不在候选池里，无法只替换一站`, 400);
    }
    origin = originPlace;
  }

  const budget = body.budget === undefined ? itinerary.totalCost : body.budget;
  const startedAt = Date.now();
  try {
    const result = await replaceStop(itinerary, stopIndex, action, {
      origin,
      pool,
      budget,
      avoidPlaceIds: body.swapHistory === undefined ? [] : body.swapHistory,
      sunsetMinute: city.thresholds.sunsetMinute,
      // 公交算路必须带城市码（与 /api/plan 同一口径）。
      cityCode: city.cityCode,
    });
    const elapsedMs = Date.now() - startedAt;

    if ("ok" in result) {
      console.log(
        `[api/swap] city=${city.city} action=${action} stopIndex=${stopIndex} ok:false 耗时 ${elapsedMs} ms：${result.reason}`,
      );
      // 「换不出来」不是服务器错误：200 + 原因，界面负责显示成人话。
      return failureResponse(result.reason, 200);
    }

    console.log(
      `[api/swap] city=${city.city} action=${action} stopIndex=${stopIndex} ok:true 耗时 ${elapsedMs} ms（${result.stops.length} 站）`,
    );
    // 展示字段在替换完成之后才挂：替换结果（placeId / 时间）一个字节都不改。
    return NextResponse.json(attachDisplayFields(city, result), { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const elapsedMs = Date.now() - startedAt;
    console.error(`[api/swap] city=${city.city} 替换抛错（耗时 ${elapsedMs} ms）：${message}`);
    // 外部失败也不许 500，界面必须还能正常渲染「排不出来」。
    return failureResponse(message, 200);
  }
}
