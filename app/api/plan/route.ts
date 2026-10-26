import { NextResponse } from "next/server";
import { z } from "zod";
import { geocode } from "@/lib/amap";
import { loadCity, resolveCityId } from "@/lib/cityData";
import type { CityData } from "@/lib/cityData";
import { findUpcomingEventsForPlaces } from "@/lib/events";
import { makeDestinationPlace, makeOriginPlace } from "@/lib/origin";
import { buildItinerary } from "@/lib/planner";
import { TravelProfileSchema } from "@/lib/profile";
import type { TravelProfile } from "@/lib/profile";
import { generateItineraryText, hasBannedHits, loadOneLinerPrompt } from "@/lib/llmText";
import { ItinerarySchema } from "@/types/schema";
import type { Itinerary, Place, StopEvent } from "@/types/schema";

/**
 * 城市数据模块化：首屏按钮唯一的后端入口。
 *
 * POST { city?, latitude?, longitude?, originAddress?, destinationAddress?, homeBy?, durationMin?, wholeDay?, nowMinute?, budget?, seed?, excludePlaceIds?, profile? }
 *   → Itinerary（200）| { ok:false, reason }（200）
 *
 * 三条硬约束：
 * 1. 地点只读 data/cities/<city>.json（服务端读文件 + zod 校验，不在前端生成任何地点）；
 * 2. 排不出来时返回 HTTP 200 + { ok:false, reason }，绝不返回 500（M5 3.4：界面要能显示「排不出来」）；
 * 3. 时间运算全部交给 lib/planner.ts 的整数分钟逻辑，本文件不做任何排程判断。
 *
 * 城市参数：city 省略时默认读 process.env.ACTIVE_CITY（再没有就用城市索引里的第一个）；
 * 城市数据里的 origin 是该城市的演示起点，调用方没带 latitude / longitude 时用它。
 * 参数非法（不是合法 JSON / 字段类型不对 / 未知城市 / 坐标只给了一半）按契约返回 400 + { ok:false, reason }
 * （M13 3.4 的口径），这属于「请求打错了」，不是「今天排不出来」。
 *
 * 本轮新增（返程 / 自定义端点 / 到家时间）：
 * - originAddress：起点地址，与 latitude/longitude 二选一；用高德 geocode 转坐标，转不出来就
 *   如实返回「没找到这个地址」，绝不退回城市默认起点（铁律：不猜）；
 * - destinationAddress：终点地址，不传 = 回到起点（默认）。坐标同样只来自 geocode；
 * - homeBy：几点到家（当日分钟数）。倒排时长、少站、极端情况返回「不够走一趟」都在 planner 里算，
 *   本文件只负责把参数原样传下去。
 */

const PlanRequestSchema = z
  .object({
    /** 城市 id（data/cities/<city>.json 的文件名）；省略 = 服务端默认城市。 */
    city: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/, "城市 id 只能是小写字母、数字和连字符")
      .max(64)
      .optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    /** 起点地址（本轮新增，可选）：与 latitude/longitude 二选一；不传 = 用城市演示起点。 */
    originAddress: z.string().max(80).optional(),
    /** 终点地址（本轮新增，可选）：不传 = 回到起点（默认）。 */
    destinationAddress: z.string().max(80).optional(),
    /** 几点到家（本轮新增，可选）：当日分钟数整数（1080 = 18:00）；不传 = 不限制时长。 */
    homeBy: z.number().int().min(0).max(1439).optional(),
    /** 当日分钟数整数（920 = 15:20）；不传 = 用服务器当前时刻。 */
    nowMinute: z.number().int().min(0).max(1439).optional(),
    budget: z.number().min(0).optional(),
    /** 任务1（可选）：想走多久（分钟，1–720）；不传 = 自动。与 wholeDay 互斥（同时传 → 400）。 */
    durationMin: z.number().int().min(1).max(720).optional(),
    /** 任务1（可选）：一整天（不套 maxTotalMin 上限）；不传 = 自动。与 durationMin 互斥。 */
    wholeDay: z.boolean().optional(),
    /**
     * 随机种子（本轮新增，可选）：「再来一条」用。
     * 传了 → 同一组条件会给出一条不同但同样合规的路线（同一个 seed 结果可复现）；
     * 不传 → 完全确定性，既有行为逐字不变（首屏「现在就走」不传）。
     */
    seed: z.number().int().min(0).max(2_147_483_647).optional(),
    /**
     * 「再来一条」可选（本轮扩展）：本会话已经出现过的 stops placeId 列表（**所有站**都避开）。
     * 页面发送「最近 24 个」；上限 24（约 6 轮 × 4 站）。不传 = 不排除（旧行为逐字不变）。
     */
    excludePlaceIds: z.array(z.string().min(1)).max(24).optional(),
    /**
     * M18（本轮新增，可选）：出行画像（开屏问答的结果），形状与 lib/profile.ts 的 TravelProfile 一致。
     * 用 lib/profile.ts 的同一个 zod schema 校验：坏数据 → 400 人话（路径会写成 profile.xxx）。
     * 不传 = 与改造前逐字一致（originAddress / latitude+longitude / 城市默认起点、homeBy 的老优先级照旧）。
     */
    profile: TravelProfileSchema.optional(),
  })
  .refine((value) => (value.latitude === undefined) === (value.longitude === undefined), {
    message: "latitude 和 longitude 必须同时提供",
    path: ["latitude"],
  })
  .refine(
    (value) =>
      value.originAddress === undefined ||
      value.originAddress.trim() === "" ||
      (value.latitude === undefined && value.longitude === undefined),
    { message: "originAddress 与 latitude/longitude 只能二选一", path: ["originAddress"] },
  )
  .refine((value) => !(value.durationMin !== undefined && value.wholeDay === true), {
    message: "durationMin 和 wholeDay 不能同时提供",
    path: ["durationMin"],
  });

type PlanRequest = z.infer<typeof PlanRequestSchema>;

type ResolvedCity = { city: CityData } | { failure: { status: number; reason: string } };

/**
 * 解析并加载城市数据。
 * - 调用方显式传了 city：找不到就是「请求参数不合法」→ 400；
 * - 走服务端默认城市：配置 / 数据文件有问题算服务端问题 → 200 + 原因（界面仍能显示「排不出来」）。
 */
function resolveCity(body: PlanRequest): ResolvedCity {
  const requested = body.city === undefined ? undefined : body.city.trim();
  try {
    return { city: loadCity(resolveCityId(requested)) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (requested !== undefined) {
      return { failure: { status: 400, reason: `请求参数不合法：${message}` } };
    }
    console.error(`[api/plan] 默认城市数据加载失败：${message}`);
    return { failure: { status: 200, reason: `城市数据加载失败：${message}` } };
  }
}

/** 本机当前时刻的「当日分钟数」（15:20 → 920）。 */
function currentMinuteOfDay(): number {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

function failureResponse(reason: string, status: number) {
  return NextResponse.json({ ok: false as const, reason }, { status });
}

/** 地址解析结果：成功给坐标；失败给一句能直接展示的人话。 */
type ResolvedAddress = { lng: number; lat: number } | { failure: string };

/**
 * 地址 → 坐标（只走高德 geocode，不猜）。
 *
 * - 查不到（geocodes 为空 / 没有合法 location）→「没找到这个地址：xxx」；
 * - 接口异常（网络 / 配额 / status≠1）→ 如实说地址解析失败，不退回默认起点。
 * 调用方（前端）把 reason 原样展示给用户。
 */
async function resolveAddress(address: string, city: CityData, label: string): Promise<ResolvedAddress> {
  const trimmed = address.trim();
  try {
    const coords = await geocode(trimmed, city.transferCityName);
    if (coords === null) return { failure: `没找到这个地址：${trimmed}` };
    return { lng: coords.lng, lat: coords.lat };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 高德对「完全转不出来」的地址返回 status=0 / ENGINE_RESPONSE_DATA_ERROR（引擎报数据错误），
    // 语义就是「这个地址转不出坐标」——按「没找到」如实告诉用户，不退回默认起点、不猜一个坐标。
    if (message.indexOf("ENGINE_RESPONSE_DATA_ERROR") !== -1) {
      console.error(`[api/plan] ${label}地址转不出坐标（${trimmed}）：${message}`);
      return { failure: `没找到这个地址：${trimmed}` };
    }
    console.error(`[api/plan] ${label}地址解析失败（${trimmed}）：${message}`);
    return { failure: `${label}地址解析失败：「${trimmed}」，请稍后再试` };
  }
}

/** 把 zod 的报错拼成一句人话（字段名 + 原因），不把整个 ZodError 丢给前端。 */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length === 0 ? "请求体" : issue.path.join(".")} ${issue.message}`)
    .join("；");
}

/**
 * 本轮新增：给行程站点挂「只做展示」的两个可选字段（importance / upcomingEvent）。
 *
 * 铁律：这两个字段**绝不参与排程**——planner 返回的 stops 原样保留，这里只读地补字段；
 * 活动文件读失败也不许让行程变成「排不出来」：降级为「本次没有活动可展示」，只打错误日志
 * （展示是可选增强，不能拖垮首屏；否则一次坏数据就会让整个产品不可用）。
 *
 * 时间比较全部在服务端（lib/events.ts），nowMinute 就是本份行程的「现在」，
 * 与页面上「现在是 15:20」同一口径；前端只渲染格式化好的 "HH:mm" 和文案，不做任何时间判断。
 */
function attachDisplayFields(city: CityData, itinerary: Itinerary, nowMinute: number): Itinerary {
  const placeById = new Map(city.places.map((place) => [place.id, place]));
  let eventsByPlace = new Map<string, StopEvent>();
  try {
    eventsByPlace = findUpcomingEventsForPlaces(
      city.city,
      itinerary.stops.map((stop) => stop.placeId),
      nowMinute,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[api/plan] 活动数据读取失败，本次不展示活动（排程不受影响）：${message}`);
  }

  const stops = itinerary.stops.map((stop) => {
    const place = placeById.get(stop.placeId);
    const event = eventsByPlace.get(stop.placeId);
    const importance = place === undefined ? undefined : place.importance;
    return {
      ...stop,
      // 没标星 / 没活动 → 不写字段（卡片按「不展示」处理，不留占位）。
      ...(importance === undefined ? {} : { importance }),
      ...(event === undefined ? {} : { upcomingEvent: event }),
    };
  });
  // 铁律 4：返回值必须过 zod；两个新增字段都是可选的，旧调用方完全不受影响。
  return ItinerarySchema.parse({ ...itinerary, stops });
}

/** 文案生成超时（M6：8 秒，失败就降级；主链路等不起太久）。 */
const ONE_LINER_TIMEOUT_MS = 8000;

/**
 * 文案控制台/文案生成（本轮新增）：给已排好的行程挂 LLM 文案（oneLiner + 每站一句）。
 *
 * 三条降级铁律（文案是可选增强，绝不能拖垮首屏）：
 * 1. prompt 文件缺失 / 损坏 → 不生成（不用「操作者以为改过、实际没生效」的默认值产出用户可见文案），
 *    行程照常返回，只是不带文案字段（对应验收「文件坏了不崩」）；
 * 2. LLM 超时 / 没配置 / 返回结构不合法 → 不挂文案字段，只打日志；
 * 3. 生成的句子命中禁止词 → 不把坏文案回给用户（禁止词检查在 lib/llmText.ts 的服务端做）。
 *
 * 排程结果（stops / 时间 / 花费 / segments）一个字节都不改，本函数只在最后补两个可选字段。
 */
async function attachOneLiner(itinerary: Itinerary): Promise<Itinerary> {
  const loaded = loadOneLinerPrompt();
  if (loaded.source !== "file") {
    console.warn(
      `[api/plan] 文案 prompt 文件不可用，本次不生成文案（行程不受影响）：${loaded.fallbackReason ?? "回退内置默认值"}`,
    );
    return itinerary;
  }

  const result = await generateItineraryText(itinerary, {
    promptContent: loaded.prompt,
    promptSource: "file",
    promptVersion: loaded.prompt.version,
    timeoutMs: ONE_LINER_TIMEOUT_MS,
    // 首屏速度优先：deepseek-flash 是 reasoning 模型，开思考可能 3–20 秒，这里关掉（约 1–2 秒）。
    disableReasoning: true,
    maxTokens: 1200,
  });
  if (result.status === "failure") {
    console.warn(`[api/plan] 文案生成失败，已降级（行程不受影响）：${result.reason}（${result.elapsedMs} ms）`);
    return itinerary;
  }
  if (hasBannedHits(result)) {
    const hits = Array.from(
      new Set([...result.oneLiner.bannedHits, ...result.stopLines.flatMap((line) => line.bannedHits)]),
    );
    console.warn(`[api/plan] 文案命中禁止词（${hits.join("、")}），本次不返回文案（行程不受影响）`);
    return itinerary;
  }

  console.log(
    `[api/plan] 文案生成 ok：耗时 ${result.elapsedMs} ms（prompt v${loaded.prompt.version}，${result.stopLines.length} 条 stopLines）`,
  );
  // 每个 stop 也带上自己的一句（卡片/展开列表按 stop.oneLine 渲染；index 已与 stops 对齐）。
  const oneLineByIndex = new Map(result.stopLines.map((line) => [line.index, line.text]));
  // 铁律 4：返回前整体再过一次 zod（oneLiner / stopLines / stop.oneLine 都是新增可选字段）。
  return ItinerarySchema.parse({
    ...itinerary,
    oneLiner: result.oneLiner.text,
    stopLines: result.stopLines.map((line) => line.text),
    stops: itinerary.stops.map((stop, index) => {
      const oneLine = oneLineByIndex.get(index);
      return oneLine === undefined ? stop : { ...stop, oneLine };
    }),
  });
}

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return failureResponse("请求体不是合法 JSON", 400);
  }

  const parsed = PlanRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return failureResponse(`请求参数不合法：${describeIssues(parsed.error)}`, 400);
  }
  const body: PlanRequest = parsed.data;

  const resolved = resolveCity(body);
  if ("failure" in resolved) {
    return failureResponse(resolved.failure.reason, resolved.failure.status);
  }
  const city = resolved.city;

  const nowMinute = body.nowMinute === undefined ? currentMinuteOfDay() : body.nowMinute;
  const budget = body.budget === undefined ? city.thresholds.defaultBudget : body.budget;
  const originAddress = body.originAddress === undefined ? "" : body.originAddress.trim();
  const destinationAddress = body.destinationAddress === undefined ? "" : body.destinationAddress.trim();
  // M18：画像（可选）。下面只做契约里的三项兜底：起点 / 几点到家 / 交给 planner 调参。
  const profile: TravelProfile | undefined = body.profile;
  // 几点到家优先级（契约 §2.2）：body.homeBy 优先；否则用画像里的 homeBy（null = 不限制 → 不传）。
  const homeBy =
    body.homeBy !== undefined
      ? body.homeBy
      : profile === undefined || profile.homeBy === null
        ? undefined
        : profile.homeBy;

  // 起点优先级：自定义地址（geocode）> 调用方坐标（接真实定位用）> 画像里的起点 > 城市演示起点。
  // （契约 §2.1：用户临时改起点仍然生效；只有两者都没有时才用 profile.origin。）
  let origin: Place;
  if (originAddress !== "") {
    const address = await resolveAddress(originAddress, city, "起点");
    if ("failure" in address) return failureResponse(address.failure, 200);
    origin = makeOriginPlace(address.lng, address.lat, originAddress);
  } else if (body.latitude !== undefined && body.longitude !== undefined) {
    origin = makeOriginPlace(body.longitude, body.latitude);
  } else if (profile !== undefined) {
    origin = makeOriginPlace(profile.origin.lng, profile.origin.lat, profile.origin.label);
  } else {
    origin = makeOriginPlace(city.origin.longitude, city.origin.latitude);
  }

  // 终点：不传 = 回到起点（planner 里 destination 省略时默认 origin）。
  let destination: Place | undefined;
  if (destinationAddress !== "") {
    const address = await resolveAddress(destinationAddress, city, "终点");
    if ("failure" in address) return failureResponse(address.failure, 200);
    destination = makeDestinationPlace(address.lng, address.lat, destinationAddress);
  }

  const startedAt = Date.now();
  try {
    const result = await buildItinerary(origin, nowMinute, {
      budget,
      maxTotalMin: city.thresholds.maxTotalMin,
      sunsetMinute: city.thresholds.sunsetMinute,
      // 夜间修复：当天硬性结束上限（默认 1410 = 23:30，城市配置可覆盖）。
      lastEndMinute: city.thresholds.lastEndMinute,
      // 公交算路必须带城市码（data/cities/<city>.json 的 cityCode）：杭州 0571 / 辽阳 0419。
      cityCode: city.cityCode,
      pool: city.places,
      // 本轮新增（都可选）：自定义终点 / 几点到家；不传时与改造前逐字一致。
      destination,
      // M18：homeBy 已按契约合并（body 优先、画像兜底）；profile 作为第 4 个参数交给 planner 调参。
      homeBy,
      // 任务1（都可选）：想走多久 / 一整天；不传 = 自动（15:20 自动 → 4 站）。
      durationMin: body.durationMin,
      wholeDay: body.wholeDay,
      // 「再来一条」的随机种子；不传 = 完全确定性（首屏「现在就走」走这条路）。
      seed: body.seed,
      // 「再来一条」：本会话出现过的全部站点（服务端所有站都避开）；不传 = 旧行为逐字不变。
      excludePlaceIds: body.excludePlaceIds,
    }, profile);
    const elapsedMs = Date.now() - startedAt;

    if ("ok" in result) {
      console.log(
        `[api/plan] city=${city.city} ok:false 耗时 ${elapsedMs} ms（now=${nowMinute}，budget=${budget}` +
          `${destinationAddress === "" ? "" : `，终点=${destinationAddress}`}${body.homeBy === undefined ? "" : `，homeBy=${body.homeBy}`}）：${result.reason}`,
      );
      // 排不出来不是服务器错误：200 + 原因，界面负责把它显示成人话（M5 3.5）。
      return failureResponse(result.reason, 200);
    }

    console.log(
      `[api/plan] city=${city.city} ok:true 耗时 ${elapsedMs} ms（now=${nowMinute}，budget=${budget}，` +
        `${result.stops.length} 站，候选 ${city.places.length} 个，endAt=${result.endAt}，segments=${result.segments.length}` +
        `${profile === undefined ? "" : `，profile=${profile.style}/${profile.scene}`}）`,
    );
    // 展示字段在排程完成之后才挂上去：排程结果（placeId 列表 / 时间 / 花费）一个字节都不改。
    const itinerary = attachDisplayFields(city, result, nowMinute);
    // 文案是最后一步可选增强：失败 / 命中禁止词 / prompt 文件不可用都只降级，绝不影响行程本身。
    return NextResponse.json(await attachOneLiner(itinerary), { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const elapsedMs = Date.now() - startedAt;
    console.error(`[api/plan] city=${city.city} 排程抛错（耗时 ${elapsedMs} ms）：${message}`);
    // M5 3.4：外部失败也不许 500，界面必须还能正常渲染「排不出来」。
    return failureResponse(message, 200);
  }
}
