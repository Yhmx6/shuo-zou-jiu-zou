/**
 * 路名展示小工具（本轮新增）：站点副行与地图文字导航的段标题共用，保证两处口径完全一致。
 *
 * 纯函数，不产生任何地点 / 路名数据（铁律 1）；路名只来自服务端返回的 Segment.road
 * （lib/amap.ts 从高德算路 step 里取的「起步那条路」）。
 */

/** 路名超过这个字数就截断（任务书要求：超过 12 字加省略号）。中文按字数算。 */
export const ROAD_LABEL_MAX_CHARS = 12;

/**
 * 可展示的路名：去掉首尾空白；空串 / 全空白 / undefined → null（调用方据此降级成原来的文案）。
 * 超过 12 个字 → 前 12 个字 + 「…」。
 */
export function roadLabel(road: string | undefined): string | null {
  if (road === undefined) return null;
  const text = road.trim();
  if (text === "") return null;
  if (text.length <= ROAD_LABEL_MAX_CHARS) return text;
  return `${text.slice(0, ROAD_LABEL_MAX_CHARS)}…`;
}

/**
 * 「沿{路名}」前缀；没有可读路名返回 null。
 * 注意：返回的是「沿XX路」，动词由调用方拼（走 / 骑 / 步行 / 骑行……），
 * 这样副行（走过去）和段标题（步行 X 分钟）两套动词都能复用同一个前缀。
 */
export function roadPrefix(road: string | undefined): string | null {
  const label = roadLabel(road);
  return label === null ? null : `沿${label}`;
}
