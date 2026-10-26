/**
 * 任务3-A 离线脚本：给自动采集的地点评 importance（1–5 星）。
 *
 * 用法（在项目根目录跑）：
 *   node node_modules/tsx/dist/cli.mjs --env-file=.env.local scripts/rate-places.ts <city> \
 *     [--no-llm] [--dry-run] [--limit=N] [--only-unrated] [--progress=json]
 *   （等价：npx tsx --env-file=.env.local scripts/rate-places.ts liaoyang --dry-run --limit=5）
 *
 * 这是离线工具，只被控制台后台（/api/admin/rate-places，任务3-B）spawn 或人工手动跑，
 * 绝不能被 app/ 或 lib/ 的运行时请求链路 import。
 *
 * ------------------------------------------------------------------
 * 打星流程（严格按任务书）
 * ------------------------------------------------------------------
 * 1) 规则打底分（判定优先级按下面的顺序，命中即停）：
 *    a. 名称含城市配置（data/cities/<city>.json 的 landmarkKeywords）里的已知地标关键词 → 5 星；
 *    b. 名称含「公园/博物馆/大剧院/剧院/塔/寺/纪念馆/故居/风景区/山/湖/湿地」→ 4 星；
 *    c. 类目 bookstore / cafe / restaurant / market → 3 星；
 *    d. 名称含「便利店/超市/打印/图文/五金/中介/药店/银行」→ 1 星；
 *    e. 其他 → 2 星。
 *    为什么地标关键词必须在 4 星名称词之前：任务书举例的「白塔/广佑寺/辽阳博物馆/龙鼎山/
 *    东京城/东京陵」本身就含 塔/寺/博物馆/山 等 4 星词，4 星先判会把已知地标截胡成 4 星。
 *    已知地标（landmarkKeywords）是「具体名单」，应优先于泛化的 4 星名称词。
 * 2) LLM 校正（有 LLM_API_KEY / LLM_BASE_URL 时）：把「名称 + 类目 + 区县 + 规则分」
 *    按 12 条/批发给 deepseek-flash，让它判断「对本地人几星」，要求回
 *    {"id","importance":1-5,"reason":≤10字}。LLM 失败 / 字段非法 / 漏项 → 该条保留规则分。
 *    --no-llm 时完全跳过 LLM，只用规则分。
 * 3) 只处理「未标注」地点：不在 manual 层、且合并后的地点没有 importance。
 *    **manual 层已存在同 id 的条目一律跳过，不覆盖**（辽阳大剧院 / 盛达文化图书城 是人工标的）。
 * 4) 写回 data/cities/<city>.manual.json（唯一写盘入口 loadManualPlaces / saveManualPlaces，
 *    原子写 + zod 校验）：新条目是**最小覆盖** `{ id, importance }`（manual 层本轮起是
 *    「部分字段覆盖」，不再复制主文件整条 Place）。主文件 <city>.json 永远不写
 *    （fetch:seed 会整份重写，星星必须留在 manual 层）。
 *
 * ------------------------------------------------------------------
 * 区县（district）说明
 * ------------------------------------------------------------------
 * Place 契约（types/schema.ts）里没有区县字段，本脚本也不给数据文件加字段。
 * 区县只用于喂 LLM：离线扫描项目根 .cache/ 下高德原始响应缓存（形如
 * {"status":"1","pois":[{"id":"B0...","adname":"西湖区",...}]}），建 placeId → adname 映射。
 * **不为此新增任何高德请求、不写回任何数据文件**；查不到的地点在 prompt 里写「未标注」。
 *
 * ------------------------------------------------------------------
 * CLI 输出契约（任务3-B 的 admin 后台按此对接，改之前先对齐）
 * ------------------------------------------------------------------
 * --progress=json 时 stdout 只输出 NDJSON（一行一个 JSON），人类日志全部走 stderr：
 *   {"type":"start","city":"liaoyang","total":139,"llm":true}
 *   {"type":"progress","done":12,"total":139,"rule":2,"llm":10}
 *   {"type":"done","city":"liaoyang","total":139,"rated":139,"skipped":2,
 *    "byStar":{"1":52,"5":12},"unrated":0}
 *   {"type":"error","message":"..."}
 * 默认模式反过来：人话日志 + 最终「1..5 星 + 未标注」条数统计走 stdout。
 * 正常结束退出码 0；参数 / 数据 / 写盘错误退出码 1（json 模式下先发 error 事件）。
 *
 * total 的口径 = 本次实际要处理的未标注地点数（已扣掉 manual 已标注、已套用 --limit）；
 * skipped = manual 层已有、被跳过的地点数；rated = 本次处理并得到最终星级的地点数；
 * unrated = 本次运行后（--dry-run 按假想写盘算）该城市仍未标星的地点数。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  ManualPlaceEntrySchema,
  loadCity,
  loadCityConfig,
  loadManualPlaces,
  resolveCityId,
  saveManualPlaces,
} from "../lib/cityData";
import type { ManualPlaceEntry } from "../lib/cityData";
import { chat } from "../lib/llmText";
import type { Place, PlaceCategory } from "../types/schema";

/* ------------------------------------------------------------------ *
 * 1. CLI 参数
 * ------------------------------------------------------------------ */

const USAGE = [
  "用法：node node_modules/tsx/dist/cli.mjs --env-file=.env.local scripts/rate-places.ts <city> \\",
  "        [--no-llm] [--dry-run] [--limit=N] [--only-unrated] [--progress=json]",
  "<city> 必填，例如 hangzhou / liaoyang（必须是 data/cities/ 下存在的城市）。",
].join("\n");

type CliOptions = {
  cityArg: string;
  noLlm: boolean;
  dryRun: boolean;
  /** null = 不限条数。 */
  limit: number | null;
  /** 显式同义开关：默认行为就是只处理未标注地点。 */
  onlyUnrated: boolean;
  progressJson: boolean;
};

/** 参数错误的专用异常（由入口转成「用法提示 + 退出码 1」，不算程序 bug）。 */
class UsageError extends Error {}

/**
 * 解析 CLI。只认任务书里约定的参数：
 * - <city> 位置参数，必填且只能有一个；
 * - --limit=N 只接受正整数（不接受 0 / 负数 / 小数）；
 * - 未知参数直接报错（不静默忽略，避免后台拼错参数后静默跑成全量）。
 */
function parseCli(argv: string[]): CliOptions {
  let cityArg: string | null = null;
  let noLlm = false;
  let dryRun = false;
  let limit: number | null = null;
  let onlyUnrated = false;
  let progressJson = false;

  for (const arg of argv) {
    if (arg === "--no-llm") {
      noLlm = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--only-unrated") {
      onlyUnrated = true;
    } else if (arg === "--progress=json") {
      progressJson = true;
    } else if (arg.startsWith("--limit=")) {
      const raw = arg.slice("--limit=".length);
      if (!/^[1-9]\d*$/.test(raw)) {
        throw new UsageError(`--limit 必须是正整数（收到：${JSON.stringify(raw)}）`);
      }
      limit = Number(raw);
    } else if (arg.startsWith("-")) {
      throw new UsageError(`未知参数：${arg}`);
    } else if (cityArg === null) {
      cityArg = arg.trim();
    } else {
      throw new UsageError(`多余的位置参数：${arg}（只能传一个城市 id）`);
    }
  }

  if (cityArg === null || cityArg === "") {
    throw new UsageError(`缺少城市 id。\n${USAGE}`);
  }
  return { cityArg, noLlm, dryRun, limit, onlyUnrated, progressJson };
}

/* ------------------------------------------------------------------ *
 * 2. 输出：JSON 模式 stdout 只能有 NDJSON，人话日志走 stderr
 * ------------------------------------------------------------------ */

type Output = {
  /** 人话日志：json 模式走 stderr，默认模式走 stdout。 */
  human(message: string): void;
  /** NDJSON 事件：只在 json 模式写 stdout。 */
  event(payload: Record<string, unknown>): void;
};

function createOutput(progressJson: boolean): Output {
  return {
    human(message: string): void {
      if (progressJson) console.error(message);
      else console.log(message);
    },
    event(payload: Record<string, unknown>): void {
      if (progressJson) console.log(JSON.stringify(payload));
    },
  };
}

/* ------------------------------------------------------------------ *
 * 3. 规则打底分（已知地标优先于泛化的 4 星名称词）
 * ------------------------------------------------------------------ */

/**
 * 4 星名称词（任务书原样）：
 * 公园 / 博物馆 / 大剧院 / 剧院 / 塔 / 寺 / 纪念馆 / 故居 / 风景区 / 山 / 湖 / 湿地。
 * 注意：这是泛化的「打底分」，判定时排在 landmarkKeywords（已知地标名单）之后——
 * 否则「辽阳博物馆 / 白塔 / 广佑寺 / 龙鼎山」这类已知地标会先被 4 星词截胡。
 */
const SCENIC_NAME_PATTERN = /(公园|博物馆|大剧院|剧院|塔|寺|纪念馆|故居|风景区|山|湖|湿地)/;

/** 1 星名称词（任务书原样）：生活配套类。 */
const LOW_VALUE_NAME_PATTERN = /(便利店|超市|打印|图文|五金|中介|药店|银行)/;

/** 3 星类目（任务书原样）：书店 / 咖啡 / 餐厅 / 市场。 */
const CATEGORY_THREE_STAR: ReadonlySet<PlaceCategory> = new Set<PlaceCategory>([
  "bookstore",
  "cafe",
  "restaurant",
  "market",
]);

type RuleRating = { star: number; reason: string };

/**
 * 规则打底分，判定顺序（命中即停）：
 * ① landmarkKeywords（已知地标名单）→ 5 星；
 * ② 4 星名称词（泛化）→ 4 星；
 * ③ 类目 3 星；④ 1 星名称词；⑤ 其他 → 2 星。
 * 已知地标优先是必须的：任务书举例的白塔/广佑寺/辽阳博物馆/龙鼎山/东京城/东京陵
 * 本身含 塔/寺/博物馆/山 等 4 星词，若先判 4 星它们永远到不了 5 星。
 * 返回的 reason 只用于人话日志 / 报告，不写进数据文件（Place 契约没有理由字段）。
 */
function rateByRule(place: Place, landmarkKeywords: readonly string[]): RuleRating {
  const keyword = landmarkKeywords.find((item) => place.name.includes(item));
  if (keyword !== undefined) {
    return { star: 5, reason: `命中地标关键词「${keyword}」` };
  }
  if (SCENIC_NAME_PATTERN.test(place.name)) {
    return { star: 4, reason: "名称含公园/博物馆/剧院/塔/寺/山/湖等地标类词" };
  }
  if (CATEGORY_THREE_STAR.has(place.category)) {
    return { star: 3, reason: "书店/咖啡/餐厅/市场类" };
  }
  if (LOW_VALUE_NAME_PATTERN.test(place.name)) {
    return { star: 1, reason: "便利店/超市/银行等生活配套" };
  }
  return { star: 2, reason: "普通地点（规则兜底）" };
}

/* ------------------------------------------------------------------ *
 * 4. 区县：离线扫描 .cache/ 的高德原始响应（不新增请求、不写回数据）
 * ------------------------------------------------------------------ */

const CACHE_DIR = join(process.cwd(), ".cache");

type DistrictIndex = {
  byPlaceId: Map<string, string>;
  /** 扫到的缓存文件数（总 / 含 pois 数组 / 解析失败）。 */
  scannedFiles: number;
  poiFiles: number;
  brokenFiles: number;
  elapsedMs: number;
};

/**
 * 从 .cache/ 的高德原始返回建 placeId → adname 映射。
 *
 * 缓存文件形状：place/text、place/around、place/detail 等成功响应都是
 * {"status":"1","pois":[{"id":"B0...","adname":"西湖区",...}]}。
 * 一个 POI 可能出现在多个缓存文件里，adname 取第一次见到的值（数据来源一致，不会冲突）。
 *
 * 逐文件读 + JSON.parse（不把 1 万个文件同时读进内存）：约 1 万个文件、1–2 秒。
 * 解析失败的文件跳过并计数（缓存是调试产物，坏文件不该让打星失败）。
 */
function loadDistrictIndexFromCache(): DistrictIndex {
  const startedAt = Date.now();
  const byPlaceId = new Map<string, string>();
  let scannedFiles = 0;
  let poiFiles = 0;
  let brokenFiles = 0;

  let names: string[];
  try {
    names = readdirSync(CACHE_DIR);
  } catch {
    return { byPlaceId, scannedFiles, poiFiles, brokenFiles, elapsedMs: Date.now() - startedAt };
  }

  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    scannedFiles += 1;
    let text: string;
    try {
      text = readFileSync(join(CACHE_DIR, name), "utf8");
    } catch {
      brokenFiles += 1;
      continue;
    }
    // 快速跳过非地点查询缓存（路线 / 地理编码等）：避免对 1 万个文件全部 JSON.parse。
    if (!text.includes('"pois"')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      brokenFiles += 1;
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    const pois = (parsed as { pois?: unknown }).pois;
    if (!Array.isArray(pois)) continue;
    poiFiles += 1;
    for (const poi of pois) {
      if (poi === null || typeof poi !== "object") continue;
      const id = (poi as { id?: unknown }).id;
      const adname = (poi as { adname?: unknown }).adname;
      if (typeof id !== "string" || typeof adname !== "string") continue;
      if (id === "" || adname === "") continue;
      if (!byPlaceId.has(id)) byPlaceId.set(id, adname);
    }
  }

  return { byPlaceId, scannedFiles, poiFiles, brokenFiles, elapsedMs: Date.now() - startedAt };
}

/* ------------------------------------------------------------------ *
 * 5. LLM 校正
 * ------------------------------------------------------------------ */

/** 任务书要求：12 条/次；并发 1（顺序跑，进度事件严格有序，也避免把 LLM 配额打满）。 */
const LLM_BATCH_SIZE = 12;
/** 离线批量打星不赶首屏时间，给足 60 秒。 */
const LLM_TIMEOUT_MS = 60_000;
/** 12 条 × 每条 ~40 token 输出，2000 足够。 */
const LLM_MAX_TOKENS = 2_000;

/** LLM 只回传最小字段；reason 超过 10 字视为字段非法（该条回退规则分）。 */
const LLM_ITEM_SCHEMA = z.object({
  id: z.string().min(1),
  importance: z.number().int().min(1).max(5),
  reason: z.string().min(1).max(10),
});

/**
 * system prompt：任务书要求必须明确写「高楼、商场、连锁店不是城市名片。
 * 城市名片是老东西：塔、寺、纪念馆、老街区、有年头的公园。」
 */
const LLM_SYSTEM_PROMPT = [
  "你是城市地点重要性评估器。只评估用户给出的「已存在地点」，不许创造、补充或改写任何地点。",
  "任务：判断这个地点对本地人来说几星？1 = 凑数，2 = 小众，3 = 还不错，4 = 本地人常带朋友去，5 = 城市名片。",
  "原则：",
  "- 高楼、商场、连锁店不是城市名片。城市名片是老东西：塔、寺、纪念馆、老街区、有年头的公园。",
  "- 连锁品牌（咖啡、奶茶、快餐、便利店）、普通农贸市场、社区小公园、写字楼、停车场、新建仿古商业街 → 最多 3 星，绝不能 5 星。",
  "- 真正的历史地标、代表性景点、老字号、城市级文化设施（博物馆/美术馆/大剧院）才考虑 4–5 星。",
  "- 只能根据名称、类目、区县、规则分推断，不许编造年代、事件、设施等任何事实。",
  "- 规则分只是参考，可以上调或下调；但不要为了「显得合理」把普通小店抬到 5 星。",
  "输出要求：只输出 JSON 数组，不要解释，不要 Markdown 代码块。",
  '数组每一项：{"id": "地点 id", "importance": 1 到 5 的整数, "reason": "不超过 10 个字的理由"}。',
].join("\n");

type BatchItem = {
  id: string;
  name: string;
  category: PlaceCategory;
  district: string | null;
  ruleStar: number;
};

/** 拼一批的 user 消息：只给已有事实（名称 / 类目 / 区县 / 规则分），不许模型补事实。 */
function buildLlmUserMessage(
  cityDisplayName: string,
  landmarkKeywords: readonly string[],
  batch: readonly BatchItem[],
): string {
  const payload = batch.map((item) => ({
    id: item.id,
    name: item.name,
    category: item.category,
    district: item.district ?? "未标注",
    ruleStar: item.ruleStar,
  }));
  const landmarkLine =
    landmarkKeywords.length === 0 ? "（该城市未配置）" : landmarkKeywords.join("、");
  return [
    `城市：${cityDisplayName}`,
    `本城公认地标关键词（名称命中时优先考虑 5 星）：${landmarkLine}`,
    "待评估地点（JSON 数组）：",
    JSON.stringify(payload, null, 2),
    "请对上面每一条输出 {" + '"id","importance","reason"' + "}，条数与输入一致，只输出 JSON 数组。",
  ].join("\n");
}

/** 从模型输出里抠 JSON 数组（兼容 ```json 代码块 / 前后带解释）。 */
function extractJsonArray(content: string): string | null {
  const start = content.indexOf("[");
  const end = content.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  return content.slice(start, end + 1);
}

type LlmBatchResult =
  | { ok: true; ratings: Map<string, { star: number; reason: string }>; invalidItems: number }
  | { ok: false; reason: string };

/**
 * 调一次 LLM（deepseek-flash，关思考提速）并校验返回。
 *
 * 契约：**永远不抛错**——网络 / HTTP / JSON / 字段非法全部收敛成 { ok:false } 或
 * 「这一条不采用」，由调用方把该条保留为规则分（任务书：LLM 失败/字段非法 → 保留规则分）。
 */
async function callLlmForBatch(
  cityDisplayName: string,
  landmarkKeywords: readonly string[],
  batch: readonly BatchItem[],
): Promise<LlmBatchResult> {
  const result = await chat(
    [
      { role: "system", content: LLM_SYSTEM_PROMPT },
      { role: "user", content: buildLlmUserMessage(cityDisplayName, landmarkKeywords, batch) },
    ],
    {
      timeoutMs: LLM_TIMEOUT_MS,
      temperature: 0,
      maxTokens: LLM_MAX_TOKENS,
      // deepseek-flash 是 reasoning 模型：批量分类关思考，输出更稳定也更快。
      disableReasoning: true,
    },
  );
  if (result.status === "failure") return { ok: false, reason: result.reason };

  const jsonText = extractJsonArray(result.content);
  if (jsonText === null) return { ok: false, reason: "模型返回里找不到 JSON 数组" };

  let raw: unknown;
  try {
    raw = JSON.parse(jsonText) as unknown;
  } catch {
    return { ok: false, reason: "模型返回的 JSON 无法解析" };
  }
  if (!Array.isArray(raw)) return { ok: false, reason: "模型返回的不是数组" };

  const batchIds = new Set<string>(batch.map((item) => item.id));
  const ratings = new Map<string, { star: number; reason: string }>();
  let invalidItems = 0;
  for (const rawItem of raw) {
    const parsed = LLM_ITEM_SCHEMA.safeParse(rawItem);
    if (!parsed.success) {
      invalidItems += 1;
      continue;
    }
    // 模型多回 / 回错 id 的一律不采用（不能把 A 的星写到 B 头上）。
    if (!batchIds.has(parsed.data.id) || ratings.has(parsed.data.id)) {
      invalidItems += 1;
      continue;
    }
    ratings.set(parsed.data.id, { star: parsed.data.importance, reason: parsed.data.reason });
  }
  return { ok: true, ratings, invalidItems };
}

/* ------------------------------------------------------------------ *
 * 6. LLM 配置（环境变量兜底）
 * ------------------------------------------------------------------ */

const LLM_ENV_KEYS = ["LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL"] as const;

/**
 * 后台 spawn 脚本时可能没带 --env-file=.env.local；Next.js dev server 本身会把 .env.local
 * 载入 process.env（子进程继承），但为了手动 / 后台两种跑法都稳，这里做一次只读兜底：
 * 只在对应环境变量缺失时从 .env.local 补，绝不覆盖已有值，也绝不打印任何 value。
 */
function ensureLlmEnv(): void {
  const hasKey = (process.env.LLM_API_KEY ?? "").trim() !== "";
  const hasBase = (process.env.LLM_BASE_URL ?? "").trim() !== "";
  if (hasKey && hasBase) return;

  const envPath = join(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;
  let text: string;
  try {
    text = readFileSync(envPath, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if ((LLM_ENV_KEYS as readonly string[]).indexOf(key) === -1) continue;
    if ((process.env[key] ?? "").trim() !== "") continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

/** LLM 是否可用 = 环境里 key / baseUrl 都非空（chat() 自己也会再判一次）。 */
function isLlmConfigured(): boolean {
  return (
    (process.env.LLM_API_KEY ?? "").trim() !== "" && (process.env.LLM_BASE_URL ?? "").trim() !== ""
  );
}

/* ------------------------------------------------------------------ *
 * 7. 主流程
 * ------------------------------------------------------------------ */

type Candidate = {
  place: Place;
  rule: RuleRating;
  district: string | null;
  /** 最终结果：LLM 成功用 llm，否则 = 规则分 */
  star: number;
  reason: string;
  source: "llm" | "rule";
};

/** 一批（最多 12 条）调 LLM，把成功校正的条目写回 candidates。 */
async function applyLlmToBatch(
  output: Output,
  cityDisplayName: string,
  landmarkKeywords: readonly string[],
  batch: Candidate[],
  stats: { llm: number; rule: number; failedBatches: number },
): Promise<void> {
  const batchItems: BatchItem[] = batch.map((item) => ({
    id: item.place.id,
    name: item.place.name,
    category: item.place.category,
    district: item.district,
    ruleStar: item.rule.star,
  }));

  // callLlmForBatch 自己已收敛失败；这里再兜一层「不该发生」的异常，绝不让单批拖垮整轮打星。
  const outcome: LlmBatchResult = await callLlmForBatch(
    cityDisplayName,
    landmarkKeywords,
    batchItems,
  ).catch((error: unknown): LlmBatchResult => ({
    ok: false,
    reason: error instanceof Error ? error.message : String(error),
  }));

  if (outcome.ok === false) {
    stats.failedBatches += 1;
    stats.rule += batch.length;
    output.human(`  ! LLM 这一批失败，${batch.length} 条保留规则分：${outcome.reason}`);
    return;
  }
  if (outcome.invalidItems > 0) {
    output.human(`  ! LLM 这一批有 ${outcome.invalidItems} 条字段非法/漏项，回退规则分`);
  }

  let llmCount = 0;
  for (const item of batch) {
    const rated = outcome.ratings.get(item.place.id);
    if (rated !== undefined) {
      item.star = rated.star;
      item.reason = rated.reason;
      item.source = "llm";
      llmCount += 1;
    }
  }
  stats.llm += llmCount;
  stats.rule += batch.length - llmCount;
}

async function run(): Promise<number> {
  const argv = process.argv.slice(2);
  // 参数错误时也要按调用方期望的格式报（先判断有没有 --progress=json）。
  const output = createOutput(argv.indexOf("--progress=json") !== -1);

  let options: CliOptions;
  try {
    options = parseCli(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.event({ type: "error", message });
    output.human(`FAIL: ${message}`);
    return 1;
  }

  // ---- 城市校验（resolveCityId 挡未知城市 / 路径穿越；loadCity 整份过 zod） ----
  let cityId: string;
  try {
    cityId = resolveCityId(options.cityArg);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.event({ type: "error", message });
    output.human(`FAIL: ${message}`);
    return 1;
  }

  let mergedPlaces: Place[];
  let landmarkKeywords: string[];
  let cityDisplayName: string;
  let manualIds: Set<string>;
  try {
    const data = loadCity(cityId);
    const config = loadCityConfig(cityId);
    mergedPlaces = data.places;
    landmarkKeywords = config.landmarkKeywords === undefined ? [] : config.landmarkKeywords.slice();
    cityDisplayName = config.displayName;
    manualIds = new Set(loadManualPlaces(cityId).map((place) => place.id));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.event({ type: "error", message });
    output.human(`FAIL: ${message}`);
    return 1;
  }

  // ---- 挑「未标注」候选：不在 manual 层 且合并后没有 importance ----
  const unratedBefore = mergedPlaces.filter((place) => place.importance === undefined).length;
  const skipped = mergedPlaces.filter((place) => manualIds.has(place.id)).length;
  const allCandidates = mergedPlaces.filter(
    (place) => !manualIds.has(place.id) && place.importance === undefined,
  );
  const candidates = options.limit === null ? allCandidates : allCandidates.slice(0, options.limit);
  const total = candidates.length;

  // ---- LLM 是否启用：--no-llm 优先；否则看有没有配置 key ----
  const wantLlm = !options.noLlm;
  if (wantLlm) ensureLlmEnv();
  const llmEnabled = wantLlm && isLlmConfigured();

  output.human(
    `[rate-places] ${cityDisplayName}（${cityId}）：未标注 ${allCandidates.length} 条，` +
      `本次处理 ${total} 条（manual 已标注跳过 ${skipped} 条），` +
      `LLM ${llmEnabled ? "开启" : options.noLlm ? "关闭（--no-llm）" : "未配置，跳过"}` +
      `${options.dryRun ? "，--dry-run 不写盘" : ""}`,
  );
  if (total === 0) {
    output.event({ type: "start", city: cityId, total, llm: llmEnabled });
    output.event({
      type: "done",
      city: cityId,
      total: 0,
      rated: 0,
      skipped,
      byStar: {},
      unrated: unratedBefore,
    });
    output.human("[rate-places] 没有未标注地点，无需处理。");
    return 0;
  }

  output.event({ type: "start", city: cityId, total, llm: llmEnabled });

  // ---- 规则打底分（全部候选先算好，LLM 只覆盖成功的那部分） ----
  const items: Candidate[] = candidates.map((place) => {
    const rule = rateByRule(place, landmarkKeywords);
    return { place, rule, district: null, star: rule.star, reason: rule.reason, source: "rule" };
  });

  // ---- 区县映射（只给 LLM 用；--no-llm 不扫缓存） ----
  let districtCovered = 0;
  let districtTotal = 0;
  if (llmEnabled) {
    const index = loadDistrictIndexFromCache();
    for (const item of items) {
      item.district = index.byPlaceId.get(item.place.id) ?? null;
      districtTotal += 1;
      if (item.district !== null) districtCovered += 1;
    }
    output.human(
      `[rate-places] 区县来自高德 adname 离线缓存（.cache/，不新增请求、不写回数据）：` +
        `扫描 ${index.scannedFiles} 个文件（含 pois ${index.poiFiles} 个，解析失败 ${index.brokenFiles} 个，` +
        `${index.elapsedMs} ms），覆盖 ${districtCovered}/${districtTotal}，缺省写「未标注」。`,
    );
  } else {
    output.human("[rate-places] 未启用 LLM：区县不参与打分（仍可离线缓存建映射，但本模式不需要）。");
  }

  // ---- LLM 校正：12 条/批，顺序跑（并发 1），每批完成发一次 progress ----
  const stats = { llm: 0, rule: 0, failedBatches: 0 };
  let done = 0;
  if (llmEnabled) {
    for (let start = 0; start < items.length; start += LLM_BATCH_SIZE) {
      const batch = items.slice(start, start + LLM_BATCH_SIZE);
      await applyLlmToBatch(output, cityDisplayName, landmarkKeywords, batch, stats);
      done += batch.length;
      output.event({ type: "progress", done, total, rule: stats.rule, llm: stats.llm });
      output.human(`[rate-places] 进度 ${done}/${total}（规则 ${stats.rule}，LLM ${stats.llm}）`);
    }
  } else {
    stats.rule = items.length;
    done = items.length;
    output.event({ type: "progress", done, total, rule: stats.rule, llm: 0 });
  }

  // ---- 每条结果的人话明细（报告里的 5 星清单 / 理由从这里来） ----
  for (const item of items) {
    const districtText = item.district === null ? "未标注" : item.district;
    const ruleText = item.source === "llm" ? `rule ${item.rule.star}` : "规则";
    output.human(
      `  [${item.star}★][${item.source}] ${item.place.name}（${districtText}，${ruleText}）｜${item.reason}`,
    );
  }

  // ---- 写 manual 层（dry-run 只演练不写盘） ----
  const byStar: Record<string, number> = {};
  for (const item of items) {
    byStar[String(item.star)] = (byStar[String(item.star)] ?? 0) + 1;
  }

  if (!options.dryRun) {
    try {
      const existingManual = loadManualPlaces(cityId);
      // 防御：manual 里已经存在的 id 一律跳过不覆盖（候选已过滤过，这里再挡一次）。
      const existingIds = new Set(existingManual.map((entry) => entry.id));
      const newEntries: ManualPlaceEntry[] = [];
      for (const item of items) {
        if (existingIds.has(item.place.id)) continue;
        // 只写最小覆盖 { id, importance }：manual 层是「部分字段覆盖」，
        // 其余字段继续从主文件继承，不能再把整条 Place 复制进来。
        const entry = ManualPlaceEntrySchema.parse({ id: item.place.id, importance: item.star });
        newEntries.push(entry);
        existingIds.add(entry.id);
      }
      if (newEntries.length > 0) {
        saveManualPlaces(cityId, [...existingManual, ...newEntries]);
      }
      output.human(
        `[rate-places] 已写 manual 层：${newEntries.length} 条（${cityId}.manual.json，原子写 + zod 校验）`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.event({ type: "error", message: `写 manual 层失败：${message}` });
      output.human(`FAIL: 写 manual 层失败：${message}`);
      return 1;
    }
  } else {
    output.human(`[rate-places] --dry-run：本次会写 manual 层 ${items.length} 条（未实际写盘）`);
  }

  // ---- 收尾统计 ----
  const unratedAfter = unratedBefore - items.length;
  const sortedByStar: Record<string, number> = {};
  for (const star of [1, 2, 3, 4, 5]) {
    const count = byStar[String(star)];
    if (count !== undefined) sortedByStar[String(star)] = count;
  }

  output.event({
    type: "done",
    city: cityId,
    total,
    rated: items.length,
    skipped,
    byStar: sortedByStar,
    unrated: unratedAfter,
  });

  output.human("");
  output.human(`打星完成：${cityDisplayName}（${cityId}）`);
  output.human(`  本次处理：${items.length} 条（未标注总数 ${allCandidates.length} 条，manual 跳过 ${skipped} 条）`);
  for (const star of [1, 2, 3, 4, 5]) {
    output.human(`  ${star}★：${byStar[String(star)] ?? 0} 条`);
  }
  output.human(`  未标注（运行后）：${unratedAfter} 条`);
  if (llmEnabled) {
    output.human(
      `  LLM：成功校正 ${stats.llm} 条 / 回退规则 ${stats.rule} 条（失败批次 ${stats.failedBatches}）`,
    );
    output.human(`  区县覆盖：${districtCovered}/${districtTotal}（缺省「未标注」）`);
  } else {
    output.human("  LLM：未使用，全部规则分");
  }
  if (options.dryRun) output.human("  （--dry-run：以上均未写盘）");
  return 0;
}

/* ------------------------------------------------------------------ *
 * 8. 入口
 * ------------------------------------------------------------------ */

run()
  .then((code) => {
    // 不用 process.exit()：让 stdout/stderr 自然 flush 完再退出。
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? `${error.message}` : String(error);
    const jsonMode = process.argv.indexOf("--progress=json") !== -1;
    if (jsonMode) console.log(JSON.stringify({ type: "error", message }));
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  });
