#!/usr/bin/env node
/**
 * 控制台验收：配色规则 + 活动分区（scripts/verify/admin-ui.mjs）
 *
 * 运行（项目根目录，dev server 已在 http://127.0.0.1:3000；localhost 加不进高德白名单）：
 *   node scripts/verify/admin-ui.mjs
 *
 * 验收 A 组（Lead 口径）：
 * 1. 打开 /admin，等地点列表加载（出现「名称 / 类目」表头 + 共 N 个地点），
 *    截图 .cache/verify/admin-places.png；
 * 2. 统计配色：gray-* 必须 0 处；text-stone-800 / text-stone-500 / bg-stone-50 /
 *    text-stone-600 / border-stone-200 必须出现；点开「编辑」弹窗后统计
 *    bg-black/40 / bg-white / shadow-lg；打印 stone-800、stone-500 对白底的 WCAG 对比度；
 * 3. 城市下拉切到「辽阳」，点顶部 tab「活动」，等《话剧《雷雨》》出现
 *    （若状态是「已结束」，先展开 <details> 折叠区），截图 .cache/verify/admin-events.png，
 *    并把活动分区 DOM 文本 dump 到 .cache/verify/admin-events.txt；
 * 4. 输出可直接贴进报告的「配色证据」(.cache/verify/admin-colors.txt) + 结构化证据 admin-report.json。
 *
 * 约束：只读操作 + 打开编辑弹窗（不保存、不删除任何数据）；不启动 / 不重启 dev server。
 */

import {
  BASE_URL,
  STONE,
  WHITE,
  apiGet,
  closeEdge,
  connectPage,
  contrastLine,
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

const REPORT = createReport('控制台验收（配色 + 活动分区）');
const ADMIN_URL = `${BASE_URL}/admin`;
const TARGET_CITY = { id: 'liaoyang', label: '辽阳' };
const TARGET_EVENT = { title: '话剧《雷雨》', placeName: '辽阳大剧院', startAt: '2026-10-23 19:00', endAt: '2026-10-23 21:00' };

/** 任务要求必须出现在页面上的 stone 规则类（bg-black/40 等弹窗类单独在弹窗里统计） */
const REQUIRED_STONE_CLASSES = ['text-stone-800', 'text-stone-500', 'bg-stone-50', 'text-stone-600', 'border-stone-200'];
/** 弹窗必须有的类（任务书要求） */
const REQUIRED_MODAL_CLASSES = ['bg-black/40', 'bg-white', 'shadow-lg'];
/** 活动分区截图 / 文本文件名（可用 --events-shot= / --events-text= 覆盖，默认保持原文件名） */
const EVENTS_SHOT_NAME = (process.argv.find((argument) => argument.startsWith('--events-shot=')) ?? '--events-shot=admin-events.png').slice('--events-shot='.length);
const EVENTS_TEXT_NAME = (process.argv.find((argument) => argument.startsWith('--events-text=')) ?? '--events-text=admin-events.txt').slice('--events-text='.length);
/** 活动「新增」弹窗截图 / 文本文件名 */
const NEW_EVENT_SHOT_NAME = (process.argv.find((argument) => argument.startsWith('--new-shot=')) ?? '--new-shot=admin-events-new.png').slice('--new-shot='.length);
const NEW_EVENT_TEXT_NAME = (process.argv.find((argument) => argument.startsWith('--new-text=')) ?? '--new-text=admin-events-new.txt').slice('--new-text='.length);
/** 活动状态中文映射（与 app/admin/page.tsx 的 EVENT_STATUS_LABELS 同一口径） */
const EVENT_STATUS_LABELS = { upcoming: '未开始', ongoing: '进行中', ended: '已结束' };
/** 展示时间：接口是 "YYYY-MM-DDTHH:mm"，页面只把 T 换成空格 */
function formatEventTime(value) {
  return String(value).replace('T', ' ');
}

// ---------------------------------------------------------------- 页面内表达式

/** 统计整页出现的颜色类（去变体前缀；gray/slate/zinc/neutral 归禁用色阶；硬编码颜色单独收集） */
const COLLECT_COLOR_CLASSES_EXPR = String.raw`(() => {
  const utilities = ['text', 'bg', 'border', 'ring', 'divide', 'outline', 'placeholder', 'decoration', 'from', 'via', 'to', 'fill', 'stroke', 'shadow', 'accent', 'caret'];
  const colorFamilies = ['gray', 'stone', 'slate', 'zinc', 'neutral', 'white', 'black', 'red', 'green', 'blue', 'amber', 'yellow', 'orange', 'teal', 'emerald', 'rose', 'sky', 'indigo', 'violet', 'purple', 'pink', 'lime', 'cyan', 'fuchsia'];
  const basePattern = /^([a-z]+)-([a-z]+)(?:-(\d{2,3}))?(?:\/(\d+))?$/;
  const counts = new Map();
  const hardcoded = new Map();
  const elements = document.querySelectorAll('*');
  for (const element of elements) {
    const raw = element.getAttribute('class');
    if (raw === null || raw === '') continue;
    for (const token of raw.split(/\s+/)) {
      if (token === '') continue;
      const base = token.includes(':') ? token.slice(token.lastIndexOf(':') + 1) : token;
      const normalized = base.replace(/^!/, '');
      if (normalized.includes('#') || /-\[[^\]]*(#|rgb|hsl)/.test(normalized)) {
        hardcoded.set(normalized, (hardcoded.get(normalized) ?? 0) + 1);
        continue;
      }
      const match = basePattern.exec(normalized);
      if (match === null) continue;
      if (!utilities.includes(match[1]) || !colorFamilies.includes(match[2])) continue;
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }
  }
  const entries = [...counts.entries()].map(([cls, count]) => ({ cls, count }));
  const families = {};
  for (const entry of entries) {
    const family = entry.cls.split('-')[1];
    families[family] = (families[family] ?? 0) + entry.count;
  }
  return {
    elementCount: elements.length,
    entries,
    families,
    hardcoded: [...hardcoded.entries()].map(([cls, count]) => ({ cls, count })),
  };
})()`;

/** 页面基础状态：表格行数 / 总数文案 / 正文摘要 */
const PAGE_STATE_EXPR = String.raw`(() => {
  const bodyText = document.body.innerText || '';
  const totalMatch = bodyText.match(/共\s*\d+\s*个地点/);
  const headers = [...document.querySelectorAll('th')].map((th) => (th.textContent || '').trim());
  return {
    readyState: document.readyState,
    hasTable: document.querySelector('table') !== null,
    rows: document.querySelectorAll('tbody tr').length,
    totalText: totalMatch === null ? null : totalMatch[0],
    headers,
    bodyText: bodyText.slice(0, 800),
  };
})()`;

/** 采样关键元素的实际计算样式 */
const STYLE_SAMPLES_EXPR = String.raw`(() => {
  const styleOf = (element) => {
    if (element === null) return null;
    const style = getComputedStyle(element);
    return {
      color: style.color,
      backgroundColor: style.backgroundColor,
      borderTopColor: style.borderTopColor,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
    };
  };
  const byClass = (cls) => document.querySelector('.' + cls);
  return {
    body: styleOf(document.body),
    main: styleOf(document.querySelector('main')),
    thead: styleOf(document.querySelector('thead')),
    tbodyFirstRow: styleOf(document.querySelector('tbody tr')),
    samplesByClass: {
      'text-stone-800': styleOf(byClass('text-stone-800')),
      'bg-stone-50': styleOf(byClass('bg-stone-50')),
      'text-stone-600': styleOf(byClass('text-stone-600')),
      'border-stone-200': styleOf(byClass('border-stone-200')),
      'text-stone-500': styleOf(byClass('text-stone-500')),
    },
  };
})()`;

/** 弹窗状态：dialog / 遮罩 + 弹窗子树全部 class token 计数 */
const MODAL_STATE_EXPR = String.raw`(() => {
  const dialog = document.querySelector('[role="dialog"]');
  const overlay = [...document.querySelectorAll('div')].find((element) => String(element.className).includes('bg-black/40'));
  const tokenCounts = {};
  const addTokens = (root) => {
    if (root === null || root === undefined) return;
    for (const element of [root, ...root.querySelectorAll('*')]) {
      const raw = element.getAttribute('class');
      if (raw === null || raw === '') continue;
      for (const token of raw.split(/\s+/)) {
        if (token === '') continue;
        const base = token.includes(':') ? token.slice(token.lastIndexOf(':') + 1) : token;
        const normalized = base.replace(/^!/, '');
        tokenCounts[normalized] = (tokenCounts[normalized] ?? 0) + 1;
      }
    }
  };
  addTokens(overlay);
  addTokens(dialog);
  return {
    dialog: dialog !== null,
    overlay: overlay !== undefined,
    dialogClass: dialog === null ? null : String(dialog.className),
    overlayClass: overlay === undefined ? null : String(overlay.className),
    dialogTitle: dialog === null || dialog.querySelector('h2') === null ? null : (dialog.querySelector('h2').textContent || '').trim(),
    tokenCounts,
  };
})()`;

/** 点开编辑弹窗（只开表单，不保存、不删除数据） */
const CLICK_OPEN_MODAL_EXPR = String.raw`(() => {
  const candidates = ['编辑', '修改', '新增地点', '新增'];
  const buttons = [...document.querySelectorAll('button')].filter((button) => button.offsetParent !== null);
  const texts = buttons.map((button) => (button.textContent || '').trim());
  for (const candidate of candidates) {
    const target = buttons.find((button) => (button.textContent || '').trim() === candidate && !button.disabled);
    if (target !== undefined) {
      target.click();
      return { clicked: true, buttonText: candidate };
    }
  }
  return { clicked: false, buttonText: null, buttonTexts: texts.slice(0, 40) };
})()`;

/** 关闭弹窗（点「关闭 / 取消」，不保存任何数据） */
const CLOSE_MODAL_EXPR = String.raw`(() => {
  const dialog = document.querySelector('[role="dialog"]');
  if (dialog === null) return { closed: false, reason: 'no-dialog' };
  const target = [...dialog.querySelectorAll('button')].find((button) => ['关闭', '取消'].includes((button.textContent || '').trim()));
  if (target === undefined) return { closed: false, reason: 'no-close-button' };
  target.click();
  return { closed: true, buttonText: (target.textContent || '').trim() };
})()`;

/** 活动分区里点「新增活动」按钮 */
const OPEN_NEW_EVENT_EXPR = String.raw`(() => {
  const buttons = [...document.querySelectorAll('button')].filter((button) => button.offsetParent !== null);
  const target = buttons.find((button) => (button.textContent || '').trim() === '新增活动');
  if (target === undefined) return { clicked: false, buttonTexts: buttons.map((button) => (button.textContent || '').trim()) };
  target.click();
  return { clicked: true };
})()`;

/** 活动「新增」弹窗表单控件 dump（地点搜索 / 下拉 / 标题 / 两个 datetime-local / 备注 textarea / 按钮） */
const EVENT_FORM_DUMP_EXPR = String.raw`(() => {
  const dialog = document.querySelector('[role="dialog"]');
  if (dialog === null) return { dialog: false };
  const inputs = [...dialog.querySelectorAll('input')];
  const select = dialog.querySelector('select');
  const textarea = dialog.querySelector('textarea');
  const options = select === null ? [] : [...select.options].map((option) => ({ value: option.value, text: (option.textContent || '').trim() }));
  const searchInput = dialog.querySelector('input[placeholder="按地点名搜索"]');
  const titleInput = dialog.querySelector('input[placeholder="例如：西湖音乐节"]');
  const datetimeInputs = inputs.filter((input) => input.type === 'datetime-local').map((input) => ({ type: input.type, value: input.value }));
  return {
    dialog: true,
    title: dialog.querySelector('h2') === null ? null : (dialog.querySelector('h2').textContent || '').trim(),
    dialogText: (dialog.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 600),
    placeSearch: searchInput === null ? null : { placeholder: searchInput.getAttribute('placeholder'), value: searchInput.value, type: searchInput.type },
    placeSelect: select === null ? null : { optionCount: options.length, selected: select.value, firstOptions: options.slice(0, 4), lastOption: options.length === 0 ? null : options[options.length - 1] },
    titleInput: titleInput === null ? null : { placeholder: titleInput.getAttribute('placeholder'), maxLength: titleInput.maxLength, value: titleInput.value },
    datetimeInputs,
    textarea: textarea === null ? null : { placeholder: textarea.getAttribute('placeholder'), rows: textarea.rows, maxLength: textarea.maxLength, value: textarea.value },
    buttons: [...dialog.querySelectorAll('button')].map((button) => (button.textContent || '').trim()),
  };
})()`;

/** 给「按地点名搜索」输入框赋值（原生 setter + input 事件，React 才能收到） */
function setPlaceSearchExpr(query) {
  return String.raw`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (dialog === null) return { ok: false, reason: 'no-dialog' };
    const input = dialog.querySelector('input[placeholder="按地点名搜索"]');
    if (input === null) return { ok: false, reason: 'no-search-input' };
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(query)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true, value: input.value };
  })()`;
}

/** 读当前弹窗里地点下拉的选项（验证搜索过滤效果） */
const PLACE_OPTIONS_EXPR = String.raw`(() => {
  const dialog = document.querySelector('[role="dialog"]');
  if (dialog === null) return { dialog: false, count: 0, options: [] };
  const select = dialog.querySelector('select');
  if (select === null) return { dialog: true, count: 0, options: [] };
  const options = [...select.options].map((option) => ({ value: option.value, text: (option.textContent || '').trim() }));
  return { dialog: true, count: options.length, options };
})()`;

/** 活动「新增」弹窗专用关闭：优先点「取消」（明确不保存） */
const CANCEL_ACTIVE_DIALOG_EXPR = String.raw`(() => {
  const dialog = document.querySelector('[role="dialog"]');
  if (dialog === null) return { closed: false, reason: 'no-dialog' };
  const buttons = [...dialog.querySelectorAll('button')];
  const target = buttons.find((button) => (button.textContent || '').trim() === '取消') ?? buttons.find((button) => ['关闭'].includes((button.textContent || '').trim()));
  if (target === undefined) return { closed: false, reason: 'no-cancel-button', buttons: buttons.map((button) => (button.textContent || '').trim()) };
  target.click();
  return { closed: true, buttonText: (target.textContent || '').trim() };
})()`;

/** 弹窗内部 gray-* 计数（只看弹窗子树） */
const DIALOG_GRAY_EXPR = String.raw`(() => {
  const dialog = document.querySelector('[role="dialog"]');
  if (dialog === null) return null;
  const html = dialog.outerHTML;
  const matches = html.match(/(?:text|bg|border)-gray-\d{2,3}/g) ?? [];
  return { count: matches.length, classes: [...new Set(matches)] };
})()`;

/** 城市下拉切到目标城市（React 受控 select 必须用原生 setter + change 事件） */
function switchCityExpr(cityId) {
  return String.raw`(() => {
    const targetValue = ${JSON.stringify(cityId)};
    const selects = [...document.querySelectorAll('select')];
    const citySelect = selects.find((select) => [...select.options].some((option) => option.value === targetValue));
    if (citySelect === undefined) {
      return { switched: false, reason: '未找到城市下拉', selects: selects.length, optionValues: selects.map((select) => [...select.options].map((option) => option.value).slice(0, 6)) };
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(citySelect, targetValue);
    citySelect.dispatchEvent(new Event('change', { bubbles: true }));
    return { switched: true, value: citySelect.value };
  })()`;
}

/** 点击顶部分区 tab */
function clickTabExpr(tabText) {
  return String.raw`(() => {
    const targetText = ${JSON.stringify(tabText)};
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    const target = tabs.find((tab) => (tab.textContent || '').trim() === targetText);
    if (target === undefined) {
      return { clicked: false, tabs: tabs.map((tab) => (tab.textContent || '').trim()) };
    }
    target.click();
    return { clicked: true, tab: targetText, beforeSelected: target.getAttribute('aria-selected') };
  })()`;
}

/** 展开「已结束」折叠区（活动状态是 ended 时它在 <details> 里） */
const EXPAND_ENDED_EXPR = String.raw`(() => {
  const details = [...document.querySelectorAll('details')];
  const ended = details.find((item) => String(item.querySelector('summary') === null ? '' : item.querySelector('summary').textContent).includes('已结束'));
  if (ended === undefined) return { expanded: false, detailsCount: details.length };
  ended.open = true;
  return { expanded: true, summary: String(ended.querySelector('summary').textContent || '').trim() };
})()`;

/** 活动分区 DOM 文本 + 可见表格结构化数据 */
const EVENTS_PANEL_EXPR = String.raw`(() => {
  const bodyText = document.body.innerText || '';
  const heading = [...document.querySelectorAll('h2')].find((h2) => (h2.textContent || '').trim() === '活动列表');
  const visibleTables = [...document.querySelectorAll('table')].filter((table) => table.getClientRects().length > 0);
  const tables = visibleTables.map((table) => ({
    inDetails: table.closest('details') !== null,
    headers: [...table.querySelectorAll('thead th')].map((th) => (th.textContent || '').trim()),
    rows: [...table.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => (td.textContent || '').replace(/\s+/g, ' ').trim())),
  }));
  const panelCandidates = heading === undefined
    ? []
    : [...document.querySelectorAll('div')].filter((div) => (div.innerText || '').includes('活动列表') && div.querySelector('table') !== null);
  panelCandidates.sort((left, right) => (left.innerText || '').length - (right.innerText || '').length);
  const panelRoot = panelCandidates.length > 0 ? panelCandidates[0] : (heading === undefined ? null : heading.parentElement);
  return {
    hasEventsHeading: heading !== undefined,
    panelText: panelRoot === null ? '' : (panelRoot.innerText || '').slice(0, 3000),
    bodyText: bodyText.slice(0, 4000),
    tables,
    hasEventTitle: bodyText.includes('话剧《雷雨》'),
    hasEventPlace: bodyText.includes('辽阳大剧院'),
    hasGrayClass: /(^|[\s"'：])(?:text|bg|border)-gray-\d{2,3}/.test(document.documentElement.outerHTML),
  };
})()`;

// ---------------------------------------------------------------- 小工具

function classCount(entries, className) {
  return entries.filter((entry) => entry.cls === className).reduce((sum, entry) => sum + entry.count, 0);
}

function filterByPattern(entries, pattern) {
  return entries.filter((entry) => pattern.test(entry.cls));
}

function topEntries(entries, limit = 15) {
  return [...entries].sort((left, right) => right.count - left.count).slice(0, limit);
}

function rgbToHex(rgb) {
  const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(rgb));
  if (match === null) return null;
  const channel = (value) => Number(value).toString(16).padStart(2, '0');
  return `#${channel(match[1])}${channel(match[2])}${channel(match[3])}`;
}

function describeStyle(style) {
  if (style === null || style === undefined) return '未采样到';
  const colorHex = rgbToHex(style.color);
  const bgHex = rgbToHex(style.backgroundColor);
  return (
    `文字 ${style.color}${colorHex === null ? '' : `（${colorHex}）`}` +
    `，背景 ${style.backgroundColor}${bgHex === null ? '' : `（${bgHex}）`}`
  );
}

/** 一行描述接口里的活动（证据文本用） */
function describeEvent(event) {
  return `${event.id ?? '?'} | ${event.title ?? '?'} | ${event.startAt ?? '?'} ~ ${event.endAt ?? '?'} | status=${event.status ?? '?'}（${EVENT_STATUS_LABELS[event.status] ?? '未知'}）`;
}

/** 等页面 readyState=complete */
async function waitPageReady(cdp, label) {
  return waitForEvaluate(cdp, 'document.readyState', (value) => value === 'complete', 120000, label);
}

// ---------------------------------------------------------------- 主流程

async function main() {
  ensureVerifyDir();
  const generatedAt = new Date().toLocaleString('zh-CN', { hour12: false });
  const evidence = [];
  const reportData = { generatedAt, url: ADMIN_URL, checks: [], screenshots: {}, contrast: [], data: {} };

  // ---------- 0. 数据探活（UI 的数据来源） ----------
  REPORT.section('0. 服务与数据探活');
  const adminPage = await apiGet('/admin', { timeoutMs: 120000 });
  REPORT.assert('控制台页面可访问', adminPage.status === 200, `HTTP ${adminPage.status}，${adminPage.ms} ms`, `HTTP ${adminPage.status}`);

  const placesApi = await apiGet(`/api/admin/places?city=${TARGET_CITY.id}&includeHidden=1`, { timeoutMs: 60000 });
  const placesCount = placesApi.json !== null && Array.isArray(placesApi.json.places) ? placesApi.json.places.length : null;
  const theater = placesApi.json !== null && Array.isArray(placesApi.json.places)
    ? placesApi.json.places.find((place) => place.id === 'B0FFGEKXKE')
    : null;
  REPORT.assert('地点接口可访问', placesApi.status === 200 && placesApi.json?.ok === true, `HTTP ${placesApi.status}，${placesCount} 个地点（辽阳）`, oneLine(placesApi.text, 300));
  REPORT.info(`辽阳大剧院：${theater === null ? '未找到' : `importance=${theater.importance}，category=${theater.category}，${theater.openTime}-${theater.closeTime}`}`);
  reportData.data.placesTotal = placesCount;
  reportData.data.theater = theater === null ? null : { id: theater.id, name: theater.name, importance: theater.importance };

  const eventsApi = await apiGet(`/api/admin/events?city=${TARGET_CITY.id}`, { timeoutMs: 60000 });
  const events = eventsApi.json !== null && Array.isArray(eventsApi.json.events) ? eventsApi.json.events : [];
  const targetEvent = events.find((event) => event.title === TARGET_EVENT.title) ?? null;
  REPORT.assert('活动接口可访问', eventsApi.status === 200 && eventsApi.json?.ok === true, `HTTP ${eventsApi.status}，辽阳 ${events.length} 条活动`, oneLine(eventsApi.text, 300));
  REPORT.info(
    targetEvent === null
      ? `没有找到活动「${TARGET_EVENT.title}」`
      : `活动「${targetEvent.title}」placeId=${targetEvent.placeId} ${targetEvent.startAt} ~ ${targetEvent.endAt}，status=${targetEvent.status}（服务端按真实时间算）`,
  );
  reportData.data.events = events;

  // ---------- 1. 打开浏览器：/admin 地点分区 ----------
  REPORT.section('1. 真实浏览器加载 /admin');
  const launched = await launchEdge();
  let cdp = null;
  let consoleCollector = null;
  let placesColorData = null;
  let eventsState = null;
  try {
    cdp = await connectPage(launched.port, { label: 'admin' }).then(({ cdp: client }) => client);
    consoleCollector = createConsoleCollector(cdp);
    await cdp.send('Page.navigate', { url: ADMIN_URL });
    try {
      await cdp.send('Page.bringToFront');
    } catch {
      /* 无头模式可忽略 */
    }

    const readyState = await waitPageReady(cdp, '/admin 页面加载完成（readyState=complete）');
    REPORT.pass('页面加载完成', `readyState=${readyState}，URL=${await cdp.evaluate('location.href')}`);

    // 等地点列表加载：出现「名称 / 类目」表头或「共 N 个地点」
    let state = null;
    try {
      state = await waitForEvaluate(
        cdp,
        PAGE_STATE_EXPR,
        (value) => value.readyState === 'complete' && value.hasTable && value.headers.includes('名称') && value.headers.includes('类目') && (value.totalText !== null || value.rows >= 2),
        90000,
        '/admin 地点列表加载完成（名称/类目表头 + 共 N 个地点）',
      );
    } catch (error) {
      REPORT.fail('地点列表加载', `90 秒内没有出现名称/类目表头和地点列表：${error.message}`);
    }
    await sleep(1500);
    await cdp.evaluate('window.scrollTo(0, 0)');
    state = await cdp.evaluate(PAGE_STATE_EXPR);
    REPORT.assert(
      '地点列表已加载（默认城市）',
      state.hasTable && state.headers.includes('名称') && state.headers.includes('类目') && (state.totalText !== null || state.rows >= 2),
      `${state.rows} 行，${state.totalText ?? '未找到总数文案'}`,
      `${state.rows} 行，正文摘要：${oneLine(state.bodyText, 200)}`,
    );
    REPORT.info(`默认城市地点表头：${state.headers.join(' / ')}`);

    // 截图前先切到辽阳（验收数据集中在辽阳；地点表里能看到大剧院的重要性星）
    const citySwitch = await cdp.evaluate(switchCityExpr(TARGET_CITY.id));
    REPORT.assert('城市下拉切到辽阳', citySwitch.switched === true, `select.value=${citySwitch.value}`, `切换失败：${JSON.stringify(citySwitch)}`);
    try {
      await waitForEvaluate(cdp, PAGE_STATE_EXPR, (value) => value.totalText !== null && value.totalText.includes('141'), 30000, '地点列表切换到辽阳（共 141 个地点）');
      REPORT.pass('地点列表已切到辽阳', '共 141 个地点');
    } catch (error) {
      REPORT.fail('地点列表切到辽阳', `30 秒内总数文案没有变成「共 141 个地点」：${error.message}`);
    }
    await sleep(1200);
    await cdp.evaluate('window.scrollTo(0, 0)');
    state = await cdp.evaluate(PAGE_STATE_EXPR);

    // 地点表的「重要性」列 + 大剧院行（importance=5，应是 5 颗实心星）
    const placesDetail = await cdp.evaluate(String.raw`(() => {
      const row = [...document.querySelectorAll('tbody tr')].find((tr) => (tr.textContent || '').includes('辽阳大剧院'));
      const starButtons = row === undefined ? [] : [...row.querySelectorAll('button[aria-label^="设为 "]')];
      return {
        headers: [...document.querySelectorAll('thead th')].map((th) => (th.textContent || '').trim()),
        theaterRow: row === undefined ? null : {
          text: (row.innerText || '').replace(/\s+/g, ' ').trim(),
          starLabels: starButtons.map((button) => button.getAttribute('aria-label')),
          filledStars: row.querySelectorAll('button[aria-label^="设为 "] svg[fill="currentColor"]').length,
        },
      };
    })()`);
    REPORT.info(`辽阳地点表头：${placesDetail.headers.join(' / ')}`);
    REPORT.assert('地点表有「重要性」列', placesDetail.headers.includes('重要性'), '表头含「重要性」', `表头：${placesDetail.headers.join(' / ')}`);
    const theaterStars = placesDetail.theaterRow === null ? [] : placesDetail.theaterRow.starLabels;
    const theaterFilled = placesDetail.theaterRow === null ? 0 : placesDetail.theaterRow.filledStars;
    REPORT.assert(
      '辽阳大剧院行显示 5 星',
      placesDetail.theaterRow !== null && theaterStars.includes('设为 5 星') && theaterFilled === 5,
      `行走标按钮：${theaterStars.join('，')}；实心星 ${theaterFilled} 颗`,
      `行走标按钮：${theaterStars.join('，')}；实心星 ${theaterFilled} 颗（应为 5 颗）`,
    );
    reportData.data.placesHeaders = placesDetail.headers;
    reportData.data.theaterRow = placesDetail.theaterRow;

    const placesShot = await screenshot(cdp, 'admin-places.png');
    reportData.screenshots.places = placesShot.path;

    // ---------- 2. 地点分区配色统计 ----------
    REPORT.section('2. 地点分区配色统计（gray-* 必须为 0）');
    placesColorData = await cdp.evaluate(COLLECT_COLOR_CLASSES_EXPR);
    const placesEntries = Array.isArray(placesColorData.entries) ? placesColorData.entries : [];
    const placesGray = filterByPattern(placesEntries, /^(text|bg|border)-gray(?:-\d{2,3})?(?:\/\d+)?$/);
    const placesGrayTotal = placesColorData.families?.gray ?? 0;
    const placesNeutralOther = (placesColorData.families?.slate ?? 0) + (placesColorData.families?.zinc ?? 0) + (placesColorData.families?.neutral ?? 0);
    REPORT.info(`DOM 元素 ${placesColorData.elementCount} 个；色阶类 ${placesEntries.length} 种；gray-* 共 ${placesGrayTotal} 次（text/bg/border ${placesGray.reduce((sum, item) => sum + item.count, 0)} 处）`);
    if (placesGray.length > 0) REPORT.info(`gray 明细：${placesGray.map((item) => `${item.cls} x${item.count}`).join('，')}`);

    const grayPass = REPORT.assert(
      'gray-* 类计数为 0',
      placesGray.length === 0,
      '页面里 text-gray-* / bg-gray-* / border-gray-* 出现 0 处',
      `仍存在 gray 类：${placesGray.map((item) => `${item.cls} x${item.count}`).join('，')}`,
    );
    reportData.checks.push({ name: 'gray-zero', pass: grayPass, detail: placesGray });
    REPORT.assert('没有 slate-* / zinc-* / neutral-*', placesNeutralOther === 0, '0 处', `出现 ${placesNeutralOther} 处非 stone 灰阶`);

    const stoneCounts = {};
    for (const className of REQUIRED_STONE_CLASSES) {
      const count = classCount(placesEntries, className);
      stoneCounts[className] = count;
      const pass = REPORT.assert(`存在 ${className}`, count > 0, `${count} 处`, `页面里没有出现 ${className}`);
      reportData.checks.push({ name: `required-${className}`, pass, detail: count });
    }
    const hardcoded = Array.isArray(placesColorData.hardcoded) ? placesColorData.hardcoded : [];
    REPORT.assert('没有硬编码颜色类', hardcoded.length === 0, '0 种', `发现：${hardcoded.map((item) => item.cls).join('，')}`);

    // ---------- 3. 编辑弹窗配色 ----------
    REPORT.section('3. 编辑弹窗配色（bg-black/40 / bg-white / shadow-lg）');
    const clickResult = await cdp.evaluate(CLICK_OPEN_MODAL_EXPR);
    REPORT.info(`地点分区可见按钮文本：${(clickResult.buttonTexts ?? []).join(' / ')}`);
    let modalState = { dialog: false, overlay: false, dialogClass: null, overlayClass: null, dialogTitle: null, tokenCounts: {} };
    let modalShot = null;
    if (clickResult.clicked) {
      try {
        modalState = await waitForEvaluate(cdp, MODAL_STATE_EXPR, (value) => value.dialog || value.overlay, 15000, '编辑弹窗出现');
        await sleep(400);
        modalShot = await screenshot(cdp, 'admin-modal.png');
        reportData.screenshots.modal = modalShot.path;
        REPORT.info(`已点击「${clickResult.buttonText}」打开弹窗：${modalState.dialogTitle ?? '(无标题)'}`);
      } catch (error) {
        REPORT.fail('编辑弹窗出现', `点击「${clickResult.buttonText}」后弹窗没有出现：${error.message}`);
      }
      const closeResult = await cdp.evaluate(CLOSE_MODAL_EXPR);
      REPORT.info(`弹窗关闭：${closeResult.closed ? `已点「${closeResult.buttonText}」` : `未关闭（${closeResult.reason}）`}`);
      await sleep(400);
    } else {
      REPORT.fail('编辑弹窗出现', `页面没有「编辑 / 修改 / 新增地点」按钮：${(clickResult.buttonTexts ?? []).join(' / ')}`);
    }

    const modalCounts = {};
    for (const className of REQUIRED_MODAL_CLASSES) {
      const count = modalState.tokenCounts?.[className] ?? 0;
      modalCounts[className] = count;
      if (!clickResult.clicked) {
        REPORT.skip(`弹窗类 ${className}`, '弹窗未打开，按任务书只检查列表/表格');
        continue;
      }
      const pass = REPORT.assert(`弹窗类 ${className}`, count > 0, `${count} 处`, `弹窗里没有 ${className}`);
      reportData.checks.push({ name: `modal-${className}`, pass, detail: count });
    }

    // ---------- 4. WCAG 对比度 ----------
    REPORT.section('4. WCAG 对比度（tailwind 规范色值）');
    const contrastItems = [
      contrastLine('正文 stone-800 / 白底', STONE[800], WHITE, 7, '> 7'),
      contrastLine('次要文字 stone-500 / 白底', STONE[500], WHITE, 4.5, '>= 4.5'),
      contrastLine('次要文字 stone-600 / 白底', STONE[600], WHITE, 4.5, '>= 4.5'),
      contrastLine('正文 stone-800 / stone-50 底', STONE[800], STONE[50], 7, '> 7'),
      contrastLine('表头 stone-600 / stone-50 底', STONE[600], STONE[50], 4.5, '>= 4.5'),
    ];
    for (const item of contrastItems) {
      console.log(`  ${item.text}`);
      reportData.contrast.push({ label: item.label, fg: item.foreground, bg: item.background, ratio: Number(item.ratio.toFixed(2)), minimum: item.minimum, pass: item.pass });
      REPORT.assert(`对比度：${item.label}`, item.pass, `${item.ratio.toFixed(2)}:1（要求 ${item.minimum}）`, `${item.ratio.toFixed(2)}:1 不满足 ${item.minimum}`);
    }

    // ---------- 5. 实际计算样式 ----------
    REPORT.section('5. 实际计算样式（getComputedStyle）');
    const styles = await cdp.evaluate(STYLE_SAMPLES_EXPR);
    console.log(`  main：${describeStyle(styles.main)}`);
    console.log(`  thead：${describeStyle(styles.thead)}`);
    console.log(`  tbody 第一行：${describeStyle(styles.tbodyFirstRow)}`);
    console.log(`  .text-stone-800 元素：${describeStyle(styles.samplesByClass?.['text-stone-800'])}`);
    console.log(`  .text-stone-500 元素：${describeStyle(styles.samplesByClass?.['text-stone-500'])}`);
    const checks = [
      ['bg-stone-50', 'backgroundColor', STONE[50], '背景'],
      ['text-stone-600', 'color', STONE[600], '文字颜色'],
      ['text-stone-500', 'color', STONE[500], '文字颜色'],
      ['border-stone-200', 'borderTopColor', STONE[200], '边框色'],
    ];
    for (const [className, property, expected, label] of checks) {
      const style = styles.samplesByClass?.[className];
      const actualHex = rgbToHex(style?.[property] ?? '');
      const pass = REPORT.assert(
        `${className} 实际渲染 ${expected}`,
        actualHex === expected,
        `${label} ${style?.[property]}（${actualHex}）`,
        `${label} ${style?.[property]}（${actualHex}），不是 ${expected}`,
      );
      reportData.checks.push({ name: `computed-${className}`, pass, detail: actualHex });
    }

    // ---------- 6. 活动分区 ----------
    REPORT.section('6. 活动分区（城市已是辽阳，点 tab「活动」）');
    // 地点列表在前面已经切到辽阳，这里只切分区 tab。
    const tabClick = await cdp.evaluate(clickTabExpr('活动'));
    REPORT.assert('点击顶部 tab「活动」', tabClick.clicked === true, `tab 存在（点击前 aria-selected=${tabClick.beforeSelected}）`, `没找到「活动」tab：${JSON.stringify(tabClick.tabs)}`);

    // 等活动列表加载：出现「话剧《雷雨》」或「已结束」折叠区
    try {
      await waitForEvaluate(
        cdp,
        `(() => {
          const text = document.body.innerText || '';
          return { hasTitle: text.includes(${JSON.stringify(TARGET_EVENT.title)}), hasEnded: text.includes('已结束'), hasEmpty: text.includes('暂无活动'), hasHeading: text.includes('活动列表') };
        })()`,
        (value) => value.hasHeading && (value.hasTitle || value.hasEnded || value.hasEmpty),
        30000,
        '活动列表加载完成（活动列表标题 + 事件或已结束折叠区）',
      );
      REPORT.pass('活动列表加载完成', '活动分区出现「活动列表」，并已收到活动数据');
    } catch (error) {
      REPORT.fail('活动列表加载', `30 秒内活动列表没有加载完成：${error.message}`);
    }

    // 活动已结束时会折叠在 <details> 里：展开后再采样
    const expandResult = await cdp.evaluate(EXPAND_ENDED_EXPR);
    REPORT.info(`已结束折叠区：${expandResult.expanded ? `已展开（${expandResult.summary}）` : '不存在（活动未结束或仍在进行中）'}`);
    await sleep(600);

    eventsState = await cdp.evaluate(EVENTS_PANEL_EXPR);
    await cdp.evaluate('window.scrollTo(0, 0)');
    const eventsShot = await screenshot(cdp, EVENTS_SHOT_NAME);
    reportData.screenshots.events = eventsShot.path;

    const activeTables = eventsState.tables.filter((table) => !table.inDetails);
    const endedTables = eventsState.tables.filter((table) => table.inDetails);
    const activeRows = activeTables.flatMap((table) => table.rows);
    const endedRows = endedTables.flatMap((table) => table.rows);

    const dumpLines = [];
    dumpLines.push(`活动分区 DOM 文本（${ADMIN_URL}，城市=辽阳，tab=活动）`);
    dumpLines.push(`截图：${eventsShot.path}`);
    dumpLines.push(`已结束折叠区：${expandResult.expanded ? `已展开（${expandResult.summary}）` : '未出现（没有已结束活动）'}`);
    dumpLines.push('');
    dumpLines.push('[未开始 / 进行中 区域]');
    for (const table of activeTables) {
      dumpLines.push(`表头：${table.headers.join(' | ')}`);
      for (const row of table.rows) dumpLines.push(`行：${row.join(' | ')}`);
    }
    if (activeRows.length === 0) dumpLines.push('(无数据行)');
    dumpLines.push('');
    dumpLines.push('[已结束折叠区（已展开）]');
    for (const table of endedTables) {
      dumpLines.push(`表头：${table.headers.join(' | ')}`);
      for (const row of table.rows) dumpLines.push(`行：${row.join(' | ')}`);
    }
    if (endedRows.length === 0) dumpLines.push('(无数据行)');
    dumpLines.push('');
    dumpLines.push('[活动 tab 页面 innerText]');
    dumpLines.push(eventsState.bodyText);
    const dumpText = dumpLines.join('\n');
    const eventsTextPath = writeArtifact(EVENTS_TEXT_NAME, `${dumpText}\n`);
    const eventsLines = dumpText.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
    console.log('  活动分区 DOM 文本：');
    for (const line of eventsLines) console.log(`    ${line}`);
    console.log(`  [evidence] 活动分区文本已保存：${eventsTextPath}`);

    // 逐条用接口数据（服务端算好的 status）对页面上两张表做匹配
    const activeExpected = events.filter((event) => event.status !== 'ended');
    const endedExpected = events.filter((event) => event.status === 'ended');
    const matchesEventRow = (row, event) => {
      const text = row.join(' ');
      return (
        text.includes(event.title) &&
        text.includes(formatEventTime(event.startAt)) &&
        text.includes(formatEventTime(event.endAt)) &&
        text.includes(EVENT_STATUS_LABELS[event.status])
      );
    };
    for (const event of activeExpected) {
      const label = EVENT_STATUS_LABELS[event.status];
      const pass = REPORT.assert(
        `未开始/进行中区域：${event.title}（${label} ${formatEventTime(event.startAt)} ~ ${formatEventTime(event.endAt)}）`,
        activeRows.some((row) => matchesEventRow(row, event)),
        `命中行：${activeRows.filter((row) => matchesEventRow(row, event)).map((row) => row.join(' | ')).join(' || ')}`,
        `没有匹配行；接口数据：${describeEvent(event)}；页面实际行：${activeRows.map((row) => row.join(' | ')).join(' || ') || '(空)'}`,
      );
      reportData.checks.push({ name: `events-active-${event.id}`, pass, detail: label });
    }
    for (const event of endedExpected) {
      const pass = REPORT.assert(
        `已结束折叠区：${event.title}（${formatEventTime(event.startAt)} ~ ${formatEventTime(event.endAt)}，已结束）`,
        endedRows.some((row) => matchesEventRow(row, event)),
        `命中行：${endedRows.filter((row) => matchesEventRow(row, event)).map((row) => row.join(' | ')).join(' || ')}`,
        `没有匹配行；接口数据：${describeEvent(event)}；页面实际行：${endedRows.map((row) => row.join(' | ')).join(' || ') || '(空)'}`,
      );
      reportData.checks.push({ name: `events-ended-${event.id}`, pass, detail: '已结束' });
    }
    REPORT.assert(
      '未开始/进行中区与已结束区互不串台',
      activeRows.every((row) => !row.join(' ').includes('已结束')) && endedRows.every((row) => row.join(' ').includes('已结束')),
      `未开始/进行中 ${activeRows.length} 行，已结束 ${endedRows.length} 行`,
      `串台：未开始区出现「已结束」=${activeRows.some((row) => row.join(' ').includes('已结束'))}；已结束区缺「已结束」=${endedRows.some((row) => !row.join(' ').includes('已结束'))}`,
    );
    reportData.eventsPanel = { text: eventsState.bodyText, tables: eventsState.tables, activeRows, endedRows, activeExpected, endedExpected, lines: eventsLines };

    // 活动分区也不许出现 gray-*
    const eventsColorData = await cdp.evaluate(COLLECT_COLOR_CLASSES_EXPR);
    const eventsGray = filterByPattern(eventsColorData.entries ?? [], /^(text|bg|border)-gray(?:-\d{2,3})?(?:\/\d+)?$/);
    REPORT.assert(
      '活动分区 gray-* 为 0',
      eventsGray.length === 0,
      '活动分区里 text-gray-* / bg-gray-* / border-gray-* 出现 0 处',
      `仍存在 gray 类：${eventsGray.map((item) => `${item.cls} x${item.count}`).join('，')}`,
    );
    reportData.eventsColorFamilies = eventsColorData.families;

    // ---------- 7. 活动「新增」弹窗（表单证据） ----------
    REPORT.section('7. 活动新增弹窗（新增活动表单）');
    const openNew = await cdp.evaluate(OPEN_NEW_EVENT_EXPR);
    REPORT.assert('点击「新增活动」', openNew.clicked === true, '已点击', `没找到「新增活动」按钮：${JSON.stringify(openNew.buttonTexts ?? [])}`);
    let formState = null;
    let newEventShot = null;
    let newDialogClasses = null;
    let searchFilter = null;
    if (openNew.clicked) {
      try {
        formState = await waitForEvaluate(
          cdp,
          EVENT_FORM_DUMP_EXPR,
          (value) => value.dialog === true && value.title === '新增活动' && value.placeSelect !== null && value.placeSelect.optionCount > 1,
          30000,
          '新增活动弹窗出现且地点下拉已加载',
        );
      } catch (error) {
        REPORT.fail('新增活动弹窗出现', `30 秒内弹窗 / 地点下拉没有就绪：${error.message}`);
        formState = await cdp.evaluate(EVENT_FORM_DUMP_EXPR).catch(() => null);
      }
      await sleep(600);
      newEventShot = await screenshot(cdp, NEW_EVENT_SHOT_NAME);
      reportData.screenshots.newEvent = newEventShot.path;
      newDialogClasses = await cdp.evaluate(MODAL_STATE_EXPR).catch(() => null);
      const dialogGray = await cdp.evaluate(DIALOG_GRAY_EXPR).catch(() => null);
      reportData.newEventDialog = { form: formState, classes: newDialogClasses, gray: dialogGray };

      if (formState !== null && formState.dialog === true) {
        console.log('  新增活动弹窗表单控件：');
        console.log(`    标题：${formState.title}`);
        console.log(`    地点搜索输入框：${formState.placeSearch === null ? '(无)' : `placeholder=「${formState.placeSearch.placeholder}」`}`);
        console.log(`    地点下拉：${formState.placeSelect === null ? '(无)' : `${formState.placeSelect.optionCount} 个选项；前 4 个=${formState.placeSelect.firstOptions.map((option) => option.text).join(' / ')}`}`);
        console.log(`    标题输入框：${formState.titleInput === null ? '(无)' : `placeholder=「${formState.titleInput.placeholder}」，maxLength=${formState.titleInput.maxLength}`}`);
        console.log(`    开始/结束输入：${formState.datetimeInputs.map((input) => `${input.type}=「${input.value || '空'}」`).join('，')}`);
        console.log(`    备注 textarea：${formState.textarea === null ? '(无)' : `placeholder=「${formState.textarea.placeholder}」，rows=${formState.textarea.rows}，maxLength=${formState.textarea.maxLength}`}`);
        console.log(`    按钮：${formState.buttons.join(' / ')}`);

        REPORT.assert('弹窗标题是「新增活动」', formState.title === '新增活动', formState.title, formState.title);
        REPORT.assert('地点搜索输入框存在', formState.placeSearch !== null && formState.placeSearch.placeholder === '按地点名搜索', `placeholder=「${formState.placeSearch?.placeholder}」`, '没有「按地点名搜索」输入框');
        REPORT.assert('地点下拉已加载该城市地点', formState.placeSelect !== null && formState.placeSelect.optionCount > 1, `${formState.placeSelect?.optionCount} 个选项（含「请选择地点」占位）`, `${formState.placeSelect?.optionCount ?? 0} 个选项`);
        REPORT.assert('标题输入框存在', formState.titleInput !== null && formState.titleInput.maxLength === 120, `placeholder=「${formState.titleInput?.placeholder}」，maxLength=${formState.titleInput?.maxLength}`, '没有标题输入框');
        REPORT.assert(
          '开始/结束是 2 个 datetime-local 输入',
          formState.datetimeInputs.length === 2 && formState.datetimeInputs.every((input) => input.type === 'datetime-local'),
          `初始值：${formState.datetimeInputs.map((input) => input.value || '(空)').join(' / ')}`,
          `datetime-local 数量=${formState.datetimeInputs.length}`,
        );
        REPORT.assert('备注 textarea 存在', formState.textarea !== null && formState.textarea.rows === 3 && formState.textarea.maxLength === 500, `placeholder=「${formState.textarea?.placeholder}」，rows=${formState.textarea?.rows}，maxLength=${formState.textarea?.maxLength}`, '没有备注 textarea');
        REPORT.assert('有「取消 / 保存」按钮', formState.buttons.includes('取消') && formState.buttons.includes('保存'), `按钮：${formState.buttons.join(' / ')}`, `按钮：${formState.buttons.join(' / ')}`);

        // 验证下拉可搜索：输入「大剧院」后选项应被过滤且包含辽阳大剧院
        const beforeOptions = await cdp.evaluate(PLACE_OPTIONS_EXPR);
        const setSearch = await cdp.evaluate(setPlaceSearchExpr('大剧院'));
        await sleep(500);
        const afterOptions = await cdp.evaluate(PLACE_OPTIONS_EXPR);
        searchFilter = { before: beforeOptions.count, after: afterOptions.count, hasTheater: afterOptions.options.some((option) => option.text.includes('辽阳大剧院')) };
        REPORT.assert(
          '地点下拉可按名称搜索（输入「大剧院」后被过滤）',
          setSearch.ok === true && afterOptions.count < beforeOptions.count && searchFilter.hasTheater,
          `过滤前 ${searchFilter.before} 个选项 → 过滤后 ${searchFilter.after} 个，含「辽阳大剧院」`,
          `过滤前 ${searchFilter.before} 个 → 过滤后 ${searchFilter.after} 个，含辽阳大剧院=${searchFilter.hasTheater}`,
        );

        // 弹窗配色（遮罩 bg-black/40 / 本体 bg-white + shadow-lg / 内部无 gray-*）
        const modalCountsNew = newDialogClasses === null ? {} : newDialogClasses.tokenCounts ?? {};
        REPORT.assert('新增活动弹窗遮罩 bg-black/40', (modalCountsNew['bg-black/40'] ?? 0) > 0, `${modalCountsNew['bg-black/40'] ?? 0} 处`, '没有 bg-black/40');
        REPORT.assert(
          '新增活动弹窗本体 bg-white + shadow-lg',
          (modalCountsNew['bg-white'] ?? 0) > 0 && (modalCountsNew['shadow-lg'] ?? 0) > 0,
          `bg-white ${modalCountsNew['bg-white'] ?? 0} 处，shadow-lg ${modalCountsNew['shadow-lg'] ?? 0} 处`,
          `bg-white ${modalCountsNew['bg-white'] ?? 0} 处，shadow-lg ${modalCountsNew['shadow-lg'] ?? 0} 处`,
        );
        REPORT.assert('新增活动弹窗内没有 gray-*', dialogGray !== null && dialogGray.count === 0, 'gray-* 0 处', `dialog 内 gray-* ${dialogGray?.count ?? '(未采样)'} 处：${(dialogGray?.classes ?? []).join('，')}`);

        // dump 存文件（可直接贴进报告）
        const dumpLines2 = [];
        dumpLines2.push(`活动「新增」弹窗（${ADMIN_URL}，城市=辽阳，tab=活动 →「新增活动」）`);
        dumpLines2.push(`截图：${newEventShot.path}`);
        dumpLines2.push(`弹窗标题：${formState.title}`);
        dumpLines2.push(`弹窗文本：${formState.dialogText}`);
        dumpLines2.push(`地点搜索输入框：${formState.placeSearch === null ? '(无)' : `placeholder=「${formState.placeSearch.placeholder}」`}`);
        dumpLines2.push(`地点下拉：${formState.placeSelect?.optionCount ?? 0} 个选项（含「请选择地点」占位）`);
        dumpLines2.push(`  前 4 个选项：${(formState.placeSelect?.firstOptions ?? []).map((option) => option.text).join(' / ')}`);
        dumpLines2.push(`  最后一个选项：${formState.placeSelect?.lastOption?.text ?? '(无)'}`);
        dumpLines2.push(`搜索「大剧院」过滤：${searchFilter.before} → ${searchFilter.after} 个选项，含辽阳大剧院=${searchFilter.hasTheater}`);
        dumpLines2.push(`标题输入框：placeholder=「${formState.titleInput?.placeholder ?? '(无)'}」，maxLength=${formState.titleInput?.maxLength ?? '(无)'}`);
        dumpLines2.push(`开始/结束：${formState.datetimeInputs.map((input) => `${input.type}（初始值「${input.value || '空'}」）`).join('，')}`);
        dumpLines2.push(`备注 textarea：placeholder=「${formState.textarea?.placeholder ?? '(无)'}」，rows=${formState.textarea?.rows ?? '(无)'}，maxLength=${formState.textarea?.maxLength ?? '(无)'}`);
        dumpLines2.push(`按钮：${formState.buttons.join(' / ')}`);
        dumpLines2.push(`弹窗类计数：bg-black/40=${modalCountsNew['bg-black/40'] ?? 0}，bg-white=${modalCountsNew['bg-white'] ?? 0}，shadow-lg=${modalCountsNew['shadow-lg'] ?? 0}；弹窗内 gray-*=${dialogGray?.count ?? '(未采样)'}`);
        const newEventTextPath = writeArtifact(NEW_EVENT_TEXT_NAME, `${dumpLines2.join('\n')}\n`);
        console.log(`  [evidence] 新增活动弹窗文本已保存：${newEventTextPath}`);
        reportData.newEventDialog = { form: formState, classes: newDialogClasses, gray: dialogGray, searchFilter, textPath: newEventTextPath, shotPath: newEventShot.path };

        // 点「取消」关闭（不保存任何数据）
        const cancelResult = await cdp.evaluate(CANCEL_ACTIVE_DIALOG_EXPR);
        REPORT.assert('点「取消」关闭弹窗（不保存）', cancelResult.closed === true, `已点「${cancelResult.buttonText}」`, `关闭失败：${JSON.stringify(cancelResult)}`);
        try {
          await waitForEvaluate(cdp, `document.querySelector('[role="dialog"]') === null`, (value) => value === true, 10000, '弹窗关闭');
          REPORT.pass('弹窗已关闭', '[role="dialog"] 已消失');
        } catch (error) {
          REPORT.fail('弹窗已关闭', `10 秒内弹窗没有关闭：${error.message}`);
        }
        // 确认没有保存任何数据（活动条数不变）
        const eventsAfter = await apiGet(`/api/admin/events?city=${TARGET_CITY.id}`, { timeoutMs: 60000 });
        const totalAfter = eventsAfter.json !== null && typeof eventsAfter.json.total === 'number' ? eventsAfter.json.total : null;
        REPORT.assert('没有保存任何数据（活动条数不变）', totalAfter === events.length, `活动仍为 ${totalAfter} 条（操作前 ${events.length} 条）`, `活动从 ${events.length} 条变成 ${totalAfter} 条`);
      }
    }

    // ---------- 8. 配色证据（可直接贴进报告） ----------
    REPORT.section('8. 配色证据');
    const stoneTop = topEntries(placesEntries.filter((entry) => entry.cls.includes('-stone-') || entry.cls.startsWith('bg-stone')), 15);
    evidence.push('配色证据（控制台 /admin）');
    evidence.push(`生成时间：${generatedAt}`);
    evidence.push(`页面：${ADMIN_URL}（headless Edge CDP，视口 1280x900）`);
    evidence.push('');
    evidence.push('一、截图');
    evidence.push(`- 地点分区：${reportData.screenshots.places}`);
    evidence.push(`- 活动分区：${reportData.screenshots.events}`);
    evidence.push(`- 编辑弹窗：${reportData.screenshots.modal ?? '（未打开）'}`);
    evidence.push('');
    evidence.push('二、页面实际出现的 stone 色阶类（地点分区，按次数降序；hover:/focus: 等变体已折算到基础类）');
    evidence.push(stoneTop.map((entry) => `- ${entry.cls}：${entry.count} 处`).join('\n'));
    evidence.push('');
    evidence.push('三、禁用色阶（必须为 0）');
    evidence.push(`- text-gray-* / bg-gray-* / border-gray-*：${placesGray.reduce((sum, item) => sum + item.count, 0)} 处${placesGray.length === 0 ? '（无）' : `：${placesGray.map((item) => `${item.cls} x${item.count}`).join('，')}`}`);
    evidence.push(`- slate-/zinc-/neutral-*：${placesNeutralOther} 处`);
    evidence.push(`- 活动分区 gray-*：${eventsGray.reduce((sum, item) => sum + item.count, 0)} 处`);
    evidence.push('');
    evidence.push('四、规则类命中（必须出现）');
    for (const className of REQUIRED_STONE_CLASSES) {
      evidence.push(`- ${className}：${stoneCounts[className]} 处${stoneCounts[className] > 0 ? '（满足）' : '（缺失）'}`);
    }
    for (const className of REQUIRED_MODAL_CLASSES) {
      evidence.push(`- ${className}（编辑弹窗）：${modalCounts[className]} 处${modalCounts[className] > 0 ? '（满足）' : '（缺失）'}`);
    }
    evidence.push('');
    evidence.push('五、WCAG 对比度（tailwind 规范色值，白底 #ffffff / stone-50 #fafaf9）');
    evidence.push(`- 正文 stone-800 #292524 对白底 #ffffff = ${contrastItems[0].ratio.toFixed(2)}:1（要求 > 7，AAA 正文）`);
    evidence.push(`- 次要文字 stone-500 #78716c 对白底 #ffffff = ${contrastItems[1].ratio.toFixed(2)}:1（要求 >= 4.5，AA 正文）`);
    evidence.push(`- 次要文字 stone-600 #57534e 对白底 #ffffff = ${contrastItems[2].ratio.toFixed(2)}:1（要求 >= 4.5）`);
    evidence.push(`- 正文 stone-800 对 stone-50 底 = ${contrastItems[3].ratio.toFixed(2)}:1（要求 > 7）`);
    evidence.push(`- 表头 stone-600 对 stone-50 底 = ${contrastItems[4].ratio.toFixed(2)}:1（要求 >= 4.5）`);
    evidence.push('');
    evidence.push('六、实际计算样式（浏览器真实渲染值）');
    evidence.push(`- main：${describeStyle(styles.main)}`);
    evidence.push(`- thead：${describeStyle(styles.thead)}`);
    evidence.push(`- .bg-stone-50 元素：${describeStyle(styles.samplesByClass?.['bg-stone-50'])}`);
    evidence.push(`- .text-stone-600 元素：${describeStyle(styles.samplesByClass?.['text-stone-600'])}`);
    evidence.push(`- .text-stone-500 元素：${describeStyle(styles.samplesByClass?.['text-stone-500'])}`);
    evidence.push('');
    evidence.push('七、地点分区（辽阳，importance 星级列）');
    evidence.push(`- 城市：辽阳，共 141 个地点；地点表头：${placesDetail.headers.join(' / ')}`);
    evidence.push(`- 辽阳大剧院行：${placesDetail.theaterRow === null ? '(未找到)' : placesDetail.theaterRow.text}`);
    evidence.push(`- 辽阳大剧院星级按钮：${placesDetail.theaterRow === null ? '(无)' : (placesDetail.theaterRow.starLabels.join('，') || '(无)')}`);
    evidence.push(`- 辽阳大剧院实心星：${placesDetail.theaterRow === null ? 0 : placesDetail.theaterRow.filledStars} 颗（importance=5）`);
    evidence.push('');
    evidence.push('八、活动分区（切到辽阳 + tab「活动」）');
    evidence.push(`- 接口数据：${events.map((event) => describeEvent(event)).join('；') || '(空)'}`);
    evidence.push(`- 未开始/进行中区域行：${activeRows.map((row) => row.join(' | ')).join(' || ') || '(空)'}`);
    evidence.push(`- 已结束折叠区行：${endedRows.map((row) => row.join(' | ')).join(' || ') || '(空)'}`);
    for (const event of activeExpected) {
      evidence.push(`- 未开始/进行中 命中：${event.title}（${EVENT_STATUS_LABELS[event.status]} ${formatEventTime(event.startAt)} ~ ${formatEventTime(event.endAt)}）= ${activeRows.some((row) => matchesEventRow(row, event))}`);
    }
    for (const event of endedExpected) {
      evidence.push(`- 已结束折叠区 命中：${event.title}（${formatEventTime(event.startAt)} ~ ${formatEventTime(event.endAt)}）= ${endedRows.some((row) => matchesEventRow(row, event))}`);
    }
    evidence.push(`- 已结束折叠区：${expandResult.expanded ? `已展开（${expandResult.summary}）` : '未出现（没有已结束活动）'}`);
    evidence.push('');
    evidence.push('九、活动「新增」弹窗（新增活动表单）');
    const formEvidence = reportData.newEventDialog;
    if (formEvidence === undefined || formEvidence === null || formEvidence.form === null || formEvidence.form === undefined || formEvidence.form.dialog !== true) {
      evidence.push('- 弹窗未成功打开（见 FAIL 项）');
    } else {
      const form = formEvidence.form;
      const counts = formEvidence.classes === null || formEvidence.classes === undefined ? {} : formEvidence.classes.tokenCounts ?? {};
      evidence.push(`- 截图：${formEvidence.shotPath}`);
      evidence.push(`- 标题：${form.title}；按钮：${form.buttons.join(' / ')}`);
      evidence.push(`- 地点搜索输入框：placeholder=「${form.placeSearch?.placeholder}」；搜索「大剧院」过滤：${formEvidence.searchFilter.before} → ${formEvidence.searchFilter.after} 个选项，含辽阳大剧院=${formEvidence.searchFilter.hasTheater}`);
      evidence.push(`- 地点下拉：${form.placeSelect?.optionCount} 个选项（含「请选择地点」占位）`);
      evidence.push(`- 标题输入框：placeholder=「${form.titleInput?.placeholder}」，maxLength=${form.titleInput?.maxLength}`);
      evidence.push(`- 开始/结束：${form.datetimeInputs.map((input) => `${input.type}（初始值「${input.value || '空'}」）`).join('，')}`);
      evidence.push(`- 备注：textarea placeholder=「${form.textarea?.placeholder}」，rows=${form.textarea?.rows}，maxLength=${form.textarea?.maxLength}`);
      evidence.push(`- 弹窗类：bg-black/40=${counts['bg-black/40'] ?? 0}，bg-white=${counts['bg-white'] ?? 0}，shadow-lg=${counts['shadow-lg'] ?? 0}；弹窗内 gray-*=${formEvidence.gray?.count ?? '(未采样)'}`);
    }

    const evidenceText = evidence.join('\n');
    const evidencePath = writeArtifact('admin-colors.txt', evidenceText);
    console.log(`\n${evidenceText}\n`);
    console.log(`[evidence] 配色证据已保存：${evidencePath}`);

    // ---------- 9. 页面 console ----------
    REPORT.section('9. 页面 console');
    if (consoleCollector.errors.length === 0) {
      REPORT.info('页面没有 console.error / 未捕获异常');
    } else {
      REPORT.info(`页面 console 错误 ${consoleCollector.errors.length} 条：${oneLine(consoleCollector.errors.join(' | '), 500)}`);
    }

    reportData.colorFamilies = placesColorData.families;
    reportData.events = events;
    const reportPath = writeArtifact('admin-report.json', JSON.stringify(reportData, null, 2));
    console.log(`[evidence] 结构化证据已保存：${reportPath}`);
  } finally {
    if (cdp !== null) cdp.close();
    await closeEdge(launched);
  }

  // ---------- 汇总 ----------
  const summary = REPORT.printSummary();
  console.log('\n[提示] 本脚本只读 + 打开编辑弹窗；没有保存、删除或修改任何数据。');
  console.log(`A 组截图：${reportData.screenshots.places ?? '(无)'} / ${reportData.screenshots.events ?? '(无)'} / ${reportData.screenshots.newEvent ?? '(无)'}`);
  process.exitCode = summary.fail > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error(`[admin-ui] 脚本异常：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
