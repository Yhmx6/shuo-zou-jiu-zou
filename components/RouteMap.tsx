import type { ItineraryEndpoint, Segment, SegmentMode, Stop } from "@/types/schema";

/**
 * M8：路线示意图（纯 SVG）。
 *
 * 为什么不用地图 SDK（照抄 M8 3.1，也照抄 00-common 铁律 8）：
 * - 地图 SDK 要另一把 JS API Key，容易和 Web 服务 Key 搞混；
 * - 我们只需要「一条串起所有点的线」，不需要真实底图；
 * - 完全可控，不涉及任何地图瓦片版权。
 *
 * 输入是行程结果（stops / segments / destination）和起点坐标：站点坐标 / 名称直接读 stop 自带的
 * placeName / lng / lat（由 lib/planner.ts 在返回行程前填好），不再依赖任何静态地点表。
 * 输出：起点标记 + 每站一个圆点 + 站点之间的连线；日落锚点站换成太阳标记。
 *
 * 本轮追加（返程）：segments 最后一段是「末站 → 终点」，默认终点 = 起点时连线画回起点菱形、
 * 不再重复画点；用户自定义终点（destination.placeId === "destination"）时多画一个 SVG 终点
 * 旗标并把返程连线连过去。本组件不参与任何排程 / 选点 / 时间计算，只负责把已经算好的结果画出来。
 */

export type RouteMapOrigin = { lng: number; lat: number };

export type RouteMapProps = {
  /** 起点坐标。优先用 Itinerary.origin 的快照，旧数据没有时由页面传城市演示起点。 */
  origin: RouteMapOrigin;
  /** 行程站点（普通行程 3 站，日落锚点行程最多 4 站）；缺 lng / lat 的站不画。 */
  stops: Stop[];
  /** 路段：站段一一对应（旧数据），本轮起多最后一段返程（末站 → 终点）。 */
  segments: Segment[];
  /**
   * 返程终点快照（本轮新增）：undefined / null = 回到起点；
   * placeId === "destination" 时画一个自定义终点标记，把最后一段连过去。
   */
  destination?: ItineraryEndpoint | null;
};

/** 画布尺寸（viewBox 单位）。2:1 的横向比例，放进 448px 宽的卡片后高度约 190px，不占满屏幕。 */
const VIEW_WIDTH = 360;
const VIEW_HEIGHT = 180;
/** 内边距：给起点 / 站点标记留出半径和太阳光芒的位置。 */
const PADDING = 30;

/**
 * 投影时的最小地理跨度兜底（纬度度数，约 165 米；经度方向按 cos 纬度折算）。
 *
 * 站点都挤在同一个街区时，不把 30 米的差异放大到整个画布——那会让「相对位置」失真；
 * 这里宁可让点聚在画布中间，也要保持示意图的距离感。
 */
const MIN_SPAN_DEG = 0.0015;

const STOP_DOT_RADIUS = 7;
const SUN_CORE_RADIUS = 8;
const SUN_RAY_START = 11;
const SUN_RAY_END = 14.5;
const SUN_RAY_COUNT = 8;
/** 圆点里的序号字号（svg 用户单位）。 */
const DOT_LABEL_FONT_PX = 9;

type GeoPoint = { lng: number; lat: number };
type CanvasPoint = { x: number; y: number };

type StopMarker = {
  stop: Stop;
  /** 站点坐标，直接从 stop 的快照字段取（缺坐标的站不会进 markers）。 */
  lng: number;
  lat: number;
  /** 是不是「日落那站」：planner 只在锚定站 reason 里写「日落」。 */
  sunset: boolean;
  /** 投影后的画布坐标（project 之后回填）。 */
  point: CanvasPoint;
};

type RouteLine = {
  key: string;
  mode: SegmentMode | null;
  d: string;
};

/**
 * 八个方向的太阳光芒（相对圆心的偏移，单位：画布坐标）。
 * 太阳标记是 SVG 线条画的，不用 emoji（00-common 铁律 11）。
 */
const SUN_RAYS = Array.from({ length: SUN_RAY_COUNT }, (_, index) => {
  const angle = (Math.PI * 2 * index) / SUN_RAY_COUNT;
  return {
    x1: round(Math.cos(angle) * SUN_RAY_START),
    y1: round(Math.sin(angle) * SUN_RAY_START),
    x2: round(Math.cos(angle) * SUN_RAY_END),
    y2: round(Math.sin(angle) * SUN_RAY_END),
  };
});

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * 等距圆柱投影（只用于示意图，不需要米级精度）：
 *   经度方向乘 cos(平均纬度) 修正东西向的比例，纬度方向取负（屏幕 y 轴向下）。
 * 然后把所有点等比缩放、居中放进 viewBox，保证不裁切任何标记。
 */
function projectPoints(points: GeoPoint[]): CanvasPoint[] {
  if (points.length === 0) return [];

  const centerLat = points.reduce((sum, point) => sum + point.lat, 0) / points.length;
  const lngScale = Math.cos((centerLat * Math.PI) / 180);
  const raw = points.map((point) => ({ x: point.lng * lngScale, y: -point.lat }));

  let minX = raw[0].x;
  let maxX = raw[0].x;
  let minY = raw[0].y;
  let maxY = raw[0].y;
  for (const point of raw) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }

  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const innerWidth = VIEW_WIDTH - PADDING * 2;
  const innerHeight = VIEW_HEIGHT - PADDING * 2;
  // 用「最小跨度兜底」算缩放：点几乎重合时不放大失真，但仍居中显示。
  const effectiveSpanX = Math.max(spanX, MIN_SPAN_DEG * lngScale);
  const effectiveSpanY = Math.max(spanY, MIN_SPAN_DEG);
  const scale = Math.min(innerWidth / effectiveSpanX, innerHeight / effectiveSpanY);
  const offsetX = (VIEW_WIDTH - spanX * scale) / 2;
  const offsetY = (VIEW_HEIGHT - spanY * scale) / 2;

  return raw.map((point) => ({
    x: offsetX + (point.x - minX) * scale,
    y: offsetY + (point.y - minY) * scale,
  }));
}

function linePath(from: CanvasPoint, to: CanvasPoint): string {
  return `M ${round(from.x)} ${round(from.y)} L ${round(to.x)} ${round(to.y)}`;
}

/**
 * 日落站判定（M8）：
 * planner 只在「户外日落点被锚定在日落窗口到站」时，才在 reason 末尾追加
 * 「赶得上 HH:mm 的日落」，所以 reason 里写明日落就是唯一判据。
 *
 * 不再看地点标签（bestTime=日落）：地点表不再下发给前端，而且只按标签判会把
 * 普通行程里中午路过的日落点误标成日落站（它并不是为了看日落去的）。
 */
function isSunsetStop(stop: Stop): boolean {
  return stop.reason.indexOf("日落") !== -1;
}

/** 站点显示名：正常情况由 planner 填好 placeName；旧数据缺字段时用占位名，不臆造地点。 */
function stopDisplayName(stop: Stop): string {
  return stop.placeName ?? "未知地点";
}

/**
 * 把 Itinerary 的 sites / segments 画成一张静态 SVG。
 * 站点数量不做硬编码：3 站普通行程、4 站日落锚点行程都能画。
 */
export default function RouteMap({ origin, stops, segments, destination }: RouteMapProps) {
  const markers: StopMarker[] = [];
  for (const stop of stops) {
    // 缺坐标的站跳过：planner 在返回行程前会填好，旧数据 / 异常数据没有这个字段。
    if (stop.lng === undefined || stop.lat === undefined) continue;
    markers.push({
      stop,
      lng: stop.lng,
      lat: stop.lat,
      sunset: isSunsetStop(stop),
      point: { x: 0, y: 0 },
    });
  }
  // 没有任何可定位的站点就不画：不拿原点硬凑一张空图。
  if (markers.length === 0) return null;

  // 自定义终点才需要单独一个投影点 / 标记；默认终点 = 起点（placeId 为 "origin" 或旧数据没有
  // destination）时不重复画点，返程段直接连回起点菱形即可。
  const customDestination =
    destination !== null && destination !== undefined && destination.placeId === "destination"
      ? destination
      : null;

  const projected = projectPoints([
    origin,
    ...markers.map((marker) => ({ lng: marker.lng, lat: marker.lat })),
    ...(customDestination === null
      ? []
      : [{ lng: customDestination.lng, lat: customDestination.lat }]),
  ]);
  const originPoint = projected[0];
  for (let index = 0; index < markers.length; index += 1) {
    markers[index].point = projected[index + 1];
  }
  const destinationPoint = customDestination === null ? originPoint : projected[projected.length - 1];

  // 连线按 segments 画（segment.fromId → segment.toId 的顺序 = 行程顺序）；
  // fromId / toId 都是 placeId，第一段的 fromId 就是起点 id，返程段的 toId 是
  // "origin"（默认回到起点）或 "destination"（自定义终点）。
  const pointById = new Map<string, CanvasPoint>();
  pointById.set(segments.length > 0 ? segments[0].fromId : "origin", originPoint);
  // 兜底显式登记起点 id：旧 / 异常数据里第一段 fromId 不是 "origin" 时，返程段仍能连回起点。
  pointById.set("origin", originPoint);
  for (const marker of markers) pointById.set(marker.stop.placeId, marker.point);
  if (customDestination !== null) pointById.set(customDestination.placeId, destinationPoint);

  const routeLines: RouteLine[] = [];
  for (const segment of segments) {
    const from = pointById.get(segment.fromId);
    const to = pointById.get(segment.toId);
    if (from === undefined || to === undefined) continue;
    routeLines.push({
      key: `${segment.fromId}->${segment.toId}`,
      mode: segment.mode,
      d: linePath(from, to),
    });
  }
  // 兜底：segments 缺失时也要连成一条线（M8 不达标判据：地图不能只是几个点）。
  if (routeLines.length === 0) {
    const points = [
      originPoint,
      ...markers.map((marker) => marker.point),
      ...(customDestination === null ? [] : [destinationPoint]),
    ];
    const d = points
      .map((point, index) => `${index === 0 ? "M" : "L"} ${round(point.x)} ${round(point.y)}`)
      .join(" ");
    routeLines.push({ key: "fallback", mode: null, d });
  }

  const sunsetMarker = markers.filter((marker) => marker.sunset)[0];
  const sunsetNote =
    sunsetMarker === undefined
      ? ""
      : `，其中第 ${markers.indexOf(sunsetMarker) + 1} 站 ${stopDisplayName(sunsetMarker.stop)} 是日落站`;
  const destinationNote =
    customDestination === null ? "，最后回到起点" : `，最后返程到 ${customDestination.name}`;
  const ariaLabel = `路线示意图：从起点出发，依次到 ${markers
    .map((marker, index) => `第 ${index + 1} 站 ${stopDisplayName(marker.stop)}`)
    .join("、")}${sunsetNote}${destinationNote}`;

  return (
    <section
      data-testid="route-map"
      aria-label={ariaLabel}
      className="rounded-2xl border border-stone-200 bg-white p-4"
    >
      <svg
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        role="img"
        aria-label={ariaLabel}
        className="block h-auto w-full"
      >
        {routeLines.map((line) => (
          <path
            key={line.key}
            data-role="route-line"
            data-mode={line.mode === null ? undefined : line.mode}
            d={line.d}
            className="fill-none stroke-stone-400"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}

        {/* 起点：菱形，和站点的圆点区分开 */}
        <g
          data-role="origin-marker"
          transform={`translate(${round(originPoint.x)} ${round(originPoint.y)})`}
        >
          <title>起点</title>
          <path
            d="M 0 -6 L 6 0 L 0 6 L -6 0 Z"
            className="fill-stone-400 stroke-white"
            strokeWidth={1.5}
            strokeLinejoin="round"
          />
        </g>

        {markers.map((marker, index) => (
          <g
            key={`${marker.stop.placeId}-${index}`}
            data-role="stop-dot"
            data-place-id={marker.stop.placeId}
            data-sunset={marker.sunset ? "true" : undefined}
            transform={`translate(${round(marker.point.x)} ${round(marker.point.y)})`}
          >
            <title>{stopDisplayName(marker.stop)}</title>
            {marker.sunset ? (
              <g>
                {SUN_RAYS.map((ray, rayIndex) => (
                  <line
                    key={`sun-ray-${rayIndex}`}
                    x1={ray.x1}
                    y1={ray.y1}
                    x2={ray.x2}
                    y2={ray.y2}
                    className="stroke-amber-500"
                    strokeWidth={1.5}
                    strokeLinecap="round"
                  />
                ))}
                <circle
                  r={SUN_CORE_RADIUS}
                  className="fill-amber-500 stroke-white"
                  strokeWidth={1.5}
                />
              </g>
            ) : (
              <circle r={STOP_DOT_RADIUS} className="fill-stone-900 stroke-white" strokeWidth={1.5} />
            )}
            <text
              textAnchor="middle"
              dominantBaseline="central"
              className="fill-white font-medium"
              fontSize={DOT_LABEL_FONT_PX}
            >
              {index + 1}
            </text>
          </g>
        ))}

        {/* 自定义终点：SVG 线条画的小旗子（不用 emoji，铁律 11）；默认终点 = 起点时不画，
            直接沿用上面的起点菱形，避免同一点上叠两个标记。 */}
        {customDestination !== null ? (
          <g
            data-role="destination-marker"
            data-place-id={customDestination.placeId}
            transform={`translate(${round(destinationPoint.x)} ${round(destinationPoint.y)})`}
          >
            <title>{`终点：${customDestination.name}`}</title>
            <path
              d="M 0 4 L 0 -15"
              className="stroke-stone-900"
              strokeWidth={2}
              strokeLinecap="round"
            />
            <path
              d="M 0 -15 L 12 -10.5 L 0 -6 Z"
              className="fill-stone-900 stroke-white"
              strokeWidth={1.2}
              strokeLinejoin="round"
            />
          </g>
        ) : null}
      </svg>
    </section>
  );
}
