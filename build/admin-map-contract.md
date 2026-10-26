# 本轮契约：/admin 地点列表配地图（Lead 维护，改动前先读完）

> 任务书：`（本轮任务书）`（以它为准）。
> 通用铁律：`（通用铁律）`。
> 项目根：`（项目根）`。当前 HEAD `397e781`（工作区里 `app/page.tsx` 等有上一轮未提交改动，**不是本轮的，别动**）。

## 0. 红线（违反即返工）

- **不重构 `app/admin/page.tsx`**：1964 行是历史累积，本轮只在里面加地图 + 联动接线，不拆文件、不改现有筛选/搜索/编辑/删除/批量打星/活动分区逻辑。
- 不改 `app/api/admin/places/route.ts` 的接口契约；不动 `types/schema.ts`、`data/cities/*.json`、`middleware.ts`、`lib/amapLoader.ts`。
- 不新增 npm 依赖（项目刻意不用 playwright/puppeteer，验收用自带 CDP `/scripts/verify/lib.mjs`）。
- 不做 emoji 图标（图例用色块 div）；不用地图截图；不出现 `map.clearMap()`。
- 地点只能来自 `/api/admin/places` 返回的数据，不许在前端生成/编造地点。
- 验收脚本**禁止** PATCH/POST/DELETE 改数据（本轮数据里 hidden 点本来就是 0，空心圈走单元断言）。

## 1. 环境事实（已核实，别重复踩）

| 项 | 值 |
| --- | --- |
| dev server | **已在跑** `http://127.0.0.1:3000`（next dev；curl `/admin` 200 且含「本地控制台」）。**不要重启 / 不要另起端口** |
| node | v22.22.2；`npx tsc -v` = 5.9.3 |
| git | 不在 PATH；用 `git` |
| 默认城市 | `ACTIVE_CITY=beijing` → /admin 首次加载就是北京 |
| 北京数据 | 116 条，hidden=0。类目分布：park 38 / bookstore 6 / cafe 16 / gallery 4 / market 9 / museum 6 / other 12 / restaurant 20 / theater 5 / mall 0 |
| 辽阳数据 | 141 条，hidden=0 |
| 搜索「美术馆」 | 2 条（B0G3JX9RRQ 北京智慧长阳美术馆、B0G0UCOGY5 韩建美术馆，都是 gallery） |
| 高德 SDK | `lib/amapLoader.ts` 的 `loadAMap(): Promise<unknown>` 已经有（幂等、安全密钥顺序已处理）。**直接复用，不要重新 load / 不要自己设 `window._AMapSecurityConfig`** |
| 浏览器验收 | headless Edge + CDP，公共库 `scripts/verify/lib.mjs`，参考 `scripts/verify/admin-ui.mjs`。Edge 路径 `<Edge 安装路径>` |
| 浏览器独占 | 跑之前建 `build/.verify-lock`（内容写你的名字），跑完删；锁已存在等 60s 重试，最多 5 分钟 |

## 2. 数据契约差异（必须知道）

`types/schema.ts` 的 `PlaceCategorySchema` 有 **10** 类（任务书只说 9 类，漏了 `mall`）：
`bookstore / museum / gallery / theater / market / park / mall / restaurant / cafe / other`。
→ 色板按 10 类实现（9 类用任务书指定色，`mall` 补 `#65a30d`），图例 10 个色块。当前两城数据里 mall 为 0 条，属预留。

## 3. 色板（唯一来源 `components/adminMapStyle.ts` 的 `CATEGORY_COLORS`）

```
park       #16a34a    bookstore  #2563eb    restaurant #ea580c    market   #a16207
museum     #7c3aed    theater    #be123c    cafe       #0891b2    gallery  #c026d3
other      #57534e    mall       #65a30d（任务书未列，schema 有，本轮补）
```

## 4. DOM / 调试钩子契约（验收脚本据此断言，**必须逐字匹配**）

### 4.1 页面（`app/admin/page.tsx`）

- 列表容器（原 `overflow-x-auto rounded border ...` 那个 div）：加 `data-testid="admin-places-list"`。
- 每个地点行 `<tr>` 加：
  - `data-row-place-id="{place.id}"`
  - `data-place-name="{place.name}"`
  - 高亮闪一下时 `data-highlight="true"`（否则不输出该属性）
  - `ref` 回调把 `<tr>` 存进 `rowRefs`（Map<placeId, HTMLTableRowElement>），供 `scrollIntoView({ block:"center" })`
  - `onClick`：点在 `button|a|input|select|textarea|label` 上时忽略；否则 `setSelectedPlaceId(place.id)`
- 筛选控件加 testid（便于脚本精确定位，不改行为）：
  - 城市 `<select>`：`data-testid="city-filter"`
  - 类目 `<select>`：`data-testid="category-filter"`
  - 名称搜索 `<input>`：`data-testid="name-search"`
  - 「显示已隐藏」 `<input type=checkbox>`：`data-testid="include-hidden"`

### 4.2 地图组件（`components/AdminPlacesMap.tsx`）

- 根 `<section data-testid="admin-places-map">`：`position:relative; overflow:hidden`；窄屏 `h-[320px]`，`lg` 桌面 `h-[calc(100vh-6rem)]`。
- SDK 挂载容器：`<div data-testid="admin-map-canvas">`（占满 section）。
- 每个 marker 的 content DOM：
  - 外层 `div`：`data-map-marker="true"`、`data-place-id`、`data-category`、`data-hidden="true"|"false"`、被选中时 `data-selected="true"`（否则不输出），`style: width:10px;height:10px;cursor:pointer`
  - 内层圆点 `div`：`data-map-dot="true"`，`box-sizing:border-box; width:10px; height:10px; border-radius:50%`
    - 实心：`background-color: 类目色` + `border:1px solid #ffffff`
    - hidden：`background-color: transparent` + `border:2px solid 类目色`
    - 选中：内层 `transform: scale(1.6)`（外层尺寸不变）
  - marker 用 `map.add(markers)` 批量加；清旧点用 `map.remove(markers)`（**禁止 `map.clearMap()`**）
  - 点击走**自己挂的 DOM `click` 监听**（不要依赖 AMap 的 marker 事件，headless 里合成事件更稳），回调 `onSelectPlace(place.id)`
- 图例：`<div data-testid="admin-map-legend">`，绝对定位贴底、`font-size:10px`、`line-height:12px`、`pointer-events:none`；每个类目一个外层 label `span[data-legend-item="{category}"]`（只放文案），内层**色块 span 同时挂 `data-legend-category="{category}"` 和 `data-legend-swatch="true"`**，它的 `background-color` = 类目色（对 `[data-legend-category]` 读数就是对的，不要再往外层 label 找背景色）；文案：公园/书店/餐厅/市集/博物馆/剧场/咖啡厅/美术馆/其他/商场（顺序即上面的色板顺序）。
- 失败态：`<div data-testid="admin-map-error">地图加载失败，不影响编辑</div>`（只在 loadAMap reject / 超时 / `new AMap.Map` 抛错时出现；列表不受影响）。
- 选中联动：`selectedId` 变化 → 对应 marker 放大 1.6 + `map.setCenter([lng, lat])`；**不**触发重画（不重新 add/remove marker、不 setFitView）。
- 拖拽/缩放（move/zoom 事件）**不触发重画**。

### 4.3 调试钩子（仅 `process.env.NODE_ENV !== "production"`，挂在 `window.__ADMIN_MAP_DEBUG__`，**原地改字段**，卸载时 delete）

```ts
type AdminMapDebug = {
  mapReady: boolean;       // 地图实例创建成功
  error: string;           // 失败原因（空串 = 没失败）
  drawCount: number;       // 每次「清旧 marker + 重画 + setFitView」+1（拖动/缩放/选中不增加）
  fitViewCount: number;    // setFitView 次数（每次重画 +1）
  markerCount: number;     // 当前 marker 数
  markerIds: string[];     // 当前 marker 的 place id（顺序同 places）
  selectedId: string | null;
  selectedScale: number;   // 选中 marker 的 scale（1 或 1.6）
  center: { lng: number; lat: number } | null;  // map.getCenter()
  zoom: number | null;     // map.getZoom()
  resizeCount: number;     // 容器从 0 尺寸恢复（tab 切回来）时 +1
};
```

## 5. 验收 9 条 → 机器断言（验收脚本按此写）

1. 打开 /admin：列表行数 = 116、marker 数 = 116、`mapReady=true`、drawCount=1、fitViewCount=1，截图。
2. 类目选「公园」：rows=38、markers=38、每个 marker `data-category=park` 且圆点 `background-color` = `rgb(22, 163, 74)`、fitViewCount 递增、地图 center 落在公园坐标 bbox 内。
3. 搜索「美术馆」：rows=2、markers=2（ids 与 API 结果一致）。
4. 点第 3 行（`[data-row-place-id]` 第 3 个）：`debug.selectedId` = 该 id、`selectedScale=1.6`、对应 marker `data-selected="true"`、`debug.center` ≈ 该点 lng/lat（误差 ≤1e-6）、drawCount 不变。
5. 点一个可见 marker（`dispatchEvent(new MouseEvent('click',{bubbles:true}))`）：对应行 `data-highlight="true"` 且 `scrollIntoView` 后该行 rect 在视口内、并断言「marker 点击不改变 selectedId」。
6. 开关「显示已隐藏」：不报错、rows/markers 仍 116（本轮无 hidden 点）；**空心圈样式由 `npx tsx` 单测 `components/adminMapStyle.ts` 的 `markerDotStyle()` 覆盖**（实心/空心两组断言）；报告写明数据里 hidden=0 的原因。
7. 城市切辽阳：rows=141、markers=141、fitViewCount 递增；再切回北京 rows=116。
8. `Input.dispatchMouseEvent` 在地图画布上滚轮缩放 + 拖拽：`debug.zoom` 或 `center` 变化（证明手势生效）且 `drawCount` **不变**。
9. `Network.setBlockedURLs` 屏蔽 `*webapi.amap.com*` 后重新导航 /admin：出现 `[data-testid="admin-map-error"]` 文案「地图加载失败，不影响编辑」，rows 仍 116、编辑按钮仍可见。

另外必测：

- 布局 1280×900：列表在地图左侧（rect 比较）、列表宽/地图宽 ≈ 60/40（±8%）、地图列 `position: sticky`、`top: 16px`。
- 布局 390×844：地图在列表上方、地图高度 ≈ 320px（±2px）、宽度撑满。
- 切到「活动」tab 再切回「地点」：地图仍可见（marker 仍在、或 `resizeCount ≥ 1`）。
- 控制台无 error（AMap 资源类噪声按既有脚本口径过滤，参考 `build/verify/map-plugin-smoke.mjs` 的过滤名单）。
- 回归：`node scripts/verify/admin-ui.mjs` 仍 PASS（现有后台配色/活动分区验收）。

## 6. 写入范围

| 角色 | 只能写 |
| --- | --- |
| Lead | `components/AdminPlacesMap.tsx`、`components/adminMapStyle.ts`、`app/admin/page.tsx`、`build/admin-map-contract.md` |
| verifier（T2/T3） | `scripts/verify/admin-map-acceptance.mjs`、`.cache/verify/`、`build/reports/admin-map/` |
| reviewer（T4） | `build/reports/admin-map/review.md` |

越界先找 Lead。

## 7. Lead 实现的补充说明（T1 最终版，验收按这个跑）

1. **容器宽度**：`<main>` 原来是 `max-w-6xl`，本轮加了 `lg:max-w-[1400px]`。原因：1964 行的 8 列表格被 60% 分栏压到 ~666px 后类目/评分/人均/来源全都竖着折行、行高变大，116 行列表难看难滚；加大容器宽度后（1280 视口下列表 ~733px、地图 ~484px）比例仍是 60/40，表格单行。这是本轮布局联动的必要调整，不涉及任何筛选/编辑逻辑。
2. **表格单元格**：地点表 4 个窄列（类目 / 评分 / 人均 / 来源）和 8 个表头加了 `whitespace-nowrap`（纯 CSS，只为不折行）；`<td>` 里内容一字未改。
3. **drawCount 口径**：首屏 `places` 还是空数组时**不画**（省掉一次空重画），所以地图就绪后 drawCount=1、fitViewCount=1。筛选变化（含搜索 / 切城市 / includeHidden）每次都 +1；清空结果时为 0 个 marker、fitViewCount 不加。
4. **选中态**：`window.__ADMIN_MAP_DEBUG__.selectedId` 的语义是「当前被放大的 marker id」。点行 → 该 id 放大 1.6 + setCenter；点 marker → **不改变** selectedId（只触发列表 scroll + 高亮）；若选中的点在筛选后不在结果里，selectedId 会被置回 null（没有任何 marker 处于放大态）。
5. **marker 点击实现**：我们在 marker 的 content 元素上自己挂 DOM `click` 监听（不依赖 AMap marker 事件），所以验收脚本可以直接 `element.dispatchEvent(new MouseEvent('click', { bubbles: true }))`。如果合成事件不触发，可以用 CDP `Input.dispatchMouseEvent` 在该 marker 的屏幕坐标上真实点击（两条路径都应生效）。
6. **失败态文案**：`[data-testid="admin-map-error"]` 的 `textContent` 恰好是「地图加载失败，不影响编辑」（失败原因放在该元素的 `title` 属性里，不进 textContent）。
7. **验证锁**：Lead 的临时冒烟脚本 `.cache/lead-smoke.mjs` / `.cache/lead-smoke-2.mjs` 会短暂用 `build/.verify-lock`；正式验收前 Lead 已确保锁被释放，看到锁就按 60s 重试规则等。
8. **调试钩子的 center / zoom 什么时候可信**：地图实例挂上了 `moveend` / `zoomend` 监听，视图真正变化后才回写 `debug.center` / `debug.zoom`。点行放大后 `setCenter` 是异步刷新的，**读数前等 ~600ms**（Lead 冒烟实测 600ms 后 center 与地点坐标完全相等，误差 < 1e-6）。
9. **手势模拟实测（Lead 已跑，headless Edge 156）**：
   - `Input.dispatchMouseEvent(mouseWheel)` **不会**改变 AMap 视野（zoom/center 都不变，和 `build/verify/map-replay.mjs` 里记录的既有结论一致）；
   - `Input.dispatchMouseEvent` 的 `mousePressed → mouseMoved×4 → mouseReleased` **可以真实拖动地图**（实测 center 从 116.39,39.97 变到 115.91,40.17，drawCount 不变）；
   - 兜底通道：`window.__ADMIN_MAP_DEBUG__.getMap()` 返回真实 `AMap.Map` 实例（dev only，不进 JSON 快照），可以 `map.setZoom(map.getZoom() + 1)` 造假不了的「视野变了」证据，但要在报告里标明是兜底方法。
   - 验收 8 的断言口径：**任一真实手势让 center 或 zoom 变化 + drawCount 不变** 即 PASS；wheel 不生效不算产品 bug（项目既有验收已记录同一现象）。
10. **切 tab 回来**：实测 `活动 → 地点` 后 `debug.resizeCount` 从 0 → 1、markers 仍 116，`[data-testid="admin-places-map"]` 在活动 tab 时 rect 为 0×0（ResizeObserver 正是靠这个恢复）。
11. **临时冒烟证据**：`.cache/verify/lead-smoke-2.json` 里有 Lead 跑的 7 条交互自查（A 点行选中 / B 点 marker 联动 / C tab 恢复 / D 手势不重画 / E 无异常）全部 PASS，可作为你脚本的交叉参考，但**不要直接当成你的验收证据**——你要用自己的脚本独立跑一遍。
