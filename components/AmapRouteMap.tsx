"use client";

import { useEffect, useRef, useState } from "react";
import RouteMap from "@/components/RouteMap";
import { loadAMap } from "@/lib/amapLoader";
import { AMAP_SDK_PLUGINS } from "@/lib/amapSdk";
import { roadPrefix } from "@/lib/roadText";
import type { ItineraryEndpoint, Segment, SegmentMode, Stop } from "@/types/schema";

/**
 * M8 地图升级（本轮）：把原来的 SVG 路线示意图换成「真实高德地图 + 沿道路的路线」。
 *
 * 为什么保留 components/RouteMap.tsx（只保留、不删）：
 * 高德 JSAPI 依赖外网 CDN（webapi.amap.com / 瓦片 / 插件脚本）。弱网、断网、校园网、广告拦截
 * 都可能让 SDK 加载失败或长时间不返回——这种情况下页面绝不能是空白，直接回落到原来的
 * SVG 示意图，用户至少还能看懂「从起点到三站」的相对位置。降级不是兜底修补，是必须的可用性设计。
 *
 * 四个已知坑（本文件逐条处理，改代码时别踩回去）：
 * 1. `window._AMapSecurityConfig` 必须在 `AMapLoader.load` **之前**设置，顺序反了会报
 *    INVALID_USER_SCODE。本轮已收敛到唯一入口 lib/amapLoader.ts 的 loadAMap()（本组件不再自己赋值）。
 * 2. 地图容器必须有明确高度（这里写死 `h-[420px]`，不是 h-full / 百分比）。高度为 0 时
 *    地图不显示且不报错，非常难查。见下方容器 JSX。
 * 3. 路线不能两点直连：必须用插件算路（AMap.Walking / Riding / Transfer / Driving），
 *    取回调里的沿路坐标连成 Polyline：
 *      - walk  → routes[0].steps[].path
 *      - bike  → routes[0].rides[].path
 *      - drive → routes[0].steps[].path
 *      - bus   → plans[].path（Transfer 返回的完整方案折线，取 time 最小的一条，与 lib/amap.ts
 *                服务端「按 duration 取最快方案」的口径一致）
 *    字段名是 2026-10-23 在本机用探测脚本打原始 JSON 实测过的，不是凭记忆写的。
 * 4. SDK 加载失败 / 超时 → 降级到 RouteMap（见 phase === "fallback"）。单段路线算不出来
 *    同样整体降级：宁可用明确的「示意图」，也不在真实底图上画一条假直线。
 * 5. 地图下方要配「文字导航」：文字步骤必须和地图上的折线来自**同一个插件回调**，
 *    不能另打一次接口（两次算路可能选到不同方案，地图和文字就会对不上）。
 *    所以算路时把 steps / rides / plan.segments 里的 instruction / road / distance
 *    和折线一起存进 segmentNav，渲染只读这份数据。
 *    - 字段形状 2026-10-23 在本机用探测脚本实测：
 *        walk   → routes[0].steps[].{instruction,road,distance,time,path}
 *        bike   → routes[0].rides[].{instruction,road,distance,time,path}
 *        drive  → routes[0].steps[].{instruction,road,distance,time,path}
 *        bus    → plans[i].segments[].{instruction,transit_mode,distance,time}
 *    其中步行/骑行/驾车的 instruction 自带路名和距离（如「沿富春路辅路步行539米右转」），
 *    文字导航直接原样展示，不改写、不补「第三个路口右转」这种编出来的转向（铁律：不编造）。
 *
 * 本轮追加（返程，验收项）：
 * 6. 响应 segments 比 stops 多最后一段「末站 → 终点」：默认终点 = 起点（toId = "origin"），
 *    用户自定义终点时 toId = "destination"。这一段与普通站间段一样走插件算路、画折线，
 *    并进文字导航——标题写成「返程 · 步行/公交/打车/骑行 X 分钟」，不写成「第 N 段」。
 *    自定义终点额外画一个 SVG 旗标；默认终点 = 起点时不重复画标记，折线直接连回起点菱形。
 *    终点坐标 / 名字全部读 Itinerary.destination 快照，不在前端解析地址。
 *
 * M19 追加（路线重播，验收项）：
 * 7. 新增可选 prop `animationKey`：值**变化** → 重播一次轨迹动画（复位「已播过」状态、清掉旧动画/
 *    圆点、所有 Polyline 先复位成单点再从头播）。同 key 的任意重渲染（父组件无关 state、地图缩放/
 *    拖动）不重播；播放中父组件重渲染也不会重播。`prefers-reduced-motion: reduce` 下 key 变化同样
 *    不播，直接完整显示。实现位于绘制 effect 顶部的 lastAnimationKeyRef 比较。详见该处注释。
 *
 * 职责边界：本组件只负责「把 planner 已经算好的 stops / segments 画出来」，
 * 不参与任何排程、选点、时间计算（00-common 铁律 3）；站点名称 / 坐标全部读 stops 自带的
 * placeName / lng / lat 快照字段，不持有任何静态地点表、不生成地点（铁律 1）。
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * 高德 JSAPI 版本号统一由 lib/amapLoader.ts 负责（本组件不再自己传 version）。
 * 路线插件清单与 lib/amapSdk.ts 共用同一份（AMAP_SDK_PLUGINS），避免两处各写一套。
 */
const AMAP_PLUGINS = AMAP_SDK_PLUGINS;

/** SDK 加载超时：超时直接降级 SVG，不让用户对着空白容器等。 */
const SDK_LOAD_TIMEOUT_MS = 10_000;

/** 底图瓦片就绪的兜底等待：瓦片慢时不能把路线绘制也卡死。 */
const MAP_READY_TIMEOUT_MS = 6_000;

/** 单段路线搜索超时。 */
const ROUTE_SEARCH_TIMEOUT_MS = 12_000;

/** 单段路线失败后重试一次，仍然失败就整体降级。 */
const ROUTE_RETRY_DELAY_MS = 400;

/** 公交插件必须带城市：由页面从城市配置（/api/cities 的 transferCityName）经 props 传入，不写死。 */

/** 路线折线样式。 */
const ROUTE_STROKE_WEIGHT = 6;
const ROUTE_STROKE_OPACITY = 0.62;
const ROUTE_OUTLINE_WEIGHT = 1.5;

/**
 * 返程折线样式（本轮验收）：返程段一定和去程部分重叠（从家出去再回家，几何上无法避免），
 * 不避让、用视觉区分——石灰色虚线 + 低透明度 + 低于去程的 zIndex，让「怎么回家」一眼和
 * 「去了哪几站」分开。文字导航里的「返程 · 步行 X 分钟」标题已经存在，这里不重复造。
 */
const RETURN_STROKE_COLOR = "#78716c";
const RETURN_STROKE_OPACITY = 0.35;
const RETURN_Z_INDEX = 100;

/** 去程折线的 zIndex 基数（返程固定 100，必须低于去程的 110+）。 */
const ROUTE_Z_INDEX_BASE = 110;

/** 轨迹动画：总时长 T = 3500ms，按各段路径点数分配（本轮验收）。 */
const ROUTE_ANIMATION_DURATION_MS = 3_500;

/** 轨迹动画移动圆点的 zIndex：压在所有折线（110+）之上、站点标记（120）之下。 */
const ROUTE_CURSOR_Z_INDEX = 119;

/**
 * 每段路线一种颜色，半透明叠加后仍能分辨。
 * 色相均匀分布（蓝/橙/绿/青/紫），在浅色底图上都够醒目；刻意避开紫→粉渐变。
 * 段数超过 5 时循环取色。
 *
 * 文字导航的段标题也用这一组颜色（内联 style 引用同一个常量，不另写一套色值）：
 * 地图上第 2 段是橙色，列表里第 2 段标题就是橙色，两边永远对得上。
 */
const ROUTE_COLORS = ["#2563eb", "#ea580c", "#16a34a", "#0891b2", "#7c3aed"];

/** 通勤方式的中文标签（与 lib/planner.ts 的 MODE_LABEL 同一口径）。 */
const MODE_LABEL: Record<SegmentMode, string> = {
  walk: "步行",
  bus: "公交",
  drive: "打车",
  bike: "骑行",
};

/** 「用高德导航」URL 的 mode 参数（walk→walk / bike→ride / bus→bus / drive→car）。 */
const NAVIGATION_MODE: Record<SegmentMode, string> = {
  walk: "walk",
  bike: "ride",
  bus: "bus",
  drive: "car",
};

/** 高德 H5 导航的来源标记（src=shuozou）。 */
const NAVIGATION_SRC = "shuozou";

/** 步数超过这个值的段默认折叠：先显示前 8 步，按钮「展开全部 N 步」。 */
const STEP_COLLAPSE_THRESHOLD = 8;

/** 地图自适应视野：四周留白 + 最大缩放级别（两站很近时不至于把地图放到 20 级）。 */
const FIT_VIEW_PADDING: number[] = [48, 48, 48, 48];
const FIT_VIEW_MAX_ZOOM = 17;

/** 站点圆点的直径（画布类名里的 h-6 是 24px；这里只用于太阳标记 SVG 半径换算）。 */
const SUN_MARKER_RAYS = Array.from({ length: 8 }, (_, index) => {
  const angle = (Math.PI * 2 * index) / 8;
  return {
    x1: round(14 + Math.cos(angle) * 6),
    y1: round(14 + Math.sin(angle) * 6),
    x2: round(14 + Math.cos(angle) * 9.5),
    y2: round(14 + Math.sin(angle) * 9.5),
  };
});

/**
 * 高德标记里的太阳图标（日落锚点站用）。线条画，不用 emoji（铁律 11）。
 * class 用 Tailwind token，避免硬编码颜色值。
 */
const SUN_MARKER_SVG =
  `<svg viewBox="0 0 28 28" class="h-7 w-7" aria-hidden="true">` +
  SUN_MARKER_RAYS.map(
    (ray) =>
      `<line x1="${ray.x1}" y1="${ray.y1}" x2="${ray.x2}" y2="${ray.y2}" class="stroke-amber-500" stroke-width="1.5" stroke-linecap="round" />`,
  ).join("") +
  `<circle cx="14" cy="14" r="8" class="fill-amber-500 stroke-white" stroke-width="1.5" />` +
  `</svg>`;

/**
 * 高德标记里的终点旗标（用户自定义终点用）。线条画，不用 emoji（铁律 11）；
 * class 用 Tailwind token，不硬编码颜色。旗杆底端在 (7, 25)，标记按 bottom-center 锚定。
 */
const DESTINATION_MARKER_SVG =
  `<svg viewBox="0 0 28 28" class="h-7 w-7" aria-hidden="true">` +
  `<line x1="7" y1="25" x2="7" y2="4" class="stroke-stone-900" stroke-width="1.8" stroke-linecap="round" />` +
  `<path d="M 7 4 L 21 8 L 7 12 Z" class="fill-stone-900 stroke-white" stroke-width="1.2" stroke-linejoin="round" />` +
  `</svg>`;

// ---------------------------------------------------------------------------
// 高德 JSAPI 的最小类型声明
//
// @amap/amap-jsapi-loader 只给了 `load(): Promise<any>`，项目里也没有 @types/amap-jsapi-types。
// 这里只声明本组件真正用到的成员，字段名与实测回调一致；不用 any 污染业务代码。
// ---------------------------------------------------------------------------

type LngLatTuple = [number, number];

/** 一段路里的「一步」：walk / drive 在 steps、bike 在 rides，字段名实测一致。 */
type AmapRouteStep = {
  path?: unknown;
  instruction?: unknown;
  road?: unknown;
  distance?: unknown;
};

/** 公交方案里的一小段：instruction 原样来自高德（如「乘坐96路…途径4站到达官巷口」）。 */
type AmapTransitSegment = {
  instruction?: unknown;
  road?: unknown;
  distance?: unknown;
  transit_mode?: unknown;
};

type AmapRoute = {
  steps?: AmapRouteStep[];
  rides?: AmapRouteStep[];
  time?: number | string;
  distance?: number | string;
};

type AmapTransitPlan = {
  path?: unknown;
  time?: number | string;
  segments?: AmapTransitSegment[];
};

type AmapRouteResult = { routes?: AmapRoute[]; plans?: AmapTransitPlan[] };

type AmapRouteSearch = {
  search: (
    from: LngLatTuple,
    to: LngLatTuple,
    callback: (status: string, result: AmapRouteResult | null) => void,
  ) => void;
};

type AmapMapInstance = {
  add: (overlay: unknown) => void;
  remove: (overlay: unknown) => void;
  setFitView: (overlays?: unknown, immediately?: boolean, avoid?: number[], maxZoom?: number) => void;
  resize: () => void;
  destroy: () => void;
  on: (event: string, callback: () => void) => void;
  off: (event: string, callback: () => void) => void;
  getZoom: () => number;
  getCenter: () => unknown;
  /** M19 验收钩子用（真实地图实例）：直接改缩放 / 中心，等价于用户手动缩放、拖动。 */
  setZoom: (zoom: number) => void;
  setCenter: (center: LngLatTuple | unknown) => void;
};

/**
 * 本组件用到的 Polyline 能力：轨迹动画只改 path（setPath），不重建覆盖物。
 * 实测（2026-10-24，AMap 2.0）：setPath([]) 确实生效（getPath() 返回 []），但会打
 * console.error("Polyline path")；单点 path 不报错、也画不出线，所以动画的「未画出」初始状态
 * 用单点 path 实现（见 startRouteAnimation）。
 */
type AmapPolyline = {
  setPath: (path: Array<LngLatTuple | unknown>) => void;
  getPath?: () => unknown;
  getOptions?: () => Record<string, unknown>;
};

/** 本组件用到的 Marker 能力：移动圆点每帧只改 position。 */
type AmapMarkerInstance = {
  setPosition: (position: LngLatTuple | unknown) => void;
};

type AmapNamespace = {
  Map: new (container: HTMLElement, options?: Record<string, unknown>) => AmapMapInstance;
  Polyline: new (options: Record<string, unknown>) => AmapPolyline;
  Marker: new (options: Record<string, unknown>) => AmapMarkerInstance;
  Walking: new (options?: Record<string, unknown>) => AmapRouteSearch;
  Riding: new (options?: Record<string, unknown>) => AmapRouteSearch;
  Transfer: new (options?: Record<string, unknown>) => AmapRouteSearch;
  Driving: new (options?: Record<string, unknown>) => AmapRouteSearch;
  plugin: (plugins: string[], callback?: () => void) => void;
};

type Endpoint = { lng: number; lat: number };

/**
 * 一步文字指令。instruction 原样来自高德，不做任何改写；
 * road / distance 也一起存下来（instruction 里通常已包含，但按用户要求「三样都取出来」，
 * 后续做跳转或无障碍文案时不用再算一遍路）。
 */
type RouteStepDetail = {
  instruction: string;
  road: string;
  distanceM: number | null;
};

/** 一段路：沿路折线 + 文字步骤。必须来自同一次插件回调，地图和文字才是一回事。 */
type CachedRoute = {
  path: LngLatTuple[];
  steps: RouteStepDetail[];
};

/** 渲染「地图下方文字导航」的每段数据。 */
type SegmentNavigation = {
  /** React key：段序号 + 起终点，换行程时不会串。 */
  key: string;
  /** 原行程里的段序号，用来取和地图折线同一个颜色。 */
  index: number;
  mode: SegmentMode;
  durationMin: number;
  destinationName: string;
  /** 目的地缺名字时不给链接（宁可不跳，也不跳到一个没有名字的点）。 */
  navigationUrl: string | null;
  steps: RouteStepDetail[];
  /**
   * 是不是返程段（segments 比 stops 多出来的最后一段）：标题写成「返程 · 步行 12 分钟」，
   * 不写「第 4 段 ·」——用户要的是「走完这几站，怎么回去」这一件事。
   */
  isReturn: boolean;
  /**
   * 这一段「起步那条路」的路名（本轮新增可选字段）：来自服务端 Segment.road。
   * 有值 → 标题写成「第 1 段 · 沿后地路步行 3 分钟」；没有（公交段 / 高德没给）→ 保持原样。
   * 站点副行与这里用同一个 lib/roadText.ts 的前缀与截断规则，两处永远一致。
   */
  road?: string;
};

/** 折线实际落到 AMap.Polyline 上的样式（也导出到 debug 钩子，验收脚本据此断言返程样式）。 */
type RoutePolylineStyle = {
  strokeColor: string;
  strokeStyle: "solid" | "dashed";
  strokeOpacity: number;
  strokeWeight: number;
  zIndex: number;
};

type RouteMapDebugSegment = {
  fromId: string;
  toId: string;
  mode: SegmentMode;
  pointCount: number;
  path: LngLatTuple[];
  /** 文字步骤也导出给验证脚本，证明 instruction / road / distance 都取到了。 */
  steps: RouteStepDetail[];
  /** 这一段是不是返程（segments 最后一段）。 */
  isReturn: boolean;
  /** 实际传给 AMap.Polyline 的样式（验收：返程 = dashed / #78716c / 0.35 / zIndex 100）。 */
  style: RoutePolylineStyle;
};

/**
 * 轨迹动画的运行时状态（仅 development 导出到 window.__AMAP_ROUTE_DEBUG__.motion）。
 * 每帧原地更新 pointCounts，验收脚本可以据此判断「动画进行到哪了 / 是否重播」。
 */
type RouteMotionDebug = {
  durationMs: number;
  /** 本页是否播过动画（含被点击跳过）；reduced-motion 时为 false。 */
  played: boolean;
  /** 当前是否正在播放。 */
  active: boolean;
  /** 是否被「点地图任意位置」提前结束。 */
  skipped: boolean;
  /** 是否因为 prefers-reduced-motion 直接完整显示。 */
  reducedMotion: boolean;
  /** 本页动画启动次数（换站 / 重新算路不应增加）。 */
  runs: number;
  startedAtMs: number;
  completedAtMs: number;
  /** 每条折线当前实际 path 点数（动画中 < fullPointCounts）。 */
  pointCounts: number[];
  fullPointCounts: number[];
  /** 移动圆点当前是否在图上。 */
  dotVisible: boolean;
};

/** development 挂到 window 上的验收钩子（生产构建不出现）。 */
type RouteMapDebug = {
  mapReady: boolean;
  segments: RouteMapDebugSegment[];
  /** 第几次绘制（换站 / 重排 +1）：验证「换站不重播」时用来区分新旧一次绘制。 */
  drawId: number;
  /** 本次绘制完成的时刻（performance.now()）。 */
  drawnAtMs: number;
  /**
   * M19 新增：本次绘制拿到的路线重播令牌（animationKey prop 的原值；未传时 undefined）。
   * 验收脚本用它区分「同 key 重渲染」与「key 变化触发的重播」。
   */
  animationKey?: number;
  /** 轨迹动画状态。 */
  motion: RouteMotionDebug;
  /** 真实的 AMap.Polyline 覆盖物：验收脚本可以在页面里读 getPath() 等真实属性。 */
  polylines: AmapPolyline[];
  /**
   * 当前地图视野快照：验收脚本在动画中采样两次，若一致就证明「动画期间没有触发 fitView 重算」。
   * 地图已销毁时返回 null。
   */
  getView: () => { zoom: number; lng: number; lat: number } | null;
  /**
   * M19 新增：真实地图实例（仅 development）。验收脚本可以像用户一样直接对地图做
   * `setZoom` / `setCenter` 等操作，验证「手动缩放/拖动地图不会触发动画重播」。
   * 地图已销毁时返回 null。
   */
  getMap: () => AmapMapInstance | null;
};

declare global {
  interface Window {
    /**
     * 仅 development 挂载的验证钩子：给无头浏览器 / 控制台导出每段折线的真实沿路坐标、
     * 折线样式与轨迹动画状态，用来证明「路线贴着街道走，不是两点直连」以及动画行为。
     * 生产构建不会出现。
     */
    __AMAP_ROUTE_DEBUG__?: RouteMapDebug;
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/**
 * 从 Tailwind 的 class 上读实际颜色，而不是把十六进制值写死在 JS 里。
 * 高德 Polyline 的 strokeColor 只接受颜色字符串（不认 className），
 * 但颜色本身仍然由 tailwind.config.ts 这一处主题决定。
 */
const resolvedColorCache = new Map<string, string>();

function readTailwindColor(className: string): string {
  const cached = resolvedColorCache.get(className);
  if (cached !== undefined) return cached;
  const probe = document.createElement("span");
  probe.className = className;
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  document.body.appendChild(probe);
  const color = window.getComputedStyle(probe).color;
  probe.remove();
  const resolved = color === "" ? "rgb(68, 64, 60)" : color;
  resolvedColorCache.set(className, resolved);
  return resolved;
}

/**
 * 站点快照：planner 在返回行程前把地点名 / 坐标填进 stop，地图不再持有静态地点表。
 * 缺坐标的站在建索引时跳过（resolveEndpoint 返回 null，上层跳过这一段）。
 */
type StopLocation = { lng: number; lat: number; name: string };

/** 把 stops 建成「placeId → 坐标 / 名称」索引，替代原来的只读地点表。 */
function buildStopLocations(stops: Stop[]): Map<string, StopLocation> {
  const locations = new Map<string, StopLocation>();
  for (const stop of stops) {
    if (stop.lng === undefined || stop.lat === undefined) continue;
    locations.set(stop.placeId, {
      lng: stop.lng,
      lat: stop.lat,
      // 缺名字时给占位名，不臆造地点（正常行程由 planner 保证有值）。
      name: stop.placeName ?? "未知地点",
    });
  }
  return locations;
}

/**
 * 段端点坐标：
 * - "origin" → 起点（页面传的城市起点或用户自定义起点的快照坐标）；
 * - "destination" → 返程终点快照（用户自定义终点；默认「回到起点」时 toId 是 "origin"，走第一条）；
 * - 其余 placeId → stops 自带的经纬度快照。
 */
function resolveEndpoint(
  placeId: string,
  origin: Endpoint,
  destination: ItineraryEndpoint | null,
  stopLocations: Map<string, StopLocation>,
): Endpoint | null {
  if (placeId === "origin") return origin;
  if (placeId === "destination") {
    if (destination === null) return null;
    return { lng: destination.lng, lat: destination.lat };
  }
  const location = stopLocations.get(placeId);
  if (location === undefined) return null;
  return { lng: location.lng, lat: location.lat };
}

/**
 * 段终点的显示名（文字导航 / 高德导航链接用）：
 * - 返回到起点："origin" 用行程起点快照的名字（旧数据没有时退成「起点」）；
 * - 返回到自定义终点：用 destination.name（用户填的地址文本，服务端原样带回，不编造）；
 * - 其余站点：用 stops 快照里的 placeName。
 */
function resolveEndpointName(
  toId: string,
  destination: ItineraryEndpoint | null,
  originName: string | undefined,
  stopLocations: Map<string, StopLocation>,
): string {
  if (toId === "origin") {
    return originName !== undefined && originName.length > 0 ? originName : "起点";
  }
  if (toId === "destination") return destination === null ? "" : destination.name;
  return stopLocations.get(toId)?.name ?? "";
}

function formatEndpointKey(endpoint: Endpoint): string {
  return `${endpoint.lng.toFixed(6)},${endpoint.lat.toFixed(6)}`;
}

/** 单段路线的缓存键：同一对坐标 + 同一种方式不重复打接口（换站时多数路段坐标没变）。 */
function routeCacheKey(mode: SegmentMode, from: Endpoint, to: Endpoint): string {
  return `${mode}|${formatEndpointKey(from)}|${formatEndpointKey(to)}`;
}

/** 回调里的 path 可能是 [lng,lat] 数组，也可能是 LngLat 对象；统一成 [lng,lat]。 */
function normalizePoint(raw: unknown): LngLatTuple | null {
  if (Array.isArray(raw)) {
    const lng = Number(raw[0]);
    const lat = Number(raw[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    return [lng, lat];
  }
  if (typeof raw === "object" && raw !== null) {
    const record = raw as { lng?: unknown; lat?: unknown };
    const lng = Number(record.lng);
    const lat = Number(record.lat);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    return [lng, lat];
  }
  return null;
}

function normalizePath(raw: unknown): LngLatTuple[] {
  if (!Array.isArray(raw)) return [];
  const points: LngLatTuple[] = [];
  for (const item of raw) {
    const point = normalizePoint(item);
    if (point !== null) points.push(point);
  }
  return points;
}

/** 把多个 step / ride 的 path 拼成一条折线，并去掉相邻重复点（step 首尾会重复）。 */
function mergePaths(chunks: LngLatTuple[][]): LngLatTuple[] {
  const merged: LngLatTuple[] = [];
  for (const chunk of chunks) {
    for (const point of chunk) {
      const previous = merged[merged.length - 1];
      if (previous !== undefined && previous[0] === point[0] && previous[1] === point[1]) continue;
      merged.push(point);
    }
  }
  return merged;
}

/** road 实测是字符串；少数版本可能给数组，统一成可读字符串（没有就空串）。 */
function normalizeRoad(raw: unknown): string {
  if (typeof raw === "string") return raw.trim();
  if (Array.isArray(raw)) {
    return raw
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .join(" / ");
  }
  return "";
}

function normalizeDistance(raw: unknown): number | null {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** 高德回调里的一步 → 可渲染的文字步骤；没有 instruction 的步骤不展示（不自己编）。 */
function extractStepDetail(raw: {
  instruction?: unknown;
  road?: unknown;
  distance?: unknown;
}): RouteStepDetail | null {
  const instruction = typeof raw.instruction === "string" ? raw.instruction.trim() : "";
  if (instruction === "") return null;
  return {
    instruction,
    road: normalizeRoad(raw.road),
    distanceM: normalizeDistance(raw.distance),
  };
}

/**
 * 从插件回调里取「沿路折线 + 文字步骤」，两者必须来自同一次回调（见文件头注释第 5 条）。
 * 返回 null 表示这段路没算出来，由上层做整体降级。
 */
function extractRouteData(result: AmapRouteResult, mode: SegmentMode): CachedRoute | null {
  if (mode === "bus") {
    const plans = Array.isArray(result.plans) ? result.plans : [];
    let best: CachedRoute | null = null;
    let bestTime = Number.POSITIVE_INFINITY;
    for (const plan of plans) {
      const path = normalizePath(plan.path);
      if (path.length < 2) continue;
      // 公交的文字步骤在 plan.segments[].instruction（实测字段见文件头注释）。
      const steps: RouteStepDetail[] = [];
      for (const segment of plan.segments ?? []) {
        const detail = extractStepDetail(segment);
        if (detail !== null) steps.push(detail);
      }
      const time = Number(plan.time);
      const comparable = Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
      // 取最快方案（与 lib/amap.ts 服务端选最快公交方案的口径一致）；时间缺失时取第一条可用方案。
      if (best === null || comparable < bestTime) {
        best = { path, steps };
        bestTime = comparable;
      }
    }
    return best;
  }

  const routes = Array.isArray(result.routes) ? result.routes : [];
  const first = routes[0];
  if (first === undefined) return null;

  const rawSteps = mode === "bike" ? first.rides ?? [] : first.steps ?? [];
  const chunks: LngLatTuple[][] = [];
  const steps: RouteStepDetail[] = [];
  for (const step of rawSteps) {
    chunks.push(normalizePath(step.path));
    const detail = extractStepDetail(step);
    if (detail !== null) steps.push(detail);
  }
  const merged = mergePaths(chunks);
  return merged.length >= 2 ? { path: merged, steps } : null;
}

/**
 * 每一段标题右侧的「用高德导航」链接（用户指定格式）。
 * 注意 to 是**这一段的终点**，不是整份行程的终点；mode 按段映射 walk→walk / bike→ride / bus→bus / drive→car。
 * callnative=1 表示优先唤起高德 App；没有 App 时由高德页面兜底。
 */
function buildNavigationUrl(
  mode: SegmentMode,
  to: Endpoint,
  destinationName: string,
): string | null {
  if (destinationName === "") return null;
  const destination = `${to.lng},${to.lat},${encodeURIComponent(destinationName)}`;
  return (
    `https://uri.amap.com/navigation?to=${destination}` +
    `&mode=${NAVIGATION_MODE[mode]}&callnative=1&coordinate=gaode&src=${NAVIGATION_SRC}`
  );
}

/**
 * 「第 1 段 · 步行 11 分钟」；返程段写成「返程 · 步行 11 分钟」（本轮验收要求）。
 *
 * 本轮新增 road：有路名时写成「第 1 段 · 沿后地路步行 3 分钟」（返程同理「返程 · 沿运道骑行 19 分钟」）；
 * 没有路名（公交段 / 高德没给）时严格保持改造前的一字不差。
 */
function formatSegmentTitle(
  index: number,
  mode: SegmentMode,
  durationMin: number,
  isReturn: boolean,
  road?: string,
): string {
  const durationText = durationMin <= 0 ? "不到 1 分钟" : `${durationMin} 分钟`;
  const prefix = roadPrefix(road);
  const title = `${prefix === null ? "" : prefix}${MODE_LABEL[mode]} ${durationText}`;
  return isReturn ? `返程 · ${title}` : `第 ${index + 1} 段 · ${title}`;
}

function createRouteSearcher(
  AMap: AmapNamespace,
  mode: SegmentMode,
  transferCityName: string,
): AmapRouteSearch | null {
  try {
    // 不传 map：插件只负责算路返回数据，路线由我们自己的 Polyline 画，避免插件再画一条默认线。
    if (mode === "walk") return new AMap.Walking({ hideMarkers: true });
    if (mode === "bike") return new AMap.Riding({ hideMarkers: true });
    if (mode === "drive") return new AMap.Driving({ hideMarkers: true });
    // 公交线路必须指定城市名（杭州「杭州市」/ 辽阳「辽阳市」），否则会按错误城市算路。
    return new AMap.Transfer({ hideMarkers: true, city: transferCityName, cityd: transferCityName });
  } catch {
    return null;
  }
}

/** 调一次插件算路（带超时）；失败返回 null。成功时折线和文字步骤一起返回。 */
function searchRoadRoute(
  AMap: AmapNamespace,
  mode: SegmentMode,
  from: Endpoint,
  to: Endpoint,
  transferCityName: string,
): Promise<CachedRoute | null> {
  const searcher = createRouteSearcher(AMap, mode, transferCityName);
  if (searcher === null) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (route: CachedRoute | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(route);
    };
    const timer = window.setTimeout(() => finish(null), ROUTE_SEARCH_TIMEOUT_MS);
    try {
      searcher.search([from.lng, from.lat], [to.lng, to.lat], (status, result) => {
        if (status !== "complete" || result === null || result === undefined) {
          finish(null);
          return;
        }
        finish(extractRouteData(result, mode));
      });
    } catch {
      finish(null);
    }
  });
}

/** 算一段路：失败重试一次，仍失败才放弃（放弃 = 整体降级 SVG，不画假直线）。 */
async function searchRoadRouteWithRetry(
  AMap: AmapNamespace,
  mode: SegmentMode,
  from: Endpoint,
  to: Endpoint,
  cache: Map<string, CachedRoute>,
  transferCityName: string,
): Promise<CachedRoute | null> {
  const key = routeCacheKey(mode, from, to);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const route = await searchRoadRoute(AMap, mode, from, to, transferCityName);
    if (route !== null) {
      cache.set(key, route);
      return route;
    }
    if (attempt === 0) await delay(ROUTE_RETRY_DELAY_MS);
  }
  return null;
}

/** 插件已随 load 预加载过，这里再显式 plugin 一次（用户约定写法），并用超时兜底避免卡住。 */
function ensureRoutePlugins(AMap: AmapNamespace): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(finish, 3000);
    try {
      AMap.plugin(AMAP_PLUGINS, finish);
    } catch {
      finish();
    }
  });
}

/** 等底图 complete；瓦片慢时最多等 MAP_READY_TIMEOUT_MS，不阻塞路线绘制。 */
function waitForMapReady(map: AmapMapInstance): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(finish, MAP_READY_TIMEOUT_MS);
    try {
      map.on("complete", finish);
    } catch {
      finish();
    }
  });
}

/** 起点标记：菱形（和站点的圆点区分开，与 RouteMap 的视觉语言一致）。 */
function createOriginMarkerElement(): HTMLElement {
  const element = document.createElement("div");
  element.className = "h-3 w-3 rotate-45 bg-stone-400 ring-2 ring-white";
  element.title = "起点";
  return element;
}

/** 站点标记：普通站是深色圆点 + 序号；日落站换成太阳（与 RouteMap 的 isSunsetStop 口径一致）。 */
function createStopMarkerElement(index: number, sunset: boolean, placeName: string): HTMLElement {
  const element = document.createElement("div");
  element.title = placeName;
  if (sunset) {
    element.className = "relative flex h-7 w-7 items-center justify-center";
    element.innerHTML =
      SUN_MARKER_SVG +
      `<span class="absolute text-[11px] font-medium leading-none text-white">${index + 1}</span>`;
    return element;
  }
  element.className =
    "flex h-6 w-6 items-center justify-center rounded-full bg-stone-900 text-[11px] font-medium text-white ring-2 ring-white";
  element.textContent = String(index + 1);
  return element;
}

/**
 * 自定义终点标记：SVG 旗标（不用 emoji），只画一次；默认终点 = 起点时不会创建它，
 * 避免起点位置叠两个标记。
 */
function createDestinationMarkerElement(placeName: string): HTMLElement {
  const element = document.createElement("div");
  element.className = "flex h-7 w-7 items-end justify-center";
  element.title = `终点：${placeName}`;
  element.innerHTML = DESTINATION_MARKER_SVG;
  return element;
}

/**
 * 日落站判定（与 RouteMap 同一口径）：
 * planner 只在「户外日落点被锚定在日落窗口到站」时，才在 reason 末尾追加「赶得上 … 的日落」，
 * 所以 reason 里写明日落就是唯一判据。地点标签不再下发给前端，也不再参与判定
 * （只按标签判会误标一个中午路过的日落点）。
 */
function isSunsetStop(stop: Stop): boolean {
  return stop.reason.indexOf("日落") !== -1;
}

/**
 * 系统是否开启了「减少动态效果」。开启时路线直接完整显示，不播轨迹动画（任务书第三步细节）。
 * matchMedia 在无头浏览器 / 旧环境里可能不存在，取不到一律按「没开」处理（不影响功能）。
 */
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** 轨迹动画的时间点。 */
type RoutePolylineEntry = {
  /** 真实的 AMap.Polyline：动画只对它调 setPath。 */
  polyline: AmapPolyline;
  /** 完整沿路坐标（动画的终点状态；不动它，只 slice 后 setPath）。 */
  path: LngLatTuple[];
};

type RouteAnimationParams = {
  map: AmapMapInstance;
  AMap: AmapNamespace;
  entries: RoutePolylineEntry[];
  /** 动画状态写回这个对象（已挂在 window.__AMAP_ROUTE_DEBUG__.motion 上）。 */
  motion: RouteMotionDebug;
  /** 圆点同样进 overlaysRef：换行程时和折线一起被清掉，不泄漏。 */
  addOverlay: (overlay: unknown) => void;
  /** 自然播完 / 点击跳过时回调一次；effect 清理导致的取消不回调。 */
  onComplete: (reason: "finished" | "skipped") => void;
};

type RouteAnimationHandle = {
  /** effect 清理时调用：停止 RAF、移除圆点、取消地图点击监听，并把折线恢复完整。 */
  cancel: () => void;
};

/**
 * 轨迹动画（任务书第三步）：
 * 1. 所有 Polyline 初始「不可见」（只保留首点，等效空 path——空数组会让 AMap 打 console.error，见下方注释）；
 * 2. 总时长 3500ms，按各段路径点数分配（点数多的段播得久，视觉速度一致）；
 * 3. 每帧 requestAnimationFrame：当前段逐步补点、已完成段保持完整、一个圆点沿当前段前进；
 * 4. 播完：恢复完整 path、圆点消失。
 *
 * 关键约束（验收项）：
 * - 动画期间不调 setFitView（视野在动画开始前一次性定好，地图不会跳）；
 * - 点地图任意位置 → 立即 finish("skipped")，马上恢复完整；
 * - 动画只改 setPath / setPosition，不重建覆盖物；圆点通过 addOverlay 进 overlaysRef；
 * - 取消（effect 清理 / 换行程 / 卸载）时停止 RAF 并移除圆点，不泄漏。
 */
function startRouteAnimation(params: RouteAnimationParams): RouteAnimationHandle {
  const { map, AMap, entries, motion, addOverlay, onComplete } = params;
  const fullPaths = entries.map((entry) => entry.path);
  const fullCounts = fullPaths.map((path) => path.length);
  const totalPoints = fullCounts.reduce((sum, count) => sum + count, 0);

  motion.pointCounts = fullCounts.map((count) => (count === 0 ? 0 : 1));
  motion.fullPointCounts = fullCounts.slice();
  motion.active = true;
  motion.skipped = false;
  motion.dotVisible = false;
  motion.startedAtMs = performance.now();
  motion.completedAtMs = 0;

  let finished = false;
  let frameId = 0;
  let cursor: AmapMarkerInstance | null = null;
  /**
   * 每条折线当前实际画出的点数（只在变化时 setPath）。
   * 初始态 = 1（只保留首点）：单点 Polyline 不画任何线，视觉上等同「空 path」。
   * 为什么不用 setPath([])：实测 AMap 2.0 上空数组虽然生效（getPath() 返回 []），但会打
   * console.error("Polyline path")——那会成为页面的异常报错。1 点 path 不报错、也画不出线。
   */
  const counts: number[] = fullCounts.map((count) => (count === 0 ? 0 : 1));

  /** 把「逻辑点数」收成合法值：非空 path 至少保留 1 个点（1 点画不出线，等效不可见）。 */
  const normalizeCount = (index: number, count: number) => {
    if (fullCounts[index] === 0) return 0;
    return Math.max(1, Math.min(count, fullCounts[index]));
  };

  const setCount = (index: number, rawCount: number) => {
    const count = normalizeCount(index, rawCount);
    if (counts[index] === count) return;
    const target = count >= fullCounts[index] ? fullPaths[index] : fullPaths[index].slice(0, count);
    try {
      entries[index].polyline.setPath(target);
    } catch {
      // 地图已销毁 / 覆盖物已移除：这一帧起动画静默结束，由 cancel 或下面的 finish 收尾。
      return;
    }
    counts[index] = count;
    motion.pointCounts = counts.slice();
  };

  /** 恢复所有折线为完整 path（播完 / 跳过 / 取消共用）。 */
  const restoreFullPaths = () => {
    for (let index = 0; index < entries.length; index += 1) setCount(index, fullCounts[index]);
  };

  const removeCursor = () => {
    if (cursor === null) return;
    try {
      map.remove(cursor);
    } catch {
      // 已经不在图上：忽略。
    }
    cursor = null;
    motion.dotVisible = false;
  };

  function handleMapClick() {
    finish("skipped");
  }

  const cleanup = () => {
    if (frameId !== 0) {
      window.cancelAnimationFrame(frameId);
      frameId = 0;
    }
    try {
      map.off("click", handleMapClick);
    } catch {
      // 地图已销毁：忽略。
    }
    removeCursor();
  };

  function finish(reason: "finished" | "skipped") {
    if (finished) return;
    finished = true;
    cleanup();
    restoreFullPaths();
    motion.active = false;
    motion.skipped = reason === "skipped";
    motion.completedAtMs = performance.now();
    onComplete(reason);
  }

  // 1) 所有 Polyline 初始「不可见」：只保留首点（1 个点的 Polyline 画不出线）。
  //    不用空数组的原因见上面 counts 注释：AMap 2.0 会对空 path 打 console.error。
  for (let index = 0; index < entries.length; index += 1) {
    const firstPoint = fullPaths[index][0];
    if (firstPoint === undefined) continue;
    try {
      entries[index].polyline.setPath([firstPoint]);
    } catch {
      // 地图已销毁：忽略（动画会自然结束）。
    }
  }
  motion.pointCounts = counts.slice();

  // 3) 移动圆点：小 Marker，沿当前段前进；和站点标记区分（12px 深色圆点 + 白色描边）。
  const firstPoint = fullPaths.find((path) => path.length > 0)?.[0];
  if (firstPoint !== undefined) {
    try {
      const marker = new AMap.Marker({
        position: [firstPoint[0], firstPoint[1]],
        anchor: "center",
        content: createRouteCursorElement(),
        zIndex: ROUTE_CURSOR_Z_INDEX,
      });
      // 进 overlaysRef：换行程时会被统一清掉（和折线、站点标记同一套清理逻辑）。
      addOverlay(marker);
      cursor = marker;
      motion.dotVisible = true;
    } catch {
      cursor = null;
    }
  }

  // 动画期间点地图任意位置 → 立即完整。
  try {
    map.on("click", handleMapClick);
  } catch {
    // 地图已销毁：忽略（动画会自然结束）。
  }

  if (totalPoints === 0) {
    finish("finished");
    return { cancel: () => undefined };
  }

  /** 把「整体进度 0..1」映射成每段已画点数和圆点位置。 */
  const applyProgress = (progress: number) => {
    const drawnTotal = progress * totalPoints;
    let cursorPoint: LngLatTuple | null = null;
    let cumulative = 0;
    for (let index = 0; index < entries.length; index += 1) {
      const segmentPoints = fullCounts[index];
      const local = drawnTotal - cumulative;
      cumulative += segmentPoints;
      if (segmentPoints === 0) continue;
      if (local >= segmentPoints) {
        // 已完成段：保持完整。
        setCount(index, segmentPoints);
        continue;
      }
      if (local <= 0) {
        setCount(index, 0);
        continue;
      }
      const count = Math.max(1, Math.floor(local));
      setCount(index, count);
      // 圆点位置：在当前段第 count 个点和下一个点之间按小数部分插值，看起来是连续滑动。
      const path = fullPaths[index];
      const from = path[Math.min(count - 1, path.length - 1)];
      const to = path[Math.min(count, path.length - 1)];
      const fraction = local - Math.floor(local);
      cursorPoint = [
        from[0] + (to[0] - from[0]) * fraction,
        from[1] + (to[1] - from[1]) * fraction,
      ];
    }
    if (cursor !== null && cursorPoint !== null) {
      try {
        cursor.setPosition([cursorPoint[0], cursorPoint[1]]);
      } catch {
        // 地图已销毁：忽略。
      }
    }
    motion.dotVisible = cursor !== null;
  };

  const tick = (now: number) => {
    if (finished) return;
    const elapsed = now - motion.startedAtMs;
    const progress =
      ROUTE_ANIMATION_DURATION_MS <= 0 ? 1 : Math.min(1, elapsed / ROUTE_ANIMATION_DURATION_MS);
    applyProgress(progress);
    if (progress >= 1) {
      // 4) 播完：恢复完整 path、圆点消失。
      finish("finished");
      return;
    }
    frameId = window.requestAnimationFrame(tick);
  };
  frameId = window.requestAnimationFrame(tick);

  return {
    cancel: () => {
      if (finished) return;
      finished = true;
      cleanup();
      restoreFullPaths();
      motion.active = false;
    },
  };
}

/** 轨迹动画的移动圆点（线条画，不用 emoji）。data-testid 供验收脚本确认「动画中有 / 结束后无」。 */
function createRouteCursorElement(): HTMLElement {
  const element = document.createElement("div");
  element.className = "h-3 w-3 rounded-full bg-stone-900 ring-2 ring-white";
  element.setAttribute("data-testid", "route-cursor");
  element.setAttribute("aria-hidden", "true");
  return element;
}

/** 构造一份动画状态（debug 钩子用）：非动画路径直接把每条折线标成完整。 */
function createRouteMotionDebug(
  options: {
    reducedMotion: boolean;
    played: boolean;
    runs: number;
    pointCounts: number[];
  },
): RouteMotionDebug {
  return {
    durationMs: ROUTE_ANIMATION_DURATION_MS,
    played: options.played,
    active: false,
    skipped: false,
    reducedMotion: options.reducedMotion,
    runs: options.runs,
    startedAtMs: 0,
    completedAtMs: 0,
    pointCounts: options.pointCounts.slice(),
    fullPointCounts: options.pointCounts.slice(),
    dotVisible: false,
  };
}

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

export type AmapRouteMapProps = {
  /** 起点坐标（与 RouteMap 的 props 基本一致，页面切换组件时不用改数据结构）。 */
  origin: Endpoint;
  /** 行程站点：坐标 / 名称直接读 stop 自带的 placeName / lng / lat。 */
  stops: Stop[];
  /** 路段（顺序即行程顺序）：本轮起多最后一段返程（末站 → 起点 / 自定义终点）。 */
  segments: Segment[];
  /** 公交算路的城市名（城市配置 transferCityName），如「杭州市」/「辽阳市」。 */
  transferCityName: string;
  /**
   * 返程终点快照（本轮新增）：undefined / null = 回到起点；
   * placeId === "destination" 时画自定义终点旗标，返程段文字导航用它的名字。
   */
  destination?: ItineraryEndpoint | null;
  /** 起点显示名（本轮新增，可选）：自定义起点时是用户填的地址；返程到起点的文字导航用它。 */
  originName?: string;
  /**
   * 路线重播令牌（M19，可选）：值**变化** → 清掉旧动画/圆点、把「已播过」状态复位，从头重播一次。
   * 值不变的重渲染（父组件无关 state、地图手动缩放/拖动）不会重播；不传（undefined）时行为与改造前
   * 完全一致：只在首次画完路线时播一次。页面在「行程数据真的变了」时 +1（见 app/page.tsx）。
   */
  animationKey?: number;
};

type MapPhase = "loading" | "ready" | "fallback";

export default function AmapRouteMap({
  origin,
  stops,
  segments,
  transferCityName,
  destination,
  originName,
  animationKey,
}: AmapRouteMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<AmapMapInstance | null>(null);
  const amapRef = useRef<AmapNamespace | null>(null);
  /** 当前挂在地图上的所有覆盖物（标记 + 折线）：换行程时整批清掉重画。 */
  const overlaysRef = useRef<unknown[]>([]);
  /** 已算好的一段路（沿路折线 + 文字步骤，同坐标同方式不重复请求）。 */
  const routeCacheRef = useRef<Map<string, CachedRoute>>(new Map());
  const [phase, setPhase] = useState<MapPhase>("loading");
  /** 地图下方文字导航的数据：和地图折线来自同一次插件回调。 */
  const [segmentNav, setSegmentNav] = useState<SegmentNavigation[]>([]);
  /** 已展开的段（key 见 SegmentNavigation.key）；默认全部折叠，只对步数多的段生效。 */
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  /**
   * 轨迹动画是否已经播过：默认只在**首次**渲染路线时播一次。
   * 换站 / 改条件重排只是重画覆盖物（effect 重跑），这个 ref 保持 true，不重播。
   * M19：animationKey **真的变化**时会被重置为 false（见下方绘制 effect），也就是「明确要求重播一次」。
   */
  const motionPlayedRef = useRef(false);
  /**
   * 上一次已经处理过的 animationKey（M19）。
   * 初值取首次渲染时的 animationKey：首次挂载不算「变化」，首次播放仍由 motionPlayedRef=false 决定，
   * 所以 StrictMode / 父组件无关重渲染都不会被误判成重播请求。
   */
  const lastAnimationKeyRef = useRef<number | undefined>(animationKey);
  /** 本页动画启动次数（只增不减，仅供 debug 钩子断言「没重播」）。 */
  const motionRunsRef = useRef(0);
  /** debug 钩子里的绘制次数：每次画完 +1，验收脚本用来区分新旧一次绘制。 */
  const drawCountRef = useRef(0);

  const toggleSegmentExpanded = (key: string) => {
    setExpandedKeys((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /**
   * 加载高德 SDK 并创建地图。
   *
   * 加载逻辑统一在 lib/amapLoader.ts：安全密钥赋值与版本号都由 loadAMap() 负责，
   * 本组件只 await 结果，不再自己设置 window._AMapSecurityConfig、不再动态 import loader。
   * 全程取消标志配合 React StrictMode 的二次挂载：旧的异步任务不会往新地图上画东西。
   */
  useEffect(() => {
    let cancelled = false;
    setPhase("loading");

    // 本地降级计时器：loadAMap() 不绑定超时语义（启动页那边有自己的 10s 上限），
    // 地图这边等不到就显示 SVG，不让用户对着空白容器等。
    const sdkTimeout = window.setTimeout(() => {
      if (cancelled) return;
      console.warn("[AmapRouteMap] 高德地图 SDK 加载超时，降级为 SVG 示意图");
      setPhase("fallback");
    }, SDK_LOAD_TIMEOUT_MS);

    const boot = async () => {
      try {
        const AMap = (await loadAMap()) as AmapNamespace;
        if (cancelled) return;

        await ensureRoutePlugins(AMap);
        if (cancelled) return;

        const container = containerRef.current;
        if (container === null) throw new Error("地图容器还没挂载");

        const map = new AMap.Map(container, {
          zoom: 15,
          center: [origin.lng, origin.lat],
          viewMode: "2D",
          resizeEnable: true,
        });
        amapRef.current = AMap;
        mapRef.current = map;

        await waitForMapReady(map);
        if (cancelled) return;

        window.clearTimeout(sdkTimeout);
        setPhase("ready");
      } catch (error) {
        window.clearTimeout(sdkTimeout);
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[AmapRouteMap] 高德地图加载失败，降级为 SVG 示意图：${message}`);
        setPhase("fallback");
      }
    };
    void boot();

    return () => {
      cancelled = true;
      window.clearTimeout(sdkTimeout);
      const map = mapRef.current;
      mapRef.current = null;
      amapRef.current = null;
      overlaysRef.current = [];
      if (map !== null) {
        try {
          map.destroy();
        } catch {
          // 重复销毁 / StrictMode 下已经销毁过：忽略。
        }
      }
      if (process.env.NODE_ENV !== "production") delete window.__AMAP_ROUTE_DEBUG__;
    };
    // origin 由页面 useMemo 稳定（同一城市内引用不变）；这里作为依赖是为了城市切换时重建地图中心。
  }, [origin]);

  /**
   * 画覆盖物：起点 + 各站标记 + 每段「插件算出来的沿路折线」。
   * 任何一段路算不出来（插件失败 / 没有方案 / 超时）就整体降级 SVG——
   * 真实底图上不画两点直连的假路线。
   */
  useEffect(() => {
    if (phase !== "ready") return;
    const map = mapRef.current;
    const AMap = amapRef.current;
    if (map === null || AMap === null) return;

    /**
     * M19 路线重播（animationKey 契约）：只有「这次绘制看到的值」和「上次处理过的值」不同，
     * 才视为页面明确要求重播，把 motionPlayedRef 复位成 false（下面的 willAnimate 会因此重新为 true）。
     *
     * 为什么不会在无关重渲染时重播：
     * - 同 key 的父组件重渲染 / 展开收起 / 手动缩放拖动：本 effect 的依赖数组没有任何一项变化时
     *   根本不会重跑；即使因为 stops / segments 等引用重跑，这里 key 相等 → 不重置 → willAnimate=false；
     * - 播放中父组件重渲染：key 不变 → 不重置；即使 effect 重跑也是「已播过」状态，不会无限重播；
     * - 首次挂载：ref 初值 = 首次渲染的 animationKey，两边相等 → 不算变化，首次播放仍由
     *   motionPlayedRef 的初值决定（只播一次）。
     *
     * 旧动画不会叠加：effect 重跑前 React 一定先执行上一轮清理（routeAnimation.cancel() 停 RAF、
     * 移除圆点、恢复完整 path），本次绘制清掉旧覆盖物后重建折线，startRouteAnimation 再把所有
     * Polyline 复位成单点从头播——任何时刻只有一个 RAF 循环和一个圆点。
     */
    const animationKeyChanged = lastAnimationKeyRef.current !== animationKey;
    lastAnimationKeyRef.current = animationKey;
    if (animationKeyChanged) {
      motionPlayedRef.current = false;
    }

    let cancelled = false;
    // 站点快照索引：坐标 / 名称全部来自 stops 自带字段（planner 已填好），不再有静态地点表。
    const stopLocations = buildStopLocations(stops);
    // 返程终点快照：null / undefined 一律按「回到起点」处理（旧数据没有这个字段）。
    const destinationSnapshot = destination ?? null;
    // 只有自定义终点（placeId === "destination"）才画旗标；默认回到起点时起点标记已经在图上了。
    const customDestination =
      destinationSnapshot !== null && destinationSnapshot.placeId === "destination"
        ? destinationSnapshot
        : null;
    // 返程段判定：segments 比 stops 多出来的最后一段（与 /api/plan 契约一致）。
    const hasReturn = segments.length === stops.length + 1;

    // 换行程时先清空旧文字导航：地图马上要重画，下方不能还挂着上一份步骤。
    setSegmentNav([]);
    setExpandedKeys(new Set());

    // 换行程 / 重新挂载时：先清掉上一批覆盖物，再画新的（不叠线）。
    for (const overlay of overlaysRef.current) {
      try {
        map.remove(overlay);
      } catch {
        // 已经不在图上：忽略。
      }
    }
    overlaysRef.current = [];

    const addOverlay = (overlay: unknown) => {
      map.add(overlay);
      overlaysRef.current.push(overlay);
    };
    const fitView = (immediately: boolean) => {
      try {
        map.setFitView(overlaysRef.current, immediately, FIT_VIEW_PADDING, FIT_VIEW_MAX_ZOOM);
      } catch {
        // 覆盖物为空 / 地图已销毁：不影响主流程。
      }
    };

    /** 本批次折线的轨迹动画句柄：effect 清理（换行程 / 卸载）时取消，RAF 与圆点都不泄漏。 */
    let routeAnimation: RouteAnimationHandle | null = null;
    /**
     * 地图视野快照（debug 钩子用）：动画中采样两次若完全一致，就证明动画期间没有 fitView 重算。
     */
    const readView = (): { zoom: number; lng: number; lat: number } | null => {
      try {
        const center = map.getCenter() as
          | { getLng?: () => number; getLat?: () => number; lng?: number; lat?: number }
          | null
          | undefined;
        if (center === null || center === undefined) return null;
        const lng = typeof center.getLng === "function" ? center.getLng() : Number(center.lng);
        const lat = typeof center.getLat === "function" ? center.getLat() : Number(center.lat);
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
        const zoom = map.getZoom();
        if (!Number.isFinite(zoom)) return null;
        return { zoom, lng, lat };
      } catch {
        // 地图已销毁：忽略（debug 钩子而已）。
        return null;
      }
    };
    /** 系统「减少动态效果」：开了就直接完整显示，不播动画。 */
    const reducedMotion = prefersReducedMotion();
    /**
     * 要不要播动画：只在**首次**渲染路线时播一次（motionPlayedRef 播过就一直是 true）；
     * M19：animationKey 真的变化时上面已把 motionPlayedRef 复位，因此会再播一次；
     * reduced-motion 直接不播（key 变化也不播，路线保持完整）；没有路段也不播。
     */
    const willAnimate = !reducedMotion && !motionPlayedRef.current && segments.length > 0;

    const draw = async () => {
      const outlineColor = readTailwindColor("text-white");

      // 1) 起点 + 站点标记先上，路线稍后逐段补（弱网时不至于空图）。
      addOverlay(
        new AMap.Marker({
          position: [origin.lng, origin.lat],
          anchor: "center",
          content: createOriginMarkerElement(),
          zIndex: 120,
        }),
      );
      for (let index = 0; index < stops.length; index += 1) {
        const stop = stops[index];
        const location = stopLocations.get(stop.placeId);
        if (location === undefined) continue;
        addOverlay(
          new AMap.Marker({
            position: [location.lng, location.lat],
            anchor: "center",
            content: createStopMarkerElement(index, isSunsetStop(stop), location.name),
            zIndex: 120,
          }),
        );
      }
      // 自定义终点旗标：只在用户填了终点时画一次，默认终点 = 起点不重复画。
      if (customDestination !== null) {
        addOverlay(
          new AMap.Marker({
            position: [customDestination.lng, customDestination.lat],
            // 旗杆在标记底部：bottom-center 让旗杆底端落在终点坐标上。
            anchor: "bottom-center",
            content: createDestinationMarkerElement(customDestination.name),
            zIndex: 118,
          }),
        );
      }
      fitView(true);

      // 2) 逐段算路：插件 → 沿路坐标 + 文字步骤 → Polyline + 文字导航。
      // 最后一段是返程（segments 比 stops 多一段）：同样算路、画线、进文字导航。
      const debugSegments: RouteMapDebugSegment[] = [];
      const navigationItems: SegmentNavigation[] = [];
      /** 本批次画出来的真实 Polyline + 完整 path：轨迹动画只改它们的 setPath。 */
      const polylineEntries: RoutePolylineEntry[] = [];
      for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
        const segment = segments[segmentIndex];
        const isReturn = hasReturn && segmentIndex === segments.length - 1;
        const from = resolveEndpoint(segment.fromId, origin, destinationSnapshot, stopLocations);
        const to = resolveEndpoint(segment.toId, origin, destinationSnapshot, stopLocations);
        if (from === null || to === null) continue;

        const route = await searchRoadRouteWithRetry(AMap, segment.mode, from, to, routeCacheRef.current, transferCityName);
        if (cancelled) return;
        if (route === null) {
          console.warn(
            `[AmapRouteMap] ${segment.fromId} → ${segment.toId} 的 ${segment.mode} 路线算不出来，整体降级为 SVG 示意图`,
          );
          setPhase("fallback");
          return;
        }
        const path = route.path;
        // 终点名用端点快照：返程到起点时是起点名，自定义终点时是用户填的终点名。
        const destinationName = resolveEndpointName(
          segment.toId,
          destinationSnapshot,
          originName,
          stopLocations,
        );

        // 本段折线的实际样式：先算出来，再同时用于 Polyline 和 debug 钩子（两边永远一致）。
        // 返程段（segments 最后一段）固定石灰色虚线 + 低透明度 + zIndex 100，与去程彩色实线区分；
        // 去程保持原样：段色循环 / 步行虚线 / 透明度 0.62 / zIndex 110+index。
        const segmentStyle: RoutePolylineStyle = {
          strokeColor: isReturn ? RETURN_STROKE_COLOR : ROUTE_COLORS[segmentIndex % ROUTE_COLORS.length],
          strokeStyle: isReturn || segment.mode === "walk" ? "dashed" : "solid",
          strokeOpacity: isReturn ? RETURN_STROKE_OPACITY : ROUTE_STROKE_OPACITY,
          strokeWeight: ROUTE_STROKE_WEIGHT,
          zIndex: isReturn ? RETURN_Z_INDEX : ROUTE_Z_INDEX_BASE + segmentIndex,
        };

        const polyline = new AMap.Polyline({
          path: path.map((point) => [point[0], point[1]]),
          // 每段一色：颜色区分「第几段」，线型区分「走路还是坐车」，两个维度不互相占用。
          strokeColor: segmentStyle.strokeColor,
          strokeWeight: segmentStyle.strokeWeight,
          strokeOpacity: segmentStyle.strokeOpacity,
          strokeStyle: segmentStyle.strokeStyle,
          lineJoin: "round",
          lineCap: "round",
          showDir: false,
          isOutline: true,
          outlineColor: outlineColor,
          borderWeight: ROUTE_OUTLINE_WEIGHT,
          // 越靠后的段压在上层，重叠时能看出谁盖住了谁，配合半透明不至于互相糊掉；
          // 返程固定 100，压在所有去程段（110+）下面，重叠处一眼能看出「这条是回家的路」。
          zIndex: segmentStyle.zIndex,
        });
        addOverlay(polyline);
        // 轨迹动画只对这些真实 Polyline 调 setPath（完整 path 另存一份，动画只改显示）。
        polylineEntries.push({ polyline, path });
        debugSegments.push({
          fromId: segment.fromId,
          toId: segment.toId,
          mode: segment.mode,
          pointCount: path.length,
          path,
          steps: route.steps,
          isReturn,
          style: segmentStyle,
        });
        navigationItems.push({
          key: `${segmentIndex}:${segment.fromId}->${segment.toId}`,
          index: segmentIndex,
          mode: segment.mode,
          durationMin: segment.durationMin,
          destinationName,
          // to 用这一段的终点（不是整份行程的终点）。
          navigationUrl: buildNavigationUrl(segment.mode, to, destinationName),
          steps: route.steps,
          isReturn,
          road: segment.road,
        });
        // 动画期间不能 fitView（会在地图上跳）；首绘（要播动画）时跳过逐段自适应，
        // 等所有段画完后一次性定好完整路线的视野。非动画路径保持原来的「逐段自适应」行为。
        if (!willAnimate) fitView(false);
      }

      if (cancelled) return;
      setSegmentNav(navigationItems);

      // 3) 轨迹动画（任务书第三步）：所有折线先「不可见」→ 3500ms 按点数分配 → 播完恢复完整。
      //    只在首次渲染路线时播一次：motionPlayedRef 播过就一直是 true，换站 / 重排直接完整显示。
      const fullPointCounts = polylineEntries.map((entry) => entry.path.length);
      const shouldAnimate = willAnimate && polylineEntries.length > 0;
      if (shouldAnimate) {
        motionPlayedRef.current = true;
        motionRunsRef.current += 1;
      }
      const motion = createRouteMotionDebug({
        reducedMotion,
        played: motionPlayedRef.current,
        runs: motionRunsRef.current,
        pointCounts: fullPointCounts,
      });
      drawCountRef.current += 1;
      if (process.env.NODE_ENV !== "production") {
        window.__AMAP_ROUTE_DEBUG__ = {
          mapReady: true,
          segments: debugSegments,
          drawId: drawCountRef.current,
          drawnAtMs: performance.now(),
          animationKey,
          motion,
          polylines: polylineEntries.map((entry) => entry.polyline),
          getView: readView,
          getMap: () => map,
        };
      }

      // 动画开始前把完整路线的视野一次性定好（immediate，不做缓动）；
      // 动画期间不再调 fitView——否则地图会在逐段补点的过程中跳动（任务书明确要求）。
      fitView(true);

      if (shouldAnimate) {
        routeAnimation = startRouteAnimation({
          map,
          AMap,
          entries: polylineEntries,
          motion,
          // 圆点也走 addOverlay，和折线 / 标记共用同一套清理逻辑（overlaysRef）。
          addOverlay,
          // 视野已在动画前定好：播完 / 跳过时不用再 fitView，地图不会在结尾跳一下。
          onComplete: () => undefined,
        });
      }
    };

    void draw().catch((error) => {
      if (cancelled) return;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[AmapRouteMap] 路线绘制失败，降级为 SVG 示意图：${message}`);
      setPhase("fallback");
    });

    return () => {
      cancelled = true;
      if (routeAnimation !== null) {
        // 动画没播完就被清理（换行程 / 组件卸载）：停止 RAF、移除圆点、恢复完整 path。
        // 「已播过」状态不归还：换站 / 重排不应该重播动画（任务书第三步细节）。
        routeAnimation.cancel();
        routeAnimation = null;
      }
    };
    // 返程终点 / 起点名也参与重画（destination 是随行程下发的快照对象，引用稳定）。
    // M19：animationKey 进依赖数组——只有页面明确 +1 时本 effect 才因为「重播」重跑一次；
    // 其余重渲染（父组件无关 state、地图手动缩放/拖动）不会让 effect 重跑，更不会重播动画。
  }, [phase, origin, stops, segments, transferCityName, destination, originName, animationKey]);

  // 站点快照索引（渲染层，只用于 aria 文案；不放进 effect 依赖，避免每次渲染重建地图）。
  const stopLocations = buildStopLocations(stops);
  // 默认终点 = 起点时文案也说「回到起点」，和地图上不重复画标记的口径一致。
  const ariaDestinationName =
    destination !== null && destination !== undefined && destination.placeId === "destination"
      ? destination.name
      : "起点";
  const ariaLabel = `路线地图：从起点出发，依次到 ${stops
    .map((stop, index) => {
      const name = stopLocations.get(stop.placeId)?.name ?? "未知地点";
      return `第 ${index + 1} 站 ${name}`;
    })
    .join("、")}，最后返程到 ${ariaDestinationName}`;

  return (
    <section
      data-testid="amap-route-map"
      aria-label={ariaLabel}
      className="rounded-2xl border border-stone-200 bg-white p-4"
    >
      {/* 坑 2：容器必须有明确高度 h-[420px]。高度为 0 时地图不显示，而且不报错。 */}
      <div className="relative h-[420px] w-full overflow-hidden rounded-xl bg-stone-100">
        <div
          ref={containerRef}
          data-testid="amap-container"
          aria-hidden="true"
          className="h-[420px] w-full"
        />
        {phase !== "ready" ? (
          // 降级层：加载中先垫着原来的 SVG 示意图；SDK 失败 / 超时 / 单段路线失败时它就是最终形态。
          <div
            data-testid="route-map-fallback"
            className="absolute inset-0 flex items-center overflow-hidden rounded-xl bg-white [&>section]:w-full [&>section]:rounded-none [&>section]:border-0 [&>section]:p-0"
          >
            <RouteMap
              origin={origin}
              stops={stops}
              segments={segments}
              destination={destination ?? null}
            />
          </div>
        ) : null}
      </div>

      {/*
        文字导航：数据来自上面算路时同一次插件回调（见文件头注释第 5 条），
        所以文字和地图折线描述的是同一条路线，不会各算各的。
        段标题颜色与地图折线共用 ROUTE_COLORS；instruction 原样来自高德，不改写、不编造。
      */}
      {phase === "ready" && segmentNav.length > 0 ? (
        <nav
          data-testid="route-navigation"
          aria-label="文字导航"
          className="mt-4 border-t border-stone-200 pt-4"
        >
          <ol className="flex flex-col gap-4">
            {segmentNav.map((item) => {
              const color = ROUTE_COLORS[item.index % ROUTE_COLORS.length];
              const collapsible = item.steps.length > STEP_COLLAPSE_THRESHOLD;
              const expanded = expandedKeys.has(item.key);
              const visibleSteps =
                collapsible && !expanded ? item.steps.slice(0, STEP_COLLAPSE_THRESHOLD) : item.steps;
              return (
                <li
                  key={item.key}
                  data-testid="route-nav-segment"
                  data-mode={item.mode}
                  data-return={item.isReturn ? "true" : undefined}
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="text-sm font-medium" style={{ color }}>
                      {formatSegmentTitle(item.index, item.mode, item.durationMin, item.isReturn, item.road)}
                    </h3>
                    {item.navigationUrl !== null ? (
                      <a
                        data-testid={`route-nav-link-${item.index}`}
                        href={item.navigationUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-stone-500 underline underline-offset-2 hover:text-stone-800"
                      >
                        用高德导航
                        {/* 外链箭头：SVG 线条图标（铁律 11：不用 emoji 当图标）。 */}
                        <svg viewBox="0 0 12 12" aria-hidden="true" className="h-3 w-3">
                          <path
                            d="M3.5 8.5 8.5 3.5M4.5 3.5h4v4"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </a>
                    ) : null}
                  </div>
                  {visibleSteps.length > 0 ? (
                    <ul className="mt-2 flex flex-col gap-1.5 text-sm leading-6 text-stone-600">
                      {visibleSteps.map((step, stepIndex) => (
                        <li
                          key={`${item.key}:step:${stepIndex}`}
                          className="flex gap-2"
                          // road / distance 是按用户要求一起取出来存好的；data-* 供自检脚本核对，
                          // 文字本身只展示高德原文 instruction（自带路名和距离，不重复拼）。
                          data-road={step.road === "" ? undefined : step.road}
                          data-distance={step.distanceM === null ? undefined : step.distanceM}
                        >
                          <span aria-hidden="true" className="text-stone-400">
                            ·
                          </span>
                          <span>{step.instruction}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {collapsible ? (
                    <button
                      type="button"
                      data-testid={`route-nav-toggle-${item.index}`}
                      aria-expanded={expanded}
                      onClick={() => toggleSegmentExpanded(item.key)}
                      className="mt-2 text-xs font-medium text-stone-500 underline underline-offset-2 hover:text-stone-800"
                    >
                      {expanded ? "收起" : `展开全部 ${item.steps.length} 步`}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </nav>
      ) : null}
    </section>
  );
}
