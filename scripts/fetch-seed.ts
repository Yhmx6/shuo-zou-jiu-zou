/**
 * M1 离线数据准备脚本（3.3.5 数据品类扩展 + 3.3.6 风景标签）。
 *
 * 只在本地手动跑，城市由 data/cities/<city>.json 的配置驱动（见 lib/cityData.ts）：
 *   npm run fetch:seed -- liaoyang
 *   npx tsx --env-file=.env.local scripts/fetch-seed.ts liaoyang
 * 这是离线工具，绝不能被 app/ 或 lib/ 的运行时请求链路引用。
 *
 * 这一轮解决的问题：
 *   1. 旧数据只有「书店 / 美术馆 / 剧场 / 市集 / 公园 / 面馆」，任何非市中心起点都会显得荒凉。
 *      3.3.5 要求覆盖 12 类采集，并按配置里的行政区（config.districts）分布。
 *   2. 配置原点（config.origin）周边 3km 用「圆心 + 半径」的 place/around 专门扫一遍，
 *      补绿道、滨水公园、观景平台、大桥等免费去处。
 *   3. 3.3.6：给每条 Place 打风景标签。有 LLM_API_KEY / LLM_BASE_URL 时调 LLM（只分类不生成地点），
 *      没有时用「只依据名称 / 类型可推断信息」的规则兜底，不编造事实。
 *
 * 采集纪律：
 *   - 地点只来自高德 place/text 与 place/around（铁律 1），本脚本不写死任何地点名 / 坐标；
 *   - 行政区只认高德返回的 adname，只收 config.districts 里的区；
 *   - 营业时间 / closedDays / category 推导全部复用 lib/amap.ts 的 toPlace，不在脚本里重写；
 *   - 每次高德请求之间至少间隔 520ms（实测 >3 QPS 会返回 CUQPS_HAS_EXCEEDED_THE_LIMIT），
 *     失败重试 3 次后跳过；成功响应会进 .cache/，重跑不再打接口；
 *   - 落盘统一走 lib/cityData.ts 的 saveCityData（写盘前 zod 校验、updatedAt 自动今天、清缓存），
 *     本脚本不自己拼 data/cities/<city>.json，也不再写 data/seed-places.json。
 */
import { z } from "zod";
import { geocode, queryPoi } from "../lib/amap";
import type { PoiDetail, PoiQuery } from "../lib/amap";
import { cityDataFilePath, loadCityConfig, saveCityData } from "../lib/cityData";
import type { CityConfig, CityTier } from "../lib/cityData";
import {
  distanceMeters,
  evaluateTierRules,
  isFreePlace,
  ORIGIN_RADIUS_M,
} from "../lib/cityTier";
import type { TierCheck } from "../lib/cityTier";
import {
  BestTimeSchema,
  PlaceSchema,
  SceneryTagSchema,
  SceneryTypeSchema,
} from "../types/schema";
import type {
  BestTime,
  Place,
  PlaceCategory,
  SceneryTag,
  SceneryType,
} from "../types/schema";

/* ------------------------------------------------------------------ *
 * 基本配置：全部来自 data/cities/<city>.json（CityConfigSchema）
 * ------------------------------------------------------------------ */

/** CLI 用法。城市 id 就是 data/cities/<city>.json 的文件名。 */
const USAGE = "用法：npx tsx --env-file=.env.local scripts/fetch-seed.ts <city>（例如 liaoyang）";

/** 从 process.argv[2] 读城市 id；没有就报错并提示用法（不猜默认城市）。 */
function readCityId(): string {
  const fromArgv = process.argv[2] === undefined ? "" : process.argv[2].trim();
  if (fromArgv === "") {
    console.error(`缺少城市 id。\n${USAGE}`);
    process.exit(1);
  }
  return fromArgv;
}

const CITY_ID = readCityId();

/** 当前城市配置；读不到 / zod 校验失败直接退出（不猜默认值）。 */
const CONFIG: CityConfig = (() => {
  try {
    return loadCityConfig(CITY_ID);
  } catch (error) {
    console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
})();

/** 高德查询城市名（place/text / place/around 的 city 参数）= config.displayName。 */
const CITY = CONFIG.displayName;
/** 只收这些行政区（高德返回的 adname 必须精确命中）= config.districts。 */
const DISTRICTS: string[] = CONFIG.districts.slice();
/** 原点 3km 专项的圆心：直接来自配置，不再 geocode 一个地址；半径见 lib/cityTier.ORIGIN_RADIUS_M。 */
const ORIGIN = { lng: CONFIG.origin.longitude, lat: CONFIG.origin.latitude };
/** 数据分级（config.thresholds.tier）：决定落盘前的门槛，规则数值见 lib/cityTier.TIER_RULES。 */
const TIER: CityTier = CONFIG.thresholds.tier;

/** 最终输出路径：写盘统一走 saveCityData，这里只用于日志展示。 */
const OUTPUT_FILE = cityDataFilePath(CONFIG.city);

const PAGE_SIZE = 25;
/** 高德实测 QPS 很紧，请求之间至少隔 520ms。 */
const THROTTLE_MS = 520;

/** 12 个采集类目（3.3.5 的表）。一个类目可以包含多个内部 theme（如美术馆 / 博物馆）。 */
type ClassDef = {
  label: string;
  /** 内部 theme key（见 THEME_CAPS / 采集函数） */
  themes: string[];
};

const CLASS_DEFS: ClassDef[] = [
  { label: "江/河/湖岸、堤坝、滨水步道", themes: ["riverfront"] },
  { label: "公园、广场、绿地", themes: ["park"] },
  { label: "老街、历史街区、老建筑", themes: ["oldstreet"] },
  { label: "工业遗存、创意园、艺术区", themes: ["industrial"] },
  { label: "山、森林、水库、湿地", themes: ["mountain"] },
  { label: "桥、观景平台", themes: ["bridge"] },
  { label: "田野、茶园、果园", themes: ["field"] },
  { label: "书店", themes: ["bookstore"] },
  { label: "美术馆 / 博物馆", themes: ["gallery", "museum"] },
  { label: "剧场", themes: ["theater"] },
  { label: "市场（含菜场、花市、古玩）", themes: ["market"] },
  { label: "餐厅 / 咖啡", themes: ["restaurant", "cafe"] },
];

/**
 * 每个内部 theme 在每个行政区的软上限。
 * 小城（如 tier4）单区 POI 本来就少，上限放宽一点才够总数门槛；
 * 原点的 3km 专项扫盘另有 origin caps（见 collectOriginScenic）。
 */
const THEME_CAPS: Record<string, number> = {
  riverfront: 4,
  park: 8,
  oldstreet: 3,
  industrial: 3,
  mountain: 3,
  bridge: 3,
  field: 4,
  bookstore: 3,
  gallery: 3,
  museum: 3,
  theater: 3,
  market: 3,
  restaurant: 6,
  cafe: 3,
};

/** 报告 / 排序用的类目顺序。 */
const CATEGORY_ORDER: PlaceCategory[] = [
  "bookstore",
  "gallery",
  "museum",
  "theater",
  "market",
  "park",
  "cafe",
  "restaurant",
  "other",
];

/**
 * 明显不是「去处」的 POI 名称（停车场、便利店、房产中介之类）。3.3.5 的不达标判据。
 * 实测高德会把车库、驿站、花店、台球器材店、KTV 都挂在景点类目下，
 * 只靠 typecode 挡不住，必须再按名称挡一层。
 */
const JUNK_NAME_PATTERN =
  /(停车场|停车库|地下车库|车库|车位|公交站|地铁站|便利店|公共厕所|收费处|售票处|管理处|服务中心|员工宿舍|公寓|酒店|宾馆|民宿|银行|药店|五金|打印|复印|房产|中介|超市|物流|仓库|充电站|加油站|洗车|维修|装饰|建材|家居|售楼|公司|工厂|派出所|警务室|社区|小区|食堂|外卖|快递|水上客运|客运中心|花艺|花店|吐司|茶楼|茶坊|驿站|嘉年华|训练场|器材|台球|健身|理发|KTV|买手店|专卖店|批发部|百货|医院|门诊|幢|号楼|栋|(?:北|南|东|西)门|道路工程|配套道路|[0-9]+(?:号|[A-Za-z])?馆$|[A-Za-z]座$|(?:南|北|东|西)区$)/;

/* ------------------------------------------------------------------ *
 * 采集状态
 * ------------------------------------------------------------------ */

type CollectedPlace = {
  place: Place;
  district: string;
  typecode: string | null;
  typeText: string | null;
  address: string | null;
  /** 命中的内部 theme（可能多个，例如「沿江公园」同时命中 riverfront / park） */
  themes: Set<string>;
  /** 到配置原点（config.origin）的直线距离（米），用于 3km 统计 */
  distanceToOriginM: number;
};

const districtCenters = new Map<string, { lng: number; lat: number }>();
/** 原点（config.origin）：3km 专项扫盘与统计的圆心。 */
const originCenter: { lng: number; lat: number } = { lng: ORIGIN.lng, lat: ORIGIN.lat };

const collectedById = new Map<string, CollectedPlace>();
const collectedByName = new Map<string, CollectedPlace[]>();
const themeDistrictCount = new Map<string, Map<string, number>>();

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 是否是配置里的目标行政区（高德 adname 精确匹配）。 */
function isDistrict(value: string): boolean {
  return DISTRICTS.indexOf(value) !== -1;
}

/** 行政区短名（自动去掉「区 / 县 / 市」后缀，如 白塔区→白塔、太子河区→太子河），只用于日志。 */
function districtShort(district: string): string {
  const short = district.replace(/[区县市]$/, "");
  return short === "" ? district : short;
}

function primaryTypecode(typecode: string | null): string {
  if (typecode === null) return "";
  return typecode.split("|")[0].trim();
}

function getThemeDistrictCount(theme: string, district: string): number {
  const row = themeDistrictCount.get(theme);
  if (row === undefined) return 0;
  return row.get(district) ?? 0;
}

function bumpThemeDistrictCount(theme: string, district: string): void {
  let row = themeDistrictCount.get(theme);
  if (row === undefined) {
    row = new Map<string, number>();
    themeDistrictCount.set(theme, row);
  }
  row.set(district, (row.get(district) ?? 0) + 1);
}

function countThemeMembers(theme: string): number {
  let count = 0;
  Array.from(collectedById.values()).forEach((item) => {
    if (item.themes.has(theme)) count += 1;
  });
  return count;
}

function allDistrictsAtCap(theme: string, cap: number): boolean {
  for (const district of DISTRICTS) {
    if (getThemeDistrictCount(theme, district) < cap) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * 高德请求：节流 + 重试
 * ------------------------------------------------------------------ */

let lastRequestAt = 0;

async function throttleRequest(): Promise<void> {
  const waitMs = lastRequestAt + THROTTLE_MS - Date.now();
  if (waitMs > 0) await sleep(waitMs);
  lastRequestAt = Date.now();
}

async function safeQuery(query: PoiQuery): Promise<PoiDetail[]> {
  const label =
    query.around === undefined
      ? `text types=${query.types ?? "-"} keywords=${query.keywords ?? "-"} page=${query.page}`
      : `around keywords=${query.keywords ?? "-"} radius=${query.around.radiusM} page=${query.page}`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await throttleRequest();
    try {
      return await queryPoi(query);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === 3) {
        console.warn(`  ! 查询失败，跳过：${label}（${message}）`);
        return [];
      }
      await sleep(1200 * attempt);
    }
  }
  return [];
}

/* ------------------------------------------------------------------ *
 * 入池：只保留 5 个行政区、去重、按 theme 计配额
 * ------------------------------------------------------------------ */

/**
 * 把一条 POI 放进候选池。
 * 返回 true 表示这是一条新条目（用于按区配额计数）；false = 重复 / 不在目标区 / 被过滤。
 */
function addCandidate(
  theme: string,
  detail: PoiDetail,
  category: PlaceCategory,
  perDistrictCap: number | null,
): boolean {
  const district = detail.district;
  if (district === null || !isDistrict(district)) return false;
  if (JUNK_NAME_PATTERN.test(detail.place.name)) return false;

  const existing = collectedById.get(detail.place.id);
  if (existing !== undefined) {
    // 同一地点被多个类目命中：合并 theme，不再占配额。
    existing.themes.add(theme);
    return false;
  }
  if (perDistrictCap !== null && getThemeDistrictCount(theme, district) >= perDistrictCap) {
    return false;
  }

  // 同名近距离 POI 去重（高德常把同一个公园拆成两条 id）。
  const sameName = collectedByName.get(detail.place.name);
  if (sameName !== undefined) {
    for (const other of sameName) {
      if (distanceMeters(other.place, detail.place) < 500) return false;
    }
  }

  const place: Place = { ...detail.place, category };
  const collected: CollectedPlace = {
    place,
    district,
    typecode: detail.typecode,
    typeText: detail.typeText,
    address: detail.address,
    themes: new Set<string>([theme]),
    distanceToOriginM: distanceMeters(originCenter, place),
  };
  collectedById.set(place.id, collected);
  if (sameName === undefined) {
    collectedByName.set(place.name, [collected]);
  } else {
    sameName.push(collected);
  }
  bumpThemeDistrictCount(theme, district);
  return true;
}

/* ------------------------------------------------------------------ *
 * 各 theme 的准入规则（只认高德 typecode / 名称里可推断的信息）
 * ------------------------------------------------------------------ */

function acceptRiverfront(detail: PoiDetail): PlaceCategory | null {
  const typecode = primaryTypecode(detail.typecode);
  const name = detail.place.name;
  if (typecode.indexOf("110") === 0) return "park";
  // 高德偶发把整段沿江公园标成 190301（道路名）：只在名字明确是公园/绿道/观景时保留。
  if (
    typecode === "190301" &&
    /(公园|绿道|步道|观景|江堤|花海|跑道)/.test(name) &&
    !/(路|街|弄|巷|大道|高架)/.test(name)
  ) {
    return "park";
  }
  return null;
}

function acceptPark(detail: PoiDetail): PlaceCategory | null {
  const typecode = primaryTypecode(detail.typecode);
  if (typecode.indexOf("110") !== 0) return null;
  if (!/(公园|广场|绿地|花园|园|苑|湿地|景区|湖)/.test(detail.place.name)) return null;
  return "park";
}

function acceptOldStreet(detail: PoiDetail): PlaceCategory | null {
  const typecode = primaryTypecode(detail.typecode);
  const name = detail.place.name;
  if (/(停车场|公交站|地铁站|便利店|金店|饭店|餐厅|面馆|茶楼|咖啡)/.test(name)) return null;
  if (!/(老街|古街|街区|故居|古建|遗址|古镇|巷|弄|坊|宅|书院|里|街)/.test(name)) {
    return null;
  }
  if (typecode.indexOf("110") === 0) return "other";
  if (
    typecode === "061000" ||
    typecode === "080000" ||
    typecode === "120302" ||
    typecode === "120100"
  ) {
    return "other";
  }
  if (typecode.indexOf("1401") === 0 || typecode.indexOf("1402") === 0) return "other";
  return null;
}

function acceptIndustrial(detail: PoiDetail): PlaceCategory | null {
  const typecode = primaryTypecode(detail.typecode);
  const name = detail.place.name;
  if (!/(创意|艺术区|文创|工业|遗存|厂|仓|园区|街区|设计|公社)/.test(name)) return null;
  if (/(停车场|售楼|中介|公寓|酒店|公司|办公|食堂|咖啡|餐厅)/.test(name)) return null;
  if (
    typecode.indexOf("1201") === 0 ||
    typecode === "120302" ||
    typecode === "080000" ||
    typecode.indexOf("110") === 0 ||
    typecode === "061000"
  ) {
    return "other";
  }
  return null;
}

function acceptMountain(detail: PoiDetail): PlaceCategory | null {
  const typecode = primaryTypecode(detail.typecode);
  if (typecode.indexOf("110") !== 0) return null;
  const name = detail.place.name;
  if (!/(山|森林|湿地|水库|景区|公园|坞|岭|峰|湖|谷|溪)/.test(name)) return null;
  if (/(停车场|公交|地铁|餐厅|茶楼|酒店|公寓|售楼)/.test(name)) return null;
  return "park";
}

function acceptBridge(detail: PoiDetail): PlaceCategory | null {
  const typecode = primaryTypecode(detail.typecode);
  const name = detail.place.name;
  if (!/(大桥|观景)/.test(name)) return null;
  if (/(公交|地铁|停车场|换乘|租赁|收费|管理)/.test(name)) return null;
  if (typecode === "190307") return "other";
  if (typecode.indexOf("110") === 0) return "other";
  return null;
}

function acceptField(detail: PoiDetail): PlaceCategory | null {
  const typecode = primaryTypecode(detail.typecode);
  const name = detail.place.name;
  if (!/(茶园|茶村|农场|田园|果园|田野|梯田|茶场|农庄)/.test(name)) return null;
  if (/(茶楼|茶坊|茶艺|茶餐厅|茶叶|茶饮|特产|管理|警务|派出所|宿舍|市场|停车场|公交|餐厅|饭店|面馆|咖啡)/.test(name)) {
    return null;
  }
  if (
    typecode.indexOf("170") === 0 ||
    typecode.indexOf("1301") === 0 ||
    typecode.indexOf("110") === 0
  ) {
    return "park";
  }
  // 实测「龙坞茶园」被高德标成 050600（茶艺馆码），名字明确是茶园才保留。
  if (typecode === "050600") return "park";
  return null;
}

function acceptBookstore(detail: PoiDetail, relaxed: boolean): PlaceCategory | null {
  const typecode = primaryTypecode(detail.typecode);
  const name = detail.place.name;
  // 高德把「小红书买手店」这类零售店也标成 061205，按名称排除。
  if (/(买手店|商店|文具|办公用品)/.test(name)) return null;
  if (typecode === "061205") return "bookstore";
  if (relaxed && typecode.indexOf("061") === 0 && /(书店|书房|书吧|书局|书城)/.test(name)) {
    return "bookstore";
  }
  return null;
}

function acceptGallery(detail: PoiDetail, relaxed: boolean): PlaceCategory | null {
  const typecode = primaryTypecode(detail.typecode);
  if (typecode === "140400") return "gallery";
  if (
    relaxed &&
    /(美术馆|艺术馆|艺术中心|画廊)/.test(detail.place.name) &&
    (typecode.indexOf("140") === 0 || typecode.indexOf("141") === 0)
  ) {
    return "gallery";
  }
  return null;
}

function acceptMuseum(detail: PoiDetail, relaxed: boolean): PlaceCategory | null {
  const typecode = primaryTypecode(detail.typecode);
  if (typecode === "140100") return "museum";
  if (
    relaxed &&
    /(博物馆|纪念馆|陈列馆)/.test(detail.place.name) &&
    typecode.indexOf("140") === 0
  ) {
    return "museum";
  }
  return null;
}

function acceptTheater(detail: PoiDetail, relaxed: boolean): PlaceCategory | null {
  const typecode = primaryTypecode(detail.typecode);
  const name = detail.place.name;
  // 实测「满丼肉剧场」是烤肉店，不是剧场。
  if (/(肉|丼|料理|烧肉|餐厅|饭店|面馆|咖啡)/.test(name)) return null;
  if (typecode === "080603" || typecode === "080301") return "theater";
  if (relaxed && /(剧场|剧院|大舞台)/.test(name) && typecode.indexOf("08") === 0) {
    return "theater";
  }
  return null;
}

/** 名字里要有「市场 / 菜场 / 早市」这类词，才把 0607 开头的 POI 当成市场（排除菜店 / 水果店 / 批发店）。 */
const MARKET_NAME_PATTERN = /(市场|菜场|菜市|集市|市集|花市|古玩|早市|大集|农贸)/;

function acceptMarket(detail: PoiDetail, relaxed: boolean): PlaceCategory | null {
  const typecode = primaryTypecode(detail.typecode);
  const name = detail.place.name;
  if (typecode.indexOf("0607") === 0) {
    return MARKET_NAME_PATTERN.test(name) ? "market" : null;
  }
  if (relaxed && typecode.indexOf("06") === 0 && MARKET_NAME_PATTERN.test(name)) {
    return "market";
  }
  return null;
}

function acceptRestaurant(detail: PoiDetail): PlaceCategory | null {
  const typecode = primaryTypecode(detail.typecode);
  if (typecode.indexOf("05") !== 0) return null;
  if (
    typecode.indexOf("0505") === 0 ||
    typecode.indexOf("0506") === 0 ||
    typecode.indexOf("0507") === 0 ||
    typecode.indexOf("0508") === 0
  ) {
    return null;
  }
  if (/(咖啡|茶楼|茶馆|茶艺|冷饮|甜品|蛋糕|面包)/.test(detail.place.name)) return null;
  return "restaurant";
}

function acceptCafe(detail: PoiDetail): PlaceCategory | null {
  const typecode = primaryTypecode(detail.typecode);
  if (typecode.indexOf("0505") === 0) return "cafe";
  return null;
}

/* ------------------------------------------------------------------ *
 * 采集器
 * ------------------------------------------------------------------ */

type AroundThemeOptions = {
  theme: string;
  keywords: string[];
  radiusM: number;
  perDistrictCap: number;
  accept: (detail: PoiDetail) => PlaceCategory | null;
  /** 某个区在半径内一条都没搜到时的区级文本兜底关键词 */
  districtTextFallback?: (district: string) => string;
};

async function collectAroundTheme(options: AroundThemeOptions): Promise<void> {
  for (const district of DISTRICTS) {
    const center = districtCenters.get(district);
    if (center === undefined) continue;
    let added = 0;
    for (const keyword of options.keywords) {
      if (added >= options.perDistrictCap) break;
      const details = await safeQuery({
        city: CITY,
        keywords: keyword,
        page: 1,
        offset: PAGE_SIZE,
        around: { lng: center.lng, lat: center.lat, radiusM: options.radiusM },
      });
      for (const detail of details) {
        if (added >= options.perDistrictCap) break;
        if (detail.district !== district) continue;
        const category = options.accept(detail);
        if (category === null) continue;
        if (addCandidate(options.theme, detail, category, options.perDistrictCap)) added += 1;
      }
    }
    // 区级文本兜底：有些区在「区中心 + 半径」里确实搜不到（例如老街离区中心很远）。
    if (added === 0 && options.districtTextFallback !== undefined) {
      const keyword = options.districtTextFallback(district);
      const details = await safeQuery({
        city: CITY,
        keywords: keyword,
        page: 1,
        offset: PAGE_SIZE,
      });
      for (const detail of details) {
        if (added >= options.perDistrictCap) break;
        if (detail.district !== district) continue;
        const category = options.accept(detail);
        if (category === null) continue;
        if (addCandidate(options.theme, detail, category, options.perDistrictCap)) added += 1;
      }
    }
  }
  console.log(`  [${options.theme}] ${countThemeMembers(options.theme)} 条`);
}

type TypecodeThemeOptions = {
  theme: string;
  /** 高德 typecode（place/text 的 types 参数） */
  types: string;
  maxPages: number;
  perDistrictCap: number;
  accept: (detail: PoiDetail, relaxed: boolean) => PlaceCategory | null;
  fallbackKeywords: string[];
  fallbackRadiusM: number;
};

async function collectTypecodeTheme(options: TypecodeThemeOptions): Promise<void> {
  for (let page = 1; page <= options.maxPages; page += 1) {
    const details = await safeQuery({ city: CITY, types: options.types, page, offset: PAGE_SIZE });
    if (details.length === 0) break;
    for (const detail of details) {
      if (detail.district === null || !isDistrict(detail.district)) continue;
      const category = options.accept(detail, false);
      if (category === null) continue;
      addCandidate(options.theme, detail, category, options.perDistrictCap);
    }
    if (allDistrictsAtCap(options.theme, options.perDistrictCap)) break;
  }

  // 区级兜底：哪个区还不到 2 条，就在区中心周边按关键词补。
  for (const district of DISTRICTS) {
    const center = districtCenters.get(district);
    if (center === undefined) continue;
    let have = getThemeDistrictCount(options.theme, district);
    if (have >= Math.min(2, options.perDistrictCap)) continue;
    for (const keyword of options.fallbackKeywords) {
      if (have >= options.perDistrictCap) break;
      const details = await safeQuery({
        city: CITY,
        keywords: keyword,
        page: 1,
        offset: PAGE_SIZE,
        around: { lng: center.lng, lat: center.lat, radiusM: options.fallbackRadiusM },
      });
      for (const detail of details) {
        if (have >= options.perDistrictCap) break;
        if (detail.district !== district) continue;
        const category = options.accept(detail, true);
        if (category === null) continue;
        if (addCandidate(options.theme, detail, category, options.perDistrictCap)) have += 1;
      }
    }
  }
  console.log(`  [${options.theme}] ${countThemeMembers(options.theme)} 条`);
}

/** 田野 / 茶园 / 果园：这几个类目在配置的行政区里都不多，用全城文本检索 + 区过滤。 */
async function collectFieldTheme(): Promise<void> {
  const keywords = ["茶园", "农场", "田园", "果园"];
  for (const keyword of keywords) {
    if (countThemeMembers("field") >= 8) break;
    for (let page = 1; page <= 2; page += 1) {
      if (countThemeMembers("field") >= 8) break;
      const details = await safeQuery({ city: CITY, keywords: keyword, page, offset: PAGE_SIZE });
      if (details.length === 0) break;
      for (const detail of details) {
        if (countThemeMembers("field") >= 8) break;
        if (detail.district === null || !isDistrict(detail.district)) continue;
        const category = acceptField(detail);
        if (category === null) continue;
        addCandidate("field", detail, category, THEME_CAPS.field);
      }
    }
  }
  console.log(`  [field] ${countThemeMembers("field")} 条`);
}

/** 配置原点 3km 专项扫盘：3.3.5 的重点（圆心 / 半径都来自配置，不写死地址）。 */
async function collectOriginScenic(): Promise<void> {
  const keywords = [
    "公园",
    "广场",
    "绿地",
    "绿道",
    "步道",
    "滨河",
    "河畔",
    "湿地",
    "观景平台",
    "大桥",
    "美术馆",
    "博物馆",
    "展览馆",
    "书店",
    "咖啡",
    "面馆",
    "餐厅",
    "小吃",
    "美食",
    "市场",
    "菜市场",
    "老街",
  ];
  const originCaps: Record<string, number> = {
    riverfront: 12,
    park: 12,
    bridge: 4,
    gallery: 3,
    museum: 3,
    theater: 3,
    bookstore: 3,
    cafe: 8,
    restaurant: 10,
    market: 6,
    landmark: 6,
  };
  for (const keyword of keywords) {
    const details = await safeQuery({
      city: CITY,
      keywords: keyword,
      page: 1,
      offset: PAGE_SIZE,
      around: { lng: originCenter.lng, lat: originCenter.lat, radiusM: ORIGIN_RADIUS_M },
    });
    for (const detail of details) {
      const distance = distanceMeters(originCenter, detail.place);
      if (distance > ORIGIN_RADIUS_M + 1) continue;
      if (detail.district === null || !isDistrict(detail.district)) continue;
      const matched = classifyOriginPlace(detail);
      if (matched === null) continue;
      addCandidate(matched.theme, detail, matched.category, originCaps[matched.theme] ?? 3);
    }
  }
  const count = Array.from(collectedById.values()).filter(
    (item) => item.distanceToOriginM <= ORIGIN_RADIUS_M,
  ).length;
  console.log(`  [origin] 3km 内累计 ${count} 个地点`);
}

type OriginMatch = { theme: string; category: PlaceCategory };

function classifyOriginPlace(detail: PoiDetail): OriginMatch | null {
  const name = detail.place.name;
  const typecode = primaryTypecode(detail.typecode);

  // 只按高德 typecode 分类；名称只用于「江景 / 普通公园」这类子判断。
  // （只用名称放行会混进车库、花艺店、KTV、台球器材店，typecode 挡第一层、名称只做细分。）
  if (typecode.indexOf("110") === 0) {
    if (/(滨水|亲水|观景|灯光秀)/.test(name)) return { theme: "riverfront", category: "park" };
    if (/(绿道|步道|河堤|江堤|沿河|沿江|江边|湖|堤|湾|花海|跑道|湿地)/.test(name)) {
      return { theme: "riverfront", category: "park" };
    }
    return { theme: "park", category: "park" };
  }
  // 跨河 / 跨江大桥这类桥梁的 typecode 是 190307，不是景点码。
  if (typecode === "190307" && /大桥/.test(name)) return { theme: "bridge", category: "other" };
  if (typecode.indexOf("1404") === 0) return { theme: "gallery", category: "gallery" };
  if (typecode.indexOf("1401") === 0) return { theme: "museum", category: "museum" };
  // 展览馆 / 体育中心：高德分别标成 140000 / 140200。
  if (
    (typecode.indexOf("1402") === 0 || typecode === "140000") &&
    /(博览中心|展览中心|体育中心)/.test(name)
  ) {
    return { theme: "landmark", category: "other" };
  }
  if (typecode === "080603") return { theme: "theater", category: "theater" };
  if (typecode === "061205") return { theme: "bookstore", category: "bookstore" };
  if (typecode.indexOf("0607") === 0) {
    return MARKET_NAME_PATTERN.test(name) ? { theme: "market", category: "market" } : null;
  }
  if (typecode.indexOf("0505") === 0) return { theme: "cafe", category: "cafe" };
  if (typecode.indexOf("05") === 0 && /面馆|餐厅|小吃|饭店|火锅|美食|菜馆/.test(name)) {
    return { theme: "restaurant", category: "restaurant" };
  }
  // 名称兜底只给被高德误标成道路名（190301）的整段滨水公园。
  if (
    typecode === "190301" &&
    /(公园|绿道|步道|观景|河堤|江堤|花海|跑道)/.test(name) &&
    !/(路|街|弄|巷|大道|高架)/.test(name)
  ) {
    return { theme: "riverfront", category: "park" };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 3.3.6 风景标签：LLM（可选）+ 规则兜底
 * ------------------------------------------------------------------ */

type TagInput = {
  place: Place;
  typeText: string | null;
  address: string | null;
};

type LlmConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

function readLlmConfig(): LlmConfig | null {
  const apiKey = (process.env.LLM_API_KEY ?? "").trim();
  const baseUrl = (process.env.LLM_BASE_URL ?? "").trim();
  if (apiKey === "" || baseUrl === "") return null;
  const model = (process.env.LLM_MODEL ?? "deepseek-chat").trim();
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    model: model === "" ? "deepseek-chat" : model,
  };
}

const LLM_BATCH_SIZE = 12;
const LLM_TIMEOUT_MS = 20000;

const LLM_CHAT_RESPONSE_SCHEMA = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
});

const LLM_TAG_ITEM_SCHEMA = z.object({
  id: z.string().min(1),
  sceneryType: SceneryTypeSchema,
  bestTime: BestTimeSchema,
  soloFriendly: z.boolean(),
  oneLineDesc: z.string().min(1).max(20),
});

const SCENERY_SYSTEM_PROMPT = [
  "你是地点分类器，只能给「已经存在的地点」分类，不许创造、补充或改写任何地点。",
  "只根据输入的 name / type / address / rating 推断，不许编造历史、年代、事件、设施等任何事实。",
  "室内场所（书店 / 美术馆 / 博物馆 / 剧场 / 餐厅 / 咖啡 / 商场）的 bestTime 一律输出「任意」；",
  "只有当名称里明确含「观景台 / 露台 / 天台 / 山顶」时，室内场所才允许输出「日落」。",
  "不要把地点所在建筑 / 地标（例如观景平台）的江景、观景属性归给其中的室内场所；只按地点自身可推断的信息判断。",
  "只输出 JSON 数组，不要解释，不要 Markdown 代码块。",
  '数组每一项：{"id": string, "sceneryType": "江景|老街|工业|田野|森林|建筑|市井|园林|其他", "bestTime": "清晨|午后|日落|夜晚|任意", "soloFriendly": boolean, "oneLineDesc": string}。',
  "oneLineDesc 不超过 20 个字，必须是能从名称 / 类型 / 地址直接推断的信息。",
].join("\n");

/** 室内类目：bestTime 不允许标「日落」（名称明确含观景台/露台/天台/山顶的除外，见 prompt）。 */
const INDOOR_CATEGORIES: ReadonlyArray<PlaceCategory> = [
  "bookstore",
  "gallery",
  "museum",
  "theater",
  "restaurant",
  "cafe",
  "mall",
];

/** 室内场所名称里出现这些词时，prompt 才允许例外标「日落」（不再认「江景」）。 */
const OUTDOOR_VIEW_NAME_PATTERN = /(观景台|露台|天台|山顶)/;

/**
 * 数据层兜底修正：prompt 约束不保证模型 100% 遵守，落盘前再纠正一次——
 * 室内类目 + bestTime='日落' + 名称不含观景词 → 强制改回「任意」（并同步一句话描述）。
 */
function enforceIndoorBestTime(input: TagInput, tag: SceneryTag): { tag: SceneryTag; corrected: boolean } {
  if (tag.bestTime !== "日落") return { tag, corrected: false };
  if ((INDOOR_CATEGORIES as readonly string[]).indexOf(input.place.category) === -1) {
    return { tag, corrected: false };
  }
  if (OUTDOOR_VIEW_NAME_PATTERN.test(input.place.name)) return { tag, corrected: false };
  return {
    tag: {
      ...tag,
      bestTime: "任意",
      oneLineDesc: buildOneLineDesc(tag.sceneryType, input.place.category, "任意"),
    },
    corrected: true,
  };
}

async function callLlmForTags(
  config: LlmConfig,
  batch: TagInput[],
): Promise<Map<string, SceneryTag>> {
  const payload = batch.map((item) => ({
    id: item.place.id,
    name: item.place.name,
    type: item.typeText,
    address: item.address,
    rating: item.place.rating,
    category: item.place.category,
  }));

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, LLM_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        messages: [
          { role: "system", content: SCENERY_SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(payload) },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json: unknown = await response.json();
    const chat = LLM_CHAT_RESPONSE_SCHEMA.parse(json);
    const content = chat.choices[0].message.content;
    const start = content.indexOf("[");
    const end = content.lastIndexOf("]");
    if (start === -1 || end <= start) throw new Error("返回里没有 JSON 数组");
    const rawItems: unknown = JSON.parse(content.slice(start, end + 1));
    if (!Array.isArray(rawItems)) throw new Error("返回的不是数组");

    const batchIds = new Set<string>(batch.map((item) => item.place.id));
    const tags = new Map<string, SceneryTag>();
    for (const rawItem of rawItems) {
      // 字段不认识 / 枚举不对 / 超过 20 字 → 丢弃，交给规则兜底（3.3.6「字段不认识就丢弃」）。
      const parsed = LLM_TAG_ITEM_SCHEMA.safeParse(rawItem);
      if (!parsed.success) continue;
      if (!batchIds.has(parsed.data.id)) continue;
      const checked = SceneryTagSchema.safeParse({
        sceneryType: parsed.data.sceneryType,
        bestTime: parsed.data.bestTime,
        soloFriendly: parsed.data.soloFriendly,
        oneLineDesc: parsed.data.oneLineDesc,
      });
      if (!checked.success) continue;
      tags.set(parsed.data.id, checked.data);
    }
    return tags;
  } finally {
    clearTimeout(timer);
  }
}

async function tagPlacesWithLlm(
  config: LlmConfig,
  inputs: TagInput[],
  batchSize: number = LLM_BATCH_SIZE,
): Promise<Map<string, SceneryTag>> {
  const all = new Map<string, SceneryTag>();
  for (let start = 0; start < inputs.length; start += batchSize) {
    const batch = inputs.slice(start, start + batchSize);
    try {
      const tags = await callLlmForTags(config, batch);
      tags.forEach((tag, id) => {
        all.set(id, tag);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`  ! LLM 标注失败（这一批走规则兜底）：${message}`);
    }
  }
  return all;
}

const OLD_STREET_PATTERN = /(老街|古街|街区|故居|古建|遗址|古镇|巷|弄|坊|宅|书院)/;
// 注意不要单放「桥」：以「桥」命名的老街店铺会被误判成江景。桥梁用「大桥」匹配。
const RIVER_PATTERN =
  /(江边|沿江|河畔|水岸|滨水|绿道|步道|江堤|河堤|运河|观景|码头|湖滨|湖畔|大桥)/;
const FOREST_PATTERN = /(森林|湿地|山林|山$|山景|山步道|岭|谷|溪)/;
const FIELD_PATTERN = /(茶园|茶村|农场|田园|果园|田野|梯田|农庄)/;
const INDUSTRIAL_PATTERN = /(创意|艺术区|文创|工业|遗存|厂|仓|园区|设计|公社)/;
const GARDEN_PATTERN = /(公园|花园|园林|植物园|花海|苑|圃|绿地|广场|乐园|景区)/;
const MARKET_PATTERN = /(市场|菜场|市集|书店|书房|咖啡|面馆|餐厅|小吃|饭店)/;
const BUILDING_PATTERN = /(美术馆|博物馆|剧院|剧场|馆|大厦|塔|中心)/;

function inferSceneryType(input: TagInput): SceneryType {
  const name = input.place.name;
  const category = input.place.category;
  const text = `${name} ${input.typeText === null ? "" : input.typeText}`;

  // 先按 category 归类，避免「东山弄店的咖啡」被「弄」误判成老街、
  // 「运河大剧院」被「运河」误判成江景。
  if (
    category === "market" ||
    category === "bookstore" ||
    category === "cafe" ||
    category === "restaurant"
  ) {
    return "市井";
  }
  if (category === "gallery" || category === "museum" || category === "theater") {
    return "建筑";
  }

  // 公园 / other 再按名称可推断的信息细分。
  if (INDUSTRIAL_PATTERN.test(text)) return "工业";
  if (FIELD_PATTERN.test(text)) return "田野";
  if (OLD_STREET_PATTERN.test(text)) return "老街";
  if (/山.{0,8}(绿道|步道)/.test(name)) return "森林";
  if (RIVER_PATTERN.test(text)) return "江景";
  if (FOREST_PATTERN.test(text)) return "森林";
  if (GARDEN_PATTERN.test(text)) return "园林";
  if (MARKET_PATTERN.test(text)) return "市井";
  if (BUILDING_PATTERN.test(text)) return "建筑";
  return "其他";
}

function inferBestTime(sceneryType: SceneryType, category: PlaceCategory): BestTime {
  switch (sceneryType) {
    case "江景":
      return "日落";
    case "森林":
      return "清晨";
    case "田野":
      return "清晨";
    case "老街":
      return "午后";
    case "工业":
      return "午后";
    case "园林":
      return "午后";
    case "建筑":
      // 剧场主要看晚场；美术馆 / 博物馆 / 地标午后更合适。
      return category === "theater" ? "夜晚" : "午后";
    case "市井":
      return "任意";
    default:
      return "任意";
  }
}

/**
 * 「日落」必须配上真的能待到傍晚的营业时间。
 * 实测高德给某些免费公园的营业时间是 09:00-16:00，标签写「傍晚风好」会自相矛盾。
 */
function adjustBestTimeByOpeningHours(bestTime: BestTime, place: Place): BestTime {
  if (bestTime !== "日落") return bestTime;
  if (place.closeTime === null) return bestTime;
  const match = /^(\d{1,2}):(\d{2})$/.exec(place.closeTime);
  if (match === null) return bestTime;
  const closeMinute = Number(match[1]) * 60 + Number(match[2]);
  // 17:30 之前关门的地点，不可能「日落」时还在。
  return closeMinute < 17 * 60 + 30 ? "午后" : bestTime;
}

function inferSoloFriendly(input: TagInput): boolean {
  const name = input.place.name;
  if (
    input.place.category === "restaurant" &&
    /(酒楼|宴会|婚宴|包厢|聚餐|团建|家宴)/.test(name)
  ) {
    return false;
  }
  return true;
}

/** 一句话描述：只用模板，不写任何具体事实（3.3.6 红线）。 */
function buildOneLineDesc(
  sceneryType: SceneryType,
  category: PlaceCategory,
  bestTime: BestTime,
): string {
  switch (sceneryType) {
    case "江景":
      // 描述必须和 bestTime 一致：有的江边点位 16:00 就关门，不能写「傍晚风好」。
      if (bestTime === "日落") return "沿江走走，傍晚风好";
      return "沿江走走，白天散步";
    case "老街":
      return "老街巷子，午后慢慢逛";
    case "工业":
      return "旧厂房改的园区，逛逛";
    case "田野":
      return "茶园田野，白天慢慢走";
    case "森林":
      return "山林湿地，清晨来走走";
    case "建筑":
      if (category === "gallery") return "看展的地方，午后去";
      if (category === "museum") return "博物馆，适合慢慢看";
      if (category === "theater") return "剧场，看场演出";
      return "有建筑可看，午后逛逛";
    case "市井":
      if (category === "market") return "菜场早市，烟火气足";
      if (category === "bookstore") return "书店，适合一个人待";
      if (category === "cafe") return "咖啡馆，坐一会儿";
      return "本地小馆，一个人也能吃";
    case "园林":
      return category === "park" ? "城市绿地，午后散步" : "园子里的地方，午后逛";
    default:
      return "短途去处，随便走走";
  }
}

function ruleTag(input: TagInput): SceneryTag {
  const sceneryType = inferSceneryType(input);
  const bestTime = adjustBestTimeByOpeningHours(
    inferBestTime(sceneryType, input.place.category),
    input.place,
  );
  return {
    sceneryType,
    bestTime,
    soloFriendly: inferSoloFriendly(input),
    oneLineDesc: buildOneLineDesc(sceneryType, input.place.category, bestTime),
  };
}

/* ------------------------------------------------------------------ *
 * 统计
 * ------------------------------------------------------------------ */

function countClassMembers(def: ClassDef): number {
  let count = 0;
  Array.from(collectedById.values()).forEach((item) => {
    const hit = def.themes.some((theme) => item.themes.has(theme));
    if (hit) count += 1;
  });
  return count;
}

function classDistrictBreakdown(def: ClassDef): string {
  const counts = new Map<string, number>();
  Array.from(collectedById.values()).forEach((item) => {
    const hit = def.themes.some((theme) => item.themes.has(theme));
    if (!hit) return;
    counts.set(item.district, (counts.get(item.district) ?? 0) + 1);
  });
  return DISTRICTS.map((district) => `${districtShort(district)}${counts.get(district) ?? 0}`).join(
    "/",
  );
}

function categorySummary(places: Place[]): string {
  const counts = new Map<PlaceCategory, number>();
  for (const place of places) {
    counts.set(place.category, (counts.get(place.category) ?? 0) + 1);
  }
  return CATEGORY_ORDER.filter((category) => (counts.get(category) ?? 0) > 0)
    .map((category) => `${category} ${counts.get(category) ?? 0}`)
    .join(" / ");
}

function districtSummary(): string {
  const counts = new Map<string, number>();
  Array.from(collectedById.values()).forEach((item) => {
    counts.set(item.district, (counts.get(item.district) ?? 0) + 1);
  });
  return DISTRICTS.map((district) => `${districtShort(district)} ${counts.get(district) ?? 0}`).join(
    " / ",
  );
}

/** 某个 category 的按区分布（餐厅按区补的验收口径）。 */
function categoryDistrictSummary(category: PlaceCategory): string {
  const counts = new Map<string, number>();
  Array.from(collectedById.values()).forEach((item) => {
    if (item.place.category !== category) return;
    counts.set(item.district, (counts.get(item.district) ?? 0) + 1);
  });
  return DISTRICTS.map((district) => `${districtShort(district)} ${counts.get(district) ?? 0}`).join(
    " / ",
  );
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function resolveCenters(): Promise<void> {
  for (const district of DISTRICTS) {
    await throttleRequest();
    const center = await geocode(district, CITY);
    if (center === null) throw new Error(`geocode 拿不到「${district}」的中心坐标`);
    districtCenters.set(district, center);
    console.log(`  ${district}中心：${center.lng},${center.lat}`);
  }
  console.log(`  原点（config.origin）：${originCenter.lng},${originCenter.lat}`);
}

async function collectAll(): Promise<void> {
  const steps: { title: string; run: () => Promise<void> }[] = [
    {
      title: "1/14 江/河/湖岸、堤坝、滨水步道",
      run: () =>
        collectAroundTheme({
          theme: "riverfront",
          keywords: ["绿道", "沿江", "河边", "河堤", "步道", "观景平台", "湖", "湿地"],
          radiusM: 8000,
          perDistrictCap: THEME_CAPS.riverfront,
          accept: acceptRiverfront,
        }),
    },
    {
      title: "2/14 公园、广场、绿地",
      run: () =>
        collectAroundTheme({
          theme: "park",
          keywords: ["公园", "广场", "绿地"],
          radiusM: 8000,
          perDistrictCap: THEME_CAPS.park,
          accept: acceptPark,
          districtTextFallback: (district) => `${district} 公园`,
        }),
    },
    {
      title: "3/14 老街、历史街区、老建筑",
      run: () =>
        collectAroundTheme({
          theme: "oldstreet",
          keywords: ["老街", "历史街区", "故居", "古建筑"],
          radiusM: 8000,
          perDistrictCap: THEME_CAPS.oldstreet,
          accept: acceptOldStreet,
          districtTextFallback: (district) => `${district} 老街`,
        }),
    },
    {
      title: "4/14 工业遗存、创意园、艺术区",
      run: () =>
        collectAroundTheme({
          theme: "industrial",
          keywords: ["创意园", "艺术区", "工业遗存", "文创园"],
          radiusM: 8000,
          perDistrictCap: THEME_CAPS.industrial,
          accept: acceptIndustrial,
          districtTextFallback: (district) => `${district} 创意园`,
        }),
    },
    {
      title: "5/14 山、森林、水库、湿地",
      run: () =>
        collectAroundTheme({
          theme: "mountain",
          keywords: ["山", "湿地", "森林", "水库"],
          radiusM: 12000,
          perDistrictCap: THEME_CAPS.mountain,
          accept: acceptMountain,
        }),
    },
    {
      title: "6/14 桥、观景平台",
      run: () =>
        collectAroundTheme({
          theme: "bridge",
          keywords: ["大桥", "观景台", "观景平台"],
          radiusM: 12000,
          perDistrictCap: THEME_CAPS.bridge,
          accept: acceptBridge,
          districtTextFallback: (district) => `${district} 大桥`,
        }),
    },
    {
      title: "7/14 田野、茶园、果园",
      run: () => collectFieldTheme(),
    },
    {
      title: "8/14 书店",
      run: () =>
        collectTypecodeTheme({
          theme: "bookstore",
          types: "061205",
          maxPages: 8,
          perDistrictCap: THEME_CAPS.bookstore,
          accept: acceptBookstore,
          fallbackKeywords: ["书店"],
          fallbackRadiusM: 6000,
        }),
    },
    {
      title: "9/14 美术馆",
      run: () =>
        collectTypecodeTheme({
          theme: "gallery",
          types: "140400",
          maxPages: 6,
          perDistrictCap: THEME_CAPS.gallery,
          accept: acceptGallery,
          fallbackKeywords: ["美术馆", "艺术中心"],
          fallbackRadiusM: 6000,
        }),
    },
    {
      title: "10/14 博物馆",
      run: () =>
        collectTypecodeTheme({
          theme: "museum",
          types: "140100",
          maxPages: 8,
          perDistrictCap: THEME_CAPS.museum,
          accept: acceptMuseum,
          fallbackKeywords: ["博物馆", "纪念馆"],
          fallbackRadiusM: 8000,
        }),
    },
    {
      title: "11/14 剧场",
      run: () =>
        collectTypecodeTheme({
          theme: "theater",
          types: "080603",
          maxPages: 8,
          perDistrictCap: THEME_CAPS.theater,
          accept: acceptTheater,
          fallbackKeywords: ["剧场", "剧院"],
          fallbackRadiusM: 10000,
        }),
    },
    {
      title: "12/14 市场（菜场/花市/古玩）",
      run: () =>
        collectTypecodeTheme({
          theme: "market",
          types: "060700",
          maxPages: 8,
          perDistrictCap: THEME_CAPS.market,
          accept: acceptMarket,
          fallbackKeywords: ["菜市场", "市场", "花市", "古玩市场"],
          fallbackRadiusM: 6000,
        }),
    },
    {
      title: "13/14 餐厅 / 咖啡",
      run: async () => {
        await collectAroundTheme({
          theme: "restaurant",
          keywords: ["面馆", "餐厅", "小吃", "美食"],
          radiusM: 8000,
          perDistrictCap: THEME_CAPS.restaurant,
          accept: acceptRestaurant,
          districtTextFallback: (district) => `${district} 面馆`,
        });
        await collectAroundTheme({
          theme: "cafe",
          keywords: ["咖啡", "咖啡馆"],
          radiusM: 5000,
          perDistrictCap: THEME_CAPS.cafe,
          accept: acceptCafe,
        });
      },
    },
    {
      title: "14/14 原点 3km 专项",
      run: () => collectOriginScenic(),
    },
  ];

  for (const step of steps) {
    console.log(`采集 ${step.title}`);
    await step.run();
  }
}

/* ------------------------------------------------------------------ *
 * tier 门槛（落盘前硬校验，不达标不许写文件）
 *
 * 通用规则（总数 / 类目覆盖 / 核心 6 类 / 原点 3km 免费点）的数值与实现都在
 * lib/cityTier.ts，与 npm run check:city 共用同一份，避免两处各写一套阈值。
 * 本文件只额外做「依赖采集过程、数据文件里没有」的检查：
 * 12 类采集覆盖、行政区分布、餐厅按区、可疑 POI、labelSource / scenery 完整性。
 * ------------------------------------------------------------------ */

/** 落盘前的硬校验：返回每条规则的实测值 + 不达标明细；所有 failures 为空才允许写文件。 */
function validateData(places: Place[], config: CityConfig): TierCheck[] {
  // 1) 与 npm run check:city 共用的 tier 规则（lib/cityTier.ts，单一实现）：
  //    总条数 / 类目覆盖(tier1) / 核心 6 类(tier4) / 原点 3km 内免费点。
  const checks: TierCheck[] = evaluateTierRules(config, places);

  // 2) fetch:seed 专属、数据文件里没有的字段（theme / adname）：只在 tier1 检查。
  if (config.thresholds.tier === "tier1") {
    const classMin = 3;
    const classFailures: string[] = [];
    for (const def of CLASS_DEFS) {
      const count = countClassMembers(def);
      if (count < classMin) {
        classFailures.push(`类目「${def.label}」只有 ${count} 条（要求 >= ${classMin}）`);
      }
    }
    const passed = CLASS_DEFS.filter((def) => countClassMembers(def) >= classMin).length;
    checks.push({
      label: "12 类采集",
      measured:
        `${passed}/${CLASS_DEFS.length} 类达标（每类要求 >= ${classMin}）：` +
        CLASS_DEFS.map((def) => `${def.label} ${countClassMembers(def)}`).join(" / "),
      failures: classFailures,
    });

    const districtMin = 8;
    const restaurantDistrictMin = 3;
    const districtCounts = new Map<string, number>();
    Array.from(collectedById.values()).forEach((item) => {
      districtCounts.set(item.district, (districtCounts.get(item.district) ?? 0) + 1);
    });
    const districtFailures: string[] = [];
    for (const district of DISTRICTS) {
      const count = districtCounts.get(district) ?? 0;
      if (count < districtMin) {
        districtFailures.push(`行政区「${district}」只有 ${count} 条（要求 >= ${districtMin}）`);
      }
    }
    checks.push({
      label: "行政区分布",
      measured: DISTRICTS.map((district) => `${district} ${districtCounts.get(district) ?? 0}`).join(" / "),
      failures: districtFailures,
    });

    const restaurantFailures: string[] = [];
    const restaurantMeasured = DISTRICTS.map((district) => {
      const count = Array.from(collectedById.values()).filter(
        (item) => item.district === district && item.place.category === "restaurant",
      ).length;
      if (count < restaurantDistrictMin) {
        restaurantFailures.push(`行政区「${district}」只有 ${count} 家餐厅（要求 >= ${restaurantDistrictMin}）`);
      }
      return `${district} ${count}`;
    }).join(" / ");
    checks.push({ label: "餐厅按区", measured: restaurantMeasured, failures: restaurantFailures });
  }

  // 3) 两种 tier 都查：可疑 POI（3.3.5 不达标判据）。
  const junk = places.filter((place) => JUNK_NAME_PATTERN.test(place.name));
  checks.push({
    label: "可疑 POI",
    measured: `${junk.length} 条（应为 0）`,
    failures: junk.length > 0 ? [`含可疑 POI：${junk.map((place) => place.name).join("、")}`] : [],
  });

  // 规则 9：室内场所不允许 bestTime='日落'（名称明确含观景台/露台/天台/山顶的例外）。
  const indoorSunset = places.filter(
    (place) =>
      (INDOOR_CATEGORIES as readonly string[]).indexOf(place.category) !== -1 &&
      place.scenery !== undefined &&
      place.scenery.bestTime === "日落" &&
      !OUTDOOR_VIEW_NAME_PATTERN.test(place.name),
  );
  checks.push({
    label: "室内场所 bestTime",
    measured: `室内标「日落」${indoorSunset.length} 条（应为 0）`,
    failures:
      indoorSunset.length > 0
        ? [
            `室内场所被标 bestTime='日落'：${indoorSunset
              .map((place) => `${place.name}(${place.category})`)
              .join("、")}`,
          ]
        : [],
  });

  // 规则 10：labelSource 必须写全（区分 LLM / 规则兜底）。
  const missingLabelSource = places.filter((place) => place.labelSource === undefined);
  checks.push({
    label: "labelSource 完整性",
    measured: `缺失 ${missingLabelSource.length} 条（应为 0）`,
    failures:
      missingLabelSource.length > 0
        ? [`缺少 labelSource：${missingLabelSource.map((place) => place.name).join("、")}`]
        : [],
  });

  // 规则 11：scenery 必须写全（3.3.6：每条都要有风景标签）。
  const missingScenery = places.filter((place) => place.scenery === undefined);
  checks.push({
    label: "scenery 完整性",
    measured: `未标注 ${missingScenery.length} 条（应为 0）`,
    failures:
      missingScenery.length > 0
        ? [`缺少 scenery：${missingScenery.map((place) => place.name).join("、")}`]
        : [],
  });

  return checks;
}

async function main(): Promise<void> {
  console.log("M1 数据扩展：12 类采集（3.3.5）+ 风景标签（3.3.6）");
  console.log(`城市配置：city=${CONFIG.city}（displayName=${CITY}，tier=${TIER}）`);
  console.log(`输出文件：${OUTPUT_FILE}（写盘走 saveCityData）`);
  console.log(
    `目标行政区=${DISTRICTS.join("、")}；原点=${originCenter.lng},${originCenter.lat}；原点半径=${ORIGIN_RADIUS_M}m`,
  );
  console.log("开始解析行政区中心（命中 .cache 时不再打接口）");
  await resolveCenters();

  console.log("开始采集；每次高德请求间隔 >= 520ms");
  await collectAll();

  const places = Array.from(collectedById.values()).map((item) => item.place);
  const tagInputs: TagInput[] = Array.from(collectedById.values()).map((item) => ({
    place: item.place,
    typeText: item.typeText,
    address: item.address,
  }));

  // 3.3.6：有 LLM 就走 LLM，没有就规则兜底；两种结果都过 SceneryTagSchema。
  // 数据层兜底：室内类目不允许 bestTime='日落'（prompt 已约束，这里再纠正一次模型输出）。
  const llmConfig = readLlmConfig();
  let llmCount = 0;
  let ruleCount = 0;
  let indoorSunsetCorrected = 0;
  const correctedNames: string[] = [];
  const applyTag = (input: TagInput, rawTag: SceneryTag, source: "llm" | "rule"): void => {
    const enforced = enforceIndoorBestTime(input, rawTag);
    if (enforced.corrected) {
      indoorSunsetCorrected += 1;
      correctedNames.push(input.place.name);
    }
    input.place.scenery = SceneryTagSchema.parse(enforced.tag);
    input.place.labelSource = source;
  };
  if (llmConfig === null) {
    console.log("未配置 LLM_API_KEY / LLM_BASE_URL：风景标签走规则兜底（不编造事实）");
    for (const input of tagInputs) {
      applyTag(input, ruleTag(input), "rule");
      ruleCount += 1;
    }
  } else {
    console.log(`配置了 LLM（${llmConfig.baseUrl} / ${llmConfig.model}）：用 LLM 给 ${tagInputs.length} 条地点打标签`);
    const llmTags = await tagPlacesWithLlm(llmConfig, tagInputs);
    for (const input of tagInputs) {
      const fromLlm = llmTags.get(input.place.id);
      if (fromLlm === undefined) {
        applyTag(input, ruleTag(input), "rule");
        ruleCount += 1;
      } else {
        applyTag(input, fromLlm, "llm");
        llmCount += 1;
      }
    }
    console.log(`  LLM 标注 ${llmCount} 条；规则兜底 ${ruleCount} 条`);
  }

  // 4) 用 labelSource 筛出规则兜底条目，再用 LLM 重跑一次（小批次，降低整批失败概率）。
  if (llmConfig !== null) {
    let remainingRuleInputs = tagInputs.filter((input) => input.place.labelSource === "rule");
    if (remainingRuleInputs.length > 0) {
      console.log(`  labelSource=rule 初检 ${remainingRuleInputs.length} 条，用 LLM 重跑一次（batch 6 → 3）`);
      for (const batchSize of [6, 3]) {
        if (remainingRuleInputs.length === 0) break;
        const beforeText = new Map<string, string>();
        for (const input of remainingRuleInputs) {
          beforeText.set(
            input.place.id,
            `${input.place.scenery?.sceneryType ?? "?"}/${input.place.scenery?.bestTime ?? "?"}`,
          );
        }
        const retags = await tagPlacesWithLlm(llmConfig, remainingRuleInputs, batchSize);
        const stillRule: TagInput[] = [];
        for (const input of remainingRuleInputs) {
          const fromLlm = retags.get(input.place.id);
          if (fromLlm === undefined) {
            stillRule.push(input);
            continue;
          }
          applyTag(input, fromLlm, "llm");
          llmCount += 1;
          ruleCount -= 1;
          console.log(
            `    ${input.place.name}：${beforeText.get(input.place.id) ?? "?"} → ` +
              `${input.place.scenery?.sceneryType}/${input.place.scenery?.bestTime}`,
          );
        }
        remainingRuleInputs = stillRule;
      }
      if (remainingRuleInputs.length > 0) {
        console.log(`    仍走规则兜底：${remainingRuleInputs.map((input) => input.place.name).join("、")}`);
      }
    }
  }

  console.log(
    `  室内场所 bestTime='日落' 纠正：${indoorSunsetCorrected} 条${
      correctedNames.length === 0 ? "" : `（${correctedNames.join("、")}）`
    }`,
  );
  const rulePlaces = tagInputs
    .filter((input) => input.place.labelSource === "rule")
    .map((input) => input.place);
  const ruleSceneryCounts = new Map<SceneryType, number>();
  for (const place of rulePlaces) {
    const sceneryType: SceneryType = place.scenery === undefined ? "其他" : place.scenery.sceneryType;
    ruleSceneryCounts.set(sceneryType, (ruleSceneryCounts.get(sceneryType) ?? 0) + 1);
  }
  const ruleScenerySummary = (
    ["江景", "老街", "工业", "田野", "森林", "建筑", "市井", "园林", "其他"] as SceneryType[]
  )
    .filter((sceneryType) => (ruleSceneryCounts.get(sceneryType) ?? 0) > 0)
    .map((sceneryType) => `${sceneryType} ${ruleSceneryCounts.get(sceneryType) ?? 0}`)
    .join(" / ");
  console.log(`  labelSource=rule：${rulePlaces.length} 条；sceneryType：${ruleScenerySummary}`);
  if (rulePlaces.length > 0) {
    console.log(`    rule 条目：${rulePlaces.map((place) => place.name).join("、")}`);
  }

  // 排序：类目 → 行政区 → 名称，保证两次运行 diff 稳定。
  places.sort((a, b) => {
    const categoryDiff = CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);
    if (categoryDiff !== 0) return categoryDiff;
    const aCollected = collectedById.get(a.id);
    const bCollected = collectedById.get(b.id);
    const aDistrict = aCollected === undefined ? 99 : DISTRICTS.indexOf(aCollected.district);
    const bDistrict = bCollected === undefined ? 99 : DISTRICTS.indexOf(bCollected.district);
    if (aDistrict !== bDistrict) return aDistrict - bDistrict;
    return a.name.localeCompare(b.name, "zh-Hans-CN");
  });

  // 落盘前过冻结契约：不通过直接抛错，不兜底修补。
  const output = z.array(PlaceSchema).parse(places);
  const checks = validateData(output, CONFIG);
  const failures = checks.flatMap((check) => check.failures);
  console.log("");
  console.log(`tier 门槛校验（${TIER}，city=${CONFIG.city}）：`);
  for (const check of checks) {
    console.log(
      `  [${check.failures.length === 0 ? "PASS" : "FAIL"}] ${check.label}：${check.measured}`,
    );
    for (const failure of check.failures) {
      console.log(`         - ${failure}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`数据不达标（${TIER}）：\n- ${failures.join("\n- ")}`);
  }

  // 写盘：saveCityData 会整份过 CityDataSchema、updatedAt 自动写今天、并清进程内缓存。
  saveCityData(CONFIG, output);

  /* ---------------------------- 报告 ---------------------------- */

  const ratingNull = output.filter((place) => place.rating === null).length;
  const costNull = output.filter((place) => place.avgCost === null).length;
  const openTimeNull = output.filter((place) => place.openTime === null).length;
  const originPlaces = output.filter(
    (place) => distanceMeters(originCenter, place) <= ORIGIN_RADIUS_M,
  );
  // 「免费点」口径与 tier 规则一致：avgCost null/0，任意类目。
  const originFree = originPlaces.filter(isFreePlace);
  const originFreeAnytime = originFree.filter(
    (place) => place.openTime === "00:00" && place.closeTime === "24:00",
  );
  const originFreeScenic = originFree.filter(
    (place) => place.category === "park" || place.category === "other",
  );
  const originFreeCulture = originFree.filter(
    (place) =>
      place.category === "gallery" ||
      place.category === "museum" ||
      place.category === "theater" ||
      place.category === "bookstore",
  );
  const originRestaurants = originPlaces.filter((place) => place.category === "restaurant");
  const originCafes = originPlaces.filter((place) => place.category === "cafe");
  const originCategoryCounts = new Map<PlaceCategory, number>();
  for (const place of originPlaces) {
    originCategoryCounts.set(place.category, (originCategoryCounts.get(place.category) ?? 0) + 1);
  }
  const restaurantDistances = output
    .filter((place) => place.category === "restaurant")
    .map((place) => ({ name: place.name, distance: distanceMeters(originCenter, place) }))
    .sort((a, b) => a.distance - b.distance);
  const nearestRestaurant = restaurantDistances.length === 0 ? null : restaurantDistances[0];

  console.log("");
  console.log(`PASS 已写入 ${OUTPUT_FILE}`);
  console.log(`总条数：${output.length}（分类 ${categorySummary(output)}）`);
  console.log(`行政区：${districtSummary()}`);
  console.log(`餐厅按区：${categoryDistrictSummary("restaurant")}`);
  console.log(`咖啡按区：${categoryDistrictSummary("cafe")}`);
  console.log("12 类采集覆盖：");
  CLASS_DEFS.forEach((def, index) => {
    console.log(
      `  ${index + 1}. ${def.label}：${countClassMembers(def)} 条（${classDistrictBreakdown(def)}）`,
    );
  });
  console.log(`补充：地标 / 场馆 ${countThemeMembers("landmark")} 条（不占 12 类名额）`);
  console.log("");
  console.log(
    `原点 3km（config.origin=${originCenter.lng},${originCenter.lat}，半径 ${ORIGIN_RADIUS_M}m）：`,
  );
  console.log(
    `  收录 ${originPlaces.length} 个地点；免费点（任意类目）${originFree.length} 个，` +
      `其中 24 小时开放 ${originFreeAnytime.length} 个；` +
      `免费公园/风景 ${originFreeScenic.length} 个；免费书店/展馆 ${originFreeCulture.length} 个`,
  );
  console.log(
    `  3km 内类目：${CATEGORY_ORDER.filter(
      (category) => (originCategoryCounts.get(category) ?? 0) > 0,
    )
      .map((category) => `${category} ${originCategoryCounts.get(category) ?? 0}`)
      .join(" / ")}`,
  );
  console.log("  免费可去清单（公园/风景，按距离）：");
  originFreeScenic
    .slice()
    .sort((a, b) => distanceMeters(originCenter, a) - distanceMeters(originCenter, b))
    .forEach((place) => {
      const distance = Math.round(distanceMeters(originCenter, place));
      const openText =
        place.openTime === null || place.closeTime === null
          ? "营业时间未知（排程当前会跳过）"
          : `${place.openTime}-${place.closeTime}`;
      console.log(`    - ${place.name}（${place.category}，${distance}m，${openText}）`);
    });
  console.log(`  3km 内餐厅 ${originRestaurants.length} 家 / 咖啡 ${originCafes.length} 家`);
  if (nearestRestaurant !== null) {
    console.log(
      `  最近的餐厅：${nearestRestaurant.name}（距原点 ${Math.round(nearestRestaurant.distance)}m）`,
    );
  }
  console.log("");
  if (llmConfig === null) {
    console.log(
      `标签：规则兜底 ${ruleCount} 条（未配置 LLM_API_KEY / LLM_BASE_URL；补 key 后重跑 fetch:seed 自动改走 LLM）`,
    );
  } else {
    console.log(`标签：LLM ${llmCount} 条 / 规则兜底 ${ruleCount} 条`);
  }
  console.log(
    `字段完整性：rating=null ${ratingNull} 条；avgCost=null ${costNull} 条；openTime=null ${openTimeNull} 条`,
  );

  console.log("前 5 条：");
  console.log(JSON.stringify(output.slice(0, 5), null, 2));
}

main().catch((error: unknown) => {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
