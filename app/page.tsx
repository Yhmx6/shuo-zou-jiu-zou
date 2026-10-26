"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import AmapRouteMap from "@/components/AmapRouteMap";
import Onboarding from "@/components/Onboarding";
import Reason from "@/components/Reason";
import RestaurantCard from "@/components/RestaurantCard";
import RouteCard from "@/components/RouteCard";
import StartButton from "@/components/StartButton";
import TravelingView from "@/components/TravelingView";
import { whenAmapSdkSettled } from "@/lib/amapSdk";
import {
  clearCachedGeo,
  GEOLOCATION_ENABLED,
  GEO_CITY_MAX_DISTANCE_M,
  isGeoInCity,
  locateOnce,
  readCachedGeo,
} from "@/lib/geolocation";
import type { GeoPosition } from "@/lib/geolocation";
import { parseClockMinute } from "@/lib/constraints";
import { readProfileFromStorage, saveProfile } from "@/lib/profile";
import type { TravelProfile } from "@/lib/profile";
import { roadPrefix } from "@/lib/roadText";
import {
  clearTripFromStorage,
  isTravelingTripFresh,
  readTripFromStorage,
  saveTrip,
} from "@/lib/trip";
import type { PlannedTrip, TravelingTrip, TripState } from "@/lib/trip";
import { ItinerarySchema } from "@/types/schema";
import type { Itinerary, Segment, SegmentMode, StopEvent } from "@/types/schema";

/**
 * M5 首屏：只有「一行状态 + 一个按钮」，点击后出第一站卡片，后续站点默认折叠。
 *
 * 职责边界（STRUCTURE.md 分层）：
 * - 页面只负责取数 / 格式化 / 渲染，排程全部在服务端 /api/plan（lib/planner.ts）；
 * - 页面不生成任何地点：地点名 / 坐标 / 闭馆时刻只读行程站点自带的
 *   placeName / lng / lat / placeCloseTime（由 lib/planner.ts 在返回前填好；
 *   页面不再静态 import 任何地点数据文件）；
 * - 时间仍是整数分钟，只在渲染时格式化成 "HH:mm"。
 *
 * M7 追加（本轮）：
 * - 卡片和每一站的「换一个 / 不感兴趣」都真的接上了 /api/swap：只替换那一站，
 *   成功时用返回的整份 Itinerary 覆盖状态（后续站点时间由服务端一起重算）；
 * - 套用前客户端再验一次时间闭合；「不感兴趣」换不回别类目时原样显示服务端文案；
 * - 请求带上本次会话已换出过的 placeId，避免连点「换一个」来回跳（仅内存，不落盘）。
 *
 * M8 追加：
 * - 结果区在第一站卡片下方加路线图；
 * - 行程普通 3 站、日落锚点场景最多 4 站，地图按 stops 数量画点，不写死站数；
 * - 日落锚点站（reason 里写明「赶得上 … 的日落」）在地图上换成太阳标记；
 * - 未点按钮时首屏仍然只有状态文字 + 按钮，地图不出现。
 *
 * M8 地图升级（本轮，用户直接要求）：
 * - 路线图从 SVG 示意图换成真实高德地图 + 沿道路的路线（AmapRouteMap）；
 * - 地图 SDK（@amap/amap-jsapi-loader）是 00-common 铁律 8 的明确例外，由用户批准；
 * - 原来的 SVG RouteMap 保留在组件内部做降级：SDK 加载失败 / 超时 / 某段路线算不出来时显示它，
 *   网络不好时页面不能是空白。
 *
 * 城市数据模块化（本轮）：
 * - 挂载后 GET /api/cities 拿城市列表：初始城市读 URL ?city=（window.location.search，
 *   不用 useSearchParams——App Router 静态渲染会要求 Suspense 包裹），没有就用接口给的 activeCity；
 * - 首屏状态行旁放原生 <select> 城市下拉（始终可见）：切城市时 history.replaceState 写回
 *   ?city=<id>，清空旧行程；切换前已有结果就自动用新城市重排一次，没有结果只更新选择；
 * - /api/plan 与 /api/swap 的请求体都带上 city，预算用所选城市的 thresholds.defaultBudget；
 * - 地图起点与「几点前出发」的闭馆时刻都改吃城市 / 站点自带数据，不再读静态地点表。
 *
 * 「更多选项」+ 返程（本轮，用户直接要求）：
 * - 首屏仍然只有「状态文字 + 按钮」，输入框收在按钮下方的折叠 <details>（默认收起）里：
 *   起点（空 = 当前位置）/ 终点（空 = 回到起点）/ 几点到家（空 = 不限制）/ 想走多久（默认自动）；
 * - 结果区底部再放同一个折叠面板，拿到行程后也能改这三个值；
 * - 三个值放 PlanOptions state，只有非空时才进 /api/plan 请求体（空串不发）；
 * - 已有行程时改值（地址 onBlur、时间 onChange，且值确实变了）自动用新值重排；
 *   重排期间保留旧行程，失败就提示原因、旧结果不丢（不把页面清空）；
 * - 返程：响应 segments 比 stops 多最后一段（末站 → 起点 / 自定义终点），endAt / totalMin 都含返程；
 * - 地图起点优先用响应里的 origin 快照（自定义起点时就是那个地址），否则用城市演示起点。
 *
 * 站点展示字段（本轮）：
 * - 第一站卡片与后续站点列表增加重要性星标，以及「19:00 有场话剧《雷雨》」这一行；
 * - importance / upcomingEvent 由服务端（/api/plan、/api/swap）从地点数据与活动文件里带下来，
 *   页面只从 itinerary.stops 原样透传，不做任何时间比较、也不参与打分（排程逻辑完全不受影响）；
 * - 两个字段都是可选的：没标星 / 没活动的站点不带字段，组件不渲染、不占位。
 *
 * 路线卡片导出（M11，本轮）：
 * - 第一站卡片下面加一个「保存这一天的卡片」按钮（components/RouteCard.tsx）；
 * - 点击后 lib/exportCard.ts 用 canvas 2D 手绘一张 1080×1920 PNG 并触发下载，纯前端、无截图库；
 * - 城市名从 /api/cities 的城市配置读（杭州 / 辽阳），页面只透传 selectedCity.displayName，
 *   卡片组件与绘制逻辑都不硬编码城市；
 * - 卡片画的是站点名的快照、不画任何底图 / 瓦片 / 坐标，「出发」标记不读取起点真实坐标。
 *
 * 本轮第二步（页面布局改版 + 启动页，只改本文件）：
 * - 布局：行程生成后从上到下 = 头部（日期 / 站数 · 时长 · 花费，stone-500）→ 站点列表
 *   （每站一行 `① 09:31  城市阳台` + 副行「走过去 11 分钟」，行间 stone-200 细线，返程单独一行
 *   `↩ 骑行 15 分钟回到起点`）→ 地图 → 文字导航；
 * - 文字导航仍由 AmapRouteMap 内部渲染（地图在上、导航在下），页面只把地图放在站点列表之后，
 *   不为了挪文字导航去改别人负责的组件（最小改动满足顺序要求）；
 * - 点站点行展开该站详情（reason 信息层 + oneLine 文案层 + 换一个 / 不感兴趣，另保留导航、
 *   星级、活动、餐厅信息），再点收起；150ms ease-out（grid-template-rows 过渡，无弹跳）；
 *   默认全部收起；
 * - 启动页：全屏白底覆盖层「说走就走 / 正在看看附近有什么」，
 *   等 `Promise.all([/api/cities 城市列表, whenAmapSdkSettled() 地图 SDK 就绪])` 完成 → 淡出 300ms；
 *   硬上限 2 秒（到点无条件淡出）；只在初次加载出现，生成行程期间不显示（按钮 loading）。
 *   覆盖层根元素带 data-splash="visible" | "fading"，淡出结束从 DOM 移除（验收以此为准）；
 * - 「不许动」：启动页消失后、未点击前，首屏仍然只有状态文字 + 按钮；城市切换 / 更多选项原样。
 *
 * M18（开屏问答 + 出行画像接入，本轮；任务书见 build/m18-contract.md §5）：
 * - 首次进入：客户端 effect 读 localStorage 里的 szjz.profile，读完之前渲染中性白屏占位
 *   （服务端渲染 / 首次客户端渲染一致，不闪问答、不闪主页）；
 * - 没有画像 → 整屏 <Onboarding/>（4 步问答），**问答期间不显示启动页**；
 *   有画像 → 直接走原有主页流程（启动页照旧，首屏逐字不变）；
 * - 问答完成：saveProfile → 存进 state → 进主页；首次进入时启动页在问答之后才出现，
 *   复用现有 splashPhase 机制（2 秒硬上限 + 300ms 淡出），只是计时起点改成「问答完成」；
 * - /api/plan 请求体带完整 profile（「再来一条」同样带，随机不许绕过画像约束）：
 *   profile 的 origin / homeBy 由服务端兜底，页面仍按老规则只在「更多选项」显式填了
 *   起点 / 终点 / 几点到家时才发那几个字段（用户临时改的优先级保持不变）；
 * - 「更多选项」里加「重新设置」：回到问答并允许取消；完成后覆盖画像，之前已有行程就用新画像
 *   自动重排一次（refresh 语义，旧行程保留到新结果回来）；取消则原样回到主页；
 * - 问答要拿到「当前城市」：手填地址带 city 调 /api/geocode（否则从 ?city=liaoyang 进来的用户
 *   会被服务端默认城市杭州兜底解析，卡在第 2 题）；城市列表没加载完时用地址栏 ?city= 兜底；
 * - 已有画像的老用户：未点击前首屏仍然只有「状态文字 + 城市 + 现在就走 + 更多选项」，逐字不变。
 *
 * 仍不做的事（按 00-common 铁律 7，想加先问）：
 * - 不做定位 / 偏好选择器：起点默认用所选城市的演示坐标（本轮只接受手填地址），M10 之后再接真实定位与偏好；
 * - 不做预算输入：用所选城市的默认预算（thresholds.defaultBudget），预算选择器留到 M10 之后。
 */

const MINUTES_PER_DAY = 1440;

/** GET /api/cities 返回的单个城市（与 app/api/cities/route.ts 的契约一致）。 */
type CityEntry = {
  city: string;
  displayName: string;
  /** 高德城市码（公交算路用）；页面不直接用，保留完整城市视图方便以后接线。 */
  cityCode: string;
  /** 公交算路的城市名，传给 AmapRouteMap（杭州「杭州市」/ 辽阳「辽阳市」）。 */
  transferCityName: string;
  origin: { latitude: number; longitude: number };
  thresholds: { defaultBudget: number; maxTotalMin: number; sunsetMinute: number };
  /**
   * 跨城边界用的「城市数据覆盖半径」（米，服务端按 max 点位距离 × 1.25 计算、下限 50km）。
   * 缺省（新城市还没采数据 / 老接口）时页面回退 50km。
   */
  geoRadiusM?: number;
  /**
   * 本轮新增：手写的「现在能规划的区域」清单（问答第 2 步 / 排不出来提示用）。
   * 和上面的 geoRadiusM 是两件事：这是给用户看的语义范围，不是技术参数。缺省 = 不显示。
   */
  coverage?: string[];
};

/** 城市列表的加载状态：加载完成前城市下拉与「现在就走」都不可用。 */
type CitiesPhase = "loading" | "ready" | "error";

/**
 * 当前城市的跨城判定半径：服务端下发的 geoRadiusM（城市数据覆盖范围 ×1.25），
 * 缺失（新城市还没采数据 / 老接口）时回退 50km。页面所有「定位点是否属于这个城市」的判断都用它。
 */
function geoRadiusForCity(city: CityEntry): number {
  return city.geoRadiusM === undefined ? GEO_CITY_MAX_DISTANCE_M : city.geoRadiusM;
}

/**
 * 「更多选项」的四个值（任务1 起）：
 * - originAddress / destinationAddress 是用户填的地址文本，空串 = 没填
 *   （起点用城市演示坐标，终点 = 回到起点）；
 * - homeBy 是 "HH:mm"（input type="time" 的原生值），空串 = 不限制几点到家；
 * - duration 是「想走多久」下拉的原生 value："" = 自动、120 / 240 = 指定分钟、fullday = 一整天。
 *
 * 这里只存文本、不换算坐标：地址 → 坐标的解析全部在 /api/plan（页面不生成地点，铁律 1）。
 */
type PlanOptions = {
  originAddress: string;
  destinationAddress: string;
  homeBy: string;
};

/** 三项都没填（首屏默认）：面板收起时页面上看不到任何输入框。 */
const EMPTY_PLAN_OPTIONS: PlanOptions = {
  originAddress: "",
  destinationAddress: "",
  homeBy: "",
};

/**
 * "HH:mm"（input type="time"）→ 当日分钟数；空串 / 格式不对 → undefined
 * （请求体不带 homeBy = 不限制）。浏览器保证原生 time 输入是 "HH:mm"，这里只是不信任外部值。
 */
function homeByToMinute(text: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (match === null) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return undefined;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return undefined;
  return hour * 60 + minute;
}

/** 两个 options 是否完全一致：用来判断「值确实变了」，没变就不重复打 /api/plan。 */
function isSamePlanOptions(left: PlanOptions, right: PlanOptions): boolean {
  return (
    left.originAddress === right.originAddress &&
    left.destinationAddress === right.destinationAddress &&
    left.homeBy === right.homeBy
  );
}

/**
 * M21：rich 画像的默认预算（任务书：defaultBudget 200 → 400，打车花钱）。
 * 只在 rich 下抬预算；无 profile / powerful 仍用城市默认（验收 3 / 旧行为依赖这一点）。
 */
const RICH_PROFILE_DEFAULT_BUDGET = 400;

/** 本次请求实际使用的预算：rich = max(城市默认, 400)；其它 = 城市默认。 */
function planBudgetFor(city: CityEntry, profile: TravelProfile | null): number {
  if (profile !== null && profile.style === "rich") {
    return Math.max(city.thresholds.defaultBudget, RICH_PROFILE_DEFAULT_BUDGET);
  }
  return city.thresholds.defaultBudget;
}

/**
 * /api/plan 请求体：城市 / 当前时刻 / 预算必带；可选项**只有非空才带**（空串 / 自动不发）。
 * 起点 / 终点地址由服务端 geocode 解析，页面不存坐标；想走多久只发 durationMin / wholeDay。
 * seed：只有「再来一条」才带（随机种子），首屏「现在就走」不带 → 服务端走完全确定性的旧路径。
 * excludePlaceIds：只有「再来一条」才带（本会话已经出现过的**全部站点**，最近 24 个）→
 * 服务端把它们从**所有站**的候选池里排除，避免 A→B→C→A 来回跳；首屏不带 → 请求体与改造前逐字一致。
 *
 * M18：profile 画像（完整对象）一直带。
 * - 画像的 origin / homeBy 由服务端兜底（页面不重复发 latitude / originAddress / homeBy）；
 * - 用户在「更多选项」里显式填的地址 / 到家时间仍然按老规则发出去，服务端优先级是「显式值 > 画像」，
 *   所以临时改起点这类操作照旧生效；
 * - profile 为 null（理论上主页不会出现，防御性写法）时不发字段 → 与改造前请求体逐字一致。
 *
 * 本轮新增【起点解析】三级优先级（与任务书一致）：
 * 1. 用户手填了 originAddress → 只发 originAddress（服务端 geocode，手动地址覆盖一切）；
 * 2. 否则有「可用起点坐标」→ 发 latitude / longitude：
 *    - 定位点属于当前城市（到 city.origin ≤50km）→ 用定位坐标；
 *    - 定位点属于另一个城市（>50km）→ 跨城边界：runPlan 清掉定位缓存，并显式传城市配置 origin 坐标；
 * 3. 都没有 → 一个坐标字段都不发（服务端用画像起点 / 城市配置 origin，请求体与改造前逐字段一致）。
 */
function buildPlanRequestBody(
  city: CityEntry,
  nowMinute: number,
  options: PlanOptions,
  profile: TravelProfile | null,
  /** 第 2 级起点坐标：定位坐标 / 跨城时显式城市 origin；null = 没有可用坐标 → 不发坐标。 */
  originCoords: { lat: number; lng: number } | null,
  /** 只有「再来一条」传：随机种子。 */
  seed?: number,
  /** 只有「再来一条」传：本会话已经出现过的全部站点 placeId（服务端所有站都避开；最多 24 个）。 */
  excludePlaceIds?: string[],
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    city: city.city,
    nowMinute,
    budget: planBudgetFor(city, profile),
  };
  // M18：完整画像随请求走（planner 按 style / scene 调参，随机 seed 也必须叠加在画像约束之上）。
  if (profile !== null) body.profile = profile;
  const originAddress = options.originAddress.trim();
  if (originAddress.length > 0) {
    // 第 1 级：手填起点优先。只发地址，不发任何坐标（手填地址永远最优先，哪怕它在另一个城市）。
    body.originAddress = originAddress;
  } else if (originCoords !== null) {
    // 第 2 级：定位坐标 / 跨城时的城市 origin 坐标（服务端优先级：originAddress > 坐标 > 画像起点 > 城市配置 origin）。
    body.latitude = originCoords.lat;
    body.longitude = originCoords.lng;
  }
  // 第 3 级：手填与坐标都没有 → 不发坐标（与改造前请求体逐字一致，placeId 不受定位特性影响）。
  const destinationAddress = options.destinationAddress.trim();
  if (destinationAddress.length > 0) body.destinationAddress = destinationAddress;
  const homeBy = homeByToMinute(options.homeBy);
  if (homeBy !== undefined) body.homeBy = homeBy;
  // 「再来一条」：带上随机种子 + 本会话出现过的全部站点（最近 24 个）。
  // 服务端在「同样合规的候选」里换路线，并把 excludePlaceIds 从**所有站**的候选池排除；
  // 排除到候选池为空时返回人话（不偷偷忽略 exclude）。
  if (seed !== undefined) body.seed = seed;
  if (excludePlaceIds !== undefined && excludePlaceIds.length > 0) {
    body.excludePlaceIds = excludePlaceIds;
  }
  return body;
}

/** 通勤方式对应的口语（第一站卡片副标题用）：走路说「走过去」，公交说「坐公交过去」。 */
const MODE_VERB: Record<SegmentMode, string> = {
  walk: "走过去",
  bus: "坐公交",
  bike: "骑车",
  drive: "打车",
};

/**
 * 有路名时的动词（本轮新增）：配合 roadPrefix() 的「沿{路名}」前缀用。
 * 「沿后地路走 3 分钟」「沿运道骑 12 分钟」；公交没有路名（transit 没有 step 级路名），
 * 这条兜底写法实际上不会出现，留着只是为了 Record 完整。
 */
const MODE_VERB_WITH_ROAD: Record<SegmentMode, string> = {
  walk: "走",
  bus: "坐公交",
  bike: "骑",
  drive: "开",
};

/** 高德 URI 导航的 mode 参数。 */
const NAVIGATION_MODE: Record<SegmentMode, string> = {
  walk: "walk",
  bus: "bus",
  bike: "ride",
  drive: "car",
};

/** 当日分钟数 → "HH:mm"（920 → "15:20"）。 */
function formatMinute(minute: number): string {
  const normalized = ((minute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hour = Math.floor(normalized / 60);
  const rest = normalized % 60;
  return `${String(hour).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

/**
 * 服务端 zod 已经把 importance 收紧到 1–5；这里只做一次类型收窄，
 * 让两个展示组件的 props 能保持严格的 1 | 2 | 3 | 4 | 5。
 * 越界 / 缺失一律按「没标星」处理——这是纯展示字段，不修正数据、更不影响排程。
 */
function toImportance(value: number | undefined): 1 | 2 | 3 | 4 | 5 | undefined {
  if (value === 1 || value === 2 || value === 3 || value === 4 || value === 5) return value;
  return undefined;
}

/** 本机当前时刻的当日分钟数（15:20 → 920）。 */
function currentMinuteOfDay(): number {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

/** 状态行后半句：天还亮着 / 天快黑了 / 天黑了。 */
function describeSky(minute: number): string {
  if (minute < 5 * 60 + 30) return "天还没亮";
  if (minute < 18 * 60) return "天还亮着";
  if (minute < 19 * 60) return "天快黑了";
  return "天黑了";
}

/**
 * 通勤口语：有路名 → 「沿后地路走 3 分钟」；没有路名 → 「走过去 3 分钟」（原来的文案，一字不改）。
 * 不足 1 分钟时和 planner 的 reason 口径一致。
 *
 * road 来自 Segment.road（服务端从高德算路 step 里取的「起步那条路」）；公交段没有这个字段。
 */
function describeCommute(mode: SegmentMode, durationMin: number, road?: string): string {
  const prefix = roadPrefix(road);
  const verb = prefix === null ? MODE_VERB[mode] : `${prefix}${MODE_VERB_WITH_ROAD[mode]}`;
  return durationMin === 0 ? `${verb}不到 1 分钟` : `${verb} ${durationMin} 分钟`;
}

// ---------------------------------------------------------------------------
// 布局改版（本轮第二步）用到的格式化 / 展示小工具：全部是纯函数，不产生地点、不碰排程
// ---------------------------------------------------------------------------

/** 启动页淡出时长（任务书：300ms）。 */
const SPLASH_FADE_MS = 300;
/** 启动页硬上限（任务书：2 秒；城市列表 / 地图 SDK 谁卡住都不能超过它）。 */
const SPLASH_MAX_MS = 2000;

/**
 * M19：UI 上暂时隐藏「换一个」，**只隐藏渲染，不删任何逻辑**。
 *
 * 保留的东西（一个都没删）：
 * - /api/swap 路由、lib/planner.ts 的 replaceStop + 距离带约束、lib/preference.ts；
 * - runSwap / onSwap 的 props 传递（本文件的展开层、components/FirstStopCard、StopList）；
 * - 相关测试脚本。
 *
 * 为什么留开关而不是删代码：等环线形状稳定后要把入口放出来，删了就得重写。
 * 放出来只需要把这里改成 true（另外两处组件内同名常量也要改）。
 */
const SHOW_SWAP_BUTTON = false;

/** 起点 / 终点不是 POI，地址栏没有它们的「第几站」序号；站点序号用 ① ② ③…（最多 MAX_STOPS=6 站）。 */
function circledNumber(index: number): string {
  return String.fromCodePoint(0x2460 + index);
}

/** 星期文案：10月24日 周六。 */
const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 头部日期行：`10月24日 周六`（只做格式化，不参与任何时间运算）。 */
function formatDateLabel(date: Date): string {
  return `${date.getMonth() + 1}月${date.getDate()}日 ${WEEKDAY_LABELS[date.getDay()]}`;
}

/** 头部总时长：`3 小时 22 分` / `42 分钟` / `3 小时`。 */
function formatDurationText(totalMin: number): string {
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  if (hours === 0) return `${minutes} 分钟`;
  if (minutes === 0) return `${hours} 小时`;
  return `${hours} 小时 ${minutes} 分`;
}

/** 头部总花费：`86 元` / `86.5 元`（金额可能带小数，去掉多余的 .0）。 */
function formatCostText(totalCost: number): string {
  const rounded = Math.round(totalCost * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** 通勤方式的中文标签（与 AmapRouteMap / planner 的 MODE_LABEL 同一口径）。 */
const MODE_LABEL: Record<SegmentMode, string> = {
  walk: "步行",
  bus: "公交",
  drive: "打车",
  bike: "骑行",
};

/**
 * 返程行文案：`↩ 骑行 15 分钟回到起点`；用户填了自定义终点时写「回到<终点名>」。
 * destinationName = null 表示回到起点（默认终点），不读任何地点数据。
 */
function describeReturnSegment(segment: Segment, destinationName: string | null): string {
  const durationText = segment.durationMin <= 0 ? "不到 1 分钟" : `${segment.durationMin} 分钟`;
  const target =
    destinationName === null || destinationName.length === 0 ? "回到起点" : `回到${destinationName}`;
  return `${MODE_LABEL[segment.mode]} ${durationText}${target}`;
}

/**
 * 活动一行（本轮从 FirstStopCard / StopList 原样搬到展开层，模板一字不改）：
 * 「19:00 有场话剧《雷雨》，票价 80-180」；跨天前面补「明天 」。
 * 字段全部来自服务端快照，前端不做时间判断、不编造。
 */
function formatUpcomingEventLine(event: StopEvent): string {
  const dayPrefix = event.dayLabel === "明天" ? "明天 " : "";
  const noteSuffix = event.noteLine === null ? "" : `，${event.noteLine}`;
  return `${dayPrefix}${event.startAtText} 有场${event.title}${noteSuffix}`;
}

/** 五角星路径（viewBox 24×24）：与 FirstStopCard / StopList 同一形状，实心 / 描边共用。 */
const STAR_PATH =
  "M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8L3.5 9.7l5.9-.9L12 3.5Z";

/**
 * 展开层里的小号重要性星（纯展示，不参与排程）。
 * 不能改 FirstStopCard / StopList（不在本轮写入范围），所以这里内联一份同样的 SVG 画法。
 */
function ImportanceStars({ importance }: { importance: 1 | 2 | 3 | 4 | 5 }) {
  return (
    <span
      role="img"
      aria-label={`重要性 ${importance} 星`}
      className="inline-flex shrink-0 items-center gap-0.5"
    >
      {[1, 2, 3, 4, 5].map((star) => {
        const filled = star <= importance;
        return (
          <svg
            key={star}
            aria-hidden="true"
            focusable="false"
            viewBox="0 0 24 24"
            fill={filled ? "currentColor" : "none"}
            stroke={filled ? "none" : "currentColor"}
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={filled ? "h-3.5 w-3.5 text-stone-900" : "h-3.5 w-3.5 text-stone-300"}
          >
            <path d={STAR_PATH} />
          </svg>
        );
      })}
    </span>
  );
}

/**
 * 城市列表的形状兜底：只认结构完整的条目，异常条目直接丢弃（不阻塞页面）。
 * 数值本身由服务端 zod 校验过，这里只防止「接口返回了一个奇怪的 JSON」把页面画崩。
 */
function normalizeCities(raw: unknown): CityEntry[] {
  if (!Array.isArray(raw)) return [];
  const cities: CityEntry[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const origin = record.origin as Record<string, unknown> | null | undefined;
    const thresholds = record.thresholds as Record<string, unknown> | null | undefined;
    if (typeof record.city !== "string" || typeof record.displayName !== "string") continue;
    if (typeof record.cityCode !== "string" || typeof record.transferCityName !== "string") continue;
    if (origin === null || origin === undefined) continue;
    if (typeof origin.latitude !== "number" || typeof origin.longitude !== "number") continue;
    if (thresholds === null || thresholds === undefined) continue;
    if (typeof thresholds.defaultBudget !== "number") continue;
    if (typeof thresholds.maxTotalMin !== "number" || typeof thresholds.sunsetMinute !== "number") {
      continue;
    }
    cities.push({
      city: record.city,
      displayName: record.displayName,
      cityCode: record.cityCode,
      transferCityName: record.transferCityName,
      origin: { latitude: origin.latitude, longitude: origin.longitude },
      thresholds: {
        defaultBudget: thresholds.defaultBudget,
        maxTotalMin: thresholds.maxTotalMin,
        sunsetMinute: thresholds.sunsetMinute,
      },
      // 跨城半径是可选字段：缺失 / 非法值就不带上，页面回退 50km 兜底。
      ...(typeof record.geoRadiusM === "number" && Number.isFinite(record.geoRadiusM) && record.geoRadiusM > 0
        ? { geoRadiusM: record.geoRadiusM }
        : {}),
      // 本轮新增：coverage 是可选的手写字段；只有「非空字符串数组」才带上，缺失 / 非法就整行不显示。
      ...(Array.isArray(record.coverage) &&
      record.coverage.length > 0 &&
      record.coverage.every((item) => typeof item === "string" && item.length > 0)
        ? { coverage: record.coverage as string[] }
        : {}),
    });
  }
  return cities;
}

/** 从地址栏的 ?city= 读初始城市；没有 / 空串返回 null（不用 useSearchParams，见文件头）。 */
function readCityFromSearch(): string | null {
  if (typeof window === "undefined") return null;
  const city = new URLSearchParams(window.location.search).get("city");
  return city === null || city.length === 0 ? null : city;
}

/** 把 ?city=<id> 写回地址栏：replaceState 不新增历史记录，也不触发路由重渲染。 */
function writeCityToSearch(city: string): void {
  const search = new URLSearchParams(window.location.search);
  search.set("city", city);
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}?${search.toString()}${window.location.hash}`,
  );
}

/**
 * 第一站卡片上的「几点前出发」：最晚出发时刻 =
 * 闭馆时刻 - 停留时长 - 走过去的时间。planner 的 isOpenAt 保证了这个值 ≥ 出发时刻（now）。
 *
 * 闭馆时刻读站点自带的 placeCloseTime（planner 从城市数据里带出来的地点快照）：
 * - null / undefined（高德没给营业时间，或旧数据缺字段）→ 没有「几点前出发」，返回出发时刻；
 * - "24:00"（parseClockMinute 得到 1440，全天开放）→ 返回 null，卡片改显示
 *   「走过去 X 分钟，随时可去」，不再出现「CBD公园 23:10 前出发」这种说不通的提示。
 */
function latestDepartMinute(itinerary: Itinerary, index: number): number | null {
  const stop = itinerary.stops[index];
  const segment = itinerary.segments[index];
  const fallback = itinerary.startAt;
  const closeTime = stop.placeCloseTime;
  if (closeTime === null || closeTime === undefined) return fallback;
  const closeMinute = parseClockMinute(closeTime);
  if (closeMinute >= MINUTES_PER_DAY) return null;
  return closeMinute - stop.stayMin - segment.durationMin;
}

/** 高德 H5 导航链接：只给目的地，起点用用户当前定位（不把「家」写进链接）。 */
function buildNavigationUrl(index: number, itinerary: Itinerary): string {
  const segment = itinerary.segments[index];
  const stop = itinerary.stops[index];
  // 坐标 / 名称都来自站点快照；缺任何一个就退回高德首页，不拼一个不完整的链接。
  if (stop.lng === undefined || stop.lat === undefined) return "https://uri.amap.com/";
  const placeName = stop.placeName;
  if (placeName === undefined || placeName.length === 0) return "https://uri.amap.com/";
  const destination = `${stop.lng},${stop.lat},${encodeURIComponent(placeName)}`;
  return (
    `https://uri.amap.com/navigation?to=${destination}` +
    `&mode=${NAVIGATION_MODE[segment.mode]}&coordinate=gaode&callnative=0&src=shuo-zou-jiu-zou`
  );
}

/**
 * M7：换站之后客户端再验一次「时间闭合」。
 *
 * 服务端 replaceStop 已经用 assertItineraryClosed 断言过一遍，这里防的是传输 / 解析层面的意外：
 * 不通过就不把这份行程套到界面上（宁可保持旧行程，也不显示一份时间对不上的结果）。
 * 只做校验，不做任何排程或修正。
 *
 * 本轮支持返程（与 lib/constraints.ts 的 assertItineraryClosed 同一口径）：
 * segments.length = stops.length + 1 时最后一段是返程——fromId 必须是末站 placeId，
 * toId 是 "origin" / "destination"，endAt = 末站 leaveAt + 返程 durationMin，totalMin 含返程。
 * 改造前的旧数据（站段一一对应、没有返程）仍然接受，避免把旧响应误判成坏数据。
 *
 * 预算用「这份行程所属城市的默认预算」（页面传入），保证和服务端排程的预算同一口径。
 */
function itineraryClosureError(itinerary: Itinerary, budget: number): string | null {
  const stopCount = itinerary.stops.length;
  const hasReturn = itinerary.segments.length === stopCount + 1;
  if (itinerary.segments.length !== stopCount && !hasReturn) return "行程结构与站点数量不一致";
  if (stopCount === 0) return "行程没有站点";

  let prevLeaveAt = itinerary.startAt;
  let expectedFromId = "origin";
  let totalMin = 0;
  let totalCost = 0;
  for (let index = 0; index < stopCount; index += 1) {
    const stop = itinerary.stops[index];
    const segment = itinerary.segments[index];
    if (segment.fromId !== expectedFromId) return `第 ${index + 1} 段起点不连续`;
    if (segment.toId !== stop.placeId) return `第 ${index + 1} 段与第 ${index + 1} 站对不上`;
    if (stop.arriveAt !== prevLeaveAt + segment.durationMin) return `第 ${index + 1} 段时间不连续`;
    if (stop.leaveAt !== stop.arriveAt + stop.stayMin) return `第 ${index + 1} 站时间不闭合`;
    prevLeaveAt = stop.leaveAt;
    expectedFromId = stop.placeId;
    totalMin += segment.durationMin + stop.stayMin;
    totalCost += stop.costEstimate;
  }

  // 返程段：末站 → 起点 / 自定义终点；endAt 与 totalMin 都要把返程算进去。
  const returnSegment = hasReturn ? itinerary.segments[stopCount] : null;
  if (returnSegment !== null) {
    const lastStop = itinerary.stops[stopCount - 1];
    if (returnSegment.fromId !== lastStop.placeId) return "返程段不是从末站出发";
    if (returnSegment.toId !== "origin" && returnSegment.toId !== "destination") {
      return "返程段终点不是起点或自定义终点";
    }
    totalMin += returnSegment.durationMin;
  }

  const expectedEndAt = returnSegment === null ? prevLeaveAt : prevLeaveAt + returnSegment.durationMin;
  if (itinerary.endAt !== expectedEndAt) return "结束时间与末站离开时间不一致";
  if (itinerary.totalMin !== itinerary.endAt - itinerary.startAt) return "总时长不闭合";
  if (itinerary.totalMin !== totalMin) return "总时长与各段之和不一致";
  if (Math.abs(itinerary.totalCost - totalCost) > 1e-9) return "总花费与各站之和不一致";
  if (itinerary.totalCost > budget) return "总花费超出预算";
  return null;
}

type Phase = "idle" | "loading" | "done";

/**
 * 启动页阶段：visible（显示中）→ fading（淡出 300ms）→ gone（已从 DOM 移除）。
 * 只单向推进，任何后续 state 变化都不会把它改回来；gone 之后页面上查不到 [data-splash]。
 */
type SplashPhase = "visible" | "fading" | "gone";

export default function Home() {
  const [phase, setPhase] = useState<Phase>("idle");
  /** 启动页：只在初次加载显示（见下面的 effect），点「现在就走」的 loading 走按钮态。 */
  const [splashPhase, setSplashPhase] = useState<SplashPhase>("visible");
  /**
   * M18 出行画像：undefined = 还没从 localStorage 读完（渲染中性白屏占位）；
   * null = 没有画像（首次进入，渲染整屏问答）；对象 = 已有画像（走原有主页流程）。
   */
  const [profile, setProfile] = useState<TravelProfile | null | undefined>(undefined);
  /** 画像最新值的 ref：runPlan 是 useCallback([])，不能闭包旧 state；问答完成时同步更新。 */
  const profileRef = useRef<TravelProfile | null>(null);
  /**
   * 是否正在显示整屏 4 步问答。
   * 本轮起**每次打开页面都会先置 true**（有画像 → 预填 + 可跳过；没有 → 必须走完）；
   * 「更多选项 → 重新设置」也会把它置 true。
   */
  const [showOnboarding, setShowOnboarding] = useState(false);
  /**
   * 启动页是否该出现：本轮起统一在「问答完成 / 跳过」之后 arm（问答期间不显示启动页）。
   * 只单向置 true，之后「重新设置」不会让启动页再播一次。
   */
  const [splashArmed, setSplashArmed] = useState(false);
  /** 启动页计时起点（2 秒硬上限从这里算）：问答完成 / 跳过的那一刻。 */
  const splashEpochRef = useRef<number | null>(null);
  /**
   * 「出发」状态机（本轮新增）：planned（刚生成行程、刷新不恢复）/ traveling（刷新恢复）/
   * null（没有行程状态）。持久化在 localStorage 的 szjz.trip，读写都在 lib/trip.ts。
   */
  const [trip, setTrip] = useState<TripState>(null);
  /** trip 的同步镜像：planned 落盘 effect 不能闭包 state，也用来判断当前是否 traveling。 */
  const tripRef = useRef<TripState>(null);
  /** 进行中「重新设置 / 切城市」前的确认弹层（null = 不显示）。 */
  const [tripExitConfirm, setTripExitConfirm] = useState<"reset" | "city" | null>(null);
  /** 确认弹层里等待切换的城市 id（confirm = city 时才有值）。 */
  const [pendingTripCityId, setPendingTripCityId] = useState<string | null>(null);
  /**
   * 恢复进行中时从 szjz.trip 带回来的城市 id：城市列表异步加载完之前先记下来，
   * 加载完成后优先按它选城市（否则会退回地址栏 / activeCity，行程和城市下拉对不上）。
   */
  const resumeTripCityRef = useRef<string | null>(null);
  /** 城市列表请求 promise：启动页要等它 + 地图 SDK 就绪；由下面的城市列表 effect 填进来。 */
  const citiesLoadPromiseRef = useRef<Promise<void> | null>(null);
  /** 当前展开的站点行下标（null = 全部收起；默认全部收起，点同一行再点收起）。 */
  const [expandedStopIndex, setExpandedStopIndex] = useState<number | null>(null);
  const [itinerary, setItinerary] = useState<Itinerary | null>(null);
  const [failureReason, setFailureReason] = useState<string | null>(null);
  // 时间在挂载后由浏览器算：服务端渲染时留空，避免服务端 / 客户端时钟差一分钟时出现 hydration 不一致。
  const [nowMinute, setNowMinute] = useState<number | null>(null);
  // M7：换站请求进行中 / 这次换站的提示文案 / 本次会话已经换出过的 placeId（只放内存，不落盘）。
  const [swapBusy, setSwapBusy] = useState(false);
  const [swapError, setSwapError] = useState<string | null>(null);
  const [swapHistory, setSwapHistory] = useState<string[]>([]);

  // M19：路线变化 → 滚到地图 + 重播动画。
  // - animationKey 每次「行程数据真的变了」+1，传给 AmapRouteMap；组件据此从头再画一遍。
  // - mapSectionRef 是地图外层容器：滚动目标（block: 'start'，顶部留一点）。
  // - lastItineraryRef 用来区分「首次出行程」和「数据变了」：首次只滚不多加 key（地图挂载本来就会播）。
  const [animationKey, setAnimationKey] = useState(0);
  const mapSectionRef = useRef<HTMLDivElement | null>(null);
  const lastItineraryRef = useRef<Itinerary | null>(null);

  /**
   * M19：行程数据真的变了（重新生成 / 不感兴趣 / 换站 / 再来一条 / 改条件重排）时：
   *   1. 先把地图滚进视野（`block: 'start'`，平滑滚动）；
   *   2. 200ms 后再让地图重播动画（先滚、再播，两个动效不打架）。
   * 不滚的情况：
   *   - 页面首屏加载（itinerary 为 null，用户还没点过）；
   *   - 行程没变的重渲染（依赖数组只有 itinerary，其他 state 变化不触发）。
   * reduced-motion 只影响地图组件里的动画，滚动照常（验收要求「不播但要滚」）。
   */
  useEffect(() => {
    if (itinerary === null) return;
    const firstItinerary = lastItineraryRef.current === null;
    lastItineraryRef.current = itinerary;
    mapSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    if (firstItinerary) return;
    const timer = window.setTimeout(() => {
      setAnimationKey((key) => key + 1);
    }, 200);
    return () => window.clearTimeout(timer);
  }, [itinerary]);

  // 城市列表：挂载后 GET /api/cities；加载完成前下拉与按钮都不可用。
  const [cityPhase, setCityPhase] = useState<CitiesPhase>("loading");
  const [cities, setCities] = useState<CityEntry[]>([]);
  const [citiesError, setCitiesError] = useState<string | null>(null);
  const [selectedCityId, setSelectedCityId] = useState<string | null>(null);
  // 请求代次：切换城市后，上一座城市还在飞的 /api/plan、/api/swap 结果一律丢弃。
  const planGenerationRef = useRef(0);

  /**
   * 定位结果（本轮新增）：三级起点优先级的第 2 级。
   * SSR / 首帧恒为 null（只在客户端 effect 里读缓存 / 定位），不会造成 hydration 不一致。
   * ref 给请求体构造用（useCallback([]) 不能闭包 state），state 给输入框 placeholder 用。
   */
  const [geoPosition, setGeoPosition] = useState<GeoPosition | null>(null);
  const geoPositionRef = useRef<GeoPosition | null>(null);
  /**
   * 跨城清空定位后，记住「这条会话里当前城市该用哪个 origin 当起点」。
   * 没有它的话，切到另一个城市后的第二次重排（改更多选项 / 再来一条 / 再点按钮）会因为
   * geoPositionRef 已清空而不发坐标 → 服务端落到画像里的旧起点（可能还是另一个城市）→ 排不出来。
   * cityId 不匹配时自动忽略（切回原城市时由画像 / 城市 origin 兜底，不沿用上一个城市的坐标）。
   */
  const forcedCityOriginRef = useRef<{ cityId: string; coords: { lat: number; lng: number } } | null>(null);

  /**
   * 本轮新增（P2 修复）：切城市后解析「这个新城市该用哪个起点」。
   *
   * 规则（手填地址由调用方跳过——手填永远优先，不走任何一步）：
   * 1. 先看 10 分钟定位缓存：
   *    - 缓存存在且就在新城市范围内（≤ geoRadiusM）→ 直接用，不重新定位（快）；
   *    - 缓存存在但属于别的城市 → 清缓存，调一次 locateOnce()；
   *    - 没有缓存 → 调一次 locateOnce()；
   * 2. locateOnce 成功：再量一次到新城市的距离——在范围内用定位坐标，否则用城市 origin；
   * 3. locateOnce 失败：静默用城市 origin（不报错、不阻塞排程）；
   * 4. 选定的起点写进 geoPositionRef / forcedCityOriginRef，runPlan 组装请求时直接读取
   *    （跨城时 forced 保证同城后续重排也不落回画像旧起点）。
   */
  const resolveOriginForCity = useCallback(async (city: CityEntry, generation: number): Promise<void> => {
    const radius = geoRadiusForCity(city);
    /**
     * 解析期间用户可能已经点了「现在就走」（首屏没有旧行程时按钮不被 loading 挡住）：
     * 这种请求读到的 state/ref 可能是旧的。所以：
     * 1. await 之前先写 forced=当前城市 origin——期间发起的重排会显式用城市默认点，不会落到画像旧起点；
     * 2. 每次 await 之后检查 generation——被更新的切城市操作顶掉时，旧异步不再写 state/ref。
     */
    const isCurrent = (): boolean => planGenerationRef.current === generation;

    /** 用定位坐标当起点：更新 state（placeholder）与 ref（请求体），清掉 forced 兜底。 */
    const applyLocatedOrigin = (position: GeoPosition): void => {
      if (!isCurrent()) return;
      geoPositionRef.current = position;
      setGeoPosition(position);
      forcedCityOriginRef.current = null;
    };

    /** 用城市 origin 当起点：清掉定位 ref，并记 forced（后续同城重排继续显式发城市 origin）。 */
    const applyCityOrigin = (): void => {
      if (!isCurrent()) return;
      geoPositionRef.current = null;
      setGeoPosition(null);
      forcedCityOriginRef.current = {
        cityId: city.city,
        coords: { lat: city.origin.latitude, lng: city.origin.longitude },
      };
    };

    // 本轮新增：自动定位关闭时，不读定位缓存、不调 locateOnce（不弹授权、不写 szjz.geo）。
    // 但切城市仍然沿用既有兜底：起点显式用新城市的 origin（否则会落到画像里的旧城市起点）。
    // 定位恢复时把 GEOLOCATION_ENABLED 改 true，下面的缓存 / locateOnce 逻辑原样生效。
    if (!GEOLOCATION_ENABLED) {
      applyCityOrigin();
      return;
    }

    // 1. 先看缓存：在同一城市范围 → 直接用（快）；在别的城市 → 清缓存后重新定位。
    const cached = readCachedGeo();
    if (cached !== null) {
      if (isGeoInCity(cached, city.origin, radius)) {
        applyLocatedOrigin(cached);
        return;
      }
      clearCachedGeo();
    }
    if (!isCurrent()) return;

    // 2/3. 没有可用缓存 → 定位一次（locateOnce 任何失败都返回 null，绝不抛错；页面不阻塞在等待上
    // 也不会因为失败报错——这里 await 只是为了「先定好起点再重排」，最坏 10 秒内必有结论）。
    // 等待期间先按城市 origin 兜底：此时点按钮发出的请求不会落到画像里的旧起点。
    geoPositionRef.current = null;
    setGeoPosition(null);
    forcedCityOriginRef.current = {
      cityId: city.city,
      coords: { lat: city.origin.latitude, lng: city.origin.longitude },
    };
    const located = await locateOnce();
    if (!isCurrent()) return;
    if (located !== null && isGeoInCity(located, city.origin, radius)) {
      applyLocatedOrigin(located);
      return;
    }
    // 定位到别的城市 / 定位失败：用城市 origin。若定位写入了「别处」的缓存则保留——
    // 用户切回自己真实所在的城市时能直接命中缓存、不用重新定位。
    applyCityOrigin();
  }, []);

  // 「更多选项」：起点 / 终点地址 + 几点到家。城市切换、重排时都保留（用户改的值不会被清掉）。
  const [planOptions, setPlanOptions] = useState<PlanOptions>(EMPTY_PLAN_OPTIONS);
  // 上次真正发出去的 options：改值后拿来比「值确实变了」，没变就不重复请求。
  const appliedOptionsRef = useRef<PlanOptions>(EMPTY_PLAN_OPTIONS);
  // 已有行程时改条件触发的重排：进行中 / 失败原因（失败保留旧行程，只提示原因）。
  const [optionsBusy, setOptionsBusy] = useState(false);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  /** 「再来一条」：整条路线重排中（按钮显示「正在再找一条…」，旧行程保留不清空）。 */
  const [anotherBusy, setAnotherBusy] = useState(false);
  /** 「再来一条」试了几次都换不出不同组合时的如实提示（null = 不显示）。 */
  const [anotherHint, setAnotherHint] = useState<string | null>(null);
  /**
   * 「再来一条」会话内已经出现过的**站点 placeId**（不是行程签名）。
   *
   * 旧实现记的是「行程签名」：只把上一轮（重试时再加上历史首站）当 excludePlaceIds 发出去，
   * 服务端也只在第 1 站避让 → A→B→C→A / 后 3 站连排都会出现「反复跳」。
   * 现在改为 placeId 集合：每次「再来一条」成功把本轮全部 placeId 加进来；请求时把整个集合
   * （最多最近 24 个，约 6 轮 × 4 站）作为 excludePlaceIds 发给服务端，由服务端从**所有站**排除。
   * 新的基准行程（现在就走 / 切城市 / 改更多选项 / 重新设置画像）会清空集合（见 runPlan 里
   * seed === undefined 分支），保证「现在就走」与不带 exclude 时行为一致。
   */
  const anotherRouteSeenRef = useRef<Set<string>>(new Set());

  const selectedCity = useMemo(
    () => cities.filter((city) => city.city === selectedCityId)[0] ?? null,
    [cities, selectedCityId],
  );

  /**
   * 排不出来时给用户看「现在能规划：…」（本轮新增）：
   * 只读城市配置里手写的 coverage（没有配置的城市整行不显示），与问答第 2 步同一个格式。
   * 注意不是 geoRadiusM —— 那是跨城判定用的技术半径，混用会误导用户。
   */
  const failureCoverageText =
    selectedCity !== null && selectedCity.coverage !== undefined && selectedCity.coverage.length > 0
      ? selectedCity.coverage.join(" · ")
      : null;

  // 地图用的起点：优先用本次行程的 origin 快照（自定义起点时就是那个地址），否则用城市演示起点。
  // 先取出经纬度标量再 useMemo：换站时 itinerary 换了、但起点坐标没变，origin 引用要保持稳定——
  // 地图创建 effect 依赖它，行内新对象会让地图被反复重建。
  const originSnapshot = itinerary?.origin ?? null;
  const originLng = originSnapshot?.lng ?? selectedCity?.origin.longitude ?? null;
  const originLat = originSnapshot?.lat ?? selectedCity?.origin.latitude ?? null;
  const routeMapOrigin = useMemo<{ lng: number; lat: number } | null>(() => {
    if (originLng === null || originLat === null) return null;
    return { lng: originLng, lat: originLat };
  }, [originLng, originLat]);

  // 状态行跟着本地时间走（半分钟刷新一次，够用了）。
  useEffect(() => {
    const update = () => setNowMinute(currentMinuteOfDay());
    update();
    const timer = window.setInterval(update, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  /**
   * 首次进入读画像 + 「出发」状态（只在客户端 effect 里读；服务端 / 首次客户端渲染都是
   * undefined，所以 hydration 一定一致）。读完之前页面渲染中性白屏占位。
   *
   * 挂载顺序（本轮「出发」状态机，任务书逐字）：
   * a. 先读 szjz.trip；
   * b. traveling 且 startedAt 距今 < 8 小时 → 直接进「进行中」视图，跳过问答；
   * c. traveling 但超过 8 小时 → 清掉，走正常流程；
   * d. planned → 清掉（上一次的行程不该恢复），走正常流程；
   * e. 没有 → 走正常流程（每次打开都先 4 步问答；有旧画像则预填 + 可跳过）。
   */
  useEffect(() => {
    const storedTrip = readTripFromStorage();
    const storedProfile = readProfileFromStorage();
    profileRef.current = storedProfile;
    setProfile(storedProfile);

    if (storedTrip !== null && storedTrip.phase === "traveling") {
      if (isTravelingTripFresh(storedTrip)) {
        // b. 恢复进行中：跳过问答，直接进进行中视图；启动页照常播在恢复内容之上。
        tripRef.current = storedTrip;
        setTrip(storedTrip);
        setItinerary(storedTrip.itinerary);
        setPhase("done");
        resumeTripCityRef.current = storedTrip.cityId ?? null;
        setShowOnboarding(false);
        splashEpochRef.current = performance.now();
        setSplashArmed(true);
        return;
      }
      // c. 超过 8 小时：清掉，走正常流程。
      clearTripFromStorage();
    } else if (storedTrip !== null) {
      // d. planned：行程是上一次的，不该恢复。
      clearTripFromStorage();
    }

    // e. 正常流程：每次打开都先 4 步问答（有旧画像 → 预填 + 可跳过）。
    setShowOnboarding(true);
  }, []);

  /**
   * 本轮新增：页面加载后**后台静默**定位一次（高德定位插件，不用浏览器原生 geolocation）。
   *
   * 三条纪律：
   * 1. 不 await、不阻塞：定位是体验增强，不是行程生成的必要条件。「现在就走」随时可点；
   *    拒绝授权 / 超时（10 秒）/ SDK 不可用 / 非安全上下文 → locateOnce 返回 null，
   *    静默回落到城市默认起点，不弹任何提示。
   * 2. 不自动重排已有行程：拿到定位只更新起点来源，下一次生成行程（点击 / 改条件）自动使用。
   * 3. 先同步读 10 分钟缓存（placeholder 立即正确），再等异步结果；过期的缓存 locateOnce 会重新定位。
   */
  useEffect(() => {
    // 本轮新增：自动定位总开关（GEOLOCATION_ENABLED）。
    // false = 不再后台定位、不弹授权、不读写 szjz.geo；定位代码全部保留，开关改 true 即恢复。
    if (!GEOLOCATION_ENABLED) return;
    let cancelled = false;
    const cached = readCachedGeo();
    if (cached !== null) {
      geoPositionRef.current = cached;
      setGeoPosition(cached);
    }
    void locateOnce().then((position) => {
      // position === null = 定位失败（预期路径，不提示、不报错）。
      if (cancelled || position === null) return;
      geoPositionRef.current = position;
      setGeoPosition(position);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 城市列表：初始城市优先读 URL ?city=，没有（或不在列表里）就用接口给的 activeCity。
  useEffect(() => {
    let cancelled = false;

    const loadCities = async () => {
      try {
        const response = await fetch("/api/cities");
        const data: unknown = await response.json();
        if (cancelled) return;
        if (typeof data !== "object" || data === null) {
          throw new Error("接口返回的不是 JSON 对象");
        }
        const record = data as Record<string, unknown>;
        if (record.ok !== true) {
          const reason =
            typeof record.reason === "string" && record.reason.length > 0
              ? record.reason
              : "城市列表读取失败";
          setCitiesError(reason);
          setCityPhase("error");
          return;
        }

        const list = normalizeCities(record.cities);
        if (list.length === 0) {
          setCitiesError("城市列表为空");
          setCityPhase("error");
          return;
        }

        const activeCity = typeof record.activeCity === "string" ? record.activeCity : "";
        const requested = readCityFromSearch();
        const requestedEntry =
          requested === null ? undefined : list.filter((city) => city.city === requested)[0];
        const activeEntry = list.filter((city) => city.city === activeCity)[0];
        // 「出发」状态恢复：szjz.trip 里记了城市 → 优先恢复它（URL 只是入口，不能把行程城市带跑）。
        const resumedTripEntry =
          resumeTripCityRef.current === null
            ? undefined
            : list.filter((city) => city.city === resumeTripCityRef.current)[0];
        const initialCity = resumedTripEntry ?? requestedEntry ?? activeEntry ?? list[0];

        setCities(list);
        setSelectedCityId(initialCity.city);
        setCityPhase("ready");
      } catch {
        if (cancelled) return;
        // 和「排不出来」同一文案风格：说清楚发生了什么，不出现「出错了 / 请重试」。
        setCitiesError("服务暂时没有响应");
        setCityPhase("error");
      }
    };

    // 启动页要等这次请求完成：effect 内把 promise 暴露给下一个 effect（声明顺序在前，一定拿得到）。
    const loading = loadCities();
    citiesLoadPromiseRef.current = loading;
    void loading;
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * 启动页（本轮第二步 + M18 问答之后补播）：只在初次加载出现一次。
   *
   * 消失条件 = `Promise.all([城市列表请求, 地图 SDK 就绪])` 完成 → 淡出 300ms；
   * 硬上限 2 秒：到点无条件淡出（城市列表 / 高德 SDK 卡住时，页面不能被白屏一直盖着）。
   * `whenAmapSdkSettled()` 永远 resolve（true = 就绪，false = 缺 key / 加载失败 / 超时），
   * 所以 Promise.all 不会 reject；这里再防御性 catch 一次。
   *
   * 本轮新行为：启动页统一在「问答完成 / 跳过」之后才 arm（问答期间**不显示**启动页）：
   * - 首次进入：整屏问答期间不出现，问答完成后才 arm；
   * - 有旧画像：问答预填期间同样不出现，完成或点「跳过」后才 arm；
   * - 「重新设置」不会再播一次（splashArmed 已经是 true）。
   * 2 秒硬上限从 splashEpochRef（问答完成 / 跳过的时刻）算起，不拿页面加载时刻算：
   * 问答可能花几十秒，用页面加载算的话剩余时间会是 0，启动页等于没出现。
   *
   * 淡出结束把 splashPhase 置 gone，元素从 DOM 移除：验收脚本用
   * `document.querySelector('[data-splash]') === null` 判定「启动页已消失」，再开始交互。
   */
  useEffect(() => {
    // 画像还没读完 / 首次用户还在问答：启动页不出现（问答是整屏的，这里直接不渲染覆盖层）。
    if (!splashArmed) return;
    let cancelled = false;
    let fadeTimer: number | null = null;
    let fadeStarted = false;

    const beginFade = () => {
      if (cancelled || fadeStarted) return;
      fadeStarted = true;
      setSplashPhase("fading");
      fadeTimer = window.setTimeout(() => {
        if (cancelled) return;
        setSplashPhase("gone");
      }, SPLASH_FADE_MS);
    };

    // 硬上限：2 秒后不管就绪与否都开始淡出（300ms 淡出后必然消失）。
    // 计时起点 = 启动页 arm 的时刻（老用户是首次读画像，首次用户是问答完成）。
    const elapsedSinceSplashStartMs =
      splashEpochRef.current === null ? 0 : performance.now() - splashEpochRef.current;
    const hardCapTimer = window.setTimeout(
      beginFade,
      Math.max(0, SPLASH_MAX_MS - elapsedSinceSplashStartMs),
    );
    const citiesReady: Promise<unknown> = citiesLoadPromiseRef.current ?? Promise.resolve();
    void Promise.all([citiesReady, whenAmapSdkSettled().catch(() => false)]).then(() => {
      if (cancelled) return;
      window.clearTimeout(hardCapTimer);
      beginFade();
    });

    return () => {
      cancelled = true;
      window.clearTimeout(hardCapTimer);
      if (fadeTimer !== null) window.clearTimeout(fadeTimer);
    };
  }, [splashArmed]);

  /**
   * 「出发」状态机：行程生成后进入 planned 并落盘 szjz.trip。
   * - deps 只有 itinerary / phase：换站、再来一条、改条件重排都会刷新 planned；
   * - 「结束这一趟」只清 storage + setTrip(null)，itinerary / phase 不变 → 本 effect 不会重跑，
   *   所以不会把 planned 又写回去（否则「结束 → 刷新」会被误判成有旧行程）；
   * - planned 落盘只为状态完整：页面加载读到 planned 会直接清掉（刷新不恢复）；
   * - 进行中（traveling）不覆盖：用 tripRef 判断，避免刷新恢复的那一刻又被写成 planned。
   */
  useEffect(() => {
    if (tripRef.current !== null && tripRef.current.phase === "traveling") return;
    if (itinerary === null || phase !== "done") return;
    const planned: PlannedTrip = { phase: "planned", itinerary };
    saveTrip(planned);
    tripRef.current = planned;
    setTrip((current) => (current !== null && current.phase === "traveling" ? current : planned));
  }, [itinerary, phase]);

  /**
   * 排一份行程（「现在就走」、切城市后自动重排、改「更多选项」后重排共用）。
   *
   * 城市显式传入而不是读 state：切城市后 setSelectedCityId 还没生效就调用的场景下，
   * 读 state 会拿到旧城市。三个可选项交给 buildPlanRequestBody：只有非空才进请求体。
   *
   * refresh = true 表示「已经有行程，只是改了起点 / 终点 / 几点到家」的重排：
   * 重排期间保留旧行程（不清空、不显示 loading），失败只提示原因，旧结果不丢。
   */
  const runPlan = useCallback(
    async (
      city: CityEntry,
      options: PlanOptions,
      refresh: boolean,
      /** 只有「再来一条」传：随机种子，服务端据此换一条同样合规的路线。 */
      seed?: number,
      /** 只有「再来一条」传：本会话已经出现过的全部站点 placeId（服务端所有站都避开；最多 24 个）。 */
      excludePlaceIds?: string[],
      /** 可选：失败时回调一句人话原因（「再来一条」用它把原因显示在按钮下方；其它调用方不传）。 */
      onFailureReason?: (reason: string) => void,
      /**
       * 内部可选（默认 true）：false = 只拿结果、不写界面状态。
       * 「再来一条」用它先试几个 seed、挑站数更完整的一条再统一提交，避免中途把半成品刷到页面上。
       */
      commitToUi = true,
    ): Promise<Itinerary | null> => {
    const generation = planGenerationRef.current + 1;
    planGenerationRef.current = generation;
    // 记下这次真正发出去的条件：地址输入框失焦时比「值确实变了」用。
    appliedOptionsRef.current = options;
    // 新的「基准行程」（不带 seed：首屏 / 切城市 / 改选项 / 换画像）开启一轮新的「再来一条」：
    // 清空会话内出现过的 placeId 集合，后续「再来一条」重新从空历史开始回避。
    if (seed === undefined) anotherRouteSeenRef.current.clear();

    if (refresh) {
      setOptionsBusy(true);
      setOptionsError(null);
    } else {
      setPhase("loading");
      setFailureReason(null);
      setItinerary(null);
      // 新一份行程 = 新会话：换站历史与提示都清空，展开的站点行也收起。
      setSwapError(null);
      setSwapHistory([]);
      setExpandedStopIndex(null);
      setOptionsBusy(false);
      setOptionsError(null);
    }

    // 点击这一刻重新取时间：状态行的 nowMinute 最多可能旧 30 秒。
    const nowAtClick = currentMinuteOfDay();
    const startedAt = performance.now();

    /**
     * 跨城边界（本轮新增）：定位点到当前城市 origin 的距离超过「本城市数据覆盖半径」时，
     * 视为「用户人在另一个城市」。
     * - 半径取 city.geoRadiusM（服务端按 max 点位距离 × 1.25 计算、下限 50km；缺省回退 50km）。
     *   不能写死 50km：北京合并后 origin 在房山苏庄、顺义点位最远 72.3km，写死会把同城顺义用户误判；
     * - 命中时：删掉 localStorage 定位缓存、清空 state/ref，并**显式发城市 origin 坐标**——
     *   服务端起点优先级是 body 坐标 > profile.origin，不显式发会先落到画像里的旧起点（可能还是另一个城市）；
     * - 同城市后续重排（改更多选项 / 再来一条 / 再点按钮）沿用 forcedCityOriginRef 里的城市 origin，
     *   避免「清空定位后不发坐标 → 落到别处画像起点 → 排不出来」；
     * - 手填 originAddress 完全不受该检查影响：请求体只发地址（手填永远最优先，哪怕在另一个城市）。
     */
    const cityGeoRadiusM = geoRadiusForCity(city);
    const hasManualOrigin = options.originAddress.trim().length > 0;
    // 手填地址时不能把定位坐标一起发出去：服务端起点优先级是 body 坐标 > originAddress，
    // 带上定位坐标就会把手填的地址整个盖掉（表现是「输入了新地址，起点还是原地」）。
    let originCoords: { lat: number; lng: number } | null = hasManualOrigin ? null : geoPositionRef.current;
    if (originCoords === null) {
      // 跨城清过定位的同一城市：继续显式用该城市 origin（其它城市不匹配 → 忽略，走正常兜底）。
      const forced = forcedCityOriginRef.current;
      if (forced !== null && forced.cityId === city.city) originCoords = forced.coords;
    }
    if (!hasManualOrigin && originCoords !== null && !isGeoInCity(originCoords, city.origin, cityGeoRadiusM)) {
      clearCachedGeo();
      geoPositionRef.current = null;
      setGeoPosition(null);
      originCoords = { lat: city.origin.latitude, lng: city.origin.longitude };
      forcedCityOriginRef.current = { cityId: city.city, coords: originCoords };
    }

    try {
      const response = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // M18：profile 从 ref 读（useCallback([]) 不能闭包 state；问答完成时同步更新 ref），
        // 「再来一条」也走这里 → 随机 seed 和画像约束一定一起发出去，不会绕过画像。
        body: JSON.stringify(
          buildPlanRequestBody(city, nowAtClick, options, profileRef.current, originCoords, seed, excludePlaceIds),
        ),
      });
      const data: unknown = await response.json();
      // 城市在请求途中又被切走 / 又被新一次重排顶掉：这份结果作废，不要套到当前页面上。
      if (generation !== planGenerationRef.current) return null;
      // M5 自检第 1 条：把「点击 → 出结果」的毫秒数打在 console 里。
      console.log(
        `[说走就走] ${refresh ? "按新条件重排" : "点击「现在就走」"} → 结果返回 ` +
          `${Math.round(performance.now() - startedAt)} ms（HTTP ${response.status}）`,
      );

      if (typeof data !== "object" || data === null) {
        throw new Error("接口返回的不是 JSON 对象");
      }
      const record = data as Record<string, unknown>;
      if (record.ok === false) {
        const reason =
          typeof record.reason === "string" && record.reason.length > 0
            ? record.reason
            : "没有可选的下一站";
        if (refresh) {
          // 保留旧行程，只在面板下方说明「按新条件排不出来」的原因。
          if (commitToUi) setOptionsError(reason);
        } else if (commitToUi) {
          setFailureReason(reason);
          setPhase("idle");
        }
        // 「再来一条」：把同一句人话显示在按钮下方（`another-route-hint`），而不是只藏在更多选项里。
        if (onFailureReason !== undefined) onFailureReason(reason);
        return null;
      }

      const nextItinerary = record as unknown as Itinerary;
      if (commitToUi) {
        setItinerary(nextItinerary);
        setPhase("done");
        if (refresh) {
          // 新行程 = 新会话：旧的换站提示 / 历史不再适用。
          setSwapError(null);
          setSwapHistory([]);
        }
      }
      return nextItinerary;
    } catch {
      if (generation !== planGenerationRef.current) return null;
      if (refresh) {
        if (commitToUi) setOptionsError("服务暂时没有响应");
        if (onFailureReason !== undefined) onFailureReason("服务暂时没有响应");
        return null;
      }
      // 界面文案仍然走「排不出来 + 原因」，不出现「出错了 / 请重试」（M5 3.5）。
      if (commitToUi) {
        setFailureReason("服务暂时没有响应");
        setPhase("idle");
      }
      return null;
    } finally {
      // 还是最新一次请求才收尾：被新请求顶掉时由新请求负责 busy 状态。
      if (generation === planGenerationRef.current) setOptionsBusy(false);
    }
  }, []);

  /** 首屏按钮：用当前所选城市 + 当前「更多选项」排一份新行程。 */
  const handleStart = useCallback(() => {
    if (selectedCity === null) return;
    void runPlan(selectedCity, planOptions, false);
  }, [runPlan, planOptions, selectedCity]);

  /** 一个 31 位随机种子（只用于「再来一条」；服务端拿它做确定性伪随机，排程本身不用 Math.random）。 */
  function randomSeed(): number {
    return Math.floor(Math.random() * 2_147_483_647);
  }

  /**
   * 「再来一条」历史站点上限（任务书：约 6 轮 × 4 站 = 24）。
   * 超过时保留最近 24 个（Set 保持插入顺序，从旧到新删）。
   */
  const ANOTHER_ROUTE_SEEN_LIMIT = 24;

  /** 取「最近 24 个」历史站点：Set 保持插入顺序，超出上限时丢掉最旧的。 */
  function recentSeenPlaceIds(seen: Set<string>): string[] {
    if (seen.size <= ANOTHER_ROUTE_SEEN_LIMIT) return Array.from(seen);
    return Array.from(seen).slice(seen.size - ANOTHER_ROUTE_SEEN_LIMIT);
  }

  /**
   * 「再来一条」：同一组条件下换一条整条路线（只出现在结果区）。
   *
   * 做法（本轮修复「反复跳」）：
   * 1. 页面把「本会话已经出现过的**站点 placeId**」收集在 anotherRouteSeenRef 里（上限 24）；
   * 2. 每次点击时，把「屏幕上这份行程的站点」先并进集合（它也是出现过的，保证不会原地返回），
   *    再把整个集合（最近 24 个）作为 excludePlaceIds 发出去；
   * 3. 服务端把 excludePlaceIds 从**所有站**的候选池里排除（不只是第 1 站），所以 A→B→C→A
   *    和「只换第 1 站、后 3 站连排」都不再可能；
   * 4. 成功后才把这一轮的站点全部记入集合（超过 24 时丢最旧的）；新的基准行程
   *    （现在就走 / 切城市 / 改更多选项 / 重新设置画像）会清空集合。
   *
   * 兜底：排除到候选池为空 / 换不出来时，服务端返回人话，页面显示在按钮下方（`another-route-hint`），
   * 旧行程保留不清空；**绝不为了「总能换」而偷偷忽略 exclude、也不假装换了一条**。
   * refresh 语义 = 重排期间保留旧行程、失败只提示原因。
   */
  const handleAnotherRoute = useCallback(async () => {
    if (selectedCity === null || itinerary === null) return;
    if (phase === "loading" || optionsBusy || swapBusy || anotherBusy) return;
    setAnotherBusy(true);
    setAnotherHint(null);
    try {
      const seenPlaceIds = anotherRouteSeenRef.current;
      // 点击时屏幕上这份行程的站点也算「已经出现过」：先并进集合，保证这次不会原样返回它。
      for (const stop of itinerary.stops) seenPlaceIds.add(stop.placeId);
      // 任务书：请求时把整个 Set（最近 24 个）作为 excludePlaceIds 发出去。
      const excludePlaceIds = recentSeenPlaceIds(seenPlaceIds);
      /**
       * 排除历史站点后候选池被缩小，个别 seed 会被距离递增 / 类目多样性 / 营业时间逼成
       * 「少站版」或直接排死。这里换新 seed 重试（exclude 不变、硬约束不放松，最多 3 次），
       * 优先挑站数最完整的一条：≥ 当前屏幕站数就立刻采用；都更少就采用其中站数最多的那条。
       * 全失败才把最后一句人话显示出来、保留旧行程。
       * 注意：重试用 runPlan(commitToUi=false) 只拿结果不写界面，避免半成品在页面上闪来闪去。
       */
      const expectedStops = itinerary.stops.length;
      const MAX_ATTEMPTS = 3;
      let bestItinerary: Itinerary | null = null;
      let lastFailureReason: string | null = null;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const next = await runPlan(
          selectedCity,
          planOptions,
          true,
          randomSeed(),
          excludePlaceIds,
          (reason) => {
            lastFailureReason = reason;
          },
          false,
        );
        if (next === null) continue;
        if (bestItinerary === null || next.stops.length > bestItinerary.stops.length) {
          bestItinerary = next;
        }
        if (bestItinerary.stops.length >= expectedStops) break;
      }
      if (bestItinerary === null) {
        // 全都换不出来：把最后一句人话显示在按钮下方，旧行程保留。
        setAnotherHint(lastFailureReason ?? "这一带能换的组合就这些了，换个时间或起点试试？");
        return;
      }
      // 统一提交选中的那条（不落后于当前屏幕站数时就是“同样完整的一条”）。
      setItinerary(bestItinerary);
      setPhase("done");
      setSwapError(null);
      setSwapHistory([]);
      // 成功后才把这一轮的 placeId 全部加进集合，下次连更早的一起排除。
      for (const stop of bestItinerary.stops) seenPlaceIds.add(stop.placeId);
      // 超过上限时只保留最近 24 个（Set 插入有序，旧的先删）。
      if (seenPlaceIds.size > ANOTHER_ROUTE_SEEN_LIMIT) {
        const kept = recentSeenPlaceIds(seenPlaceIds);
        seenPlaceIds.clear();
        for (const placeId of kept) seenPlaceIds.add(placeId);
      }
    } finally {
      setAnotherBusy(false);
    }
  }, [selectedCity, itinerary, phase, optionsBusy, swapBusy, anotherBusy, planOptions, runPlan]);

  /**
   * 问答完成（每次打开 / 重新设置共用）。
   *
   * 1. 写 localStorage（页面负责落盘，Onboarding 只回传画像）→ 同步 ref → 更新 state；
   * 2. 回主页；
   * 3. 首次进入（还没播过启动页）：问答之后才「启动」启动页（2 秒硬上限从这里重新计时）；
   * 4. 重新设置（启动页已播过）：直接回主页；之前已有行程 → 用新画像自动重排一次（refresh 语义）。
   */
  const handleProfileComplete = useCallback(
    (nextProfile: TravelProfile) => {
      saveProfile(nextProfile);
      profileRef.current = nextProfile;
      setProfile(nextProfile);
      setShowOnboarding(false);

      // 本轮新增：问答完成后「起点」以刚写下的 profile.origin 为准。
      // 问答里切过城市时，changeCityTo → resolveOriginForCity 会写一个「城市 origin 兜底坐标」
      // （forcedCityOriginRef / geoPositionRef）——那是切城市当时的临时兜底，不能拿它盖掉
      // 用户在第 2 步真正选的起点（服务端优先级：body 坐标 > profile.origin）。
      // 跳过的路径不清（profile 没更新，新城市的兜底坐标反而更合理）。
      forcedCityOriginRef.current = null;
      geoPositionRef.current = null;
      setGeoPosition(null);

      if (!splashArmed) {
        // 首次进入：整屏问答之后才让启动页出现（问答完成 → 启动页 → 主页）。
        splashEpochRef.current = performance.now();
        setSplashArmed(true);
        return;
      }

      // 重新设置：覆盖画像后回主页；有行程就按新画像重排一次。
      if (selectedCity !== null && phase === "done" && itinerary !== null) {
        void runPlan(selectedCity, planOptions, true);
      }
    },
    [splashArmed, selectedCity, phase, itinerary, planOptions, runPlan],
  );

  /**
   * 问答「跳过」（本轮新增；只有已有画像时才显示）：
   * - 不覆盖 localStorage 的 szjz.profile、不改 updatedAt，直接用上次设置进主页；
   * - 首次进入（还没播启动页）→ 跳过也算问答结束，启动页在之后出现；重新设置时点跳过 = 取消回主页。
   */
  const handleOnboardingSkip = useCallback(() => {
    setShowOnboarding(false);
    if (!splashArmed) {
      splashEpochRef.current = performance.now();
      setSplashArmed(true);
    }
  }, [splashArmed]);

  /** 「更多选项」里的「重新设置」：回到 4 步问答（有画像 → 预填 + 可跳过）。 */
  const handleOnboardingReset = useCallback(() => {
    setShowOnboarding(true);
  }, []);

  /**
   * 切换城市（内部实现：主页下拉、「进行中」确认切城市共用）：
   * - 用 history.replaceState 把 ?city=<id> 写回地址栏（不新增历史记录）；
   * - 清空旧城市的行程 / 提示；「更多选项」的值保留，跟着新城市一起发出去；
   * - **P2**：切完先解析新城市的起点（缓存快路径 / 跨城清缓存重定位 / 失败静默用城市 origin），
   *   解析完再重排——否则「切回原城市」会先用旧状态排一份、定位结果到了却不再重排；
   * - 手填 originAddress 时完全跳过解析（手填永远最优先）；
   * - 切换前已有结果就自动用新城市重排一次（phase 走 loading）；没有结果只更新选择。
   */
  const changeCityTo = useCallback(
    (
      nextCityId: string,
      /**
       * 可选（本轮新增）：这次切换要用的「更多选项」值。
       *
       * 问答里切城市会清掉旧城市的 originAddress，但 setState 是异步的——如果这里还从闭包里读
       * 旧的 planOptions，就会拿 A 城的地址去 B 城 geocode。所以调用方显式把清理后的值传进来。
       */
      optionsOverride?: PlanOptions,
    ) => {
      const nextCity = cities.filter((city) => city.city === nextCityId)[0];
      if (nextCity === undefined || nextCity.city === selectedCityId) return;

      setSelectedCityId(nextCity.city);
      writeCityToSearch(nextCity.city);
      setFailureReason(null);
      setSwapError(null);
      setSwapHistory([]);

      // 旧城市还在飞的请求从此作废（结果回来也丢掉），避免把上一座城市的行程套到当前页面。
      planGenerationRef.current += 1;
      const generation = planGenerationRef.current;
      const nextOptions = optionsOverride ?? planOptions;
      const hasManualOrigin = nextOptions.originAddress.trim().length > 0;
      if (itinerary !== null) setPhase("loading");

      void (async () => {
        // 4. 手填地址永远优先：不读缓存 / 不定位 / 不动定位状态。
        if (!hasManualOrigin) {
          await resolveOriginForCity(nextCity, generation);
        }
        // 解析期间又切了城市 / 又发起了新请求：这次结果作废。
        if (planGenerationRef.current !== generation) return;
        if (itinerary !== null) {
          // runPlan 内部会清空旧行程并置 loading。
          void runPlan(nextCity, nextOptions, false);
        } else {
          setPhase("idle");
        }
      })();
    },
    [cities, selectedCityId, itinerary, planOptions, runPlan, resolveOriginForCity],
  );

  /** 主页城市下拉：把原生 change 事件转成 changeCityTo。 */
  const handleCityChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      changeCityTo(event.target.value);
    },
    [changeCityTo],
  );

  /**
   * 问答第 2 步里点城市胶囊（本轮新增）：
   * - 城市只有一份 state（selectedCityId），这里不新建任何城市状态 —— 问答与主页下拉共用它；
   * - 用户手填的起点文本属于旧城市，切城市时必须清掉：否则走完问答后 /api/plan 会拿
   *   A 城的地址去 B 城 geocode（可能解析到奇怪的地方）。只清 originAddress，终点文本不动
   *   （本轮任务书只要求起点；终点语义留给以后单独一轮）；
   * - 真正的切换逻辑（写回 ?city=、清 / 重解析定位缓存、有行程就重排）复用 changeCityTo。
   *
   * 注意：主页下拉切城市**不**清手填起点（保持既有「手填地址永远最优先」的行为），
   * 这条清理只属于问答里的城市切换。
   */
  const handleOnboardingCityChange = useCallback(
    (nextCityId: string) => {
      if (nextCityId === selectedCityId) return;
      const nextOptions: PlanOptions =
        planOptions.originAddress === "" ? planOptions : { ...planOptions, originAddress: "" };
      setPlanOptions(nextOptions);
      // 显式把清理后的选项传给 changeCityTo：否则它闭包里的 planOptions 还是旧的，
      // 会拿 A 城的地址去 B 城 geocode（也可能是「有手填地址就不解析新城市起点」的错判）。
      changeCityTo(nextCityId, nextOptions);
    },
    [changeCityTo, planOptions, selectedCityId],
  );

  // -------------------------------------------------------------------------
  // 「出发」状态机（本轮新增）
  // -------------------------------------------------------------------------

  /**
   * 生成行程后点「出发」：planned → traveling。
   * startedAt 取点击这一刻的 Date.now()；currentStopIndex 从 0 开始；cityId 一并落盘，
   * 刷新恢复时城市下拉才能回到同一座城市。
   */
  const handleStartTrip = useCallback(() => {
    if (itinerary === null) return;
    const traveling: TravelingTrip = {
      phase: "traveling",
      itinerary,
      startedAt: Date.now(),
      currentStopIndex: 0,
      ...(selectedCityId === null ? {} : { cityId: selectedCityId }),
    };
    saveTrip(traveling);
    tripRef.current = traveling;
    setTrip(traveling);
    setExpandedStopIndex(null);
    setTripExitConfirm(null);
    setPendingTripCityId(null);
  }, [itinerary, selectedCityId]);

  /** 「到下一站了」：当前站 +1（已在最后一站就不动），并马上持久化——刷新后停在同一站。 */
  const handleAdvanceTrip = useCallback(() => {
    setTrip((current) => {
      if (current === null || current.phase !== "traveling") return current;
      const nextIndex = Math.min(current.currentStopIndex + 1, current.itinerary.stops.length - 1);
      if (nextIndex === current.currentStopIndex) return current;
      const next: TravelingTrip = { ...current, currentStopIndex: nextIndex };
      saveTrip(next);
      tripRef.current = next;
      return next;
    });
  }, []);

  /** 「结束这一趟」：清 szjz.trip → 回主页（保留当前行程，可重新「出发」）。 */
  const handleEndTrip = useCallback(() => {
    clearTripFromStorage();
    tripRef.current = null;
    setTrip(null);
    setTripExitConfirm(null);
    setPendingTripCityId(null);
  }, []);

  /** 进行中点「重新设置」：先弹确认「要结束这一趟吗」。 */
  const handleTripRequestReset = useCallback(() => {
    setTripExitConfirm("reset");
  }, []);

  /** 进行中切城市：先记下目标城市并弹确认，确认后才真正切。 */
  const handleTripRequestCityChange = useCallback(
    (cityId: string) => {
      if (cityId === selectedCityId) return;
      setPendingTripCityId(cityId);
      setTripExitConfirm("city");
    },
    [selectedCityId],
  );

  /** 确认弹层点「取消」：留在进行中，什么都不改。 */
  const handleTripCancelExit = useCallback(() => {
    setTripExitConfirm(null);
    setPendingTripCityId(null);
  }, []);

  /**
   * 确认弹层点「确认结束」：
   * - 先清 szjz.trip + 退出进行中视图；
   * - kind = reset → 回问答（画像仍在 → 预填 + 可跳过）；
   * - kind = city → 走原来的切城市流程（解析起点 → 按需重排）。
   */
  const handleTripConfirmExit = useCallback(() => {
    const kind = tripExitConfirm;
    const nextCityId = pendingTripCityId;
    clearTripFromStorage();
    tripRef.current = null;
    setTrip(null);
    setTripExitConfirm(null);
    setPendingTripCityId(null);

    if (kind === "city") {
      if (nextCityId !== null) changeCityTo(nextCityId);
      return;
    }
    if (kind === "reset") {
      setShowOnboarding(true);
    }
  }, [tripExitConfirm, pendingTripCityId, changeCityTo]);

  /**
   * 改完「更多选项」后，若已有行程且值确实变了，就用新条件重排一次。
   * 没有行程 / 值没变时什么都不做（只更新 state）——打开面板 focus 再 blur 不会白打接口。
   */
  const replanIfOptionsChanged = useCallback(
    (nextOptions: PlanOptions) => {
      if (selectedCity === null || phase !== "done" || itinerary === null) return;
      if (isSamePlanOptions(nextOptions, appliedOptionsRef.current)) return;
      void runPlan(selectedCity, nextOptions, true);
    },
    [itinerary, phase, runPlan, selectedCity],
  );

  /** 地址输入框：输入时只更新 state，失焦时才按需重排（不在每次按键都请求）。 */
  const handleAddressChange = useCallback(
    (field: "originAddress" | "destinationAddress", event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value;
      setPlanOptions((previous) =>
        field === "originAddress"
          ? { ...previous, originAddress: value }
          : { ...previous, destinationAddress: value },
      );
    },
    [],
  );

  /** 起点 / 终点失焦：值变了且已有行程时才重排。 */
  const handleAddressBlur = useCallback(() => {
    replanIfOptionsChanged(planOptions);
  }, [planOptions, replanIfOptionsChanged]);

  /** 几点到家：原生 time 输入没有「输入中」，值一变就按需重排（空 = 不限制）。 */
  const handleHomeByChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const nextOptions: PlanOptions = { ...planOptions, homeBy: event.target.value };
      setPlanOptions(nextOptions);
      replanIfOptionsChanged(nextOptions);
    },
    [planOptions, replanIfOptionsChanged],
  );

  /**
   * M7「换一个 / 不感兴趣」共用的入口：只把 stopIndex 这一站交给 /api/swap。
   *
   * 成功后用服务端返回的**整份新 Itinerary** 覆盖状态——后续站点的到达 / 离开时间
   * 由服务端一起重算（换了第 1 站，后面所有站都会平移），不能只换卡片内容。
   * 套到界面之前客户端再验一次时间闭合；不通过就保持旧行程，不显示时间对不上的结果。
   * 请求带上当前城市 id 与默认预算：候选池 / 预算必须和生成这份行程时一致。
   */
  const runSwap = useCallback(
    async (stopIndex: number, action: "reroll" | "dislike") => {
      if (itinerary === null || swapBusy || selectedCity === null) return;
      const generation = planGenerationRef.current;
      setSwapBusy(true);
      setSwapError(null);
      const leftPlaceId = itinerary.stops[stopIndex].placeId;
      const startedAt = performance.now();

      try {
        const response = await fetch("/api/swap", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            itinerary,
            stopIndex,
            action,
            city: selectedCity.city,
            // M21：rich 的预算抬到 400（与 /api/plan 一致），否则 rich 行程 totalCost 可能超过 200、
            // 换站会被 replaceStop 的预算断言拒掉；其它 style / 无 profile 仍用城市默认。
            budget: planBudgetFor(selectedCity, profileRef.current),
            // 连点不来回跳：带上本次会话已经换出过的 placeId，服务端从候选池里排除。
            swapHistory,
          }),
        });
        const data: unknown = await response.json();
        // 城市在换站途中被切走：这份结果属于旧城市，丢弃。
        if (generation !== planGenerationRef.current) return;
        console.log(
          `[说走就走] ${action === "reroll" ? "换一个" : "不感兴趣"}第 ${stopIndex + 1} 站 → ` +
            `${Math.round(performance.now() - startedAt)} ms（HTTP ${response.status}）`,
        );

        if (typeof data !== "object" || data === null) {
          throw new Error("接口返回的不是 JSON 对象");
        }
        const record = data as Record<string, unknown>;
        if (record.ok === false) {
          const reason =
            typeof record.reason === "string" && record.reason.length > 0
              ? record.reason
              : "这一站换不出来";
          // 包括「附近没有其他类型的地方了」：原样显示，不额外加工。
          setSwapError(reason);
          return;
        }

        const parsed = ItinerarySchema.safeParse(data);
        if (!parsed.success) {
          setSwapError("换完的行程格式不合法，已放弃这次替换");
          return;
        }
        const next = parsed.data;
        const closureError = itineraryClosureError(next, planBudgetFor(selectedCity, profileRef.current));
        if (closureError !== null) {
          setSwapError(`换完后${closureError}，已放弃这次替换`);
          return;
        }

        setItinerary(next);
        setSwapHistory((previous) =>
          previous.indexOf(leftPlaceId) === -1 ? [...previous, leftPlaceId] : previous,
        );
      } catch {
        if (generation !== planGenerationRef.current) return;
        setSwapError("服务暂时没有响应");
      } finally {
        setSwapBusy(false);
      }
    },
    [itinerary, swapBusy, swapHistory, selectedCity],
  );

  const isDone = phase === "done" && itinerary !== null;

  /**
   * M19：换一个按钮在 UI 上隐藏了，但「页面收到新的换站数据」这条链路必须还在（验收 4）。
   * 开发环境把 runSwap 挂到 window 上，配合 curl /api/swap 可以验证：
   *   curl 调通接口 → window.__SZJZ_DEBUG__.runSwap(0, "reroll") → 页面拿到新行程 → 滚到地图 + 重播。
   * 生产构建里这段会被常量折叠掉（NODE_ENV === "production" 直接 return），不影响线上包体行为。
   */
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const debugWindow = window as Window & { __SZJZ_DEBUG__?: { runSwap: typeof runSwap } };
    debugWindow.__SZJZ_DEBUG__ = { runSwap };
    return () => {
      delete debugWindow.__SZJZ_DEBUG__;
    };
  }, [runSwap]);

  // 第一站的「几点前出发」（原第一站卡片的副标题）：24 小时开放的点为 null，
  // 展开层里改成「走过去 X 分钟，随时可去」。其它站没有这个概念。
  const firstStopDepartMinute = itinerary === null ? null : latestDepartMinute(itinerary, 0);

  // 返程段（segments 比 stops 多最后一段）：在站点列表末尾单独渲染一行。
  // 终点名只读响应里的 destination 快照；默认终点 = 起点时不显示名字，写「回到起点」。
  let returnSegment: Segment | null = null;
  let returnDestinationName: string | null = null;
  if (itinerary !== null && itinerary.segments.length === itinerary.stops.length + 1) {
    returnSegment = itinerary.segments[itinerary.stops.length];
    if (returnSegment.toId === "destination") {
      returnDestinationName = itinerary.destination?.name ?? null;
    }
  }

  /**
   * 「更多选项」折叠面板：首屏按钮下方与结果区底部渲染的是同一个面板（同一份 state）。
   * 用原生 <details>（不加 open 属性）默认收起，首屏因此仍然只有状态文字 + 按钮，没有输入框。
   */
  const planOptionsPanel = (
    <details data-testid="more-options" className="rounded-2xl border border-stone-200 bg-white">
      <summary className="cursor-pointer px-5 py-4 text-sm font-medium text-stone-700 marker:text-stone-400">
        更多选项
      </summary>
      <div className="flex flex-col gap-4 border-t border-stone-200 px-5 py-4">
        <label
          htmlFor="plan-origin-address"
          className="flex flex-col gap-1.5 text-sm text-stone-600"
        >
          起点
          <input
            id="plan-origin-address"
            data-testid="origin-address-input"
            type="text"
            value={planOptions.originAddress}
            placeholder={
              // 自动定位关闭时 geoPosition 恒为 null：不要显示「当前位置」，改成实话实说的引导。
              !GEOLOCATION_ENABLED
                ? "留空用城市中心，或输入起点地址"
                : geoPosition === null
                  ? "当前位置"
                  : `已定位：${geoPosition.label === undefined ? "当前位置" : geoPosition.label}（点击可改）`
            }
            onChange={(event) => handleAddressChange("originAddress", event)}
            onBlur={handleAddressBlur}
            className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-800 placeholder:text-stone-400 transition duration-150 hover:bg-stone-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500"
          />
        </label>
        <label
          htmlFor="plan-destination-address"
          className="flex flex-col gap-1.5 text-sm text-stone-600"
        >
          终点
          <input
            id="plan-destination-address"
            data-testid="destination-address-input"
            type="text"
            value={planOptions.destinationAddress}
            placeholder="回到起点"
            onChange={(event) => handleAddressChange("destinationAddress", event)}
            onBlur={handleAddressBlur}
            className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-800 placeholder:text-stone-400 transition duration-150 hover:bg-stone-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500"
          />
        </label>
        <label htmlFor="plan-home-by" className="flex flex-col gap-1.5 text-sm text-stone-600">
          几点到家
          <span className="text-xs font-normal text-stone-400">不填 = 不限制</span>
          <input
            id="plan-home-by"
            data-testid="home-by-input"
            type="time"
            value={planOptions.homeBy}
            onChange={handleHomeByChange}
            className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-800 transition duration-150 hover:bg-stone-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500"
          />
        </label>
        {/* M18：「重新设置」——回到 4 步问答（可取消）。完成后覆盖画像；已有行程会自动按新画像重排一次。 */}
        <div className="border-t border-stone-200 pt-4">
          <button
            type="button"
            data-testid="onboarding-reset"
            onClick={handleOnboardingReset}
            className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 transition duration-150 hover:bg-stone-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500"
          >
            重新设置
          </button>
        </div>
        {optionsBusy ? <p className="text-xs leading-5 text-stone-500">正在按新条件重新安排…</p> : null}
        {optionsError !== null ? (
          <p role="alert" className="text-xs leading-6 text-stone-600">
            按新条件排不出来：{optionsError}
          </p>
        ) : null}
      </div>
    </details>
  );

  // 启动页覆盖层：主页与「进行中」视图共用；gone 之后整块从 DOM 移除。
  // 验收契约：显示中 data-splash="visible"，淡出中 data-splash="fading"，
  // 淡出结束元素消失 → `document.querySelector('[data-splash]') === null`。
  // 覆盖层要真的挡住点击（不做 pointer-events-none），自动化脚本应等它移除后再交互。
  const splashOverlay =
    splashArmed && splashPhase !== "gone" ? (
      <div
        data-splash={splashPhase === "fading" ? "fading" : "visible"}
        aria-hidden={splashPhase === "fading"}
        className={`fixed inset-0 z-50 flex flex-col items-center justify-center bg-white transition-opacity duration-300 ease-out ${
          splashPhase === "fading" ? "opacity-0" : "opacity-100"
        }`}
      >
        <p className="text-4xl font-light tracking-[0.3em] text-stone-900">说走就走</p>
        <p className="mt-5 text-sm tracking-wide text-stone-500">正在看看附近有什么</p>
      </div>
    ) : null;

  // 画像还没读完 —— 中性白屏占位（服务端渲染 / 首次客户端渲染都走这里，hydration 一致）。
  if (profile === undefined) {
    return <main className="min-h-screen bg-white" aria-busy="true" />;
  }

  // 「出发」进行中（本轮新增）：整页进行中视图；刷新恢复时也走这里，不显示问答。
  if (trip !== null && trip.phase === "traveling") {
    const nextIndex = Math.min(Math.max(trip.currentStopIndex, 0), trip.itinerary.stops.length - 1);
    const pendingCity =
      pendingTripCityId === null
        ? undefined
        : cities.filter((city) => city.city === pendingTripCityId)[0];
    return (
      <>
        {splashOverlay}
        <TravelingView
          itinerary={trip.itinerary}
          startedAt={trip.startedAt}
          currentStopIndex={nextIndex}
          cityOptions={cities.map((city) => ({ city: city.city, displayName: city.displayName }))}
          selectedCityId={selectedCityId}
          citiesReady={cityPhase === "ready"}
          nextNavigationUrl={buildNavigationUrl(nextIndex, trip.itinerary)}
          confirm={tripExitConfirm}
          pendingCityName={pendingCity?.displayName ?? null}
          onCityChange={handleTripRequestCityChange}
          onRequestReset={handleTripRequestReset}
          onAdvance={handleAdvanceTrip}
          onEnd={handleEndTrip}
          onConfirmExit={handleTripConfirmExit}
          onCancelExit={handleTripCancelExit}
        />
      </>
    );
  }

  // 本轮新行为：**每次打开都先走 5 步问答**（有画像时预填、可跳过）；问答期间不显示启动页。
  // 首次进入（profile === null）不传 onSkip → 不能跳过；有画像 → 顶部「跳过」直接用上次设置。
  // 城市（本轮起由问答第 2 步自己切）：cities / selectedCityId / onCityChange 全部来自页面这一份 state，
  // 所以问答里切完城市，主页右上角的下拉会跟着变（不是两张皮）。
  // selectedCityId 的兜底：城市列表还没加载完时用地址栏 ?city=，再不行空串（geocode 不带 city）。
  if (profile === null || showOnboarding) {
    return (
      <Onboarding
        onComplete={handleProfileComplete}
        onSkip={profile === null ? undefined : handleOnboardingSkip}
        initialProfile={profile ?? undefined}
        initialGeo={geoPosition}
        cities={cities}
        selectedCityId={selectedCityId ?? readCityFromSearch() ?? ""}
        onCityChange={handleOnboardingCityChange}
      />
    );
  }

  return (
    <main className="min-h-screen bg-stone-50 text-stone-900">
      {splashOverlay}

      <div className="mx-auto flex min-h-screen w-full max-w-md flex-col px-5 py-10 sm:py-14">
        {/* 状态行 + 城市下拉：这两样在首屏（不管有没有结果）始终可见。 */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm tracking-wide text-stone-500">
            {nowMinute === null
              ? "\u00A0"
              : `现在是 ${formatMinute(nowMinute)}，${describeSky(nowMinute)}`}
          </p>
          <div className="flex items-center gap-2">
            <label htmlFor="city-select" className="shrink-0 text-sm tracking-wide text-stone-500">
              城市
            </label>
            <select
              id="city-select"
              data-testid="city-select"
              value={selectedCityId ?? ""}
              onChange={handleCityChange}
              disabled={cityPhase !== "ready"}
              className="rounded-lg border border-stone-300 bg-white px-2.5 py-1.5 text-sm text-stone-800 shadow-sm transition duration-150 hover:bg-stone-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {cityPhase === "ready" ? (
                cities.map((city) => (
                  <option key={city.city} value={city.city}>
                    {city.displayName}
                  </option>
                ))
              ) : (
                <option value="">
                  {cityPhase === "loading" ? "正在读取城市…" : "城市列表不可用"}
                </option>
              )}
            </select>
          </div>
        </div>

        {citiesError !== null ? (
          <p
            role="alert"
            className="mt-4 rounded-xl border border-stone-200 bg-white px-5 py-4 text-sm leading-6 text-stone-700"
          >
            城市列表读不出来：{citiesError}
          </p>
        ) : null}

        {isDone ? (
          /* 行程生成后：头部（紧凑）→ 站点列表（可展开）→ 地图 → 文字导航（AmapRouteMap 内部）。
             文字导航是 AmapRouteMap 自带的（地图在上、导航在下），所以页面只保证「站点列表 → 地图」
             的顺序，就能同时满足任务书 4 项顺序；不为了挪导航去改别人负责的组件。 */
          <article className="mt-8 flex flex-col gap-6" aria-label="今日行程">
            {/* 1. 头部：日期 / 站数 · 总时长 · 总花费，字号小、stone-500。 */}
            <header data-testid="itinerary-header" className="flex flex-col gap-1">
              <p className="text-xs tracking-wide text-stone-500">{formatDateLabel(new Date())}</p>
              <p data-testid="itinerary-summary" className="text-sm tracking-wide text-stone-500">
                {`${itinerary.stops.length} 站 · ${formatDurationText(itinerary.totalMin)} · ${formatCostText(itinerary.totalCost)} 元`}
              </p>
            </header>

            {/* 2. 站点列表：每站一行（序号 + 到达时刻 + 地点名），副行小字写怎么过去；
                 行间 stone-200 细分隔线；返程单独一行。点行展开详情，再点收起（默认全部收起）。 */}
            <ol data-testid="stop-list" className="overflow-hidden rounded-2xl border border-stone-200 bg-white">
              {itinerary.stops.map((stop, index) => {
                const expanded = expandedStopIndex === index;
                const segment = itinerary.segments[index];
                const importance = toImportance(stop.importance);
                return (
                  <li
                    key={stop.placeId}
                    data-testid="stop-list-item"
                    className="border-b border-stone-200 last:border-b-0"
                  >
                    <button
                      type="button"
                      data-testid="stop-row"
                      aria-expanded={expanded}
                      aria-controls={`stop-detail-${index}`}
                      onClick={() => {
                        setExpandedStopIndex((current) => (current === index ? null : index));
                      }}
                      className="flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors duration-150 ease-out hover:bg-stone-50 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-stone-500"
                    >
                      <span className="flex w-full items-baseline justify-between gap-3">
                        {/* 标题行用内联 span 而不是 flex 子项：innerText 才能保持
                            「① 15:20 城市阳台」一行（flex item 会各自成行），自动化验收也好读。 */}
                        <span className="min-w-0 truncate text-sm">
                          <span className="font-medium text-stone-500">{circledNumber(index)}</span>
                          {" "}
                          <span className="tabular-nums text-stone-500">{formatMinute(stop.arriveAt)}</span>
                          {" "}
                          <span className="font-medium text-stone-900">{stop.placeName ?? "未知地点"}</span>
                        </span>
                        <svg
                          aria-hidden="true"
                          focusable="false"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className={`h-4 w-4 shrink-0 text-stone-400 transition-transform duration-150 ease-out ${expanded ? "rotate-180" : ""}`}
                        >
                          <path d="m6 9 6 6 6-6" />
                        </svg>
                      </span>
                      <span className="pl-6 text-xs leading-5 text-stone-500">
                        {describeCommute(segment.mode, segment.durationMin, segment.road)}
                      </span>
                    </button>

                    {/* 展开层：reason 信息层 + oneLine 文案层 + 换一个 / 不感兴趣（另保留导航 / 星级 /
                        活动 / 餐厅信息，不让上一轮已有展示字段消失）。150ms ease-out，无弹跳缓动；
                        收起后高度归 0，按钮移出 Tab 序（aria-hidden + tabIndex=-1）。 */}
                    <div
                      id={`stop-detail-${index}`}
                      data-testid={`stop-detail-${index}`}
                      aria-hidden={!expanded}
                      className={`grid transition-[grid-template-rows] duration-150 ease-out ${
                        expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
                      }`}
                    >
                      <div className="overflow-hidden">
                        <div className="flex flex-col gap-3 border-t border-stone-200 px-4 py-4">
                          <p className="text-xs leading-5 tabular-nums text-stone-500">
                            {`${formatMinute(stop.arriveAt)}–${formatMinute(stop.leaveAt)}，停留 ${stop.stayMin} 分钟`}
                          </p>
                          <Reason text={stop.reason} />
                          {stop.oneLine !== undefined && stop.oneLine !== "" ? (
                            <p className="text-xs leading-5 text-stone-500">{stop.oneLine}</p>
                          ) : null}
                          {index === 0 ? (
                            <p className="text-xs leading-5 text-stone-500">
                              {firstStopDepartMinute === null
                                ? `${describeCommute(segment.mode, segment.durationMin, segment.road)}，随时可去`
                                : `${formatMinute(firstStopDepartMinute)} 前出发，${describeCommute(segment.mode, segment.durationMin, segment.road)}`}
                            </p>
                          ) : null}
                          {importance !== undefined ? <ImportanceStars importance={importance} /> : null}
                          {stop.upcomingEvent !== undefined ? (
                            <p className="text-xs leading-5 text-stone-600">
                              {formatUpcomingEventLine(stop.upcomingEvent)}
                            </p>
                          ) : null}
                          {stop.meal !== undefined && stop.meal !== null ? (
                            <RestaurantCard arriveAtText={formatMinute(stop.arriveAt)} meal={stop.meal} />
                          ) : null}
                          <div className="flex flex-wrap items-center gap-3">
                            <a
                              href={buildNavigationUrl(index, itinerary)}
                              target="_blank"
                              rel="noreferrer"
                              tabIndex={expanded ? 0 : -1}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 transition duration-150 hover:bg-stone-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500"
                            >
                              <svg
                                aria-hidden="true"
                                focusable="false"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                className="h-3.5 w-3.5"
                              >
                                <path d="M3 11.5 21 3l-8.5 18-2-7.5-7.5-2Z" />
                              </svg>
                              导航
                            </a>
                            {/* M19：UI 暂时隐藏「换一个」（逻辑保留，见文件顶部 SHOW_SWAP_BUTTON 注释）。 */}
                            {SHOW_SWAP_BUTTON ? (
                              <button
                                type="button"
                                tabIndex={expanded ? 0 : -1}
                                onClick={() => {
                                  void runSwap(index, "reroll");
                                }}
                                disabled={swapBusy}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 transition duration-150 hover:bg-stone-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-white"
                              >
                                <svg
                                  aria-hidden="true"
                                  focusable="false"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  className="h-3.5 w-3.5"
                                >
                                  <path d="M7 4v16" />
                                  <path d="m3 8 4-4 4 4" />
                                  <path d="M17 20V4" />
                                  <path d="m13 16 4 4 4-4" />
                                </svg>
                                换一个
                              </button>
                            ) : null}
                            <button
                              type="button"
                              tabIndex={expanded ? 0 : -1}
                              onClick={() => {
                                void runSwap(index, "dislike");
                              }}
                              disabled={swapBusy}
                              className="text-xs leading-5 text-stone-400 underline decoration-stone-300 underline-offset-4 transition duration-150 hover:text-stone-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-stone-400"
                            >
                              不感兴趣
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}

              {/* 返程单独一行：↩ 骑行 15 分钟回到起点（自定义终点时写终点名）。 */}
              {returnSegment !== null ? (
                <li
                  data-testid="return-row"
                  className="border-t border-stone-200 bg-stone-50/60 px-4 py-3 text-sm text-stone-600"
                >
                  <p className="text-sm text-stone-600">
                    <span aria-hidden="true" className="tabular-nums text-stone-400">
                      ↩
                    </span>
                    {" "}
                    <span>{describeReturnSegment(returnSegment, returnDestinationName)}</span>
                  </p>
                </li>
              ) : null}
            </ol>

            {/*
              「出发」（本轮新增）：把当前行程交给「出发」状态机。
              点了 → planned 变 traveling、写 szjz.trip（startedAt = 现在）、切进行中视图。
              只出现在结果区（拿到行程之后）。
            */}
            <button
              type="button"
              data-testid="start-trip-button"
              onClick={handleStartTrip}
              disabled={optionsBusy || anotherBusy || swapBusy}
              className="w-full rounded-2xl bg-stone-900 px-6 py-3 text-sm font-medium text-white transition duration-150 hover:bg-stone-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50"
            >
              出发
            </button>

            {/*
              「再来一条」：整条路线换一条。
              位置：站点卡片（含返程行）下面、地图上面 —— 看完这几站就能直接说「换一条」，
              不用滚到页面最底部。
              只出现在结果区，首屏（未点击前）仍然只有「状态文字 + 现在就走」，验收 11 的逐字一致不受影响。
              点它会带一个新随机种子重新排一份同样合规的路线；重排期间保留旧行程，只把按钮变成忙碌态。
            */}
            <button
              type="button"
              data-testid="another-route-button"
              onClick={() => {
                void handleAnotherRoute();
              }}
              disabled={anotherBusy || optionsBusy || swapBusy}
              className="w-full rounded-2xl border border-stone-300 bg-white px-6 py-3 text-sm font-medium text-stone-700 transition duration-150 hover:bg-stone-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50"
            >
              {anotherBusy ? "正在再找一条…" : "再来一条"}
            </button>
            {anotherHint !== null ? (
              <p data-testid="another-route-hint" className="text-xs leading-5 text-stone-500">
                {anotherHint}
              </p>
            ) : null}

            {/* 3. 地图：AmapRouteMap 内部输出「地图 → 文字导航」，所以第 4 项文字导航就在它下方。 */}
            {/* M19：外层包一个容器当作滚动目标；animationKey 变化时地图从头重播轨迹动画。 */}
            <div ref={mapSectionRef} data-testid="map-section" className="scroll-mt-4">
              {routeMapOrigin !== null && selectedCity !== null ? (
                <AmapRouteMap
                  origin={routeMapOrigin}
                  stops={itinerary.stops}
                  segments={itinerary.segments}
                  transferCityName={selectedCity.transferCityName}
                  originName={itinerary.origin?.name}
                  destination={itinerary.destination ?? null}
                  animationKey={animationKey}
                />
              ) : null}
            </div>

            {swapError !== null ? (
              <p role="alert" className="rounded-xl border border-stone-200 bg-white px-4 py-3 text-sm leading-6 text-stone-700">
                {swapError}
              </p>
            ) : null}

            {/* M11：导出「这一天的卡片」（没列入任务书 4 项，放在文字导航之后、更多选项之前）。 */}
            {selectedCity !== null ? (
              <RouteCard itinerary={itinerary} cityName={selectedCity.displayName} />
            ) : null}

            {/* 结果区底部再放同一个「更多选项」：拿到行程后也能改起点 / 终点 / 几点到家，改完自动重排。 */}
            {planOptionsPanel}
          </article>
        ) : (
          <div className="my-auto flex flex-col gap-6 pb-16">
            {/* 城市列表加载完成前按钮禁用（复用 busy prop）：没有城市就排不了行程。 */}
            <StartButton onClick={handleStart} busy={phase === "loading" || selectedCity === null} />
            {/* 按钮下方的「更多选项」：默认收起，首屏仍然只有状态文字 + 按钮。 */}
            {planOptionsPanel}
            {failureReason !== null ? (
              <div
                role="alert"
                className="rounded-xl border border-stone-200 bg-white px-5 py-4 text-sm leading-6 text-stone-700"
              >
                <p>今天这条路线排不出来：{failureReason}</p>
                {/* 本轮新增：排不出来时顺带告诉用户「能规划哪儿」，避免只知道换时间不知道换起点。 */}
                {failureCoverageText !== null ? (
                  <p data-testid="failure-coverage" className="mt-2 text-xs leading-5 text-stone-500">
                    {`现在能规划：${failureCoverageText}`}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </main>
  );
}
