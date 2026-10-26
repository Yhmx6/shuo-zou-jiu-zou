#!/usr/bin/env node
/**
 * 问答第 2 步「城市切换 + coverage」浏览器验收（scripts/verify/onboarding-city-acceptance.mjs）
 *
 * 契约：build/onboarding-city-contract.md（§3 布局/DOM、§4 切城市清理、§5 页面接线、§7 验收 1–9）
 *
 * 覆盖 §7：
 *   1. 清 localStorage 首次打开 → 第 1 步选风格进第 2 步：标题「你的起点在哪？」；
 *      onboarding-city-switch 下 2 个胶囊；北京胶囊 aria-pressed=true + 白底/深色字/1px 边框；
 *      辽阳胶囊 aria-pressed=false + 透明底/灰字。
 *   2. 点「辽阳」→ 胶囊选中切换、placeholder=例如：白塔区中心路、coverage=现在能规划：白塔区 · 文庙 · 太子河沿岸、
 *      URL ?city=liaoyang、/api/cities 不重新请求、页面 state 稳定。
 *   3. 北京填「良乡地铁站」不提交 → 点辽阳 → 输入框清空；先「解析地址」成功（已选起点）再切辽阳 →
 *      已选起点卡片消失、输入框空、onboarding-origin-error 不存在。
 *   4. 问答里选辽阳 → 走完 5 步 → 主页 city-select=liaoyang；主页下拉切北京（不清手填起点）→ 刷新 →
 *      问答第 2 步北京胶囊 aria-pressed=true（预选新城市）。
 *   5. coverage 数据/API：/api/cities 两城 coverage = 城市 json；npx tsx loadCityConfig 一致；
 *      两城 json 除 coverage 外与 git HEAD 深比较一致（places 不变）；红线文件 hash 不变；上轮 manual 文件未动。
 *   6. 北京起点「五道口站」→ 走完问答 → 主页点「现在就走」→ role=alert 失败提示里含
 *      data-testid="failure-coverage" 文案「现在能规划：良乡 · 长阳 · 顺义城区」（实时钟失败原因可能是时间文案，
 *      只断言 alert + coverage；实时钟排得出来时用 fake clock 23:50 强制失败并注明）。
 *   7. 回归：onboarding-always-acceptance（含旧标题失效断言说明）、check:city 基线 13/1、
 *      admin-map-acceptance PASS 90/0/1（只读）、tsc 0 error、lint 0 warning。
 *   8. 控制台过滤 AMap 噪声后 0 error；无 emoji。
 *   9. 1280×900 截图：第 2 步北京 / 第 2 步辽阳 / 主页失败提示（含 coverage）。
 *
 * 跑法（项目根；dev server 3000 已在跑，勿重启）：
 *   node scripts/verify/onboarding-city-acceptance.mjs
 *   node scripts/verify/onboarding-city-acceptance.mjs --no-regression   # 跳过 §7.7 重回归（调试用）
 *   node scripts/verify/onboarding-city-acceptance.mjs --dump-helper     # 只生成 tsx 助手（不跑验收）
 *
 * 约束：
 * - 浏览器独占 build/.verify-lock（内容 verifier-onboarding-city），跑自己的浏览器阶段时持有，跑回归子脚本前释放；
 * - 只读：不改 data/、不改产品代码；geocode 走真实 /api/geocode（失败时用 localStorage 测试画像兜底并在报告注明）；
 * - 只写 verifier 范围：scripts/verify/onboarding-city-acceptance.mjs、.cache/verify/、build/reports/onboarding-city/；
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
const REPORT_DIR = path.join(ROOT_DIR, "build", "reports", "onboarding-city");
const CACHE_DIR = path.join(ROOT_DIR, ".cache", "verify");
const LOCK = path.join(ROOT_DIR, "build", ".verify-lock");
const LOCK_NAME = "verifier-onboarding-city";
const CONFIG_HELPER = path.join(CACHE_DIR, "onboarding-city-config.mts");
const VIEWPORT = { width: 1280, height: 900 };
const DATA_DIR = path.join(ROOT_DIR, "data", "cities");
const SCREENSHOT_PREFIX = "onboarding-city-";

const REPORT = createReport("问答第 2 步城市切换 + coverage · 验收");

const ARGS = process.argv.slice(2);
const SKIP_REGRESSION = ARGS.includes("--no-regression");
const DUMP_HELPER = ARGS.includes("--dump-helper");

/** 契约 §1 / §3 / §7 固定数据。 */
const CITIES = {
  beijing: {
    id: "beijing",
    label: "北京",
    capsuleTestId: "onboarding-city-beijing",
    coverage: ["良乡 · 长阳", "顺义城区"],
    coverageText: "现在能规划：良乡 · 长阳 · 顺义城区",
    placeholder: "例如：良乡地铁站",
    manualAddress: "良乡地铁站",
    origin: { lat: 39.723168, lng: 116.126621, label: "良乡地铁站" },
  },
  liaoyang: {
    id: "liaoyang",
    label: "辽阳",
    capsuleTestId: "onboarding-city-liaoyang",
    coverage: ["白塔区 · 文庙", "太子河沿岸"],
    coverageText: "现在能规划：白塔区 · 文庙 · 太子河沿岸",
    placeholder: "例如：白塔区中心路",
    manualAddress: "白塔区中心路",
    origin: { lat: 41.2739, lng: 123.1869, label: "白塔区中心路" },
  },
};
const FAILURE_CITY = CITIES.beijing;
const FAILURE_ADDRESS = "五道口站";
const FAILURE_ORIGIN = { lat: 39.9925, lng: 116.3376, label: FAILURE_ADDRESS };
const FAILURE_COVERAGE_TEXT = CITIES.beijing.coverageText;
const PROFILE_KEY = "szjz.profile";
const GEO_KEY = "szjz.geo";
const FIXED_FAILURE_MINUTE = 23 * 60 + 50; // fake clock 23:50 强制「排不出来」兜底场景

/** 胶囊样式（契约 §3 / §7.1，Tailwind 实际渲染值）。 */
const STYLE = {
  selected: { backgroundColor: "rgb(255, 255, 255)", color: "rgb(28, 25, 23)", borderWidth: "1px", borderStyle: "solid", borderColor: "rgb(28, 25, 23)" },
  unselected: { backgroundColor: "rgba(0, 0, 0, 0)", color: "rgb(120, 113, 108)" },
};

/** 验收对象冻结版本（Lead T9 最终冻结，SHA256 前 16 位；SELF 断言防止验收到旧代码）。 */
const IMPL_FROZEN_HASHES = {
  "components/Onboarding.tsx": "718B38FD20FE3DB8",
  "app/page.tsx": "CA0B66A1DE6D7BA8",
  "lib/cityData.ts": "E94862F29C85069B",
  "app/api/cities/route.ts": "32A8F684EC060CE9",
  "data/cities/beijing.json": "915DBB51194B8C1C",
  "data/cities/liaoyang.json": "8D5067EE7B40DF95",
  "build/onboarding-city-contract.md": "900B9670C7BBB712",
};

/** check:city 基线（本轮之前就存在：hangzhou.json / liaoyang.events.json 未登记）。 */
const CHECK_CITY_BASELINE = {
  passCount: 13,
  failCount: 1,
  failText: "索引未登记的城市文件：hangzhou.json、liaoyang.events.json",
};

/** 本轮不许碰的文件 SHA256（§6 红线；本轮开始前实测值）。 */
const FROZEN_HASHES = {
  "types/schema.ts": "387ab987f9b76782325cc2650b9d6a143df5316176e1acdc88f0784d9115f220",
  "lib/planner.ts": "39e67609c6323e39872c7a78736c73c9644cc52d53749afac5bdd5be493629f0",
  "scripts/fetch-seed.ts": "e833204e44d3eda1db730ba381d12694a453dfc8686e1af3b9ac59ce96976487",
  "app/api/plan/route.ts": "56a486b3de291e9faf5596831c9f9b3da87d58370f1d20658777bb8a57f4a7c4",
  "app/api/geocode/route.ts": "b4116996af4fe63dd1a4dd6921e42c89a8877c69a30d8aaaa66412e8fa289411",
  "middleware.ts": "9d645da7e7a95d90d7f52a22a44b4368c8c6f782872a4bcd21de74491a41e354",
  "package.json": "a5059add3a1b9b9c4a87fbc5204ffca6a74e09312376684025e9d1c7ddfaeb94",
  "package-lock.json": "04cfe37e0966a2690bf0efa33c5616c75007d6fc3a0045c037780185584f54ef",
};

/** 上一轮 manual 瘦身结果（本轮 manual 文件不许动）。 */
const MANUAL_CLEAN_SHA = {
  beijing: "8020670aabf22fb4e83ab8bdb5aa5cd25b6c45fb42e0973d224048fce80c30d0",
  liaoyang: "bcb80b8103d2e95e5c0f610473ea9adc374ded9dcfbe453a59ea217abb0993bb",
};

/** git 可执行文件（用于取本轮开始前 git HEAD 的两个城市 json 基线）；不在 PATH 里时用 GIT_BIN 指定。 */
const PORTABLE_GIT = process.env.GIT_BIN || "git";

/** AMap 资源类 console 噪声（与既有脚本同口径）。 */
const CONSOLE_NOISE = /AMap|INVALID_USER_DOMAIN|amap|favicon|Failed to load resource|ERR_NETWORK|ERR_BLOCKED_BY_CLIENT|WebSocket connection|\[HMR\]|\[Fast Refresh\]/;

const GROUPS = {
  env: "0. 环境与数据/API 只读（coverage / 红线 / 上轮 manual 不变）",
  accept1: "1. 第 2 步布局：标题 / 城市胶囊 / 样式 / placeholder / coverage",
  accept2: "2. 切「辽阳」：胶囊 / placeholder / coverage / URL / 请求",
  accept3: "3. 切城市清空输入与已选起点",
  accept4: "4. 走完 5 步 → 主页城市 / 下拉切城市 / 刷新预选",
  accept6: "6. 失败提示带 coverage（role=alert + failure-coverage）",
  accept11: "11. 切城市+选起点+真正排一次（M1：/api/plan 不带 latitude/longitude、profile.origin.label 正确）",
  regression: "7. 回归（onboarding-always / check:city / admin-map / tsc / lint）",
  console: "8. 控制台无 error + 无 emoji",
  shots: "9. 截图",
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

function readText(absPath) {
  try {
    return readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
}

function readJson(absPath) {
  const text = readText(absPath);
  if (text === null) return { ok: false, error: "文件不存在或不可读", value: null, text: null };
  try {
    return { ok: true, error: null, value: JSON.parse(text), text };
  } catch (error) {
    return { ok: false, error: messageText(error), value: null, text };
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

function formatMs(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function ensureDirs() {
  for (const dir of [REPORT_DIR, CACHE_DIR]) if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/* ------------------------------------------------------------------ *
 * 结果记录 / 子进程 / 锁
 * ------------------------------------------------------------------ */

function addCheck(state, group, id, name, status, expected, actual) {
  const entry = { group, id, name, status, expected: truncate(String(expected), 500), actual: truncate(String(actual), 1000) };
  state.checks.push(entry);
  const line = `期望 ${entry.expected}；实际 ${entry.actual}`;
  if (status === "PASS") REPORT.pass(`${id} ${name}`, line);
  else if (status === "FAIL") REPORT.fail(`${id} ${name}`, line);
  else REPORT.skip(`${id} ${name}`, line);
  return status === "PASS";
}

function check(state, group, id, name, condition, expected, actual) {
  return addCheck(state, group, id, name, condition ? "PASS" : "FAIL", expected, actual);
}

function skipCheck(state, group, id, name, reason) {
  return addCheck(state, group, id, name, "SKIP", "(前置条件)", reason);
}

function infoLog(message) {
  REPORT.info(message);
}

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
    stdout,
    stderr,
    output: `${stdout}\n${stderr}`,
    elapsedMs: Date.now() - startedAt,
    logPath,
  };
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
    await sleep(60_000);
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
 * 数据 / API 只读阶段（§7.5 + §6 红线）
 * ------------------------------------------------------------------ */

function buildConfigHelperSource() {
  return String.raw`#!/usr/bin/env tsx
/**
 * 只读校验 lib/cityData.ts 的 loadCityConfig：coverage 字段（由 scripts/verify/onboarding-city-acceptance.mjs 生成）。
 * 输出一行 __CONFIG_JSON__{...}。
 */
import { loadCityConfig } from "@/lib/cityData";

const cityIds = ${JSON.stringify(["beijing", "liaoyang"])};
const result: Record<string, unknown> = { cities: {} };
for (const city of cityIds) {
  try {
    const config = loadCityConfig(city);
    (result.cities as Record<string, unknown>)[city] = {
      ok: true,
      displayName: config.displayName,
      coverage: config.coverage === undefined ? null : config.coverage,
      coverageType: Array.isArray(config.coverage) ? "array" : typeof config.coverage,
      coverageIsOptionalStringArray: config.coverage === undefined || (Array.isArray(config.coverage) && config.coverage.every((item) => typeof item === "string" && item.length > 0)),
      districts: config.districts,
    };
  } catch (error) {
    (result.cities as Record<string, unknown>)[city] = { ok: false, error: String(error) };
  }
}
console.log("__CONFIG_JSON__" + JSON.stringify(result));
`;
}

function writeConfigHelper() {
  ensureDirs();
  writeFileSync(CONFIG_HELPER, buildConfigHelperSource(), "utf8");
  return CONFIG_HELPER;
}

/** 用 portable git 取本轮开始前（HEAD）的城市 json 原文；取不到返回 null。 */
function readGitHeadJson(relPath) {
  const attempts = [[PORTABLE_GIT, ["show", `HEAD:${relPath}`]], ["git", ["show", `HEAD:${relPath}`]]];
  for (const [command, args] of attempts) {
    try {
      const result = spawnSync(command, args, { cwd: ROOT_DIR, encoding: "utf8", timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
      if (result.status === 0 && typeof result.stdout === "string" && result.stdout.trim() !== "") {
        return { ok: true, text: result.stdout, command: `${command} ${args.join(" ")}` };
      }
    } catch {
      /* try next */
    }
  }
  return { ok: false, text: null, command: null };
}

function countFetchLog(fetchLog, pattern) {
  return Array.isArray(fetchLog) ? fetchLog.filter((entry) => pattern.test(String(entry.url ?? ""))).length : 0;
}

async function phaseDataAndApi(state) {
  const group = GROUPS.env;

  // 0.1 /api/cities 可访问
  const citiesApi = await apiGet("/api/cities", { timeoutMs: 30000, baseUrl: APP });
  const apiCities = citiesApi.json !== null && Array.isArray(citiesApi.json.cities) ? citiesApi.json.cities : [];
  check(
    state,
    group,
    "0.1",
    "/api/cities 可访问且返回 beijing / liaoyang",
    citiesApi.status === 200 && citiesApi.json?.ok === true && apiCities.length === 2,
    "HTTP 200 + 2 个城市",
    `HTTP ${citiesApi.status}，城市=${apiCities.map((city) => city.city).join(",")}`,
  );

  // 0.2 两城 json coverage 字段（唯一来源）
  state.cityJson = {};
  for (const city of Object.values(CITIES)) {
    const raw = readJson(path.join(DATA_DIR, `${city.id}.json`));
    state.cityJson[city.id] = raw;
    const parsed = raw.ok ? raw.value : null;
    const keys = parsed === null ? [] : Object.keys(parsed);
    const coverage = parsed === null ? null : parsed.coverage;
    const coverageIndex = keys.indexOf("coverage");
    const districtsIndex = keys.indexOf("districts");
    const landmarkIndex = keys.indexOf("landmarkKeywords");
    const positionOk = coverageIndex !== -1 && districtsIndex !== -1 && coverageIndex > districtsIndex && (landmarkIndex === -1 || coverageIndex < landmarkIndex);
    check(
      state,
      group,
      `0.2-json-${city.id}`,
      `${city.label}城市 json：coverage = ${JSON.stringify(city.coverage)}，位置在 districts 之后 / landmarkKeywords 之前`,
      raw.ok && deepEqual(coverage, city.coverage) && positionOk,
      `coverage=${JSON.stringify(city.coverage)}；key 位置 districts(index=${districtsIndex}) < coverage(index=${coverageIndex}) < landmarkKeywords(index=${landmarkIndex})`,
      raw.ok ? `coverage=${JSON.stringify(coverage)}；keys=${keys.join(",")}` : `读取失败：${raw.error}`,
    );
  }

  // 0.3 /api/cities 的 coverage 与 json 一致
  for (const city of Object.values(CITIES)) {
    const apiEntry = apiCities.find((entry) => entry.city === city.id) ?? null;
    check(
      state,
      group,
      `0.3-api-${city.id}`,
      `/api/cities 的 ${city.label} coverage 与城市 json 一致`,
      apiEntry !== null && deepEqual(apiEntry.coverage, city.coverage),
      JSON.stringify(city.coverage),
      apiEntry === null ? "接口没有该城市" : `coverage=${JSON.stringify(apiEntry.coverage)}`,
    );
  }

  // 0.4 npx tsx loadCityConfig 一致
  writeConfigHelper();
  const configRun = runCommand(state, "city-config-helper", "npx tsx .cache/verify/onboarding-city-config.mts", { timeoutMs: 180000 });
  let configParsed = null;
  for (const line of configRun.stdout.split(/\r?\n/)) {
    if (line.startsWith("__CONFIG_JSON__")) {
      try {
        configParsed = JSON.parse(line.slice("__CONFIG_JSON__".length));
      } catch (error) {
        infoLog(`loadCityConfig helper JSON 解析失败：${messageText(error)}`);
      }
    }
  }
  state.configHelper = { command: configRun.command, exitCode: configRun.status, parsed: configParsed, logPath: rel(configRun.logPath) };
  check(
    state,
    group,
    "0.4-helper-run",
    "npx tsx 独立进程 loadCityConfig() 可运行并输出 coverage",
    configRun.status === 0 && configParsed !== null,
    "exit 0 + __CONFIG_JSON__",
    `exit=${configRun.status}；输出尾：${configRun.output.trim().split(/\r?\n/).slice(-3).join(" | ")}`,
  );
  for (const city of Object.values(CITIES)) {
    const info = configParsed === null ? null : configParsed.cities?.[city.id];
    check(
      state,
      group,
      `0.4-config-${city.id}`,
      `loadCityConfig('${city.id}').coverage = ${JSON.stringify(city.coverage)}（与城市 json 一致）`,
      info !== null && info !== undefined && info.ok === true && deepEqual(info.coverage, city.coverage) && info.coverageIsOptionalStringArray === true,
      JSON.stringify(city.coverage),
      info === null || info === undefined ? "helper 无结果" : `coverage=${JSON.stringify(info.coverage)}；类型=${info.coverageType}；可选字符串数组=${info.coverageIsOptionalStringArray}`,
    );
  }

  // 0.5 两城 json 除 coverage 外与 git HEAD 深比较一致（places 不变）
  state.gitBaseline = {};
  for (const city of Object.values(CITIES)) {
    const relPath = `data/cities/${city.id}.json`;
    const current = state.cityJson[city.id];
    const head = readGitHeadJson(relPath);
    let result = { ok: false, detail: "git HEAD 不可用" };
    if (head.ok) {
      try {
        const headValue = JSON.parse(head.text);
        const currentValue = current.ok ? current.value : null;
        if (currentValue === null) {
          result = { ok: false, detail: "当前 json 读取失败" };
        } else {
          const currentWithoutCoverage = { ...currentValue };
          delete currentWithoutCoverage.coverage;
          const headWithoutCoverage = { ...headValue };
          delete headWithoutCoverage.coverage;
          const equals = deepEqual(currentWithoutCoverage, headWithoutCoverage);
          const placesEquals = deepEqual(currentValue.places, headValue.places);
          result = {
            ok: equals && placesEquals,
            equals,
            placesEquals,
            placesCount: Array.isArray(currentValue.places) ? currentValue.places.length : null,
            diff: equals ? null : firstDifference(currentWithoutCoverage, headWithoutCoverage, "city"),
            command: head.command,
            detail: `除 coverage 外 deepEqual=${equals}；places deepEqual=${placesEquals}（${Array.isArray(currentValue.places) ? currentValue.places.length : "?"} 条）`,
          };
        }
      } catch (error) {
        result = { ok: false, detail: `git HEAD JSON 解析失败：${messageText(error)}` };
      }
    }
    state.gitBaseline[city.id] = result;
    check(
      state,
      group,
      `0.5-git-${city.id}`,
      `${city.label}城市 json 除 coverage 外与 git HEAD 完全一致（places 未变）`,
      result.ok === true,
      "除 coverage 外 deepEqual；places deepEqual",
      result.detail + (result.diff === null || result.diff === undefined ? "" : `；第一处差异：${result.diff}`),
    );
  }

  // 0.6 红线文件 hash 不变
  const hashProblems = [];
  const hashDetail = [];
  for (const [relPath, expected] of Object.entries(FROZEN_HASHES)) {
    const actual = sha256File(path.join(ROOT_DIR, relPath));
    hashDetail.push(`${relPath}=${actual === null ? "(缺失)" : actual.slice(0, 16)}…`);
    if (actual !== expected) hashProblems.push(`${relPath}=${actual === null ? "(缺失)" : actual}（期望 ${expected}）`);
  }
  state.frozenHashes = hashDetail;
  check(
    state,
    group,
    "0.6-redline-hashes",
    "红线文件 SHA256 与本轮开始前一致（types/schema / planner / fetch-seed / plan route / geocode route / middleware / package*.json）",
    hashProblems.length === 0,
    "8 个红线文件 hash 全部一致",
    hashProblems.length === 0 ? `8/8 一致：${hashDetail.join("；")}` : hashProblems.slice(0, 4).join("；"),
  );

  // 0.8 验收对象 = Lead 冻结版本（实现 hash）
  const implProblems = [];
  const implDetail = [];
  for (const [relPath, expected] of Object.entries(IMPL_FROZEN_HASHES)) {
    const actual = sha256File(path.join(ROOT_DIR, relPath));
    const first = actual === null ? null : actual.toUpperCase().slice(0, 16);
    implDetail.push(`${relPath}=${first ?? "(缺失)"}`);
    if (first !== expected) implProblems.push(`${relPath}=${first ?? "(缺失)"}（期望 ${expected}）`);
  }
  state.implFrozenHashes = implDetail;
  check(
    state,
    group,
    "0.8-impl-frozen",
    "验收对象 = Lead 冻结版本（Onboarding/page/cityData/cities route/两城 json/契约 hash 全部一致）",
    implProblems.length === 0,
    "7 个文件 SHA256 前 16 位与 T9 冻结值一致",
    implProblems.length === 0 ? implDetail.join("；") : implProblems.join("；"),
  );

  // 0.7 上轮 manual 瘦身文件未动
  for (const city of Object.values(CITIES)) {
    const actual = sha256File(path.join(DATA_DIR, `${city.id}.manual.json`));
    check(
      state,
      group,
      `0.7-manual-${city.id}`,
      `${city.label} manual 文件 = 上轮瘦身后的 clean 基线（本轮不动 manual）`,
      actual === MANUAL_CLEAN_SHA[city.id],
      `sha256=${MANUAL_CLEAN_SHA[city.id]}`,
      `sha256=${actual}`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * 浏览器探针表达式
 * ------------------------------------------------------------------ */

const ONBOARDING_STATE_EXPR = String.raw`(() => {
  const onboarding = document.querySelector('[data-testid="onboarding"]');
  const stepEl = document.querySelector('[data-testid="onboarding-step"]');
  const switchBox = document.querySelector('[data-testid="onboarding-city-switch"]');
  const buttons = switchBox === null ? [] : [...switchBox.querySelectorAll('button[data-testid^="onboarding-city-"]')].map((button) => {
    const style = getComputedStyle(button);
    const testId = button.getAttribute("data-testid");
    return {
      testId: testId,
      city: button.getAttribute("data-city") || (testId === null ? "" : testId.replace("onboarding-city-", "")),
      text: (button.textContent || "").trim(),
      ariaPressed: button.getAttribute("aria-pressed"),
      backgroundColor: style.backgroundColor,
      color: style.color,
      borderTopWidth: style.borderTopWidth,
      borderTopStyle: style.borderTopStyle,
      borderTopColor: style.borderTopColor,
    };
  });
  const input = document.querySelector('[data-testid="onboarding-manual-input"]');
  const coverageEl = document.querySelector('[data-testid="onboarding-coverage"]');
  const coverageStyle = coverageEl === null ? null : getComputedStyle(coverageEl);
  const originEl = document.querySelector('[data-testid="onboarding-origin-selected"]');
  const originText = originEl !== null
    ? (originEl.innerText || "").trim()
    : (() => {
        const step = document.querySelector('[data-testid="onboarding-step"]');
        if (step === null) return null;
        const p = [...step.querySelectorAll("p")].find((node) => (node.innerText || "").indexOf("已选起点：") !== -1);
        return p === undefined ? null : (p.innerText || "").trim();
      })();
  const errorEl = document.querySelector('[data-testid="onboarding-origin-error"]');
  const progress = document.querySelector('[data-testid="onboarding-progress"]');
  const back = document.querySelector('[data-testid="onboarding-back"]');
  const continueBtn = document.querySelector('[data-testid="onboarding-continue"]');
  const selected = buttons.find((button) => button.ariaPressed === "true") || null;
  return {
    present: onboarding !== null,
    url: location.href,
    step: stepEl === null ? null : Number(stepEl.getAttribute("data-step")),
    title: stepEl === null ? null : (() => { const h = stepEl.querySelector("h1"); return h === null ? null : (h.textContent || "").trim(); })(),
    switchExists: switchBox !== null,
    buttons: buttons,
    buttonCount: buttons.length,
    selectedTestId: selected === null ? null : selected.testId,
    placeholder: input === null ? null : input.getAttribute("placeholder"),
    manualValue: input === null ? null : input.value,
    coverageExists: coverageEl !== null,
    coverageText: coverageEl === null ? null : (coverageEl.textContent || "").trim(),
    coverageFontSize: coverageStyle === null ? null : coverageStyle.fontSize,
    coverageColor: coverageStyle === null ? null : coverageStyle.color,
    coverageClass: coverageEl === null ? null : String(coverageEl.className),
    originSelectedText: originText,
    originErrorText: errorEl === null ? null : (errorEl.innerText || "").trim(),
    geolocateExists: document.querySelector('[data-testid="onboarding-geolocate"]') !== null,
    backExists: back !== null,
    progressNow: progress === null ? null : Number(progress.getAttribute("aria-valuenow")),
    progressMax: progress === null ? null : Number(progress.getAttribute("aria-valuemax")),
    continueExists: continueBtn !== null,
    continueDisabled: continueBtn === null ? null : continueBtn.disabled === true,
    hasEmoji: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(onboarding === null ? "" : (onboarding.innerText || "")),
    bodyText: (document.body.innerText || "").slice(0, 600),
  };
})()`;

const MAIN_STATE_EXPR = String.raw`(() => {
  const select = document.querySelector('[data-testid="city-select"]');
  const originInput = document.querySelector('[data-testid="origin-address-input"]');
  const alertEl = document.querySelector('[role="alert"]');
  const coverageEl = document.querySelector('[data-testid="failure-coverage"]');
  const coverageStyle = coverageEl === null ? null : getComputedStyle(coverageEl);
  const splash = document.querySelector('[data-splash]');
  const itinerary = document.querySelector('[data-testid="itinerary-header"]');
  return {
    url: location.href,
    onboardingExists: document.querySelector('[data-testid="onboarding"]') !== null,
    splash: splash === null ? null : splash.getAttribute("data-splash"),
    citySelectExists: select !== null,
    citySelectValue: select === null ? null : select.value,
    cityOptions: select === null ? [] : [...select.options].map((option) => ({ value: option.value, text: (option.textContent || "").trim() })),
    originInputExists: originInput !== null,
    originInputValue: originInput === null ? null : originInput.value,
    alertExists: alertEl !== null,
    alertText: alertEl === null ? null : (alertEl.innerText || "").replace(/\s+/g, " ").trim(),
    failureCoverageExists: coverageEl !== null,
    failureCoverageText: coverageEl === null ? null : (coverageEl.textContent || "").trim(),
    failureCoverageFontSize: coverageStyle === null ? null : coverageStyle.fontSize,
    failureCoverageColor: coverageStyle === null ? null : coverageStyle.color,
    failureCoverageClass: coverageEl === null ? null : String(coverageEl.className),
    itineraryExists: itinerary !== null,
    bodyText: (document.body.innerText || "").slice(0, 800),
  };
})()`;

const FETCH_LOG_EXPR = `(() => (window.__fetchLog || []).slice(-80))()`;

function bootScript() {
  return `(() => {
  try {
    window.__fetchLog = [];
    const realFetch = window.fetch.bind(window);
    window.fetch = async function (input, init) {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      const method = (init && init.method) || "GET";
      let body = null;
      try { body = init && init.body ? JSON.parse(String(init.body)) : null; } catch { body = String(init && init.body); }
      const startedAt = Date.now();
      try {
        const response = await realFetch(input, init);
        let text = null;
        try { text = await response.clone().text(); } catch { text = null; }
        window.__fetchLog.push({ url: url, method: method, body: body, status: response.status, text: text === null ? null : text.slice(0, 20000), ms: Date.now() - startedAt });
        return response;
      } catch (error) {
        window.__fetchLog.push({ url: url, method: method, body: body, status: null, error: String(error), ms: Date.now() - startedAt });
        throw error;
      }
    };
  } catch (error) { window.__fetchLogError = String(error); }
})();`;
}

function fakeClockSource(minuteOfDay) {
  const now = new Date();
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  return `(() => {
  const RealDate = Date;
  const fixed = new RealDate(${now.getFullYear()}, ${now.getMonth()}, ${now.getDate()}, ${hour}, ${minute}, 0, 0).getTime();
  window.Date = class extends RealDate {
    constructor(...args) { if (args.length === 0) { super(fixed); } else { super(...args); } }
    static now() { return fixed; }
  };
})();`;
}

/* ------------------------------------------------------------------ *
 * 浏览器交互辅助
 * ------------------------------------------------------------------ */

function exprClickTestId(testId) {
  return `(() => {
    const el = document.querySelector('[data-testid=${JSON.stringify(testId)}]');
    if (el === null) return "not-found";
    if (el.disabled === true) return "disabled";
    el.click();
    return "clicked";
  })()`;
}

/** 输入框：React 受控组件必须用原生 setter + input 事件（合成键盘输入也行，这里用 setter 更稳）。 */
function exprSetInput(testId, value) {
  return `(() => {
    const el = document.querySelector('[data-testid=${JSON.stringify(testId)}]');
    if (el === null) return { ok: false, reason: "not-found" };
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return { ok: true, value: el.value };
  })()`;
}

/** 下拉框：原生 setter + change 事件。 */
function exprSetSelect(testId, value) {
  return `(() => {
    const el = document.querySelector('[data-testid=${JSON.stringify(testId)}]');
    if (el === null) return { ok: false, reason: "not-found" };
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, value: el.value };
  })()`;
}

async function readOnboarding(cdp) {
  return cdp.evaluate(ONBOARDING_STATE_EXPR);
}

async function readMain(cdp) {
  return cdp.evaluate(MAIN_STATE_EXPR);
}

async function readFetchLog(cdp) {
  try {
    return await cdp.evaluate(FETCH_LOG_EXPR);
  } catch {
    return [];
  }
}

async function waitPageReady(cdp, label) {
  await waitForEvaluate(cdp, "document.readyState", (value) => value === "complete", 120000, `${label}：页面加载`, 150);
}

async function waitOnboarding(cdp, label, expectedStep = null, timeoutMs = 90000) {
  await waitForEvaluate(cdp, ONBOARDING_STATE_EXPR, (value) => value !== null && value.present === true, timeoutMs, `${label}：问答渲染`, 150);
  if (expectedStep !== null) {
    await waitForEvaluate(cdp, ONBOARDING_STATE_EXPR, (value) => value !== null && value.step === expectedStep, 30000, `${label}：第 ${expectedStep} 步`, 150);
  }
  const snapshot = await readOnboarding(cdp);
  console.log(`[onboarding] ${label}：step=${snapshot.step}，title=${JSON.stringify(snapshot.title)}`);
  return snapshot;
}

async function waitMain(cdp, label, timeoutMs = 60000) {
  const state = await waitForEvaluate(
    cdp,
    MAIN_STATE_EXPR,
    (value) => value !== null && value.citySelectExists === true && value.onboardingExists === false && value.splash === null,
    timeoutMs,
    `${label}：主页就绪（问答消失、启动页消失）`,
    200,
  );
  console.log(`[main] ${label}：city-select=${state.citySelectValue}`);
  return state;
}

async function navigate(cdp, url, label) {
  await cdp.send("Page.navigate", { url });
  await waitPageReady(cdp, label);
  await sleep(250);
  console.log(`[nav] ${label}：${url.replace(APP, "")}`);
}

async function clickTestId(cdp, testId, label) {
  const result = await cdp.evaluate(exprClickTestId(testId));
  if (result !== "clicked") throw new Error(`${label}：点 ${testId} 失败（${result}）`);
}

async function waitOnboardingStable(cdp, predicate, label, timeoutMs = 10000) {
  return waitForEvaluate(cdp, ONBOARDING_STATE_EXPR, (value) => value !== null && predicate(value), timeoutMs, label, 150);
}

/** 把测试画像写 localStorage（geocode 不可用时的兜底；只改测试数据，不碰产品代码）。 */
async function writeTestProfile(cdp, profile) {
  const result = await cdp.evaluate(`(() => {
    try {
      window.localStorage.setItem(${JSON.stringify(PROFILE_KEY)}, ${JSON.stringify(JSON.stringify(profile))});
      window.localStorage.removeItem(${JSON.stringify(GEO_KEY)});
      return "ok";
    } catch (error) { return "error:" + String(error); }
  })()`);
  if (result !== "ok") throw new Error(`写测试画像失败：${result}`);
  return result;
}

function baseProfile(origin) {
  return {
    style: "rich",
    origin: { lat: origin.lat, lng: origin.lng, label: origin.label },
    homeBy: null,
    scene: "any",
    mealIncluded: true,
    updatedAt: "2026-10-25T00:00:00.000Z",
  };
}

/** 首次进入：清 localStorage → 重新打开 → 第 1 步，再选风格进第 2 步。 */
async function enterFreshOnboarding(cdp, cityId, label) {
  const url = `${APP}/?city=${cityId}`;
  await navigate(cdp, url, `${label}：首次打开`);
  await cdp.evaluate("(() => { try { window.localStorage.clear(); return 'cleared'; } catch (error) { return 'error'; } })()");
  await navigate(cdp, url, `${label}：清 localStorage 后重开`);
  await waitOnboarding(cdp, label, 1);
  await clickTestId(cdp, "onboarding-style-rich", `${label}：第 1 步选 rich`);
  return waitOnboarding(cdp, label, 2);
}

/**
 * 第 2 步手填地址并「解析地址」：
 * 成功返回 { ok:true, step, fetchEntry }；失败返回 { ok:false, error, fetchEntry }（不抛错，由调用方决定兜底）。
 */
async function geocodeFromStep2(cdp, address, label) {
  const before = await readFetchLog(cdp);
  const beforeGeocodeCount = countFetchLog(before, /\/api\/geocode/);
  await cdp.evaluate(exprSetInput("onboarding-manual-input", address));
  await clickTestId(cdp, "onboarding-manual-submit", `${label}：解析地址`);
  let state = null;
  try {
    state = await waitForEvaluate(
      cdp,
      ONBOARDING_STATE_EXPR,
      (value) => value !== null && ((value.step !== null && value.step >= 3) || value.originErrorText !== null),
      40000,
      `${label}：geocode 返回（进入第 3 步或出现错误提示）`,
      250,
    );
  } catch (error) {
    state = await readOnboarding(cdp);
    infoLog(`${label}：geocode 等待超时：${messageText(error)}`);
  }
  const after = await readFetchLog(cdp);
  const geocodeEntries = after.filter((entry) => /\/api\/geocode/.test(String(entry.url ?? "")));
  const fetchEntry = geocodeEntries.length > beforeGeocodeCount ? geocodeEntries[geocodeEntries.length - 1] : null;
  const step = state === null ? null : state.step;
  const errorText = state === null ? null : state.originErrorText;
  const ok = step !== null && step >= 3;
  return { ok, step, error: errorText, fetchEntry, address };
}

/** geocode 失败时的兜底：写测试画像（origin=地址）→ 重开 → 第 1 步 → 第 2 步（已选起点预填）。 */
async function fallbackProfileOriginOnStep2(cdp, city, address, label) {
  await writeTestProfile(cdp, baseProfile({ lat: city.origin.lat, lng: city.origin.lng, label: address }));
  await navigate(cdp, `${APP}/?city=${city.id}`, `${label}：画像兜底重开`);
  await waitOnboarding(cdp, label, 1);
  await clickTestId(cdp, "onboarding-style-rich", `${label}：第 1 步选 rich`);
  const step2 = await waitOnboarding(cdp, `${label}：画像兜底第 2 步`, 2);
  return step2;
}

/** 第 2 步已有起点时点「继续」进入第 3 步。 */
async function continueToStep3(cdp, label) {
  await clickTestId(cdp, "onboarding-continue", `${label}：继续到第 3 步`);
  return waitOnboarding(cdp, `${label}：第 3 步`, 3);
}

/** 第 3/4/5 步固定选择，完成问答回主页。 */
async function finishOnboarding(cdp, label) {
  await clickTestId(cdp, "onboarding-homeby-null", `${label}：第 3 步选不限制`);
  await waitOnboarding(cdp, `${label}：第 4 步`, 4);
  await clickTestId(cdp, "onboarding-scene-any", `${label}：第 4 步选随便走走`);
  await waitOnboarding(cdp, `${label}：第 5 步`, 5);
  await clickTestId(cdp, "onboarding-meal-yes", `${label}：第 5 步选要吃点东西`);
  return waitMain(cdp, `${label}：完成问答`, 60000);
}

function capsuleOf(snapshot, city) {
  return snapshot.buttons.find((button) => button.testId === city.capsuleTestId) ?? null;
}

/**
 * 等胶囊 computed 颜色过渡结束（150ms transition）：aria-pressed 与 computed style 不是同一帧生效。
 * selected=true 要求白底/深色字/1px stone-900 边框；false 要求透明底/stone-500 灰字。
 */
async function waitCapsuleStyles(cdp, testId, selected, label, timeoutMs = 5000) {
  return waitForEvaluate(
    cdp,
    ONBOARDING_STATE_EXPR,
    (value) => {
      if (value === null || value.buttons === undefined) return false;
      const button = value.buttons.find((item) => item.testId === testId);
      if (button === undefined) return false;
      if (selected) {
        return (
          button.ariaPressed === "true" &&
          button.backgroundColor === STYLE.selected.backgroundColor &&
          button.color === STYLE.selected.color &&
          button.borderTopColor === STYLE.selected.borderColor &&
          button.borderTopWidth === STYLE.selected.borderWidth &&
          button.borderTopStyle === STYLE.selected.borderStyle
        );
      }
      return button.ariaPressed === "false" && button.backgroundColor === STYLE.unselected.backgroundColor && button.color === STYLE.unselected.color;
    },
    timeoutMs,
    label,
    80,
  );
}

/* ------------------------------------------------------------------ *
 * 浏览器主阶段（§7.1–§7.4、§7.6、§7.8、§7.9）
 * ------------------------------------------------------------------ */

async function phaseBrowser(state) {
  let launched = null;
  let cdp = null;
  let collector = null;
  try {
    launched = await launchEdge();
    state.browser = { version: launched.version?.Browser ?? "(未知)", cdpPort: launched.port };
    infoLog(`headless Edge 已启动：${state.browser.version}（CDP port=${launched.port}）`);
    const page = await connectPage(launched.port, {
      label: "onboarding-city",
      viewport: VIEWPORT,
      seedProfile: false,
      autoSkipOnboarding: false,
    });
    cdp = page.cdp;
    collector = createConsoleCollector(cdp);
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: bootScript() });
    state.fetchLogAll = [];

    /* ================= §7.1 第 2 步北京布局 ================= */
    const s1 = await enterFreshOnboarding(cdp, "beijing", "1");
    state.s1 = s1;
    check(
      state,
      GROUPS.accept1,
      "1.1",
      "第 2 步标题 = 你的起点在哪？",
      s1.title === "你的起点在哪？",
      "你的起点在哪？",
      JSON.stringify(s1.title),
    );
    check(
      state,
      GROUPS.accept1,
      "1.2",
      "onboarding-city-switch 下恰有 2 个城市胶囊（北京、辽阳，顺序同 /api/cities）",
      s1.switchExists === true && s1.buttonCount === 2 && s1.buttons[0]?.testId === "onboarding-city-beijing" && s1.buttons[1]?.testId === "onboarding-city-liaoyang",
      "2 个胶囊：onboarding-city-beijing、onboarding-city-liaoyang",
      `switchExists=${s1.switchExists}；按钮=${s1.buttons.map((button) => `${button.testId}(aria-pressed=${button.ariaPressed})`).join(", ")}`,
    );
    const s1Beijing = capsuleOf(s1, CITIES.beijing);
    const s1Liaoyang = capsuleOf(s1, CITIES.liaoyang);
    check(
      state,
      GROUPS.accept1,
      "1.3",
      "北京胶囊 aria-pressed=true（默认选中）",
      s1Beijing !== null && s1Beijing.ariaPressed === "true" && s1.selectedTestId === "onboarding-city-beijing",
      'aria-pressed="true"',
      `aria-pressed=${JSON.stringify(s1Beijing?.ariaPressed)}；selected=${s1.selectedTestId}`,
    );
    const beijingStyleOk =
      s1Beijing !== null &&
      s1Beijing.backgroundColor === STYLE.selected.backgroundColor &&
      s1Beijing.color === STYLE.selected.color &&
      s1Beijing.borderTopWidth === STYLE.selected.borderWidth &&
      s1Beijing.borderTopStyle === STYLE.selected.borderStyle &&
      s1Beijing.borderTopColor === STYLE.selected.borderColor;
    check(
      state,
      GROUPS.accept1,
      "1.4",
      "北京胶囊 computed 样式：白底 rgb(255,255,255) + 深色字 rgb(28,25,23) + 1px 边框（borderColor 同 stone-900）",
      beijingStyleOk,
      "background=rgb(255,255,255)；color=rgb(28,25,23)；border=1px solid rgb(28,25,23)",
      s1Beijing === null ? "找不到北京胶囊" : `background=${s1Beijing.backgroundColor}；color=${s1Beijing.color}；border=${s1Beijing.borderTopWidth} ${s1Beijing.borderTopStyle} ${s1Beijing.borderTopColor}`,
    );
    check(
      state,
      GROUPS.accept1,
      "1.5",
      "辽阳胶囊 aria-pressed=false + 透明底 + 灰字 rgb(120,113,108)",
      s1Liaoyang !== null && s1Liaoyang.ariaPressed === "false" && s1Liaoyang.backgroundColor === STYLE.unselected.backgroundColor && s1Liaoyang.color === STYLE.unselected.color,
      `aria-pressed=false；background=${STYLE.unselected.backgroundColor}；color=${STYLE.unselected.color}`,
      s1Liaoyang === null ? "找不到辽阳胶囊" : `aria-pressed=${s1Liaoyang.ariaPressed}；background=${s1Liaoyang.backgroundColor}；color=${s1Liaoyang.color}；border=${s1Liaoyang.borderTopWidth} ${s1Liaoyang.borderTopStyle} ${s1Liaoyang.borderTopColor}`,
    );
    check(
      state,
      GROUPS.accept1,
      "1.6",
      "北京 placeholder = 例如：良乡地铁站",
      s1.placeholder === CITIES.beijing.placeholder,
      CITIES.beijing.placeholder,
      JSON.stringify(s1.placeholder),
    );
    check(
      state,
      GROUPS.accept1,
      "1.7",
      "北京 coverage 灰字 = 现在能规划：良乡 · 长阳 · 顺义城区",
      s1.coverageExists === true && s1.coverageText === CITIES.beijing.coverageText,
      CITIES.beijing.coverageText,
      `exists=${s1.coverageExists}；text=${JSON.stringify(s1.coverageText)}；fontSize=${s1.coverageFontSize}；color=${s1.coverageColor}`,
    );
    check(
      state,
      GROUPS.accept1,
      "1.8",
      "GEOLOCATION_ENABLED=false 环境：无定位按钮；既有元素保留（上一步 / 进度 2/5；无起点时「继续」按既有 canContinue 规则不渲染）",
      s1.geolocateExists === false && s1.backExists === true && s1.progressNow === 2 && s1.progressMax === 5,
      "无 onboarding-geolocate；back 存在；progress=2/5（continue 无起点时按既有 canContinue 规则不渲染）",
      `geolocateExists=${s1.geolocateExists}；back=${s1.backExists}；continue=${s1.continueExists}（disabled=${s1.continueDisabled}）；progress=${s1.progressNow}/${s1.progressMax}`,
    );
    check(state, GROUPS.accept1, "1.9", "第 2 步无 emoji（契约 §6 红线）", s1.hasEmoji === false, "onboarding DOM 内无 emoji", `hasEmoji=${s1.hasEmoji}`);
    const shotBeijing = await safeShot(cdp, state, `${SCREENSHOT_PREFIX}step2-beijing.png`);
    check(state, GROUPS.accept1, "1.10", "第 2 步北京截图 .cache/verify/onboarding-city-step2-beijing.png", shotBeijing !== null, "截图存在", shotBeijing === null ? "截图失败" : rel(shotBeijing.path));

    /* ================= §7.2 点「辽阳」 ================= */
    const fetchBeforeSwitch = await readFetchLog(cdp);
    const citiesRequestsBefore = countFetchLog(fetchBeforeSwitch, /\/api\/cities/);
    const plansBefore = countFetchLog(fetchBeforeSwitch, /\/api\/plan/);
    await clickTestId(cdp, CITIES.liaoyang.capsuleTestId, "2：点辽阳胶囊");
    let s2 = await waitOnboardingStable(
      cdp,
      (value) =>
        value.selectedTestId === "onboarding-city-liaoyang" &&
        value.placeholder === CITIES.liaoyang.placeholder &&
        value.coverageText === CITIES.liaoyang.coverageText &&
        value.url.includes("city=liaoyang"),
      "2：辽阳选中 + placeholder + coverage + URL",
      20000,
    );
    // 胶囊颜色有 150ms transition：aria-pressed 先变，computed backgroundColor/color 滞后十几毫秒；
    // 等过渡结束再读样式（否则会拿到过渡起点的旧颜色，run1 踩过）。
    await waitCapsuleStyles(cdp, CITIES.liaoyang.capsuleTestId, true, "2：辽阳胶囊选中样式到位", 5000);
    await waitCapsuleStyles(cdp, CITIES.beijing.capsuleTestId, false, "2：北京胶囊未选中样式到位", 5000);
    s2 = await readOnboarding(cdp);
    state.s2 = s2;
    const s2Liaoyang = capsuleOf(s2, CITIES.liaoyang);
    const s2Beijing = capsuleOf(s2, CITIES.beijing);
    const liaoyangStyleOk =
      s2Liaoyang !== null &&
      s2Liaoyang.ariaPressed === "true" &&
      s2Liaoyang.backgroundColor === STYLE.selected.backgroundColor &&
      s2Liaoyang.color === STYLE.selected.color &&
      s2Liaoyang.borderTopWidth === STYLE.selected.borderWidth &&
      s2Liaoyang.borderTopStyle === STYLE.selected.borderStyle &&
      s2Liaoyang.borderTopColor === STYLE.selected.borderColor;
    check(
      state,
      GROUPS.accept2,
      "2.1",
      "点辽阳 → 辽阳胶囊 aria-pressed=true + 白底/深色字/1px 边框；北京变 false + 透明底/灰字",
      liaoyangStyleOk && s2Beijing !== null && s2Beijing.ariaPressed === "false" && s2Beijing.backgroundColor === STYLE.unselected.backgroundColor && s2Beijing.color === STYLE.unselected.color,
      "辽阳 selected（白底 rgb(255,255,255)/深色字 rgb(28,25,23)/1px 边框）；北京 unselected（透明底/灰字 rgb(120,113,108)）",
      `辽阳：aria-pressed=${s2Liaoyang?.ariaPressed}，bg=${s2Liaoyang?.backgroundColor}，color=${s2Liaoyang?.color}，border=${s2Liaoyang?.borderTopWidth} ${s2Liaoyang?.borderTopStyle} ${s2Liaoyang?.borderTopColor}；北京：aria-pressed=${s2Beijing?.ariaPressed}，bg=${s2Beijing?.backgroundColor}，color=${s2Beijing?.color}`,
    );
    check(state, GROUPS.accept2, "2.2", "辽阳 placeholder = 例如：白塔区中心路", s2.placeholder === CITIES.liaoyang.placeholder, CITIES.liaoyang.placeholder, JSON.stringify(s2.placeholder));
    check(
      state,
      GROUPS.accept2,
      "2.3",
      "辽阳 coverage = 现在能规划：白塔区 · 文庙 · 太子河沿岸",
      s2.coverageExists === true && s2.coverageText === CITIES.liaoyang.coverageText,
      CITIES.liaoyang.coverageText,
      `text=${JSON.stringify(s2.coverageText)}；fontSize=${s2.coverageFontSize}；color=${s2.coverageColor}`,
    );
    check(
      state,
      GROUPS.accept2,
      "2.4",
      "切城市后 URL ?city=liaoyang",
      /[?&]city=liaoyang(&|$)/.test(new URL(s2.url).search),
      "?city=liaoyang",
      s2.url.replace(APP, ""),
    );
    const fetchAfterSwitch = await readFetchLog(cdp);
    const citiesRequestsAfter = countFetchLog(fetchAfterSwitch, /\/api\/cities/);
    const plansAfter = countFetchLog(fetchAfterSwitch, /\/api\/plan/);
    check(
      state,
      GROUPS.accept2,
      "2.5",
      "点胶囊切城市不影响 /api/cities：请求数不增加；也不提前打 /api/plan",
      citiesRequestsAfter === citiesRequestsBefore && plansAfter === plansBefore,
      `/api/cities 请求数 ${citiesRequestsBefore} 不变；/api/plan 请求数 ${plansBefore} 不变`,
      `/api/cities ${citiesRequestsBefore}→${citiesRequestsAfter}；/api/plan ${plansBefore}→${plansAfter}`,
    );
    await sleep(350);
    const s2Stable = await readOnboarding(cdp);
    check(
      state,
      GROUPS.accept2,
      "2.6",
      "页面 state 稳定：350ms 后仍第 2 步、辽阳选中、placeholder/coverage 不变",
      s2Stable.step === 2 && s2Stable.selectedTestId === "onboarding-city-liaoyang" && s2Stable.placeholder === CITIES.liaoyang.placeholder && s2Stable.coverageText === CITIES.liaoyang.coverageText,
      "step=2；selected=辽阳；placeholder/coverage 不变",
      `step=${s2Stable.step}；selected=${s2Stable.selectedTestId}；placeholder=${JSON.stringify(s2Stable.placeholder)}`,
    );
    const shotLiaoyang = await safeShot(cdp, state, `${SCREENSHOT_PREFIX}step2-liaoyang.png`);
    check(state, GROUPS.accept2, "2.7", "第 2 步辽阳截图 .cache/verify/onboarding-city-step2-liaoyang.png", shotLiaoyang !== null, "截图存在", shotLiaoyang === null ? "截图失败" : rel(shotLiaoyang.path));

    /* ================= §7.3a 未提交输入 → 切城市清空 ================= */
    await clickTestId(cdp, CITIES.beijing.capsuleTestId, "3a：切回北京");
    await waitOnboardingStable(cdp, (value) => value.selectedTestId === "onboarding-city-beijing" && value.placeholder === CITIES.beijing.placeholder, "3a：北京选中", 15000);
    const fillResult = await cdp.evaluate(exprSetInput("onboarding-manual-input", CITIES.beijing.manualAddress));
    check(
      state,
      GROUPS.accept3,
      "3.1",
      "北京第 2 步输入框能填入「良乡地铁站」（不提交）",
      fillResult.ok === true && (await readOnboarding(cdp)).manualValue === CITIES.beijing.manualAddress,
      CITIES.beijing.manualAddress,
      `value=${(await readOnboarding(cdp)).manualValue}`,
    );
    await clickTestId(cdp, CITIES.liaoyang.capsuleTestId, "3a：填了未提交后点辽阳");
    let s3a = null;
    try {
      s3a = await waitOnboardingStable(cdp, (value) => value.selectedTestId === "onboarding-city-liaoyang" && value.manualValue === "", "3a：切辽阳后输入框清空", 8000);
    } catch {
      s3a = await readOnboarding(cdp);
    }
    state.s3a = s3a;
    check(
      state,
      GROUPS.accept3,
      "3.2",
      "未提交的输入框内容在切辽阳后清空（value=\"\"）",
      s3a.manualValue === "",
      'input value=""',
      `value=${JSON.stringify(s3a.manualValue)}`,
    );
    check(
      state,
      GROUPS.accept3,
      "3.3",
      "切城市后「已选起点」卡片不存在、onboarding-origin-error 不存在",
      s3a.originSelectedText === null && s3a.originErrorText === null,
      "无已选起点 / 无错误提示",
      `originSelected=${JSON.stringify(s3a.originSelectedText)}；originError=${JSON.stringify(s3a.originErrorText)}`,
    );

    /* ================= §7.3b 解析地址成功 → 已选起点 → 切城市清空 ================= */
    await clickTestId(cdp, CITIES.beijing.capsuleTestId, "3b：切回北京");
    await waitOnboardingStable(cdp, (value) => value.selectedTestId === "onboarding-city-beijing", "3b：北京选中", 15000);
    const geocodeBeijing = await geocodeFromStep2(cdp, CITIES.beijing.manualAddress, "3b 北京 geocode");
    state.geocodeBeijing = geocodeBeijing;
    let originMethod = "geocode";
    let geocodeErrorText = geocodeBeijing.error;
    let originCardVisible = false;
    if (geocodeBeijing.ok) {
      // 成功后组件自动进第 3 步；回退到第 2 步看「已选起点：良乡地铁站」
      await clickTestId(cdp, "onboarding-back", "3b：回退到第 2 步");
      const step2 = await waitOnboarding(cdp, "3b：回退后第 2 步", 2);
      originCardVisible = typeof step2.originSelectedText === "string" && step2.originSelectedText.indexOf("已选起点：") === 0;
    } else {
      originMethod = "profile-fallback（geocode 失败）";
      const step2 = await fallbackProfileOriginOnStep2(cdp, CITIES.beijing, CITIES.beijing.manualAddress, "3b 画像兜底");
      originCardVisible = typeof step2.originSelectedText === "string" && step2.originSelectedText.indexOf("已选起点：") === 0;
    }
    const originSnapshot = await readOnboarding(cdp);
    check(
      state,
      GROUPS.accept3,
      "3.4",
      `「解析地址」成功路径（或画像兜底）：第 2 步出现「已选起点：${CITIES.beijing.manualAddress}」`,
      originCardVisible && originSnapshot.originSelectedText !== null && originSnapshot.originSelectedText.indexOf(CITIES.beijing.manualAddress) !== -1 && originSnapshot.continueExists === true,
      `已选起点：${CITIES.beijing.manualAddress}（方式=${originMethod}）`,
      `originSelected=${JSON.stringify(originSnapshot.originSelectedText)}；方式=${originMethod}；geocodeError=${JSON.stringify(geocodeErrorText)}；geocode 请求=${JSON.stringify(geocodeBeijing.fetchEntry?.body ?? null)}`,
    );
    const geocodeCityOk = geocodeBeijing.fetchEntry === null || geocodeBeijing.fetchEntry.body?.city === "beijing";
    check(
      state,
      GROUPS.accept3,
      "3.5",
      "手填地址解析请求体带当前城市 city=beijing（契约 §2 / geocode 城市口径）",
      geocodeCityOk,
      "请求体 {address, city:'beijing'}",
      geocodeBeijing.fetchEntry === null ? "没有捕获到 geocode 请求（画像兜底路径）" : `请求体=${JSON.stringify(geocodeBeijing.fetchEntry.body)}；status=${geocodeBeijing.fetchEntry.status}`,
    );
    await clickTestId(cdp, CITIES.liaoyang.capsuleTestId, "3b：解析成功后点辽阳");
    let s3b = null;
    try {
      s3b = await waitOnboardingStable(
        cdp,
        (value) => value.selectedTestId === "onboarding-city-liaoyang" && value.manualValue === "" && value.originSelectedText === null,
        "3b：切辽阳后已选起点 / 输入框清空",
        8000,
      );
    } catch {
      s3b = await readOnboarding(cdp);
    }
    state.s3b = s3b;
    check(
      state,
      GROUPS.accept3,
      "3.6",
      "先解析成功再切辽阳：已选起点卡片消失、输入框空、origin-error 不存在",
      s3b.originSelectedText === null && s3b.manualValue === "" && s3b.originErrorText === null,
      "originSelected=null；input value=\"\"；originError=null",
      `originSelected=${JSON.stringify(s3b.originSelectedText)}；value=${JSON.stringify(s3b.manualValue)}；originError=${JSON.stringify(s3b.originErrorText)}`,
    );

    /* ================= §7.4 选辽阳走完 5 步 → 主页；下拉切北京 → 刷新预选 ================= */
    // 当前：第 2 步辽阳，起点已被清空；重新解析辽阳地址（失败则画像兜底）→ 第 3 步
    const geocodeLiaoyang = await geocodeFromStep2(cdp, CITIES.liaoyang.manualAddress, "4 辽阳 geocode");
    state.geocodeLiaoyang = geocodeLiaoyang;
    let stepAfterOrigin = null;
    let originMethod4 = "geocode";
    if (geocodeLiaoyang.ok) {
      stepAfterOrigin = await waitOnboarding(cdp, "4：辽阳起点解析成功第 3 步", 3);
      originMethod4 = "geocode";
    } else {
      const step2 = await fallbackProfileOriginOnStep2(cdp, CITIES.liaoyang, CITIES.liaoyang.manualAddress, "4 辽阳画像兜底");
      if (step2.originSelectedText === null) {
        check(state, GROUPS.accept4, "4.0", "辽阳起点已就绪（geocode 或画像兜底）", false, "第 2 步出现已选起点", "qa geocode 与画像兜底都没拿到起点");
      }
      stepAfterOrigin = await continueToStep3(cdp, "4：画像兜底继续到第 3 步");
      originMethod4 = "profile-fallback（geocode 失败）";
    }
    const mainAfterLiaoyang = await finishOnboarding(cdp, "4 完成问答（辽阳）");
    state.mainAfterLiaoyang = mainAfterLiaoyang;
    check(
      state,
      GROUPS.accept4,
      "4.1",
      "问答里选辽阳并走完 5 步 → 主页 city-select value=liaoyang",
      mainAfterLiaoyang.citySelectValue === "liaoyang" && mainAfterLiaoyang.itineraryExists === false,
      "city-select=liaoyang",
      `city-select=${JSON.stringify(mainAfterLiaoyang.citySelectValue)}；options=${JSON.stringify(mainAfterLiaoyang.cityOptions)}；起点方式=${originMethod4}`,
    );
    await safeShot(cdp, state, `${SCREENSHOT_PREFIX}main-after-liaoyang.png`);

    // 主页「更多选项」手填起点：切城市后必须保留（主页下拉切城市不清手填起点）
    const manualMainOrigin = "主页手填起点-城切测试";
    const setOrigin = await cdp.evaluate(exprSetInput("origin-address-input", manualMainOrigin));
    const mainBeforeSwitch = await readMain(cdp);
    check(
      state,
      GROUPS.accept4,
      "4.2",
      "主页「更多选项」起点输入可写入（用于验证下拉切城市不清手填起点）",
      setOrigin.ok === true && mainBeforeSwitch.originInputValue === manualMainOrigin,
      manualMainOrigin,
      `value=${JSON.stringify(mainBeforeSwitch.originInputValue)}`,
    );
    const switchMain = await cdp.evaluate(exprSetSelect("city-select", "beijing"));
    let mainAfterSwitch = null;
    try {
      mainAfterSwitch = await waitForEvaluate(
        cdp,
        MAIN_STATE_EXPR,
        (value) => value !== null && value.citySelectValue === "beijing" && value.url.includes("city=beijing"),
        20000,
        "4：主页城市下拉切北京",
        200,
      );
    } catch {
      mainAfterSwitch = await readMain(cdp);
    }
    state.mainAfterSwitch = mainAfterSwitch;
    check(
      state,
      GROUPS.accept4,
      "4.3",
      "主页城市下拉切北京：city-select=beijing、URL ?city=beijing",
      switchMain.ok === true && mainAfterSwitch.citySelectValue === "beijing" && mainAfterSwitch.url.includes("city=beijing"),
      "city-select=beijing；?city=beijing",
      `select=${JSON.stringify(mainAfterSwitch.citySelectValue)}；url=${mainAfterSwitch.url.replace(APP, "")}`,
    );
    check(
      state,
      GROUPS.accept4,
      "4.4",
      "主页下拉切城市不清手填起点：origin-address-input 值保持「主页手填起点-城切测试」",
      mainAfterSwitch.originInputValue === manualMainOrigin,
      manualMainOrigin,
      `value=${JSON.stringify(mainAfterSwitch.originInputValue)}`,
    );

    // 刷新 → 问答第 2 步预选北京（新城市）
    await navigate(cdp, `${APP}/?city=beijing`, "4：刷新验证预选");
    await waitOnboarding(cdp, "4：刷新后问答", 1);
    await clickTestId(cdp, "onboarding-style-rich", "4：刷新后第 1 步选 rich");
    const s4 = await waitOnboarding(cdp, "4：刷新后第 2 步", 2);
    state.s4 = s4;
    const s4Beijing = capsuleOf(s4, CITIES.beijing);
    const s4Liaoyang = capsuleOf(s4, CITIES.liaoyang);
    check(
      state,
      GROUPS.accept4,
      "4.5",
      "刷新后问答第 2 步：北京胶囊 aria-pressed=true（预选新城市），辽阳 false",
      s4Beijing !== null && s4Beijing.ariaPressed === "true" && s4.selectedTestId === "onboarding-city-beijing" && s4Liaoyang !== null && s4Liaoyang.ariaPressed === "false",
      "北京 selected、辽阳 unselected",
      `selected=${s4.selectedTestId}；北京=${s4Beijing?.ariaPressed}；辽阳=${s4Liaoyang?.ariaPressed}；URL=${s4.url.replace(APP, "")}`,
    );
    check(
      state,
      GROUPS.accept4,
      "4.6",
      "刷新后第 2 步北京 placeholder / coverage 与城市一致",
      s4.placeholder === CITIES.beijing.placeholder && s4.coverageText === CITIES.beijing.coverageText,
      `${CITIES.beijing.placeholder}；${CITIES.beijing.coverageText}`,
      `placeholder=${JSON.stringify(s4.placeholder)}；coverage=${JSON.stringify(s4.coverageText)}`,
    );
    await safeShot(cdp, state, `${SCREENSHOT_PREFIX}step2-beijing-after-refresh.png`);

    /* ================= §7.6 失败提示带 coverage ================= */
    // 当前：第 2 步北京；起点填「五道口站」→ 走完 5 步 → 主页「现在就走」→ 失败 alert + coverage
    const failureGeocode = await geocodeFromStep2(cdp, FAILURE_ADDRESS, "6 五道口站 geocode");
    state.failureGeocode = failureGeocode;
    let failureOriginMethod = "geocode";
    if (failureGeocode.ok) {
      await waitOnboarding(cdp, "6：第 3 步", 3);
    } else {
      await fallbackProfileOriginOnStep2(cdp, CITIES.beijing, FAILURE_ADDRESS, "6 画像兜底");
      await continueToStep3(cdp, "6：画像兜底继续到第 3 步");
      failureOriginMethod = "profile-fallback（geocode 失败）";
    }
    const mainForFailure = await finishOnboarding(cdp, "6 完成问答（五道口站）");
    state.mainForFailure = mainForFailure;
    check(
      state,
      GROUPS.accept6,
      "6.1",
      `北京起点「${FAILURE_ADDRESS}」走完问答 → 主页（city-select=beijing）`,
      mainForFailure.citySelectValue === "beijing" && mainForFailure.onboardingExists === false,
      "city-select=beijing；问答已结束",
      `city-select=${JSON.stringify(mainForFailure.citySelectValue)}；起点方式=${failureOriginMethod}；geocode=${JSON.stringify(failureGeocode.error ?? "ok")}`,
    );

    const clickNow = await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find((el) => (el.textContent || '').trim() === "现在就走");
      if (button === undefined) return "not-found";
      if (button.disabled === true) return "disabled";
      button.click();
      return "clicked";
    })()`);
    check(
      state,
      GROUPS.accept6,
      "6.2",
      "主页点「现在就走」",
      clickNow === "clicked",
      "clicked",
      String(clickNow),
    );
    let failureMain = null;
    try {
      failureMain = await waitForEvaluate(
        cdp,
        MAIN_STATE_EXPR,
        (value) => value !== null && value.failureCoverageExists === true && value.alertExists === true,
        90000,
        "6：排不出来失败提示 + failure-coverage",
        250,
      );
    } catch {
      failureMain = await readMain(cdp);
    }
    state.failureMain = failureMain;
    let failureMethod = "实时钟";
    if (failureMain.failureCoverageExists !== true) {
      // 实时钟排得出来（成功）→ 用 fake clock 23:50 强制失败场景（只用于验收 §7.6，报告注明）
      failureMethod = "fake clock 23:50（实时钟未触发失败）";
      infoLog(`实时钟点击「现在就走」没有出现失败提示（itinerary=${failureMain.itineraryExists}），改用 fake clock 23:50 强制失败场景`);
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: fakeClockSource(FIXED_FAILURE_MINUTE) });
      await navigate(cdp, `${APP}/?city=beijing`, "6：fake clock 强制失败");
      await waitOnboarding(cdp, "6：fake clock 问答", 1);
      await clickTestId(cdp, "onboarding-skip", "6：点跳过");
      const mainFake = await waitMain(cdp, "6：fake clock 主页", 60000);
      state.mainFakeClock = mainFake;
      const clickNowFake = await cdp.evaluate(`(() => {
        const button = [...document.querySelectorAll('button')].find((el) => (el.textContent || '').trim() === "现在就走");
        if (button === undefined) return "not-found";
        if (button.disabled === true) return "disabled";
        button.click();
        return "clicked";
      })()`);
      check(state, GROUPS.accept6, "6.2b", "fake clock 23:50 下点「现在就走」", clickNowFake === "clicked", "clicked", String(clickNowFake));
      try {
        failureMain = await waitForEvaluate(
          cdp,
          MAIN_STATE_EXPR,
          (value) => value !== null && value.failureCoverageExists === true && value.alertExists === true,
          120000,
          "6：fake clock 23:50 失败提示 + failure-coverage",
          250,
        );
      } catch {
        failureMain = await readMain(cdp);
      }
      state.failureMain = failureMain;
    }
    check(
      state,
      GROUPS.accept6,
      "6.3",
      "排不出来时出现 role=alert 失败提示，且提示里含 failure-coverage 行",
      failureMain.alertExists === true && failureMain.failureCoverageExists === true,
      "role=alert 存在 + data-testid=failure-coverage 存在",
      `alertExists=${failureMain.alertExists}；failureCoverageExists=${failureMain.failureCoverageExists}；方式=${failureMethod}；alertText=${JSON.stringify(truncate(failureMain.alertText, 300))}`,
    );
    check(
      state,
      GROUPS.accept6,
      "6.4",
      `failure-coverage 文案 = 现在能规划：良乡 · 长阳 · 顺义城区`,
      failureMain.failureCoverageText === FAILURE_COVERAGE_TEXT && typeof failureMain.alertText === "string" && failureMain.alertText.includes(FAILURE_COVERAGE_TEXT),
      FAILURE_COVERAGE_TEXT,
      `failure-coverage=${JSON.stringify(failureMain.failureCoverageText)}`,
    );
    const failureCoverageStyleOk =
      failureMain.failureCoverageFontSize === "12px" &&
      failureMain.failureCoverageColor === "rgb(120, 113, 108)" &&
      typeof failureMain.failureCoverageClass === "string" &&
      failureMain.failureCoverageClass.includes("text-xs") &&
      failureMain.failureCoverageClass.includes("text-stone-500");
    check(
      state,
      GROUPS.accept6,
      "6.5",
      "failure-coverage 是 text-xs text-stone-500 灰字（computed 12px / rgb(120,113,108)）",
      failureCoverageStyleOk,
      "font-size=12px；color=rgb(120,113,108)；class 含 text-xs text-stone-500",
      `fontSize=${failureMain.failureCoverageFontSize}；color=${failureMain.failureCoverageColor}；class=${truncate(failureMain.failureCoverageClass, 200)}`,
    );
    const shotFailure = await safeShot(cdp, state, `${SCREENSHOT_PREFIX}failure-coverage.png`);
    check(state, GROUPS.accept6, "6.6", "主页失败提示（含 coverage）截图 .cache/verify/onboarding-city-failure-coverage.png", shotFailure !== null, "截图存在", shotFailure === null ? "截图失败" : rel(shotFailure.path));

    /* ================= §7.11 切城市 + 选起点 + 真正排一次（M1） ================= */
    // M1 复现：北京 → 问答里点辽阳（触发 changeCityTo / forcedCityOrigin）→ 页内解析辽阳地址成功
    // → 直接走完 5 步 → 主页「现在就走」；抓 /api/plan 请求体：不得带 latitude/longitude、
    // profile.origin.label = 刚选的地址（bug 版本会把新城市 origin 兜底坐标发出去盖掉 profile.origin）。
    await enterFreshOnboarding(cdp, "beijing", "11 M1");
    await clickTestId(cdp, CITIES.liaoyang.capsuleTestId, "11：问答里点辽阳（触发切城市）");
    await waitOnboardingStable(
      cdp,
      (value) => value.selectedTestId === "onboarding-city-liaoyang" && value.url.includes("city=liaoyang"),
      "11：切到辽阳",
      20000,
    );
    const m1Addresses = ["白塔区中心路", "辽阳大剧院"];
    let m1Geocode = null;
    for (const address of m1Addresses) {
      const attempt = await geocodeFromStep2(cdp, address, `11 辽阳 geocode（${address}）`);
      m1Geocode = attempt;
      if (attempt.ok) break;
    }
    state.m1Geocode = m1Geocode;
    const m1OriginOk = m1Geocode !== null && m1Geocode.ok === true;
    check(
      state,
      GROUPS.accept11,
      "11.1",
      "问答里（北京）点辽阳 → 页内解析辽阳地址成功进入第 3 步（M1 复现路径）",
      m1OriginOk,
      "页内解析成功（不走刷新画像兜底，否则 forcedCityOrigin 已被重置、M1 不可复现）",
      m1Geocode === null ? "geocode 未执行" : `地址=${m1Geocode.address}；step=${m1Geocode.step}；error=${JSON.stringify(m1Geocode.error)}；请求=${JSON.stringify(m1Geocode.fetchEntry?.body ?? null)}`,
    );
    if (!m1OriginOk) {
      for (const id of ["11.2", "11.3", "11.4", "11.5", "11.6"]) {
        skipCheck(state, GROUPS.accept11, id, `§7.11 断言 ${id}`, `页内 geocode 没成功（无法复现 M1 场景）：${m1Geocode?.error ?? "未知"}；没有用刷新画像兜底避免假绿`);
      }
      skipCheck(state, GROUPS.accept11, "11.7", "§7.11 /api/plan 响应 ok=true（可选）", "geocode 未成功，未进入主页排程");
    } else {
      const planEntriesBefore = await readFetchLog(cdp);
      const planCountBefore = countFetchLog(planEntriesBefore, /\/api\/plan/);
      const m1Main = await finishOnboarding(cdp, "11 M1 完成问答");
      state.m1Main = m1Main;
      check(
        state,
        GROUPS.accept11,
        "11.2",
        "走完 5 步到主页（city-select=liaoyang）",
        m1Main.citySelectValue === "liaoyang" && m1Main.onboardingExists === false,
        "city-select=liaoyang；问答已结束",
        `city-select=${JSON.stringify(m1Main.citySelectValue)}；splash=${JSON.stringify(m1Main.splash)}`,
      );
      const clickNowM1 = await cdp.evaluate(`(() => {
        const button = [...document.querySelectorAll('button')].find((el) => (el.textContent || '').trim() === "现在就走");
        if (button === undefined) return "not-found";
        if (button.disabled === true) return "disabled";
        button.click();
        return "clicked";
      })()`);
      check(state, GROUPS.accept11, "11.3", "主页点「现在就走」", clickNowM1 === "clicked", "clicked", String(clickNowM1));
      let planEntry = null;
      try {
        const planLog = await waitForEvaluate(
          cdp,
          FETCH_LOG_EXPR,
          (value) => {
            if (!Array.isArray(value)) return false;
            const entries = value.filter((entry) => /\/api\/plan/.test(String(entry.url ?? "")));
            // 必须出现「本次点击新产生」的 /api/plan 请求，不能拿 §7.6 的旧请求冒充。
            return entries.length > planCountBefore && entries.some((entry) => entry.body !== null && entry.body !== undefined);
          },
          120000,
          "11：捕获 POST /api/plan 请求体",
          200,
        );
        const planEntries = (Array.isArray(planLog) ? planLog : []).filter((entry) => /\/api\/plan/.test(String(entry.url ?? "")));
        planEntry = planEntries.length > planCountBefore ? planEntries[planEntries.length - 1] : null;
      } catch (error) {
        infoLog(`11：等待 /api/plan 请求超时：${messageText(error)}`);
        const log = await readFetchLog(cdp);
        const planEntries = (Array.isArray(log) ? log : []).filter((entry) => /\/api\/plan/.test(String(entry.url ?? "")));
        planEntry = planEntries.length > planCountBefore ? planEntries[planEntries.length - 1] : null;
      }
      state.m1PlanEntry = planEntry;
      check(
        state,
        GROUPS.accept11,
        "11.4",
        "捕获 POST /api/plan 请求（含 body）",
        planEntry !== null && planEntry.body !== null && planEntry.body !== undefined,
        "有 /api/plan 请求 + JSON body",
        planEntry === null ? "没有捕获到 /api/plan 请求" : `status=${planEntry.status}；method=${planEntry.method}；body=${truncate(JSON.stringify(planEntry.body), 600)}`,
      );
      const body = planEntry === null ? null : planEntry.body;
      const hasLatitude = body !== null && body !== undefined && Object.prototype.hasOwnProperty.call(body, "latitude");
      const hasLongitude = body !== null && body !== undefined && Object.prototype.hasOwnProperty.call(body, "longitude");
      check(
        state,
        GROUPS.accept11,
        "11.5",
        "POST /api/plan 请求体不得带 latitude / longitude（M1 修复核心断言）",
        body !== null && body !== undefined && hasLatitude === false && hasLongitude === false,
        "body 无 latitude / longitude 字段（坐标只用于定位 / 跨城兜底）",
        body === null || body === undefined ? "没有请求体" : `body keys=${Object.keys(body).join(",")}；latitude=${JSON.stringify(body.latitude)}；longitude=${JSON.stringify(body.longitude)}`,
      );
      const profileLabel = body === null || body === undefined || body.profile === null || body.profile === undefined ? null : body.profile.origin?.label ?? null;
      const profileHasCoords = body !== null && body !== undefined && body.profile?.origin !== null && body.profile?.origin !== undefined && typeof body.profile.origin.lat === "number" && typeof body.profile.origin.lng === "number";
      check(
        state,
        GROUPS.accept11,
        "11.6",
        "请求体 profile.origin.label = 问答里选的起点地址（服务端用 profile.origin 当起点，不是城市中心）",
        profileLabel !== null && String(profileLabel) === String(m1Geocode.address) && profileHasCoords,
        `profile.origin.label=${JSON.stringify(m1Geocode.address)}（且带 lat/lng）`,
        `profile.origin=${JSON.stringify(body === null || body === undefined ? null : body.profile?.origin ?? null)}`,
      );
      const responseJson = planEntry === null || typeof planEntry.text !== "string" ? null : (() => {
        try {
          return JSON.parse(planEntry.text);
        } catch {
          return null;
        }
      })();
      state.m1PlanResponse = responseJson;
      // /api/plan 成功时直接返回整份 Itinerary（startAt/stops/...）；失败返回 {ok:false,reason}。
      const planSucceeded = responseJson !== null && (responseJson.ok === true || (Array.isArray(responseJson.stops) && responseJson.stops.length > 0 && typeof responseJson.startAt === "number"));
      if (responseJson === null) {
        skipCheck(state, GROUPS.accept11, "11.7", "§7.11 /api/plan 响应 = 完整 Itinerary（能正常排出来，可选）", "响应正文缺失 / 截断无法解析（契约只要求请求体断言）");
      } else if (planSucceeded) {
        check(
          state,
          GROUPS.accept11,
          "11.7",
          "§7.11 /api/plan 响应 = 完整 Itinerary（ok=true / stops>0，起点来自 profile.origin）",
          true,
          "返回 Itinerary（stops>0、startAt 为数字；实时钟允许排不出来时按 SKIP 处理）",
          `stops=${Array.isArray(responseJson.stops) ? responseJson.stops.length : "?"}；startAt=${JSON.stringify(responseJson.startAt)}；首站=${JSON.stringify(responseJson.stops?.[0]?.placeName ?? responseJson.stops?.[0]?.placeId ?? null)}；totalMin=${JSON.stringify(responseJson.totalMin)}`,
        );
      } else if (responseJson.ok === false) {
        skipCheck(
          state,
          GROUPS.accept11,
          "11.7",
          "§7.11 /api/plan 响应 = 完整 Itinerary（能正常排出来，可选）",
          `实时钟排不出来（ok:false，契约只要求请求体断言）：${truncate(responseJson.reason ?? "", 220)}`,
        );
      } else {
        skipCheck(state, GROUPS.accept11, "11.7", "§7.11 /api/plan 响应 = 完整 Itinerary（能正常排出来，可选）", `响应形状不符合预期：${truncate(JSON.stringify(responseJson), 220)}`);
      }
      await safeShot(cdp, state, `${SCREENSHOT_PREFIX}m1-plan-origin.png`);
    }

    /* ================= §7.8 控制台 / emoji ================= */
    state.fetchLogAll = await readFetchLog(cdp);
    const rawErrors = collector.errors.slice();
    const filtered = rawErrors.filter((line) => !CONSOLE_NOISE.test(String(line)));
    state.console = { rawCount: rawErrors.length, filtered: filtered.slice(0, 20), warningsCount: collector.warnings.length, warningsSample: collector.warnings.slice(0, 5) };
    check(
      state,
      GROUPS.console,
      "8.1",
      "全流程控制台无 error（AMap 资源类噪声按既有口径过滤）",
      filtered.length === 0,
      `过滤后 0 条（原始 ${rawErrors.length} 条；warnings ${collector.warnings.length} 条）`,
      filtered.length === 0 ? `0 条；warnings=${collector.warnings.length}` : `${filtered.length} 条：${filtered.slice(0, 5).join(" ｜ ")}`,
    );
    const emojiScan = scanSourceEmoji();
    check(
      state,
      GROUPS.console,
      "8.2",
      "本轮改动源码无 emoji 图标（components/Onboarding.tsx、app/page.tsx）",
      emojiScan.problems.length === 0,
      "两个文件文本内无 emoji",
      emojiScan.problems.length === 0 ? "0 处 emoji" : emojiScan.problems.slice(0, 5).join("；"),
    );
  } finally {
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

/** 扫描本轮改动源码里的 emoji（§6 红线「无 emoji 图标」）。 */
function scanSourceEmoji() {
  const emojiPattern = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F900}-\u{1F9FF}]/u;
  const files = ["components/Onboarding.tsx", "app/page.tsx"];
  const problems = [];
  for (const relPath of files) {
    const text = readText(path.join(ROOT_DIR, relPath));
    if (text === null) {
      problems.push(`${relPath} 读取失败`);
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (emojiPattern.test(lines[index])) problems.push(`${relPath}:${index + 1} ${truncate(lines[index].trim(), 120)}`);
    }
  }
  return { problems };
}

/* ------------------------------------------------------------------ *
 * 回归阶段（§7.7）
 * ------------------------------------------------------------------ */

function parseSummaryLine(text) {
  const matches = [...String(text).matchAll(/PASS (\d+) \/ FAIL (\d+) \/ SKIP (\d+)/g)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1];
  return { pass: Number(last[1]), fail: Number(last[2]), skip: Number(last[3]), summaryLine: last[0] };
}

function backupAdminMapArtifacts() {
  const backupDir = path.join(CACHE_DIR, "onboarding-city-admin-map-backup");
  try {
    if (existsSync(backupDir)) rmSync(backupDir, { recursive: true, force: true });
    mkdirSync(backupDir, { recursive: true });
    const saved = [];
    for (const name of ["acceptance.md", "acceptance.json"]) {
      const source = path.join(ROOT_DIR, "build", "reports", "admin-map", name);
      if (existsSync(source)) {
        writeFileSync(path.join(backupDir, name), readFileSync(source));
        saved.push(name);
      }
    }
    for (const name of readdirSync(CACHE_DIR)) {
      if (!/^admin-map-.*\.png$/.test(name)) continue;
      writeFileSync(path.join(backupDir, name), readFileSync(path.join(CACHE_DIR, name)));
      saved.push(name);
    }
    return saved;
  } catch (error) {
    infoLog(`备份上一轮地图验收产物失败：${messageText(error)}`);
    return [];
  }
}

function restoreAdminMapArtifacts(saved) {
  const backupDir = path.join(CACHE_DIR, "onboarding-city-admin-map-backup");
  const restored = [];
  try {
    for (const name of saved) {
      const source = path.join(backupDir, name);
      if (!existsSync(source)) continue;
      const destination = /^admin-map-.*\.png$/.test(name) ? path.join(CACHE_DIR, name) : path.join(ROOT_DIR, "build", "reports", "admin-map", name);
      writeFileSync(destination, readFileSync(source));
      restored.push(name);
    }
  } catch (error) {
    infoLog(`恢复上一轮地图验收产物失败：${messageText(error)}`);
  }
  return restored;
}

function phaseRegressions(state) {
  const group = GROUPS.regression;

  // 7.1 onboarding-always-acceptance（本轮标题改动的失效断言允许改一处并在报告注明；脚本不自动改，失败时给证据）
  const onboardingAlways = runCommand(state, "onboarding-always-acceptance", "node build/verify/onboarding-always-acceptance.mjs", { timeoutMs: 20 * 60 * 1000, env: { ...process.env, VERIFY_APP_URL: APP } });
  const onboardingAlwaysSummary = parseSummaryLine(onboardingAlways.output);
  state.onboardingAlways = { command: onboardingAlways.command, exitCode: onboardingAlways.status, summary: onboardingAlwaysSummary, logPath: rel(onboardingAlways.logPath) };
  check(
    state,
    group,
    "7.1-onboarding-always",
    "回归 node build/verify/onboarding-always-acceptance.mjs 仍 PASS（FAIL 0）",
    onboardingAlways.status === 0 && onboardingAlwaysSummary !== null && onboardingAlwaysSummary.fail === 0,
    "exit 0；FAIL 0",
    onboardingAlwaysSummary === null
      ? `exit=${onboardingAlways.status}；未匹配到汇总行；输出尾：${onboardingAlways.output.trim().split(/\r?\n/).slice(-6).join(" | ")}`
      : `exit=${onboardingAlways.status}；PASS ${onboardingAlwaysSummary.pass} / FAIL ${onboardingAlwaysSummary.fail} / SKIP ${onboardingAlwaysSummary.skip}；日志=${rel(onboardingAlways.logPath)}`,
  );
  if (onboardingAlways.status !== 0) {
    const legacyTitle = /从哪儿出发|你的起点在哪/.test(onboardingAlways.output);
    infoLog(`onboarding-always 回归失败${legacyTitle ? "（输出含旧/新标题字样，可能是标题改动导致的失效断言）" : ""}；详见 ${rel(onboardingAlways.logPath)}`);
  }

  // 7.2 check:city 基线 13 通过 / 1 失败
  const checkCity = runCommand(state, "check-city", "npm run check:city", { timeoutMs: 180000 });
  const summaryMatch = /结果：FAIL（(\d+) 项失败，(\d+) 项通过）/.exec(checkCity.output);
  const detailIndex = checkCity.output.indexOf("失败明细：");
  const detailLines = detailIndex === -1
    ? []
    : checkCity.output
        .slice(detailIndex + "失败明细：".length)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("- "));
  const uniqueFailureTexts = [...new Set(detailLines)];
  const actualFailCount = summaryMatch === null ? null : Number(summaryMatch[1]);
  const actualPassCount = summaryMatch === null ? null : Number(summaryMatch[2]);
  const checkCityOk =
    actualFailCount === CHECK_CITY_BASELINE.failCount &&
    actualPassCount === CHECK_CITY_BASELINE.passCount &&
    uniqueFailureTexts.length === 1 &&
    uniqueFailureTexts[0].includes(CHECK_CITY_BASELINE.failText);
  check(
    state,
    group,
    "7.2-check-city",
    "npm run check:city 与基线一致（13 通过 / 1 失败：hangzhou.json、liaoyang.events.json 未登记，本轮之前就存在）",
    checkCity.status === 1 && checkCityOk,
    `${CHECK_CITY_BASELINE.passCount} 通过 / ${CHECK_CITY_BASELINE.failCount} 失败；唯一失败项="${CHECK_CITY_BASELINE.failText}"`,
    summaryMatch === null
      ? `exit=${checkCity.status}；未匹配到结果行；输出尾：${checkCity.output.trim().split(/\r?\n/).slice(-5).join(" | ")}`
      : `${actualPassCount} 通过 / ${actualFailCount} 失败；失败明细去重=${JSON.stringify(uniqueFailureTexts)}；exit=${checkCity.status}`,
  );

  // 7.3 上一轮地图验收（只读 3000；报告/截图先备份，跑完恢复）
  const savedArtifacts = backupAdminMapArtifacts();
  try {
    const adminMap = runCommand(state, "admin-map-acceptance", "node scripts/verify/admin-map-acceptance.mjs", { timeoutMs: 15 * 60 * 1000, env: { ...process.env, VERIFY_BASE_URL: APP } });
    const adminMapSummary = parseSummaryLine(adminMap.output);
    state.adminMapRegression = { command: adminMap.command, exitCode: adminMap.status, summary: adminMapSummary, logPath: rel(adminMap.logPath) };
    check(
      state,
      group,
      "7.3-admin-map",
      "上一轮地图验收 scripts/verify/admin-map-acceptance.mjs 仍 PASS（FAIL 0、PASS 90、SKIP 1 headless wheel 已知项）",
      adminMap.status === 0 && adminMapSummary !== null && adminMapSummary.fail === 0 && adminMapSummary.pass === 90 && adminMapSummary.skip === 1,
      "exit 0；FAIL 0；PASS 90；SKIP 1",
      adminMapSummary === null
        ? `exit=${adminMap.status}；未匹配到汇总行；输出尾：${adminMap.output.trim().split(/\r?\n/).slice(-6).join(" | ")}`
        : `exit=${adminMap.status}；PASS ${adminMapSummary.pass} / FAIL ${adminMapSummary.fail} / SKIP ${adminMapSummary.skip}；日志=${rel(adminMap.logPath)}`,
    );
  } finally {
    const restored = restoreAdminMapArtifacts(savedArtifacts);
    if (restored.length > 0) infoLog(`已恢复上一轮地图验收产物 ${restored.length} 个文件`);
  }

  // 7.4 tsc
  const tsc = runCommand(state, "tsc", "npx tsc --noEmit", { timeoutMs: 300000 });
  const tscHasError = /(^|\n)\s*error TS\d+/i.test(tsc.output);
  check(
    state,
    group,
    "7.4-tsc",
    "npx tsc --noEmit = 0 error",
    tsc.status === 0 && !tscHasError,
    "exit 0 且无 error TS",
    `exit=${tsc.status}；error TS 命中=${tscHasError}；输出尾：${tsc.output.trim().split(/\r?\n/).slice(-3).join(" | ")}；日志=${rel(tsc.logPath)}`,
  );

  // 7.5 lint
  const lint = runCommand(state, "lint", "npm run lint", { timeoutMs: 300000 });
  const lintClean =
    lint.status === 0 &&
    !/Error:/i.test(lint.output) &&
    (!/warning/i.test(lint.output) || /No ESLint warnings or errors/i.test(lint.output));
  check(
    state,
    group,
    "7.5-lint",
    "npm run lint = 0 warning / 0 error",
    lintClean,
    "exit 0 + 无 warning/error",
    `exit=${lint.status}；输出尾：${lint.output.trim().split(/\r?\n/).slice(-4).join(" | ")}；日志=${rel(lint.logPath)}`,
  );
}

/* ------------------------------------------------------------------ *
 * 报告
 * ------------------------------------------------------------------ */

function summaryFromChecks(state) {
  const pass = state.checks.filter((item) => item.status === "PASS").length;
  const fail = state.checks.filter((item) => item.status === "FAIL").length;
  const skip = state.checks.filter((item) => item.status === "SKIP").length;
  return { pass, fail, skip, total: state.checks.length };
}

function buildOverview(state) {
  const mapping = [
    { key: "1", title: "第 2 步布局：标题/胶囊/选中样式/placeholder/coverage", group: GROUPS.accept1 },
    { key: "2", title: "切辽阳：胶囊选中/placeholder/coverage/URL/请求稳定", group: GROUPS.accept2 },
    { key: "3", title: "切城市清空未提交输入 + 已选起点", group: GROUPS.accept3 },
    { key: "4", title: "走完 5 步→主页城市；下拉切城市；刷新预选", group: GROUPS.accept4 },
    { key: "5", title: "coverage 数据/API/红线/manual 不变（只读）", group: GROUPS.env },
    { key: "6", title: "失败提示 role=alert + failure-coverage", group: GROUPS.accept6 },
    { key: "11", title: "切城市+选起点+真正排一次（M1：/api/plan 不带 latitude/longitude、profile.origin.label 正确）", group: GROUPS.accept11 },
    { key: "7", title: "回归：onboarding-always / check:city / admin-map / tsc / lint", group: GROUPS.regression },
    { key: "8", title: "控制台无 error + 无 emoji", group: GROUPS.console },
    { key: "9", title: "1280×900 截图（北京 / 辽阳 / 失败提示）", group: GROUPS.shots },
  ];
  return mapping.map((item) => {
    const list = state.checks.filter((entry) => entry.group === item.group);
    const pass = list.filter((entry) => entry.status === "PASS").length;
    const fail = list.filter((entry) => entry.status === "FAIL").length;
    const skip = list.filter((entry) => entry.status === "SKIP").length;
    const status = fail > 0 ? "FAIL" : list.length === 0 ? "SKIP" : pass > 0 ? "PASS" : "SKIP";
    const evidence = list
      .filter((entry) => entry.status !== "SKIP")
      .slice(0, 3)
      .map((entry) => `${entry.id} ${entry.actual}`)
      .join("；");
    return { key: item.key, title: item.title, pass, fail, skip, status, evidence: truncate(evidence, 420) };
  });
}

function buildMarkdown(state, summary, meta) {
  const lines = [];
  lines.push("# 问答第 2 步城市切换 + coverage · 验收报告（verifier-onboarding-city）");
  lines.push("");
  lines.push(`- 生成时间：${meta.generatedAtLocal}（${meta.generatedAtIso}）`);
  lines.push(`- 页面：${APP}/?city=beijing（headless Edge ${meta.browserVersion} + CDP，视口 1280×900）`);
  lines.push(`- 契约：build/onboarding-city-contract.md §7（6 条主验收 + 数据/API + 回归 + 截图）`);
  lines.push(`- 验收对象冻结 hash：${Object.entries(IMPL_FROZEN_HASHES).map(([relPath, hash]) => `${relPath}=${hash}`).join("；")}`);
  lines.push(`- 结果：**PASS ${summary.pass} / FAIL ${summary.fail} / SKIP ${summary.skip}**（共 ${summary.total} 条）`);
  lines.push(`- 结论：${summary.fail === 0 ? "全部通过" : `有 ${summary.fail} 条 FAIL（见文末）`}`);
  lines.push("");
  lines.push("## 一、验收总览（§7 逐项）");
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
  lines.push("## 三、关键现场（DOM / 请求 / 数据）");
  lines.push("");
  lines.push(`- 第 2 步北京：title=${JSON.stringify(truncate(state.s1?.title, 60))}；胶囊=${JSON.stringify((state.s1?.buttons ?? []).map((button) => `${button.testId}:${button.ariaPressed}`))}；placeholder=${JSON.stringify(state.s1?.placeholder)}；coverage=${JSON.stringify(state.s1?.coverageText)}`);
  lines.push(`- 第 2 步辽阳：胶囊=${JSON.stringify((state.s2?.buttons ?? []).map((button) => `${button.testId}:${button.ariaPressed}`))}；placeholder=${JSON.stringify(state.s2?.placeholder)}；coverage=${JSON.stringify(state.s2?.coverageText)}；url=${JSON.stringify(truncate(state.s2?.url, 120))}`);
  lines.push(`- 切城市清空：未提交输入 → value=${JSON.stringify(state.s3a?.manualValue)}；解析成功后 → originSelected=${JSON.stringify(state.s3b?.originSelectedText)}，value=${JSON.stringify(state.s3b?.manualValue)}`);
  lines.push(`- geocode：北京=${JSON.stringify(state.geocodeBeijing?.fetchEntry?.body ?? "画像兜底")}；辽阳=${JSON.stringify(state.geocodeLiaoyang?.fetchEntry?.body ?? "画像兜底")}`);
  lines.push(`- 主页：完成辽阳问答后 city-select=${JSON.stringify(state.mainAfterLiaoyang?.citySelectValue)}；下拉切北京后 city-select=${JSON.stringify(state.mainAfterSwitch?.citySelectValue)}，手填起点=${JSON.stringify(state.mainAfterSwitch?.originInputValue)}；刷新后第 2 步选中=${JSON.stringify(state.s4?.selectedTestId)}`);
  lines.push(`- 失败提示：alert=${JSON.stringify(truncate(state.failureMain?.alertText, 220))}；failure-coverage=${JSON.stringify(state.failureMain?.failureCoverageText)}；fontSize=${JSON.stringify(state.failureMain?.failureCoverageFontSize)}；color=${JSON.stringify(state.failureMain?.failureCoverageColor)}`);
  lines.push(`- M1（§7.11）切城市+解析起点+排一次：解析地址=${JSON.stringify(state.m1Geocode?.address ?? null)}（step=${state.m1Geocode?.step ?? "?"}）；/api/plan body keys=${JSON.stringify(state.m1PlanEntry?.body === undefined || state.m1PlanEntry?.body === null ? null : Object.keys(state.m1PlanEntry.body))}；profile.origin=${JSON.stringify(state.m1PlanEntry?.body?.profile?.origin ?? null)}；响应 ok=${JSON.stringify(state.m1PlanResponse?.ok ?? null)}`);
  lines.push("");
  lines.push("## 四、数据 / API 只读证据");
  lines.push("");
  for (const city of Object.values(CITIES)) {
    lines.push(`- ${city.label}：/api/cities coverage=${JSON.stringify(city.coverage)}；城市 json coverage=${JSON.stringify((state.cityJson?.[city.id]?.value ?? {}).coverage)}；loadCityConfig=${JSON.stringify(state.configHelper?.parsed?.cities?.[city.id]?.coverage ?? null)}`);
    lines.push(`  - git HEAD 除 coverage 外 deepEqual：${state.gitBaseline?.[city.id]?.detail ?? "(未执行)"}`);
  }
  lines.push(`- 红线文件：${(state.frozenHashes ?? []).join("；")}`);
  lines.push(`- 上轮 manual 瘦身文件 sha256：beijing=${MANUAL_CLEAN_SHA.beijing}；liaoyang=${MANUAL_CLEAN_SHA.liaoyang}（见逐条明细 0.7）`);
  lines.push("");
  lines.push("## 五、回归命令与日志");
  lines.push("");
  const regressions = [
    ["onboarding-always-acceptance", "node build/verify/onboarding-always-acceptance.mjs", state.onboardingAlways],
    ["check:city", "npm run check:city", state.checks.find((item) => item.id === "7.2-check-city")],
    ["admin-map-acceptance", "node scripts/verify/admin-map-acceptance.mjs", state.adminMapRegression],
    ["tsc", "npx tsc --noEmit", state.checks.find((item) => item.id === "7.4-tsc")],
    ["lint", "npm run lint", state.checks.find((item) => item.id === "7.5-lint")],
  ];
  for (const [label, command, info] of regressions) {
    if (info === undefined || info === null) {
      lines.push(`- ${label}：\`${command}\` → (未执行)`);
    } else if (info.logPath !== undefined) {
      lines.push(`- ${label}：\`${command}\` → exit=${info.exitCode}，汇总=${info.summary?.summaryLine ?? "(无)"}，日志=${info.logPath}`);
    } else {
      lines.push(`- ${label}：\`${command}\` → ${info.status}（${info.actual}）`);
    }
  }
  lines.push("");
  lines.push("## 六、控制台 / emoji");
  lines.push("");
  lines.push(`- 控制台：${state.console === undefined || state.console === null ? "(未采样)" : `过滤后 error ${state.console.filtered.length} 条（原始 ${state.console.rawCount} 条，warnings ${state.console.warningsCount} 条）`}`);
  lines.push(`- 无 emoji：见逐条明细 8.2（扫描 components/Onboarding.tsx、app/page.tsx）`);
  lines.push("");
  lines.push("## 七、截图（.cache/verify/）");
  lines.push("");
  const requiredShots = [
    `${SCREENSHOT_PREFIX}step2-beijing.png`,
    `${SCREENSHOT_PREFIX}step2-liaoyang.png`,
    `${SCREENSHOT_PREFIX}failure-coverage.png`,
  ];
  for (const name of requiredShots) lines.push(`- ${name}：${state.screenshots[name] === null || state.screenshots[name] === undefined ? "（缺失）" : rel(state.screenshots[name])}`);
  for (const [name, filePath] of Object.entries(state.screenshots)) {
    if (requiredShots.includes(name)) continue;
    lines.push(`- ${name}：${filePath === null ? "（失败）" : rel(filePath)}`);
  }
  lines.push("");
  lines.push("## 八、备注");
  lines.push("");
  lines.push("- 实时钟下「现在就走」可能排得出来（§7.6 只要求失败提示里含 coverage）；本脚本优先用实时钟，实时钟成功时改用 fake clock 23:50 强制失败，并在 6.3 证据里注明方式。");
  lines.push("- geocode 走真实 /api/geocode；若外部高德接口不可用，会写 localStorage 测试画像兜底（只改测试数据，不碰产品代码），证据里注明「方式=profile-fallback」。");
  lines.push("- onboarding-always-acceptance 若因本轮标题改动出现失效断言，按契约 §8 允许改一处并注明行号/原因；脚本本身不自动改回归脚本，失败时把日志路径与现场发给 Lead。");
  lines.push("");
  lines.push("## 九、FAIL 汇总");
  lines.push("");
  const failures = state.checks.filter((item) => item.status === "FAIL");
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
    meta,
    summary,
    acceptance: buildOverview(state),
    checks: state.checks,
    screenshots: state.screenshots,
    app: APP,
    cityJson: {
      beijing: state.cityJson?.beijing?.value ?? null,
      liaoyang: state.cityJson?.liaoyang?.value ?? null,
    },
    apiCities: state.apiCities ?? null,
    configHelper: state.configHelper ?? null,
    gitBaseline: state.gitBaseline ?? null,
    implFrozenHashes: IMPL_FROZEN_HASHES,
    frozenHashes: state.frozenHashes ?? null,
    manualCleanSha: MANUAL_CLEAN_SHA,
    browser: state.browser ?? null,
    fetchLog: state.fetchLogAll ?? [],
    onboardingAlways: state.onboardingAlways ?? null,
    adminMapRegression: state.adminMapRegression ?? null,
    console: state.console ?? null,
    evidence: {
      s1: state.s1 ?? null,
      s2: state.s2 ?? null,
      s3a: state.s3a ?? null,
      s3b: state.s3b ?? null,
      s4: state.s4 ?? null,
      mainAfterLiaoyang: state.mainAfterLiaoyang ?? null,
      mainAfterSwitch: state.mainAfterSwitch ?? null,
      failureMain: state.failureMain ?? null,
      geocodeBeijing: state.geocodeBeijing ?? null,
      geocodeLiaoyang: state.geocodeLiaoyang ?? null,
      failureGeocode: state.failureGeocode ?? null,
      m1Geocode: state.m1Geocode ?? null,
      m1Main: state.m1Main ?? null,
      m1PlanEntry: state.m1PlanEntry ?? null,
      m1PlanResponse: state.m1PlanResponse ?? null,
    },
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
    console: null,
    cityJson: {},
    apiCities: null,
    configHelper: null,
    gitBaseline: null,
    frozenHashes: null,
    browser: null,
    fetchLogAll: [],
    s1: null,
    s2: null,
    s3a: null,
    s3b: null,
    s4: null,
    mainAfterLiaoyang: null,
    mainAfterSwitch: null,
    failureMain: null,
    geocodeBeijing: null,
    geocodeLiaoyang: null,
    failureGeocode: null,
    onboardingAlways: null,
    adminMapRegression: null,
  };
}

async function main() {
  ensureDirs();

  if (DUMP_HELPER) {
    const helper = writeConfigHelper();
    console.log(`[helper] 已生成：${rel(helper)}`);
    process.exitCode = 0;
    return;
  }

  const startedAt = Date.now();
  const generatedAt = new Date();
  const state = createState();
  let fatalError = null;
  let lockHeld = false;

  try {
    // 数据 / API 只读检查不依赖浏览器，先跑（失败不影响浏览器部分继续取证）
    try {
      const citiesApi = await apiGet("/api/cities", { timeoutMs: 30000, baseUrl: APP });
      state.apiCities = citiesApi.json !== null && Array.isArray(citiesApi.json.cities) ? citiesApi.json.cities : null;
    } catch {
      state.apiCities = null;
    }
    await phaseDataAndApi(state);
  } catch (error) {
    fatalError = error;
    check(state, GROUPS.env, "0.0", "数据/API 只读检查执行完成", false, "无异常", `异常：${messageText(error)}`);
  }

  // 浏览器阶段（独占浏览器锁；结束后释放，回归子脚本自己拿锁）
  try {
    await acquireLock();
    lockHeld = true;
    await phaseBrowser(state);
  } catch (error) {
    fatalError = error;
    check(state, GROUPS.accept1, "B.0", "浏览器验收主流程执行完成", false, "无异常", `异常：${messageText(error)}${error instanceof Error && error.stack !== undefined ? `\n${truncate(error.stack, 500)}` : ""}`);
  } finally {
    if (lockHeld) {
      try {
        releaseLock();
      } catch {
        /* ignore */
      }
      lockHeld = false;
    }
  }

  // §7.9 截图检查（无论浏览器阶段是否完全成功都记录）
  for (const name of [`${SCREENSHOT_PREFIX}step2-beijing.png`, `${SCREENSHOT_PREFIX}step2-liaoyang.png`, `${SCREENSHOT_PREFIX}failure-coverage.png`]) {
    const filePath = state.screenshots[name];
    const ok = typeof filePath === "string" && existsSync(filePath) && statSync(filePath).size > 10000;
    check(
      state,
      GROUPS.shots,
      `9.${name}`,
      `1280×900 截图存在：${name}`,
      ok,
      "截图存在且 >10KB",
      filePath === null || filePath === undefined ? "截图未生成" : `${rel(filePath)}（${existsSync(filePath) ? statSync(filePath).size : "?"} bytes）`,
    );
  }

  // §7.7 回归（浏览器锁已释放；admin-map 子脚本自己拿锁）
  if (SKIP_REGRESSION) {
    skipCheck(state, GROUPS.regression, "7.skip", "回归组（--no-regression）", "本次传了 --no-regression，跳过 §7.7 回归");
  } else {
    try {
      phaseRegressions(state);
    } catch (error) {
      check(state, GROUPS.regression, "7.SYS", "回归组执行完成", false, "无异常", `异常：${messageText(error)}`);
    }
  }

  const summary = summaryFromChecks(state);
  summary.elapsedMs = Date.now() - startedAt;
  const meta = {
    script: "scripts/verify/onboarding-city-acceptance.mjs",
    generatedAtIso: generatedAt.toISOString(),
    generatedAtLocal: generatedAt.toLocaleString("zh-CN", { hour12: false }),
    url: `${APP}/?city=beijing`,
    app: APP,
    lockOwner: LOCK_NAME,
    node: process.version,
    browserVersion: state.browser?.version ?? "(未启动)",
    viewport: VIEWPORT,
    contract: "build/onboarding-city-contract.md §7",
    fixedFailureMinute: FIXED_FAILURE_MINUTE,
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
  for (const [name, filePath] of Object.entries(state.screenshots)) console.log(`  ${filePath === null ? "（失败）" : rel(filePath)}  ${name}`);
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
  console.error(`[onboarding-city-acceptance] 脚本异常：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exitCode = 1;
});
