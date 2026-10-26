import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readJsonFile, writeJsonFileAtomic } from "./cityData";
import type { Itinerary } from "@/types/schema";

/**
 * 行程文案（oneLiner + 每站一句 stopLines）的唯一 LLM 入口 + prompt 文件存储。
 *
 * 为什么单独一层：
 * - prompt 不许硬编码在代码里。system / 禁止词 / 好例子 / 坏例子 全部落在
 *   data/prompts/one-liner.json，后台 /admin/prompt 可以随时改、随时预览；
 * - 页面第一次打开时调的是 /api/plan，文案失败也绝不能拖垮行程（M6 降级铁律），
 *   所以本文件所有对外函数都不抛「LLM 失败」——用 { ok:false, reason } 表达，由调用方降级；
 * - 文件坏了（JSON 不合法 / zod 不通过）不许让行程挂掉：读取回退到内置默认值，
 *   并通过 fallbackReason 告诉后台「现在用的是内置默认，不是文件」。
 *
 * 铁律：
 * 1. 只允许使用行程里已有的字段（地点名、时间、停留、花费、reason）拼 prompt，
 *    不许编造行程里没有的地点 / 时间（生成结果也只回传文字，不回写任何行程字段）；
 * 2. 模型返回必须过 zod；不是合法 JSON / 缺字段 / 超长 一律当失败，不兜底修补；
 * 3. 禁止词检查放在服务端（findBannedHits），每句都带 bannedHits，前端只负责把命中的字标红；
 * 4. API Key 只从服务端环境变量读，任何日志都不许出现 key。
 *
 * 存储：
 * - data/prompts/one-liner.json           当前版本
 * - data/prompts/history/one-liner.v{n}.json  每次保存前把旧版本复制到这里的备份（只留最近 10 个）
 */

/* ------------------------------------------------------------------ *
 * 1. prompt 契约（文件形状 / 保存入参 / 预览入参）
 * ------------------------------------------------------------------ */

/** updatedAt 口径与 Place.lastVerified 一致：本地日期 "YYYY-MM-DD"。 */
const PROMPT_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 单条 example / 禁止词的长度上限（防止后台误贴一整篇文章进来）。 */
const BANNED_WORD_MAX = 20;
const EXAMPLE_MAX = 80;

/**
 * data/prompts/one-liner.json 的完整形状。
 *
 * 读文件时用这个 schema 校验；校验失败 = 文件坏了 → 回退 DEFAULT_ONE_LINER_PROMPT，
 * 不允许把半成品 prompt 喂给模型。
 */
export const OneLinerPromptSchema = z.object({
  /** 版本号：从 1 开始，每次保存 +1；保存时用它挡并发覆盖（文件版本不一致 → 409）。 */
  version: z.number().int().min(1),
  /** 主 system prompt。真正的「文案风格」就在这一段里。 */
  system: z.string().trim().min(1, "system prompt 不能为空").max(4000, "system prompt 不能超过 4000 字"),
  /** 禁止词（服务端逐句检查，命中就在响应的 bannedHits 里标出来，前端红高亮）。 */
  banned: z.array(z.string().trim().min(1).max(BANNED_WORD_MAX)).max(50),
  /** 好 / 坏例子：给调 prompt 的人做参照（也是 prompt 资产的一部分，随版本一起备份）。 */
  examples: z.object({
    good: z.array(z.string().trim().min(1).max(EXAMPLE_MAX)).max(20),
    bad: z.array(z.string().trim().min(1).max(EXAMPLE_MAX)).max(20),
  }),
  /** 最后保存日期（本地日期 "YYYY-MM-DD"）。 */
  updatedAt: z.string().regex(PROMPT_DATE_PATTERN, "updatedAt 必须是 YYYY-MM-DD"),
});
export type OneLinerPrompt = z.infer<typeof OneLinerPromptSchema>;

/** prompt 正文（不含 version / updatedAt）：保存与预览共用的入参形状。 */
export const OneLinerPromptContentSchema = z.object({
  system: z.string().trim().min(1, "system prompt 不能为空").max(4000, "system prompt 不能超过 4000 字"),
  banned: z.array(z.string().trim().min(1).max(BANNED_WORD_MAX)).max(50),
  examples: z.object({
    good: z.array(z.string().trim().min(1).max(EXAMPLE_MAX)).max(20),
    bad: z.array(z.string().trim().min(1).max(EXAMPLE_MAX)).max(20),
  }),
});
export type OneLinerPromptContent = z.infer<typeof OneLinerPromptContentSchema>;

/** POST /api/admin/prompt 的请求体：正文 + 客户端读到的版本号（并发校验用）。 */
export const OneLinerSaveInputSchema = OneLinerPromptContentSchema.extend({
  version: z.number().int().min(1),
});
export type OneLinerSaveInput = z.infer<typeof OneLinerSaveInputSchema>;

/**
 * 内置默认 prompt：任务书给的初始内容，必须与 data/prompts/one-liner.json 的初始版本逐字一致。
 *
 * 作用只有一个：文件缺失 / 文件坏了时，后台还能看到一份可用的默认值（并提示文件异常），
 * 用户可以把默认值保存回去完成修复。注意 /api/plan 在文件不可用时**不生成文案**（降级），
 * 避免用「操作者以为没生效的 prompt」产出用户可见的文案。
 */
export const DEFAULT_ONE_LINER_PROMPT: OneLinerPrompt = OneLinerPromptSchema.parse({
  version: 1,
  system:
    "你是给一份城市散步行程写旁白的人。不要写广告词。\n\n" +
    "禁止出现：让心灵、片刻宁静、品味生活、发现不一样的自己、值得一去、环境优雅、氛围感、沉浸式、治愈\n\n" +
    "只允许写「看到什么、闻到什么、听到什么、几点钟的光」这类具体的东西。每句不超过 20 字，不要形容词堆砌，不要感叹号。\n\n" +
    "好的例子：\n- 走三分钟就到，下午的光正好照在书架那排上\n- 街角那家，老板记得熟客的面\n- 江边的风比街上大，站久了会冷\n\n" +
    "坏例子（绝对不要这样写）：\n- 在书香中感受宁静时光\n- 品味地道美食，治愈你的胃\n- 让脚步慢下来，遇见更好的自己",
  banned: ["让心灵", "宁静", "治愈", "值得一去", "氛围感", "沉浸式", "品味", "遇见更好的自己"],
  examples: {
    good: ["走三分钟就到，下午的光正好照在书架那排上", "街角那家，老板记得熟客的面"],
    bad: ["在书香中感受宁静时光", "品味地道美食，治愈你的胃"],
  },
  updatedAt: "2026-10-23",
});

/* ------------------------------------------------------------------ *
 * 2. prompt 文件路径 / 读写 / 历史备份
 * ------------------------------------------------------------------ */

/** prompt 目录：基于 process.cwd()，与 lib/cityData.ts 读 data/cities 的口径一致。 */
function promptDir(): string {
  return join(process.cwd(), "data", "prompts");
}

/** 当前版本文件：data/prompts/one-liner.json。 */
function promptFilePath(): string {
  return join(promptDir(), "one-liner.json");
}

/** 历史备份目录：data/prompts/history/。 */
function historyDir(): string {
  return join(promptDir(), "history");
}

/** 历史文件名固定为 one-liner.v{n}.json，只认这个形状（其他文件一律不碰）。 */
const HISTORY_FILE_PATTERN = /^one-liner\.v(\d+)\.json$/;

/** 只保留最近 10 个历史版本（任务书要求）。 */
export const PROMPT_HISTORY_LIMIT = 10;

/** 本地日期 "YYYY-MM-DD"（与 updatedAt 口径一致）。 */
function todayLocalDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 读当前文件的结果：ok = 文件合法；missing = 没有这个文件；broken = 文件在但不合法。 */
type CurrentPromptFile =
  | { kind: "ok"; prompt: OneLinerPrompt }
  | { kind: "missing" }
  | { kind: "broken"; reason: string };

/**
 * 读当前 prompt 文件。任何失败都收敛成 missing / broken（不抛错）：
 * 读取失败不能让 /api/plan 或后台页面挂掉，降级由调用方决定。
 */
function readCurrentPromptFile(): CurrentPromptFile {
  const filePath = promptFilePath();
  if (!existsSync(filePath)) return { kind: "missing" };
  try {
    const raw = readJsonFile(filePath, "文案 prompt 文件");
    return { kind: "ok", prompt: OneLinerPromptSchema.parse(raw) };
  } catch (error) {
    const reason = errorMessage(error);
    console.error(`[llmText] prompt 文件不可用（${filePath}）：${reason}`);
    return { kind: "broken", reason };
  }
}

/** prompt 读取结果：source = file 表示读的是磁盘文件；default 表示回退到内置默认值。 */
export type PromptLoadResult = {
  prompt: OneLinerPrompt;
  source: "file" | "default";
  /** source=default 时说明为什么回退（文件缺失 / JSON 坏了 / zod 不通过），直接展示给后台。 */
  fallbackReason: string | null;
};

/**
 * 读当前 prompt。**永远不抛错**：
 * - 文件合法 → 用文件内容；
 * - 文件缺失 / 坏了 → 用内置默认值 + fallbackReason（行程和后台都不许挂）。
 */
export function loadOneLinerPrompt(): PromptLoadResult {
  const current = readCurrentPromptFile();
  if (current.kind === "ok") {
    return { prompt: current.prompt, source: "file", fallbackReason: null };
  }
  const reason =
    current.kind === "missing" ? `prompt 文件不存在：${promptFilePath()}` : current.reason;
  return { prompt: DEFAULT_ONE_LINER_PROMPT, source: "default", fallbackReason: reason };
}

/** 加载历史版本（按 version 升序，最多 10 个）。坏掉的历史文件忽略并打日志，不影响列表。 */
export function loadPromptHistory(): OneLinerPrompt[] {
  const dir = historyDir();
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    console.error(`[llmText] 读取历史目录失败（${dir}）：${errorMessage(error)}`);
    return [];
  }
  const versions: OneLinerPrompt[] = [];
  for (const name of names) {
    if (!HISTORY_FILE_PATTERN.test(name)) continue;
    try {
      const raw = readJsonFile(join(dir, name), "文案 prompt 历史版本");
      versions.push(OneLinerPromptSchema.parse(raw));
    } catch (error) {
      console.error(`[llmText] 历史版本 ${name} 不可用，已忽略：${errorMessage(error)}`);
    }
  }
  versions.sort((a, b) => a.version - b.version);
  return versions;
}

/** 把当前版本备份到 history/one-liner.v{n}.json（保存前调用）。 */
function writePromptHistory(prompt: OneLinerPrompt): void {
  writeJsonFileAtomic(join(historyDir(), `one-liner.v${prompt.version}.json`), prompt);
}

/** 只保留最近 PROMPT_HISTORY_LIMIT 个版本，超出的删最旧的（按 version 数字排序）。 */
function prunePromptHistory(): void {
  const dir = historyDir();
  if (!existsSync(dir)) return;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    console.error(`[llmText] 清理历史版本失败（读取目录）：${errorMessage(error)}`);
    return;
  }
  const entries = names
    .map((name) => {
      const match = HISTORY_FILE_PATTERN.exec(name);
      if (match === null) return null;
      return { name, version: Number(match[1]) };
    })
    .filter((entry): entry is { name: string; version: number } => entry !== null)
    .sort((a, b) => a.version - b.version);
  const excess = entries.length - PROMPT_HISTORY_LIMIT;
  if (excess <= 0) return;
  for (const entry of entries.slice(0, excess)) {
    try {
      unlinkSync(join(dir, entry.name));
      console.log(`[llmText] 历史版本超过 ${PROMPT_HISTORY_LIMIT} 个，已删除最旧的 ${entry.name}`);
    } catch (error) {
      // 删不掉不算失败：下次保存还会再清理一轮。
      console.error(`[llmText] 删除旧历史版本失败（${entry.name}）：${errorMessage(error)}`);
    }
  }
}

/** 保存时客户端版本与文件版本不一致（并发覆盖）——由 API 转成 409。 */
export class PromptVersionConflictError extends Error {
  readonly currentPrompt: OneLinerPrompt;

  constructor(currentPrompt: OneLinerPrompt) {
    super(`版本冲突：文件已经是 v${currentPrompt.version}，请刷新后再保存`);
    this.name = "PromptVersionConflictError";
    this.currentPrompt = currentPrompt;
  }
}

/** 去空 / 去重 / 去首尾空白（保持原有顺序），保存前统一清洗一遍。 */
function normalizeList(items: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of items) {
    const text = item.trim();
    if (text === "" || seen.has(text)) continue;
    seen.add(text);
    normalized.push(text);
  }
  return normalized;
}

/**
 * 保存 prompt（同步执行：Node 单线程里一整个 tick 完成，天然不会被并发写打断）：
 * 1. 版本校验：客户端 version ≠ 文件 version → 抛 PromptVersionConflictError；
 * 2. 保存前把当前版本备份成 history/one-liner.v{当前}.json；
 * 3. version + 1 写回 one-liner.json（临时文件 + rename 原子写）；
 * 4. 历史超过 10 个就删最旧的。
 *
 * 文件缺失 / 损坏属于「重建」场景（后台会用内置默认值给用户改）：
 * 不用 +1（没有可信的当前版本），直接按客户端版本号写回去，让用户可以自助修复。
 *
 * 入参必须已被 OneLinerSaveInputSchema 校验过（API 层做），这里再兜一层 zod。
 */
export function saveOneLinerPrompt(input: OneLinerSaveInput): {
  prompt: OneLinerPrompt;
  history: OneLinerPrompt[];
} {
  const parsed = OneLinerSaveInputSchema.parse(input);
  const current = readCurrentPromptFile();

  let nextVersion: number;
  if (current.kind === "ok") {
    if (current.prompt.version !== parsed.version) {
      throw new PromptVersionConflictError(current.prompt);
    }
    writePromptHistory(current.prompt);
    nextVersion = current.prompt.version + 1;
  } else {
    if (current.kind === "broken") {
      console.warn(`[llmText] prompt 文件损坏，本次保存直接重建：${current.reason}`);
    }
    nextVersion = Math.max(parsed.version, 1);
  }

  const nextPrompt: OneLinerPrompt = OneLinerPromptSchema.parse({
    version: nextVersion,
    system: parsed.system,
    banned: normalizeList(parsed.banned),
    examples: {
      good: normalizeList(parsed.examples.good),
      bad: normalizeList(parsed.examples.bad),
    },
    updatedAt: todayLocalDate(),
  });
  writeJsonFileAtomic(promptFilePath(), nextPrompt);
  prunePromptHistory();
  return { prompt: nextPrompt, history: loadPromptHistory() };
}

/* ------------------------------------------------------------------ *
 * 3. LLM 调用（/chat/completions，失败一律收敛成 { ok:false }）
 * ------------------------------------------------------------------ */

/** 默认超时：行程主链路等不起太久（M6：超时 8 秒，失败降级）。 */
const DEFAULT_CHAT_TIMEOUT_MS = 8000;

type ChatMessage = { role: "system" | "user"; content: string };

/** LLM token 用量（服务商没返回 usage 时是 null，不编数字）。 */
export type LlmUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
} | null;

export type ChatResult =
  | {
      status: "success";
      content: string;
      usage: LlmUsage;
      model: string;
      elapsedMs: number;
    }
  | { status: "failure"; reason: string; elapsedMs: number };

type LlmConfig = { baseUrl: string; apiKey: string; model: string };

/** 从服务端环境变量读 LLM 配置；没配全就返回 null（降级，不抛错）。 */
function readLlmConfig(): LlmConfig | null {
  const apiKey = (process.env.LLM_API_KEY ?? "").trim();
  const baseUrl = (process.env.LLM_BASE_URL ?? "").trim();
  if (apiKey === "" || baseUrl === "") return null;
  const model = (process.env.LLM_MODEL ?? "deepseek-chat").trim();
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    model: model === "" ? "deepseek-chat" : model,
  };
}

/** OpenAI 兼容响应的最小形状（多余字段 zod 会忽略）。 */
const ChatResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          /** deepseek 等实现可能给 null（例如只返回 reasoning），按失败处理。 */
          content: z.string().nullable(),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().min(0).optional(),
      completion_tokens: z.number().int().min(0).optional(),
      total_tokens: z.number().int().min(0).optional(),
    })
    .optional(),
});

function toUsage(raw: z.infer<typeof ChatResponseSchema>["usage"]): LlmUsage {
  if (raw === undefined) return null;
  const promptTokens = raw.prompt_tokens ?? 0;
  const completionTokens = raw.completion_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: raw.total_tokens ?? promptTokens + completionTokens,
  };
}

/**
 * 调一次 LLM（OpenAI 兼容 /chat/completions，用 fetch 直调，不装 SDK）。
 *
 * 契约：**永远不抛错**。没配置 / 超时 / 网络失败 / HTTP 非 2xx / 响应结构不对 全部返回
 * { ok:false, reason }，上层据此降级（M6 铁律：chat() 失败不能拖垮功能）。
 * 日志里绝不出现 API Key。
 */
export async function chat(
  messages: ChatMessage[],
  options?: {
    timeoutMs?: number;
    temperature?: number;
    /** 输出预算（含 reasoning 的 token；reasoning 模型开思考时不能给太小，否则 content 会被吃掉）。 */
    maxTokens?: number;
    /**
     * 关闭模型思考（reasoning_effort: "none"）。
     *
     * deepseek-flash 是 reasoning 模型：开思考时输出质量高但可能 3–20 秒，
     * 主链路首屏等不起 → /api/plan 关思考（约 1–2 秒）；
     * 控制台预览为了忠实检验「每句不超过 6 字」这类约束 → 保留思考模式。
     */
    disableReasoning?: boolean;
  },
): Promise<ChatResult> {
  const startedAt = Date.now();
  const config = readLlmConfig();
  if (config === null) {
    return { status: "failure", reason: "未配置 LLM_API_KEY / LLM_BASE_URL，文案生成跳过", elapsedMs: 0 };
  }
  const timeoutMs = options?.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.maxTokens ?? 4000,
        messages,
        // 开思考时不要传这个字段（走模型默认）；关思考时显式声明，避免 reasoning 吃掉输出预算。
        ...(options?.disableReasoning === true ? { reasoning_effort: "none" } : {}),
      }),
      signal: controller.signal,
    });
    const elapsedMs = Date.now() - startedAt;
    if (!response.ok) {
      console.error(`[llmText] LLM 返回 HTTP ${response.status}`);
      return { status: "failure", reason: `LLM 接口返回 HTTP ${response.status}`, elapsedMs };
    }
    const json: unknown = await response.json();
    const parsed = ChatResponseSchema.safeParse(json);
    if (!parsed.success) {
      return {
        status: "failure",
        reason: "LLM 响应结构不符合预期（缺少 choices[0].message.content）",
        elapsedMs,
      };
    }
    const content = (parsed.data.choices[0].message.content ?? "").trim();
    if (content === "") {
      return { status: "failure", reason: "LLM 返回了空内容", elapsedMs };
    }
    return {
      status: "success",
      content,
      usage: toUsage(parsed.data.usage),
      model: config.model,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    if (controller.signal.aborted) {
      return { status: "failure", reason: `LLM 请求超时（${timeoutMs} ms）`, elapsedMs };
    }
    return { status: "failure", reason: `LLM 请求失败：${errorMessage(error)}`, elapsedMs };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * 4. 行程文案生成（oneLiner + 每站一句）
 * ------------------------------------------------------------------ */

/** 当日分钟数 → "HH:mm"（与页面展示同一口径，不在前端做时间换算）。 */
export function formatMinuteOfDay(minute: number): string {
  const hours = Math.floor(minute / 60);
  const minutes = minute % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** 模型必须返回的 JSON 形状（多一句少一句都当结构不合格，避免前端拿到半截文案）。 */
export const ItineraryTextSchema = z.object({
  /** 整条路线的一句话总结。 */
  oneLiner: z.string().trim().min(1).max(120),
  /** 按站点顺序，每站一句。 */
  stopLines: z.array(z.string().trim().min(1).max(200)).min(1).max(12),
});
export type ItineraryText = z.infer<typeof ItineraryTextSchema>;

/** 单句文案 + 服务端命中的禁止词（前端据此红高亮）。 */
export type GeneratedLine = { text: string; bannedHits: string[] };

export type ItineraryTextResult =
  | {
      status: "success";
      oneLiner: GeneratedLine;
      /** index 与 itinerary.stops 一一对应（模型少写时按顺序对齐，缺的句子不会出现）。 */
      stopLines: Array<GeneratedLine & { index: number }>;
      model: string;
      elapsedMs: number;
      usage: LlmUsage;
      /** prompt 来源：file = 磁盘文件；default = 内置默认；override = 预览传入的临时 prompt。 */
      promptSource: "file" | "default" | "override";
      promptVersion: number | null;
    }
  | {
      status: "failure";
      reason: string;
      elapsedMs: number;
      promptSource: "file" | "default" | "override";
      promptVersion: number | null;
    };

/** 找出 text 里命中的禁止词（谁先出现不影响结果，按 banned 原顺序返回）。 */
export function findBannedHits(text: string, banned: readonly string[]): string[] {
  const hits: string[] = [];
  for (const word of banned) {
    if (word.trim() !== "" && text.includes(word)) hits.push(word);
  }
  return hits;
}

/** 从模型输出里抠出 JSON 对象：兼容 ```json 代码块 / 前后带解释的情况。 */
function extractJsonObject(content: string): string | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return content.slice(start, end + 1);
}

/**
 * 拼 user 消息：只允许使用行程里已有的字段（M6 铁律：不许编造行程里没有的地点 / 时间）。
 * 站点名优先用 placeName（planner / API 已填充快照），没有快照时退回 placeId（不猜名字）。
 */
function buildItineraryUserMessage(itinerary: Itinerary): string {
  const lines: string[] = [];
  lines.push("这是一份已经排好的城市半日行程，请按要求写文案。");
  lines.push(
    `出发 ${formatMinuteOfDay(itinerary.startAt)}，预计 ${formatMinuteOfDay(itinerary.endAt)} 结束，` +
      `总时长 ${itinerary.totalMin} 分钟，总花费约 ${itinerary.totalCost} 元。`,
  );
  lines.push("站点（按顺序）：");
  itinerary.stops.forEach((stop, index) => {
    const placeName = stop.placeName ?? stop.placeId;
    lines.push(
      `${index + 1}. ${formatMinuteOfDay(stop.arriveAt)}–${formatMinuteOfDay(stop.leaveAt)} ` +
        `${placeName}｜停留 ${stop.stayMin} 分钟｜花费约 ${stop.costEstimate} 元｜推荐理由：${stop.reason}`,
    );
  });
  lines.push("");
  lines.push("输出要求：");
  lines.push("- 必须严格遵守 system 里的每一条要求（包括每句话的格式和长度限制）；");
  lines.push(`- stopLines 必须正好 ${itinerary.stops.length} 条，顺序与上面站点一致，每站一句；`);
  lines.push("- oneLiner 用一句话概括整条路线；");
  lines.push("- 只能使用上面给出的地点、时间、停留、花费、理由，不许编造行程里没有的地点、时间或事件；");
  lines.push("- 只输出 JSON，不要解释，不要 Markdown 代码块。");
  lines.push('输出格式：{"oneLiner": "一句话", "stopLines": ["第 1 站一句", "第 2 站一句"]}');
  return lines.join("\n");
}

export type GenerateItineraryTextOptions = {
  /** 控制台预览用：直接传「正在编辑的 prompt」，不读磁盘文件。不传 = 读 data/prompts/one-liner.json。 */
  promptContent?: OneLinerPromptContent;
  /** 预览时传 override，响应里能看出用的是临时 prompt 而不是已保存版本。 */
  promptSource?: "file" | "default" | "override";
  /** prompt 文件版本号（预览不传 = null）。 */
  promptVersion?: number | null;
  timeoutMs?: number;
  /** 关思考（主链路提速用）；不传 = 保留模型默认的思考模式（控制台预览用）。 */
  disableReasoning?: boolean;
  /** 输出预算（含 reasoning token）。 */
  maxTokens?: number;
};

/**
 * 给一份行程生成 oneLiner + 每站 stopLines。
 *
 * 失败不抛错：模型没返回 JSON / 字段不合法 / 超时 / 没配置 key 全部走 { ok:false, reason }，
 * 由 /api/plan 降级（不挂文案字段，行程照常返回）或由预览接口原样展示原因。
 */
export async function generateItineraryText(
  itinerary: Itinerary,
  options?: GenerateItineraryTextOptions,
): Promise<ItineraryTextResult> {
  const override = options?.promptContent;
  const loaded = override === undefined ? loadOneLinerPrompt() : null;
  const promptContent: OneLinerPromptContent = override ?? (loaded as PromptLoadResult).prompt;
  const promptSource = options?.promptSource ?? loaded?.source ?? "override";
  const promptVersion =
    options?.promptVersion ?? (loaded === null ? null : loaded.prompt.version);

  const fail = (reason: string, elapsedMs = 0): ItineraryTextResult => ({
    status: "failure",
    reason,
    elapsedMs,
    promptSource,
    promptVersion,
  });

  if (itinerary.stops.length === 0) return fail("行程没有站点，无法生成 stopLines");

  const result = await chat(
    [
      { role: "system", content: promptContent.system },
      { role: "user", content: buildItineraryUserMessage(itinerary) },
    ],
    {
      timeoutMs: options?.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS,
      disableReasoning: options?.disableReasoning,
      maxTokens: options?.maxTokens,
    },
  );
  if (result.status === "failure") return fail(result.reason, result.elapsedMs);

  const jsonText = extractJsonObject(result.content);
  if (jsonText === null) return fail("模型返回里找不到 JSON 对象", result.elapsedMs);

  let raw: unknown;
  try {
    raw = JSON.parse(jsonText) as unknown;
  } catch {
    return fail("模型返回的 JSON 无法解析", result.elapsedMs);
  }
  const parsed = ItineraryTextSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("模型返回的文案结构不符合约定（oneLiner / stopLines）", result.elapsedMs);
  }

  // 禁止词检查全部在服务端做：每句都带上命中的词，前端只负责染色。
  const oneLiner: GeneratedLine = {
    text: parsed.data.oneLiner,
    bannedHits: findBannedHits(parsed.data.oneLiner, promptContent.banned),
  };
  const expected = itinerary.stops.length;
  if (parsed.data.stopLines.length !== expected) {
    console.warn(
      `[llmText] 模型返回 ${parsed.data.stopLines.length} 条 stopLines，行程有 ${expected} 站，按顺序对齐`,
    );
  }
  const stopLines = parsed.data.stopLines.slice(0, expected).map((text, index) => ({
    index,
    text,
    bannedHits: findBannedHits(text, promptContent.banned),
  }));

  return {
    status: "success",
    oneLiner,
    stopLines,
    model: result.model,
    elapsedMs: result.elapsedMs,
    usage: result.usage,
    promptSource,
    promptVersion,
  };
}

/** 生成结果里是否有任何一句命中禁止词（/api/plan 据此决定要不要把文案回给用户）。 */
export function hasBannedHits(result: ItineraryTextResult): boolean {
  if (result.status === "failure") return false;
  if (result.oneLiner.bannedHits.length > 0) return true;
  return result.stopLines.some((line) => line.bannedHits.length > 0);
}
