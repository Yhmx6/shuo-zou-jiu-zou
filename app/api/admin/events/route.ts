import { NextResponse } from "next/server";
import { z } from "zod";
import {
  assertEventPlaceInCity,
  eventStatus,
  loadCityEvents,
  nextEventId,
  saveCityEvents,
  serverNow,
} from "@/lib/events";
import type { EventStatus } from "@/lib/events";
import { loadCity, loadCityConfig, resolveCityId } from "@/lib/cityData";
import { CityEventSchema } from "@/types/schema";
import type { CityEvent } from "@/types/schema";

/**
 * 本地活动管理后台的唯一后端入口（给 app/admin/page.tsx 的控制台调用，不是用户功能）。
 *
 * 数据层：data/cities/<city>.events.json（形状 { "events": CityEvent[] }），读写全部走
 * lib/events.ts（读盘过 zod、写盘临时文件 + rename 原子写），本文件只做 HTTP 契约：
 * - GET    ?city=<city>[&placeId=<id>] → 活动列表（带 placeName / 服务端算的 status）
 * - POST   { city, event }             → 新增（id 由服务端生成，placeId 必须属于该城市）
 * - PATCH  { city, id, patch }         → 修改（整体合并后再过一遍 CityEventSchema，id 不许改）
 * - DELETE { city, id }                → 删除
 *
 * 三条硬约束：
 * 1. 时间比较全部在服务端做（status 用 lib/events.ts 的 serverNow + eventStatus），
 *    前端只拿现成的 "upcoming" | "ongoing" | "ended"，用户机器时间不准也不会显示错；
 * 2. 任何写入前都过 CityEventSchema（types/schema.ts 冻结契约），不通过返回 400 + 逐字段错误；
 * 3. 活动关联的地点必须属于该城市（跨城市 / 地点不存在直接 400，文案可直接展示给后台用户）。
 *
 * 返回统一 JSON：
 * - 成功 { ok:true, ... }
 * - 失败 { ok:false, reason, errors?:[{ path, message }] }（400 / 404 / 500）
 * 口径与 /api/admin/places 保持一致，控制台可以复用同一套错误处理。
 */

export const dynamic = "force-dynamic";

/** 活动列表里额外带的展示字段（只出现在响应里，不写回数据文件）。 */
type AdminEvent = {
  id: string;
  placeId: string;
  /** 从该城市合并后的地点里查；地点被删 / 隐藏后旧活动仍保留，这里给占位文案 */
  placeName: string;
  title: string;
  /** 原样返回本地时间 "YYYY-MM-DDTHH:mm"，不做任何时区换算（比较已经在服务端算好） */
  startAt: string;
  endAt: string;
  note: string | null;
  /** 服务端按真实「现在」算：upcoming 未开始 / ongoing 进行中 / ended 已结束 */
  status: EventStatus;
};

type FieldIssue = { path: string; message: string };

/** 地点被删 / 被隐藏后旧活动允许留着，列表里用这个占位，不静默丢掉这条活动。 */
const PLACE_MISSING_NAME = "(地点已不存在)";

function failure(status: number, reason: string, errors?: FieldIssue[]) {
  return NextResponse.json(errors === undefined ? { ok: false as const, reason } : { ok: false as const, reason, errors }, {
    status,
  });
}

/** 把 zod 报错拆成「字段 → 原因」，给后台表单逐字段展示（不丢整个 ZodError）。 */
function fieldIssues(error: z.ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length === 0 ? "请求体" : issue.path.join("."),
    message: issue.message,
  }));
}

function describeIssues(error: z.ZodError): string {
  // CityEventSchema 的 refine 文案本身已经带字段名（「endAt 必须晚于 startAt」），
  // 这类不再重复拼 path，否则 reason 里会出现「endAt endAt 必须晚于 startAt」。
  return fieldIssues(error)
    .map((issue) => (issue.message.includes(issue.path) ? issue.message : `${issue.path} ${issue.message}`))
    .join("；");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 请求里的 city：缺省 / 空串 / 非法 / 不在城市索引里都直接抛错，由调用方转成 400。
 * 这里刻意不用 resolveCityId 的「不传就用默认城市」行为：后台写错文件比报错更难查。
 */
function requireCityId(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("缺少 city 参数（例如 city=liaoyang）");
  }
  return resolveCityId(raw.trim());
}

/**
 * note 的「没有该字段」语义（新增 / 修改共用）：
 * undefined、null、空串、纯空白都视为没填，返回 undefined 让调用方删字段；
 * 非空备注去掉首尾空白后原样保存（备注只做展示，不做任何加工 / 截断）。
 */
function normalizeNote(raw: string | null | undefined): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** 列表排序：startAt 升序（同格式定长字符串，字典序即时间序），同一时间按 id 升序。 */
function compareEvents(a: CityEvent, b: CityEvent): number {
  if (a.startAt !== b.startAt) return a.startAt < b.startAt ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/** 数据层 CityEvent → 后台列表项：补 placeName（查不到给占位）+ 服务端算的 status。 */
function toAdminEvent(
  event: CityEvent,
  placeNameById: ReadonlyMap<string, string>,
  now: Date,
): AdminEvent {
  return {
    id: event.id,
    placeId: event.placeId,
    placeName: placeNameById.get(event.placeId) ?? PLACE_MISSING_NAME,
    title: event.title,
    startAt: event.startAt,
    endAt: event.endAt,
    // 数据层 note 是可选的；响应契约固定 string | null，前端不用再判断 undefined
    note: event.note === undefined || event.note === "" ? null : event.note,
    status: eventStatus(event, now),
  };
}

/** 合并后的 placeId → name 映射（loadCity 已按 manual 层覆盖过，含隐藏点）。 */
function placeNameIndex(cityId: string): Map<string, string> {
  return new Map(loadCity(cityId).places.map((place) => [place.id, place.name]));
}

/* ------------------------------------------------------------------ *
 * 请求体契约
 * ------------------------------------------------------------------ */

/** 备注上限与 CityEventSchema 一致（500 字）；null / 缺省 = 没有备注。 */
const NoteInputSchema = z.string().max(500, "备注最多 500 字").nullable().optional();

/**
 * 新增时的活动入参：只让后台填「活动本身」的字段。
 * id / status 由服务端生成，不接受前端伪造（.strict() 会把多余字段当错误拒掉）。
 * startAt / endAt 这里只要求是字符串，格式 / 真实日期 / endAt > startAt 统一交给
 * CityEventSchema 校验（错误文案只维护一份，避免两处规则漂移）。
 */
const EventInputSchema = z
  .object({
    placeId: z.string().min(1, "placeId 不能为空"),
    title: z.string().min(1, "标题不能为空").max(120, "标题最多 120 字"),
    startAt: z.string().min(1, "startAt 不能为空"),
    endAt: z.string().min(1, "endAt 不能为空"),
    note: NoteInputSchema,
  })
  .strict();

const CreateRequestSchema = z
  .object({
    city: z.string().min(1, "city 不能为空"),
    event: EventInputSchema,
  })
  .strict();

/** 修改：所有可编辑字段都可选，但 patch 不能为空；id 不允许改（.strict() 直接拒掉 id）。 */
const EventPatchSchema = z
  .object({
    placeId: z.string().min(1, "placeId 不能为空").optional(),
    title: z.string().min(1, "标题不能为空").max(120, "标题最多 120 字").optional(),
    startAt: z.string().min(1, "startAt 不能为空").optional(),
    endAt: z.string().min(1, "endAt 不能为空").optional(),
    note: NoteInputSchema,
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: "patch 不能为空" });

const PatchRequestSchema = z
  .object({
    city: z.string().min(1, "city 不能为空"),
    id: z.string().min(1, "id 不能为空"),
    patch: EventPatchSchema,
  })
  .strict();

const DeleteRequestSchema = z
  .object({
    city: z.string().min(1, "city 不能为空"),
    id: z.string().min(1, "id 不能为空"),
  })
  .strict();

/** 读 JSON 请求体；不是合法 JSON 返回 null（由调用方回 400）。 */
async function readJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * GET：活动列表
 * ------------------------------------------------------------------ */

export async function GET(request: Request) {
  const url = new URL(request.url);

  let cityId: string;
  try {
    cityId = requireCityId(url.searchParams.get("city"));
  } catch (error) {
    return failure(400, errorMessage(error));
  }

  // placeId 是可选过滤条件：只查某个地点的活动。空串按「不过滤」处理（控制台清空输入框即全量）。
  const placeIdFilter = (url.searchParams.get("placeId") ?? "").trim();

  try {
    // 先读地点 / 配置再读活动：文件坏都会抛错，由下面的 catch 统一转 500。
    const config = loadCityConfig(cityId);
    const placeNameById = placeNameIndex(cityId);
    const events = loadCityEvents(cityId);
    const now = serverNow();

    const filtered =
      placeIdFilter === "" ? events : events.filter((event) => event.placeId === placeIdFilter);
    // 每次请求现算 status：不缓存，避免列表里出现已经过期的「即将开始」。
    const list = filtered
      .slice()
      .sort(compareEvents)
      .map((event) => toAdminEvent(event, placeNameById, now));

    return NextResponse.json({
      ok: true as const,
      city: cityId,
      displayName: config.displayName,
      total: list.length,
      events: list,
    });
  } catch (error) {
    const message = errorMessage(error);
    console.error(`[api/admin/events] GET 失败：${message}`);
    return failure(500, `读取活动数据失败：${message}`);
  }
}

/* ------------------------------------------------------------------ *
 * POST：新增活动
 * ------------------------------------------------------------------ */

export async function POST(request: Request) {
  const payload = await readJsonBody(request);
  if (payload === null) return failure(400, "请求体不是合法 JSON");

  const parsed = CreateRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return failure(400, `请求参数不合法：${describeIssues(parsed.error)}`, fieldIssues(parsed.error));
  }
  const body = parsed.data;

  let cityId: string;
  try {
    cityId = requireCityId(body.city);
  } catch (error) {
    return failure(400, errorMessage(error));
  }

  try {
    // 写盘前先把读操作全部做完：任何一项失败都不会留下半成品。
    const events = loadCityEvents(cityId);
    const placeNameById = placeNameIndex(cityId);

    const note = normalizeNote(body.event.note);
    const candidate = {
      id: nextEventId(events),
      placeId: body.event.placeId,
      title: body.event.title,
      startAt: body.event.startAt,
      endAt: body.event.endAt,
      // 没填备注就干脆不带该字段：文件里保持 { ... } 干净，读取侧统一按 undefined 处理
      ...(note === undefined ? {} : { note }),
    };

    const validated = CityEventSchema.safeParse(candidate);
    if (!validated.success) {
      return failure(400, `活动参数不合法：${describeIssues(validated.error)}`, fieldIssues(validated.error));
    }
    const event = validated.data;

    // 关联地点必须属于该城市（跨城市 / 地点不存在 → 400，文案可直接展示）。
    // 上面 loadCity 已经在本请求里成功读过，这里 assert 再抛错只可能是「地点不属于该城市」，
    // 所以按请求方错误返回 400；真正的数据层错误在更早的 loadCity 就会走 500。
    try {
      assertEventPlaceInCity(cityId, event.placeId);
    } catch (error) {
      const message = errorMessage(error);
      return failure(400, message, [{ path: "event.placeId", message }]);
    }

    // 写回整份列表（数据层会再校验一次并原子写盘）；返回值是落盘后的数组。
    const saved = saveCityEvents(cityId, [...events, event]);
    const created = saved.find((item) => item.id === event.id) ?? event;

    return NextResponse.json({
      ok: true as const,
      city: cityId,
      event: toAdminEvent(created, placeNameById, serverNow()),
    });
  } catch (error) {
    const message = errorMessage(error);
    console.error(`[api/admin/events] POST 失败：${message}`);
    return failure(500, `新增活动失败：${message}`);
  }
}

/* ------------------------------------------------------------------ *
 * PATCH：修改活动
 * ------------------------------------------------------------------ */

export async function PATCH(request: Request) {
  const payload = await readJsonBody(request);
  if (payload === null) return failure(400, "请求体不是合法 JSON");

  const parsed = PatchRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return failure(400, `请求参数不合法：${describeIssues(parsed.error)}`, fieldIssues(parsed.error));
  }
  const body = parsed.data;
  const patch = body.patch;

  let cityId: string;
  try {
    cityId = requireCityId(body.city);
  } catch (error) {
    return failure(400, errorMessage(error));
  }

  try {
    const events = loadCityEvents(cityId);
    const index = events.findIndex((event) => event.id === body.id);
    if (index === -1) {
      return failure(404, `找不到活动：${body.id}（城市 ${cityId}）`);
    }
    const existing = events[index];
    const placeNameById = placeNameIndex(cityId);

    // 合并语义：patch 里显式出现的字段才覆盖；id 不允许改（请求体 schema 已拒掉）。
    const merged: Record<string, unknown> = { ...existing };
    if (patch.placeId !== undefined) merged.placeId = patch.placeId;
    if (patch.title !== undefined) merged.title = patch.title;
    if (patch.startAt !== undefined) merged.startAt = patch.startAt;
    if (patch.endAt !== undefined) merged.endAt = patch.endAt;
    if (patch.note !== undefined) {
      // 显式 note:null / "" / 空白 = 清空（把字段删掉）；没传 note 才会保留原备注。
      const note = normalizeNote(patch.note);
      if (note === undefined) {
        delete merged.note;
      } else {
        merged.note = note;
      }
    }

    // 整体合并后再过 CityEventSchema：只改 startAt 也可能让 endAt <= startAt，必须整条重新校验。
    const validated = CityEventSchema.safeParse(merged);
    if (!validated.success) {
      return failure(400, `活动参数不合法：${describeIssues(validated.error)}`, fieldIssues(validated.error));
    }
    const updated = validated.data;

    // 只有改关联地点时才重新做城市归属校验：老活动指向的地点后来被删掉时，
    // 仍然允许编辑标题 / 时间，不然这条数据就再也改不动了。
    if (patch.placeId !== undefined) {
      try {
        assertEventPlaceInCity(cityId, updated.placeId);
      } catch (error) {
        const message = errorMessage(error);
        return failure(400, message, [{ path: "patch.placeId", message }]);
      }
    }

    const nextEvents = events.slice();
    nextEvents[index] = updated;
    const saved = saveCityEvents(cityId, nextEvents);
    const result = saved.find((item) => item.id === body.id) ?? updated;

    return NextResponse.json({
      ok: true as const,
      city: cityId,
      event: toAdminEvent(result, placeNameById, serverNow()),
    });
  } catch (error) {
    const message = errorMessage(error);
    console.error(`[api/admin/events] PATCH 失败：${message}`);
    return failure(500, `修改活动失败：${message}`);
  }
}

/* ------------------------------------------------------------------ *
 * DELETE：删除活动
 * ------------------------------------------------------------------ */

export async function DELETE(request: Request) {
  const payload = await readJsonBody(request);
  if (payload === null) return failure(400, "请求体不是合法 JSON");

  const parsed = DeleteRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return failure(400, `请求参数不合法：${describeIssues(parsed.error)}`, fieldIssues(parsed.error));
  }
  const body = parsed.data;

  let cityId: string;
  try {
    cityId = requireCityId(body.city);
  } catch (error) {
    return failure(400, errorMessage(error));
  }

  try {
    const events = loadCityEvents(cityId);
    const index = events.findIndex((event) => event.id === body.id);
    if (index === -1) {
      return failure(404, `找不到活动：${body.id}（城市 ${cityId}）`);
    }

    const nextEvents = events.slice();
    nextEvents.splice(index, 1);
    // 允许删到空数组并落盘 { "events": [] }：活动文件是独立层，空列表是合法状态。
    saveCityEvents(cityId, nextEvents);

    return NextResponse.json({ ok: true as const, city: cityId, id: body.id });
  } catch (error) {
    const message = errorMessage(error);
    console.error(`[api/admin/events] DELETE 失败：${message}`);
    return failure(500, `删除活动失败：${message}`);
  }
}
