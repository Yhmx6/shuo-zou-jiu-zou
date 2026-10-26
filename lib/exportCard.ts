import type { Itinerary, SegmentMode, Stop } from "@/types/schema";

/**
 * M11：路线卡片导出（1080×1920 竖版 PNG）。
 *
 * 职责边界：
 * - 本文件只做「把已经算好的 Itinerary 画成一张图」，不排程、不选点、不算时间（00-common 铁律 3）；
 * - 输入全部来自 /api/plan 返回的 Itinerary：站点名称 / 坐标是 planner 填好的快照，
 *   本文件不生成任何地点、不编造任何营业时间；
 * - 导出走 canvas.toDataURL("image/png") + <a download>，不引入 html2canvas / sharp / resvg /
 *   puppeteer 等任何截图 / 图片处理依赖（M11 3.3）；
 * - 不用任何地图厂商的瓦片或截图：路线是拿站点经纬度做的等距圆柱投影 + 手绘平滑曲线，
 *   白底、无底图、无街道名、无地图 logo（M11 3.2 合规红线）。
 *
 * 隐私红线（M11 3.4 / 本轮需求）：
 * - **起点坐标不参与绘制**。本文件从头到尾不读 itinerary.origin 的经纬度，「出发」标记固定画在
 *   左侧一个中性锚点上——图上因此既没有家庭住址，也没有「家相对这几站的方向」这种可反推信息；
 * - 图上不出现任何经纬度数字、门牌号、地址；只出现站点名称（本来就是给用户看的）；
 * - 返程段（segments 比 stops 多的最后一段）刻意不画：起点已隐藏，把返程连回中性锚点会暗示
 *   「家在那一侧」，属于变相泄露；M11 给的两个选项里这里选「干脆不画」。
 *
 * 坐标映射（验收第 5 条「相对位置和真实地理一致」）：
 * - 等距圆柱投影：x = lng × cos(平均纬度)，y = −lat，两个方向用**同一个**缩放比例，
 *   保证「实际很近 → 图上也很近」；只把 stops 的外接矩形等比放进上半部分画布，留边距；
 * - 曲线只用站点坐标算出来，不加随机抖动（抖动会让相对位置失真）。
 */

/** 导出尺寸：竖版 1080×1920，直接写进 canvas.width / height（不依赖 devicePixelRatio）。 */
export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 1920;

/**
 * 画布配色。
 *
 * canvas 2D 吃不到 className / CSS 变量，颜色只能落在代码里；这里集中成一份色板，
 * 取值全部对应 Tailwind 的 stone / teal / amber / slate 色阶（和页面同一套视觉），
 * 绘制函数里不许再出现颜色字面量。
 */
const PALETTE = {
  /** 底：纯白（M11 3.2 要求纯色底，不加装饰性渐变）。 */
  paper: "#ffffff",
  /** stone-900：正文最深色（日期 / 站点序号）。 */
  ink: "#1c1917",
  /** stone-800：路线主色 / 底部一句话。 */
  inkSoft: "#292524",
  /** stone-700：地名列表。 */
  textStrong: "#44403c",
  /** stone-600：统计行。 */
  text: "#57534e",
  /** stone-300：一句话上方的短分隔线。 */
  rule: "#d6d3d1",
  /** stone-200：两条细横线。 */
  hairline: "#e7e5e4",
  /** stone-400：右下角城市名 + 日期。 */
  meta: "#a8a29e",
  /** 四种通勤方式四种颜色，整体控制在「三四种以内」、全部低饱和。 */
  routeWalk: "#292524",
  routeBike: "#0f766e",
  routeBus: "#b45309",
  routeDrive: "#475569",
} as const;

/**
 * 中文字体栈。canvas 只认字体名，不认 CSS 简写里的 system-ui 别名之外的 Tailwind 变量，
 * 所以这里显式列出 Windows / macOS / Linux 上常见的无衬线中文字体，最后兜底 system-ui，
 * 避免图上出现豆腐块或回退成衬线体（验收第 6 条「没有乱码、没有被裁切」）。
 */
const FONT_STACK =
  '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Source Han Sans SC", system-ui, sans-serif';

/* ------------------------------------------------------------------ *
 * 版式（1080×1920 的分层，从上到下）
 * ─ 路线图  0 ~ 1020   （约 53%，白底极简）
 * ─ 日期    1056 ~ 1180
 * ─ 统计    1180 ~ 1322
 * ─ 地名    1322 ~ 1560（最多两行）
 * ─ 一句话  1560 ~ 1790（最多两行）
 * ─ 右下角  1852（很小）
 * ------------------------------------------------------------------ */

/** 左右安全边距。 */
const MARGIN_X = 96;
/** 细横线的左右端点（内容区同宽）。 */
const LINE_X0 = MARGIN_X;
const LINE_X1 = CARD_WIDTH - MARGIN_X;
/** 两条细横线：路线图 / 日期统计之间，以及统计 / 地名之间。 */
const DIVIDER_ROUTE_Y = 1026;
const DIVIDER_STATS_Y = 1318;

/** 路线图里站点坐标的落点区域（「出发」标记占左侧一条竖向留白，所以右移一点）。 */
const MAP_BOX = { left: 300, top: 186, right: 960, bottom: 952 };

/**
 * 「出发」标记的中性锚点。
 *
 * 固定画在左侧留白里、高度跟随第一站（所以第一段总是一条短的横向弧线，不会横穿整个点群），
 * 与 origin 的真实经纬度无关——这是隐私红线的实现方式，不是临时值。
 * 真实起点在哪不影响它，图上因此既没有家庭住址，也没有「家相对这几站的方向」这种可反推信息。
 */
const DEPART_ANCHOR_X = 176;
/** 锚点竖向落点：跟第一站对齐，再夹在路线区里，给空心圆和「出发」二字留出空间。 */
const DEPART_ANCHOR_TOP = MAP_BOX.top + 24;
const DEPART_ANCHOR_BOTTOM = MAP_BOX.bottom - 48;

/**
 * 地理跨度的最小值兜底（纬度度数，经度方向按 cos 纬度折算）。
 *
 * 所有站点几乎重合时不做「把一个街区放大到整张画布」的失真放大：宁可让点聚在中间，
 * 也保持相对距离的观感（和 components/RouteMap.tsx 的 MIN_SPAN_DEG 同一口径）。
 */
const MIN_SPAN_DEG = 0.0015;

/** 路线线宽（1080 宽的画布上 7px 是「细但有存在感」的克重）。 */
const ROUTE_LINE_WIDTH = 7;
/** 每一段底下垫的白边宽度差：让后画的路段在交叉处把前一段切断一点点，读得清谁在上面。 */
const ROUTE_CASING_EXTRA = 8;
/** 站点实心圆半径 + 外圈白环（白环只为了和路过的线分开，画在圆的下面半层）。 */
const STOP_DOT_RADIUS = 26;
const STOP_RING_RADIUS = 29;
const STOP_RING_WIDTH = 6;
/** 站点序号字号。 */
const STOP_NUMBER_FONT = 28;
/** 「出发」空心圆半径 + 描边宽度。 */
const DEPART_RADIUS = 20;
const DEPART_STROKE_WIDTH = 5;

/** 日期字号 / 统计行字号 / 地名列表字号 / 一句话字号 / 右下角小字字号。 */
const FONT_DATE = 72;
const FONT_STATS = 40;
const FONT_NAMES = 38;
const FONT_ONE_LINER = 40;
const FONT_META = 24;
const FONT_DEPART_LABEL = 30;

/** 地名列表最多两行、一句话最多两行（M11 分层：小字，不抢路线图）。 */
const NAMES_MAX_LINES = 2;
const ONE_LINER_MAX_LINES = 2;
/** 地名列表 / 一句话的行高。 */
const NAMES_LINE_HEIGHT = 60;
const ONE_LINER_LINE_HEIGHT = 64;

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

export type RouteCardOptions = {
  /** 已经算好的行程（/api/plan、/api/swap 返回的原始对象）。 */
  itinerary: Itinerary;
  /**
   * 城市显示名，来自 /api/cities 的城市配置（杭州 / 辽阳），页面透传；
   * 本文件不写死城市名（双城市要求）。
   */
  cityName: string;
  /** 卡片上的日期，默认今天。只影响日期文案，不参与任何排程。 */
  date?: Date;
};

type GeoPoint = { lng: number; lat: number };
type CanvasPoint = { x: number; y: number };

/* ------------------------------------------------------------------ *
 * 纯函数：文案 / 统计（不碰 canvas，方便单独验证口径）
 * ------------------------------------------------------------------ */

/** 分钟数 → 「3 小时 8 分」/「48 分钟」/「不到 1 分钟」。 */
export function formatDuration(totalMin: number): string {
  const minutes = Math.max(0, Math.round(totalMin));
  if (minutes === 0) return "不到 1 分钟";
  if (minutes < 60) return `${minutes} 分钟`;
  const hour = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hour} 小时` : `${hour} 小时 ${rest} 分`;
}

/** 米 → 「1.9 公里」/「800 米」。保留一位小数，不做四舍五入到整公里。 */
export function formatDistance(meters: number): string {
  const value = Math.max(0, meters);
  if (value >= 1000) return `${(value / 1000).toFixed(1)} 公里`;
  return `${Math.round(value)} 米`;
}

/**
 * 统计行：「3 小时 8 分 · 步行 1.9 公里 · 68 元」。
 *
 * 口径：
 * - 时长用 itinerary.totalMin（含返程，服务端算好的整数分钟）；
 * - 距离按段累加：只累加 mode === "walk" 的段（返程段也计入，因为时长口径包含返程）；
 *   一段步行都没有时退回「所有段的总里程」并改叫「移动」，不把公交 / 打车里程冒充步行；
 * - 花费用 itinerary.totalCost 取整。
 */
export function buildStatLine(itinerary: Itinerary): string {
  const parts: string[] = [formatDuration(itinerary.totalMin)];

  const walkMeters = itinerary.segments
    .filter((segment) => segment.mode === "walk")
    .reduce((sum, segment) => sum + segment.distanceM, 0);
  const allMeters = itinerary.segments.reduce((sum, segment) => sum + segment.distanceM, 0);
  const distanceMeters = walkMeters > 0 ? walkMeters : allMeters;
  if (distanceMeters > 0) {
    parts.push(`${walkMeters > 0 ? "步行" : "移动"} ${formatDistance(distanceMeters)}`);
  }

  parts.push(`${Math.round(itinerary.totalCost)} 元`);
  return parts.join(" · ");
}

/** 日期行：「10月23日 周五」。 */
export function formatCardDate(date: Date): string {
  return `${date.getMonth() + 1}月${date.getDate()}日 ${WEEKDAYS[date.getDay()]}`;
}

/** 右下角的小日期：「10.23」。 */
export function formatCardDateShort(date: Date): string {
  return `${date.getMonth() + 1}.${date.getDate()}`;
}

/**
 * 地名列表的展示口径：去掉名字末尾括号里的分店后缀。
 *
 * 「星巴克(杭州UDC店)」→「星巴克」、「兰州陈记牛肉面(杭州首店)」→「兰州陈记牛肉面」——
 * 只做显示裁剪（括号常是分店 / 商圈名，卡片上字小，留着会把列表挤成两行还放不下），
 * 不改数据、不生成任何名称；去掉后为空就退回原名。
 */
export function displayPlaceName(name: string): string {
  const trimmed = name.trim();
  const stripped = trimmed.replace(/[（(][^（）()]*[）)]\s*$/, "").trim();
  return stripped.length > 0 ? stripped : trimmed;
}

/** 站点名称列表：「城市阳台 · 乾嘉书房 · 胡家厨房」。 */
export function buildPlaceNames(stops: Stop[]): string[] {
  return stops
    .map((stop) => displayPlaceName(stop.placeName ?? ""))
    .filter((name) => name.length > 0);
}

/** 导出文件名：route-card-2026-10-23.png（不含中文，避免不同系统的下载编码问题）。 */
export function buildCardFileName(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `route-card-${year}-${month}-${day}.png`;
}

/* ------------------------------------------------------------------ *
 * 几何：投影 + 平滑曲线
 * ------------------------------------------------------------------ */

/**
 * 等距圆柱投影 + 等比缩放：只把有坐标的站点放进 MAP_BOX，居中、不裁切。
 * 两个方向共用一个 scale，所以「实际更近的两点 → 图上更近」成立。
 */
export function projectStops(stops: GeoPoint[]): CanvasPoint[] {
  if (stops.length === 0) return [];

  const centerLat =
    stops.reduce((sum, stop) => sum + stop.lat, 0) / Math.max(1, stops.length);
  const lngScale = Math.cos((centerLat * Math.PI) / 180);
  const raw = stops.map((stop) => ({ x: stop.lng * lngScale, y: -stop.lat }));

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
  const innerWidth = MAP_BOX.right - MAP_BOX.left;
  const innerHeight = MAP_BOX.bottom - MAP_BOX.top;
  const effectiveSpanX = Math.max(spanX, MIN_SPAN_DEG * lngScale);
  const effectiveSpanY = Math.max(spanY, MIN_SPAN_DEG);
  const scale = Math.min(innerWidth / effectiveSpanX, innerHeight / effectiveSpanY);

  const offsetX = MAP_BOX.left + (innerWidth - spanX * scale) / 2;
  const offsetY = MAP_BOX.top + (innerHeight - spanY * scale) / 2;
  return raw.map((point) => ({
    x: offsetX + (point.x - minX) * scale,
    y: offsetY + (point.y - minY) * scale,
  }));
}

/**
 * 每一段路的控制点：沿弦方向向里收 36%，再统一向行进方向的同一侧弯一个固定比例。
 *
 * 为什么不用「整条线穿所有点的 Catmull-Rom」：
 * 行程顺序不是空间顺序（可能先往东、再折回西、再往北），在折返点上 Catmull-Rom 为了让切线连续
 * 会甩出一个比站点圆还大的回环，图上看起来像打结，也会让人误读成「绕了一圈」。
 * 现在每段单独成一条平滑的弧、弧度随弦长按比例（上限 80px），在站点圆的白环下面接起来：
 * 全程没有折角、没有回环，相对位置只由站点坐标决定（验收第 5 条）。
 */
function legControlPoints(from: CanvasPoint, to: CanvasPoint): { c1: CanvasPoint; c2: CanvasPoint } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 1) return { c1: { ...from }, c2: { ...to } };

  const ux = dx / length;
  const uy = dy / length;
  // 行进方向逆时针 90° 的法线（屏幕坐标 y 向下）；所有段用同一侧，整条路像一根顺着手势画的线。
  const nx = uy;
  const ny = -ux;
  const bow = Math.min(length * 0.1, 80);
  const along = length * 0.36;
  return {
    c1: { x: from.x + ux * along + nx * bow, y: from.y + uy * along + ny * bow },
    c2: { x: to.x - ux * along + nx * bow, y: to.y - uy * along + ny * bow },
  };
}

/** 通勤方式 → 路线颜色（四种以内，整体克制）。 */
function segmentColor(mode: SegmentMode | undefined): string {
  switch (mode) {
    case "bike":
      return PALETTE.routeBike;
    case "bus":
      return PALETTE.routeBus;
    case "drive":
      return PALETTE.routeDrive;
    case "walk":
    default:
      return PALETTE.routeWalk;
  }
}

/* ------------------------------------------------------------------ *
 * 文本绘制
 * ------------------------------------------------------------------ */

function applyFont(ctx: CanvasRenderingContext2D, size: number, weight: number): void {
  ctx.font = `${weight} ${size}px ${FONT_STACK}`;
}

/** 一行文字放不下时截断并补省略号（保证截断后仍不超宽）。 */
function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  const current = Array.from(text);
  while (current.length > 0 && ctx.measureText(`${current.join("")}…`).width > maxWidth) {
    current.pop();
  }
  return `${current.join("")}…`;
}

/** 按字符换行（中文没有空格，按字符断行），最多 maxLines 行，最后一行超长补省略号。 */
function wrapByChars(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const chars = Array.from(text);
  const lines: string[] = [];
  let current = "";
  for (const char of chars) {
    const candidate = current + char;
    if (current.length > 0 && ctx.measureText(candidate).width > maxWidth) {
      lines.push(current);
      current = char;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) lines.push(current);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = ellipsize(ctx, kept[maxLines - 1], maxWidth);
  return kept;
}

/**
 * 按「token + 分隔符」换行（地名列表用：「城市阳台 · 乾嘉书房 · 胡家厨房」只在 · 处断行）。
 * 单个 token 本身就超宽时按字符截断，不硬挤。
 */
function wrapByTokens(
  ctx: CanvasRenderingContext2D,
  tokens: string[],
  separator: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const lines: string[] = [];
  let current = "";
  for (const token of tokens) {
    const piece = ctx.measureText(token).width > maxWidth ? ellipsize(ctx, token, maxWidth) : token;
    const candidate = current.length === 0 ? piece : `${current}${separator}${piece}`;
    if (current.length > 0 && ctx.measureText(candidate).width > maxWidth) {
      lines.push(current);
      current = piece;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) lines.push(current);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = ellipsize(ctx, kept[maxLines - 1], maxWidth);
  return kept;
}

function fillText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  align: CanvasTextAlign = "left",
): void {
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(text, x, y);
}

/* ------------------------------------------------------------------ *
 * 各层绘制
 * ------------------------------------------------------------------ */

/** 细横线（1px 视觉宽度：1080 画布上画 2px 更接近屏幕上的 1px）。 */
function drawHairline(ctx: CanvasRenderingContext2D, y: number): void {
  ctx.save();
  ctx.fillStyle = PALETTE.hairline;
  ctx.fillRect(LINE_X0, y, LINE_X1 - LINE_X0, 2);
  ctx.restore();
}

/**
 * 第一层：路线图。
 *
 * 只画三样东西：平滑路线、「出发」空心圆、各站实心圆 + 序号。
 * 没有底图、没有瓦片、没有街道名、没有正北指北针、没有任何坐标数字。
 */
function drawRouteMap(ctx: CanvasRenderingContext2D, itinerary: Itinerary): void {
  const geocoded = itinerary.stops.filter(
    (stop): stop is Stop & { lng: number; lat: number } =>
      typeof stop.lng === "number" && typeof stop.lat === "number",
  );
  if (geocoded.length === 0) {
    throw new Error("这份行程的站点没有坐标，画不出路线图");
  }

  const stopPoints = projectStops(geocoded);
  // 「出发」锚点：左侧留白，高度对齐第一站（真实 origin 坐标不参与）。
  const departAnchor: CanvasPoint = {
    x: DEPART_ANCHOR_X,
    y: Math.min(Math.max(stopPoints[0].y, DEPART_ANCHOR_TOP), DEPART_ANCHOR_BOTTOM),
  };
  const pathPoints: CanvasPoint[] = [departAnchor, ...stopPoints];

  // 路线：逐段画（颜色按这一段的服务端 mode），整条线仍然是同一条平滑曲线。
  // 每段先画一层白色「衬底」再画颜色：路线在空间上会交叉（先往东再折回西），
  // 衬底让后画的段把前一段切断一小截，交叉处看得清，像手绘地图上的压线。
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let index = 0; index < pathPoints.length - 1; index += 1) {
    const from = pathPoints[index];
    const to = pathPoints[index + 1];
    const { c1, c2 } = legControlPoints(from, to);

    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, to.x, to.y);
    ctx.lineWidth = ROUTE_LINE_WIDTH + ROUTE_CASING_EXTRA;
    ctx.strokeStyle = PALETTE.paper;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, to.x, to.y);
    ctx.lineWidth = ROUTE_LINE_WIDTH;
    ctx.strokeStyle = segmentColor(itinerary.segments[index]?.mode);
    ctx.stroke();
  }
  ctx.restore();

  // 各站：白色外环（只把「路过的线」和圆点分开）→ 实心圆 → 白色序号。
  // 外环画在实心圆下面：连到这一站的路段不会被挖出大缺口，路过的线则会被环切断一小截。
  for (let index = 0; index < stopPoints.length; index += 1) {
    const point = stopPoints[index];
    ctx.beginPath();
    ctx.strokeStyle = PALETTE.paper;
    ctx.lineWidth = STOP_RING_WIDTH;
    ctx.arc(point.x, point.y, STOP_RING_RADIUS, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.fillStyle = PALETTE.ink;
    ctx.arc(point.x, point.y, STOP_DOT_RADIUS, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.fillStyle = PALETTE.paper;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    applyFont(ctx, STOP_NUMBER_FONT, 600);
    ctx.fillText(String(index + 1), point.x, point.y + 1);
    ctx.restore();
  }

  // 起点：空心圆（白底 + 深色描边，视觉上是空心），下方一行「出发」。
  ctx.save();
  ctx.beginPath();
  ctx.fillStyle = PALETTE.paper;
  ctx.arc(departAnchor.x, departAnchor.y, DEPART_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = DEPART_STROKE_WIDTH;
  ctx.strokeStyle = PALETTE.ink;
  ctx.stroke();
  ctx.restore();
  applyFont(ctx, FONT_DEPART_LABEL, 400);
  fillText(
    ctx,
    "出发",
    departAnchor.x,
    departAnchor.y + DEPART_RADIUS + 38,
    PALETTE.text,
    "center",
  );
}

/** 第二层：日期 + 统计。 */
function drawDateAndStats(
  ctx: CanvasRenderingContext2D,
  itinerary: Itinerary,
  date: Date,
): void {
  applyFont(ctx, FONT_DATE, 600);
  fillText(ctx, formatCardDate(date), MARGIN_X, 1170, PALETTE.ink);

  applyFont(ctx, FONT_STATS, 400);
  fillText(ctx, buildStatLine(itinerary), MARGIN_X, 1252, PALETTE.text);
}

/** 第三层：地名列表（小字，最多两行）。 */
function drawPlaceNames(ctx: CanvasRenderingContext2D, stops: Stop[]): void {
  applyFont(ctx, FONT_NAMES, 400);
  const names = buildPlaceNames(stops);
  if (names.length === 0) return;
  const lines = wrapByTokens(ctx, names, " · ", LINE_X1 - LINE_X0, NAMES_MAX_LINES);
  lines.forEach((line, index) => {
    fillText(ctx, line, MARGIN_X, 1402 + index * NAMES_LINE_HEIGHT, PALETTE.textStrong);
  });
}

/**
 * 第四层：底部一句话 + 左上短分隔线；右下角城市名 + 日期。
 *
 * 一句话只来自 Itinerary.oneLiner（/api/plan 生成成功时才有）。没有就**留白**，
 * 不再从 reason 提炼兜底——避免「没文案」时画出一句看起来像文案的行程摘录。
 */
function drawOneLinerAndMeta(
  ctx: CanvasRenderingContext2D,
  itinerary: Itinerary,
  date: Date,
  cityName: string,
): void {
  const oneLiner = (itinerary.oneLiner ?? "").trim();

  if (oneLiner.length > 0) {
    // 一句话上方一条短横线，和地名列表分层；不加任何装饰图形（M11 3.2：不要装饰性渐变）。
    ctx.save();
    ctx.fillStyle = PALETTE.rule;
    ctx.fillRect(MARGIN_X, 1568, 72, 4);
    ctx.restore();

    applyFont(ctx, FONT_ONE_LINER, 400);
    const lines = wrapByChars(ctx, oneLiner, LINE_X1 - LINE_X0, ONE_LINER_MAX_LINES);
    lines.forEach((line, index) => {
      fillText(ctx, line, MARGIN_X, 1652 + index * ONE_LINER_LINE_HEIGHT, PALETTE.inkSoft);
    });
  }

  // 右下角：城市名从城市配置来（杭州 / 辽阳），后面跟一个小日期。
  const city = cityName.trim();
  const meta = city.length > 0 ? `${city} · ${formatCardDateShort(date)}` : formatCardDateShort(date);
  applyFont(ctx, FONT_META, 400);
  fillText(ctx, meta, LINE_X1, 1848, PALETTE.meta, "right");
}

/* ------------------------------------------------------------------ *
 * 对外入口
 * ------------------------------------------------------------------ */

/** 把一份行程画到传入的 2D 上下文上（尺寸由调用方保证是 CARD_WIDTH×CARD_HEIGHT）。 */
export function drawRouteCard(ctx: CanvasRenderingContext2D, options: RouteCardOptions): void {
  const date = options.date ?? new Date();

  ctx.save();
  ctx.fillStyle = PALETTE.paper;
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
  ctx.restore();

  drawRouteMap(ctx, options.itinerary);
  drawHairline(ctx, DIVIDER_ROUTE_Y);
  drawDateAndStats(ctx, options.itinerary, date);
  drawHairline(ctx, DIVIDER_STATS_Y);
  drawPlaceNames(ctx, options.itinerary.stops);
  drawOneLinerAndMeta(ctx, options.itinerary, date, options.cityName);
}

/** 新建一块 1080×1920 的画布并画好（浏览器端）。 */
export function renderRouteCard(options: RouteCardOptions): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    throw new Error("浏览器拿不到 canvas 2D 上下文，导不出卡片");
  }
  drawRouteCard(ctx, options);
  return canvas;
}

/**
 * 导出：canvas.toDataURL("image/png") → <a download>（M11 3.3 要求的方式，纯前端）。
 * 返回实际宽高，页面可以拿来做「导出成功」的提示 / 验收脚本可以直接核对。
 */
export function exportRouteCardPng(options: RouteCardOptions): {
  fileName: string;
  width: number;
  height: number;
} {
  const date = options.date ?? new Date();
  const canvas = renderRouteCard({ ...options, date });
  const dataUrl = canvas.toDataURL("image/png");
  const fileName = buildCardFileName(date);

  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = fileName;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();

  return { fileName, width: canvas.width, height: canvas.height };
}
