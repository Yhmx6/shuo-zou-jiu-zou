"use client";

/**
 * 高德 JSAPI 的「预加载 / 就绪探测」入口（给启动页用）。
 *
 * 历史：本模块最早自带一套 loader（赋值安全密钥 + 动态 import + load）。本轮把「加载 SDK」
 * 收敛到唯一入口 `lib/amapLoader.ts` 的 `loadAMap()`，本模块只保留启动页需要的失败/超时语义：
 *
 * 为什么还需要这个薄包装：
 * 启动页的消失条件是 `Promise.all([城市列表, 地图 SDK 就绪])`。本模块把「加载失败」收敛成
 * 布尔值，并且给加载加一个 10 秒上限；`whenAmapSdkSettled()` 永远 resolve。
 *
 * 铁律：安全密钥顺序、只加载一次的 Promise、版本号，全部由 lib/amapLoader.ts 负责；
 * 本文件**不许**再出现 `_AMapSecurityConfig` / `AMapLoader.load` / 动态 import 高德 loader。
 */

import { loadAMap } from "./amapLoader";

/** 高德 JSAPI 版本（真实版本号在 lib/amapLoader.ts，这里保留导出给旧调用方）。 */
export { AMAP_JSAPI_VERSION as AMAP_SDK_VERSION } from "./amapLoader";

/**
 * 路线插件清单（保留导出兼容旧调用方）。
 * 真正的插件加载在 components/AmapRouteMap.tsx 的 ensureRoutePlugins 里用 AMap.plugin 做；
 * 定位插件在 lib/geolocation.ts 里单独加载。
 */
export const AMAP_SDK_PLUGINS = ["AMap.Walking", "AMap.Riding", "AMap.Transfer", "AMap.Driving"];

/** SDK 加载超时：超时按「未就绪」处理，绝不把页面卡住。 */
const SDK_LOAD_TIMEOUT_MS = 10_000;

/** 已有 promise 只算一次：并发调用共享同一次加载。 */
let pending: Promise<unknown> | null = null;

/** 页面侧环境变量是否齐全（缺 key 时不发任何请求，直接按「未就绪」处理）。 */
export function isAmapSdkConfigured(): boolean {
  const key = process.env.NEXT_PUBLIC_AMAP_JS_KEY;
  const securityJsCode = process.env.NEXT_PUBLIC_AMAP_SECURITY_CODE;
  return !(key === undefined || key === "" || securityJsCode === undefined || securityJsCode === "");
}

/**
 * 加载高德 JSAPI（幂等）。成功 resolve 成 AMap 命名空间；失败 / 超时 reject。
 * 失败时清掉缓存的 promise，下一次调用可以重试（层内不留毒缓存）。
 *
 * 说明：`loadAMap()` 自己也是幂等的；这里的 Promise 包装只额外提供「10 秒超时」语义。
 */
export function loadAmapSdk(): Promise<unknown> {
  if (pending !== null) return pending;
  if (!isAmapSdkConfigured()) {
    return Promise.reject(new Error("缺少 NEXT_PUBLIC_AMAP_JS_KEY / NEXT_PUBLIC_AMAP_SECURITY_CODE"));
  }

  const task = (async (): Promise<unknown> => loadAMap())();
  pending = Promise.race([
    task,
    new Promise<never>((_resolve, reject) => {
      window.setTimeout(() => reject(new Error("高德 JSAPI 加载超时")), SDK_LOAD_TIMEOUT_MS);
    }),
  ]).catch((error: unknown) => {
    pending = null;
    throw error;
  });

  return pending;
}

/**
 * 启动页专用：等「SDK 有结论」，**永远 resolve**。
 * true = 已就绪；false = 缺 key / 加载失败 / 超时。
 */
export async function whenAmapSdkSettled(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  if (!isAmapSdkConfigured()) return false;
  try {
    await loadAmapSdk();
    return true;
  } catch {
    return false;
  }
}
