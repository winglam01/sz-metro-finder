/* Shenzhen Metro Pinyin — client application.
   Single page app, hash routing, no build step and no third-party code.

   The phone build has no backend: the data layer runs in the browser and
   talks to the Shenzhen Metro public endpoints directly, so `api` resolves the
   same paths against local modules. */

import { api } from './data/api.mjs';

const state = {
  bootstrap: null,
  view: { name: 'finder' },
  finder: { q: '', results: [], loading: false },
  station: { code: '', data: null, loading: false, error: '', dayType: defaultDayType() },
  plan: {
    from: '',
    to: '',
    fromLabel: '',
    toLabel: '',
    ridingType: 0,
    result: null,
    loading: false,
    error: '',
    menu: '',
    menuResults: [],
  },
  network: { open: '' },
  saved: { items: [] },
};

/** The operator publishes three timetables; a weekday starts on the weekday one. */
function defaultDayType() {
  const day = new Date().getDay();
  return day === 0 || day === 6 ? 'weekend' : 'work';
}

const DAY_TYPES = [
  { id: 'work', label: '工作日' },
  { id: 'weekend', label: '休息日' },
  { id: 'holiday', label: '节假日' },
];

const root = /** @type {HTMLElement} */ (document.getElementById('main'));
const toast = /** @type {HTMLElement} */ (document.getElementById('toast'));

/* ------------------------------------------------------------- helpers */

/**
 * @param {unknown} value
 * @returns {string}
 */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  );
}

/**
 * The short label inside a line badge: the line number, and `6支` for the
 * Line 6 branch.
 *
 * @param {string} lineId
 * @param {string} lineName
 * @returns {string}
 */
function lineBadgeLabel(lineId, lineName) {
  if (lineId === '66') return '6支';
  if (/^\d+$/.test(lineId)) return lineId;
  return lineName.replace(/号线.*/, '');
}

/**
 * The official colour of a line. The route planner numbers its lines with
 * leading zeros (`03`), the catalogue without (`3`).
 *
 * @param {string} lineId
 * @returns {string}
 */
function lineColour(lineId) {
  const id = String(lineId ?? '').replace(/^0+(?=\d)/, '');
  const line = state.bootstrap?.lines.find((item) => item.id === id);
  return line?.color ?? '#666666';
}

/**
 * The coloured badge that carries a line's official colour.
 *
 * @param {string} label
 * @param {string} color
 * @param {string} [title]
 * @returns {string}
 */
function lineBadge(label, color, title = '') {
  const tip = title ? ` title="${esc(title)}"` : '';
  return `<span class="badge badge--line" style="background:${esc(color)}"${tip}>${esc(label)}</span>`;
}

/**
 * @param {number} minutes
 * @returns {string}
 */
function countdown(minutes) {
  if (minutes <= 0) return '即将到站';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

/**
 * @param {number} seconds
 * @returns {string}
 */
function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

function showToast(message) {
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  toast.timer = setTimeout(() => {
    toast.hidden = true;
  }, 2400);
}

/* ---------------------------------------------------------------- theme */

const THEMES = ['auto', 'light', 'dark'];

/**
 * @returns {string}
 */
function readTheme() {
  try {
    const stored = localStorage.getItem('szmetro:theme');
    return THEMES.includes(/** @type {string} */ (stored)) ? /** @type {string} */ (stored) : 'auto';
  } catch {
    return 'auto';
  }
}

/**
 * @param {string} theme
 */
function applyTheme(theme) {
  const rootEl = document.documentElement;
  if (theme === 'auto') rootEl.removeAttribute('data-theme');
  else rootEl.setAttribute('data-theme', theme);
  const label = document.querySelector('[data-theme-label]');
  if (label) label.textContent = theme === 'auto' ? '跟随系统' : theme === 'light' ? '浅色' : '深色';
  try {
    localStorage.setItem('szmetro:theme', theme);
  } catch {
    /* the theme simply will not be remembered */
  }
}

/* --------------------------------------------------------------- router */

/**
 * @returns {void}
 */
function readHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, queryString] = raw.split('?');
  const query = new URLSearchParams(queryString ?? '');
  const parts = path.split('/').filter(Boolean);

  if (parts[0] === 'station' && parts[1]) {
    const dayType = query.get('day');
    state.view = { name: 'station', code: parts[1] };
    if (dayType && DAY_TYPES.some((item) => item.id === dayType)) state.station.dayType = dayType;
    return;
  }
  if (parts[0] === 'plan') {
    state.view = { name: 'plan' };
    return;
  }
  if (parts[0] === 'network') {
    state.view = { name: 'network' };
    return;
  }
  if (parts[0] === 'saved') {
    state.view = { name: 'saved' };
    return;
  }
  state.view = { name: 'finder' };
}

/**
 * @returns {void}
 */
function syncNav() {
  const active = state.view.name === 'station' ? 'finder' : state.view.name;
  for (const item of document.querySelectorAll('[data-nav]')) {
    item.classList.toggle('is-active', item.getAttribute('data-nav') === active);
  }
}

/* --------------------------------------------------------------- render */

/**
 * @returns {void}
 */
function render() {
  syncNav();
  if (state.view.name === 'station') renderStation();
  else if (state.view.name === 'plan') renderPlan();
  else if (state.view.name === 'network') renderNetwork();
  else if (state.view.name === 'saved') renderSaved();
  else renderFinder();
}

/* --------------------------------------------------------------- finder */

/**
 * @returns {void}
 */
function renderFinder() {
  const popular = state.bootstrap?.popular ?? [];
  root.innerHTML = `
    <section class="page-head">
      <div>
        <h1>深圳地铁拼音查站</h1>
        <p>输入拼音或拼音首字母，即可查询该站各线路、各方向的预计到站时间、首末班车、行车间隔与出入口信息。</p>
      </div>
    </section>

    <section class="section">
      <div class="search">
        <div class="search__field">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input id="station-search" type="search" inputmode="search" autocomplete="off" spellcheck="false"
                 placeholder="shenzhenbei / szb / 深圳北" aria-label="按拼音或中文搜索车站" />
        </div>
        <p class="search__hint">支持全拼 <code>shenzhenbei</code>、首字母 <code>szb</code>、中文 <code>深圳北站</code>；空格会被忽略。</p>
      </div>
      <ul class="results" id="search-results" role="listbox"></ul>
    </section>

    <section class="section">
      <div class="section__head"><h2>常用车站</h2><span>Popular stations</span></div>
      <div class="chips" id="popular-list">
        ${popular
          .map(
            (station) =>
              `<a class="chip" href="#/station/${esc(station.code)}">${esc(station.name)}<span class="result__pinyin">${esc(station.qp)}</span></a>`,
          )
          .join('')}
      </div>
    </section>

    <section class="section">
      <div class="notice">
        到站时间依据深圳地铁集团官网公布的各线路首末班车与行车间隔推算；首末班车、行车间隔、出入口与周边公交为官方原始数据。
        深圳地铁暂未对外公开实时列车位置数据。
      </div>
    </section>`;

  const input = /** @type {HTMLInputElement | null} */ (document.getElementById('station-search'));
  if (input) {
    input.value = state.finder.q;
    input.addEventListener('input', () => {
      state.finder.q = input.value;
      scheduleSearch();
    });
    if (state.finder.q) {
      renderResults(state.finder.results);
    }
  }
}

/** @type {number | undefined} */
let searchTimer;

/**
 * @returns {void}
 */
function scheduleSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    void runSearch();
  }, 130);
}

/**
 * @returns {Promise<void>}
 */
async function runSearch() {
  const query = state.finder.q.trim();
  if (!query) {
    state.finder.results = [];
    renderResults([]);
    return;
  }
  state.finder.loading = true;
  try {
    const payload = await api(`/api/stations?q=${encodeURIComponent(query)}`);
    state.finder.results = payload.results ?? [];
    renderResults(state.finder.results);
  } catch (error) {
    state.finder.results = [];
    renderResults([], error instanceof Error ? error.message : '查询失败');
  } finally {
    state.finder.loading = false;
  }
}

/**
 * @param {any[]} results
 * @param {string} [error]
 * @returns {void}
 */
function renderResults(results, error = '') {
  const list = document.getElementById('search-results');
  if (!list) return;
  if (error) {
    list.innerHTML = `<li class="error">${esc(error)}</li>`;
    return;
  }
  if (!results.length) {
    list.innerHTML = `<li class="empty">没有找到匹配的车站，试试拼音首字母（例如 <code>szb</code>）。</li>`;
    return;
  }
  list.innerHTML = results
    .map(
      (station) => `
      <li>
        <a class="result" href="#/station/${esc(station.code)}">
          <span>
            <span class="result__name">${esc(station.name)}</span><br />
            <span class="result__pinyin">${esc(station.qp)} · ${esc(station.jp)}</span>
          </span>
          <span class="result__meta">
            ${(station.lines ?? [])
              .map((id) => {
                const line = state.bootstrap?.lines.find((item) => item.id === id);
                return lineBadge(
                  lineBadgeLabel(id, line?.name ?? id),
                  line?.color ?? '#666666',
                  line?.name ?? id,
                );
              })
              .join('')}
          </span>
        </a>
      </li>`,
    )
    .join('');
}

/* -------------------------------------------------------------- station */

/**
 * @returns {void}
 */
async function renderStation() {
  const code = state.view.code ?? '';
  if (state.station.code !== code) {
    state.station.code = code;
    state.station.data = null;
    state.station.error = '';
  }

  root.innerHTML = `
    <section class="page-head">
      <div><h1>正在查询车站…</h1></div>
    </section>`;

  try {
    const data = await api(`/api/station/${encodeURIComponent(code)}?dayType=${encodeURIComponent(state.station.dayType)}`);
    state.station.data = data;
    state.station.error = '';
  } catch (error) {
    state.station.error = error instanceof Error ? error.message : '查询失败';
  }
  paintStation();
}

/**
 * @returns {void}
 */
function paintStation() {
  if (state.station.error) {
    root.innerHTML = `
      <section class="page-head"><div><h1>车站查询失败</h1></div></section>
      <p class="error">${esc(state.station.error)}</p>
      <p><a class="btn btn--ghost" href="#/finder">返回搜索</a></p>`;
    return;
  }

  const data = state.station.data;
  if (!data) {
    root.innerHTML = `<section class="page-head"><div><h1>正在查询车站…</h1></div></section>`;
    return;
  }

  const saved = state.saved.items.some((item) => item.code === data.station.code);

  /** @type {Map<string, any[]>} */
  const groups = new Map();
  for (const direction of data.directions ?? []) {
    // A terminus has no trains running towards itself, so the operator
    // publishes no times for that direction. It is not a direction of travel.
    if (!direction.first && !direction.last) continue;
    const key = direction.lineName || direction.lineId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)?.push(direction);
  }

  root.innerHTML = `
    <section class="page-head">
      <div class="station-head">
        <div>
          <h1>${esc(data.station.name)}站</h1>
          <p class="station-head__pinyin">${esc(data.station.qp)} · ${esc(data.station.jp)}</p>
          <div class="station-head__lines">
            ${(data.station.lines ?? [])
              .map((line) => lineBadge(lineBadgeLabel(line.id, line.name), line.color, line.name))
              .join('')}
          </div>
        </div>
        <div class="toolbar">
          <button class="btn btn--ghost" type="button" data-action="toggle-favourite" data-code="${esc(data.station.code)}">
            ${saved ? '★ 已收藏' : '☆ 收藏'}
          </button>
          <a class="btn btn--ghost" href="#/plan?from=${esc(data.station.code)}">以此站为起点</a>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="toolbar">
        <div class="segmented" role="group" aria-label="选择日期类型">
          ${DAY_TYPES.map(
            (item) =>
              `<button type="button" data-action="set-day-type" data-day="${item.id}" class="${
                state.station.dayType === item.id ? 'is-active' : ''
              }">${item.label}</button>`,
          ).join('')}
        </div>
        <span class="clock">本地时间 ${esc(data.clock)}</span>
        <span class="clock">数据更新于 ${esc(new Date(data.fetchedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }))}</span>
      </div>
    </section>

    <section class="section">
      <div class="section__head">
        <h2>预计到站时间</h2>
        <span>${esc(data.dayTypeLabel)}时刻表推算</span>
      </div>
      ${
        groups.size
          ? [...groups.entries()]
              .map(
                ([lineName, directions]) => `
        <div class="line-group">
          <div class="line-group__head">
            ${lineBadge(lineBadgeLabel(directions[0]?.lineId ?? '', lineName), directions[0]?.lineColor ?? '#666666', lineName)}
            <span class="line-group__name">${esc(lineName)}</span>
          </div>
          ${directions.map((direction) => renderDirection(direction)).join('')}
        </div>`,
              )
              .join('')
          : '<p class="empty">该站暂未公布时刻表。</p>'
      }
    </section>

    ${
      (data.exits ?? []).length
        ? `<section class="section">
            <div class="section__head"><h2>出入口</h2><span>Exits</span></div>
            <div class="card">
              <ul class="kv">
                ${data.exits
                  .map(
                    (exit) => `
                  <li>
                    <span class="kv__key">${esc(exit.code)}出入口</span>
                    <span class="kv__value">${esc(exit.text)}</span>
                  </li>`,
                  )
                  .join('')}
              </ul>
            </div>
          </section>`
        : ''
    }

    ${
      (data.buses ?? []).length
        ? `<section class="section">
            <div class="section__head"><h2>周边公交</h2><span>Nearby buses</span></div>
            <div class="card">
              <ul class="kv">
                ${data.buses
                  .flatMap((group) =>
                    group.stops.map(
                      (bus) => `
                  <li>
                    <span class="kv__key">${esc(group.exit)}</span>
                    <span class="kv__value"><b>${esc(bus.name)}</b> · ${esc(bus.routes)}</span>
                  </li>`,
                    ),
                  )
                  .join('')}
              </ul>
            </div>
          </section>`
        : ''
    }

    <section class="section">
      <div class="notice">
        到站时间依据深圳地铁集团官网公布的各线路首末班车与行车间隔推算；首末班车、行车间隔、出入口与周边公交为官方原始数据。
        深圳地铁暂未对外公开实时列车位置数据。
      </div>
    </section>`;

  const input = /** @type {HTMLInputElement | null} */ (document.getElementById('station-search'));
  if (input) input.focus();
}

/**
 * @param {any} direction
 * @returns {string}
 */
function renderDirection(direction) {
  const arrivals = direction.arrivals ?? [];
  const chips = arrivals.length
    ? arrivals
        .map(
          (arrival, index) => `
      <div class="arrival ${index === 0 ? 'arrival--next' : ''}">
        <div class="arrival__time">
          ${esc(arrival.clock)}${index === 0 ? '<span class="arrival__next">下一班</span>' : ''}
        </div>
        <div class="arrival__wait">${arrival.nextDay ? '次日 · ' : ''}${esc(countdown(arrival.inMinutes))}</div>
      </div>`,
        )
        .join('')
    : `<div class="arrival"><div class="arrival__time">已收车</div><div class="arrival__wait">次日首班 ${esc(
        direction.nextDayFirst,
      )}</div></div>`;

  return `
    <div class="direction">
      <div class="direction__head">
        <span class="direction__toward">开往 ${esc(direction.toward)}</span>
        <span class="direction__en">${esc(direction.towardEn)}</span>
      </div>
      <div class="arrivals">${chips}</div>
      <div class="facts">
        <span>首班车 <b>${esc(direction.first)}</b></span>
        <span>末班车 <b>${esc(direction.last)}</b></span>
        <span>高峰间隔 <b>${esc(direction.peakHeadway || '—')}</b></span>
        <span>平峰间隔 <b>${esc(direction.offPeakHeadway || '—')}</b></span>
      </div>
      ${
        direction.headwayKnown
          ? ''
          : '<div class="facts"><span>该站未公布行车间隔，上述到站时间为按默认间隔估算。</span></div>'
      }
    </div>`;
}

/* ----------------------------------------------------------------- plan */

/**
 * Look a station up in the bootstrap payload by its official code.
 *
 * @param {string} code
 * @returns {{ code: string, name: string, qp: string } | null}
 */
function stationByCode(code) {
  for (const list of Object.values(state.bootstrap?.allStations ?? {})) {
    const hit = list.find((station) => station.code === code);
    if (hit) return hit;
  }
  return null;
}

/**
 * @returns {void}
 */
function renderPlan() {
  const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
  const fromParam = params.get('from');
  if (fromParam && fromParam !== state.plan.from) {
    state.plan.from = fromParam;
    state.plan.fromLabel = '';
  }
  const toParam = params.get('to');
  if (toParam && toParam !== state.plan.to) {
    state.plan.to = toParam;
    state.plan.toLabel = '';
  }

  // A station that arrived through the URL has no label yet; fill it in from
  // the catalogue so the field shows what is actually selected.
  if (state.plan.from && !state.plan.fromLabel) {
    const station = stationByCode(state.plan.from);
    if (station) state.plan.fromLabel = `${station.name} (${station.qp})`;
  }
  if (state.plan.to && !state.plan.toLabel) {
    const station = stationByCode(state.plan.to);
    if (station) state.plan.toLabel = `${station.name} (${station.qp})`;
  }

  root.innerHTML = `
    <section class="page-head">
      <div>
        <h1>乘车路线</h1>
        <p>输入起点和终点的拼音，查询换乘方案、预计乘车时间与票价。</p>
      </div>
    </section>

    <section class="section">
      <div class="grid-2">
        <div class="picker">
          <label class="picker__label" for="from-input">起点站</label>
          <div class="search__field">
            <input id="from-input" type="search" autocomplete="off" spellcheck="false" placeholder="luohu / 罗湖" value="${esc(
              state.plan.fromLabel,
            )}" />
          </div>
          <ul class="picker__menu" id="from-menu" hidden></ul>
        </div>
        <div class="picker">
          <label class="picker__label" for="to-input">终点站</label>
          <div class="search__field">
            <input id="to-input" type="search" autocomplete="off" spellcheck="false" placeholder="shenzhenbei / 深圳北站" value="${esc(
              state.plan.toLabel,
            )}" />
          </div>
          <ul class="picker__menu" id="to-menu" hidden></ul>
        </div>
      </div>

      <div class="toolbar" style="margin: 14px 0 4px;">
        <div class="segmented" role="group" aria-label="换乘偏好">
          <button type="button" data-action="set-riding-type" data-riding="0" class="${
            state.plan.ridingType === 0 ? 'is-active' : ''
          }">最少时间</button>
          <button type="button" data-action="set-riding-type" data-riding="1" class="${
            state.plan.ridingType === 1 ? 'is-active' : ''
          }">最少换乘</button>
        </div>
        <button class="btn" type="button" data-action="run-plan">查询路线</button>
        <button class="btn btn--ghost" type="button" data-action="swap-plan">交换起终点</button>
      </div>
    </section>

    <section class="section" id="plan-result"></section>`;

  const fromInput = /** @type {HTMLInputElement | null} */ (document.getElementById('from-input'));
  const toInput = /** @type {HTMLInputElement | null} */ (document.getElementById('to-input'));

  if (fromInput) {
    fromInput.addEventListener('input', () => {
      state.plan.menu = 'from';
      void runPicker('from', fromInput.value);
    });
    fromInput.addEventListener('focus', () => {
      state.plan.menu = 'from';
    });
  }
  if (toInput) {
    toInput.addEventListener('input', () => {
      state.plan.menu = 'to';
      void runPicker('to', toInput.value);
    });
    toInput.addEventListener('focus', () => {
      state.plan.menu = 'to';
    });
  }

  if (state.plan.result) paintPlanResult(state.plan.result);
  else if (state.plan.error) {
    const target = document.getElementById('plan-result');
    if (target) target.innerHTML = `<p class="error">${esc(state.plan.error)}</p>`;
  }
}

/**
 * @param {'from' | 'to'} slot
 * @param {string} query
 * @returns {Promise<void>}
 */
async function runPicker(slot, query) {
  const menu = document.getElementById(`${slot}-menu`);
  if (!menu) return;
  const trimmed = query.trim();
  if (!trimmed) {
    menu.hidden = true;
    menu.innerHTML = '';
    return;
  }
  try {
    const payload = await api(`/api/stations?q=${encodeURIComponent(trimmed)}`);
    state.plan.menuResults = payload.results ?? [];
    menu.innerHTML = state.plan.menuResults.length
      ? state.plan.menuResults
          .map(
            (station) => `
        <li><button type="button" data-action="pick-station" data-slot="${slot}" data-code="${esc(
          station.code,
        )}">
          <span>${esc(station.name)}</span>
          <span class="result__pinyin">${esc(station.qp)}</span>
        </button></li>`,
          )
          .join('')
      : '<li><span class="result__pinyin">没有匹配的车站</span></li>';
    menu.hidden = false;
  } catch {
    menu.hidden = true;
  }
}

/**
 * @param {string} code
 * @param {string} name
 * @param {string} qp
 * @returns {void}
 */
function setStation(slot, code, name, qp) {
  if (slot === 'from') {
    state.plan.from = code;
    state.plan.fromLabel = `${name} (${qp})`;
  } else {
    state.plan.to = code;
    state.plan.toLabel = `${name} (${qp})`;
  }
  state.plan.result = null;
  state.plan.error = '';
  const input = /** @type {HTMLInputElement | null} */ (document.getElementById(`${slot}-input`));
  if (input) input.value = slot === 'from' ? state.plan.fromLabel : state.plan.toLabel;
  const menu = document.getElementById(`${slot}-menu`);
  if (menu) menu.hidden = true;
}

/**
 * @returns {Promise<void>}
 */
async function runPlan() {
  if (!state.plan.from || !state.plan.to) {
    state.plan.error = '请先选择起点站和终点站。';
    const target = document.getElementById('plan-result');
    if (target) target.innerHTML = `<p class="error">${esc(state.plan.error)}</p>`;
    return;
  }
  const target = document.getElementById('plan-result');
  if (target) target.innerHTML = '<p class="empty">正在查询路线…</p>';
  try {
    const result = await api(
      `/api/journey?from=${encodeURIComponent(state.plan.from)}&to=${encodeURIComponent(
        state.plan.to,
      )}&ridingType=${state.plan.ridingType}`,
    );
    state.plan.result = result;
    state.plan.error = '';
    paintPlanResult(result);
  } catch (error) {
    state.plan.result = null;
    state.plan.error = error instanceof Error ? error.message : '查询失败';
    if (target) target.innerHTML = `<p class="error">${esc(state.plan.error)}</p>`;
  }
}

/**
 * @param {any} result
 * @returns {void}
 */
function paintPlanResult(result) {
  const target = document.getElementById('plan-result');
  if (!target) return;

  const segments = result.segments ?? [];
  target.innerHTML = `
    <div class="route">
      <div class="route__summary">
        <span class="route__stat"><b>${esc(result.minutes)}</b><span>预计乘车时间（分钟）</span></span>
        <span class="route__stat"><b>${esc(result.transfers)}</b><span>换乘次数</span></span>
        <span class="route__stat"><b>¥${esc(result.fare)}</b><span>普通票价</span></span>
        <span class="route__stat"><b>¥${esc(result.businessFare)}</b><span>商务票价</span></span>
      </div>
      ${segments
        .map(
          (segment, index) => `
        <div class="segment">
          <div class="segment__rail">
            <span class="segment__dot"></span>
            ${index < segments.length - 1 ? '<span class="segment__line"></span>' : ''}
          </div>
          <div class="segment__body">
            <div class="segment__route">
              ${lineBadge(
                segment.line.replace(/^0+(?=\d)/, ''),
                lineColour(segment.line),
                segment.lineName,
              )}
              <span>${esc(segment.from)} → ${esc(segment.to)}</span>
            </div>
            <div class="segment__note">
              乘车 ${esc(duration(segment.travelSeconds))}
              ${
                segment.transferSeconds > 1
                  ? ` · 在 ${esc(segment.from)} 换乘步行约 ${esc(Math.round(segment.transferMetres))} 米 / ${esc(
                      Math.round(segment.transferSeconds / 60),
                    )} 分钟`
                  : ''
              }
            </div>
            <div class="segment__note">
              首班 ${esc(segment.first || '—')} · 末班 ${esc(segment.last || '—')}
              ${
                segment.peakHeadway && segment.peakHeadway !== '--'
                  ? ` · 高峰间隔 ${esc(segment.peakHeadway)}`
                  : ''
              }
              ${
                segment.offPeakHeadway && segment.offPeakHeadway !== '--'
                  ? ` · 平峰间隔 ${esc(segment.offPeakHeadway)}`
                  : ''
              }
            </div>
            ${
              segment.via.length
                ? `<div class="segment__note">途经：${esc(segment.via.join(' · '))}</div>`
                : ''
            }
          </div>
        </div>`,
        )
        .join('')}
      <p class="segment__note" style="margin-top: 10px;">票价与时间由深圳地铁官方线路规划接口返回，换乘步行时间与估时为官方数据。</p>
    </div>`;
}

/* -------------------------------------------------------------- network */

/**
 * @returns {void}
 */
function renderNetwork() {
  const lines = state.bootstrap?.lines ?? [];
  root.innerHTML = `
    <section class="page-head">
      <div>
        <h1>线路车站</h1>
        <p>深圳地铁全线网共 ${esc(state.bootstrap?.lines?.length ?? 0)} 条线路、${esc(
          state.bootstrap?.stationCount ?? 0,
        )} 座车站。点击线路展开车站列表，点击车站查看到站时间。</p>
      </div>
    </section>
    <section class="section" id="network-list"></section>`;

  const target = document.getElementById('network-list');
  if (!target) return;

  target.innerHTML = lines
    .map(
      (line) => `
    <div class="line-card">
      <button class="line-card__head" type="button" data-action="toggle-line" data-line="${esc(line.id)}">
        ${lineBadge(lineBadgeLabel(line.id, line.name), line.color, line.name)}
        <span>
          <span class="line-card__name">${esc(line.name)}</span><br />
          <span class="line-card__ends">${esc(line.from)} — ${esc(line.to)}</span>
        </span>
        <span class="line-card__count">${esc(line.stations)} 站</span>
      </button>
      <ul class="line-card__list" ${state.network.open === line.id ? '' : 'hidden'}>
        ${(state.bootstrap?.allStations?.[line.id] ?? [])
          .map(
            (station) => `
          <li><button type="button" data-action="open-station" data-code="${esc(station.code)}">
            <span>${esc(station.name)}</span><small>${esc(station.qp)}</small>
          </button></li>`,
          )
          .join('')}
      </ul>
    </div>`,
    )
    .join('');
}

/* ---------------------------------------------------------------- saved */

/**
 * @returns {void}
 */
function renderSaved() {
  const items = state.saved.items;
  root.innerHTML = `
    <section class="page-head">
      <div>
        <h1>收藏车站</h1>
        <p>收藏保存在这台设备上，下次打开即可直接查看该站到站时间。</p>
      </div>
    </section>
    <section class="section">
      ${
        items.length
          ? `<div class="card"><ul class="kv">${items
              .map(
                (item) => `
            <li>
              <span class="kv__key"><a href="#/station/${esc(item.code)}">${esc(item.name)}</a></span>
              <span class="kv__value">${esc(item.qp)}</span>
              <button class="btn btn--ghost" type="button" data-action="remove-favourite" data-code="${esc(
                item.code,
              )}">移除</button>
            </li>`,
              )
              .join('')}</ul></div>`
          : '<p class="empty">还没有收藏的车站。在车站页面点击「收藏」即可加入。</p>'
      }
    </section>`;
}

/* --------------------------------------------------------------- events */

/**
 * @returns {void}
 */
async function loadSaved() {
  try {
    const payload = await api('/api/favourites');
    state.saved.items = payload.items ?? [];
  } catch {
    state.saved.items = [];
  }
}

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
  if (!target) return;
  const action = target.getAttribute('data-action');

  if (action === 'toggle-theme') {
    const order = ['auto', 'light', 'dark'];
    const next = order[(order.indexOf(readTheme()) + 1) % order.length];
    applyTheme(next);
    return;
  }

  if (action === 'set-day-type') {
    const day = target.getAttribute('data-day') ?? 'work';
    state.station.dayType = day;
    state.station.data = null;
    location.hash = `#/station/${state.station.code}?day=${day}`;
    if (state.view.name === 'station') void renderStation();
    return;
  }

  if (action === 'toggle-favourite') {
    const code = target.getAttribute('data-code') ?? '';
    void (async () => {
      const saved = state.saved.items.some((item) => item.code === code);
      try {
        const payload = saved
          ? await api(`/api/favourites/${encodeURIComponent(code)}`, { method: 'DELETE' })
          : await api('/api/favourites', { method: 'POST', body: JSON.stringify({ code }) });
        state.saved.items = payload.items ?? [];
        showToast(saved ? '已取消收藏' : '已收藏');
        if (state.view.name === 'station') paintStation();
        if (state.view.name === 'saved') renderSaved();
      } catch (error) {
        showToast(error instanceof Error ? error.message : '操作失败');
      }
    })();
    return;
  }

  if (action === 'remove-favourite') {
    const code = target.getAttribute('data-code') ?? '';
    void (async () => {
      try {
        const payload = await api(`/api/favourites/${encodeURIComponent(code)}`, { method: 'DELETE' });
        state.saved.items = payload.items ?? [];
        renderSaved();
        showToast('已移除');
      } catch {
        showToast('操作失败');
      }
    })();
    return;
  }

  if (action === 'pick-station') {
    const slot = target.getAttribute('data-slot') === 'to' ? 'to' : 'from';
    const code = target.getAttribute('data-code') ?? '';
    const station = state.plan.menuResults.find((item) => item.code === code);
    if (station) setStation(slot, station.code, station.name, station.qp);
    return;
  }

  if (action === 'set-riding-type') {
    state.plan.ridingType = target.getAttribute('data-riding') === '1' ? 1 : 0;
    renderPlan();
    return;
  }

  if (action === 'run-plan') {
    void runPlan();
    return;
  }

  if (action === 'swap-plan') {
    const from = state.plan.from;
    const to = state.plan.to;
    state.plan.from = to;
    state.plan.to = from;
    const fromLabel = state.plan.fromLabel;
    state.plan.fromLabel = state.plan.toLabel;
    state.plan.toLabel = fromLabel;
    state.plan.result = null;
    renderPlan();
    return;
  }

  if (action === 'toggle-line') {
    const line = target.getAttribute('data-line') ?? '';
    state.network.open = state.network.open === line ? '' : line;
    renderNetwork();
    return;
  }

  if (action === 'open-station') {
    location.hash = `#/station/${target.getAttribute('data-code') ?? ''}`;
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  for (const menu of document.querySelectorAll('.picker__menu')) {
    /** @type {HTMLElement} */ (menu).hidden = true;
  }
});

/* --------------------------------------------------------------- start */

/**
 * The offline shell. Registration only works on a secure origin, which every
 * published copy is, and a failure here must never break the page.
 */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  });
}

window.addEventListener('hashchange', () => {
  readHash();
  render();
});

async function start() {
  applyTheme(readTheme());
  readHash();
  try {
    state.bootstrap = await api('/api/bootstrap');
  } catch {
    state.bootstrap = { lines: [], popular: [], stationCount: 0 };
  }
  await loadSaved();
  render();
}

void start();
