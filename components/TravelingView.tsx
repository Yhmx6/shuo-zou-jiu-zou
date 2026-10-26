"use client";

import { useEffect, useState } from "react";
import type { Itinerary } from "@/types/schema";

/**
 * 「进行中」视图（本轮新增「出发」状态机的一部分）。
 *
 * 只负责展示和回调，不碰 localStorage / 不排程：
 * - 顶部：今天这一趟 · 已走 X 分钟（每 30 秒刷新一次）；
 * - 突出「下一站」：地点名 + 到达时间 + 一键导航（高德 H5 链接由页面算好传入）；
 * - 其他站点折叠在 <details> 里（已走过 / 待走两种状态）；
 * - 底部：「到下一站了」/「结束这一趟」；
 * - 顶部还有城市下拉与「重新设置」：点了不直接做，先交给页面弹「要结束这一趟吗」确认。
 *
 * 样式沿用主页 stone 色系；不引入新依赖、不做 GPS / 到站提醒。
 */

type CityOption = { city: string; displayName: string };

export type TravelingViewProps = {
  itinerary: Itinerary;
  /** 点「出发」的时刻（Date.now()）。 */
  startedAt: number;
  /** 当前站下标（0 起，页面已夹到合法范围）。 */
  currentStopIndex: number;
  cityOptions: CityOption[];
  selectedCityId: string | null;
  citiesReady: boolean;
  /** 「下一站」的一键导航链接（页面用 buildNavigationUrl 算好）。 */
  nextNavigationUrl: string;
  /** 非 null = 正在确认「要结束这一趟吗」（reset / city）。 */
  confirm: "reset" | "city" | null;
  /** confirm=city 时，用户想切去的城市名（用于确认文案）。 */
  pendingCityName: string | null;
  onCityChange: (cityId: string) => void;
  onRequestReset: () => void;
  onAdvance: () => void;
  onEnd: () => void;
  onConfirmExit: () => void;
  onCancelExit: () => void;
};

/** 当日分钟数 → "HH:mm"（与主页 formatMinute 同一口径的页面内小工具）。 */
function formatMinute(minute: number): string {
  const normalized = ((minute % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

export default function TravelingView({
  itinerary,
  startedAt,
  currentStopIndex,
  cityOptions,
  selectedCityId,
  citiesReady,
  nextNavigationUrl,
  confirm,
  pendingCityName,
  onCityChange,
  onRequestReset,
  onAdvance,
  onEnd,
  onConfirmExit,
  onCancelExit,
}: TravelingViewProps) {
  // 已走时长：每 30 秒 tick 一次，够用了（不让秒级刷新把页面变成计时器）。
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const elapsedMinutes = Math.max(0, Math.floor((nowMs - startedAt) / 60_000));

  const nextStop = itinerary.stops[currentStopIndex];
  const isLastStop = currentStopIndex >= itinerary.stops.length - 1;

  return (
    <main data-testid="trip-view" className="min-h-screen bg-stone-50 text-stone-900">
      <div className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-6 px-5 py-8">
        <header className="flex flex-col gap-4">
          <p data-testid="trip-elapsed" className="text-sm tracking-wide text-stone-500">
            {`今天这一趟 · 已走 ${elapsedMinutes} 分钟`}
          </p>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <label htmlFor="trip-city-select" className="shrink-0 text-sm tracking-wide text-stone-500">
                城市
              </label>
              <select
                id="trip-city-select"
                data-testid="trip-city-select"
                value={selectedCityId ?? ""}
                onChange={(event) => {
                  onCityChange(event.target.value);
                }}
                disabled={!citiesReady}
                className="rounded-lg border border-stone-300 bg-white px-2.5 py-1.5 text-sm text-stone-800 shadow-sm transition duration-150 hover:bg-stone-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {citiesReady ? (
                  cityOptions.map((city) => (
                    <option key={city.city} value={city.city}>
                      {city.displayName}
                    </option>
                  ))
                ) : (
                  <option value="">正在读取城市…</option>
                )}
              </select>
            </div>
            <button
              type="button"
              data-testid="trip-reset-button"
              onClick={onRequestReset}
              className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 transition duration-150 hover:bg-stone-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500"
            >
              重新设置
            </button>
          </div>
        </header>

        {/* 下一站：整屏最突出的信息（任务书要求「突出显示」，含到达时间与一键导航）。 */}
        <section
          data-testid="trip-next-stop"
          className="flex flex-col gap-3 rounded-2xl border border-stone-900 bg-white px-5 py-5 shadow-sm"
        >
          <p className="text-lg font-medium leading-7 text-stone-900">
            <span className="text-sm font-normal tracking-wide text-stone-500">下一站：</span>
            {nextStop.placeName ?? "未知地点"}
          </p>
          <p className="text-sm tabular-nums text-stone-600">
            {`${formatMinute(nextStop.arriveAt)} 到达 · 停留 ${nextStop.stayMin} 分钟`}
          </p>
          <a
            data-testid="trip-next-navigation"
            href={nextNavigationUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex w-fit items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 transition duration-150 hover:bg-stone-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500"
          >
            <svg
              aria-hidden="true"
              focusable="false"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-3.5 w-3.5"
            >
              <path d="M3 11.5 21 3l-8.5 18-2-7.5-7.5-2Z" />
            </svg>
            导航
          </a>
        </section>

        {/* 其他站点：折叠；已走过 / 待走用文字标出，不做到站提醒。 */}
        <details
          data-testid="trip-other-stops"
          className="overflow-hidden rounded-2xl border border-stone-200 bg-white"
        >
          <summary className="cursor-pointer px-4 py-3 text-sm text-stone-600 transition-colors duration-150 hover:bg-stone-50">
            其他站点（{itinerary.stops.length - 1}）
          </summary>
          <ol className="border-t border-stone-200">
            {itinerary.stops.map((stop, index) => {
              if (index === currentStopIndex) return null;
              const done = index < currentStopIndex;
              return (
                <li
                  key={stop.placeId}
                  data-testid="trip-other-stop-item"
                  className="flex items-center justify-between gap-3 border-b border-stone-200 px-4 py-2.5 last:border-b-0"
                >
                  <span className="min-w-0">
                    <span className="font-medium text-stone-500">{`${index + 1}. `}</span>
                    <span className="tabular-nums text-stone-500">{formatMinute(stop.arriveAt)}</span>
                    {" "}
                    <span className={done ? "text-stone-400 line-through" : "text-stone-800"}>
                      {stop.placeName ?? "未知地点"}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-stone-400">{done ? "已走过" : "待走"}</span>
                </li>
              );
            })}
          </ol>
        </details>

        {/* 底部两个操作：切到下一站 / 结束这一趟。 */}
        <div className="mt-auto flex flex-col gap-3 pb-2">
          <button
            type="button"
            data-testid="trip-advance-button"
            onClick={onAdvance}
            disabled={isLastStop}
            className="w-full rounded-2xl bg-stone-900 px-6 py-3 text-sm font-medium text-white transition duration-150 hover:bg-stone-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isLastStop ? "已经到最后一站" : "到下一站了"}
          </button>
          <button
            type="button"
            data-testid="trip-end-button"
            onClick={onEnd}
            className="w-full rounded-2xl border border-stone-300 bg-white px-6 py-3 text-sm font-medium text-stone-700 transition duration-150 hover:bg-stone-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500 active:translate-y-px"
          >
            结束这一趟
          </button>
        </div>
      </div>

      {confirm !== null ? (
        <div
          data-testid="trip-exit-confirm"
          role="dialog"
          aria-modal="true"
          aria-label="要结束这一趟吗"
          className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/30 px-5"
        >
          <div className="w-full max-w-sm rounded-2xl bg-white px-5 py-5 shadow-lg">
            <p className="text-sm leading-6 text-stone-800">
              要结束这一趟吗？
              {confirm === "city" && pendingCityName !== null
                ? `切换城市会先结束这一趟（去${pendingCityName}）。`
                : "结束后会回到主页重新安排。"}
            </p>
            <div className="mt-5 flex justify-end gap-3">
              <button
                type="button"
                data-testid="trip-exit-cancel"
                onClick={onCancelExit}
                className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 transition duration-150 hover:bg-stone-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500"
              >
                取消
              </button>
              <button
                type="button"
                data-testid="trip-exit-confirm-button"
                onClick={onConfirmExit}
                className="rounded-lg bg-stone-900 px-3 py-1.5 text-xs font-medium text-white transition duration-150 hover:bg-stone-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500"
              >
                确认结束
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
