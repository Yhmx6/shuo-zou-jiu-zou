"use client";

import { useEffect, useRef, useState } from "react";
import { loadAMap } from "@/lib/amapLoader";
import {
  CATEGORY_COLORS,
  CATEGORY_SHORT_LABELS,
  LEGEND_CATEGORIES,
  MARKER_DOT_SIZE_PX,
  MARKER_SELECTED_SCALE,
  markerDotStyle,
  markerSelectedTransform,
} from "./adminMapStyle";
import type { Place } from "@/types/schema";

/**
 * 控制台地点地图（本轮新增）：把「当前筛选结果」的全部地点画在真实高德底图上。
 *
 * 设计约束（见 build/admin-map-contract.md 与任务书）：
 * - SDK **只走** lib/amapLoader.ts 的 loadAMap()，不重新 load、不自己设 _AMapSecurityConfig；
 * - 地图实例只在挂载时创建一次（useRef 保存），父组件重渲染 / 选中变化 / 拖动缩放都不重建；
 * - 重画只在 `places`（当前筛选结果）变化时发生：逐个 setMap(null) + map.remove() 清旧点，
 *   **不用 map.clearMap()**（那会把底图控件一起清掉），画完 setFitView()；
 * - 点的样式：类目色实心 10px + 1px 白边；hidden 画成空心圈（2px 类目色边框、透明填充）；
 * - 点列表某行（父组件传 selectedId）→ 对应点放大 1.6 + setCenter；点地图上的点 → 回调父组件；
 * - 加载失败 / 超时只在图区显示一行降级文案，不影响列表编辑；
 * - 卸载时先摘覆盖物再 map.destroy()。
 *
 * 铁律：地点只来自 /api/admin/places 的返回（places prop），本组件不生成、不补造任何地点。
 */

/** 后台列表项（与 app/admin/page.tsx 的 AdminPlace 结构兼容，多出来的 origin 字段这里不关心）。 */
export type AdminMapPlace = Place & { hidden: boolean };

export type AdminPlacesMapProps = {
  /** 当前筛选结果（服务端顺序，地图按同一顺序画点）。 */
  places: AdminMapPlace[];
  /** 列表里选中的地点 id：变化时对应点放大 + 地图居中（不触发重画）。 */
  selectedId: string | null;
  /** 点了地图上的点：由页面负责列表滚动 / 高亮。 */
  onSelectPlace: (placeId: string) => void;
};

/* ------------------------------------------------------------------ *
 * 高德 JSAPI 的最小类型声明（只声明本组件用到的成员，与 AmapRouteMap 同口径）
 * ------------------------------------------------------------------ */

type LngLatTuple = [number, number];

type AmapMapInstance = {
  add: (overlay: unknown | unknown[]) => void;
  remove: (overlay: unknown | unknown[]) => void;
  setFitView: (overlays?: unknown, immediately?: boolean, avoid?: number[]) => void;
  setCenter: (center: LngLatTuple) => void;
  getCenter: () => unknown;
  getZoom: () => number;
  /** 容器尺寸从 0 恢复（切 tab 回来）时补一次重算；旧版本可能没有，调用前判类型。 */
  resize?: () => void;
  /** 视图变化事件（moveend / zoomend）：用来把最新的 center / zoom 写回调试钩子。 */
  on?: (event: string, callback: () => void) => void;
  off?: (event: string, callback: () => void) => void;
  destroy: () => void;
};

type AmapMarkerInstance = {
  setMap: (map: unknown | null) => void;
};

type AmapNamespace = {
  Map: new (container: HTMLElement, options?: Record<string, unknown>) => AmapMapInstance;
  Marker: new (options: Record<string, unknown>) => AmapMarkerInstance;
};

/** SDK 加载 + 创建地图的总超时：断网 / CDN 被墙时别让用户对着空白容器等。 */
const SDK_LOAD_TIMEOUT_MS = 15000;

/** 一条 marker 记录：三个 DOM 都是我们自己 createElement 的，删除时一起释放。 */
type MarkerRecord = {
  marker: AmapMarkerInstance;
  wrapper: HTMLDivElement;
  dot: HTMLDivElement;
  place: AdminMapPlace;
};

/**
 * 调试钩子（仅 development）：验收脚本据此断言 marker 数、颜色、重画次数、选中态、视图。
 * 字段原地改，不整个替换对象，脚本可以两次快照对比。
 */
type AdminMapDebug = {
  mapReady: boolean;
  error: string;
  /** 重画次数（每次「清旧点 + 重建 + setFitView」+1；拖动 / 缩放 / 选中不增加）。 */
  drawCount: number;
  /** setFitView 次数（每次有点的重画 +1）。 */
  fitViewCount: number;
  markerCount: number;
  markerIds: string[];
  selectedId: string | null;
  selectedScale: number;
  center: { lng: number; lat: number } | null;
  zoom: number | null;
  /** 容器尺寸从 0 恢复（活动 tab 切回来）的次数。 */
  resizeCount: number;
  /**
   * 真实 AMap.Map 实例（仅 development；不进 JSON 快照）。
   * 给验收脚本在「headless 里合成手势不生效」时留的证据通道：直接 setZoom / setCenter
   * 改视图，再断言「视野变了但 drawCount 不变」。与 AmapRouteMap 的 debug.getMap 同口径。
   */
  getMap?: () => AmapMapInstance | null;
};

declare global {
  interface Window {
    __ADMIN_MAP_DEBUG__?: AdminMapDebug;
  }
}

/* ------------------------------------------------------------------ *
 * 纯工具（不依赖 React）
 * ------------------------------------------------------------------ */

function emptyDebug(): AdminMapDebug {
  return {
    mapReady: false,
    error: "",
    drawCount: 0,
    fitViewCount: 0,
    markerCount: 0,
    markerIds: [],
    selectedId: null,
    selectedScale: 1,
    center: null,
    zoom: null,
    resizeCount: 0,
  };
}

/** 读地图中心（地图未就绪 / 已销毁时返回 null，不抛）。 */
function readCenter(map: AmapMapInstance | null): { lng: number; lat: number } | null {
  if (map === null) return null;
  try {
    const center = map.getCenter() as { getLng?: () => number; getLat?: () => number } | null;
    if (center === null || center === undefined) return null;
    const lng = typeof center.getLng === "function" ? center.getLng() : undefined;
    const lat = typeof center.getLat === "function" ? center.getLat() : undefined;
    if (typeof lng !== "number" || typeof lat !== "number") return null;
    return { lng, lat };
  } catch {
    return null;
  }
}

/** 读地图缩放级别（同上，失败返回 null）。 */
function readZoom(map: AmapMapInstance | null): number | null {
  if (map === null) return null;
  try {
    const zoom = map.getZoom();
    return typeof zoom === "number" ? zoom : null;
  } catch {
    return null;
  }
}

/**
 * 摘掉所有覆盖物：先逐个 setMap(null)，再 map.remove(数组)。
 * 不调用 map.clearMap()（会连底图控件一起清掉，任务书红线）。
 */
function removeMarkers(map: AmapMapInstance | null, records: MarkerRecord[]): void {
  if (records.length === 0) return;
  for (const record of records) {
    try {
      record.marker.setMap(null);
    } catch {
      // 地图已销毁 / 覆盖物已被移除：忽略。
    }
  }
  if (map !== null) {
    try {
      map.remove(records.map((record) => record.marker));
    } catch {
      // 同上。
    }
  }
}

/**
 * 把选中态同步到 marker 上：
 * - 选中点放大 1.6 + data-selected="true"；
 * - 其余点恢复原样；
 * - 选中点存在时把地图中心移过去（任务书：点列表某行 → 放大 + setCenter）。
 */
function applySelection(
  map: AmapMapInstance | null,
  records: MarkerRecord[],
  placeId: string | null,
  debug: AdminMapDebug | null,
): void {
  let selectedRecord: MarkerRecord | undefined;
  for (const record of records) {
    const isSelected = placeId !== null && record.place.id === placeId;
    if (isSelected) {
      selectedRecord = record;
      record.dot.style.transform = markerSelectedTransform();
      record.wrapper.dataset.selected = "true";
    } else {
      record.dot.style.transform = "";
      delete record.wrapper.dataset.selected;
    }
  }
  if (selectedRecord !== undefined && map !== null) {
    try {
      map.setCenter([selectedRecord.place.lng, selectedRecord.place.lat]);
    } catch {
      // 地图已销毁：忽略（选中态没有意义了）。
    }
  }
  if (debug !== null) {
    const appliedId = selectedRecord === undefined ? null : selectedRecord.place.id;
    debug.selectedId = appliedId;
    debug.selectedScale = appliedId === null ? 1 : MARKER_SELECTED_SCALE;
    debug.center = readCenter(map);
  }
}

/* ------------------------------------------------------------------ *
 * 组件
 * ------------------------------------------------------------------ */

export default function AdminPlacesMap({ places, selectedId, onSelectPlace }: AdminPlacesMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<AmapMapInstance | null>(null);
  const amapRef = useRef<AmapNamespace | null>(null);
  const markersRef = useRef<MarkerRecord[]>([]);
  const debugRef = useRef<AdminMapDebug | null>(null);
  /** moveend / zoomend 的监听器（卸载时先 off 再 destroy，避免销毁后回调）。 */
  const viewSyncRef = useRef<(() => void) | null>(null);
  const selectedIdRef = useRef<string | null>(selectedId);
  const onSelectPlaceRef = useRef(onSelectPlace);

  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [failReason, setFailReason] = useState("");

  // 地图是一次性创建的：选中态 / 点选回调要读「最新值」，放进 ref，避免父组件重渲染就重建地图。
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    onSelectPlaceRef.current = onSelectPlace;
  }, [onSelectPlace]);

  /**
   * 挂载：loadAMap() → new AMap.Map()。失败 / 超时才进降级态，列表完全不受影响。
   * 取消标志配合 React StrictMode 的二次挂载：被取消的异步任务不会往新地图上画东西。
   */
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return undefined;

    let cancelled = false;
    setPhase("loading");
    setFailReason("");

    const fail = (message: string) => {
      setPhase("error");
      setFailReason(message);
      if (process.env.NODE_ENV !== "production") {
        const debug = emptyDebug();
        debug.error = message;
        debugRef.current = debug;
        window.__ADMIN_MAP_DEBUG__ = debug;
      }
    };

    const timeout = window.setTimeout(() => {
      if (cancelled) return;
      fail("高德地图 SDK 加载超时");
    }, SDK_LOAD_TIMEOUT_MS);

    const boot = async () => {
      try {
        const namespace = (await loadAMap()) as AmapNamespace;
        if (cancelled) return;
        window.clearTimeout(timeout);

        const map = new namespace.Map(container, {
          viewMode: "2D",
          resizeEnable: true,
          // 明确打开拖拽 / 滚轮缩放 / 双击缩放：任务书要求用户能拖动缩放（且这两个动作不重画）。
          dragEnable: true,
          scrollWheel: true,
          doubleClickZoom: true,
        });
        if (cancelled) {
          try {
            map.destroy();
          } catch {
            // 已取消：忽略。
          }
          return;
        }

        amapRef.current = namespace;
        mapRef.current = map;

        // 视图变化（拖动 / 缩放 / setFitView / setCenter）后，把最新 center / zoom 写回调试钩子。
        // setCenter 之后立刻 getCenter() 可能还是旧值（地图异步刷新），所以靠 moveend / zoomend 兜正。
        const syncView = () => {
          const debug = debugRef.current;
          if (debug === null) return;
          debug.center = readCenter(map);
          debug.zoom = readZoom(map);
        };
        viewSyncRef.current = syncView;
        try {
          map.on?.("moveend", syncView);
          map.on?.("zoomend", syncView);
        } catch {
          // 老版本不支持事件绑定：center / zoom 只在重画 / 选中时更新，不影响功能。
        }

        if (process.env.NODE_ENV !== "production") {
          const debug = emptyDebug();
          debug.mapReady = true;
          debug.center = readCenter(map);
          debug.zoom = readZoom(map);
          debug.getMap = () => mapRef.current;
          debugRef.current = debug;
          window.__ADMIN_MAP_DEBUG__ = debug;
        }

        setPhase("ready");
      } catch (error) {
        window.clearTimeout(timeout);
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[AdminPlacesMap] 高德地图加载失败，图区降级：${message}`);
        fail(message);
      }
    };
    void boot();

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      const map = mapRef.current;
      // 先摘覆盖物、再解绑视图监听、最后销毁地图：避免 destroy 后还有回调。
      removeMarkers(map, markersRef.current);
      markersRef.current = [];
      const syncView = viewSyncRef.current;
      viewSyncRef.current = null;
      if (map !== null && syncView !== null) {
        try {
          map.off?.("moveend", syncView);
          map.off?.("zoomend", syncView);
        } catch {
          // 地图已不可用：忽略。
        }
      }
      mapRef.current = null;
      amapRef.current = null;
      debugRef.current = null;
      if (map !== null) {
        try {
          map.destroy();
        } catch {
          // StrictMode / 重复销毁：忽略。
        }
      }
      if (process.env.NODE_ENV !== "production") delete window.__ADMIN_MAP_DEBUG__;
    };
  }, []);

  /**
   * 画点：`places` 变化（筛选 / 搜索 / 切城市 / 数据刷新）时清旧点、按新结果重画并 setFitView。
   * 依赖里只有 phase 和 places：拖动、缩放、选中都不会走到这里（任务书验收 8）。
   */
  useEffect(() => {
    if (phase !== "ready") return;
    const map = mapRef.current;
    const namespace = amapRef.current;
    if (map === null || namespace === null) return;
    const debug = debugRef.current;

    // 首屏列表还没回来（places 是空数组）：先不画。否则会多出一次「空重画」，
    // 验收里 drawCount 就不再是「每个筛选结果画一次」的干净口径。
    if (places.length === 0 && markersRef.current.length === 0) return;

    removeMarkers(map, markersRef.current);
    markersRef.current = [];

    const records: MarkerRecord[] = [];
    const markers: AmapMarkerInstance[] = [];
    for (const place of places) {
      // 内层圆点：颜色 / 实心空心由 adminMapStyle 的唯一口径决定。
      const dot = document.createElement("div");
      dot.dataset.mapDot = "true";
      Object.assign(dot.style, markerDotStyle(place.category, place.hidden === true));
      dot.style.transformOrigin = "center";

      // 外层是 marker 的 content 容器（10px 定尺寸，放大只作用于内层，不改变布局盒）。
      const wrapper = document.createElement("div");
      wrapper.dataset.mapMarker = "true";
      wrapper.dataset.placeId = place.id;
      wrapper.dataset.category = place.category;
      wrapper.dataset.hidden = place.hidden === true ? "true" : "false";
      wrapper.style.width = `${MARKER_DOT_SIZE_PX}px`;
      wrapper.style.height = `${MARKER_DOT_SIZE_PX}px`;
      wrapper.style.cursor = "pointer";
      wrapper.appendChild(dot);
      // 自己挂 DOM click：不依赖 AMap 的 marker 事件（headless 验收里的合成事件也能稳定触发）。
      wrapper.addEventListener("click", () => {
        onSelectPlaceRef.current(place.id);
      });

      markers.push(
        new namespace.Marker({
          position: [place.lng, place.lat],
          content: wrapper,
          anchor: "center",
          zIndex: 120,
        }),
      );
      records.push({ marker: markers[markers.length - 1], wrapper, dot, place });
    }

    // 一次批量加（116 个点无压力）；空结果不加也不 fitView（没有可适配的视野）。
    if (markers.length > 0) {
      map.add(markers);
      try {
        // 只把本组 marker 交给 setFitView，避免把底图控件 / 未来其它覆盖物算进视野。
        map.setFitView(markers, false);
      } catch {
        // 视野自适应失败不影响点本身。
      }
    }
    markersRef.current = records;

    if (debug !== null) {
      debug.drawCount += 1;
      if (markers.length > 0) debug.fitViewCount += 1;
      debug.markerCount = records.length;
      debug.markerIds = records.map((record) => record.place.id);
      debug.center = readCenter(map);
      debug.zoom = readZoom(map);
    }

    // 筛选变化后如果列表选中项还在新结果里，把放大 / 居中补上（新 marker 默认是未选中态）。
    applySelection(map, records, selectedIdRef.current, debug);
  }, [phase, places]);

  /** 选中变化：只改 marker 样式 + setCenter，不重画（不 add/remove marker、不 setFitView）。 */
  useEffect(() => {
    if (phase !== "ready") return;
    applySelection(mapRef.current, markersRef.current, selectedId, debugRef.current);
  }, [phase, selectedId]);

  /**
   * 容器尺寸恢复（从「活动」tab 切回「地点」时父容器 display:none → 有尺寸）：
   * 补一次 resize + fitView，否则底图可能停在 0 尺寸时的空白渲染。
   */
  useEffect(() => {
    if (phase !== "ready") return;
    const container = containerRef.current;
    const map = mapRef.current;
    if (container === null || map === null) return;

    if (typeof ResizeObserver === "undefined") return undefined;
    let wasHidden = container.clientWidth === 0 || container.clientHeight === 0;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      const { width, height } = entry.contentRect;
      if (width <= 0 || height <= 0) {
        wasHidden = true;
        return;
      }
      try {
        if (typeof map.resize === "function") map.resize();
      } catch {
        // 旧版本没有 resize：忽略，下面 setFitView 也能把视野拉回来。
      }
      if (!wasHidden) return;
      wasHidden = false;
      const markers = markersRef.current.map((record) => record.marker);
      if (markers.length > 0) {
        try {
          map.setFitView(markers, false);
        } catch {
          // 视野自适应失败不影响点本身。
        }
      }
      if (debugRef.current !== null) debugRef.current.resizeCount += 1;
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [phase]);

  return (
    <section
      data-testid="admin-places-map"
      aria-label="地点地图：当前筛选结果的全部地点"
      className="relative h-[320px] overflow-hidden rounded border border-stone-200 bg-stone-100 lg:h-[calc(100vh_-_6rem)] lg:min-h-[420px]"
    >
      {/* 高德 SDK 自己接管这个容器的子节点，React 只负责挂载点本身。 */}
      <div ref={containerRef} data-testid="admin-map-canvas" className="h-full w-full" />

      {/* 图例：色块 div 不用 emoji；10px 一行排开，窄屏允许换行。 */}
      <div
        data-testid="admin-map-legend"
        className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-wrap items-center gap-x-1 gap-y-0.5 overflow-hidden border-t border-stone-200 bg-white/85 px-2 py-1 lg:flex-nowrap"
        style={{ fontSize: "10px", lineHeight: "12px" }}
      >
        {LEGEND_CATEGORIES.map((category) => (
          <span
            key={category}
            data-legend-item={category}
            className="flex items-center gap-1 whitespace-nowrap text-stone-700"
          >
            {/* 色块本身同时挂 data-legend-category / data-legend-swatch：有背景色的就是它，
                验收脚本对 [data-legend-category] 读 computed backgroundColor 才是类目色。 */}
            <span
              data-legend-category={category}
              data-legend-swatch="true"
              aria-hidden="true"
              className="inline-block rounded-full"
              style={{ width: "8px", height: "8px", backgroundColor: CATEGORY_COLORS[category] }}
            />
            {CATEGORY_SHORT_LABELS[category]}
          </span>
        ))}
      </div>

      {/* 降级态：只在 SDK 加载失败 / 超时 / 建图抛错时出现；列表照常可用。 */}
      {phase === "error" && (
        <div
          data-testid="admin-map-error"
          role="status"
          title={failReason}
          className="absolute inset-0 flex items-center justify-center bg-white/90 px-4 text-center text-sm text-stone-600"
        >
          地图加载失败，不影响编辑
        </div>
      )}
    </section>
  );
}
