"use client";

import { useState } from "react";
import { CARD_HEIGHT, CARD_WIDTH, exportRouteCardPng } from "@/lib/exportCard";
import type { Itinerary } from "@/types/schema";

/**
 * M11：路线卡片导出入口。
 *
 * 位置：app/page.tsx 里第一站卡片的下面（「保存这一天的卡片」按钮）。
 * 点击 → lib/exportCard.ts 用 canvas 2D 手绘一张 1080×1920 的 PNG（无瓦片、无截图库）
 *      → canvas.toDataURL("image/png") → <a download> 触发下载 / 保存。
 *
 * 组件只负责「按钮 + 状态提示」：
 * - 正在生成时按钮禁用，防止连点导出多张；
 * - 导出成功显示文件名和实际尺寸（尺寸由 canvas.width / height 返回，不写死文案）；
 * - 失败把原因原样显示（例如浏览器拿不到 canvas 2D 上下文），不静默失败。
 *
 * 输入是完整 Itinerary 与城市显示名：城市名从 /api/cities 的城市配置读出来（杭州 / 辽阳），
 * 组件和 lib 都不硬编码城市。
 */

export type RouteCardProps = {
  /** 当前这份行程（换站后会换成新的对象，每次点击都按最新的画）。 */
  itinerary: Itinerary;
  /** 城市显示名（来自城市配置），显示在卡片右下角。 */
  cityName: string;
};

type ExportState =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "done"; fileName: string; width: number; height: number }
  | { kind: "failed"; message: string };

export default function RouteCard({ itinerary, cityName }: RouteCardProps) {
  const [state, setState] = useState<ExportState>({ kind: "idle" });

  const handleExport = async () => {
    if (state.kind === "working") return;
    setState({ kind: "working" });

    // 先让「正在生成…」这一帧渲染出来，画布绘制本身是同步的（1080×1920 一次约几十毫秒）。
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => {
        resolve();
      });
    });

    try {
      const result = exportRouteCardPng({ itinerary, cityName, date: new Date() });
      setState({
        kind: "done",
        fileName: result.fileName,
        width: result.width,
        height: result.height,
      });
    } catch (error) {
      setState({
        kind: "failed",
        message: error instanceof Error ? error.message : "未知原因",
      });
    }
  };

  const working = state.kind === "working";

  return (
    <section className="rounded-2xl border border-stone-200 bg-white p-5">
      <button
        type="button"
        data-testid="export-card-button"
        onClick={() => {
          void handleExport();
        }}
        disabled={working}
        className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-stone-300 bg-white px-5 py-3 text-sm font-medium text-stone-700 transition duration-150 hover:bg-stone-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-white"
      >
        {/* 下载图标：内联 SVG（00-common 铁律 11：不用 emoji 当功能图标）。 */}
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
          <path d="M12 3v12" />
          <path d="m7 10 5 5 5-5" />
          <path d="M4 21h16" />
        </svg>
        {working ? "正在生成…" : "保存这一天的卡片"}
      </button>

      <p className="mt-2 text-center text-xs leading-5 text-stone-400">
        {CARD_WIDTH} × {CARD_HEIGHT} 竖版 PNG，存进相册或者发给朋友
      </p>

      {state.kind === "done" ? (
        <p role="status" className="mt-2 text-center text-xs leading-5 text-stone-500">
          已导出 {state.fileName}（{state.width} × {state.height}）
        </p>
      ) : null}

      {state.kind === "failed" ? (
        <p role="alert" className="mt-2 text-center text-xs leading-5 text-stone-600">
          卡片没生成出来：{state.message}
        </p>
      ) : null}
    </section>
  );
}
