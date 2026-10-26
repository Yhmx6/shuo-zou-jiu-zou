#!/usr/bin/env node
/**
 * 「说走就走」验收工具公共库（scripts/verify/lib.mjs）
 *
 * 设计约束（与任务书一致）：
 * - 不依赖任何 npm 包：只用 Node 22 内置的 fetch / WebSocket / child_process；
 * - 不启动、不重启 dev server（假定 http://127.0.0.1:3000 已经在跑）；
 *   本地开发地址统一用 127.0.0.1：高德「Web端(JS API)」Key 的域名白名单只收域名 / IP，
 *   **localhost 不是合法域名、加不进去**（会报 INVALID_USER_DOMAIN 10006），
 *   用 localhost 打开页面时地图会降级成 SVG 示意图。可用 VERIFY_BASE_URL 覆盖。
 * - 默认用系统 Edge + CDP 驱动真实浏览器（headless），截图存 .cache/verify/；
 * - 断言失败不抛异常：收集成 PASS / FAIL / SKIP 结果，由调用方决定退出码；
 * - 本文件可以直接运行：`node scripts/verify/lib.mjs` 是一个「能截图」的最小 demo。
 *
 * 用法示例：
 *   import { apiGet, apiPost, createReport, withEdge, openPage, screenshot, capture } from './lib.mjs';
 *   const report = createReport('示例');
 *   const res = await apiGet('/api/cities');
 *   report.assert('城市列表 200', res.status === 200, `HTTP ${res.status}`);
 */

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- 常量

export const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 项目根：scripts/verify -> 上两级 */
export const ROOT = path.resolve(HERE, '..', '..');
/** 所有验收产物只写这里 */
export const VERIFY_DIR = path.join(ROOT, '.cache', 'verify');
/**
 * dev server 地址。默认 127.0.0.1 而不是 localhost：
 * 高德「Web端(JS API)」Key 的域名白名单只接受域名 / IP，localhost 不是合法域名、加不进去，
 * 用 localhost 访问时地图 SDK 会返回 INVALID_USER_DOMAIN（10006）并降级成 SVG 示意图。
 * 需要换地址（例如部署环境）时用 VERIFY_BASE_URL 覆盖。
 */
export const BASE_URL = process.env.VERIFY_BASE_URL ?? 'http://127.0.0.1:3000';
export const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
/** 本工具的 Edge 独立 profile（不要和别的验收脚本共用，避免 profile 锁冲突） */
export const EDGE_PROFILE_DIR = path.join(VERIFY_DIR, 'edge-profile');
/** 首选 9222；被占就依次尝试后面的端口（不抢占别人的 CDP 服务） */
export const CDP_PORT_CANDIDATES = [9222, 9333, 9334, 9335];
export const VIEWPORT = { width: 1280, height: 900 };

// ---------------------------------------------------------------- 测试画像（M18 开屏问答）

/**
 * M18 起页面首次进入会先问 4 个问题（components/Onboarding.tsx）。历史验收脚本（首屏 / 地图 /
 * 换站 / 再来一条…）测的都是「老用户」路径，所以这里统一在文档加载前塞一个合法 profile，
 * 让它们直接进主页；问答流程本身由 build/verify/onboarding-e2e.mjs 单独测（它传 seedProfile:false）。
 *
 * origin 按 ?city= 取对应城市的配置圆心 —— 这样和「画像出现之前，服务端默认用城市演示起点」
 * 完全一致，历史脚本的距离断言不会因为起点变了而漂移。
 */
export const TEST_PROFILE = {
  style: 'powerful',
  homeBy: null,
  scene: 'any',
  updatedAt: '2026-10-24T00:00:00.000Z',
  origins: {
    hangzhou: { lat: 30.245, lng: 120.225 },
    liaoyang: { lat: 41.247878, lng: 123.184017 },
  },
};

/** 在文档加载前写入 localStorage 的画像（已存在则不覆盖，方便单个脚本自己定制）。 */
export function testProfileBootstrapScript() {
  return `(() => {
  try {
    // 每次都覆盖：Edge 的独立 profile 会跨脚本保留上一个用例写进 localStorage 的画像，
    // 不覆盖的话「上次留下的 rich」会污染这次（例如 powerful 用例实际跑成 rich）。
    const params = new URLSearchParams(window.location.search);
    const city = params.get("city") || "hangzhou";
    const origins = ${JSON.stringify(TEST_PROFILE.origins)};
    const origin = origins[city] || origins.hangzhou;
    window.localStorage.setItem("szjz.profile", JSON.stringify({
      style: ${JSON.stringify(TEST_PROFILE.style)},
      origin: { lat: origin.lat, lng: origin.lng, label: "测试起点" },
      homeBy: ${JSON.stringify(TEST_PROFILE.homeBy)},
      scene: ${JSON.stringify(TEST_PROFILE.scene)},
      updatedAt: ${JSON.stringify(TEST_PROFILE.updatedAt)},
    }));
  } catch {}
})();`;
}

// ---------------------------------------------------------------- 基础工具

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function ensureVerifyDir() {
  if (!existsSync(VERIFY_DIR)) mkdirSync(VERIFY_DIR, { recursive: true });
  return VERIFY_DIR;
}

/** .cache/verify 下的产物路径（自动建目录） */
export function artifactPath(name) {
  ensureVerifyDir();
  return path.join(VERIFY_DIR, name);
}

/** 写文本产物（UTF-8），返回绝对路径 */
export function writeArtifact(name, content) {
  const filePath = artifactPath(name);
  writeFileSync(filePath, content, 'utf8');
  return filePath;
}

/** 写二进制产物（截图 base64 等），返回绝对路径 */
export function writeArtifactBuffer(name, buffer) {
  const filePath = artifactPath(name);
  writeFileSync(filePath, buffer);
  return filePath;
}

/** JSON 美化打印（超长截断，避免把终端刷爆） */
export function pretty(value, maxLength = 4000) {
  let text;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  if (text === undefined) text = String(value);
  if (text.length > maxLength) return `${text.slice(0, maxLength)}\n...（已截断，原长 ${text.length} 字符）`;
  return text;
}

/** 单行摘要（日志里用） */
export function oneLine(value, maxLength = 800) {
  let text;
  if (typeof value === 'string') {
    text = value.replace(/\s+/g, ' ').trim();
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  if (text === undefined) text = String(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}...（截断）` : text;
}

// ---------------------------------------------------------------- 时间（全部按本机本地时间）

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 本机当天 "YYYY-MM-DD"；offsetDays = 1 表示明天 */
export function todayLocalDate(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 当日分钟数 -> "HH:mm"（超过 1440 也按取模显示，例如 1460 -> "00:20"） */
export function formatMinute(minute) {
  const normalized = ((Math.round(minute) % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(normalized / 60))}:${pad2(normalized % 60)}`;
}

/**
 * 本机本地时间字符串 "YYYY-MM-DDTHH:mm"（事件接口的契约格式，不带时区）。
 * @param {number} offsetDays 0 = 今天，1 = 明天
 * @param {number} minuteOfDay 0..1439
 */
export function localDateTime(offsetDays, minuteOfDay) {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  return `${todayLocalDate(offsetDays)}T${pad2(hour)}:${pad2(minute)}`;
}

/** 本机当前时刻 "YYYY-MM-DDTHH:mm" */
export function localNowDateTime() {
  const date = new Date();
  return `${todayLocalDate(0)}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** 本机当前时刻的当日分钟数（15:20 -> 920） */
export function nowMinuteOfDay() {
  const date = new Date();
  return date.getHours() * 60 + date.getMinutes();
}

// ---------------------------------------------------------------- HTTP / API

/**
 * 打一个本地接口，永不抛异常（网络错误也变成 ok:false 的结果，方便优雅 FAIL）。
 *
 * 返回 { ok, status, ms, json, text, error, url, method }
 * - ok：HTTP 2xx 且响应体可解析为 JSON 且 json.ok !== false；
 * - json/text：解析结果 / 原始文本，二者都保留，方便打错误现场。
 */
export async function apiRequest(method, pathname, body, options = {}) {
  const url = pathname.startsWith('http') ? pathname : `${options.baseUrl ?? BASE_URL}${pathname}`;
  const timeoutMs = options.timeoutMs ?? 60000;
  const startedAt = Date.now();
  const init = { method, headers: {}, signal: AbortSignal.timeout(timeoutMs) };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (options.headers !== undefined) Object.assign(init.headers, options.headers);

  try {
    const response = await fetch(url, init);
    const text = await response.text();
    let json = null;
    let parseError = null;
    try {
      json = text.length === 0 ? null : JSON.parse(text);
    } catch (error) {
      parseError = error;
    }
    const result = {
      ok: response.ok && json !== null && json.ok !== false,
      status: response.status,
      ms: Date.now() - startedAt,
      json,
      text,
      parseError: parseError === null ? null : String(parseError.message),
      error: null,
      url,
      method,
    };
    if (options.verbose === true) {
      console.log(`[api] ${method} ${pathname} -> HTTP ${result.status}（${result.ms} ms）`);
    }
    return result;
  } catch (error) {
    return {
      ok: false,
      status: null,
      ms: Date.now() - startedAt,
      json: null,
      text: '',
      parseError: null,
      error: error instanceof Error ? error.message : String(error),
      url,
      method,
    };
  }
}

export function apiGet(pathname, options) {
  return apiRequest('GET', pathname, undefined, options);
}

export function apiPost(pathname, body, options) {
  return apiRequest('POST', pathname, body, options);
}

/** PATCH / DELETE 也支持 body（Next.js Route Handler 里用 request.json() 读） */
export function apiPatch(pathname, body, options) {
  return apiRequest('PATCH', pathname, body, options);
}

export function apiDelete(pathname, body, options) {
  return apiRequest('DELETE', pathname, body, options);
}

/** 接口结果的简短现场描述（HTTP 状态 + 响应体前 N 字） */
export function describeApiResult(result, maxLength = 500) {
  if (result.error !== null) return `请求失败：${result.error}`;
  const bodyText = result.text.length === 0 ? '(空响应体)' : result.text.slice(0, maxLength);
  return `HTTP ${result.status}，响应：${bodyText}`;
}

// ---------------------------------------------------------------- 报告收集

/** 统一的结果文本（对象 / 数组用 JSON，字符串原样） */
function detailText(detail) {
  if (detail === undefined || detail === null) return '';
  return typeof detail === 'string' ? detail : oneLine(detail, 1200);
}

/**
 * 结果收集器：PASS / FAIL / SKIP 都记下来，打印一行一条。
 * 断言失败只记录，不抛出；最终由 summary() / printSummary() 汇总。
 */
export function createReport(title) {
  const rows = [];
  const startedAt = Date.now();

  function record(status, name, detail) {
    const text = detailText(detail);
    rows.push({ status, name, detail: text });
    console.log(`[${status}] ${name}${text === '' ? '' : ` — ${text}`}`);
    return status === 'PASS';
  }

  return {
    title,
    section(name) {
      console.log(`\n---------- ${name} ----------`);
    },
    info(message) {
      console.log(`[INFO] ${message}`);
    },
    raw(line) {
      console.log(line);
    },
    pass(name, detail) {
      return record('PASS', name, detail);
    },
    fail(name, detail) {
      return record('FAIL', name, detail);
    },
    /** SKIP = 依赖的功能还没开发完 / 本机环境不满足，不算失败 */
    skip(name, reason) {
      return record('SKIP', name, reason);
    },
    /** 断言：condition 为真 PASS，否则 FAIL，都不抛异常 */
    assert(name, condition, detailPass, detailFail) {
      if (condition) return record('PASS', name, detailPass);
      return record('FAIL', name, detailFail ?? detailPass);
    },
    summary() {
      const pass = rows.filter((row) => row.status === 'PASS').length;
      const fail = rows.filter((row) => row.status === 'FAIL').length;
      const skip = rows.filter((row) => row.status === 'SKIP').length;
      return {
        title,
        pass,
        fail,
        skip,
        total: rows.length,
        elapsedMs: Date.now() - startedAt,
        failures: rows.filter((row) => row.status === 'FAIL'),
        skips: rows.filter((row) => row.status === 'SKIP'),
        rows,
      };
    },
    printSummary() {
      const result = this.summary();
      console.log(
        `\n===== 汇总（${title}）：PASS ${result.pass} / FAIL ${result.fail} / SKIP ${result.skip}，` +
          `共 ${result.total} 项，用时 ${(result.elapsedMs / 1000).toFixed(1)} s =====`,
      );
      if (result.failures.length > 0) {
        console.log('FAIL 项：');
        for (const row of result.failures) console.log(`  - ${row.name}${row.detail === '' ? '' : `：${row.detail}`}`);
      }
      if (result.skips.length > 0) {
        console.log('SKIP 项（等开发完成 / 环境不满足，不算失败）：');
        for (const row of result.skips) console.log(`  - ${row.name}：${row.detail}`);
      }
      return result;
    },
  };
}

// ---------------------------------------------------------------- WCAG 对比度

/** Tailwind stone 色阶（官方规范色值） */
export const STONE = {
  50: '#fafaf9',
  100: '#f5f5f4',
  200: '#e7e5e4',
  300: '#d6d3d1',
  400: '#a8a29e',
  500: '#78716c',
  600: '#57534e',
  700: '#44403c',
  800: '#292524',
  900: '#1c1917',
  950: '#0c0a09',
};
export const WHITE = '#ffffff';
export const BLACK = '#000000';

/** "#rrggbb" / "#rgb" -> { r, g, b }（0..255）；非法值抛错（验收脚本宁可炸也不静默） */
export function hexToRgb(hex) {
  let value = String(hex).trim().replace(/^#/, '');
  if (value.length === 3) value = value.split('').map((char) => char + char).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(value)) throw new Error(`不是合法的十六进制颜色：${hex}`);
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

/** WCAG 相对亮度（sRGB，0..1） */
export function relativeLuminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const channel = (value) => {
    const normalized = value / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 对比度（1..21，越大越清楚） */
export function contrastRatio(foregroundHex, backgroundHex) {
  const foreground = relativeLuminance(foregroundHex);
  const background = relativeLuminance(backgroundHex);
  const lighter = Math.max(foreground, background);
  const darker = Math.min(foreground, background);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * 生成一条可贴进报告的对比度结论。
 * requirement: '正文 > 7' / '次要 >= 4.5' 这类文字；pass 由调用方给的数值阈值决定。
 */
export function contrastLine(label, foregroundHex, backgroundHex, minimum, requirementText) {
  const ratio = contrastRatio(foregroundHex, backgroundHex);
  const pass = ratio >= minimum;
  const verdict = pass ? 'PASS' : 'FAIL';
  return {
    label,
    foreground: foregroundHex,
    background: backgroundHex,
    ratio,
    minimum,
    pass,
    text: `${label}：${foregroundHex} 对 ${backgroundHex} = ${ratio.toFixed(2)}:1（要求 ${requirementText}）${verdict}`,
  };
}

// ---------------------------------------------------------------- CDP 客户端

/**
 * 极简 Chrome DevTools Protocol 客户端：JSON-RPC over WebSocket。
 * 只用 Node 22 的全局 WebSocket（浏览器里 event.data 是字符串）。
 */
export class CdpClient {
  constructor(ws, label) {
    this.ws = ws;
    this.label = label;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();

    ws.addEventListener('message', (event) => {
      let message;
      try {
        const text = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8');
        message = JSON.parse(text);
      } catch {
        return;
      }
      if (typeof message.id === 'number') {
        const pending = this.pending.get(message.id);
        if (pending === undefined) return;
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(`CDP 错误（${message.method ?? 'response'}）：${message.error.message}（code=${message.error.code}）`));
        } else {
          pending.resolve(message.result);
        }
        return;
      }
      const handlers = this.handlers.get(message.method);
      if (handlers !== undefined) {
        for (const handler of handlers) {
          try {
            handler(message.params);
          } catch {
            /* 事件处理失败不影响验收 */
          }
        }
      }
    });

    ws.addEventListener('close', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('CDP WebSocket 已关闭'));
      this.pending.clear();
    });
  }

  static async connect(wsUrl, label = 'cdp') {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`连接 CDP WebSocket 超时：${wsUrl}`)), 10000);
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error(`连接 CDP WebSocket 失败：${wsUrl}`));
        },
        { once: true },
      );
    });
    return new CdpClient(ws, label);
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }

  send(method, params = {}, timeoutMs = 30000) {
    if (this.ws.readyState !== 1) return Promise.reject(new Error(`CDP ${method}：WebSocket 未连接`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时（${timeoutMs} ms）`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  /** 执行页面内 JS，返回按值序列化后的结果（awaitPromise = true） */
  async evaluate(expression, timeoutMs = 60000) {
    const response = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, userGesture: true },
      timeoutMs,
    );
    if (response !== undefined && response.exceptionDetails !== undefined) {
      const details = response.exceptionDetails;
      const description =
        (details.exception !== undefined && (details.exception.description ?? details.exception.value)) ??
        details.text ??
        'unknown';
      throw new Error(`页面内 evaluate 异常：${String(description).slice(0, 600)}`);
    }
    return response !== undefined && response.result !== undefined ? response.result.value : undefined;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------- 进程 / Edge 启停

function killTree(pid) {
  if (!pid) return false;
  try {
    spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', timeout: 20000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 列出命令行里带本工具 profile 路径的 msedge 进程（只可能是本工具遗留的）。
 * 用 -like 匹配 profile 绝对路径，不会误杀用户自己开着的 Edge。
 */
export function listVerifyEdgePids() {
  const pattern = `*${EDGE_PROFILE_DIR}*`;
  const psScript =
    `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | ` +
    `Where-Object { $_.CommandLine -like '${pattern}' } | ForEach-Object { $_.ProcessId }`;
  for (const shell of ['powershell.exe', 'pwsh.exe']) {
    try {
      const output = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', psScript], {
        encoding: 'utf8',
        timeout: 25000,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      return output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^\d+$/.test(line))
        .map(Number);
    } catch {
      /* 换下一个 shell */
    }
  }
  return [];
}

/** 清理上次异常退出遗留的、属于本工具 profile 的 Edge 进程 */
export function killLeftoverVerifyEdges() {
  const stale = listVerifyEdgePids();
  if (stale.length > 0) {
    console.log(`[edge] 清理上次遗留的 headless Edge 进程：${stale.join(', ')}`);
    for (const pid of stale) killTree(pid);
  }
  return stale;
}

async function httpJson(url, timeoutMs = 3000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return response.json();
}

async function isCdpAlive(port) {
  try {
    await httpJson(`http://127.0.0.1:${port}/json/version`, 700);
    return true;
  } catch {
    return false;
  }
}

/**
 * 轮询直到 fn 返回真值；超时抛错（附带最后一次错误）。
 * 用于等页面元素出现、等接口就绪这类「不确定要多久」的事情。
 */
export async function waitFor(fn, timeoutMs, intervalMs, label) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `等待超时（${timeoutMs} ms）：${label}${lastError === null ? '' : `（最后错误：${lastError.message}）`}`,
  );
}

/** 轮询页面内表达式，直到 predicate(value) 为真；返回该值 */
export async function waitForEvaluate(cdp, expression, predicate, timeoutMs, label, intervalMs = 300) {
  return waitFor(
    async () => {
      const value = await cdp.evaluate(expression);
      return predicate(value) ? value : false;
    },
    timeoutMs,
    intervalMs,
    label,
  );
}

/**
 * 启动 headless Edge 并打开 CDP 端口。
 * - 先清理本工具遗留进程；
 * - 9222 被别的 CDP 服务占用时自动换下一个端口（不抢占、不复用别人的浏览器）；
 * - 成功返回 { port, proc, version }，结束必须调 closeEdge。
 */
export async function launchEdge(options = {}) {
  if (!existsSync(EDGE_PATH)) throw new Error(`找不到 Edge：${EDGE_PATH}`);
  ensureVerifyDir();
  if (options.cleanupStale !== false) killLeftoverVerifyEdges();

  const ports = options.portCandidates ?? CDP_PORT_CANDIDATES;
  const failures = [];
  for (const port of ports) {
    if (await isCdpAlive(port)) {
      failures.push(`端口 ${port} 已有 CDP 服务应答（跳过，避免动到别人的浏览器）`);
      continue;
    }
    console.log(`[edge] 启动 headless Edge：port=${port} profile=${EDGE_PROFILE_DIR}`);
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-extensions',
      '--mute-audio',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${EDGE_PROFILE_DIR}`,
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      'about:blank',
    ];
    const proc = spawn(EDGE_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    if (proc.stderr !== null) {
      proc.stderr.on('data', (chunk) => {
        if (stderr.length < 8192) stderr += chunk.toString();
      });
    }
    let spawnError = null;
    proc.on('error', (error) => {
      spawnError = error.message;
    });

    try {
      const version = await waitFor(
        async () => {
          if (spawnError !== null) throw new Error(`spawn 失败：${spawnError}`);
          return httpJson(`http://127.0.0.1:${port}/json/version`, 900);
        },
        options.timeoutMs ?? 30000,
        400,
        `Edge CDP 就绪（http://127.0.0.1:${port}/json/version）`,
      );
      console.log(`[edge] CDP 就绪：${version.Browser ?? '(未知版本)'} port=${port} pid=${proc.pid}`);
      return { port, proc, version };
    } catch (error) {
      failures.push(`端口 ${port} 启动失败：${error.message}${stderr === '' ? '' : `；stderr=${stderr.slice(0, 300)}`}`);
      killTree(proc.pid);
      await sleep(1000);
    }
  }
  throw new Error(`无法启动 headless Edge CDP：${failures.join(' ｜ ')}`);
}

/** 关闭 headless Edge，并清掉所有带本工具 profile 的遗留进程 */
export async function closeEdge(launched) {
  const killed = [];
  if (launched !== null && launched !== undefined && launched.proc !== null && launched.proc !== undefined) {
    killTree(launched.proc.pid);
    killed.push(launched.proc.pid);
  }
  await sleep(600);
  for (const pid of listVerifyEdgePids()) {
    killTree(pid);
    killed.push(pid);
  }
  await sleep(200);
  const remaining = listVerifyEdgePids();
  console.log(`[edge] 已关闭 headless Edge（清理 ${killed.length} 个进程，剩余 ${remaining.length} 个）`);
  return { killed, remaining };
}

/** 一步到位：启动 Edge -> 跑回调 -> 无论成败都关闭 Edge */
export async function withEdge(fn, options) {
  const launched = await launchEdge(options);
  try {
    return await fn(launched);
  } finally {
    await closeEdge(launched);
  }
}

// ---------------------------------------------------------------- 页面操作

/** GET /json/list 里第一个 page 类型的 target；没有就新建一个 about:blank */
export async function getPageTarget(port) {
  try {
    const list = await httpJson(`http://127.0.0.1:${port}/json/list`, 5000);
    const page = list.find((target) => target.type === 'page');
    if (page !== undefined) return page;
  } catch {
    /* 落到新建 target */
  }
  for (const method of ['PUT', 'GET']) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
        method,
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) continue;
      const target = await response.json();
      if (target !== undefined && target.webSocketDebuggerUrl !== undefined) return target;
    } catch {
      /* 试下一个方法 */
    }
  }
  throw new Error(`CDP 没有可用的 page target（port=${port}）`);
}

/**
 * 统一 onboarding auto-skip 的注入脚本（task-20）：
 * 「每次打开都显示 4 步问答」之后，历史脚本仍按「老用户直接进主页」写；这里在页面渲染出
 * [data-testid="onboarding-skip"] 时自动点它（= 使用已有 profile 跳过问答），
 * 超时短（~15s）、失败静默（没有 profile / 没有 skip 时什么都不做）。
 * 测问答本身的脚本用环境变量 VERIFY_NO_AUTOSKIP=1 或 connectPage(..., { autoSkipOnboarding:false }) 关闭。
 */
export function onboardingAutoSkipScript() {
  return `(() => {
  try {
    if (window.__verifyAutoSkipInstalled) return;
    window.__verifyAutoSkipInstalled = true;
    window.__verifyAutoSkipClicked = false;
    if (new URLSearchParams(window.location.search).get("e2e_no_autoskip") === "1") return;
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      const button = document.querySelector('[data-testid="onboarding-skip"]');
      if (button !== null) {
        try { button.click(); window.__verifyAutoSkipClicked = true; } catch (error) {}
        window.clearInterval(timer);
        return;
      }
      if (attempts >= 150) window.clearInterval(timer);
    }, 100);
  } catch (error) {}
})();`;
}

/** 给已连接的 page 显式装上 auto-skip（connectPage 已默认自动装；显式调用用于特殊顺序场景）。 */
export async function autoSkipOnboarding(cdp) {
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: onboardingAutoSkipScript() });
}

/**
 * 连上 page target 并做基础设置（Runtime/Page/视口）。
 * 返回 { cdp, target }；调用方负责 cdp.close()。
 */
export async function connectPage(port, options = {}) {
  const target = await getPageTarget(port);
  const cdp = await CdpClient.connect(target.webSocketDebuggerUrl, options.label ?? 'page');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: options.viewport?.width ?? VIEWPORT.width,
    height: options.viewport?.height ?? VIEWPORT.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  // 默认塞一个测试画像，绕过 M18 的开屏问答（历史脚本测的是老用户路径）。
  // 测问答流程本身时传 { seedProfile: false }，由脚本自己控制 localStorage。
  if (options.seedProfile !== false) {
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: testProfileBootstrapScript() });
  }
  // task-20：页面现在「总是先问答」，历史脚本靠 profile 直接影响主页的路径失效，
  // 统一注入 auto-skip（有 profile → 顶部出现「跳过」→ 自动点掉）；失败静默。
  // 测问答本身的脚本：环境变量 VERIFY_NO_AUTOSKIP=1（或本选项 false）关闭。
  if (options.autoSkipOnboarding !== false && process.env.VERIFY_NO_AUTOSKIP !== '1') {
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: onboardingAutoSkipScript() });
  }
  return { cdp, target };
}

/** 打开页面（不等待业务就绪；调用方自己轮询页面内条件） */
export async function openPage(port, url, options = {}) {
  const { cdp } = await connectPage(port, options);
  await cdp.send('Page.navigate', { url });
  try {
    await cdp.send('Page.bringToFront');
  } catch {
    /* 无头的 bringToFront 可能失败，不影响截图 */
  }
  return cdp;
}

/** 截图存 .cache/verify/<name>，返回 { path, bytes } */
export async function screenshot(cdp, name) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, 30000);
  const filePath = artifactPath(name);
  writeFileSync(filePath, Buffer.from(result.data, 'base64'));
  const bytes = statSync(filePath).size;
  console.log(`[shot] ${filePath}（${bytes} bytes）`);
  return { path: filePath, bytes };
}

/**
 * 挂上页面 console / 异常收集，返回收集器。
 * 只记录，不判定失败；Next dev 的编译提示 / 警告也会进来，报告时按需展示。
 */
export function createConsoleCollector(cdp) {
  const errors = [];
  const warnings = [];

  const formatArgs = (args) =>
    (args ?? [])
      .map((arg) => {
        if (arg === undefined) return 'undefined';
        if (arg.value !== undefined) return String(arg.value);
        if (arg.description !== undefined) return String(arg.description);
        if (arg.unserializableValue !== undefined) return String(arg.unserializableValue);
        return arg.type ?? 'arg';
      })
      .join(' ');

  cdp.on('Runtime.exceptionThrown', (params) => {
    const details = params?.exceptionDetails;
    const text =
      (details?.exception !== undefined && (details.exception.description ?? details.exception.value)) ??
      details?.text ??
      'unknown exception';
    errors.push(String(text).slice(0, 1200));
  });
  cdp.on('Runtime.consoleAPICalled', (params) => {
    if (params?.type === 'error' || params?.type === 'assert') {
      errors.push(formatArgs(params.args).slice(0, 1200));
    } else if (params?.type === 'warning') {
      warnings.push(formatArgs(params.args).slice(0, 600));
    }
  });

  return { errors, warnings };
}

// ---------------------------------------------------------------- 最小 demo（直接运行本文件时）

async function runDemo() {
  ensureVerifyDir();
  console.log('lib.mjs 最小 demo：apiGet + headless Edge CDP 截图');
  const health = await apiGet('/api/cities', { timeoutMs: 20000 });
  console.log(`[demo] /api/cities -> HTTP ${health.status}（${health.ms} ms）ok=${health.ok}`);

  const launched = await launchEdge();
  const cdp = await openPage(launched.port, `${BASE_URL}/?city=liaoyang`);
  try {
    const readyState = await waitForEvaluate(
      cdp,
      'document.readyState',
      (value) => value === 'complete',
      60000,
      '页面 readyState=complete',
    );
    await sleep(2500);
    const info = await cdp.evaluate(
      '({ url: location.href, title: document.title, mainText: (document.body.innerText || "").slice(0, 200), readyState: document.readyState })',
    );
    const shot = await screenshot(cdp, 'cdp-demo.png');
    console.log(`[demo] readyState=${readyState} url=${info.url}`);
    console.log(`[demo] title=${JSON.stringify(info.title)}`);
    console.log(`[demo] body 摘要：${oneLine(info.mainText, 200)}`);
    console.log(`[demo] 截图成功：${shot.path}（${shot.bytes} bytes）`);
    console.log('[demo] PASS：Node + Edge CDP + 截图链路可用');
    return 0;
  } finally {
    cdp.close();
    await closeEdge(launched);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  runDemo()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`[demo] FAIL：${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
