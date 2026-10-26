# 本轮契约：manual 层瘦身（覆盖式最小条目）——Lead 维护

> 用户指令（2026-10-25 16:2x）：把 `data/cities/*.manual.json` 里每条砍成 `{ id, importance }`；没被手工改过的才砍，手工改过的字段要保留。已确认执行方式：
> - **口径 B（用户已选）**：`origin` 语义一并改——只有「真手工新增 / 改过 importance 以外字段」才算 `manual`（来源列「手工」），只覆盖星级的显示「自动」并给「隐藏」按钮（而不是「删除」）。
> - **直接落盘（用户已选）**：dry-run → 备份 → 写盘 → 断言「瘦身前后的合并数据逐字段完全一致」。
> 项目根：`（项目根）`。dev server 3000 是旧进程，但 **Lead 改完 lib/cityData.ts / route.ts 后它已经重新编译并读到瘦身后的新数据**（实测 GET 已返回 origin=main）。验收方式因此定为：
> - **浏览器只读检查**：直接用 3000（打开 /admin 看来源列/按钮/列表，不要点写操作）；
> - **写入路径测试**：不要走 dev server，改用 **进程内直接调用 route handler**（`npx tsx` import `app/api/admin/places/route.ts` 的 GET/PATCH/DELETE 并 `new Request(...)` 调用），配合备份/还原，不受 server 缓存影响；
> - `npm run check:city` 有一个**本轮之前就存在**的失败项（"索引未登记的城市文件：hangzhou.json、liaoyang.events.json"），基线是 13 项通过 / 1 项失败；本轮要求失败集合与基线完全一致（不是要求 PASS）。

## 0. 现状事实（已核实，2026-10-25 16:30）

| 项 | 值 |
| --- | --- |
| `data/cities/beijing.manual.json` | 116 条 = **主文件全量副本 + importance**；除 importance 外所有字段与主文件逐字段相同；无手工新增点 |
| `data/cities/liaoyang.manual.json` | 141 条；其中 **140 条同北京**；仅 `B0FFGEKXKE 辽阳大剧院` 额外改了 `scenery` |
| 主文件 importance | 两城主文件都是 `undefined`（116/141 条全无 importance） |
| manual importance 分布 | 北京 {1:13, 2:63, 3:30, 4:7, 5:3}；辽阳 {1:16, 2:92, 3:17, 4:4, 5:12} |
| 根因 | `scripts/rate-places.ts` 写回时复制了整条 Place（第 685 行附近）；后台 PATCH/DELETE 也写整条 |
| 关键前提 | **合并结果（主文件 + manual）本轮必须保持完全不变**：planner 会读 importance（rich/powerful 模式），改数据内容 = 改排程行为，属于禁止的副作用 |

## 1. 数据模型（新）

`manual` 层条目 = **部分字段覆盖**：`{ id, ...主文件里要覆盖的字段 }`；`{ id, importance }` 是最常见形态。
- `id` 必有；其余字段都是 PlaceSchema 的可选子集（值仍然按 Place 字段规则校验，例如 importance 1–5、category 枚举）。
- **手工新增点**（主文件里没有这个 id）仍必须是**完整 Place**（缺字段直接报错，不兜底）。
- 合并规则（`lib/cityData.ts` 的 mergePlaces）：主文件点 + 覆盖条目 → 字段级合并（覆盖条目里出现的字段赢）；手工新增点原样追加。
- 文件格式不变：`{ "places": [ ... ] }`（顶层只有 places）。

## 2. 瘦身后的文件长相（验收按这个核对）

`beijing.manual.json`：
```json
{
  "places": [
    { "id": "B0KRJO5V9G", "importance": 5 },
    ...
  ]
}
```
- 116 条，每条 **恰好两个键** `["id","importance"]`，键序 id → importance；顺序与主文件 places 顺序一致（脚本按主文件顺序输出）。
- 主文件 116 个 id 全覆盖。

`liaoyang.manual.json`：
- 141 条；140 条恰好 `["id","importance"]`；`B0FFGEKXKE` 的键集合 = `{id, importance, scenery}`（实际顺序按 PlaceSchema 字段序：`["id","scenery","importance"]`——验收按**键集合**比，别按顺序比）。
- 顺序与主文件一致。

体积预估：66KB/79KB → 约 6–8KB（报告里写实测）。

## 3. 代码改动与行为契约

### 3.1 `lib/cityData.ts`

- 新增 `ManualPlaceEntrySchema = PlaceSchema.partial().extend({ id: z.string().min(1) })`，导出类型 `ManualPlaceEntry`；`ManualCityDataSchema.places` 改用它。
- `loadManualPlaces(id)` 返回 `ManualPlaceEntry[]`（只读盘 + 基本 schema + id 唯一性；**不**在这里读主文件）。
- `mergePlaces(mainPlaces, entries, cityId)`：主文件同 id → 字段级合并（只覆盖 entry 里出现且非 undefined 的字段），合并结果过 `PlaceSchema`；主文件没有的 id → 必须是完整 Place，否则抛错（错误信息里带 id 和 city）。
- `saveManualPlaces(id, entries: ManualPlaceEntry[])`：schema 校验 + id 唯一 + **完整性校验**（id 不在主文件时必须是完整 Place）+ 原子写 + `clearCityCache()`。
- 新增导出 `loadMainPlaceIds(id): Set<string>`（读主文件、不含 manual 合并；供 API 判断写覆盖还是写完整点）与 `loadMainCityData(id): CityData`（主文件原始数据；供脚本/诊断；内部复用，`loadCity` 也走它）。
- `loadCity` 合并结果**必须与改动前完全一致**（本轮最重要的不变式）。

### 3.2 `app/api/admin/places/route.ts`（请求/响应字段名与结构一律不变，只有 `origin` 取值语义变）

- `origin` 新口径：manual 层有该 id 的条目，且条目里**除 id / importance 之外还有字段** → `"manual"`；否则 `"main"`。
  - 手工新增点（条目是全量 Place）→ `"manual"` ✓ 自动满足。
  - 只覆盖 importance → `"main"`（来源列显示「自动」，行内按钮显示「隐藏」）。
  - 覆盖了 hidden / scenery / 名称等 → `"manual"`（来源列「手工」）。
- `POST`：新增点仍写完整 Place 进 manual 层；响应不变。
- `PATCH`：主文件点 → 先叠成「现有覆盖 + patch」，再**裁到只留与主文件不同的字段**（`pruneMainOverride`；后台编辑表单提交整份字段，不裁就会把没改的字段全写回 manual）；裁完只剩 id 时把整条覆盖摘掉。手工新增点 → 写完整 Place（`PlaceSchema.parse({...existing, ...patch})`）。响应不变。
- `DELETE`（页面按钮语义由服务端按数据分流，前端不动）：
  - 主文件点 + manual 条目只有星级覆盖（`originOf(entry)==="main"`，页面上是「隐藏」按钮）→ **不能真删条目**（会把 importance 一起删掉），改成在条目上合并 `hidden: true`，返回 `deleted:"hidden"`；
  - 其它 manual 条目（改过 importance 以外字段 / 手工新增点，页面上是「删除」按钮）→ 真删条目，返回 `deleted:"manual"`；
  - 主文件点没有条目 → 写 `{ id, hidden: true }`，返回 `deleted:"hidden"`。
  - 主文件点永远不真删（README/路由注释里的既有约束不变）。“恢复”走 PATCH `hidden:false`，`pruneMainOverride` 会把 hidden 裁掉、保留星级。

### 3.3 `scripts/rate-places.ts`

- 写回 manual 时改为最小覆盖：`{ id: place.id, importance: star }`（不再复制整条 Place）。
- 其余逻辑（候选挑选、manual 已存在则跳过、SSE 事件、dry-run）不变。

### 3.4 `scripts/shrink-manual.ts`（本轮新增脚本）

```
npx tsx scripts/shrink-manual.ts                        # dry-run（默认）：只打印计划
npx tsx scripts/shrink-manual.ts --apply                # 落盘
npx tsx scripts/shrink-manual.ts --city=beijing,liaoyang  # 只处理指定城市（默认 index.json 全部）
```
行为：
1. 读主文件 + manual 原始条目；逐条对比主文件同 id 的全部字段（undefined / 缺失视为相同）；
2. manual 独有 id → 原样保留（完整 Place），dry-run 里单独列出；
3. 与主文件逐字段相同 → 丢弃该条；
4. 有差异 → 只保留 `{ id, ...有差异的字段 }`（键序：id 在最前，其余按 PlaceSchema 字段顺序）；
5. `--apply` 时：备份原件到 `build/reports/manual-shrink/<city>.manual.orig.json`（逐字节），把**瘦身前**的合并结果写到 `build/reports/manual-shrink/<city>.merged-before.json`，调 `saveManualPlaces` 写盘，再在新进程内 `loadCity` 取**瘦身后**合并结果，断言两者 JSON 完全相等（顺序、字段、值都相等）；不一致 → 用备份回滚并 exit 1；
6. 幂等：对已瘦身的文件再跑 dry-run 应显示 0 变更；
7. 只碰 `.manual.json`，主文件一个字节都不改。

## 4. 验收清单（verifier 按这个写脚本，全部只读 + 临时 server 上的可逆写测试）

### A. 文件格式（只读）
1. 北京：116 条；每条键恰好 `["id","importance"]`；id 唯一；id 集合 = 主文件 116 个 id；顺序 = 主文件顺序；importance 分布 {1:13,2:63,3:30,4:7,5:3}。
2. 辽阳：141 条；140 条键 `["id","importance"]`；`B0FFGEKXKE` 键集合 = `{id, importance, scenery}`（实际键序 `["id","scenery","importance"]`，按集合比）；顺序 = 主文件顺序；importance 分布 {1:16,2:92,3:17,4:4,5:12}。
3. 两个文件体积实测值（预期 66KB→<10KB、79KB→<10KB），顶层只有 `places`。
4. `--apply` 幂等：再跑 dry-run 显示 0 变更；备份文件存在且与"瘦身前原件"内容一致（脚本自带 sha256 更好）。
5. 红线：`types/schema.ts`、`data/cities/beijing.json`、`data/cities/liaoyang.json`、`scripts/fetch-seed.ts`、`package.json`/`package-lock.json` 的 SHA256 与本轮开始前一致（本轮不该碰）；无新增 npm 依赖。

### B. 数据不变式（最重要）
6. 独立进程（`npx tsx -e` 或脚本）`loadCity('beijing' | 'liaoyang')` 的 `places` 与 `build/reports/manual-shrink/<city>.merged-before.json` **JSON 完全相等**（含顺序）。
7. 瘦身后 `GET /api/admin/places?city=beijing&includeHidden=1` / `city=liaoyang`：`total` 仍 116 / 141；除 `origin` 外每个字段与备份快照逐字段相等（同一顺序）。

### C. origin 新语义
8. API：北京 116 行 **全部 origin="main"**；辽阳 140 行 main + `B0FFGEKXKE` origin="manual"。
9. 后台页面（1280×900）：北京「来源」列 116 行全是「自动」；辽阳 141 行中仅「辽阳大剧院」是「手工」，其余「自动」。
10. 行内按钮：北京某主文件行有「隐藏」无「删除」；辽阳大剧院行有「删除」。（截图证据 + DOM 断言）

### D. 写入方保持最小格式（**进程内调 route handler**，不经过 dev server；做完用备份还原文件并核对 sha256）
11. PATCH `{importance: 原值}`（主文件点）→ manual 文件**逐字节不变**（说明写的是最小覆盖且幂等）。
11b. PATCH **整份表单但字段值都没变**（name/lng/lat/category/openTime/closeTime/closedDays/rating/avgCost/hidden:false）→ 裁剪后 manual 文件仍**逐字节不变**；PATCH 只改 name → 该条目恰好 `["id","importance","name"]`（排序后），改回 name → 文件回基线。
12. PATCH `{importance: 新值}` → 该条目仍恰好 `["id","importance"]`，值更新；再 PATCH 回原值 → 文件回到基线（逐字节）。
13. DELETE 主文件点（星-only 覆盖，页面「隐藏」按钮）→ 返回 `deleted:"hidden"`、该条目变成 `{ id, importance, hidden:true }`（星级保留）、合并后 hidden=true；随后 PATCH `{hidden:false}`（页面「恢复」）→ 条目裁剪回 `{ id, importance }`、文件逐字节回基线、hidden=false。
13b. DELETE 改过非星级字段的 manual 条目（如先 PATCH 改 name，页面「删除」按钮）→ 返回 `deleted:"manual"`、该条目被移除；`build/reports/manual-shrink/<city>.manual.clean.json` 还原并核对 sha256。
14. POST 新增手工点（带 name/lng/lat/category 等必填）→ manual 条目是完整 Place（键远多于两个）；再 DELETE 该点 → 返回 `deleted:"manual"` 且 manual 文件逐字节恢复原样。
**tsx 进程内测试注意**：route handler 里 import 的是 `@/lib/cityData`，测试脚本若 import `../lib/cityData` 会是**两个模块实例**（两份 LRU）；断言合并结果前先 `clearCityCache()`，或者直接读文件/走 GET handler。
15. `scripts/rate-places.ts`：源码里写 manual 的条目是 `{ id, importance }`（静态校验：import ManualPlaceEntrySchema + parse {id, importance}）；可选 `--dry-run` 冒烟不写盘。

**测试前后必须**：`sha256(manual 文件)` = `build/reports/manual-shrink/<city>.manual.clean.json` 的 sha256（见 `<city>.sha256.txt`），并在报告里贴前后 hash。

### E. 回归
16. `npx tsc --noEmit` = 0 error；`npm run lint` = 0 warning；`npm run check:city` 与基线一致（13 通过 / 1 失败，失败项 = "索引未登记的城市文件：hangzhou.json、liaoyang.events.json"，本轮之前就存在 → 不算本轮回归）。
17. 上一轮地图验收 `scripts/verify/admin-map-acceptance.mjs`（默认 3000，只读）全 PASS（PASS 90 / FAIL 0；SKIP 1 是 headless wheel 已知项）。注意该脚本 SELF2 会核对 3 个前端文件 hash——本轮不碰 `AdminPlacesMap.tsx`/`adminMapStyle.ts`/`app/admin/page.tsx`，应仍一致。
18. `node scripts/verify/admin-ui.mjs`（3000，只读 + 打开编辑弹窗不保存）PASS；如顺带跑 `api-checks.mjs`，只允许它的只读检查，任何写操作留下的数据改动必须在报告里说明并还原（宁可不跑）。
19. 控制台 error 0（沿用既有噪声过滤口径）。
20. 页面写操作**不在浏览器里测**：来源列/按钮只做 DOM 断言；写入格式用 D 组进程内 route handler 测试。

## 5. 写入范围

| 角色 | 可以写 |
| --- | --- |
| Lead | `lib/cityData.ts`、`app/api/admin/places/route.ts`、`scripts/rate-places.ts`、`scripts/shrink-manual.ts`、`build/manual-layer-contract.md`（+ 用脚本写 `data/cities/*.manual.json`） |
| verifier | `scripts/verify/manual-layer-acceptance.mjs`、`.cache/verify/`、`build/reports/manual-shrink/`（只读文件；写测试结束必须还原数据文件并核对 sha256） |
| reviewer | `build/reports/manual-shrink/review.md` |

**绝对不许**：改 `types/schema.ts`、两个主城市文件、`fetch:seed.ts`、`lib/planner.ts`、`package.json`；改 admin 页面（origin 语义在服务端解决，页面代码本轮不动）；新增依赖。
