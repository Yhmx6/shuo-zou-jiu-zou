import { NextResponse } from "next/server";
import { z } from "zod";
import {
  OneLinerPromptContentSchema,
  OneLinerSaveInputSchema,
  PromptVersionConflictError,
  formatMinuteOfDay,
  generateItineraryText,
  loadOneLinerPrompt,
  loadPromptHistory,
  saveOneLinerPrompt,
} from "@/lib/llmText";
import { SAMPLE_ITINERARY, SAMPLE_ITINERARY_CITY } from "@/lib/fixtures/sampleItinerary";

/**
 * 文案控制台（/admin/prompt）的唯一后端入口（本地开发用的后台，不做鉴权）。
 *
 * - GET  → 当前 prompt + 来源（file / default）+ 回退原因 + 历史版本列表 + 预览用样例行程摘要
 * - POST { version, system, banned, examples }            → 保存（版本校验，冲突 409）
 * - POST ?action=preview { system, banned, examples }     → 用请求体里的临时 prompt + 固定样例行程
 *   调一次 LLM，**不写任何文件**，返回 oneLiner / stopLines / 耗时 / token 用量 / 每句 bannedHits
 *
 * 三条硬约束：
 * 1. 预览必须用「正在编辑的 prompt」（请求体），不是已保存的——否则改了看不到效果；
 * 2. 禁止词检查在服务端（lib/llmText.ts 的 findBannedHits），响应里逐句标 bannedHits，前端只染色；
 * 3. 保存前把当前版本备份到 data/prompts/history/one-liner.v{n}.json，version+1，只留最近 10 个。
 *
 * 返回统一信封：
 * - 成功 { ok:true, ... }
 * - 失败 { ok:false, reason, errors?:[{ path, message }] }（400 / 409 / 500）
 * 口径与 /api/admin/places、/api/admin/events 保持一致，控制台复用同一套错误处理。
 */

export const dynamic = "force-dynamic";

/**
 * 预览是「人等在屏幕前调 prompt」，可以比主链路宽松：超时 60 秒、输出预算 5000
 * （预览保留模型思考模式，才能忠实检验「每句不超过 6 字」这类细约束）。
 */
const PREVIEW_TIMEOUT_MS = 60000;
const PREVIEW_MAX_TOKENS = 5000;

type FieldIssue = { path: string; message: string };

function failure(status: number, reason: string, errors?: FieldIssue[]) {
  return NextResponse.json(
    errors === undefined ? { ok: false as const, reason } : { ok: false as const, reason, errors },
    { status },
  );
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 预览区展示用的样例行程摘要（固定来自 lib/fixtures/sampleItinerary.ts，不是客户端传的）。
 * 只给后台显示「这次预览用的是哪份行程」，不参与生成逻辑。
 */
function fixtureSummary() {
  return {
    cityName: SAMPLE_ITINERARY_CITY,
    startAtText: formatMinuteOfDay(SAMPLE_ITINERARY.startAt),
    endAtText: formatMinuteOfDay(SAMPLE_ITINERARY.endAt),
    totalMin: SAMPLE_ITINERARY.totalMin,
    totalCost: SAMPLE_ITINERARY.totalCost,
    stops: SAMPLE_ITINERARY.stops.map((stop) => ({
      placeName: stop.placeName ?? stop.placeId,
      arriveAtText: formatMinuteOfDay(stop.arriveAt),
      leaveAtText: formatMinuteOfDay(stop.leaveAt),
      stayMin: stop.stayMin,
    })),
  };
}

/** GET：当前 prompt + 来源 + 历史版本 + 预览样例行程摘要。 */
export async function GET() {
  const loaded = loadOneLinerPrompt();
  return NextResponse.json({
    ok: true,
    prompt: loaded.prompt,
    source: loaded.source,
    /** source="default"（文件缺失 / 坏了）时告诉后台为什么回退到内置默认值。 */
    fallbackReason: loaded.fallbackReason,
    history: loadPromptHistory(),
    fixture: fixtureSummary(),
  });
}

/**
 * POST：默认是「保存」；带 ?action=preview 是「用临时 prompt 试一下」。
 * 未知 action 直接 400，不猜测语义。
 */
export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return failure(400, "请求体不是合法 JSON");
  }

  const action = new URL(request.url).searchParams.get("action");
  if (action === "preview") return preview(payload);
  if (action !== null && action !== "") return failure(400, `未知的 action：${action}`);
  return save(payload);
}

function save(payload: unknown) {
  const parsed = OneLinerSaveInputSchema.safeParse(payload);
  if (!parsed.success) {
    return failure(400, `请求参数不合法：${describeIssues(parsed.error)}`, fieldIssues(parsed.error));
  }
  try {
    const result = saveOneLinerPrompt(parsed.data);
    return NextResponse.json({ ok: true, prompt: result.prompt, history: result.history });
  } catch (error) {
    if (error instanceof PromptVersionConflictError) {
      // 并发覆盖：把文件当前版本和内容一起带回去，后台刷新后可以基于最新版本重试。
      return NextResponse.json(
        {
          ok: false,
          reason: error.message,
          currentVersion: error.currentPrompt.version,
          prompt: error.currentPrompt,
          history: loadPromptHistory(),
        },
        { status: 409 },
      );
    }
    if (error instanceof z.ZodError) {
      return failure(400, `请求参数不合法：${describeIssues(error)}`, fieldIssues(error));
    }
    console.error(`[api/admin/prompt] 保存失败：${errorMessage(error)}`);
    return failure(500, `保存失败：${errorMessage(error)}`);
  }
}

/** 预览：临时 prompt + 固定样例行程，调一次 LLM；无论成败都不写文件。 */
async function preview(payload: unknown) {
  const parsed = OneLinerPromptContentSchema.safeParse(payload);
  if (!parsed.success) {
    return failure(400, `请求参数不合法：${describeIssues(parsed.error)}`, fieldIssues(parsed.error));
  }

  const result = await generateItineraryText(SAMPLE_ITINERARY, {
    promptContent: parsed.data,
    promptSource: "override",
    promptVersion: null,
    timeoutMs: PREVIEW_TIMEOUT_MS,
    maxTokens: PREVIEW_MAX_TOKENS,
  });

  if (result.status === "failure") {
    // 生成失败不是「请求打错了」：返回 200 + ok:false，后台照常显示原因（和 /api/plan 的降级口径一致）。
    return NextResponse.json({
      ok: false,
      reason: result.reason,
      elapsedMs: result.elapsedMs,
      banned: parsed.data.banned,
      fixture: fixtureSummary(),
    });
  }

  const fixtureStops = SAMPLE_ITINERARY.stops;
  return NextResponse.json({
    ok: true,
    model: result.model,
    elapsedMs: result.elapsedMs,
    usage: result.usage,
    banned: parsed.data.banned,
    fixture: fixtureSummary(),
    /** 一句话总结：text + 服务端命中的禁止词（前端把命中的词标红）。 */
    oneLiner: {
      text: result.oneLiner.text,
      bannedHits: result.oneLiner.bannedHits,
    },
    /** 每站一句：带上站点名 / 到达时间方便后台对照（都来自固定样例行程，不是模型编的）。 */
    stopLines: result.stopLines.map((line) => {
      const stop = fixtureStops[line.index];
      return {
        index: line.index,
        placeName: stop === undefined ? `第 ${line.index + 1} 站` : (stop.placeName ?? stop.placeId),
        arriveAtText: stop === undefined ? "" : formatMinuteOfDay(stop.arriveAt),
        text: line.text,
        bannedHits: line.bannedHits,
      };
    }),
  });
}
