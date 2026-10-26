import type { Place, PlaceCategory } from "../types/schema";
import type { CityConfig, CityTier } from "./cityData";

/**
 * 城市数据分级规则（tier1 / tier4）的**唯一实现**。
 *
 * 两个使用方：
 * 1. scripts/fetch-seed.ts：落盘前的硬校验（不达标不许写 data/cities/<city>.json）；
 * 2. scripts/check-city.ts（npm run check:city）：换城市数据后 / 提交前的只读校验。
 *
 * 这里只放「能从 data/cities/<city>.json 复算」的规则：
 *   总数上下限、类目覆盖（tier1）、核心 6 类（tier4）、原点 3km 内免费点。
 * fetch:seed 另有一些依赖采集过程（admin/theme）的检查（12 类采集覆盖、行政区分布、
 * 餐厅按区、可疑 POI、labelSource/scenery 完整性），那些仍留在脚本里。
 */

/** 原点 3km 半径：tier 规则里的「3km 内」。 */
export const ORIGIN_RADIUS_M = 3000;

/** 一条 tier 规则的实测结果：failures 为空 = PASS。 */
export type TierCheck = {
  label: string;
  measured: string;
  failures: string[];
};

export type TierCategoryMinimum = {
  category: PlaceCategory;
  min: number;
};

export type TierRule = {
  tier: CityTier;
  totalMin: number;
  totalMax: number;
  /** 原点 3km 内免费点下限（任意类目）。 */
  originFreeMin: number;
  /** 逐类目下限（tier1：9 个常用类目每类 ≥3；空数组 = 不检查）。 */
  categoryMinimums: TierCategoryMinimum[];
  /** 核心类目下限（tier4）；空数组 = 不检查。 */
  coreCategoryMinimums: TierCategoryMinimum[];
};

/** 城市数据的常用类目顺序（mall 不参与 tier1 的类目覆盖检查，与 fetch:seed 原口径一致）。 */
export const CITY_CATEGORY_ORDER: PlaceCategory[] = [
  "bookstore",
  "gallery",
  "museum",
  "theater",
  "market",
  "park",
  "cafe",
  "restaurant",
  "other",
];

const TIER1_CATEGORY_MINIMUMS: TierCategoryMinimum[] = CITY_CATEGORY_ORDER.map((category) => ({
  category,
  min: 3,
}));

const TIER4_CORE_CATEGORY_MINIMUMS: TierCategoryMinimum[] = [
  { category: "park", min: 2 },
  { category: "bookstore", min: 2 },
  { category: "restaurant", min: 2 },
  { category: "market", min: 2 },
  { category: "museum", min: 2 },
  { category: "theater", min: 2 },
];

/** tier 规则表（数值与 fetch:seed 改造前完全一致）。 */
export const TIER_RULES: Record<CityTier, TierRule> = {
  tier1: {
    tier: "tier1",
    totalMin: 120,
    // 12 类 × 5 个区实采在 280 条左右，240 是拍脑袋定的，会让数据更全的城市直接 FAIL。
    totalMax: 320,
    originFreeMin: 10,
    categoryMinimums: TIER1_CATEGORY_MINIMUMS,
    coreCategoryMinimums: [],
  },
  tier4: {
    tier: "tier4",
    // 北京房山苏庄 61 条、顺义城区 55 条——这类远郊片区清洗后的真实密度就在 50-60。
    // 这个阈值是「底线」（低于它说明采集出问题了），不是「目标」。
    totalMin: 50,
    totalMax: 240,
    originFreeMin: 5,
    categoryMinimums: [],
    coreCategoryMinimums: TIER4_CORE_CATEGORY_MINIMUMS,
  },
};

/** 两点球面距离（米）。只用于 tier 统计 / 去重，不参与排程。 */
export function distanceMeters(
  a: { lng: number; lat: number },
  b: { lng: number; lat: number },
): number {
  const earthRadius = 6371000;
  const toRad = (degree: number): number => (degree * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * earthRadius * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** 「免费」口径：avgCost 为 null 或 0（高德没给价也按免费可去算）。 */
export function isFreePlace(place: Place): boolean {
  return place.avgCost === null || place.avgCost === 0;
}

/** 按 Place.category 计数（报告 / 规则共用）。 */
export function countCategories(places: Place[]): Map<PlaceCategory, number> {
  const counts = new Map<PlaceCategory, number>();
  for (const place of places) {
    counts.set(place.category, (counts.get(place.category) ?? 0) + 1);
  }
  return counts;
}

/** 原点坐标（城市配置里 origin 是 latitude / longitude 顺序，这里统一成 lng / lat）。 */
export function originPoint(config: CityConfig): { lng: number; lat: number } {
  return { lng: config.origin.longitude, lat: config.origin.latitude };
}

/**
 * 按城市 tier 校验数据（可从 data/cities/<city>.json 复算的部分）。
 * 返回每条规则的 label / 实测值 / 失败明细；调用方把所有 failures 拼起来判断是否达标。
 */
export function evaluateTierRules(config: CityConfig, places: Place[]): TierCheck[] {
  const rules = TIER_RULES[config.thresholds.tier];
  const checks: TierCheck[] = [];

  // 规则 1：总数上下限。
  const totalFailures: string[] = [];
  if (places.length < rules.totalMin) {
    totalFailures.push(`总条数 ${places.length} < ${rules.totalMin}`);
  }
  if (places.length > rules.totalMax) {
    totalFailures.push(`总条数 ${places.length} > ${rules.totalMax}`);
  }
  checks.push({
    label: "总条数",
    measured: `${places.length} 条（要求 ${rules.totalMin}–${rules.totalMax}）`,
    failures: totalFailures,
  });

  const categoryCounts = countCategories(places);

  // 规则 2：类目覆盖（tier1）。
  if (rules.categoryMinimums.length > 0) {
    const failures: string[] = [];
    for (const rule of rules.categoryMinimums) {
      const count = categoryCounts.get(rule.category) ?? 0;
      if (count < rule.min) {
        failures.push(`category「${rule.category}」只有 ${count} 条（要求 >= ${rule.min}）`);
      }
    }
    checks.push({
      label: "category 覆盖",
      measured: rules.categoryMinimums
        .map((rule) => `${rule.category} ${categoryCounts.get(rule.category) ?? 0}`)
        .join(" / "),
      failures,
    });
  }

  // 规则 3：核心 6 类（tier4）。
  if (rules.coreCategoryMinimums.length > 0) {
    const failures: string[] = [];
    for (const rule of rules.coreCategoryMinimums) {
      const count = categoryCounts.get(rule.category) ?? 0;
      if (count < rule.min) {
        failures.push(`核心类目「${rule.category}」只有 ${count} 条（要求 >= ${rule.min}）`);
      }
    }
    const minPerCategory = Math.min(...rules.coreCategoryMinimums.map((rule) => rule.min));
    checks.push({
      label: "核心 6 类",
      measured:
        rules.coreCategoryMinimums
          .map((rule) => `${rule.category} ${categoryCounts.get(rule.category) ?? 0}`)
          .join(" / ") + `（每类要求 >= ${minPerCategory}）`,
      failures,
    });
  }

  // 规则 4：原点 3km 内免费点（两种 tier 都查；任意类目）。
  const origin = originPoint(config);
  const originFree = places.filter(
    (place) => distanceMeters(origin, place) <= ORIGIN_RADIUS_M && isFreePlace(place),
  );
  checks.push({
    label: `原点 ${Math.round(ORIGIN_RADIUS_M / 1000)}km 内免费点`,
    measured: `${originFree.length} 个（要求 >= ${rules.originFreeMin}；圆心 ${origin.lng},${origin.lat}）`,
    failures:
      originFree.length < rules.originFreeMin
        ? [`原点 3km 内免费点只有 ${originFree.length} 个（要求 >= ${rules.originFreeMin}）`]
        : [],
  });

  return checks;
}
