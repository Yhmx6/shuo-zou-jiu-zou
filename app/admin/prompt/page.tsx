"use client";

import { useCallback, useEffect, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

/**
 * 文案 prompt 控制台（本地后台，不做鉴权）。
 *
 * 两块：
 * - 编辑区：system prompt / 禁止词 / 好例子 / 坏例子，保存时带 version 做冲突校验；
 *    「恢复上一版」只把 history 里 version 最大的内容载入编辑区，不自动保存。
 * - 预览区：用固定样例行程 + **当前编辑区内容**（未保存的也算）调一次预览接口，
 *    展示 oneLiner 与每站一句，并按服务端返回的 bannedHits 标红命中禁止词的句子。
 *
 * 接口契约见 app/api/admin/prompt/route.ts；本文件不读取任何服务端模块。
 * 失败一律原样展示服务端 reason，前端不重写规则、不自己判禁止词。
 */

type PromptExamples = {
  good: string[];
  bad: string[];
};

type PromptItem = {
  version: number;
  system: string;
  banned: string[];
  examples: PromptExamples;
  updatedAt?: string;
};

type FixtureStop = {
  placeName?: string;
  arriveAtText?: string;
  leaveAtText?: string;
  stayMin?: number;
};

type Fixture = {
  cityName?: string;
  startAtText?: string;
  endAtText?: string;
  totalMin?: number;
  totalCost?: number;
  stops?: FixtureStop[];
};

type Usage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

type PreviewLine = {
  text?: string;
  bannedHits?: string[];
};

type PreviewStopLine = PreviewLine & {
  index?: number;
  placeName?: string;
  arriveAtText?: string;
};

/** GET /api/admin/prompt */
type PromptGetResponse = {
  ok?: boolean;
  reason?: string;
  prompt?: PromptItem;
  source?: "file" | "default";
  fallbackReason?: string | null;
  history?: PromptItem[];
  fixture?: Fixture;
};

/** POST /api/admin/prompt（保存） */
type PromptSaveResponse = {
  ok?: boolean;
  reason?: string;
  currentVersion?: number;
  prompt?: PromptItem;
  history?: PromptItem[];
};

/** POST /api/admin/prompt?action=preview */
type PromptPreviewResponse = {
  ok?: boolean;
  reason?: string;
  model?: string;
  elapsedMs?: number;
  usage?: Usage | null;
  banned?: string[];
  fixture?: Fixture;
  oneLiner?: PreviewLine;
  stopLines?: PreviewStopLine[];
};

type Notice = {
  kind: "success" | "error" | "info";
  text: string;
};

type PreviewState = {
  model: string;
  elapsedMs: number | null;
  usage: Usage | null;
  fixture: Fixture | null;
  oneLiner: PreviewLine | null;
  stopLines: PreviewStopLine[];
};

/** 读 JSON 响应；不是 JSON（例如路由还没实现时的 404 HTML）则回退成空对象，由调用方按 HTTP 状态兜底。 */
async function readJson<T>(response: Response): Promise<T> {
  try {
    const data: unknown = await response.json();
    if (data !== null && typeof data === "object") return data as T;
  } catch {
    // 落到空对象
  }
  return {} as T;
}

/** 所有请求统一 cache: "no-store"，后台数据不吃浏览器缓存。 */
async function requestJson<T>(url: string, init?: RequestInit): Promise<{ status: number; data: T }> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  return { status: response.status, data: await readJson<T>(response) };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 宽进：服务端字段缺失 / 类型不对时回落到安全默认值，页面不因单个字段崩。 */
function normalizePrompt(raw?: PromptItem): PromptItem {
  const version = raw?.version;
  const system = raw?.system;
  const banned = raw?.banned;
  const good = raw?.examples?.good;
  const bad = raw?.examples?.bad;
  const updatedAt = raw?.updatedAt;
  return {
    version: typeof version === "number" ? version : 0,
    system: typeof system === "string" ? system : "",
    banned: Array.isArray(banned) ? banned.filter((word) => typeof word === "string") : [],
    examples: {
      good: Array.isArray(good) ? good.filter((line) => typeof line === "string") : [],
      bad: Array.isArray(bad) ? bad.filter((line) => typeof line === "string") : [],
    },
    updatedAt: typeof updatedAt === "string" ? updatedAt : undefined,
  };
}

/** 提交前整理例子：去首尾空白、丢空行（空行存进去没有意义，还会让 prompt 变脏）。 */
function cleanLines(lines: string[]): string[] {
  return lines.map((line) => line.trim()).filter((line) => line !== "");
}

/** history 按 version 升序返回；这里再取一次最大值，顺序变了也不会载入错版本。 */
function latestHistoryItem(history: PromptItem[]): PromptItem | null {
  if (history.length === 0) return null;
  return history.reduce((latest, item) => (item.version > latest.version ? item : latest));
}

function fixtureTitle(fixture: Fixture | null): string {
  if (!fixture) return "固定样例行程";
  const stopCount = Array.isArray(fixture.stops) ? fixture.stops.length : 0;
  const parts: string[] = [];
  if (typeof fixture.cityName === "string" && fixture.cityName !== "") parts.push(fixture.cityName);
  if (typeof fixture.startAtText === "string" && fixture.startAtText !== "") parts.push(`${fixture.startAtText} 出发`);
  if (stopCount > 0) parts.push(`${stopCount} 站`);
  return parts.length > 0 ? parts.join(" · ") : "固定样例行程";
}

function fixtureDetail(fixture: Fixture | null): string {
  if (!fixture) return "";
  const parts: string[] = [];
  if (typeof fixture.endAtText === "string" && fixture.endAtText !== "") parts.push(`${fixture.endAtText} 结束`);
  if (typeof fixture.totalMin === "number") parts.push(`共 ${fixture.totalMin} 分钟`);
  if (typeof fixture.totalCost === "number") parts.push(`约 ${fixture.totalCost} 元`);
  return parts.join(" · ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 禁止词高亮：只按服务端返回的一行里的 bannedHits 标红，前端不自己扫全文。
 * hits 里可能有互相包含的词，按长度降序参与正则，优先匹配更长的。
 */
function highlightBanned(text: string, hits: string[] | undefined): ReactNode {
  const words = Array.from(new Set((hits ?? []).filter((word) => typeof word === "string" && word !== ""))).sort(
    (a, b) => b.length - a.length,
  );
  if (text === "") return <span className="text-stone-500">（空）</span>;
  if (words.length === 0) return text;
  const pattern = new RegExp(`(${words.map(escapeRegExp).join("|")})`, "g");
  return text.split(pattern).map((piece, index) => {
    if (piece === "") return null;
    if (words.includes(piece)) {
      return (
        <mark key={index} className="rounded bg-red-100 px-0.5 text-red-700">
          {piece}
        </mark>
      );
    }
    return <span key={index}>{piece}</span>;
  });
}

function BannedBadge({ hits }: { hits: string[] }) {
  if (hits.length === 0) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-700"
      title={`命中禁止词：${hits.join("、")}`}
    >
      含禁止词
      <span className="font-normal">（{hits.join("、")}）</span>
    </span>
  );
}

function ExampleList({
  title,
  hint,
  items,
  onChange,
  onRemove,
  onAdd,
}: {
  title: string;
  hint: string;
  items: string[];
  onChange: (index: number, value: string) => void;
  onRemove: (index: number) => void;
  onAdd: () => void;
}) {
  return (
    <div>
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs text-stone-500">{hint}</span>
      </div>
      <div className="space-y-2">
        {items.length === 0 && <p className="text-xs text-stone-500">暂无，可点「+ 添加一行」。</p>}
        {items.map((item, index) => (
          <div key={index} className="flex items-center gap-2">
            <input
              value={item}
              onChange={(event) => onChange(index, event.target.value)}
              className="min-w-0 flex-1 rounded border border-stone-300 bg-white px-2 py-1 text-sm text-stone-800 placeholder:text-stone-500"
              placeholder={`${title}第 ${index + 1} 行`}
            />
            <button
              type="button"
              onClick={() => onRemove(index)}
              aria-label={`删除${title}第 ${index + 1} 行`}
              title={`删除${title}第 ${index + 1} 行`}
              className="rounded border border-stone-300 px-2 py-1 text-sm text-stone-500 hover:bg-stone-50 hover:text-stone-800"
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <button type="button" onClick={onAdd} className="mt-2 text-sm text-blue-600 hover:underline">
        + 添加一行
      </button>
    </div>
  );
}

export default function PromptAdminPage() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  /** 当前已保存版本（保存请求带的就是它）；null = 还没读到。 */
  const [version, setVersion] = useState<number | null>(null);
  const [source, setSource] = useState<"file" | "default" | null>(null);
  const [fallbackReason, setFallbackReason] = useState<string | null>(null);
  const [fixture, setFixture] = useState<Fixture | null>(null);
  const [history, setHistory] = useState<PromptItem[]>([]);

  /** 编辑区状态（未保存的脏状态只在这里，不随保存/预览失败被冲掉）。 */
  const [system, setSystem] = useState("");
  const [banned, setBanned] = useState<string[]>([]);
  const [bannedInput, setBannedInput] = useState("");
  const [goodExamples, setGoodExamples] = useState<string[]>([]);
  const [badExamples, setBadExamples] = useState<string[]>([]);

  const [saving, setSaving] = useState(false);
  const [saveNotice, setSaveNotice] = useState<Notice | null>(null);

  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [preview, setPreview] = useState<PreviewState | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const { status, data } = await requestJson<PromptGetResponse>("/api/admin/prompt");
      if (!data.ok || !data.prompt) {
        setLoadError(data.reason ?? `读取失败（HTTP ${status}）`);
        return;
      }
      const prompt = normalizePrompt(data.prompt);
      setVersion(prompt.version);
      setSystem(prompt.system);
      setBanned(prompt.banned);
      setGoodExamples(prompt.examples.good);
      setBadExamples(prompt.examples.bad);
      setSource(data.source === "default" ? "default" : "file");
      setFallbackReason(typeof data.fallbackReason === "string" && data.fallbackReason !== "" ? data.fallbackReason : null);
      setHistory(Array.isArray(data.history) ? data.history.map((item) => normalizePrompt(item)) : []);
      setFixture(data.fixture ?? null);
    } catch (error) {
      setLoadError(errorText(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const addBanned = () => {
    const parts = bannedInput
      .split(/[,，]/)
      .map((part) => part.trim())
      .filter((part) => part !== "");
    setBannedInput("");
    if (parts.length === 0) return;
    setBanned((prev) => {
      const seen = new Set(prev);
      const next = [...prev];
      for (const part of parts) {
        if (!seen.has(part)) {
          seen.add(part);
          next.push(part);
        }
      }
      return next;
    });
  };

  const handleBannedKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // 中文输入法回车确认候选词时不要误添加（isComposing）。
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      addBanned();
    }
  };

  const removeBanned = (word: string) => {
    setBanned((prev) => prev.filter((item) => item !== word));
  };

  const updateExample = (kind: "good" | "bad", index: number, value: string) => {
    if (kind === "good") {
      setGoodExamples((prev) => prev.map((item, i) => (i === index ? value : item)));
      return;
    }
    setBadExamples((prev) => prev.map((item, i) => (i === index ? value : item)));
  };

  const removeExample = (kind: "good" | "bad", index: number) => {
    if (kind === "good") {
      setGoodExamples((prev) => prev.filter((_, i) => i !== index));
      return;
    }
    setBadExamples((prev) => prev.filter((_, i) => i !== index));
  };

  const addExample = (kind: "good" | "bad") => {
    if (kind === "good") {
      setGoodExamples((prev) => [...prev, ""]);
      return;
    }
    setBadExamples((prev) => [...prev, ""]);
  };

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    setSaveNotice(null);
    try {
      const { status, data } = await requestJson<PromptSaveResponse>("/api/admin/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: version ?? 0,
          system,
          banned,
          examples: { good: cleanLines(goodExamples), bad: cleanLines(badExamples) },
        }),
      });
      if (!data.ok) {
        // 含 409：把服务端 reason 原样显示，不在前端猜冲突版本。
        setSaveNotice({ kind: "error", text: data.reason ?? `保存失败（HTTP ${status}）` });
        return;
      }
      const saved = normalizePrompt(data.prompt);
      if (data.prompt) {
        setVersion(saved.version);
        setSystem(saved.system);
        setBanned(saved.banned);
        setGoodExamples(saved.examples.good);
        setBadExamples(saved.examples.bad);
      }
      if (Array.isArray(data.history)) setHistory(data.history.map((item) => normalizePrompt(item)));
      setSaveNotice({ kind: "success", text: `已保存为 v${data.prompt?.version ?? saved.version}` });
    } catch (error) {
      setSaveNotice({ kind: "error", text: errorText(error) });
    } finally {
      setSaving(false);
    }
  };

  const handleRestore = () => {
    const latest = latestHistoryItem(history);
    if (!latest) {
      setSaveNotice({ kind: "info", text: "没有历史版本" });
      return;
    }
    const restored = normalizePrompt(latest);
    setSystem(restored.system);
    setBanned(restored.banned);
    setGoodExamples(restored.examples.good);
    setBadExamples(restored.examples.bad);
    // 只载入编辑区，不自动保存，也不改当前版本号。
    setSaveNotice({ kind: "info", text: `已载入 v${restored.version} 的内容（未保存）` });
  };

  const handlePreview = async () => {
    if (previewing) return;
    setPreviewing(true);
    setPreviewError("");
    try {
      const { status, data } = await requestJson<PromptPreviewResponse>("/api/admin/prompt?action=preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system,
          banned,
          examples: { good: cleanLines(goodExamples), bad: cleanLines(badExamples) },
        }),
      });
      if (!data.ok) {
        setPreviewError(data.reason ?? `预览失败（HTTP ${status}）`);
        return;
      }
      setPreview({
        model: typeof data.model === "string" ? data.model : "",
        elapsedMs: typeof data.elapsedMs === "number" ? data.elapsedMs : null,
        usage: data.usage ?? null,
        fixture: data.fixture ?? fixture,
        oneLiner: data.oneLiner ?? null,
        stopLines: Array.isArray(data.stopLines) ? data.stopLines : [],
      });
    } catch (error) {
      setPreviewError(errorText(error));
    } finally {
      setPreviewing(false);
    }
  };

  const noticeClass =
    saveNotice?.kind === "success"
      ? "text-green-700"
      : saveNotice?.kind === "error"
        ? "text-red-600"
        : "text-stone-600";

  return (
    <main className="mx-auto max-w-6xl bg-white px-4 py-6 pb-16 text-stone-800">
      {/* 与 app/admin/page.tsx 一致：本地后台的显式提醒，首屏 HTML 里必须能看到这句话。 */}
      <div className="mb-5 rounded border-2 border-red-500 bg-red-50 px-4 py-3 text-center text-base font-bold text-red-600">
        本地后台，请勿公开部署
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-bold">文案 prompt 控制台</h1>
        <a href="/admin" className="text-sm text-blue-600 hover:underline">
          返回后台
        </a>
      </div>

      {loading && <p className="text-sm text-stone-500">读取中…</p>}

      {!loading && loadError !== "" && <p className="text-sm text-red-600">{loadError}</p>}

      {!loading && loadError === "" && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded border border-stone-200 bg-stone-50 px-3 py-2 text-sm">
            <span>
              当前已保存版本 <strong className="font-mono">v{version ?? "—"}</strong>
            </span>
            <span className="text-xs text-stone-500">
              来源：{source === "default" ? "内置默认值" : "prompt 文件"}
            </span>
            {history.length > 0 && <span className="text-xs text-stone-500">历史 {history.length} 版</span>}
          </div>

          {source === "default" && (
            <div className="mb-5 rounded border border-yellow-400 bg-yellow-50 px-4 py-3 text-sm text-yellow-800">
              <p className="font-medium">文件读取失败，正在使用内置默认值。</p>
              <p className="mt-1 whitespace-pre-wrap break-words">
                {fallbackReason ?? "（服务端未返回 fallbackReason）"}
              </p>
            </div>
          )}

          <section className="mb-10">
            <h2 className="mb-3 text-base font-bold">编辑区</h2>
            <div className="rounded border border-stone-200 p-4">
              <div className="mb-5">
                <label htmlFor="prompt-system" className="mb-1 block text-sm font-medium">
                  system prompt
                </label>
                <p className="mb-2 text-xs text-stone-500">
                  生成「一句话行程文案 + 每站一句」时使用的系统提示词，保存后写回 prompt 文件。
                </p>
                <textarea
                  id="prompt-system"
                  rows={12}
                  value={system}
                  onChange={(event) => setSystem(event.target.value)}
                  spellCheck={false}
                  className="w-full resize-y rounded border border-stone-300 bg-white px-3 py-2 font-mono text-sm leading-6 text-stone-800 placeholder:text-stone-500"
                />
                <p className="mt-1 text-right text-xs text-stone-500">{system.length} 字</p>
              </div>

              <div className="mb-5">
                <span className="mb-1 block text-sm font-medium">禁止词</span>
                <p className="mb-2 text-xs text-stone-500">
                  文案里命中这些词会标红。输入后按 Enter 或点「添加」；支持用中英文逗号分隔批量添加，自动去重。
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  {banned.length === 0 && <span className="text-xs text-stone-500">暂无禁止词</span>}
                  {banned.map((word) => (
                    <span
                      key={word}
                      className="inline-flex items-center gap-1 rounded border border-stone-200 bg-stone-100 px-2 py-0.5 text-sm"
                    >
                      {word}
                      <button
                        type="button"
                        onClick={() => removeBanned(word)}
                        aria-label={`删除禁止词 ${word}`}
                        title={`删除禁止词 ${word}`}
                        className="text-stone-500 hover:text-stone-800"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    value={bannedInput}
                    onChange={(event) => setBannedInput(event.target.value)}
                    onKeyDown={handleBannedKeyDown}
                    placeholder="例如：让心灵、必去"
                    aria-label="添加禁止词"
                    className="w-64 rounded border border-stone-300 bg-white px-2 py-1 text-sm text-stone-800 placeholder:text-stone-500"
                  />
                  <button
                    type="button"
                    onClick={addBanned}
                    className="rounded border border-stone-300 px-3 py-1 text-sm hover:bg-stone-50"
                  >
                    添加
                  </button>
                </div>
              </div>

              <div className="grid gap-5 md:grid-cols-2">
                <ExampleList
                  title="好例子"
                  hint="希望模型学到的写法"
                  items={goodExamples}
                  onChange={(index, value) => updateExample("good", index, value)}
                  onRemove={(index) => removeExample("good", index)}
                  onAdd={() => addExample("good")}
                />
                <ExampleList
                  title="坏例子"
                  hint="要避免的写法"
                  items={badExamples}
                  onChange={(index, value) => updateExample("bad", index, value)}
                  onRemove={(index) => removeExample("bad", index)}
                  onAdd={() => addExample("bad")}
                />
              </div>

              <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={handleRestore}
                  disabled={saving || history.length === 0}
                  title={history.length === 0 ? "没有历史版本" : "载入历史里版本最大的内容到编辑区（不自动保存）"}
                  className="rounded border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-50 disabled:opacity-50"
                >
                  恢复上一版
                </button>
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={saving}
                  className="rounded bg-blue-600 px-4 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {saving ? "保存中…" : "保存"}
                </button>
              </div>

              {saveNotice && <p className={`mt-3 text-right text-sm ${noticeClass}`}>{saveNotice.text}</p>}

              <div className="mt-4 border-t border-stone-200 pt-3">
                <p className="mb-1 text-xs font-medium text-stone-500">历史版本（按版本升序）</p>
                {history.length === 0 ? (
                  <p className="text-xs text-stone-500">暂无历史版本</p>
                ) : (
                  <ul className="flex flex-wrap gap-2 text-xs text-stone-600">
                    {history.map((item) => (
                      <li key={item.version} className="rounded border border-stone-200 bg-stone-50 px-2 py-0.5">
                        v{item.version}
                        {item.updatedAt ? ` · ${item.updatedAt}` : ""}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </section>

          <section className="rounded border border-stone-200 p-4">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-bold">预览</h2>
                <p className="mt-1 text-xs text-stone-500">
                  用当前编辑区内容（未保存的也算）生成一次固定样例行程；只调接口，不写文件、不影响已保存版本。
                </p>
                <p className="mt-1 text-xs text-stone-500">样例行程：{fixtureTitle(fixture)}</p>
              </div>
              <button
                type="button"
                onClick={() => void handlePreview()}
                disabled={previewing}
                className="rounded bg-blue-600 px-4 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {previewing ? "生成中…" : "试一下"}
              </button>
            </div>

            {previewError !== "" && (
              <p className="mt-3 whitespace-pre-wrap break-words rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
                {previewError}
              </p>
            )}

            {preview && (
              <div className="mt-4 rounded border border-stone-200 bg-stone-50 p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-stone-500">
                  <span>样例行程：{fixtureTitle(preview.fixture ?? fixture)}</span>
                  {fixtureDetail(preview.fixture ?? fixture) !== "" && (
                    <span>{fixtureDetail(preview.fixture ?? fixture)}</span>
                  )}
                </div>

                <div className="mb-5">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-bold text-stone-700">oneLiner</h3>
                    <BannedBadge hits={Array.isArray(preview.oneLiner?.bannedHits) ? preview.oneLiner.bannedHits : []} />
                  </div>
                  <p className="text-xl font-medium leading-relaxed text-stone-800">
                    {highlightBanned(
                      typeof preview.oneLiner?.text === "string" ? preview.oneLiner.text : "",
                      Array.isArray(preview.oneLiner?.bannedHits) ? preview.oneLiner.bannedHits : [],
                    )}
                  </p>
                </div>

                <div>
                  <h3 className="mb-2 text-sm font-bold text-stone-700">每站一句</h3>
                  {preview.stopLines.length === 0 ? (
                    <p className="text-sm text-stone-500">没有返回 stopLines。</p>
                  ) : (
                    <ul className="space-y-2">
                      {preview.stopLines.map((line, index) => {
                        const stopIndex = typeof line.index === "number" ? line.index : index;
                        const stop = Array.isArray(preview.fixture?.stops) ? preview.fixture.stops[stopIndex] : undefined;
                        const placeName =
                          typeof line.placeName === "string" && line.placeName !== ""
                            ? line.placeName
                            : (stop?.placeName ?? `第 ${index + 1} 站`);
                        const arriveAtText =
                          typeof line.arriveAtText === "string" && line.arriveAtText !== ""
                            ? line.arriveAtText
                            : (stop?.arriveAtText ?? "");
                        const hits = Array.isArray(line.bannedHits) ? line.bannedHits : [];
                        return (
                          <li
                            key={`${stopIndex}-${index}`}
                            className="rounded border border-stone-200 bg-white px-3 py-2"
                          >
                            <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-stone-500">
                              <span className="font-medium text-stone-700">
                                {index + 1}. {placeName}
                              </span>
                              {arriveAtText !== "" && <span>{arriveAtText} 到达</span>}
                              <BannedBadge hits={hits} />
                            </div>
                            <p className="text-sm leading-relaxed text-stone-800">
                              {highlightBanned(typeof line.text === "string" ? line.text : "", hits)}
                            </p>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-stone-200 pt-3 text-xs text-stone-500">
                  <span>耗时：{typeof preview.elapsedMs === "number" ? `${preview.elapsedMs} ms` : "—"}</span>
                  <span>模型：{preview.model !== "" ? preview.model : "—"}</span>
                  <span>
                    token：prompt {preview.usage?.promptTokens ?? "—"} / completion{" "}
                    {preview.usage?.completionTokens ?? "—"} / total {preview.usage?.totalTokens ?? "—"}
                  </span>
                </div>
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
