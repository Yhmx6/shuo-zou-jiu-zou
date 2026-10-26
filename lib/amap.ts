import { z } from "zod";
import { PlaceSchema } from "../types/schema";
import type { Place, PlaceCategory } from "../types/schema";
import { readCache, writeCache } from "./cache";

/**
 * 高德 Web 服务接口封装（只在服务端调用）：
 *   searchPoi —— place/text   POI 搜索
 *   geocode   —— geocode/geo  地址转坐标
 *   regeo     —— geocode/regeo 坐标转地址
 *
 * M1 只做「取数 + 字段映射」，不做任何排序 / 选点 / 排程。
 *
 * 字段形状按 M1 3.1.5 的实测结果写（不要凭记忆改字段名）：
 *   - biz_ext.cost 可能是空数组，空数组 / 空字符串 / 缺字段一律 → null（不能让 Number([]) 变成 0 元）；
 *   - biz_ext.rating 是字符串 "4.7"，Number() 后 NaN → null；
 *   - 营业时间优先用 biz_ext.open_time（已是 "10:00-22:00"），opentime2 是自然语言，只兜底；
 *   - count 是字符串 "581"，做分页判断前先 Number()；
 *   - category 只从 typecode 推（typecode 比 keywords 准），复合码取第一段主类型。
 *
 * AMAP_KEY 只从服务端环境变量读：不写死、不进日志、不进缓存键。
 */

const AMAP_BASE_URL = "https://restapi.amap.com";
/** place/text 每页条数；M1 每个关键词只抓第 1 页（10 条）。 */
const POI_PAGE_SIZE = 10;

/** 高德响应信封：status 为 "1" 才代表成功。 */
const AmapEnvelopeSchema = z.object({
  status: z.union([z.string(), z.number()]),
  info: z.union([z.string(), z.number()]).optional(),
  infocode: z.union([z.string(), z.number()]).optional(),
});

/** 坐标。geocode 的返回值也必须过 zod 校验。 */
const LngLatSchema = z.object({
  lng: z.number(),
  lat: z.number(),
});

type AmapParams = Record<string, string>;

function getApiKey(): string {
  const key = process.env.AMAP_KEY;
  if (!key) {
    throw new Error(
      "缺少 AMAP_KEY：请把高德开放平台「Web 服务」类型的 Key 写进 .env.local（只放服务端环境变量）",
    );
  }
  return key;
}

/** 带磁盘缓存的 GET。命中缓存直接返回原始 JSON，不消耗高德配额。 */
async function requestAmap(
  fn: string,
  path: string,
  params: AmapParams,
): Promise<Record<string, unknown>> {
  const cached = readCache<Record<string, unknown>>(fn, params);
  if (cached !== null) return cached;

  const url = new URL(path, AMAP_BASE_URL);
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }
  url.searchParams.set("key", getApiKey());

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`高德 ${fn} 请求失败：HTTP ${response.status}`);
  }
  const json: unknown = await response.json();
  if (typeof json !== "object" || json === null) {
    throw new Error(`高德 ${fn} 返回的不是 JSON 对象`);
  }

  const envelope = AmapEnvelopeSchema.safeParse(json);
  if (!envelope.success) {
    throw new Error(`高德 ${fn} 响应缺少 status 字段，结构不符合预期`);
  }
  const { status, info, infocode } = envelope.data;
  if (String(status) !== "1") {
    throw new Error(
      `高德 ${fn} 调用失败：status=${String(status)} info=${String(info)} infocode=${String(infocode)}`,
    );
  }

  const result = json as Record<string, unknown>;
  writeCache(fn, params, result);
  return result;
}

/** 高德没有值时可能返回 []、"" 或干脆没有这个字段；统一转 null。 */
function toNullableNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    return toNullableNumber(value[0]);
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "") return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" ? null : text;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** "120.099011,30.265921" → { lng, lat }；拿不到合法坐标返回 null。 */
function parseLngLat(value: unknown): { lng: number; lat: number } | null {
  const text = toNonEmptyString(value);
  if (text === null) return null;
  const [lngText, latText] = text.split(",");
  if (lngText === undefined || latText === undefined) return null;
  const lng = Number(lngText.trim());
  const lat = Number(latText.trim());
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return null;
  // 高德对没有坐标的 POI 有时会给 "0,0"，这种也视为没有坐标。
  if (lng === 0 && lat === 0) return null;
  return LngLatSchema.parse({ lng, lat });
}

function formatClock(hourText: string, minuteText: string): string | null {
  const hour = Number(hourText);
  const minute = Number(minuteText);
  // 24:00 是营业时间的合法结束点（全天营业 = 00:00-24:00），其它 24 点几的写法不认。
  const isEndOfDay = hour === 24 && minute === 0;
  if (!Number.isInteger(hour) || hour < 0 || (hour > 23 && !isEndOfDay)) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** 从一段文字里取第一个时间区间，兼容 "10:00-22:00" / "10:00–22:00" / "10:00至22:00"。 */
const TIME_RANGE_PATTERN = /(\d{1,2})[:：](\d{2})\s*[-–—~～至]\s*(\d{1,2})[:：](\d{2})/;

/** 高德对全天开放的地点常常直接写「24小时营业」，没有 HH:mm 区间可用。 */
const ALL_DAY_PATTERN = /24\s*小时/;

/**
 * 全天营业的统一表示：openTime "00:00" / closeTime "24:00"。
 * closeTime 写成 "24:00" 而不是 "23:59"，是为了让 lib/constraints.ts 的 parseClockMinute 得到 1440
 * （当日结束），「到达 + 停留 ≤ 闭馆」在 23:30 以后不会因为差 1 分钟被误判成关门。
 */
const ALL_DAY_OPEN_TIME = "00:00";
const ALL_DAY_CLOSE_TIME = "24:00";

/**
 * 营业时间映射。
 * 顺序：open_time（已是 "10:00-22:00"）→ opentime2（自然语言，兜底）→ opentime_today。
 * 一天有多个营业时段时只取第一段（schema 只有一对 openTime/closeTime）。
 * 高德确实没给营业时间时两个都返回 null（M1 3.1：「没有就写 null，不要编」）。
 *
 * M5 数据口径修复：高德对公园这类全天开放的地点给的是
 *   open_time = "24小时营业"，opentime2 = "周一至周日 00:00-24:00"
 * 旧实现只认 HH:mm 区间，"24小时营业" 解析不出来就落成 null；而 lib/constraints.ts 的 isOpenAt
 * 把 null 当「未知 → 不可去」，于是 7 个公园永远选不中。现在两种写法都映射成
 * "00:00" / "24:00"（24:00 由 parseClockMinute 解析成 1440）。
 * 注意：types/schema.ts 的注释把「两个都 null」解释为全天开放，和这里「未知」的语义有出入，
 * 但 M5 之后城市数据里只有真正没给营业时间的地点才会是 null。
 */
function parseOpenTime(bizExt: Record<string, unknown>): {
  openTime: string | null;
  closeTime: string | null;
} {
  const candidates: unknown[] = [bizExt.open_time, bizExt.opentime2, bizExt.opentime_today];
  for (const candidate of candidates) {
    const text = toNonEmptyString(candidate);
    if (text === null) continue;
    if (ALL_DAY_PATTERN.test(text)) {
      return { openTime: ALL_DAY_OPEN_TIME, closeTime: ALL_DAY_CLOSE_TIME };
    }
    const match = TIME_RANGE_PATTERN.exec(text);
    if (match === null) continue;
    const openTime = formatClock(match[1], match[2]);
    const closeTime = formatClock(match[3], match[4]);
    if (openTime === null || closeTime === null) continue;
    return { openTime, closeTime };
  }
  return { openTime: null, closeTime: null };
}

/**
 * 周休解析（M1 补丁 / M2 §0.5）：从 biz_ext.opentime2 的自然语言里解析「每周哪几天休息」。
 * 只处理实际数据里出现的写法：周一、周X至周Y、周一、周三至周日、周一闭馆/全天关闭/不营业；
 * 带具体日期（2026-02-09、01-01至01-30、1/1-12/31）或节假日限定的子句不参与周休判断
 * （整年区间 1/1-12/31 例外，它等价于每周规则）；解析不出来返回 []，不猜。
 */

const WEEKDAY_DAY: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
/** 一周的书写顺序（周一..周日），把「A 至 B」展开成连续星期时用。 */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

/** 闭馆类动词：出现在它前面的星期才是「休息日」。 */
const CLOSED_VERB_PATTERN = /(?:全天关闭|全天不开放|闭馆|闭园|闭店|停业|休息|不营业|关闭)/;
const HOLIDAY_PATTERN = /(?:元旦|春节|清明|劳动节|端午|中秋|国庆|节假日|法定节假日)/;
/** 周X / 周X至周Y 的星期写法 */
const WEEKDAY_RANGE_PATTERN =
  /(?:周|星期|礼拜)([一二三四五六日天])\s*(?:至|到|~|～|–|—|-)\s*(?:周|星期|礼拜)([一二三四五六日天])/g;
const WEEKDAY_SINGLE_PATTERN = /(?:周|星期|礼拜)([一二三四五六日天])/g;
/** 2026-02-09 这种带年份的具体日期 */
const FULL_DATE_PATTERN = /\d{4}-\d{1,2}-\d{1,2}/;
/** 01-01至01-30 这种月-日区间 */
const MONTH_DAY_RANGE_PATTERN = /(?:^|[^\d])\d{1,2}-\d{1,2}\s*(?:至|[-–—~～])\s*\d{1,2}-\d{1,2}/;
/** 1/1-12/31 这种月/日区间 */
const MONTH_DAY_SLASH_RANGE_PATTERN = /(?:^|[^\d])\d{1,2}\/\d{1,2}\s*(?:至|[-–—~～])\s*\d{1,2}\/\d{1,2}/;
/** 整年区间：等价于「每周都按这个来」，不能当成具体日期跳过。 */
const WHOLE_YEAR_TEST_PATTERN = /(?:^|[^\d])0?1(?:\/|-|\.)0?1\s*(?:至|[-–—~～])\s*12(?:\/|-|\.)31/;
const WHOLE_YEAR_STRIP_PATTERN = /(?:^|[^\d])0?1(?:\/|-|\.)0?1\s*(?:至|[-–—~～])\s*12(?:\/|-|\.)31/g;

function expandWeekdayRange(startDay: number, endDay: number): number[] {
  const start = WEEK_ORDER.indexOf(startDay);
  const end = WEEK_ORDER.indexOf(endDay);
  if (start === -1 || end === -1) return [];
  if (start <= end) return WEEK_ORDER.slice(start, end + 1);
  return [...WEEK_ORDER.slice(start), ...WEEK_ORDER.slice(0, end + 1)];
}

/** tsconfig 没开 downlevelIteration（target 默认 ES5），统一用 exec 循环取所有匹配，避免 for...of 迭代器。 */
function findAll(pattern: RegExp, text: string): RegExpExecArray[] {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const regexp = new RegExp(pattern.source, flags);
  const matches: RegExpExecArray[] = [];
  let match: RegExpExecArray | null = regexp.exec(text);
  while (match !== null) {
    matches.push(match);
    match = regexp.exec(text);
  }
  return matches;
}

/** 子句里出现的星期（含「A 至 B」展开的连续星期），升序去重。 */
function collectWeekdays(text: string): number[] {
  const days = new Set<number>();
  for (const match of findAll(WEEKDAY_RANGE_PATTERN, text)) {
    for (const day of expandWeekdayRange(WEEKDAY_DAY[match[1]], WEEKDAY_DAY[match[2]])) days.add(day);
  }
  for (const match of findAll(WEEKDAY_SINGLE_PATTERN, text)) {
    days.add(WEEKDAY_DAY[match[1]]);
  }
  return Array.from(days);
}

function isDateSpecificClause(clause: string): boolean {
  const hadWholeYear = WHOLE_YEAR_TEST_PATTERN.test(clause);
  const target = hadWholeYear ? clause.replace(WHOLE_YEAR_STRIP_PATTERN, " ") : clause;
  return (
    HOLIDAY_PATTERN.test(target) ||
    FULL_DATE_PATTERN.test(target) ||
    MONTH_DAY_RANGE_PATTERN.test(target) ||
    MONTH_DAY_SLASH_RANGE_PATTERN.test(target)
  );
}

/** opentime2 → closedDays（0 = 周日，升序）。没有信息就返回 []。 */
export function parseClosedDays(opentime2: string | null): number[] {
  const text = opentime2 === null ? "" : opentime2.trim();
  if (text === "") return [];
  const openDays = new Set<number>();
  const restDays = new Set<number>();

  for (const clause of text
    .split(/[;；,，。]/)
    .map((part) => part.trim())
    .filter((part) => part !== "")) {
    // 具体日期 / 节假日限定的子句是临时调整，不是周休规则。
    if (isDateSpecificClause(clause)) continue;
    const verb = CLOSED_VERB_PATTERN.exec(clause);
    if (verb !== null) {
      // 只看闭馆动词之前的星期主语；「周六至周日 不营业(演出日…)」括号里的例外不展开。
      for (const day of collectWeekdays(clause.slice(0, verb.index))) restDays.add(day);
      continue;
    }
    for (const day of collectWeekdays(clause)) openDays.add(day);
  }

  // 原文枚举了营业日但没覆盖整周 → 没列出来的星期就是休息日（「周一至周日」覆盖整周 → []）。
  if (openDays.size > 0 && openDays.size < 7) {
    for (const day of WEEK_ORDER) {
      if (!openDays.has(day)) restDays.add(day);
    }
  }
  return Array.from(restDays).sort((a, b) => a - b);
}

/**
 * typecode → category。
 * 只认实测 / M1 3.1.5 给出的类型码，认不出的返回 "other"（由 fetch-seed 丢弃），
 * 不拿关键词去猜分类。复合码（"061205|110200"）取第一段主类型。
 */
const TYPECODE_TO_CATEGORY: Record<string, PlaceCategory> = {
  // 实测：购物服务;专卖店;书店
  "061205": "bookstore",
  // 实测：科教文化服务;美术馆;美术馆
  "140400": "gallery",
  // 实测：科教文化服务;博物馆;博物馆（3.1.5 里把 140100 标成美术馆/展览，实测是博物馆，按实测映射）
  "140100": "museum",
  // 实测：体育休闲服务;影剧院;剧场
  "080603": "theater",
  // 3.1.5 给定的剧场码，本轮杭州数据没返回，留作其它城市的兜底
  "080301": "theater",
  // 3.1.5 给定的公园码（M1 五个关键词不抓公园，先留映射）
  "110101": "park",
};

function categoryFromTypecode(typecode: string | null): PlaceCategory {
  if (typecode === null) return "other";
  const primary = typecode.split("|")[0].trim();
  const exact = TYPECODE_TO_CATEGORY[primary];
  if (exact !== undefined) return exact;
  // 购物服务;综合市场;农副产品市场 / 蔬菜市场 / 综合市场
  if (primary.startsWith("0607")) return "market";
  // 餐饮服务;中餐厅;中餐厅 / 海鲜酒楼（面馆属于中餐厅下的子类）
  if (primary.startsWith("0501")) return "restaurant";
  return "other";
}

/** 本机当地的 "YYYY-MM-DD"（不用 UTC，避免跨日错位；与 lib/origin.ts 的处理保持一致）。 */
function todayIsoDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** 一条 place/text 的 POI → Place；没有 id / 名称 / 坐标的直接丢弃（只保留有坐标的）。 */
function toPlace(rawPoi: unknown): Place | null {
  const poi = asRecord(rawPoi);
  if (poi === null) return null;

  const id = toNonEmptyString(poi.id);
  const name = toNonEmptyString(poi.name);
  const center = parseLngLat(poi.location);
  if (id === null || name === null || center === null) return null;

  const bizExt = asRecord(poi.biz_ext) ?? {};
  const { openTime, closeTime } = parseOpenTime(bizExt);
  // M1 补丁（M2 §0.5）：周休只从 opentime2 的自然语言里解析；解析不出来如实留空，不猜。
  const closedDays = parseClosedDays(toNonEmptyString(bizExt.opentime2));

  return {
    id,
    name,
    lng: center.lng,
    lat: center.lat,
    category: categoryFromTypecode(toNonEmptyString(poi.typecode)),
    openTime,
    closeTime,
    closedDays,
    rating: toNullableNumber(bizExt.rating),
    avgCost: toNullableNumber(bizExt.cost),
    source: "amap",
    lastVerified: todayIsoDate(),
  };
}

/** POI 搜索（place/text）。返回值过 PlaceSchema 校验，不通过直接抛错。 */
export async function searchPoi(keyword: string, city: string, page: number): Promise<Place[]> {
  if (!Number.isInteger(page) || page < 1) {
    throw new Error(`searchPoi 的 page 必须是 >= 1 的整数，收到：${String(page)}`);
  }

  const json = await requestAmap("place/text", "/v3/place/text", {
    keywords: keyword,
    city,
    citylimit: "true",
    offset: String(POI_PAGE_SIZE),
    page: String(page),
    extensions: "all",
  });

  // 陷阱：count 是字符串（"581"），分页判断必须先 Number()，否则字符串比较会出错。
  const totalCount = toNullableNumber(json.count);
  const rawPois = Array.isArray(json.pois) ? json.pois : [];
  if (totalCount !== null && (page - 1) * POI_PAGE_SIZE >= totalCount) {
    return [];
  }

  const places: Place[] = [];
  for (const rawPoi of rawPois) {
    const place = toPlace(rawPoi);
    if (place !== null) places.push(place);
  }

  // 契约校验：不通过直接抛错，不兜底修补。
  return z.array(PlaceSchema).parse(places);
}

/** 地址转坐标（geocode/geo）。查不到返回 null。 */
export async function geocode(address: string, city: string): Promise<{ lng: number; lat: number } | null> {
  const json = await requestAmap("geocode/geo", "/v3/geocode/geo", { address, city });
  const geocodes = Array.isArray(json.geocodes) ? json.geocodes : [];
  for (const item of geocodes) {
    const geo = asRecord(item);
    if (geo === null) continue;
    const center = parseLngLat(geo.location);
    if (center !== null) return center;
  }
  return null;
}

/** 坐标转地址（geocode/regeo）。查不到返回 null。 */
export async function regeo(lng: number, lat: number): Promise<string | null> {
  const json = await requestAmap("geocode/regeo", "/v3/geocode/regeo", {
    location: `${lng},${lat}`,
  });
  const regeocode = asRecord(json.regeocode);
  if (regeocode === null) return null;
  return z.string().nullable().parse(toNonEmptyString(regeocode.formatted_address));
}

/* ------------------------------------------------------------------ *
 * M2：两点之间（只算时长/距离，不做选点、不做排程）
 *
 * 字段形状全部来自 2026-10-22 的实测（同一对坐标各打 1 次，原始返回已进 .cache/）：
 *   - walking  v3：route.paths[0].duration="3349"（秒）/ distance="4186"（米），都是字符串；
 *   - driving  v3：route.paths[0].duration="626"  / distance="4659"，都是字符串；
 *   - transit  v3：route.transits[] 里是多条方案，取 duration（秒）最小的一条；
 *                  方案距离取同一条的 transits[i].distance，而 route.distance 是另一个数，不混用；
 *                  公交接口必须带城市码 city / cityd（杭州 0571，取自 .cache 原始返回的 citycode）。
 *   - bicycling v5：route.paths[0].duration="1629" / distance="4534"，信封与 v3 一致；
 *                  v4 也能用，但信封是 errcode/errmsg 且数值是原生 number；同一路线 v4 报 1088 秒、
 *                  v5 报 1629 秒。这里选 v5：和 M1 共用 status/infocode 信封与同一套缓存逻辑。
 *   - 所有数值字段一律先 Number() 再算；duration 单位是秒，必须 /60 后取整。
 *
 * 失败（网络错误 / status≠1 / 没有 paths / 没有 transits）一律返回 null，由上层降级；不抛错，
 * 但真正返回出去的数值仍旧过 zod（不合法会抛错，不做兜底修补）。
 * ------------------------------------------------------------------ */

export type RouteMode = "walk" | "bus" | "drive" | "bike";

/**
 * 两点之间一种出行方式的结果：整数分钟 + 整数米（+ 可选路名）。
 *
 * road 是本轮新增字段：这一段「起步那条路」的名字，给前端站点副行 / 文字导航标题用。
 * 没有可读路名时**不出现这个字段**（不是空串，也不是 "[]"）。
 */
export type RouteSummary = {
  durationMin: number;
  distanceM: number;
  road?: string;
};

const RouteSummarySchema = z.object({
  durationMin: z.number().int().min(0),
  distanceM: z.number().int().min(0),
  road: z.string().min(1).optional(),
});

/** 三种出行方式的整体返回；单项算不出来是 null。 */
const AllRoutesSchema = z.record(
  z.enum(["walk", "bus", "drive"]),
  RouteSummarySchema.nullable(),
);

/**
 * 高德城市码：公交接口（direction/transit/integrated）必填 city / cityd，
 * 且必须与起点/终点所在城市一致。城市码不写死在这里：由 city 配置
 * （data/cities/<city>.json 的 cityCode）经 planner → getRoute 传进来。
 * 常见值：杭州 0571、辽阳 0419（高德 place/text 原始返回的 citycode 口径）。
 */

type RouteEndpoint = {
  /** 缓存 / 报错里用的函数名，与 M1 的 "place/text" 同一套命名。 */
  fn: string;
  path: string;
};

const ROUTE_ENDPOINTS: Record<RouteMode, RouteEndpoint> = {
  walk: { fn: "direction/walking", path: "/v3/direction/walking" },
  drive: { fn: "direction/driving", path: "/v3/direction/driving" },
  bus: { fn: "direction/transit/integrated", path: "/v3/direction/transit/integrated" },
  bike: { fn: "direction/bicycling", path: "/v5/direction/bicycling" },
};

function formatLngLat(point: { lng: number; lat: number }): string {
  return `${point.lng},${point.lat}`;
}

/** 秒 + 米 → 整数分钟 + 整数米；字段缺失（没有可用方案）返回 null。road 没有就不带这个字段。 */
function buildRouteSummary(
  durationSeconds: unknown,
  distanceMeters: unknown,
  road?: string,
): RouteSummary | null {
  const seconds = toNullableNumber(durationSeconds);
  const meters = toNullableNumber(distanceMeters);
  if (seconds === null || meters === null) return null;
  // duration 是秒，必须 /60 再取整（实测 walking 3km 级 = 3349 秒 → 56 分钟）。
  const base = { durationMin: Math.round(seconds / 60), distanceM: Math.round(meters) };
  return RouteSummarySchema.parse(road === undefined ? base : { ...base, road });
}

/**
 * 这一段「起步那条路」的路名（本轮新增）。三个坑都在真实缓存数据上实测过：
 *
 * 1. 高德没有路名时 `road` 给的是**空数组 []**（和 biz_ext.cost 一个毛病）。
 *    直接 `String([])` 会得到空串 `""`、`String(["x"])` 会得到 "x"——两种都不安全。
 *    这里一律走 `toNonEmptyString`：只认「非空白字符串」，[] / "" / null / 数字都算没有。
 *    （types/schema.ts 的 Segment.road 是 min(1) 的可选字段，空串会被 zod 直接拒绝。）
 * 2. **只看 steps[0].road 是不够的**：实测 68% 的路线第一条 step 的 road 就是 []（第一步通常是
 *    「向东南步行 1452 米」这种没有路名的引路段），真正的路名在后面的 step 里。
 *    所以按顺序取「第一条有名字的 step」，而不是死盯 steps[0]。
 * 3. **v5 骑行接口的字段名不是 road，而是 road_name**（真实返回字段：instruction / orientation /
 *    road_name / step_distance / polyline）。同时兼容两个字段名，步行/骑行都能拿到路名。
 *
 * 公交走的是 summaryFromTransits（transits 没有 step），所以公交段天然没有路名。
 */
function firstRoadOfPath(firstPath: Record<string, unknown>): string | undefined {
  const steps = Array.isArray(firstPath.steps) ? firstPath.steps : [];
  for (const item of steps) {
    const step = asRecord(item);
    if (step === null) continue;
    const road = toNonEmptyString(step.road) ?? toNonEmptyString(step.road_name);
    if (road !== null) return road;
  }
  return undefined;
}

/** v3 步行/驾车、v5 骑行：数据在 route.paths[0]。 */
function summaryFromPaths(json: Record<string, unknown>): RouteSummary | null {
  const route = asRecord(json.route);
  if (route === null) return null;
  const paths = Array.isArray(route.paths) ? route.paths : [];
  const firstPath = asRecord(paths[0]);
  if (firstPath === null) return null;
  return buildRouteSummary(firstPath.duration, firstPath.distance, firstRoadOfPath(firstPath));
}

/**
 * v3 公交：接口会返回多条方案，按 transits[i].duration（秒）取最快的一条（不取第一条）；
 * 方案距离用同一条方案的 transits[i].distance，不用 route.distance（那是另一个数）。
 */
function summaryFromTransits(json: Record<string, unknown>): RouteSummary | null {
  const route = asRecord(json.route);
  if (route === null) return null;
  const transits = Array.isArray(route.transits) ? route.transits : [];
  let fastestSeconds = Number.POSITIVE_INFINITY;
  let fastest: RouteSummary | null = null;
  for (const item of transits) {
    const transit = asRecord(item);
    if (transit === null) continue;
    const seconds = toNullableNumber(transit.duration);
    if (seconds === null || seconds >= fastestSeconds) continue;
    const summary = buildRouteSummary(transit.duration, transit.distance);
    if (summary === null) continue;
    fastestSeconds = seconds;
    fastest = summary;
  }
  return fastest;
}

/**
 * 两点之间一种出行方式的时长、距离，以及这一段「起步那条路」的路名（拿不到就没有 road 字段）。
 * 失败返回 null（上层做降级），不抛错；走 lib/cache.ts 缓存，同一请求不会重复打接口。
 *
 * cityCode 只在公交（mode="bus"）时使用：高德公交接口必须带城市码，
 * 由调用方从城市配置（data/cities/<city>.json 的 cityCode）传入。
 * 没给城市码时公交一律算不出来（返回 null），不会用错误城市的线路冒充。
 */
export async function getRoute(
  from: { lng: number; lat: number },
  to: { lng: number; lat: number },
  mode: RouteMode,
  options?: { cityCode?: string },
): Promise<RouteSummary | null> {
  const endpoint = ROUTE_ENDPOINTS[mode];
  const params: AmapParams = {
    origin: formatLngLat(from),
    destination: formatLngLat(to),
  };
  if (mode === "bus") {
    const cityCode = options === undefined ? undefined : options.cityCode;
    // 公交没有城市码就无法确定「哪座城市的公交」；直接返回 null，由上层降级到其它交通方式。
    if (cityCode === undefined || cityCode === "") return null;
    params.city = cityCode;
    params.cityd = cityCode;
  }

  let json: Record<string, unknown>;
  try {
    json = await requestAmap(endpoint.fn, endpoint.path, params);
  } catch {
    // 网络抖动、配额、status≠1（比如两地之间没有公交方案）都按「算不出来」处理。
    return null;
  }

  return mode === "bus" ? summaryFromTransits(json) : summaryFromPaths(json);
}

/** 一次返回步行/公交/驾车三种，方便对比；单项失败为 null，不影响其它项。 */
export async function getAllRoutes(
  from: { lng: number; lat: number },
  to: { lng: number; lat: number },
  options?: { cityCode?: string },
): Promise<Record<"walk" | "bus" | "drive", RouteSummary | null>> {
  const [walk, bus, drive] = await Promise.all([
    getRoute(from, to, "walk", options),
    getRoute(from, to, "bus", options),
    getRoute(from, to, "drive", options),
  ]);
  // 整体再过一次 zod（单项已在 getRoute 里校验过；null 表示该项算不出来）。
  return AllRoutesSchema.parse({ walk, bus, drive });
}

/* ------------------------------------------------------------------ *
 * M1 数据扩展（3.3.5）：带行政区 / 原始 typecode 的 POI 查询
 *
 * 只给离线脚本 scripts/fetch-seed.ts 用（npm run fetch:seed），不接运行时请求链路。
 *
 * 为什么另起一个 queryPoi，而不是扩展 searchPoi：
 *   1. 3.3.5 要求按 12 类采集、按「上城/拱墅/西湖/滨江/萧山」分布。Place 里没有行政区，
 *      只能从 place/text 原始返回的 adname 拿；扩展 searchPoi 会改已有函数行为，
 *      本轮只允许「新增」，所以新开一个函数。
 *   2. 需要按 typecode 精确筛（types 参数）和按圆心 + 半径搜（place/around），
 *      searchPoi 只封装了 keywords 版 place/text。
 *
 * 这里不重复任何字段映射：仍然复用 toPlace 的 parseOpenTime / parseClosedDays / category 推导。
 * ------------------------------------------------------------------ */

/** 带行政区 / typecode / 类型的 POI 查询结果。 */
export type PoiDetail = {
  place: Place;
  /** 高德 adname（行政区名，如「萧山区」）；高德没给为 null。 */
  district: string | null;
  /** 高德原始 typecode，复合码原样保留（如 "061205|110200"）。 */
  typecode: string | null;
  /** 高德 type 文本（如 "风景名胜;公园广场;公园"）。 */
  typeText: string | null;
  /** 高德 address（用于 3.3.6 给 LLM 做分类输入）；没给为 null。 */
  address: string | null;
};

const PoiDetailSchema = z.object({
  place: PlaceSchema,
  district: z.string().nullable(),
  typecode: z.string().nullable(),
  typeText: z.string().nullable(),
  address: z.string().nullable(),
});

export type PoiQuery = {
  city: string;
  /** 页码，从 1 开始。 */
  page: number;
  keywords?: string;
  /** 高德 typecode（如 "110101"），多个用 "|" 分隔。 */
  types?: string;
  /** 每页条数，实测 place/text 与 place/around 都支持 25。默认 25。 */
  offset?: number;
  /** 传了就调 place/around（圆心 + 半径），不传走 place/text（全城检索）。 */
  around?: { lng: number; lat: number; radiusM: number };
};

/** place/text 实测 offset 最大 25；超过会被高德忽略并只回 20 条左右，这里直接挡住。 */
const POI_QUERY_DEFAULT_OFFSET = 25;
const POI_QUERY_MAX_OFFSET = 25;
/** place/around 的 radius 上限（米）。 */
const AROUND_MAX_RADIUS_M = 50000;

/** place/text / place/around 原始 POI → PoiDetail；没有 id / 名称 / 坐标的丢弃。 */
function toPoiDetail(rawPoi: unknown): PoiDetail | null {
  const place = toPlace(rawPoi);
  if (place === null) return null;
  const poi = asRecord(rawPoi);
  return {
    place,
    district: poi === null ? null : toNonEmptyString(poi.adname),
    typecode: poi === null ? null : toNonEmptyString(poi.typecode),
    typeText: poi === null ? null : toNonEmptyString(poi.type),
    address: poi === null ? null : toNonEmptyString(poi.address),
  };
}

/**
 * 带行政区信息的 POI 查询（离线取数专用）。
 *
 * - 不传 around：place/text，city + citylimit=true，全城按关键词/类型检索；
 * - 传 around：place/around，按圆心 + 半径检索。
 *
 * 返回值过 zod 校验，不通过直接抛错（铁律 4）。没有结果返回 []。
 */
export async function queryPoi(query: PoiQuery): Promise<PoiDetail[]> {
  if (!Number.isInteger(query.page) || query.page < 1) {
    throw new Error(`queryPoi 的 page 必须是 >= 1 的整数，收到：${String(query.page)}`);
  }
  const offset = query.offset === undefined ? POI_QUERY_DEFAULT_OFFSET : query.offset;
  if (!Number.isInteger(offset) || offset < 1 || offset > POI_QUERY_MAX_OFFSET) {
    throw new Error(`queryPoi 的 offset 必须在 1–${POI_QUERY_MAX_OFFSET} 之间，收到：${String(offset)}`);
  }

  const keywords = toNonEmptyString(query.keywords);
  const types = toNonEmptyString(query.types);
  if (keywords === null && types === null) {
    throw new Error("queryPoi 至少要给 keywords 或 types 之一");
  }

  const params: AmapParams = {
    city: query.city,
    offset: String(offset),
    page: String(query.page),
    extensions: "all",
  };
  if (keywords !== null) params.keywords = keywords;
  if (types !== null) params.types = types;

  let fn: string;
  let path: string;
  if (query.around !== undefined) {
    const { lng, lat, radiusM } = query.around;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      throw new Error(`queryPoi 的 around 坐标不合法：${String(lng)},${String(lat)}`);
    }
    if (!Number.isInteger(radiusM) || radiusM < 1 || radiusM > AROUND_MAX_RADIUS_M) {
      throw new Error(`queryPoi 的 around.radiusM 必须在 1–${AROUND_MAX_RADIUS_M} 之间，收到：${String(radiusM)}`);
    }
    params.location = `${lng},${lat}`;
    params.radius = String(radiusM);
    fn = "place/around";
    path = "/v3/place/around";
  } else {
    params.citylimit = "true";
    fn = "place/text";
    path = "/v3/place/text";
  }

  const json = await requestAmap(fn, path, params);

  // 与 searchPoi 相同的分页判断：count 是字符串，先 Number()。
  const totalCount = toNullableNumber(json.count);
  const rawPois = Array.isArray(json.pois) ? json.pois : [];
  if (totalCount !== null && (query.page - 1) * offset >= totalCount) {
    return [];
  }

  const details: PoiDetail[] = [];
  for (const rawPoi of rawPois) {
    const detail = toPoiDetail(rawPoi);
    if (detail === null) continue;
    // 契约校验：不通过直接抛错。这里逐条 safeParse 再把原对象入列，
    // 不用 parse() 的返回类型（zod v4 对 nullable 字段的 output 推断会把字段标成 optional，
    // 与 PoiDetail 的显式类型对不上；校验本身仍是完整的）。
    const checked = PoiDetailSchema.safeParse(detail);
    if (!checked.success) throw checked.error;
    details.push(detail);
  }

  return details;
}
