#!/usr/bin/env node
/**
 * /admin 地点列表配地图 · 浏览器级验收（scripts/verify/admin-map-acceptance.mjs）
 *
 * 本轮任务书：（内部文档，第三节 9 条验收）
 * 本轮契约：build/admin-map-contract.md（§4 DOM/调试钩子、§5 机器断言、§6 写入范围）
 *
 * 覆盖（逐条对应任务书第三节 + 契约 §5 的「另外必测」）：
 *   验收 1：打开 /admin → rows=116 / markers=116 / mapReady=true / drawCount=1 / fitViewCount=1 / 截图
 *   验收 2：类目「公园」→ rows=38 / markers=38 / 全部 park 色 rgb(22,163,74) / fitViewCount 递增 / center 在 bbox 内
 *   验收 3：搜索「美术馆」→ rows=2 / markers=2 / markerIds 与接口一致
 *   验收 4：点第 3 行 → selectedId / selectedScale=1.6 / marker data-selected / center≈点坐标（≤1e-6）/ drawCount 不变
 *   验收 5：点可见 marker → 对应行 data-highlight=true 且在视口内 / 高亮背景生效 / selectedId 不变
 *   验收 6：开关「显示已隐藏」不报错、rows/markers 仍 116；空心圈样式用 npx tsx 单测 markerDotStyle() 覆盖
 *           （本轮数据 hidden=0，浏览器里不会出现空心圈，报告写明原因）
 *   验收 7：切辽阳 rows=141 / markers=141 / fitViewCount 递增 / center 在辽阳 bbox → 切回北京 rows=116
 *   验收 8：CDP 滚轮缩放 + 拖拽 → debug.zoom 或 center 变化且 drawCount 不变
 *   验收 9：Network.setBlockedURLs 屏蔽 *webapi.amap.com* → 出现 [data-testid="admin-map-error"]
 *           文案「地图加载失败，不影响编辑」，rows 仍 116、编辑按钮仍可见
 *   布局 1280×900：列表在左、地图在右，宽度 ≈60/40（±8%），地图列 position:sticky; top:16px
 *   布局 390×844：地图在列表上方、高度 ≈320px（±2）、宽度撑满
 *   活动 tab ↔ 地点 tab：切回来地图仍可见（marker 仍在 / resizeCount ≥1）
 *   控制台无 error（AMap 资源类噪声按 build/verify/map-plugin-smoke.mjs 的既有口径过滤）
 *   回归：node scripts/verify/admin-ui.mjs 仍 PASS
 *
 * 跑法（项目根目录；dev server 已在 http://127.0.0.1:3000，不要重启 / 不要另起端口）：
 *   node scripts/verify/admin-map-acceptance.mjs
 *   node scripts/verify/admin-map-acceptance.mjs --no-regression   # 调试用：跳过 admin-ui 回归
 *   node scripts/verify/admin-map-acceptance.mjs --dump-unit-source # 只生成空心圈单测文件（不跑浏览器）
 *
 * 硬约束（本轮任务要求）：
 * - 只读：只调用 GET 接口，绝不 POST/PATCH/DELETE /api/admin/places，不写 data/*.json；
 * - 浏览器独占：跑之前建 build/.verify-lock（内容 verifier-map），跑完删；锁已存在等 60s 重试，最多 5 分钟；
 * - 不新增 npm 依赖（只用 Node 22 + scripts/verify/lib.mjs 的 CDP 公共库 + 本地 tsx）；
 * - 交互用 DOM 合成事件（原生 value/checked setter + dispatchEvent），手势用 CDP Input.dispatchMouseEvent；
 * - 产物：截图 .cache/verify/*.png、报告 build/reports/admin-map/acceptance.md + acceptance.json；
 * - 退出码：0 = 全部 PASS；1 = 有 FAIL（脚本自身异常也记 FAIL）。
 */

import {
  BASE_URL,
  ROOT,
  apiGet,
  closeEdge,
  connectPage,
  createConsoleCollector,
  createReport,
  launchEdge,
  screenshot,
  sleep,
  waitForEvaluate,
} from "./lib.mjs";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* ------------------------------------------------------------------ *
 * 常量 / 目录 / 锁
 * ------------------------------------------------------------------ */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = ROOT;
const ADMIN_URL = `${BASE_URL}/admin`;
const LOCK = path.join(ROOT_DIR, "build", ".verify-lock");
const LOCK_NAME = "verifier-map";
const REPORT_DIR = path.join(ROOT_DIR, "build", "reports", "admin-map");
const STYLE_UNIT_FILE = path.join(ROOT_DIR, ".cache", "verify", "admin-map-style-unit.mts");
const VIEWPORT_DESKTOP = { width: 1280, height: 900 };
const VIEWPORT_NARROW = { width: 390, height: 844 };

const REPORT = createReport("/admin 地点列表配地图 · 验收");
const ROWS = [];

const ARGS = process.argv.slice(2);
const SKIP_REGRESSION = ARGS.includes("--no-regression");
const DUMP_UNIT_SOURCE = ARGS.includes("--dump-unit-source");

/** 数据契约（build/admin-map-contract.md §1，环境事实；对不上就是环境漂移，要报 Lead）。 */
const EXPECTED = {
  beijingTotal: 116,
  parkCount: 38,
  searchCount: 2,
  searchIds: ["B0G3JX9RRQ", "B0G0UCOGY5"],
  liaoyangTotal: 141,
};

/** 色板：任务书 9 色 + schema 多出来的 mall（契约 §3）。 */
const CATEGORY_HEX = {
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
const LEGEND_ORDER = Object.keys(CATEGORY_HEX);
/** 验收 2 的公园主色（rgb(22, 163, 74)）单独提出来，断言/证据共用。 */
const EXPECTED_PARK_HEX = CATEGORY_HEX.park;
const CATEGORY_LABELS = {
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

/** 分组（报告按此顺序组织，验收 1–9 一一对应）。 */
const GROUPS = {
  data: "0. 环境与数据探活",
  accept1: "1. 验收 1：打开 /admin，列表 + 地图 116 点",
  layoutDesktop: "L. 布局 1280×900（桌面分栏 + sticky）",
  accept2: "2. 验收 2：类目「公园」38 点 + 配色 + 视野",
  accept3: "3. 验收 3：搜索「美术馆」→ 2 点",
  accept4: "4. 验收 4：点列表第 3 行 → 放大 + 居中",
  accept5: "5. 验收 5：点地图 marker → 列表滚动 + 高亮",
  accept6: "6. 验收 6：显示已隐藏 + 空心圈单元断言",
  accept7: "7. 验收 7：切城市 北京 ↔ 辽阳",
  accept8: "8. 验收 8：滚轮/拖动不重画",
  accept9: "9. 验收 9：地图加载失败降级",
  layoutNarrow: "N. 布局 390×844（窄屏地图在上 320px）",
  tab: "TAB. 活动 tab ↔ 地点 tab",
  console: "CON. 控制台无 error",
  regression: "REG. 回归 node scripts/verify/admin-ui.mjs",
  self: "SELF. 只读约束自检",
};
const GROUP_ORDER = Object.values(GROUPS);

/** 本轮验收对象（实现文件 SHA256 前 16 位；Lead 冻结版本，用于报告/复核跑的是哪一版）。 */
const EXPECTED_IMPL_HASHES = {
  "components/AdminPlacesMap.tsx": "B54EDAA0E512E198",
  "components/adminMapStyle.ts": "E376D3C9B9BFE23D",
  "app/admin/page.tsx": "7CB2D0E60B50A778",
};

/** 控制台 error 过滤（与 build/verify/map-plugin-smoke.mjs 同口径：AMap 资源类噪声不算）。 */
const CONSOLE_NOISE = /AMap|INVALID_USER_DOMAIN|amap|favicon|Failed to load resource|ERR_NETWORK|ERR_BLOCKED_BY_CLIENT|WebSocket connection|\[HMR\]|\[Fast Refresh\]/;

/* ------------------------------------------------------------------ *
 * 探针表达式（页面内执行）
 * ------------------------------------------------------------------ */

const DEBUG_SNAPSHOT_CODE = String.raw`(() => {
  const debug = window.__ADMIN_MAP_DEBUG__;
  if (debug === undefined || debug === null) return null;
  const rawCenter = typeof debug.center === "function" ? debug.center() : debug.center;
  let center = null;
  if (rawCenter !== null && rawCenter !== undefined && typeof rawCenter === "object") {
    const lng = typeof rawCenter.lng === "number" ? rawCenter.lng : typeof rawCenter.getLng === "function" ? rawCenter.getLng() : NaN;
    const lat = typeof rawCenter.lat === "number" ? rawCenter.lat : typeof rawCenter.getLat === "function" ? rawCenter.getLat() : NaN;
    if (Number.isFinite(lng) && Number.isFinite(lat)) center = { lng: lng, lat: lat };
  }
  return {
    mapReady: debug.mapReady === true,
    error: typeof debug.error === "string" ? debug.error : "",
    drawCount: Number(debug.drawCount) || 0,
    fitViewCount: Number(debug.fitViewCount) || 0,
    markerCount: Number(debug.markerCount) || 0,
    markerIds: Array.isArray(debug.markerIds) ? debug.markerIds.map(String) : [],
    selectedId: typeof debug.selectedId === "string" ? debug.selectedId : null,
    selectedScale: typeof debug.selectedScale === "number" ? debug.selectedScale : null,
    center: center,
    zoom: typeof debug.zoom === "number" ? debug.zoom : null,
    resizeCount: Number(debug.resizeCount) || 0,
  };
})()`;

const PAGE_STATE_EXPR = String.raw`(() => {
  const debug = ${DEBUG_SNAPSHOT_CODE};
  const list = document.querySelector('[data-testid="admin-places-list"]');
  const bodyText = document.body.innerText || "";
  const totalMatch = bodyText.match(/共\s*\d+\s*个地点/);
  return {
    readyState: document.readyState,
    hasList: list !== null,
    rows: list === null ? 0 : list.querySelectorAll('[data-row-place-id]').length,
    totalText: totalMatch === null ? null : totalMatch[0],
    hasMapSection: document.querySelector('[data-testid="admin-places-map"]') !== null,
    hasCanvas: document.querySelector('[data-testid="admin-map-canvas"]') !== null,
    hasMapError: document.querySelector('[data-testid="admin-map-error"]') !== null,
    mapErrorText: (() => {
      const element = document.querySelector('[data-testid="admin-map-error"]');
      return element === null ? null : (element.textContent || "").trim();
    })(),
    markerDomCount: document.querySelectorAll('[data-map-marker="true"]').length,
    debug: debug,
  };
})()`;

const ROW_IDS_EXPR = String.raw`(() => [...document.querySelectorAll('[data-testid="admin-places-list"] [data-row-place-id]')].map((row) => row.getAttribute('data-row-place-id')))()`;

const MARKER_DOM_EXPR = String.raw`(() => {
  const colorOf = (value) => {
    const raw = String(value === undefined || value === null ? "" : value);
    const rgba = /rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+))?\s*\)/.exec(raw);
    if (rgba !== null) {
      return { r: Number(rgba[1]), g: Number(rgba[2]), b: Number(rgba[3]), a: rgba[4] === undefined ? 1 : Number(rgba[4]), raw: raw };
    }
    return { r: null, g: null, b: null, a: null, raw: raw };
  };
  return [...document.querySelectorAll('[data-map-marker="true"]')].map((wrapper) => {
    const dot = wrapper.querySelector('[data-map-dot="true"]');
    const wrapperStyle = getComputedStyle(wrapper);
    const dotStyle = dot === null ? null : getComputedStyle(dot);
    return {
      placeId: wrapper.getAttribute("data-place-id"),
      category: wrapper.getAttribute("data-category"),
      hidden: wrapper.getAttribute("data-hidden"),
      selected: wrapper.getAttribute("data-selected"),
      dot: dot === null ? null : {
        width: dotStyle.width,
        height: dotStyle.height,
        borderRadius: dotStyle.borderRadius,
        boxSizing: dotStyle.boxSizing,
        backgroundColor: colorOf(dotStyle.backgroundColor),
        borderTopWidth: dotStyle.borderTopWidth,
        borderTopStyle: dotStyle.borderTopStyle,
        borderTopColor: colorOf(dotStyle.borderTopColor),
        transform: dotStyle.transform,
      },
      wrapper: { width: wrapperStyle.width, height: wrapperStyle.height, cursor: wrapperStyle.cursor },
    };
  });
})()`;

/**
 * 图例 DOM（contract §4.2 最新口径）：
 * - 外层 label `span[data-legend-item="{category}"]` 只放文案；
 * - 有背景色的色块 span 才挂 `data-legend-category` + `data-legend-swatch="true"`，
 *   对 `[data-legend-category]` 读 computed backgroundColor 才是类目色。
 */
const LEGEND_EXPR = String.raw`(() => {
  const legend = document.querySelector('[data-testid="admin-map-legend"]');
  if (legend === null) return { exists: false };
  const style = getComputedStyle(legend);
  const rect = legend.getBoundingClientRect();
  const items = [...legend.querySelectorAll('[data-legend-item]')].map((item) => {
    const swatch = item.querySelector('[data-legend-category]');
    const swatchStyle = swatch === null ? null : getComputedStyle(swatch);
    return {
      category: item.getAttribute("data-legend-item"),
      label: (item.textContent || "").trim(),
      swatchCategory: swatch === null ? null : swatch.getAttribute("data-legend-category"),
      swatchFlag: swatch === null ? null : swatch.getAttribute("data-legend-swatch"),
      swatchTag: swatch === null ? null : swatch.tagName,
      swatchBackground: swatchStyle === null ? null : swatchStyle.backgroundColor,
    };
  });
  const swatches = [...legend.querySelectorAll('[data-legend-category]')].map((swatch) => {
    const swatchStyle = getComputedStyle(swatch);
    const swatchRect = swatch.getBoundingClientRect();
    return {
      category: swatch.getAttribute("data-legend-category"),
      swatchFlag: swatch.getAttribute("data-legend-swatch"),
      backgroundColor: swatchStyle.backgroundColor,
      width: Math.round(swatchRect.width * 10) / 10,
      height: Math.round(swatchRect.height * 10) / 10,
    };
  });
  return {
    exists: true,
    fontSize: style.fontSize,
    lineHeight: style.lineHeight,
    position: style.position,
    pointerEvents: style.pointerEvents,
    bottom: style.bottom,
    rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height, bottom: rect.bottom },
    items: items,
    swatches: swatches,
    hasImage: legend.querySelector("img, svg") !== null,
    hasEmoji: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(legend.textContent || ""),
  };
})()`;

const LAYOUT_EXPR = String.raw`(() => {
  const rectOf = (element) => {
    if (element === null) return null;
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
  };
  const styleOf = (element) => {
    if (element === null) return null;
    const style = getComputedStyle(element);
    return { position: style.position, top: style.top, overflowX: style.overflowX, overflowY: style.overflowY, display: style.display };
  };
  const list = document.querySelector('[data-testid="admin-places-list"]');
  const section = document.querySelector('[data-testid="admin-places-map"]');
  const canvas = document.querySelector('[data-testid="admin-map-canvas"]');
  let sticky = null;
  if (section !== null) {
    let element = section.parentElement;
    for (let level = 0; level < 6 && element !== null; level += 1) {
      const style = getComputedStyle(element);
      if (style.position === "sticky") {
        sticky = { level: level, position: style.position, top: style.top, className: String(element.className) };
        break;
      }
      element = element.parentElement;
    }
  }
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    scrollY: window.scrollY,
    list: { rect: rectOf(list), style: styleOf(list) },
    section: { rect: rectOf(section), style: styleOf(section) },
    sectionParent: { rect: rectOf(section === null ? null : section.parentElement), clientWidth: section === null || section.parentElement === null ? null : section.parentElement.clientWidth },
    canvas: { rect: rectOf(canvas), childCount: canvas === null ? null : canvas.childElementCount, hasAmapContainer: document.querySelector('[data-testid="admin-map-canvas"] .amap-container') !== null },
    sticky: sticky,
  };
})()`;

const MAP_SURFACE_EXPR = String.raw`(() => {
  const section = document.querySelector('[data-testid="admin-places-map"]');
  const canvas = document.querySelector('[data-testid="admin-map-canvas"]');
  const legend = document.querySelector('[data-testid="admin-map-legend"]');
  const rectOf = (element) => {
    if (element === null) return null;
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  };
  const styleOf = (element) => {
    if (element === null) return null;
    const style = getComputedStyle(element);
    return { position: style.position, overflowX: style.overflowX, overflowY: style.overflowY, display: style.display };
  };
  return {
    section: { rect: rectOf(section), style: styleOf(section) },
    canvas: { rect: rectOf(canvas), childCount: canvas === null ? null : canvas.childElementCount, hasAmapContainer: document.querySelector('[data-testid="admin-map-canvas"] .amap-container') !== null },
    legend: { rect: rectOf(legend) },
    controls: document.querySelectorAll('[data-testid="admin-map-canvas"] .amap-control, [data-testid="admin-map-canvas"] .amap-logo, [data-testid="admin-map-canvas"] .amap-copyright').length,
    hasError: document.querySelector('[data-testid="admin-map-error"]') !== null,
  };
})()`;

const MAP_HIDDEN_STATE_EXPR = String.raw`(() => {
  const section = document.querySelector('[data-testid="admin-places-map"]');
  if (section === null) return { exists: false, visible: false };
  const rect = section.getBoundingClientRect();
  const style = getComputedStyle(section);
  const ancestorsVisible = (() => {
    let element = section;
    for (let level = 0; level < 6 && element !== null; level += 1) {
      const ancestorStyle = getComputedStyle(element);
      if (ancestorStyle.display === "none" || ancestorStyle.visibility === "hidden") return false;
      element = element.parentElement;
    }
    return true;
  })();
  return {
    exists: true,
    visible: rect.width > 0 && rect.height > 0 && style.display !== "none" && ancestorsVisible,
    rect: { width: rect.width, height: rect.height },
    rows: document.querySelectorAll('[data-testid="admin-places-list"] [data-row-place-id]').length,
    markerDomCount: document.querySelectorAll('[data-map-marker="true"]').length,
  };
})()`;

const TAB_STATE_EXPR = String.raw`(() => {
  const tabs = [...document.querySelectorAll('[role="tab"]')].map((tab) => ({ text: (tab.textContent || "").trim(), selected: tab.getAttribute("aria-selected") }));
  const bodyText = document.body.innerText || "";
  const debug = ${DEBUG_SNAPSHOT_CODE};
  return {
    tabs: tabs,
    hasEventsHeading: bodyText.indexOf("活动列表") !== -1,
    rows: document.querySelectorAll('[data-testid="admin-places-list"] [data-row-place-id]').length,
    markerDomCount: document.querySelectorAll('[data-map-marker="true"]').length,
    debug: debug,
  };
})()`;

const VIEW_PROBE_EXPR = String.raw`(() => {
  const debug = ${DEBUG_SNAPSHOT_CODE};
  const markers = [...document.querySelectorAll('[data-map-marker="true"]')].slice(0, 8).map((element) => {
    const rect = element.getBoundingClientRect();
    return { id: element.getAttribute("data-place-id"), left: Math.round(rect.left * 100) / 100, top: Math.round(rect.top * 100) / 100 };
  });
  return { debug: debug, markers: markers };
})()`;

const MAP_ERROR_STATE_EXPR = String.raw`(() => {
  const error = document.querySelector('[data-testid="admin-map-error"]');
  const rect = error === null ? null : error.getBoundingClientRect();
  const list = document.querySelector('[data-testid="admin-places-list"]');
  const debug = ${DEBUG_SNAPSHOT_CODE};
  const visibleEditButtons = [...document.querySelectorAll('[data-testid="admin-places-list"] button')].filter((button) => {
    return (button.textContent || "").trim() === "编辑" && !button.disabled && button.getClientRects().length > 0;
  });
  return {
    readyState: document.readyState,
    hasError: error !== null,
    errorText: error === null ? null : (error.textContent || "").trim(),
    errorVisible: rect !== null && rect.width > 0 && rect.height > 0,
    rows: list === null ? 0 : list.querySelectorAll('[data-row-place-id]').length,
    hasList: list !== null,
    hasMapSection: document.querySelector('[data-testid="admin-places-map"]') !== null,
    editButtons: visibleEditButtons.length,
    debug: debug,
    bodyText: (document.body.innerText || "").slice(0, 300),
  };
})()`;

/** 列表行状态（点 marker 后高亮 / 是否在视口内）。 */
function exprRowState(placeId) {
  return `(() => {
    const id = ${JSON.stringify(placeId)};
    const list = document.querySelector('[data-testid="admin-places-list"]');
    const row = list === null ? null : [...list.querySelectorAll('[data-row-place-id]')].find((element) => element.getAttribute("data-row-place-id") === id) || null;
    if (row === null) return { exists: false };
    const rect = row.getBoundingClientRect();
    const style = getComputedStyle(row);
    const debug = ${DEBUG_SNAPSHOT_CODE};
    return {
      exists: true,
      highlight: row.getAttribute("data-highlight"),
      inViewport: rect.top >= 0 && rect.bottom <= window.innerHeight && rect.left >= 0 && rect.right <= window.innerWidth,
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      backgroundColor: style.backgroundColor,
      className: String(row.className),
      scrollY: window.scrollY,
      selectedId: debug === null ? null : debug.selectedId,
    };
  })()`;
}

/** 单个 marker 的选中态 / 样式。 */
function exprMarkerState(placeId) {
  return `(() => {
    const id = ${JSON.stringify(placeId)};
    const marker = [...document.querySelectorAll('[data-map-marker="true"]')].find((element) => element.getAttribute("data-place-id") === id) || null;
    if (marker === null) return { exists: false };
    const dot = marker.querySelector('[data-map-dot="true"]');
    const rect = marker.getBoundingClientRect();
    const dotStyle = dot === null ? null : getComputedStyle(dot);
    return {
      exists: true,
      selected: marker.getAttribute("data-selected"),
      category: marker.getAttribute("data-category"),
      hidden: marker.getAttribute("data-hidden"),
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      dot: dotStyle === null ? null : { transform: dotStyle.transform, backgroundColor: dotStyle.backgroundColor, borderTopWidth: dotStyle.borderTopWidth, borderTopColor: dotStyle.borderTopColor },
      selectedCount: document.querySelectorAll('[data-map-marker="true"][data-selected="true"]').length,
      selectedIds: [...document.querySelectorAll('[data-map-marker="true"][data-selected="true"]')].map((element) => element.getAttribute("data-place-id")),
    };
  })()`;
}

/** 挑选一个「可见且不是当前选中」的 marker（用于验收 5）。 */
function exprPickVisibleMarker(excludeId) {
  return `(() => {
    const exclude = ${JSON.stringify(excludeId)};
    const canvas = document.querySelector('[data-testid="admin-map-canvas"]');
    const canvasRect = canvas === null ? null : canvas.getBoundingClientRect();
    const rows = [...document.querySelectorAll('[data-testid="admin-places-list"] [data-row-place-id]')];
    const rowIndex = new Map(rows.map((row, index) => [row.getAttribute("data-row-place-id"), index]));
    const markers = [...document.querySelectorAll('[data-map-marker="true"]')];
    const candidates = markers.map((element) => {
      const rect = element.getBoundingClientRect();
      const id = element.getAttribute("data-place-id");
      const index = rowIndex.has(id) ? rowIndex.get(id) : -1;
      const inCanvas = canvasRect !== null && rect.width > 0 && rect.height > 0 &&
        rect.left >= canvasRect.left - 2 && rect.right <= canvasRect.right + 2 &&
        rect.top >= canvasRect.top - 2 && rect.bottom <= canvasRect.bottom + 2;
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const inViewport = x >= 0 && x <= window.innerWidth && y >= 0 && y <= window.innerHeight;
      return { id: id, index: index, inCanvas: inCanvas, inViewport: inViewport, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
    });
    const usable = candidates.filter((item) => item.id !== exclude && item.inCanvas).sort((left, right) => right.index - left.index);
    const fallback = candidates.filter((item) => item.id !== exclude && item.inViewport).sort((left, right) => right.index - left.index);
    const chosen = usable.length > 0 ? usable[0] : fallback.length > 0 ? fallback[0] : null;
    return {
      chosen: chosen,
      usableCount: usable.length,
      fallbackCount: fallback.length,
      total: candidates.length,
      canvasRect: canvasRect === null ? null : { left: canvasRect.left, top: canvasRect.top, width: canvasRect.width, height: canvasRect.height },
    };
  })()`;
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

const sleepSafe = (ms) => sleep(ms);

function messageText(error) {
  return error instanceof Error ? error.message : String(error);
}

function truncate(value, maxLength) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}…（截断，原长 ${text.length}）` : text;
}

function rel(filePath) {
  if (filePath === null || filePath === undefined) return "(无)";
  return path.relative(ROOT_DIR, filePath).replace(/\\/g, "/");
}

function hexToRgb(hex) {
  const value = String(hex).replace("#", "");
  return { r: parseInt(value.slice(0, 2), 16), g: parseInt(value.slice(2, 4), 16), b: parseInt(value.slice(4, 6), 16) };
}

function rgbText(hex) {
  const { r, g, b } = hexToRgb(hex);
  return `rgb(${r}, ${g}, ${b})`;
}

function colorEquals(color, hex) {
  if (color === null || color === undefined) return false;
  const target = hexToRgb(hex);
  return color.r === target.r && color.g === target.g && color.b === target.b;
}

function isTransparentColor(color) {
  if (color === null || color === undefined) return false;
  if (String(color.raw ?? "").trim() === "transparent") return true;
  return color.a === 0;
}

function arraysEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function setEquals(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (leftSet.size !== rightSet.size) return false;
  for (const value of leftSet) if (!rightSet.has(value)) return false;
  return true;
}

function fmtDebug(debug) {
  if (debug === null || debug === undefined) return "debug=null";
  const center = debug.center === null || debug.center === undefined ? "null" : `(${debug.center.lng}, ${debug.center.lat})`;
  return `mapReady=${debug.mapReady}；drawCount=${debug.drawCount}；fitViewCount=${debug.fitViewCount}；markerCount=${debug.markerCount}；center=${center}；zoom=${debug.zoom}；selectedId=${debug.selectedId}；selectedScale=${debug.selectedScale}；resizeCount=${debug.resizeCount}`;
}

function bboxOf(places) {
  const values = places.filter((place) => typeof place.lng === "number" && typeof place.lat === "number");
  if (values.length === 0) return null;
  return {
    minLng: Math.min(...values.map((place) => place.lng)),
    maxLng: Math.max(...values.map((place) => place.lng)),
    minLat: Math.min(...values.map((place) => place.lat)),
    maxLat: Math.max(...values.map((place) => place.lat)),
  };
}

function centerInBbox(center, bbox, margin = 0.002) {
  if (center === null || bbox === null) return false;
  return (
    center.lng >= bbox.minLng - margin &&
    center.lng <= bbox.maxLng + margin &&
    center.lat >= bbox.minLat - margin &&
    center.lat <= bbox.maxLat + margin
  );
}

function fmtBbox(bbox) {
  if (bbox === null) return "(无)";
  return `lng[${bbox.minLng.toFixed(6)}, ${bbox.maxLng.toFixed(6)}] lat[${bbox.minLat.toFixed(6)}, ${bbox.maxLat.toFixed(6)}]`;
}

function centerNear(center, place, tolerance = 1e-6) {
  if (center === null || place === null) return false;
  return Math.abs(center.lng - place.lng) <= tolerance && Math.abs(center.lat - place.lat) <= tolerance;
}

/* ------------------------------------------------------------------ *
 * 结果记录
 * ------------------------------------------------------------------ */

function addCheck(state, group, id, name, status, expected, actual) {
  const entry = {
    group: group,
    id: id,
    name: name,
    status: status,
    expected: truncate(String(expected), 500),
    actual: truncate(String(actual), 900),
  };
  state.checks.push(entry);
  const line = `期望 ${entry.expected}；实际 ${entry.actual}`;
  if (status === "PASS") REPORT.pass(`${id} ${name}`, line);
  else if (status === "FAIL") REPORT.fail(`${id} ${name}`, line);
  else REPORT.skip(`${id} ${name}`, line);
  return status === "PASS";
}

function check(state, group, id, name, condition, expected, actual) {
  return addCheck(state, group, id, name, condition ? "PASS" : "FAIL", expected, actual);
}

function skipCheck(state, group, id, name, reason) {
  return addCheck(state, group, id, name, "SKIP", "(前置条件)：", reason);
}

function infoLog(message) {
  REPORT.info(message);
}

/* ------------------------------------------------------------------ *
 * 锁 / 目录 / 截图
 * ------------------------------------------------------------------ */

async function acquireLock() {
  const deadline = Date.now() + 5 * 60 * 1000;
  for (;;) {
    if (!existsSync(LOCK)) {
      try {
        writeFileSync(LOCK, LOCK_NAME, { flag: "wx" });
        console.log(`[lock] 已获取 build/.verify-lock（${LOCK_NAME}）`);
        return;
      } catch (error) {
        if (error === null || error === undefined || error.code !== "EEXIST") throw error;
      }
    }
    const owner = existsSync(LOCK) ? readFileSync(LOCK, "utf8").trim() : "(未知)";
    if (Date.now() > deadline) throw new Error(`build/.verify-lock 被「${owner}」占用超过 5 分钟，需要 Lead 协调`);
    console.log(`[lock] build/.verify-lock 被「${owner}」占用，60s 后重试…`);
    await sleepSafe(60_000);
  }
}

function releaseLock() {
  try {
    if (existsSync(LOCK)) {
      unlinkSync(LOCK);
      console.log("[lock] 已释放 build/.verify-lock");
    }
  } catch {
    /* ignore */
  }
}

function ensureDirs() {
  for (const dir of [REPORT_DIR, path.dirname(STYLE_UNIT_FILE)]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

async function safeShot(cdp, state, name) {
  try {
    const result = await screenshot(cdp, name);
    state.screenshots[name] = result.path;
    return result;
  } catch (error) {
    state.screenshots[name] = null;
    console.warn(`[shot] 截图失败 ${name}：${messageText(error)}`);
    return null;
  }
}

async function readPageState(cdp) {
  try {
    return await cdp.evaluate(PAGE_STATE_EXPR);
  } catch {
    return null;
  }
}

async function readDebug(cdp) {
  try {
    return await cdp.evaluate(DEBUG_SNAPSHOT_CODE);
  } catch {
    return null;
  }
}

/**
 * 等地图视野「真正停下来」：连续 3 次采样（间隔 250ms）center/zoom 完全一致才算稳定。
 * 切城市 / setFitView / setCenter 后 AMap 有动画，手 gestures 必须在动画结束后做，
 * 否则会把动画途中的位移误当成手势效果（run2 就踩过这个坑）。
 */
async function waitViewSettled(cdp, label, timeoutMs = 12000) {
  const startedAt = Date.now();
  let previousKey = null;
  let stableCount = 0;
  let latest = null;
  while (Date.now() - startedAt < timeoutMs) {
    latest = await readDebug(cdp);
    const key =
      latest === null
        ? "null"
        : `${latest.center === null ? "null" : `${latest.center.lng},${latest.center.lat}`}|${latest.zoom}|${latest.drawCount}`;
    if (previousKey !== null && key === previousKey) stableCount += 1;
    else stableCount = 0;
    previousKey = key;
    if (stableCount >= 2) {
      console.log(`[view] ${label}：视野已稳定（${key}，${Date.now() - startedAt}ms）`);
      return latest;
    }
    await sleepSafe(250);
  }
  console.log(`[view] ${label}：等待视野稳定超时（${timeoutMs}ms），用当前值继续`);
  return latest === null ? await readDebug(cdp) : latest;
}

/* ------------------------------------------------------------------ *
 * 前置：dev server + 数据探活（只读 GET）
 * ------------------------------------------------------------------ */

async function probeEnvironment(state) {
  const group = GROUPS.data;

  const page = await apiGet("/admin", { timeoutMs: 120000 });
  check(
    state,
    group,
    "0.1",
    "dev server /admin 可访问（HTTP 200 + 本地控制台）",
    page.status === 200 && String(page.text).includes("本地控制台"),
    "HTTP 200，HTML 含「本地控制台」",
    `HTTP ${page.status}，${page.ms} ms，HTML ${String(page.text).length} 字符`,
  );

  const cities = await apiGet("/api/cities", { timeoutMs: 30000 });
  const cityIds = cities.json !== null && Array.isArray(cities.json.cities) ? cities.json.cities.map((city) => city.city) : [];
  check(
    state,
    group,
    "0.2",
    "/api/cities 可访问且包含 beijing / liaoyang",
    cities.status === 200 && cities.json?.ok === true && cityIds.includes("beijing") && cityIds.includes("liaoyang"),
    "HTTP 200 + 城市索引含 beijing、liaoyang",
    `HTTP ${cities.status}，城市=${cityIds.join(",")}`,
  );

  const beijing = await apiGet("/api/admin/places?city=beijing&includeHidden=1", { timeoutMs: 60000 });
  const beijingPlaces = beijing.json !== null && Array.isArray(beijing.json.places) ? beijing.json.places : [];
  const beijingHidden = beijingPlaces.filter((place) => place.hidden === true).length;
  state.data.beijingIds = beijingPlaces.map((place) => place.id);
  state.data.beijingHidden = beijingHidden;
  state.data.beijingBbox = bboxOf(beijingPlaces);
  state.data.beijingPlaces = beijingPlaces;
  state.data.beijingByName = new Map(beijingPlaces.map((place) => [place.id, place]));
  check(
    state,
    group,
    "0.3",
    `北京数据：${EXPECTED.beijingTotal} 条、hidden=0（契约 §1）`,
    beijingPlaces.length === EXPECTED.beijingTotal && beijingHidden === 0,
    `${EXPECTED.beijingTotal} 条，hidden=0`,
    `${beijingPlaces.length} 条，hidden=${beijingHidden}（HTTP ${beijing.status}）`,
  );

  const park = await apiGet("/api/admin/places?city=beijing&category=park", { timeoutMs: 60000 });
  const parkPlaces = park.json !== null && Array.isArray(park.json.places) ? park.json.places : [];
  state.data.parkIds = parkPlaces.map((place) => place.id);
  state.data.parkBbox = bboxOf(parkPlaces);
  const parkLocal = beijingPlaces.filter((place) => place.category === "park");
  check(
    state,
    group,
    "0.4",
    `公园筛选：${EXPECTED.parkCount} 条（接口与北京全量按 category=park 过滤一致）`,
    parkPlaces.length === EXPECTED.parkCount && setEquals(parkPlaces.map((place) => place.id), parkLocal.map((place) => place.id)),
    `${EXPECTED.parkCount} 条，ids 与本地过滤一致；bbox=${fmtBbox(state.data.parkBbox)}`,
    `${parkPlaces.length} 条（期望 ${EXPECTED.parkCount}），bbox=${fmtBbox(state.data.parkBbox)}`,
  );

  const search = await apiGet(`/api/admin/places?city=beijing&q=${encodeURIComponent("美术馆")}`, { timeoutMs: 60000 });
  const searchPlaces = search.json !== null && Array.isArray(search.json.places) ? search.json.places : [];
  state.data.searchIds = searchPlaces.map((place) => place.id);
  state.data.searchPlaces = searchPlaces;
  check(
    state,
    group,
    "0.5",
    `搜索「美术馆」：${EXPECTED.searchCount} 条且 ids 与契约一致`,
    searchPlaces.length === EXPECTED.searchCount && setEquals(state.data.searchIds, EXPECTED.searchIds),
    `${EXPECTED.searchCount} 条：${EXPECTED.searchIds.join(",")}`,
    `${searchPlaces.length} 条：${state.data.searchIds.join(",")}`,
  );

  const liaoyang = await apiGet("/api/admin/places?city=liaoyang", { timeoutMs: 60000 });
  const liaoyangPlaces = liaoyang.json !== null && Array.isArray(liaoyang.json.places) ? liaoyang.json.places : [];
  state.data.liaoyangIds = liaoyangPlaces.map((place) => place.id);
  state.data.liaoyangPlaces = liaoyangPlaces;
  state.data.liaoyangBbox = bboxOf(liaoyangPlaces);
  state.data.liaoyangByName = new Map(liaoyangPlaces.map((place) => [place.id, place]));
  check(
    state,
    group,
    "0.6",
    `辽阳数据：${EXPECTED.liaoyangTotal} 条（契约 §1）`,
    liaoyangPlaces.length === EXPECTED.liaoyangTotal,
    `${EXPECTED.liaoyangTotal} 条，bbox=${fmtBbox(state.data.liaoyangBbox)}`,
    `${liaoyangPlaces.length} 条，bbox=${fmtBbox(state.data.liaoyangBbox)}`,
  );
}

/* ------------------------------------------------------------------ *
 * 验收 1：首屏（rows=116 / markers=116 / mapReady / drawCount=1）
 * ------------------------------------------------------------------ */

async function phaseInitial(state, cdp) {
  const group = GROUPS.accept1;

  // 1.1 列表加载
  let listState = null;
  try {
    listState = await waitForEvaluate(
      cdp,
      PAGE_STATE_EXPR,
      (value) => value.readyState === "complete" && value.hasList && value.rows === EXPECTED.beijingTotal,
      150000,
      "验收 1：地点列表 116 行加载完成（.next 首次编译可能较慢）",
      250,
    );
  } catch (error) {
    listState = await readPageState(cdp);
    check(
      state,
      group,
      "1.1",
      "打开 /admin：地点列表 116 行加载完成",
      false,
      `列表 116 行 + 总数文案「共 ${EXPECTED.beijingTotal} 个地点」`,
      `等待超时：${messageText(error)}；当前 ${listState === null ? "页面不可读" : `${listState.rows} 行`}`,
    );
    return;
  }
  check(
    state,
    group,
    "1.1",
    "打开 /admin：地点列表 116 行加载完成",
    listState.rows === EXPECTED.beijingTotal && listState.totalText !== null && listState.totalText.includes(String(EXPECTED.beijingTotal)),
    `116 行 + 「共 116 个地点」`,
    `${listState.rows} 行，总数文案=${listState.totalText}`,
  );

  // 1.2 地图就绪 + marker 数
  let ready = null;
  try {
    ready = await waitForEvaluate(
      cdp,
      PAGE_STATE_EXPR,
      (value) =>
        value.debug !== null &&
        value.debug.mapReady === true &&
        value.debug.markerCount === EXPECTED.beijingTotal &&
        value.markerDomCount === EXPECTED.beijingTotal &&
        value.hasMapSection &&
        value.hasCanvas,
      150000,
      "验收 1：地图就绪（mapReady=true）且画出 116 个 marker",
      300,
    );
  } catch (error) {
    ready = await readPageState(cdp);
    infoLog(`验收 1 地图等待超时：${messageText(error)}`);
  }
  const debug = ready === null ? null : ready.debug;
  state.debug.initial = debug;
  const mapReady = debug !== null && debug.mapReady === true && debug.error === "" && debug.markerCount === EXPECTED.beijingTotal && ready.markerDomCount === EXPECTED.beijingTotal && ready.hasMapSection && ready.hasCanvas && !ready.hasMapError;
  check(
    state,
    group,
    "1.2",
    "地图实例创建成功且画出 116 个 marker",
    mapReady,
    "debug.mapReady=true；markerCount=116；DOM marker=116；无 [admin-map-error]",
    mapReady ? `${fmtDebug(debug)}；DOM marker=${ready.markerDomCount}` : `debug=${debug === null ? "null" : fmtDebug(debug)}；DOM marker=${ready === null ? "?" : ready.markerDomCount}；错误态=${ready === null ? "?" : ready.hasMapError}`,
  );
  if (!mapReady) {
    state.mapOk = false;
    return;
  }
  state.mapOk = true;

  // 1.3 drawCount / fitViewCount（契约 §5.1：首屏各 =1）
  check(
    state,
    group,
    "1.3",
    "首屏只重画一次：drawCount=1、fitViewCount=1（契约 §5.1）",
    debug.drawCount === 1 && debug.fitViewCount === 1,
    "drawCount=1；fitViewCount=1",
    `drawCount=${debug.drawCount}；fitViewCount=${debug.fitViewCount}`,
  );

  // 1.4 markerIds 顺序 = 接口 places 顺序
  check(
    state,
    group,
    "1.4",
    "debug.markerIds 顺序 = /api/admin/places 返回顺序",
    arraysEqual(debug.markerIds, state.data.beijingIds),
    `ids[0..2]=${state.data.beijingIds.slice(0, 3).join(",")}…（共 ${state.data.beijingIds.length}）`,
    arraysEqual(debug.markerIds, state.data.beijingIds)
      ? `${debug.markerIds.length} 个 id 与接口完全一致`
      : `markerIds=${debug.markerIds.length} 个；第一处差异 index=${state.data.beijingIds.findIndex((id, index) => debug.markerIds[index] !== id)}；marker 前 3=${debug.markerIds.slice(0, 3).join(",")}，接口前 3=${state.data.beijingIds.slice(0, 3).join(",")}`,
  );

  // 1.5 列表行顺序 = 接口 places 顺序
  const rowIds = await cdp.evaluate(ROW_IDS_EXPR).catch(() => []);
  check(
    state,
    group,
    "1.5",
    "列表行 data-row-place-id 顺序 = 接口 places 顺序（116 行）",
    arraysEqual(rowIds, state.data.beijingIds),
    `116 行，顺序与接口一致`,
    arraysEqual(rowIds, state.data.beijingIds) ? `${rowIds.length} 行与接口一致` : `rows=${rowIds.length}；首行=${rowIds[0]}，接口首行=${state.data.beijingIds[0]}`,
  );

  // 1.6 marker DOM 结构 / 实心样式 / 类目色
  const markers = await cdp.evaluate(MARKER_DOM_EXPR).catch(() => []);
  const problems = [];
  const categoryCounts = {};
  for (const marker of markers) {
    const apiPlace = state.data.beijingByName.get(marker.placeId);
    const category = marker.category;
    categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
    if (apiPlace === undefined) {
      problems.push(`marker ${marker.placeId} 不在接口结果里`);
      continue;
    }
    if (marker.category !== apiPlace.category) problems.push(`marker ${marker.placeId} data-category=${marker.category}，接口=${apiPlace.category}`);
    if (marker.hidden !== "false") problems.push(`marker ${marker.placeId} data-hidden=${marker.hidden}（本轮数据 hidden 全为 false）`);
    if (marker.selected !== null) problems.push(`marker ${marker.placeId} 首屏不应有 data-selected`);
    const dot = marker.dot;
    if (dot === null) {
      problems.push(`marker ${marker.placeId} 缺少内层 [data-map-dot]`);
      continue;
    }
    const hex = CATEGORY_HEX[apiPlace.category];
    if (dot.width !== "10px" || dot.height !== "10px") problems.push(`marker ${marker.placeId} 圆点尺寸 ${dot.width}x${dot.height}（期望 10x10）`);
    if (dot.borderRadius !== "50%") problems.push(`marker ${marker.placeId} border-radius=${dot.borderRadius}（期望 50%）`);
    if (dot.boxSizing !== "border-box") problems.push(`marker ${marker.placeId} box-sizing=${dot.boxSizing}（期望 border-box）`);
    if (dot.borderTopWidth !== "1px" || dot.borderTopStyle !== "solid") problems.push(`marker ${marker.placeId} 边框 ${dot.borderTopWidth} ${dot.borderTopStyle}（期望 1px solid）`);
    if (!colorEquals(dot.borderTopColor, "#ffffff")) problems.push(`marker ${marker.placeId} 边框色 ${dot.borderTopColor?.raw}（期望 #ffffff）`);
    if (hex === undefined) {
      problems.push(`marker ${marker.placeId} 类目 ${apiPlace.category} 不在色板里`);
    } else if (!colorEquals(dot.backgroundColor, hex)) {
      problems.push(`marker ${marker.placeId}（${apiPlace.category}）背景 ${dot.backgroundColor?.raw}（期望 ${rgbText(hex)}）`);
    }
    if (marker.wrapper.width !== "10px" || marker.wrapper.height !== "10px") problems.push(`marker ${marker.placeId} 外层尺寸 ${marker.wrapper.width}x${marker.wrapper.height}（期望 10x10）`);
    if (marker.wrapper.cursor !== "pointer") problems.push(`marker ${marker.placeId} cursor=${marker.wrapper.cursor}（期望 pointer）`);
  }
  state.dom.initialMarkers = {
    count: markers.length,
    categoryCounts: categoryCounts,
    problems: problems.slice(0, 20),
    sample: markers.slice(0, 3),
  };
  check(
    state,
    group,
    "1.6",
    "116 个 marker：data-* 完整、10px 实心圆点 + 1px 白边、9 类颜色正确（contract §4.2/§3）",
    markers.length === EXPECTED.beijingTotal && problems.length === 0,
    `116 个 marker，类目色按 §3 色板；问题 0`,
    markers.length === EXPECTED.beijingTotal && problems.length === 0
      ? `116/116 PASS；类目分布 ${Object.entries(categoryCounts).map(([key, value]) => `${key}=${value}`).join("，")}`
      : `marker=${markers.length}，问题 ${problems.length} 条：${problems.slice(0, 6).join("；")}`,
  );

  // 1.7 图例结构 / 顺序 / 文案（contract §4.2 最新口径：外层 data-legend-item 只放文案）
  const legend = await cdp.evaluate(LEGEND_EXPR).catch(() => ({ exists: false }));
  const legendItems = legend.exists === true && Array.isArray(legend.items) ? legend.items : [];
  const legendSwatches = legend.exists === true && Array.isArray(legend.swatches) ? legend.swatches : [];
  const legendOrderOk = arraysEqual(legendItems.map((item) => item.category), LEGEND_ORDER);
  const legendLabelsOk = arraysEqual(legendItems.map((item) => item.label), LEGEND_ORDER.map((category) => CATEGORY_LABELS[category]));
  const legendRelationOk = legendItems.every((item) => item.swatchCategory === item.category && item.swatchFlag === "true");
  const legendSwatchOrderOk = arraysEqual(legendSwatches.map((swatch) => swatch.category), LEGEND_ORDER);
  const legendColorProblems = legendSwatches.filter((swatch) => !colorEquals(parseRgb(swatch.backgroundColor), CATEGORY_HEX[swatch.category] ?? "#000000"));
  check(
    state,
    group,
    "1.7",
    "图例：10 个 data-legend-item 顺序/文案符合契约（公园…商场），每个 label 内含同 category 的色块",
    legend.exists === true && legendItems.length === 10 && legendOrderOk && legendLabelsOk && legendRelationOk,
    `10 项，顺序 ${LEGEND_ORDER.join(" > ")}；文案 ${LEGEND_ORDER.map((category) => CATEGORY_LABELS[category]).join("/")}；色块同时挂 data-legend-category + data-legend-swatch`,
    legend.exists === false
      ? "没有 [data-testid=\"admin-map-legend\"]"
      : `${legendItems.length} 项；顺序=${legendOrderOk}；文案=${legendLabelsOk}；label 与色块 category 对应=${legendRelationOk}；实际文案=${legendItems.map((item) => item.label).join("/")}`,
  );
  check(
    state,
    group,
    "1.8",
    "图例：10 个 [data-legend-category] 色块的 backgroundColor 逐类等于契约色板（contract §4.2）",
    legendSwatches.length === 10 && legendSwatchOrderOk && legendColorProblems.length === 0,
    `10 个色块，背景依次 = ${LEGEND_ORDER.map((category) => rgbText(CATEGORY_HEX[category])).join(" / ")}`,
    legend.exists === false
      ? "图例不存在"
      : `${legendSwatches.length} 个色块；顺序=${legendSwatchOrderOk}；颜色问题=${legendColorProblems.map((swatch) => `${swatch.category}(${swatch.backgroundColor})`).join("，") || "无"}；实际=${legendSwatches.map((swatch) => `${swatch.category}:${swatch.backgroundColor}`).join("，")}`,
  );
  check(
    state,
    group,
    "1.9",
    "图例样式：font-size 10px / line-height 12px / 绝对定位贴底 / pointer-events:none / 无 emoji",
    legend.exists === true &&
      legend.fontSize === "10px" &&
      legend.lineHeight === "12px" &&
      legend.position === "absolute" &&
      legend.pointerEvents === "none" &&
      legend.hasEmoji === false &&
      legend.hasImage === false &&
      Number.parseFloat(legend.bottom) === 0,
    "fontSize=10px；lineHeight=12px；position=absolute；pointerEvents=none；bottom=0；无 emoji/img",
    legend.exists === false
      ? "图例不存在"
      : `fontSize=${legend.fontSize}；lineHeight=${legend.lineHeight}；position=${legend.position}；pointerEvents=${legend.pointerEvents}；bottom=${legend.bottom}；emoji=${legend.hasEmoji}；img/svg=${legend.hasImage}`,
  );

  // 1.10 地图根 section 样式 + 画布真实渲染
  const surface = await cdp.evaluate(MAP_SURFACE_EXPR).catch(() => null);
  const sectionStyle = surface === null ? null : surface.section.style;
  const sectionRect = surface === null ? null : surface.section.rect;
  const canvasRect = surface === null ? null : surface.canvas.rect;
  const canvasFilled = sectionRect !== null && canvasRect !== null && Math.abs(canvasRect.width - sectionRect.width) <= 2 && Math.abs(canvasRect.height - sectionRect.height) <= 2;
  check(
    state,
    group,
    "1.10",
    "地图根 section：position:relative、overflow:hidden；画布铺满且 SDK 有渲染子节点",
    sectionStyle !== null &&
      sectionStyle.position === "relative" &&
      sectionStyle.overflowX === "hidden" &&
      sectionStyle.overflowY === "hidden" &&
      canvasFilled &&
      surface.canvas.childCount > 0,
    "section position=relative、overflow=hidden；canvas 尺寸=section；canvas 子节点>0",
    sectionStyle === null
      ? "读取不到地图 section"
      : `section position=${sectionStyle.position}，overflow=${sectionStyle.overflowX}/${sectionStyle.overflowY}；canvas=${canvasRect === null ? "null" : `${Math.round(canvasRect.width)}x${Math.round(canvasRect.height)}`}（section ${sectionRect === null ? "?" : `${Math.round(sectionRect.width)}x${Math.round(sectionRect.height)}`}）；canvas 子节点=${surface.canvas.childCount}；amap-container=${surface.canvas.hasAmapContainer}`,
  );

  // 1.11 首屏无错误态
  check(
    state,
    group,
    "1.11",
    "首屏没有 [data-testid=\"admin-map-error\"]（地图正常）",
    ready.hasMapError === false,
    "无错误态",
    `hasMapError=${ready.hasMapError}；mapErrorText=${ready.mapErrorText}`,
  );

  // 1.12 截图
  await cdp.evaluate("window.scrollTo(0, 0)").catch(() => {});
  await sleepSafe(400);
  const shotResult = await safeShot(cdp, state, "admin-map-1280.png");
  check(
    state,
    group,
    "1.12",
    "首屏截图 .cache/verify/admin-map-1280.png",
    shotResult !== null && shotResult.bytes > 10000,
    "截图存在且 >10KB",
    shotResult === null ? "截图失败" : `${rel(shotResult.path)}（${shotResult.bytes} bytes）`,
  );

  // 1.13 底图控件（后续多次重画后还会再断言一次，证明没有 clearMap）
  const controls = surface === null ? null : surface.controls;
  check(
    state,
    group,
    "1.13",
    "底图控件存在（首屏渲染完成，非空容器）",
    controls !== null && (controls > 0 || surface.canvas.childCount > 1),
    "canvas 内存在 AMap 底图控件/子节点",
    `controls=${controls}；canvas 子节点=${surface === null ? "?" : surface.canvas.childCount}`,
  );
}

/** 从 computedStyle 颜色字符串解析 {r,g,b,a}（Node 侧小工具，图例用）。 */
function parseRgb(raw) {
  const match = /rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+))?\s*\)/.exec(String(raw ?? ""));
  if (match === null) return { r: null, g: null, b: null, a: null };
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: match[4] === undefined ? 1 : Number(match[4]) };
}

/* ------------------------------------------------------------------ *
 * 布局：1280×900 桌面分栏 + sticky
 * ------------------------------------------------------------------ */

async function phaseLayoutDesktop(state, cdp) {
  const group = GROUPS.layoutDesktop;
  const layout = await cdp.evaluate(LAYOUT_EXPR).catch(() => null);
  state.layout.desktop = layout;
  if (layout === null || layout.list.rect === null || layout.section.rect === null) {
    check(state, group, "L0", "读取桌面布局 rect 成功", false, "能读到列表容器与地图 section 的 rect", "读取失败（列表或地图不存在）");
    return;
  }
  const list = layout.list.rect;
  const section = layout.section.rect;

  check(
    state,
    group,
    "L1",
    "列表在地图左侧（左右分栏）",
    list.left < section.left && list.right <= section.left + 1,
    "list.right ≤ map.left",
    `list=[${Math.round(list.left)}, ${Math.round(list.right)}]；map=[${Math.round(section.left)}, ${Math.round(section.right)}]`,
  );

  const totalWidth = list.width + section.width;
  const listRatio = totalWidth === 0 ? 0 : list.width / totalWidth;
  const sectionRatio = totalWidth === 0 ? 0 : section.width / totalWidth;
  check(
    state,
    group,
    "L2",
    "宽度比例 ≈ 60/40（±8%：列表 52%–68%，地图 32%–48%）",
    listRatio >= 0.52 && listRatio <= 0.68 && sectionRatio >= 0.32 && sectionRatio <= 0.48,
    "列表 52%–68% / 地图 32%–48%",
    `列表 ${Math.round(list.width)}px（${(listRatio * 100).toFixed(1)}%）/ 地图 ${Math.round(section.width)}px（${(sectionRatio * 100).toFixed(1)}%）；viewport=${layout.viewport.width}x${layout.viewport.height}`,
  );

  check(
    state,
    group,
    "L3",
    "地图列 position:sticky 且 top=16px（lg:top-4）",
    layout.sticky !== null && layout.sticky.position === "sticky" && layout.sticky.top === "16px",
    "position=sticky；top=16px",
    layout.sticky === null ? "地图 section 的祖先里没有 position:sticky" : `level=${layout.sticky.level}；position=${layout.sticky.position}；top=${layout.sticky.top}；class=${truncate(layout.sticky.className, 120)}`,
  );

  const expectedHeight = layout.viewport.height - 96;
  check(
    state,
    group,
    "L4",
    "桌面地图高度 = calc(100vh - 6rem) ≈ 804px（±2px）",
    Math.abs(section.height - expectedHeight) <= 2,
    `${expectedHeight}px（100vh=${layout.viewport.height} − 96）`,
    `${section.height.toFixed(1)}px`,
  );

  check(
    state,
    group,
    "L5",
    "桌面地图 section position:relative + overflow:hidden（contract §4.2）",
    layout.section.style.position === "relative" && layout.section.style.overflowX === "hidden" && layout.section.style.overflowY === "hidden",
    "position=relative；overflow=hidden",
    `position=${layout.section.style.position}；overflow=${layout.section.style.overflowX}/${layout.section.style.overflowY}`,
  );
}

/* ------------------------------------------------------------------ *
 * 验收 2：类目「公园」
 * ------------------------------------------------------------------ */

const exprSetSelect = (testId, value) => `(() => {
  const select = document.querySelector('[data-testid="' + ${JSON.stringify(testId)} + '"]');
  if (select === null) return { ok: false, reason: "控件不存在：" + ${JSON.stringify(testId)} };
  const target = ${JSON.stringify(value)};
  const optionValues = [...select.options].map((option) => option.value);
  if (optionValues.indexOf(target) === -1) return { ok: false, reason: "选项不存在", optionValues: optionValues };
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
  setter.call(select, target);
  select.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, value: select.value, optionValues: optionValues };
})()`;

const exprSetInput = (testId, value) => `(() => {
  const input = document.querySelector('[data-testid="' + ${JSON.stringify(testId)} + '"]');
  if (input === null) return { ok: false, reason: "控件不存在：" + ${JSON.stringify(testId)} };
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(input, ${JSON.stringify(value)});
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return { ok: true, value: input.value };
})()`;

const exprToggleCheckbox = (testId) => `(() => {
  const input = document.querySelector('[data-testid="' + ${JSON.stringify(testId)} + '"]');
  if (input === null) return { ok: false, reason: "控件不存在：" + ${JSON.stringify(testId)} };
  const before = input.checked;
  input.click();
  return { ok: true, before: before, checked: input.checked };
})()`;

function exprClickRow(placeId) {
  return `(() => {
    const id = ${JSON.stringify(placeId)};
    const list = document.querySelector('[data-testid="admin-places-list"]');
    const row = list === null ? null : [...list.querySelectorAll('[data-row-place-id]')].find((element) => element.getAttribute("data-row-place-id") === id) || null;
    if (row === null) return { clicked: false, reason: "行不存在" };
    const rect = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    return { clicked: true, id: id, rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } };
  })()`;
}

function exprClickMarker(placeId) {
  return `(() => {
    const id = ${JSON.stringify(placeId)};
    const marker = [...document.querySelectorAll('[data-map-marker="true"]')].find((element) => element.getAttribute("data-place-id") === id) || null;
    if (marker === null) return { clicked: false, reason: "marker 不存在" };
    marker.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    return { clicked: true, id: id };
  })()`;
}

function exprClickTab(tabText) {
  return `(() => {
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    const target = tabs.find((tab) => (tab.textContent || "").trim() === ${JSON.stringify(tabText)});
    if (target === undefined) return { clicked: false, tabs: tabs.map((tab) => (tab.textContent || "").trim()) };
    target.click();
    return { clicked: true, tab: ${JSON.stringify(tabText)} };
  })()`;
}

async function waitForPage(cdp, predicate, timeoutMs, label, intervalMs = 300) {
  return waitForEvaluate(cdp, PAGE_STATE_EXPR, predicate, timeoutMs, label, intervalMs);
}

async function phasePark(state, cdp) {
  const group = GROUPS.accept2;
  const before = await readDebug(cdp);
  if (before === null) {
    check(state, group, "2.0", "读取类目筛选前 debug 快照", false, "debug 可用", "debug=null");
    return;
  }

  const switched = await cdp.evaluate(exprSetSelect("category-filter", "park")).catch((error) => ({ ok: false, reason: messageText(error) }));
  check(
    state,
    group,
    "2.1",
    "类目下拉切到「公园」（原生 setter + change 事件）",
    switched.ok === true && switched.value === "park",
    "select[data-testid=category-filter].value=park",
    switched.ok === true ? `value=${switched.value}` : `失败：${switched.reason}`,
  );

  let parkState = null;
  try {
    parkState = await waitForPage(
      cdp,
      (value) =>
        value.rows === EXPECTED.parkCount &&
        value.debug !== null &&
        value.debug.markerCount === EXPECTED.parkCount &&
        value.markerDomCount === EXPECTED.parkCount,
      30000,
      "验收 2：rows=38 且 markers=38",
    );
  } catch (error) {
    parkState = await readPageState(cdp);
    infoLog(`验收 2 等待 rows/markers=38 超时：${messageText(error)}`);
  }
  const parkDebug = parkState === null ? null : parkState.debug;
  state.debug.parks = parkDebug;
  check(
    state,
    group,
    "2.2",
    "类目「公园」→ 列表 38 行、地图 38 个 marker、总数文案 38",
    parkState !== null && parkState.rows === EXPECTED.parkCount && parkState.debug !== null && parkState.debug.markerCount === EXPECTED.parkCount && parkState.markerDomCount === EXPECTED.parkCount && String(parkState.totalText).includes(String(EXPECTED.parkCount)),
    "rows=38；markers=38；共 38 个地点",
    parkState === null ? "页面不可读" : `rows=${parkState.rows}；markers=${parkState.debug === null ? "?" : parkState.debug.markerCount}；DOM marker=${parkState.markerDomCount}；总数文案=${parkState.totalText}`,
  );

  const markers = await cdp.evaluate(MARKER_DOM_EXPR).catch(() => []);
  const parkProblems = [];
  for (const marker of markers) {
    if (marker.category !== "park") parkProblems.push(`marker ${marker.placeId} category=${marker.category}`);
    if (marker.dot === null) {
      parkProblems.push(`marker ${marker.placeId} 缺少圆点`);
      continue;
    }
    if (!colorEquals(marker.dot.backgroundColor, EXPECTED_PARK_HEX)) parkProblems.push(`marker ${marker.placeId} 背景=${marker.dot.backgroundColor?.raw}`);
    if (!colorEquals(marker.dot.borderTopColor, "#ffffff")) parkProblems.push(`marker ${marker.placeId} 边框=${marker.dot.borderTopColor?.raw}`);
    if (marker.hidden !== "false") parkProblems.push(`marker ${marker.placeId} hidden=${marker.hidden}`);
  }
  check(
    state,
    group,
    "2.3",
    "38 个 marker 全部 data-category=park、圆点 background-color = rgb(22, 163, 74)",
    markers.length === EXPECTED.parkCount && parkProblems.length === 0,
    `38 个 marker：data-category=park；背景 ${rgbText(EXPECTED_PARK_HEX)}`,
    markers.length === EXPECTED.parkCount && parkProblems.length === 0
      ? `38/38 PASS；背景 ${rgbText(EXPECTED_PARK_HEX)}；白边 #ffffff`
      : `marker=${markers.length}，问题 ${parkProblems.length}：${parkProblems.slice(0, 5).join("；")}`,
  );

  check(
    state,
    group,
    "2.4",
    "筛选后 fitViewCount 递增（每次重画 setFitView 一次）",
    parkDebug !== null && parkDebug.fitViewCount > before.fitViewCount && parkDebug.drawCount > before.drawCount,
    `fitViewCount > ${before.fitViewCount}；drawCount > ${before.drawCount}`,
    parkDebug === null ? "debug=null" : `fitViewCount=${before.fitViewCount}→${parkDebug.fitViewCount}；drawCount=${before.drawCount}→${parkDebug.drawCount}`,
  );

  // center 落在公园坐标 bbox 内（最多等 4s，兼容视野动画 / moveend 更新）
  let centerState = parkDebug;
  try {
    centerState = await waitForEvaluate(
      cdp,
      DEBUG_SNAPSHOT_CODE,
      (value) => value !== null && centerInBbox(value.center, state.data.parkBbox),
      4000,
      "验收 2：地图 center 落入公园 bbox",
      250,
    );
  } catch {
    centerState = await readDebug(cdp);
  }
  state.debug.parksCenter = centerState === null ? null : centerState.center;
  const centerOk = centerState !== null && centerInBbox(centerState.center, state.data.parkBbox);
  check(
    state,
    group,
    "2.5",
    "地图 center 落在公园坐标 bbox 内（视野自适应到房山那片公园）",
    centerOk,
    `center ∈ ${fmtBbox(state.data.parkBbox)}（允许 0.002° 余量）`,
    centerState === null || centerState.center === null ? "center=null" : `center=(${centerState.center.lng}, ${centerState.center.lat})；zoom=${centerState.zoom}`,
  );

  await cdp.evaluate("window.scrollTo(0, 0)").catch(() => {});
  await sleepSafe(300);
  const shotResult = await safeShot(cdp, state, "admin-map-parks.png");
  check(state, group, "2.6", "公园筛选截图 .cache/verify/admin-map-parks.png", shotResult !== null, "截图存在", shotResult === null ? "截图失败" : rel(shotResult.path));
}

/* ------------------------------------------------------------------ *
 * 验收 3：搜索「美术馆」
 * ------------------------------------------------------------------ */

async function phaseSearch(state, cdp) {
  const group = GROUPS.accept3;

  // 先恢复类目「全部」，否则 park + 美术馆 = 0 条
  const reset = await cdp.evaluate(exprSetSelect("category-filter", "")).catch((error) => ({ ok: false, reason: messageText(error) }));
  let resetState = null;
  try {
    resetState = await waitForPage(
      cdp,
      (value) => value.rows === EXPECTED.beijingTotal && value.debug !== null && value.debug.markerCount === EXPECTED.beijingTotal,
      30000,
      "验收 3：恢复全部类目 rows=116",
    );
  } catch (error) {
    resetState = await readPageState(cdp);
    infoLog(`验收 3 恢复全部类目超时：${messageText(error)}`);
  }
  check(
    state,
    group,
    "3.1",
    "类目恢复「全部」→ rows=116 / markers=116",
    reset.ok === true && resetState !== null && resetState.rows === EXPECTED.beijingTotal && resetState.debug !== null && resetState.debug.markerCount === EXPECTED.beijingTotal,
    "rows=116；markers=116",
    reset.ok === false ? `切回失败：${reset.reason}` : resetState === null ? "页面不可读" : `rows=${resetState.rows}；markers=${resetState.debug === null ? "?" : resetState.debug.markerCount}`,
  );

  const before = await readDebug(cdp);
  const typed = await cdp.evaluate(exprSetInput("name-search", "美术馆")).catch((error) => ({ ok: false, reason: messageText(error) }));
  check(
    state,
    group,
    "3.2",
    "搜索框输入「美术馆」（原生 setter + input 事件）",
    typed.ok === true && typed.value === "美术馆",
    "input[data-testid=name-search].value=美术馆",
    typed.ok === true ? `value=${typed.value}` : `失败：${typed.reason}`,
  );

  let searchState = null;
  try {
    searchState = await waitForPage(
      cdp,
      (value) =>
        value.rows === EXPECTED.searchCount &&
        value.debug !== null &&
        value.debug.markerCount === EXPECTED.searchCount &&
        value.markerDomCount === EXPECTED.searchCount,
      30000,
      "验收 3：搜索后 rows=2 / markers=2（含 300ms 防抖）",
    );
  } catch (error) {
    searchState = await readPageState(cdp);
    infoLog(`验收 3 等待 rows/markers=2 超时：${messageText(error)}`);
  }
  const searchDebug = searchState === null ? null : searchState.debug;
  state.debug.search = searchDebug;
  state.dom.searchMarkers = await cdp.evaluate(MARKER_DOM_EXPR).catch(() => []);
  check(
    state,
    group,
    "3.3",
    "搜索「美术馆」→ 列表 2 行、地图 2 个 marker",
    searchState !== null && searchState.rows === EXPECTED.searchCount && searchDebug !== null && searchDebug.markerCount === EXPECTED.searchCount && searchState.markerDomCount === EXPECTED.searchCount,
    "rows=2；markers=2",
    searchState === null ? "页面不可读" : `rows=${searchState.rows}；markers=${searchDebug === null ? "?" : searchDebug.markerCount}；DOM marker=${searchState.markerDomCount}`,
  );

  check(
    state,
    group,
    "3.4",
    "搜索结果的 marker ids 与 /api/admin/places?q=美术馆 一致",
    searchDebug !== null && arraysEqual(searchDebug.markerIds, state.data.searchIds),
    `ids=${state.data.searchIds.join(",")}`,
    searchDebug === null ? "debug=null" : `markerIds=${searchDebug.markerIds.join(",")}`,
  );

  check(
    state,
    group,
    "3.5",
    "搜索后 drawCount / fitViewCount 递增",
    searchDebug !== null && before !== null && searchDebug.drawCount > before.drawCount && searchDebug.fitViewCount > before.fitViewCount,
    `drawCount > ${before === null ? "?" : before.drawCount}；fitViewCount > ${before === null ? "?" : before.fitViewCount}`,
    searchDebug === null ? "debug=null" : `drawCount=${before === null ? "?" : before.drawCount}→${searchDebug.drawCount}；fitViewCount=${before === null ? "?" : before.fitViewCount}→${searchDebug.fitViewCount}`,
  );

  await cdp.evaluate("window.scrollTo(0, 0)").catch(() => {});
  await sleepSafe(300);
  const shotResult = await safeShot(cdp, state, "admin-map-search.png");
  check(state, group, "3.6", "搜索结果截图 .cache/verify/admin-map-search.png", shotResult !== null, "截图存在", shotResult === null ? "截图失败" : rel(shotResult.path));
}

/* ------------------------------------------------------------------ *
 * 验收 4：点列表第 3 行 → marker 放大 + center
 * ------------------------------------------------------------------ */

async function phaseRow3(state, cdp) {
  const group = GROUPS.accept4;

  // 先清空搜索，回到 116 行
  const cleared = await cdp.evaluate(exprSetInput("name-search", "")).catch((error) => ({ ok: false, reason: messageText(error) }));
  let clearState = null;
  try {
    clearState = await waitForPage(
      cdp,
      (value) => value.rows === EXPECTED.beijingTotal && value.debug !== null && value.debug.markerCount === EXPECTED.beijingTotal,
      30000,
      "验收 4：清空搜索 rows=116",
    );
  } catch (error) {
    clearState = await readPageState(cdp);
    infoLog(`验收 4 清空搜索超时：${messageText(error)}`);
  }
  if (clearState === null || clearState.rows !== EXPECTED.beijingTotal) {
    check(state, group, "4.0", "清空搜索后 rows=116", false, "rows=116", clearState === null ? "页面不可读" : `rows=${clearState.rows}`);
    return;
  }
  const rowIds = await cdp.evaluate(ROW_IDS_EXPR).catch(() => []);
  const thirdId = rowIds[2];
  const thirdPlace = state.data.beijingByName.get(thirdId) ?? null;
  check(
    state,
    group,
    "4.1",
    "取列表第 3 行（[data-row-place-id] 第 3 个）",
    typeof thirdId === "string" && thirdPlace !== null,
    `第 3 行 placeId 存在且能在接口数据里找到`,
    `placeId=${thirdId ?? "(缺失)"}；name=${thirdPlace === null ? "(接口无此 id)" : thirdPlace.name}`,
  );
  if (typeof thirdId !== "string" || thirdPlace === null) return;

  const before = await readDebug(cdp);
  const clicked = await cdp.evaluate(exprClickRow(thirdId)).catch((error) => ({ clicked: false, reason: messageText(error) }));
  let selectedDebug = null;
  try {
    selectedDebug = await waitForEvaluate(
      cdp,
      DEBUG_SNAPSHOT_CODE,
      (value) => value !== null && value.selectedId === thirdId && value.selectedScale === 1.6,
      10000,
      "验收 4：selectedId 变为第 3 行且 selectedScale=1.6",
      150,
    );
  } catch (error) {
    selectedDebug = await readDebug(cdp);
    infoLog(`验收 4 等待选中态超时：${messageText(error)}`);
  }
  state.debug.row3 = selectedDebug;
  check(
    state,
    group,
    "4.2",
    "点列表第 3 行 → debug.selectedId=该 id 且 selectedScale=1.6",
    clicked.clicked === true && selectedDebug !== null && selectedDebug.selectedId === thirdId && selectedDebug.selectedScale === 1.6,
    `selectedId=${thirdId}；selectedScale=1.6`,
    clicked.clicked === false ? `点击失败：${clicked.reason}` : selectedDebug === null ? "debug=null" : `selectedId=${selectedDebug.selectedId}；selectedScale=${selectedDebug.selectedScale}`,
  );

  // 圆点 transform 有 120ms transition：选中后立刻读会读到过渡起点的 matrix(1,0,0,1,0,0)，
  // 这里轮询到 scale≈1.6 再断言（run2 踩过这个坑，不是产品 bug）。
  const transformReached = (value) => {
    if (value === null || value.exists !== true || value.selected !== "true" || value.dot === null) return false;
    const current = String(value.dot.transform ?? "");
    return /matrix\(\s*1\.6[,\s]/.test(current) || /scale\(\s*1\.6\s*\)/.test(current);
  };
  let markerState = null;
  try {
    markerState = await waitForEvaluate(cdp, exprMarkerState(thirdId), transformReached, 2500, "验收 4：marker 放大到 scale(1.6)（120ms 过渡结束）", 100);
  } catch {
    markerState = await cdp.evaluate(exprMarkerState(thirdId)).catch(() => null);
  }
  const transform = markerState === null || markerState.dot === null ? "" : markerState.dot.transform;
  const transformOk = /matrix\(\s*1\.6[,\s]/.test(transform) || /scale\(\s*1\.6\s*\)/.test(transform);
  check(
    state,
    group,
    "4.3",
    "对应 marker data-selected=true（且只有 1 个）、内层圆点 transform=scale(1.6)",
    markerState !== null && markerState.selected === "true" && markerState.selectedCount === 1 && transformOk,
    `data-selected=true；selectedCount=1；transform=matrix(1.6, ...)`,
    markerState === null ? "读取 marker 失败" : `selected=${markerState.selected}；selectedCount=${markerState.selectedCount}；selectedIds=${markerState.selectedIds.join(",")}；transform=${transform}`,
  );

  let centerDebug = selectedDebug;
  // contract §7.8：debug.center 在 moveend/zoomend 后回写，setCenter 是异步刷新的，读数前等 ~600ms。
  await sleepSafe(700);
  try {
    centerDebug = await waitForEvaluate(
      cdp,
      DEBUG_SNAPSHOT_CODE,
      (value) => value !== null && centerNear(value.center, thirdPlace),
      4000,
      "验收 4：地图 setCenter 到该点",
      200,
    );
  } catch {
    centerDebug = await readDebug(cdp);
  }
  state.debug.row3Center = centerDebug === null ? null : centerDebug.center;
  check(
    state,
    group,
    "4.4",
    "debug.center ≈ 该点 lng/lat（误差 ≤1e-6）",
    centerDebug !== null && centerNear(centerDebug.center, thirdPlace),
    `center=(${thirdPlace.lng}, ${thirdPlace.lat})，误差 ≤1e-6`,
    centerDebug === null || centerDebug.center === null ? "center=null" : `center=(${centerDebug.center.lng}, ${centerDebug.center.lat})；误差=(${Math.abs(centerDebug.center.lng - thirdPlace.lng).toExponential(2)}, ${Math.abs(centerDebug.center.lat - thirdPlace.lat).toExponential(2)})`,
  );

  check(
    state,
    group,
    "4.5",
    "选中只放大 + 居中，不触发重画（drawCount / fitViewCount 不变）",
    centerDebug !== null && before !== null && centerDebug.drawCount === before.drawCount && centerDebug.fitViewCount === before.fitViewCount,
    `drawCount=${before === null ? "?" : before.drawCount} 不变；fitViewCount=${before === null ? "?" : before.fitViewCount} 不变`,
    centerDebug === null ? "debug=null" : `drawCount=${before === null ? "?" : before.drawCount}→${centerDebug.drawCount}；fitViewCount=${before === null ? "?" : before.fitViewCount}→${centerDebug.fitViewCount}`,
  );

  await cdp.evaluate("window.scrollTo(0, 0)").catch(() => {});
  await sleepSafe(250);
  const shotResult = await safeShot(cdp, state, "admin-map-row3-selected.png");
  check(state, group, "4.6", "第 3 行选中截图 .cache/verify/admin-map-row3-selected.png", shotResult !== null, "截图存在", shotResult === null ? "截图失败" : rel(shotResult.path));
}

/* ------------------------------------------------------------------ *
 * 验收 5：点地图 marker → 列表滚动 + 高亮（且不改变 selectedId）
 * ------------------------------------------------------------------ */

async function phaseMarkerClick(state, cdp) {
  const group = GROUPS.accept5;
  await cdp.evaluate("window.scrollTo(0, 0)").catch(() => {});
  await sleepSafe(400);

  const currentDebug = await readDebug(cdp);
  const selectedId = currentDebug === null ? null : currentDebug.selectedId;
  const picked = await cdp.evaluate(exprPickVisibleMarker(selectedId)).catch(() => null);
  const chosen = picked === null ? null : picked.chosen;
  state.debug.pickMarker = picked;
  check(
    state,
    group,
    "5.1",
    "选中一个可见 marker（画布内、且不是当前选中点）",
    chosen !== null && typeof chosen.id === "string",
    "存在 canvas 内可见的非选中 marker",
    picked === null ? "挑选表达式执行失败" : `chosen=${chosen === null ? "null" : `${chosen.id}（行 #${chosen.index}，画布内=${chosen.inCanvas}）`}；画布内候选=${picked.usableCount}；视口内候选=${picked.fallbackCount}；marker 总数=${picked.total}`,
  );
  if (chosen === null || typeof chosen.id !== "string") return;

  const before = await readDebug(cdp);
  const beforeScrollY = await cdp.evaluate("window.scrollY").catch(() => null);
  const clicked = await cdp.evaluate(exprClickMarker(chosen.id)).catch((error) => ({ clicked: false, reason: messageText(error) }));
  let clickMethod = "DOM 合成 click（dispatchEvent(MouseEvent)）";
  let highlightState = null;
  try {
    highlightState = await waitForEvaluate(
      cdp,
      exprRowState(chosen.id),
      (value) => value.exists === true && value.highlight === "true",
      3000,
      "验收 5：对应行出现 data-highlight=true（合成 click）",
      100,
    );
  } catch {
    // contract §7.5：合成事件不灵时，用 CDP Input.dispatchMouseEvent 在 marker 屏幕坐标真实点击。
    clickMethod = "CDP Input.dispatchMouseEvent 在 marker 屏幕坐标真实点击（合成 click 未触发）";
    infoLog(`验收 5：合成 click 未触发高亮，改用 CDP 真实点击 marker（${chosen.x}, ${chosen.y}）`);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: chosen.x, y: chosen.y, button: "left", buttons: 1, clickCount: 1 }).catch(() => {});
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: chosen.x, y: chosen.y, button: "left", buttons: 0, clickCount: 1 }).catch(() => {});
    try {
      highlightState = await waitForEvaluate(
        cdp,
        exprRowState(chosen.id),
        (value) => value.exists === true && value.highlight === "true",
        6000,
        "验收 5：对应行出现 data-highlight=true（CDP 真实点击）",
        100,
      );
    } catch (error) {
      highlightState = await cdp.evaluate(exprRowState(chosen.id)).catch(() => null);
      infoLog(`验收 5 等待行高亮超时：${messageText(error)}`);
    }
  }
  check(
    state,
    group,
    "5.2",
    "点地图 marker → 对应列表行 data-highlight=true",
    clicked.clicked === true && highlightState !== null && highlightState.highlight === "true",
    `行 ${chosen.id} 出现 data-highlight=true（高亮约 1.4s）`,
    clicked.clicked === false
      ? `点击失败：${clicked.reason}`
      : highlightState === null
        ? "读取行状态失败"
        : `data-highlight=${highlightState.highlight}；点击方式=${clickMethod}`,
  );

  let viewportState = highlightState;
  try {
    viewportState = await waitForEvaluate(
      cdp,
      exprRowState(chosen.id),
      (value) => value.exists === true && value.inViewport === true,
      4000,
      "验收 5：对应行 scrollIntoView 后在视口内",
      100,
    );
  } catch (error) {
    viewportState = await cdp.evaluate(exprRowState(chosen.id)).catch(() => null);
    infoLog(`验收 5 等待行进入视口超时：${messageText(error)}`);
  }
  check(
    state,
    group,
    "5.3",
    "该行 scrollIntoView({block:'center'}) 后 rect 在视口内",
    viewportState !== null && viewportState.inViewport === true,
    "row.top ≥ 0 且 row.bottom ≤ innerHeight",
    viewportState === null ? "读取行状态失败" : `rect=[${Math.round(viewportState.rect.top)}, ${Math.round(viewportState.rect.bottom)}]；视口高=${await cdp.evaluate("window.innerHeight").catch(() => "?")}；scrollY ${beforeScrollY}→${viewportState.scrollY}`,
  );

  const backgroundVisible = viewportState !== null && !isTransparentColor(parseRgb(viewportState.backgroundColor));
  check(
    state,
    group,
    "5.4",
    "高亮背景生效（行背景闪一下，不是透明）",
    backgroundVisible,
    "行背景为非透明色（bg-amber-100 → rgb(254, 243, 199)）",
    viewportState === null ? "读取行状态失败" : `backgroundColor=${viewportState.backgroundColor}；className 含 amber=${String(viewportState.className).includes("amber")}`,
  );

  const after = await readDebug(cdp);
  check(
    state,
    group,
    "5.5",
    "marker 点击不改变 selectedId（验收 5 明文要求）",
    before !== null && after !== null && after.selectedId === before.selectedId,
    `selectedId 保持 ${before === null ? "?" : before.selectedId}`,
    after === null ? "debug=null" : `点击前 selectedId=${before === null ? "?" : before.selectedId}；点击后 selectedId=${after.selectedId}`,
  );
  check(
    state,
    group,
    "5.6",
    "marker 点击不触发重画（drawCount / fitViewCount 不变）",
    before !== null && after !== null && after.drawCount === before.drawCount && after.fitViewCount === before.fitViewCount,
    `drawCount=${before === null ? "?" : before.drawCount} 不变；fitViewCount=${before === null ? "?" : before.fitViewCount} 不变`,
    after === null ? "debug=null" : `drawCount=${before === null ? "?" : before.drawCount}→${after.drawCount}；fitViewCount=${before === null ? "?" : before.fitViewCount}→${after.fitViewCount}`,
  );

  await sleepSafe(100);
  const shotResult = await safeShot(cdp, state, "admin-map-marker-to-row.png");
  check(state, group, "5.7", "marker→行 联动截图 .cache/verify/admin-map-marker-to-row.png", shotResult !== null, "截图存在", shotResult === null ? "截图失败" : rel(shotResult.path));
}

/* ------------------------------------------------------------------ *
 * 验收 6：显示已隐藏开关（浏览器部分）
 * ------------------------------------------------------------------ */

async function phaseIncludeHidden(state, cdp) {
  const group = GROUPS.accept6;
  const before = await readDebug(cdp);

  const toggledOn = await cdp.evaluate(exprToggleCheckbox("include-hidden")).catch((error) => ({ ok: false, reason: messageText(error) }));
  check(
    state,
    group,
    "6.1",
    "勾选「显示已隐藏」（checkbox.click()，DOM 合成点击）",
    toggledOn.ok === true && toggledOn.checked === true,
    "checkbox 勾选后 checked=true",
    toggledOn.ok === true ? `checked ${toggledOn.before}→${toggledOn.checked}` : `失败：${toggledOn.reason}`,
  );

  let onState = null;
  try {
    onState = await waitForPage(
      cdp,
      (value) =>
        value.rows === EXPECTED.beijingTotal &&
        value.debug !== null &&
        value.debug.markerCount === EXPECTED.beijingTotal &&
        value.debug.drawCount > (before === null ? 0 : before.drawCount),
      20000,
      "验收 6：勾选后重新拉取 + 重画（rows/markers 仍 116）",
    );
  } catch (error) {
    onState = await readPageState(cdp);
    infoLog(`验收 6 勾选后等待重画超时：${messageText(error)}`);
  }
  const onDebug = onState === null ? null : onState.debug;
  state.debug.includeHiddenOn = onDebug;
  check(
    state,
    group,
    "6.2",
    "勾选后不报错：rows=116 / markers=116（本轮 hidden=0，数量不变）",
    onState !== null && onState.rows === EXPECTED.beijingTotal && onDebug !== null && onDebug.markerCount === EXPECTED.beijingTotal && onState.markerDomCount === EXPECTED.beijingTotal && onState.hasMapError === false,
    "rows=116；markers=116；无 [admin-map-error]",
    onState === null ? "页面不可读" : `rows=${onState.rows}；markers=${onDebug === null ? "?" : onDebug.markerCount}；DOM marker=${onState.markerDomCount}；错误态=${onState.hasMapError}`,
  );

  const hiddenMarkers = await cdp.evaluate(MARKER_DOM_EXPR).catch(() => []);
  const wrongHidden = hiddenMarkers.filter((marker) => marker.hidden !== "false");
  check(
    state,
    group,
    "6.3",
    "浏览器内没有 hidden marker（data hidden 全为 false），因此看不到空心圈",
    hiddenMarkers.length === EXPECTED.beijingTotal && wrongHidden.length === 0,
    "116 个 marker 的 data-hidden 全为 false",
    `marker=${hiddenMarkers.length}；data-hidden=true 的=${wrongHidden.length}；数据 hidden=${state.data.beijingHidden ?? "?"}`,
  );

  const toggledOff = await cdp.evaluate(exprToggleCheckbox("include-hidden")).catch((error) => ({ ok: false, reason: messageText(error) }));
  let offState = null;
  try {
    offState = await waitForPage(
      cdp,
      (value) =>
        value.rows === EXPECTED.beijingTotal &&
        value.debug !== null &&
        value.debug.markerCount === EXPECTED.beijingTotal &&
        value.debug.drawCount > (onDebug === null ? 0 : onDebug.drawCount),
      20000,
      "验收 6：取消勾选后 rows/markers 仍 116",
    );
  } catch (error) {
    offState = await readPageState(cdp);
    infoLog(`验收 6 取消勾选后等待重画超时：${messageText(error)}`);
  }
  const offDebug = offState === null ? null : offState.debug;
  state.debug.includeHiddenOff = offDebug;
  check(
    state,
    group,
    "6.4",
    "取消勾选后 rows/markers 仍 116（开关来回不丢点、不报错）",
    toggledOff.ok === true && toggledOff.checked === false && offState !== null && offState.rows === EXPECTED.beijingTotal && offDebug !== null && offDebug.markerCount === EXPECTED.beijingTotal,
    "checked=false；rows=116；markers=116",
    offState === null ? "页面不可读" : `checked=${toggledOff.checked}；rows=${offState.rows}；markers=${offDebug === null ? "?" : offDebug.markerCount}`,
  );
}

/* ------------------------------------------------------------------ *
 * 验收 7：切城市 北京 ↔ 辽阳
 * ------------------------------------------------------------------ */

async function phaseCitySwitch(state, cdp) {
  const group = GROUPS.accept7;
  const before = await readDebug(cdp);

  const switched = await cdp.evaluate(exprSetSelect("city-filter", "liaoyang")).catch((error) => ({ ok: false, reason: messageText(error) }));
  check(
    state,
    group,
    "7.1",
    "城市下拉切到「辽阳」（原生 setter + change 事件）",
    switched.ok === true && switched.value === "liaoyang",
    "select[data-testid=city-filter].value=liaoyang",
    switched.ok === true ? `value=${switched.value}` : `失败：${switched.reason}`,
  );

  let liaoyangState = null;
  try {
    liaoyangState = await waitForPage(
      cdp,
      (value) =>
        value.rows === EXPECTED.liaoyangTotal &&
        value.debug !== null &&
        value.debug.markerCount === EXPECTED.liaoyangTotal &&
        value.markerDomCount === EXPECTED.liaoyangTotal,
      60000,
      "验收 7：辽阳 rows=141 / markers=141",
    );
  } catch (error) {
    liaoyangState = await readPageState(cdp);
    infoLog(`验收 7 等待辽阳 141 超时：${messageText(error)}`);
  }
  const liaoyangDebug = liaoyangState === null ? null : liaoyangState.debug;
  state.debug.liaoyang = liaoyangDebug;
  check(
    state,
    group,
    "7.2",
    "切辽阳 → rows=141 / markers=141 / DOM marker=141",
    liaoyangState !== null && liaoyangState.rows === EXPECTED.liaoyangTotal && liaoyangDebug !== null && liaoyangDebug.markerCount === EXPECTED.liaoyangTotal && liaoyangState.markerDomCount === EXPECTED.liaoyangTotal,
    "rows=141；markers=141；DOM marker=141",
    liaoyangState === null ? "页面不可读" : `rows=${liaoyangState.rows}；markers=${liaoyangDebug === null ? "?" : liaoyangDebug.markerCount}；DOM marker=${liaoyangState.markerDomCount}`,
  );

  check(
    state,
    group,
    "7.3",
    "辽阳 markerIds 与 /api/admin/places?city=liaoyang 一致",
    liaoyangDebug !== null && arraysEqual(liaoyangDebug.markerIds, state.data.liaoyangIds),
    `141 个 id 与接口一致`,
    liaoyangDebug === null ? "debug=null" : `${liaoyangDebug.markerIds.length} 个；第一处差异 index=${state.data.liaoyangIds.findIndex((id, index) => liaoyangDebug.markerIds[index] !== id)}`,
  );

  check(
    state,
    group,
    "7.4",
    "切城市后 fitViewCount / drawCount 递增",
    before !== null && liaoyangDebug !== null && liaoyangDebug.fitViewCount > before.fitViewCount && liaoyangDebug.drawCount > before.drawCount,
    `fitViewCount > ${before === null ? "?" : before.fitViewCount}；drawCount > ${before === null ? "?" : before.drawCount}`,
    liaoyangDebug === null ? "debug=null" : `fitViewCount=${before === null ? "?" : before.fitViewCount}→${liaoyangDebug.fitViewCount}；drawCount=${before === null ? "?" : before.drawCount}→${liaoyangDebug.drawCount}`,
  );

  let liaoyangCenter = liaoyangDebug;
  try {
    liaoyangCenter = await waitForEvaluate(
      cdp,
      DEBUG_SNAPSHOT_CODE,
      (value) => value !== null && centerInBbox(value.center, state.data.liaoyangBbox),
      4000,
      "验收 7：地图 center 落入辽阳 bbox",
      250,
    );
  } catch {
    liaoyangCenter = await readDebug(cdp);
  }
  state.debug.liaoyangCenter = liaoyangCenter === null ? null : liaoyangCenter.center;
  check(
    state,
    group,
    "7.5",
    "地图 center 落在辽阳坐标 bbox 内（视野正确跟着换城市）",
    liaoyangCenter !== null && centerInBbox(liaoyangCenter.center, state.data.liaoyangBbox),
    `center ∈ ${fmtBbox(state.data.liaoyangBbox)}`,
    liaoyangCenter === null || liaoyangCenter.center === null ? "center=null" : `center=(${liaoyangCenter.center.lng}, ${liaoyangCenter.center.lat})；zoom=${liaoyangCenter.zoom}`,
  );

  await cdp.evaluate("window.scrollTo(0, 0)").catch(() => {});
  await sleepSafe(400);
  const shotResult = await safeShot(cdp, state, "admin-map-liaoyang.png");
  check(state, group, "7.6", "辽阳地图截图 .cache/verify/admin-map-liaoyang.png", shotResult !== null, "截图存在", shotResult === null ? "截图失败" : rel(shotResult.path));

  // 多次重画后底图控件仍在 → 证明没用 map.clearMap()
  const surface = await cdp.evaluate(MAP_SURFACE_EXPR).catch(() => null);
  check(
    state,
    group,
    "7.7",
    "多次重画后底图控件仍在（没有 map.clearMap()，任务书红线）",
    surface !== null && surface.canvas.childCount > 0 && (surface.controls > 0 || surface.canvas.childCount > 1),
    "canvas 仍存在 AMap 底图控件/子节点（>0）",
    surface === null ? "读取地图失败" : `controls=${surface.controls}；canvas 子节点=${surface.canvas.childCount}；amap-container=${surface.canvas.hasAmapContainer}`,
  );

  const back = await cdp.evaluate(exprSetSelect("city-filter", "beijing")).catch((error) => ({ ok: false, reason: messageText(error) }));
  let backState = null;
  try {
    backState = await waitForPage(
      cdp,
      (value) => value.rows === EXPECTED.beijingTotal && value.debug !== null && value.debug.markerCount === EXPECTED.beijingTotal && value.markerDomCount === EXPECTED.beijingTotal,
      60000,
      "验收 7：切回北京 rows=116",
    );
  } catch (error) {
    backState = await readPageState(cdp);
    infoLog(`验收 7 切回北京超时：${messageText(error)}`);
  }
  const backDebug = backState === null ? null : backState.debug;
  state.debug.backBeijing = backDebug;
  check(
    state,
    group,
    "7.8",
    "切回北京 → rows=116 / markers=116（城市来回切换正常）",
    back.ok === true && backState !== null && backState.rows === EXPECTED.beijingTotal && backDebug !== null && backDebug.markerCount === EXPECTED.beijingTotal,
    "rows=116；markers=116",
    backState === null ? "页面不可读" : `rows=${backState.rows}；markers=${backDebug === null ? "?" : backDebug.markerCount}`,
  );

  // 恢复「全部类目 / 空搜索 / 不显示已隐藏」基线（为后续手势与 tab 做准备）
  await cdp.evaluate(exprSetSelect("category-filter", "")).catch(() => {});
}

/**
 * 挑一个「离所有 marker 都尽量远」的画布内坐标做拖拽起点：
 * marker 的 content 元素上挂了 click 监听，按在 marker 上可能不触发地图拖拽。
 */
function exprPickDragPoint() {
  return `(() => {
    const canvas = document.querySelector('[data-testid="admin-map-canvas"]');
    if (canvas === null) return null;
    const rect = canvas.getBoundingClientRect();
    const margin = 24;
    const left = Math.max(rect.left + margin, 4);
    const right = Math.min(rect.right - margin, window.innerWidth - 4);
    const top = Math.max(rect.top + margin, 4);
    const bottom = Math.min(rect.bottom - margin, window.innerHeight - 4);
    const width = right - left;
    const height = bottom - top;
    if (width <= 40 || height <= 40) return null;
    const markerRects = [...document.querySelectorAll('[data-map-marker="true"]')]
      .map((element) => element.getBoundingClientRect())
      .filter((markerRect) => markerRect.width > 0 && markerRect.height > 0);
    const fractions = [[0.5, 0.55], [0.32, 0.42], [0.68, 0.6], [0.42, 0.72], [0.62, 0.34], [0.5, 0.3]];
    let best = null;
    for (const [fx, fy] of fractions) {
      const x = Math.round(left + width * fx);
      const y = Math.round(top + height * fy);
      let minDistance = Infinity;
      for (const markerRect of markerRects) {
        const markerX = markerRect.left + markerRect.width / 2;
        const markerY = markerRect.top + markerRect.height / 2;
        minDistance = Math.min(minDistance, Math.hypot(markerX - x, markerY - y));
      }
      const candidate = { x: x, y: y, minDistance: Math.round(minDistance), fraction: [fx, fy], markerCount: markerRects.length };
      if (best === null || candidate.minDistance > best.minDistance) best = candidate;
      if (minDistance >= 24) return candidate;
    }
    return best === null ? null : { ...best, fallback: true };
  })()`;
}

/* ------------------------------------------------------------------ *
 * 验收 8：滚轮缩放 / 拖拽 → 不重画
 *
 * contract §5.8 / §7.9 口径：
 * - 「任一真实手势让 center 或 zoom 变化 + drawCount 不变」即 PASS；
 * - headless Edge 的合成 mouseWheel 不会改变 AMap 视野（项目既有 map-replay.mjs 已记录同一现象），
 *   不算产品 bug，报告里记为 SKIP + 原因；
 * - mousePressed → mouseMoved×4 → mouseReleased 能真实拖动地图；
 * - 若真实手势都不生效，可用 debug.getMap().setZoom(...) 兜底制造「视野变了」证据，但必须标明兜底方法。
 * ------------------------------------------------------------------ */

async function phaseGesture(state, cdp) {
  const group = GROUPS.accept8;
  await cdp.evaluate("window.scrollTo(0, 0)").catch(() => {});
  await sleepSafe(500);
  // 切城市回来的 setFitView 是异步动画：先等视野真正停下，否则会把动画位移误判成手势效果（run2 踩过）。
  await waitViewSettled(cdp, "手势前（切回北京后的 setFitView 动画结束）", 15000);

  const before = await cdp.evaluate(VIEW_PROBE_EXPR).catch(() => null);
  if (before === null || before.debug === null) {
    check(state, group, "8.0", "读取手势前 debug/视图快照", false, "debug 可用", "读取失败");
    return;
  }
  const canvasRect = await cdp.evaluate(`(() => {
    const canvas = document.querySelector('[data-testid="admin-map-canvas"]');
    if (canvas === null) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      innerHeight: window.innerHeight,
    };
  })()`).catch(() => null);
  check(
    state,
    group,
    "8.0",
    "地图画布在视口内、可交互（手势坐标可用）",
    canvasRect !== null && canvasRect.width > 0 && canvasRect.height > 0 && canvasRect.y > 0 && canvasRect.y < canvasRect.innerHeight,
    "canvas 中心点在视口内",
    canvasRect === null ? "读取 canvas 失败" : `center=(${canvasRect.x}, ${canvasRect.y})；尺寸=${canvasRect.width}x${canvasRect.height}；innerHeight=${canvasRect.innerHeight}`,
  );
  if (canvasRect === null) return;

  // 探针：手势不重画时应保留同一个 DOM marker
  await cdp.evaluate(`(() => {
    const marker = document.querySelector('[data-map-marker="true"]');
    if (marker === null) return false;
    marker.setAttribute("data-verify-probe", "keep");
    return true;
  })()`).catch(() => {});

  const beforeZoom = before.debug.zoom;
  const beforeCenter = before.debug.center;
  const beforeMarkerPositions = JSON.stringify(before.markers);

  const viewChanged = (snapshot) =>
    snapshot !== null &&
    ((snapshot.zoom !== null && beforeZoom !== null && snapshot.zoom !== beforeZoom) ||
      (snapshot.center !== null && beforeCenter !== null && (Math.abs(snapshot.center.lng - beforeCenter.lng) > 1e-9 || Math.abs(snapshot.center.lat - beforeCenter.lat) > 1e-9)));

  // ---------- 8.1 滚轮缩放（headless 已知不生效，不算产品 bug） ----------
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: canvasRect.x, y: canvasRect.y, deltaX: 0, deltaY: -240 }).catch((error) => infoLog(`滚轮事件发送失败：${messageText(error)}`));
  await sleepSafe(1500);
  // 滚轮若真的生效会触发 zoom 动画：等它停下再取「滚轮后」快照，避免把动画中间态当结果。
  let afterWheel = await readDebug(cdp);
  if (viewChanged(afterWheel)) afterWheel = await waitViewSettled(cdp, "滚轮后", 8000);
  const wheelProbe = await cdp.evaluate(VIEW_PROBE_EXPR).catch(() => null);
  const wheelMarkerChanged = wheelProbe !== null && JSON.stringify(wheelProbe.markers) !== beforeMarkerPositions;
  const wheelChanged = viewChanged(afterWheel) || wheelMarkerChanged;
  state.debug.gestureWheel = { before: before.debug, after: afterWheel, markerPositionsChanged: wheelMarkerChanged, effective: wheelChanged };
  if (wheelChanged) {
    check(
      state,
      group,
      "8.1",
      "CDP 滚轮缩放生效（debug.zoom 或 debug.center 变化）",
      true,
      "滚轮后 zoom 或 center 变化",
      `zoom ${beforeZoom}→${afterWheel === null ? "?" : afterWheel.zoom}；center ${JSON.stringify(beforeCenter)}→${JSON.stringify(afterWheel === null ? null : afterWheel.center)}`,
    );
  } else {
    skipCheck(
      state,
      group,
      "8.1",
      "CDP 滚轮缩放：headless 合成 mouseWheel 不改变 AMap 视野（已知现象，不算产品 bug）",
      `滚轮后 zoom/center 均未变化（zoom=${beforeZoom}，center=${JSON.stringify(beforeCenter)}），marker 屏幕位置也未变；` +
        "与 build/verify/map-replay.mjs 记录的既有结论一致。按 contract §7.9，验收 8 由下方「任一真实手势」+ drawCount 不变判定。",
    );
  }

  // ---------- 8.2 拖拽平移（真实手势；contract §7.9 实测有效路径） ----------
  const dragOnce = async (fromX, fromY, label) => {
    // 注意：先取拖拽前快照，再派发事件（moveend 后 debug.center 才会回写）。
    const beforeDragState = await readDebug(cdp);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: fromX, y: fromY, button: "left", buttons: 1, clickCount: 1 }).catch(() => {});
    for (const [dx, dy] of [[14, 12], [36, 30], [64, 52], [96, 78]]) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: fromX + dx, y: fromY + dy, button: "left", buttons: 1 }).catch(() => {});
      await sleepSafe(60);
    }
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: fromX + 96, y: fromY + 78, button: "left", buttons: 0, clickCount: 1 }).catch(() => {});
    let changed = null;
    try {
      changed = await waitForEvaluate(
        cdp,
        DEBUG_SNAPSHOT_CODE,
        (value) =>
          value !== null &&
          value.center !== null &&
          beforeDragState !== null &&
          beforeDragState.center !== null &&
          (Math.abs(value.center.lng - beforeDragState.center.lng) > 1e-9 || Math.abs(value.center.lat - beforeDragState.center.lat) > 1e-9),
        8000,
        `验收 8：拖拽（${label}）后 debug.center 变化`,
        150,
      );
    } catch {
      changed = await readDebug(cdp);
    }
    return { beforeDragState: beforeDragState, afterDrag: changed };
  };

  const dragChangedOf = (result) =>
    result !== null &&
    result.beforeDragState !== null &&
    result.afterDrag !== null &&
    result.beforeDragState.center !== null &&
    result.afterDrag.center !== null &&
    (Math.abs(result.afterDrag.center.lng - result.beforeDragState.center.lng) > 1e-9 || Math.abs(result.afterDrag.center.lat - result.beforeDragState.center.lat) > 1e-9);

  // 起点避开 marker（marker 上挂了 click 监听，按在 marker 上可能不触发地图拖拽）；最多试 2 个点。
  const dragPoints = [];
  const pickedDragPoint = await cdp.evaluate(exprPickDragPoint()).catch(() => null);
  if (pickedDragPoint !== null && typeof pickedDragPoint.x === "number") dragPoints.push(pickedDragPoint);
  dragPoints.push({
    x: canvasRect.left + Math.round(canvasRect.width * 0.3),
    y: canvasRect.top + Math.round(canvasRect.height * 0.35),
    minDistance: "?",
    fraction: null,
  });

  let dragResult = null;
  let dragChanged = false;
  let dragMethod = "";
  for (let attempt = 0; attempt < dragPoints.length && !dragChanged; attempt += 1) {
    const point = dragPoints[attempt];
    await waitViewSettled(cdp, `拖拽尝试 ${attempt + 1} 前`, 8000);
    const attemptLabel = `起点 (${point.x}, ${point.y})，离最近 marker ${point.minDistance}px`;
    const attemptResult = await dragOnce(point.x, point.y, attemptLabel);
    await waitViewSettled(cdp, `拖拽尝试 ${attempt + 1} 后`, 8000);
    const settledAfter = await readDebug(cdp);
    dragResult = { beforeDragState: attemptResult.beforeDragState, afterDrag: settledAfter === null ? attemptResult.afterDrag : settledAfter };
    dragChanged = dragChangedOf(dragResult);
    dragMethod = `CDP Input.dispatchMouseEvent(mousePressed → mouseMoved×4 → mouseReleased)，${attemptLabel}`;
    if (!dragChanged) infoLog(`验收 8：第 ${attempt + 1} 次拖拽未改变 center（${attemptLabel}），换点重试`);
  }
  const dragProbe = await cdp.evaluate(VIEW_PROBE_EXPR).catch(() => null);
  const dragMarkerChanged = dragProbe !== null && JSON.stringify(dragProbe.markers) !== JSON.stringify(wheelProbe === null ? [] : wheelProbe.markers);
  state.debug.gestureDrag = {
    before: dragResult.beforeDragState,
    after: dragResult.afterDrag,
    markerPositionsChanged: dragMarkerChanged,
    effective: dragChanged,
    method: dragMethod,
  };
  check(
    state,
    group,
    "8.2",
    "CDP 拖拽平移生效（debug.center 变化；mousePressed → mouseMoved×4 → mouseReleased）",
    dragChanged,
    "拖拽后 debug.center 与拖拽前不同",
    dragResult.beforeDragState === null || dragResult.afterDrag === null
      ? "debug=null"
      : `center ${dragResult.beforeDragState.center === null ? "null" : `(${dragResult.beforeDragState.center.lng}, ${dragResult.beforeDragState.center.lat})`}→${dragResult.afterDrag.center === null ? "null" : `(${dragResult.afterDrag.center.lng}, ${dragResult.afterDrag.center.lat})`}；方式=${dragMethod}；marker 屏幕位置变化=${dragMarkerChanged}（辅助证据）`,
  );

  // ---------- 8.3 验收 8 总口径：任一真实手势让 center 或 zoom 变化 ----------
  let realGestureEffective = wheelChanged || dragChanged;
  let gestureMethod = wheelChanged && dragChanged ? "滚轮 + 拖拽均生效" : wheelChanged ? "滚轮生效（拖拽未观察到位移）" : dragChanged ? "拖拽生效（滚轮为 headless 已知不生效）" : "真实手势均未生效";
  let fallbackUsed = false;
  let fallbackZoom = null;
  if (!realGestureEffective) {
    // contract §7.9 兜底通道：debug.getMap() 返回真实 AMap.Map（dev only），setZoom 制造「视野变了」证据。
    const fallbackResult = await cdp.evaluate(`(() => {
      const debug = window.__ADMIN_MAP_DEBUG__;
      const map = debug !== undefined && debug !== null && typeof debug.getMap === "function" ? debug.getMap() : null;
      if (map === null) return { ok: false, reason: "debug.getMap() 不可用" };
      try {
        const zoom = map.getZoom();
        map.setZoom(zoom + 1);
        return { ok: true, zoom: zoom, next: zoom + 1 };
      } catch (error) {
        return { ok: false, reason: String(error) };
      }
    })()`).catch((error) => ({ ok: false, reason: messageText(error) }));
    if (fallbackResult.ok === true) {
      try {
        const zoomed = await waitForEvaluate(
          cdp,
          DEBUG_SNAPSHOT_CODE,
          (value) => value !== null && value.zoom !== null && value.zoom !== beforeZoom,
          5000,
          "验收 8：兜底 setZoom 后 debug.zoom 变化",
          150,
        );
        fallbackUsed = zoomed !== null && zoomed.zoom !== null && zoomed.zoom !== beforeZoom;
        fallbackZoom = zoomed === null ? null : zoomed.zoom;
      } catch {
        fallbackUsed = false;
      }
    }
    gestureMethod = `真实手势均未生效 → 兜底 debug.getMap().setZoom(${fallbackResult.zoom ?? "?"}+1)${fallbackUsed ? " 生效" : " 也未生效"}`;
    realGestureEffective = fallbackUsed;
  }
  let finalDebug = await readDebug(cdp);
  if (fallbackUsed) finalDebug = (await waitViewSettled(cdp, "兜底 setZoom 后", 6000)) ?? finalDebug;
  check(
    state,
    group,
    "8.3",
    "验收 8：手势让视野变化（debug.zoom 或 center 变化）" + (fallbackUsed ? "——**使用兜底方法，报告已标明**" : ""),
    realGestureEffective,
    "任一真实手势（滚轮/拖拽）让 debug.zoom 或 debug.center 变化；兜底方法需标明",
    `${gestureMethod}；zoom ${beforeZoom}→${finalDebug === null ? "?" : finalDebug.zoom}；center→${finalDebug === null ? "?" : JSON.stringify(finalDebug.center)}${fallbackUsed ? `；兜底 setZoom 后 zoom=${fallbackZoom}` : ""}`,
  );

  // ---------- 8.4 手势不触发重画 ----------
  check(
    state,
    group,
    "8.4",
    "缩放手势不触发重画：drawCount / fitViewCount 不变（任务书验收 8）",
    finalDebug !== null && finalDebug.drawCount === before.debug.drawCount && finalDebug.fitViewCount === before.debug.fitViewCount,
    `drawCount=${before.debug.drawCount} 不变；fitViewCount=${before.debug.fitViewCount} 不变`,
    finalDebug === null ? "debug=null" : `drawCount=${before.debug.drawCount}→${finalDebug.drawCount}；fitViewCount=${before.debug.fitViewCount}→${finalDebug.fitViewCount}`,
  );

  // ---------- 8.5 marker 未被重建 ----------
  const probeExists = await cdp.evaluate(`(() => { const marker = document.querySelector('[data-map-marker="true"][data-verify-probe="keep"]'); return marker !== null; })()`).catch(() => false);
  const finalState = await readPageState(cdp);
  check(
    state,
    group,
    "8.5",
    "手势后 marker 未被重建（DOM 探针仍在、marker 仍 116）",
    probeExists === true && finalState !== null && finalState.markerDomCount === EXPECTED.beijingTotal && finalState.debug !== null && finalState.debug.markerCount === EXPECTED.beijingTotal,
    "data-verify-probe 属性仍在；marker=116",
    `探针存在=${probeExists}；DOM marker=${finalState === null ? "?" : finalState.markerDomCount}；debug.markerCount=${finalState === null || finalState.debug === null ? "?" : finalState.debug.markerCount}`,
  );

  const shotResult = await safeShot(cdp, state, "admin-map-gesture.png");
  check(state, group, "8.6", "手势后截图 .cache/verify/admin-map-gesture.png", shotResult !== null, "截图存在", shotResult === null ? "截图失败" : rel(shotResult.path));
}

/* ------------------------------------------------------------------ *
 * Tab：活动 ↔ 地点（地图尺寸恢复）
 * ------------------------------------------------------------------ */

async function phaseTabSwitch(state, cdp) {
  const group = GROUPS.tab;
  const before = await readDebug(cdp);

  const eventsTab = await cdp.evaluate(exprClickTab("活动")).catch((error) => ({ clicked: false, reason: messageText(error) }));
  let tabState = null;
  try {
    tabState = await waitForEvaluate(
      cdp,
      TAB_STATE_EXPR,
      (value) => value.hasEventsHeading === true && value.tabs.some((tab) => tab.text === "活动" && tab.selected === "true"),
      20000,
      "Tab：切到「活动」分区（活动列表出现）",
      200,
    );
  } catch (error) {
    tabState = await cdp.evaluate(TAB_STATE_EXPR).catch(() => null);
    infoLog(`Tab 切到活动等待超时：${messageText(error)}`);
  }
  check(
    state,
    group,
    "TAB1",
    "点击顶部 tab「活动」→ 活动分区显示（活动列表出现）",
    eventsTab.clicked === true && tabState !== null && tabState.hasEventsHeading === true,
    "tab 活动 aria-selected=true 且出现「活动列表」",
    tabState === null ? "读取 tab 状态失败" : `hasEventsHeading=${tabState.hasEventsHeading}；tabs=${tabState.tabs.map((tab) => `${tab.text}:${tab.selected}`).join("，")}`,
  );

  const hiddenState = await cdp.evaluate(MAP_HIDDEN_STATE_EXPR).catch(() => null);
  state.tabHidden = hiddenState;
  infoLog(`切到活动 tab 时地图可见性：${hiddenState === null ? "读取失败" : `visible=${hiddenState.visible}，rect=${JSON.stringify(hiddenState.rect)}`}`);

  const placesTab = await cdp.evaluate(exprClickTab("地点")).catch((error) => ({ clicked: false, reason: messageText(error) }));
  let backState = null;
  try {
    backState = await waitForEvaluate(
      cdp,
      MAP_HIDDEN_STATE_EXPR,
      (value) => value.exists === true && value.visible === true && value.rows === EXPECTED.beijingTotal,
      20000,
      "Tab：切回「地点」分区且地图恢复可见",
      200,
    );
  } catch (error) {
    backState = await cdp.evaluate(MAP_HIDDEN_STATE_EXPR).catch(() => null);
    infoLog(`Tab 切回地点等待超时：${messageText(error)}`);
  }
  const after = await readDebug(cdp);
  state.debug.afterTab = after;
  state.layout.tabBack = backState;
  const visibleOk = backState !== null && backState.visible === true;
  const markersKept = after !== null && after.markerCount === EXPECTED.beijingTotal;
  const resizeCount = after === null ? 0 : after.resizeCount;
  check(
    state,
    group,
    "TAB2",
    "切回「地点」后地图仍可见（marker 仍在 或 resizeCount ≥1）",
    placesTab.clicked === true && visibleOk && (markersKept || resizeCount >= 1),
    "地图 section 可见 && (markers=116 或 resizeCount≥1)",
    backState === null ? "读取地图状态失败" : `visible=${backState.visible}；rect=${JSON.stringify(backState.rect)}；markers=${after === null ? "?" : after.markerCount}；resizeCount=${resizeCount}`,
  );

  const shotResult = await safeShot(cdp, state, "admin-map-tab-back.png");
  check(state, group, "TAB3", "切回地点分区后截图 .cache/verify/admin-map-tab-back.png", shotResult !== null, "截图存在", shotResult === null ? "截图失败" : rel(shotResult.path));
}

/* ------------------------------------------------------------------ *
 * 控制台无 error（正常流程；AMap 噪声按既有口径过滤）
 * ------------------------------------------------------------------ */

function assertConsoleNormal(state, collector) {
  const group = GROUPS.console;
  if (collector === null) {
    check(state, group, "CON0", "console 收集器可用", false, "createConsoleCollector 已挂载", "collector=null");
    return;
  }
  const rawErrors = collector.errors.slice();
  const filtered = rawErrors.filter((line) => !CONSOLE_NOISE.test(String(line)));
  state.console.normal = {
    rawCount: rawErrors.length,
    filtered: filtered.slice(0, 20),
    warningsCount: collector.warnings.length,
    warningsSample: collector.warnings.slice(0, 5),
  };
  check(
    state,
    group,
    "CON1",
    "正常流程（首屏/筛选/搜索/联动/切城市/手势/tab）控制台无 error",
    filtered.length === 0,
    "过滤 AMap 资源类噪声后 0 条 error",
    filtered.length === 0
      ? `0 条（原始 ${rawErrors.length} 条均命中既有噪声过滤口径；warnings=${collector.warnings.length} 条）`
      : `${filtered.length} 条：${filtered.slice(0, 5).join(" ｜ ")}`,
  );
}

/* ------------------------------------------------------------------ *
 * 布局 390×844（窄屏地图在上 320px）
 * ------------------------------------------------------------------ */

async function phaseNarrowLayout(state, cdp) {
  const group = GROUPS.layoutNarrow;
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: VIEWPORT_NARROW.width, height: VIEWPORT_NARROW.height, deviceScaleFactor: 1, mobile: false }).catch((error) => infoLog(`设置窄屏视口失败：${messageText(error)}`));
  await sleepSafe(800);
  await cdp.evaluate("window.scrollTo(0, 0)").catch(() => {});

  let layout = null;
  try {
    layout = await waitForEvaluate(
      cdp,
      LAYOUT_EXPR,
      (value) => value.section.rect !== null && value.section.rect.height >= 318 && value.section.rect.height <= 322 && value.section.rect.width > 300,
      10000,
      "窄屏布局：地图高度 ≈320px",
      250,
    );
  } catch (error) {
    layout = await cdp.evaluate(LAYOUT_EXPR).catch(() => null);
    infoLog(`窄屏布局等待超时：${messageText(error)}`);
  }
  state.layout.narrow = layout;
  if (layout === null || layout.section.rect === null || layout.list.rect === null) {
    check(state, group, "N0", "读取 390×844 窄屏布局", false, "能读到列表/地图 rect", "读取失败");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: VIEWPORT_DESKTOP.width, height: VIEWPORT_DESKTOP.height, deviceScaleFactor: 1, mobile: false }).catch(() => {});
    return;
  }
  const section = layout.section.rect;
  const list = layout.list.rect;
  const parentWidth = layout.sectionParent.clientWidth;

  check(
    state,
    group,
    "N1",
    "窄屏：地图在列表上方（上下排）",
    section.top < list.top,
    "map.top < list.top",
    `map.top=${Math.round(section.top)}；list.top=${Math.round(list.top)}；viewport=${layout.viewport.width}x${layout.viewport.height}`,
  );
  check(
    state,
    group,
    "N2",
    "窄屏：地图高度 ≈ 320px（±2px）",
    Math.abs(section.height - 320) <= 2,
    "320px（±2）",
    `${section.height.toFixed(1)}px`,
  );
  const widthOk = parentWidth !== null && Math.abs(section.width - parentWidth) <= 2 && Math.abs(section.width - list.width) <= 2;
  check(
    state,
    group,
    "N3",
    "窄屏：地图宽度撑满容器（= 父容器宽 = 列表宽，±2px）",
    widthOk,
    `地图宽 = 父容器宽（${parentWidth}px）= 列表宽`,
    `地图宽=${section.width.toFixed(1)}px；父容器 clientWidth=${parentWidth}；列表宽=${list.width.toFixed(1)}px`,
  );

  let narrowPage = await readPageState(cdp);
  try {
    narrowPage = await waitForPage(
      cdp,
      (value) => value.markerDomCount === EXPECTED.beijingTotal && value.debug !== null && value.debug.mapReady === true,
      8000,
      "窄屏：地图仍 116 marker",
    );
  } catch (error) {
    narrowPage = await readPageState(cdp);
    infoLog(`窄屏等待 marker 超时：${messageText(error)}`);
  }
  check(
    state,
    group,
    "N4",
    "窄屏布局下地图仍可用（mapReady=true、marker=116）",
    narrowPage !== null && narrowPage.debug !== null && narrowPage.debug.mapReady === true && narrowPage.markerDomCount === EXPECTED.beijingTotal,
    "mapReady=true；marker=116",
    narrowPage === null || narrowPage.debug === null ? "读取失败" : `mapReady=${narrowPage.debug.mapReady}；DOM marker=${narrowPage.markerDomCount}；markerCount=${narrowPage.debug.markerCount}`,
  );

  await cdp.evaluate("window.scrollTo(0, 0)").catch(() => {});
  const shotResult = await safeShot(cdp, state, "admin-map-390.png");
  check(state, group, "N5", "窄屏截图 .cache/verify/admin-map-390.png", shotResult !== null, "截图存在", shotResult === null ? "截图失败" : rel(shotResult.path));

  await cdp.send("Emulation.setDeviceMetricsOverride", { width: VIEWPORT_DESKTOP.width, height: VIEWPORT_DESKTOP.height, deviceScaleFactor: 1, mobile: false }).catch((error) => infoLog(`恢复桌面视口失败：${messageText(error)}`));
  await sleepSafe(600);
  await cdp.evaluate("window.scrollTo(0, 0)").catch(() => {});
}

/* ------------------------------------------------------------------ *
 * 验收 9：屏蔽高德 CDN → 地图失败降级，列表仍可用
 * ------------------------------------------------------------------ */

async function phaseBlockedError(state, cdp, collector) {
  const group = GROUPS.accept9;
  const errorMark = collector === null ? 0 : collector.errors.length;
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true }).catch((error) => infoLog(`setCacheDisabled 失败：${messageText(error)}`));
  await cdp.send("Network.setBlockedURLs", { urls: ["*webapi.amap.com*"] }).catch((error) => infoLog(`setBlockedURLs 失败：${messageText(error)}`));
  infoLog("已设置 Network.setBlockedURLs([*webapi.amap.com*]) 并禁用缓存，重新导航 /admin");

  let navigated = false;
  try {
    await cdp.send("Page.navigate", { url: ADMIN_URL });
    await waitForEvaluate(cdp, "document.readyState", (value) => value === "complete", 120000, "验收 9：屏蔽 CDN 后页面加载完成", 200);
    navigated = true;
  } catch (error) {
    infoLog(`验收 9 导航失败：${messageText(error)}`);
  }
  check(
    state,
    group,
    "9.1",
    "屏蔽 *webapi.amap.com* 后重新导航 /admin 成功",
    navigated === true,
    "Page.navigate 成功且 readyState=complete",
    navigated ? "导航成功" : "导航超时/失败",
  );

  let listState = null;
  try {
    listState = await waitForPage(cdp, (value) => value.hasList && value.rows === EXPECTED.beijingTotal, 120000, "验收 9：列表仍 116 行（地图失败不影响列表）");
  } catch (error) {
    listState = await readPageState(cdp);
    infoLog(`验收 9 等待列表 116 行超时：${messageText(error)}`);
  }
  check(
    state,
    group,
    "9.2",
    "地图加载失败时列表仍加载 116 行",
    listState !== null && listState.rows === EXPECTED.beijingTotal,
    "rows=116",
    listState === null ? "页面不可读" : `rows=${listState.rows}；hasList=${listState.hasList}`,
  );

  let errorState = null;
  try {
    errorState = await waitForEvaluate(cdp, MAP_ERROR_STATE_EXPR, (value) => value.hasError === true, 90000, "验收 9：出现 [data-testid=admin-map-error]", 300);
  } catch (error) {
    errorState = await cdp.evaluate(MAP_ERROR_STATE_EXPR).catch(() => null);
    infoLog(`验收 9 等待地图错误态超时：${messageText(error)}`);
  }
  state.debug.blocked = errorState;
  check(
    state,
    group,
    "9.3",
    "地图区显示降级文案「地图加载失败，不影响编辑」（逐字）",
    errorState !== null && errorState.hasError === true && errorState.errorText === "地图加载失败，不影响编辑" && errorState.errorVisible === true,
    "[data-testid=\"admin-map-error\"] 可见，文案逐字一致",
    errorState === null ? "读取失败" : `hasError=${errorState.hasError}；errorText=${JSON.stringify(errorState.errorText)}；errorVisible=${errorState.errorVisible}；debug.error=${errorState.debug === null ? "debug=null" : JSON.stringify(errorState.debug.error)}`,
  );
  check(
    state,
    group,
    "9.4",
    "地图失败时列表仍可用：116 行 + 首行「编辑」按钮可见",
    errorState !== null && errorState.rows === EXPECTED.beijingTotal && errorState.editButtons > 0,
    "rows=116；可见「编辑」按钮 >0",
    errorState === null ? "读取失败" : `rows=${errorState.rows}；可见编辑按钮=${errorState.editButtons}`,
  );
  check(
    state,
    group,
    "9.5",
    "地图失败时图区容器仍在（只是内容降级，不白屏炸页面）",
    errorState !== null && errorState.hasMapSection === true,
    "[data-testid=admin-places-map] 仍存在",
    errorState === null ? "读取失败" : `hasMapSection=${errorState.hasMapSection}`,
  );

  const shotResult = await safeShot(cdp, state, "admin-map-error.png");
  check(state, group, "9.6", "地图失败降级截图 .cache/verify/admin-map-error.png", shotResult !== null, "截图存在", shotResult === null ? "截图失败" : rel(shotResult.path));

  if (collector !== null) {
    const blockedErrors = collector.errors.slice(errorMark);
    state.console.blocked = {
      count: blockedErrors.length,
      filtered: blockedErrors.filter((line) => !CONSOLE_NOISE.test(String(line))).slice(0, 10),
      sample: blockedErrors.slice(0, 5),
    };
    infoLog(`验收 9 阶段新增 console 记录 ${blockedErrors.length} 条（网络被拦截属于预期，不计 FAIL）`);
  }

  // 收尾：恢复网络（浏览器马上要关闭，仍还原以免影响回归脚本）
  await cdp.send("Network.setBlockedURLs", { urls: [] }).catch(() => {});
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: false }).catch(() => {});
}

/* ------------------------------------------------------------------ *
 * 浏览器主流程
 * ------------------------------------------------------------------ */

async function withBrowser(state) {
  let launched = null;
  let cdp = null;
  let collector = null;
  try {
    launched = await launchEdge();
    state.browser.version = launched.version === undefined ? "(未知)" : launched.version.Browser ?? "(未知)";
    state.browser.cdpPort = launched.port;
    infoLog(`headless Edge 已启动：${state.browser.version}（CDP port=${launched.port}）`);

    const page = await connectPage(launched.port, {
      label: "admin-map-acceptance",
      viewport: VIEWPORT_DESKTOP,
      seedProfile: false,
      autoSkipOnboarding: false,
    });
    cdp = page.cdp;
    collector = createConsoleCollector(cdp);
    await cdp.send("Network.enable").catch(() => {});
    await cdp.send("Page.navigate", { url: ADMIN_URL });

    await phaseInitial(state, cdp);
    await phaseLayoutDesktop(state, cdp);

    if (state.mapOk) {
      await phasePark(state, cdp);
      await phaseSearch(state, cdp);
      await phaseRow3(state, cdp);
      await phaseMarkerClick(state, cdp);
      await phaseIncludeHidden(state, cdp);
      await phaseCitySwitch(state, cdp);
      await phaseGesture(state, cdp);
      await phaseTabSwitch(state, cdp);
    } else {
      const skipReason = "前置验收 1 失败（地图未就绪 / debug 钩子缺失），跳过依赖地图的验收";
      for (const group of [GROUPS.accept2, GROUPS.accept3, GROUPS.accept4, GROUPS.accept5, GROUPS.accept6, GROUPS.accept7, GROUPS.accept8, GROUPS.tab]) {
        skipCheck(state, group, "SKIP", `跳过 ${group.split("：")[0]}`, skipReason);
      }
    }

    // 正常流程 console（必须在验收 9 屏蔽网络之前统计）
    assertConsoleNormal(state, collector);

    await phaseNarrowLayout(state, cdp);
    await phaseBlockedError(state, cdp, collector);
  } finally {
    state.console.rawErrors = collector === null ? [] : collector.errors.slice(0, 50);
    state.console.rawWarnings = collector === null ? [] : collector.warnings.slice(0, 30);
    if (cdp !== null) {
      try {
        cdp.close();
      } catch {
        /* ignore */
      }
    }
    if (launched !== null) await closeEdge(launched);
  }
}

/* ------------------------------------------------------------------ *
 * 验收 6 补充：npx tsx 直接 import components/adminMapStyle.ts 单测空心圈
 * ------------------------------------------------------------------ */

function buildStyleUnitSource() {
  return String.raw`/**
 * adminMapStyle 纯函数单元断言（验收 6：空心圈 / 实心点样式）
 *
 * 由 scripts/verify/admin-map-acceptance.mjs 生成。本轮数据里 hidden 点为 0，
 * 浏览器 DOM 里不会出现空心圈，所以「hidden 点的空心样式」只能在这一层（纯函数）验证。
 *
 * 跑法：npx tsx .cache/verify/admin-map-style-unit.mts
 * 退出码：0 = 全部 PASS；1 = 有 FAIL。
 */
import {
  CATEGORY_COLORS,
  MARKER_DOT_SIZE_PX,
  MARKER_OUTLINE_COLOR,
  MARKER_SELECTED_SCALE,
  markerDotStyle,
  markerSelectedTransform,
} from "../../components/adminMapStyle";

type UnitResult = { group: string; name: string; status: "PASS" | "FAIL"; expected: string; actual: string };

const results: UnitResult[] = [];
function record(group: string, name: string, ok: boolean, expected: string, actual: string): void {
  results.push({ group: group, name: name, status: ok ? "PASS" : "FAIL", expected: expected, actual: actual });
}

const EXPECTED_COLORS: Record<string, string> = ${JSON.stringify(CATEGORY_HEX, null, 2)};
const EXPECTED_ORDER: string[] = ${JSON.stringify(LEGEND_ORDER)};
const styleOf = markerDotStyle as unknown as (category: string, hidden: boolean) => unknown;

const palette = (CATEGORY_COLORS ?? {}) as Record<string, string>;
const paletteKeys = Object.keys(palette);
record("palette", "CATEGORY_COLORS 恰好 10 类（schema 10 类全覆盖）", paletteKeys.length === 10, "10 类", paletteKeys.length + " 类：" + paletteKeys.join(","));
for (const category of EXPECTED_ORDER) {
  const actual = String(palette[category] ?? "").toLowerCase();
  record("palette", "CATEGORY_COLORS[" + category + "] = " + EXPECTED_COLORS[category], actual === EXPECTED_COLORS[category], EXPECTED_COLORS[category], actual === "" ? "(缺失)" : actual);
}

record("constants", "MARKER_DOT_SIZE_PX = 10", MARKER_DOT_SIZE_PX === 10, "10", String(MARKER_DOT_SIZE_PX));
record("constants", "MARKER_OUTLINE_COLOR = #ffffff", String(MARKER_OUTLINE_COLOR).toLowerCase() === "#ffffff", "#ffffff", String(MARKER_OUTLINE_COLOR));
record("constants", "MARKER_SELECTED_SCALE = 1.6", MARKER_SELECTED_SCALE === 1.6, "1.6", String(MARKER_SELECTED_SCALE));
const selectedTransform = typeof markerSelectedTransform === "function" ? String(markerSelectedTransform()) : "(无)";
record("constants", "markerSelectedTransform() 含 scale(1.6)", /scale\(\s*1\.6\s*\)/.test(selectedTransform), "scale(1.6)", selectedTransform);

function flatten(style: unknown): Record<string, unknown> | null {
  if (style === null || typeof style !== "object") return null;
  const source = style as Record<string, unknown>;
  const nested = source["style"];
  if (nested !== null && nested !== undefined && typeof nested === "object") return flatten(nested);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    out[key.replace(/[A-Z]/g, (match) => "-" + match.toLowerCase())] = source[key];
  }
  return out;
}
function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}
function compact(value: unknown): string {
  return text(value).replace(/\s+/g, "");
}
function rgbOf(hex: string): { r: number; g: number; b: number } {
  const value = hex.replace("#", "");
  return { r: parseInt(value.slice(0, 2), 16), g: parseInt(value.slice(2, 4), 16), b: parseInt(value.slice(4, 6), 16) };
}
function containsColor(value: unknown, hex: string): boolean {
  const raw = text(value).toLowerCase();
  if (raw === "") return false;
  if (raw.indexOf(hex.toLowerCase()) !== -1) return true;
  const rgb = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(raw);
  if (rgb === null) return false;
  const target = rgbOf(hex);
  return Number(rgb[1]) === target.r && Number(rgb[2]) === target.g && Number(rgb[3]) === target.b;
}
function isTransparent(value: unknown): boolean {
  const raw = text(value).trim().toLowerCase();
  if (raw === "transparent") return true;
  const rgba = /rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([0-9.]+)\s*\)/.exec(raw);
  return rgba !== null && Number(rgba[1]) === 0;
}
function backgroundValue(style: Record<string, unknown>): unknown {
  return style["background-color"] !== undefined ? style["background-color"] : style["background"];
}
function borderValue(style: Record<string, unknown>): string {
  const shorthand = text(style["border"]).trim();
  if (shorthand !== "") return shorthand;
  return [text(style["border-width"]), text(style["border-style"]), text(style["border-color"])].filter((part) => part.trim() !== "").join(" ");
}
function sizeValue(style: Record<string, unknown>, key: string): string {
  const value = style[key];
  return typeof value === "number" ? value + "px" : compact(value);
}
function describe(style: Record<string, unknown> | null): string {
  if (style === null) return "(markerDotStyle 返回非对象)";
  return "background=" + text(backgroundValue(style)) + "；border=" + borderValue(style) + "；width=" + sizeValue(style, "width") + "；height=" + sizeValue(style, "height") + "；borderRadius=" + sizeValue(style, "border-radius") + "；boxSizing=" + sizeValue(style, "box-sizing");
}

for (const category of EXPECTED_ORDER) {
  const hex = EXPECTED_COLORS[category];

  const solid = flatten(styleOf(category, false));
  const solidBackgroundOk = solid !== null && containsColor(backgroundValue(solid), hex);
  const solidBorderOk = solid !== null && /(^|\s)1px(\s|$)/.test(borderValue(solid)) && containsColor(borderValue(solid), "#ffffff");
  record("solid", "实心点 " + category + "：类目色填充 + 1px 白边", solidBackgroundOk && solidBorderOk, "background=" + hex + "；border=1px solid #ffffff", describe(solid));
  const solidBoxOk = solid !== null && sizeValue(solid, "width") === "10px" && sizeValue(solid, "height") === "10px" && sizeValue(solid, "border-radius") === "50%" && sizeValue(solid, "box-sizing") === "border-box";
  record("solid", "实心点 " + category + "：10px 圆点 + border-box", solidBoxOk, "width/height=10px；border-radius=50%；box-sizing=border-box", describe(solid));

  const hollow = flatten(styleOf(category, true));
  const hollowBackgroundOk = hollow !== null && isTransparent(backgroundValue(hollow));
  const hollowBorderOk = hollow !== null && /(^|\s)2px(\s|$)/.test(borderValue(hollow)) && containsColor(borderValue(hollow), hex);
  record("hidden", "空心点 " + category + "：透明填充 + 2px 类目色边框", hollowBackgroundOk && hollowBorderOk, "background=transparent；border=2px solid " + hex, describe(hollow));
  const hollowBoxOk = hollow !== null && sizeValue(hollow, "width") === "10px" && sizeValue(hollow, "height") === "10px" && sizeValue(hollow, "border-radius") === "50%" && sizeValue(hollow, "box-sizing") === "border-box";
  record("hidden", "空心点 " + category + "：10px 空心圆 + border-box", hollowBoxOk, "width/height=10px；border-radius=50%；box-sizing=border-box", describe(hollow));
}

const failed = results.filter((item) => item.status === "FAIL");
console.log("__UNIT_JSON__" + JSON.stringify({ results: results, failed: failed.length, total: results.length }));
process.exitCode = failed.length === 0 ? 0 : 1;
`;
}

function writeStyleUnitSource() {
  ensureDirs();
  writeFileSync(STYLE_UNIT_FILE, buildStyleUnitSource(), "utf8");
  return STYLE_UNIT_FILE;
}

function runStyleUnit(state) {
  const group = GROUPS.accept6;
  let unitPath = null;
  try {
    unitPath = writeStyleUnitSource();
  } catch (error) {
    check(state, group, "6.U0", "生成空心圈单测文件（.cache/verify/admin-map-style-unit.mts）", false, "写入成功", `失败：${messageText(error)}`);
    return;
  }
  const command = "npx tsx .cache/verify/admin-map-style-unit.mts";
  infoLog(`运行空心圈单元断言：${command}`);
  const startedAt = Date.now();
  const result = spawnSync(command, {
    shell: true,
    cwd: ROOT_DIR,
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const tail = `${stdout}\n${stderr}`.trim().split(/\r?\n/).slice(-30).join("\n");
  let parsed = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith("__UNIT_JSON__")) {
      try {
        parsed = JSON.parse(line.slice("__UNIT_JSON__".length));
      } catch (error) {
        infoLog(`单测 JSON 解析失败：${messageText(error)}`);
      }
    }
  }
  state.unit = {
    path: unitPath,
    command: command,
    exitCode: result.status,
    elapsedMs: Date.now() - startedAt,
    parsed: parsed === null ? null : { total: parsed.total, failed: parsed.failed, results: parsed.results },
    stdoutTail: tail,
  };
  check(
    state,
    group,
    "6.U0",
    "npx tsx 单元断言脚本可运行（缓存目录内临时文件，不新增依赖）",
    result.status === 0 && parsed !== null && parsed.total > 0,
    "退出码 0 + 输出 __UNIT_JSON__",
    `退出码=${result.status}；耗时=${Date.now() - startedAt}ms；单测项=${parsed === null ? "未解析" : parsed.total}${result.status === 0 ? "" : `；输出：${tail.slice(0, 400)}`}`,
  );
  if (parsed === null) return;

  const expectations = {
    palette: "CATEGORY_COLORS 10 类颜色逐字等于契约 §3",
    constants: "圆点常量：直径 10px / 白边 #ffffff / 选中 scale 1.6",
    solid: "实心点：10 类目 background-color=类目色 + 1px solid #ffffff + 10px/border-box",
    hidden: "空心点：10 类目 background-color=transparent + 2px solid 类目色 + 10px/border-box",
  };
  for (const unitGroup of ["palette", "constants", "solid", "hidden"]) {
    const list = parsed.results.filter((item) => item.group === unitGroup);
    const failedItems = list.filter((item) => item.status !== "PASS");
    const ok = list.length > 0 && failedItems.length === 0;
    check(
      state,
      group,
      `6.U-${unitGroup}`,
      expectations[unitGroup],
      ok,
      `全部 PASS（${list.length} 项）`,
      ok ? `${list.length}/${list.length} PASS` : `FAIL ${failedItems.length}/${list.length}：${failedItems.slice(0, 4).map((item) => `${item.name}（期望 ${item.expected}，实际 ${item.actual}）`).join("；")}`,
    );
  }
  infoLog("本轮数据 hidden=0（两城都是），浏览器 DOM 里只可能画实心点；空心圈样式由上面 4 组单元断言覆盖（报告备注）。");
}

/* ------------------------------------------------------------------ *
 * 回归：node scripts/verify/admin-ui.mjs
 * ------------------------------------------------------------------ */

function runRegression(state) {
  const group = GROUPS.regression;
  const command = "node scripts/verify/admin-ui.mjs";
  infoLog(`回归运行：${command}（浏览器已关闭，锁仍由本脚本持有）`);
  const startedAt = Date.now();
  const result = spawnSync(command, {
    shell: true,
    cwd: ROOT_DIR,
    encoding: "utf8",
    timeout: 10 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const logText = `$ ${command}\n\n[stdout]\n${stdout}\n[stderr]\n${stderr}\n`;
  let logPath = null;
  try {
    ensureDirs();
    logPath = path.join(REPORT_DIR, "admin-ui-regression.log");
    writeFileSync(logPath, logText, "utf8");
  } catch (error) {
    infoLog(`写回归日志失败：${messageText(error)}`);
  }
  const summaryMatch = /PASS (\d+) \/ FAIL (\d+) \/ SKIP (\d+)/.exec(stdout);
  const passCount = summaryMatch === null ? null : Number(summaryMatch[1]);
  const failCount = summaryMatch === null ? null : Number(summaryMatch[2]);
  state.regression = {
    command: command,
    exitCode: result.status,
    elapsedMs: Date.now() - startedAt,
    pass: passCount,
    fail: failCount,
    summaryLine: summaryMatch === null ? null : summaryMatch[0],
    logPath: logPath,
    tail: `${stdout}\n${stderr}`.trim().split(/\r?\n/).slice(-40).join("\n"),
  };
  check(
    state,
    group,
    "REG1",
    "回归 node scripts/verify/admin-ui.mjs 仍 PASS（既有后台配色/活动分区验收）",
    result.status === 0 && failCount === 0,
    "退出码 0；汇总 FAIL 0",
    `退出码=${result.status}；汇总=${summaryMatch === null ? "未匹配到汇总行" : summaryMatch[0]}；耗时=${((Date.now() - startedAt) / 1000).toFixed(1)}s；日志=${rel(logPath)}`,
  );
  if (failCount !== null && failCount > 0) {
    const failLines = stdout.split(/\r?\n/).filter((line) => line.startsWith("[FAIL]")).slice(0, 10);
    infoLog(`回归有 FAIL：${failLines.join(" ｜ ")}`);
  }
}

/* ------------------------------------------------------------------ *
 * 只读约束自检（脚本自身不写数据）
 * ------------------------------------------------------------------ */

function runSelfCheck(state) {
  const group = GROUPS.self;
  let sourceText = "";
  try {
    sourceText = readFileSync(fileURLToPath(import.meta.url), "utf8");
  } catch (error) {
    check(state, group, "SELF1", "读取验收脚本自身源码", false, "可读", `失败：${messageText(error)}`);
    return;
  }
  // 运行时拼出写方法正则，避免「源码里出现禁词」这种自证问题
  const writeMethodPattern = new RegExp(
    "api" + "Post|api" + "Patch|api" + "Delete|method\\s*:\\s*[\"'](?:" + "POST|PATCH|DELETE" + ")[\"']",
  );
  const writesDataFile = /writeFileSync\([^)]*["']data[\\/]/.test(sourceText);
  const ok = !writeMethodPattern.test(sourceText) && !writesDataFile;
  check(
    state,
    group,
    "SELF1",
    "验收脚本只读：只用 GET，不写 data/*.json（任务硬约束）",
    ok,
    "源码无 POST/PATCH/DELETE 调用、无写 data/ 文件",
    ok ? `只使用 apiGet(GET)；写盘目标仅 .cache/verify/ 与 build/reports/admin-map/（本文件 ${sourceText.length} 字符）` : `发现写入调用：writeMethod=${writeMethodPattern.test(sourceText)}；writesData=${writesDataFile}`,
  );
}

/**
 * 计算被验收实现文件的 hash（SHA256 前 16 位，大写）：报告顶部写明验收的是哪一版实现，
 * 防止「实现改了但报告是旧版跑的」这种串味。
 */
function computeImplHashes() {
  const result = {};
  for (const relPath of Object.keys(EXPECTED_IMPL_HASHES)) {
    try {
      const digest = createHash("sha256").update(readFileSync(path.join(ROOT_DIR, relPath))).digest("hex").toUpperCase().slice(0, 16);
      result[relPath] = { actual: digest, expected: EXPECTED_IMPL_HASHES[relPath], matches: digest === EXPECTED_IMPL_HASHES[relPath] };
    } catch (error) {
      result[relPath] = { actual: null, expected: EXPECTED_IMPL_HASHES[relPath], matches: false, error: messageText(error) };
    }
  }
  return result;
}

function runImplHashCheck(state) {
  const group = GROUPS.self;
  const hashes = state.implHashes ?? {};
  const mismatches = Object.entries(hashes).filter(([, value]) => value.matches !== true);
  const detail = Object.entries(hashes)
    .map(([relPath, value]) => `${relPath}=${value.actual === null ? "(读取失败)" : value.actual}${value.matches ? "" : `（期望 ${value.expected}）`}`)
    .join("；");
  check(
    state,
    group,
    "SELF2",
    "验收对象 = Lead 冻结的实现版本（3 个文件 SHA256 前 16 位一致）",
    mismatches.length === 0,
    "components/AdminPlacesMap.tsx、components/adminMapStyle.ts、app/admin/page.tsx hash 与冻结值一致",
    detail,
  );
}

/* ------------------------------------------------------------------ *
 * 报告生成
 * ------------------------------------------------------------------ */

function summaryFromChecks(state) {
  const pass = state.checks.filter((item) => item.status === "PASS").length;
  const fail = state.checks.filter((item) => item.status === "FAIL").length;
  const skip = state.checks.filter((item) => item.status === "SKIP").length;
  return { pass: pass, fail: fail, skip: skip, total: state.checks.length };
}

function buildAcceptanceOverview(state) {
  const mapping = [
    { key: "1", title: "打开 /admin → 左列表右地图、116 个点全部显示", group: GROUPS.accept1 },
    { key: "2", title: "筛选「公园」→ 38 个绿点、视野缩到房山", group: GROUPS.accept2 },
    { key: "3", title: "搜索「美术馆」→ 只剩对应点", group: GROUPS.accept3 },
    { key: "4", title: "点列表第 3 行 → 对应点放大 + 居中", group: GROUPS.accept4 },
    { key: "5", title: "点地图点 → 列表滚动到该行并高亮", group: GROUPS.accept5 },
    { key: "6", title: "开关「显示已隐藏」→ 不报错；空心圈由 markerDotStyle 单测覆盖", group: GROUPS.accept6 },
    { key: "7", title: "切城市（北京 ↔ 辽阳）→ 地图跟着换、视野正确", group: GROUPS.accept7 },
    { key: "8", title: "缩放/拖动地图 → 不触发重画", group: GROUPS.accept8 },
    { key: "9", title: "地图加载失败（断网）→ 列表仍可用、图区显示降级文案", group: GROUPS.accept9 },
    { key: "L", title: "布局 1280×900：60/40 分栏 + sticky top 16px", group: GROUPS.layoutDesktop },
    { key: "N", title: "布局 390×844：地图在上 320px、宽度撑满", group: GROUPS.layoutNarrow },
    { key: "TAB", title: "活动 tab ↔ 地点 tab：地图仍可见 / resize 恢复", group: GROUPS.tab },
    { key: "CON", title: "控制台无 error（AMap 资源噪声按既有口径过滤）", group: GROUPS.console },
    { key: "REG", title: "回归 node scripts/verify/admin-ui.mjs 仍 PASS", group: GROUPS.regression },
  ];
  return mapping.map((item) => {
    const list = state.checks.filter((entry) => entry.group === item.group);
    const fail = list.filter((entry) => entry.status === "FAIL").length;
    const skip = list.filter((entry) => entry.status === "SKIP").length;
    const pass = list.filter((entry) => entry.status === "PASS").length;
    const status = fail > 0 ? "FAIL" : list.length === 0 ? "SKIP" : pass > 0 ? "PASS" : "SKIP";
    const evidence = list
      .filter((entry) => entry.status !== "SKIP")
      .slice(0, 3)
      .map((entry) => `${entry.id} ${entry.actual}`)
      .join("；");
    return { key: item.key, title: item.title, group: item.group, pass: pass, fail: fail, skip: skip, status: status, evidence: truncate(evidence, 360) };
  });
}

function buildMarkdown(state, summary, meta) {
  const lines = [];
  lines.push("# /admin 地点列表配地图 · 验收报告（verifier-map）");
  lines.push("");
  lines.push(`- 生成时间：${meta.generatedAtLocal}（${meta.generatedAtIso}）`);
  lines.push(`- 页面：${meta.url}`);
  lines.push(`- 浏览器：headless Edge ${meta.browserVersion} + CDP；视口 ${VIEWPORT_DESKTOP.width}×${VIEWPORT_DESKTOP.height} / ${VIEWPORT_NARROW.width}×${VIEWPORT_NARROW.height}`);
  lines.push(`- 数据：北京 ${EXPECTED.beijingTotal} 条（hidden=0）、公园 ${EXPECTED.parkCount} 条、搜索「美术馆」${EXPECTED.searchCount} 条、辽阳 ${EXPECTED.liaoyangTotal} 条`);
  const implHashEntries = Object.entries(state.implHashes ?? {});
  lines.push(
    `- 验收对象实现 hash（SHA256 前 16 位）：${
      implHashEntries.length === 0
        ? "（未采样）"
        : implHashEntries
            .map(([relPath, value]) => `${relPath} = ${value.actual === null ? "(读取失败)" : value.actual}${value.matches ? "（与冻结值一致）" : `（**期望 ${value.expected}，不一致**）`}`)
            .join("；")
    }`,
  );
  lines.push(`- 结果：**PASS ${summary.pass} / FAIL ${summary.fail} / SKIP ${summary.skip}**（共 ${summary.total} 条）`);
  lines.push(`- 结论：${summary.fail === 0 ? "全部通过" : `有 ${summary.fail} 条失败，见下方 FAIL 项`}`);
  lines.push("");
  lines.push("## 一、验收 1–9 总览");
  lines.push("");
  lines.push("| 验收 | 结果 | 通过/失败/跳过 | 关键证据 |");
  lines.push("| --- | --- | --- | --- |");
  for (const item of buildAcceptanceOverview(state)) {
    lines.push(`| ${item.key} ${item.title} | ${item.status} | ${item.pass}/${item.fail}/${item.skip} | ${item.evidence.replace(/\|/g, "/")} |`);
  }
  lines.push("");
  lines.push("## 二、逐条检查明细（期望 / 实际）");
  for (const group of GROUP_ORDER) {
    const list = state.checks.filter((entry) => entry.group === group);
    if (list.length === 0) continue;
    lines.push("");
    lines.push(`### ${group}`);
    for (const entry of list) {
      lines.push(`- **${entry.status}** \`${entry.id}\` ${entry.name}`);
      lines.push(`  - 期望：${entry.expected}`);
      lines.push(`  - 实际：${entry.actual}`);
    }
  }
  lines.push("");
  lines.push("## 三、验收 6 说明：为什么空心圈只能用单元断言");
  lines.push("");
  lines.push(`- 默认城市北京 ${EXPECTED.beijingTotal} 条、辽阳 ${EXPECTED.liaoyangTotal} 条，接口 \`includeHidden=1\` 返回的 hidden=true 数量均为 0；契约禁止为了造空心点去 PATCH 数据。`);
  lines.push("- 因此浏览器内只能验证：开关「显示已隐藏」不报错、rows/markers 仍 116、所有 marker 的 `data-hidden=\"false\"`。");
  lines.push("- 空心圈（hidden=true：透明填充 + 2px 类目色边框）由 `npx tsx` 直接 import `components/adminMapStyle.ts` 的 `markerDotStyle(category, hidden)` 做单测覆盖；实心/空心 × 10 类目的背景、边框、尺寸、box-sizing、圆角逐项断言。");
  lines.push("");
  lines.push("## 四、截图清单");
  lines.push("");
  const shotEntries = Object.entries(state.screenshots);
  if (shotEntries.length === 0) lines.push("- （无）");
  for (const [name, filePath] of shotEntries) {
    lines.push(`- \`${name}\`：${filePath === null ? "（截图失败）" : rel(filePath)}`);
  }
  lines.push("");
  lines.push("## 五、关键 debug 快照（window.__ADMIN_MAP_DEBUG__）");
  lines.push("");
  const debugEntries = Object.entries(state.debug).filter(([, value]) => value !== null && value !== undefined);
  if (debugEntries.length === 0) lines.push("- （无）");
  for (const [key, value] of debugEntries) {
    if (value === null || typeof value !== "object") continue;
    if ("mapReady" in value) lines.push(`- **${key}**：${fmtDebug(value)}`);
    else lines.push(`- **${key}**：${truncate(JSON.stringify(value), 500)}`);
  }
  lines.push("");
  lines.push("## 六、数据探活");
  lines.push("");
  lines.push(`- 北京：${state.data.beijingIds.length} 条（hidden=${state.data.beijingHidden ?? "?"}）；前 3 个 id=${state.data.beijingIds.slice(0, 3).join(",")}`);
  lines.push(`- 公园：${state.data.parkIds.length} 条；bbox=${fmtBbox(state.data.parkBbox)}`);
  lines.push(`- 搜索「美术馆」：${state.data.searchIds.join(",")}`);
  lines.push(`- 辽阳：${state.data.liaoyangIds.length} 条；bbox=${fmtBbox(state.data.liaoyangBbox)}`);
  lines.push("");
  lines.push("## 七、控制台");
  lines.push("");
  lines.push(`- 正常流程：${state.console.normal === undefined ? "（未采样）" : `过滤后 error ${state.console.normal.filtered.length} 条（原始 ${state.console.normal.rawCount} 条，warnings ${state.console.normal.warningsCount} 条）`}`);
  if (state.console.normal !== undefined && state.console.normal.filtered.length > 0) lines.push(`  - ${state.console.normal.filtered.join(" ｜ ")}`);
  lines.push(`- 验收 9 屏蔽 CDN 阶段新增 console 记录 ${state.console.blocked === undefined ? "?" : state.console.blocked.count} 条（网络被拦截属预期，不计 FAIL）`);
  lines.push("");
  lines.push("## 八、空心圈 / 实心点单元断言（npx tsx）");
  lines.push("");
  if (state.unit === undefined || state.unit === null) {
    lines.push("- （未运行）");
  } else {
    lines.push(`- 命令：\`${state.unit.command}\`；退出码 ${state.unit.exitCode}；耗时 ${state.unit.elapsedMs}ms；单测项 ${state.unit.parsed === null ? "未解析" : state.unit.parsed.total}`);
    if (state.unit.parsed !== null) {
      for (const unitGroup of ["palette", "constants", "solid", "hidden"]) {
        const list = state.unit.parsed.results.filter((item) => item.group === unitGroup);
        const failed = list.filter((item) => item.status !== "PASS");
        lines.push(`  - ${unitGroup}：${list.length - failed.length}/${list.length} PASS` + (failed.length === 0 ? "" : `；FAIL：${failed.map((item) => `${item.name}（实际 ${item.actual}）`).join("；")}`));
      }
    }
  }
  lines.push("");
  lines.push("## 九、回归（scripts/verify/admin-ui.mjs）");
  lines.push("");
  if (state.regression === undefined || state.regression === null) {
    lines.push(`- 未运行（${SKIP_REGRESSION ? "本次传了 --no-regression" : "未执行"}）`);
  } else {
    lines.push(`- 命令：\`${state.regression.command}\`；退出码 ${state.regression.exitCode}；汇总：${state.regression.summaryLine ?? "未匹配"}`);
    lines.push(`- 日志：${rel(state.regression.logPath)}`);
  }
  lines.push("");
  lines.push("## 十、FAIL 汇总");
  lines.push("");
  const failures = state.checks.filter((entry) => entry.status === "FAIL");
  if (failures.length === 0) {
    lines.push("- 无");
  } else {
    for (const entry of failures) {
      lines.push(`- \`${entry.id}\` ${entry.name}`);
      lines.push(`  - 期望：${entry.expected}`);
      lines.push(`  - 实际：${entry.actual}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function buildJsonReport(state, summary, meta) {
  return {
    meta: meta,
    summary: summary,
    acceptance: buildAcceptanceOverview(state),
    checks: state.checks,
    screenshots: state.screenshots,
    debug: state.debug,
    layout: state.layout,
    dom: state.dom,
    data: {
      beijingIds: state.data.beijingIds,
      beijingHidden: state.data.beijingHidden,
      parkIds: state.data.parkIds,
      parkBbox: state.data.parkBbox,
      searchIds: state.data.searchIds,
      liaoyangIds: state.data.liaoyangIds,
      liaoyangBbox: state.data.liaoyangBbox,
    },
    console: state.console,
    unit: state.unit ?? null,
    regression: state.regression ?? null,
    tabHidden: state.tabHidden ?? null,
  };
}

function writeReports(state, summary, meta) {
  ensureDirs();
  const mdPath = path.join(REPORT_DIR, "acceptance.md");
  const jsonPath = path.join(REPORT_DIR, "acceptance.json");
  writeFileSync(mdPath, `${buildMarkdown(state, summary, meta)}\n`, "utf8");
  writeFileSync(jsonPath, `${JSON.stringify(buildJsonReport(state, summary, meta), null, 2)}\n`, "utf8");
  console.log(`\n[report] 验收报告：${mdPath}`);
  console.log(`[report] 结构化证据：${jsonPath}`);
  return { mdPath, jsonPath };
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

function createState() {
  return {
    checks: [],
    screenshots: {},
    debug: {},
    layout: {},
    dom: {},
    data: { beijingIds: [], liaoyangIds: [], parkIds: [], searchIds: [] },
    console: {},
    unit: null,
    regression: null,
    tabHidden: null,
    browser: {},
    mapOk: false,
    implHashes: {},
  };
}

async function main() {
  ensureDirs();

  if (DUMP_UNIT_SOURCE) {
    const unitPath = writeStyleUnitSource();
    console.log(`[unit] 已生成空心圈单测源码：${unitPath}`);
    process.exitCode = 0;
    return;
  }

  const startedAt = Date.now();
  const generatedAt = new Date();
  const state = createState();
  state.implHashes = computeImplHashes();
  console.log(`[impl] 验收对象 hash：${Object.entries(state.implHashes).map(([relPath, value]) => `${relPath}=${value.actual ?? "(缺失)"}`).join("，")}`);
  let fatalError = null;

  try {
    await acquireLock();
    try {
      await probeEnvironment(state);
      await withBrowser(state);
    } catch (error) {
      fatalError = error;
      check(state, GROUPS.accept1, "SYS.1", "浏览器验收主流程执行完成", false, "无异常", `异常：${messageText(error)}${error instanceof Error && error.stack !== undefined ? `\n${truncate(error.stack, 500)}` : ""}`);
    }
    try {
      runStyleUnit(state);
    } catch (error) {
      check(state, GROUPS.accept6, "6.U0", "空心圈单元断言执行", false, "无异常", `异常：${messageText(error)}`);
    }
    if (!SKIP_REGRESSION) {
      try {
        runRegression(state);
      } catch (error) {
        check(state, GROUPS.regression, "REG1", "回归 admin-ui.mjs 执行", false, "无异常", `异常：${messageText(error)}`);
      }
    } else {
      skipCheck(state, GROUPS.regression, "REG0", "跳过 admin-ui 回归", "--no-regression");
    }
    try {
      runSelfCheck(state);
    } catch (error) {
      check(state, GROUPS.self, "SELF1", "只读约束自检", false, "无异常", `异常：${messageText(error)}`);
    }
    try {
      runImplHashCheck(state);
    } catch (error) {
      check(state, GROUPS.self, "SELF2", "验收对象 hash 核对", false, "无异常", `异常：${messageText(error)}`);
    }
  } catch (error) {
    fatalError = fatalError ?? error;
    check(state, GROUPS.self, "SYS.0", "验收脚本可运行（获取浏览器锁 / 目录）", false, "正常获取 build/.verify-lock 并执行", `异常：${messageText(error)}`);
  } finally {
    releaseLock();
  }

  const summary = summaryFromChecks(state);
  summary.elapsedMs = Date.now() - startedAt;
  const meta = {
    script: "scripts/verify/admin-map-acceptance.mjs",
    generatedAtIso: generatedAt.toISOString(),
    generatedAtLocal: generatedAt.toLocaleString("zh-CN", { hour12: false }),
    url: ADMIN_URL,
    baseUrl: BASE_URL,
    lockOwner: LOCK_NAME,
    node: process.version,
    browserVersion: state.browser.version ?? "(未启动)",
    cdpPort: state.browser.cdpPort ?? null,
    viewports: { desktop: VIEWPORT_DESKTOP, narrow: VIEWPORT_NARROW },
    implHashes: state.implHashes,
    regressionSkipped: SKIP_REGRESSION,
    elapsedMs: summary.elapsedMs,
    fatalError: fatalError === null ? null : messageText(fatalError),
  };

  let reportPaths = { mdPath: null, jsonPath: null };
  try {
    reportPaths = writeReports(state, summary, meta);
  } catch (error) {
    console.error(`[report] 写报告失败：${messageText(error)}`);
  }

  const finalSummary = REPORT.summary();
  REPORT.printSummary();
  console.log(`\n[截图目录] ${path.join(ROOT_DIR, ".cache", "verify")}`);
  for (const [name, filePath] of Object.entries(state.screenshots)) {
    console.log(`  ${filePath === null ? "（失败）" : rel(filePath)}  ${name}`);
  }
  if (summary.fail > 0) {
    console.log("\n[FAIL 明细]");
    for (const entry of state.checks.filter((item) => item.status === "FAIL")) {
      console.log(`  - ${entry.id} ${entry.name}`);
      console.log(`    期望：${entry.expected}`);
      console.log(`    实际：${entry.actual}`);
    }
  }
  console.log(`\n[结论] ${summary.fail === 0 ? `全部通过（PASS ${summary.pass} / SKIP ${summary.skip}）` : `${summary.fail} 条 FAIL（PASS ${summary.pass} / SKIP ${summary.skip}）`}`);
  process.exitCode = summary.fail > 0 ? 1 : 0;
}

main().catch((error) => {
  releaseLock();
  console.error(`[admin-map-acceptance] 脚本异常：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exitCode = 1;
});
