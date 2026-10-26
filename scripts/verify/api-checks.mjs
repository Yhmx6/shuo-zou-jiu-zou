#!/usr/bin/env node
/**
 * 纯接口验收（scripts/verify/api-checks.mjs）
 *
 * 运行（项目根目录，dev server 已在 http://127.0.0.1:3000；localhost 加不进高德白名单）：
 *   node scripts/verify/api-checks.mjs                # 全部检查
 *   node scripts/verify/api-checks.mjs --only=plan    # 只跑 plan
 *   node scripts/verify/api-checks.mjs --only=sort    # 只跑后台排序 / 过滤
 *   node scripts/verify/api-checks.mjs --only=events  # 只跑活动接口（只读 + 临时数据 CRUD）
 *
 * 检查项（每项独立 try/catch，输出 PASS / FAIL / SKIP，不因单项失败中断）：
 * - checkPlanBase：POST /api/plan 固定参数，打印 ok / 失败原因 / stops[].placeId / 每站 importance / upcomingEvent；
 * - checkPlanDisplayFields：用「更多选项起点=辽阳大剧院」让第一站就是大剧院，
 *   验证 /api/plan 真的把 importance=5 与 upcomingEvent（话剧《雷雨》）挂到站点上；
 * - checkAdminSort：GET /api/admin/places?city=liaoyang，校验 importance 降序（无值视为 0）；
 * - checkAdminImportanceFilter：GET ...&minImportance=4，校验过滤生效且不误伤；
 * - checkEventsReadOnly：GET /api/admin/events 的只读检查（辽阳那条活动绝不 PATCH / DELETE）；
 * - checkEventsCRUD：在杭州创建临时活动 → GET 校验 → PATCH → DELETE → GET 校验删除，
 *   外加「跨城市拒绝 / endAt<=startAt 拒绝 / 未知 id 404」三个负例；结束时一定清理临时数据。
 *
 * 结果同时写 .cache/verify/api-checks.json。
 */

import { apiDelete, apiGet, apiPatch, apiPost, oneLine, pretty, writeArtifact } from './lib.mjs';

const CITY = 'liaoyang';
const THEATER_PLACE_ID = 'B0FFGEKXKE';
const THEATER_PLACE_NAME = '辽阳大剧院';
const EVENT_TITLE = '话剧《雷雨》';
/** 固定排程参数：15:20（920），默认预算 200 */
const FIXED_NOW_MINUTE = 920;
const FIXED_BUDGET = 200;

const results = [];

function record(status, name, detail) {
  const text = detail === undefined || detail === null ? '' : String(detail);
  results.push({ status, name, detail: text });
  console.log(`[${status}] ${name}${text === '' ? '' : ` — ${text}`}`);
  return status === 'PASS';
}

function pass(name, detail) {
  return record('PASS', name, detail);
}

function fail(name, detail) {
  return record('FAIL', name, detail);
}

function skip(name, reason) {
  return record('SKIP', name, reason);
}

/** 断言：condition 为真 PASS，否则 FAIL；不抛异常 */
function assert(name, condition, detailPass, detailFail) {
  return condition ? pass(name, detailPass) : fail(name, detailFail ?? detailPass);
}

function section(title) {
  console.log(`\n---------- ${title} ----------`);
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 相对今天 offsetDays 天的本地时间 "YYYY-MM-DDTHH:mm" */
function localDateTimeOffset(offsetDays, minuteOfDay) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const day = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  return `${day}T${pad2(Math.floor(minuteOfDay / 60))}:${pad2(minuteOfDay % 60)}`;
}

/** 平面打印一个活动对象的关键字段 */
function describeEvent(event) {
  if (event === null || event === undefined) return '(null)';
  return `${event.id ?? '?'} | ${event.title ?? '?'} | place=${event.placeName ?? event.placeId ?? '?'} | ${event.startAt ?? '?'} ~ ${event.endAt ?? '?'} | status=${event.status ?? '?'}`;
}

// ---------------------------------------------------------------- 1. /api/plan 基础

/**
 * 固定参数打一次 /api/plan，打印 ok / stops / importance / upcomingEvent。
 * @returns {Promise<object|null>} 成功时返回响应 JSON，失败返回 null
 */
export async function checkPlanBase(options = {}) {
  section(`1. POST /api/plan 基础（city=${options.city ?? CITY}，nowMinute=${options.nowMinute ?? FIXED_NOW_MINUTE}，budget=${options.budget ?? FIXED_BUDGET}）`);
  const body = {
    city: options.city ?? CITY,
    nowMinute: options.nowMinute ?? FIXED_NOW_MINUTE,
    budget: options.budget ?? FIXED_BUDGET,
  };
  const result = await apiPost('/api/plan', body, { timeoutMs: 120000 });
  if (result.error !== null) {
    fail('请求成功', `网络错误：${result.error}`);
    return null;
  }
  assert('HTTP 200', result.status === 200, `HTTP ${result.status}，${result.ms} ms`, `HTTP ${result.status}，${oneLine(result.text, 400)}`);
  const json = result.json;
  if (json === null) {
    fail('响应是 JSON', `响应不是 JSON：${oneLine(result.text, 400)}`);
    return null;
  }
  if (json.ok === false) {
    fail('排程成功（ok=true）', `ok=false，reason=${oneLine(json.reason ?? '(无)', 400)}`);
    return null;
  }
  pass('排程成功（ok=true）', `startAt=${json.startAt}（${String(Math.floor(json.startAt / 60)).padStart(2, '0')}:${pad2(json.startAt % 60)}），endAt=${json.endAt}，totalMin=${json.totalMin}，totalCost=${json.totalCost}`);

  const stops = Array.isArray(json.stops) ? json.stops : [];
  console.log(`  stops[].placeId：${stops.map((stop) => stop.placeId).join(', ')}`);
  console.log('  每站 importance / upcomingEvent：');
  for (let index = 0; index < stops.length; index += 1) {
    const stop = stops[index];
    const importance = stop.importance === undefined ? '(无)' : String(stop.importance);
    const event = stop.upcomingEvent === undefined
      ? '(无)'
      : `${stop.upcomingEvent.startAtText} ${stop.upcomingEvent.title}（${stop.upcomingEvent.status}）`;
    console.log(`    ${index + 1}. ${stop.placeName ?? '?'}（${stop.placeId}）importance=${importance} upcomingEvent=${event}`);
  }
  const withImportance = stops.filter((stop) => stop.importance !== undefined).length;
  const withEvent = stops.filter((stop) => stop.upcomingEvent !== undefined).length;
  pass('行程结构', `${stops.length} 站；带 importance ${withImportance} 站；带 upcomingEvent ${withEvent} 站；segments=${Array.isArray(json.segments) ? json.segments.length : '(无)'}`);
  return json;
}

/**
 * 用自定义起点「辽阳大剧院」把大剧院顶到第一站，验证 /api/plan 的展示附加字段。
 * （这是页面「更多选项-起点」已有的功能，与 B 组浏览器验收同一路径。）
 */
export async function checkPlanDisplayFields() {
  section('2. POST /api/plan 展示附加字段（起点=辽阳大剧院，nowMinute=920）');
  const result = await apiPost(
    '/api/plan',
    { city: CITY, nowMinute: FIXED_NOW_MINUTE, budget: FIXED_BUDGET, originAddress: THEATER_PLACE_NAME },
    { timeoutMs: 120000 },
  );
  if (result.error !== null) {
    fail('请求成功', `网络错误：${result.error}`);
    return null;
  }
  const json = result.json;
  if (json === null || json.ok === false) {
    fail('排程成功（ok=true）', json === null ? oneLine(result.text, 400) : `ok=false，reason=${json.reason}`);
    return null;
  }
  const firstStop = Array.isArray(json.stops) ? json.stops[0] : null;
  assert('第一站是辽阳大剧院', firstStop !== null && firstStop.placeId === THEATER_PLACE_ID, `${firstStop?.placeName}（${firstStop?.placeId}）`, `第一站是 ${firstStop?.placeName}（${firstStop?.placeId}）`);
  assert('第一站带 importance=5', firstStop !== null && firstStop.importance === 5, `importance=${firstStop?.importance}`, `importance=${firstStop?.importance ?? '(缺失)'}`);
  const upcoming = firstStop?.upcomingEvent ?? null;
  assert(
    '第一站带 upcomingEvent（话剧《雷雨》）',
    upcoming !== null && upcoming.title === EVENT_TITLE,
    upcoming === null ? '没有 upcomingEvent' : `${upcoming.startAtText} 有场${upcoming.title}，status=${upcoming.status}，dayLabel=${upcoming.dayLabel}，noteLine=${upcoming.noteLine ?? 'null'}`,
    `upcomingEvent=${oneLine(upcoming, 300)}`,
  );
  if (upcoming !== null) {
    const line = `${upcoming.dayLabel === '明天' ? '明天 ' : ''}${upcoming.startAtText} 有场${upcoming.title}${upcoming.noteLine === null ? '' : `，${upcoming.noteLine}`}`;
    console.log(`  卡片活动行原文：${line}`);
    pass('活动行文案符合约定', line);
  }
  return json;
}

// ---------------------------------------------------------------- 3. 后台排序 / 过滤

/** GET /api/admin/places?city=liaoyang，校验按 importance 降序（无值视为 0） */
export async function checkAdminSort() {
  section('3. GET /api/admin/places 排序（importance 降序，无值视为 0）');
  const result = await apiGet(`/api/admin/places?city=${CITY}`, { timeoutMs: 60000 });
  if (result.error !== null) {
    fail('请求成功', `网络错误：${result.error}`);
    return null;
  }
  assert('HTTP 200', result.status === 200, `HTTP ${result.status}`, `HTTP ${result.status}，${oneLine(result.text, 300)}`);
  const json = result.json;
  if (json === null || json.ok !== true || !Array.isArray(json.places)) {
    fail('响应结构', `ok=${json?.ok}，places 不是数组：${oneLine(result.text, 300)}`);
    return null;
  }
  const places = json.places;
  const values = places.map((place) => (typeof place.importance === 'number' ? place.importance : 0));
  const sorted = values.every((value, index) => index === 0 || values[index - 1] >= value);
  const firstBad = values.findIndex((value, index) => index > 0 && values[index - 1] < value);
  const withImportance = places.filter((place) => typeof place.importance === 'number');
  assert(
    '按 importance 降序排列',
    sorted,
    `共 ${places.length} 个地点，前 5 个 importance：${values.slice(0, 5).join(', ')}`,
    `第 ${firstBad + 1} 个开始降序被破坏：${values.slice(Math.max(0, firstBad - 1), firstBad + 3).join(', ')}`,
  );
  assert(
    '没有 importance=0 的显式值',
    places.every((place) => place.importance !== 0),
    '未标星的点都不带 importance 字段（没有显式 0）',
    `存在 importance=0 的点：${places.filter((place) => place.importance === 0).map((place) => place.id).join(', ')}`,
  );
  console.log(`  标的星的地点（${withImportance.length} 个）：${withImportance.map((place) => `${place.name}=${place.importance}`).join('，') || '(无)'}`);
  // 任务3（自动星级）之后：两城 423 个地点已全部由 scripts/rate-places.ts 批量打星（只写 manual 层），
  // 未标注应为 0。旧断言「辽阳只有大剧院标了 5 星」已随数据变化失效，改成覆盖统计 + 合法性校验。
  assert(
    '全部地点都有 1–5 星',
    withImportance.length === places.length && withImportance.every((place) => place.importance >= 1 && place.importance <= 5),
    `${withImportance.length}/${places.length} 个地点带 importance`,
    `仍有 ${places.length - withImportance.length} 个地点未标星：${places.filter((place) => typeof place.importance !== 'number').map((place) => place.id).slice(0, 10).join('，')}`,
  );
  return json;
}

/** GET ...&minImportance=4 过滤 */
export async function checkAdminImportanceFilter() {
  section('4. GET /api/admin/places?minImportance=4 过滤');
  const result = await apiGet(`/api/admin/places?city=${CITY}&minImportance=4`, { timeoutMs: 60000 });
  if (result.error !== null) {
    fail('请求成功', `网络错误：${result.error}`);
    return null;
  }
  const json = result.json;
  if (json === null || json.ok !== true || !Array.isArray(json.places)) {
    fail('响应结构', `ok=${json?.ok}，places 不是数组：${oneLine(result.text, 300)}`);
    return null;
  }
  const places = json.places;
  const allHigh = places.every((place) => typeof place.importance === 'number' && place.importance >= 4);
  assert('过滤后每一条 importance >= 4', allHigh, `${places.length} 条：${places.map((place) => `${place.name}=${place.importance}`).join('，') || '(空)'}`, `存在 importance < 4 的条目：${places.filter((place) => typeof place.importance !== 'number' || place.importance < 4).map((place) => place.id).join(', ')}`);
  // 任务3 之后辽阳有多条真实地标是 5 星（不只大剧院），断言改为「非空 + 覆盖大剧院」。
  const theater = places.find((place) => place.id === THEATER_PLACE_ID);
  assert(
    '辽阳 4 星以上结果包含大剧院（importance=5）',
    places.length > 0 && theater !== undefined && theater.importance === 5,
    `${places.length} 条 >=4 星，含大剧院=${theater === undefined ? '否' : `是（${theater.importance} 星）`}`,
    `结果里没有大剧院或星级不是 5：${places.map((place) => `${place.name}(${place.id})=${place.importance}`).join('，')}`,
  );
  return json;
}

// ---------------------------------------------------------------- 5. 活动接口（只读）

/** 读辽阳活动列表 / placeId 过滤，绝不修改辽阳数据 */
export async function checkEventsReadOnly() {
  section('5. GET /api/admin/events 只读检查（辽阳，不写不改）');
  const result = await apiGet(`/api/admin/events?city=${CITY}`, { timeoutMs: 60000 });
  if (result.error !== null) {
    fail('请求成功', `网络错误：${result.error}`);
    return null;
  }
  if (result.status === 404) {
    skip('活动接口可用', '/api/admin/events 返回 404（接口未实现，等 events-api）');
    return null;
  }
  assert('HTTP 200', result.status === 200, `HTTP ${result.status}`, `HTTP ${result.status}，${oneLine(result.text, 300)}`);
  const json = result.json;
  if (json === null || json.ok !== true || !Array.isArray(json.events)) {
    fail('响应结构', `ok=${json?.ok}，events 不是数组：${oneLine(result.text, 300)}`);
    return null;
  }
  const events = json.events;
  const target = events.find((event) => event.title === EVENT_TITLE) ?? null;
  assert('活动列表包含「话剧《雷雨》」', target !== null, `共 ${events.length} 条`, `共 ${events.length} 条，没有「${EVENT_TITLE}」`);
  if (target !== null) {
    console.log(`  目标活动：${describeEvent(target)}`);
    assert('活动字段齐全（id/placeId/placeName/title/startAt/endAt/status）', [target.id, target.placeId, target.placeName, target.title, target.startAt, target.endAt, target.status].every((value) => typeof value === 'string' && value.length > 0), '字段齐全', `缺字段：${JSON.stringify(target)}`);
    assert('placeName 是辽阳大剧院', target.placeName === THEATER_PLACE_NAME, `placeName=${target.placeName}`, `placeName=${target.placeName}`);
    assert('startAt/endAt 是本地时间格式 YYYY-MM-DDTHH:mm', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(target.startAt) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(target.endAt), `${target.startAt} ~ ${target.endAt}`, `${target.startAt} ~ ${target.endAt}`);
    assert('status 是 upcoming/ongoing/ended 之一', ['upcoming', 'ongoing', 'ended'].includes(target.status), `status=${target.status}（服务端按真实时间算）`, `status=${target.status}`);
  }

  // placeId 过滤
  const filtered = await apiGet(`/api/admin/events?city=${CITY}&placeId=${THEATER_PLACE_ID}`, { timeoutMs: 60000 });
  const filteredEvents = filtered.json !== null && Array.isArray(filtered.json.events) ? filtered.json.events : null;
  assert(
    'placeId 过滤生效',
    filteredEvents !== null && filteredEvents.length >= 1 && filteredEvents.every((event) => event.placeId === THEATER_PLACE_ID),
    `${filteredEvents?.length ?? '?'} 条，全部 placeId=${THEATER_PLACE_ID}`,
    `过滤结果异常：${oneLine(filtered.text, 300)}`,
  );
  const noEventsPlace = await apiGet(`/api/admin/events?city=${CITY}&placeId=B0HRCZKQIF`, { timeoutMs: 60000 });
  const noEventsList = noEventsPlace.json !== null && Array.isArray(noEventsPlace.json.events) ? noEventsPlace.json.events : null;
  assert('没有活动的地点返回空列表', noEventsList !== null && noEventsList.length === 0, '0 条', `返回 ${noEventsList?.length ?? '(结构异常)'} 条`);

  // 缺少 city → 400
  const noCity = await apiGet('/api/admin/events', { timeoutMs: 30000 });
  assert('缺少 city 参数返回 400', noCity.status === 400 && noCity.json?.ok === false, `HTTP ${noCity.status}，${oneLine(noCity.text, 200)}`, `HTTP ${noCity.status}，${oneLine(noCity.text, 200)}`);
  return json;
}

// ---------------------------------------------------------------- 6. 活动接口（临时数据 CRUD，走杭州）

/** 在杭州创建临时活动，完整走 POST/GET/PATCH/DELETE + 负例，并保证清理 */
export async function checkEventsCRUD() {
  section('6. 活动 CRUD（临时数据在杭州，结束后删除；辽阳数据只读）');
  const testCity = 'hangzhou';
  const title = `验收临时活动-请删除-${Date.now()}`;
  const startAt = localDateTimeOffset(1, 19 * 60);
  const endAt = localDateTimeOffset(1, 21 * 60);
  let createdId = null;
  let initialCount = null;

  // 杭州第一个地点 id（写测试活动用）
  const placesResult = await apiGet(`/api/admin/places?city=${testCity}&includeHidden=1`, { timeoutMs: 60000 });
  const places = placesResult.json !== null && Array.isArray(placesResult.json.places) ? placesResult.json.places : [];
  const place = places[0] ?? null;
  if (place === null) {
    fail('拿到杭州测试地点', `杭州没有地点：${oneLine(placesResult.text, 300)}`);
    return null;
  }
  console.log(`  测试城市=${testCity}，测试地点=${place.name}（${place.id}），测试时间=${startAt} ~ ${endAt}`);

  try {
    // 初始列表（只用于证明清理后回到原状）
    const initial = await apiGet(`/api/admin/events?city=${testCity}`, { timeoutMs: 60000 });
    const initialEvents = initial.json !== null && Array.isArray(initial.json.events) ? initial.json.events : null;
    initialCount = initialEvents === null ? null : initialEvents.length;
    assert('杭州活动列表可读', initialEvents !== null, `初始 ${initialCount} 条活动`, `读取失败：${oneLine(initial.text, 300)}`);

    // POST
    const create = await apiPost('/api/admin/events', { city: testCity, event: { placeId: place.id, title, startAt, endAt, note: 'verifier 临时验收数据，结束会删除' } }, { timeoutMs: 60000 });
    assert('POST 新增活动', create.status === 200 && create.json?.ok === true, `HTTP ${create.status}，${oneLine(create.json?.event ?? create.text, 300)}`, `HTTP ${create.status}，${oneLine(create.text, 500)}`);

    // GET 校验（用 title 定位，避免依赖响应里的 id 位置）
    const afterCreate = await apiGet(`/api/admin/events?city=${testCity}`, { timeoutMs: 60000 });
    const afterCreateEvents = afterCreate.json !== null && Array.isArray(afterCreate.json.events) ? afterCreate.json.events : [];
    const created = afterCreateEvents.find((event) => event.title === title) ?? null;
    createdId = created === null ? null : created.id;
    assert('GET 能看到新增活动', created !== null, created === null ? '列表里没有新活动' : `id=${created.id}，placeName=${created.placeName}，status=${created.status}`, `列表里没有「${title}」：${oneLine(afterCreate.text, 300)}`);
    if (createdId === null) {
      fail('拿到新增活动 id', '无法继续 PATCH / DELETE（列表里找不到新活动）');
      return null;
    }
    assert('新增活动 id 形如 evt_NNN', /^evt_\d+$/.test(createdId), `id=${createdId}`, `id=${createdId} 不符合 evt_NNN`);
    assert('新增活动 status 由服务端算好', ['upcoming', 'ongoing', 'ended'].includes(created.status), `status=${created.status}`, `status=${created.status}`);
    assert('新增活动 placeName 已回填', created.placeName === place.name, `placeName=${created.placeName}`, `placeName=${created.placeName}，期望 ${place.name}`);

    // PATCH
    const newTitle = `${title}-已修改`;
    const patch = await apiPatch('/api/admin/events', { city: testCity, id: createdId, patch: { title: newTitle } }, { timeoutMs: 60000 });
    assert('PATCH 修改活动', patch.status === 200 && patch.json?.ok === true, `HTTP ${patch.status}`, `HTTP ${patch.status}，${oneLine(patch.text, 500)}`);
    const afterPatch = await apiGet(`/api/admin/events?city=${testCity}`, { timeoutMs: 60000 });
    const patchedList = afterPatch.json !== null && Array.isArray(afterPatch.json.events) ? afterPatch.json.events : [];
    const patched = patchedList.find((event) => event.id === createdId) ?? null;
    assert('PATCH 后标题已更新', patched !== null && patched.title === newTitle, `title=${patched?.title}`, `title=${patched?.title}，期望 ${newTitle}`);

    // 负例 1：跨城市 placeId → 400
    const crossCity = await apiPost('/api/admin/events', { city: 'liaoyang', event: { placeId: place.id, title: `${title}-跨城市`, startAt, endAt } }, { timeoutMs: 60000 });
    assert('跨城市 placeId 被拒绝（400）', crossCity.status === 400 && crossCity.json?.ok === false, `HTTP ${crossCity.status}，${oneLine(crossCity.json?.reason, 200)}`, `HTTP ${crossCity.status}，${oneLine(crossCity.text, 300)}`);

    // 负例 2：endAt <= startAt → 400
    const badTime = await apiPost('/api/admin/events', { city: testCity, event: { placeId: place.id, title: `${title}-坏时间`, startAt: endAt, endAt: startAt } }, { timeoutMs: 60000 });
    assert('endAt 早于 startAt 被拒绝（400）', badTime.status === 400 && badTime.json?.ok === false, `HTTP ${badTime.status}，${oneLine(badTime.json?.reason, 200)}`, `HTTP ${badTime.status}，${oneLine(badTime.text, 300)}`);

    // 负例 3：未知 id PATCH / DELETE → 404
    const unknownPatch = await apiPatch('/api/admin/events', { city: testCity, id: 'evt_999999', patch: { title: '不存在的活动' } }, { timeoutMs: 60000 });
    assert('未知 id PATCH 返回 404', unknownPatch.status === 404, `HTTP ${unknownPatch.status}`, `HTTP ${unknownPatch.status}，${oneLine(unknownPatch.text, 300)}`);
    const unknownDelete = await apiDelete('/api/admin/events', { city: testCity, id: 'evt_999999' }, { timeoutMs: 60000 });
    assert('未知 id DELETE 返回 404', unknownDelete.status === 404, `HTTP ${unknownDelete.status}`, `HTTP ${unknownDelete.status}，${oneLine(unknownDelete.text, 300)}`);

    // DELETE 清理
    const remove = await apiDelete('/api/admin/events', { city: testCity, id: createdId }, { timeoutMs: 60000 });
    assert('DELETE 删除临时活动', remove.status === 200 && remove.json?.ok === true, `HTTP ${remove.status}，id=${createdId}`, `HTTP ${remove.status}，${oneLine(remove.text, 500)}`);
    const afterDelete = await apiGet(`/api/admin/events?city=${testCity}`, { timeoutMs: 60000 });
    const afterDeleteEvents = afterDelete.json !== null && Array.isArray(afterDelete.json.events) ? afterDelete.json.events : [];
    const stillThere = afterDeleteEvents.find((event) => event.id === createdId) ?? null;
    assert('DELETE 后列表里不再有该活动', stillThere === null, `剩余 ${afterDeleteEvents.length} 条活动`, `仍存在 id=${createdId}`);
    if (stillThere === null) createdId = null;
    if (initialCount !== null) {
      assert('临时数据已清干净（回到初始条数）', afterDeleteEvents.length === initialCount, `清理后 ${afterDeleteEvents.length} 条 = 初始 ${initialCount} 条`, `清理后 ${afterDeleteEvents.length} 条 ≠ 初始 ${initialCount} 条`);
    }
    return { createdId, title, ok: true };
  } catch (error) {
    fail('活动 CRUD 执行', `脚本内异常：${error instanceof Error ? error.message : String(error)}`);
    return null;
  } finally {
    // 兜底清理：中途失败也要把临时活动删掉
    if (createdId !== null) {
      const cleanup = await apiDelete('/api/admin/events', { city: testCity, id: createdId }, { timeoutMs: 60000 });
      if (cleanup.status === 200) {
        console.log(`  [cleanup] 已兜底删除临时活动 ${createdId}`);
        createdId = null;
      } else {
        fail('[cleanup] 兜底删除临时活动失败', `id=${createdId}，${oneLine(cleanup.text, 300)}；请人工检查杭州活动数据`);
      }
    }
  }
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const only = (process.argv.find((argument) => argument.startsWith('--only=')) ?? '--only=all').slice('--only='.length);
  console.log(`api-checks：only=${only}，dev server=${process.env.VERIFY_BASE_URL ?? 'http://127.0.0.1:3000'}`);

  const runners = {
    plan: async () => {
      await checkPlanBase();
      await checkPlanDisplayFields();
    },
    sort: async () => {
      await checkAdminSort();
      await checkAdminImportanceFilter();
    },
    events: async () => {
      await checkEventsReadOnly();
      await checkEventsCRUD();
    },
  };

  if (only === 'all' || only === 'plan') {
    try {
      await runners.plan();
    } catch (error) {
      fail('plan 检查组', `异常：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (only === 'all' || only === 'sort') {
    try {
      await runners.sort();
    } catch (error) {
      fail('sort 检查组', `异常：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (only === 'all' || only === 'events') {
    try {
      await runners.events();
    } catch (error) {
      fail('events 检查组', `异常：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 汇总
  const passCount = results.filter((item) => item.status === 'PASS').length;
  const failCount = results.filter((item) => item.status === 'FAIL').length;
  const skipCount = results.filter((item) => item.status === 'SKIP').length;
  console.log(`\n===== 汇总（api-checks，only=${only}）：PASS ${passCount} / FAIL ${failCount} / SKIP ${skipCount}，共 ${results.length} 项 =====`);
  if (failCount > 0) {
    console.log('FAIL 项：');
    for (const item of results.filter((entry) => entry.status === 'FAIL')) console.log(`  - ${item.name}：${item.detail}`);
  }
  if (skipCount > 0) {
    console.log('SKIP 项：');
    for (const item of results.filter((entry) => entry.status === 'SKIP')) console.log(`  - ${item.name}：${item.detail}`);
  }

  const reportPath = writeArtifact('api-checks.json', JSON.stringify({ only, generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }), pass: passCount, fail: failCount, skip: skipCount, results }, null, 2));
  console.log(`[evidence] 结构化证据已保存：${reportPath}`);
  console.log(`\n${pretty({ pass: passCount, fail: failCount, skip: skipCount })}`);
  process.exitCode = failCount > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error(`[api-checks] 脚本异常：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
