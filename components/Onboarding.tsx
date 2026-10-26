"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { buildProfile } from "@/lib/profile";
import type { TravelProfile, TravelScene, TravelStyle } from "@/lib/profile";
import { GEOLOCATION_ENABLED } from "@/lib/geolocation";

/**
 * 开屏问答：5 步、一屏内切换（不跳路由），结果交给调用方写 localStorage。
 *
 * 分工（契约 §4）：
 * - 组件只收集 style / origin / homeBy / scene / mealIncluded 五件事，最后 buildProfile() 补 updatedAt；
 * - 是否落盘（saveProfile）、落盘后进主页 / 自动重排，全部由 app/page.tsx 负责；
 * - 本轮起**每次打开页面都会走这套问答**：
 *   · 有旧画像时传 initialProfile → 5 步默认选中上次的选择（预填）；
 *   · 有定位结果时传 initialGeo → 第 2 题（起点）预选「当前位置」；
 *   · 有旧画像时传 onSkip → 顶部出现「跳过」，点了直接用上次设置进主页；
 *   · 首次进入（没有旧画像）不传 onSkip → 不能跳过，必须走完 5 步。
 *
 * 交互约定（Lead 浏览器验收按 data-testid 找元素）：
 * - 5 步；进度点在整屏最下面，当前步高亮；第 2–5 步左下角有「上一步」，第 1 步没有；
 * - 第 1 / 3 / 4 步是「选一个就进下一步」；第 3 步「自己选」用原生 time input + 确认按钮；
 * - 第 2 步（本轮起合并了城市切换）：标题「你的起点在哪？」→ 城市胶囊（第一行，与主页下拉共用
 *   同一个 selectedCityId）→ 起点输入框（placeholder 按城市变）→ coverage 灰字「现在能规划：…」；
 *   手填地址走 POST /api/geocode（请求体带当前城市）；任何失败都只在
 *   data-testid="onboarding-origin-error" 里说人话，不阻挡重试；
 *   在问答里切到另一个城市时清空起点输入与已选起点（旧城市的地址不能拿到新城市里 geocode）；
 * - 第 5 步「这一趟要安排吃饭吗？」：默认选中「要吃点东西」；选完直接
 *   onComplete(buildProfile({...}))，ref 兜底只调一次。
 *
 * 风格与首屏一致：白底、stone 色系、无 emoji、无图片、字号克制；按钮一律 <button type="button">，
 * 输入框都有 <label>，进度点用 role="progressbar" + aria-label「第 X 步，共 5 步」。
 * 不引入任何新依赖。
 */

export type OnboardingCityOption = {
  city: string;
  displayName: string;
  /** 可选（本轮新增）：手写的「现在能规划的区域」；没有就不显示那行灰字。 */
  coverage?: string[];
};

export type OnboardingProps = {
  onComplete: (profile: TravelProfile) => void;
  /**
   * 可选：已有画像时顶部显示「跳过」，点了直接回主页用上次设置。
   * 首次进入（没有画像）不传 = 不显示跳过按钮。
   */
  onSkip?: () => void;
  /** 可选：上次的画像 → 5 步的选项默认选中上次的选择。 */
  initialProfile?: TravelProfile;
  /**
   * 可选：本轮定位结果 → 第 2 步（起点）预选「当前位置」。
   * 定位异步到达时也会更新预选（用户已经手动选过起点则不覆盖）。
   */
  initialGeo?: { lat: number; lng: number } | null;
  /**
   * 本轮新增：城市列表（顺序 = /api/cities 下发顺序）。
   * 第 2 步的城市胶囊、起点输入框的 placeholder、coverage 灰字都从这里取。
   */
  cities: OnboardingCityOption[];
  /**
   * 本轮新增：当前城市 id（**唯一来源是页面 state**，本组件不另存一份 city state）。
   * 空串 = 城市列表还没加载完：不显示胶囊选中态、placeholder 用通用文案、geocode 不带 city。
   */
  selectedCityId: string;
  /** 本轮新增：点第 2 步的城市胶囊 → 通知页面做真正的切换（写回 ?city=、清/重解析定位缓存、按需重排）。 */
  onCityChange: (cityId: string) => void;
};

type Step = 1 | 2 | 3 | 4 | 5;

/** 第 2 步定下来的起点：坐标 + 展示名（定位 = "当前位置"；手填 = 地址原文）。 */
type Origin = { lat: number; lng: number; label: string };

const TOTAL_STEPS = 5;

/** 第 2 步起点输入框的示例文案：按城市 id 给；认不出的城市（或城市还没加载）用通用文案。 */
const ORIGIN_PLACEHOLDER_BY_CITY: Readonly<Record<string, string>> = {
  beijing: "例如：良乡地铁站",
  liaoyang: "例如：白塔区中心路",
};
const DEFAULT_ORIGIN_PLACEHOLDER = "输入你的起点";

/** 契约要求的定位超时：8 秒没结果就按失败处理，提示用户手填。 */
const GEOLOCATION_TIMEOUT_MS = 8_000;

/** 定位成功时写进 profile.origin.label 的固定展示名（契约 §4）。 */
const CURRENT_LOCATION_LABEL = "当前位置";

/** 定位不可用 / 被拒 / 超时的统一人话（契约要求的原句）。 */
const GEOLOCATION_FAILURE_TEXT = "定位不可用，手动输入地址也一样";

/** geocode 接口连 reason 都没给时（例如服务端 500）的兜底人话。 */
const ORIGIN_FALLBACK_ERROR_TEXT = "这个地址暂时解析不了，换个说法或写得更具体一点试试";

/** 网络层失败（同首屏「排不出来」文案口径，不出现「出错了 / 请重试」）。 */
const SERVICE_ERROR_TEXT = "服务暂时没有响应";

/** 自定义时间没填就点确认时的提示（不是接口错误，不走 origin-error）。 */
const CUSTOM_TIME_MISSING_TEXT = "先选一个时间再确认";

const STYLE_OPTIONS: ReadonlyArray<{
  value: TravelStyle;
  title: string;
  subtitle: string;
  testId: string;
}> = [
  {
    value: "rich",
    title: "用钱换时间",
    subtitle: "打车没问题，吃好一点",
    testId: "onboarding-style-rich",
  },
  {
    value: "powerful",
    title: "用体力换钱",
    subtitle: "多走走，免费的地方也很好",
    testId: "onboarding-style-powerful",
  },
];

/** 第 3 题的固定选项：testId 后缀 = 当日分钟数，不限制用 null。 */
const HOME_BY_OPTIONS: ReadonlyArray<{ key: string; label: string; value: number | null }> = [
  { key: "null", label: "不限制", value: null },
  { key: "1080", label: "18:00", value: 1080 },
  { key: "1200", label: "20:00", value: 1200 },
  { key: "1320", label: "22:00", value: 1320 },
];

const SCENE_OPTIONS: ReadonlyArray<{
  value: TravelScene;
  title: string;
  subtitle: string;
  testId: string;
}> = [
  {
    value: "scenery",
    title: "风光",
    subtitle: "江边、公园、能看见远处的地方",
    testId: "onboarding-scene-scenery",
  },
  {
    value: "culture",
    title: "人文",
    subtitle: "老街、书店、博物馆",
    testId: "onboarding-scene-culture",
  },
  {
    value: "any",
    title: "随便走走",
    subtitle: "不挑，顺路就好",
    testId: "onboarding-scene-any",
  },
];

/** 第 5 题的固定选项：要不要安排吃饭（默认「要吃点东西」）。 */
const MEAL_OPTIONS: ReadonlyArray<{
  value: boolean;
  title: string;
  subtitle: string;
  testId: string;
}> = [
  {
    value: true,
    title: "要吃点东西",
    subtitle: "会给你留出吃饭的时间",
    testId: "onboarding-meal-yes",
  },
  {
    value: false,
    title: "不用了",
    subtitle: "只是想走走看看",
    testId: "onboarding-meal-no",
  },
];

// ---------------------------------------------------------------------------
// 样式常量：全部沿用首屏的 stone 色系 / 圆角 / 150ms 过渡，字号克制
// ---------------------------------------------------------------------------

const QUESTION_CLASS = "text-xl font-light leading-8 tracking-wide text-stone-900";
const OPTION_BASE_CLASS =
  "flex w-full flex-col rounded-2xl border px-5 py-4 text-left transition duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500";
const OPTION_ACTIVE_CLASS = "border-stone-900 bg-stone-50";
const OPTION_IDLE_CLASS = "border-stone-200 bg-white hover:bg-stone-50";
const OPTION_TITLE_CLASS = "text-base font-medium text-stone-900";
const OPTION_SUBTITLE_CLASS = "mt-1 text-xs leading-5 text-stone-500";
const PRIMARY_BUTTON_CLASS =
  "w-full rounded-2xl bg-stone-900 px-5 py-3.5 text-sm font-medium text-white transition duration-150 hover:bg-stone-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60";
const SECONDARY_BUTTON_CLASS =
  "shrink-0 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-700 transition duration-150 hover:bg-stone-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500 disabled:cursor-not-allowed disabled:opacity-50";
const INPUT_CLASS =
  "min-w-0 flex-1 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-800 placeholder:text-stone-400 transition duration-150 hover:bg-stone-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500";
const CANCEL_CLASS =
  "text-xs leading-5 text-stone-400 underline decoration-stone-300 underline-offset-4 transition duration-150 hover:text-stone-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500";
const BACK_CLASS =
  "text-xs leading-5 text-stone-500 underline decoration-stone-300 underline-offset-4 transition duration-150 hover:text-stone-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500";
const CONTINUE_CLASS =
  "rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 transition duration-150 hover:bg-stone-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500";

/** 选项按钮的完整 className：选中态只换边框 / 底色，不换字号。 */
function optionClass(active: boolean): string {
  return `${OPTION_BASE_CLASS} ${active ? OPTION_ACTIVE_CLASS : OPTION_IDLE_CLASS}`;
}

/** 「已选起点：…」卡片：定位模式放在按钮下方，手动模式下放在输入框上方。 */
function SelectedOriginCard({ label }: { label: string }) {
  return (
    <p
      data-testid="onboarding-origin-selected"
      className="rounded-2xl border border-stone-200 bg-stone-50 px-5 py-3 text-sm leading-6 text-stone-700"
    >
      {`已选起点：${label}`}
    </p>
  );
}

/** "HH:mm"（原生 time input 的值）→ 当日分钟数；空串 / 格式不对 → null。 */
function parseClockMinute(text: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

/** 当日分钟数 → "HH:mm"（第 3 题自定义时间预填用）。 */
function formatClockMinute(minute: number): string {
  const normalized = ((minute % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

export default function Onboarding({
  onComplete,
  onSkip,
  initialProfile,
  initialGeo,
  cities,
  selectedCityId,
  onCityChange,
}: OnboardingProps) {
  const [step, setStep] = useState<Step>(1);
  /**
   * 四道题的答案：没答过用 null / undefined 区分（null 本身是第 3 题「不限制」的合法答案）。
   * 本轮起用 initialProfile 预填上次的选择；initialGeo（定位结果）优先作为第 2 题起点预选。
   */
  const [style, setStyle] = useState<TravelStyle | null>(initialProfile?.style ?? null);
  const [origin, setOrigin] = useState<Origin | null>(() => {
    if (initialGeo !== undefined && initialGeo !== null) {
      return { lat: initialGeo.lat, lng: initialGeo.lng, label: CURRENT_LOCATION_LABEL };
    }
    return initialProfile === undefined ? null : { ...initialProfile.origin };
  });
  const [homeBy, setHomeBy] = useState<number | null | undefined>(initialProfile?.homeBy);
  const [scene, setScene] = useState<TravelScene | null>(initialProfile?.scene ?? null);
  /** 第 5 题：要不要安排吃饭。默认「要吃点东西」；有旧画像时预填上次的选择。 */
  const [mealIncluded, setMealIncluded] = useState<boolean>(initialProfile?.mealIncluded ?? true);

  // 第 2 步的异步状态：定位中 / 解析中 / 错误人话 / 手填文本。
  const [geoBusy, setGeoBusy] = useState(false);
  const [manualBusy, setManualBusy] = useState(false);
  const [originError, setOriginError] = useState<string | null>(null);
  const [manualAddress, setManualAddress] = useState("");

  // 第 3 步「自己选」：原生 time input 的值 + 没填就确认的提示。
  // 上次是「自定义时间」（不在固定选项里）时预填输入框。
  const [customTime, setCustomTime] = useState(() =>
    initialProfile !== undefined &&
    initialProfile.homeBy !== null &&
    !HOME_BY_OPTIONS.some((option) => option.value === initialProfile.homeBy)
      ? formatClockMinute(initialProfile.homeBy)
      : "",
  );
  const [customError, setCustomError] = useState<string | null>(null);

  /** 用户是否在本轮问答里主动选过起点（点定位 / 提交地址）：是的话异步定位结果不再覆盖。 */
  const userTouchedOriginRef = useRef(false);

  /** onComplete 只调一次（第 5 题连点 / 父组件晚一步卸载都兜得住）。 */
  const completedRef = useRef(false);
  /** 起点已经定过（第 2 步成功后进第 3 步）：防止两条异步路线都写结果。 */
  const originSettledRef = useRef(false);
  /**
   * 起点采集的「代次」：每次点定位 / 解析 / 上一步都 +1。
   * 异步回调回来时代次对不上就丢弃——用户换了另一种方式或回退了，旧结果不能抢占界面。
   */
  const originFlowRef = useRef(0);
  /** 定位超时定时器的清理函数（卸载 / 回退时清掉，避免 setState on unmounted）。 */
  const geoCleanupRef = useRef<(() => void) | null>(null);
  // busy 的同步镜像：双击发生在两次 render 之间时，ref 也能挡住第二次。
  const geoBusyRef = useRef(false);
  const manualBusyRef = useRef(false);

  /**
   * 上一次看到的城市 id：用来区分「用户在第 2 步真的切了城市」和「城市列表刚加载完知道当前城市」。
   * 只有非空 → 非空的切换才清起点（见下方 effect）。
   */
  const previousCityIdRef = useRef(selectedCityId);

  /** 当前城市条目（胶囊 / placeholder / coverage 都从这里取；找不到时兜底）。 */
  const selectedCityOption = cities.filter((option) => option.city === selectedCityId)[0] ?? null;
  const originPlaceholder = ORIGIN_PLACEHOLDER_BY_CITY[selectedCityId] ?? DEFAULT_ORIGIN_PLACEHOLDER;
  /** 空地址提示里带上当前城市的例子（通用文案时不生硬地拼「例如：输入你的起点」）。 */
  const emptyOriginHint =
    originPlaceholder.indexOf("例如：") === 0 ? `先写一个地址，${originPlaceholder}` : "先写一个地址";
  const coverageText =
    selectedCityOption !== null &&
    selectedCityOption.coverage !== undefined &&
    selectedCityOption.coverage.length > 0
      ? selectedCityOption.coverage.join(" · ")
      : null;

  /** 卸载时作废在飞的定位结果并清掉超时定时器。 */
  useEffect(() => {
    return () => {
      originFlowRef.current += 1;
      const cleanup = geoCleanupRef.current;
      geoCleanupRef.current = null;
      if (cleanup !== null) cleanup();
    };
  }, []);

  /**
   * 本轮新增：定位结果异步到达时，把它作为第 2 题起点的预选。
   * 页面在问答打开期间后台定位；结果晚到时也能预填「已选起点：当前位置」。
   * 用户已经主动点过定位 / 提交过地址时不覆盖（以用户操作为准）。
   */
  useEffect(() => {
    if (initialGeo === undefined || initialGeo === null) return;
    // 只在还没离开第 2 题时预选：用户已经点「继续」到第 3/4 题后，迟到的定位结果不能改掉已确认的起点。
    if (step > 2) return;
    if (userTouchedOriginRef.current) return;
    setOrigin((current) => {
      if (
        current !== null &&
        current.label === CURRENT_LOCATION_LABEL &&
        current.lat === initialGeo.lat &&
        current.lng === initialGeo.lng
      ) {
        return current;
      }
      return { lat: initialGeo.lat, lng: initialGeo.lng, label: CURRENT_LOCATION_LABEL };
    });
  }, [initialGeo, step]);

  /** 作废在飞的定位 / 解析（回退或卸载时用），并复位忙碌态。 */
  const cancelPendingOriginWork = useCallback(() => {
    originFlowRef.current += 1;
    originSettledRef.current = false;
    const cleanup = geoCleanupRef.current;
    geoCleanupRef.current = null;
    if (cleanup !== null) cleanup();
    geoBusyRef.current = false;
    manualBusyRef.current = false;
    setGeoBusy(false);
    setManualBusy(false);
  }, []);

  /**
   * 第 2 步里切城市 → 清掉属于旧城市的起点（本轮新增）。
   *
   * 判据是「非空 → 非空」：
   * - `"" → "beijing"`：城市列表刚加载完、组件第一次知道当前城市，这时必须保留
   *   initialProfile.origin 的预填（重置流程的「已选起点」就靠它），不能清；
   * - 非空 → 非空：用户点了另一个城市胶囊，旧城市的地址拿到新城市里 geocode 会解析到奇怪的地方，
   *   所以输入框、已选坐标、「已选起点」卡片、错误提示全部清空，在飞的解析作废。
   * 同时复位 userTouched：新城市的定位结果允许再预填起点。
   */
  useEffect(() => {
    const previousCityId = previousCityIdRef.current;
    previousCityIdRef.current = selectedCityId;
    if (previousCityId === selectedCityId) return;
    if (previousCityId === "" || selectedCityId === "") return;
    cancelPendingOriginWork();
    userTouchedOriginRef.current = false;
    setOrigin(null);
    setManualAddress("");
    setOriginError(null);
  }, [selectedCityId, cancelPendingOriginWork]);

  /**
   * 起点定下来：写 profile 用的 origin，然后自动进第 3 题。
   * flow 用来丢弃「已经被新一次操作顶掉」的迟到结果。
   */
  const settleOrigin = useCallback((flow: number, next: Origin) => {
    if (flow !== originFlowRef.current) return;
    if (originSettledRef.current) return;
    originSettledRef.current = true;
    setOrigin(next);
    setOriginError(null);
    setStep(3);
  }, []);

  /**
   * 定位当前位置。
   * - 8 秒没回调（或权限被拒 / 定位不可用）→ 显示「定位不可用，手动输入地址也一样」；
   * - 浏览器不给地理位置的超时兜底时，我们自己的 setTimeout 也会在 8 秒到点收尾；
   * - 忙碌态 + ref 双保险，连点只发一次。
   */
  const handleGeolocate = useCallback(() => {
    if (geoBusyRef.current) return;
    userTouchedOriginRef.current = true;
    if (typeof navigator === "undefined" || navigator.geolocation === undefined || navigator.geolocation === null) {
      setOriginError(GEOLOCATION_FAILURE_TEXT);
      return;
    }

    const flow = originFlowRef.current + 1;
    originFlowRef.current = flow;
    geoBusyRef.current = true;
    setGeoBusy(true);
    setOriginError(null);

    let finished = false;
    let timeoutId: number | null = null;

    /** 收尾：无论成功/失败/超时都只跑一次；代次对不上就只清状态、不碰界面结果。 */
    const finish = (apply: () => void) => {
      if (finished) return;
      finished = true;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      geoCleanupRef.current = null;
      geoBusyRef.current = false;
      setGeoBusy(false);
      if (flow !== originFlowRef.current) return;
      apply();
    };

    geoCleanupRef.current = () => {
      finished = true;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      geoCleanupRef.current = null;
      geoBusyRef.current = false;
    };

    timeoutId = window.setTimeout(() => {
      finish(() => setOriginError(GEOLOCATION_FAILURE_TEXT));
    }, GEOLOCATION_TIMEOUT_MS);

    try {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          finish(() => {
            settleOrigin(flow, {
              lat: position.coords.latitude,
              lng: position.coords.longitude,
              label: CURRENT_LOCATION_LABEL,
            });
          });
        },
        () => {
          finish(() => setOriginError(GEOLOCATION_FAILURE_TEXT));
        },
        {
          enableHighAccuracy: false,
          timeout: GEOLOCATION_TIMEOUT_MS,
          maximumAge: 30_000,
        },
      );
    } catch {
      finish(() => setOriginError(GEOLOCATION_FAILURE_TEXT));
    }
  }, [settleOrigin]);

  /**
   * 手填地址 → POST /api/geocode（页面同源，用相对路径）。
   * 契约：200 {ok:true,lng,lat,label} 成功；200/400 {ok:false,reason} 失败显示 reason。
   * 请求体带上页面当前城市 city（不传 / 空串 → 不带该字段，服务端用 ACTIVE_CITY 默认城市）：
   * 否则辽阳等非默认城市的用户手填本地地址会被拿杭州兜底解析，一直卡在第 2 题。
   * 服务端连 reason 都没给（例如 500 空 body）时用兜底人话，绝不让错误把题干撑坏。
   */
  const handleManualSubmit = useCallback(async () => {
    if (manualBusyRef.current) return;
    const address = manualAddress.trim();
    if (address.length === 0) {
      // 自动定位关闭时没有「上面的定位」可点了，提示改成只引导手填（文案随开关 / 城市变化）。
      setOriginError(GEOLOCATION_ENABLED ? "先写一个地址，或者直接用上面的定位" : emptyOriginHint);
      return;
    }
    userTouchedOriginRef.current = true;

    const flow = originFlowRef.current + 1;
    originFlowRef.current = flow;
    manualBusyRef.current = true;
    setManualBusy(true);
    setOriginError(null);

    // 请求体带上当前城市（本轮起城市由页面 state 传入）：不传的话服务端会用默认城市，
    // 从 ?city=liaoyang 进来的用户手填「辽阳大剧院」会被拿北京兜底解析、卡在第 2 步。
    // 城市列表还没加载完（空串）时不发这个字段，保持服务端默认行为。
    const requestBody: Record<string, unknown> = { address };
    const cityId = selectedCityId.trim();
    if (cityId.length > 0) requestBody.city = cityId;

    try {
      const response = await fetch("/api/geocode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      if (flow !== originFlowRef.current) return;

      let data: unknown = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      if (flow !== originFlowRef.current) return;

      const record =
        typeof data === "object" && data !== null ? (data as Record<string, unknown>) : null;
      const reason =
        record !== null && typeof record.reason === "string" && record.reason.length > 0
          ? record.reason
          : null;

      if (!response.ok) {
        // 400（参数不合法）会带 reason；5xx 空 body 只能兜底人话。
        setOriginError(reason ?? ORIGIN_FALLBACK_ERROR_TEXT);
        return;
      }
      if (record === null || record.ok !== true) {
        setOriginError(reason ?? ORIGIN_FALLBACK_ERROR_TEXT);
        return;
      }

      const lat = record.lat;
      const lng = record.lng;
      if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng)) {
        setOriginError(ORIGIN_FALLBACK_ERROR_TEXT);
        return;
      }
      const label =
        typeof record.label === "string" && record.label.length > 0 ? record.label : address;
      settleOrigin(flow, { lat, lng, label });
    } catch {
      if (flow !== originFlowRef.current) return;
      setOriginError(SERVICE_ERROR_TEXT);
    } finally {
      if (flow === originFlowRef.current) {
        manualBusyRef.current = false;
        setManualBusy(false);
      }
    }
  }, [emptyOriginHint, manualAddress, selectedCityId, settleOrigin]);

  /** 第 1 题：选走法 → 第 2 题。 */
  const handleStyleChoice = useCallback((nextStyle: TravelStyle) => {
    setStyle(nextStyle);
    setStep(2);
  }, []);

  /** 第 3 题的固定选项：选完直接第 4 题。 */
  const handleHomeByChoice = useCallback((value: number | null) => {
    setHomeBy(value);
    setCustomError(null);
    setStep(4);
  }, []);

  /** 第 3 题「自己选」：time input 的 "HH:mm" → 当日分钟数，填了才放行。 */
  const handleCustomTimeConfirm = useCallback(() => {
    const minute = parseClockMinute(customTime);
    if (minute === null) {
      setCustomError(CUSTOM_TIME_MISSING_TEXT);
      return;
    }
    setCustomError(null);
    setHomeBy(minute);
    setStep(4);
  }, [customTime]);

  /**
   * 第 4 题：记下场景偏好，进第 5 题（本轮起第 4 题不再直接完成）。
   */
  const handleSceneChoice = useCallback((nextScene: TravelScene) => {
    setScene(nextScene);
    setStep(5);
  }, []);

  /**
   * 第 5 题：选完直接完成。
   * buildProfile 只负责补 updatedAt / 过 zod；写 localStorage 与进主页由页面负责。
   */
  const handleMealChoice = useCallback(
    (nextMealIncluded: boolean) => {
      if (completedRef.current) return;
      if (style === null || origin === null || homeBy === undefined || scene === null) return;
      completedRef.current = true;
      setMealIncluded(nextMealIncluded);
      onComplete(buildProfile({ style, origin, homeBy, scene, mealIncluded: nextMealIncluded }));
    },
    [homeBy, onComplete, origin, scene, style],
  );

  /** 上一步：第 1 步没有；回退时作废在飞的定位 / 解析，旧起点仍保留可继续用。 */
  const handleBack = useCallback(() => {
    cancelPendingOriginWork();
    setOriginError(null);
    setCustomError(null);
    setStep((current) => (current > 1 ? ((current - 1) as Step) : current));
  }, [cancelPendingOriginWork]);

  /**
   * 回退到已答过的步骤时给一个「继续」（否则第 2/3 题没有纯前进的入口）：
   * - 第 2 题：起点已定 → 继续；
   * - 第 3 题：回家时间已定 → 继续。
   */
  const canContinue =
    (step === 2 && origin !== null) || (step === 3 && homeBy !== undefined);

  const handleContinue = useCallback(() => {
    // 离开第 2 题 = 用户认可当前预填起点：之后迟到的定位结果不再覆盖（避免悄悄改掉 profile.origin）。
    if (step === 2) userTouchedOriginRef.current = true;
    setStep((current) => (current < TOTAL_STEPS ? ((current + 1) as Step) : current));
  }, [step]);

  // -------------------------------------------------------------------------
  // 五步的内容（同一屏内切换：只换 <section> 里的内容，不跳路由）
  // -------------------------------------------------------------------------

  const stepOne = (
    <div className="flex flex-col gap-8">
      <h1 className={QUESTION_CLASS}>你更想怎么走？</h1>
      <div className="flex flex-col gap-3">
        {STYLE_OPTIONS.map((option) => {
          const active = style === option.value;
          return (
            <button
              key={option.value}
              type="button"
              data-testid={option.testId}
              aria-pressed={active}
              onClick={() => handleStyleChoice(option.value)}
              className={optionClass(active)}
            >
              <span className={OPTION_TITLE_CLASS}>{option.title}</span>
              <span className={OPTION_SUBTITLE_CLASS}>{option.subtitle}</span>
            </button>
          );
        })}
      </div>
    </div>
  );

  const stepTwo = (
    <div className="flex flex-col gap-8">
      <h1 className={QUESTION_CLASS}>你的起点在哪？</h1>

      {/* 第一行：城市切换。与主页下拉共用同一个 selectedCityId，组件内部不另存城市 state。 */}
      <div data-testid="onboarding-city-switch" className="flex flex-wrap items-center gap-2">
        {cities.map((option) => {
          const active = option.city === selectedCityId;
          return (
            <button
              key={option.city}
              type="button"
              data-testid={`onboarding-city-${option.city}`}
              aria-pressed={active}
              onClick={() => {
                if (!active) onCityChange(option.city);
              }}
              className={[
                "rounded-full border px-4 py-1.5 text-sm transition duration-150",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500",
                active
                  ? "border-stone-900 bg-white text-stone-900"
                  : "border-transparent bg-transparent text-stone-500 hover:text-stone-800",
              ].join(" ")}
            >
              {option.displayName}
            </button>
          );
        })}
      </div>

      {/**
       * 自动定位开关（lib/geolocation.ts 的 GEOLOCATION_ENABLED）：
       * true  = 保留原来的「定位当前位置」按钮（按钮 + 已选起点一行）；
       * false = 隐藏定位按钮，只留下面的手填地址；已选起点卡片挪到手填区上方，不留空白块。
       */}
      {GEOLOCATION_ENABLED ? (
        <div className="flex flex-col gap-3">
          <button
            type="button"
            data-testid="onboarding-geolocate"
            onClick={handleGeolocate}
            disabled={geoBusy}
            className={PRIMARY_BUTTON_CLASS}
          >
            {geoBusy ? "正在定位…" : "定位当前位置"}
          </button>
          {origin !== null ? <SelectedOriginCard label={origin.label} /> : null}
        </div>
      ) : null}
      <div
        className={`flex flex-col gap-2 ${GEOLOCATION_ENABLED ? "border-t border-stone-200 pt-7" : ""}`}
      >
        {!GEOLOCATION_ENABLED && origin !== null ? <SelectedOriginCard label={origin.label} /> : null}
        <label htmlFor="onboarding-manual-address" className="text-sm text-stone-600">
          手动输入地址
        </label>
        <div className="flex items-stretch gap-2">
          <input
            id="onboarding-manual-address"
            data-testid="onboarding-manual-input"
            type="text"
            value={manualAddress}
            onChange={(event) => setManualAddress(event.target.value)}
            placeholder={originPlaceholder}
            autoComplete="off"
            className={INPUT_CLASS}
          />
          <button
            type="button"
            data-testid="onboarding-manual-submit"
            onClick={() => {
              void handleManualSubmit();
            }}
            disabled={manualBusy}
            className={SECONDARY_BUTTON_CLASS}
          >
            {manualBusy ? "解析中…" : "解析地址"}
          </button>
        </div>
        {originError !== null ? (
          <p data-testid="onboarding-origin-error" role="alert" className="text-xs leading-6 text-stone-600">
            {originError}
          </p>
        ) : null}
        {/* 第三行：coverage 灰字（手写字段，跟着城市走）。城市没配 coverage 就整行不渲染。 */}
        {coverageText !== null ? (
          <p data-testid="onboarding-coverage" className="text-xs leading-6 text-stone-500">
            {`现在能规划：${coverageText}`}
          </p>
        ) : null}
      </div>
    </div>
  );

  const stepThree = (
    <div className="flex flex-col gap-8">
      <h1 className={QUESTION_CLASS}>几点想回家？</h1>
      <div className="flex flex-col gap-3">
        {HOME_BY_OPTIONS.map((option) => {
          const active = homeBy === option.value;
          return (
            <button
              key={option.key}
              type="button"
              data-testid={`onboarding-homeby-${option.key}`}
              aria-pressed={active}
              onClick={() => handleHomeByChoice(option.value)}
              className={optionClass(active)}
            >
              <span className={OPTION_TITLE_CLASS}>{option.label}</span>
            </button>
          );
        })}
        <div className="rounded-2xl border border-stone-200 px-5 py-4">
          <label htmlFor="onboarding-homeby-time" className="text-sm text-stone-600">
            自己选
          </label>
          <div className="mt-2 flex items-stretch gap-2">
            <input
              id="onboarding-homeby-time"
              data-testid="onboarding-homeby-custom"
              type="time"
              value={customTime}
              onChange={(event) => {
                setCustomTime(event.target.value);
                setCustomError(null);
              }}
              className={INPUT_CLASS}
            />
            <button
              type="button"
              data-testid="onboarding-homeby-custom-confirm"
              onClick={handleCustomTimeConfirm}
              className={SECONDARY_BUTTON_CLASS}
            >
              确认
            </button>
          </div>
          {customError !== null ? (
            <p className="mt-2 text-xs leading-5 text-stone-500">{customError}</p>
          ) : null}
        </div>
      </div>
    </div>
  );

  const stepFour = (
    <div className="flex flex-col gap-8">
      <h1 className={QUESTION_CLASS}>今天想看什么？</h1>
      <div className="flex flex-col gap-3">
        {SCENE_OPTIONS.map((option) => {
          const active = scene === option.value;
          return (
            <button
              key={option.value}
              type="button"
              data-testid={option.testId}
              aria-pressed={active}
              onClick={() => handleSceneChoice(option.value)}
              className={optionClass(active)}
            >
              <span className={OPTION_TITLE_CLASS}>{option.title}</span>
              <span className={OPTION_SUBTITLE_CLASS}>{option.subtitle}</span>
            </button>
          );
        })}
      </div>
    </div>
  );

  const stepFive = (
    <div className="flex flex-col gap-8">
      <h1 className={QUESTION_CLASS}>这一趟要安排吃饭吗？</h1>
      <div className="flex flex-col gap-3">
        {MEAL_OPTIONS.map((option) => {
          const active = mealIncluded === option.value;
          return (
            <button
              key={String(option.value)}
              type="button"
              data-testid={option.testId}
              aria-pressed={active}
              onClick={() => handleMealChoice(option.value)}
              className={optionClass(active)}
            >
              <span className={OPTION_TITLE_CLASS}>{option.title}</span>
              <span className={OPTION_SUBTITLE_CLASS}>{option.subtitle}</span>
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div data-testid="onboarding" className="flex min-h-screen w-full flex-col bg-white text-stone-900">
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col px-5 pb-10 pt-8">
        {/* 顶部：左侧字标（与启动页同一套风格）；有旧画像时右上角出现「跳过」 */}
        <header className="flex min-h-6 items-center justify-between">
          <p className="text-xs tracking-[0.3em] text-stone-400">说走就走</p>
          {onSkip !== undefined ? (
            <button
              type="button"
              data-testid="onboarding-skip"
              onClick={() => {
                onSkip();
              }}
              className={CANCEL_CLASS}
            >
              跳过
            </button>
          ) : null}
        </header>

        {/* 题干 + 选项：垂直居中；data-step 跟着当前题号走 */}
        <section
          data-testid="onboarding-step"
          data-step={step}
          className="flex flex-1 flex-col justify-center py-10"
        >
          {step === 1 ? stepOne : null}
          {step === 2 ? stepTwo : null}
          {step === 3 ? stepThree : null}
          {step === 4 ? stepFour : null}
          {step === 5 ? stepFive : null}
        </section>

        {/* 底部：上一步 / 继续，再下面就是进度点（当前步高亮） */}
        <footer className="mt-10 flex flex-col gap-5">
          <div className="flex min-h-6 items-center justify-between">
            {step > 1 ? (
              <button type="button" data-testid="onboarding-back" onClick={handleBack} className={BACK_CLASS}>
                上一步
              </button>
            ) : (
              <span aria-hidden="true" />
            )}
            {canContinue ? (
              <button type="button" data-testid="onboarding-continue" onClick={handleContinue} className={CONTINUE_CLASS}>
                继续
              </button>
            ) : (
              <span aria-hidden="true" />
            )}
          </div>
          <div
            data-testid="onboarding-progress"
            role="progressbar"
            aria-label={`第 ${step} 步，共 ${TOTAL_STEPS} 步`}
            aria-valuemin={1}
            aria-valuemax={TOTAL_STEPS}
            aria-valuenow={step}
            className="flex items-center justify-center gap-1.5 pb-1"
          >
            {Array.from({ length: TOTAL_STEPS }, (_, index) => {
              const number = (index + 1) as Step;
              return (
                <span
                  key={number}
                  aria-hidden="true"
                  className={`h-1.5 w-1.5 rounded-full transition-colors duration-150 ${
                    number === step ? "bg-stone-900" : "bg-stone-300"
                  }`}
                />
              );
            })}
          </div>
        </footer>
      </div>
    </div>
  );
}
