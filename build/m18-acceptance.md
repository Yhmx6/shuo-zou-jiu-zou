# M18 开屏问答 + 出行画像 + planner 接入 · 验收报告

> 需求：加开屏问答流程（4 步 / localStorage `szjz.profile` / zod 校验 / 只在首次问 / 更多选项可重新设置），
> profile 按 style（rich/powerful）与 scene（风光/人文/随便）调参；**随机也必须遵守约束**。
> 基线 HEAD：`53aa3ae`（M17）。验收时间：2026-10-24 18:0x–19:0x。

**结论：8 条验收全部通过；无 profile 的既有行为逐字不变；全量回归绿。** 已提交 `e5e4c1a`（M18）。

## 1. 交付

| 层 | 文件 | 说明 |
| --- | --- | --- |
| 数据 | `lib/profile.ts`（新） | `TravelProfile` 类型 + zod（strict）+ localStorage 读/写/清 + `buildProfile`；**读的时候坏数据当没有** |
| 接口 | `app/api/geocode/route.ts`（新） | `POST {address, city?}` → 200 `{ok:true,lng,lat,label}` / 200 `{ok:false,reason}` / 400 人话 |
| 接口 | `app/api/plan/route.ts` | body 加可选 `profile`（zod，非法 400）；origin 优先级 originAddress > lat/lng > profile.origin > 城市默认；homeBy body > profile |
| 规划 | `lib/planner.ts` | `buildItinerary(origin, startAt, constraints, profile?)`；rich/powerful 调参 + scene 加权 + 硬约束；所有加权同步进 `scoreUpperBound`（剪枝安全）；随机 jitter 在约束之后乘 |
| 组件 | `components/Onboarding.tsx`（新） | 4 步一屏、进度点最下、白底 stone 无 emoji、定位（8s 超时/失败人话）、手填 geocode、`onComplete` 只调一次 |
| 页面 | `app/page.tsx` | 首次进入读画像：无 → 整屏问答（**无启动页**）；有 → 原主页（启动页照旧）；问答完成 → save → 主页（启动页在问答之后）；请求带 profile；「更多选项 → 重新设置」（可取消，完成后覆盖画像并 refresh 重排） |
| 测试基建 | `scripts/verify/lib.mjs` | 历史验收脚本自动注入测试画像（powerful / origin=城市圆心），绕过问答 |

## 2. 八条验收

| # | 验收 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 首次进入出现 4 步问答，走完进主页 | **PASS** | Lead `onboarding-e2e.mjs` 1.1–1.14：问答存在、问答期间**无启动页**、4 步（风格→手填地址→22:00→人文）→ 主页；启动页在问答后出现，**447ms** 消失 |
| 2 | 刷新不再问，直接进主页 | **PASS** | 同脚本 2.1/2.2：刷新后 onboarding 不存在、主页就绪 |
| 3 | rich 跑一次：有打车段，或餐厅更贵 | **PASS** | 辽阳 rich：3 站，`walk→walk→drive→drive`，餐厅乐芝达 **63 元**（无 profile 基准最高 24 元）；杭州 rich 也有 drive 段 |
| 4 | powerful 跑一次：全步行/骑行，站数更多 | **PASS** | 辽阳 powerful 4 站 `walk→walk→walk→bike→bike`（A 脚本断言：全段 walk/bike）；站数 4 ≥ rich 3（两城都成立） |
| 5 | 风光：≥3 站是 park 或风光类 sceneryType | **PASS** | 辽阳 3/3、杭州 3/3（脚本按 placeId 查城市数据判定） |
| 6 | 人文：≥3 站是书店/博物馆/美术馆/市场/老街 | **PASS**（按用户原文严格名单） | 辽阳：鑫语书店 + 西文化综合市场 + 辽阳市海鲜农贸大市场 = 3/3；杭州：明康汇生鲜菜市 + 南宋书房 + 新华书店(解放路) = 3/3 |
| 7 | 点「重新设置」→ 回到问答 | **PASS** | E2E 7.1–7.6：更多选项里有按钮、回到第 1 题、可取消回主页、重新答完覆盖画像（powerful/null/scenery） |
| 8 | 清空 localStorage → 再次进入会重新问 | **PASS** | E2E 8.1 |

附加（超出验收要求，但顺手覆盖）：
- 定位失败 → 人话「定位不可用，手动输入地址也一样」，且**不挡手填**（E2E 1.7/1.8）；
- 定位成功 → `profile.origin` 用定位坐标（E2E 附2）；
- 手填地址 → `/api/geocode` 解析 → 进第 3 题（E2E 1.9）；
- `/api/plan` 请求体带完整 profile（style/homeBy/scene/origin），「再来一条」也带 profile+seed（E2E 1.18 / page-wiring 脚本 G2/G3）。

## 3. 关键实现口径（含与字面要求的差异，均已在契约里批准）

1. **rich**
   - rating 权重 0.45（原 0.3）；importance≥3 且 rating≥4.3 加权 ×1.25（非过滤）；
   - 餐厅 `avgCost<60` 排除（`null` 视为未知保留，否则小城市没有餐厅可用）；若因此正餐轮排不进 → **放宽下限重排一次兜底**并打 `[planner] rich 餐厅下限兜底` 日志；
   - 规划副本 `timeFirst=true`（允许打车）、站数上限 3、非餐厅站 90 分钟（餐厅保持类目原停留，避免顶穿正餐窗口）。
2. **powerful**
   - rating 权重 0.2；硬底线 `rating≥3.5 或 importance≥2`；餐厅 `avgCost>60` 排除（null 保留）；
   - 步行半径 30→50 分钟（planner 内 profile 感知，未改 lib/constraints.ts）；
   - **规划时禁公交/打车**（用户验收 4 要求「全步行/骑行」；只对带 profile 生效）；
   - 站数上限 6（沿用 MAX_STOPS）。
3. **scene**（加权非过滤，上界同步乘）
   - scenery：sceneryType∈[江景,森林,田野,园林] 或 park → ×1.5；
   - culture：**用户严格名单**（bookstore/museum/gallery/market 或 sceneryType=老街）→ ×1.5；契约 §3 的「建筑/市井」降为次级 ×1.2；culture 的「第 1 站场景优先」「预筛预留名额」只认严格名单（否则数学上凑不到 ≥3）；
   - any：不变。
4. **随机不绕约束**：seed 只影响「在通过过滤的候选里选谁」，所有 profile 过滤/加权在打分与上界层面先生效。实测 seed=1..3 × 4 类 profile × 2 城共 24 组，约束全部不破。
5. **无 profile 行为逐字不变**：`check-loopshape --strict` 5 组 placeId/距离与基线完全一致；`try-itinerary` 三组 placeId 完全一致。

## 4. 全量回归

| 套件 | 结果 |
| --- | --- |
| `onboarding-e2e.mjs`（Lead 写） | **PASS 30 / FAIL 0** |
| `onboarding-ui.mjs`（组件） | **PASS 76 / FAIL 0**（含定位 8s 超时 8085ms） |
| `page-onboarding.mjs`（页面接线） | **PASS 41 / FAIL 0**（未点击首屏与改版前逐字一致 0 行差异） |
| `profile-plan.mjs`（planner 34 组） | **FAIL 0 / WARN 1**（仅 rich 杭州餐厅下限兜底，已报备） |
| `check-loopshape --strict` | PASS 5/5（placeId/距离与基线逐字一致） |
| `try-itinerary` | exit 0（三组 placeId 与基线一致） |
| `page.mjs` | PASS 39 / FAIL 0 / SKIP 1（SKIP=旧基线文件改名） |
| `map.mjs` | PASS 50 / FAIL 0 |
| `lead-final.mjs` | PASS 16 / FAIL 0（启动页时序按 M18 改为「出现→消失」口径） |
| `another-route-ui.mjs` | PASS 24 / FAIL 0 |
| `swap-band-ui.mjs` | PASS 19 / FAIL 0 |
| `road-ui.mjs` | PASS 26 / FAIL 0 / SKIP 1（返程非公交时跳过公交文案） |
| `swap-dislike-ui.mjs` | PASS 5 / FAIL 0 |
| `npx tsc --noEmit` / `npm run lint` / `npx next build` | 全部 exit 0 |

## 5. 已知取舍 / 边界

1. **rich 杭州 15:20 走兜底**：数据里唯一「avgCost≥60 且能排」的餐厅在 11.5km 外（超驾车半径），故正餐轮放宽下限重排；辽阳 rich 正常（餐厅 63、有 drive）。
2. **powerful 在少量时段较慢**（如杭州 16:10 首次约 20s）：步行半径 50 分钟 + 禁公交 → 候选与算路更多；功能正确，只是慢。
3. **culture 达标靠严格名单**：辽阳/杭州各 3/3；若未来城市数据里书店/博物馆/美术馆/市场/老街过少，可能达不到 3 站，届时如实降级（不伪造）。
4. **历史脚本适配**：`build/verify/swap-band-natural-ui.mjs`（M14 的「不感兴趣把序列弄成非单调再换一个」脚本）在 M18 的 powerful 测试画像下不再触发区间反转（数据依赖），该路径已由受控测试覆盖；其余历史脚本已按 M18 启动页时序修正等待逻辑。
5. **测试基建**：`scripts/verify/lib.mjs` 的 `connectPage` 默认注入测试画像并**每次覆盖**（Edge profile 的 localStorage 会跨脚本残留）；测首次问答必须传 `{ seedProfile: false }`。
6. `/api/geocode` 的城市参数：问答第 2 题会把页面当前城市（`?city=` / 城市下拉）带给服务端；不传时仍用 ACTIVE_CITY 默认城市。

## 6. 复现

```powershell
cd "（项目根）"
# dev server 在 http://127.0.0.1:3000
node build/verify/onboarding-e2e.mjs       # 验收 1/2/7/8 + 定位两条路径 + profile 随请求下发
node build/verify/profile-plan.mjs         # 验收 3–6 + 随机不绕约束 + API 契约（34 组）
node build/verify/page-onboarding.mjs      # 页面接线（41 项）
node build/verify/onboarding-ui.mjs        # 组件（76 项）
npx tsx --env-file=.env.local scripts/check-loopshape.ts --strict   # 无 profile 回归不变
```
