# M19 隐藏「换一个」+ 路线变化滚地图重播动画 · 验收报告

> 需求两条一起做：① UI 隐藏「换一个」（只隐藏、逻辑全留）；② 路线变化后跳地图 + 重播轨迹动画。
> 基线 HEAD：`45fe809`。结论：**验收 1–7 全过，回归 8/9 全过**，已提交（M19）。

## 1. 第 3 条：UI 隐藏「换一个」

### 改动
三处渲染都加了同名开关 `const SHOW_SWAP_BUTTON = false;`（带注释说明「只隐藏、不删逻辑」）：
- `app/page.tsx`（当前真正在用的展开层按钮，文件顶部常量）
- `components/FirstStopCard.tsx`
- `components/StopList.tsx`

按钮渲染统一改成 `{SHOW_SWAP_BUTTON ? (<button …>换一个</button>) : null}`。

### 保留清单（一个都没删）
| 东西 | 状态 |
| --- | --- |
| `/api/swap` 路由 | 保留，实测 HTTP 200（见验收 3） |
| `lib/planner.ts` `replaceStop` + 距离带约束 | 保留（本轮 planner 一行没动，`git diff` 为空） |
| `onSwap` props 传递 / `runSwap` | 保留（另加 dev 钩子 `window.__SZJZ_DEBUG__.runSwap`） |
| `lib/preference.ts` | 保留 |
| 相关测试脚本 | 保留（M14 的受控/UI 用例都在；UI 点击用例需要把开关改回 true 才能再跑） |
| 「不感兴趣」 | **保留并可用**（验收 2 真实点击通过） |

## 2. 第 2 条：路线变化后跳地图 + 重播动画

### 改动
- `components/AmapRouteMap.tsx`：新增 `animationKey?: number`。绘制 effect 顶部用 `lastAnimationKeyRef` 比较：
  - 组件首次挂载 → 播（原行为）；
  - `animationKey` 真变化 → 复位已播状态并从头重播（先 cancel 旧动画、清 overlays、Polyline 复位成单点，保证只有 1 个 RAF / 1 个圆点、不叠加）；
  - 其他重渲染（无关 state / 手动缩放拖动 / 同 key）→ 不播；
  - `prefers-reduced-motion: reduce` → 仍然不播，直接完整显示。
- `app/page.tsx`：
  - `animationKey` state；`itinerary` 变化时（重新生成 / 不感兴趣 / 换站 / 再来一条 / 改条件重排）执行：立即 `mapSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })`，**200ms 后**再 `animationKey + 1`（先滚、后播，两个动效不打架）；
  - 首次出行程只滚不 bump key（地图首次挂载本来就会播，避免双重启动）；
  - 首屏加载（`itinerary === null`）不滚不播；
  - 地图外层新增 `[data-testid="map-section"]` 容器作为滚动目标；
  - dev 钩子 `window.__SZJZ_DEBUG__.runSwap(index, action)`（仅 development；生产构建常量折叠掉），用于「换一个」入口隐藏后仍能验证页面收到新换站数据的链路。

## 3. 验收结果（`node build/verify/m19-scroll-replay.mjs` → PASS 30 / FAIL 0）

| # | 验收 | 结果 |
| --- | --- | --- |
| 1 | 点「现在就走」→ 出结果 → 滚到地图、路线重新画一遍 | PASS：滚到地图（map.top=211~370，scrollY>200）；runs=1，active 时 pointCounts 从 1 开始涨 |
| 2 | 点「不感兴趣」→ 行程变了 → 滚到地图、动画重播 | PASS：站点行变化（四季面馆→U咪Coffee 等）；滚回地图（scrollY=594）；runs 1→2 |
| 3 | 「换一个」看不到了；`/api/swap` 仍能调通 | PASS：全页 0 个「换一个」按钮、展开层也没有；Node 直接 POST `/api/swap` → HTTP 200、第 2 站 placeId 确实变了；「不感兴趣」仍在 |
| 4 | 手动触发换站（curl 等价数据）→ 页面收到后仍滚+重播 | PASS：dev 钩子走同一条 `runSwap` → 真实 `/api/swap` HTTP 200；站点变化；滚到地图；runs 2→3 |
| 5 | 首屏加载不滚、不播 | PASS：scrollY=0、无地图容器、无 motion |
| 6 | 减少动态效果 → 不播但滚 | PASS（CDP 模拟 `prefers-reduced-motion: reduce`）：滚到地图；`reducedMotion=true, runs=0`；路线直接完整 |
| 7 | 手动缩放/拖动地图 → 不重播 | PASS：手势后 runs 仍为 3、active=false、0 圆点、滚动位置不动（589→589） |
| 8 | 15:20 / 辽阳 placeId 与改造前一致 | PASS：不传 profile `B0HRCZKQIF,B0KR4Z14IU,B01A300Q37,B0FFKBHIFY`，与 M18 验收记录逐字一致（本轮 planner/api/preference 零改动） |
| 9 | tsc / lint | PASS：`npx tsc --noEmit` exit 0；`npm run lint` 0 warning/0 error；`npx next build` exit 0 |

## 4. 回归

| 套件 | 结果 |
| --- | --- |
| `m19-scroll-replay.mjs`（本轮验收） | PASS 30 / FAIL 0 |
| `map.mjs`（地图视觉/动画/降级） | PASS 50 / FAIL 0（B 段按 M19 新契约改为「换站后重播 runs=2」） |
| `map-replay.mjs`（组件重播专项） | PASS 57 / FAIL 0（同 key 重渲染不重播、reduce、跳过后再换站、真实不感兴趣 runs 1→2） |
| `page.mjs` | PASS 40 / FAIL 0 / SKIP 1（C4/D 断言改为「不感兴趣在、换一个隐藏」） |
| `lead-final.mjs` | PASS 16 / FAIL 0（场景 3 换站改走 dev 钩子；每次换站等重播结束再点下一次） |
| `another-route-ui.mjs` | PASS 24 / FAIL 0（站数允许随种子变化，首站不变） |
| `onboarding-e2e.mjs`（M18 回归） | PASS 30 / FAIL 0 |
| `road-ui.mjs` | PASS 26 / FAIL 0 / SKIP 1 |
| `swap-dislike-ui.mjs`（不感兴趣） | PASS 5 / FAIL 0 |
| `swap-band-api.mjs`（API 级距离带） | 验收 1–3 PASS、验收 5 PASS；验收 4「自然空带场景搜索」在当前数据下没搜到（历史 M14 脚本的搜索用例，非 M19 回归；受控空带用例与 UI 受控测试仍覆盖） |
| `check-loopshape --strict` | PASS 5/5（placeId/距离与冻结基线一致） |
| `try-itinerary` | exit 0（三组 placeId 与基线一致） |
| `tsc` / `lint` / `next build` | 全部 exit 0 |

## 5. 已知取舍 / 边界

1. **换一个入口藏起来后，M14 的 UI 点击类脚本会失效**（页面上没有按钮可点）：`swap-band-ui.mjs`、`swap-band-natural-ui.mjs`、`first-screen.mjs` 里点「换一个」的用例需把三处 `SHOW_SWAP_BUTTON` 改回 `true` 才能跑；脚本本身都保留，没有删除。
2. **快速连点换站时动画会重新开始**：每次行程变化都会让 animationKey +1，如果上一次重播还在播，组件会取消旧动画并从头播新的（不会叠加两个 RAF/两个圆点）。lead-final 的「连续 3 次换站」用例现在每次等重播播完再点下一次（真人不会在 3.5s 动画里连点三次）。
3. **滚动目标受页面高度限制**：`scrollIntoView(block:'start')` 在结果页内容不够长时，最大滚动量可能只够把地图顶到 170–370px（而不是贴着视口顶部），这属于正常布局；断言按「地图进入视野 + scrollY 明显增大」判定。
4. **dev 钩子只在开发环境存在**：`window.__SZJZ_DEBUG__.runSwap` 被 `process.env.NODE_ENV === "production"` 守卫；生产包不会暴露。
5. 「再来一条」随机换整条路线时，站数可能随种子变化（powerful 画像下已出现 4→3 站），首站仍按硬规则不变。

## 6. 复现

```powershell
cd "（项目根）"
# dev server 在 http://127.0.0.1:3000
node build/verify/m19-scroll-replay.mjs     # 验收 1–7 + 回归 8（本轮主验收）
node build/verify/map-replay.mjs            # 组件重播专项（57 项）
node build/verify/map.mjs                   # 地图视觉/动画/降级（50 项）
node build/verify/page.mjs                  # 页面/首屏/展开层（换一个已隐藏）
npx tsx --env-file=.env.local scripts/check-loopshape.ts --strict
node build/verify/swap-dislike-ui.mjs       # 不感兴趣仍可用
```
