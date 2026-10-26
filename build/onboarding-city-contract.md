# 本轮契约：问答第 2 步加城市切换 + coverage 文案

> 用户指令（2026-10-25 17:0x，原文见对话）：问答第 2 步合并进「城市切换」，不新增步骤；城市状态与主页下拉共用同一份 state；切城市要清掉属于旧城市的起点；另加手写 `coverage` 字段与「现在能规划：…」灰字（问答第 2 步 + 排不出来文案）。
> 项目根：`（项目根）`。dev server 3000 在跑（旧进程，代码改动后会自动重编译；验收不要重启）。

## 0. 用户指示 vs 代码现实（两处偏差，实现按现实、报告写明）

1. 用户说「`types/schema.ts` 的 CityConfig 加可选字段 `coverage?: string[]`」——**实际 `CityConfigSchema` / `CityConfig` 在 `lib/cityData.ts`**（`types/schema.ts` 里没有 CityConfig，且该文件 M0 冻结）。本轮**不改** `types/schema.ts`，在 `lib/cityData.ts` 的 `CityConfigSchema` 上加可选字段（符合「只允许新增可选字段」精神）。
2. 用户说「已有逻辑，跟着城市走」的 coverage 灰字——仓库里并不存在现成 coverage 文案（全仓无「已收录/覆盖范围」这类灰字）。按用户后续补充：**coverage 是手写字段，不自动推导、不用 geoRadiusM**。

## 1. coverage 数据（手写，唯一来源 = 城市 json）

- `data/cities/beijing.json` 顶层加：`"coverage": ["良乡 · 长阳", "顺义城区"]`
- `data/cities/liaoyang.json` 顶层加：`"coverage": ["白塔区 · 文庙", "太子河沿岸"]`
- 位置：`districts` 之后、`landmarkKeywords` 之前（schema 字段顺序同此，fetch:seed 重写时按 schema 顺序落盘也不会变）。
- 只加这一个键：`places` 与其它配置字段一个字节都不许变（验证方式：解析两文件，除 `coverage` 外 JSON 深比较相等）。
- `lib/cityData.ts`：`CityConfigSchema` 增加 `coverage: z.array(z.string().min(1)).optional()`；`CityConfig` 自动带上。
- `app/api/cities/route.ts`：下发条目增加 `coverage`（有才带，`...(config.coverage === undefined ? {} : { coverage: config.coverage })`）。
- `scripts/fetch-seed.ts` **不许改**：它用 `loadCityConfig` 读回整份配置再 `saveCityData(CONFIG, ...)`，coverage 天然保留（reviewer 静态核这条链路）。

## 2. Onboarding props（`components/Onboarding.tsx`）

```ts
export type OnboardingCityOption = { city: string; displayName: string; coverage?: string[] };
export type OnboardingProps = {
  onComplete, onSkip?, initialProfile?, initialGeo?,   // 既有，语义不变
  /** 本轮新增：城市列表（顺序 = /api/cities 下发顺序） */
  cities: OnboardingCityOption[];
  /** 本轮新增：当前城市 id（页面 state，不是组件内部 state）；空串 = 城市列表还没加载完 */
  selectedCityId: string;
  /** 本轮新增：切城市（由页面执行真正的切换逻辑） */
  onCityChange: (cityId: string) => void;
};
```
旧 prop `city?: string` **删除**（geocode 的 city 改用 `selectedCityId`；页面传的 `selectedCityId` 已包含「城市列表还没加载完时用地址栏 ?city= 兜底」的口径）。

## 3. 第 2 步布局（不新增步骤；GEOLOCATION_ENABLED=false，定位按钮当前不渲染，保持）

从上到下：
1. 标题：**「你的起点在哪？」**（原「从哪儿出发？」）。
2. 第一行：城市胶囊按钮组，容器 `data-testid="onboarding-city-switch"`，每个按钮 `data-testid="onboarding-city-{city}"`、`aria-pressed`；
   - 选中态：白底 + 深色字 + 1px 边框（`border-stone-900 bg-white text-stone-900`）；
   - 未选中：透明底 + 灰字（`border-transparent bg-transparent text-stone-500`）；
   - 点击未选中项 → `onCityChange(city)`；点选中项不发请求。
3. 第二行：起点输入框（既有 `onboarding-manual-input` + `onboarding-manual-submit` 保留），placeholder 按城市：
   - `beijing` → `例如：良乡地铁站`
   - `liaoyang` → `例如：白塔区中心路`
   - 其它 / 空串 → `输入你的起点`
4. 第三行（coverage 灰字，`data-testid="onboarding-coverage"`）：
   - 当前城市有 `coverage` → `现在能规划：{coverage.join(" · ")}`；
   - 没有 → 整行不渲染。
   - 例：北京 → `现在能规划：良乡 · 长阳 · 顺义城区`；辽阳 → `现在能规划：白塔区 · 文庙 · 太子河沿岸`。
5. 既有元素全部保留：预填/已选起的「已选起点：…」卡片、`onboarding-origin-error`、上一步/继续/进度点、第 1/3/4/5 步。

## 4. 切城市的清理规则（第 2 步内）

`selectedCityId` 发生 **非空 → 非空** 的变化时（= 用户真的在问答里切城市）：
1. `manualAddress` 清空（输入框 value 变空）；
2. 已选起点 `origin` 清空（「已选起点」卡片消失；`canContinue` 变 false，必须在新城市重新选起点）；
3. `originError` 清空；
4. 在飞的 geocode 作废（`originFlowRef += 1` / `cancelPendingOriginWork()`），旧城市地址的解析结果不许回填；
5. `userTouchedOriginRef` 复位 false（新城市的定位结果可以再预填）；
6. `originSettledRef` 复位 false（新城市可以重新 settle）。

**不触发清理的情况**（否则会破坏既有预填体验）：
- `"" → "beijing"`（城市列表加载完刚知道当前城市）：保留 `initialProfile.origin` 预填；
- 同 id 重复赋值；
- 主页下拉切城市（Onboarding 未挂载，与此无关）。

## 5. 页面接线（`app/page.tsx`）

1. `CityEntry` 加可选 `coverage?: string[]`；`normalizeCities` 解析（字符串数组且非空才带）；`/api/cities` 契约注释同步。
2. 渲染 Onboarding 时传：
   - `cities={cities.map(...)}`（至少含 city / displayName / coverage；直接传 CityEntry[] 结构兼容）；
   - `selectedCityId={selectedCityId ?? readCityFromSearch() ?? ""}`；
   - `onCityChange={handleOnboardingCityChange}`。
3. `handleOnboardingCityChange = (cityId) => { ... }`：
   - `if (cityId === selectedCityId) return;`
   - **清掉页面上属于旧城市的手填起点**：`planOptions.originAddress` 非空 → 置空（避免走完问答后用 A 的地址去 B 里 geocode）；
   - 调现有 `changeCityTo(cityId, nextOptions)`（写回 `?city=`、清行程提示、清/重解析定位缓存、有行程就重排——即用户要求的「含清定位缓存、重新拉数据」）。
     `changeCityTo` 本轮加了**可选第二参 `optionsOverride`**（主页下拉 / 进行中切城市仍只传 id）：因为 `setPlanOptions` 是异步的，
     不显式传「清理后」的选项的话，闭包里还是旧地址，会拿 A 的地址去 B geocode / 误判「有手填起点」而跳过新城市起点解析。
   - **不新建第二份城市 state**：问答与主页下拉都只读写 `selectedCityId`。
4. 排不出来时文案带 coverage（与问答同格式的灰字）：
   - 失败提示块（`role="alert"`）里，`failureReason !== null` 时追加一行：
     `现在能规划：{coverage.join(" · ")}`（`data-testid="failure-coverage"`，`text-xs text-stone-500`；当前城市没有 coverage 不渲染）。
   - 不改 planner / 不改失败 reason 本身。

## 6. 红线（本轮）

- `types/schema.ts` 不改（hash 不变）。用户指示的 coverage 字段按 §0 落到 `lib/cityData.ts`。
- 两个主城市文件只加 `coverage` 一个键；`places` 数组与其它字段逐字节不变；`data/cities/*.manual.json`（上轮刚瘦身）不动。
- 不改 `lib/planner.ts`、`scripts/fetch-seed.ts`、`app/api/plan/route.ts`、`app/api/geocode/route.ts`、`middleware.ts`；不新增 npm 依赖；无 emoji 图标。
- 不改问答步数（仍 5 步）、不动第 1/3/4/5 步的选项与 testid；不动主页城市下拉行为（主页下拉切城市**不**清 `planOptions.originAddress`，保持既有「手填永远最优先」语义）。

## 7. 验收（verifier 按此写脚本；6 条主验收 + 数据/API + 回归）

1. 清 localStorage 打开 → 走完第 1 步进第 2 步：标题「你的起点在哪？」；`onboarding-city-switch` 下 2 个胶囊；北京胶囊 `aria-pressed=true` 且 computed 样式 = 白底(`rgb(255, 255, 255)`)、深色字(`rgb(28, 25, 23)` stone-900)、1px 边框；辽阳胶囊 `aria-pressed=false`、透明底(`rgba(0, 0, 0, 0)`)、灰字(`rgb(120, 113, 108)` stone-500)。
2. 点「辽阳」→ 胶囊选中切换；placeholder = `例如：白塔区中心路`；coverage 文本 = `现在能规划：白塔区 · 文庙 · 太子河沿岸`；`/api/cities` 请求不受影响；URL `?city=liaoyang`；等页面 state 稳定。
3. 在北京：输入框填「良乡地铁站」（不提交）→ 点「辽阳」→ 输入框 value 变空；如果先点「解析地址」成功（出现「已选起点：良乡地铁站」）再切辽阳 → 「已选起点」卡片消失、输入框空、`onboarding-origin-error` 不存在。
4. 问答里选辽阳 → 走完 5 步 → 主页 `[data-testid="city-select"]` 的 value = `liaoyang`；再回主页下拉切北京 → 刷新 → 问答第 2 步北京胶囊 `aria-pressed=true`（预选新城市）；**主页下拉切城市不清手填起点**（主页行为不变）。
5. coverage 数据/API：`/api/cities` 两城条目都带 coverage 且数组与城市 json 一致；`npx tsx` 读 `loadCityConfig` 一致；两城 json 除 coverage 外深比较与备份一致（places 不变）。
6. 排不出来带 coverage：北京起点填「五道口站」（/api/geocode 能解析）→ 走完问答 → 主页点「现在就走」→ 出现 `role="alert"` 失败提示，且其中包含 `现在能规划：良乡 · 长阳 · 顺义城区`（`data-testid="failure-coverage"`）。
7. 回归：`node build/verify/onboarding-always-acceptance.mjs` 仍 PASS（若它硬断言了旧标题，脚本里的**失效断言**允许改一处并在报告注明；产品代码不改）；`npm run check:city` = 基线 13 通过 / 1 历史失败；上一轮地图验收 `scripts/verify/admin-map-acceptance.mjs` 仍 PASS（data places 未变）；tsc 0 error、lint 0 warning。
8. 控制台过滤 AMap 噪声后 0 error；无 emoji。
9. 至少 1280×900 截图：第 2 步北京、第 2 步辽阳、主页失败提示（含 coverage）。

10. **被本轮规格取代的旧断言**（只能在报告注明后改那一行，产品代码不能为迁就旧脚本改回去）：
    - `build/verify/onboarding-e2e.mjs:188`：断言第 2 题 bodyText 含「从哪儿出发」→ 本轮标题改为「你的起点在哪？」。
    - `build/verify/geo-flag-acceptance.mjs:54`：断言 placeholder = 「输入你的起点，例如：良乡地铁站」→ 本轮按城市给 placeholder（北京「例如：良乡地铁站」/ 辽阳「例如：白塔区中心路」/ 其它「输入你的起点」）。
    - `build/verify/onboarding-ui.mjs:313-321`：静态断言源码含 `city?: string` 与 `const cityId = typeof city === "string"` → 本轮 props 改为 `cities/selectedCityId/onCityChange`（城市透传改由 selectedCityId 负责）。该脚本更早轮就与 GEOLOCATION 关闭后的实现有出入，不算本轮回归门禁。

11. **切城市 + 选起点 + 真正排一次（reviewer 发现的 M1，已修，必须验）**：
    在问答里切到另一个城市 → 填该城市地址并解析成功（出现「已选起点」）→ 走完 5 步 → 主页点「现在就走」：
    - `POST /api/plan` 请求体**不得带 `latitude` / `longitude`**（这两个字段只用于定位 / 跨城兜底）；
    - 请求体必须带 `profile`，且 `profile.origin.label` = 用户在问答里选的起点；
    - 服务端因此用 `profile.origin` 当起点（不是新城市的中心点）。
    实现保证：`handleProfileComplete` 里清 `forcedCityOriginRef / geoPositionRef / setGeoPosition(null)`（跳过路径不清）。

## 8. 写入范围

| 角色 | 可以写 |
| --- | --- |
| Lead | `data/cities/beijing.json`、`data/cities/liaoyang.json`、`lib/cityData.ts`、`app/api/cities/route.ts`、`app/page.tsx`、`components/Onboarding.tsx`、`build/onboarding-city-contract.md` |
| verifier | `scripts/verify/onboarding-city-acceptance.mjs`、`.cache/verify/`、`build/reports/onboarding-city/`（可改 `build/verify/onboarding-always-acceptance.mjs` 里因标题改动的失效断言，但必须在报告注明改了哪一行、为什么） |
| reviewer | `build/reports/onboarding-city/review.md` |

越界先找 Lead。
