import { NextResponse } from "next/server";
import { activeCityId, listCities, loadCity, loadCityConfig } from "@/lib/cityData";
import { distanceMeters } from "@/lib/cityTier";

/** 跨城探测半径的兜底下限（米）：与页面的 GEO_CITY_MAX_DISTANCE_M 同口径。 */
const GEO_RADIUS_MIN_M = 50_000;

/** 城市数据覆盖半径的余量：max(点位到 origin 距离) × 1.25（留出城郊缓冲区）。 */
const GEO_RADIUS_MARGIN_RATIO = 1.25;

/**
 * 「城市数据覆盖半径」：所有地点到城市 origin 的最大直线距离 × 1.25，下限 50km。
 *
 * 为什么不能只写死 50km：北京合并后 origin 在房山苏庄、顺义片区的点位离它 61.6–72.3km，
 * 写死 50km 会把同城的顺义用户误判成「跨城」，丢掉定位、错误地从房山苏庄出发。
 * 城市还没采数据（loadCity 失败）时返回 undefined：页面回退 50km 兜底，下拉照常可用。
 */
function geoRadiusOf(
  cityId: string,
  config: { origin: { latitude: number; longitude: number } },
): number | undefined {
  try {
    const data = loadCity(cityId);
    const origin = { lng: config.origin.longitude, lat: config.origin.latitude };
    let maxDistanceM = 0;
    for (const place of data.places) {
      maxDistanceM = Math.max(maxDistanceM, distanceMeters(origin, { lng: place.lng, lat: place.lat }));
    }
    return Math.max(GEO_RADIUS_MIN_M, Math.ceil((maxDistanceM * GEO_RADIUS_MARGIN_RATIO) / 1000) * 1000);
  } catch {
    return undefined;
  }
}

/**
 * 城市数据模块化：给首屏城市下拉用的只读入口。
 *
 * GET → { ok:true, activeCity, cities:[{ city, displayName, cityCode, transferCityName, origin, thresholds }] }
 *       | { ok:false, reason }
 *
 * 为什么需要这个路由：页面是浏览器端代码，不能读 data/cities/index.json；
 * 这里把「读文件 + zod 校验」全部留在服务端（lib/cityData.ts），前端只拿 JSON。
 *
 * 只读城市配置（loadCityConfig，不要求 places 已采）：
 * - 下拉只需要 id / 名称 / 起点 / 阈值；
 * - 刚加的城市可能还没有 places（fetch:seed 还没跑），不应该把整个下拉拖崩。
 * 地点只通过 /api/plan、/api/swap 返回的行程站点下发，避免把整份 POI 数据塞进前端。
 */
export const dynamic = "force-dynamic";

function failureResponse(reason: string) {
  return NextResponse.json({ ok: false as const, reason }, { status: 200 });
}

export async function GET() {
  try {
    const entries = listCities();
    // 每个城市的配置（含城市码 / 公交城市名 / 起点 / 阈值）都在它自己的文件里，这里逐个读出来给下拉用。
    const cities = entries.map((entry) => {
      const config = loadCityConfig(entry.city);
      const geoRadiusM = geoRadiusOf(entry.city, config);
      return {
        city: config.city,
        displayName: config.displayName,
        cityCode: config.cityCode,
        transferCityName: config.transferCityName,
        origin: config.origin,
        thresholds: config.thresholds,
        // 本轮新增：手写的「现在能规划的区域」清单（问答第 2 步 / 失败提示用）。没有配置就不带。
        ...(config.coverage === undefined ? {} : { coverage: config.coverage }),
        // 跨城边界用：城市数据覆盖半径（米）。老前端不认识这个字段会忽略它。
        ...(geoRadiusM === undefined ? {} : { geoRadiusM }),
      };
    });
    return NextResponse.json({
      ok: true as const,
      activeCity: activeCityId(),
      cities,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[api/cities] 读取城市列表失败：${message}`);
    // 列表读不出来不是「排不出行程」，页面会显示成一行提示；返回 200 + 原因，不抛 500。
    return failureResponse(message);
  }
}
