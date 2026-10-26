import { z } from "zod";

/**
 * 出行画像（开屏问答的结果）。存在 localStorage，key = "szjz.profile"。
 *
 * 设计约束：
 * 1. **读的时候一律过 zod**：坏数据（手改、旧版本、别的站点的同名 key）当「没有」处理，
 *    让用户重新答一遍，绝不让半截数据进 planner。
 * 2. 这里只有类型 / 校验 / 读写，**不含任何业务判断**（怎么按画像调参是 lib/planner.ts 的事）。
 * 3. 工具函数全部做了 `typeof window` 保护：本文件被服务端 import 也不会炸
 *    （planner 只 import type，运行时不会加载）。
 */

/** localStorage 键名（固定值，测试清空时也用这个）。 */
export const PROFILE_STORAGE_KEY = "szjz.profile";

/** 两种人格：有钱换时间 / 体力换省钱。 */
export const TRAVEL_STYLES = ["rich", "powerful"] as const;

/** 场景：风光 / 人文 / 随便。 */
export const TRAVEL_SCENES = ["scenery", "culture", "any"] as const;

export const TravelProfileSchema = z
  .object({
    /** rich = 有钱换时间（打车/吃好点）；powerful = 用体力换钱（多走走/免费的地方）。 */
    style: z.enum(TRAVEL_STYLES),
    /** 出发点：定位得到的坐标，或手填地址 geocode 出来的坐标。 */
    origin: z
      .object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        /** 展示名：定位 = "当前位置"；手填 = 用户输入的地址原文。 */
        label: z.string().min(1).max(80),
      })
      .strict(),
    /** 几点想回家（当日分钟数，1320 = 22:00）；null = 不限制。 */
    homeBy: z.number().int().min(0).max(1439).nullable(),
    /** 今天想看什么。 */
    scene: z.enum(TRAVEL_SCENES),
    /**
     * 这一趟要不要安排吃饭（开屏第 5 题）：false = planner 不排餐厅、不套用餐硬约束；
     * cafe 仍保留（它是歇脚，不是吃饭）。
     *
     * 兼容旧画像：旧数据没有这个字段，`default(true)` 会补成 true —— 也就是说老用户的行为不变。
     */
    mealIncluded: z.boolean().default(true),
    /** 写入时间（ISO 字符串，只做展示 / 排查用）。 */
    updatedAt: z.string().min(1).max(40),
  })
  .strict();

export type TravelProfile = z.infer<typeof TravelProfileSchema>;
export type TravelStyle = (typeof TRAVEL_STYLES)[number];
export type TravelScene = (typeof TRAVEL_SCENES)[number];

/** 问答里收集到的原始输入（updatedAt 由 buildProfile 补）。 */
export type TravelProfileInput = {
  style: TravelStyle;
  origin: { lat: number; lng: number; label: string };
  homeBy: number | null;
  scene: TravelScene;
  /** 这一趟要不要安排吃饭；省略 = true（老调用方的默认行为）。 */
  mealIncluded?: boolean;
};

/** 把问答结果补成完整画像（updatedAt = 现在）。 */
export function buildProfile(input: TravelProfileInput): TravelProfile {
  return TravelProfileSchema.parse({
    style: input.style,
    origin: input.origin,
    homeBy: input.homeBy,
    scene: input.scene,
    // 省略时也按 true 处理（zod 的 default 同样会补，这里显式写一遍便于阅读）。
    mealIncluded: input.mealIncluded ?? true,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * 读画像：没有 / 解析失败 / zod 不通过 → null（当没有，触发问答）。
 * 服务端调用恒返回 null（没有 localStorage）。
 */
export function readProfileFromStorage(): TravelProfile | null {
  if (typeof window === "undefined") return null;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(PROFILE_STORAGE_KEY);
  } catch {
    // 隐私模式 / 被禁用：按「没有」处理，用户答完这一轮还能用（只是存不下来）。
    return null;
  }
  if (raw === null || raw.trim() === "") return null;
  try {
    const parsed = TravelProfileSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** 写画像：成功返回 true；localStorage 不可用（隐私模式）返回 false，不抛错。 */
export function saveProfile(profile: TravelProfile): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(TravelProfileSchema.parse(profile)));
    return true;
  } catch {
    return false;
  }
}

/** 清掉画像（测试 / 「重新设置」想彻底重来时用）。 */
export function clearProfileFromStorage(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(PROFILE_STORAGE_KEY);
  } catch {
    /* 忽略 */
  }
}

/** 画像里「几点回家」的展示文案：null → 不限；1320 → "22:00"。 */
export function formatProfileHomeBy(homeBy: number | null): string {
  if (homeBy === null) return "不限";
  const normalized = ((homeBy % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}
