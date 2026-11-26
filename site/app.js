'use strict';
/* Energy Flows – static client. Reads the pre-computed JSON in data/ and
 * renders two views with Apache ECharts:
 *   #/vyroba?c=cz,de&p=30d|7d|ytd|lastyear&od=YYYY-MM[-DD]&do=…&g=hour|day|month|year&z=<sources>&s=<sort>
 *   #/toky?p=day|7d|30d|ytd|lastyear&d=YYYY-MM-DD&h=<hour index>
 * The URL is the single source of truth: controls only change the hash. */

const DATA = 'data/';
const MAX_HOURLY_DAYS = 62;
const DARK = window.matchMedia('(prefers-color-scheme: dark)').matches;
const HOVER = window.matchMedia('(hover: hover)').matches;
const MONTHS = ['led', 'úno', 'bře', 'dub', 'kvě', 'čvn', 'čvc', 'srp', 'zář', 'říj', 'lis', 'pro'];

const $ = (s) => document.querySelector(s);
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const NF = (d) => new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: d });
const nf0 = NF(0), nf1 = NF(1), nf2 = NF(2);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let META = null;          // countries.json
const SRC = {};           // source key -> {name, color, renewable, kind}
const CC = {};            // country code -> country meta
let renderSeq = 0;

/* ------------------------------------------------------------------ data */
const jsonCache = new Map();
function getJSON(path) {
  if (!jsonCache.has(path)) {
    jsonCache.set(path, fetch(DATA + path).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  }
  return jsonCache.get(path);
}

/* ----------------------------------------------------------------- dates */
const D = {
  parse: (s) => new Date(s + 'T00:00:00Z'),
  fmt: (d) => d.toISOString().slice(0, 10),
  add(s, n) { const d = D.parse(s); d.setUTCDate(d.getUTCDate() + n); return D.fmt(d); },
  days(a, b) { return Math.round((D.parse(b) - D.parse(a)) / 864e5) + 1; },
  range(a, b) { const out = []; for (let s = a; s <= b; s = D.add(s, 1)) out.push(s); return out; },
  months(a, b) {
    const out = []; let y = +a.slice(0, 4), m = +a.slice(5, 7);
    const end = b.slice(0, 7);
    for (;;) { const k = `${y}-${String(m).padStart(2, '0')}`; if (k > end) break; out.push(k); if (++m > 12) { m = 1; y++; } }
    return out;
  },
  monthEnd(ym) { const [y, m] = ym.split('-').map(Number); return D.fmt(new Date(Date.UTC(y, m, 0))); },
  label: (s) => `${+s.slice(8, 10)}. ${+s.slice(5, 7)}. ${s.slice(0, 4)}`,
  short: (s) => `${+s.slice(8, 10)}. ${+s.slice(5, 7)}.`,
  monthLabel: (ym) => `${MONTHS[+ym.slice(5, 7) - 1]} ${ym.slice(2, 4)}`,
  localMidnight: (s) => new Date(s + 'T00:00:00').getTime(), // browser time zone
};
const dtf = {};
function partsIn(ms, tz) {
  const f = (dtf[tz] ||= new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }));
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour % 24 };
}
/** Last local day whose final hour is present in the data. */
function lastCompleteDay(lastHourIso, tz) {
  const ms = Date.parse(lastHourIso);
  const next = partsIn(ms + 3600e3, tz);
  const cur = partsIn(ms, tz).date;
  return next.hour === 0 ? cur : D.add(cur, -1);
}
function normFrom(s) { return s.length === 4 ? `${s}-01-01` : s.length === 7 ? `${s}-01` : s; }
function normTo(s) { return s.length === 4 ? `${s}-12-31` : s.length === 7 ? D.monthEnd(s) : s; }
const isDate = (s) => /^\d{4}(-\d{2}(-\d{2})?)?$/.test(s || '');

/* ------------------------------------------------------------ formatting */
function fmtEnergy(gwh, signed = false) {
  if (gwh == null || Number.isNaN(gwh)) return '–';
  const sign = signed && gwh > 0 ? '+' : '';
  const a = Math.abs(gwh);
  if (a >= 1000) return sign + nf2.format(gwh / 1000) + ' TWh';
  if (a >= 10) return sign + nf0.format(gwh) + ' GWh';
  if (a >= 1) return sign + nf1.format(gwh) + ' GWh';
  return sign + nf0.format(gwh * 1000) + ' MWh';
}
function fmtPower(mw, signed = false) {
  if (mw == null || Number.isNaN(mw)) return '–';
  const sign = signed && mw > 0 ? '+' : '';
  return Math.abs(mw) >= 10000 ? sign + nf1.format(mw / 1000) + ' GW' : sign + nf0.format(mw) + ' MW';
}
const fmtVal = (v, unit, signed) => (unit === 'MW' ? fmtPower(v, signed) : fmtEnergy(v, signed));
const pct = (x) => (x == null || Number.isNaN(x) ? '–' : nf1.format(x * 100) + ' %');

/* ---------------------------------------------------------------- router */
function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [view, qs] = h.split('?');
  return { view: ['toky', 'zebricek'].includes(view) ? view : 'vyroba', q: new URLSearchParams(qs || '') };
}
function hashFor(view, params) {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%2C/g, ',')}`)
    .join('&');
  return `#/${view}${qs ? '?' + qs : ''}`;
}
function go(view, params, replace = false) {
  const h = hashFor(view, params);
  if (replace) { history.replaceState(null, '', h); route(); }
  else if (location.hash !== h) location.hash = h;
  else route();
}
function route() {
  const { view, q } = parseHash();
  document.querySelectorAll('.view').forEach((s) => { s.hidden = s.id !== `view-${view}`; });
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  if (view !== 'toky') stopPlay();
  closeSheet();
  const [render, notice] = { toky: [renderFlows, '#m-notice'], zebricek: [renderRanking, '#r-notice'] }[view]
    || [renderProduction, '#p-notice'];
  render(q).catch((e) => { console.error(e); showNotice(notice, 'Chyba při načítání dat: ' + e.message); });
}
function showNotice(sel, text) { const n = $(sel); n.hidden = !text; n.textContent = text || ''; }

/* ---------------------------------------------------------------- charts */
const charts = {};
function chart(id) {
  if (!charts[id]) charts[id] = echarts.init(document.getElementById(id), DARK ? 'dark' : null);
  return charts[id];
}
window.addEventListener('resize', () => Object.values(charts).forEach((c) => c.resize()));
function baseText() {
  return { color: cssVar('--text'), fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' };
}
const axisCommon = () => ({
  axisLine: { lineStyle: { color: cssVar('--line') } },
  axisLabel: { color: cssVar('--muted'), fontSize: 11 },
  splitLine: { lineStyle: { color: cssVar('--line'), opacity: 0.7 } },
});

/* ======================================================= VIEW: Výroba */
function prodState(q) {
  const avail = META.countries.filter((c) => c.power).map((c) => c.code);
  let cs = (q.get('c') || 'cz').split(',').map((s) => s.trim().toLowerCase()).filter((c) => avail.includes(c));
  cs = [...new Set(cs)];
  if (!cs.length) cs = [avail.includes('cz') ? 'cz' : avail[0]];
  const latest = cs.map((c) => lastCompleteDay(CC[c].power.last_hour, CC[c].tz)).sort()[0];
  let p = q.get('p');
  const od = q.get('od'), dd = q.get('do');
  if (isDate(od) && isDate(dd)) p = 'custom';
  else if (!['1d', '7d', '30d', 'ytd', 'lastyear'].includes(p)) p = '30d';
  const g = ['hour', 'day', 'month', 'year'].includes(q.get('g')) ? q.get('g') : p === '1d' ? 'hour' : 'day';
  let from, to;
  if (p === '1d') { from = to = latest; }
  else if (p === '7d') { to = latest; from = D.add(to, -6); }
  else if (p === '30d') { to = latest; from = D.add(to, -29); }
  else if (p === 'ytd') { to = latest; from = latest.slice(0, 4) + '-01-01'; }
  else if (p === 'lastyear') { const y = +latest.slice(0, 4) - 1; from = `${y}-01-01`; to = `${y}-12-31`; }
  else { from = normFrom(od); to = normTo(dd); if (from > to) [from, to] = [to, from]; }
  const z = q.get('z') ? new Set(q.get('z').split(',')) : null;
  const s = q.get('s') || 'ren';
  return { cs, g, p, from, to, z, s, latest, od: p === 'custom' ? od : null, do: p === 'custom' ? dd : null };
}
function prodParams(st, patch = {}) {
  const s = { ...st, ...patch };
  const custom = s.p === 'custom';
  return {
    c: s.cs.join(','), p: custom ? null : s.p, od: custom ? s.od : null, do: custom ? s.do : null,
    g: s.g, z: s.z ? [...s.z].join(',') : null, s: s.s !== 'ren' ? s.s : null,
  };
}

/** x axis for a step: ms timestamps (hour) or label keys. */
function axisFor(g, from, to) {
  if (g === 'hour') {
    const x = []; const e = D.localMidnight(D.add(to, 1));
    for (let t = D.localMidnight(from); t < e; t += 3600e3) x.push(t);
    return x;
  }
  if (g === 'day') return D.range(from, to);
  const months = D.months(from, to);
  if (g === 'month') return months;
  return [...new Set(months.map((m) => m.slice(0, 4)))];
}

/** Load one country's data aligned to x. Returns {key: number[]}. */
async function loadTable(cc, g, x, from, to) {
  const pm = CC[cc].power;
  const out = {};
  const put = (k, i, v) => { if (v == null) return; (out[k] ||= new Array(x.length).fill(null))[i] = v; };
  if (g === 'hour') {
    const months = D.months(new Date(x[0]).toISOString().slice(0, 10), new Date(x[x.length - 1]).toISOString().slice(0, 10))
      .filter((m) => pm.hourly_months.includes(m));
    const docs = await Promise.all(months.map((m) => getJSON(`power_hourly/${cc}/${m}.json`)));
    const pos = new Map(x.map((t, i) => [t, i]));
    for (const doc of docs) {
      if (!doc) continue;
      const start = Date.parse(doc.start);
      for (const [k, arr] of Object.entries(doc.data)) {
        arr.forEach((v, j) => { const i = pos.get(start + j * 3600e3); if (i !== undefined) put(k, i, v); });
      }
    }
  } else if (g === 'day') {
    const years = [...new Set(x.map((d) => +d.slice(0, 4)))].filter((y) => pm.years.includes(y));
    const docs = await Promise.all(years.map((y) => getJSON(`power_daily/${cc}/${y}.json`)));
    const pos = new Map(x.map((d, i) => [d, i]));
    for (const doc of docs) {
      if (!doc) continue;
      doc.days.forEach((d, j) => {
        const i = pos.get(d);
        if (i === undefined) return;
        for (const k of doc.series) put(k, i, doc.data[k][j]);
      });
    }
  } else {
    const mon = await getJSON('power_monthly.json');
    const c = mon && mon.countries[cc];
    if (c) {
      const lo = from.slice(0, 7), hi = to.slice(0, 7);
      const pos = new Map(x.map((k, i) => [k, i]));
      mon.months.forEach((m, j) => {
        if (m < lo || m > hi) return;
        const i = pos.get(g === 'month' ? m : m.slice(0, 4));
        if (i === undefined) return;
        for (const [k, arr] of Object.entries(c.data)) {
          if (arr[j] == null) continue;
          put(k, i, (out[k]?.[i] || 0) + arr[j]);
        }
      });
    }
  }
  return out;
}

function sumTables(tables, n) {
  const out = {};
  for (const t of tables) {
    for (const [k, arr] of Object.entries(t)) {
      const o = (out[k] ||= new Array(n).fill(null));
      arr.forEach((v, i) => { if (v != null) o[i] = (o[i] || 0) + v; });
    }
  }
  return out;
}
const sum = (arr) => (arr || []).reduce((a, v) => a + (v || 0), 0);
const ordered = (keys) => META.sources.map((s) => s.key).filter((k) => keys.includes(k));

function totals(table, unit) {
  const f = unit === 'MW' ? 1 / 1000 : 1; // MW per hour -> GWh
  // renewable share = renewables (waste 50 %) / generation without storage output,
  // the same definition energy-charts.info uses
  const gen = {}; let genAll = 0, genPrimary = 0, ren = 0, any = false;
  const has = (arr) => (arr || []).some((v) => v != null);
  for (const [k, arr] of Object.entries(table)) {
    const s = SRC[k];
    if (!s || s.kind !== 'generation') continue;
    any ||= has(arr);
    gen[k] = sum(arr) * f; genAll += gen[k];
    if (!s.storage) genPrimary += gen[k];
    ren += gen[k] * (Number(s.renewable) || 0);
  }
  return {
    gen, genAll: any ? genAll : null, ren, renShare: any && genPrimary ? ren / genPrimary : null,
    load: has(table.load) ? sum(table.load) * f : null,
    net: has(table.net_export) ? sum(table.net_export) * f : null,
  };
}

async function renderProduction(q) {
  const seq = ++renderSeq;
  const st = prodState(q);
  homeCountry = st.cs[0];
  const view = $('#view-vyroba');
  drawProdControls(st);

  let g = st.g;
  let notice = '';
  if (g === 'hour' && D.days(st.from, st.to) > MAX_HOURLY_DAYS) {
    notice = `Hodinový krok je k dispozici pro období do ${MAX_HOURLY_DAYS} dní – zobrazuji po dnech.`;
    g = 'day';
  }
  const unit = g === 'hour' ? 'MW' : 'GWh';
  const x = axisFor(g, st.from, st.to);
  view.classList.add('loading');
  const tables = await Promise.all(st.cs.map((cc) => loadTable(cc, g, x, st.from, st.to)));
  if (seq !== renderSeq) return;
  view.classList.remove('loading');

  const table = sumTables(tables, x.length);
  const present = ordered(Object.keys(table).filter((k) => table[k].some((v) => v != null)));
  if (!present.length) notice = (notice ? notice + ' ' : '') + 'Pro zvolené období nejsou k dispozici data.';
  showNotice('#p-notice', notice);

  const names = st.cs.map((c) => CC[c].name);
  $('#p-title').textContent = 'Výroba – ' + (names.length > 3 ? `${names.length} zemí` : names.join(' + '));
  $('#p-unit').textContent = { hour: 'MW, po hodinách', day: 'GWh za den', month: 'GWh za měsíc', year: 'GWh za rok' }[g];
  $('#p-range-label').textContent = st.from === st.to ? D.label(st.from) : `${D.label(st.from)} – ${D.label(st.to)}`;

  const on = (k) => !st.z || st.z.has(k);
  drawLegend(st, present);
  drawMainChart(g, unit, x, table, present.filter(on));
  const tot = totals(table, unit);
  drawKpis(tot, st);
  drawDonut(tot, present.filter(on));
  await drawComparison(st, g, unit, x, tables, present);
}

let multiMode = false; // country picker: one country (default) or several to compare
function drawProdControls(st) {
  // countries: a tap selects just that country; "Porovnat více zemí" turns on multi-select
  if (st.cs.length > 1) multiMode = true;
  const drop = $('#f-countries');
  const multi = $('#f-multi');
  multi.checked = multiMode;
  multi.onchange = () => {
    multiMode = multi.checked;
    if (!multiMode && st.cs.length > 1) go('vyroba', prodParams(st, { cs: [st.cs[0]] }));
  };
  const list = $('#f-countries-list');
  const avail = META.countries.filter((c) => c.power).sort((a, b) => a.name.localeCompare(b.name, 'cs'));
  list.replaceChildren(...avail.map((c) => {
    const b = document.createElement('button');
    b.className = 'chip' + (st.cs.includes(c.code) ? ' on' : '');
    b.textContent = c.name;
    b.onclick = () => {
      if (!multiMode) {
        drop.open = false;
        go('vyroba', prodParams(st, { cs: [c.code] }));
        return;
      }
      const set = new Set(st.cs);
      if (set.has(c.code)) { if (set.size > 1) set.delete(c.code); } else set.add(c.code);
      go('vyroba', prodParams(st, { cs: [...set] }));
    };
    return b;
  }));
  $('#f-countries-label').textContent = st.cs.length > 3
    ? `${st.cs.length} zemí`
    : st.cs.map((c) => CC[c].name).join(', ');
  // period
  const today = partsIn(Date.now(), CC[st.cs[0]].tz).date;
  document.querySelectorAll('#f-period button').forEach((b) => {
    const v = b.dataset.v;
    b.classList.toggle('active', v === st.p);
    if (v === '1d') {
      b.textContent = st.latest === D.add(today, -1) ? 'Včera' : '1 den';
      b.title = D.label(st.latest);
    }
    if (v === 'lastyear') {
      const y = +st.latest.slice(0, 4) - 1;
      b.disabled = !st.cs.some((c) => CC[c].power.years.includes(y));
      b.title = b.disabled ? `Data za rok ${y} nejsou stažená` : '';
    }
    b.onclick = () => {
      if (v === 'custom') { go('vyroba', prodParams(st, { p: 'custom', od: st.from, do: st.to })); return; }
      // 1 day -> hourly step by default; leaving 1 day (or going long) -> daily step
      let g = st.g;
      if (v === '1d') g = 'hour';
      else if (st.p === '1d' && g === 'hour') g = 'day';
      else if ((v === 'ytd' || v === 'lastyear') && g === 'hour') g = 'day';
      go('vyroba', prodParams(st, { p: v, g }));
    };
  });
  const range = $('#f-range');
  range.hidden = st.p !== 'custom';
  const fi = $('#f-from'), ti = $('#f-to');
  fi.value = st.from; ti.value = st.to;
  fi.onchange = ti.onchange = () => {
    if (fi.value && ti.value) go('vyroba', prodParams(st, { p: 'custom', od: fi.value, do: ti.value }));
  };
  // step
  const long = D.days(st.from, st.to) > MAX_HOURLY_DAYS;
  document.querySelectorAll('#f-step button').forEach((b) => {
    b.classList.toggle('active', b.dataset.v === st.g && !(long && st.g === 'hour'));
    if (long && st.g === 'hour' && b.dataset.v === 'day') b.classList.add('active');
    b.disabled = b.dataset.v === 'hour' && long;
    b.onclick = () => go('vyroba', prodParams(st, { g: b.dataset.v }));
  });
}

function drawLegend(st, present) {
  const box = $('#p-legend');
  const keys = present.filter((k) => SRC[k] && SRC[k].kind !== 'balance');
  box.replaceChildren(...keys.map((k) => {
    const b = document.createElement('button');
    const on = !st.z || st.z.has(k);
    b.className = (on ? '' : 'off') + (k === 'load' ? ' load' : '');
    b.title = on ? 'Skrýt' : 'Zobrazit';
    const i = document.createElement('i');
    i.style.background = k === 'load' ? cssVar('--text') : SRC[k].color;
    b.append(i, SRC[k].name);
    b.onclick = () => {
      const set = new Set(st.z || keys);
      set.has(k) ? set.delete(k) : set.add(k);
      const all = keys.every((x) => set.has(x));
      go('vyroba', prodParams(st, { z: all ? null : set }), true);
    };
    return b;
  }));
}

function drawMainChart(g, unit, x, table, keys) {
  const c = chart('chart-main');
  const time = g === 'hour';
  const isBar = g === 'month' || g === 'year' || (!time && x.length <= 2); // 1-2 points: bars, not areas
  const card = cssVar('--card');
  const byName = Object.fromEntries(keys.map((k) => [SRC[k].name, k]));
  const label = (v) => (g === 'day' ? D.short(v) : g === 'month' ? D.monthLabel(v) : v);
  const series = [];
  // bar width as ECharts lays it out (80 % of the band, capped) -> load marker width
  const plotW = Math.max(100, document.getElementById('chart-main').clientWidth - 70);
  const barW = Math.min(46, (plotW / Math.max(1, x.length)) * 0.8);
  for (const k of keys) {
    const s = SRC[k];
    if (!s || s.kind === 'balance') continue;
    const data = time ? x.map((t, i) => [t, table[k][i]]) : table[k];
    if (k === 'load') {
      series.push(isBar
        // bars: a short horizontal mark per bar instead of a line between bars
        ? { name: s.name, type: 'line', data, z: 10, color: cssVar('--text'), lineStyle: { width: 0 },
            symbol: 'rect', symbolSize: [barW + 6, 3], showSymbol: true }
        : { name: s.name, type: 'line', data, symbol: 'none', z: 10, color: cssVar('--text'),
            lineStyle: { width: 2 }, connectNulls: false });
      continue;
    }
    // one stack: ECharts stacks positive (generation) and negative (storage
    // charging) values separately, so both sit on the same bar / x position
    const stack = 'all';
    series.push(isBar
      ? { name: s.name, type: 'bar', stack, data, color: s.color, barMaxWidth: 46, itemStyle: { borderColor: card, borderWidth: 0.5 } }
      : { name: s.name, type: 'line', stack, data, color: s.color, symbol: 'none', lineStyle: { width: 0 },
          areaStyle: { opacity: 0.92 }, emphasis: { focus: 'series' } });
  }
  c.setOption({
    backgroundColor: 'transparent',
    textStyle: baseText(),
    animationDuration: 300,
    grid: { left: 8, right: 10, top: 10, bottom: 8, containLabel: true },
    legend: { show: false },
    tooltip: {
      trigger: 'axis', confine: true, axisPointer: { type: isBar ? 'shadow' : 'line' },
      backgroundColor: card, borderColor: cssVar('--line'), textStyle: { color: cssVar('--text'), fontSize: 12 },
      formatter: (ps) => {
        if (!ps.length) return '';
        const head = time
          ? new Date(ps[0].value[0]).toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
          : g === 'day' ? D.label(ps[0].axisValue) : g === 'month' ? D.monthLabel(ps[0].axisValue) : ps[0].axisValue;
        // sources sorted by value (largest first, storage charging last); load in the footer
        let gen = 0, load = null;
        const items = [];
        for (const p of ps) {
          const v = time ? p.value[1] : p.value;
          if (v == null) continue;
          const key = byName[p.seriesName];
          if (key === 'load') { load = v; continue; }
          if (key && SRC[key].kind === 'generation') gen += v;
          if (v !== 0) items.push({ p, v });
        }
        items.sort((a, b) => b.v - a.v);
        const row = (left, right, extra = '') => `<div style="display:flex;justify-content:space-between;gap:12px;${extra}"><span>${left}</span><b>${right}</b></div>`;
        const line = `border-top:1px solid ${cssVar('--line')};margin-top:4px;padding-top:4px`;
        return `<div style="font-weight:600;margin-bottom:4px">${esc(head)}</div>` +
          items.map(({ p, v }) => row(p.marker + esc(p.seriesName), fmtVal(v, unit))).join('') +
          row('Výroba celkem', fmtVal(gen, unit), line) +
          (load != null ? row('Zatížení (spotřeba)', fmtVal(load, unit)) : '');
      },
    },
    xAxis: time
      ? { type: 'time', ...axisCommon(), splitLine: { show: false } }
      : { type: 'category', data: x, ...axisCommon(), axisLabel: { ...axisCommon().axisLabel, formatter: label }, boundaryGap: isBar, splitLine: { show: false } },
    yAxis: { type: 'value', ...axisCommon(), axisLabel: { ...axisCommon().axisLabel, formatter: (v) => nf0.format(v) } },
    series,
  }, true);
}

function drawKpis(t, st) {
  const box = $('#p-kpis');
  const netTxt = t.net == null ? '–' : fmtEnergy(t.net, true);
  const netSub = t.net == null ? 'bez dat o tocích' : t.net >= 0 ? 'čistý vývoz' : 'čistý dovoz';
  const items = [
    ['Výroba', fmtEnergy(t.genAll), 'všechny zdroje'],
    ['Spotřeba', fmtEnergy(t.load), 'zatížení sítě'],
    ['Saldo', netTxt, netSub],
    ['Podíl OZE', pct(t.renShare), 'na výrobě'],
  ];
  box.replaceChildren(...items.map(([k, v, s]) => {
    const d = document.createElement('div');
    d.className = 'kpi';
    d.innerHTML = `<div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div>`;
    return d;
  }));
}

function drawDonut(t, keys) {
  const c = chart('chart-donut');
  const raw = ordered(keys).filter((k) => SRC[k].kind === 'generation' && t.gen[k] > 0);
  const total = raw.reduce((a, k) => a + t.gen[k], 0);
  const data = raw.map((k) => {
    const big = t.gen[k] / total >= 0.04; // direct labels only for the larger slices
    return { name: SRC[k].name, value: t.gen[k], itemStyle: { color: SRC[k].color },
      label: { show: big }, labelLine: { show: big } };
  });
  c.setOption({
    backgroundColor: 'transparent',
    textStyle: baseText(),
    tooltip: {
      trigger: 'item', confine: true, backgroundColor: cssVar('--card'), borderColor: cssVar('--line'),
      textStyle: { color: cssVar('--text'), fontSize: 12 },
      formatter: (p) => `${p.marker}${esc(p.name)}<br><b>${fmtEnergy(p.value)}</b> (${nf1.format(p.percent)} %)`,
    },
    series: [{
      type: 'pie', radius: ['42%', '68%'], center: ['50%', '52%'], data,
      itemStyle: { borderColor: cssVar('--card'), borderWidth: 2 },
      label: {
        color: cssVar('--text'), fontSize: 11, overflow: 'none', edgeDistance: 4,
        formatter: (p) => `${p.name}\n${nf0.format(p.percent)} %`,
      },
      labelLine: { length: 8, length2: 6 },
      emphasis: { scale: true, scaleSize: 4 },
    }],
  }, true);
}

async function drawComparison(st, g, unit, x, tables, present) {
  const card = $('#cmp-card');
  card.hidden = st.cs.length < 2;
  if (card.hidden) return;
  const genKeys = present.filter((k) => SRC[k]?.kind === 'generation');
  const sel = $('#cmp-sort');
  const opts = [['ren', 'podílu OZE'], ...genKeys.map((k) => [k, SRC[k].name.toLowerCase()])];
  sel.replaceChildren(...opts.map(([v, n]) => { const o = document.createElement('option'); o.value = v; o.textContent = n; return o; }));
  sel.value = opts.some(([v]) => v === st.s) ? st.s : 'ren';
  sel.onchange = () => go('vyroba', prodParams(st, { s: sel.value }), true);

  const rows = st.cs.map((cc, i) => {
    const t = totals(tables[i], unit);
    const share = (k) => (t.genAll ? (t.gen[k] || 0) / t.genAll : 0);
    return { cc, t, share, sortVal: sel.value === 'ren' ? t.renShare || 0 : share(sel.value) };
  }).sort((a, b) => a.sortVal - b.sortVal); // ascending: largest ends on top
  const on = (k) => !st.z || st.z.has(k);
  const c = chart('chart-cmp');
  document.getElementById('chart-cmp').style.height = `${70 + 38 * rows.length}px`;
  c.resize();
  c.setOption({
    backgroundColor: 'transparent',
    textStyle: baseText(),
    grid: { left: 8, right: 14, top: 6, bottom: 6, containLabel: true },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'shadow' }, confine: true, backgroundColor: cssVar('--card'),
      borderColor: cssVar('--line'), textStyle: { color: cssVar('--text'), fontSize: 12 },
      formatter: (ps) => `<b>${esc(ps[0].name)}</b><br>` + ps.filter((p) => p.value > 0.0005).sort((a, b) => b.value - a.value)
        .map((p) => `${p.marker}${esc(p.seriesName)}: <b>${nf1.format(p.value * 100)} %</b>`).join('<br>'),
    },
    xAxis: { type: 'value', max: 1, ...axisCommon(), axisLabel: { ...axisCommon().axisLabel, formatter: (v) => nf0.format(v * 100) + ' %' } },
    yAxis: { type: 'category', data: rows.map((r) => CC[r.cc].name), ...axisCommon(), axisLabel: { ...axisCommon().axisLabel, fontSize: 12, color: cssVar('--text') } },
    series: genKeys.filter(on).map((k) => ({
      name: SRC[k].name, type: 'bar', stack: 'share', color: SRC[k].color, barWidth: '62%',
      itemStyle: { borderColor: cssVar('--card'), borderWidth: 0.5 },
      data: rows.map((r) => r.share(k)),
    })),
  }, true);
}

/* ========================================================= VIEW: Toky */
let mapReady = null;
let geoIndex = null; // [{code, polys}] for tap hit-testing fallback
const proj = {
  project: ([lon, lat]) => [lon * Math.PI / 180, -Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))],
  unproject: ([x, y]) => [x * 180 / Math.PI, (2 * Math.atan(Math.exp(-y)) - Math.PI / 2) * 180 / Math.PI],
};
function ensureMap() {
  if (!mapReady) {
    mapReady = fetch('europe.geojson').then((r) => r.json()).then((gj) => {
      echarts.registerMap('europe', gj);
      geoIndex = gj.features.map((f) => ({ code: f.properties.id, polys: f.geometry.coordinates }));
    });
  }
  return mapReady;
}
function flowsLatest() {
  const f = META.flows;
  return lastCompleteDay(f.last_hour, META.flows_tz);
}
function flowState(q) {
  const f = META.flows;
  const p = ['day', '7d', '30d', 'ytd', 'lastyear'].includes(q.get('p')) ? q.get('p') : 'day';
  let d = /^\d{4}-\d{2}-\d{2}$/.test(q.get('d') || '') ? q.get('d') : flowsLatest();
  if (d < f.from) d = f.from;
  if (d > f.to) d = f.to;
  let from = d, to = d;
  if (p === '7d') from = D.add(d, -6);
  if (p === '30d') from = D.add(d, -29);
  if (p === 'ytd') from = d.slice(0, 4) + '-01-01';
  if (p === 'lastyear') { const y = +d.slice(0, 4) - 1; from = `${y}-01-01`; to = `${y}-12-31`; }
  if (from < f.from) from = f.from;
  const hourly = p === 'day' && f.hourly_days.includes(d);
  const h = hourly && q.get('h') !== null && q.get('h') !== '' ? Math.max(0, parseInt(q.get('h'), 10) || 0) : -1;
  return { p, d, from, to, h, hourly };
}
const flowParams = (st, patch = {}) => {
  const s = { ...st, ...patch };
  return { p: s.p !== 'day' ? s.p : null, d: s.d, h: s.h >= 0 ? s.h : null };
};

/** Border values for the state: [{a, b, ab, ba}] in GWh (period) or MW (hour). */
async function loadBorders(st) {
  if (st.h >= 0) {
    const doc = await getJSON(`flows_hourly/${st.d}.json`);
    if (!doc) return { unit: 'MW', borders: [], doc };
    const h = Math.min(st.h, doc.hours - 1);
    const borders = Object.entries(doc.borders).map(([k, arr]) => {
      const [a, b] = k.split('-');
      const v = arr[h];
      return v == null ? null : { a, b, ab: Math.max(v, 0), ba: Math.max(-v, 0) };
    }).filter(Boolean);
    return { unit: 'MW', borders, doc, h };
  }
  const years = [...new Set([st.from.slice(0, 4), st.to.slice(0, 4)])].map(Number)
    .filter((y) => META.flows.years.includes(y));
  const docs = (await Promise.all(years.map((y) => getJSON(`flows_daily/${y}.json`)))).filter(Boolean);
  const acc = {};
  for (const doc of docs) {
    const idx = doc.days.map((d, i) => (d >= st.from && d <= st.to ? i : -1)).filter((i) => i >= 0);
    for (const [k, v] of Object.entries(doc.borders)) {
      const o = (acc[k] ||= { ab: 0, ba: 0, n: 0 });
      for (const i of idx) { if (v.ab[i] != null) { o.ab += v.ab[i]; o.ba += v.ba[i]; o.n++; } }
    }
  }
  const borders = Object.entries(acc).filter(([, o]) => o.n).map(([k, o]) => {
    const [a, b] = k.split('-');
    return { a, b, ab: o.ab, ba: o.ba };
  });
  return { unit: 'GWh', borders };
}

function saldoByCountry(borders) {
  const s = {};
  for (const { a, b, ab, ba } of borders) {
    s[a] = (s[a] || 0) + ab - ba;
    s[b] = (s[b] || 0) + ba - ab;
  }
  return s;
}

let flowCtx = null; // last rendered flows state, for taps and play
async function renderFlows(q) {
  const seq = ++renderSeq;
  const st = flowState(q);
  drawFlowControls(st);
  await ensureMap();
  const view = $('#view-toky');
  view.classList.add('loading');
  const res = await loadBorders(st);
  if (seq !== renderSeq) return;
  view.classList.remove('loading');

  // hour slider
  const slider = $('#m-hour');
  const hours = res.doc ? res.doc.hours : 24;
  slider.max = String(hours - 1);
  slider.value = String(st.h);
  let caption;
  if (st.h >= 0 && res.doc) {
    const start = Date.parse(res.doc.start) + res.h * 3600e3;
    const hh = partsIn(start, META.flows_tz).hour;
    $('#m-hour-label').textContent = `${String(hh).padStart(2, '0')}:00–${String((hh + 1) % 24).padStart(2, '0')}:00`;
    caption = `${D.label(st.d)}, ${$('#m-hour-label').textContent}`;
  } else {
    $('#m-hour-label').textContent = st.hourly ? 'celý den' : '';
    caption = st.p === 'day' ? D.label(st.d) : `${D.label(st.from)} – ${D.label(st.to)}`;
  }
  $('#m-caption').textContent = caption + (res.unit === 'MW' ? ' · MW' : ' · GWh');
  showNotice('#m-notice', res.borders.length ? '' : 'Pro zvolené období nejsou k dispozici data o tocích.');

  flowCtx = { st, ...res, saldo: saldoByCountry(res.borders), caption };
  drawMap(flowCtx);
}

function drawFlowControls(st) {
  const f = META.flows;
  document.querySelectorAll('#m-period button').forEach((b) => {
    b.classList.toggle('active', b.dataset.v === st.p);
    if (b.dataset.v === 'lastyear') b.disabled = !f.years.includes(+st.d.slice(0, 4) - 1);
    b.onclick = () => { stopPlay(); go('toky', flowParams(st, { p: b.dataset.v, h: -1 })); };
  });
  const di = $('#m-date');
  di.min = f.from; di.max = f.to; di.value = st.d;
  di.onchange = () => { if (di.value) { stopPlay(); go('toky', flowParams(st, { d: di.value, h: st.h })); } };
  const step = st.p === 'day' ? 1 : st.p === '7d' ? 7 : st.p === '30d' ? 30 : 0;
  const shift = (dir) => {
    let d = step ? D.add(st.d, dir * step) : `${+st.d.slice(0, 4) + dir}${st.d.slice(4)}`;
    if (d > f.to) d = f.to;
    if (d < f.from) d = f.from;
    stopPlay(); go('toky', flowParams(st, { d }));
  };
  $('#m-prev').onclick = () => shift(-1);
  $('#m-next').onclick = () => shift(1);
  $('#m-prev').disabled = st.d <= f.from;
  $('#m-next').disabled = st.d >= f.to;
  $('#m-hourrow').hidden = !st.hourly;
  const slider = $('#m-hour');
  slider.oninput = () => { stopPlay(); go('toky', flowParams(st, { h: +slider.value }), true); };
  $('#m-play').onclick = () => (playTimer ? stopPlay() : startPlay());
}

function drawMap(ctx) {
  const c = chart('map');
  const { borders, saldo, unit } = ctx;
  const withFlows = new Set(META.countries.filter((x) => x.has_flows).map((x) => x.code));
  const values = Object.entries(saldo).filter(([k]) => withFlows.has(k));
  const maxAbs = Math.max(1e-9, ...values.map(([, v]) => Math.abs(v)));
  const maxNet = Math.max(1e-9, ...borders.map((b) => Math.abs(b.ab - b.ba)));
  const flowColor = DARK ? '#a9c8f5' : '#163a6e';

  const lines = [];
  for (const br of borders) {
    const net = br.ab - br.ba;
    const [from, to] = net >= 0 ? [br.a, br.b] : [br.b, br.a];
    const A = CC[from]?.center, B = CC[to]?.center;
    if (!A || !B || Math.abs(net) < maxNet * 0.004) continue;
    const lerp = (t) => [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t];
    const w = 1.2 + 7 * Math.sqrt(Math.abs(net) / maxNet);
    lines.push({
      coords: [lerp(0.2), lerp(0.8)], br, net: Math.abs(net), from, to,
      lineStyle: { width: w }, symbolSize: [0, Math.max(7, w * 2.2)],
    });
  }
  const labels = META.countries.filter((x) => x.center && (withFlows.has(x.code) || saldo[x.code] !== undefined))
    .map((x) => ({ name: x.code, value: x.center }));

  const tooltip = HOVER ? {
    trigger: 'item', confine: true, backgroundColor: cssVar('--card'), borderColor: cssVar('--line'),
    textStyle: { color: cssVar('--text'), fontSize: 12 },
    formatter: (p) => {
      if (p.seriesType === 'lines') {
        const d = p.data;
        return `<b>${esc(CC[d.from].name)} → ${esc(CC[d.to].name)}</b><br>${fmtVal(d.net, unit)}`;
      }
      if (p.seriesType === 'map' || p.componentType === 'geo') {
        const code = p.name; const v = saldo[code];
        const name = CC[code]?.name || code.toUpperCase();
        if (!withFlows.has(code) || v === undefined) return `<b>${esc(name)}</b><br><span style="opacity:.7">bez vlastních dat</span>`;
        return `<b>${esc(name)}</b><br>saldo ${fmtVal(v, unit, true)} (${v >= 0 ? 'vývoz' : 'dovoz'})`;
      }
      return '';
    },
  } : { show: false };

  // Diverging fill: import (red) <- neutral grey -> export (green), intensity by size.
  const neu = hexRgb(cssVar('--neu')), imp = hexRgb(cssVar('--imp')), exp = hexRgb(cssVar('--exp'));
  const regions = values.map(([k, v]) => {
    const t = Math.pow(Math.min(1, Math.abs(v) / maxAbs), 0.75);
    const to = v >= 0 ? exp : imp;
    const rgb = neu.map((n, i) => Math.round(n + (to[i] - n) * t));
    return { name: k, itemStyle: { areaColor: `rgb(${rgb.join(',')})` }, emphasis: { itemStyle: { areaColor: `rgb(${rgb.join(',')})`, borderColor: cssVar('--text'), borderWidth: 1.2 } } };
  });

  const el = document.getElementById('map');
  const portrait = el.clientHeight > el.clientWidth;
  const prev = c.getOption && c.getOption();
  const keepView = prev && prev.geo && prev.geo[0];
  c.setOption({
    backgroundColor: 'transparent',
    textStyle: baseText(),
    tooltip,
    geo: {
      map: 'europe', nameProperty: 'id', projection: proj, roam: true, triggerEvent: true,
      center: keepView ? keepView.center : proj.project(portrait ? [10, 53.4] : [11, 50.5]),
      zoom: keepView ? keepView.zoom : (portrait ? 2.15 : 1.5),
      scaleLimit: { min: 1, max: 12 },
      itemStyle: { areaColor: cssVar('--land'), borderColor: cssVar('--border-map'), borderWidth: 0.8 },
      emphasis: { label: { show: false }, itemStyle: { areaColor: cssVar('--land-hover') } },
      select: { disabled: true },
      selectedMode: false,
      tooltip: { show: HOVER },
      regions,
    },
    series: [
      {
        type: 'lines', coordinateSystem: 'geo', zlevel: 1, data: lines,
        symbol: ['none', 'arrow'],
        lineStyle: { color: flowColor, opacity: 0.85, curveness: 0.12, cap: 'round' },
        effect: { show: true, period: 3, trailLength: 0.15, symbol: 'circle', symbolSize: 4, color: DARK ? '#ffffff' : '#ffe680' },
        emphasis: { lineStyle: { opacity: 1 } },
      },
      {
        type: 'scatter', coordinateSystem: 'geo', zlevel: 2, silent: true, symbolSize: 0, data: labels,
        label: {
          show: true, formatter: (p) => p.name.toUpperCase(), color: cssVar('--text'), fontSize: 10, fontWeight: 600,
          textBorderColor: cssVar('--card'), textBorderWidth: 2,
        },
      },
    ],
  }, { replaceMerge: ['series', 'geo'] });

  if (!c.__wired) {
    c.__wired = true;
    let lastLineTap = 0;
    c.on('click', (p) => {
      if (p.seriesType === 'lines') { lastLineTap = Date.now(); openBorderSheet(p.data.br); return; }
      if (p.seriesType === 'map' || p.componentType === 'geo') { lastLineTap = Date.now(); openCountrySheet(p.name); }
    });
    // Fallback hit-test for taps on regions that the map series does not report.
    c.getZr().on('click', (e) => {
      setTimeout(() => {
        if (Date.now() - lastLineTap < 300) return;
        const pt = [e.offsetX, e.offsetY];
        if (!c.containPixel('geo', pt)) return;
        const [lon, lat] = c.convertFromPixel('geo', pt);
            const hit = geoIndex.find((g) => g.polys.some((poly) => inRing(lon, lat, poly[0])));
        if (hit) openCountrySheet(hit.code);
      }, 0);
    });
  }
}
function hexRgb(h) {
  const s = h.replace('#', '');
  const f = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16));
}
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/* ----------------------------------------------------------- play */
let playTimer = null;
function startPlay() {
  const { st } = flowCtx || {};
  if (!st) return;
  const days = META.flows.hourly_days;
  let { d, h } = st;
  if (!days.includes(d)) { d = days[0]; h = -1; }
  $('#m-play').classList.add('on');
  $('#m-play').textContent = '❚❚';
  const tick = async () => {
    const doc = await getJSON(`flows_hourly/${d}.json`);
    h += 1;
    if (!doc || h >= doc.hours) {
      const i = days.indexOf(d);
      if (i < 0 || i >= days.length - 1) { stopPlay(); return; }
      d = days[i + 1]; h = 0;
    }
    const next = days[days.indexOf(d) + 1];
    if (next) getJSON(`flows_hourly/${next}.json`); // prefetch
    if (!playTimer) return;
    go('toky', { d, h }, true);
    playTimer = setTimeout(tick, 900);
  };
  playTimer = setTimeout(tick, 0);
}
function stopPlay() {
  if (playTimer) clearTimeout(playTimer);
  playTimer = null;
  const b = $('#m-play');
  if (b) { b.classList.remove('on'); b.textContent = '▶'; }
}

/* ----------------------------------------------------------- bottom sheet */
function openSheet(html) {
  $('#sheet-body').innerHTML = html;
  $('#sheet').hidden = false;
}
function closeSheet() { $('#sheet').hidden = true; }

async function powerFor(cc, st) {
  // production / consumption of a country for the current flows state
  const pm = CC[cc]?.power;
  if (!pm) return null;
  if (st.h >= 0 && flowCtx.doc) {
    const ts = Date.parse(flowCtx.doc.start) + flowCtx.h * 3600e3;
    const month = new Date(ts).toISOString().slice(0, 7);
    if (!pm.hourly_months.includes(month)) return null;
    const doc = await getJSON(`power_hourly/${cc}/${month}.json`);
    const i = Math.round((ts - Date.parse(doc.start)) / 3600e3);
    const t = {}; for (const k of doc.series) t[k] = [doc.data[k][i]];
    return { unit: 'MW', ...totals(t, 'GWh') }; // values stay in MW
  }
  const x = D.range(st.from, st.to);
  const t = await loadTable(cc, 'day', x, st.from, st.to);
  return { unit: 'GWh', ...totals(t, 'GWh') };
}

async function openCountrySheet(code) {
  if (!flowCtx) return;
  const { st, borders, unit, caption } = flowCtx;
  const name = CC[code]?.name || code.toUpperCase();
  const mine = borders.filter((b) => b.a === code || b.b === code).map((b) => {
    const out = b.a === code ? b.ab : b.ba, inn = b.a === code ? b.ba : b.ab;
    const nb = b.a === code ? b.b : b.a;
    return { nb, out, inn, net: out - inn };
  }).sort((x, y) => Math.abs(y.net) - Math.abs(x.net));
  const own = CC[code]?.has_flows;
  const saldo = mine.reduce((a, r) => a + r.net, 0);
  openSheet(`<h3>${esc(name)}</h3><div class="muted">${esc(caption)}</div><p class="muted">Načítám…</p>`);
  const pw = await powerFor(code, st).catch(() => null);
  const cls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
  const rows = mine.map((r) => `<tr><td>${esc(CC[r.nb]?.name || r.nb.toUpperCase())}</td><td>${fmtVal(r.out, unit)}</td><td>${fmtVal(r.inn, unit)}</td><td class="${cls(r.net)}">${fmtVal(r.net, unit, true)}</td></tr>`).join('');
  const linkG = st.h >= 0 ? 'hour' : 'day';
  const link = CC[code]?.power ? hashFor('vyroba', { c: code, od: st.from, do: st.to, g: linkG }) : null;
  openSheet(`
    <h3>${esc(name)}</h3><div class="muted">${esc(caption)}</div>
    <div class="kpis" style="margin-top:10px">
      <div class="kpi"><div class="k">Výroba</div><div class="v">${pw ? fmtVal(pw.genAll, pw.unit) : '–'}</div></div>
      <div class="kpi"><div class="k">Spotřeba</div><div class="v">${pw ? fmtVal(pw.load, pw.unit) : '–'}</div></div>
      <div class="kpi"><div class="k">Saldo toků</div><div class="v ${cls(saldo)}">${mine.length ? fmtVal(saldo, unit, true) : '–'}</div>
        <div class="s">${!own ? 'jen z dat sousedů' : saldo >= 0 ? 'čistý vývoz' : 'čistý dovoz'}</div></div>
      <div class="kpi"><div class="k">Podíl OZE</div><div class="v">${pw ? pct(pw.renShare) : '–'}</div></div>
    </div>
    ${mine.length ? `<table><thead><tr><th>Soused</th><th>Vývoz</th><th>Dovoz</th><th>Saldo</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="muted">Žádné toky.</p>'}
    ${link ? `<a class="btn" href="${link}">Výroba v pohledu Výroba →</a>` : ''}`);
}

function openBorderSheet(br) {
  if (!flowCtx) return;
  const { unit, caption } = flowCtx;
  const A = CC[br.a]?.name || br.a, B = CC[br.b]?.name || br.b;
  const net = br.ab - br.ba;
  const [f, t] = net >= 0 ? [A, B] : [B, A];
  openSheet(`
    <h3>${esc(A)} ↔ ${esc(B)}</h3><div class="muted">${esc(caption)}</div>
    <table>
      <tr><td>${esc(A)} → ${esc(B)}</td><td>${fmtVal(br.ab, unit)}</td></tr>
      <tr><td>${esc(B)} → ${esc(A)}</td><td>${fmtVal(br.ba, unit)}</td></tr>
      <tr><th>Čistý tok</th><th>${esc(f)} → ${esc(t)}: ${fmtVal(Math.abs(net), unit)}</th></tr>
    </table>
    <p class="hint">Fyzické toky přes hranici. Za období se sčítají hodinové čisté toky v každém směru zvlášť.</p>`);
}

/* ===================================================== VIEW: Žebříček */
let homeCountry = 'cz'; // highlighted in rankings (last country opened in Výroba)
const GROUPS = [
  ['sol', 'Slunce', 'solar'],
  ['win', 'Vítr', 'wind_onshore'],
  ['hyd', 'Voda', 'hydro_run_of_river'],
  ['bio', 'Biomasa, odpad a ostatní', 'biomass'],
];
const RANK_DAYS = { '1d': 1, '7d': 7, '30d': 30 };

async function renderRanking(q) {
  const seq = ++renderSeq;
  const m = q.get('m') === 'trade' ? 'trade' : 'ren';
  const p = ['1d', '7d', '30d', 'ytd', 'lastyear'].includes(q.get('p')) ? q.get('p') : '30d';
  const u = ['pct', 'abs'].includes(q.get('u')) ? q.get('u') : m === 'ren' ? 'pct' : 'abs';
  const st = { m, p, u };
  const params = (patch) => {
    const s = { ...st, ...patch };
    return { m: s.m, p: s.p, u: s.u === (s.m === 'ren' ? 'pct' : 'abs') ? null : s.u };
  };
  document.querySelectorAll('#r-metric button').forEach((b) => {
    b.classList.toggle('active', b.dataset.v === m);
    b.onclick = () => go('zebricek', params({ m: b.dataset.v, u: b.dataset.v === 'ren' ? 'pct' : 'abs' }));
  });
  document.querySelectorAll('#r-unit button').forEach((b) => {
    b.classList.toggle('active', b.dataset.v === u);
    b.textContent = b.dataset.v === 'abs' ? 'TWh' : m === 'ren' ? '% výroby' : '% spotřeby';
    b.onclick = () => go('zebricek', params({ u: b.dataset.v }), true);
  });

  const R = await getJSON('ranking.json');
  if (seq !== renderSeq) return;
  if (!R) { showNotice('#r-notice', 'Chybí data žebříčku – spusťte build.py.'); return; }
  const F = Object.fromEntries(R.fields.map((f, i) => [f, i]));
  const ccs = Object.keys(R.countries);

  // period end = latest day that most countries have complete
  let end = R.days.length - 1;
  for (; end > 0; end--) {
    const rows = ccs.map((c) => R.countries[c].d[end]).filter(Boolean);
    if (rows.length && rows.filter((r) => r[F.h] >= 23).length >= 0.75 * rows.length) break;
  }
  const endDay = R.days[end];
  let pick, label;
  if (RANK_DAYS[p]) {
    const n = RANK_DAYS[p];
    const idx = R.days.map((_, i) => i).filter((i) => i > end - n && i <= end);
    pick = (c) => idx.map((i) => R.countries[c].d[i]);
    label = n === 1 ? D.label(endDay) : `${D.label(R.days[idx[0]])} – ${D.label(endDay)}`;
    document.querySelector('#r-period button[data-v="1d"]').textContent =
      endDay === D.add(partsIn(Date.now(), 'Europe/Prague').date, -1) ? 'Včera' : '1 den';
  } else {
    const y = p === 'ytd' ? endDay.slice(0, 4) : String(+endDay.slice(0, 4) - 1);
    const idx = R.months.map((mm, i) => [mm, i]).filter(([mm]) => mm.startsWith(y) && (p !== 'ytd' || mm <= endDay.slice(0, 7))).map(([, i]) => i);
    pick = (c) => idx.map((i) => R.countries[c].m[i]);
    label = p === 'ytd' ? `1. 1. – ${D.label(endDay)}` : `rok ${y}`;
  }
  document.querySelectorAll('#r-period button').forEach((b) => {
    b.classList.toggle('active', b.dataset.v === p);
    if (b.dataset.v === 'lastyear') b.disabled = !R.months.some((mm) => mm.startsWith(String(+endDay.slice(0, 4) - 1)));
    b.onclick = () => go('zebricek', params({ p: b.dataset.v }));
  });

  // aggregate each country over the period
  const agg = ccs.map((c) => {
    const s = new Array(R.fields.length).fill(null);
    for (const row of pick(c)) {
      if (!row) continue;
      row.forEach((v, i) => { if (v != null) s[i] = (s[i] || 0) + v; });
    }
    return { cc: c, s };
  }).filter((a) => a.s[F.h]);
  const maxH = Math.max(0, ...agg.map((a) => a.s[F.h]));
  agg.forEach((a) => { a.partial = a.s[F.h] < 0.95 * maxH; });

  let items;
  if (m === 'ren') {
    items = agg.filter((a) => a.s[F.gen] > 0).map((a) => {
      const g = Object.fromEntries(GROUPS.map(([k]) => [k, a.s[F[k]] || 0]));
      const ren = Object.values(g).reduce((x, y) => x + y, 0);
      return { ...a, g, ren, gen: a.s[F.gen], value: u === 'pct' ? ren / a.s[F.gen] : ren };
    });
  } else {
    items = agg.filter((a) => a.s[F.exp] != null && (u === 'abs' || a.s[F.load] > 0)).map((a) => {
      const net = a.s[F.exp] - a.s[F.imp];
      return { ...a, net, exp: a.s[F.exp], imp: a.s[F.imp], load: a.s[F.load],
        value: u === 'pct' ? net / a.s[F.load] : net };
    });
  }
  items.sort((a, b) => b.value - a.value);
  showNotice('#r-notice', items.length ? '' : 'Pro zvolené období nejsou k dispozici data.');

  const abs = u === 'abs';
  const twh = abs && Math.max(...items.map((i) => Math.abs(i.value)), 0) >= 1000;
  const fmtAbs = (gwh) => (twh ? nf1.format(gwh / 1000) + ' TWh' : nf0.format(gwh) + ' GWh');
  const fmtPct = (x) => nf1.format(x * 100) + ' %';
  const show = (v) => (abs ? fmtAbs(v) : fmtPct(v));
  $('#r-title').textContent = m === 'ren'
    ? (abs ? 'Výroba z obnovitelných zdrojů' : 'Podíl obnovitelných zdrojů na výrobě')
    : (abs ? 'Saldo přeshraničních toků' : 'Saldo toků v % spotřeby');
  $('#r-sub').textContent = `${label} · ${items.length} zemí`;
  $('#r-legend').innerHTML = m === 'ren'
    ? GROUPS.map(([, n, src]) => `<span><i style="background:${SRC[src].color}"></i>${n}</span>`).join('')
    : `<span><i style="background:${cssVar('--exp')}"></i>čistý vývoz</span><span><i style="background:${cssVar('--imp')}"></i>čistý dovoz</span>`;
  const anyPartial = items.some((i) => i.partial);
  $('#r-hint').textContent = (m === 'ren'
    ? 'Podíl OZE na domácí výrobě (ne na spotřebě). OZE = slunce, vítr, voda, biomasa, geotermální, ostatní OZE a 50 % odpadu; přečerpávací elektrárny a baterie se do výroby nepočítají (jen vracejí uloženou energii). Stejná definice jako energy-charts.info.'
    : 'Fyzické toky přes hranice za období: vývoz − dovoz. Nahoře největší vývozci, dole největší dovozci.')
    + ' Klepnutím na zemi otevřete její výrobu.' + (anyPartial ? ' * neúplná data za období.' : '');

  const el = document.getElementById('chart-rank');
  el.style.height = `${60 + items.length * 26}px`;
  const c = chart('chart-rank');
  c.resize();
  const byCc = Object.fromEntries(items.map((i) => [i.cc, i]));
  const name = (cc) => (CC[cc]?.name || cc.toUpperCase()) + (byCc[cc]?.partial ? ' *' : '');
  const scale = (v) => (abs ? (twh ? v / 1000 : v) : v * 100); // axis units: TWh/GWh or %
  const tipRow = (l, r) => `<div style="display:flex;justify-content:space-between;gap:14px"><span>${l}</span><b>${r}</b></div>`;
  let series;
  if (m === 'ren') {
    series = GROUPS.map(([k, n, src], gi) => ({
      name: n, type: 'bar', stack: 'ren', color: SRC[src].color, barWidth: 16,
      itemStyle: { borderColor: cssVar('--card'), borderWidth: 0.5 },
      data: items.map((i) => scale(abs ? i.g[k] : i.g[k] / i.gen)),
      label: gi === GROUPS.length - 1
        ? { show: true, position: 'right', fontSize: 11, color: cssVar('--text'), formatter: (pp) => show(items[pp.dataIndex].value) }
        : { show: false },
    }));
  } else {
    series = [{
      name: 'Saldo', type: 'bar', barWidth: 16,
      data: items.map((i) => ({
        value: scale(i.value),
        itemStyle: { color: i.value >= 0 ? cssVar('--exp') : cssVar('--imp') },
        label: { position: i.value >= 0 ? 'right' : 'left' },
      })),
      label: { show: true, fontSize: 11, color: cssVar('--text'), formatter: (pp) => (items[pp.dataIndex].value > 0 ? '+' : '') + show(items[pp.dataIndex].value) },
    }];
  }
  c.setOption({
    backgroundColor: 'transparent',
    textStyle: baseText(),
    animationDuration: 300,
    grid: { left: 6, right: 64, top: 6, bottom: 6, containLabel: true },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'shadow' }, confine: true,
      backgroundColor: cssVar('--card'), borderColor: cssVar('--line'), textStyle: { color: cssVar('--text'), fontSize: 12 },
      formatter: (ps) => {
        const i = byCc[ps[0].name];
        if (!i) return '';
        const head = `<div style="font-weight:600;margin-bottom:4px">${esc(name(i.cc))}</div>`;
        if (m === 'ren') {
          return head + tipRow('OZE celkem', `${fmtPct(i.ren / i.gen)} · ${fmtEnergy(i.ren)}`)
            + GROUPS.map(([k, n, src]) => tipRow(`<i style="display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;background:${SRC[src].color}"></i>${n}`, `${fmtPct(i.g[k] / i.gen)} · ${fmtEnergy(i.g[k])}`)).join('')
            + tipRow('Výroba (bez akumulace)', fmtEnergy(i.gen));
        }
        return head + tipRow('Vývoz', fmtEnergy(i.exp)) + tipRow('Dovoz', fmtEnergy(i.imp))
          + tipRow('Saldo', fmtEnergy(i.net, true))
          + (i.load ? tipRow('v % spotřeby', (i.net > 0 ? '+' : '') + fmtPct(i.net / i.load)) : '');
      },
    },
    xAxis: m === 'ren'
      ? {
          type: 'value', ...axisCommon(), position: 'top', max: abs ? null : 100,
          axisLabel: { ...axisCommon().axisLabel, formatter: (v) => nf0.format(v) + (abs ? '' : ' %') },
        }
      : (() => {
          // diverging bars: leave room left of the largest import for its value label
          const vals = items.map((i) => scale(i.value));
          const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals), span = hi - lo || 1;
          return {
            type: 'value', ...axisCommon(), min: lo < 0 ? lo - span * 0.42 : 0, max: hi > 0 ? hi : span * 0.05,
            axisLabel: { show: false }, splitLine: { show: false },
          };
        })(),
    yAxis: {
      type: 'category', inverse: true, data: items.map((i) => i.cc), ...axisCommon(),
      axisTick: { show: false }, triggerEvent: true,
      axisLabel: {
        ...axisCommon().axisLabel, fontSize: 12, color: cssVar('--text'),
        formatter: (cc) => (cc === homeCountry ? `{home|${name(cc)}}` : name(cc)),
        rich: { home: { fontWeight: 700, fontSize: 12, color: cssVar('--accent') } },
      },
    },
    series,
  }, true);
  if (!c.__wired) {
    c.__wired = true;
    let last = 0;
    const open = (cc) => {
      if (Date.now() - last < 400 || !cc || !CC[cc]?.power) return;
      last = Date.now();
      go('vyroba', { c: cc, p: c.__period });
    };
    // bars and country names...
    c.on('click', (pp) => open(pp.componentType === 'yAxis' ? pp.value : pp.name));
    // ...and anywhere else on the row
    c.getZr().on('click', (e) => setTimeout(() => {
      const pt = [e.offsetX, e.offsetY];
      if (!c.containPixel('grid', pt)) return;
      const [, yi] = c.convertFromPixel('grid', pt);
      open(c.getOption().yAxis[0].data[Math.round(yi)]);
    }, 0));
  }
  c.__period = p;
}

/* ------------------------------------------------------------------ init */
async function init() {
  if (!window.echarts) {
    document.querySelector('main').innerHTML = '<p class="notice">Nepodařilo se načíst knihovnu grafů (ECharts z CDN). Jste online?</p>';
    return;
  }
  META = await fetch(DATA + 'countries.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!META || !META.countries.some((c) => c.power)) {
    document.querySelector('main').innerHTML = '<p class="notice">Zatím nejsou k dispozici žádná data. Spusťte <code>make fetch</code> a <code>make build</code>.</p>';
    return;
  }
  for (const s of META.sources) SRC[s.key] = s;
  for (const c of META.countries) CC[c.code] = c;
  if (META.updated) {
    $('#updated').textContent = 'Data do ' + new Date(Date.parse(META.updated) + 3600e3)
      .toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  if (!META.flows) document.querySelector('.tabs a[data-view="toky"]').hidden = true;
  $('#sheet-close').onclick = closeSheet;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
  document.addEventListener('click', (e) => {
    const det = $('#f-countries');
    if (det.open && !det.contains(e.target)) det.open = false;
  });
  window.addEventListener('hashchange', route);
  route();
}
document.addEventListener('DOMContentLoaded', init);
