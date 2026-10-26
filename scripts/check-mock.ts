/**
 * M0 假数据自检。
 *
 * 做两件事：
 * 1. 用 types/schema.ts 里的 zod 契约校验 data/mock-itinerary.json（不通过直接抛错，不兜底修补）；
 * 2. 断言 M0 3.3 要求的两条算术关系：
 *    ① arriveAt + stayMin + 下一段 durationMin === 下一站 arriveAt
 *    ② totalCost === 三个 costEstimate 之和
 *
 * 跑法：npm run check:mock
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ItinerarySchema, PlaceSchema } from "../types/schema";

const MOCK_FILE = join(process.cwd(), "data", "mock-itinerary.json");

function die(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    console.error(`FAIL: ${label} 不符合 types/schema.ts 契约`);
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    process.exit(1);
  }
  return parsed.data;
}

function readMockFile(): unknown {
  let text: string;
  try {
    text = readFileSync(MOCK_FILE, "utf8");
  } catch {
    die(`读不到 ${MOCK_FILE}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    die(`${MOCK_FILE} 不是合法 JSON：${String(error)}`);
  }
}

const raw = readMockFile();
if (typeof raw !== "object" || raw === null) {
  die("data/mock-itinerary.json 顶层必须是对象 { places, itinerary }");
}
const file = raw as { places?: unknown; itinerary?: unknown };

// ---- 1. schema 校验 ----
const places = parseOrThrow(z.array(PlaceSchema), file.places, "places");
const itinerary = parseOrThrow(ItinerarySchema, file.itinerary, "itinerary");

const placeIds = new Set(places.map((place) => place.id));
const stops = itinerary.stops;
const segments = itinerary.segments;

if (stops.length !== 3) {
  die(`M0 要求 3 站，实际 ${stops.length} 站`);
}
if (segments.length !== stops.length) {
  die(`segment 数量应为 ${stops.length} 段（含起点到第一站），实际 ${segments.length} 段`);
}
for (const stop of stops) {
  if (!placeIds.has(stop.placeId)) {
    die(`stop.placeId=${stop.placeId} 在 places 里不存在`);
  }
}

// ---- 2. 算术关系 ----
// ① arriveAt + stayMin + 下一段 durationMin === 下一站 arriveAt
const linkNotes: string[] = [];
for (let i = 0; i < stops.length - 1; i += 1) {
  const current = stops[i];
  const next = stops[i + 1];
  const segment = segments.find(
    (item) => item.fromId === current.placeId && item.toId === next.placeId,
  );
  if (!segment) {
    die(`缺少 ${current.placeId} → ${next.placeId} 的 segment`);
  }
  const expected = current.arriveAt + current.stayMin + segment.durationMin;
  if (expected !== next.arriveAt) {
    die(
      `第 ${i + 1} 站衔接不闭合：arriveAt(${current.arriveAt}) + stayMin(${current.stayMin}) + ` +
        `durationMin(${segment.durationMin}) = ${expected}，但第 ${i + 2} 站 arriveAt = ${next.arriveAt}`,
    );
  }
  linkNotes.push(
    `${current.placeId} → ${next.placeId}: ${current.arriveAt} + ${current.stayMin} + ${segment.durationMin} = ${next.arriveAt}`,
  );
}

// ② totalCost === 所有 costEstimate 之和
const costSum = stops.reduce((sum, stop) => sum + stop.costEstimate, 0);
if (costSum !== itinerary.totalCost) {
  die(
    `总花费不闭合：totalCost = ${itinerary.totalCost}，` +
      `Σ costEstimate = ${costSum}（${stops.map((stop) => stop.costEstimate).join(" + ")}）`,
  );
}

// ③ 站内闭合与总时长（M0 3.3「字段全部合法」的一部分）
for (const stop of stops) {
  if (stop.arriveAt + stop.stayMin !== stop.leaveAt) {
    die(
      `${stop.placeId} 站内不闭合：arriveAt(${stop.arriveAt}) + stayMin(${stop.stayMin}) = ` +
        `${stop.arriveAt + stop.stayMin}，但 leaveAt = ${stop.leaveAt}`,
    );
  }
}
const lastStop = stops[stops.length - 1];
if (itinerary.endAt !== lastStop.leaveAt) {
  die(`endAt(${itinerary.endAt}) 应等于末站 leaveAt(${lastStop.leaveAt})`);
}
if (itinerary.startAt + itinerary.totalMin !== itinerary.endAt) {
  die(
    `总时长不闭合：startAt(${itinerary.startAt}) + totalMin(${itinerary.totalMin}) ` +
      `= ${itinerary.startAt + itinerary.totalMin}，但 endAt = ${itinerary.endAt}`,
  );
}

console.log(`PASS  data/mock-itinerary.json`);
console.log(`      schema：${places.length} 个 Place + 1 个 Itinerary 全部通过 zod 校验`);
console.log(`      ① 相邻站衔接（arriveAt + stayMin + durationMin = 下一站 arriveAt）：`);
for (const note of linkNotes) {
  console.log(`         ${note}`);
}
console.log(
  `      ② 总花费：totalCost ${itinerary.totalCost} = ${stops
    .map((stop) => stop.costEstimate)
    .join(" + ")}`,
);
console.log(
  `      ③ 站内闭合：leaveAt = arriveAt + stayMin（${stops.length} 处）；` +
    `endAt = 末站 leaveAt = ${itinerary.endAt}；totalMin = ${itinerary.totalMin}`,
);
