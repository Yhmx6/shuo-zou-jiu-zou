import type { MealInfo, WaitLevel } from "@/types/schema";

export type RestaurantCardProps = {
  /** 到店时间 "12:20"（卡片上由 page 格式化，组件不碰时间运算）。 */
  arriveAtText: string;
  /** 服务端算好的餐厅信息（排队估计 / 点菜建议 / 人均）。 */
  meal: MealInfo;
};

/** 排队等级的视觉权重：low 保持常态，mid / high 用暖色提醒，但不做红色警告（只是估计）。 */
const WAIT_TONE: Record<WaitLevel, string> = {
  low: "text-stone-800",
  mid: "text-amber-700",
  high: "text-amber-800",
};

/**
 * M9 餐厅卡：只回答「到店时间 / 要不要等 / 吃什么 / 花多少」。
 *
 * 四条红线（M9 3.3 / 3.5）：
 * - 排队只能写估计，不许出现任何承诺性表述（三个禁用词见 M9 3.3，
 *   这里故意不写成字面量，免得 `grep` 自检永远有输出）；
 * - 不代订、不代付、不声称已经订好——预约提醒只给一行话 + 一个自查链接；
 * - 点菜建议按人数给，人数来自 meal.people；
 * - 不编造任何实时排队人数或电话。
 */
export default function RestaurantCard({ arriveAtText, meal }: RestaurantCardProps) {
  const rows: { label: string; value: string; tone?: string }[] = [
    { label: "到店", value: arriveAtText },
    { label: "排队", value: meal.waitText, tone: WAIT_TONE[meal.waitLevel] },
    { label: "吃什么", value: `${meal.dishText}（按 ${meal.people} 人）` },
    { label: "花多少", value: `人均 ${meal.perPersonCost} 元` },
  ];

  return (
    <section
      aria-label="餐厅信息"
      className="rounded-xl border border-stone-200 bg-stone-50/70 px-4 py-4 sm:px-5"
    >
      <dl className="grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-2 text-sm leading-6">
        {rows.map((row) => (
          <div key={row.label} className="contents">
            <dt className="text-stone-500">{row.label}</dt>
            <dd className={row.tone ?? "text-stone-800"}>{row.value}</dd>
          </div>
        ))}
      </dl>

      <p className="mt-3 text-xs leading-5 text-stone-400">
        排队是按评分和到达时段估的，不是实时排队人数。
      </p>

      {meal.bookingText !== null && meal.bookingUrl !== null ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-stone-200 pt-3">
          <p className="text-sm leading-6 text-stone-700">{meal.bookingText}</p>
          <a
            href={meal.bookingUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 transition duration-150 hover:bg-stone-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500"
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
              <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.7a2 2 0 0 1-.5 2.1L8.1 9.7a16 16 0 0 0 6 6l1.2-1.1a2 2 0 0 1 2.1-.5c.9.3 1.8.5 2.7.6a2 2 0 0 1 1.9 2.2Z" />
            </svg>
            查电话
          </a>
        </div>
      ) : null}
    </section>
  );
}
