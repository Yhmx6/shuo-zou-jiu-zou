import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { PlaceSchema } from "../types/schema";
import type { Place } from "../types/schema";
import { createMemoryLru } from "./cache";

/**
 * 城市数据加载器（只在服务端 / 离线脚本里用，依赖 node:fs）。
 *
 * 为什么要有这一层：地点数据按城市拆到 data/cities/<city>.json，每个文件自包含
 * （城市 id / 展示名 / 区列表 / 演示起点 / 阈值 / places），页面和 API 都只认这一份数据。
 * 读文件路径基于 process.cwd()：Next.js 从项目根启动，离线脚本也从项目根跑。
 *
 * 三条硬约束（00-common 铁律）：
 * 1. 地点只能来自 data/cities 下的真实数据，本文件不生成、不补全任何地点；
 * 2. 所有读盘结果必须过 zod，校验失败直接抛错，不返回半成品；
 * 3. 不确定就抛错：路径穿越、未知城市、文件名与 city 字段不一致都直接失败，不猜默认值。
 *
 * 缓存：文件解析结果放进程内 LRU（clearCityCache 可清空），跨请求复用同一份只读数据。
 * 调用方不要修改返回值；planner 会把 pool 再 zod 解析成自己的对象，不会反向污染缓存。
 */

/** 城市 id 只允许小写字母、数字和连字符；正则同时挡住 "../"、"/" 这类路径穿越。 */
const CITY_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** 与 /api/plan、/api/swap 请求体里的 city 上限保持一致（防呆）。 */
const MAX_CITY_ID_LENGTH = 64;

/** 日期格式 "YYYY-MM-DD"（与 PlaceSchema.lastVerified 同一口径）。 */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 城市文件目录：每个城市一个自包含 JSON，文件名就是城市 id。 */
function cityDataDir(): string {
  return join(process.cwd(), "data", "cities");
}

function isValidCityId(cityId: string): boolean {
  return CITY_ID_PATTERN.test(cityId) && cityId.length <= MAX_CITY_ID_LENGTH;
}

/** 把 zod 报错拼成一句人话（字段名 + 原因），不把整个 ZodError 丢给调用方。 */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length === 0 ? "根" : issue.path.join(".")} ${issue.message}`)
    .join("；");
}

/** 读 UTF-8 JSON；读不到 / 不是合法 JSON 直接抛错（不返回 null，不静默兜底）。 */
export function readJsonFile(filePath: string, label: string): unknown {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}读取失败：${filePath}（${reason}）`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label}不是合法 JSON：${filePath}`);
  }
}

/* ------------------------------------------------------------------ *
 * 数据契约（zod）
 * ------------------------------------------------------------------ */

/** 城市演示起点：调用方没带坐标时，/api/plan、/api/swap 用它的经纬度。 */
export const CityOriginSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
export type CityOrigin = z.infer<typeof CityOriginSchema>;

/**
 * 城市数据分级：决定 fetch:seed 的采集门槛（见 lib/cityTier.ts）。
 * - tier1：一线城市，12 类采集、每类 ≥3、3km 内 ≥10 个免费点、总数 ≥120；
 * - tier4：四线小城，只要求核心 6 类（park/bookstore/restaurant/market/museum/theater），
 *   每类 ≥2、3km 内 ≥5 个免费点、总数 ≥90。
 */
export const CityTierSchema = z.enum(["tier1", "tier4"]);
export type CityTier = z.infer<typeof CityTierSchema>;

/**
 * 城市阈值：数据分级 tier + 默认预算（元）/ 单次行程最长时长（分钟）/ 当地日落时刻（当日分钟数）
 * + 当天硬性结束上限（lastEndMinute，默认 1410 = 23:30）。
 */
export const CityThresholdsSchema = z.object({
  tier: CityTierSchema,
  defaultBudget: z.number().min(0),
  maxTotalMin: z.number().int().min(1),
  sunsetMinute: z.number().int().min(0).max(1439),
  /**
   * 当天硬性结束上限（当日分钟数）：默认 1410 = 23:30，城市文件可用同名字段覆盖。
   *
   * 晚间出发时 planner 不再把站点排到 24:00 之后：候选「到达 + 停留 + 返程」超过它就丢弃，
   * 所有候选都不行就停止加站；一站都排不出来返回人话原因。跨午夜是正常业务场景，不是程序错误。
   */
  lastEndMinute: z.number().int().min(0).max(1439).default(1410),
});
export type CityThresholds = z.infer<typeof CityThresholdsSchema>;

/**
 * 城市配置（不含 places）：data/cities/<city>.json 的元信息部分。
 *
 * 为什么单独拆一个「配置」schema：
 * - 新城市要先有配置（id / 名称 / 城市码 / 行政区 / 圆心 / 阈值）才能跑 fetch:seed 采数据，
 *   那一刻文件里还没有 places；
 * - 运行时 /api/cities（下拉）只需要配置，不需要把 200 条 places 读出来。
 */
export const CityConfigSchema = z.object({
  city: z
    .string()
    .max(MAX_CITY_ID_LENGTH)
    .regex(CITY_ID_PATTERN, "城市 id 只能是小写字母、数字和连字符"),
  displayName: z.string().min(1),
  /** 高德城市码（公交算路参数 city / cityd）：杭州 0571、辽阳 0419。 */
  cityCode: z.string().regex(/^\d{4,6}$/, "cityCode 必须是 4–6 位数字（高德城市码）"),
  /** 高德公交算路的城市名（AMap.Transfer 的 city）：杭州「杭州市」、辽阳「辽阳市」。 */
  transferCityName: z.string().min(1),
  districts: z.array(z.string().min(1)),
  /**
   * 给用户看的「现在能规划的区域」清单（本轮新增可选字段，手写在城市 json 里）。
   *
   * 为什么手写、不自动推导：这是**给用户看的语义范围**（「良乡 · 长阳」「顺义城区」），
   * 不是技术参数。跨城判定用的 geoRadiusM 是另一个东西（点位最大距离 ×1.25），两者混用会误导用户。
   * 可选是为了兼容还没配 coverage 的城市：没有这个字段 = 问答和失败文案都不显示这一行。
   */
  coverage: z.array(z.string().min(1)).optional(),
  /**
   * 城市地标关键词（本轮新增可选字段，任务3 星级数据用）：地点名称包含其中任意一个
   * → 该城市公认地标（scripts/rate-places.ts 的 5 星规则候选，同时作为 LLM 校正的提示）。
   *
   * 只做「离线打星规则 / 提示」，不参与 planner 打分（排程铁律不变）。
   * 关键词由人工按真实数据维护：必须避免「西湖」这种会把「西湖店」餐馆也算成地标的过度匹配，
   * 因此配置的是更具体的地标名（如「清河坊」「京杭大运河」）。
   * 可选是为了兼容旧城市配置：没有这个字段 = 该城市不启用关键词规则。
   */
  landmarkKeywords: z.array(z.string().min(1)).optional(),
  origin: CityOriginSchema,
  thresholds: CityThresholdsSchema,
  updatedAt: z.string().regex(DATE_PATTERN, "updatedAt 必须是 YYYY-MM-DD"),
});
export type CityConfig = z.infer<typeof CityConfigSchema>;

/** 一个城市自包含的数据文件（data/cities/<city>.json）：配置 + 真实地点。 */
export const CityDataSchema = CityConfigSchema.extend({
  /** 地点只来自这里；空数组说明数据还没采，按校验失败处理（运行时不允许空城市）。 */
  places: z.array(PlaceSchema).min(1),
});
export type CityData = z.infer<typeof CityDataSchema>;

/* ------------------------------------------------------------------ *
 * 手工维护层（data/cities/<city>.manual.json）
 * ------------------------------------------------------------------ */

/**
 * 手工维护层的**一条**：默认是「主文件某条地点的部分字段覆盖」。
 *
 * 为什么允许部分字段（本轮改造）：批量打星（scripts/rate-places.ts）只改 importance，
 * 旧实现把主文件整条 Place 复制进 manual 层，导致手工层 116/141 条全是重复副本、
 * 后台「来源」列全显示「手工」。现在只写「和主文件不一样的字段」，最常见就是
 * `{ id, importance }`；合并时按字段覆盖（见 mergePlaces）。
 *
 * 但**手工新增点**（主文件里没有这个 id）仍然必须是完整 Place：这条完整性校验在
 * loadCity 合并和 saveManualPlaces 写盘两处都会做，不允许把残缺地点藏进 manual 层。
 */
export const ManualPlaceEntrySchema = PlaceSchema.partial().extend({
  id: z.string().min(1),
});
export type ManualPlaceEntry = z.infer<typeof ManualPlaceEntrySchema>;

/**
 * 手工维护层文件（data/cities/<city>.manual.json）：只含 places。
 *
 * 合并规则（见 loadCity）：按 id 匹配主文件——同 id 做字段级覆盖；主文件没有的 id
 * 必须是完整 Place 并直接追加。空文件是合法状态：{ "places": [] }。
 */
export const ManualCityDataSchema = z.object({
  places: z.array(ManualPlaceEntrySchema),
});
export type ManualCityData = z.infer<typeof ManualCityDataSchema>;

/** 城市索引里的一条：只放列表需要的元信息，起点 / 阈值在各自的城市文件里。 */
export const CityIndexEntrySchema = z.object({
  city: z
    .string()
    .max(MAX_CITY_ID_LENGTH)
    .regex(CITY_ID_PATTERN, "城市 id 只能是小写字母、数字和连字符"),
  displayName: z.string().min(1),
});
export type CityIndexEntry = z.infer<typeof CityIndexEntrySchema>;

/** data/cities/index.json：城市清单。至少要有一个城市，否则没有默认城市。 */
export const CityIndexSchema = z.object({
  cities: z.array(CityIndexEntrySchema).min(1),
  updatedAt: z.string().regex(DATE_PATTERN, "updatedAt 必须是 YYYY-MM-DD"),
});
export type CityIndex = z.infer<typeof CityIndexSchema>;

/* ------------------------------------------------------------------ *
 * 进程内缓存
 * ------------------------------------------------------------------ */

/** 城市数据缓存上限：一个部署里的城市数量远小于这个值，超过按 LRU 淘汰最旧。 */
const CITY_CACHE_LIMIT = 16;

let indexCache: CityIndex | null = null;
const cityCache = createMemoryLru<string, CityData>(CITY_CACHE_LIMIT);
const cityConfigCache = createMemoryLru<string, CityConfig>(CITY_CACHE_LIMIT);

/** 本机当地 "YYYY-MM-DD"（不用 UTC，避免跨日错位）。 */
function todayIsoDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 清空城市索引、城市数据、城市配置的进程内缓存。
 * 改了 data/cities 下的文件后（fetch:seed 写盘后会自动调它），需要重新读盘时调用。
 */
export function clearCityCache(): void {
  indexCache = null;
  cityCache.clear();
  cityConfigCache.clear();
}

/* ------------------------------------------------------------------ *
 * 读取接口
 * ------------------------------------------------------------------ */

/** 读 data/cities/index.json 并过 zod；结果缓存在进程内。 */
function loadCityIndex(): CityIndex {
  if (indexCache !== null) return indexCache;
  const filePath = join(cityDataDir(), "index.json");
  const raw = readJsonFile(filePath, "城市索引");
  const parsed = CityIndexSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`城市索引校验失败：${filePath}：${describeIssues(parsed.error)}`);
  }
  indexCache = parsed.data;
  return indexCache;
}

/** 城市清单（只含 id / 展示名）；返回副本数组，调用方改它不会污染缓存。 */
export function listCities(): CityIndexEntry[] {
  return loadCityIndex().cities.slice();
}

/**
 * 当前默认城市：
 * - 显式配置了 process.env.ACTIVE_CITY 就用它（必须命中城市索引，否则抛错，不猜）；
 * - 没配置（或为空）就用城市索引里的第一个城市。
 */
export function activeCityId(): string {
  const fromEnv = process.env.ACTIVE_CITY === undefined ? "" : process.env.ACTIVE_CITY.trim();
  const cities = listCities();
  if (fromEnv === "") return cities[0].city;
  if (!isValidCityId(fromEnv)) {
    throw new Error(
      `默认城市配置不合法：ACTIVE_CITY=${JSON.stringify(process.env.ACTIVE_CITY)}（城市 id 只能是小写字母、数字和连字符）`,
    );
  }
  if (!cities.some((entry) => entry.city === fromEnv)) {
    throw new Error(
      `默认城市配置不合法：ACTIVE_CITY=${fromEnv} 不在城市索引里（可用：${cities.map((entry) => entry.city).join("、")}）`,
    );
  }
  return fromEnv;
}

/**
 * 把「请求里的城市参数」解析成确定的城市 id：
 * - 显式传了 requested：必须是合法 id 且在城市索引里，否则抛错（API 层据此回 400，不静默换成默认城市）；
 * - 没传 / 空串：走 activeCityId()（ACTIVE_CITY ?? 第一个城市）。
 */
export function resolveCityId(requested?: string): string {
  const candidate = requested === undefined ? "" : requested.trim();
  if (candidate === "") return activeCityId();
  if (!isValidCityId(candidate)) {
    throw new Error(`城市 id 不合法：${JSON.stringify(requested)}（只能是小写字母、数字和连字符）`);
  }
  const cities = listCities();
  if (!cities.some((entry) => entry.city === candidate)) {
    throw new Error(`未知城市：${candidate}（可用：${cities.map((entry) => entry.city).join("、")}）`);
  }
  return candidate;
}

/**
 * 读一个城市的自包含数据（data/cities/<id>.json），**不含** manual 合并，结果不缓存。
 *
 * 三道校验缺一不可，任何一道失败都直接抛错（不降级、不返回 null）：
 * 1. 城市 id 正则：挡路径穿越（../、/、点号）和超长 id；
 * 2. 整份文件过 CityDataSchema（含里面每一条 PlaceSchema）；
 * 3. 文件内容里的 city 必须等于请求的 id，避免改名 / 拷贝后串城市。
 *
 * 用途：loadCity 的合并基座；API / 脚本判断「这条是不是自动采集点」（整条数据 or 只要 id）。
 */
export function loadMainCityData(id: string): CityData {
  const requested = typeof id === "string" ? id.trim() : "";
  if (requested === "") throw new Error("城市 id 不能为空");
  if (!isValidCityId(requested)) {
    throw new Error(`城市 id 不合法：${JSON.stringify(id)}（只能是小写字母、数字和连字符，路径穿越会被拒绝）`);
  }

  const filePath = join(cityDataDir(), `${requested}.json`);
  if (!existsSync(filePath)) {
    throw new Error(`城市数据不存在：${requested}（期望文件：${filePath}）`);
  }
  const raw = readJsonFile(filePath, `城市数据 ${requested}`);
  const parsed = CityDataSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`城市数据校验失败：${filePath}：${describeIssues(parsed.error)}`);
  }
  const data = parsed.data;
  if (data.city !== requested) {
    throw new Error(
      `城市数据里的 city=${JSON.stringify(data.city)} 与请求的 id=${JSON.stringify(requested)} 不一致（文件：${filePath}）`,
    );
  }
  return data;
}

/** 主文件（不含 manual 合并）里的地点 id 集合：API 用它判断「这条是自动采集点还是手工新增点」。 */
export function loadMainPlaceIds(id: string): Set<string> {
  return new Set(loadMainCityData(id).places.map((place) => place.id));
}

/**
 * 读一个城市的自包含数据（data/cities/<id>.json）+ 手工维护层，并把结果缓存在进程内。
 *
 * 合并规则（本轮改）：manual 同 id 条目是**部分字段覆盖**（字段级合并，见 mergePlaces）；
 * 主文件没有的 id 必须是完整 Place、直接追加。planner 组候选池时再过滤 hidden===true
 * （见 lib/planner.ts），后台列表仍能看到隐藏点。
 */
export function loadCity(id: string): CityData {
  const requested = typeof id === "string" ? id.trim() : "";
  if (requested === "") throw new Error("城市 id 不能为空");
  if (!isValidCityId(requested)) {
    throw new Error(`城市 id 不合法：${JSON.stringify(id)}（只能是小写字母、数字和连字符，路径穿越会被拒绝）`);
  }

  const cached = cityCache.get(requested);
  if (cached !== undefined) return cached;

  const main = loadMainCityData(requested);
  const entries = loadManualPlaces(requested);
  const merged: CityData =
    entries.length === 0 ? main : { ...main, places: mergePlaces(main.places, entries, requested) };
  cityCache.set(requested, merged);
  return merged;
}

/** data/cities/<id>.json 的绝对路径；城市 id 先过正则（挡路径穿越）。 */
export function cityDataFilePath(id: string): string {
  const requested = typeof id === "string" ? id.trim() : "";
  if (requested === "") throw new Error("城市 id 不能为空");
  if (!isValidCityId(requested)) {
    throw new Error(`城市 id 不合法：${JSON.stringify(id)}（只能是小写字母、数字和连字符，路径穿越会被拒绝）`);
  }
  return join(cityDataDir(), `${requested}.json`);
}

/**
 * 只读城市配置（不含 places）：给「城市下拉」和 fetch:seed 用。
 *
 * 与 loadCity 的区别：不要求 places 非空。新城市在采数据之前就是一个只有配置的文件，
 * 下拉能正常列出它（只是 /api/plan 会报「城市还没有地点数据」）。
 */
export function loadCityConfig(id: string): CityConfig {
  const requested = typeof id === "string" ? id.trim() : "";
  if (requested === "") throw new Error("城市 id 不能为空");
  if (!isValidCityId(requested)) {
    throw new Error(`城市 id 不合法：${JSON.stringify(id)}（只能是小写字母、数字和连字符，路径穿越会被拒绝）`);
  }

  const cached = cityConfigCache.get(requested);
  if (cached !== undefined) return cached;

  const filePath = cityDataFilePath(requested);
  if (!existsSync(filePath)) {
    throw new Error(`城市配置不存在：${requested}（期望文件：${filePath}）`);
  }
  const raw = readJsonFile(filePath, `城市配置 ${requested}`);
  const parsed = CityConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`城市配置校验失败：${filePath}：${describeIssues(parsed.error)}`);
  }
  const config = parsed.data;
  if (config.city !== requested) {
    throw new Error(
      `城市配置里的 city=${JSON.stringify(config.city)} 与请求的 id=${JSON.stringify(requested)} 不一致（文件：${filePath}）`,
    );
  }
  cityConfigCache.set(requested, config);
  return config;
}

/* ------------------------------------------------------------------ *
 * 手工维护层读写
 * ------------------------------------------------------------------ */

/** 城市 id 的公共校验（manual 文件路径 / 读写都用它，挡路径穿越）。 */
function requireCityId(id: string): string {
  const requested = typeof id === "string" ? id.trim() : "";
  if (requested === "") throw new Error("城市 id 不能为空");
  if (!isValidCityId(requested)) {
    throw new Error(`城市 id 不合法：${JSON.stringify(id)}（只能是小写字母、数字和连字符，路径穿越会被拒绝）`);
  }
  return requested;
}

/** 原子写 JSON：先写同目录临时文件，成功后再 rename 覆盖目标，避免写一半留下坏 JSON。 */
export function writeJsonFileAtomic(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  try {
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // 临时文件清理失败不掩盖 rename 的原始错误
    }
    throw error;
  }
}

/**
 * 主文件 places + 手工层条目合并（不修改入参）：
 * - 同 id：以手工条目做**字段级**覆盖（只覆盖条目里出现、且值不为 undefined 的字段），
 *   合并结果再过一遍 PlaceSchema——手工覆盖不能把整条写成非法数据；
 * - manual 独有：必须是完整 Place（缺字段直接抛错，不静默组装半成品），追加到末尾；
 * - 主文件独有：原样保留。
 */
function mergePlaces(mainPlaces: Place[], entries: ManualPlaceEntry[], cityId: string): Place[] {
  if (entries.length === 0) return mainPlaces.slice();
  const entryById = new Map<string, ManualPlaceEntry>();
  for (const entry of entries) entryById.set(entry.id, entry);
  const merged: Place[] = [];
  const usedEntryIds = new Set<string>();
  for (const place of mainPlaces) {
    const override = entryById.get(place.id);
    if (override === undefined) {
      merged.push(place);
    } else {
      merged.push(applyManualOverride(place, override, cityId));
      usedEntryIds.add(place.id);
    }
  }
  for (const entry of entries) {
    if (usedEntryIds.has(entry.id)) continue;
    const complete = PlaceSchema.safeParse(entry);
    if (!complete.success) {
      throw new Error(
        `手工新增地点必须是完整 Place：${JSON.stringify(entry.id)}（城市 ${cityId}）：${describeIssues(complete.error)}`,
      );
    }
    merged.push(complete.data);
  }
  return merged;
}

/**
 * 字段级覆盖：只认条目里出现、且值不是 undefined 的字段。
 *
 * 注意 null 是合法值（openTime / closeTime / rating / avgCost 都用 null 表示「未知」），
 * 所以这里只跳过 undefined，不能把 null 当「没提供」——那样后台永远没法把营业时间清空。
 */
function applyManualOverride(base: Place, override: ManualPlaceEntry, cityId: string): Place {
  const candidate: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (key === "id") continue;
    if (value === undefined) continue;
    candidate[key] = value;
  }
  const parsed = PlaceSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(
      `手工覆盖合并后不是合法地点：${JSON.stringify(override.id)}（城市 ${cityId}）：${describeIssues(parsed.error)}`,
    );
  }
  return parsed.data;
}

/** manual 文件里的 id 不允许重复：合并 / 修改都会变得不确定。 */
function assertUniqueManualIds(entries: ManualPlaceEntry[], filePath: string): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      throw new Error(`手工地点里 id 重复：${JSON.stringify(entry.id)}（文件：${filePath}）`);
    }
    seen.add(entry.id);
  }
}

/** data/cities/<id>.manual.json 的绝对路径；城市 id 先过正则（挡路径穿越）。 */
export function manualCityDataFilePath(id: string): string {
  return join(cityDataDir(), `${requireCityId(id)}.manual.json`);
}

/**
 * data/cities/<id>.events.json 的绝对路径（本轮新增：活动数据）。
 *
 * 活动单独一层，与主文件 / manual 层都分开：fetch:seed 永远不碰它，地点的增删改也不影响它。
 * 文件不存在 = 该城市还没有活动（合法状态，read 侧返回空数组）。
 */
export function cityEventsFilePath(id: string): string {
  return join(cityDataDir(), `${requireCityId(id)}.events.json`);
}

/**
 * 读手工维护层 data/cities/<id>.manual.json。
 *
 * - 文件不存在 = 合法（还没手工加过点 / 没覆盖过字段），返回空数组；
 * - 文件存在但 JSON 坏 / zod 不通过 / id 重复 → 直接抛错（不静默丢数据）；
 * - 返回条目（可能是部分字段覆盖，也可能是一条完整的手工新增点）。
 * 返回新数组，调用方改它不会污染任何缓存。
 */
export function loadManualPlaces(id: string): ManualPlaceEntry[] {
  const filePath = manualCityDataFilePath(id);
  if (!existsSync(filePath)) return [];
  const raw = readJsonFile(filePath, "手工地点");
  const parsed = ManualCityDataSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`手工地点校验失败：${filePath}：${describeIssues(parsed.error)}`);
  }
  assertUniqueManualIds(parsed.data.places, filePath);
  return parsed.data.places.slice();
}

/**
 * 手工新增点（主文件里没有的 id）必须是完整 Place。
 *
 * 为什么在写盘这一步拦：如果允许半成品进 manual 层，读取侧要到合并时才炸、或者
 * 更糟——悄悄把「缺 name 的点」当成数据里真实存在的点。宁可写盘失败也不写坏数据。
 */
function assertManualEntriesComplete(entries: ManualPlaceEntry[], cityId: string): void {
  const mainIds = loadMainPlaceIds(cityId);
  for (const entry of entries) {
    if (mainIds.has(entry.id)) continue;
    const complete = PlaceSchema.safeParse(entry);
    if (!complete.success) {
      throw new Error(
        `手工新增地点必须是完整 Place：${JSON.stringify(entry.id)}（城市 ${cityId}）：${describeIssues(complete.error)}`,
      );
    }
  }
}

/**
 * 写手工维护层（整份覆盖：管理后台每次都是「读全量 → 改 → 写回」）。
 * 写盘前过 ManualCityDataSchema + 完整性校验（主文件没有的 id 必须完整 Place）；
 * 临时文件 + rename 原子写；写完清进程内缓存。
 */
export function saveManualPlaces(id: string, entries: ManualPlaceEntry[]): ManualPlaceEntry[] {
  const requested = requireCityId(id);
  const filePath = manualCityDataFilePath(requested);
  const parsed = ManualCityDataSchema.safeParse({ places: entries });
  if (!parsed.success) {
    throw new Error(`手工地点校验失败（未写盘）：${describeIssues(parsed.error)}`);
  }
  assertUniqueManualIds(parsed.data.places, filePath);
  assertManualEntriesComplete(parsed.data.places, requested);
  writeJsonFileAtomic(filePath, { places: parsed.data.places });
  clearCityCache();
  return parsed.data.places.slice();
}

/**
 * 写一个城市的完整数据文件（配置 + places），供离线脚本 fetch:seed 落地使用。
 *
 * - 写盘前整份过 CityDataSchema（city 字段必须与文件名一致），不通过直接抛错；
 * - updatedAt 统一写成今天（本机时区）；
 * - 只写主文件，永远不碰同目录的 .manual.json（手工层由 saveManualPlaces 维护）；
 * - 写完清空进程内缓存，同一进程后续 loadCity 能读到新数据。
 */
export function saveCityData(config: CityConfig, places: Place[]): CityData {
  const parsedConfig = CityConfigSchema.parse(config);
  const data: CityData = CityDataSchema.parse({
    ...parsedConfig,
    updatedAt: todayIsoDate(),
    places,
  });
  const filePath = cityDataFilePath(data.city);
  writeJsonFileAtomic(filePath, data);
  clearCityCache();
  return data;
}
