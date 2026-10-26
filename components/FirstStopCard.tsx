"use client";

import { useState } from "react";
import Reason from "./Reason";
import RestaurantCard from "./RestaurantCard";
import type { MealInfo, StopEvent } from "@/types/schema";

/**
 * 重要性星级 1–5（本轮新增展示字段）：
 * 与 types/schema.ts 里 Place.importance / Stop.importance 同一口径，服务端 zod 已收紧到 1–5，
 * 组件这里再写成字面量联合类型，是为了让「6 星 / 0 星」这类值在编译期就过不去。
 */
export type Importance = 1 | 2 | 3 | 4 | 5;

/**
 * M19：UI 上暂时隐藏「换一个」，只隐藏渲染、不删逻辑（/api/swap、replaceStop、距离带、
 * onSwap / onDislike props 全部保留）。等环线形状稳定后改成 true 即可放出来。
 * 同名的三个开关：本文件、components/StopList.tsx、app/page.tsx（展开层）。
 */
const SHOW_SWAP_BUTTON = false;

export type FirstStopCardProps = {
  placeName: string;
  /** 最晚出发时刻 "17:00"；null = 24 小时开放的点，没有「几点前出发」（M5 收尾修复）。 */
  departByText: string | null;
  commuteText: string;
  reason: string;
  navigationUrl: string;
  onSwap?: () => void;
  /**
   * M7 次级入口：「不感兴趣」。和「换一个」的信号方向相反——
   * 点击后后端把该类目权重 × 0.2（仅本次会话内存），再换掉这一站。
   * 不传时按钮禁用（页面接线在集成阶段做，M7 只加两个入口）。
   */
  onDislike?: () => void;
  /** 正在调 /api/swap：按钮暂时禁用，防止重复提交。 */
  busy?: boolean;
  /** 到店时间 "12:20"；只有餐厅站才需要。 */
  arriveAtText?: string;
  /** 服务端给的餐厅信息；非 null 说明这一站是餐厅，卡片下半部分换成餐厅卡。 */
  meal?: MealInfo | null;
  /**
   * 地点重要性 1–5（本轮新增可选字段，服务端从地点数据里带下来）。
   * 纯展示：标题右侧放五颗星；不传 = 没标星，整组星不渲染、不留空位。
   */
  importance?: Importance;
  /**
   * 这一站「现在或即将开始」的活动（本轮新增可选字段，服务端已算好并格式化）。
   * 卡片里加一行「19:00 有场话剧《雷雨》，票价 80-180」；null / 不传 = 没有活动，不渲染、不占位。
   */
  upcomingEvent?: StopEvent | null;
  /**
   * 文案接线（本轮新增可选字段）：LLM 给这一站写的一句文案。
   * 有就在 reason（信息层）下面加一行小字；没有就不渲染、不留空位。
   */
  oneLine?: string;
};

/**
 * 第一站副标题（M5 收尾修复）：
 * - 普通地点：「17:00 前出发，走过去 22 分钟」；
 * - 24 小时开放的点（page 传 departByText = null）：「走过去 5 分钟，随时可去」——
 *   这类点没有闭馆时刻，不该出现「几点前出发」。
 */
export function buildDepartLine(departByText: string | null, commuteText: string): string {
  return departByText === null ? `${commuteText}，随时可去` : `${departByText} 前出发，${commuteText}`;
}

/** 五角星路径（viewBox 24×24）：实心 / 描边共用，保证两种状态形状完全一致。 */
const STAR_PATH =
  "M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8L3.5 9.7l5.9-.9L12 3.5Z";

/**
 * 重要性星标（本轮新增）：五颗内联 SVG，前 importance 颗实心（fill=currentColor，深色），
 * 其余只描边（stroke=currentColor，浅灰）。纯展示，不可点击、不参与排程。
 * 整组 role="img" + aria-label，读屏会念「重要性 4 星」；单颗星 aria-hidden，避免念五遍。
 */
function ImportanceStars({ importance }: { importance: Importance }) {
  return (
    <span
      role="img"
      aria-label={`重要性 ${importance} 星`}
      className="inline-flex shrink-0 items-center gap-0.5"
    >
      {[1, 2, 3, 4, 5].map((star) => {
        const filled = star <= importance;
        return (
          <svg
            key={star}
            aria-hidden="true"
            focusable="false"
            viewBox="0 0 24 24"
            fill={filled ? "currentColor" : "none"}
            stroke={filled ? "none" : "currentColor"}
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={filled ? "h-4 w-4 text-stone-900" : "h-4 w-4 text-stone-300"}
          >
            <path d={STAR_PATH} />
          </svg>
        );
      })}
    </span>
  );
}

/**
 * 活动提示文案（严格按约定拼接，不做二次加工）：
 * 「19:00 有场话剧《雷雨》，票价 80-180」；跨天时前面补「明天 」。
 * dayLabel / startAtText / title / noteLine 全部来自服务端快照，前端不做时间判断。
 */
export function buildEventLine(event: StopEvent): string {
  const dayPrefix = event.dayLabel === "明天" ? "明天 " : "";
  const noteSuffix = event.noteLine === null ? "" : `，${event.noteLine}`;
  return `${dayPrefix}${event.startAtText} 有场${event.title}${noteSuffix}`;
}

/**
 * 活动一行（本轮新增）：白底卡片里用浅灰底 + 细边框，醒目但克制；
 * 前面是 16px 的日历图标（内联 SVG，随文字颜色走）。没有活动时调用方不渲染。
 */
function UpcomingEventLine({ event }: { event: StopEvent }) {
  return (
    <p className="flex items-start gap-2 rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm leading-6 text-stone-800">
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="mt-0.5 h-4 w-4 shrink-0 text-stone-500"
      >
        <rect x="3" y="4" width="18" height="17" rx="2" />
        <path d="M8 2v4" />
        <path d="M16 2v4" />
        <path d="M3 10h18" />
      </svg>
      <span>{buildEventLine(event)}</span>
    </p>
  );
}

/**
 * 第一站卡片：只放地点名、出发提示、reason、两个操作，
 * 不展示到达/离开时间、停留时长、预算、分类等额外信息。
 *
 * M9：当这一站是餐厅（meal 不为空）时，额外渲染 RestaurantCard，
 * 补上「到店 / 要不要等 / 吃什么 / 花多少」四件事——这不是给所有站点加时间轴。
 *
 * 本轮追加（站点展示字段）：
 * - importance 存在时在标题右侧画 5 颗星（只展示，不参与排程打分）；
 * - upcomingEvent 存在时在 reason 上方加一行活动提示；两者都没有就不渲染、不占位。
 */
export default function FirstStopCard({
  placeName,
  departByText,
  commuteText,
  reason,
  navigationUrl,
  onSwap,
  onDislike,
  busy,
  arriveAtText,
  meal,
  importance,
  upcomingEvent,
  oneLine,
}: FirstStopCardProps) {
  const showRestaurant = meal !== undefined && meal !== null && arriveAtText !== undefined;

  // M7 3.4：同一站连续换 3 次，行内提示一次「要不要换别的类型？」；提示过一次就不再出现。
  const [rerollCount, setRerollCount] = useState(0);
  const [typeHintShown, setTypeHintShown] = useState(false);

  const handleSwap = () => {
    if (onSwap === undefined || busy === true) return;
    const nextCount = rerollCount + 1;
    setRerollCount(nextCount);
    if (nextCount >= 3 && !typeHintShown) setTypeHintShown(true);
    onSwap();
  };

  return (
    <article className="space-y-4 rounded-2xl border border-stone-200 bg-white p-6 shadow-sm sm:p-8">
      {/* 标题行：地点名 + 右侧星标（importance 未提供时星标整组不渲染，标题占满整行）。 */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <h2 className="text-2xl font-semibold tracking-tight text-stone-900 sm:text-3xl">
          {placeName}
        </h2>
        {importance !== undefined ? <ImportanceStars importance={importance} /> : null}
      </div>

      <p className="text-sm leading-6 text-stone-600">
        {buildDepartLine(departByText, commuteText)}
      </p>

      {/* 活动放在 reason 之前：它决定「要不要现在就去」，比「为什么是它」更有时效性。 */}
      {upcomingEvent !== null && upcomingEvent !== undefined ? (
        <UpcomingEventLine event={upcomingEvent} />
      ) : null}

      <Reason text={reason} />

      {/* 文案一行：信息层（评分·距离·人均）不变，只在它下面多这一行；比正文小一号、浅一档，
          不加引号 / 图标 / 背景。没有 oneLine 就整行不渲染，不留空位。 */}
      {oneLine !== undefined && oneLine !== "" ? (
        <p className="text-sm leading-6 text-stone-500">{oneLine}</p>
      ) : null}

      {showRestaurant ? <RestaurantCard arriveAtText={arriveAtText} meal={meal} /> : null}

      <div className="flex flex-wrap items-center gap-3">
        <a
          href={navigationUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 rounded-xl bg-stone-900 px-5 py-2.5 text-sm font-medium text-white transition duration-150 hover:bg-stone-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900 active:translate-y-px"
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
            className="h-4 w-4"
          >
            <path d="M3 11.5 21 3l-8.5 18-2-7.5-7.5-2Z" />
          </svg>
          导航
        </a>

        {/* M19：UI 暂时隐藏「换一个」（逻辑保留）。 */}
        {SHOW_SWAP_BUTTON ? (
          <button
            type="button"
            onClick={handleSwap}
          disabled={onSwap === undefined || busy === true}
          title={onSwap === undefined ? "「换一个」将在集成阶段接入页面" : undefined}
          className="inline-flex items-center gap-2 rounded-xl border border-stone-300 bg-white px-5 py-2.5 text-sm font-medium text-stone-700 transition duration-150 hover:bg-stone-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-white"
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
            className="h-4 w-4"
          >
            <path d="M7 4v16" />
            <path d="m3 8 4-4 4 4" />
            <path d="M17 20V4" />
            <path d="m13 16 4 4 4-4" />
          </svg>
            换一个
          </button>
        ) : null}

        {/* M7 次级入口：小号文字、负反馈。与「换一个」方向相反，后端会把类目权重 × 0.2。 */}
        <button
          type="button"
          onClick={onDislike}
          disabled={onDislike === undefined || busy === true}
          title={onDislike === undefined ? "「不感兴趣」将在集成阶段接入页面" : undefined}
          className="px-1 py-1 text-xs leading-5 text-stone-400 underline decoration-stone-300 underline-offset-4 transition duration-150 hover:text-stone-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-stone-400"
        >
          不感兴趣
        </button>
      </div>

      {/* M7 3.4：同一站连续换 3 次只提示一次，行内提示，不弹窗。 */}
      {typeHintShown ? (
        <p className="text-xs leading-5 text-stone-500">要不要换别的类型？</p>
      ) : null}
    </article>
  );
}
