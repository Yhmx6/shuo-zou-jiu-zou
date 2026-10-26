#!/usr/bin/env node
/**
 * manual 层瘦身 · 浏览器/文件/进程内写入验收（scripts/verify/manual-layer-acceptance.mjs）
 *
 * 契约：build/manual-layer-contract.md（§4 A–E 全部 20 条，含 11b）
 * 任务：build/admin-map-contract.md 上一轮已交付；本脚本只读 + 可逆写入自测。
 *
 * 覆盖：
 *   A. 文件格式（A1–A5）：北京 116 条 {id,importance}；辽阳 141 条（140 条两键 + 大剧院 {id,importance,scenery}）；
 *      顺序=主文件顺序；importance 分布；体积；顶层只有 places；备份/clean 基线/瘦身前原件；dry-run 幂等 0 变更；红线文件 SHA256 不变、无新增依赖。
 *   B. 数据不变式（B6–B7）：独立 tsx 进程 loadCity() 与 merged-before 快照 JSON 完全相等；
 *      GET /api/admin/places 除 origin 外逐字段与快照相等（同一顺序），total=116/141。
 *   C. origin 新语义（C8–C10）：北京 116 全 main；辽阳 140 main + B0FFGEKXKE manual；
 *      后台 1280×900 来源列「自动/手工」；行内按钮「隐藏/删除」（截图证据）。
 *   D. 写入方最小格式（D11–D15）：进程内 import route handler 调 GET/PATCH/POST/DELETE，
 *      测 PATCH 同值 / 整份表单不变值 / 只改 name / importance 新值 / DELETE / POST+DELETE，
 *      每次核对 manual 文件逐字节 sha256；结束从 <city>.manual.clean.json 还原并核对 sha256（全局 finally 双保险）。
 *   E. 回归：tsc / lint / check:city（与基线 13 通过 / 1 失败一致）/ 上轮地图验收 / admin-ui / api-checks --only=sort / 控制台无 error。
 *
 * 跑法（项目根；dev server 3000 已在跑，勿重启/勿点写操作）：
 *   node scripts/verify/manual-layer-acceptance.mjs
 *   node scripts/verify/manual-layer-acceptance.mjs --no-regression   # 跳过 E 组重回归
 *   node scripts/verify/manual-layer-acceptance.mjs --no-write        # 跳过 D 组写测试（仍做文件还原核对）
 *   node scripts/verify/manual-layer-acceptance.mjs --dump-helpers    # 只生成两个 tsx 助手（不跑验收）
 *
 * 硬约束：
 * - 浏览器只读：/admin 只看来源列/按钮，不点任何写操作；
 * - 写路径测试走「进程内 route handler」（npx tsx import app/api/admin/places/route），不经过 dev server；
 * - 写测试可逆：运行前备份、每一步核对、结束（含异常路径）从 <city>.manual.clean.json 还原并核对 sha256；
 * - 浏览器独占：build/.verify-lock（内容 verifier-manual），跑自己的浏览器/写测阶段时持有，跑 E 组前释放；
 * - 只写 verifier 范围：scripts/verify/manual-layer-acceptance.mjs、.cache/verify/、build/reports/manual-shrink/；
 * - 不新增 npm 依赖；退出码 0 = 全 PASS/SKIP 无 FAIL。
 */

import {
  ROOT,
  apiGet,
  closeEdge,
  connectPage,
  createConsoleCollector,
  createReport,
  launchEdge,
  screenshot,
  sleep,
  waitForEvaluate,
} from "./lib.mjs";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

const ROOT_DIR = ROOT;
const APP = (process.env.VERIFY_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const ADMIN_URL = `${APP}/admin`;
const REPORT_DIR = path.join(ROOT_DIR, "build", "reports", "manual-shrink");
const CACHE_DIR = path.join(ROOT_DIR, ".cache", "verify");
const BASELINE_DIR = path.join(CACHE_DIR, "manual-baseline");
const ADMIN_MAP_REPORT_DIR = path.join(ROOT_DIR, "build", "reports", "admin-map");
const ADMIN_MAP_BACKUP_DIR = path.join(CACHE_DIR, "admin-map-regression-backup");
const LOCK = path.join(ROOT_DIR, "build", ".verify-lock");
const LOCK_NAME = "verifier-manual";
const INVARIANT_HELPER = path.join(CACHE_DIR, "manual-invariant.mts");
const WRITE_HELPER = path.join(CACHE_DIR, "manual-write-tests.mts");
const VIEWPORT = { width: 1280, height: 900 };
const DATA_DIR = path.join(ROOT_DIR, "data", "cities");

const REPORT = createReport("manual 层瘦身 · 验收");

const ARGS = process.argv.slice(2);
const SKIP_REGRESSION = ARGS.includes("--no-regression");
const SKIP_WRITE = ARGS.includes("--no-write");
const DUMP_HELPERS = ARGS.includes("--dump-helpers");

/** 城市与期望值（build/manual-layer-contract.md §0 / §2）。 */
const CITIES = [
  {
    id: "beijing",
    label: "北京",
    manualCount: 116,
    importanceDist: { 1: 13, 2: 63, 3: 30, 4: 7, 5: 3 },
    specialId: null,
    specialExtraFields: [],
    /** 瘦身前 manual 体积（契约 §0：66KB）。 */
    origExpectedBytes: 66001,
  },
  {
    id: "liaoyang",
    label: "辽阳",
    manualCount: 141,
    importanceDist: { 1: 16, 2: 92, 3: 17, 4: 4, 5: 12 },
    specialId: "B0FFGEKXKE",
    specialExtraFields: ["scenery"],
    origExpectedBytes: 79292,
    specialName: "辽阳大剧院",
  },
];

/** 实现冻结版本 hash（SHA256 前 16 位，Lead 提供；防止验收到旧代码）。 */
const IMPL_FROZEN_HASHES = {
  "lib/cityData.ts": "5FA0AC6D0CE24CAD",
  "app/api/admin/places/route.ts": "3662E8CF1C9ED580",
  "scripts/rate-places.ts": "01573552E16988D4",
  "scripts/shrink-manual.ts": "41B9A3F97F0738EE",
};

/** manual 基线完整 SHA256（= build/reports/manual-shrink/<city>.sha256.txt 的 manual.clean）。 */
const MANUAL_CLEAN_SHA = {
  beijing: "8020670aabf22fb4e83ab8bdb5aa5cd25b6c45fb42e0973d224048fce80c30d0",
  liaoyang: "bcb80b8103d2e95e5c0f610473ea9adc374ded9dcfbe453a59ea217abb0993bb",
};

/** 本轮不该碰的文件 SHA256（A5 + contract §5 额外红线）。 */
const FROZEN_HASHES = {
  "types/schema.ts": "387ab987f9b76782325cc2650b9d6a143df5316176e1acdc88f0784d9115f220",
  "data/cities/beijing.json": "312b6e10de29a0b2432a80d9aecdeda6bb830aab463772b770532b9a16907448",
  "data/cities/liaoyang.json": "c052b58c5fa59772527935dfb10660d3e0bae0d1f74f1fd616967a0dd67db381",
  "scripts/fetch-seed.ts": "e833204e44d3eda1db730ba381d12694a453dfc8686e1af3b9ac59ce96976487",
  "package.json": "a5059add3a1b9b9c4a87fbc5204ffca6a74e09312376684025e9d1c7ddfaeb94",
  "package-lock.json": "04cfe37e0966a2690bf0efa33c5616c75007d6fc3a0045c037780185584f54ef",
  // contract §5 额外红线（本轮不许改）
  "lib/planner.ts": "39e67609c6323e39872c7a78736c73c9644cc52d53749afac5bdd5be493629f0",
  "app/admin/page.tsx": "7cb2d0e60b50a7780d946e8a45197bcc98e77865740b84c0f2240aaa95625a9b",
  "components/AdminPlacesMap.tsx": "b54edaa0e512e198276402256eb197b955e322e4c16e4d4c7bd8710a8b5b3c07",
  "components/adminMapStyle.ts": "e376d3c9b9bfe23dc91df33b46165e03d1bcd1a31f4cf5f82cfa791166855f55",
};

/** 依赖基线（本轮不许新增依赖；package.json hash 已能覆盖，这里再做一次显式集合比较）。 */
const BASELINE_DEPENDENCIES = ["@amap/amap-jsapi-loader", "next", "react", "react-dom", "zod"];
const BASELINE_DEV_DEPENDENCIES = [
  "@types/node",
  "@types/react",
  "@types/react-dom",
  "eslint",
  "eslint-config-next",
  "postcss",
  "tailwindcss",
  "tsx",
  "typescript",
];

/** check:city 基线：本轮之前就存在的失败（hangzhou.json、liaoyang.events.json 未登记）。 */
const CHECK_CITY_BASELINE = {
  passCount: 13,
  failCount: 1,
  failText: "索引未登记的城市文件：hangzhou.json、liaoyang.events.json",
};

/** contract §2/§4 A.2 字面键序 vs §3.4 PlaceSchema 顺序：实现按 §3.4，契约内部冲突，见报告备注。 */
const SPECIAL_KEY_ORDER_CONTRACT = ["id", "importance", "scenery"];
const SPECIAL_KEY_ORDER_SCHEMA = ["id", "scenery", "importance"];

/** 控制台 error 过滤（与 build/verify/map-plugin-smoke.mjs 同口径）。 */
const CONSOLE_NOISE = /AMap|INVALID_USER_DOMAIN|amap|favicon|Failed to load resource|ERR_NETWORK|ERR_BLOCKED_BY_CLIENT|WebSocket connection|\[HMR\]|\[Fast Refresh\]/;

const GROUPS = {
  env: "0. 环境与基线（server / manual 基线 / 实现冻结 hash）",
  a: "A. 文件格式（A1–A5）",
  b: "B. 数据不变式（B6–B7）",
  c: "C. origin 新语义（C8–C10）",
  d: "D. 写入方最小格式（D11–D15，进程内 route handler + 可逆还原）",
  e: "E. 回归（E16–E20）",
  g: "G. 数据还原复核（测试后 manual sha256 = clean 基线）",
};
const GROUP_ORDER = Object.values(GROUPS);

/* ------------------------------------------------------------------ *
 * 通用工具
 * ------------------------------------------------------------------ */

function messageText(error) {
  return error instanceof Error ? error.message : String(error);
}

function truncate(value, maxLength) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}…（截断，原长 ${text.length}）` : text;
}

function rel(filePath) {
  if (filePath === null || filePath === undefined) return "(无)";
  return path.relative(ROOT_DIR, filePath).replace(/\\/g, "/");
}

function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function sha256File(absPath) {
  try {
    return sha256Buffer(readFileSync(absPath));
  } catch {
    return null;
  }
}

function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function first16(sha) {
  return sha === null || sha === undefined ? "(null)" : String(sha).slice(0, 16);
}

function readText(absPath) {
  try {
    return readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
}

function readJsonFile(absPath) {
  const text = readText(absPath);
  if (text === null) return { ok: false, value: null, text: null, error: "文件不存在或不可读" };
  try {
    return { ok: true, value: JSON.parse(text), text, error: null };
  } catch (error) {
    return { ok: false, value: null, text, error: messageText(error) };
  }
}

function deepEqual(left, right) {
  if (left === right) return true;
  if (left === null || left === undefined || right === null || right === undefined) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) if (!deepEqual(left[index], right[index])) return false;
    return true;
  }
  if (typeof left === "object" && typeof right === "object") {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    for (const key of leftKeys) {
      if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
      if (!deepEqual(left[key], right[key])) return false;
    }
    return true;
  }
  return false;
}

function firstDifference(left, right, where = "$") {
  if (deepEqual(left, right)) return null;
  if (left === null || right === null || left === undefined || right === undefined || typeof left !== "object" || typeof right !== "object") {
    return `${where}: ${truncate(left, 120)} ≠ ${truncate(right, 120)}`;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return `${where}: 数组类型不一致`;
    if (left.length !== right.length) return `${where}: 长度 ${left.length} ≠ ${right.length}`;
    for (let index = 0; index < left.length; index += 1) {
      const diff = firstDifference(left[index], right[index], `${where}[${index}]`);
      if (diff !== null) return diff;
    }
    return `${where}: 未知差异`;
  }
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    const diff = firstDifference(left[key], right[key], `${where}.${key}`);
    if (diff !== null) return diff;
  }
  return `${where}: 未知差异`;
}

function placesOf(value) {
  if (Array.isArray(value)) return value;
  if (value !== null && value !== undefined && Array.isArray(value.places)) return value.places;
  return null;
}

function parseShaTxt(cityId) {
  const absPath = path.join(REPORT_DIR, `${cityId}.sha256.txt`);
  const text = readText(absPath);
  const values = {};
  if (text !== null) {
    for (const line of text.split(/\r?\n/)) {
      const match = /^([A-Za-z0-9_.]+)=(.*)$/.exec(line.trim());
      if (match !== null) values[match[1]] = match[2];
    }
  }
  return values;
}

function manualPathOf(cityId) {
  return path.join(DATA_DIR, `${cityId}.manual.json`);
}

function mainPathOf(cityId) {
  return path.join(DATA_DIR, `${cityId}.json`);
}

function cleanPathOf(cityId) {
  return path.join(REPORT_DIR, `${cityId}.manual.clean.json`);
}

function origPathOf(cityId) {
  return path.join(REPORT_DIR, `${cityId}.manual.orig.json`);
}

function mergedBeforePathOf(cityId) {
  return path.join(REPORT_DIR, `${cityId}.merged-before.json`);
}

function formatBytes(bytes) {
  if (typeof bytes !== "number") return "(?)";
  return `${bytes} B（${(bytes / 1024).toFixed(1)} KB）`;
}

async function sleepSafe(ms) {
  await sleep(ms);
}

/* ------------------------------------------------------------------ *
 * 结果记录 / 报告
 * ------------------------------------------------------------------ */

function addCheck(state, group, id, name, status, expected, actual, extra) {
  const entry = {
    group: group,
    id: id,
    name: name,
    status: status,
    expected: truncate(String(expected), 500),
    actual: truncate(String(actual), 1000),
  };
  if (extra !== undefined) entry.extra = extra;
  state.checks.push(entry);
  const line = `期望 ${entry.expected}；实际 ${entry.actual}`;
  if (status === "PASS") REPORT.pass(`${id} ${name}`, line);
  else if (status === "FAIL") REPORT.fail(`${id} ${name}`, line);
  else REPORT.skip(`${id} ${name}`, line);
  return status === "PASS";
}

function check(state, group, id, name, condition, expected, actual, extra) {
  return addCheck(state, group, id, name, condition ? "PASS" : "FAIL", expected, actual, extra);
}

function skipCheck(state, group, id, name, reason) {
  return addCheck(state, group, id, name, "SKIP", "(前置条件)", reason);
}

function infoLog(message) {
  REPORT.info(message);
}

/* ------------------------------------------------------------------ *
 * 子进程 / 日志
 * ------------------------------------------------------------------ */

function runCommand(state, label, command, options = {}) {
  ensureDirs();
  const timeoutMs = options.timeoutMs ?? 300_000;
  const startedAt = Date.now();
  console.log(`[cmd] ${label}：${command}`);
  const result = spawnSync(command, {
    shell: true,
    cwd: ROOT_DIR,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: options.env ?? process.env,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const elapsedMs = Date.now() - startedAt;
  const logPath = path.join(REPORT_DIR, `${label}.log`);
  try {
    writeFileSync(logPath, `$ ${command}\n\n[stdout]\n${stdout}\n[stderr]\n${stderr}\n`, "utf8");
  } catch (error) {
    infoLog(`写 ${label} 日志失败：${messageText(error)}`);
  }
  return {
    label,
    command,
    status: result.status,
    signal: result.signal ?? null,
    stdout,
    stderr,
    output: `${stdout}\n${stderr}`,
    elapsedMs,
    logPath,
  };
}

function parseSummaryLine(text) {
  // 汇总行可能不止一条（例如回归脚本内部又跑了 admin-ui，会先打印它自己的 PASS/FAIL 汇总）；
  // 取最后一条才是被测脚本自己的最终汇总。
  const matches = [...String(text).matchAll(/PASS (\d+) \/ FAIL (\d+) \/ SKIP (\d+)/g)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1];
  return { pass: Number(last[1]), fail: Number(last[2]), skip: Number(last[3]), summaryLine: last[0] };
}

function tailLines(text, count) {
  return String(text).trim().split(/\r?\n/).filter((line) => line.trim() !== "").slice(-count).join("\n");
}

/* ------------------------------------------------------------------ *
 * 目录 / 锁 / 截图
 * ------------------------------------------------------------------ */

function ensureDirs() {
  for (const dir of [REPORT_DIR, CACHE_DIR, BASELINE_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

async function acquireLock() {
  const deadline = Date.now() + 5 * 60 * 1000;
  for (;;) {
    if (!existsSync(LOCK)) {
      try {
        writeFileSync(LOCK, LOCK_NAME, { flag: "wx" });
        console.log(`[lock] 已获取 build/.verify-lock（${LOCK_NAME}）`);
        return;
      } catch (error) {
        if (error === null || error === undefined || error.code !== "EEXIST") throw error;
      }
    }
    const owner = existsSync(LOCK) ? readText(LOCK).trim() : "(未知)";
    if (Date.now() > deadline) throw new Error(`build/.verify-lock 被「${owner}」占用超过 5 分钟，需要 Lead 协调`);
    console.log(`[lock] build/.verify-lock 被「${owner}」占用，60s 后重试…`);
    await sleepSafe(60_000);
  }
}

function releaseLock() {
  try {
    if (existsSync(LOCK)) {
      unlinkSync(LOCK);
      console.log("[lock] 已释放 build/.verify-lock");
    }
  } catch {
    /* ignore */
  }
}

async function safeShot(cdp, state, name) {
  try {
    const result = await screenshot(cdp, name);
    state.screenshots[name] = result.path;
    return result;
  } catch (error) {
    state.screenshots[name] = null;
    console.warn(`[shot] 截图失败 ${name}：${messageText(error)}`);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * tsx 助手源码（独立进程：数据不变式 / 进程内写测试）
 * ------------------------------------------------------------------ */

function buildInvariantHelperSource() {
  const cityIds = JSON.stringify(CITIES.map((city) => city.id));
  return String.raw`#!/usr/bin/env tsx
/**
 * manual 层「瘦身后合并数据 = 瘦身前快照」独立进程断言（由 scripts/verify/manual-layer-acceptance.mjs 生成）。
 * 跑法：npx tsx .cache/verify/manual-invariant.mts（项目根）。输出一行 __INVARIANT_JSON__{...}。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { loadCity } from "../../lib/cityData";

const CITIES = ${cityIds};
const REPORT_DIR = join(process.cwd(), "build", "reports", "manual-shrink");

function readText(filePath: string): string | null {
  try { return readFileSync(filePath, "utf8"); } catch { return null; }
}
function readJson(filePath: string): unknown {
  const text = readText(filePath);
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return null; }
}
function placesOf(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (value !== null && value !== undefined && Array.isArray((value as { places?: unknown }).places)) {
    return (value as { places: unknown[] }).places;
  }
  return null;
}
function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || left === undefined || right === null || right === undefined) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) if (!deepEqual(left[index], right[index])) return false;
    return true;
  }
  if (typeof left === "object" && typeof right === "object") {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord);
    const rightKeys = Object.keys(rightRecord);
    if (leftKeys.length !== rightKeys.length) return false;
    for (const key of leftKeys) {
      if (!Object.prototype.hasOwnProperty.call(rightRecord, key)) return false;
      if (!deepEqual(leftRecord[key], rightRecord[key])) return false;
    }
    return true;
  }
  return false;
}
function firstDifference(left: unknown, right: unknown, where: string): string | null {
  if (deepEqual(left, right)) return null;
  if (left === null || right === null || left === undefined || right === undefined || typeof left !== "object" || typeof right !== "object") {
    return where + ": " + JSON.stringify(left) + " != " + JSON.stringify(right);
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return where + ": 数组类型不一致";
    if (left.length !== right.length) return where + ": 长度 " + left.length + " != " + right.length;
    for (let index = 0; index < left.length; index += 1) {
      const diff = firstDifference(left[index], right[index], where + "[" + index + "]");
      if (diff !== null) return diff;
    }
    return where + ": 未知差异";
  }
  const record = left as Record<string, unknown>;
  const other = right as Record<string, unknown>;
  const keys = new Set([...Object.keys(record), ...Object.keys(other)]);
  for (const key of keys) {
    const diff = firstDifference(record[key], other[key], where + "." + key);
    if (diff !== null) return diff;
  }
  return where + ": 未知差异";
}
function parseShaTxt(city: string): Record<string, string> {
  const text = readText(join(REPORT_DIR, city + ".sha256.txt"));
  const result: Record<string, string> = {};
  if (text === null) return result;
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_.]+)=(.*)$/.exec(line.trim());
    if (match !== null) result[match[1]] = match[2];
  }
  return result;
}

const output: Record<string, unknown> = { cities: {} };
for (const city of CITIES) {
  const result: Record<string, unknown> = {};
  const shaTxt = parseShaTxt(city);
  result.shaTxt = shaTxt;
  const beforePlaces = placesOf(readJson(join(REPORT_DIR, city + ".merged-before.json")));
  result.beforeExists = beforePlaces !== null;
  result.beforeCount = beforePlaces === null ? null : beforePlaces.length;
  const beforeCompact = beforePlaces === null ? null : JSON.stringify(beforePlaces);
  result.mergedBeforeCompactSha = beforeCompact === null ? null : sha256Text(beforeCompact);
  result.mergedBeforeShaMatchesTxt =
    result.mergedBeforeCompactSha !== null && result.mergedBeforeCompactSha === shaTxt["merged.before.sha256"];
  result.mergedBeforeEqualsAfter =
    typeof shaTxt["merged.before.sha256"] === "string" && shaTxt["merged.before.sha256"] === shaTxt["merged.after.sha256"];

  try {
    const current = loadCity(city);
    result.currentCount = current.places.length;
    result.currentEqualsBefore = beforePlaces !== null && deepEqual(current.places, beforePlaces);
    result.currentCompactSha = sha256Text(JSON.stringify(current.places));
    result.currentCompactShaEqualsBefore = result.currentCompactSha === result.mergedBeforeCompactSha;
    result.currentFirstDifference = beforePlaces === null ? null : firstDifference(current.places, beforePlaces, "places");
  } catch (error) {
    result.loadError = String(error);
  }

  const manualPath = join(process.cwd(), "data", "cities", city + ".manual.json");
  const manualText = readText(manualPath);
  result.manualSha = manualText === null ? null : sha256Text(manualText);
  result.manualShaMatchesClean = manualText !== null && result.manualSha === shaTxt["manual.clean"];
  const cleanText = readText(join(REPORT_DIR, city + ".manual.clean.json"));
  result.cleanExists = cleanText !== null;
  result.cleanSha = cleanText === null ? null : sha256Text(cleanText);
  result.cleanMatchesManual = cleanText !== null && manualText !== null && cleanText === manualText;
  result.cleanShaMatchesTxt = result.cleanSha !== null && result.cleanSha === shaTxt["manual.clean"];

  const origPlaces = placesOf(readJson(join(REPORT_DIR, city + ".manual.orig.json")));
  const origText = readText(join(REPORT_DIR, city + ".manual.orig.json"));
  result.origExists = origText !== null;
  if (origText !== null) {
    result.origSha = sha256Text(origText);
    result.origShaMatchesTxt = result.origSha === shaTxt["manual.orig"];
    result.origCount = origPlaces === null ? null : origPlaces.length;
    result.origEntriesComplete =
      origPlaces !== null &&
      origPlaces.every((place) => place !== null && typeof (place as { id?: unknown }).id === "string" && Object.keys(place as Record<string, unknown>).length > 2);
    const mainRaw = readJson(join(process.cwd(), "data", "cities", city + ".json")) as { places?: unknown[] } | null;
    const mainPlaces = mainRaw !== null && Array.isArray(mainRaw.places) ? mainRaw.places : null;
    if (origPlaces !== null && mainPlaces !== null) {
      const byId = new Map<string, unknown>();
      for (const place of origPlaces) byId.set(String((place as { id: unknown }).id), place);
      const merged: unknown[] = [];
      const used = new Set<string>();
      for (const place of mainPlaces) {
        const id = String((place as { id: unknown }).id);
        const override = byId.get(id);
        if (override === undefined) {
          merged.push(place);
        } else {
          merged.push(override);
          used.add(id);
        }
      }
      for (const place of origPlaces) {
        const id = String((place as { id: unknown }).id);
        if (!used.has(id)) merged.push(place);
      }
      result.origMergeCount = merged.length;
      result.origMergeEqualsBefore = beforePlaces !== null && deepEqual(merged, beforePlaces);
      result.origMergeFirstDifference = beforePlaces === null ? null : firstDifference(merged, beforePlaces, "origMerge");
    }
  }
  (output.cities as Record<string, unknown>)[city] = result;
}

console.log("__INVARIANT_JSON__" + JSON.stringify(output));
`;
}

function buildWriteHelperSource() {
  return String.raw`#!/usr/bin/env tsx
/**
 * manual 层写入路径测试（由 scripts/verify/manual-layer-acceptance.mjs 生成）：
 * 进程内 import app/api/admin/places/route.ts 的 GET/POST/PATCH/DELETE，用 new Request(...) 调用。
 *
 * 只做可逆操作；finally 里一定从 build/reports/manual-shrink/<city>.manual.clean.json 还原两个城市，
 * 并核对 sha256 = sha256.txt 的 manual.clean。输出一行 __WRITE_TEST_JSON__{...}。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DELETE, GET, PATCH, POST } from "../../app/api/admin/places/route";
// contract §4 D 的 tsx 坑：route handler 里 import 的是 "@/lib/cityData"；
// 这里用同一个 alias specifier，确保 clearCityCache() 清的是 route 模块实例的那份 LRU。
import { clearCityCache } from "@/lib/cityData";

const ROOT = process.cwd();
const REPORT_DIR = join(ROOT, "build", "reports", "manual-shrink");
const CITIES = ["beijing", "liaoyang"];
const BASE_URL = "http://127.0.0.1:3000";

const results: Array<Record<string, unknown>> = [];
function record(step: string, name: string, ok: boolean, detail: string): void {
  results.push({ step: step, name: name, status: ok ? "PASS" : "FAIL", detail: detail });
}
function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}
function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
function readText(filePath: string): string | null {
  try { return readFileSync(filePath, "utf8"); } catch { return null; }
}
function readJson(filePath: string): unknown {
  const text = readText(filePath);
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return null; }
}
function manualPath(city: string): string {
  return join(ROOT, "data", "cities", city + ".manual.json");
}
function cleanPath(city: string): string {
  return join(REPORT_DIR, city + ".manual.clean.json");
}
function fileSha(city: string): string {
  return sha256Buffer(readFileSync(manualPath(city)));
}
function manualEntries(city: string): Array<Record<string, unknown>> | null {
  const raw = readJson(manualPath(city));
  if (raw === null || !Array.isArray((raw as { places?: unknown }).places)) return null;
  return (raw as { places: Array<Record<string, unknown>> }).places;
}
function parseShaTxt(city: string): Record<string, string> {
  const text = readText(join(REPORT_DIR, city + ".sha256.txt"));
  const result: Record<string, string> = {};
  if (text === null) return result;
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_.]+)=(.*)$/.exec(line.trim());
    if (match !== null) result[match[1]] = match[2];
  }
  return result;
}
function restoreCity(city: string): void {
  const cleanText = readText(cleanPath(city));
  if (cleanText === null) throw new Error("clean 基线不存在：" + cleanPath(city));
  writeFileSync(manualPath(city), cleanText, "utf8");
  clearCityCache();
}
function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || left === undefined || right === null || right === undefined) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) if (!deepEqual(left[index], right[index])) return false;
    return true;
  }
  if (typeof left === "object" && typeof right === "object") {
    const a = left as Record<string, unknown>;
    const b = right as Record<string, unknown>;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      if (!deepEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}
type ApiResult = { status: number; json: Record<string, unknown> | null; text: string };
async function callRoute(method: string, pathname: string, body?: unknown): Promise<ApiResult> {
  const init: RequestInit = { method: method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const request = new Request(BASE_URL + pathname, init);
  const handler = method === "GET" ? GET : method === "POST" ? POST : method === "PATCH" ? PATCH : DELETE;
  const response = await handler(request);
  const text = await response.text();
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = null; }
  return { status: response.status, json: json, text: text };
}
function extractEntries(json: Record<string, unknown> | null): Array<Record<string, unknown>> {
  if (json === null) return [];
  const places = (json as { places?: unknown }).places;
  return Array.isArray(places) ? (places as Array<Record<string, unknown>>) : [];
}

const summary: Record<string, unknown> = { results: results };
const baseline: Record<string, unknown> = {};
try {
  // ---------- setup：当前文件必须 = clean 基线 ----------
  for (const city of CITIES) {
    const shaTxt = parseShaTxt(city);
    const current = fileSha(city);
    baseline[city] = { currentSha: current, cleanSha: shaTxt["manual.clean"] };
    record("setup", city + " manual 文件当前 sha = clean 基线", current === shaTxt["manual.clean"], "current=" + current.slice(0, 16) + "… clean=" + String(shaTxt["manual.clean"]).slice(0, 16) + "…");
  }
  if (Object.values(baseline).some((item) => (item as { currentSha: string }).currentSha !== (item as { cleanSha: string }).cleanSha)) {
    throw new Error("启动写测试前 manual 文件 != clean 基线，已中止（外层会从 clean 还原）");
  }

  // ---------- 选择 beijing 主文件点（第 1 条覆盖条目） ----------
  const beijingEntries = manualEntries("beijing");
  if (beijingEntries === null) throw new Error("读不到 beijing.manual.json 的 places");
  const target = beijingEntries.find((entry) => typeof entry.importance === "number" && typeof entry.id === "string");
  if (target === undefined) throw new Error("beijing manual 里没有 {id,importance} 条目");
  const targetId = String(target.id);
  const origImportance = Number(target.importance);
  const baselineSha = fileSha("beijing");
  const baselineCount = beijingEntries.length;
  const baselineEntries = beijingEntries.slice();
  summary.target = { city: "beijing", id: targetId, origImportance: origImportance, baselineSha: baselineSha, baselineCount: baselineCount };
  record("setup", "选定 beijing 测试点与基线", true, "id=" + targetId + "，importance=" + origImportance + "，baselineSha=" + baselineSha.slice(0, 16) + "…");

  const getRow = async (): Promise<Record<string, unknown> | null> => {
    const response = await callRoute("GET", "/api/admin/places?city=beijing&includeHidden=1");
    return extractEntries(response.json).find((row) => row.id === targetId) ?? null;
  };

  // ---------- D11：PATCH {importance: 原值} → 文件逐字节不变 ----------
  try {
    const response = await callRoute("PATCH", "/api/admin/places", { city: "beijing", id: targetId, patch: { importance: origImportance } });
    const row = (response.json?.place ?? null) as Record<string, unknown> | null;
    record("D11", "PATCH importance=原值 HTTP 200 + 值不变", response.status === 200 && response.json?.ok === true && row?.importance === origImportance, "HTTP " + response.status + "，importance=" + (row?.importance ?? "(无)") + "，origin=" + (response.json?.origin ?? "(无)"));
    const afterSha = fileSha("beijing");
    record("D11", "PATCH 同值后 manual 文件逐字节不变", afterSha === baselineSha, "sha=" + afterSha.slice(0, 16) + "… vs baseline=" + baselineSha.slice(0, 16) + "…");
  } catch (error) {
    record("D11", "PATCH importance=原值 执行", false, "异常：" + String(error));
  }

  // ---------- D11b：PATCH 整份表单（值全没变）→ 文件不变；只改 name → 条目 {id,importance,name}；改回 → 回基线 ----------
  try {
    const row = await getRow();
    if (row === null) throw new Error("GET 找不到目标点");
    const fullForm = {
      name: row.name,
      lng: row.lng,
      lat: row.lat,
      category: row.category,
      openTime: row.openTime,
      closeTime: row.closeTime,
      closedDays: row.closedDays,
      rating: row.rating,
      avgCost: row.avgCost,
      importance: row.importance,
      hidden: row.hidden === true,
    };
    const fullResponse = await callRoute("PATCH", "/api/admin/places", { city: "beijing", id: targetId, patch: fullForm });
    record("D11b", "PATCH 整份表单（字段值全没变）HTTP 200", fullResponse.status === 200 && fullResponse.json?.ok === true, "HTTP " + fullResponse.status);
    const afterFullSha = fileSha("beijing");
    record("D11b", "PATCH 整份表单（值全没变）→ manual 文件逐字节不变（prune 生效）", afterFullSha === baselineSha, "sha=" + afterFullSha.slice(0, 16) + "… vs baseline=" + baselineSha.slice(0, 16) + "…；表单字段=" + Object.keys(fullForm).join(","));

    const changedName = String(row.name) + "（验收临时改名）";
    const renameResponse = await callRoute("PATCH", "/api/admin/places", { city: "beijing", id: targetId, patch: { name: changedName } });
    const entriesAfterRename = manualEntries("beijing") ?? [];
    const renamedEntry = entriesAfterRename.find((entry) => entry.id === targetId) ?? null;
    const renamedKeys = renamedEntry === null ? [] : Object.keys(renamedEntry).sort();
    const expectedKeys = ["id", "importance", "name"];
    record(
      "D11b",
      "PATCH 只改 name → 条目键（排序后）恰好 [id,importance,name]",
      renameResponse.status === 200 && renamedEntry !== null && JSON.stringify(renamedKeys) === JSON.stringify(expectedKeys) && renamedEntry.name === changedName,
      "key=" + JSON.stringify(renamedKeys) + "，value=" + String(renamedEntry?.name ?? "(缺失)") + "，response.origin=" + (renameResponse.json?.origin ?? "(无)"),
    );
    const afterRenameSha = fileSha("beijing");
    record("D11b", "只改 name 后 manual 文件确实变化（不再是基线）", afterRenameSha !== baselineSha, "sha=" + afterRenameSha.slice(0, 16) + "… != baseline=" + baselineSha.slice(0, 16) + "…");

    const revertResponse = await callRoute("PATCH", "/api/admin/places", { city: "beijing", id: targetId, patch: { name: row.name } });
    record("D11b", "PATCH name 改回原值 → manual 文件逐字节回基线", revertResponse.status === 200 && fileSha("beijing") === baselineSha, "sha=" + fileSha("beijing").slice(0, 16) + "… vs baseline=" + baselineSha.slice(0, 16) + "…");
  } catch (error) {
    record("D11b", "PATCH 整份表单 / 只改 name 执行", false, "异常：" + String(error));
  }

  // ---------- D12：PATCH importance 新值 → {id,importance}；改回 → 回基线 ----------
  try {
    const newImportance = origImportance === 1 ? 2 : origImportance - 1;
    const changed = await callRoute("PATCH", "/api/admin/places", { city: "beijing", id: targetId, patch: { importance: newImportance } });
    const entries = manualEntries("beijing") ?? [];
    const entry = entries.find((item) => item.id === targetId) ?? null;
    record("D12", "PATCH importance=新值 HTTP 200 + 响应已更新", changed.status === 200 && changed.json?.ok === true && (changed.json?.place as Record<string, unknown> | null)?.importance === newImportance, "HTTP " + changed.status + "，新值=" + newImportance + "，response.importance=" + String((changed.json?.place as Record<string, unknown> | null)?.importance ?? "(无)"));
    record("D12", "新值条目仍恰好 [id,importance]", entry !== null && JSON.stringify(Object.keys(entry)) === JSON.stringify(["id", "importance"]) && entry.importance === newImportance, "keys=" + JSON.stringify(entry === null ? [] : Object.keys(entry)) + "，importance=" + String(entry?.importance ?? "(无)"));
    record(
      "D12",
      "其余条目与基线逐字段一致（条数不变）",
      entries.length === baselineCount && deepEqual(entries.filter((item) => item.id !== targetId), baselineEntries.filter((item) => item.id !== targetId)),
      "count=" + entries.length + "（baseline " + baselineCount + "）",
    );
    const back = await callRoute("PATCH", "/api/admin/places", { city: "beijing", id: targetId, patch: { importance: origImportance } });
    record("D12", "PATCH importance 改回原值 → manual 文件逐字节回基线", back.status === 200 && fileSha("beijing") === baselineSha, "sha=" + fileSha("beijing").slice(0, 16) + "… vs baseline=" + baselineSha.slice(0, 16) + "…");
    const row = await getRow();
    record("D12", "只覆盖 importance 的 API origin 仍 main（新语义）", row !== null && row.origin === "main", "origin=" + String(row?.origin ?? "(无)"));
  } catch (error) {
    record("D12", "PATCH importance 新值/改回 执行", false, "异常：" + String(error));
  }

  // ---------- D13a：DELETE 星-only 主文件点（页面「隐藏」）→ 保星级 + 加 hidden:true；PATCH hidden:false 恢复回基线 ----------
  try {
    const hide = await callRoute("DELETE", "/api/admin/places", { city: "beijing", id: targetId });
    record("D13a", "DELETE 星-only 主文件点（origin=main，页面「隐藏」）→ deleted=hidden（星级保留、不真删条目）", hide.status === 200 && hide.json?.deleted === "hidden", "HTTP " + hide.status + "，deleted=" + String(hide.json?.deleted ?? "(无)"));
    const entriesAfterHide = manualEntries("beijing") ?? [];
    const hiddenEntry = entriesAfterHide.find((entry) => entry.id === targetId) ?? null;
    const hiddenKeySet = hiddenEntry === null ? [] : Object.keys(hiddenEntry).sort();
    record(
      "D13a",
      "条目变成 {id, importance, hidden:true}（键集合，星级值不变、条数不变）",
      entriesAfterHide.length === baselineCount && hiddenEntry !== null && JSON.stringify(hiddenKeySet) === JSON.stringify(["hidden", "id", "importance"]) && hiddenEntry.hidden === true && hiddenEntry.importance === origImportance,
      "key=" + JSON.stringify(hiddenKeySet) + "，importance=" + String(hiddenEntry?.importance ?? "(无)") + "，hidden=" + String(hiddenEntry?.hidden ?? "(无)") + "，count=" + entriesAfterHide.length,
    );
    const getAfterHide = await callRoute("GET", "/api/admin/places?city=beijing&includeHidden=1");
    const hiddenRow = extractEntries(getAfterHide.json).find((row) => row.id === targetId) ?? null;
    record(
      "D13a",
      "GET includeHidden=1：该点 hidden=true、origin=manual（页面显示「恢复」）、importance 保留",
      hiddenRow !== null && hiddenRow.hidden === true && hiddenRow.origin === "manual" && hiddenRow.importance === origImportance,
      "hidden=" + String(hiddenRow?.hidden ?? "(无)") + "，origin=" + String(hiddenRow?.origin ?? "(无)") + "，importance=" + String(hiddenRow?.importance ?? "(无)"),
    );
    const getDefaultAfterHide = await callRoute("GET", "/api/admin/places?city=beijing");
    record(
      "D13a",
      "默认 GET（不显示已隐藏）不再包含该点（真的隐藏了）",
      extractEntries(getDefaultAfterHide.json).every((row) => row.id !== targetId),
      "默认列表不含 id=" + targetId + "（共 " + extractEntries(getDefaultAfterHide.json).length + " 条）",
    );
    // 页面「恢复」：PATCH hidden:false → prune 会把 hidden 裁掉 → 回 {id,importance} + 文件回基线
    const restoreHide = await callRoute("PATCH", "/api/admin/places", { city: "beijing", id: targetId, patch: { hidden: false } });
    const entriesAfterRestore = manualEntries("beijing") ?? [];
    const restoredEntry = entriesAfterRestore.find((entry) => entry.id === targetId) ?? null;
    record(
      "D13a",
      "PATCH hidden:false 恢复 → 条目裁剪回 {id,importance}、文件逐字节回基线",
      restoreHide.status === 200 && fileSha("beijing") === baselineSha && restoredEntry !== null && JSON.stringify(Object.keys(restoredEntry)) === JSON.stringify(["id", "importance"]),
      "HTTP " + restoreHide.status + "，sha=" + fileSha("beijing").slice(0, 16) + "… vs baseline=" + baselineSha.slice(0, 16) + "…，keys=" + JSON.stringify(restoredEntry === null ? [] : Object.keys(restoredEntry)),
    );
    const getAfterRestoreHide = await callRoute("GET", "/api/admin/places?city=beijing&includeHidden=1");
    const restoredRow = extractEntries(getAfterRestoreHide.json).find((row) => row.id === targetId) ?? null;
    record(
      "D13a",
      "恢复后 GET：hidden=false、origin=main、importance 保留",
      restoredRow !== null && restoredRow.hidden === false && restoredRow.origin === "main" && restoredRow.importance === origImportance,
      "hidden=" + String(restoredRow?.hidden ?? "(无)") + "，origin=" + String(restoredRow?.origin ?? "(无)") + "，importance=" + String(restoredRow?.importance ?? "(无)"),
    );
  } catch (error) {
    record("D13a", "DELETE 星-only 隐藏 / PATCH hidden:false 恢复 执行", false, "异常：" + String(error));
  }

  // ---------- D13b：先 PATCH 改 name（origin→manual，页面「删除」）→ DELETE 真删条目；从 clean 还原 ----------
  try {
    const baselineRow = await getRow();
    if (baselineRow === null) throw new Error("GET 找不到目标点");
    const d13bName = String(baselineRow.name) + "（验收临时改名-D13b）";
    const rename = await callRoute("PATCH", "/api/admin/places", { city: "beijing", id: targetId, patch: { name: d13bName } });
    record("D13b", "PATCH 只改 name → 条目不再星-only，响应 origin=manual（页面显示「删除」）", rename.status === 200 && rename.json?.origin === "manual", "HTTP " + rename.status + "，origin=" + String(rename.json?.origin ?? "(无)"));
    const entriesAfterRename = manualEntries("beijing") ?? [];
    const renamedEntry = entriesAfterRename.find((entry) => entry.id === targetId) ?? null;
    record(
      "D13b",
      "改 name 后条目键（排序后）恰 [id,importance,name]",
      renamedEntry !== null && JSON.stringify(Object.keys(renamedEntry).sort()) === JSON.stringify(["id", "importance", "name"]) && renamedEntry.name === d13bName,
      "key=" + JSON.stringify(renamedEntry === null ? [] : Object.keys(renamedEntry).sort()) + "，name=" + String(renamedEntry?.name ?? "(无)"),
    );
    const remove = await callRoute("DELETE", "/api/admin/places", { city: "beijing", id: targetId });
    const entriesAfterDelete = manualEntries("beijing") ?? [];
    record(
      "D13b",
      "DELETE 改过非星级字段的条目 → deleted=manual、条目被移除、少一条",
      remove.status === 200 && remove.json?.deleted === "manual" && entriesAfterDelete.length === baselineCount - 1 && !entriesAfterDelete.some((entry) => entry.id === targetId) && deepEqual(entriesAfterDelete, baselineEntries.filter((entry) => entry.id !== targetId)),
      "HTTP " + remove.status + "，deleted=" + String(remove.json?.deleted ?? "(无)") + "，count=" + entriesAfterDelete.length + "（baseline " + baselineCount + "）",
    );
    restoreCity("beijing");
    // 这里显式清缓存：即使 route handler 与 helper 的 @/lib/cityData 被 tsx 解析成同一模块，也保证 GET 读盘是最新。
    clearCityCache();
    record("D13b", "从 clean.json 还原后 sha = 基线", fileSha("beijing") === baselineSha, "sha=" + fileSha("beijing").slice(0, 16) + "… vs baseline=" + baselineSha.slice(0, 16) + "…");
    const getAfterRestore = await callRoute("GET", "/api/admin/places?city=beijing&includeHidden=1");
    const rowAfterRestore = extractEntries(getAfterRestore.json).find((row) => row.id === targetId) ?? null;
    record(
      "D13b",
      "还原后 GET（缓存已清）：origin=main、importance 保留、hidden=false（回到基线视图）",
      rowAfterRestore !== null && rowAfterRestore.origin === "main" && rowAfterRestore.importance === origImportance && rowAfterRestore.hidden === false,
      "origin=" + String(rowAfterRestore?.origin ?? "(无)") + "，importance=" + String(rowAfterRestore?.importance ?? "(无)") + "，hidden=" + String(rowAfterRestore?.hidden ?? "(无)"),
    );
  } catch (error) {
    record("D13b", "改 name 后 DELETE 真删 / clean 还原 执行", false, "异常：" + String(error));
  }

  // ---------- D14：POST 新增手工点（完整 Place）→ GET origin=manual → DELETE → 回基线 ----------
  try {
    const newId = "manual-acceptance-" + Date.now();
    const payload = {
      id: newId,
      name: "验收临时手工点（请删除）",
      lng: 116.2,
      lat: 39.8,
      category: "park",
      openTime: "08:00",
      closeTime: "18:00",
      closedDays: [],
      rating: null,
      avgCost: null,
      importance: 3,
    };
    const created = await callRoute("POST", "/api/admin/places", { city: "beijing", place: payload });
    const createdRow = (created.json?.place ?? null) as Record<string, unknown> | null;
    record("D14", "POST 新增手工点 HTTP 200 + origin=manual", created.status === 200 && created.json?.ok === true && createdRow?.origin === "manual" && createdRow?.id === newId, "HTTP " + created.status + "，origin=" + String(createdRow?.origin ?? "(无)") + "，id=" + String(createdRow?.id ?? "(无)"));
    const entriesAfterPost = manualEntries("beijing") ?? [];
    const createdEntry = entriesAfterPost.find((entry) => entry.id === newId) ?? null;
    const createdKeys = createdEntry === null ? [] : Object.keys(createdEntry);
    const requiredFields = ["id", "name", "lng", "lat", "category", "openTime", "closeTime", "closedDays", "rating", "avgCost", "source", "lastVerified"];
    record(
      "D14",
      "新条目是完整 Place（必填字段齐全、键数>2、source=manual）",
      createdEntry !== null && requiredFields.every((field) => createdKeys.includes(field)) && createdKeys.length > 2 && createdEntry.source === "manual",
      "keyCount=" + createdKeys.length + "；keys=" + createdKeys.join(","),
    );
    record("D14", "POST 后 manual 条数 +1", entriesAfterPost.length === baselineCount + 1, "count=" + entriesAfterPost.length + "（baseline+1=" + (baselineCount + 1) + "）");
    const getAfterPost = await callRoute("GET", "/api/admin/places?city=beijing&includeHidden=1");
    const newRow = extractEntries(getAfterPost.json).find((row) => row.id === newId) ?? null;
    record("D14", "POST 后 GET 该点 origin=manual（完整条目语义）", newRow !== null && newRow.origin === "manual", "origin=" + String(newRow?.origin ?? "(无)"));
    const removed = await callRoute("DELETE", "/api/admin/places", { city: "beijing", id: newId });
    record("D14", "DELETE 新点 → deleted=manual 且 manual 文件逐字节回基线", removed.status === 200 && removed.json?.deleted === "manual" && fileSha("beijing") === baselineSha, "HTTP " + removed.status + "，deleted=" + String(removed.json?.deleted ?? "(无)") + "，sha=" + fileSha("beijing").slice(0, 16) + "…");
    const getAfterDelete = await callRoute("GET", "/api/admin/places?city=beijing&includeHidden=1");
    record("D14", "DELETE 后 GET 列表不含新点", extractEntries(getAfterDelete.json).every((row) => row.id !== newId), "列表不含 id=" + newId);
  } catch (error) {
    record("D14", "POST/DELETE 新增手工点 执行", false, "异常：" + String(error));
  }
} catch (error) {
  record("setup", "写测试前置检查", false, "异常：" + String(error));
} finally {
  for (const city of CITIES) {
    try {
      restoreCity(city);
    } catch (error) {
      record("restore", city + " 强制还原异常", false, "异常：" + String(error));
    }
  }
}

const restoreReport: Record<string, unknown> = {};
for (const city of CITIES) {
  const shaTxt = parseShaTxt(city);
  const currentSha = fileSha(city);
  restoreReport[city] = {
    currentSha: currentSha,
    cleanSha: shaTxt["manual.clean"],
    restored: currentSha === shaTxt["manual.clean"],
  };
  record("restore", city + " 写测试结束 manual sha = clean 基线", currentSha === shaTxt["manual.clean"], "sha=" + currentSha.slice(0, 16) + "… clean=" + String(shaTxt["manual.clean"]).slice(0, 16) + "…");
}
summary.restore = restoreReport;
summary.baseline = baseline;
console.log("__WRITE_TEST_JSON__" + JSON.stringify(summary));
const failed = results.filter((item) => item.status !== "PASS").length;
const restoreFailed = Object.values(restoreReport).some((item) => !(item as { restored: boolean }).restored);
process.exitCode = failed === 0 && !restoreFailed ? 0 : 1;
`;
}

function writeHelpers() {
  ensureDirs();
  writeFileSync(INVARIANT_HELPER, buildInvariantHelperSource(), "utf8");
  writeFileSync(WRITE_HELPER, buildWriteHelperSource(), "utf8");
  return { invariant: INVARIANT_HELPER, write: WRITE_HELPER };
}

/* ------------------------------------------------------------------ *
 * 页面探针表达式
 * ------------------------------------------------------------------ */

const ADMIN_STATE_EXPR = String.raw`(() => {
  const list = document.querySelector('[data-testid="admin-places-list"]');
  const citySelect = document.querySelector('[data-testid="city-filter"]');
  const headers = list === null ? [] : [...list.querySelectorAll('thead th')].map((th) => (th.textContent || '').trim());
  const rows = list === null ? [] : [...list.querySelectorAll('[data-row-place-id]')].map((row) => {
    return {
      id: row.getAttribute('data-row-place-id'),
      name: row.getAttribute('data-place-name'),
      cells: [...row.querySelectorAll('td')].map((td) => (td.textContent || '').trim()),
      buttons: [...row.querySelectorAll('button')].map((button) => (button.textContent || '').trim()),
    };
  });
  return {
    readyState: document.readyState,
    hasList: list !== null,
    headers: headers,
    rows: rows,
    rowCount: rows.length,
    city: citySelect === null ? null : citySelect.value,
    bodyText: (document.body.innerText || '').slice(0, 400),
  };
})()`;

function exprSetCity(cityId) {
  return `(() => {
    const select = document.querySelector('[data-testid="city-filter"]');
    if (select === null) return { ok: false, reason: 'city-filter 不存在' };
    const target = ${JSON.stringify(cityId)};
    const values = [...select.options].map((option) => option.value);
    if (values.indexOf(target) === -1) return { ok: false, reason: '城市选项不存在', values: values };
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(select, target);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: select.value };
  })()`;
}

/* ------------------------------------------------------------------ *
 * 阶段 0：环境与基线
 * ------------------------------------------------------------------ */

function computeFileHash(relPath) {
  try {
    return sha256Buffer(readFileSync(path.join(ROOT_DIR, relPath)));
  } catch {
    return null;
  }
}

function computeFrozenHashes(state) {
  const result = {};
  for (const [relPath, expected] of Object.entries(FROZEN_HASHES)) {
    const actual = computeFileHash(relPath);
    result[relPath] = { expected: expected, actual: actual, matches: actual === expected };
  }
  for (const [relPath, expected] of Object.entries(IMPL_FROZEN_HASHES)) {
    const actual = computeFileHash(relPath);
    result[relPath] = { expected: expected, actual: actual === null ? null : actual.toUpperCase().slice(0, 16), matches: actual !== null && actual.toUpperCase().slice(0, 16) === expected };
  }
  state.frozenHashes = result;
  return result;
}

async function phaseEnvironment(state) {
  const group = GROUPS.env;

  // 0.1 server 可达（contract：浏览器只读走 3000；默认 3000，VERIFY_BASE_URL 可覆盖）
  const pageProbe = await apiGet("/admin", { timeoutMs: 120000, baseUrl: APP });
  check(
    state,
    group,
    "0.1",
    "验收目标 dev server /admin 可访问",
    pageProbe.status === 200 && String(pageProbe.text).includes("本地控制台"),
    `HTTP 200 + HTML 含「本地控制台」（目标 ${APP}）`,
    `HTTP ${pageProbe.status}，目标 ${APP}，${pageProbe.ms} ms`,
  );
  state.app = APP;

  const citiesProbe = await apiGet("/api/cities", { timeoutMs: 30000, baseUrl: APP });
  const cityIds = citiesProbe.json !== null && Array.isArray(citiesProbe.json.cities) ? citiesProbe.json.cities.map((city) => city.city) : [];
  check(
    state,
    group,
    "0.2",
    "/api/cities 可访问且含 beijing / liaoyang",
    citiesProbe.status === 200 && citiesProbe.json?.ok === true && cityIds.includes("beijing") && cityIds.includes("liaoyang"),
    "HTTP 200 + 城市索引含 beijing、liaoyang",
    `HTTP ${citiesProbe.status}，城市=${cityIds.join(",")}`,
  );

  // 0.3 报告基线文件（orig / clean / merged-before / sha256.txt）
  state.baselines = {};
  for (const city of CITIES) {
    const shaTxt = parseShaTxt(city.id);
    const files = {
      orig: origPathOf(city.id),
      clean: cleanPathOf(city.id),
      mergedBefore: mergedBeforePathOf(city.id),
      shaTxt: path.join(REPORT_DIR, `${city.id}.sha256.txt`),
    };
    const missing = Object.entries(files).filter(([, absPath]) => !existsSync(absPath)).map(([name]) => name);
    const cleanText = readText(files.clean);
    const cleanShaActual = sha256File(files.clean);
    const manualShaActual = sha256File(manualPathOf(city.id));
    const currentMatchesClean = cleanShaActual !== null && manualShaActual !== null && cleanShaActual === manualShaActual;
    const origBytes = existsSync(files.orig) ? statSync(files.orig).size : null;
    const mergedBeforeBytes = existsSync(files.mergedBefore) ? statSync(files.mergedBefore).size : null;
    state.baselines[city.id] = {
      shaTxt: shaTxt,
      cleanSha: cleanShaActual,
      manualSha: manualShaActual,
      cleanBytes: cleanText,
      origBytes: origBytes,
      manualBytes: existsSync(manualPathOf(city.id)) ? statSync(manualPathOf(city.id)).size : null,
      files: Object.fromEntries(Object.entries(files).map(([name, absPath]) => [name, rel(absPath)])),
      missing: missing,
      currentMatchesClean: currentMatchesClean,
      expectedCleanSha: MANUAL_CLEAN_SHA[city.id],
    };
    check(
      state,
      group,
      `0.3-${city.id}`,
      `${city.label}验收基线文件齐全（orig/clean/merged-before/sha256.txt）`,
      missing.length === 0,
      "4 个基线文件都存在",
      missing.length === 0
        ? `orig=${formatBytes(origBytes)}，clean=${formatBytes(state.baselines[city.id].manualBytes)}，merged-before=${formatBytes(mergedBeforeBytes)}`
        : `缺少：${missing.join("、")}`,
    );

    // 0.4 当前 manual 文件必须 = clean 基线；不一致先按 Lead 口径从 clean 还原再继续（记录 incident，不直接 FAIL）
    if (!currentMatchesClean) {
      const incident = `启动前 ${city.label} manual sha=${first16(manualShaActual)}… ≠ clean 基线 ${first16(cleanShaActual)}…（可能 Lead 的写测试残留），已从 clean 还原`;
      infoLog(incident);
      if (cleanText !== null) {
        writeFileSync(manualPathOf(city.id), cleanText, "utf8");
      }
      state.baselines[city.id].manualSha = sha256File(manualPathOf(city.id));
      state.baselines[city.id].manualBytes = statSync(manualPathOf(city.id)).size;
      skipCheck(state, group, `0.4-${city.id}`, `${city.label}启动前 manual 文件 = clean 基线`, `${incident}；还原后 sha=${first16(state.baselines[city.id].manualSha)}…`);
    } else {
      check(
        state,
        group,
        `0.4-${city.id}`,
        `${city.label}启动前 manual 文件 = clean 基线（sha256 一致）`,
        cleanShaActual === MANUAL_CLEAN_SHA[city.id],
        `sha256=${MANUAL_CLEAN_SHA[city.id]}`,
        `sha256=${cleanShaActual}`,
      );
    }
    // 备份本次运行前的原始字节（在 0.4 还原之后写；双保险：外层 finally 也走 clean 还原）
    const baselineText = readText(manualPathOf(city.id));
    if (baselineText !== null) writeFileSync(path.join(BASELINE_DIR, `${city.id}.manual.baseline.json`), Buffer.from(baselineText, "utf8"));
  }

  // 0.5 实现冻结版本 hash（防验收到旧代码）
  const frozen = computeFrozenHashes(state);
  const implProblems = Object.entries(IMPL_FROZEN_HASHES).filter(([relPath]) => frozen[relPath].matches !== true);
  check(
    state,
    group,
    "0.5",
    "被验收实现 = Lead 冻结版本（lib/cityData.ts / route.ts / rate-places.ts / shrink-manual.ts hash 一致）",
    implProblems.length === 0,
    "4 个实现文件 SHA256 前 16 位与冻结值一致",
    implProblems.length === 0
      ? Object.entries(IMPL_FROZEN_HASHES).map(([relPath, expected]) => `${relPath}=${expected}`).join("；")
      : implProblems.map(([relPath]) => `${relPath}=${frozen[relPath].actual ?? "(缺失)"}（期望 ${IMPL_FROZEN_HASHES[relPath]}）`).join("；"),
  );

  // 0.6 主文件 / 契约基线数据（白盒对照）
  const mainState = {};
  for (const city of CITIES) {
    const mainRaw = readJsonFile(mainPathOf(city.id));
    const manualRaw = readJsonFile(manualPathOf(city.id));
    const mainPlaces = mainRaw.ok ? placesOf(mainRaw.value) : null;
    const manualPlaces = manualRaw.ok ? placesOf(manualRaw.value) : null;
    mainState[city.id] = {
      mainPlaces: mainPlaces,
      manualPlaces: manualPlaces,
      mainIds: mainPlaces === null ? [] : mainPlaces.map((place) => place.id),
      manualIds: manualPlaces === null ? [] : manualPlaces.map((place) => place.id),
      mainImportanceCount: mainPlaces === null ? null : mainPlaces.filter((place) => place.importance !== undefined).length,
    };
  }
  state.mainState = mainState;
  const mainImportanceOk = CITIES.every((city) => state.mainState[city.id].mainImportanceCount === 0);
  check(
    state,
    group,
    "0.6",
    "两城主文件仍是「无 importance」的原始采集数据（116/141 条）",
    mainImportanceOk && state.mainState.beijing.mainPlaces?.length === 116 && state.mainState.liaoyang.mainPlaces?.length === 141,
    "beijing 116 条 / liaoyang 141 条，importance 字段 0 个",
    `beijing=${state.mainState.beijing.mainPlaces?.length} 条（带 importance ${state.mainState.beijing.mainImportanceCount}）；liaoyang=${state.mainState.liaoyang.mainPlaces?.length} 条（带 importance ${state.mainState.liaoyang.mainImportanceCount}）`,
  );
}

/* ------------------------------------------------------------------ *
 * A. 文件格式
 * ------------------------------------------------------------------ */

async function phaseFormat(state) {
  const group = GROUPS.a;

  for (const city of CITIES) {
    const manualRaw = readJsonFile(manualPathOf(city.id));
    const topLevelOnlyPlaces = manualRaw.ok && manualRaw.value !== null && !Array.isArray(manualRaw.value) && JSON.stringify(Object.keys(manualRaw.value)) === JSON.stringify(["places"]);
    const entries = manualRaw.ok ? placesOf(manualRaw.value) : null;
    const entryList = entries === null ? [] : entries;
    const ids = entryList.map((entry) => String(entry.id));
    const uniqueIds = new Set(ids);
    const mainIds = state.mainState[city.id].mainIds;
    const keysList = entryList.map((entry) => Object.keys(entry));
    const importanceValues = entryList.map((entry) => entry.importance);
    const dist = {};
    for (const value of importanceValues) dist[String(value)] = (dist[String(value)] ?? 0) + 1;
    const orderSame = JSON.stringify(ids) === JSON.stringify(mainIds);
    const idSetSame = ids.length === mainIds.length && uniqueIds.size === ids.length && mainIds.every((id) => uniqueIds.has(id));

    const baseId = `${city.id}`;
    // A1/A2 公共：条目数 / 顶层键 / id 集 / id 唯一 / 顺序 / 分布
    check(
      state,
      group,
      `A1-${baseId}`,
      `${city.label}：顶层只有 places，${city.manualCount} 条，id 唯一且集合 = 主文件`,
      topLevelOnlyPlaces && entryList.length === city.manualCount && uniqueIds.size === ids.length && idSetSame,
      `顶层键=["places"]；${city.manualCount} 条；id 集 = 主文件 ${mainIds.length} 个`,
      `顶层键=${manualRaw.ok && manualRaw.value !== null && !Array.isArray(manualRaw.value) ? JSON.stringify(Object.keys(manualRaw.value)) : "(读取失败)"}；条数=${entryList.length}；唯一 id=${uniqueIds.size}；id 集一致=${idSetSame}`,
    );
    check(
      state,
      group,
      `A2-${baseId}`,
      `${city.label}：manual 顺序 = 主文件 places 顺序`,
      orderSame,
      `顺序 = 主文件 ${mainIds.length} 个 id 顺序`,
      orderSame ? `${ids.length} 个 id 顺序一致（前 3：${ids.slice(0, 3).join(",")}）` : `第 ${ids.findIndex((id, index) => id !== mainIds[index])} 个开始不一致；manual 前 3=${ids.slice(0, 3).join(",")}，主文件前 3=${mainIds.slice(0, 3).join(",")}`,
    );
    check(
      state,
      group,
      `A3-${baseId}`,
      `${city.label}：importance 分布 = ${JSON.stringify(city.importanceDist)}`,
      JSON.stringify(Object.fromEntries(Object.entries(dist).sort((left, right) => Number(left[0]) - Number(right[0])))) === JSON.stringify(Object.fromEntries(Object.entries(city.importanceDist).sort((left, right) => Number(left[0]) - Number(right[0])))),
      JSON.stringify(city.importanceDist),
      JSON.stringify(dist),
    );

    if (city.specialId === null) {
      // 北京：116 条全部恰好 [id, importance]
      const badKeys = entryList.filter((entry) => JSON.stringify(Object.keys(entry)) !== JSON.stringify(["id", "importance"]));
      check(
        state,
        group,
        "A1-key-beijing",
        "北京：每条恰好两个键且键序 [id, importance]",
        entryList.length === 116 && badKeys.length === 0,
        '116 条 × ["id","importance"]',
        badKeys.length === 0 ? `116/116 PASS；示例 ${JSON.stringify(entryList[0])}` : `${badKeys.length} 条不符：${badKeys.slice(0, 3).map((entry) => JSON.stringify(entry)).join("；")}`,
      );
    } else {
      const special = entryList.filter((entry) => entry.id === city.specialId);
      const minimal = entryList.filter((entry) => entry.id !== city.specialId);
      const minimalBad = minimal.filter((entry) => JSON.stringify(Object.keys(entry)) !== JSON.stringify(["id", "importance"]));
      const specialKeys = special.length === 1 ? Object.keys(special[0]) : [];
      const specialKeySet = [...specialKeys].sort().join(",");
      const expectedSpecialKeySet = ["id", "importance", ...city.specialExtraFields].sort().join(",");
      check(
        state,
        group,
        "A2-key-liaoyang",
        `辽阳：140 条恰好 [id, importance]；${city.specialId} 键集合 = {id, importance, scenery}`,
        minimalBad.length === 0 && special.length === 1 && specialKeySet === expectedSpecialKeySet,
        '140 条 ["id","importance"] + 1 条 {id,importance,scenery}',
        `${minimal.length} 条非特殊条目（不符 ${minimalBad.length} 条）；特殊条目 ${special.length} 个，键=${JSON.stringify(specialKeys)}`,
      );
      check(
        state,
        group,
        "A2-key-schema-order-liaoyang",
        "辽阳大剧院键序符合 §3.4「id 最前，其余按 PlaceSchema 字段顺序」（= [id, scenery, importance]）",
        JSON.stringify(specialKeys) === JSON.stringify(SPECIAL_KEY_ORDER_SCHEMA),
        JSON.stringify(SPECIAL_KEY_ORDER_SCHEMA),
        JSON.stringify(specialKeys),
      );
      if (JSON.stringify(specialKeys) === JSON.stringify(SPECIAL_KEY_ORDER_CONTRACT)) {
        check(state, group, "A2-key-contract-order-liaoyang", "辽阳大剧院键序符合 §2/§4 A.2 字面 [id, importance, scenery]", true, JSON.stringify(SPECIAL_KEY_ORDER_CONTRACT), JSON.stringify(specialKeys));
      } else {
        // 契约已更新（Lead 2026-10-25 16:4x）：§2/§4 A.2 改为「按键集合比，不按顺序比」；
        // 实际键序按 §3.4 PlaceSchema 顺序 [id, scenery, importance] 属预期，这里按集合语义判 PASS 并附实际键序。
        check(
          state,
          group,
          "A2-key-contract-order-liaoyang",
          "辽阳大剧院键集合符合契约（§2/§4 A.2 已改为按键集合比，不按顺序比；键序按 PlaceSchema 字段顺序）",
          specialKeySet === expectedSpecialKeySet,
          `键集合 = {${expectedSpecialKeySet}}（不比较顺序）`,
          `键集合={${specialKeySet}}；实际键序=${JSON.stringify(specialKeys)}（PlaceSchema 顺序，符合 §3.4）`,
        );
      }
      check(
        state,
        group,
        "A2-scenery-value-liaoyang",
        "辽阳大剧院 scenery 值与瘦身前一致（merged-before 快照）",
        (() => {
          const beforePlaces = placesOf(readJsonFile(mergedBeforePathOf("liaoyang")).value);
          const before = beforePlaces === null ? null : beforePlaces.find((place) => place.id === city.specialId);
          return special.length === 1 && before !== undefined && deepEqual(special[0].scenery, before.scenery);
        })(),
        "scenery 与 merged-before 快照逐字段相等",
        `scenery=${truncate(special[0]?.scenery, 200)}`,
      );
    }

    // A3 体积
    const manualBytes = statSync(manualPathOf(city.id)).size;
    const cleanBytes = state.baselines[city.id].manualBytes;
    check(
      state,
      group,
      `A4-size-${baseId}`,
      `${city.label} manual 文件体积 < 10KB（实测）`,
      manualBytes < 10240,
      `66KB/79KB → <10KB（10240 B）`,
      `${formatBytes(manualBytes)}；瘦身前 orig=${formatBytes(state.baselines[city.id].origBytes)}，缩小 ${(100 - (manualBytes / state.baselines[city.id].origBytes) * 100).toFixed(1)}%`,
    );

    // A4 备份 / clean / 幂等
    const shaTxt = parseShaTxt(city.id);
    const origSha = sha256File(origPathOf(city.id));
    const cleanSha = sha256File(cleanPathOf(city.id));
    const origPlaces = placesOf(readJsonFile(origPathOf(city.id)).value);
    const origAllFull = origPlaces !== null && origPlaces.length === city.manualCount && origPlaces.every((place) => place !== null && typeof place.id === "string" && Object.keys(place).length > 2);
    check(
      state,
      group,
      `A5-orig-${baseId}`,
      `${city.label}瘦身前备份 orig 存在且形状正确（${city.manualCount} 条完整 Place）`,
      existsSync(origPathOf(city.id)) && origAllFull && origSha === shaTxt["manual.orig"],
      `${city.manualCount} 条完整 Place；orig sha256 = sha256.txt 记录值`,
      existsSync(origPathOf(city.id)) ? `${origPlaces === null ? "?" : origPlaces.length} 条；sha=${first16(origSha)}…（记录 ${first16(shaTxt["manual.orig"])}…）；orig 体积=${formatBytes(state.baselines[city.id].origBytes)}` : "orig 备份不存在",
    );
    check(
      state,
      group,
      `A5-clean-${baseId}`,
      `${city.label} clean 基线存在且 sha256 = sha256.txt，并 = 当前 manual 文件`,
      cleanSha !== null && cleanSha === shaTxt["manual.clean"] && cleanSha === sha256File(manualPathOf(city.id)),
      `clean sha256=${shaTxt["manual.clean"]}`,
      `clean sha=${first16(cleanSha)}…；manual sha=${first16(sha256File(manualPathOf(city.id)))}…`,
    );
    const mergedBeforeSha = shaTxt["merged.before.sha256"];
    const mergedBeforeText = readJsonFile(mergedBeforePathOf(city.id)).text;
    const mergedBeforePlaces = placesOf(readJsonFile(mergedBeforePathOf(city.id)).value);
    const mergedBeforeCompactSha = mergedBeforePlaces === null ? null : sha256Text(JSON.stringify(mergedBeforePlaces));
    check(
      state,
      group,
      `A5-merged-${baseId}`,
      `${city.label} merged-before 快照存在且 sha256 与 sha256.txt 记录一致（before == after）`,
      mergedBeforeCompactSha !== null && mergedBeforeCompactSha === mergedBeforeSha && mergedBeforeSha === shaTxt["merged.after.sha256"],
      `merged.before.sha256 = merged.after.sha256 = ${first16(mergedBeforeSha)}…`,
      `快照 places 紧凑 sha=${first16(mergedBeforeCompactSha)}…；记录 before=${first16(mergedBeforeSha)}… / after=${first16(shaTxt["merged.after.sha256"])}…；快照体积=${formatBytes(mergedBeforeText === null ? null : Buffer.byteLength(mergedBeforeText))}`,
    );
  }

  // A4 幂等 dry-run（不写盘 + 显示 0 变更）
  const beforeDryShas = {};
  for (const city of CITIES) beforeDryShas[city.id] = sha256File(manualPathOf(city.id));
  const dryRun = runCommand(state, "shrink-dry-run", "npx tsx scripts/shrink-manual.ts", { timeoutMs: 180000 });
  const dryOutput = dryRun.output;
  const zeroChangePatterns = [/dry-run 结束：\s*0\s*个城市有变化/, /(?:变更|改动|差异)[^\n]{0,12}[:：]?\s*0\b/, /无需变更/];
  const zeroClaimed = zeroChangePatterns.some((pattern) => pattern.test(dryOutput));
  const minimalFormatCount = (dryOutput.match(/是否改动文件：否（已是最小格式）/g) ?? []).length;
  const afterDryShas = {};
  for (const city of CITIES) afterDryShas[city.id] = sha256File(manualPathOf(city.id));
  const shasUnchanged = CITIES.every((city) => beforeDryShas[city.id] === afterDryShas[city.id]);
  check(
    state,
    group,
    "A4-dry-run-idempotent",
    "shrink-manual dry-run 幂等：退出码 0、显示 0 城市有变化、两城均为「已是最小格式」",
    dryRun.status === 0 && zeroClaimed && minimalFormatCount === 2,
    "exit 0；0 个城市有变化；2 城都显示「已是最小格式」",
    `exit=${dryRun.status}；zeroClaimed=${zeroClaimed}；minimalFormatCount=${minimalFormatCount}；输出尾：${tailLines(dryOutput, 4)}`,
  );
  check(
    state,
    group,
    "A4-dry-run-no-write",
    "shrink-manual dry-run 不写盘（两城 manual sha256 前后不变）",
    shasUnchanged,
    "dry-run 前后 manual sha256 不变",
    CITIES.map((city) => `${city.id}: ${first16(beforeDryShas[city.id])}→${first16(afterDryShas[city.id])}`).join("；"),
  );

  // A5 红线文件 hash + 无新增依赖
  const frozen = state.frozenHashes ?? computeFrozenHashes(state);
  const redlineProblems = Object.entries(FROZEN_HASHES).filter(([relPath]) => frozen[relPath].matches !== true);
  check(
    state,
    group,
    "A5-redline-hashes",
    "红线文件 SHA256 与本轮开始前一致（types/schema.ts、主城市文件、fetch-seed.ts、package*.json、planner.ts、admin 页面、地图组件）",
    redlineProblems.length === 0,
    "10 个红线文件 hash 全部一致",
    redlineProblems.length === 0 ? "10/10 一致" : redlineProblems.map(([relPath]) => `${relPath}=${first16(frozen[relPath].actual)}（期望 ${first16(FROZEN_HASHES[relPath])}）`).join("；"),
  );
  let packageJson = null;
  try {
    packageJson = JSON.parse(readText(path.join(ROOT_DIR, "package.json")) ?? "null");
  } catch {
    packageJson = null;
  }
  const deps = packageJson === null ? [] : Object.keys(packageJson.dependencies ?? {}).sort();
  const devDeps = packageJson === null ? [] : Object.keys(packageJson.devDependencies ?? {}).sort();
  check(
    state,
    group,
    "A5-no-new-deps",
    "无新增 npm 依赖（dependencies / devDependencies 集合 = 基线）",
    JSON.stringify(deps) === JSON.stringify(BASELINE_DEPENDENCIES) && JSON.stringify(devDeps) === JSON.stringify(BASELINE_DEV_DEPENDENCIES),
    `dependencies=[${BASELINE_DEPENDENCIES.join(",")}]；devDependencies=[${BASELINE_DEV_DEPENDENCIES.join(",")}]`,
    `dependencies=[${deps.join(",")}]；devDependencies=[${devDeps.join(",")}]`,
  );
}

/* ------------------------------------------------------------------ *
 * B. 数据不变式
 * ------------------------------------------------------------------ */

function runInvariantHelper(state) {
  ensureDirs();
  if (!existsSync(INVARIANT_HELPER)) writeHelpers();
  const result = runCommand(state, "manual-invariant", "npx tsx .cache/verify/manual-invariant.mts", { timeoutMs: 180000 });
  let parsed = null;
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith("__INVARIANT_JSON__")) {
      try {
        parsed = JSON.parse(line.slice("__INVARIANT_JSON__".length));
      } catch (error) {
        infoLog(`invariant helper JSON 解析失败：${messageText(error)}`);
      }
    }
  }
  state.invariant = { command: result.command, exitCode: result.status, parsed: parsed, logPath: rel(result.logPath), tail: tailLines(result.output, 10) };
  return state.invariant;
}

function invariantCheck(state, group, id, name, condition, expected, actual) {
  return check(state, group, id, name, condition, expected, actual);
}

async function phaseInvariant(state) {
  const group = GROUPS.b;
  const invariant = runInvariantHelper(state);
  check(
    state,
    group,
    "B6-run",
    "独立进程 npx tsx 加载 loadCity 并输出不变式结果（与 dev server 缓存无关）",
    invariant.exitCode === 0 && invariant.parsed !== null,
    "exit 0 + __INVARIANT_JSON__ 输出",
    `exit=${invariant.exitCode}；输出尾：${invariant.tail}`,
  );
  const parsed = invariant.parsed;
  if (parsed === null) {
    for (const city of CITIES) skipCheck(state, group, `B6-${city.id}`, `${city.label} loadCity 合并结果 = merged-before`, "invariant helper 未产出 JSON，跳过");
    return;
  }
  state.invariantData = parsed;
  for (const city of CITIES) {
    const data = parsed.cities?.[city.id] ?? {};
    check(
      state,
      group,
      `B6-${city.id}`,
      `${city.label}：独立进程 loadCity().places 与 merged-before 快照 JSON 完全相等（含顺序）`,
      data.currentEqualsBefore === true && data.currentCompactShaEqualsBefore === true,
      "deepEqual + JSON 紧凑 sha256 都相等",
      `currentEqualsBefore=${data.currentEqualsBefore}；sha=${first16(data.currentCompactSha)}… vs before=${first16(data.mergedBeforeCompactSha)}…；差异=${data.currentFirstDifference ?? "无"}`,
    );
    check(
      state,
      group,
      `B6-sha-${city.id}`,
      `${city.label}：merged-before 紧凑 sha256 = sha256.txt，before == after`,
      data.mergedBeforeShaMatchesTxt === true && data.mergedBeforeEqualsAfter === true,
      "merged.before.sha256 = merged.after.sha256 = sha256.txt 记录",
      `mergedBeforeShaMatchesTxt=${data.mergedBeforeShaMatchesTxt}；mergedBeforeEqualsAfter=${data.mergedBeforeEqualsAfter}`,
    );
    check(
      state,
      group,
      `B6-orig-${city.id}`,
      `${city.label}：瘦身前原件 orig 备份 sha256 一致，且 orig+主文件合并结果 = merged-before`,
      data.origExists === true && data.origShaMatchesTxt === true && data.origEntriesComplete === true && data.origMergeEqualsBefore === true,
      "orig sha 一致；orig 全为完整 Place；orig 合并 == merged-before",
      `origExists=${data.origExists}；origCount=${data.origCount}；shaMatch=${data.origShaMatchesTxt}；完整=${data.origEntriesComplete}；merge==before=${data.origMergeEqualsBefore}；差异=${data.origMergeFirstDifference ?? "无"}`,
    );
    check(
      state,
      group,
      `B6-clean-${city.id}`,
      `${city.label}：clean.json = 当前 manual 文件 = sha256.txt manual.clean`,
      data.cleanMatchesManual === true && data.cleanShaMatchesTxt === true && data.manualShaMatchesClean === true,
      "三个 sha256 一致",
      `clean==manual=${data.cleanMatchesManual}；clean==shaTxt=${data.cleanShaMatchesTxt}；manual==clean=${data.manualShaMatchesClean}`,
    );
  }
}

/** 把 merged-before 快照按 API 排序口径（importance 降序、同级保持原顺序）转成期望行。 */
function expectedApiRowsFromSnapshot(mergedPlaces) {
  if (mergedPlaces === null) return null;
  const sorted = mergedPlaces
    .map((place, index) => ({ place: place, index: index }))
    .sort((left, right) => {
      const diff = (right.place.importance ?? 0) - (left.place.importance ?? 0);
      return diff !== 0 ? diff : left.index - right.index;
    })
    .map((entry) => entry.place);
  return sorted.map((place) => ({ ...place, hidden: place.hidden === true }));
}

function compareApiRows(actualRows, expectedRows) {
  const result = { totalOk: false, orderOk: false, fieldProblems: [], originProblems: [] };
  if (!Array.isArray(actualRows) || !Array.isArray(expectedRows)) return result;
  result.totalOk = actualRows.length === expectedRows.length;
  result.orderOk = result.totalOk && actualRows.every((row, index) => row.id === expectedRows[index].id);
  for (let index = 0; index < Math.min(actualRows.length, expectedRows.length); index += 1) {
    const actual = actualRows[index];
    const expected = expectedRows[index];
    const origin = actual.origin;
    if (origin !== "main" && origin !== "manual") result.originProblems.push(`${index}:${actual.id} origin=${JSON.stringify(origin)}`);
    const actualWithoutOrigin = { ...actual };
    delete actualWithoutOrigin.origin;
    if (!deepEqual(actualWithoutOrigin, expected)) {
      const diff = firstDifference(actualWithoutOrigin, expected, "row");
      if (result.fieldProblems.length < 5) result.fieldProblems.push(`${index}:${actual.id} ${diff}`);
    }
  }
  return result;
}

async function phaseApiAndOrigin(state) {
  const group = GROUPS.b;
  state.api = {};
  for (const city of CITIES) {
    const response = await apiGet(`/api/admin/places?city=${city.id}&includeHidden=1`, { timeoutMs: 60000, baseUrl: APP });
    const rows = response.json !== null && Array.isArray(response.json.places) ? response.json.places : null;
    state.api[city.id] = { status: response.status, total: response.json?.total ?? null, rows: rows, text: response.text };
    const mergedBefore = placesOf(readJsonFile(mergedBeforePathOf(city.id)).value);
    const expectedRows = expectedApiRowsFromSnapshot(mergedBefore);
    const compare = compareApiRows(rows, expectedRows);
    check(
      state,
      group,
      `B7-${city.id}`,
      `${city.label}：GET /api/admin/places?includeHidden=1 total=${city.manualCount} 且除 origin 外逐字段 = merged-before 快照（同一顺序）`,
      response.status === 200 && response.json?.ok === true && compare.totalOk && compare.orderOk && compare.fieldProblems.length === 0 && compare.originProblems.length === 0,
      `${city.manualCount} 条、顺序与字段（除 origin）全部相等`,
      `HTTP ${response.status}，total=${response.json?.total}，rows=${rows === null ? "null" : rows.length}；totalOk=${compare.totalOk}；orderOk=${compare.orderOk}；字段差异=${compare.fieldProblems.length === 0 ? "无" : compare.fieldProblems.join("；")}；origin 异常=${compare.originProblems.length === 0 ? "无" : compare.originProblems.slice(0, 3).join("；")}`,
    );
    // C8 origin 统计（同一份 API 响应）
    const originCounts = {};
    for (const row of rows ?? []) originCounts[row.origin] = (originCounts[row.origin] ?? 0) + 1;
    if (city.id === "beijing") {
      check(
        state,
        GROUPS.c,
        "C8-beijing",
        "北京 API：116 行全部 origin=main",
        response.status === 200 && rows !== null && rows.length === 116 && originCounts.main === 116 && originCounts.manual === undefined,
        "116 行全部 origin=main",
        `HTTP ${response.status}，total=${response.json?.total}，origin 分布=${JSON.stringify(originCounts)}`,
      );
    } else {
      const specialRow = (rows ?? []).find((row) => row.id === city.specialId) ?? null;
      check(
        state,
        GROUPS.c,
        "C8-liaoyang",
        "辽阳 API：140 行 origin=main + B0FFGEKXKE origin=manual",
        response.status === 200 && rows !== null && rows.length === 141 && originCounts.main === 140 && originCounts.manual === 1 && specialRow !== null && specialRow.origin === "manual",
        "main=140，manual=1（B0FFGEKXKE）",
        `HTTP ${response.status}，origin 分布=${JSON.stringify(originCounts)}；大剧院=${specialRow === null ? "(未找到)" : `origin=${specialRow.origin}，name=${specialRow.name}`}`,
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 * C. 浏览器只读：来源列 / 按钮（1280×900）
 * ------------------------------------------------------------------ */

async function phaseBrowser(state) {
  const group = GROUPS.c;
  let launched = null;
  let cdp = null;
  let collector = null;
  try {
    launched = await launchEdge();
    state.browser = { version: launched.version?.Browser ?? "(未知)", cdpPort: launched.port, url: ADMIN_URL };
    infoLog(`headless Edge 已启动：${state.browser.version}（CDP port=${launched.port}），目标 ${ADMIN_URL}`);
    const page = await connectPage(launched.port, {
      label: "manual-layer-acceptance",
      viewport: VIEWPORT,
      seedProfile: false,
      autoSkipOnboarding: false,
    });
    cdp = page.cdp;
    collector = createConsoleCollector(cdp);
    await cdp.send("Page.navigate", { url: ADMIN_URL });
    await waitForEvaluate(cdp, "document.readyState", (value) => value === "complete", 120000, "后台页面加载完成", 200);
    let adminState = await waitForEvaluate(cdp, ADMIN_STATE_EXPR, (value) => value.hasList && value.rowCount === 116, 120000, "后台地点列表 116 行", 250);
    state.browser.headers = adminState.headers;
    state.browser.defaultCity = adminState.city;

    // 确保默认城市是 beijing（ACTIVE_CITY 在 .env.local 里=beijing；不正常也不硬失败，切回来即可）
    if (adminState.city !== "beijing") {
      infoLog(`后台默认城市=${adminState.city}，切换到 beijing 再做北京断言`);
      const switched = await cdp.evaluate(exprSetCity("beijing")).catch(() => null);
      if (switched === null || switched.ok !== true) throw new Error("切换城市到 beijing 失败");
      adminState = await waitForEvaluate(cdp, ADMIN_STATE_EXPR, (value) => value.hasList && value.rowCount === 116 && value.city === "beijing", 60000, "切到北京后 116 行", 250);
    }
    const sourceIndex = adminState.headers.indexOf("来源");
    check(
      state,
      group,
      "C9-header",
      "后台表头含「来源」「操作」列（验收来源列依据）",
      sourceIndex !== -1 && adminState.headers.includes("操作"),
      `表头含 来源（index=${sourceIndex}）与 操作`,
      `表头：${adminState.headers.join(" / ")}；来源 index=${sourceIndex}`,
    );
    if (sourceIndex === -1) throw new Error("后台表头没有「来源」列，无法继续 C 组");

    // C9.1 北京：116 行来源全「自动」
    const beijingSources = adminState.rows.map((row) => row.cells[sourceIndex]);
    const beijingBadSources = adminState.rows.filter((row) => row.cells[sourceIndex] !== "自动").map((row) => `${row.id}:${row.cells[sourceIndex]}`);
    check(
      state,
      group,
      "C9-beijing",
      "后台北京：116 行「来源」列全是「自动」",
      adminState.rowCount === 116 && beijingBadSources.length === 0,
      "116 行全部「自动」",
      `${adminState.rowCount} 行；非「自动」${beijingBadSources.length} 行${beijingBadSources.length === 0 ? "" : `：${beijingBadSources.slice(0, 5).join("，")}`}；来源值分布=${JSON.stringify(beijingSources.reduce((acc, value) => ({ ...acc, [value]: (acc[value] ?? 0) + 1 }), {}))}`,
    );

    // C10.1 北京主文件行：有「隐藏」无「删除」
    const beijingBadButtons = adminState.rows.filter((row) => !row.buttons.includes("隐藏") || row.buttons.includes("删除")).map((row) => `${row.id}:${row.buttons.join("|")}`);
    check(
      state,
      group,
      "C10-beijing",
      "后台北京主文件行按钮：有「隐藏」、无「删除」",
      adminState.rowCount === 116 && beijingBadButtons.length === 0,
      "116 行都有「隐藏」且都没有「删除」",
      beijingBadButtons.length === 0 ? `116/116 PASS；示例按钮=${adminState.rows[0]?.buttons.join(" / ")}` : `${beijingBadButtons.length} 行不符：${beijingBadButtons.slice(0, 5).join("；")}`,
    );
    await cdp.evaluate("window.scrollTo(0, 0)").catch(() => {});
    await sleepSafe(300);
    const beijingShot = await safeShot(cdp, state, "manual-admin-beijing.png");
    check(state, group, "C9-shot-beijing", "后台北京来源列截图 .cache/verify/manual-admin-beijing.png", beijingShot !== null, "截图存在", beijingShot === null ? "截图失败" : rel(beijingShot.path));

    // 切辽阳 → 141 行
    const switchedLiaoyang = await cdp.evaluate(exprSetCity("liaoyang")).catch(() => null);
    const liaoyangState = await waitForEvaluate(cdp, ADMIN_STATE_EXPR, (value) => value.hasList && value.rowCount === 141 && value.city === "liaoyang", 60000, "切辽阳后 141 行", 250);
    check(
      state,
      group,
      "C9-switch-liaoyang",
      "后台城市下拉切到辽阳 → 141 行",
      switchedLiaoyang !== null && switchedLiaoyang.ok === true && liaoyangState.rowCount === 141,
      "141 行",
      `rowCount=${liaoyangState.rowCount}；city=${liaoyangState.city}`,
    );
    const liaoyangSources = liaoyangState.rows.map((row) => row.cells[sourceIndex]);
    const manualRows = liaoyangState.rows.filter((row) => row.cells[sourceIndex] === "手工");
    const theaterRow = liaoyangState.rows.find((row) => row.id === "B0FFGEKXKE") ?? null;
    check(
      state,
      group,
      "C9-liaoyang",
      "后台辽阳：141 行中仅「辽阳大剧院」(B0FFGEKXKE) 来源「手工」，其余 140 行「自动」",
      liaoyangState.rowCount === 141 && manualRows.length === 1 && manualRows[0]?.id === "B0FFGEKXKE" && theaterRow !== null && theaterRow.cells[sourceIndex] === "手工" && liaoyangSources.filter((value) => value === "自动").length === 140,
      "manual=1（B0FFGEKXKE），main=140",
      `手动行=${manualRows.map((row) => `${row.id}:${row.name}`).join(",") || "(无)"}；来源分布=${JSON.stringify(liaoyangSources.reduce((acc, value) => ({ ...acc, [value]: (acc[value] ?? 0) + 1 }), {}))}`,
    );
    const liaoyangBadButtons = liaoyangState.rows.filter((row) => row.id !== "B0FFGEKXKE" && (!row.buttons.includes("隐藏") || row.buttons.includes("删除")));
    check(
      state,
      group,
      "C10-liaoyang-theater",
      "辽阳大剧院行按钮：有「删除」、无「隐藏」（origin=manual）",
      theaterRow !== null && theaterRow.buttons.includes("删除") && !theaterRow.buttons.includes("隐藏"),
      "大剧院行按钮含「删除」、不含「隐藏」",
      theaterRow === null ? "未找到大剧院行" : `按钮=${theaterRow.buttons.join(" / ")}；来源=${theaterRow.cells[sourceIndex]}`,
    );
    check(
      state,
      group,
      "C10-liaoyang-others",
      "辽阳其余 140 行按钮：有「隐藏」、无「删除」",
      liaoyangState.rowCount === 141 && liaoyangBadButtons.length === 0,
      "140 行都有「隐藏」且都没有「删除」",
      liaoyangBadButtons.length === 0 ? "140/140 PASS" : `${liaoyangBadButtons.length} 行不符：${liaoyangBadButtons.slice(0, 5).map((row) => `${row.id}:${row.buttons.join("|")}`).join("；")}`,
    );
    await cdp.evaluate("window.scrollTo(0, 0)").catch(() => {});
    await sleepSafe(300);
    const liaoyangShot = await safeShot(cdp, state, "manual-admin-liaoyang.png");
    check(state, group, "C10-shot-liaoyang", "后台辽阳来源列/按钮截图 .cache/verify/manual-admin-liaoyang.png", liaoyangShot !== null, "截图存在", liaoyangShot === null ? "截图失败" : rel(liaoyangShot.path));

    // 控制台（E19）：只读阶段无 error（AMap 噪声过滤）
    const rawErrors = collector.errors.slice();
    const filtered = rawErrors.filter((line) => !CONSOLE_NOISE.test(String(line)));
    state.console = { rawCount: rawErrors.length, filtered: filtered.slice(0, 20), warningsCount: collector.warnings.length, warningsSample: collector.warnings.slice(0, 5) };
    check(
      state,
      GROUPS.e,
      "E19-console",
      "浏览器只读验收阶段控制台无 error（AMap 资源类噪声按既有口径过滤）",
      filtered.length === 0,
      `过滤后 error 0 条（原始 ${rawErrors.length} 条；warnings ${collector.warnings.length} 条）`,
      filtered.length === 0 ? `0 条；warnings=${collector.warnings.length}` : `${filtered.length} 条：${filtered.slice(0, 5).join(" ｜ ")}`,
    );
  } finally {
    if (collector !== null && state.console === undefined) {
      state.console = { rawCount: collector.errors.length, filtered: [], warningsCount: collector.warnings.length, warningsSample: collector.warnings.slice(0, 5) };
    }
    if (cdp !== null) {
      try {
        cdp.close();
      } catch {
        /* ignore */
      }
    }
    if (launched !== null) await closeEdge(launched);
  }
}

/* ------------------------------------------------------------------ *
 * D. 写入方最小格式（进程内 route handler）
 * ------------------------------------------------------------------ */

function phaseWriteTests(state) {
  const group = GROUPS.d;
  if (SKIP_WRITE) {
    skipCheck(state, group, "D-skip", "写入路径测试（--no-write）", "本次传了 --no-write，跳过长 D 组；数据文件仍会在 G 组核对 = clean 基线");
    return;
  }
  ensureDirs();
  if (!existsSync(WRITE_HELPER)) writeHelpers();
  const result = runCommand(state, "manual-write-tests", "npx tsx .cache/verify/manual-write-tests.mts", { timeoutMs: 240000 });
  let parsed = null;
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith("__WRITE_TEST_JSON__")) {
      try {
        parsed = JSON.parse(line.slice("__WRITE_TEST_JSON__".length));
      } catch (error) {
        infoLog(`write-tests helper JSON 解析失败：${messageText(error)}`);
      }
    }
  }
  state.writeTests = { command: result.command, exitCode: result.status, parsed: parsed, logPath: rel(result.logPath), tail: tailLines(result.output, 12) };
  check(
    state,
    group,
    "D0",
    "进程内 route handler 写测试脚本可运行（npx tsx import app/api/admin/places/route）",
    parsed !== null,
    "输出 __WRITE_TEST_JSON__",
    `exit=${result.status}；输出尾：${tailLines(result.output, 8)}`,
  );
  if (parsed === null) return;
  const baselineInfo = parsed.baseline ?? {};
  state.writeBaseline = baselineInfo;
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  state.writeResults = results;
  const stepCounters = {};
  for (const item of results) {
    const step = String(item.step ?? "?");
    stepCounters[step] = (stepCounters[step] ?? 0) + 1;
    const id = `${step}.${stepCounters[step]}`;
    addCheck(state, group, id, String(item.name ?? "(未命名)"), item.status === "PASS" ? "PASS" : "FAIL", "PASS", String(item.detail ?? ""));
  }
  // D15 静态：rate-places 写回 { id, importance }（ManualPlaceEntrySchema.parse）
  const rateSource = readText(path.join(ROOT_DIR, "scripts", "rate-places.ts")) ?? "";
  const minimalPattern = /ManualPlaceEntrySchema\.parse\(\{\s*id:\s*item\.place\.id,\s*importance:\s*item\.star\s*\}\)/;
  const legacyCopyPattern = /(saveManualPlaces[\s\S]{0,400}?\.\.\.item\.place)|(\.\.\.item\.place[\s\S]{0,400}?saveManualPlaces)/;
  const minimalMatch = minimalPattern.exec(rateSource);
  check(
    state,
    group,
    "D15-static",
    "scripts/rate-places.ts 写 manual 的条目是 { id: item.place.id, importance: item.star }（不再复制整条 Place）",
    minimalMatch !== null && !legacyCopyPattern.test(rateSource),
    "含 ManualPlaceEntrySchema.parse({ id: item.place.id, importance: item.star })，无 ...item.place 整条复制",
    minimalMatch === null ? "没有找到最小写回语句" : `命中：${truncate(minimalMatch[0], 160)}；legacyCopy=${legacyCopyPattern.test(rateSource)}`,
  );
  // D15 可选：rate-places --dry-run 冒烟不写盘
  const beforeSha = sha256File(manualPathOf("beijing"));
  const rateDry = runCommand(state, "rate-places-dry-run", "npx tsx --env-file=.env.local scripts/rate-places.ts beijing --dry-run --no-llm --limit=1", { timeoutMs: 180000 });
  const afterSha = sha256File(manualPathOf("beijing"));
  if (rateDry.status === 0) {
    check(
      state,
      group,
      "D15-dry-run",
      "rate-places --dry-run --no-llm 冒烟：退出码 0 且不写盘（manual sha256 不变）",
      beforeSha === afterSha,
      `exit 0 + sha 不变（${first16(beforeSha)}…）`,
      `exit=${rateDry.status}；sha ${first16(beforeSha)}→${first16(afterSha)}；输出尾：${tailLines(rateDry.output, 3)}`,
    );
  } else {
    skipCheck(state, group, "D15-dry-run", "rate-places --dry-run 冒烟（可选）", `可选冒烟未成功（exit=${rateDry.status}），不判 FAIL；输出尾：${tailLines(rateDry.output, 3)}`);
  }
  // 写测试自身还原结果（最终 G 组还会再核一遍）
  check(
    state,
    group,
    "D-restore",
    "写测试 helper 结束时已从 clean.json 还原两城 manual 文件（sha = 基线）",
    parsed.restore !== undefined && CITIES.every((city) => parsed.restore?.[city.id]?.restored === true),
    "两城 restored=true",
    CITIES.map((city) => `${city.id}: current=${first16(parsed.restore?.[city.id]?.currentSha)}… clean=${first16(parsed.restore?.[city.id]?.cleanSha)}… restored=${parsed.restore?.[city.id]?.restored}`).join("；"),
  );
}

/* ------------------------------------------------------------------ *
 * G. 数据还原复核（外层 finally 一定执行）
 * ------------------------------------------------------------------ */

function restoreManualFromClean() {
  const report = {};
  for (const city of CITIES) {
    const cleanText = readText(cleanPathOf(city.id));
    if (cleanText === null) {
      report[city.id] = { restored: false, reason: "clean 基线不存在" };
      continue;
    }
    writeFileSync(manualPathOf(city.id), cleanText, "utf8");
    const sha = sha256File(manualPathOf(city.id));
    const shaTxt = parseShaTxt(city.id);
    report[city.id] = { restored: sha === shaTxt["manual.clean"], sha: sha, cleanSha: shaTxt["manual.clean"], bytes: statSync(manualPathOf(city.id)).size };
  }
  return report;
}

async function phaseRestoreVerify(state) {
  const group = GROUPS.g;
  // 还原（即使 D 组没跑也执行；幂等）
  let restoreReport = null;
  try {
    restoreReport = restoreManualFromClean();
  } catch (error) {
    restoreReport = null;
    check(state, group, "G0", "从 clean 基线还原 manual 数据", false, "两城还原成功", `异常：${messageText(error)}`);
  }
  state.restore = restoreReport ?? state.restore;
  for (const city of CITIES) {
    const info = restoreReport === null ? null : restoreReport[city.id];
    const baseline = state.baselines?.[city.id];
    check(
      state,
      group,
      `G1-${city.id}`,
      `${city.label}数据已还原：manual sha256 = clean 基线（测试前 ${first16(baseline?.manualSha)}…）`,
      info !== null && info.restored === true && info.sha === MANUAL_CLEAN_SHA[city.id],
      `sha256=${MANUAL_CLEAN_SHA[city.id]}`,
      info === null ? "还原失败/未执行" : `sha256=${info.sha}；体积=${formatBytes(info.bytes)}；与 clean 一致=${info.restored}`,
    );
  }

  // 还原后重跑不变式（文件层数据没变）
  const invariant = runInvariantHelper(state);
  const parsed = invariant.parsed;
  for (const city of CITIES) {
    const data = parsed === null ? null : parsed.cities?.[city.id];
    check(
      state,
      group,
      `G2-${city.id}`,
      `${city.label}还原后独立进程 loadCity().places 仍与 merged-before 快照完全相等`,
      invariant.exitCode === 0 && data !== null && data.currentEqualsBefore === true && data.currentCompactShaEqualsBefore === true,
      "deepEqual + JSON 紧凑 sha256 相等",
      data === null ? `invariant 无结果（exit=${invariant.exitCode}）` : `equalsBefore=${data.currentEqualsBefore}；sha=${first16(data.currentCompactSha)}… vs before=${first16(data.mergedBeforeCompactSha)}…`,
    );
  }

  // 还原后 API 复查（server 缓存内容 = 基线；若 dev server 不可达则 SKIP）
  for (const city of CITIES) {
    const response = await apiGet(`/api/admin/places?city=${city.id}&includeHidden=1`, { timeoutMs: 30000, baseUrl: APP }).catch((error) => ({ status: null, json: null, error }));
    if (response.status !== 200) {
      skipCheck(state, group, `G3-${city.id}`, `${city.label}还原后 API 复查`, `dev server 不可达/异常：HTTP ${response.status}`);
      continue;
    }
    const rows = Array.isArray(response.json?.places) ? response.json.places : null;
    const mergedBefore = placesOf(readJsonFile(mergedBeforePathOf(city.id)).value);
    const expectedRows = expectedApiRowsFromSnapshot(mergedBefore);
    const compare = compareApiRows(rows, expectedRows);
    const originCounts = {};
    for (const row of rows ?? []) originCounts[row.origin] = (originCounts[row.origin] ?? 0) + 1;
    check(
      state,
      group,
      `G3-${city.id}`,
      `${city.label}还原后 API：total=${city.manualCount}、字段（除 origin）与快照一致、origin 分布正确`,
      compare.totalOk && compare.orderOk && compare.fieldProblems.length === 0 && (city.id === "beijing" ? originCounts.main === 116 : originCounts.main === 140 && originCounts.manual === 1),
      city.id === "beijing" ? "total=116，origin main=116" : "total=141，origin main=140 + manual=1",
      `HTTP ${response.status}，total=${response.json?.total}；orderOk=${compare.orderOk}；字段差异=${compare.fieldProblems.length === 0 ? "无" : compare.fieldProblems.join("；")}；origin=${JSON.stringify(originCounts)}`,
    );
  }

  // 原子写临时文件残留
  const tmpFiles = readdirSync(DATA_DIR).filter((name) => name.includes(".tmp-"));
  check(state, group, "G4-tmp-clean", "data/cities 下没有原子写残留的 .tmp-* 临时文件", tmpFiles.length === 0, "0 个 .tmp-*", tmpFiles.length === 0 ? "0 个" : `残留：${tmpFiles.join("、")}`);

  // 明确写进报告：数据已还原
  const allRestored = CITIES.every((city) => state.restore?.[city.id]?.restored === true);
  check(
    state,
    group,
    "G5-restored-statement",
    "报告确认：写测试结束后 data/cities/*.manual.json 已还原（sha256 = clean 基线，无残留改动）",
    allRestored,
    "两城 sha256 = clean 基线",
    CITIES.map((city) => `${city.id} ${first16(state.restore?.[city.id]?.sha)}… = ${first16(MANUAL_CLEAN_SHA[city.id])}…`).join("；"),
  );
}

/* ------------------------------------------------------------------ *
 * E. 回归
 * ------------------------------------------------------------------ */

function backupAdminMapArtifacts() {
  try {
    if (existsSync(ADMIN_MAP_BACKUP_DIR)) rmSync(ADMIN_MAP_BACKUP_DIR, { recursive: true, force: true });
    mkdirSync(ADMIN_MAP_BACKUP_DIR, { recursive: true });
    const saved = [];
    for (const name of ["acceptance.md", "acceptance.json"]) {
      const source = path.join(ADMIN_MAP_REPORT_DIR, name);
      if (existsSync(source)) {
        writeFileSync(path.join(ADMIN_MAP_BACKUP_DIR, name), readFileSync(source));
        saved.push(name);
      }
    }
    if (existsSync(CACHE_DIR)) {
      for (const name of readdirSync(CACHE_DIR)) {
        if (!/^admin-map-.*\.png$/.test(name)) continue;
        writeFileSync(path.join(ADMIN_MAP_BACKUP_DIR, name), readFileSync(path.join(CACHE_DIR, name)));
        saved.push(name);
      }
    }
    return saved;
  } catch (error) {
    infoLog(`备份上一轮地图验收产物失败：${messageText(error)}`);
    return [];
  }
}

function restoreAdminMapArtifacts(saved) {
  const restored = [];
  try {
    for (const name of saved) {
      const source = path.join(ADMIN_MAP_BACKUP_DIR, name);
      if (!existsSync(source)) continue;
      const destination = /^admin-map-.*\.png$/.test(name) ? path.join(CACHE_DIR, name) : path.join(ADMIN_MAP_REPORT_DIR, name);
      writeFileSync(destination, readFileSync(source));
      restored.push(name);
    }
  } catch (error) {
    infoLog(`恢复上一轮地图验收产物失败：${messageText(error)}`);
  }
  return restored;
}

function phaseRegressions(state) {
  const group = GROUPS.e;

  // E16.1 tsc
  const tsc = runCommand(state, "tsc", "npx tsc --noEmit", { timeoutMs: 300000 });
  const tscHasError = /(^|\n)\s*error TS\d+/i.test(tsc.output);
  check(
    state,
    group,
    "E16-tsc",
    "npx tsc --noEmit = 0 error",
    tsc.status === 0 && !tscHasError,
    "exit 0 且无 error TS",
    `exit=${tsc.status}；error TS 命中=${tscHasError}；输出尾：${tailLines(tsc.output, 3)}；日志=${rel(tsc.logPath)}`,
  );

  // E16.2 lint
  const lint = runCommand(state, "lint", "npm run lint", { timeoutMs: 300000 });
  const lintOutput = lint.output;
  const lintClean =
    lint.status === 0 &&
    !/Error:/i.test(lintOutput) &&
    (!/warning/i.test(lintOutput) || /No ESLint warnings or errors/i.test(lintOutput));
  check(
    state,
    group,
    "E16-lint",
    "npm run lint = 0 warning / 0 error",
    lintClean,
    "exit 0 + 无 warning/error（No ESLint warnings or errors）",
    `exit=${lint.status}；输出尾：${tailLines(lintOutput, 4)}；日志=${rel(lint.logPath)}`,
  );

  // E16.3 check:city 与基线一致（13 通过 / 1 失败）
  const checkCity = runCommand(state, "check-city", "npm run check:city", { timeoutMs: 180000 });
  const checkCityOutput = checkCity.output;
  const summaryMatch = /结果：FAIL（(\d+) 项失败，(\d+) 项通过）/.exec(checkCityOutput);
  const detailIndex = checkCityOutput.indexOf("失败明细：");
  const detailLines = detailIndex === -1
    ? []
    : checkCityOutput
        .slice(detailIndex + "失败明细：".length)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("- "));
  const uniqueFailureTexts = [...new Set(detailLines)];
  const actualFailCount = summaryMatch === null ? null : Number(summaryMatch[1]);
  const actualPassCount = summaryMatch === null ? null : Number(summaryMatch[2]);
  // 基线口径（Lead 已确认）：13 通过 / 1 失败，唯一失败项是「索引未登记的城市文件：hangzhou.json、liaoyang.events.json」。
  // 注意 check-city 自己的输出里同一句话会在不同段落出现多次，只比较「失败明细」段去重后的唯一失败项。
  const failureMatchesBaseline =
    actualFailCount === CHECK_CITY_BASELINE.failCount &&
    actualPassCount === CHECK_CITY_BASELINE.passCount &&
    uniqueFailureTexts.length === 1 &&
    uniqueFailureTexts[0].includes(CHECK_CITY_BASELINE.failText);
  check(
    state,
    group,
    "E16-check-city",
    "npm run check:city 与基线一致（13 通过 / 1 失败，失败项 = hangzhou.json、liaoyang.events.json 未登记，本轮之前就存在）",
    checkCity.status === 1 && failureMatchesBaseline,
    `${CHECK_CITY_BASELINE.passCount} 通过 / ${CHECK_CITY_BASELINE.failCount} 失败；唯一失败项="${CHECK_CITY_BASELINE.failText}"`,
    summaryMatch === null
      ? `exit=${checkCity.status}；未匹配到「结果：FAIL（N 项失败，M 项通过）」；输出尾：${tailLines(checkCityOutput, 5)}`
      : `${actualPassCount} 通过 / ${actualFailCount} 失败；失败明细去重后=${JSON.stringify(uniqueFailureTexts)}；exit=${checkCity.status}`,
  );

  // E17 上一轮地图验收（只读，默认 3000；脚本会核对前端 3 个文件 hash）
  const savedArtifacts = backupAdminMapArtifacts();
  let adminMapReport = null;
  try {
    const adminMap = runCommand(state, "admin-map-acceptance", "node scripts/verify/admin-map-acceptance.mjs", {
      timeoutMs: 10 * 60 * 1000,
      env: { ...process.env, VERIFY_BASE_URL: APP },
    });
    const summary = parseSummaryLine(adminMap.output);
    try {
      const childJson = readJsonFile(path.join(ADMIN_MAP_REPORT_DIR, "acceptance.json"));
      if (childJson.ok) adminMapReport = { summary: childJson.value?.summary ?? null, meta: childJson.value?.meta ?? null };
    } catch {
      adminMapReport = null;
    }
    state.adminMapRegression = { command: adminMap.command, exitCode: adminMap.status, summary: summary, logPath: rel(adminMap.logPath), report: adminMapReport };
    check(
      state,
      group,
      "E17-map-acceptance",
      "上一轮地图验收 scripts/verify/admin-map-acceptance.mjs（只读，3000）全 PASS：FAIL 0、PASS 90、SKIP 1（headless wheel 已知项）",
      adminMap.status === 0 && summary !== null && summary.fail === 0 && summary.pass === 90 && summary.skip === 1,
      "exit 0；FAIL 0；PASS 90；SKIP 1",
      summary === null ? `exit=${adminMap.status}；未匹配到汇总行；输出尾：${tailLines(adminMap.output, 5)}` : `exit=${adminMap.status}；汇总行="${summary.summaryLine}"；PASS ${summary.pass} / FAIL ${summary.fail} / SKIP ${summary.skip}；日志=${rel(adminMap.logPath)}`,
    );
    const selfHashLines = adminMap.output
      .split(/\r?\n/)
      .filter((line) => line.includes("SELF2"))
      .slice(0, 2);
    check(
      state,
      group,
      "E17-map-selff2-hash",
      "地图验收脚本 SELF2（前端 3 文件 hash 与冻结值一致）仍 PASS",
      selfHashLines.length > 0 && selfHashLines.every((line) => line.startsWith("[PASS]")),
      "SELF2 PASS",
      selfHashLines.length === 0 ? "日志里没有 SELF2 行" : selfHashLines.join(" ｜ "),
    );
  } finally {
    const restored = restoreAdminMapArtifacts(savedArtifacts);
    if (restored.length > 0) infoLog(`已恢复上一轮地图验收产物 ${restored.length} 个文件（避免本轮回归覆盖上一轮报告/截图）`);
  }

  // E18.1 admin-ui 只读回归
  const adminUi = runCommand(state, "admin-ui", "node scripts/verify/admin-ui.mjs", {
    timeoutMs: 10 * 60 * 1000,
    env: { ...process.env, VERIFY_BASE_URL: APP },
  });
  const adminUiSummary = parseSummaryLine(adminUi.output);
  state.adminUiRegression = { command: adminUi.command, exitCode: adminUi.status, summary: adminUiSummary, logPath: rel(adminUi.logPath) };
  check(
    state,
    group,
    "E18-admin-ui",
    "上一轮后台验收 node scripts/verify/admin-ui.mjs（3000，只读 + 打开编辑弹窗不保存）PASS",
    adminUi.status === 0 && adminUiSummary !== null && adminUiSummary.fail === 0,
    "exit 0；FAIL 0",
    adminUiSummary === null ? `exit=${adminUi.status}；未匹配到汇总行；输出尾：${tailLines(adminUi.output, 5)}` : `exit=${adminUi.status}；PASS ${adminUiSummary.pass} / FAIL ${adminUiSummary.fail} / SKIP ${adminUiSummary.skip}；日志=${rel(adminUi.logPath)}`,
  );

  // E18.2 api-checks 只读子集（--only=sort：importance 排序 / 过滤；不跑 events CRUD）
  const apiChecks = runCommand(state, "api-checks-sort", "node scripts/verify/api-checks.mjs --only=sort", {
    timeoutMs: 5 * 60 * 1000,
    env: { ...process.env, VERIFY_BASE_URL: APP },
  });
  const apiSummary = parseSummaryLine(apiChecks.output);
  state.apiChecksRegression = { command: apiChecks.command, exitCode: apiChecks.status, summary: apiSummary, logPath: rel(apiChecks.logPath) };
  check(
    state,
    group,
    "E18-api-checks-sort",
    "api-checks --only=sort（只读：importance 排序 / minImportance 过滤）全 PASS，未跑任何写操作",
    apiChecks.status === 0 && apiSummary !== null && apiSummary.fail === 0,
    "exit 0；FAIL 0",
    apiSummary === null ? `exit=${apiChecks.status}；未匹配到汇总行；输出尾：${tailLines(apiChecks.output, 5)}` : `exit=${apiChecks.status}；PASS ${apiSummary.pass} / FAIL ${apiSummary.fail} / SKIP ${apiSummary.skip}；日志=${rel(apiChecks.logPath)}`,
  );

  // E20 页面写操作不在浏览器测（静态自证：主脚本只 import apiGet；浏览器阶段无 .click；写路径全部在 tsx 助手里调 route handler）
  const selfSource = readText(fileURLToPath(import.meta.url)) ?? "";
  const directWriteApiPattern = new RegExp("api" + "Post\\(|api" + "Patch\\(|api" + "Delete\\(");
  const browserClickPattern = new RegExp("\\." + "click\\(");
  const hasDirectWriteApi = directWriteApiPattern.test(selfSource);
  const hasBrowserClick = browserClickPattern.test(selfSource);
  check(
    state,
    group,
    "E20-browser-readonly",
    "页面写操作不在浏览器里测（主脚本只 GET；浏览器阶段不点击任何写按钮；PATCH/DELETE/POST 只在进程内 route handler 助手里调用）",
    !hasDirectWriteApi && !hasBrowserClick,
    "主脚本无 apiPost/apiPatch/apiDelete 调用、无按钮点击调用",
    `directWriteApi=${hasDirectWriteApi}；browserClick=${hasBrowserClick}`,
  );
}

/* ------------------------------------------------------------------ *
 * 报告
 * ------------------------------------------------------------------ */

function summaryFromChecks(state) {
  const pass = state.checks.filter((item) => item.status === "PASS").length;
  const fail = state.checks.filter((item) => item.status === "FAIL").length;
  const skip = state.checks.filter((item) => item.status === "SKIP").length;
  return { pass: pass, fail: fail, skip: skip, total: state.checks.length };
}

function buildOverview(state) {
  const mapping = [
    { key: "A1", title: "北京 manual 116 条、每条恰好 {id,importance}、顺序/分布正确", groups: [GROUPS.a], filter: (item) => item.id.startsWith("A1-") || item.id.startsWith("A2-beijing") || item.id.startsWith("A3-beijing") },
    { key: "A2", title: "辽阳 141 条（140 条两键 + 大剧院 scenery）、顺序/分布正确", groups: [GROUPS.a], filter: (item) => item.id.startsWith("A2-") || item.id.startsWith("A3-liaoyang") || item.id.startsWith("A1-liaoyang") },
    { key: "A3", title: "体积 <10KB、顶层只有 places（实测）", groups: [GROUPS.a], filter: (item) => item.id.startsWith("A4-size") },
    { key: "A4", title: "dry-run 幂等 0 变更 + 备份 orig/clean/merged-before/sha256 一致", groups: [GROUPS.a], filter: (item) => item.id.startsWith("A4-dry") || item.id.startsWith("A5-orig") || item.id.startsWith("A5-clean") || item.id.startsWith("A5-merged") },
    { key: "A5", title: "红线文件 SHA256 不变 + 无新增依赖", groups: [GROUPS.a], filter: (item) => item.id.startsWith("A5-redline") || item.id.startsWith("A5-no-new") },
    { key: "B6", title: "独立进程 loadCity 合并结果 = merged-before（含顺序）", groups: [GROUPS.b], filter: (item) => item.id.startsWith("B6-") },
    { key: "B7", title: "API 除 origin 外逐字段 = 快照，total 116/141", groups: [GROUPS.b], filter: (item) => item.id.startsWith("B7-") },
    { key: "C8", title: "API origin：北京全 main；辽阳 140 main + 大剧院 manual", groups: [GROUPS.c], filter: (item) => item.id.startsWith("C8-") },
    { key: "C9", title: "后台来源列：北京全自动；辽阳仅大剧院手工", groups: [GROUPS.c], filter: (item) => item.id.startsWith("C9-") },
    { key: "C10", title: "行内按钮：主文件行隐藏、大剧院删除（截图）", groups: [GROUPS.c], filter: (item) => item.id.startsWith("C10-") },
    { key: "D11-14", title: "写入方最小格式（PATCH 同值/整表/改名/importance、DELETE、POST）逐字节可逆", groups: [GROUPS.d], filter: (item) => /^D(11|11b|12|13|14)/.test(item.id) || item.id.startsWith("D-restore") },
    { key: "D15", title: "rate-places 最小写回静态校验 + dry-run 冒烟", groups: [GROUPS.d], filter: (item) => item.id.startsWith("D15-") },
    { key: "E16", title: "tsc / lint / check:city（与基线一致）", groups: [GROUPS.e], filter: (item) => item.id.startsWith("E16-") },
    { key: "E17", title: "上一轮地图验收回归（只读 3000）", groups: [GROUPS.e], filter: (item) => item.id.startsWith("E17-") },
    { key: "E18", title: "admin-ui + api-checks 只读回归", groups: [GROUPS.e], filter: (item) => item.id.startsWith("E18-") },
    { key: "E19/20", title: "控制台无 error；页面写操作不在浏览器测", groups: [GROUPS.e], filter: (item) => item.id === "E19-console" || item.id.startsWith("E20-") },
    { key: "G", title: "数据还原复核：manual sha256 = clean 基线（测试前后一致）", groups: [GROUPS.g], filter: () => true },
  ];
  return mapping.map((item) => {
    const list = state.checks.filter((entry) => item.groups.includes(entry.group) && item.filter(entry));
    const pass = list.filter((entry) => entry.status === "PASS").length;
    const fail = list.filter((entry) => entry.status === "FAIL").length;
    const skip = list.filter((entry) => entry.status === "SKIP").length;
    const status = fail > 0 ? "FAIL" : list.length === 0 ? "SKIP" : pass > 0 ? "PASS" : "SKIP";
    const evidence = list
      .filter((entry) => entry.status !== "SKIP")
      .slice(0, 3)
      .map((entry) => `${entry.id} ${entry.actual}`)
      .join("；");
    return { key: item.key, title: item.title, pass: pass, fail: fail, skip: skip, status: status, evidence: truncate(evidence, 420) };
  });
}

function buildMarkdown(state, summary, meta) {
  const lines = [];
  const beforeShas = CITIES.map((city) => `${city.label} ${state.baselines?.[city.id]?.manualSha ?? "(未采样)"}`).join("；");
  const afterShas = CITIES.map((city) => `${city.label} ${state.restore?.[city.id]?.sha ?? "(未还原)"}`).join("；");
  lines.push("# manual 层瘦身 · 验收报告（verifier-manual）");
  lines.push("");
  lines.push(`- 生成时间：${meta.generatedAtLocal}（${meta.generatedAtIso}）`);
  lines.push(`- 验收目标：${meta.url}（浏览器只读走 dev server；写入路径走进程内 route handler，不经过 server）`);
  lines.push(`- 浏览器：headless Edge ${meta.browserVersion} + CDP，视口 1280×900`);
  lines.push(`- 契约：build/manual-layer-contract.md §4 A–E（含 11b）`);
  lines.push(`- 实现冻结 hash：${Object.entries(IMPL_FROZEN_HASHES).map(([relPath, expected]) => `${relPath}=${expected}`).join("；")}`);
  lines.push(`- 结果：**PASS ${summary.pass} / FAIL ${summary.fail} / SKIP ${summary.skip}**（共 ${summary.total} 条）`);
  lines.push(`- **数据已还原**：测试前 manual sha256：${beforeShas}；测试后：${afterShas}；与 clean 基线一致=${CITIES.every((city) => state.restore?.[city.id]?.restored === true) ? "是（已还原）" : "否（见 FAIL）"}`);
  lines.push("");
  lines.push("## 一、验收总览（A–E 逐项）");
  lines.push("");
  lines.push("| 项 | 结果 | 通过/失败/跳过 | 关键证据 |");
  lines.push("| --- | --- | --- | --- |");
  for (const item of buildOverview(state)) lines.push(`| ${item.key} ${item.title} | ${item.status} | ${item.pass}/${item.fail}/${item.skip} | ${item.evidence.replace(/\|/g, "/")} |`);
  lines.push("");
  lines.push("## 二、逐条明细（期望 / 实际）");
  for (const group of GROUP_ORDER) {
    const list = state.checks.filter((entry) => entry.group === group);
    if (list.length === 0) continue;
    lines.push("");
    lines.push(`### ${group}`);
    for (const entry of list) {
      lines.push(`- **${entry.status}** \`${entry.id}\` ${entry.name}`);
      lines.push(`  - 期望：${entry.expected}`);
      lines.push(`  - 实际：${entry.actual}`);
    }
  }
  lines.push("");
  lines.push("## 三、数据还原确认（必须）");
  lines.push("");
  lines.push("本轮 D 组写测试全部走「进程内 import app/api/admin/places/route.ts + new Request」；每一步都核对 manual 文件的 sha256。");
  lines.push("");
  lines.push("| 城市 | 测试前 sha256 | 测试后 sha256 | clean 基线 sha256 | 是否还原 |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const city of CITIES) {
    lines.push(`| ${city.label} | ${state.baselines?.[city.id]?.manualSha ?? "(未采样)"} | ${state.restore?.[city.id]?.sha ?? "(未还原)"} | ${MANUAL_CLEAN_SHA[city.id]} | ${state.restore?.[city.id]?.restored === true ? "是（逐字节 = clean 基线）" : "否"} |`);
  }
  lines.push("");
  lines.push("说明：D 组写测试的每一步（PATCH 同值 / 整份表单不变值 / 只改 name / importance 新值 / DELETE 星-only 隐藏→恢复 / 改 name 后 DELETE 真删 / POST+DELETE）都在 helper 的 `finally` 里从 `<city>.manual.clean.json` 强制还原；本脚本外层 `finally`/G 组再做一次还原并用 sha256 复核。");
  lines.push("");
  lines.push("## 四、write 测试逐步证据（进程内 route handler）");
  lines.push("");
  const writeResults = Array.isArray(state.writeResults) ? state.writeResults : [];
  if (writeResults.length === 0) lines.push("- （未运行 / --no-write）");
  for (const item of writeResults) lines.push(`- **${item.status}** ${item.step} ${item.name} — ${item.detail}`);
  lines.push("");
  lines.push("## 五、A. 文件格式实测（体积 / 分布）");
  lines.push("");
  for (const city of CITIES) {
    lines.push(`- ${city.label}：${formatBytes(state.baselines?.[city.id]?.manualBytes)}（瘦身前 orig ${formatBytes(state.baselines?.[city.id]?.origBytes)}）；importance 分布 ${JSON.stringify(city.importanceDist)}`);
  }
  lines.push("");
  lines.push("## 六、B. 数据不变式（独立进程 + API）");
  lines.push("");
  lines.push(`- 独立进程 helper：${state.invariant?.command ?? "(未运行)"}；exit=${state.invariant?.exitCode ?? "?"}；日志=${state.invariant?.logPath ?? "(无)"}`);
  lines.push(`- merged-before 紧凑 sha256 与 sha256.txt 比对、orig 合并比对、API 逐字段比对见「二、逐条明细」。`);
  lines.push("");
  lines.push("## 七、C. 后台来源列 / 按钮（截图）");
  lines.push("");
  lines.push(`- 表头：${(state.browser?.headers ?? []).join(" / ")}；默认城市=${state.browser?.defaultCity ?? "?"}`);
  for (const name of ["manual-admin-beijing.png", "manual-admin-liaoyang.png"]) {
    const filePath = state.screenshots[name];
    lines.push(`- ${name}：${filePath === null || filePath === undefined ? "（截图失败/未生成）" : rel(filePath)}`);
  }
  lines.push("");
  lines.push("## 八、E. 回归命令与日志");
  lines.push("");
  const regressionEntries = [
    ["tsc", "npx tsc --noEmit", state.checks.find((item) => item.id === "E16-tsc")],
    ["lint", "npm run lint", state.checks.find((item) => item.id === "E16-lint")],
    ["check:city", "npm run check:city", state.checks.find((item) => item.id === "E16-check-city")],
    ["admin-map-acceptance", "node scripts/verify/admin-map-acceptance.mjs（VERIFY_BASE_URL=" + APP + "）", state.checks.find((item) => item.id === "E17-map-acceptance")],
    ["admin-ui", "node scripts/verify/admin-ui.mjs（VERIFY_BASE_URL=" + APP + "）", state.checks.find((item) => item.id === "E18-admin-ui")],
    ["api-checks --only=sort", "node scripts/verify/api-checks.mjs --only=sort（VERIFY_BASE_URL=" + APP + "）", state.checks.find((item) => item.id === "E18-api-checks-sort")],
  ];
  for (const [label, command, entry] of regressionEntries) {
    lines.push(`- ${label}：\`${command}\` → ${entry === undefined ? "(未执行)" : entry.status + "（" + entry.actual + "）"}`);
  }
  lines.push(`- 日志目录：${rel(REPORT_DIR)}/`);
  lines.push("");
  lines.push("## 九、备注：辽阳大剧院条目键序（契约已更新）");
  lines.push("");
  lines.push("- 契约 §2/§4 A.2 已更新为「按键集合比较，不按顺序比较」：大剧院条目键集合 = `{id, importance, scenery}`。");
  lines.push("- 实际键序 = `[\"id\",\"scenery\",\"importance\"]`，按 `scripts/shrink-manual.ts` 的 FIELD_ORDER（id 最前，其余按 PlaceSchema 字段顺序，scenery 在 importance 之前），与 §3.4 一致；报告中按集合断言 PASS，并附实际键序。");
  lines.push("");
  lines.push("## 十、FAIL 汇总");
  lines.push("");
  const failures = state.checks.filter((entry) => entry.status === "FAIL");
  if (failures.length === 0) lines.push("- 无");
  for (const entry of failures) {
    lines.push(`- \`${entry.id}\` ${entry.name}`);
    lines.push(`  - 期望：${entry.expected}`);
    lines.push(`  - 实际：${entry.actual}`);
  }
  lines.push("");
  return lines.join("\n");
}

function buildJsonReport(state, summary, meta) {
  return {
    meta: meta,
    summary: summary,
    acceptance: buildOverview(state),
    checks: state.checks,
    screenshots: state.screenshots,
    app: APP,
    implFrozenHashes: IMPL_FROZEN_HASHES,
    frozenHashes: state.frozenHashes,
    baselines: Object.fromEntries(
      Object.entries(state.baselines ?? {}).map(([city, info]) => [
        city,
        {
          manualSha: info.manualSha,
          cleanSha: info.cleanSha,
          manualBytes: info.manualBytes,
          origBytes: info.origBytes,
          files: info.files,
          shaTxt: info.shaTxt,
        },
      ]),
    ),
    restore: state.restore,
    dryRun: { logPath: "shrink-dry-run.log" },
    invariant: state.invariant,
    writeTests: state.writeTests,
    writeResults: state.writeResults,
    browser: state.browser,
    console: state.console,
    adminMapRegression: state.adminMapRegression ?? null,
    adminUiRegression: state.adminUiRegression ?? null,
    apiChecksRegression: state.apiChecksRegression ?? null,
  };
}

function writeReports(state, summary, meta) {
  ensureDirs();
  const mdPath = path.join(REPORT_DIR, "acceptance.md");
  const jsonPath = path.join(REPORT_DIR, "acceptance.json");
  writeFileSync(mdPath, `${buildMarkdown(state, summary, meta)}\n`, "utf8");
  writeFileSync(jsonPath, `${JSON.stringify(buildJsonReport(state, summary, meta), null, 2)}\n`, "utf8");
  console.log(`\n[report] 验收报告：${mdPath}`);
  console.log(`[report] 结构化证据：${jsonPath}`);
  return { mdPath, jsonPath };
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

function createState() {
  return {
    checks: [],
    screenshots: {},
    baselines: {},
    frozenHashes: {},
    mainState: {},
    invariant: null,
    invariantData: null,
    api: {},
    browser: {},
    console: {},
    writeTests: null,
    writeResults: [],
    restore: {},
    adminMapRegression: null,
    adminUiRegression: null,
    apiChecksRegression: null,
  };
}

async function main() {
  ensureDirs();

  if (DUMP_HELPERS) {
    const helpers = writeHelpers();
    console.log(`[helpers] 已生成：${rel(helpers.invariant)}、${rel(helpers.write)}`);
    process.exitCode = 0;
    return;
  }

  // 每次运行都重新生成两个 tsx 助手：避免上一轮缓存的旧 helper 被复用（脚本改过断言时最容易踩）。
  const helpers = writeHelpers();
  infoLog(`tsx 助手已重新生成：${rel(helpers.invariant)}、${rel(helpers.write)}`);

  const startedAt = Date.now();
  const generatedAt = new Date();
  const state = createState();
  let fatalError = null;
  let lockHeld = false;

  try {
    await acquireLock();
    lockHeld = true;

    await phaseEnvironment(state);
    await phaseFormat(state);
    await phaseInvariant(state);
    await phaseApiAndOrigin(state);
    await phaseBrowser(state);
    phaseWriteTests(state);
  } catch (error) {
    fatalError = error;
    check(state, GROUPS.env, "SYS.1", "验收主流程执行完成", false, "无异常", `异常：${messageText(error)}${error instanceof Error && error.stack !== undefined ? `\n${truncate(error.stack, 500)}` : ""}`);
  } finally {
    // 数据还原（即使 D 组没跑也幂等执行；异常/中断路径也走这里）
    try {
      state.restore = restoreManualFromClean();
    } catch (error) {
      check(state, GROUPS.g, "SYS.restore", "异常路径强制还原 manual 数据", false, "两城还原成功", `异常：${messageText(error)}`);
    }
    if (lockHeld) {
      try {
        releaseLock();
      } catch {
        /* ignore */
      }
    }
  }

  // G：数据还原复核（锁已释放；只读脚本 + 写数据文件还原核验）
  try {
    await phaseRestoreVerify(state);
  } catch (error) {
    check(state, GROUPS.g, "G-SYS", "数据还原复核执行完成", false, "无异常", `异常：${messageText(error)}`);
  }

  // E：回归（只读；admin-map-acceptance 会自己拿 build/.verify-lock）
  if (SKIP_REGRESSION) {
    skipCheck(state, GROUPS.e, "E-skip", "回归组（--no-regression）", "本次传了 --no-regression，跳过 E16–E19 回归");
  } else {
    try {
      phaseRegressions(state);
    } catch (error) {
      check(state, GROUPS.e, "E-SYS", "回归组执行完成", false, "无异常", `异常：${messageText(error)}`);
    }
  }

  const summary = summaryFromChecks(state);
  summary.elapsedMs = Date.now() - startedAt;
  const meta = {
    script: "scripts/verify/manual-layer-acceptance.mjs",
    generatedAtIso: generatedAt.toISOString(),
    generatedAtLocal: generatedAt.toLocaleString("zh-CN", { hour12: false }),
    url: ADMIN_URL,
    app: APP,
    lockOwner: LOCK_NAME,
    node: process.version,
    browserVersion: state.browser.version ?? "(未启动)",
    viewport: VIEWPORT,
    implFrozenHashes: IMPL_FROZEN_HASHES,
    manualCleanSha: MANUAL_CLEAN_SHA,
    elapsedMs: summary.elapsedMs,
    fatalError: fatalError === null ? null : messageText(fatalError),
  };

  try {
    writeReports(state, summary, meta);
  } catch (error) {
    console.error(`[report] 写报告失败：${messageText(error)}`);
  }

  REPORT.printSummary();
  console.log(`\n[截图目录] ${CACHE_DIR}`);
  for (const [name, filePath] of Object.entries(state.screenshots)) {
    console.log(`  ${filePath === null ? "（失败）" : rel(filePath)}  ${name}`);
  }
  console.log(`\n[数据还原]`);
  for (const city of CITIES) {
    console.log(`  ${city.label}：测试前 ${state.baselines?.[city.id]?.manualSha ?? "(未采样)"} → 测试后 ${state.restore?.[city.id]?.sha ?? "(未还原)"}（clean 基线 ${MANUAL_CLEAN_SHA[city.id]}，还原=${state.restore?.[city.id]?.restored === true}）`);
  }
  if (summary.fail > 0) {
    console.log("\n[FAIL 明细]");
    for (const entry of state.checks.filter((item) => item.status === "FAIL")) {
      console.log(`  - ${entry.id} ${entry.name}`);
      console.log(`    期望：${entry.expected}`);
      console.log(`    实际：${entry.actual}`);
    }
  }
  console.log(`\n[结论] ${summary.fail === 0 ? `全部通过（PASS ${summary.pass} / SKIP ${summary.skip}）` : `${summary.fail} 条 FAIL（PASS ${summary.pass} / SKIP ${summary.skip}）`}`);
  process.exitCode = summary.fail > 0 ? 1 : 0;
}

main().catch((error) => {
  releaseLock();
  console.error(`[manual-layer-acceptance] 脚本异常：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exitCode = 1;
});
