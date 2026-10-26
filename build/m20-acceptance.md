# M20 补站：行程时长贴近「现在 → 到家时间」· 验收报告

> 现象：15:20 出发、20:00 到家，只排到 18:48 就结束（浪费 72 分钟）；18:00 差 31、19:00 差 12。
> 根因：站数按 `floor(可用时长 / 72)` 估算（每站按 60 分钟停留 + 12 分钟通勤），实际每站 45–90 分钟、
> 通勤 3–9 分钟，估算偏保守。
> 结论：**验收 1–7 全过，全量回归绿**；已提交 `6614d0c`（M20）。

## 1. 修法（两层，都只对「传了 homeBy」生效）

### ① 主循环之后补站（`lib/planner.ts` · `planRounds`）
把原来的 `for (round = 0; round < targetStops; ...)` 改成不限轮次（补站轮 = `round >= targetStops`），
但**只有 `constraints.homeBy !== undefined` 且站数 < 画像上限（rich 3 / 其他 6）时才进入补站轮**。
补站轮复用主循环的**同一套**逻辑，不复制、不放松：

| 约束 | 怎么保证 |
| --- | --- |
| 距离递增（环线） | 同一个 `buildSourcePool` → `filterByRouteDistance`（×0.9 / ×0.75） |
| 营业时间 | 同一个 `pickNext` → `isOpenAt`（到达 + 停留 ≤ 闭馆；户外空间按既有口径只作参考） |
| 预算 | 同一个 `pickNext` 的预算过滤 + 累计 `budgetLeft` |
| 800m 去重 | 同一个 `isSameAreaDuplicate` / `isNonAdjacentLoopback` |
| 用餐硬约束 | 补站轮自己判断「这一站会不会覆盖还没安排餐厅的正餐时段」（`extraRoundMealWindow`），会 → 只从餐厅里选 |
| 站数上限 | `profileMaxStops(profile)`（rich 3 / powerful 等 6） |
| 日落锚点 | 锚点场景走 `tryPlanSunsetReserved`，**根本不进 `planRounds`** → 不会把新站插到锚点后面；等于「加不进去就停止补站」 |
| 提前停止 | 剩余时间 < `min(停留下限, 45) + 12` 分钟（用户口径 MIN_STAY_MIN+12）就停；候选都装不下也停 |

### ② 收尾补时（`extendLastStopForHomeBy`，在 `buildItinerary` 里真实返程算出来之后）
补站停下来常常只剩十几~几十分钟、不够再排一站。这时把**最后一站多待一会儿**，最多 30 分钟，
让到家时刻贴近 homeBy。硬边界：

- 只在 homeBy 存在、且当前差值 **> 30 分钟**时才补时（已够贴近就不折腾行程）；
- 餐厅站不动（正餐停留固定）；
- 最终 `endAt`（**含返程**）不能跨进「还没安排餐厅」的正餐时段 → 1090 场景停在 17:30；
- 仍受营业时间（`isOpenAt`）、`homeBy`、本轮 `attemptBudget`（同时指定「想走多久」时以更紧的为准）约束；
- 不传 homeBy 时整段不执行（验收 4）。

## 2. 验收结果（`node build/verify/m20-postfill.mjs` → PASS 14 / FAIL 0）

| # | 验收 | 改造前 | 改造后 |
| --- | --- | --- | --- |
| 1 | 15:20 → homeBy 18:00，差值 ≤30 | 31 分钟（2 站，end 17:29） | **30 分钟**（2 站，end 17:30，最后一站多待 1 分钟） |
| 2 | 15:20 → homeBy 19:00，差值 ≤30 | 12 分钟（3 站，end 18:48） | **12 分钟**（3 站，end 18:48，无需补） |
| 3 | 15:20 → homeBy 20:00，差值 ≤30 | 72 分钟（3 站，end 18:48） | **10 分钟**（4 站，end 19:50，补了 1 站） |
| 4 | 不传 homeBy → 与改造前一致 | — | placeId `B0HRCZKQIF,B0KR4Z14IU,B01A300Q37,B0FFKBHIFY`、end 19:49、5 段，**逐字一致**；两次请求排站结果完全相同 |
| 5 | 补站后距离序列单调 | — | 18:00：215→667；19:00：215→667→1047；20:00：215→667→1047→1555（复算 ≤10% 回退全过） |
| 6 | 补站后无站点重复（800m） | — | 复算通过（同类目 <800m + 第 3 站起不落回前序 800m） |
| 7 | 最多 6 站 | — | 本轮最多 4 站；rich 画像 ≤3 站（宽矩阵里 0 违规） |

**页面级复核**（build/verify/m20-ui-check.mjs）：15:20 打开页面 → 更多选项把「几点到家」设成 20:00 →
点「现在就走」→ 请求体 `homeBy=1200`，响应 `endAt=20:00`、4 站、差值 **0 分钟**，页面正常出行程。

**宽矩阵**：2 城 × 5 个出发时刻 × 3 个 homeBy × 4 种画像 = 120 组（实际 125 次请求，含边界），
逐条复算 闭合 / 时间递增 / 预算 / 用餐硬约束 / 营业时间 / 距离单调 / 800m 去重 / 站数上限 / `endAt ≤ homeBy`
→ **0 条违规**；7 组「rich + 90 分钟窗口」的排不出是画像/短窗口的合法结果（无画像 0 组失败）。
边界：homeBy 只剩 10 分钟 → 如实返回「离 15:30 只剩 10 分钟，不够走一趟」；夜间 21:30→22:30 正常排 1 站、差值 0。

## 3. 全量回归

| 套件 | 结果 |
| --- | --- |
| `m20-postfill.mjs`（本轮验收） | PASS 14 / FAIL 0 |
| `check-loopshape --strict`（无 homeBy） | 5/5 PASS，placeId/距离与冻结基线逐字一致 |
| `try-itinerary`（无 homeBy） | exit 0，三组 placeId 与基线一致 |
| `profile-plan.mjs`（M18 画像矩阵，含 profile.homeBy 兜底） | FAIL 0 / WARN 1（原已报备的 rich 杭州下限兜底） |
| `page.mjs` | PASS 40 / FAIL 0 / SKIP 1 |
| `map.mjs` | PASS 50 / FAIL 0 |
| `lead-final.mjs` | PASS 16 / FAIL 0 |
| `another-route-ui.mjs` | PASS 24 / FAIL 0 |
| `onboarding-e2e.mjs`（M18，含 profile.homeBy=22:00 排程） | PASS 30 / FAIL 0 |
| `m19-scroll-replay.mjs`（M19） | PASS 30 / FAIL 0 |
| `road-ui.mjs` | PASS 26 / FAIL 0 / SKIP 1 |
| `tsc` / `lint` / `next build` | 全部 exit 0 |

## 4. 已知取舍 / 边界

1. **18:00 场景停在「差 30 分钟」是数据边界**：当前 2 站行程 17:17 离开最后一站、返程 12 分钟；
   再排一站需要 45 分钟停留，只能停在 17:30（再往后就跨进晚餐时段、又不能凭空加餐厅）。
   补时把最后一站从 60 分钟延长 1 分钟到 61 分钟，正好压到 30 分钟整（用户把 31 分钟列为「可接受」，这是一个小改善）。
2. **补站被限制在 `homeBy` 场景**：不传 homeBy 的路径一行没改（验收 4；check-loopshape / try-itinerary 逐字一致）。
3. **日落锚点场景不补站**：锚点行程由 `tryPlanSunsetReserved` 负责，补站逻辑不在那条路径上（用户要求「加不进去就停止」）。
4. **补时不是补站**：补时只改最后一站的 `stayMin`（≤30 分钟），不新增地点；餐厅站不补时。
5. 宽矩阵里 7 组「rich + 90 分钟窗口」排不出：rich 站数 ≤3、非餐厅站 90 分钟停留、餐厅人均 ≥60，90 分钟窗口装不下任何合法组合；这是画像约束下的如实失败，不是补站导致。

## 5. 复现

```powershell
cd "（项目根）"
# dev server 在 http://127.0.0.1:3000
node build/verify/m20-postfill.mjs        # 验收 1–7 + 宽矩阵（125 次请求）
npx tsx --env-file=.env.local scripts/check-loopshape.ts --strict   # 无 homeBy 回归
npx tsx --env-file=.env.local scripts/try-itinerary.ts
```
