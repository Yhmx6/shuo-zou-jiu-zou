# M18 契约：开屏问答 + 出行画像 + planner 接入（Lead 定稿，三人按此并行）

> 任务原文（用户）：加开屏问答流程（4 步 / localStorage / planner 按 style + scene 调参 / 随机也不许绕过约束）。
> 项目根 `（项目根）`；dev server 已在 **http://127.0.0.1:3000**（别重启、别另起端口）。
> 基线 HEAD：`53aa3ae`。审批已关闭，**不要**请求提权。不要 git commit / reset / checkout。

## 0. 谁写什么（严格分区，越界即返工）

| 角色 | 文件 |
| --- | --- |
| Lead（已完成，只读） | `lib/profile.ts`、`app/api/geocode/route.ts` |
| `profile-planner`（A） | `lib/planner.ts`、`app/api/plan/route.ts` |
| `onboarding-ui`（B） | `components/Onboarding.tsx`（新建） |
| `page-wiring`（C） | `app/page.tsx` |
| Lead | `scripts/verify/lib.mjs`（测试注入 profile 的公共 helper）、`build/verify/*`、最终验收与提交 |

不许动：`types/schema.ts`、`lib/constraints.ts`、`app/api/cities`、`/admin` 相关、`data/**`、`lib/amap.ts`、`lib/profile.ts`、`app/api/geocode/route.ts`。
需要跨区改动 → 先发消息给 Lead。

## 1. 数据层（Lead 已写完，你们直接用）

`lib/profile.ts`：

```ts
export const PROFILE_STORAGE_KEY = "szjz.profile";
export const TRAVEL_STYLES = ["rich", "powerful"] as const;
export const TRAVEL_SCENES = ["scenery", "culture", "any"] as const;
export const TravelProfileSchema;            // zod（strict）
export type TravelProfile = {
  style: "rich" | "powerful";
  origin: { lat: number; lng: number; label: string };
  homeBy: number | null;                     // 当日分钟数，1320 = 22:00
  scene: "scenery" | "culture" | "any";
  updatedAt: string;
};
export type TravelStyle; export type TravelScene;
export type TravelProfileInput = { style; origin; homeBy; scene };
export function buildProfile(input: TravelProfileInput): TravelProfile;   // 补 updatedAt
export function readProfileFromStorage(): TravelProfile | null;          // 坏数据 → null
export function saveProfile(profile: TravelProfile): boolean;
export function clearProfileFromStorage(): void;
export function formatProfileHomeBy(homeBy: number | null): string;      // null → "不限"
```

`app/api/geocode/route.ts`（问答第 2 题手填地址用）：

```
POST { address: string, city?: string }
  → 200 { ok: true, lng, lat, label }
  → 200 { ok: false, reason }   // 解析不出来的人话
  → 400 { ok: false, reason }   // 参数非法
```

## 2. `/api/plan` 的 profile 契约（A 实现）

请求体新增**可选** `profile`（形状与 `TravelProfile` 一致；用 zod 校验，非法 → 400 人话）。

有 profile 时：
1. **起点**：`originAddress` / `latitude+longitude` 仍然优先（用户临时改起点要生效）；
   两者都没有 → 用 `profile.origin`（`makeOriginPlace(profile.origin.lng, profile.origin.lat, profile.origin.label)`）。
2. **homeBy**：body.homeBy 优先；否则用 `profile.homeBy`（`null` → 不传）。
3. 把 profile 作为 `buildItinerary(origin, nowMinute, constraints, profile)` 的第 4 个参数传下去。
4. 无 profile → 与现在**逐字一致**（不许改默认行为）。

## 3. planner 接入（A 实现）

`buildItinerary(originInput, startAt, constraintsInput, profile?: TravelProfile)`；profile 类型用
`import type { TravelProfile } from "./profile"`（type-only，运行时不会加载 profile.ts）。

**通用要求**
- 所有 profile 逻辑只在 `profile !== undefined` 时生效；不传时既有 5 组 placeId 基线（check-loopshape）与 try-itinerary 三组结果必须**逐字不变**。
- 加权不能破坏 `scoreUpperBound` 剪枝：候选打分乘的系数要同时乘到上界上（或保证 ≤1 的写法），保证「真实分 ≤ 上界」。
- **随机（seed）与 profile 必须叠加**：随机只改「在通过约束的候选里选谁」，不能绕过任何 profile 约束。

**style 调参**（两个都是「去什么样的地方」）

| 项 | rich（高品质） | powerful（冒险） |
| --- | --- | --- |
| rating 权重 | 0.3 → 0.45（其余权重不变；排名等价于归一化） | 0.3 → 0.2 |
| 优先加权（非过滤，×1.25） | importance ≥3 **且** rating ≥4.3 | sceneryType ∈ [老街,工业,市井,森林] **或** category ∈ [market,other] |
| 硬约束 1 | 餐厅 `avgCost < 60` 排除（`avgCost === null` 视为未知，保留；否则小城市会没有餐厅可用） | 餐厅 `avgCost > 60` 排除（null 保留） |
| 硬约束 2 | — | 所有候选：`rating ≥ 3.5` 或 `importance ≥ 2`（满足其一才进池） |
| 交通 | 允许打车（规划时 mode 视为 timeFirst=true → 现有规则会用 drive），驾车半径 25 分钟（现有 RADIUS_LIMIT_MIN.drive 就是 25） | 步行半径 30 → **50 分钟**（override） |
| 站数上限 | 3 | 6（现有 MAX_STOPS） |
| 停留时长 | 非餐厅站 90 分钟（餐厅保持类目原值，避免顶穿正餐窗口） | 不变 |

**scene 加权（非过滤，在预筛前生效）**
- `scenery`：sceneryType ∈ [江景,森林,田野,园林] 或 category=park → 分 ×1.5
- `culture`：sceneryType ∈ [老街,建筑,市井] 或 category ∈ [bookstore,museum,gallery,market] → 分 ×1.5
- `any`：不变
- 多个加权同时命中就相乘（例：rich+scenery 的江景公园 = 1.25×1.5），上界同步乘，剪枝仍安全。

**验收口径（A 自己先跑）**
- 无 profile：`check-loopshape --strict` 5/5 + `try-itinerary` placeId 与基线一致。
- 有 profile：用 `/api/plan` 分别跑 rich / powerful / scenery / culture（辽阳与杭州 15:20），
  断言：rich 有 drive 段或餐厅人均更高、powerful 全步行/骑行且站数 ≥ rich、scenery ≥3 站是 park/风光类、
  culture ≥3 站是书店/博物馆/美术馆/市场/老街。规则（时间闭合、预算、用餐、距离）不破。
  脚本写到 `build/verify/profile-plan.mjs`（你自己的文件）。

## 4. Onboarding 组件（B 实现）

`components/Onboarding.tsx`（`"use client"`）：

```ts
export type OnboardingProps = {
  onComplete: (profile: TravelProfile) => void;
  /** 可选：重新设置时允许取消回主页（首次进入不传 = 不能跳过）。 */
  onCancel?: () => void;
};
export default function Onboarding({ onComplete, onCancel }: OnboardingProps);
```

4 步，每步一屏（同一屏内切换，不要路由跳转）；**进度点在最下面**（当前步高亮）。
风格与首屏一致：白底、stone 色系、无 emoji、无图片；字号克制。

1. 第 1 题「你更想怎么走？」两个选项：`用钱换时间`（副文案：打车没问题，吃好一点）/ `用体力换钱`（副文案：多走走，免费的地方也很好）。
2. 第 2 题「从哪儿出发？」：`定位当前位置` → `navigator.geolocation.getCurrentPosition`；
   失败/被拒/超时（8 秒）→ 显示人话提示「定位不可用，手动输入地址也一样」并且**不阻塞**手填。
   `手动输入地址` → 输入框 + 「解析地址」按钮 → `POST /api/geocode`；失败显示接口的 reason。
   定位成功用 label `当前位置`；手填成功用地址原文 label。**解析中/定位中按钮要有忙碌态**。
3. 第 3 题「几点想回家？」：`不限制` / `18:00` / `20:00` / `22:00` / `自己选`（原生 `<input type="time">` + 确认）。
   → homeBy = 当日分钟数（18:00=1080 / 20:00=1200 / 22:00=1320），不限制 = null。
4. 第 4 题「今天想看什么？」：`风光` / `人文` / `随便走走`。
完成 → `buildProfile({style, origin, homeBy, scene})` → `onComplete(profile)`（**写 localStorage 由页面负责**）。
每步都有「上一步」；第 1 步没有；重新设置时（onCancel 存在）右上角给一个「取消」。

**必须提供的 data-testid**（Lead 的浏览器验收要用）：
`onboarding`、`onboarding-step`（带 `data-step="1|2|3|4"`）、`onboarding-progress`、
`onboarding-style-rich` / `onboarding-style-powerful`、
`onboarding-geolocate`、`onboarding-manual-input`、`onboarding-manual-submit`、`onboarding-origin-error`、
`onboarding-homeby-1080|1200|1320|null`、`onboarding-homeby-custom`、`onboarding-homeby-custom-confirm`、
`onboarding-scene-scenery|culture|any`、`onboarding-back`、`onboarding-cancel`。

注意：不要用 emoji；不要引入新依赖；`onComplete` 只调一次。

## 5. 页面接线（C 实现）

`app/page.tsx`：

1. 首次进入读画像（`readProfileFromStorage()`，只在客户端；用 effect 读，避免 hydration 不一致）：
   - 没有 → 渲染 `<Onboarding onComplete={...} />`（**整屏**），此时**不显示启动页**；
   - 有 → 直接进现有主页流程（启动页照旧）。
2. `onComplete(profile)`：`saveProfile(profile)` → 存到 state → 进入主页（首次进入时启动页在问答之后才出现，仍走现有 2 秒上限逻辑）。
3. `/api/plan` 请求体加 `profile`（完整对象）；`buildPlanRequestBody` 加参数。
   profile 的 origin / homeBy 由服务端兜底（页面不用重复发 latitude/originAddress/homeBy，
   除非用户在「更多选项」里显式填了 —— 那几条现有的优先级逻辑保持不变）。
4. 「更多选项」面板里加一个「重新设置」（`data-testid="onboarding-reset"`）：
   点了回到问答（`onCancel` 存在 → 显示取消）；问答完成 → 覆盖画像；
   如果之前已有行程，完成后用新 profile 自动重排一次（沿用 `runPlan(..., refresh=true)` 语义）。
5. 首屏一致性：**已有 profile 的老用户**打开页面时，未点击前仍然只有「状态文字 + 城市 + 现在就走 + 更多选项」，
   逐字不变（现有 page.mjs 的验收 11 会检查）；onboarding 只在「没有画像」时出现。
6. 「再来一条」请求也必须带 `profile`（随机不许绕过约束）。

## 6. 验收（8 条）与分工

| # | 验收 | 谁跑 |
| --- | --- | --- |
| 1 | 首次进入（清 localStorage）出现 4 步问答，走完进主页 | Lead 浏览器全流程 |
| 2 | 刷新不再问，直接进主页 | Lead（刷新后断言 onboarding 不存在） |
| 3 | rich 跑一次：有打车段，或餐厅更贵 | A 的 API 脚本 + Lead 复跑 |
| 4 | powerful 跑一次：全步行/骑行，站数更多 | A + Lead |
| 5 | scenery：4 站里 ≥3 站是 park 或风光类 sceneryType | A + Lead（用城市数据按 placeId 查类型） |
| 6 | culture：≥3 站是书店/博物馆/美术馆/市场/老街 | A + Lead |
| 7 | 点「重新设置」→ 回到问答 | Lead 浏览器 |
| 8 | 清空 localStorage → 再次进入会重新问 | Lead 浏览器 |

## 7. 环境与协作

- 浏览器验收是独占资源：跑之前原子创建 `build/.verify-lock`（内容写你的名字），跑完删除；
  锁已存在等 60s 重试，最多 5 分钟。
- **现有验收脚本**（page.mjs / map.mjs / lead-final / another-route-ui / swap-band-ui…）会因为「没有 profile」
  而先看到问答 —— Lead 会统一在脚本里注入 localStorage 画像来绕过问答，你们**不用改**这些脚本；
  但你们自己的脚本要自己注入（示例：`Page.addScriptToEvaluateOnNewDocument` 里
  `localStorage.setItem("szjz.profile", JSON.stringify({...}))`）。
- 每次改完必须：`npx tsc --noEmit` 干净 + `npm run lint` 干净 + 自己的验收脚本 PASS，把**真实输出**贴进报告。
- 报告写到 `build/reports/m18-<你的名字>.md`，完成后 `send_message` 给 Lead 发 ≤300 字摘要 + 报告路径。
- 不联调对方未完成的代码：按本契约的接口写，遇到真实的类型/接口不符 → 先找 Lead。
