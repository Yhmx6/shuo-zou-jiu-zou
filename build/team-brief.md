# 本轮改造 · 团队作战简报（Lead 维护，所有人先读完再动手）

> 任务书全文：`（本轮任务书）`（**必读**，以它为准）。
> 项目根：`（项目根）`（下文相对路径都相对项目根）。
> 本文件是 Lead 摸清现状后的补充事实，任务书里没写的都在这里。

## 0. 绝对红线（违反即返工）

- 不改 `types/schema.ts` 已有字段的名字和类型（只能加可选字段）。
- 不改打分权重里与本次无关的部分；不动 `/admin` 相关代码；不改 `lib/constraints.ts`。
- 不做任何 emoji 图标；不用地图截图。
- 地点只能来自 `data/cities/*.json`，**不许凭空生成地点**（铁律 1）。
- 时间一律「当日分钟数整数」，只有已成型的展示文案才格式化。
- 不新增 npm 依赖（项目刻意不用 puppeteer/playwright，验收用自带的 CDP 脚本）。
- 不碰别人的写入范围（见 §4），需要跨界先找 Lead。

## 1. 环境事实

| 项 | 值 |
| --- | --- |
| git | **不在 PATH**，用 `git` |
| 当前 HEAD | `2dcdd16`（干净，可回退；本文件与新增脚本是未跟踪文件） |
| dev server | **已在跑**：`http://localhost:3000`（`next dev -p 3000`，HMR 生效，**不要重启 / 不要另起端口**） |
| node / npm | v22.22.2 / 10.9.7 |
| 类型检查 | `npx tsc --noEmit`（当前 **干净**，任何时刻都必须保持干净） |
| 路线缓存 | `.cache/` 已有 1.1 万条，planner 自检很快（辽阳秒回，杭州首次约 1–2s） |
| 城市 | `hangzhou`（282 POI, cityCode 0571, sunset 1062, maxTotalMin 360）、`liaoyang`（141 POI, 0419, sunset 1039, maxTotalMin 360）；两者 `lastEndMinute` 都是 1410 |

## 2. 动手前必须知道的现状坑

1. **`scripts/try-itinerary.ts` 是红的（改造前就红，不是本轮引入）**：它还在断言
   `stops.length === segments.length`，而当前契约是 `segments.length === stops.length + 1`（多一段返程），
   且 `BASELINE_PLACE_IDS` 也过期了。**别把它当回归基线**；本轮改用 `scripts/check-loopshape.ts`
   作第一步的权威自检（见 §3）。要不要顺手修 try-itinerary 由 Lead 决定。
2. `components/AmapRouteMap.tsx` 已经实现了「返程段识别 + 文字导航标题写『返程 · 步行 X 分钟』」
   （`formatSegmentTitle`、`isReturn`）。本步只需要改**折线样式**（虚线 / 石灰色 / 低透明度 / 低 zIndex），
   别把已有的「返程」文字标题逻辑推翻。
3. 地图折线当前统一样式：`strokeWeight 6`、`strokeOpacity 0.62`、`zIndex: 110 + index`、
   颜色取 `ROUTE_COLORS` 循环、`strokeStyle = 步行 ? dashed : solid`。
4. `lib/planner.ts` 里 `pickNext` 的候选池**已预筛**：每轮只把「距当前站直线最近的 6 个」交给它
   （`selectNearby`）。第 1 轮时当前站就是 origin，所以这 6 个正好是「距 origin 最近的 6 个」——
   「第 1 站取最近的合规点」在这个池子里是成立的，不要绕开预筛去全量扫。
5. 日落锚点前置（`tryPlanSunsetReserved`）里的 pickNext 调用**不传** `routeShape`。
   任务书第一步第 4 条要求「锚点站仍优先占位，其余站遵守距离递增规则」——需要你判断怎么接，
   并在报告里说明你的处理方式和理由（锚点站可以违反单调，这是设计内的例外）。
6. 用餐硬约束（覆盖 11:30–13:30 / 17:30–19:30 必须有餐厅）与站数上限（`MAX_STOPS=6`）不能被新规则打破；
   新规则只能「少排站」，不能「排错站」。
7. `Itinerary.stops` 已带 `placeName / lng / lat / placeCloseTime` 快照；页面 / 地图不许静态 import 地点文件。

## 3. 已有验收工具（不要重复造）

| 工具 | 用途 |
| --- | --- |
| `npx tsc --noEmit` | 类型门禁 |
| `npx tsx --env-file=.env.local scripts/check-loopshape.ts [--strict] [--save <path>]` | **Lead 新写**：两城 5 组，打印每站到 origin 的直线距离序列、单调性、首站合规、800m 去重（第一步验收 1–3、5） |
| `node scripts/verify/lib.mjs` | CDP 公共库（Node 22 内置，不装包）：Edge headless + 截图 + 控制台收集 + 假时钟 |
| `node scripts/verify/first-screen.mjs [--mode=noevent]` | 首屏验收（现有脚本，可当改造前后对照；见 §5） |
| `node scripts/verify/api-checks.mjs` / `admin-ui.mjs` | API / 后台回归（本轮别动后台，可作回归） |
| `npm run check:city` | 城市数据校验（本轮不改数据，应保持 PASS） |

**浏览器验收是独占资源**：同一时刻只允许一个 Edge/CDP 验收在跑。跑之前先建锁
`build/.verify-lock`（内容写你的名字），跑完删掉；锁已存在就等 60s 重试，最多等 5 分钟，超时找 Lead。
（`lib.mjs` 自带的 profile/端口隔离只能防一半冲突，锁是硬要求。）

## 4. 写入范围（严格按此分区，别越界）

| 角色 | 可以写 | 不许写 |
| --- | --- | --- |
| Lead | 全部（最终把关） | — |
| `planner-loop` | `lib/planner.ts`、`scripts/check-loopshape.ts`、`scripts/try-itinerary.ts` | 页面 / 地图组件 |
| `page-splash` | `app/page.tsx` | 地图组件 / planner |
| `map-motion` | `components/AmapRouteMap.tsx` | 页面 / planner |
| 共同只读 | `lib/amapSdk.ts`（Lead 已写好，契约固定）、`lib/constraints.ts`、`types/schema.ts`、`lib/cityData.ts` | 不改 |

`lib/amapSdk.ts` 是 Lead 给启动页准备的地图 SDK 就绪入口，契约：

```ts
export const AMAP_SDK_VERSION: string;              // "2.0"
export const AMAP_SDK_PLUGINS: string[];            // 路线插件
export function isAmapSdkConfigured(): boolean;     // 环境变量齐全？
export function loadAmapSdk(): Promise<unknown>;    // 幂等；失败会 reject
export async function whenAmapSdkSettled(): Promise<boolean>; // 启动页用：永远 resolve
```

## 5. 改造前基线（2026-10-24 00:2x 采集，`scripts/check-loopshape.ts --save .cache/loopshape-baseline.json`）

改造前 5 组实际结果（**验收 16「15:20 / 辽阳 与改造前对比」就以 `ly-1520` 这一行为准**）：

```
hz-1520  B0HU4KJCTO,B0FFH5FFC1,BZA4QP01H6,B0KGCC8TEV      距离 2240 → 1039 → 1982 → 2879  单调 FAIL(第1→2 回退 53.6%)
hz-1100  B0KGCC8TEV,B0J06ZG937,B023B09LZP,B023B09UVH      距离 3775 → 3578 → 4101 → 4901  首站 FAIL / 去重 FAIL(700m 非相邻)
hz-0900  B0FFLGSK6B,B0KGCC8TEV                            距离 199 → 3394
ly-1520  B0HRCZKQIF,B0KR4Z14IU,B0FFIJKINQ,B0FFFPKNAM      距离 215 → 667 → 933 → 1490     去重 FAIL(755m 非相邻)
ly-0900  B0HRCZKQIF,B0KR4Z14IU,B0FFIJKINQ                 距离 215 → 667 → 933           去重 FAIL(755m 非相邻)
```

这正好复现了任务书描述的问题：第 1 站不是最近的合规点、距离序列会回退、800m 内会重复。改造后**允许变化，但必须在报告里逐组说明原因**。

## 6. 每步交付要求

- 改完先 `npx tsc --noEmit` 干净，再跑自己那部分自检，**把真实输出贴进报告**（不贴结论贴命令输出）。
- 报告格式：改了什么文件哪些函数 / 自检命令与输出 / 与任务书的逐条对照（哪条通过、哪条有偏差及原因）/ 剩余风险。
- 发现任务书与代码现实冲突时：**以「不改坏已有约束」为先**，采用最小改动，并在报告里写明冲突与选择。
- 不许为了让自检通过而放宽断言（例如把 800m 改回 500m）；断言要跟着任务书收紧。
