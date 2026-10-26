"use client";

/**
 * 高德定位（本轮新增）。
 *
 * 为什么不用浏览器原生 geolocation：
 * Chrome 的 `navigator.geolocation` 依赖 Google 定位服务，国内网络下会长时间无响应 / 静默超时；
 * 高德 JSAPI 的 `AMap.Geolocation` 插件走高德自己的定位服务，是项目已接入的高德链路的自然延伸。
 *
 * 设计约束（改动前必读）：
 * 1. **定位是增强，不是必须条件**：任何失败（拒绝授权 / 超时 / SDK 加载失败 / 非安全上下文）
 *    都返回 null，不抛错，页面静默回落到城市默认起点，绝不阻塞行程生成；
 * 2. 10 分钟内复用 localStorage 里的 `szjz.geo`，避免每次打开都重复定位 / 重复弹授权；
 * 3. 成功才写缓存（含 timestamp）；localStorage 读写全部包 try/catch（隐私模式 / 配额满不崩）；
 * 4. 失败只允许 console.warn（预期失败静默），**不许打 console.error**——拒绝授权是用户选择，
 *    不是程序错误。
 */

import { loadAMap } from "./amapLoader";

/**
 * 全局定位开关（本轮新增）：**自动定位**与开屏问答第 2 步的「定位当前位置」按钮都由它控制。
 *
 * - false（当前默认）= 隐藏自动定位：页面不再后台定位、不弹授权、不写 `szjz.geo`；
 *   问答第 2 步只保留「手动输入地址」。手填地址解析 / 跨城起点保护 / 切城市的起点兜底都照旧。
 * - true = 老行为：后台静默定位 + 问答里的定位按钮 + 10 分钟缓存全部回来。
 *
 * 定位相关代码（locateOnce / readCachedGeo / clearCachedGeo / szjz.geo 读写 / 切城市重新定位）
 * **一行都不删**，只在这个开关后面保留；要恢复定位只改这一行为 true，不要动其它文件。
 */
export const GEOLOCATION_ENABLED = false;

/** 定位结果（成功才返回）。label 是可选的「房山区苏庄」这类可读地名，给输入框 placeholder 用。 */
export type GeoPosition = {
  lat: number;
  lng: number;
  accuracy: number;
  label?: string;
};

/** localStorage 缓存里多存一个写入时刻，用来判 10 分钟有效期。 */
type CachedGeoPosition = GeoPosition & { timestamp: number };

/** 缓存 key（验收脚本会直接读写它，改名必须同步验收脚本）。 */
const GEO_STORAGE_KEY = "szjz.geo";

/** 缓存有效期：10 分钟。 */
const GEO_CACHE_TTL_MS = 10 * 60 * 1000;

/** 传给 AMap.Geolocation 的 timeout（毫秒）：10 秒没结果按失败处理。 */
const GEO_OPTION_TIMEOUT_MS = 10_000;

/** 额外保护计时器：比插件 timeout 略长。插件在少数环境（被拦截 / 非安全上下文）下可能不回调，
 * 这里保证 Promise 一定会 settle（页面只关心「拿到/没拿到」，不关心卡多久）。 */
const GEO_GUARD_TIMEOUT_MS = 12_000;

/**
 * AMap.plugin 回调本身的超时：插件脚本下载失败 / 被拦截时回调可能永远不来。
 * 没有这个上限的话 `locateOnce()` 会永久悬挂、pendingLocate 永远不清空（后续调用都拿同一个悬挂 Promise）；
 * 加一个上限后统一按「定位不可用 → null」降级。
 */
const GEO_PLUGIN_LOAD_TIMEOUT_MS = 10_000;

/** 高德定位插件的最小类型（只声明本文件用到的部分，不引第三方类型）。 */
type AmapGeolocationNamespace = {
  plugin: (plugins: string | string[], callback?: () => void) => void;
  Geolocation: new (options: Record<string, unknown>) => {
    getCurrentPosition: (callback: (status: string, result: unknown) => void) => void;
  };
};

/**
 * 跨城边界（本轮新增）：定位点到当前城市 origin 的直线距离超过这个值（50km），
 * 就视为「用户人在另一个城市」——不再拿定位当起点（否则在当前城市的候选池里排不出来）。
 */
export const GEO_CITY_MAX_DISTANCE_M = 50_000;

/** 两点球面直线距离（米，haversine）。只用于「定位点是否属于当前城市」的判定，不参与排程。 */
export function geoDistanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const earthRadius = 6_371_000;
  const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * 定位点是否属于当前城市（到 city.origin 的直线距离 ≤ maxDistanceM，默认 50km）。
 * 没有定位（null）= true：由调用方维持原行为（不发坐标，走画像 / 城市默认起点）。
 *
 * maxDistanceM 由页面从 /api/cities 的 geoRadiusM 传入：合并后的大城市（如北京房山+顺义）
 * 数据覆盖半径远超 50km，写死会把同城用户误判成跨城。
 */
export function isGeoInCity(
  geo: { lat: number; lng: number } | null,
  cityOrigin: { latitude: number; longitude: number },
  maxDistanceM: number = GEO_CITY_MAX_DISTANCE_M,
): boolean {
  if (geo === null) return true;
  return geoDistanceMeters(geo, { lat: cityOrigin.latitude, lng: cityOrigin.longitude }) <= maxDistanceM;
}

/** 删除本地定位缓存（跨城时清掉，避免下一次请求继续拿另一个城市的坐标当起点）。 */
export function clearCachedGeo(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(GEO_STORAGE_KEY);
  } catch {
    // 隐私模式 / 存储不可用：本来就没法清，忽略（不影响本次请求）。
  }
}

/** 并发去重：页面 StrictMode 双挂载 / 多处调用时只定位一次。 */
let pendingLocate: Promise<GeoPosition | null> | null = null;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readString(source: Record<string, unknown> | null, key: string): string {
  if (source === null) return "";
  const value = source[key];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 从 AMap.Geolocation 的回调结果里拼一个短地名（只用于 placeholder 展示，不参与排程）。
 * 优先级：区 + 乡镇/街道（例如「房山区苏庄」）→ 区 → formattedAddress 前 20 字。
 */
function labelFromResult(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const record = result as Record<string, unknown>;
  const component =
    typeof record.addressComponent === "object" && record.addressComponent !== null
      ? (record.addressComponent as Record<string, unknown>)
      : null;
  const district = readString(component, "district");
  const township = readString(component, "township");
  if (district !== "" && township !== "") return `${district}${township}`;
  if (district !== "") return district;
  const formatted = readString(record, "formattedAddress");
  return formatted === "" ? undefined : formatted.slice(0, 20);
}

/** 把任意 JSON 值收敛成合法 GeoPosition；不合法返回 null。 */
function parseGeoPosition(value: unknown): GeoPosition | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!isFiniteNumber(record.lat) || !isFiniteNumber(record.lng)) return null;
  const accuracy = isFiniteNumber(record.accuracy) ? record.accuracy : 0;
  const label = typeof record.label === "string" && record.label.trim() !== "" ? record.label.trim() : undefined;
  return label === undefined
    ? { lat: record.lat, lng: record.lng, accuracy }
    : { lat: record.lat, lng: record.lng, accuracy, label };
}

/**
 * 读「10 分钟内的定位缓存」；没有 / 过期 / 值不合法 / 读不到 localStorage → null。
 * 导出是给页面用的：页面首帧先同步拿缓存，避免等 locateOnce 的异步结果。
 */
export function readCachedGeo(now: number = Date.now()): GeoPosition | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(GEO_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    const position = parseGeoPosition(parsed);
    if (position === null) return null;
    const record = parsed as Record<string, unknown>;
    if (!isFiniteNumber(record.timestamp)) return null;
    const ageMs = now - record.timestamp;
    // 未来时间戳（时钟被改过）也视为不可信：宁可不复用，也不拿可疑坐标排程。
    if (ageMs < 0 || ageMs > GEO_CACHE_TTL_MS) return null;
    return position;
  } catch {
    return null;
  }
}

/** 写定位缓存（含 timestamp）。写不进去（隐私模式 / 配额满）不算失败：本次内存里仍然可用。 */
function writeCachedGeo(position: GeoPosition): void {
  if (typeof window === "undefined") return;
  try {
    const payload: CachedGeoPosition = { ...position, timestamp: Date.now() };
    window.localStorage.setItem(GEO_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // 忽略：定位结果仍然返回给调用方，只是下次打开需要重新定位。
  }
}

/** 加载 AMap.Geolocation 插件（同一份 SDK 只加载一次；插件回调有 10 秒上限，绝不悬挂）。 */
async function loadGeolocationPlugin(): Promise<AmapGeolocationNamespace> {
  const AMap = (await loadAMap()) as AmapGeolocationNamespace;
  if (typeof AMap.plugin !== "function") throw new Error("高德 JSAPI 的 AMap.plugin 不可用");
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (error === undefined) resolve();
      else reject(error);
    };
    // 插件脚本下载失败 / 被拦截时 AMap.plugin 的回调可能永远不来：加超时兜底。
    const timer = window.setTimeout(
      () => finish(new Error("高德定位插件加载超时")),
      GEO_PLUGIN_LOAD_TIMEOUT_MS,
    );
    try {
      AMap.plugin("AMap.Geolocation", () => finish());
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
  if (typeof AMap.Geolocation !== "function") throw new Error("AMap.Geolocation 插件加载失败");
  return AMap;
}

/** 真正执行一次定位（不带缓存逻辑、不带并发去重）。 */
async function locateNow(): Promise<GeoPosition | null> {
  let AMap: AmapGeolocationNamespace;
  try {
    AMap = await loadGeolocationPlugin();
  } catch (error) {
    // SDK / 插件加载失败：降级到城市默认起点。只 warn（不是 error），且不抛给页面。
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[geolocation] 高德定位不可用，改用城市默认起点：${message}`);
    return null;
  }

  return await new Promise<GeoPosition | null>((resolve) => {
    let settled = false;
    let guard: number | null = null;

    const finish = (position: GeoPosition | null): void => {
      if (settled) return;
      settled = true;
      if (guard !== null) window.clearTimeout(guard);
      resolve(position);
    };

    // 兜底：插件在少数环境下可能永远不回调，保证 Promise 一定结束（页面不 await，但也不能悬挂）。
    guard = window.setTimeout(() => finish(null), GEO_GUARD_TIMEOUT_MS);

    let geolocation: { getCurrentPosition: (callback: (status: string, result: unknown) => void) => void };
    try {
      geolocation = new AMap.Geolocation({
        enableHighAccuracy: true,
        timeout: GEO_OPTION_TIMEOUT_MS,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[geolocation] 创建定位实例失败，改用城市默认起点：${message}`);
      finish(null);
      return;
    }

    try {
      geolocation.getCurrentPosition((status, result) => {
        // 拒绝授权 / 超时 / 定位服务无数据：高德用 status!=='complete' 表示，静默回落。
        if (status !== "complete" || typeof result !== "object" || result === null) {
          finish(null);
          return;
        }
        const record = result as Record<string, unknown>;
        const position =
          typeof record.position === "object" && record.position !== null
            ? (record.position as Record<string, unknown>)
            : null;
        const lat = position === null ? NaN : position.lat;
        const lng = position === null ? NaN : position.lng;
        if (!isFiniteNumber(lat) || !isFiniteNumber(lng)) {
          finish(null);
          return;
        }
        const accuracy = isFiniteNumber(record.accuracy) ? record.accuracy : 0;
        const label = labelFromResult(result);
        const geoPosition: GeoPosition =
          label === undefined ? { lat, lng, accuracy } : { lat, lng, accuracy, label };
        writeCachedGeo(geoPosition);
        finish(geoPosition);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[geolocation] 调起定位失败，改用城市默认起点：${message}`);
      finish(null);
    }
  });
}

/**
 * 定位一次：
 * 1. 先读 10 分钟缓存（有就直接返回，不再触发 SDK / 授权弹窗）；
 * 2. 没有缓存 → 加载高德 SDK → AMap.Geolocation 定位；
 * 3. 成功写缓存并返回坐标；**任何失败返回 null，绝不抛错**。
 *
 * 并发调用共享同一个 Promise（StrictMode 双挂载 / 页面与地图同时调用都只定位一次）。
 */
export function locateOnce(): Promise<GeoPosition | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (pendingLocate !== null) return pendingLocate;

  // 纪律 1：10 分钟缓存优先。命中就直接返回——不加载 SDK、不调 getCurrentPosition、
  // 不触发授权弹窗（验收 2：10 分钟内刷新页面不允许重新定位）。
  const cached = readCachedGeo();
  if (cached !== null) return Promise.resolve(cached);

  pendingLocate = locateNow().finally(() => {
    pendingLocate = null;
  });
  return pendingLocate;
}
