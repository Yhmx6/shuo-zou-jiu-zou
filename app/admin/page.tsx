"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import AdminPlacesMap from "@/components/AdminPlacesMap";
import type { Place, PlaceCategory } from "@/types/schema";

/**
 * 本地开发用的管理后台（不是用户功能，不做鉴权）。
 *
 * 两个分区，顶部 tab 切换：
 * - 地点：看地点、筛选地点、改地点（含重要性星级），以及增删改 / 地址解析弹窗；
 * - 活动：本地活动 / 演出的增删改（只展示，不参与排程）。
 *
 * 所有校验以服务端 zod 为准，前端只拦必填项，其余错误原样展示服务端返回的 reason / errors。
 * 数据来源：GET /api/cities + /api/admin/places + /api/admin/events。
 * 接口契约见 app/api/admin/* /route.ts，本文件不读取任何服务端模块。
 */

/** 列表接口在 Place 基础上额外返回的两个后台字段。 */
type AdminPlace = Place & {
  /** 是否已隐藏（hidden 行灰显） */
  hidden: boolean;
  /** main = 自动采集层；manual = 手工维护层 */
  origin: "main" | "manual";
};

/** 活动状态：服务端按真实「现在」算好，前端只做中文映射，不做任何时间比较。 */
type AdminEventStatus = "upcoming" | "ongoing" | "ended";

/** /api/admin/events 列表项（placeName 与 status 都是服务端补的展示字段）。 */
type AdminEvent = {
  id: string;
  placeId: string;
  /** 地点被删 / 隐藏后仍保留旧活动，此时是占位文案 */
  placeName: string;
  title: string;
  /** 本地时间 "YYYY-MM-DDTHH:mm"（不带时区）；直接展示 / 回填，不换算 */
  startAt: string;
  endAt: string;
  note: string | null;
  status: AdminEventStatus;
};

const EVENT_STATUS_LABELS: Record<AdminEventStatus, string> = {
  upcoming: "未开始",
  ongoing: "进行中",
  ended: "已结束",
};

type CityOption = {
  city: string;
  displayName: string;
};

/** 服务端逐字段报错：errors?: [{ path, message }] */
type ApiFieldError = {
  path: string;
  message: string;
};

/** 接口返回的统一信封（宽松类型：成功/失败共用，按 ok 分支处理）。 */
type ApiEnvelope = {
  ok?: boolean;
  reason?: string;
  errors?: ApiFieldError[];
  activeCity?: string;
  cities?: CityOption[];
  city?: string;
  displayName?: string;
  total?: number;
  places?: AdminPlace[];
  place?: AdminPlace;
  events?: AdminEvent[];
  event?: AdminEvent;
  lng?: number;
  lat?: number;
  deleted?: string;
  origin?: string;
};

/** 星级筛选下拉项：不用 checkbox，改成一个原生 <select> 承载服务端三种过滤口径。 */
type ImportanceFilterValue = "" | "5" | "4" | "unrated";

/**
 * 批量打星进度（POST /api/admin/rate-places 的 SSE 流事件在前端累积成这个形状）。
 * 只做展示，不写回数据；真正的结果以脚本 done 事件 + 重新拉列表为准。
 */
type RateProgressState = {
  phase: "running" | "done" | "error";
  /** progress 事件：已完成 / 总数 */
  done: number;
  total: number;
  /** 规则命中 / LLM 打星的条数（progress 事件带） */
  rule: number;
  llm: number;
  /** done 事件汇总：实际写入 / 跳过 / 打完后的未标注数 / 各星级条数 */
  rated: number;
  skipped: number;
  unrated: number;
  byStar: Record<string, number>;
  /** error 事件或网络错误的原因 */
  message: string;
};

/** 从 JSON 对象里安全读 number（SSE 事件字段可能缺，缺了就用兜底值）。 */
function numberOf(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 读 done 事件里的 byStar 汇总：{ "1": 52, "5": 12 } → 只保留数字值。 */
function readByStar(value: unknown): Record<string, number> {
  if (value === null || typeof value !== "object") return {};
  const result: Record<string, number> = {};
  for (const [key, count] of Object.entries(value as Record<string, unknown>)) {
    if (typeof count === "number" && Number.isFinite(count)) result[key] = count;
  }
  return result;
}

/**
 * 解析一帧 SSE（帧之间用空行分隔，已由读流逻辑切好）：
 * 只取 data: 行拼成 JSON；`: ping` 这类注释帧没有 data 行，返回 null。
 */
function parseSseFrame(frame: string): Record<string, unknown> | null {
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  try {
    const value: unknown = JSON.parse(dataLines.join("\n"));
    if (value !== null && typeof value === "object") return value as Record<string, unknown>;
  } catch {
    // 半帧 / 非 JSON 数据：忽略这一帧，不影响后续 progress
  }
  return null;
}

/** 各星级条数 → 中文摘要（按星级升序，例如「1 星 52 个，5 星 12 个」）。 */
function formatByStar(byStar: Record<string, number>): string {
  return Object.entries(byStar)
    .filter(([, count]) => count > 0)
    .sort((left, right) => Number(left[0]) - Number(right[0]))
    .map(([star, count]) => `${star} 星 ${count} 个`)
    .join("，");
}

const CATEGORY_LABELS: Record<PlaceCategory, string> = {
  bookstore: "书店",
  museum: "博物馆",
  gallery: "美术馆",
  theater: "剧场",
  market: "市集",
  park: "公园",
  mall: "商场",
  restaurant: "餐厅",
  cafe: "咖啡厅",
  other: "其他",
};

const CATEGORY_OPTIONS = (Object.keys(CATEGORY_LABELS) as PlaceCategory[]).map((value) => ({
  value,
  label: CATEGORY_LABELS[value],
}));

/** 闭馆日：数据里 0 = 周日、1 = 周一 … 6 = 周六；界面上按周一到周日排列。 */
const CLOSED_DAY_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 1, label: "周一" },
  { value: 2, label: "周二" },
  { value: 3, label: "周三" },
  { value: 4, label: "周四" },
  { value: 5, label: "周五" },
  { value: 6, label: "周六" },
  { value: 0, label: "周日" },
];

const HH_MM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
/** closeTime 额外允许 "24:00"（数据契约里的「营业到当天结束」，杭州 58 条公园/书房在用）。 */
const CLOSE_TIME_PATTERN = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;

/** 地图点 marker → 列表行联动时，行背景高亮闪一下的时长（ms）。 */
const ROW_HIGHLIGHT_MS = 1400;

function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category as PlaceCategory] ?? category;
}

function formatRating(rating: number | null | undefined): string {
  if (typeof rating !== "number") return "—";
  return Number.isInteger(rating) ? String(rating) : String(Math.round(rating * 10) / 10);
}

function formatAvgCost(avgCost: number | null | undefined): string {
  if (typeof avgCost !== "number") return "—";
  return `${Math.round(avgCost * 100) / 100} 元`;
}

function formatOpenTime(place: AdminPlace): string {
  if (!place.openTime && !place.closeTime) return "—";
  return `${place.openTime ?? "?"}–${place.closeTime ?? "?"}`;
}

/**
 * 列表数据里允许出现 "24:00"（营业到当天结束）。这里用文本输入框，原样保留 24:00，
 * 不把它改写成 00:00——虽然 constraints.parseClockMinute 判定等价，但后台不该悄悄改数据。
 */
function normalizeTimeForInput(value: string | null | undefined): string {
  if (typeof value !== "string" || value === "") return "";
  if (HH_MM_PATTERN.test(value) || CLOSE_TIME_PATTERN.test(value)) return value;
  return "";
}

/** 坐标展示：最多 6 位小数，去掉浮点尾巴。 */
function formatCoordinate(value: number): string {
  return String(Number(value.toFixed(6)));
}

/** 星值：数据里没有 importance 按 0 星（未标星），不要当 0 星展示成「零分」。 */
function importanceOf(place: AdminPlace): number {
  return typeof place.importance === "number" ? place.importance : 0;
}

/**
 * 重要性星星（1–5 星，只展示，不参与排程）。
 *
 * 五颗星都可点：点第 k 颗 = 设为 k 星。实心 = 已标星，描边 = 未到；
 * 未标星时五颗全描边。每颗星包一个 button 是为了键盘操作和 aria-label，
 * SVG 的 fill/stroke 已经表达了状态（不靠颜色单独传达），故 svg 本身标记 aria-hidden。
 */
function ImportanceStars({
  place,
  disabled,
  onRate,
}: {
  place: AdminPlace;
  disabled: boolean;
  onRate: (importance: number) => void;
}) {
  const current = importanceOf(place);
  return (
    <span className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((star) => {
        const filled = star <= current;
        return (
          <button
            key={star}
            type="button"
            onClick={() => onRate(star)}
            disabled={disabled}
            aria-label={`设为 ${star} 星`}
            title={`设为 ${star} 星`}
            className="rounded p-0.5 hover:bg-stone-100 disabled:opacity-50"
          >
            <svg
              viewBox="0 0 20 20"
              aria-hidden="true"
              focusable="false"
              className={`h-4 w-4 ${filled ? "text-amber-500" : "text-stone-500"}`}
              fill={filled ? "currentColor" : "none"}
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinejoin="round"
            >
              <path d="M10 1.8l2.52 5.1 5.63.82-4.07 3.97.96 5.61L10 14.65l-5.04 2.65.96-5.61L1.85 7.72l5.63-.82L10 1.8z" />
            </svg>
          </button>
        );
      })}
    </span>
  );
}

/** 读 JSON 响应；不是 JSON（例如路由还没实现时的 404 HTML）则回退成通用错误。 */
async function parseJson(response: Response): Promise<ApiEnvelope> {
  try {
    const data: unknown = await response.json();
    if (data !== null && typeof data === "object") return data as ApiEnvelope;
  } catch {
    // 落到下面的统一错误
  }
  return { ok: false, reason: `请求失败（HTTP ${response.status}）` };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function AdminPage() {
  /** 顶部分区：地点（默认）/ 活动。两个分区各自维护自己的列表、筛选与弹窗状态。 */
  const [tab, setTab] = useState<"places" | "events">("places");
  const [cities, setCities] = useState<CityOption[]>([]);
  const [city, setCity] = useState("");
  const [citiesError, setCitiesError] = useState("");

  const [places, setPlaces] = useState<AdminPlace[]>([]);
  const [total, setTotal] = useState(0);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState("");

  const [category, setCategory] = useState("");
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [includeHidden, setIncludeHidden] = useState(false);
  /** 星级筛选：请求分别不带 / minImportance=5 / minImportance=4 / unrated=1，过滤在服务端做。 */
  const [importanceFilter, setImportanceFilter] = useState<ImportanceFilterValue>("");
  /** 批量打星进度（null = 还没跑过）；进度来自 POST /api/admin/rate-places 的 SSE 流。 */
  const [rateProgress, setRateProgress] = useState<RateProgressState | null>(null);

  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<AdminPlace | null>(null);

  /** 地图 ↔ 列表联动：列表点行 → 地图对应点放大 + 居中；地图点 marker → 列表滚到该行并高亮。 */
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null);
  const [highlightPlaceId, setHighlightPlaceId] = useState<string | null>(null);
  /** 列表行 DOM 引用（按 place.id 存），点地图 marker 时 scrollIntoView({ block: "center" }) 用。 */
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  /** 行高亮闪一下的定时器：连续点不同行 / 卸载时要清掉，避免往卸载后的组件 setState。 */
  const highlightTimerRef = useRef<number | null>(null);

  /** 列表请求序号：筛选条件连续变化时只采纳最后一次请求的结果。 */
  const listSeqRef = useRef(0);
  /** 批量打星的 AbortController：切城市 / 卸载时 abort，服务端收到断开会 kill 脚本。 */
  const rateAbortRef = useRef<AbortController | null>(null);

  // 城市列表：默认选中服务端的 activeCity。
  useEffect(() => {
    let cancelled = false;
    const loadCities = async () => {
      try {
        const response = await fetch("/api/cities", { cache: "no-store" });
        const json = await parseJson(response);
        // 先落到 const：下面 setCity 的回调是闭包，闭包里读 json.cities 拿不到 Array.isArray 的收窄。
        const cityList = json.cities;
        if (!json.ok || !Array.isArray(cityList)) {
          if (!cancelled) setCitiesError(json.reason ?? "读取城市列表失败");
          return;
        }
        if (cancelled) return;
        setCities(cityList);
        const activeCity = typeof json.activeCity === "string" ? json.activeCity : "";
        setCity((previous) => previous || activeCity || cityList[0]?.city || "");
      } catch (error) {
        if (!cancelled) setCitiesError(errorText(error));
      }
    };
    loadCities();
    return () => {
      cancelled = true;
    };
  }, []);

  // 搜索框防抖：停下来 300ms 再请求，避免每敲一个字都打一次接口。
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(timer);
  }, [q]);

  // 列表：城市 / 类目 / 搜索词 / 显示已隐藏 / 星级筛选 任一变化都重新拉取（含新增、编辑、删除后的刷新）。
  useEffect(() => {
    if (city === "") return;
    const seq = listSeqRef.current + 1;
    listSeqRef.current = seq;

    const params = new URLSearchParams();
    params.set("city", city);
    if (category !== "") params.set("category", category);
    if (debouncedQ.trim() !== "") params.set("q", debouncedQ.trim());
    if (includeHidden) params.set("includeHidden", "1");
    // 星级筛选统一走服务端过滤：全部 = 不带参数。
    if (importanceFilter === "5") params.set("minImportance", "5");
    if (importanceFilter === "4") params.set("minImportance", "4");
    if (importanceFilter === "unrated") params.set("unrated", "1");

    const loadPlaces = async () => {
      setListLoading(true);
      setListError("");
      try {
        const response = await fetch(`/api/admin/places?${params.toString()}`, { cache: "no-store" });
        const json = await parseJson(response);
        if (listSeqRef.current !== seq) return;
        if (!json.ok || !Array.isArray(json.places)) {
          setPlaces([]);
          setTotal(0);
          setListError(json.reason ?? "读取地点列表失败");
          return;
        }
        setPlaces(json.places);
        setTotal(typeof json.total === "number" ? json.total : json.places.length);
      } catch (error) {
        if (listSeqRef.current !== seq) return;
        setPlaces([]);
        setTotal(0);
        setListError(errorText(error));
      } finally {
        if (listSeqRef.current === seq) setListLoading(false);
      }
    };
    loadPlaces();
  }, [city, category, debouncedQ, includeHidden, importanceFilter, refreshTick]);

  const reloadList = () => setRefreshTick((tick) => tick + 1);

  // 切城市：上一轮的选中 / 高亮不属于新城市，清掉（地图会按新城市的数据重画）。
  useEffect(() => {
    setSelectedPlaceId(null);
    setHighlightPlaceId(null);
  }, [city]);

  // 卸载时清掉高亮定时器。
  useEffect(() => {
    return () => {
      if (highlightTimerRef.current !== null) {
        window.clearTimeout(highlightTimerRef.current);
        highlightTimerRef.current = null;
      }
    };
  }, []);

  /**
   * 地图上点了某个点：列表滚到对应行（block: "center"）并让行背景闪一下。
   * 按任务书口径，点 marker 只联动列表，不改变「哪一行被放大」的选中态。
   */
  const handleMapSelectPlace = (placeId: string) => {
    setHighlightPlaceId(placeId);
    const row = rowRefs.current.get(placeId);
    if (row !== undefined) row.scrollIntoView({ block: "center", behavior: "auto" });
    if (highlightTimerRef.current !== null) window.clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = window.setTimeout(() => {
      highlightTimerRef.current = null;
      setHighlightPlaceId(null);
    }, ROW_HIGHLIGHT_MS);
  };

  /** 列表行点击：选中该点（地图放大 + 居中）。点在行内按钮 / 输入框上时不算选行。 */
  const handleRowSelectPlace = (placeId: string, target: EventTarget | null) => {
    if (target instanceof Element && target.closest("button, a, input, select, textarea, label") !== null) return;
    setSelectedPlaceId(placeId);
  };

  const openCreate = () => {
    setEditing(null);
    setModalOpen(true);
  };

  const openEdit = (place: AdminPlace) => {
    setEditing(place);
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setEditing(null);
  };

  const handleSaved = (message: string) => {
    setModalOpen(false);
    setEditing(null);
    setNotice({ kind: "success", text: message });
    reloadList();
  };

  /** 手工来源：真删；自动来源：隐藏（服务端 DELETE 会根据来源层自行决定）。 */
  const handleRemove = async (place: AdminPlace) => {
    const isManual = place.origin === "manual";
    const confirmText = isManual
      ? `确定删除「${place.name}」吗？手工地点删除后不可恢复。`
      : `确定隐藏「${place.name}」吗？隐藏后仍可在「显示已隐藏」里看到并恢复。`;
    if (!window.confirm(confirmText)) return;

    setActionBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/places", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ city, id: place.id }),
      });
      const json = await parseJson(response);
      if (!json.ok) {
        setNotice({ kind: "error", text: json.reason ?? "操作失败" });
        return;
      }
      setNotice({
        kind: "success",
        text: json.deleted === "manual" ? `已删除「${place.name}」` : `已隐藏「${place.name}」`,
      });
      reloadList();
    } catch (error) {
      setNotice({ kind: "error", text: errorText(error) });
    } finally {
      setActionBusy(false);
    }
  };

  /** 恢复隐藏地点：PATCH { hidden: false }。 */
  const handleRestore = async (place: AdminPlace) => {
    setActionBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/places", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ city, id: place.id, patch: { hidden: false } }),
      });
      const json = await parseJson(response);
      if (!json.ok) {
        setNotice({ kind: "error", text: json.reason ?? "恢复失败" });
        return;
      }
      setNotice({ kind: "success", text: `已恢复「${place.name}」` });
      reloadList();
    } catch (error) {
      setNotice({ kind: "error", text: errorText(error) });
    } finally {
      setActionBusy(false);
    }
  };

  /**
   * 点星星设重要性：PATCH 之后统一重拉列表，而不是在本地改数组。
   * 列表顺序 / 星级过滤都由服务端算，前端再排一次会出现两套口径。
   */
  const handleRate = async (place: AdminPlace, importance: number) => {
    setActionBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/places", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ city, id: place.id, patch: { importance } }),
      });
      const json = await parseJson(response);
      if (!json.ok) {
        setNotice({ kind: "error", text: json.reason ?? "设置重要性失败" });
        return;
      }
      setNotice({ kind: "success", text: `已将「${place.name}」设为 ${importance} 星` });
      reloadList();
    } catch (error) {
      setNotice({ kind: "error", text: errorText(error) });
    } finally {
      setActionBusy(false);
    }
  };

  const rateRunning = rateProgress !== null && rateProgress.phase === "running";

  /**
   * 批量打星（未标注的）：POST /api/admin/rate-places，逐帧读 SSE 更新进度。
   *
   * 进度来自脚本 stdout 的 NDJSON（路由原样转发），不是前端假动画：
   * - start   → total
   * - progress→ done / total / rule / llm（「正在打星：45/141（规则 30，LLM 15）」）
   * - done    → rated / skipped / unrated / byStar（汇总 + 重拉列表）
   * - error   → message（失败原因）
   */
  const handleRateAllUnrated = async () => {
    if (city === "" || rateRunning) return;
    const controller = new AbortController();
    rateAbortRef.current = controller;

    setNotice(null);
    setRateProgress({
      phase: "running",
      done: 0,
      total: 0,
      rule: 0,
      llm: 0,
      rated: 0,
      skipped: 0,
      unrated: 0,
      byStar: {},
      message: "",
    });

    /** done / error 只保留最后一次（脚本正常各发一次；异常路径可能重复，以后到的为准）。 */
    let doneEvent: Record<string, unknown> | null = null;
    let errorMessage = "";

    const applyFrame = (frame: string) => {
      const event = parseSseFrame(frame);
      if (event === null) return;
      const type = typeof event.type === "string" ? event.type : "";
      if (type === "start") {
        const total = numberOf(event.total, 0);
        setRateProgress((previous) => (previous === null ? previous : { ...previous, total }));
        return;
      }
      if (type === "progress") {
        setRateProgress((previous) => {
          if (previous === null) return previous;
          return {
            ...previous,
            done: numberOf(event.done, previous.done),
            total: numberOf(event.total, previous.total),
            rule: numberOf(event.rule, previous.rule),
            llm: numberOf(event.llm, previous.llm),
          };
        });
        return;
      }
      if (type === "done") {
        doneEvent = event;
        return;
      }
      if (type === "error") {
        errorMessage = typeof event.message === "string" ? event.message : "打星失败（脚本没有给出原因）";
      }
      // 其它类型（log / 未知）：忽略，不影响进度。
    };

    try {
      const response = await fetch("/api/admin/rate-places", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ city, onlyUnrated: true }),
        signal: controller.signal,
      });
      if (!response.ok) {
        // 400 / 500 走 JSON 错误信封（参数错、脚本还没交付等），不会进入事件流。
        const json = await parseJson(response);
        const message = json.reason ?? `请求失败（HTTP ${response.status}）`;
        setRateProgress({ phase: "error", done: 0, total: 0, rule: 0, llm: 0, rated: 0, skipped: 0, unrated: 0, byStar: {}, message });
        setNotice({ kind: "error", text: `批量打星失败：${message}` });
        return;
      }
      if (response.body === null) throw new Error("响应没有可读的流");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let separator = buffer.indexOf("\n\n");
        while (separator !== -1) {
          applyFrame(buffer.slice(0, separator));
          buffer = buffer.slice(separator + 2);
          separator = buffer.indexOf("\n\n");
        }
      }
      if (buffer.trim() !== "") applyFrame(buffer);

      // 流结束：以脚本的 done / error 事件为准，不看 HTTP 状态（200 也可能脚本内部失败）。
      if (doneEvent !== null) {
        const summary: Record<string, unknown> = doneEvent;
        const total = numberOf(summary.total, 0);
        const rated = numberOf(summary.rated, 0);
        const skipped = numberOf(summary.skipped, 0);
        const unrated = numberOf(summary.unrated, 0);
        const byStar = readByStar(summary.byStar);
        setRateProgress({ phase: "done", done: total, total, rule: 0, llm: 0, rated, skipped, unrated, byStar, message: "" });
        setNotice({
          kind: "success",
          text: `批量打星完成：共 ${total} 个地点，已写 ${rated} 个${skipped > 0 ? `，跳过 ${skipped} 个` : ""}`,
        });
        reloadList();
        return;
      }
      const message = errorMessage === "" ? "打星流提前结束，未收到完成事件" : errorMessage;
      setRateProgress({ phase: "error", done: 0, total: 0, rule: 0, llm: 0, rated: 0, skipped: 0, unrated: 0, byStar: {}, message });
      setNotice({ kind: "error", text: `批量打星失败：${message}` });
    } catch (error) {
      // 主动 abort（切城市 / 卸载）不算失败：服务端已经 kill 脚本，这里安静退出。
      if (controller.signal.aborted) return;
      const message = errorText(error);
      setRateProgress({ phase: "error", done: 0, total: 0, rule: 0, llm: 0, rated: 0, skipped: 0, unrated: 0, byStar: {}, message });
      setNotice({ kind: "error", text: `批量打星失败：${message}` });
    } finally {
      if (rateAbortRef.current === controller) rateAbortRef.current = null;
    }
  };

  // 城市切换：终止上一个城市正在跑的批量打星（服务端收到断开会 kill 脚本），并清掉进度。
  // 组件卸载时同样会 abort（清理函数在依赖变化和卸载时都会执行）。
  useEffect(() => {
    setRateProgress(null);
    return () => {
      const controller = rateAbortRef.current;
      rateAbortRef.current = null;
      if (controller !== null) controller.abort();
    };
  }, [city]);

  /** done 阶段的各星级摘要（空对象时为空串）。 */
  const rateByStarSummary = rateProgress === null ? "" : formatByStar(rateProgress.byStar);

  return (
    <main className="mx-auto max-w-6xl bg-white px-4 py-6 pb-16 text-stone-800 lg:max-w-[1400px]">
      {/* 这个横幅是「本地后台」的显式提醒，首屏 HTML 里必须能看到这句话。 */}
      <div className="mb-5 rounded border-2 border-red-500 bg-red-50 px-4 py-3 text-center text-base font-bold text-red-600">
        本地后台，请勿公开部署
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-4">
          <h1 className="text-lg font-bold">本地控制台</h1>
          <label className="flex items-center gap-2 text-sm">
            城市
            <select
              data-testid="city-filter"
              value={city}
              onChange={(event) => setCity(event.target.value)}
              className="rounded border border-stone-300 bg-white px-2 py-1 text-stone-800 placeholder:text-stone-500"
            >
              {cities.length === 0 && <option value="">（读取中）</option>}
              {cities.map((option) => (
                <option key={option.city} value={option.city}>
                  {option.displayName}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {/* 分区 tab：地点默认；活动只做展示，不参与排程。 */}
          <div
            role="tablist"
            aria-label="后台分区"
            className="flex items-center gap-1 rounded border border-stone-200 bg-stone-50 p-1"
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab === "places"}
              onClick={() => setTab("places")}
              className={`rounded px-3 py-1 text-sm ${
                tab === "places" ? "bg-white font-medium text-stone-800 shadow-sm" : "text-stone-500 hover:text-stone-800"
              }`}
            >
              地点
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "events"}
              onClick={() => setTab("events")}
              className={`rounded px-3 py-1 text-sm ${
                tab === "events" ? "bg-white font-medium text-stone-800 shadow-sm" : "text-stone-500 hover:text-stone-800"
              }`}
            >
              活动
            </button>
          </div>
          {/* 文案 prompt 控制台入口：沿用未选中 tab 的文字样式，放在 tab 组外面（不参与 tab 语义）。 */}
          <a href="/admin/prompt" className="rounded px-3 py-1 text-sm text-stone-500 hover:text-stone-800">
            文案
          </a>
          {tab === "places" && (
            <button
              type="button"
              onClick={openCreate}
              disabled={city === ""}
              className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
            >
              新增地点
            </button>
          )}
        </div>
      </div>

      {citiesError !== "" && <p className="mb-3 text-sm text-red-600">{citiesError}</p>}

      {/* 地点分区一直挂载，切到活动再切回来时筛选条件 / 列表状态不丢，只是不展示。 */}
      <div className={tab === "places" ? "" : "hidden"}>

      <div className="mb-3 flex flex-wrap items-center gap-5 rounded border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-800">
        <label className="flex items-center gap-2">
          类目
          <select
            data-testid="category-filter"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            className="rounded border border-stone-300 bg-white px-2 py-1 text-stone-800 placeholder:text-stone-500"
          >
            <option value="">全部</option>
            {CATEGORY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          名称
          <input
            data-testid="name-search"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="按名称模糊搜索"
            className="w-48 rounded border border-stone-300 bg-white px-2 py-1 text-stone-800 placeholder:text-stone-500"
          />
        </label>
        <label className="flex items-center gap-2">
          <input
            data-testid="include-hidden"
            type="checkbox"
            checked={includeHidden}
            onChange={(event) => setIncludeHidden(event.target.checked)}
          />
          显示已隐藏
        </label>
        <label className="flex items-center gap-2">
          星级
          <select
            data-testid="importance-filter"
            value={importanceFilter}
            onChange={(event) => setImportanceFilter(event.target.value as ImportanceFilterValue)}
            className="rounded border border-stone-300 bg-white px-2 py-1 text-stone-800"
          >
            <option value="">全部</option>
            <option value="5">5 星</option>
            <option value="4">4 星以上</option>
            <option value="unrated">未标注</option>
          </select>
        </label>
        <button
          type="button"
          data-testid="rate-all-unrated"
          onClick={() => void handleRateAllUnrated()}
          disabled={city === "" || rateRunning || actionBusy}
          className="rounded border border-stone-300 bg-white px-3 py-1 text-sm text-stone-800 hover:bg-stone-100 disabled:opacity-50"
        >
          {rateRunning ? "正在打星…" : "批量打星（未标注的）"}
        </button>
        <span className="text-stone-500">共 {total} 个地点</span>
        {listLoading && <span className="text-stone-500">加载中…</span>}
      </div>

      {rateProgress !== null && (
        <div
          data-testid="rate-progress"
          data-phase={rateProgress.phase}
          className={`mb-3 rounded border px-3 py-2 text-sm ${
            rateProgress.phase === "error"
              ? "border-red-300 bg-red-50 text-red-600"
              : rateProgress.phase === "done"
                ? "border-green-300 bg-green-50 text-green-700"
                : "border-stone-200 bg-stone-50 text-stone-800"
          }`}
        >
          {rateProgress.phase === "running" && rateProgress.total === 0 && <p>正在启动打星脚本…</p>}
          {rateProgress.phase === "running" && rateProgress.total > 0 && (
            <p>
              正在打星：{rateProgress.done}/{rateProgress.total}（规则 {rateProgress.rule}，LLM {rateProgress.llm}）
            </p>
          )}
          {rateProgress.phase === "running" && rateProgress.total > 0 && (
            <div
              className="mt-1.5 h-1.5 w-full overflow-hidden rounded bg-stone-200"
              role="progressbar"
              aria-label="批量打星进度"
              aria-valuemin={0}
              aria-valuemax={rateProgress.total}
              aria-valuenow={rateProgress.done}
            >
              <div
                className="h-full bg-stone-500 transition-all"
                style={{ width: `${Math.min(100, Math.round((rateProgress.done / rateProgress.total) * 100))}%` }}
              />
            </div>
          )}
          {rateProgress.phase === "done" && (
            <p>
              打星完成：共 {rateProgress.total} 个未标注地点，已写 {rateProgress.rated} 个
              {rateProgress.skipped > 0 ? `，跳过 ${rateProgress.skipped} 个` : ""}
              {rateByStarSummary === "" ? "" : `（${rateByStarSummary}）`}
              {rateProgress.unrated > 0 ? `；仍有 ${rateProgress.unrated} 个未标注` : ""}
            </p>
          )}
          {rateProgress.phase === "error" && <p>打星失败：{rateProgress.message}</p>}
        </div>
      )}

      {notice !== null && (
        <p
          className={`mb-3 rounded border px-3 py-2 text-sm ${
            notice.kind === "success"
              ? "border-green-300 bg-green-50 text-green-700"
              : "border-red-300 bg-red-50 text-red-600"
          }`}
        >
          {notice.text}
        </p>
      )}

      {listError !== "" && <p className="mb-3 text-sm text-red-600">{listError}</p>}

      {/* 列表 60% / 地图 40%：窄屏地图在上（320px）、列表在下；桌面左右分栏，地图 sticky 跟随滚动。
          DOM 顺序是「地图在前、列表在后」（窄屏要求），桌面用 col-start 显式换到右侧。 */}
      <div className="grid gap-4 lg:grid-cols-5 lg:items-start">
        <div className="lg:sticky lg:top-4 lg:col-span-2 lg:col-start-4 lg:row-start-1">
          <AdminPlacesMap
            places={places}
            selectedId={selectedPlaceId}
            onSelectPlace={handleMapSelectPlace}
          />
        </div>
        <div
          data-testid="admin-places-list"
          className="overflow-x-auto rounded border border-stone-200 bg-white lg:col-span-3 lg:col-start-1 lg:row-start-1"
        >
        <table className="w-full border-collapse text-left text-sm">
          <thead className="bg-stone-50 text-stone-600">
            <tr>
              <th className="whitespace-nowrap px-3 py-2 font-medium">名称</th>
              <th className="whitespace-nowrap px-3 py-2 font-medium">类目</th>
              <th className="whitespace-nowrap px-3 py-2 font-medium">
                <span className="inline-flex items-center gap-1">
                  重要性
                  {/* 降序提示用内联 SVG（不用 emoji），aria-label 说明排序方向。 */}
                  <svg
                    viewBox="0 0 20 20"
                    role="img"
                    aria-label="按重要性降序"
                    className="h-3.5 w-3.5 text-stone-500"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M10 3v14M5.5 12.5L10 17l4.5-4.5" />
                  </svg>
                </span>
              </th>
              <th className="whitespace-nowrap px-3 py-2 font-medium">评分</th>
              <th className="whitespace-nowrap px-3 py-2 font-medium">人均</th>
              <th className="whitespace-nowrap px-3 py-2 font-medium">营业时间</th>
              <th className="whitespace-nowrap px-3 py-2 font-medium">来源</th>
              <th className="whitespace-nowrap px-3 py-2 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {places.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-stone-500">
                  {listLoading ? "加载中…" : "暂无地点"}
                </td>
              </tr>
            )}
            {places.map((place) => {
              const hidden = place.hidden === true;
              const isManual = place.origin === "manual";
              const highlighted = highlightPlaceId === place.id;
              return (
                <tr
                  key={place.id}
                  data-row-place-id={place.id}
                  data-place-name={place.name}
                  data-highlight={highlighted ? "true" : undefined}
                  ref={(element) => {
                    if (element === null) rowRefs.current.delete(place.id);
                    else rowRefs.current.set(place.id, element);
                  }}
                  onClick={(event) => handleRowSelectPlace(place.id, event.target)}
                  className={`cursor-pointer border-t border-stone-200 hover:bg-stone-50 ${
                    hidden ? "text-stone-500 " : ""
                  }${highlighted ? "bg-amber-100" : ""}`}
                >
                  <td className="px-3 py-2">
                    {place.name}
                    {hidden && (
                      <span className="ml-2 inline-block rounded border border-stone-300 bg-stone-100 px-1 text-xs text-stone-600">
                        已隐藏
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">{categoryLabel(place.category)}</td>
                  <td className="px-3 py-2">
                    <ImportanceStars
                      place={place}
                      disabled={actionBusy}
                      onRate={(importance) => handleRate(place, importance)}
                    />
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">{formatRating(place.rating)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{formatAvgCost(place.avgCost)}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-stone-500">{formatOpenTime(place)}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-stone-500">{isManual ? "手工" : "自动"}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => openEdit(place)}
                      disabled={actionBusy}
                      className="mr-3 text-blue-600 hover:underline disabled:opacity-50"
                    >
                      编辑
                    </button>
                    {isManual && (
                      <button
                        type="button"
                        onClick={() => handleRemove(place)}
                        disabled={actionBusy}
                        className="mr-3 text-red-600 hover:underline disabled:opacity-50"
                      >
                        删除
                      </button>
                    )}
                    {!isManual && !hidden && (
                      <button
                        type="button"
                        onClick={() => handleRemove(place)}
                        disabled={actionBusy}
                        className="mr-3 text-blue-600 hover:underline disabled:opacity-50"
                      >
                        隐藏
                      </button>
                    )}
                    {hidden && (
                      <button
                        type="button"
                        onClick={() => handleRestore(place)}
                        disabled={actionBusy}
                        className="text-blue-600 hover:underline disabled:opacity-50"
                      >
                        恢复
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      </div>

      {modalOpen && (
        <PlaceFormDialog
          key={editing === null ? "create" : `edit-${editing.id}`}
          city={city}
          editing={editing}
          onClose={closeModal}
          onSaved={handleSaved}
        />
      )}
      </div>

      {tab === "events" && <EventsPanel city={city} />}
    </main>
  );
}

/* ------------------------------------------------------------------ *
 * 新增 / 编辑弹窗
 * ------------------------------------------------------------------ */

type PlaceFormDialogProps = {
  city: string;
  /** null = 新增；否则编辑这条 */
  editing: AdminPlace | null;
  onClose: () => void;
  onSaved: (message: string) => void;
};

type FormState = {
  name: string;
  address: string;
  lng: string;
  lat: string;
  category: PlaceCategory;
  openTime: string;
  closeTime: string;
  closedDays: number[];
  rating: string;
  avgCost: string;
  /** 重要性："..." 空串 = 不设置（新增默认 / 编辑时表示不改），"1"–"5" = 星级 */
  importance: string;
};

function buildInitialForm(editing: AdminPlace | null): FormState {
  if (editing === null) {
    return {
      name: "",
      address: "",
      lng: "",
      lat: "",
      category: "other",
      openTime: "",
      closeTime: "",
      closedDays: [],
      rating: "",
      avgCost: "",
      importance: "",
    };
  }
  return {
    name: editing.name,
    address: "",
    lng: String(editing.lng),
    lat: String(editing.lat),
    category: editing.category,
    openTime: normalizeTimeForInput(editing.openTime),
    closeTime: normalizeTimeForInput(editing.closeTime),
    closedDays: Array.isArray(editing.closedDays) ? [...editing.closedDays] : [],
    rating: editing.rating === null || editing.rating === undefined ? "" : String(editing.rating),
    avgCost: editing.avgCost === null || editing.avgCost === undefined ? "" : String(editing.avgCost),
    importance: editing.importance === undefined ? "" : String(editing.importance),
  };
}

/** 可选数字输入：空 → null；非数字 → undefined（交给调用方报错）。 */
function parseOptionalNumber(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return undefined;
  return value;
}

function PlaceFormDialog({ city, editing, onClose, onSaved }: PlaceFormDialogProps) {
  const [form, setForm] = useState<FormState>(() => buildInitialForm(editing));
  const [formError, setFormError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<ApiFieldError[]>([]);
  const [saving, setSaving] = useState(false);
  const [geocoding, setGeocoding] = useState(false);
  const [geocodeError, setGeocodeError] = useState("");
  const [geocodeHint, setGeocodeHint] = useState("");

  const updateForm = (patch: Partial<FormState>) => {
    setForm((previous) => ({ ...previous, ...patch }));
  };

  const toggleClosedDay = (day: number) => {
    setForm((previous) => {
      const selected = previous.closedDays.indexOf(day) !== -1;
      return {
        ...previous,
        closedDays: selected
          ? previous.closedDays.filter((item) => item !== day)
          : [...previous.closedDays, day],
      };
    });
  };

  /** 解析地址：GET /api/admin/places?city=...&geocode=...，成功后把坐标填进下面的输入框。 */
  const handleGeocode = async () => {
    const address = form.address.trim();
    setGeocodeError("");
    setGeocodeHint("");
    if (address === "") {
      setGeocodeError("请先填写地址");
      return;
    }
    setGeocoding(true);
    try {
      const response = await fetch(
        `/api/admin/places?city=${encodeURIComponent(city)}&geocode=${encodeURIComponent(address)}`,
        { cache: "no-store" },
      );
      const json = await parseJson(response);
      const lng = json.lng;
      const lat = json.lat;
      if (!json.ok || typeof lng !== "number" || typeof lat !== "number") {
        setGeocodeError(json.reason ?? "解析地址失败");
        return;
      }
      setForm((previous) => ({
        ...previous,
        lng: formatCoordinate(lng),
        lat: formatCoordinate(lat),
      }));
      setGeocodeHint(`已解析坐标：${formatCoordinate(lng)}, ${formatCoordinate(lat)}`);
    } catch (error) {
      setGeocodeError(errorText(error));
    } finally {
      setGeocoding(false);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError("");
    setFieldErrors([]);

    // 必填：名称 / 经度 / 纬度。其余字段交给服务端 zod 校验（错误原样展示）。
    const name = form.name.trim();
    if (name === "") {
      setFormError("名称不能为空");
      return;
    }
    const lngRaw = form.lng.trim();
    const latRaw = form.lat.trim();
    const lng = Number(lngRaw);
    const lat = Number(latRaw);
    if (lngRaw === "" || !Number.isFinite(lng)) {
      setFormError("经度不能为空且必须是数字");
      return;
    }
    if (latRaw === "" || !Number.isFinite(lat)) {
      setFormError("纬度不能为空且必须是数字");
      return;
    }

    const rating = parseOptionalNumber(form.rating);
    if (rating === undefined) {
      setFormError("评分必须是数字");
      return;
    }
    if (rating !== null && (rating < 0 || rating > 5)) {
      setFormError("评分必须在 0 到 5 之间");
      return;
    }
    const avgCost = parseOptionalNumber(form.avgCost);
    if (avgCost === undefined) {
      setFormError("人均必须是数字");
      return;
    }
    if (avgCost !== null && avgCost < 0) {
      setFormError("人均不能是负数");
      return;
    }

    // 重要性：空串 = 不设置（新增默认 / 编辑时表示不改）。
    const importance = form.importance === "" ? null : Number(form.importance);
    if (importance !== null && (!Number.isInteger(importance) || importance < 1 || importance > 5)) {
      setFormError("重要性必须是 1–5 星");
      return;
    }

    const openTime = form.openTime.trim();
    if (openTime !== "" && !HH_MM_PATTERN.test(openTime)) {
      setFormError("开始时间必须是 HH:mm（例如 09:00）");
      return;
    }
    const closeTime = form.closeTime.trim();
    if (closeTime !== "" && !CLOSE_TIME_PATTERN.test(closeTime)) {
      setFormError("结束时间必须是 HH:mm（24:00 表示当天结束）");
      return;
    }

    const placePayload = {
      name,
      lng,
      lat,
      category: form.category,
      // 时间为空 → 提交 null（契约里 null 表示「未知」，不编造营业时间）。
      openTime: openTime === "" ? null : openTime,
      closeTime: closeTime === "" ? null : closeTime,
      closedDays: [...form.closedDays].sort((left, right) => left - right),
      rating,
      avgCost,
    };

    const isEdit = editing !== null;
    // 编辑时只有用户真的改了星级才提交 importance：不传的话服务端 PATCH 合并后保留原值
    // （现有契约没有「清空星级」语义，下拉选「不设置」等于不改，避免把已有星级静默抹掉）。
    const importanceChanged = importance !== null && importance !== (editing?.importance ?? null);
    const requestBody = isEdit
      ? {
          city,
          id: editing.id,
          // hidden 只在编辑时带上，保证「编辑一条隐藏地点」不会把它意外恢复显示。
          patch: {
            ...placePayload,
            hidden: editing.hidden === true,
            ...(importanceChanged ? { importance } : {}),
          },
        }
      : { city, place: { ...placePayload, ...(importance === null ? {} : { importance }) } };

    setSaving(true);
    try {
      const response = await fetch("/api/admin/places", {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      const json = await parseJson(response);
      if (!json.ok) {
        setFormError(json.reason ?? "保存失败");
        setFieldErrors(Array.isArray(json.errors) ? json.errors : []);
        return;
      }
      onSaved(isEdit ? `已保存「${name}」` : `已新增「${name}」`);
    } catch (error) {
      setFormError(errorText(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="place-form-title"
        className="mx-auto my-8 w-full max-w-xl rounded border border-stone-200 bg-white p-5 shadow-lg"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="place-form-title" className="text-base font-bold">
            {editing === null ? "新增地点" : "编辑地点"}
          </h2>
          <button type="button" onClick={onClose} className="text-sm text-stone-500 hover:underline">
            关闭
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3 text-sm">
          <label className="block">
            <span className="mb-1 block text-stone-800">
              名称 <span className="text-red-600">*</span>
            </span>
            <input
              value={form.name}
              onChange={(event) => updateForm({ name: event.target.value })}
              placeholder="地点名称"
              className="w-full rounded border border-stone-300 bg-white px-2 py-1 text-stone-800 placeholder:text-stone-500"
            />
          </label>

          <div>
            <span className="mb-1 block text-stone-800">地址（可选，仅用于解析坐标）</span>
            <div className="flex gap-2">
              <input
                value={form.address}
                onChange={(event) => updateForm({ address: event.target.value })}
                placeholder="例如：杭州市西湖区北山街"
                className="min-w-0 flex-1 rounded border border-stone-300 bg-white px-2 py-1 text-stone-800 placeholder:text-stone-500"
              />
              <button
                type="button"
                onClick={handleGeocode}
                disabled={geocoding}
                className="rounded border border-stone-300 px-3 py-1 hover:bg-stone-50 disabled:opacity-50"
              >
                {geocoding ? "解析中…" : "解析地址"}
              </button>
            </div>
            {geocodeError !== "" && <p className="mt-1 text-red-600">{geocodeError}</p>}
            {geocodeHint !== "" && <p className="mt-1 text-green-700">{geocodeHint}</p>}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-stone-800">
                经度 <span className="text-red-600">*</span>
              </span>
              <input
                type="number"
                step="any"
                value={form.lng}
                onChange={(event) => updateForm({ lng: event.target.value })}
                placeholder="120.123456"
                className="w-full rounded border border-stone-300 bg-white px-2 py-1 text-stone-800 placeholder:text-stone-500"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-stone-800">
                纬度 <span className="text-red-600">*</span>
              </span>
              <input
                type="number"
                step="any"
                value={form.lat}
                onChange={(event) => updateForm({ lat: event.target.value })}
                placeholder="30.123456"
                className="w-full rounded border border-stone-300 bg-white px-2 py-1 text-stone-800 placeholder:text-stone-500"
              />
            </label>
          </div>

          <label className="block">
            <span className="mb-1 block text-stone-800">类目</span>
            <select
              value={form.category}
              onChange={(event) => updateForm({ category: event.target.value as PlaceCategory })}
              className="w-full rounded border border-stone-300 bg-white px-2 py-1 text-stone-800 placeholder:text-stone-500"
            >
              {CATEGORY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-stone-800">重要性（可选，只展示，不参与排程）</span>
            <select
              value={form.importance}
              onChange={(event) => updateForm({ importance: event.target.value })}
              className="w-full rounded border border-stone-300 bg-white px-2 py-1 text-stone-800"
            >
              <option value="">不设置</option>
              {[1, 2, 3, 4, 5].map((star) => (
                <option key={star} value={String(star)}>
                  {star} 星
                </option>
              ))}
            </select>
          </label>

          <div>
            <span className="mb-1 block text-stone-800">营业时间（可选，留空表示未知）</span>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex items-center gap-2">
                开始
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="HH:mm"
                  value={form.openTime}
                  onChange={(event) => updateForm({ openTime: event.target.value })}
                  className="flex-1 rounded border border-stone-300 bg-white px-2 py-1 text-stone-800 placeholder:text-stone-500"
                />
              </label>
              <label className="flex items-center gap-2">
                结束
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="HH:mm（24:00=全天）"
                  value={form.closeTime}
                  onChange={(event) => updateForm({ closeTime: event.target.value })}
                  className="flex-1 rounded border border-stone-300 bg-white px-2 py-1 text-stone-800 placeholder:text-stone-500"
                />
              </label>
            </div>
          </div>

          <div>
            <span className="mb-1 block text-stone-800">闭馆日（可选，可多选）</span>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {CLOSED_DAY_OPTIONS.map((option) => (
                <label key={option.value} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={form.closedDays.indexOf(option.value) !== -1}
                    onChange={() => toggleClosedDay(option.value)}
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-stone-800">评分（可选，0–5）</span>
              <input
                type="number"
                min="0"
                max="5"
                step="0.1"
                value={form.rating}
                onChange={(event) => updateForm({ rating: event.target.value })}
                placeholder="4.5"
                className="w-full rounded border border-stone-300 bg-white px-2 py-1 text-stone-800 placeholder:text-stone-500"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-stone-800">人均（可选，元）</span>
              <input
                type="number"
                min="0"
                step="1"
                value={form.avgCost}
                onChange={(event) => updateForm({ avgCost: event.target.value })}
                placeholder="60"
                className="w-full rounded border border-stone-300 bg-white px-2 py-1 text-stone-800 placeholder:text-stone-500"
              />
            </label>
          </div>

          {formError !== "" && (
            <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-red-600">{formError}</p>
          )}
          {fieldErrors.length > 0 && (
            <ul className="list-inside list-disc rounded border border-red-300 bg-red-50 px-3 py-2 text-red-600">
              {fieldErrors.map((item, index) => (
                <li key={`${item.path}-${index}`}>
                  {item.path}：{item.message}
                </li>
              ))}
            </ul>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-stone-300 px-3 py-1.5 hover:bg-stone-50"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded bg-blue-600 px-3 py-1.5 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 活动分区（第二批）
 * ------------------------------------------------------------------ */

/** 活动状态徽标：颜色只是辅助，文案本身已经说明状态（服务端算好，前端不比较时间）。 */
function EventStatusBadge({ status }: { status: AdminEventStatus }) {
  const style =
    status === "ongoing"
      ? "border-green-300 bg-green-50 text-green-700"
      : status === "upcoming"
        ? "border-blue-300 bg-blue-50 text-blue-700"
        : "border-stone-300 bg-stone-100 text-stone-600";
  return <span className={`inline-block rounded border px-1.5 py-0.5 text-xs ${style}`}>{EVENT_STATUS_LABELS[status]}</span>;
}

/** 展示用时间：数据是 "YYYY-MM-DDTHH:mm"，只把 T 换成空格，不做任何时区换算。 */
function formatEventTime(value: string): string {
  return value.replace("T", " ");
}

type EventsPanelProps = {
  city: string;
};

function EventsPanel({ city }: EventsPanelProps) {
  const [events, setEvents] = useState<AdminEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AdminEvent | null>(null);

  // 列表顺序（startAt 升序）由服务端排好，控制台只渲染，不再排一次。
  useEffect(() => {
    if (city === "") return;
    let cancelled = false;
    const loadEvents = async () => {
      setLoading(true);
      setListError("");
      try {
        const response = await fetch(`/api/admin/events?city=${encodeURIComponent(city)}`, { cache: "no-store" });
        const json = await parseJson(response);
        if (cancelled) return;
        if (!json.ok || !Array.isArray(json.events)) {
          setEvents([]);
          setListError(json.reason ?? "读取活动列表失败");
          return;
        }
        setEvents(json.events);
      } catch (error) {
        if (!cancelled) {
          setEvents([]);
          setListError(errorText(error));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    loadEvents();
    return () => {
      cancelled = true;
    };
  }, [city, refreshTick]);

  const reload = () => setRefreshTick((tick) => tick + 1);

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const openEdit = (event: AdminEvent) => {
    setEditing(event);
    setDialogOpen(true);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setEditing(null);
  };

  const handleSaved = (message: string) => {
    setDialogOpen(false);
    setEditing(null);
    setNotice({ kind: "success", text: message });
    reload();
  };

  const handleDelete = async (event: AdminEvent) => {
    if (!window.confirm(`确定删除活动「${event.title}」吗？删除后不可恢复。`)) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/events", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ city, id: event.id }),
      });
      const json = await parseJson(response);
      if (!json.ok) {
        setNotice({ kind: "error", text: json.reason ?? "删除失败" });
        return;
      }
      setNotice({ kind: "success", text: `已删除活动「${event.title}」` });
      reload();
    } catch (error) {
      setNotice({ kind: "error", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  };

  // status 已由服务端算好：未开始 + 进行中常显，已结束收进 <details>（默认折叠）。
  const activeEvents = events.filter((event) => event.status !== "ended");
  const endedEvents = events.filter((event) => event.status === "ended");

  const renderTable = (rows: AdminEvent[]) => (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        <thead className="bg-stone-50 text-stone-600">
          <tr>
            <th className="border-b border-stone-200 px-3 py-2 font-medium">标题</th>
            <th className="border-b border-stone-200 px-3 py-2 font-medium">地点</th>
            <th className="border-b border-stone-200 px-3 py-2 font-medium">开始</th>
            <th className="border-b border-stone-200 px-3 py-2 font-medium">结束</th>
            <th className="border-b border-stone-200 px-3 py-2 font-medium">状态</th>
            <th className="border-b border-stone-200 px-3 py-2 font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((event) => (
            <tr key={event.id} className="border-t border-stone-200 hover:bg-stone-50">
              <td className="px-3 py-2">{event.title}</td>
              <td className="px-3 py-2 text-stone-500">{event.placeName}</td>
              <td className="px-3 py-2 whitespace-nowrap text-stone-500">{formatEventTime(event.startAt)}</td>
              <td className="px-3 py-2 whitespace-nowrap text-stone-500">{formatEventTime(event.endAt)}</td>
              <td className="px-3 py-2">
                <EventStatusBadge status={event.status} />
              </td>
              <td className="px-3 py-2 whitespace-nowrap">
                <button
                  type="button"
                  onClick={() => openEdit(event)}
                  disabled={busy}
                  className="mr-3 text-blue-600 hover:underline disabled:opacity-50"
                >
                  编辑
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(event)}
                  disabled={busy}
                  className="text-red-600 hover:underline disabled:opacity-50"
                >
                  删除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-base font-bold">活动列表</h2>
          <span className="text-sm text-stone-500">{loading ? "加载中…" : `共 ${events.length} 条`}</span>
        </div>
        <button
          type="button"
          onClick={openCreate}
          disabled={city === ""}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
        >
          新增活动
        </button>
      </div>

      {notice !== null && (
        <p
          className={`mb-3 rounded border px-3 py-2 text-sm ${
            notice.kind === "success"
              ? "border-green-300 bg-green-50 text-green-700"
              : "border-red-300 bg-red-50 text-red-600"
          }`}
        >
          {notice.text}
        </p>
      )}

      {listError !== "" && <p className="mb-3 text-sm text-red-600">{listError}</p>}

      <div className="overflow-hidden rounded border border-stone-200 bg-white">
        {events.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-stone-500">{loading ? "加载中…" : "暂无活动"}</p>
        ) : (
          <>
            {activeEvents.length === 0 ? (
              <p className="px-3 py-4 text-sm text-stone-500">暂无未开始 / 进行中的活动。</p>
            ) : (
              renderTable(activeEvents)
            )}
            {endedEvents.length > 0 && (
              <details className="border-t border-stone-200">
                <summary className="cursor-pointer bg-stone-50 px-3 py-2 text-sm text-stone-600">
                  已结束（{endedEvents.length}）
                </summary>
                {renderTable(endedEvents)}
              </details>
            )}
          </>
        )}
      </div>

      {dialogOpen && (
        <EventFormDialog
          key={editing === null ? "create" : `edit-${editing.id}`}
          city={city}
          editing={editing}
          onClose={closeDialog}
          onSaved={handleSaved}
        />
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * 新增 / 编辑活动弹窗
 * ------------------------------------------------------------------ */

/** datetime-local 的值就是契约里的 "YYYY-MM-DDTHH:mm"，原样传接口 / 回填，不做时区换算。 */
const LOCAL_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

type EventFormDialogProps = {
  city: string;
  /** null = 新增；否则编辑这条 */
  editing: AdminEvent | null;
  onClose: () => void;
  onSaved: (message: string) => void;
};

type EventFormState = {
  placeId: string;
  title: string;
  startAt: string;
  endAt: string;
  note: string;
};

function buildInitialEventForm(editing: AdminEvent | null): EventFormState {
  if (editing === null) {
    return { placeId: "", title: "", startAt: "", endAt: "", note: "" };
  }
  return {
    placeId: editing.placeId,
    title: editing.title,
    startAt: editing.startAt,
    endAt: editing.endAt,
    note: editing.note ?? "",
  };
}

function EventFormDialog({ city, editing, onClose, onSaved }: EventFormDialogProps) {
  const [form, setForm] = useState<EventFormState>(() => buildInitialEventForm(editing));
  const [places, setPlaces] = useState<AdminPlace[]>([]);
  const [placesLoading, setPlacesLoading] = useState(true);
  const [placesError, setPlacesError] = useState("");
  const [placeQuery, setPlaceQuery] = useState("");
  const [formError, setFormError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<ApiFieldError[]>([]);
  const [saving, setSaving] = useState(false);

  // 地点下拉：带 includeHidden 拉全量（老活动可能挂在一个后来被隐藏的点上），本地按名称过滤。
  useEffect(() => {
    if (city === "") {
      setPlacesLoading(false);
      return;
    }
    let cancelled = false;
    const loadPlaces = async () => {
      setPlacesLoading(true);
      setPlacesError("");
      try {
        const response = await fetch(`/api/admin/places?city=${encodeURIComponent(city)}&includeHidden=1`, {
          cache: "no-store",
        });
        const json = await parseJson(response);
        if (cancelled) return;
        if (!json.ok || !Array.isArray(json.places)) {
          setPlaces([]);
          setPlacesError(json.reason ?? "读取地点列表失败");
          return;
        }
        setPlaces(json.places);
      } catch (error) {
        if (!cancelled) setPlacesError(errorText(error));
      } finally {
        if (!cancelled) setPlacesLoading(false);
      }
    };
    loadPlaces();
    return () => {
      cancelled = true;
    };
  }, [city]);

  const updateForm = (patch: Partial<EventFormState>) => {
    setForm((previous) => ({ ...previous, ...patch }));
  };

  const normalizedQuery = placeQuery.trim().toLowerCase();
  const filteredPlaces =
    normalizedQuery === "" ? places : places.filter((place) => place.name.toLowerCase().includes(normalizedQuery));

  // 老活动指向的地点可能已经被删掉：给当前值一个占位选项，避免下拉显示成空。
  const placeOptionMissing =
    !placesLoading && form.placeId !== "" && !places.some((place) => place.id === form.placeId);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError("");
    setFieldErrors([]);

    if (form.placeId === "") {
      setFormError("请选择关联地点");
      return;
    }
    const title = form.title.trim();
    if (title === "") {
      setFormError("标题不能为空");
      return;
    }
    const startAt = form.startAt.trim();
    const endAt = form.endAt.trim();
    if (!LOCAL_DATETIME_PATTERN.test(startAt)) {
      setFormError("开始时间必须填完整（日期和时分都要选）");
      return;
    }
    if (!LOCAL_DATETIME_PATTERN.test(endAt)) {
      setFormError("结束时间必须填完整（日期和时分都要选）");
      return;
    }
    // 定长字符串比较即时间比较；真正的日期合法性 / endAt > startAt 服务端还会再校验一遍。
    if (endAt <= startAt) {
      setFormError("结束时间必须晚于开始时间");
      return;
    }
    const note = form.note.trim();

    const isEdit = editing !== null;
    const requestBody = isEdit
      ? {
          city,
          id: editing.id,
          patch: {
            title,
            startAt,
            endAt,
            // 空备注 = 清空（契约里 note:null 表示没有备注）；没填也显式传 null，编辑时才能清掉旧备注。
            note: note === "" ? null : note,
            // 地点没换就不提交 placeId：老活动指向的地点后来被删掉时，仍允许改标题 / 时间。
            ...(form.placeId === editing.placeId ? {} : { placeId: form.placeId }),
          },
        }
      : {
          city,
          event: {
            placeId: form.placeId,
            title,
            startAt,
            endAt,
            note: note === "" ? null : note,
          },
        };

    setSaving(true);
    try {
      const response = await fetch("/api/admin/events", {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      const json = await parseJson(response);
      if (!json.ok) {
        setFormError(json.reason ?? "保存失败");
        setFieldErrors(Array.isArray(json.errors) ? json.errors : []);
        return;
      }
      onSaved(isEdit ? `已保存活动「${title}」` : `已新增活动「${title}」`);
    } catch (error) {
      setFormError(errorText(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="event-form-title"
        className="mx-auto my-8 w-full max-w-xl rounded border border-stone-200 bg-white p-5 shadow-lg"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="event-form-title" className="text-base font-bold">
            {editing === null ? "新增活动" : "编辑活动"}
          </h2>
          <button type="button" onClick={onClose} className="text-sm text-stone-500 hover:underline">
            关闭
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3 text-sm">
          <div>
            <span className="mb-1 block text-stone-800">
              关联地点 <span className="text-red-600">*</span>
            </span>
            <input
              value={placeQuery}
              onChange={(event) => setPlaceQuery(event.target.value)}
              placeholder="按地点名搜索"
              className="mb-2 w-full rounded border border-stone-300 bg-white px-2 py-1 text-stone-800 placeholder:text-stone-500"
            />
            <select
              value={form.placeId}
              onChange={(event) => {
                updateForm({ placeId: event.target.value });
                // 选完就清空搜索词，否则选中的地点可能被过滤掉、下拉看起来像没选。
                setPlaceQuery("");
              }}
              className="w-full rounded border border-stone-300 bg-white px-2 py-1 text-stone-800"
            >
              <option value="">{placesLoading ? "（地点读取中…）" : "请选择地点"}</option>
              {placeOptionMissing && editing !== null && (
                <option value={editing.placeId}>{editing.placeName}（不在当前列表）</option>
              )}
              {filteredPlaces.map((place) => (
                <option key={place.id} value={place.id}>
                  {place.hidden ? `${place.name}（已隐藏）` : place.name}
                </option>
              ))}
            </select>
            {placesError !== "" && <p className="mt-1 text-red-600">{placesError}</p>}
          </div>

          <label className="block">
            <span className="mb-1 block text-stone-800">
              标题 <span className="text-red-600">*</span>
            </span>
            <input
              value={form.title}
              maxLength={120}
              onChange={(event) => updateForm({ title: event.target.value })}
              placeholder="例如：西湖音乐节"
              className="w-full rounded border border-stone-300 bg-white px-2 py-1 text-stone-800 placeholder:text-stone-500"
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-stone-800">
                开始 <span className="text-red-600">*</span>
              </span>
              <input
                type="datetime-local"
                value={form.startAt}
                onChange={(event) => updateForm({ startAt: event.target.value })}
                className="w-full rounded border border-stone-300 bg-white px-2 py-1 text-stone-800"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-stone-800">
                结束 <span className="text-red-600">*</span>
              </span>
              <input
                type="datetime-local"
                value={form.endAt}
                onChange={(event) => updateForm({ endAt: event.target.value })}
                className="w-full rounded border border-stone-300 bg-white px-2 py-1 text-stone-800"
              />
            </label>
          </div>

          <label className="block">
            <span className="mb-1 block text-stone-800">备注（可选，最多 500 字）</span>
            <textarea
              rows={3}
              maxLength={500}
              value={form.note}
              onChange={(event) => updateForm({ note: event.target.value })}
              placeholder="票价 / 购票渠道等"
              className="w-full rounded border border-stone-300 bg-white px-2 py-1 text-stone-800 placeholder:text-stone-500"
            />
          </label>

          {formError !== "" && (
            <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-red-600">{formError}</p>
          )}
          {fieldErrors.length > 0 && (
            <ul className="list-inside list-disc rounded border border-red-300 bg-red-50 px-3 py-2 text-red-600">
              {fieldErrors.map((item, index) => (
                <li key={`${item.path}-${index}`}>
                  {item.path}：{item.message}
                </li>
              ))}
            </ul>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-stone-300 px-3 py-1.5 hover:bg-stone-50"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded bg-blue-600 px-3 py-1.5 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
