import { existsSync } from "node:fs";
import { z } from "zod";
import { CityEventSchema } from "../types/schema";
import type { CityEvent, StopEvent } from "../types/schema";
import { cityEventsFilePath, loadCity, readJsonFile, writeJsonFileAtomic } from "./cityData";

/**
 * 活动数据层（本轮新增）：data/cities/<city>.events.json
 *
 * 文件的形状固定为 `{ "events": CityEvent[] }`（契约见 types/schema.ts 的 CityEventSchema）：
 * - startAt / endAt 一律是「本地时间、不带时区」的 "YYYY-MM-DDTHH:mm"，跨天活动也能表达；
 * - 时间比较全部在本文件里做（服务端 / 离线脚本），前端只拿格式化好的字段渲染，
 *   因为用户机器时间可能不准（本轮铁律）；
 * - 活动**不参与排程**：本文件只被 /api/admin/events（增删改查）和 /api/plan、/api/swap
 *   （附加展示字段）调用，planner 完全看不见这些数据。
 *
 * 硬约束（与 lib/cityData.ts 同一套）：
 * 1. 读盘结果必须过 zod，校验失败直接抛错，不返回半成品；
 * 2. 写入走临时文件 + rename 原子写；
 * 3. 活动关联的 placeId 必须属于该城市（assertEventPlaceInCity，跨城市直接拒绝）；
 * 4. 文件不存在 = 该城市还没有活动（合法），返回空数组。
 */

/** 活动文件整体形状：只允许一个 events 数组。 */
export const CityEventsFileSchema = z
  .object({
    events: z.array(CityEventSchema),
  })
  .strict();
export type CityEventsFile = z.infer<typeof CityEventsFileSchema>;

/** 卡片上「现在或即将开始」的匹配窗口（分钟）：startAt < 现在 + 4 小时。 */
export const UPCOMING_EVENT_WINDOW_MIN = 240;

/** 把 zod 报错拼成一句人话（字段名 + 原因），不把整个 ZodError 丢给调用方。 */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length === 0 ? "根" : issue.path.join(".")} ${issue.message}`)
    .join("；");
}

/** 活动 id 不允许重复：增删改都会变得不确定。 */
function assertUniqueEventIds(events: CityEvent[], filePath: string): void {
  const seen = new Set<string>();
  for (const event of events) {
    if (seen.has(event.id)) {
      throw new Error(`活动 id 重复：${JSON.stringify(event.id)}（文件：${filePath}）`);
    }
    seen.add(event.id);
  }
}

/**
 * 读一个城市的活动列表 data/cities/<city>.events.json。
 * - 文件不存在 = 合法（还没录过活动），返回空数组；
 * - 文件存在但 JSON 坏 / zod 不通过 / id 重复 → 直接抛错（不静默丢数据）。
 * 返回新数组，调用方改它不会污染任何缓存（活动文件每次从盘上读，不缓存）。
 *
 * 注意：这里**不校验 placeId 是否还存在**——地点被删 / 隐藏后旧活动允许留着，
 * 展示时按 placeId 关联不上自然不出现；新增 / 修改活动时由 API 调 assertEventPlaceInCity 校验。
 */
export function loadCityEvents(cityId: string): CityEvent[] {
  const filePath = cityEventsFilePath(cityId);
  if (!existsSync(filePath)) return [];
  const raw = readJsonFile(filePath, "活动数据");
  const parsed = CityEventsFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`活动数据校验失败：${filePath}：${describeIssues(parsed.error)}`);
  }
  assertUniqueEventIds(parsed.data.events, filePath);
  return parsed.data.events.slice();
}

/**
 * 写一个城市的活动列表（整份覆盖：后台每次都是「读全量 → 改 → 写回」）。
 * 写盘前过 CityEventsFileSchema；临时文件 + rename 原子写。
 */
export function saveCityEvents(cityId: string, events: CityEvent[]): CityEvent[] {
  const filePath = cityEventsFilePath(cityId);
  const parsed = CityEventsFileSchema.safeParse({ events });
  if (!parsed.success) {
    throw new Error(`活动数据校验失败（未写盘）：${describeIssues(parsed.error)}`);
  }
  assertUniqueEventIds(parsed.data.events, filePath);
  writeJsonFileAtomic(filePath, { events: parsed.data.events });
  return parsed.data.events.slice();
}

/**
 * 生成下一个活动 id：沿用契约示例的 "evt_001" 形态，取现有最大序号 +1。
 * 连续删掉最后一条后会复用编号，但编号只要求「当前文件内不重复」，不要求全局单调。
 */
export function nextEventId(events: CityEvent[]): string {
  let max = 0;
  for (const event of events) {
    const match = /^evt_(\d+)$/.exec(event.id);
    if (match === null) continue;
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > max) max = value;
  }
  return `evt_${String(max + 1).padStart(3, "0")}`;
}

/**
 * 活动关联的地点必须属于该城市（跨城市直接拒绝，本轮铁律）。
 * 找不到时抛一句能直接展示的人话；调用方（API 层）转成 400。
 */
export function assertEventPlaceInCity(cityId: string, placeId: string): void {
  const city = loadCity(cityId);
  if (!city.places.some((place) => place.id === placeId)) {
    throw new Error(`活动关联的地点不属于该城市：placeId=${placeId}（城市 ${cityId}）`);
  }
}

/* ------------------------------------------------------------------ *
 * 时间比较 / 匹配（全部在服务端）
 * ------------------------------------------------------------------ */

/**
 * "YYYY-MM-DDTHH:mm" → 本地 Date。
 * 不用 new Date(string)：显式按本地时区构造，避免任何解析歧义；格式先过 zod 再进这里。
 */
export function parseLocalDateTime(text: string): Date {
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(5, 7));
  const day = Number(text.slice(8, 10));
  const hour = Number(text.slice(11, 13));
  const minute = Number(text.slice(14, 16));
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

/** 本地 Date → "HH:mm"。 */
export function formatClock(date: Date): string {
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${hour}:${minute}`;
}

/** 活动状态（服务端按真实「现在」算）：upcoming 未开始 / ongoing 进行中 / ended 已结束。 */
export type EventStatus = "upcoming" | "ongoing" | "ended";

export function eventStatus(event: CityEvent, now: Date): EventStatus {
  if (now.getTime() >= parseLocalDateTime(event.endAt).getTime()) return "ended";
  if (now.getTime() >= parseLocalDateTime(event.startAt).getTime()) return "ongoing";
  return "upcoming";
}

/**
 * 构造「行程里的现在」：服务器本地日期 + 当日分钟数。
 * 与 /api/plan 的 nowMinute 同一口径（15:20 → 920），保证卡片文案和行程里的「现在是 15:20」一致。
 */
export function referenceDateFromMinute(minuteOfDay: number): Date {
  const now = new Date();
  const safe = Math.max(0, Math.min(1439, Math.floor(minuteOfDay)));
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(safe / 60), safe % 60, 0, 0);
}

/** 服务器真实「现在」（后台列表的状态判定用它）。 */
export function serverNow(): Date {
  return new Date();
}

/** 备注取第一句（「票价 80-180，大麦有售」→「票价 80-180」）；空备注 → null。 */
export function noteFirstClause(note: string | undefined): string | null {
  if (note === undefined) return null;
  const first = note.split(/[，,。；;：:\n]/)[0].trim();
  if (first === "") return null;
  // 卡片只有一行，超长截断到 30 字（不编造内容，只是截断）。
  return first.slice(0, 30);
}

/** 活动开始日期相对「现在」的标签：今天 / 明天（4 小时窗口最多跨到明天）。 */
function dayLabelFor(startAt: Date, now: Date): "今天" | "明天" {
  const startDay = new Date(startAt.getFullYear(), startAt.getMonth(), startAt.getDate()).getTime();
  const nowDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return startDay > nowDay ? "明天" : "今天";
}

/**
 * 给一组地点挑出「现在或即将开始」的活动，按 placeId 建映射（每个地点最多一个）。
 *
 * 匹配规则（本轮需求原文）：
 * - 该地点的活动存在；
 * - endAt > 现在；
 * - startAt < 现在 + 4 小时。
 *
 * 同一个地点命中多条时：进行中的优先，其次开始时间最早的。已结束的活动永不返回。
 * 返回的是给站点卡片用的 StopEventSchema 快照（时间已格式化成 "HH:mm"，前端不再比较时间）。
 */
export function findUpcomingEventsForPlaces(
  cityId: string,
  placeIds: ReadonlyArray<string>,
  referenceMinuteOfDay: number,
): Map<string, StopEvent> {
  const wanted = new Set(placeIds);
  const result = new Map<string, StopEvent>();
  if (wanted.size === 0) return result;

  const now = referenceDateFromMinute(referenceMinuteOfDay);
  const windowEndMs = now.getTime() + UPCOMING_EVENT_WINDOW_MIN * 60_000;

  for (const event of loadCityEvents(cityId)) {
    if (!wanted.has(event.placeId)) continue;
    const start = parseLocalDateTime(event.startAt);
    const end = parseLocalDateTime(event.endAt);
    if (end.getTime() <= now.getTime()) continue;
    if (start.getTime() >= windowEndMs) continue;

    const status: "upcoming" | "ongoing" = start.getTime() <= now.getTime() ? "ongoing" : "upcoming";
    const candidate: StopEvent = {
      id: event.id,
      title: event.title,
      startAtText: formatClock(start),
      endAtText: formatClock(end),
      status,
      dayLabel: dayLabelFor(start, now),
      noteLine: noteFirstClause(event.note),
    };

    const current = result.get(event.placeId);
    if (current === undefined) {
      result.set(event.placeId, candidate);
      continue;
    }
    // 进行中优先；同状态取开始更早的那条。
    const currentRank = current.status === "ongoing" ? 0 : 1;
    const candidateRank = candidate.status === "ongoing" ? 0 : 1;
    if (
      candidateRank < currentRank ||
      (candidateRank === currentRank && candidate.startAtText < current.startAtText)
    ) {
      result.set(event.placeId, candidate);
    }
  }
  return result;
}
