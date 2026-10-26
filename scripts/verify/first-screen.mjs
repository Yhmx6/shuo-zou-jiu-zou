#!/usr/bin/env node
/**
 * 首屏验收（scripts/verify/first-screen.mjs）
 *
 * 运行（项目根目录，dev server 已在 http://127.0.0.1:3000；localhost 加不进高德白名单）：
 *   node scripts/verify/first-screen.mjs              # B 组：首屏（新布局「站点行 + 展开层」）活动行
 *   node scripts/verify/first-screen.mjs --mode=noevent   # C 组：活动过期后应看不到活动行
 *
 * 本轮适配（任务书第二步布局改版后，Lead 追加的小任务）：
 * - 第一站不再有 `article + h2` 卡片：站点改成「行」+ 点击展开，星标 / 活动行 / 导航按钮都在展开层；
 * - 本脚本改为：等启动页从 DOM 消失 → 点「现在就走」 → **点第 1 行展开** → 断言展开层内容，
 *   等价验证原来 M10 首屏的 4 项：
 *     1) 第一站名称（行首「① HH:mm 辽阳大剧院」）；
 *     2) 重要性星标 aria-label = 重要性 5 星 + 5 颗实心星；
 *     3) 活动行「19:00 有场话剧《雷雨》，票价 80-180」；
 *     4) 页面时间显示 15:20。
 *   另外校验原首屏功能仍在展开层：`导航` 高德链接；行程含餐厅站时 `餐厅信息` 卡。
 *
 * 活动数据过期处理（不是页面 bug，是数据现状）：
 *   辽阳「话剧《雷雨》」的 endAt 已过。服务器按「服务器本地当天 + 请求 nowMinute=920」匹配活动
 *   （见 lib/events.ts 的 referenceDateFromMinute，与 /api/plan 同口径），所以不会下发 upcomingEvent。
 *   脚本用同一口径先算「目标活动是否仍在匹配窗口内」：
 *     - 仍在窗口内 → 照常 assert 活动行（API 预检 + 页面展开层各一条）；
 *     - 已结束 / 不在 4h 窗口 → 这两条记为 SKIP 并打印明确原因（不伪装 PASS，也不删掉检查；
 *       数据更新后活动重新进入窗口，脚本会自动恢复检查）。
 *
 * 验收契约（本轮新增）：
 * - 浏览器是独占资源：跑前原子创建 build/.verify-lock（内容 "first-screen"），已存在就等 60s 重试、
 *   最多 5 分钟；跑完（含异常）删除；
 * - 启动页覆盖层移除后（`[data-splash] === null`）才开始交互，避免白底覆盖层挡住操作。
 *
 * 先用 API 预检（POST /api/plan 固定参数）确认这条路径确实能排到辽阳大剧院并带上 importance / 活动；
 * 预检失败会如实打印 API 证据，浏览器步骤照跑，失败时贴 body.innerText，不伪造。
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  BASE_URL,
  ROOT,
  apiGet,
  apiPost,
  closeEdge,
  connectPage,
  createConsoleCollector,
  createReport,
  ensureVerifyDir,
  launchEdge,
  oneLine,
  screenshot,
  sleep,
  waitForEvaluate,
  writeArtifact,
} from './lib.mjs';

const LOCK_PATH = path.join(ROOT, 'build', '.verify-lock');
const LOCK_OWNER = 'first-screen';
const LOCK_WAIT_MS = 5 * 60 * 1000;
const LOCK_RETRY_MS = 60 * 1000;

const MODE = (process.argv.find((argument) => argument.startsWith('--mode=')) ?? '--mode=event').slice('--mode='.length);
const IS_NOEVENT = MODE === 'noevent';
const TITLE = IS_NOEVENT ? '首屏验收 C 组（活动过期后应消失）' : '首屏验收 B 组（首屏活动行）';
const REPORT = createReport(TITLE);

const APP_URL = `${BASE_URL}/?city=liaoyang`;
const CITY_ID = 'liaoyang';
const TARGET_PLACE_ID = 'B0FFGEKXKE';
const TARGET_PLACE_NAME = '辽阳大剧院';
const EVENT_TITLE = '话剧《雷雨》';
/** 页面假时钟固定在活动当天 15:20（920 = 15:20） */
const FAKE_TIME_MINUTE = 15 * 60 + 20;
/** 活动开始时间 19:00（页面文案里的关键片段） */
const EXPECTED_EVENT_LINE = '19:00 有场话剧《雷雨》';
const EXPECTED_EVENT_NOTE = '票价 80-180';
/** 与 lib/events.ts 的 UPCOMING_EVENT_WINDOW_MIN 同一口径：startAt < now + 4 小时。 */
const EVENT_WINDOW_MIN = 240;

const SHOT_NAME = IS_NOEVENT ? 'first-screen-noevent.png' : 'first-screen-event.png';
const TEXT_NAME = IS_NOEVENT ? 'first-screen-noevent.txt' : 'first-screen-event.txt';
const REPORT_NAME = IS_NOEVENT ? 'first-screen-noevent-report.json' : 'first-screen-event-report.json';

// ---------------------------------------------------------------- 小工具

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** "YYYY-MM-DDTHH:mm"（本地时间，无时区）→ Date；与 lib/events.ts 的 parseLocalDateTime 同口径。 */
function parseLocalDateTime(text) {
  return new Date(
    Number(text.slice(0, 4)),
    Number(text.slice(5, 7)) - 1,
    Number(text.slice(8, 10)),
    Number(text.slice(11, 13)),
    Number(text.slice(14, 16)),
    0,
    0,
  );
}

/** 服务器参考「现在」：服务器本地日期 + 请求里的 nowMinute（与 /api/plan 匹配活动的口径一致）。 */
function serverReferenceAtMinute(minuteOfDay) {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(minuteOfDay / 60), minuteOfDay % 60, 0, 0);
}

/** Date → "YYYY-MM-DD HH:mm"（只为打印原因，不做业务运算） */
function formatLocalDateTime(date) {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  );
}

/** 用页面里的 Date 假时钟脚本：固定到活动当天 15:20（含 Date.now / Date.UTC / Date.parse 继承） */
function fakeClockSource(year, month, day, minuteOfDay) {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  return `(() => {
    const RealDate = Date;
    const fixed = new RealDate(${year}, ${month - 1}, ${day}, ${hour}, ${minute}, 0, 0).getTime();
    window.Date = class extends RealDate {
      constructor(...args) {
        super(...(args.length === 0 ? [fixed] : args));
      }
      static now() {
        return fixed;
      }
    };
  })();`;
}

/** 浏览器独占锁：原子创建（O_EXCL），已存在就等 60s 重试，最多 5 分钟。 */
async function acquireLock() {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      writeFileSync(LOCK_PATH, LOCK_OWNER, { flag: 'wx' });
      console.log(`[lock] 已创建 build/.verify-lock（${LOCK_OWNER}）`);
      return;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    if (Date.now() > deadline) {
      throw new Error(`build/.verify-lock 已被占用超过 5 分钟（内容：${safeRead(LOCK_PATH)}），请 Lead 处理`);
    }
    console.log(`[lock] build/.verify-lock 已存在（内容：${safeRead(LOCK_PATH)}），60s 后重试`);
    await sleep(LOCK_RETRY_MS);
  }
}

function releaseLock() {
  try {
    if (existsSync(LOCK_PATH)) unlinkSync(LOCK_PATH);
    console.log('[lock] 已删除 build/.verify-lock');
  } catch (error) {
    console.log(`[lock] 删除失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function safeRead(filePath) {
  try {
    return readFileSync(filePath, 'utf8').trim();
  } catch {
    return '(读不到)';
  }
}

// ---------------------------------------------------------------- 页面表达式

/** 页面状态：城市下拉 / 按钮 / 启动页是否还在 */
const PAGE_STATE_EXPR = String.raw`(() => {
  const citySelect = document.querySelector('[data-testid="city-select"]');
  const bodyText = document.body.innerText || '';
  return {
    readyState: document.readyState,
    cityExists: citySelect !== null,
    cityValue: citySelect === null ? null : citySelect.value,
    cityDisabled: citySelect === null ? null : citySelect.disabled,
    buttonTexts: [...document.querySelectorAll('button')].map((button) => (button.textContent || '').trim()),
    splashPresent: document.querySelector('[data-splash]') !== null,
    bodyText: bodyText.slice(0, 600),
  };
})()`;

/** 启动页已从 DOM 移除（Lead 约定信号：查不到 [data-splash] 才算消失） */
const SPLASH_ABSENT_EXPR = `document.querySelector('[data-splash]') === null`;

/** 展开「更多选项」 */
const EXPAND_MORE_OPTIONS_EXPR = String.raw`(() => {
  const details = [...document.querySelectorAll('details')].find((item) => String(item.querySelector('summary') === null ? '' : item.querySelector('summary').textContent).includes('更多选项'));
  if (details === undefined) return { opened: false, detailsCount: document.querySelectorAll('details').length };
  details.open = true;
  return { opened: true };
})()`;

/** 用原生 setter 给 React 受控 input 赋值（否则 React 收不到变更） */
function fillOriginExpr(placeName) {
  return String.raw`(() => {
    const input = document.querySelector('#plan-origin-address') ?? document.querySelector('[data-testid="origin-address-input"]');
    if (input === null) return { filled: false, reason: '未找到起点输入框' };
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(placeName)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return { filled: true, value: input.value };
  })()`;
}

/** 点击「现在就走」 */
const CLICK_START_EXPR = String.raw`(() => {
  const buttons = [...document.querySelectorAll('button')];
  const button = buttons.find((item) => (item.textContent || '').trim() === '现在就走');
  if (button === undefined) return { clicked: false, reason: '没有「现在就走」按钮', buttonTexts: buttons.map((item) => (item.textContent || '').trim()) };
  if (button.disabled) return { clicked: false, reason: '按钮 disabled', buttonTexts: buttons.map((item) => (item.textContent || '').trim()) };
  button.click();
  return { clicked: true };
})()`;

/** 新布局就绪：头部 + 站点行出现（第二步改版后的结构，不再有 article+h2 首站卡片） */
const NEW_LAYOUT_STATE_EXPR = String.raw`(() => {
  const header = document.querySelector('[data-testid="itinerary-header"]');
  const rows = [...document.querySelectorAll('[data-testid="stop-row"]')];
  return {
    hasHeader: header !== null,
    headerText: header === null ? null : (header.innerText || '').trim(),
    rowCount: rows.length,
    firstRowText: rows.length === 0 ? null : (rows[0].innerText || '').trim(),
    splashPresent: document.querySelector('[data-splash]') !== null,
    bodyText: (document.body.innerText || '').slice(0, 800),
  };
})()`;

/**
 * 点第 1 行展开后采集展开层（新结构验收的核心）：
 * 第一站名称从行首解析；星标 / 活动行 / 导航按钮 / 换一个 / 不感兴趣都在 [data-testid="stop-detail-0"] 里。
 */
const EXPANDED_FIRST_STOP_EXPR = String.raw`(() => {
  const rows = [...document.querySelectorAll('[data-testid="stop-row"]')];
  const firstRow = rows.length === 0 ? null : rows[0];
  const detail = document.querySelector('[data-testid="stop-detail-0"]');
  const detailText = detail === null ? '' : (detail.innerText || '');
  const starGroup = detail === null ? null : detail.querySelector('[role="img"][aria-label^="重要性"]');
  const navigationLinks = detail === null
    ? []
    : [...detail.querySelectorAll('a[href*="uri.amap.com/navigation"]')].map((link) => (link.textContent || '').trim());
  const bodyText = document.body.innerText || '';
  const lines = bodyText.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  const firstRowLines = firstRow === null
    ? []
    : (firstRow.innerText || '').split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  return {
    url: location.href,
    firstRowText: firstRow === null ? null : (firstRow.innerText || '').trim(),
    firstRowLines,
    firstRowAriaExpanded: firstRow === null ? null : firstRow.getAttribute('aria-expanded'),
    detailExists: detail !== null,
    detailHeight: detail === null ? null : Math.round(detail.getBoundingClientRect().height),
    detailText,
    starGroupLabel: starGroup === null ? null : starGroup.getAttribute('aria-label'),
    filledStars: starGroup === null ? 0 : starGroup.querySelectorAll('svg[fill="currentColor"]').length,
    outlinedStars: starGroup === null ? 0 : starGroup.querySelectorAll('svg[fill="none"]').length,
    navigationLinks,
    hasSwapButton: detailText.includes('换一个'),
    hasDislikeButton: detailText.includes('不感兴趣'),
    pageTimeLine: lines.find((line) => line.includes('现在是')) ?? null,
    eventLines: lines.filter((line) => line.includes('有场')),
    theaterLines: lines.filter((line) => line.includes(${JSON.stringify(TARGET_PLACE_NAME)})),
    hasEventLine: bodyText.includes('有场'),
    hasEventTitle: bodyText.includes(${JSON.stringify(EVENT_TITLE)}),
    bodyText,
  };
})()`;

/** 点第 N 行（展开 / 收起由调用方决定点几次） */
function clickRowExpr(index) {
  return String.raw`(() => {
    const row = [...document.querySelectorAll('[data-testid="stop-row"]')][${index}] ?? null;
    if (row === null) return { clicked: false, reason: '找不到第 ' + (${index} + 1) + ' 行' };
    row.click();
    return { clicked: true, ariaExpandedBeforeClick: row.getAttribute('aria-expanded') };
  })()`;
}

/** 第 N 行展开层里是否有「餐厅信息」卡（原第一站卡片的 RestaurantCard 功能） */
function restaurantCardExpr(index) {
  return String.raw`(() => {
    const detail = document.querySelector('[data-testid="stop-detail-${index}"]');
    const card = detail === null ? null : detail.querySelector('[aria-label="餐厅信息"]');
    return {
      exists: card !== null,
      text: card === null ? null : (card.innerText || '').trim().slice(0, 300),
    };
  })()`;
}

// ---------------------------------------------------------------- 主流程

async function main() {
  ensureVerifyDir();
  const generatedAt = new Date().toLocaleString('zh-CN', { hour12: false });
  const reportData = { generatedAt, mode: MODE, url: APP_URL, checks: [], screenshots: {}, api: {}, dom: null };
  const referenceNow = serverReferenceAtMinute(FAKE_TIME_MINUTE);
  console.log(`[time] 服务器参考时刻（real today + nowMinute 920）：${formatLocalDateTime(referenceNow)}`);

  await acquireLock();
  const launched = await launchEdge();
  let cdp = null;
  let consoleCollector = null;
  try {
    // ---------- 0. 用 API 找活动 + 判断活动是否还在匹配窗口内 ----------
    REPORT.section('0. 活动数据探活（决定假时钟日期 / 活动行是否可验证）');
    const eventsApi = await apiGet(`/api/admin/events?city=${CITY_ID}`, { timeoutMs: 60000 });
    const events = eventsApi.json !== null && Array.isArray(eventsApi.json.events) ? eventsApi.json.events : [];
    const targetEvent = events.find((event) => event.title === EVENT_TITLE) ?? null;
    reportData.api.events = targetEvent;
    REPORT.assert('活动接口可访问', eventsApi.status === 200 && eventsApi.json?.ok === true, `HTTP ${eventsApi.status}，${events.length} 条活动`, oneLine(eventsApi.text, 300));
    if (targetEvent === null) {
      if (IS_NOEVENT) {
        REPORT.skip('找到活动「话剧《雷雨》」', '活动记录已不存在（C 组不需要它存在，只要求首屏不出现）');
      } else {
        REPORT.fail('找到活动「话剧《雷雨》」', `当前辽阳没有「${EVENT_TITLE}」：${oneLine(eventsApi.text, 300)}`);
      }
    } else if (IS_NOEVENT) {
      REPORT.pass(
        '找到活动「话剧《雷雨》」（C 组：应已过期）',
        `${targetEvent.startAt} ~ ${targetEvent.endAt}，placeName=${targetEvent.placeName}，status=${targetEvent.status}（服务端按真实时间算）`,
      );
    } else {
      REPORT.pass(
        '找到活动「话剧《雷雨》」',
        `${targetEvent.startAt} ~ ${targetEvent.endAt}，placeName=${targetEvent.placeName}，status=${targetEvent.status}`,
      );
    }
    const eventDate = targetEvent === null ? null : targetEvent.startAt.slice(0, 10);
    const eventPlaceName = targetEvent !== null && typeof targetEvent.placeName === 'string' && targetEvent.placeName.length > 0 ? targetEvent.placeName : TARGET_PLACE_NAME;
    const [eventYear, eventMonth, eventDay] = eventDate === null
      ? [new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate()]
      : eventDate.split('-').map(Number);
    REPORT.info(`假时钟目标：${eventYear}-${pad2(eventMonth)}-${pad2(eventDay)} 15:20（页面时间，点击「现在就走」前注入）`);

    /**
     * 目标活动是否「仍在匹配窗口内」，口径与 lib/events.ts 完全一致：
     *   endAt > 服务器参考时刻（real today + 920）且 startAt < 参考时刻 + 4 小时。
     * 只有 true 时，活动行（API 预检 + 页面展开层）才有必要断言；否则两条都记 SKIP 并说明原因。
     */
    const eventEnded = targetEvent !== null && parseLocalDateTime(targetEvent.endAt).getTime() <= referenceNow.getTime();
    const eventOutOfWindow =
      targetEvent !== null && !eventEnded &&
      parseLocalDateTime(targetEvent.startAt).getTime() >= referenceNow.getTime() + EVENT_WINDOW_MIN * 60_000;
    const eventVisible = targetEvent !== null && !eventEnded && !eventOutOfWindow;
    const eventInactiveReason = targetEvent === null
      ? '活动记录不存在，无法验证活动行'
      : eventEnded
        ? `活动 ${targetEvent.id}「${targetEvent.title}」已于 ${targetEvent.endAt} 结束（服务器参考时刻 ${formatLocalDateTime(referenceNow)}，活动窗口只看 endAt > 参考时刻）；服务器按真实时间匹配不会下发 upcomingEvent → 这条无法验证（不是页面回归；数据更新后会自动恢复检查）`
        : `活动 ${targetEvent.id}「${targetEvent.title}」开始于 ${targetEvent.startAt}，不在服务器参考时刻 ${formatLocalDateTime(referenceNow)} 的 4 小时窗口内 → 这条无法验证（数据更新后会自动恢复检查）`;
    reportData.event = {
      target: targetEvent,
      referenceNow: formatLocalDateTime(referenceNow),
      ended: eventEnded,
      outOfWindow: eventOutOfWindow,
      visible: eventVisible,
      reason: eventVisible ? null : eventInactiveReason,
    };
    if (eventVisible) {
      REPORT.pass(
        '目标活动仍在「现在 / 4 小时内」匹配窗口',
        `endAt=${targetEvent.endAt} > 参考时刻 ${formatLocalDateTime(referenceNow)}，startAt=${targetEvent.startAt} < 参考时刻+4h`,
      );
    } else if (targetEvent !== null) {
      // 这是「活动行能不能验证」的前提，不是验收项：只打印现状，不记 PASS/FAIL/SKIP。
      REPORT.info(`目标活动不在匹配窗口，活动行两项断言将记 SKIP：${eventInactiveReason}`);
    }

    // ---------- 1. API 预检：固定参数下第一站必须是大剧院且带 importance（活动行按窗口决定 assert/SKIP） ----------
    REPORT.section('1. API 预检（POST /api/plan 固定参数）');
    const precheckBody = {
      city: CITY_ID,
      nowMinute: FAKE_TIME_MINUTE,
      budget: 200,
      originAddress: eventPlaceName,
    };
    const precheck = await apiPost('/api/plan', precheckBody, { timeoutMs: 120000 });
    let precheckOk = false;
    if (precheck.error !== null) {
      REPORT.fail('API 预检请求', `请求失败：${precheck.error}`);
    } else if (precheck.json === null || precheck.json.ok === false) {
      REPORT.fail('API 预检结果', `ok=false：${oneLine(precheck.json?.reason ?? precheck.text, 400)}`);
    } else {
      const firstStop = Array.isArray(precheck.json.stops) ? precheck.json.stops[0] : null;
      precheckOk = firstStop !== null && firstStop.placeId === TARGET_PLACE_ID;
      REPORT.assert(
        'API 预检：第一站是辽阳大剧院',
        precheckOk,
        `第一站 ${firstStop?.placeName ?? '(无)'}（${firstStop?.placeId ?? '-'}）`,
        `第一站是 ${firstStop?.placeName ?? '(无)'}（${firstStop?.placeId ?? '-'}），不是辽阳大剧院`,
      );
      REPORT.assert(
        'API 预检：第一站带 importance=5',
        firstStop !== null && firstStop.importance === 5,
        `importance=${firstStop?.importance}`,
        `importance=${firstStop?.importance ?? '(缺失)'}`,
      );
      const upcoming = firstStop?.upcomingEvent ?? null;
      if (IS_NOEVENT) {
        // C 组：活动已过期（或本就不在窗口内）→ 第一站不应该再挂 upcomingEvent。
        if (eventVisible) {
          REPORT.skip(
            'API 预检：第一站不带 upcomingEvent（活动已过期）',
            '活动仍在匹配窗口内，C 组「已过期」前提不成立，不做「不存在」断言',
          );
        } else {
          REPORT.assert(
            'API 预检：第一站不带 upcomingEvent（活动已过期）',
            upcoming === null,
            '没有 upcomingEvent',
            `仍带 upcomingEvent：${oneLine(upcoming, 300)}`,
          );
        }
      } else if (eventVisible) {
        REPORT.assert(
          'API 预检：第一站带 upcomingEvent（话剧《雷雨》）',
          upcoming !== null && upcoming.title === EVENT_TITLE,
          upcoming === null ? '没有 upcomingEvent' : `${upcoming.startAtText} 有场${upcoming.title}，status=${upcoming.status}，dayLabel=${upcoming.dayLabel}，noteLine=${upcoming.noteLine ?? 'null'}`,
          upcoming === null ? '没有 upcomingEvent' : `upcomingEvent 异常：${oneLine(upcoming, 300)}`,
        );
      } else {
        REPORT.skip('API 预检：第一站带 upcomingEvent（话剧《雷雨》）', eventInactiveReason);
      }
      REPORT.info(`API 预检 stops：${(precheck.json.stops ?? []).map((stop) => `${stop.placeName}(${stop.placeId})`).join(' -> ')}`);
      reportData.api.precheck = {
        ok: precheckOk,
        status: precheck.status,
        stops: (precheck.json.stops ?? []).map((stop) => ({
          placeId: stop.placeId,
          placeName: stop.placeName,
          importance: stop.importance ?? null,
          upcomingEvent: stop.upcomingEvent ?? null,
          hasMeal: stop.meal !== undefined && stop.meal !== null,
        })),
      };
    }

    // ---------- 2. 真实浏览器：假时钟 15:20 + 起点=大剧院 + 点「现在就走」 ----------
    REPORT.section('2. 真实浏览器：假时钟 15:20 + 更多选项起点=大剧院 + 点「现在就走」');
    cdp = await connectPage(launched.port, { label: IS_NOEVENT ? 'first-screen-noevent' : 'first-screen' }).then(({ cdp: client }) => client);
    consoleCollector = createConsoleCollector(cdp);
    // 关键：假时钟必须在页面脚本执行前注入（Page.addScriptToEvaluateOnNewDocument 对下一次导航生效）
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: fakeClockSource(eventYear, eventMonth, eventDay, FAKE_TIME_MINUTE) });
    await cdp.send('Page.navigate', { url: APP_URL });
    try {
      await cdp.send('Page.bringToFront');
    } catch {
      /* 无头模式可忽略 */
    }

    // 2.0 等启动页从 DOM 移除（本轮新增的覆盖层；不先等它消失就交互会被白底挡住）
    try {
      await waitForEvaluate(cdp, SPLASH_ABSENT_EXPR, (value) => value === true, 15000, '启动页从 DOM 移除', 100);
      REPORT.pass('启动页已从 DOM 移除（[data-splash] 查不到）', '已等它消失后再交互');
    } catch (error) {
      REPORT.fail('启动页已从 DOM 移除', `15s 内启动页没有消失：${error.message}`);
    }

    // 2.1 等城市下拉 ready（辽阳）
    let pageState = null;
    try {
      pageState = await waitForEvaluate(
        cdp,
        PAGE_STATE_EXPR,
        (value) =>
          value.readyState === 'complete' &&
          value.cityExists &&
          value.cityValue === CITY_ID &&
          value.cityDisabled === false &&
          value.buttonTexts.includes('现在就走') &&
          value.splashPresent === false,
        120000,
        '首屏就绪（城市下拉=辽阳 + 「现在就走」按钮可用 + 启动页已消失）',
      );
      REPORT.pass('城市下拉出现「辽阳」', `select.value=${pageState.cityValue}，按钮：${pageState.buttonTexts.join(' / ')}`);
    } catch (error) {
      REPORT.fail('首屏就绪', `120 秒内城市下拉 /「现在就走」没有就绪：${error.message}`);
      pageState = await cdp.evaluate(PAGE_STATE_EXPR).catch(() => null);
      if (pageState !== null) REPORT.info(`当前页面摘要：${oneLine(pageState.bodyText, 300)}`);
    }

    // 2.2 假时钟是否生效
    const pageNow = await cdp.evaluate(String.raw`(() => {
      const now = new Date();
      const match = (document.body.innerText || '').match(/现在是[^\n]*/);
      return { date: now.toString(), minute: now.getHours() * 60 + now.getMinutes(), nowText: match === null ? null : match[0] };
    })()`);
    REPORT.assert('页面假时钟生效（15:20）', pageNow.minute === FAKE_TIME_MINUTE, `new Date()=${pageNow.date}`, `分钟数 ${pageNow.minute} 不是 ${FAKE_TIME_MINUTE}`);

    // 2.3 展开「更多选项」并填起点
    const expandResult = await cdp.evaluate(EXPAND_MORE_OPTIONS_EXPR);
    REPORT.assert('展开「更多选项」', expandResult.opened === true, 'details.open=true', `没有找到「更多选项」details（页面上 details 数=${expandResult.detailsCount}）`);
    await sleep(400);
    const fillResult = await cdp.evaluate(fillOriginExpr(eventPlaceName));
    REPORT.assert('起点输入框填「辽阳大剧院」', fillResult.filled === true, `输入框值=${fillResult.value}`, `填写失败：${JSON.stringify(fillResult)}`);
    await sleep(500);

    // 2.4 点击「现在就走」
    const clickResult = await cdp.evaluate(CLICK_START_EXPR);
    REPORT.assert('点击「现在就走」', clickResult.clicked === true, '已点击', `点击失败：${JSON.stringify(clickResult)}`);

    // 2.5 等新布局出现（第二步改版：头部 + 站点行；不再有 article+h2 第一站卡片）
    let layoutState = null;
    try {
      layoutState = await waitForEvaluate(
        cdp,
        NEW_LAYOUT_STATE_EXPR,
        (value) => value.hasHeader === true && value.rowCount > 0 && value.splashPresent === false,
        120000,
        '新布局出现（itinerary-header + stop-row）',
      );
      REPORT.pass('新布局出现（头部 + 站点行）', `头部：${oneLine(layoutState.headerText, 120)}；${layoutState.rowCount} 行`);
      REPORT.assert(
        '站点行数 = API 预检 stops 数',
        precheckOk && layoutState.rowCount === (precheck.json?.stops?.length ?? -1),
        `${layoutState.rowCount} 行`,
        `页面 ${layoutState.rowCount} 行，API ${precheck.json?.stops?.length ?? '-'} 站`,
      );
    } catch (error) {
      REPORT.fail('新布局出现', `120 秒内没等到新布局：${error.message}`);
      const bodyText = await cdp.evaluate('(document.body.innerText || "").slice(0, 1200)').catch(() => '');
      REPORT.info(`当前页面正文摘要：${oneLine(bodyText, 600)}`);
    }

    // 2.6 点第 1 行展开 → 断言展开层
    const clickFirstRow = await cdp.evaluate(clickRowExpr(0));
    REPORT.assert('点第 1 行展开', clickFirstRow.clicked === true, '已点击', `点击失败：${JSON.stringify(clickFirstRow)}`);
    await sleep(450); // 150ms 展开过渡 + 稳定余量
    const detail = await cdp.evaluate(EXPANDED_FIRST_STOP_EXPR);
    reportData.dom = detail;
    REPORT.assert(
      '第 1 行已展开（aria-expanded=true，展开层高度 > 0）',
      detail.firstRowAriaExpanded === 'true' && detail.detailExists === true && detail.detailHeight > 10,
      `aria-expanded=${detail.firstRowAriaExpanded}，detail 高度=${detail.detailHeight}`,
      `aria-expanded=${detail.firstRowAriaExpanded}，detail 高度=${detail.detailHeight}`,
    );

    // 2.7 餐厅信息卡（原第一站卡片的 RestaurantCard 功能）：行程里有餐厅站时，逐行展开检查
    const restaurantRows = [];
    if (layoutState !== null) {
      for (let index = 0; index < layoutState.rowCount; index += 1) {
        const expanded = await cdp.evaluate(
          `(() => { const row = document.querySelectorAll('[data-testid="stop-row"]')[${index}] ?? null; return row === null ? null : row.getAttribute('aria-expanded'); })()`,
        );
        const openedHere = expanded !== 'true';
        if (openedHere) {
          await cdp.evaluate(clickRowExpr(index));
          await sleep(300);
        }
        const card = await cdp.evaluate(restaurantCardExpr(index));
        if (card.exists) restaurantRows.push({ index, text: card.text });
        // 只保留第 1 行展开（截图用），其它行检查完立刻收起
        if (openedHere && index !== 0) {
          await cdp.evaluate(clickRowExpr(index));
          await sleep(250);
        }
      }
    }
    reportData.restaurantRows = restaurantRows;

    // 2.8 重新展开第 1 行：逐行检查餐厅卡时，页面是「单开」交互（展开另一行会收起第 1 行），
    //     所以截图和最终断言前要把它重新展开，保证「点第 1 行展开 → 断言展开层」的现场是展开态。
    const firstRowExpandedNow = await cdp.evaluate(
      `(() => { const row = document.querySelectorAll('[data-testid="stop-row"]')[0] ?? null; return row === null ? null : row.getAttribute('aria-expanded'); })()`,
    );
    if (firstRowExpandedNow !== 'true') {
      await cdp.evaluate(clickRowExpr(0));
      await sleep(450); // 150ms 展开过渡 + 稳定余量
    }

    // 2.9 截图 + 文本（第 1 行保持展开，能同时看到行与展开层）
    await sleep(400);
    const shot = await screenshot(cdp, SHOT_NAME);
    reportData.screenshots.main = shot.path;
    const finalDetail = await cdp.evaluate(EXPANDED_FIRST_STOP_EXPR);
    REPORT.assert(
      '截图前第 1 行处于展开态',
      finalDetail.firstRowAriaExpanded === 'true' && finalDetail.detailHeight > 10,
      `aria-expanded=${finalDetail.firstRowAriaExpanded}，detail 高度=${finalDetail.detailHeight}`,
      `aria-expanded=${finalDetail.firstRowAriaExpanded}，detail 高度=${finalDetail.detailHeight}`,
    );
    const textPath = writeArtifact(TEXT_NAME, `${finalDetail.bodyText}\n`);
    console.log(`  [evidence] 首屏 innerText 已保存：${textPath}`);
    reportData.dom = finalDetail;

    console.log('  首屏关键文本：');
    console.log(`    页面时间行：${finalDetail.pageTimeLine ?? '(未找到)'}`);
    console.log(`    第一站行：${finalDetail.firstRowText ?? '(未找到)'}`);
    console.log(`    展开层星标：${finalDetail.starGroupLabel ?? '(无)'}`);
    console.log(`    活动行：${finalDetail.eventLines.length > 0 ? finalDetail.eventLines.join(' || ') : '(无)'}`);
    console.log(`    展开层导航链接：${finalDetail.navigationLinks.length > 0 ? finalDetail.navigationLinks.join(' / ') : '(无)'}`);
    console.log(`    餐厅信息卡：${restaurantRows.length > 0 ? restaurantRows.map((row) => `第 ${row.index + 1} 行`).join('、') : '(本行程无餐厅站)'}`);

    // ---------- 3. 断言（新结构：行 + 展开层） ----------
    REPORT.section(IS_NOEVENT ? '3. 断言（活动过期后应该看不到活动行）' : '3. 断言（首屏必须看到活动行 / 星级 / 15:20）');
    const parseFirstRowName = (rowText) => {
      if (rowText === null) return null;
      const firstLine = rowText.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? '';
      const match = /^[①-⑳]\s*\d{2}:\d{2}\s+(.+)$/.exec(firstLine);
      return match === null ? null : match[1].trim();
    };
    const firstRowName = parseFirstRowName(finalDetail.firstRowText);
    const namePass = REPORT.assert(
      '第一站名称 = 辽阳大剧院（行首「① HH:mm 地点」）',
      firstRowName === TARGET_PLACE_NAME,
      `第一站行：${firstRowName ?? '(无)'}`,
      `第一站行：${firstRowName ?? '(无)'}，首屏文本见 ${textPath}`,
    );
    const starsPass = REPORT.assert(
      '第 1 行展开层：星标 aria-label = 重要性 5 星 + 5 颗实心星',
      finalDetail.starGroupLabel === '重要性 5 星' && finalDetail.filledStars === 5 && finalDetail.outlinedStars === 0,
      `aria-label=${finalDetail.starGroupLabel}，实心 ${finalDetail.filledStars} / 描边 ${finalDetail.outlinedStars}`,
      `aria-label=${finalDetail.starGroupLabel ?? '(无)'}，实心 ${finalDetail.filledStars} / 描边 ${finalDetail.outlinedStars}（应为 5 实心 / 0 描边）`,
    );
    const timePass = REPORT.assert(
      '页面时间显示 15:20',
      finalDetail.pageTimeLine !== null && finalDetail.pageTimeLine.includes('15:20'),
      `页面时间行：${finalDetail.pageTimeLine}`,
      `页面时间行：${finalDetail.pageTimeLine ?? '(无)'}`,
    );
    const navPass = REPORT.assert(
      '第 1 行展开层保留原首屏「导航」链接（高德）',
      finalDetail.navigationLinks.some((text) => text.includes('导航')),
      `导航链接：${finalDetail.navigationLinks.join(' / ')}`,
      `没有找到高德导航链接（原第一站卡片的「导航」按钮）`,
    );
    const swapPass = REPORT.assert(
      '第 1 行展开层保留「换一个 / 不感兴趣」',
      finalDetail.hasSwapButton && finalDetail.hasDislikeButton,
      '两个入口都在展开层',
      `展开层文本：${oneLine(finalDetail.detailText, 300)}`,
    );
    let eventLinePass = null;
    if (IS_NOEVENT) {
      if (eventVisible) {
        REPORT.skip(
          '页面不含活动行（C 组）',
          '活动仍在匹配窗口内，C 组「活动已过期」前提不成立，不做「不存在」断言',
        );
        eventLinePass = true;
      } else {
        const noEventLinePass = REPORT.assert(
          '页面不含活动行「有场」',
          finalDetail.hasEventLine === false,
          '页面 innerText 里没有「有场」',
          `页面仍含「有场」：${finalDetail.eventLines.join(' || ')}`,
        );
        const noEventTitlePass = REPORT.assert(
          `页面不含「${EVENT_TITLE}」`,
          finalDetail.hasEventTitle === false,
          `页面 innerText 里没有「${EVENT_TITLE}」`,
          `页面仍含「${EVENT_TITLE}」，首屏文本见 ${textPath}`,
        );
        eventLinePass = noEventLinePass && noEventTitlePass;
      }
    } else if (eventVisible) {
      const eventLine = finalDetail.eventLines[0] ?? '';
      eventLinePass = REPORT.assert(
        `第 1 行展开层含活动行「${EXPECTED_EVENT_LINE}，${EXPECTED_EVENT_NOTE}」`,
        eventLine.includes(EXPECTED_EVENT_LINE) && eventLine.includes(EXPECTED_EVENT_NOTE),
        `实际活动行：${eventLine}`,
        `没有找到活动行；页面 activity 行=${JSON.stringify(finalDetail.eventLines)}，首屏文本见 ${textPath}`,
      );
    } else {
      // 活动已结束 / 不在窗口：两项活动断言记 SKIP 并打印原因（不伪装 PASS，也不删检查）
      REPORT.skip(`第 1 行展开层含活动行「${EXPECTED_EVENT_LINE}，${EXPECTED_EVENT_NOTE}」`, eventInactiveReason);
      eventLinePass = true;
    }

    // 原首屏功能：餐厅卡（有餐厅站时必须能展开看到）
    const hasRestaurantInApi = Array.isArray(reportData.api.precheck?.stops)
      ? reportData.api.precheck.stops.some((stop) => stop.hasMeal === true)
      : false;
    let restaurantPass = true;
    if (!hasRestaurantInApi) {
      REPORT.skip('展开层保留「餐厅信息」卡（原第一站卡片功能）', '本次行程没有餐厅站（API 预检所有站 meal 均为空），无从检查；页面代码对餐厅站仍渲染 RestaurantCard');
    } else if (restaurantRows.length === 0) {
      restaurantPass = REPORT.fail('展开层保留「餐厅信息」卡（原第一站卡片功能）', 'API 预检有餐厅站，但逐行展开都没找到 [aria-label="餐厅信息"]');
    } else {
      REPORT.pass(
        '展开层保留「餐厅信息」卡（原第一站卡片功能）',
        `第 ${restaurantRows.map((row) => row.index + 1).join('、')} 行；${oneLine(restaurantRows[0].text, 160)}`,
      );
    }

    if (!IS_NOEVENT) {
      reportData.checks.push({
        name: 'first-screen-event',
        pass: namePass && starsPass && timePass && navPass && swapPass && eventLinePass !== false && restaurantPass,
        eventLine: eventVisible ? 'checked' : 'SKIPPED（活动已结束 / 不在窗口）',
      });
    } else {
      reportData.checks.push({
        name: 'noevent-hidden',
        pass: namePass && starsPass && timePass && navPass && swapPass && eventLinePass !== false,
      });
    }

    // ---------- 4. 页面 console ----------
    REPORT.section('4. 页面 console');
    if (consoleCollector.errors.length === 0) {
      REPORT.info('页面没有 console.error / 未捕获异常');
    } else {
      REPORT.info(`页面 console 错误 ${consoleCollector.errors.length} 条：${oneLine(consoleCollector.errors.join(' | '), 500)}`);
    }
    reportData.consoleErrors = consoleCollector.errors;
    const reportPath = writeArtifact(REPORT_NAME, JSON.stringify(reportData, null, 2));
    console.log(`  [evidence] 结构化证据已保存：${reportPath}`);
  } finally {
    if (cdp !== null) cdp.close();
    await closeEdge(launched);
    releaseLock();
  }

  const summary = REPORT.printSummary();
  console.log(`\n截图：${reportData.screenshots.main ?? '(未截图)'}`);
  console.log(`文本：${reportData.screenshots.main === undefined ? '(未保存)' : `${ensureVerifyDir()}\\${TEXT_NAME}`}`);
  process.exitCode = summary.fail > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error(`[first-screen] 脚本异常：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  try {
    releaseLock();
  } catch {
    /* ignore */
  }
  process.exitCode = 1;
});
