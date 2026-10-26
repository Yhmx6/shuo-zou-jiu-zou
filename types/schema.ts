import { z } from "zod";

/**
 * 数据契约（M0 冻结，之后只允许新增可选字段）。
 * 所有时间一律是「当日分钟数整数」：920 = 15:20。不允许出现字符串时间。
 */

export const PlaceCategorySchema = z.enum([
  "bookstore",
  "museum",
  "gallery",
  "theater",
  "market",
  "park",
  "mall",
  "restaurant",
  "cafe",
  "other",
]);

export const PlaceSourceSchema = z.enum(["amap", "seed", "manual"]);

export const SegmentModeSchema = z.enum(["walk", "bus", "drive", "bike"]);

/**
 * M1 数据扩展（3.3.6，新增可选字段）：风景标签。
 *
 * 只做分类 / 一句话描述，不产生任何地点（铁律 1）。标签由离线脚本
 * scripts/fetch-seed.ts 生成（有 LLM_API_KEY 时用 LLM，没有时用可推断的规则兜底），
 * 这里只负责冻结字段形状：枚举不认识的分类会被 zod 直接拒绝。
 */
export const SceneryTypeSchema = z.enum([
  "江景",
  "老街",
  "工业",
  "田野",
  "森林",
  "建筑",
  "市井",
  "园林",
  "其他",
]);

export const BestTimeSchema = z.enum(["清晨", "午后", "日落", "夜晚", "任意"]);

export const SceneryTagSchema = z.object({
  sceneryType: SceneryTypeSchema,
  bestTime: BestTimeSchema,
  /** 一个人去会不会尴尬 */
  soloFriendly: z.boolean(),
  /** 不超过 20 字，只能基于名称 / 类型 / 地址可推断的信息，不许编造事实 */
  oneLineDesc: z.string().min(1).max(20),
});

/** 地点。只能来自高德 API 或 data/cities/<city>.json 里的 places，不允许凭空生成。 */
export const PlaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  lng: z.number(),
  lat: z.number(),
  category: PlaceCategorySchema,
  /**
   * "HH:mm"。与 closeTime 同为 null 表示「高德未给出营业时间」：
   * 由 lib/constraints.ts 的 isOpenAt 判定，公园 / 江景 / 老街 / 森林 / 田野 / 建筑类视作全天开放
   * （00:00–24:00），其余类目仍按「未知 → 不可去」处理。字段本身不编造时间。
   */
  openTime: z.string().nullable(),
  closeTime: z.string().nullable(),
  /** 每周休息的星期，0 = 周日 */
  closedDays: z.array(z.number().int().min(0).max(6)),
  rating: z.number().nullable(),
  /** 人均消费（元） */
  avgCost: z.number().nullable(),
  source: PlaceSourceSchema,
  /** 最后核验日期，"YYYY-MM-DD" */
  lastVerified: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /**
   * M1 数据扩展（3.3.6 新增可选字段）：风景标签。
   * 可选是为了兼容 M1/M5 已落盘的 52 条旧数据（旧条目没有这个字段，读取侧按「未标注」处理）。
   */
  scenery: SceneryTagSchema.optional(),
  /**
   * M1 数据扩展（本轮新增可选字段）：风景标签的来源。
   * "llm" = 大模型标注；"rule" = LLM 未返回/校验失败时走的规则兜底。
   * 旧数据/手工数据没有这个字段。
   */
  labelSource: z.enum(["llm", "rule"]).optional(),
  /**
   * 地点管理后台（本轮新增可选字段）：true = 后台隐藏该点。
   * 自动采集的点不允许从主文件里真删（下次 fetch:seed 会回来），DELETE 时在
   * data/cities/<city>.manual.json 里写一条同 id 覆盖条目并置 hidden:true；
   * planner 组候选池时跳过 hidden===true 的点，后台列表仍能看到它（灰显）。
   * 旧数据 / 手工新增的点没有这个字段，按 false 处理。
   */
  hidden: z.boolean().optional(),
  /**
   * 地点管理后台（本轮新增可选字段）：重要性 1–5 星。
   *
   * 5 = 地标性建筑 / 城市名片 / 代表性景点；4 = 本地人常带朋友去；3 = 还不错；
   * 2 = 小众；1 = 凑数。**只做展示**，暂不参与 planner 打分（本轮铁律：活动 / 重要性都不许影响排程）。
   *
   * 存续方式：控制台改重要性走「主文件来源的点复制进 manual 层再改」，
   * 所以给自动采集点标的星写在 data/cities/<city>.manual.json 里，fetch:seed 重写主文件不会丢。
   * 旧数据 / 未标注的点没有这个字段，按「未标星」处理（不要当 0 星展示）。
   */
  importance: z.number().int().min(1).max(5).optional(),
});

/** 两点之间的一段路。durationMin 是整数分钟。 */
export const SegmentSchema = z.object({
  fromId: z.string().min(1),
  toId: z.string().min(1),
  mode: SegmentModeSchema,
  durationMin: z.number().int().min(0),
  distanceM: z.number().min(0),
  /**
   * 路名（本轮新增可选字段，M0 契约只许新增可选字段）：这一段「起步那条路」的名字。
   *
   * 来源：高德算路返回的 step 级路名——v3 步行 / 驾车在 steps[].road，v5 骑行在 steps[].road_name；
   * 高德没有值时给的是空数组 []（和 biz_ext.cost 一个毛病），lib/amap.ts 统一归一成
   * 「非空字符串或 undefined」，**绝不允许出现空串 / "[]"**。
   * 公交（transit 方案）没有 step 级路名，所以公交段不带这个字段。
   * 展示侧：有值 → 「沿{road}走 3 分钟」；没有 → 保持原来的「走过去 3 分钟」。
   */
  road: z.string().min(1).optional(),
});

/** 排队等级。只能是「估」，不存在任何实时排队数据。 */
export const WaitLevelSchema = z.enum(["low", "mid", "high"]);

/**
 * M9 餐厅卡的附加信息。挂在 Stop 上（可选字段，M0 契约只许新增可选字段）。
 *
 * 全部由服务端按规则算好：排队是按「评分 × 时段」估出来的，没有任何实时排队/订座数据。
 */
export const MealInfoSchema = z.object({
  /** 预估要等多少分钟（下界：low 0 / mid 15 / high 30）。 */
  waitMin: z.number().int().min(0),
  waitLevel: WaitLevelSchema,
  /** 只允许两种句式：「这个点人少」「周五 18:00 后通常要等 30–40 分钟」。 */
  waitText: z.string().min(1),
  /** 需要自行预约时的提醒；null = 这个点不用提醒。 */
  bookingText: z.string().nullable(),
  /** 「查看电话」跳转；null = 不跳。只做展示，不代订、不代付。 */
  bookingUrl: z.string().nullable(),
  /** 点菜建议按几个人算（V1 首屏没有人数选择器，固定 1 人）。 */
  people: z.number().int().min(1),
  /** 点菜建议，按人数给。 */
  dishText: z.string().min(1),
  /** 人均（元），与 reason 里的「人均 X」同一口径。 */
  perPersonCost: z.number().min(0),
});

/**
 * 活动（本轮新增）：本地活动 / 演出，挂在某个地点上。
 *
 * 数据文件：data/cities/<city>.events.json，形状 { "events": CityEvent[] }。
 * 时间一律是「本地时间、不带时区」的 "YYYY-MM-DDTHH:mm"（跨天活动必须带日期，
 * 所以不能用 00-common 铁律 2 的当日分钟数整数；比较全部在服务端做，格式化后的
 * 展示字段见 StopEventSchema）。
 *
 * 铁律：活动**不参与排程**，本轮只做展示；关联的地点必须属于该城市（跨城市拒绝）。
 */
const LOCAL_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** 校验 "YYYY-MM-DDTHH:mm" 是真实存在的本地时刻（挡 2026-02-31 / 25:00 这类值）。 */
function isValidLocalDateTime(text: string): boolean {
  if (!LOCAL_DATETIME_PATTERN.test(text)) return false;
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(5, 7));
  const day = Number(text.slice(8, 10));
  const hour = Number(text.slice(11, 13));
  const minute = Number(text.slice(14, 16));
  if (hour > 23 || minute > 59) return false;
  if (month < 1 || month > 12) return false;
  // 用 UTC 构造只做「这个年月日是否存在」的判定，不参与任何业务时间运算。
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
  );
}

export const CityEventSchema = z
  .object({
    /** 服务端生成的稳定 id，形如 "evt_001"。 */
    id: z.string().min(1).max(80),
    /** 必须是该城市已有的地点 id（新增 / 修改时由 API 校验，跨城市拒绝）。 */
    placeId: z.string().min(1),
    title: z.string().min(1).max(120),
    /** 本地时间 "YYYY-MM-DDTHH:mm"（不带时区）。 */
    startAt: z.string().refine(isValidLocalDateTime, "startAt 必须是真实存在的本地时刻，格式 YYYY-MM-DDTHH:mm"),
    endAt: z.string().refine(isValidLocalDateTime, "endAt 必须是真实存在的本地时刻，格式 YYYY-MM-DDTHH:mm"),
    /** 备注（票价 / 购票渠道等）；可空。 */
    note: z.string().max(500).optional(),
  })
  .refine((event) => event.endAt > event.startAt, {
    message: "endAt 必须晚于 startAt",
    path: ["endAt"],
  });
export type CityEvent = z.infer<typeof CityEventSchema>;

/**
 * 挂在行程站点上的「现在或即将开始的活动」快照（本轮新增，可选）。
 *
 * 全部由服务端算好（匹配规则：该站 placeId 有活动、endAt > 现在、startAt < 现在 + 4 小时）：
 * 前端只负责渲染，不再做任何时间比较（用户机器时间可能不准）。
 * 没有活动的站点不带这个字段，卡片上不留任何占位。
 */
export const StopEventSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  /** 开始的本地时刻 "HH:mm"（不带日期）。 */
  startAtText: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  /** 结束的本地时刻 "HH:mm"。 */
  endAtText: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  /** upcoming = 还没开始；ongoing = 正在进行。已结束的活动不会出现在这里。 */
  status: z.enum(["upcoming", "ongoing"]),
  /** 相对「现在」的日期标签：卡片上「明天 01:00」这种跨天展示用。 */
  dayLabel: z.enum(["今天", "明天"]),
  /** 备注的第一句（没有备注 / 取不到 → null）；卡片原样展示，不再加工。 */
  noteLine: z.string().min(1).nullable(),
});
export type StopEvent = z.infer<typeof StopEventSchema>;

/** 行程中的一站。arriveAt / leaveAt 是当日分钟数整数。 */
export const StopSchema = z.object({
  placeId: z.string().min(1),
  arriveAt: z.number().int(),
  leaveAt: z.number().int(),
  stayMin: z.number().int().min(0),
  reason: z.string().min(1),
  costEstimate: z.number().min(0),
  /** M9 新增（可选）：只有餐厅站才有，其余站点为 null / 不传。 */
  meal: MealInfoSchema.nullable().optional(),
  /*
   * 城市数据模块化新增（只新增可选字段，M0 契约不变）：
   * 站点展示所需的地点快照，由 lib/planner.ts 在返回行程前统一填充。
   * 页面 / 地图组件因此不再静态 import 地点数据文件，只依赖这些字段渲染。
   * 旧数据（data/mock-itinerary.json 等）没有这些字段，读取侧按「未提供」处理。
   */
  placeName: z.string().min(1).optional(),
  lng: z.number().optional(),
  lat: z.number().optional(),
  /** 地点闭馆时刻 "HH:mm"（"24:00" = 全天）；null = 未知。第一站卡片的「几点前出发」用它。 */
  placeCloseTime: z.string().nullable().optional(),
  /**
   * 地点重要性快照 1–5（本轮新增可选字段）：由 /api/plan、/api/swap 从合并后的地点数据里带下来，
   * 卡片只读它展示星标，**不参与排程打分**。没有标过星的点不带这个字段。
   */
  importance: z.number().int().min(1).max(5).optional(),
  /**
   * 该站点「现在或即将开始」的活动（本轮新增可选字段）：服务端按
   * endAt > 现在 && startAt < 现在 + 4 小时 匹配好并格式化，前端只渲染这一行。
   * 没有活动时不带这个字段（卡片不占位）。
   */
  upcomingEvent: StopEventSchema.optional(),
  /*
   * 文案接线（本轮新增可选字段，M0 契约只许新增可选字段）：
   * LLM 给这一站写的一句文案，由 /api/plan 生成成功后从 stopLines 按顺序对齐挂上来。
   * 生成失败 / prompt 文件不可用 / 命中禁止词时整份行程都不带文案字段（降级），
   * 卡片只在字段存在时多渲染一行，没有就不渲染、不留空位。
   */
  oneLine: z.string().min(1).optional(),
});

/**
 * 行程端点快照（本轮新增可选字段）：起点 / 返程终点。
 *
 * 这两个端点不是 POI，也永远不进候选池（铁律 1 不受影响），但地图需要它们的坐标、
 * 文字导航需要终点的名字，而 Itinerary 契约里原本没有地方放起点 / 终点。
 * 默认「回到起点」时 destination.placeId === "origin"；自定义终点用固定 id "destination"。
 * 旧数据（data/mock-itinerary.json、改造前的响应）没有这两个字段，读取侧按「未提供」处理。
 */
export const ItineraryEndpointSchema = z.object({
  placeId: z.string().min(1),
  name: z.string().min(1),
  lng: z.number(),
  lat: z.number(),
});

/** 一份完整行程。startAt / endAt / totalMin 均为当日分钟数或分钟数整数。 */
export const ItinerarySchema = z.object({
  startAt: z.number().int(),
  endAt: z.number().int(),
  totalMin: z.number().int().min(0),
  totalCost: z.number().min(0),
  stops: z.array(StopSchema),
  segments: z.array(SegmentSchema),
  /** 本轮新增可选项：起点快照（默认城市起点 / 用户自定义起点）。旧数据没有。 */
  origin: ItineraryEndpointSchema.optional(),
  /** 本轮新增可选项：返程终点快照；默认回到起点（placeId = "origin"）。旧数据没有。 */
  destination: ItineraryEndpointSchema.optional(),
  /*
   * 文案控制台（本轮新增可选字段，M0 契约只许新增可选字段）：
   * LLM 生成的一句话总结 + 每站一句文案，由 /api/plan 在排程完成后挂上。
   * 生成失败 / prompt 文件不可用 / 命中禁止词时**不带这两个字段**（降级，行程字段原样不动），
   * 旧调用方（页面、导出卡）完全不依赖它们。
   */
  /** 整条路线的一句话文案；没有生成成功时不存在。 */
  oneLiner: z.string().min(1).optional(),
  /** 按 stops 顺序的每站一句文案；数量与 stops 对齐，没有生成成功时不存在。 */
  stopLines: z.array(z.string().min(1)).optional(),
});

export type PlaceCategory = z.infer<typeof PlaceCategorySchema>;
export type PlaceSource = z.infer<typeof PlaceSourceSchema>;
export type SegmentMode = z.infer<typeof SegmentModeSchema>;
export type WaitLevel = z.infer<typeof WaitLevelSchema>;

export type SceneryType = z.infer<typeof SceneryTypeSchema>;
export type BestTime = z.infer<typeof BestTimeSchema>;
export type SceneryTag = z.infer<typeof SceneryTagSchema>;

export type Place = z.infer<typeof PlaceSchema>;
export type Segment = z.infer<typeof SegmentSchema>;
export type ItineraryEndpoint = z.infer<typeof ItineraryEndpointSchema>;
export type MealInfo = z.infer<typeof MealInfoSchema>;
export type Stop = z.infer<typeof StopSchema>;
export type Itinerary = z.infer<typeof ItinerarySchema>;
