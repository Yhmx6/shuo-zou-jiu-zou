"use client";

/**
 * 高德 JSAPI 的**唯一加载入口**（本轮新增）。
 *
 * 为什么抽出来：
 * - 页面（启动页就绪探测）、地图组件、定位插件三处都需要 `AMap` 命名空间；
 * - 安全密钥 `window._AMapSecurityConfig` 必须在 `AMapLoader.load` **之前**赋值，
 *   顺序反了会报 INVALID_USER_SCODE。这个顺序只能有一处实现，否则很容易各写各的写反；
 * - @amap/amap-jsapi-loader 自己虽然是模块级状态机，但「缺 key / 失败后重试 / 只发一次请求」
 *   这些边界仍应在项目内统一。
 *
 * 契约：
 * - `loadAMap()` 幂等：并发调用共享同一个 Promise；成功 resolve 成 `window.AMap` 命名空间；
 * - 失败 reject，并清掉缓存的 Promise（下一次调用可以重试，不会留下毒缓存）；
 * - 只负责加载 SDK，不创建地图、不加载业务插件（路线插件由 AmapRouteMap 用 AMap.plugin 加载，
 *   定位插件由 lib/geolocation.ts 用 AMap.plugin 加载）；
 * - 浏览器端专用：服务端调用直接 reject（页面 / 组件都只在客户端 effect 里调它）。
 */

/** 高德 JSAPI 版本（全项目唯一来源；不要再在组件里各写一个）。 */
export const AMAP_JSAPI_VERSION = "2.0";

type AmapLoaderLoad = (options: { key: string; version: string }) => Promise<unknown>;

/** loader 是 UMD 包，webpack 动态导入有时只给 default，这里各种形态都认。 */
type AmapLoaderModule = {
  load?: AmapLoaderLoad;
  default?: AmapLoaderLoad | { load?: AmapLoaderLoad };
};

declare global {
  interface Window {
    /** 高德安全密钥配置（必须在 SDK 加载前赋值）。 */
    _AMapSecurityConfig?: { securityJsCode?: string };
  }
}

/** 已有 Promise 只算一次：并发调用共享同一次加载。 */
let promise: Promise<unknown> | null = null;

/**
 * 从动态 import 的模块里取出 `load` 函数。
 * 兼容 ESM/CJS/UMD 三种导出形态；取不到就抛错（不静默降级成 undefined）。
 */
function resolveLoad(module: AmapLoaderModule): AmapLoaderLoad {
  if (typeof module.load === "function") return module.load;
  const fallback = module.default;
  if (typeof fallback === "function") return fallback;
  if (fallback !== null && typeof fallback === "object" && typeof fallback.load === "function") {
    return fallback.load;
  }
  throw new Error("@amap/amap-jsapi-loader 没有导出 load");
}

/**
 * 加载高德 JSAPI（幂等）。
 *
 * 注意顺序（铁律）：先同步写 `window._AMapSecurityConfig`，再动态 import / load。
 */
export function loadAMap(): Promise<unknown> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("高德 JSAPI 只能在浏览器里加载"));
  }
  if (promise !== null) return promise;

  const key = process.env.NEXT_PUBLIC_AMAP_JS_KEY;
  const securityJsCode = process.env.NEXT_PUBLIC_AMAP_SECURITY_CODE;
  if (!key || !securityJsCode) {
    return Promise.reject(new Error("缺少 NEXT_PUBLIC_AMAP_JS_KEY / NEXT_PUBLIC_AMAP_SECURITY_CODE"));
  }

  // 铁律：安全密钥必须在 load 之前赋值（同步执行，早于下面的动态 import）。
  window._AMapSecurityConfig = { securityJsCode };

  const task = (async (): Promise<unknown> => {
    const loaderModule = (await import("@amap/amap-jsapi-loader")) as unknown as AmapLoaderModule;
    const load = resolveLoad(loaderModule);
    return load({ key, version: AMAP_JSAPI_VERSION });
  })();

  promise = task.catch((error: unknown) => {
    // 失败不留毒缓存：下一次调用（例如用户重新允许网络后刷新前）可以重试。
    promise = null;
    throw error;
  });
  return promise;
}
