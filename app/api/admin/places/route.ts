import { NextResponse } from "next/server";
import { z } from "zod";
import { geocode } from "@/lib/amap";
import {
  ManualPlaceEntrySchema,
  loadCity,
  loadCityConfig,
  loadMainCityData,
  loadManualPlaces,
  resolveCityId,
  saveManualPlaces,
} from "@/lib/cityData";
import type { ManualPlaceEntry } from "@/lib/cityData";
import { PlaceCategorySchema, PlaceSchema, SceneryTagSchema } from "@/types/schema";
import type { Place } from "@/types/schema";

/**
 * 本地地点管理后台的唯一后端入口（给 app/admin/page.tsx 用，不是用户功能）。
 *
 * 数据分两层（见 lib/cityData.ts）：
 * - data/cities/<city>.json         自动采集层，scripts/fetch-seed.ts 会整份重写；
 * - data/cities/<city>.manual.json  手工维护层，fetch:seed 永远不碰，只由本路由写。
 *
 * 写入规则（本轮起 manual 层是「部分字段覆盖」）：
 * - 新增 → 只写 manual.json（完整 Place，手工新增点必须完整）；
 * - 修改主文件来源的点 → manual.json 只写「改动字段」的最小覆盖（如 { id, importance }），不抄整条；
 * - 修改手工新增点 → 写完整 Place；
 * - 删除 manual 里的点 → 真删（主文件点的同 id 条目删除后 = 恢复自动采集版本，也是「取消覆盖」的入口）；
 * - 删除主文件里的点 → 不真删（下次 fetch:seed 会回来），在 manual.json 写一条 { id, hidden: true } 覆盖。
 *
 * 三条硬约束：
 * 1. 任何写入前都过 PlaceSchema（types/schema.ts 冻结契约），不通过返回 400 + 逐字段错误；
 * 2. 写盘走 lib/cityData.ts 的 saveManualPlaces（临时文件 + rename 原子写，写完清进程内缓存）；
 * 3. 不做鉴权（本地开发），路径 / 城市 id 的穿越防护在 lib/cityData.ts 里。
 *
 * 接口：
 * - GET    ?city=hangzhou&category=park&q=书店&includeHidden=1[&minImportance=4][&unrated=1] → 合并后的地点列表
 *          （默认按 importance 降序，未标星视为 0；minImportance 只留 >= 该星级的点；
 *           unrated=1 只留没有 importance 的点，与其它筛选正交组合）
 * - GET    ?city=hangzhou&geocode=西溪湿地             → 地址转坐标（后台表单的「解析地址」）
 * - POST   { city, place }                             → 新增到 manual.json
 * - PATCH  { city, id, patch }                         → 修改（主文件来源自动复制成 manual 覆盖）
 * - DELETE { city, id }                                → manual 真删 / 主文件写 hidden:true
 *
 * 返回统一 JSON：
 * - 成功 { ok:true, ... }
 * - 失败 { ok:false, reason, errors?:[{ path, message }] }（400 / 404 / 500）
 */

export const dynamic = "force-dynamic";

/** 地点列表里额外带的两个后台专用字段（不写回数据文件）。 */
type AdminPlace = Place & {
  /** 是否已隐藏（数据里没有该字段按 false） */
  hidden: boolean;
  /**
   * 这条数据是否被「人工改过」：
   * - "main"：自动采集数据（包括只有 { id, importance } 星级覆盖的点——星星是批量脚本标的，
   *   不改变这条数据的来源，后台显示「自动」、行内给「隐藏」按钮）；
   * - "manual"：manual 层有这条且改过 importance 以外的字段，或者是手工新增点。
   */
  origin: "main" | "manual";
};

type FieldIssue = { path: string; message: string };

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
  return fieldIssues(error)
    .map((issue) => `${issue.path} ${issue.message}`)
    .join("；");
}

/** 本机当地 "YYYY-MM-DD"（与 PlaceSchema.lastVerified 同一口径）。 */
function todayIsoDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** 请求里的 city 参数：缺省 / 非法 / 不在索引里都直接抛错，由调用方转成 400（不猜默认城市写错文件）。 */
function requireCityId(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("缺少 city 参数（例如 city=liaoyang）");
  }
  return resolveCityId(raw.trim());
}

/**
 * origin 口径（本轮改）：manual 条目里除 id / importance 之外还有字段才算「手工」。
 * 只有 { id, importance } 的星级覆盖仍算自动采集数据（来源列「自动」），
 * 这样「批量打星」不会把整城地点都标成手工。
 */
function originOf(entry: ManualPlaceEntry | undefined): "main" | "manual" {
  if (entry === undefined) return "main";
  for (const key of Object.keys(entry)) {
    if (key !== "id" && key !== "importance") return "manual";
  }
  return "main";
}

/** 后台列表项的公共投影：补 hidden 默认值 + origin 来源层。 */
function toAdminPlace(place: Place, entry: ManualPlaceEntry | undefined): AdminPlace {
  return {
    ...place,
    hidden: place.hidden === true,
    origin: originOf(entry),
  };
}

/** 读手工条目的一个字段（zod 的 partial 类型，索引访问需要收窄）。 */
function entryField(entry: ManualPlaceEntry, field: string): unknown {
  return (entry as unknown as Record<string, unknown>)[field];
}

/** 覆盖值是否与主文件「等价」：等价就不该写进 manual 条目（只留真正改过的字段）。 */
function sameAsMain(field: string, value: unknown, main: Place): boolean {
  // hidden 在数据里是可选字段，主文件没有 = false；按有效值比较，避免写出多余的 hidden:false。
  if (field === "hidden") return (value === true) === (main.hidden === true);
  const mainValue = (main as unknown as Record<string, unknown>)[field];
  if (value === mainValue) return true;
  if (value === null || value === undefined || mainValue === null || mainValue === undefined) {
    return value === mainValue;
  }
  if (typeof value === "object" || typeof mainValue === "object") {
    return JSON.stringify(value) === JSON.stringify(mainValue);
  }
  return false;
}

/**
 * 把「主文件点」的手工覆盖裁到只留与主文件不同的字段。
 * 裁完只剩 id 时返回 null —— 这条覆盖不承载任何改动，不该留在 manual 层。
 *
 * 为什么需要：后台编辑表单会提交整份字段，不裁的话每编辑一次就把一堆没改的字段写进 manual，
 * 和本轮「manual 只存差异」的目标相反。
 */
function pruneMainOverride(entry: ManualPlaceEntry, main: Place): ManualPlaceEntry | null {
  const pruned: Record<string, unknown> = { id: entry.id };
  for (const field of Object.keys(entry)) {
    if (field === "id") continue;
    const value = entryField(entry, field);
    if (sameAsMain(field, value, main)) continue;
    pruned[field] = value;
  }
  if (Object.keys(pruned).length === 1) return null;
  const parsed = ManualPlaceEntrySchema.safeParse(pruned);
  if (!parsed.success) {
    // 只做了「删字段」，理论上不会失败；真失败也宁可 500 也不写坏数据。
    throw new Error(`手工覆盖裁剪后不合法：${entry.id}：${describeIssues(parsed.error)}`);
  }
  return parsed.data;
}

/* ------------------------------------------------------------------ *
 * 请求体契约
 * ------------------------------------------------------------------ */

/**
 * 营业时间格式：openTime 只允许 00:00–23:59；
 * closeTime 额外允许 "24:00"（数据契约里表示「营业到当天结束」，杭州 58 条公园/书房在用）。
 * 后台不允许在这里把 24:00 改写成 00:00（虽然 constraints 判定等价，但那是静默改数据）。
 */
const CLOCK_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const CLOSE_CLOCK_PATTERN = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;

/**
 * 新增时的地点入参：只让后台填「地点本身」的字段。
 * id / source / lastVerified 由服务端生成，不接受前端伪造（source 只会是 manual）。
 */
const PlaceInputSchema = z
  .object({
    /** 可选：不传由服务端生成；传了不能和合并后的已有 id 重复。 */
    id: z.string().min(1).max(80).optional(),
    name: z.string().min(1, "名称不能为空").max(120),
    lng: z.number().min(-180).max(180),
    lat: z.number().min(-90).max(90),
    category: PlaceCategorySchema,
    openTime: z
      .string()
      .regex(CLOCK_PATTERN, "开始时间必须是 HH:mm（00:00–23:59）")
      .nullable()
      .optional(),
    closeTime: z
      .string()
      .regex(CLOSE_CLOCK_PATTERN, "结束时间必须是 HH:mm，或 24:00 表示当天结束")
      .nullable()
      .optional(),
    closedDays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    rating: z.number().min(0).max(5).nullable().optional(),
    avgCost: z.number().min(0).nullable().optional(),
    /** 重要性 1–5 星（只展示，不参与排程）；不传 = 未标星，不要当成 0 星写进数据。 */
    importance: z.number().int().min(1).max(5).optional(),
    hidden: z.boolean().optional(),
    scenery: SceneryTagSchema.optional(),
    labelSource: z.enum(["llm", "rule"]).optional(),
  })
  .strict();

const CreateRequestSchema = z
  .object({
    city: z.string().min(1),
    place: PlaceInputSchema,
  })
  .strict();

/** 修改：所有可编辑字段都可选，但 patch 不能为空；id 不允许改。 */
const PlacePatchSchema = z
  .object({
    name: z.string().min(1, "名称不能为空").max(120).optional(),
    lng: z.number().min(-180).max(180).optional(),
    lat: z.number().min(-90).max(90).optional(),
    category: PlaceCategorySchema.optional(),
    openTime: z
      .string()
      .regex(CLOCK_PATTERN, "开始时间必须是 HH:mm（00:00–23:59）")
      .nullable()
      .optional(),
    closeTime: z
      .string()
      .regex(CLOSE_CLOCK_PATTERN, "结束时间必须是 HH:mm，或 24:00 表示当天结束")
      .nullable()
      .optional(),
    closedDays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    rating: z.number().min(0).max(5).nullable().optional(),
    avgCost: z.number().min(0).nullable().optional(),
    /** 只做 1–5 星修改；不传 = 保留原值（后台编辑「没改就不提交」靠的就是这条）。 */
    importance: z.number().int().min(1).max(5).optional(),
    hidden: z.boolean().optional(),
    scenery: SceneryTagSchema.optional(),
    labelSource: z.enum(["llm", "rule"]).optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: "patch 不能为空" });

const UpdateRequestSchema = z
  .object({
    city: z.string().min(1),
    id: z.string().min(1),
    patch: PlacePatchSchema,
  })
  .strict();

const DeleteRequestSchema = z
  .object({
    city: z.string().min(1),
    id: z.string().min(1),
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

/** 生成一个不会撞已有 id 的手工地点 id（时间戳 + 随机后缀）。 */
function generateManualId(existingIds: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const id = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (!existingIds.has(id)) return id;
  }
  throw new Error("生成手工地点 id 失败：连续 10 次都撞已有 id");
}

/* ------------------------------------------------------------------ *
 * GET：列表 / 地址转坐标
 * ------------------------------------------------------------------ */

/**
 * GET 的 minImportance 查询参数：只接受 1–5 的整数（与 PlaceSchema.importance 同一口径）。
 * 解析失败返回 null，由调用方回 400 + 逐字段错误——不静默当成「不过滤」，否则筛选写错会看到全量数据。
 */
function parseMinImportance(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 5 ? value : null;
}

/** 是 / 否型查询参数（unrated）的合法拼写；不在这两个集合里就是非法值。 */
const TRUE_FLAGS: readonly string[] = ["1", "true", "yes"];
const FALSE_FLAGS: readonly string[] = ["0", "false", "no"];

/**
 * GET 的 unrated 查询参数：只接受 1/0/true/false/yes/no（大小写不敏感）。
 * 解析失败返回 null，由调用方回 400（与 minImportance 同口径：筛选写错不能静默变成「不过滤」）。
 */
function parseUnrated(raw: string): boolean | null {
  const value = raw.trim().toLowerCase();
  if (TRUE_FLAGS.includes(value)) return true;
  if (FALSE_FLAGS.includes(value)) return false;
  return null;
}

export async function GET(request: Request) {
  const url = new URL(request.url);

  let cityId: string;
  try {
    cityId = requireCityId(url.searchParams.get("city"));
  } catch (error) {
    return failure(400, error instanceof Error ? error.message : String(error));
  }

  // 地址转坐标：后台表单「解析地址」用，不返回地点列表。
  const geocodeAddress = (url.searchParams.get("geocode") ?? "").trim();
  if (geocodeAddress !== "") {
    try {
      const config = loadCityConfig(cityId);
      const coords = await geocode(geocodeAddress, config.transferCityName);
      if (coords === null) {
        return NextResponse.json({ ok: false as const, reason: `没找到这个地址：${geocodeAddress}` });
      }
      return NextResponse.json({ ok: true as const, city: cityId, lng: coords.lng, lat: coords.lat });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return NextResponse.json({ ok: false as const, reason: `地址解析失败：${message}` });
    }
  }

  try {
    const data = loadCity(cityId);
    const config = loadCityConfig(cityId);
    const manualEntries = new Map(loadManualPlaces(cityId).map((entry) => [entry.id, entry]));

    const categoryRaw = (url.searchParams.get("category") ?? "").trim();
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const includeHidden = ["1", "true", "yes"].includes(
      (url.searchParams.get("includeHidden") ?? "").trim().toLowerCase(),
    );

    // 星级门槛：不传（或空串）= 不过滤；传了必须是 1–5 的整数，否则 400。
    const minImportanceRaw = (url.searchParams.get("minImportance") ?? "").trim();
    let minImportance: number | null = null;
    if (minImportanceRaw !== "") {
      minImportance = parseMinImportance(minImportanceRaw);
      if (minImportance === null) {
        return failure(400, `minImportance 必须是 1–5 的整数（收到：${minImportanceRaw}）`, [
          { path: "minImportance", message: "必须是 1–5 的整数" },
        ]);
      }
    }

    // 「未标注」筛选：unrated=1 只留没有 importance 的点；unrated=0 等价于不传；
    // 其它值一律 400（和 minImportance 一样，筛选参数写错不静默降级）。
    const unratedRaw = (url.searchParams.get("unrated") ?? "").trim();
    let unratedOnly = false;
    if (unratedRaw !== "") {
      const parsedUnrated = parseUnrated(unratedRaw);
      if (parsedUnrated === null) {
        return failure(400, `unrated 必须是 1 / 0 / true / false（收到：${unratedRaw}）`, [
          { path: "unrated", message: "必须是 1 / 0 / true / false" },
        ]);
      }
      unratedOnly = parsedUnrated;
    }

    let places: AdminPlace[] = data.places.map((place) => toAdminPlace(place, manualEntries.get(place.id)));

    // 默认不显示已隐藏的点；后台勾「显示已隐藏」才带上。
    if (!includeHidden) places = places.filter((place) => !place.hidden);

    if (categoryRaw !== "" && categoryRaw !== "all") {
      const category = PlaceCategorySchema.safeParse(categoryRaw);
      if (!category.success) {
        return failure(400, `类目不合法：${categoryRaw}（可用：${PlaceCategorySchema.options.join(" / ")}）`, [
          { path: "category", message: `类目不合法：${categoryRaw}` },
        ]);
      }
      places = places.filter((place) => place.category === category.data);
    }

    // 名称模糊匹配（大小写不敏感；中文按字面包含）。
    if (q !== "") places = places.filter((place) => place.name.toLowerCase().includes(q));

    // 星级门槛过滤：没标星的条目（importance === undefined）视为 0 星，不满足任何 minImportance。
    if (minImportance !== null) {
      places = places.filter((place) => (place.importance ?? 0) >= minImportance);
    }

    // 「未标注」过滤：与 minImportance / category / q / includeHidden 正交组合。
    // 和 minImportance 同时传时交集必然为空（没标星的点不满足任何星级门槛），保持服务端口径不做特判。
    if (unratedOnly) {
      places = places.filter((place) => typeof place.importance !== "number");
    }

    // 默认按重要性降序。排序放服务端而不是控制台：后台列表、验收脚本、以及以后任何读这个
    // 列表的调用方共用同一口径，不会各自排一遍排出两套顺序。
    // 未标星视为 0 排最后；同星级保持数据文件里的原相对顺序——显式带上原始下标排序，
    // 不依赖运行时 Array#sort 是否稳定。
    places = places
      .map((place, index) => ({ place, index }))
      .sort((left, right) => {
        const diff = (right.place.importance ?? 0) - (left.place.importance ?? 0);
        return diff !== 0 ? diff : left.index - right.index;
      })
      .map((entry) => entry.place);

    return NextResponse.json({
      ok: true as const,
      city: cityId,
      displayName: config.displayName,
      total: places.length,
      places,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[api/admin/places] GET 失败：${message}`);
    return failure(500, `读取地点数据失败：${message}`);
  }
}

/* ------------------------------------------------------------------ *
 * POST：新增（只写 manual.json）
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
    return failure(400, error instanceof Error ? error.message : String(error));
  }

  try {
    const manual = loadManualPlaces(cityId);
    const merged = loadCity(cityId);
    const existingIds = new Set<string>(merged.places.map((place) => place.id));

    const input = body.place;
    if (input.id !== undefined && existingIds.has(input.id)) {
      return failure(400, `地点 id 已存在：${input.id}（新增请留空 id 或换一个）`, [
        { path: "place.id", message: "id 已存在" },
      ]);
    }
    const id = input.id === undefined ? generateManualId(existingIds) : input.id;

    const place = PlaceSchema.parse({
      id,
      name: input.name,
      lng: input.lng,
      lat: input.lat,
      category: input.category,
      openTime: input.openTime === undefined ? null : input.openTime,
      closeTime: input.closeTime === undefined ? null : input.closeTime,
      closedDays: input.closedDays === undefined ? [] : input.closedDays,
      rating: input.rating === undefined ? null : input.rating,
      avgCost: input.avgCost === undefined ? null : input.avgCost,
      source: "manual",
      lastVerified: todayIsoDate(),
      ...(input.importance === undefined ? {} : { importance: input.importance }),
      ...(input.hidden === undefined ? {} : { hidden: input.hidden }),
      ...(input.scenery === undefined ? {} : { scenery: input.scenery }),
      ...(input.labelSource === undefined ? {} : { labelSource: input.labelSource }),
    });

    const saved = saveManualPlaces(cityId, [...manual, place]);
    // 新增点的条目就是完整 Place，origin 必为 manual；这里显式用保存后的条目投影。
    const savedEntry = saved.find((entry) => entry.id === place.id) ?? place;
    return NextResponse.json({
      ok: true as const,
      city: cityId,
      place: toAdminPlace(place, savedEntry),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 数据文件校验失败 / 写盘失败：后台要看到原因，返回 500（不是用户请求错）。
    console.error(`[api/admin/places] POST 失败：${message}`);
    return failure(500, `新增失败：${message}`);
  }
}

/* ------------------------------------------------------------------ *
 * PATCH：修改（主文件来源 → 复制进 manual 再改，形成覆盖）
 * ------------------------------------------------------------------ */

export async function PATCH(request: Request) {
  const payload = await readJsonBody(request);
  if (payload === null) return failure(400, "请求体不是合法 JSON");

  const parsed = UpdateRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return failure(400, `请求参数不合法：${describeIssues(parsed.error)}`, fieldIssues(parsed.error));
  }
  const body = parsed.data;

  let cityId: string;
  try {
    cityId = requireCityId(body.city);
  } catch (error) {
    return failure(400, error instanceof Error ? error.message : String(error));
  }

  try {
    const merged = loadCity(cityId);
    const existing = merged.places.find((place) => place.id === body.id);
    if (existing === undefined) {
      return failure(404, `找不到地点：${body.id}（城市 ${cityId}）`);
    }

    // 先合并 patch 再过一遍完整 PlaceSchema：单独改一个字段也不能把整条写成非法数据。
    const updated = PlaceSchema.parse({ ...existing, ...body.patch });
    const entries = loadManualPlaces(cityId);
    const index = entries.findIndex((entry) => entry.id === body.id);
    // 主文件里有同 id = 自动采集点（manual 条目只是覆盖）；没有 = 手工新增点（条目必须完整）。
    const mainPlace = loadMainCityData(cityId).places.find((place) => place.id === body.id);

    if (mainPlace !== undefined) {
      // 自动采集点：先叠成「现有覆盖 + patch」，再裁到只留与主文件不同的字段。
      // 这样后台编辑整份表单也只落真正改过的字段，不会把整条 Place 又抄一遍。
      const nextEntry = {
        ...(index === -1 ? { id: body.id } : entries[index]),
        ...body.patch,
      } as ManualPlaceEntry;
      const pruned = pruneMainOverride(nextEntry, mainPlace);
      if (pruned === null) {
        // 改完和主文件一样：这条覆盖没有存在意义，直接摘掉。
        if (index !== -1) entries.splice(index, 1);
      } else if (index === -1) {
        entries.push(pruned);
      } else {
        entries[index] = pruned;
      }
    } else {
      // 手工新增点：manual 条目的形状就是完整 Place，直接写合并后的完整数据。
      if (index === -1) entries.push(updated);
      else entries[index] = updated;
    }

    saveManualPlaces(cityId, entries);
    const savedEntry = loadManualPlaces(cityId).find((entry) => entry.id === body.id);
    return NextResponse.json({
      ok: true as const,
      city: cityId,
      origin: originOf(savedEntry),
      place: toAdminPlace(updated, savedEntry),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[api/admin/places] PATCH 失败：${message}`);
    return failure(500, `修改失败：${message}`);
  }
}

/* ------------------------------------------------------------------ *
 * DELETE：manual 里真删；主文件里的写 hidden:true 覆盖
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
    return failure(400, error instanceof Error ? error.message : String(error));
  }

  try {
    const entries = loadManualPlaces(cityId);
    const manualIndex = entries.findIndex((entry) => entry.id === body.id);
    const mainPlace = loadMainCityData(cityId).places.find((place) => place.id === body.id);

    // manual 有条目时，先分清这次 DELETE 是「隐藏」还是「删除手工条目」：
    // - 主文件点 + 条目里只有星级覆盖（origin = main）→ 页面上的按钮是「隐藏」，
    //   绝不能真删条目（会把 importance 一起删掉，点两次才真正隐藏）→ 在原覆盖上加 hidden:true；
    // - 其它 manual 条目（改过其它字段 / 手工新增点）→ 页面上的按钮是「删除」，按原语义真删。
    if (manualIndex !== -1) {
      const entry = entries[manualIndex];
      if (mainPlace !== undefined && originOf(entry) === "main") {
        entries[manualIndex] = { ...entry, hidden: true };
        saveManualPlaces(cityId, entries);
        return NextResponse.json({
          ok: true as const,
          city: cityId,
          id: body.id,
          deleted: "hidden" as const,
        });
      }
      entries.splice(manualIndex, 1);
      saveManualPlaces(cityId, entries);
      return NextResponse.json({
        ok: true as const,
        city: cityId,
        id: body.id,
        deleted: "manual" as const,
      });
    }

    // 主文件里的自动采集点：不真删（下次 fetch:seed 会回来），只写一条最小的 hidden 覆盖。
    if (mainPlace === undefined) {
      return failure(404, `找不到地点：${body.id}（城市 ${cityId}）`);
    }
    saveManualPlaces(cityId, [...entries, { id: body.id, hidden: true }]);
    return NextResponse.json({
      ok: true as const,
      city: cityId,
      id: body.id,
      deleted: "hidden" as const,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[api/admin/places] DELETE 失败：${message}`);
    return failure(500, `删除失败：${message}`);
  }
}
