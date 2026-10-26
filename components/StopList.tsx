"use client";

import { useState } from "react";
import type { StopEvent } from "@/types/schema";

/**
 * 重要性星级 1–5（本轮新增展示字段）：与 FirstStopCard 同一口径，
 * 服务端 zod 已收紧到 1–5，这里再写成字面量联合类型让越界值编译期过不去。
 */
export type Importance = 1 | 2 | 3 | 4 | 5;

export type StopListStop = {
  id: string;
  name: string;
  arriveAtText: string;
  leaveAtText: string;
  /** 地点重要性 1–5（可选，服务端带下来；未提供 = 没标星，不渲染星标）。 */
  importance?: Importance;
  /** 现在 / 即将开始的活动（可选，服务端带下来；未提供 = 没有活动，不占位）。 */
  upcomingEvent?: StopEvent;
  /**
   * 文案接线（本轮新增可选字段）：服务端给这一站写的一句文案。
   * 有就在名称/时间行下面加一行小字；没有就不渲染、不占位。
   */
  oneLine?: string;
};

export type StopListProps = {
  stops: StopListStop[];
  /**
   * M7 主入口「换一个」：只替换这一站（index 是 stops 数组下标）。
   * 不传时按钮禁用——页面接线在集成阶段做，M7 只负责把入口加出来。
   */
  onSwap?: (index: number) => void;
  /**
   * M7 次级入口「不感兴趣」：和「换一个」信号方向相反，后端会把该类目权重 × 0.2
   * （仅本次会话内存）。不传时按钮禁用。
   */
  onDislike?: (index: number) => void;
  /** 正在调 /api/swap：按钮暂时禁用，防止重复提交。 */
  busy?: boolean;
};

type RerollHintState = { rerolls: number; hintShown: boolean };

/** 五角星路径（viewBox 24×24）：与 FirstStopCard 同一形状，实心 / 描边共用。 */
const STAR_PATH =
  "M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8L3.5 9.7l5.9-.9L12 3.5Z";

/**
 * 小号重要性星（本轮新增）：每行地点名旁边 5 颗 14px 的内联 SVG，
 * 前 importance 颗实心（fill=currentColor，深色）、其余描边（stroke=currentColor，浅灰）。
 * 和第一站卡片同款，只是小一号——列表里不该抢正文的视线。
 */
function SmallImportanceStars({ importance }: { importance: Importance }) {
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
            className={filled ? "h-3.5 w-3.5 text-stone-900" : "h-3.5 w-3.5 text-stone-300"}
          >
            <path d={STAR_PATH} />
          </svg>
        );
      })}
    </span>
  );
}

/**
 * 活动小字文案（本轮新增）：模板与 FirstStopCard.buildEventLine 完全一致——
 * 「19:00 有场话剧《雷雨》，票价 80-180」，跨天前面补「明天 」。
 * 本轮只允许改这三个文件、不新增共享文件，所以就地复制一份；改文案时两处一起改。
 */
function buildEventLine(event: StopEvent): string {
  const dayPrefix = event.dayLabel === "明天" ? "明天 " : "";
  const noteSuffix = event.noteLine === null ? "" : `，${event.noteLine}`;
  return `${dayPrefix}${event.startAtText} 有场${event.title}${noteSuffix}`;
}

/**
 * 后续站点：默认折叠成一行，避免首屏变成一份时刻表。
 * 用原生 <details>（没有 open 属性）实现，无需额外状态。
 *
 * M7：每一站加两个入口——主按钮「换一个」+ 次级小字「不感兴趣」；
 * 同一站连续换 3 次，行内提示一次「要不要换别的类型？」（不弹窗，不再出现）。
 *
 * 本轮追加（站点展示字段）：每行地点名旁加小号重要性星，地点名 / 时间下方加一行活动小字；
 * 两个字段都是可选的，没有就不渲染、不占位（列表默认折叠，信息密度不能再涨）。
 */
/**
 * M19：UI 上暂时隐藏「换一个」，只隐藏渲染、不删逻辑（/api/swap、replaceStop、距离带、
 * onSwap / onDislike props 全部保留）。等环线形状稳定后改成 true 即可放出来。
 * 同名的三个开关：本文件、components/FirstStopCard.tsx、app/page.tsx（展开层）。
 */
const SHOW_SWAP_BUTTON = false;

export default function StopList({ stops, onSwap, onDislike, busy }: StopListProps) {
  // 按「这一站在列表里的位置」记连续换的次数：换完后 placeId 会变，但站的位置不变。
  const [rerollHints, setRerollHints] = useState<Record<number, RerollHintState>>({});

  const handleSwap = (index: number) => {
    if (onSwap === undefined || busy === true) return;
    setRerollHints((previous) => {
      const current = previous[index] ?? { rerolls: 0, hintShown: false };
      const rerolls = current.rerolls + 1;
      return {
        ...previous,
        [index]: { rerolls, hintShown: current.hintShown || rerolls >= 3 },
      };
    });
    onSwap(index);
  };

  if (stops.length === 0) return null;

  return (
    <details className="rounded-2xl border border-stone-200 bg-white">
      <summary className="cursor-pointer px-5 py-4 text-sm font-medium text-stone-700 marker:text-stone-400">
        之后还有 {stops.length} 个地方
      </summary>

      <ul className="divide-y divide-stone-100 border-t border-stone-200">
        {stops.map((stop, index) => (
          <li key={stop.id} className="px-5 py-3 text-sm">
            <div className="flex items-baseline justify-between gap-4">
              <span className="flex flex-wrap items-center gap-1.5 font-medium text-stone-800">
                {stop.name}
                {/* 有 importance 才画星；没标星的点不占位。 */}
                {stop.importance !== undefined ? (
                  <SmallImportanceStars importance={stop.importance} />
                ) : null}
              </span>
              <span className="shrink-0 tabular-nums text-stone-500">
                {`${stop.arriveAtText}–${stop.leaveAtText}`}
              </span>
            </div>

            {/* 文案一行：名称/时间（信息层）下面多一行；列表正文是 text-sm，这里小一号用 text-xs、
                浅一档 stone-500，不加引号 / 图标 / 背景。没有 oneLine 就整行不渲染。 */}
            {stop.oneLine !== undefined && stop.oneLine !== "" ? (
              <p className="mt-1 text-xs leading-5 text-stone-500">{stop.oneLine}</p>
            ) : null}

            {/* 活动一行：地点名 / 时间下面加小字，没有活动就不渲染这一行。 */}
            {stop.upcomingEvent !== undefined ? (
              <p className="mt-1 flex items-start gap-1.5 text-xs leading-5 text-stone-600">
                <svg
                  aria-hidden="true"
                  focusable="false"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stone-500"
                >
                  <rect x="3" y="4" width="18" height="17" rx="2" />
                  <path d="M8 2v4" />
                  <path d="M16 2v4" />
                  <path d="M3 10h18" />
                </svg>
                <span>{buildEventLine(stop.upcomingEvent)}</span>
              </p>
            ) : null}

            <div className="mt-2 flex flex-wrap items-center gap-3">
              {/* M19：UI 暂时隐藏「换一个」（逻辑保留）。 */}
              {SHOW_SWAP_BUTTON ? (
              <button
                type="button"
                onClick={() => handleSwap(index)}
                disabled={onSwap === undefined || busy === true}
                title={onSwap === undefined ? "「换一个」将在集成阶段接入页面" : undefined}
                className="inline-flex items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 transition duration-150 hover:bg-stone-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-white"
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
                  <path d="M7 4v16" />
                  <path d="m3 8 4-4 4 4" />
                  <path d="M17 20V4" />
                  <path d="m13 16 4 4 4-4" />
                </svg>
                换一个
              </button>
              ) : null}

              <button
                type="button"
                onClick={() => {
                  if (onDislike !== undefined && busy !== true) onDislike(index);
                }}
                disabled={onDislike === undefined || busy === true}
                title={onDislike === undefined ? "「不感兴趣」将在集成阶段接入页面" : undefined}
                className="text-xs leading-5 text-stone-400 underline decoration-stone-300 underline-offset-4 transition duration-150 hover:text-stone-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-stone-400"
              >
                不感兴趣
              </button>
            </div>

            {rerollHints[index]?.hintShown ? (
              <p className="mt-2 text-xs leading-5 text-stone-500">要不要换别的类型？</p>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}
