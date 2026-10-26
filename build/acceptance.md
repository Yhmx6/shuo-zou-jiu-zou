# 本轮改造验收报告（Lead）

> 任务书：`（本轮任务书）`
> 项目：`（项目根）`　基线 HEAD `2dcdd16`（改前已提交，工作区干净）
> 验收时间：2026-10-24 00:22 – 01:05（Asia/Hong_Kong）
>
> **结论：任务书 17 条验收项全部通过**（其中第 10、11、12 条的测量口径与限制见 §4）。
> 另：`tsc` / `next lint` / `next build` / 城市数据（除 1 项改造前既有失败）均通过。

---

## 1. 本轮交付

| 文件 | 改动 | 负责 |
| --- | --- | --- |
| `lib/planner.ts` | +299/−? 环线形状（首站规则、距离单调、拐点弱化 0.8/0.6、800m 去重收紧）、日落锚点接法、`replaceStop` 同步 | planner-loop |
| `components/AmapRouteMap.tsx` | +537/−26 返程折线视觉区分（灰虚线）、3500ms 轨迹动画 + 移动圆点 + 点击跳过 + reduced-motion + 动画期禁 fitView | map-motion |
| `app/page.tsx` | +492/−? 布局改版（头部 → 站点行 → 地图 → 文字导航）、点击展开、启动页（`data-splash` 契约、2s 硬上限） | page-splash |
| `lib/amapSdk.ts` | **新增** 地图 SDK 就绪入口（`whenAmapSdkSettled()`），给启动页的 `Promise.all` 用 | Lead |
| `scripts/check-loopshape.ts` | **新增** 环线形状自检（两城 5 组 + 日落组，`--strict` 退出码） | Lead 起草，planner-loop 按需收紧 |
| `scripts/try-itinerary.ts` | 修到当前契约（改造前就红：`segments = stops + 1`、站数、800m 去重、基线 placeId） | planner-loop |
| `scripts/verify/first-screen.mjs` | 适配新结构（行 + 点击展开；活动行数据过期时 SKIP 而非假 FAIL） | page-splash |

未改：`types/schema.ts`、`lib/constraints.ts`、`data/**`、`/admin` 相关代码、其他组件。未新增依赖。

## 2. 门禁命令（最后一次运行的真实结果）

```
npx tsc --noEmit                                          → exit 0（无输出）
npm run lint  (= next lint)                                → ✔ No ESLint warnings or errors
npx eslint app components lib scripts types --ext .ts,.tsx → exit 0
npx next build                                             → ✓ Compiled successfully（9 页全部生成，exit 0）
npm run check:city                                         → FAIL 1 项：liaoyang.events.json 未在 index.json 登记（改造前既有问题，见 §5）
npx tsx --env-file=.env.local scripts/check-loopshape.ts --strict   → PASS 5/5，exit 0
npx tsx --env-file=.env.local scripts/check-loopshape.ts --sunset --strict → PASS，exit 0
npx tsx --env-file=.env.local scripts/try-itinerary.ts      → exit 0（三组 placeId 与更新后的基线一致）
node build/verify/page.mjs                                 → PASS 39 / FAIL 0 / SKIP 1
node build/verify/map.mjs                                  → PASS 50 / FAIL 0 / SKIP 0（20.4 s）
node build/verify/lead-final.mjs                           → PASS 16 / FAIL 0 / SKIP 0
node scripts/verify/first-screen.mjs                       → PASS 21 / FAIL 0 / SKIP 2（SKIP=活动数据过期）
node scripts/verify/first-screen.mjs --mode=noevent        → PASS 24 / FAIL 0 / SKIP 0
```

## 3. 验收 1–17 逐条对照

### 第一步

**1. 5 组（两城 × 不同起点/时间）距离序列 —— PASS**

| 组 | 起点 / 出发 | 每站到 origin 的直线距离（米） |
| --- | --- | --- |
| `hz-1520` | 杭州 15:20 · 茑屋书店(天目里店) | 1039 → 2879 → 3690 → 4053 |
| `hz-1100` | 杭州 11:00 · 武林广场 | 3746 → 3945 → 4901 |
| `hz-0900` | 杭州 09:00 · 湖滨银泰 in77 | 199 → 3394 |
| `ly-1520` | 辽阳 15:20 · 城市圆心 | 215 → 667 → 1380 → 2281 |
| `ly-0900` | 辽阳 09:00 · 城市圆心 | 215 → 667 → 1047 |

命令：`npx tsx --env-file=.env.local scripts/check-loopshape.ts --strict`（快照 `build/reports/lead-loopshape-final.json`）。
改造前同一命令的对应序列见 `build/baseline/loopshape-baseline.json`（hz-1520 是 `2240 → 1039 → …`，回退 53.6%）。

**2. 序列单调不减（允许 ≤10% 回退）—— PASS**：5 组全部 `单调 PASS`（脚本逐对比较，低于 −10% 即 FAIL）。

**3. 第 1 站 = 最近的合规点（importance ≥2 或 rating ≥3.5）—— PASS（判定口径见 §4.1）**
5 组全部 `首站 PASS`：hz-1520 = 茶园绿云 1039m、hz-1100 = 玉古面馆 3746m（强制用餐轮 → 最近合规餐厅）、
hz-0900 = 东坡大剧院 199m、ly-1520/ly-0900 = 鑫语书店 215m。脚本同时打印「不看过滤的最近合规点」参照，
例如 hz-1520 的浙江省工业创意产业中心（788m，`openTime=null` 永远排不进）。

**4. 地图上返程是浅灰虚线，与去程彩色实线明显不同 —— PASS**
`node build/verify/map.mjs`（读真实 `AMap.Polyline.getOptions()`）：

```
A1 最后一段 isReturn=true（只有最后一段）
A2 strokeStyle=dashed      A3 strokeColor=#78716c      A4 strokeOpacity=0.35
A5 zIndex=100              A6 去程 zIndex=110,111,112,113（全部高于返程）
A7 去程：步行 #2563eb/#ea580c/#16a34a dashed op=0.62 w=6；骑行 #0891b2 solid — 与改造前一致
A10 真实覆盖物读回样式与导出样式逐条一致
```
证据截图：`.cache/verify/map-return-only.png`（隐藏去程只留返程）、`map-no-lines.png`（全部隐藏，做像素差集）、
`map-animation-end.png`。像素解混：返程可见像素 85.8% 为中性灰、差集形状为虚线。

**5. 站点列表不出现「同一片区域去两次」—— PASS**
`check-loopshape` 第 [3] 项口径：同类目 <800m 任意两站、第 3 站及以后对前序任一站 <800m 一律 FAIL。5 组全 PASS。
改造前 ly-1520 的第 3 站「李先生牛肉面」距第 1 站仅 755m（旧 500m 口径放过），正是这条规则修掉的典型。

**6. 文字导航最后一段标着「返程」—— PASS**
`map.mjs A8`：最后一段标题 `返程 · 公交 24 分钟`（不是「第 5 段」）。页面整页截图里也是 `返程 · 骑行 19 分钟`。

### 第二步

**7. 截图：从上到下 = 头部 → 站点行 → 地图 → 文字导航 —— PASS**
几何证据（`page.mjs` C3）：`header.top=120 → stop-list.top=184 → map.top=535 → navigation.top=988`。
头部：`10月24日 周六`（12px stone-500）+ `4 站 · 4 小时 29 分 · 108 元`（14px stone-500）。
站点行：`① 15:23 鑫语书店(八一街店)` + 副行小字 + 行间 `border-stone-200` 1px + 返程独行 `↩ 骑行 19 分钟回到起点`。
截图：`.cache/verify/page-c-itinerary.png`（整页 1265×2070）。

**8. 点第 2 行展开详情，再点收起 —— PASS**
`page.mjs` D 组：默认全收起（详情高 0、`aria-hidden`）；点击后 `aria-expanded=true`、高 193px；
过渡 `0.15s cubic-bezier(0,0,0.2,1)`（ease-out，无弹跳/弹性）；再点回到 0。
展开层内容：`16:32–17:17，停留 45 分钟` + reason + oneLine + 星级 + 导航 + 「换一个」「不感兴趣」。
截图：`page-d-row2-expanded.png` / `page-d-row2-collapsed.png`。

**9. 刷新页面：启动页出现、2 秒内消失，之后是「状态文字 + 按钮」—— PASS**
`page.mjs` B 组页面内时序：`visible@50 → fading@767 → gone@1067`（生命周期 1017ms）；
Lead 复测：傍晚 `visible=380 → gone=957`（生命周期 577ms）、断网场景 `333 → 644`（311ms）。
启动页硬上限的实测兜底路径（挂起 amap 请求）：`fading@2002 → gone@2302`，仍 ≤2.3s。
截图：`page-a-splash.png`（白底 + `说走就走` + `正在看看附近有什么`）。

**10. 断网刷新：启动页最多 2 秒，然后正常进（地图降级 SVG）—— PASS（含口径说明，见 §4.2）**
- `lead-final` 场景 2：拦掉 `*amap.com*` 与同源 `/api/*` → 启动页生命周期 311ms 消失，页面不白屏：
  `现在是 15:20，天还亮着 / 城市：城市列表不可用 / 城市列表读不出来：服务暂时没有响应 / 正在安排…（按钮 disabled）/ 更多选项`。
- 地图降级：`map.mjs` 回归组拦 `*amap.com*` → 出现 `route-map-fallback` + SVG 示意图，页面不崩、正文 735 字，
  仅 1 条 warning（`[AmapRouteMap] 高德地图加载失败，降级为 SVG 示意图`），0 条 error。截图 `map-sdk-fallback.png`。

**11. 首屏未点击前，除启动页外与改造前逐字一致 —— PASS（最硬的一条）**
改造前基线（真实未点击状态，`build/baseline/before-first-screen-preclick.{txt,png}`）vs 改后：
- innerText **0 行差异**；
- 截图 **SHA256 完全相同**：`D73634B307EECA31F6873DADCC9273EFBDC92CD5E2A2F003132A9F8E931A31B4`（两文件一致，Lead 复核）。

### 第三步

**12. 路线从起点逐段画出，有一个点沿线移动 —— PASS**
`map.mjs` B 组：动画中途 `pointCounts=[5,29,28,1,1]` vs 完整 `[5,29,42,75,70]`（前两段完整、第三段画到一半、后两段还没开始），
圆点 DOM 存在 1 个；总时长实测 **3513ms**（配置 3500）；结束后 `pointCounts=full`、`getPath=full`、圆点 0 个。
截图：`map-animation-mid.png`（中途 + 圆点）/ `map-animation-end.png`（完整、无圆点）。
（任务书允许「录屏或描述」，本轮用中途/结束双截图 + 实时点数/圆点状态代替录屏。）

**13. 点地图任意位置 → 立即跳到完整状态 —— PASS**
CDP 在地图画布中心派发真实鼠标点击：`skipped=true`、**16ms** 内 `pointCounts=full`、圆点消失。截图 `map-click-skip.png`。

**14. 换一次站 → 直接完整显示，不重播 —— PASS**
`map.mjs`：换站后 `drawId=2`（新一次绘制）、`runs` 仍 = 1、画完 +34ms 采样已完整、1 秒后复查仍未播。
Lead 复测（页面级）：辽阳连续换 3 次站都成功换出新站，`runs=1`、`pc=full`、无圆点。截图 `lead-after-swaps.png`。

**15. 系统开启「减少动态效果」→ 直接完整显示 —— PASS**
CDP `Emulation.setEmulatedMedia({prefers-reduced-motion:reduce})` 后重载：`reducedMotion=true / played=false / runs=0`，
`pointCounts=full`、`getPath=full`、圆点从未出现。截图 `map-reduced-motion.png`。

### 回归

**16. 15:20 / 辽阳 placeId 列表与改造前对比 —— 有变化，原因已查明（允许）**

| | placeId 列表（按站序） |
| --- | --- |
| 改造前 | `B0HRCZKQIF, B0KR4Z14IU, B0FFIJKINQ, B0FFFPKNAM`（鑫语书店 215m → U咪Coffee 667m → 李先生牛肉面 933m → 海鲜农贸大市场 1490m） |
| 改造后 | `B0HRCZKQIF, B0KR4Z14IU, B01A300Q37, B0FFKBHIFY`（鑫语书店 215m → U咪Coffee 667m → 泰和园 1380m → 长谷川拉面 2281m） |

变化原因：旧第 3 站「李先生牛肉面(辽阳东兴路餐厅)」距第 1 站鑫语书店仅 **755m**，按本轮收紧的
「第 3 站及以后不得落在前序任一站 800m 内」，它被去重淘汰（旧 500m 口径恰好放过，这就是任务书要修的
「同一片区域去两次」）；第 3 站换成 1380m 的泰和园，第 4 站按「距离递增 + 覆盖晚餐」排到 2281m 的長谷川拉面。
地点全部来自 `data/cities/liaoyang.json`，没有凭空生成。

其余 4 组变化（同一份命令输出）：
`hz-0900` 完全不变；`hz-1520` 首站从 2240m 农贸市场改为 1039m 茶园绿云并整体单调；
`hz-1100` 4→3 站（第 2 站换成 120 分钟的浙大永谦剧场后时间守卫先到，属允许的少排站）；
`ly-0900` 同 ly-1520 的去重原因（李先生牛肉面 → 四季面馆 1047m）。

**17. 白天、傍晚各跑一次，确认没有异常报错 —— PASS**

| 场景 | 结果 | 截图 |
| --- | --- | --- |
| 白天 · 杭州 15:20（`page.mjs`） | 4 站，console error 0 条 | `page-c-itinerary.png` |
| 白天 · 辽阳 15:20（`lead-final` 场景 3，含 3 次换站） | 4 站，error 0 条 | `lead-after-swaps.png` |
| 傍晚 · 杭州 16:10（日落锚点路径，`lead-final` 场景 1） | 4 站 / 5h26m / 24 元，② 17:32 湖心岛平台（日落锚点），error 0 条 | `lead-evening-hangzhou.png` |
| 深夜冒烟 · 辽阳 21:30 | 1 站 / 1h15m / 0 元，正常出行程，error 0 条 | `lead-night-liaoyang.png` |
| 日落锚点 · 杭州 16:10 / 16:40 / 17:00（`--sunset --strict`） | 16:10 锚点可见且锚点后距离继续递增；16:40/17:00 按既有设计回退普通排程（不抛错、能出行程） | — |

## 4. 必须说明的口径与偏离

### 4.1 首站「最近的合规点」的口径（比任务书字面更严，也不是放松）
任务书字面是「按距离升序，取第一个满足 importance≥2 或 rating≥3.5 的点」。但若「合规」完全不管营业时间，
就会拿**永远排不进去**的点当基准（hz-1520 → 788m「浙江省工业创意产业中心」`category=other, openTime=null`，
`isOpenAt` 恒 false）。这会让「首站取最近合规点」与「不许破坏营业时间过滤」两条红线自相矛盾。
本轮口径：**最近的、通过 pickNext 全部 1–5 步过滤的合规点**；强制用餐轮（11:00 覆盖午餐）则在餐厅池内取最近合规餐厅。
判定脚本 `scripts/check-loopshape.ts` 还额外加了「首站自身必须合规」的硬断言，且同时打印纯距离参照点供人工核对。

### 4.2 第 10 条「断网」的可行口径
真正把整个网络断掉，连本地 dev server 的 HTML 都拿不到，页面根本不会出现，也就无从验证启动页。
本轮按「外部网络/接口不可用」验证：拦 `*amap.com*`（地图 SDK + 瓦片）与同源 `/api/*`。结果如上：启动页 311ms 消失、页面不白屏、
按钮进入不可用态；地图在 SDK 失败时降级为既有 SVG 示意图（`map.mjs` 回归组）。
另：启动页的「2 秒硬上限」是本轮新增逻辑，页面内实测最坏 2245ms（visible→gone，含 300ms 淡出），符合要求。

### 4.3 站点副行没有路名（`沿之江路走 11 分钟` → 实际 `走过去 3 分钟`）
`Itinerary.segments` 契约里没有道路名字段；道路名只存在于 `AmapRouteMap` 内部算路回调的 `steps[].road`。
页面不能编造路名（铁律：不编造地点信息），因此副行沿用既有 `describeCommute()` 口径（走过去/坐公交/骑车/打车 + 分钟）。
若以后把每段路名暴露成 `Segment` 的可选字段，页面可零风险升级。

### 4.4 动画初始 path 用「单点」而不是「空数组」
任务书建议 `setPath([])`。实测（`build/verify/_diag3.mjs`）：空数组功能上生效（`getPath()` 返回 `[]`），
但 AMap JSAPI 2.0 每次都 `console.error("Polyline path")`——每画一次地图会多 N 条 console error，违反「没有异常报错」。
改用「只保留首点」：单点画不出线、视觉等同空 path、console 干净。恢复完整 path 已由 B5/B6 证明。

### 4.5 返程线的可见范围
任务书硬要求返程 `zIndex: 100`（低于去程 110+），所以**完全重叠的路段会被去程彩色线盖住**，这是规则的必然结果。
本组行程分叉段清晰可见（返程单独隐藏时的截图见 `map-return-only.png`），像素解混 85.8% 中性灰。
任务书原文「不避让，用视觉区分」按字面执行。

### 4.6 其它
- 日落锚点站（第 2 站）允许违反距离单调 —— 任务书第一步第 4 条明确「锚点站仍优先占位」，这是设计内例外，已写进代码注释。
- 任务书第二步示例写「3 行站点」，实际站数由 planner 决定（本轮样本 4 站），页面按 `stops.length` 渲染，不写死。
- 页面不再使用 `FirstStopCard` / `StopList` 两个组件（布局里没有它们的位置），组件文件原样保留、未修改，展示字段全部迁到展开层。
- 切换城市 / 刷新页面会重建地图组件，动画会被视为「新一次首次渲染」再播一次；换站/重新算路不重播（任务书要求的就是后者）。

## 5. 改造前就存在的问题（本轮未引入、未修）

1. `npm run check:city` FAIL 1 项：`data/cities/liaoyang.events.json` 没有在 `data/cities/index.json` 登记。
   `scripts/check-city.ts` 的孤立文件检查只放过 `.manual.json`、不放过 `.events.json`；`data/**` 本轮完全没动。
2. `scripts/try-pick.ts` 末尾因硬编码 `B0FFIPE4M6`（已不在辽阳数据里）退出 1（planner-loop 已确认与改造前一致）。
3. `scripts/verify/first-screen.mjs` 的活动行断言：辽阳 `evt_001 话剧《雷雨》` `endAt=2026-10-23T21:00` 已结束，
   服务器参考时刻之后必然拿不到 `upcomingEvent` → 已改为「数据在 4 小时窗口内才 assert，否则 SKIP 并写明原因」（不删检查、不伪 PASS）。

## 6. 复现方式

```powershell
cd "（项目根）"
# dev server 需在 http://localhost:3000 跑着（npm run dev -- -p 3000）
npx tsc --noEmit
npm run lint
npx tsx --env-file=.env.local scripts/check-loopshape.ts --strict          # 验收 1–3、5
npx tsx --env-file=.env.local scripts/check-loopshape.ts --sunset --strict # 日落锚点
npx tsx --env-file=.env.local scripts/try-itinerary.ts                     # 旧契约回归
node build/verify/page.mjs      # 验收 7–11（浏览器，独占 build/.verify-lock）
node build/verify/map.mjs       # 验收 4、6、12–15（浏览器）
node build/verify/lead-final.mjs# 验收 10、17 + 换站回归（浏览器）
node scripts/verify/first-screen.mjs [--mode=noevent]  # 首屏历史验收（已适配新结构）
```

产物：截图在 `.cache/verify/`；三份 teammate 报告在 `build/reports/{planner-loop,page-splash,map-motion}.md`；
工作简报与改造前基线在 `build/team-brief.md`、`build/baseline/`。
