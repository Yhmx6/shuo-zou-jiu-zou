/**
 * 控制台地点地图的**配色与点样式唯一来源**（本轮新增）。
 *
 * 为什么单独一个文件：
 * - 地图组件（画点）和控制台页面（列表里的小色块）必须用同一份色板，色差会让人以为筛错了；
 * - 颜色 / 尺寸是纯数据 + 纯函数，不依赖 DOM 也不依赖 React，验收脚本可以用 `npx tsx` 直接
 *   import 它做单元断言（本轮数据里 hidden 点为 0，空心圈样式只能在这一层验证，见 build/admin-map-contract.md）。
 *
 * 不许在别处再写一份类目色值：改这里，地图和图例一起变。
 */

import type { CSSProperties } from "react";
import type { PlaceCategory } from "@/types/schema";

/**
 * 类目色板。前 9 个颜色由本轮任务书直接指定；`mall` 是任务书漏掉的一类——
 * types/schema.ts 的 PlaceCategorySchema 实际有 10 类（含商场），不补色会让 mall 的点没有颜色。
 * 补色选了和现有 9 色都拉得开的黄绿 #65a30d（与 park 的绿 / market 的棕黄区分得开）。
 */
export const CATEGORY_COLORS: Record<PlaceCategory, string> = {
  park: "#16a34a",
  bookstore: "#2563eb",
  restaurant: "#ea580c",
  market: "#a16207",
  museum: "#7c3aed",
  theater: "#be123c",
  cafe: "#0891b2",
  gallery: "#c026d3",
  other: "#57534e",
  mall: "#65a30d",
};

/** 图例顺序：任务书写明的 9 类顺序在前，schema 多出来的 mall 排最后。 */
export const LEGEND_CATEGORIES: readonly PlaceCategory[] = [
  "park",
  "bookstore",
  "restaurant",
  "market",
  "museum",
  "theater",
  "cafe",
  "gallery",
  "other",
  "mall",
];

/** 图例文案：10px 字号一行排开要短，语义与控制台页面上的类目名一致。 */
export const CATEGORY_SHORT_LABELS: Record<PlaceCategory, string> = {
  park: "公园",
  bookstore: "书店",
  restaurant: "餐厅",
  market: "市集",
  museum: "博物馆",
  theater: "剧场",
  cafe: "咖啡厅",
  gallery: "美术馆",
  other: "其他",
  mall: "商场",
};

/** 圆点直径（px）：实心 10px + 1px 白边；hidden 同心圆 2px 类目色边框。 */
export const MARKER_DOT_SIZE_PX = 10;

/** 选中时圆点的放大倍数（任务书：点列表某行 → 地图上对应 marker 放大 scale 1.6）。 */
export const MARKER_SELECTED_SCALE = 1.6;

/** 记号点用的白色描边（00-common 允许的硬编码颜色之一）。 */
export const MARKER_OUTLINE_COLOR = "#ffffff";

/**
 * 圆点的内联样式（实心 / 空心两态，任务书第四节）。
 *
 * - 实心：类目色填充 + 1px 白边（box-sizing 让 10px 把边框算进去，视觉直径仍是 10px）；
 * - hidden：透明填充 + 2px 类目色边框（空心圈，仍占 10px）。
 *
 * 返回 CSSProperties 而不是字符串，是为了同时满足 React 内联样式和原生 DOM 的
 * `Object.assign(element.style, ...)`（地图 marker 的 content 是我们自己 createElement 的）。
 */
export function markerDotStyle(category: PlaceCategory, hidden: boolean): CSSProperties {
  const color = CATEGORY_COLORS[category] ?? CATEGORY_COLORS.other;
  return {
    boxSizing: "border-box",
    width: `${MARKER_DOT_SIZE_PX}px`,
    height: `${MARKER_DOT_SIZE_PX}px`,
    borderRadius: "50%",
    backgroundColor: hidden ? "transparent" : color,
    border: hidden ? `2px solid ${color}` : `1px solid ${MARKER_OUTLINE_COLOR}`,
  };
}

/** 选中态的 transform（放大 1.6；transform-origin 由元素样式固定为 center）。 */
export function markerSelectedTransform(): string {
  return `scale(${MARKER_SELECTED_SCALE})`;
}
