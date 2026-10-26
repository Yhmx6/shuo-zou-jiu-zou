# 路名改动验收报告（Segment.road）

> 任务：`types/schema.ts` 加 `Segment.road` → `lib/amap.ts` 从高德算路里取路名 → `lib/planner.ts` 带进 Segment →
> 前端「站点副行」「文字导航段标题」展示（超 12 字截断加省略号，没有则降级成原文案）。
> 验收时间：2026-10-24 01:00 – 01:25　基线 HEAD `4e3cb91`（M12）

**结论：四项改动全部落地，三条验收全过（另外补了截断与回归）。**

## 1. 改动清单

| 文件 | 改动 |
| --- | --- |
| `types/schema.ts` | `SegmentSchema` 新增可选字段 `road: z.string().min(1).optional()`（只加可选字段，不动已有字段） |
| `lib/amap.ts` | `RouteSummary` / `RouteSummarySchema` 加 `road?: string`；新增 `firstRoadOfPath()`；`summaryFromPaths` 带出 road；`getRoute` / `buildRouteSummary` 透传 |
| `lib/planner.ts` | `Commute` 加 `road?`；新增 `commuteOf()`（getRoute → Commute 唯一出口）与 `segmentOf()`（Commute → Segment 唯一出口，覆盖 7 处 Segment 构造：站间段 / 返程段 / 换站进出段 / 日落路径）；`commuteFromSegment` 反向保留 road |
| `lib/roadText.ts` | **新增**：`roadLabel()` / `roadPrefix()`，12 字截断规则只写一处，页面与地图组件共用 |
| `app/page.tsx` | `describeCommute(mode, durationMin, road?)`：有路名 → `沿{road}走/骑 X 分钟`，无 → 原文案；3 个调用点（站点副行、展开层「X 前出发」、首站那行）全部传入 |
| `components/AmapRouteMap.tsx` | `SegmentNavigation` 加 `road`；`formatSegmentTitle(..., road?)`：`第 1 段 · 沿后地路步行 3 分钟` / 无路名保持 `第 1 段 · 步行 3 分钟`；返程同理 |

## 2. 取数实现：三个实测出来的坑（也是与字面指令的唯一偏差）

任务书写「从高德返回里取第一条 step 的 road」。在真实缓存数据（5996 条路径 / 977 个不同路名）上实测后，
**按字面实现会拿不到路名**，所以实现成「取第一条**有路名的** step」，理由如下：

1. **`road: []` 不只是偶尔出现，而是大概率**：68% 的路线 `steps[0].road` 就是 `[]`（第一步通常是
   「向东南步行 1452 米」这种没有路名的引路段）。按字面只读 `steps[0]`，辽阳 15:20 只有 2/4 站有路名，
   验收 1「确认都有路名」不可能通过。
   → 改成**按顺序找第一条有名字的 step**。`road` 用 `toNonEmptyString` 归一：
   `[]` / `""` / `null` / 数字 一律视为没有（`String([])` 会得到空串，正是任务书提醒的那个坑），
   配合 `Segment.road` 的 `min(1)` 约束，空串根本进不了 Itinerary。
2. **v5 骑行接口的字段名不是 `road`，而是 `road_name`**（真实返回字段：`instruction / orientation /
   road_name / step_distance / polyline`）。不兼容这个字段名，所有骑行段都会丢路名
   （辽阳 15:20 的第 3 段、杭州 15:20 的第 4 段都是骑行）。
   → `firstRoadOfPath` 同时认 `road` 与 `road_name`。
3. **公交方案（transit）没有 step**，因此公交段天然没有 `road` → 前端按既有文案降级（正好是验收 3 要的）。

## 3. 验收项

### 1）辽阳 15:20：4 站副行都有路名 —— PASS

```
① 15:23 鑫语书店(八一街店)   ｜  沿后地路走 3 分钟
② 16:32 U咪Coffee&Bar       ｜  沿后地路走 9 分钟
③ 17:29 泰和园              ｜  沿八一街骑 12 分钟
④ 18:30 长谷川拉面(乐购店)   ｜  沿武圣路走 16 分钟
返程行                        ｜  ↩ 骑行 19 分钟回到起点

文字导航：第 1 段 · 沿后地路步行 3 分钟 / 第 2 段 · 沿后地路步行 9 分钟 /
          第 3 段 · 沿八一街骑行 12 分钟 / 第 4 段 · 沿武圣路步行 16 分钟 /
          返程 · 沿西二道街骑行 19 分钟
```

### 2）杭州 15:20：4 站副行都有路名 —— PASS

```
① 15:24 城市阳台江堤步道     ｜  沿之江绿道江干段走 4 分钟
② 16:17 星巴克(杭州UDC店)   ｜  沿之江绿道江干段走 8 分钟
③ 17:21 CBD公园             ｜  沿新业路辅路走 19 分钟
④ 18:20 兰州陈记牛肉面(杭州首店) ｜ 沿五星路骑 14 分钟
返程行                        ｜  ↩ 公交 24 分钟回到起点

文字导航：第 1 段 · 沿之江绿道江干段步行 4 分钟 / 第 2 段 · 沿之江绿道江干段步行 8 分钟 /
          第 3 段 · 沿新业路辅路步行 19 分钟 / 第 4 段 · 沿五星路骑行 14 分钟 /
          返程 · 公交 24 分钟     ← 公交段无 road，降级成原样
```

### 3）没有 road 的段：降级正确，不是「沿undefined走」/「沿走 3 分钟」—— PASS

| 场景 | 段 | 实际文案 |
| --- | --- | --- |
| 杭州 15:20 | 返程（公交 24 分钟，transit 无 step） | 副行/段标题：`↩ 公交 24 分钟回到起点` / `返程 · 公交 24 分钟` |
| 杭州 11:00 | 第 2 段（步行 1 分钟，高德全程 road 为空） | 副行：`走过去 1 分钟`；段标题：`第 2 段 · 步行 1 分钟` |

另外做了**脏值扫描**：三个场景的整页 `innerText` 都不含 `沿undefined / 沿null / 沿NaN / 沿走 / 沿 / undefined走 / 沿[object` 中任何一种。

### 4）超过 12 字截断（任务书第 4 条附带项）—— PASS

真实数据里 977 个路名最长只有 10 个字（`半山国家森林公园绿道`），12 字规则不会被真实数据触发；
所以用测试页拦截 `/api/plan` 响应、把第 1 段 road 注入成 13 个字 **`之江绿道江干段滨江延伸线东`**，在真实页面上验证：

```
副行   ：沿之江绿道江干段滨江延伸线…走 3 分钟
段标题 ：第 1 段 · 沿之江绿道江干段滨江延伸线…步行 3 分钟
断言   ：含「沿{前 12 字}…」且不含完整 13 字 → PASS
```

（只改测试页面里的网络响应，不动源码 / 数据。截断规则单点在 `lib/roadText.ts` 的 `ROAD_LABEL_MAX_CHARS = 12`。）

### 自检汇总

```
node build/verify/road-api.mjs  （API 层：road 透传 + 展示文案推演）      → 辽阳/杭州 各 4 站全有路名
node build/verify/road-ui.mjs   （浏览器层：A/B/C/D 四场景）            → PASS 27 / FAIL 0 / SKIP 0（20.1s）
```

截图：`.cache/verify/road-liaoyang-1520.png`、`road-hangzhou-1520.png`、`road-hangzhou-1100.png`、
`road-liaoyang-1520-longroad.png`（截断场景）。

## 4. 回归（本轮改动不影响既有验收）

| 门禁 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npm run lint`（next lint） | ✔ No ESLint warnings or errors |
| `npx next build` | ✓ Compiled successfully（exit 0，9 页全部生成） |
| `scripts/check-loopshape.ts --strict` | PASS 5/5（距离序列 / 首站 / 去重与改造前一致：加 road 不参与打分） |
| `scripts/try-itinerary.ts` | exit 0（三组 placeId 与基线逐字一致） |
| `build/verify/page.mjs` | PASS 39 / FAIL 0 / SKIP 1 |
| `build/verify/map.mjs` | PASS 50 / FAIL 0 / SKIP 0（`返程 · 公交 24 分钟` 仍含「返程」） |
| `build/verify/lead-final.mjs` | PASS 16 / FAIL 0 / SKIP 0 |

## 5. 需要知道的边界

1. **「走路」类动词按方式区分**：有路名时 walk →「沿XX路走」，bike →「沿XX街骑」，drive →「沿XX路开」，
   bus →「沿XX坐公交」（bus 实际拿不到路名，这条不会出现）；没有路名时严格是改造前的
   「走过去 / 骑车 / 坐公交 / 打车 X 分钟」。任务书示例只写了「走过去 3 分钟」这一种，其余是对称补全。
2. **返程行（`↩ 骑行 19 分钟回到起点`）没加路名**：任务书列的是「站点副行」与「文字导航段标题」两处；
   返程行是独立一行、句式是「X 分钟回到起点」，加「沿…」会与「回到起点」冲突，故保持原样。
   文字导航里的返程段标题**已**带路名（`返程 · 沿西二道街骑行 19 分钟`）。
3. **`Stop.reason` 里的通勤描述未改**（仍「骑行 15 分钟能到」）：任务书只要求两处展示，reason 是服务端
   信息层文案，不在本次范围。
4. 路名只做展示，不参与排程（和 importance / 活动一样的只读字段）；`Segment.road` 是可选字段，旧数据
   （`data/mock-itinerary.json`、缓存的旧行程）没有它，读取侧按「没有路名」降级，不会报错。
