'use strict';
/* Energy Flows – world part. Data: Ember (yearly for ~210 countries, monthly
 * for ~90), pre-computed by build_world.py into data/world/. Uses the helpers
 * of app.js (getJSON, D, chart, go, hashFor, openSheet, …).
 *   #/svet/vyroba?e=CHN,USA&g=month|year&p=1y|3y|10y|all&u=abs|pct&z=<sources>&s=<sort>
 *   #/svet/mapa?m=<metric>&y=latest|ltm|<year>
 *   #/svet/zebricek?m=<metric>&y=latest|ltm|<year>&r=top|agg|all|<region>&u=pct|abs
 *   #/svet/srovnani?e=europe,USA,CHN,RUS&g=year|month */

let W = null;          // world/meta.json
const WE = {};         // entity code -> meta
const WSRC = {};       // source key -> meta
let wHome = null;      // last single entity shown in world Výroba (highlighted in the ranking)
const wShared = { m: 'ren', y: 'latest', r: 'top' }; // carried between Mapa and Žebříček via the tab links

Object.assign(VIEWS, {
  'svet/vyroba': { area: 'world', notice: '#w-notice', render: (q) => renderWorldProd(q) },
  'svet/mapa': { area: 'world', notice: '#wm-notice', render: (q) => renderWorldMap(q) },
  'svet/zebricek': { area: 'world', notice: '#wr-notice', render: (q) => renderWorldRank(q) },
  'svet/srovnani': { area: 'world', notice: '#wc-notice', render: (q) => renderWorldCompare(q) },
});

async function worldMeta() {
  if (W) return W;
  const m = await getJSON('world/meta.json');
  if (!m) throw new Error('chybí data světa (spusťte pipeline/fetch_world.py a build.py)');
  W = m;
  for (const s of m.sources) WSRC[s.key] = s;
  for (const e of m.entities) WE[e.code] = e;
  $('#updated-world').textContent = `Měsíční data do ${fmtYm(m.updated)}, roční do ${m.latest_year}`;
  return W;
}
const FUELS = () => W.sources.map((s) => s.key);
const wName = (c) => WE[c]?.name || c;
const fmtYm = (ym) => (ym ? `${+ym.slice(5, 7)}/${ym.slice(0, 4)}` : '–');
function addMonths(ym, n) {
  let y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1 + n;
  y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
  return `${y}-${String(m + 1).padStart(2, '0')}`;
}
function fmtTWh(v, signed = false) {
  if (v == null || Number.isNaN(v)) return '–';
  const sign = signed && v > 0 ? '+' : '';
  const a = Math.abs(v);
  if (a >= 100) return sign + nf0.format(v) + ' TWh';
  if (a >= 10) return sign + nf1.format(v) + ' TWh';
  if (a >= 1 || a === 0) return sign + nf2.format(v) + ' TWh';
  return sign + nf0.format(v * 1000) + ' GWh';
}
const norm = (s) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const genOf = (v) => FUELS().reduce((a, k) => a + (v[k] || 0), 0);
const tipCss = () => ({ backgroundColor: cssVar('--card'), borderColor: cssVar('--line'), textStyle: { color: cssVar('--text'), fontSize: 12 } });
const tipRow = (l, r, extra = '') => `<div style="display:flex;justify-content:space-between;gap:14px;${extra}"><span>${l}</span><b>${r}</b></div>`;
const swatch = (color) => `<i style="display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;background:${color}"></i>`;

/* ================================================== VIEW: Svět – Výroba */
function wProdState(q) {
  let es = (q.get('e') || '').split(',').map((s) => s.trim()).filter((c) => WE[c]);
  es = [...new Set(es)];
  if (!es.length) es = [wHome && WE[wHome] ? wHome : 'world'];
  const monthly = es.every((c) => WE[c].m);
  let g = q.get('g');
  const wantMonth = g === 'month';
  if (g !== 'month' && g !== 'year') g = monthly ? 'month' : 'year';
  if (g === 'month' && !monthly) g = 'year';
  const p = ['1y', '3y', '10y', 'all'].includes(q.get('p')) ? q.get('p') : g === 'month' ? '3y' : 'all';
  const n = { '1y': 1, '3y': 3, '10y': 10 }[p];
  let from, to;
  if (g === 'month') {
    to = es.map((c) => WE[c].m[1]).sort()[0];
    const start = es.map((c) => WE[c].m[0]).sort().pop();
    from = n ? [start, addMonths(to, -12 * n + 1)].sort().pop() : start;
  } else {
    to = Math.min(...es.map((c) => WE[c].y[1]));
    const start = Math.max(...es.map((c) => WE[c].y[0]));
    from = n ? Math.max(start, to - n + 1) : start;
  }
  return {
    es, g, p, from, to, monthly,
    u: q.get('u') === 'pct' ? 'pct' : 'abs',
    z: q.get('z') ? new Set(q.get('z').split(',')) : null,
    s: q.get('s') || 'ren',
    monthMissing: wantMonth && !monthly,
  };
}
function wProdParams(st, patch = {}) {
  const s = { ...st, ...patch };
  return {
    e: s.es.join(','), g: s.g, p: s.p, u: s.u === 'pct' ? 'pct' : null,
    z: s.z ? [...s.z].join(',') : null, s: s.s && s.s !== 'ren' ? s.s : null,
  };
}
function wAxis(st) {
  if (st.g === 'month') return D.months(st.from, st.to);
  const out = [];
  for (let y = st.from; y <= st.to; y++) out.push(String(y));
  return out;
}

/** One entity's values aligned to x: {field: number[]}. */
async function wTable(code, g, x) {
  const t = {};
  if (g === 'year') {
    const Y = await getJSON('world/yearly.json');
    const d = Y?.data[code] || {};
    const idx = x.map((y) => Y.years.indexOf(+y));
    for (const [k, arr] of Object.entries(d)) t[k] = idx.map((i) => (i < 0 ? null : arr[i]));
  } else {
    const M = await getJSON(`world/monthly/${code}.json`);
    if (M) {
      const pos = new Map(D.months(M.months[0], M.months[1]).map((m, i) => [m, i]));
      for (const [k, arr] of Object.entries(M.data)) t[k] = x.map((m) => (pos.has(m) ? arr[pos.get(m)] : null));
    }
  }
  return t;
}
const genAt = (t, i) => FUELS().reduce((a, k) => a + (t[k]?.[i] || 0), 0);

/** Sum of several entities; carbon intensity weighted by generation. */
function wSum(tables, n) {
  const out = {};
  const cw = new Array(n).fill(0), gw = new Array(n).fill(0);
  let anyCi = false;
  for (const t of tables) {
    for (const [k, arr] of Object.entries(t)) {
      if (k === 'ci' || k === 'kwh_pc') continue;
      const o = (out[k] ||= new Array(n).fill(null));
      arr.forEach((v, i) => { if (v != null) o[i] = (o[i] || 0) + v; });
    }
    (t.ci || []).forEach((c, i) => {
      const g = genAt(t, i);
      if (c != null && g > 0) { cw[i] += c * g; gw[i] += g; anyCi = true; }
    });
  }
  if (anyCi) out.ci = cw.map((v, i) => (gw[i] > 0 ? v / gw[i] : null));
  if (tables.length === 1 && tables[0].kwh_pc) out.kwh_pc = tables[0].kwh_pc;
  return out;
}

function wTotals(t) {
  const gen = {};
  let all = 0, ren = 0, clean = 0, any = false;
  for (const s of W.sources) {
    const arr = t[s.key];
    if (!arr) continue;
    any ||= arr.some((v) => v != null);
    gen[s.key] = sum(arr); all += gen[s.key];
    if (s.renewable) ren += gen[s.key];
    if (s.clean) clean += gen[s.key];
  }
  let cw = 0, gw = 0;
  (t.ci || []).forEach((c, i) => { const g = genAt(t, i); if (c != null && g > 0) { cw += c * g; gw += g; } });
  const has = (a) => a && a.some((v) => v != null);
  return {
    gen, all: any ? all : null, ren: all > 0 ? ren / all : null, clean: all > 0 ? clean / all : null,
    demand: has(t.demand) ? sum(t.demand) : null,
    net: has(t.net_imports) ? -sum(t.net_imports) : null, // + = net export
    ci: gw ? cw / gw : null,
  };
}

async function renderWorldProd(q) {
  const seq = ++renderSeq;
  await worldMeta();
  const st = wProdState(q);
  if (st.es.length === 1) wHome = st.es[0];
  wProdControls(st);
  const x = wAxis(st);
  const view = $('#view-svet-vyroba');
  view.classList.add('loading');
  const tables = await Promise.all(st.es.map((c) => wTable(c, st.g, x)));
  if (seq !== renderSeq) return;
  view.classList.remove('loading');

  const t = wSum(tables, x.length);
  const present = FUELS().filter((k) => (t[k] || []).some((v) => v));
  let notice = st.monthMissing ? `Měsíční data nejsou pro ${st.es.filter((c) => !WE[c].m).map(wName).join(', ')} k dispozici – zobrazuji po letech.` : '';
  if (!present.length) notice = (notice ? notice + ' ' : '') + 'Pro zvolené období nejsou k dispozici data.';
  showNotice('#w-notice', notice);

  const names = st.es.map(wName);
  $('#w-title').textContent = 'Výroba – ' + (names.length > 3 ? `${names.length} zemí` : names.join(' + '));
  $('#w-sub').textContent = st.u === 'pct' ? '% výroby' : st.g === 'month' ? 'TWh za měsíc' : 'TWh za rok';
  const range = st.g === 'month'
    ? (st.from === st.to ? fmtYm(st.from) : `${fmtYm(st.from)} – ${fmtYm(st.to)}`)
    : (st.from === st.to ? String(st.from) : `${st.from} – ${st.to}`);
  $('#w-range-label').textContent = range;
  $('#w-hint').textContent = (st.u === 'pct'
    ? 'Podíl zdrojů na výrobě v každém období.'
    : 'Barvy = výroba podle zdroje, černá značka = spotřeba. Výroba nad spotřebou se vyváží, pod ní se dováží.')
    + ' Klepnutím na zdroj v legendě ho skryjete. Zdroj: Ember (u některých zemí jsou poslední měsíce odhad).';

  const on = (k) => !st.z || st.z.has(k);
  wLegend(st, present);
  wMainChart(st, x, t, present.filter(on));
  const tot = wTotals(t);
  wKpis(tot, x.length === 1 ? t.kwh_pc?.[0] : null); // per person: only for one entity and one year
  wDonut(tot, present.filter(on));
  const eu = st.es.length === 1 && WE[st.es[0]].eu;
  $('#w-eu-link').hidden = !eu;
  if (eu) $('#w-eu-link').href = hashFor('vyroba', { c: eu });
  wComparison(st, tables, present);
}

let wMulti = false;
function wProdControls(st) {
  if (st.es.length > 1) wMulti = true;
  const drop = $('#w-entities');
  const multi = $('#w-multi');
  multi.checked = wMulti;
  multi.onchange = () => {
    wMulti = multi.checked;
    if (!wMulti && st.es.length > 1) go('svet/vyroba', wProdParams(st, { es: [st.es[0]] }));
  };
  $('#w-entities-label').textContent = st.es.length > 3 ? `${st.es.length} zemí` : st.es.map(wName).join(', ');
  const pick = (code) => {
    let es;
    if (!wMulti) { drop.open = false; es = [code]; } else {
      const set = new Set(st.es);
      if (set.has(code)) { if (set.size > 1) set.delete(code); } else set.add(code);
      es = [...set];
    }
    // monthly <-> yearly-only selection: fall back to that selection's defaults
    const keep = es.every((c) => WE[c].m) === st.monthly;
    go('svet/vyroba', wProdParams(st, keep ? { es } : { es, g: null, p: null }));
  };
  const groups = [['Svět a regiony', W.entities.filter((e) => e.agg)],
    ...W.regions.map((r) => [r.name, W.entities.filter((e) => !e.agg && e.region === r.key)]),
    ['Ostatní', W.entities.filter((e) => !e.agg && !W.regions.some((r) => r.key === e.region))]];
  const list = $('#w-entities-list');
  list.replaceChildren(...groups.filter(([, es]) => es.length).map(([title, es]) => {
    const g = document.createElement('div');
    g.className = 'group';
    const h = document.createElement('h4');
    h.textContent = title;
    const chips = document.createElement('div');
    chips.className = 'chips';
    const sorted = title === 'Svět a regiony' ? es : [...es].sort((a, b) => a.name.localeCompare(b.name, 'cs'));
    chips.append(...sorted.map((e) => {
      const b = document.createElement('button');
      b.className = 'chip' + (st.es.includes(e.code) ? ' on' : '');
      b.textContent = e.name;
      b.dataset.q = norm(e.name + ' ' + e.code);
      if (!e.m) b.title = 'jen roční data';
      b.onclick = () => pick(e.code);
      return b;
    }));
    g.append(h, chips);
    return g;
  }));
  const search = $('#w-search');
  const filter = () => {
    const s = norm(search.value.trim());
    list.querySelectorAll('.group').forEach((g) => {
      let any = false;
      g.querySelectorAll('.chip').forEach((b) => { const hit = !s || b.dataset.q.includes(s); b.hidden = !hit; any ||= hit; });
      g.hidden = !any;
    });
  };
  search.oninput = filter;
  filter();
  drop.ontoggle = () => { if (drop.open && HOVER) search.focus(); };

  document.querySelectorAll('#w-period button').forEach((b) => {
    const v = b.dataset.v;
    b.classList.toggle('active', v === st.p);
    if (v === '1y') b.textContent = st.g === 'month' ? '12 měsíců' : '1 rok';
    b.onclick = () => go('svet/vyroba', wProdParams(st, { p: v }));
  });
  document.querySelectorAll('#w-step button').forEach((b) => {
    const v = b.dataset.v;
    b.classList.toggle('active', v === st.g);
    b.disabled = v === 'month' && !st.monthly;
    b.title = b.disabled ? 'Měsíční data pro tuto zemi nejsou' : '';
    b.onclick = () => go('svet/vyroba', wProdParams(st, { g: v, p: v === 'year' && st.p === '1y' ? '10y' : st.p }));
  });
  document.querySelectorAll('#w-unit button').forEach((b) => {
    b.classList.toggle('active', b.dataset.v === st.u);
    b.onclick = () => go('svet/vyroba', wProdParams(st, { u: b.dataset.v }), true);
  });
}

function wLegend(st, present) {
  const box = $('#w-legend');
  const keys = [...present, ...(st.u === 'abs' ? ['demand'] : [])];
  box.replaceChildren(...keys.map((k) => {
    const b = document.createElement('button');
    const on = !st.z || st.z.has(k);
    b.className = (on ? '' : 'off') + (k === 'demand' ? ' load' : '');
    b.title = on ? 'Skrýt' : 'Zobrazit';
    const i = document.createElement('i');
    i.style.background = k === 'demand' ? cssVar('--text') : WSRC[k].color;
    b.append(i, k === 'demand' ? 'Spotřeba' : WSRC[k].name);
    b.onclick = () => {
      const set = new Set(st.z || keys);
      set.has(k) ? set.delete(k) : set.add(k);
      go('svet/vyroba', wProdParams(st, { z: keys.every((x) => set.has(x)) ? null : set }), true);
    };
    return b;
  }));
}

function wMainChart(st, x, t, keys) {
  const c = chart('chart-w-main');
  const pctMode = st.u === 'pct';
  const isBar = x.length <= 60;
  const card = cssVar('--card');
  const total = x.map((_, i) => genAt(t, i));
  const val = (k, i) => {
    const v = t[k]?.[i];
    if (v == null) return null;
    return pctMode ? (total[i] > 0 ? (v / total[i]) * 100 : null) : v;
  };
  const label = (v) => (st.g === 'month' ? D.monthLabel(v) : v);
  const byName = {};
  const series = keys.map((k) => {
    byName[WSRC[k].name] = k;
    const data = x.map((_, i) => val(k, i));
    return isBar
      ? { name: WSRC[k].name, type: 'bar', stack: 'all', data, color: WSRC[k].color, barMaxWidth: 46, itemStyle: { borderColor: card, borderWidth: 0.5 } }
      : { name: WSRC[k].name, type: 'line', stack: 'all', data, color: WSRC[k].color, symbol: 'none', lineStyle: { width: 0 }, areaStyle: { opacity: 0.92 }, emphasis: { focus: 'series' } };
  });
  const showDemand = !pctMode && t.demand && (!st.z || st.z.has('demand'));
  if (showDemand) {
    const plotW = Math.max(100, document.getElementById('chart-w-main').clientWidth - 70);
    const barW = Math.min(46, (plotW / Math.max(1, x.length)) * 0.8);
    byName['Spotřeba'] = 'demand';
    series.push(isBar
      ? { name: 'Spotřeba', type: 'line', data: t.demand, z: 10, color: cssVar('--text'), lineStyle: { width: 0 }, symbol: 'rect', symbolSize: [barW + 6, 3], showSymbol: true }
      : { name: 'Spotřeba', type: 'line', data: t.demand, z: 10, color: cssVar('--text'), symbol: 'none', lineStyle: { width: 2 } });
  }
  const maxV = pctMode ? 100 : Math.max(0, ...total, ...(t.demand || []).map((v) => v || 0));
  const dec = maxV < 1 ? 2 : maxV < 10 ? 1 : 0;
  const fmt = (v) => (pctMode ? nf1.format(v) + ' %' : fmtTWh(v));
  c.setOption({
    backgroundColor: 'transparent',
    textStyle: baseText(),
    animationDuration: 300,
    grid: { left: 8, right: 10, top: 10, bottom: 8, containLabel: true },
    legend: { show: false },
    tooltip: {
      trigger: 'axis', confine: true, axisPointer: { type: isBar ? 'shadow' : 'line' }, ...tipCss(),
      formatter: (ps) => {
        if (!ps.length) return '';
        const i = ps[0].dataIndex;
        const head = st.g === 'month' ? fmtYm(x[i]) : x[i];
        let demand = null;
        const items = [];
        for (const p of ps) {
          if (p.value == null) continue;
          if (byName[p.seriesName] === 'demand') { demand = p.value; continue; }
          if (p.value !== 0) items.push(p);
        }
        items.sort((a, b) => b.value - a.value);
        const line = `border-top:1px solid ${cssVar('--line')};margin-top:4px;padding-top:4px`;
        return `<div style="font-weight:600;margin-bottom:4px">${esc(head)}</div>`
          + items.map((p) => tipRow(p.marker + esc(p.seriesName), fmt(p.value))).join('')
          + tipRow('Výroba celkem', fmtTWh(total[i]), line)
          + (demand != null ? tipRow('Spotřeba', fmtTWh(demand)) : '')
          + (t.ci?.[i] != null ? tipRow('Emise', nf0.format(t.ci[i]) + ' g CO₂/kWh') : '');
      },
    },
    xAxis: { type: 'category', data: x, ...axisCommon(), axisLabel: { ...axisCommon().axisLabel, formatter: label }, boundaryGap: isBar, splitLine: { show: false } },
    yAxis: { type: 'value', max: pctMode ? 100 : null, ...axisCommon(), axisLabel: { ...axisCommon().axisLabel, formatter: (v) => NF(dec).format(v) + (pctMode ? ' %' : '') } },
    series,
  }, true);
}

function wKpis(t, pc) {
  const netSub = t.net == null ? 'bez dat' : t.net >= 0 ? 'čistý vývoz' : 'čistý dovoz';
  const items = [
    ['Výroba', fmtTWh(t.all), 'všechny zdroje'],
    ['Spotřeba', fmtTWh(t.demand), pc != null ? `${nf0.format(pc)} kWh na obyvatele` : 'poptávka po elektřině'],
    ['Saldo', t.net == null ? '–' : fmtTWh(t.net, true), netSub],
    ['Podíl OZE', pct(t.ren), 'na výrobě'],
    ['Bezemisní', pct(t.clean), 'OZE + jádro'],
    ['Emise', t.ci == null ? '–' : nf0.format(t.ci) + ' g', 'CO₂ na kWh výroby'],
  ];
  $('#w-kpis').replaceChildren(...items.map(([k, v, s]) => {
    const d = document.createElement('div');
    d.className = 'kpi';
    d.innerHTML = `<div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div>`;
    return d;
  }));
}

function wDonut(t, keys) {
  const c = chart('chart-w-donut');
  const raw = keys.filter((k) => t.gen[k] > 0);
  const total = raw.reduce((a, k) => a + t.gen[k], 0);
  const data = raw.map((k) => {
    const big = t.gen[k] / total >= 0.04;
    return { name: WSRC[k].name, value: t.gen[k], itemStyle: { color: WSRC[k].color }, label: { show: big }, labelLine: { show: big } };
  });
  c.setOption({
    backgroundColor: 'transparent',
    textStyle: baseText(),
    tooltip: { trigger: 'item', confine: true, ...tipCss(), formatter: (p) => `${p.marker}${esc(p.name)}<br><b>${fmtTWh(p.value)}</b> (${nf1.format(p.percent)} %)` },
    series: [{
      type: 'pie', radius: ['42%', '68%'], center: ['50%', '52%'], data,
      itemStyle: { borderColor: cssVar('--card'), borderWidth: 2 },
      label: { color: cssVar('--text'), fontSize: 11, overflow: 'none', edgeDistance: 4, formatter: (p) => `${p.name}\n${nf0.format(p.percent)} %` },
      labelLine: { length: 8, length2: 6 },
      emphasis: { scale: true, scaleSize: 4 },
    }],
  }, true);
}

function wComparison(st, tables, present) {
  const card = $('#w-cmp-card');
  card.hidden = st.es.length < 2;
  if (card.hidden) return;
  const sel = $('#w-cmp-sort');
  const opts = [['ren', 'podílu OZE'], ['clean', 'bezemisních zdrojů'], ...present.map((k) => [k, WSRC[k].name.toLowerCase()])];
  sel.replaceChildren(...opts.map(([v, n]) => { const o = document.createElement('option'); o.value = v; o.textContent = n; return o; }));
  sel.value = opts.some(([v]) => v === st.s) ? st.s : 'ren';
  sel.onchange = () => go('svet/vyroba', wProdParams(st, { s: sel.value }), true);
  const rows = st.es.map((code, i) => {
    const t = wTotals(tables[i]);
    const share = (k) => (t.all ? (t.gen[k] || 0) / t.all : 0);
    const v = sel.value === 'ren' ? t.ren : sel.value === 'clean' ? t.clean : share(sel.value);
    return { code, share, sortVal: v || 0 };
  }).sort((a, b) => a.sortVal - b.sortVal);
  const on = (k) => !st.z || st.z.has(k);
  const el = document.getElementById('chart-w-cmp');
  el.style.height = `${70 + 38 * rows.length}px`;
  const c = chart('chart-w-cmp');
  c.resize();
  c.setOption({
    backgroundColor: 'transparent',
    textStyle: baseText(),
    grid: { left: 8, right: 14, top: 6, bottom: 6, containLabel: true },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'shadow' }, confine: true, ...tipCss(),
      formatter: (ps) => `<b>${esc(ps[0].name)}</b><br>` + ps.filter((p) => p.value > 0.0005).sort((a, b) => b.value - a.value)
        .map((p) => `${p.marker}${esc(p.seriesName)}: <b>${nf1.format(p.value * 100)} %</b>`).join('<br>'),
    },
    xAxis: { type: 'value', max: 1, ...axisCommon(), axisLabel: { ...axisCommon().axisLabel, formatter: (v) => nf0.format(v * 100) + ' %' } },
    yAxis: { type: 'category', data: rows.map((r) => wName(r.code)), ...axisCommon(), axisLabel: { ...axisCommon().axisLabel, fontSize: 12, color: cssVar('--text') } },
    series: present.filter(on).map((k) => ({
      name: WSRC[k].name, type: 'bar', stack: 'share', color: WSRC[k].color, barWidth: '62%',
      itemStyle: { borderColor: cssVar('--card'), borderWidth: 0.5 },
      data: rows.map((r) => r.share(k)),
    })),
  }, true);
}

/* ========================================= metrics for Mapa and Žebříček */
const share = (keys) => (v) => { const g = genOf(v); return g > 0 ? keys.reduce((a, k) => a + (v[k] || 0), 0) / g : null; };
const REN = () => FUELS().filter((k) => WSRC[k].renewable);
const CLEAN = () => FUELS().filter((k) => WSRC[k].clean);
// ramps: [light-mode low, light-mode high, dark-mode low, dark-mode high]
const RAMPS = {
  green: ['#e3f2e1', '#16692a', '#1e3123', '#6fdc8a'],
  teal: ['#ddf1f3', '#0b5f69', '#18302f', '#5fd3dc'],
  blue: ['#e2ebf7', '#1a4889', '#1b2737', '#8fb8f2'],
  brown: ['#f3ebe3', '#5a3a22', '#2b241e', '#d9a679'],
  red: ['#fbe8e4', '#8a1c10', '#33201d', '#ff8f7a'],
  indigo: ['#ebeaf7', '#38307f', '#23223a', '#aaa3f5'],
  slate: ['#e7ecf1', '#22384f', '#1f262e', '#a9c0d8'],
};
const WMETRICS = {
  ren: { name: 'Podíl OZE', title: 'Podíl obnovitelných zdrojů na výrobě', kind: 'share', ramp: 'green', val: (v) => share(REN())(v),
    groups: () => [['Slunce', ['solar']], ['Vítr', ['wind']], ['Voda', ['hydro']], ['Biomasa a ostatní OZE', ['bioenergy', 'other_renewables']]] },
  ws: { name: 'Vítr a slunce', title: 'Podíl větru a slunce na výrobě', kind: 'share', ramp: 'teal', val: (v) => share(['wind', 'solar'])(v),
    groups: () => [['Slunce', ['solar']], ['Vítr', ['wind']]] },
  clean: { name: 'Bezemisní zdroje', title: 'Podíl bezemisních zdrojů (OZE + jádro)', kind: 'share', ramp: 'blue', val: (v) => share(CLEAN())(v),
    groups: () => [['Jádro', ['nuclear']], ['Voda', ['hydro']], ['Vítr', ['wind']], ['Slunce', ['solar']], ['Biomasa a ostatní OZE', ['bioenergy', 'other_renewables']]] },
  coal: { name: 'Podíl uhlí', title: 'Podíl uhlí na výrobě', kind: 'share', ramp: 'brown', val: (v) => share(['coal'])(v),
    groups: () => [['Uhlí', ['coal']]] },
  ci: { name: 'Emise CO₂ na kWh', title: 'Emisní intenzita výroby (g CO₂/kWh)', kind: 'abs', ramp: 'red', domain: [0, 900],
    val: (v) => (v.ci != null && genOf(v) > 0 ? v.ci : null), fmt: (x) => nf0.format(x) + ' g' },
  trade: { name: 'Dovoz / vývoz', title: 'Saldo obchodu s elektřinou', kind: 'trade', domain: [-0.5, 0.5],
    val: (v, u) => (v.net_imports == null ? null : u === 'abs' ? -v.net_imports : v.demand > 0 ? -v.net_imports / v.demand : null) },
  pc: { name: 'Spotřeba na obyvatele', title: 'Spotřeba elektřiny na obyvatele', kind: 'abs', ramp: 'indigo', log: [100, 20000],
    val: (v) => v.kwh_pc ?? null, fmt: (x) => nf0.format(x) + ' kWh' },
  gen: { name: 'Výroba celkem', title: 'Výroba elektřiny celkem', kind: 'abs', ramp: 'slate', log: [0.1, 10000],
    val: (v) => { const g = genOf(v); return g > 0 ? g : null; }, fmt: (x) => fmtTWh(x) },
};
const metricKey = (q) => (WMETRICS[q.get('m')] ? q.get('m') : 'ren');

/** Values of one entity for a period: 'latest' (its newest year), 'ltm' or a year. */
function wPeriodRow(Y, code, y) {
  const d = Y.data[code];
  if (!d) return null;
  if (y === 'ltm') {
    const l = Y.ltm[code];
    return l ? { v: l.v, label: `${fmtYm(l.from)} – ${fmtYm(l.to)}`, old: l.to < addMonths(W.updated, -1), end: l.to } : null;
  }
  const hasGen = (i) => FUELS().some((k) => d[k]?.[i] != null);
  let i;
  if (y === 'latest') { for (i = Y.years.length - 1; i >= 0 && !hasGen(i); i--); } else i = Y.years.indexOf(+y);
  if (i < 0 || !hasGen(i)) return null;
  const v = {};
  for (const [k, arr] of Object.entries(d)) v[k] = arr[i];
  const year = Y.years[i];
  return { v, year, label: String(year), old: y === 'latest' && year < W.latest_year };
}
function periodState(q) {
  const y = q.get('y') || 'latest';
  return y === 'latest' || y === 'ltm' || (+y >= W.years[0] && +y <= W.years[1]) ? y : 'latest';
}
function periodLabel(y) {
  if (y === 'latest') return `nejnovější rok (${W.latest_year}, u části zemí dříve)`;
  if (y === 'ltm') return `posledních 12 měsíců (do ${fmtYm(W.updated)})`;
  return `rok ${y}`;
}
function fillPicks(metricSel, yearSel, st, onChange) {
  metricSel.replaceChildren(...Object.entries(WMETRICS).map(([k, m]) => new Option(m.name, k)));
  metricSel.value = st.m;
  const years = [];
  for (let y = W.years[1]; y >= W.years[0]; y--) years.push(String(y));
  yearSel.replaceChildren(new Option('Nejnovější rok', 'latest'), new Option('12 měsíců', 'ltm'),
    ...years.map((y) => new Option(y, y)));
  yearSel.value = st.y;
  metricSel.onchange = () => onChange({ m: metricSel.value });
  yearSel.onchange = () => onChange({ y: yearSel.value });
}
function syncWorldTabs() {
  const p = { m: wShared.m !== 'ren' ? wShared.m : null, y: wShared.y !== 'latest' ? wShared.y : null };
  document.querySelector('.tabs a[data-view="svet/mapa"]').href = hashFor('svet/mapa', p);
  document.querySelector('.tabs a[data-view="svet/zebricek"]').href = hashFor('svet/zebricek', { ...p, r: wShared.r !== 'top' ? wShared.r : null });
}

/* colour scales */
function mix(a, b, t) {
  const A = hexRgb(a), B = hexRgb(b);
  return `rgb(${A.map((x, i) => Math.round(x + (B[i] - x) * t)).join(',')})`;
}
function scaleT(m, x) {
  if (m.kind === 'share') return Math.max(0, Math.min(1, x));
  if (m.log) { const [a, b] = m.log.map(Math.log10); return Math.max(0, Math.min(1, (Math.log10(Math.max(x, 1e-9)) - a) / (b - a))); }
  const [a, b] = m.domain;
  return Math.max(0, Math.min(1, (x - a) / (b - a)));
}
function colorFor(m, x) {
  if (m.kind === 'trade') {
    const t = Math.pow(Math.min(1, Math.abs(x) / m.domain[1]), 0.8);
    return mix(cssVar('--neu'), x >= 0 ? cssVar('--exp') : cssVar('--imp'), t);
  }
  const r = RAMPS[m.ramp];
  const [lo, hi] = DARK ? [r[2], r[3]] : [r[0], r[1]];
  return mix(lo, hi, scaleT(m, x));
}
function fmtMetric(m, x, u) {
  if (x == null) return '–';
  if (m.kind === 'share') return u === 'abs' ? fmtTWh(x) : nf1.format(x * 100) + ' %';
  if (m.kind === 'trade') {
    if (u === 'abs') return Math.abs(x) < 0.0005 ? '0 TWh' : fmtTWh(x, true);
    return Math.abs(x) < 0.0005 ? '0 %' : (x > 0 ? '+' : '') + nf1.format(x * 100) + ' %';
  }
  return m.fmt(x);
}
function scaleLegend(m) {
  let stops, ticks;
  if (m.kind === 'trade') {
    stops = [colorFor(m, m.domain[0]), cssVar('--neu'), colorFor(m, m.domain[1])];
    ticks = ['dovoz ≥ 50 % spotřeby', 'vyrovnané', 'vývoz ≥ 50 %'];
  } else {
    stops = [0, 0.25, 0.5, 0.75, 1].map((t) => {
      const r = RAMPS[m.ramp];
      const [lo, hi] = DARK ? [r[2], r[3]] : [r[0], r[1]];
      return mix(lo, hi, t);
    });
    if (m.kind === 'share') ticks = ['0 %', '50 %', '100 %'];
    else if (m.log) ticks = [m.fmt(m.log[0]), m.fmt(Math.sqrt(m.log[0] * m.log[1])), m.fmt(m.log[1]) + ' a víc'];
    else ticks = [m.fmt(m.domain[0]), m.fmt((m.domain[0] + m.domain[1]) / 2), m.fmt(m.domain[1]) + ' a víc'];
  }
  return `<div class="bar" style="background:linear-gradient(to right,${stops.join(',')})"></div>
    <div class="ticks">${ticks.map((t) => `<span>${esc(t)}</span>`).join('')}</div>
    <div class="nodata"><i></i>bez dat</div>`;
}

/* ===================================================== VIEW: Svět – Mapa */
// Equal Earth projection (Šavrič, Patterson, Jenny 2018): equal-area, pleasant world shape
const EQUAL_EARTH = (() => {
  const A1 = 1.340264, A2 = -0.081106, A3 = 0.000893, A4 = 0.003796, M = Math.sqrt(3) / 2, R = Math.PI / 180;
  const poly = (t) => { const t2 = t * t, t6 = t2 * t2 * t2; return [t * (A1 + A2 * t2 + t6 * (A3 + A4 * t2)), A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2)]; };
  return {
    project([lon, lat]) {
      const t = Math.asin(M * Math.sin(lat * R));
      const [y, dy] = poly(t);
      return [(lon * R * Math.cos(t)) / (M * dy), -y];
    },
    unproject([x, yy]) {
      const y = -yy;
      let t = y;
      for (let i = 0; i < 20; i++) { const [f, df] = poly(t); const d = (f - y) / df; t -= d; if (Math.abs(d) < 1e-10) break; }
      const [, dy] = poly(t);
      return [(M * x * dy) / Math.cos(t) / R, Math.asin(Math.max(-1, Math.min(1, Math.sin(t) / M))) / R];
    },
  };
})();
let worldMapReady = null;
let worldGeo = null; // [{code, polys}] for the tap fallback
function ensureWorldMap() {
  if (!worldMapReady) {
    worldMapReady = fetch('world.geojson').then((r) => r.json()).then((gj) => {
      echarts.registerMap('world', gj);
      worldGeo = gj.features.map((f) => ({ code: f.properties.id, polys: f.geometry.coordinates }));
    });
  }
  return worldMapReady;
}

let wMapCtx = null;
async function renderWorldMap(q) {
  const seq = ++renderSeq;
  await worldMeta();
  const st = { m: metricKey(q), y: periodState(q) };
  Object.assign(wShared, st);
  syncWorldTabs();
  const params = (patch) => {
    const s = { ...st, ...patch };
    return { m: s.m !== 'ren' ? s.m : null, y: s.y !== 'latest' ? s.y : null };
  };
  fillPicks($('#wm-metric'), $('#wm-year'), st, (patch) => go('svet/mapa', params(patch)));
  const [Y] = await Promise.all([getJSON('world/yearly.json'), ensureWorldMap()]);
  if (seq !== renderSeq) return;
  const m = WMETRICS[st.m];
  const u = m.kind === 'trade' ? 'pct' : null;
  const values = {};
  for (const e of W.entities) {
    if (e.agg) continue;
    const row = wPeriodRow(Y, e.code, st.y);
    const x = row && m.val(row.v, u);
    if (x != null && Number.isFinite(x)) values[e.code] = { x, row };
  }
  showNotice('#wm-notice', Object.keys(values).length ? '' : 'Pro zvolené období nejsou k dispozici data.');
  $('#wm-caption').textContent = `${m.name} · ${st.y === 'latest' ? 'nejnovější rok' : st.y === 'ltm' ? `12 měs. do ${fmtYm(W.updated)}` : st.y}`;
  $('#wm-legend').innerHTML = scaleLegend(m);
  const nOld = Object.values(values).filter((v) => v.row.old).length;
  $('#wm-hint').textContent = `${m.title}, ${periodLabel(st.y)}. ${Object.keys(values).length} zemí`
    + (nOld ? `, u ${nOld} z nich jsou nejnovější data starší.` : '.')
    + (st.y === 'ltm' ? ' Měsíční data má jen část zemí.' : '')
    + ' Klepněte na zemi pro detail, mapu lze přiblížit dvěma prsty.';
  wMapCtx = { st, m, values, Y, u };

  const c = chart('wmap');
  const regions = Object.entries(values).map(([code, { x }]) => {
    const col = colorFor(m, x);
    return { name: code, itemStyle: { areaColor: col }, emphasis: { itemStyle: { areaColor: col, borderColor: cssVar('--text'), borderWidth: 1.2 } } };
  });
  const prev = c.getOption && c.getOption();
  const keep = prev && prev.geo && prev.geo[0];
  const el = document.getElementById('wmap');
  // the world (Equal Earth, ~2:1) fills the width; layoutSize is the map's longer side
  const size = Math.min(el.clientWidth * 0.98, el.clientHeight * 2.0);
  c.setOption({
    backgroundColor: 'transparent',
    textStyle: baseText(),
    tooltip: HOVER ? {
      trigger: 'item', confine: true, ...tipCss(),
      formatter: (p) => {
        const v = values[p.name];
        return `<b>${esc(wName(p.name))}</b><br>` + (v ? `${esc(fmtMetric(m, v.x, u))} <span style="opacity:.7">(${esc(v.row.label)})</span>` : '<span style="opacity:.7">bez dat</span>');
      },
    } : { show: false },
    geo: {
      map: 'world', nameProperty: 'id', projection: EQUAL_EARTH, roam: true, triggerEvent: true,
      layoutCenter: ['50%', '50%'], layoutSize: size,
      center: keep ? keep.center : undefined, zoom: keep ? keep.zoom : 1,
      scaleLimit: { min: 1, max: 20 },
      itemStyle: { areaColor: cssVar('--land'), borderColor: cssVar('--border-map'), borderWidth: 0.5 },
      emphasis: { label: { show: false }, itemStyle: { areaColor: cssVar('--land-hover') } },
      select: { disabled: true }, selectedMode: false,
      tooltip: { show: HOVER },
      regions,
    },
    series: [],
  }, { replaceMerge: ['series', 'geo'] });
  if (!c.__wired) {
    c.__wired = true;
    let last = 0;
    c.on('click', (p) => { if (p.componentType === 'geo') { last = Date.now(); wCountrySheet(p.name); } });
    c.getZr().on('click', (e) => setTimeout(() => {
      if (Date.now() - last < 300) return;
      const pt = [e.offsetX, e.offsetY];
      if (!c.containPixel('geo', pt)) return;
      const [lon, lat] = c.convertFromPixel('geo', pt);
      const hit = worldGeo.find((g) => g.polys.some((poly) => inRing(lon, lat, poly[0])));
      if (hit) wCountrySheet(hit.code);
    }, 0));
  }
}

function wCountrySheet(code) {
  if (!wMapCtx || !WE[code]) return;
  const { st, Y } = wMapCtx;
  const e = WE[code];
  const row = wPeriodRow(Y, code, st.y);
  const links = `<a class="btn" href="${hashFor('svet/vyroba', { e: code })}">Výroba v čase →</a>`
    + (e.eu ? ` <a class="btn ghost" href="${hashFor('vyroba', { c: e.eu })}">Hodinová data (Evropa) →</a>` : '');
  if (!row) {
    openSheet(`<h3>${esc(e.name)}</h3><p class="muted">Pro zvolené období nejsou data.</p>${links}`);
    return;
  }
  const v = row.v;
  const gen = genOf(v);
  const mixRows = FUELS().map((k) => ({ k, x: v[k] || 0 })).filter((r) => r.x > 0).sort((a, b) => b.x - a.x);
  const net = v.net_imports == null ? null : -v.net_imports;
  const cls = (x) => (x > 0 ? 'pos' : x < 0 ? 'neg' : '');
  openSheet(`
    <h3>${esc(e.name)}</h3><div class="muted">${esc(row.label)}${row.old ? ' · novější data zatím nejsou' : ''}</div>
    <div class="kpis" style="margin-top:10px">
      <div class="kpi"><div class="k">Výroba</div><div class="v">${fmtTWh(gen)}</div></div>
      <div class="kpi"><div class="k">Spotřeba</div><div class="v">${fmtTWh(v.demand)}</div><div class="s">${v.kwh_pc != null ? nf0.format(v.kwh_pc) + ' kWh/obyv.' : ''}</div></div>
      <div class="kpi"><div class="k">Podíl OZE</div><div class="v">${pct(share(REN())(v))}</div><div class="s">bezemisní ${pct(share(CLEAN())(v))}</div></div>
      <div class="kpi"><div class="k">Emise</div><div class="v">${v.ci != null ? nf0.format(v.ci) + ' g' : '–'}</div><div class="s">CO₂ na kWh</div></div>
    </div>
    <div class="mixbar">${mixRows.map((r) => `<i style="width:${(r.x / gen) * 100}%;background:${WSRC[r.k].color}" title="${esc(WSRC[r.k].name)}"></i>`).join('')}</div>
    <table><tbody>${mixRows.map((r) => `<tr><td>${swatch(WSRC[r.k].color)}${esc(WSRC[r.k].name)}</td><td>${fmtTWh(r.x)}</td><td>${nf1.format((r.x / gen) * 100)} %</td></tr>`).join('')}
      ${net != null ? `<tr><th>Saldo (vývoz − dovoz)</th><th class="${cls(net)}">${fmtTWh(net, true)}</th><th></th></tr>` : ''}</tbody></table>
    ${links}`);
}

/* ================================================= VIEW: Svět – Žebříček */
const TOP_N = 30;
async function renderWorldRank(q) {
  const seq = ++renderSeq;
  await worldMeta();
  const regionKeys = W.regions.map((r) => r.key);
  const r = ['top', 'agg', 'all', ...regionKeys].includes(q.get('r')) ? q.get('r') : 'top';
  const st = { m: metricKey(q), y: periodState(q), r };
  const m = WMETRICS[st.m];
  const units = m.kind === 'share' || m.kind === 'trade';
  st.u = units && q.get('u') === 'abs' ? 'abs' : 'pct';
  Object.assign(wShared, { m: st.m, y: st.y, r: st.r });
  syncWorldTabs();
  const params = (patch) => {
    const s = { ...st, ...patch };
    return { m: s.m !== 'ren' ? s.m : null, y: s.y !== 'latest' ? s.y : null, r: s.r !== 'top' ? s.r : null, u: s.u === 'abs' ? 'abs' : null };
  };
  fillPicks($('#wr-metric'), $('#wr-year'), st, (patch) => go('svet/zebricek', params(patch)));
  const regionBtns = [['top', `${TOP_N} největších`], ['agg', 'Regiony'], ...W.regions.map((x) => [x.key, x.name]), ['all', 'Všechny']];
  $('#wr-region').replaceChildren(...regionBtns.map(([k, n]) => {
    const b = document.createElement('button');
    b.textContent = n;
    b.classList.toggle('active', k === st.r);
    b.onclick = () => go('svet/zebricek', params({ r: k }));
    return b;
  }));
  $('#wr-unit').hidden = !units;
  document.querySelectorAll('#wr-unit button').forEach((b) => {
    b.classList.toggle('active', b.dataset.v === st.u);
    b.textContent = b.dataset.v === 'abs' ? 'TWh' : m.kind === 'trade' ? '% spotřeby' : '% výroby';
    b.onclick = () => go('svet/zebricek', params({ u: b.dataset.v }), true);
  });

  const Y = await getJSON('world/yearly.json');
  if (seq !== renderSeq) return;
  let pool = W.entities.filter((e) => (st.r === 'agg' ? e.agg : !e.agg && (st.r === 'top' || st.r === 'all' || e.region === st.r)));
  let items = pool.map((e) => {
    const row = wPeriodRow(Y, e.code, st.y);
    if (!row) return null;
    const gen = genOf(row.v);
    const value = m.kind === 'share' && st.u === 'abs' ? m.val(row.v) * gen : m.val(row.v, st.u);
    return value == null || !Number.isFinite(value) ? null : { code: e.code, row, gen, value };
  }).filter(Boolean);
  if (st.r === 'top') items = items.sort((a, b) => b.gen - a.gen).slice(0, TOP_N);
  items.sort((a, b) => b.value - a.value);
  showNotice('#wr-notice', items.length ? '' : 'Pro zvolené období nejsou k dispozici data.');

  const regionName = regionBtns.find(([k]) => k === st.r)[1];
  $('#wr-title').textContent = m.kind === 'share' && st.u === 'abs' ? m.title.replace('Podíl', 'Výroba z').replace(' na výrobě', '') + ' (TWh)'
    : m.kind === 'trade' ? (st.u === 'abs' ? 'Saldo obchodu s elektřinou (TWh)' : 'Saldo obchodu v % spotřeby') : m.title;
  $('#wr-sub').textContent = `${periodLabel(st.y)} · ${st.r === 'agg' ? `${items.length} regionů a skupin` : st.r === 'top' ? `${items.length} zemí s největší výrobou` : `${regionName}: ${items.length} zemí`}`;
  const groups = m.groups ? m.groups() : null;
  const gColor = (keys) => WSRC[keys[0]].color;
  $('#wr-legend').innerHTML = groups && groups.length > 1
    ? groups.map(([n, keys]) => `<span><i style="background:${gColor(keys)}"></i>${esc(n)}</span>`).join('')
    : m.kind === 'trade' ? `<span><i style="background:${cssVar('--exp')}"></i>čistý vývoz</span><span><i style="background:${cssVar('--imp')}"></i>čistý dovoz</span>` : '';
  const anyOld = items.some((i) => i.row.old);
  $('#wr-hint').textContent = {
    share: 'Podíl na domácí výrobě elektřiny (ne na spotřebě). ',
    trade: 'Vývoz − dovoz elektřiny za období podle Ember. Nahoře největší vývozci, dole největší dovozci. ',
    abs: '',
  }[m.kind] + (st.r === 'top' ? `${TOP_N} zemí s největší výrobou. ` : '')
    + 'Klepnutím na zemi otevřete její výrobu v čase.'
    + (anyOld ? (st.y === 'ltm' ? ' * data končí dřív než ostatní.' : ' * novější data zatím nejsou (rok je v detailu).') : '');

  const el = document.getElementById('chart-w-rank');
  el.style.height = `${60 + items.length * 26}px`;
  const c = chart('chart-w-rank');
  c.resize();
  const byCode = Object.fromEntries(items.map((i) => [i.code, i]));
  const name = (code) => wName(code) + (byCode[code]?.row.old ? ' *' : '');
  const pctAxis = (m.kind === 'share' || m.kind === 'trade') && st.u === 'pct';
  const scale = (x) => (pctAxis ? x * 100 : x);
  const show = (i) => fmtMetric(m, i.value, st.u);
  let series;
  if (groups) {
    series = groups.map(([n, keys], gi) => ({
      name: n, type: 'bar', stack: 'v', color: gColor(keys), barWidth: 16,
      itemStyle: { borderColor: cssVar('--card'), borderWidth: 0.5 },
      data: items.map((i) => {
        const part = keys.reduce((a, k) => a + (i.row.v[k] || 0), 0);
        return scale(st.u === 'abs' ? part : part / i.gen);
      }),
      label: gi === groups.length - 1
        ? { show: true, position: 'right', fontSize: 11, color: cssVar('--text'), formatter: (pp) => show(items[pp.dataIndex]) }
        : { show: false },
    }));
  } else if (m.kind === 'trade') {
    series = [{
      name: m.name, type: 'bar', barWidth: 16,
      data: items.map((i) => ({ value: scale(i.value), itemStyle: { color: i.value >= 0 ? cssVar('--exp') : cssVar('--imp') }, label: { position: i.value >= 0 ? 'right' : 'left' } })),
      label: { show: true, fontSize: 11, color: cssVar('--text'), formatter: (pp) => show(items[pp.dataIndex]) },
    }];
  } else {
    series = [{
      name: m.name, type: 'bar', barWidth: 16,
      data: items.map((i) => ({ value: i.value, itemStyle: { color: st.m === 'ci' ? colorFor(m, i.value) : cssVar('--accent') } })),
      label: { show: true, position: 'right', fontSize: 11, color: cssVar('--text'), formatter: (pp) => show(items[pp.dataIndex]) },
    }];
  }
  const vals = items.map((i) => scale(i.value));
  // diverging bars: room left of the largest import for its value label (~56 px)
  const plotW = Math.max(120, el.clientWidth - 230);
  const padFrac = Math.min(1.2, 56 / Math.max(60, plotW - 56));
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals), span = hi - lo || 1;
  const home = wHome || CC[homeCountry]?.world;
  c.setOption({
    backgroundColor: 'transparent',
    textStyle: baseText(),
    animationDuration: 300,
    grid: { left: 10, right: 70, top: 6, bottom: 6, containLabel: true },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'shadow' }, confine: true, ...tipCss(),
      formatter: (ps) => {
        const i = byCode[ps[0].name];
        if (!i) return '';
        const v = i.row.v;
        let body = tipRow(esc(m.name), esc(show(i)));
        if (groups) body += groups.map(([n, keys]) => { const part = keys.reduce((a, k) => a + (v[k] || 0), 0); return tipRow(swatch(gColor(keys)) + esc(n), `${nf1.format((part / i.gen) * 100)} % · ${fmtTWh(part)}`); }).join('');
        body += tipRow('Výroba celkem', fmtTWh(i.gen));
        if (v.demand != null) body += tipRow('Spotřeba', fmtTWh(v.demand));
        if (v.net_imports != null) body += tipRow('Saldo', fmtTWh(-v.net_imports, true));
        if (v.ci != null) body += tipRow('Emise', nf0.format(v.ci) + ' g CO₂/kWh');
        return `<div style="font-weight:600;margin-bottom:4px">${esc(wName(i.code))} <span style="font-weight:400;opacity:.7">${esc(i.row.label)}</span></div>` + body;
      },
    },
    xAxis: m.kind === 'trade'
      ? { type: 'value', ...axisCommon(), min: lo < 0 ? lo - span * padFrac : 0, max: hi > 0 ? hi : span * 0.05, axisLabel: { show: false }, splitLine: { show: false } }
      : {
          type: 'value', ...axisCommon(), position: 'top', max: pctAxis ? 100 : null,
          interval: pctAxis ? (el.clientWidth < 560 ? 50 : 25) : null, splitNumber: 3,
          axisLabel: { ...axisCommon().axisLabel, formatter: (x) => (pctAxis ? nf0.format(x) + ' %' : nf0.format(x)) },
        },
    yAxis: {
      type: 'category', inverse: true, data: items.map((i) => i.code), ...axisCommon(), axisTick: { show: false }, triggerEvent: true,
      axisLabel: {
        ...axisCommon().axisLabel, fontSize: 12, color: cssVar('--text'),
        formatter: (code) => (code === home ? `{home|${name(code)}}` : name(code)),
        rich: { home: { fontWeight: 700, fontSize: 12, color: cssVar('--accent') } },
      },
    },
    series,
  }, true);
  if (!c.__wired) {
    c.__wired = true;
    let last = 0;
    const open = (code) => {
      if (Date.now() - last < 400 || !WE[code]) return;
      last = Date.now();
      go('svet/vyroba', { e: code });
    };
    c.on('click', (pp) => open(pp.componentType === 'yAxis' ? pp.value : pp.name));
    c.getZr().on('click', (e) => setTimeout(() => {
      const pt = [e.offsetX, e.offsetY];
      if (!c.containPixel('grid', pt)) return;
      const [, yi] = c.convertFromPixel('grid', pt);
      open(c.getOption().yAxis[0].data[Math.round(yi)]);
    }, 0));
  }
}

/* ================================================= VIEW: Svět – Srovnání */
// Fixed colour per entity (colour follows the entity, never its rank); checked for
// colour-blind separation of all pairs. The world is a grey dashed reference line.
const CMP = [
  { code: 'europe', short: 'Evropa', light: '#257de0', dark: '#338ced' },
  { code: 'eu', short: 'EU', light: '#d28e05', dark: '#dcae1d' },
  { code: 'USA', short: 'USA', light: '#00b894', dark: '#00a888' },
  { code: 'CHN', short: 'Čína', light: '#ec4647', dark: '#eb6263' },
  { code: 'RUS', short: 'Rusko', light: '#8e44ad', dark: '#a463c4' },
  { code: 'world', short: 'Svět', light: '#8a8f98', dark: '#8f96a0', ref: true },
];
const CMP_DEFAULT = ['europe', 'USA', 'CHN', 'RUS'];
const cmpOf = (c) => CMP.find((x) => x.code === c);
const cmpColor = (c) => (DARK ? cmpOf(c).dark : cmpOf(c).light);
const fmtPct1 = (x) => (x == null ? '–' : nf1.format(x) + ' %');
const fmtInt = (unit) => (x) => (x == null ? '–' : nf0.format(x) + ' ' + unit);
// metric -> value from one period's values {field: number}
const CMP_VAL = {
  gen: (v) => { const g = genOf(v); return g > 0 ? g : null; },
  demand: (v) => v.demand ?? null,
  pc: (v) => v.kwh_pc ?? null,
  ren: (v) => pctOf(share(REN())(v)),
  ws: (v) => pctOf(share(['wind', 'solar'])(v)),
  clean: (v) => pctOf(share(CLEAN())(v)),
  nuclear: (v) => pctOf(share(['nuclear'])(v)),
  coal: (v) => pctOf(share(['coal'])(v)),
  gas: (v) => pctOf(share(['gas'])(v)),
  ci: (v) => (v.ci != null && genOf(v) > 0 ? v.ci : null),
  co2: (v) => (v.ci != null && genOf(v) > 0 ? (v.ci * genOf(v)) / 1000 : null), // g/kWh x TWh -> Mt
};
function pctOf(x) { return x == null ? null : x * 100; }
const CMP_TRENDS = [
  { key: 'gen', title: 'Výroba elektřiny', unit: 'TWh', fmt: (x) => fmtTWh(x) },
  { key: 'ren', title: 'Podíl OZE na výrobě', unit: '%', fmt: fmtPct1 },
  { key: 'ws', title: 'Podíl větru a slunce', unit: '%', fmt: fmtPct1 },
  { key: 'coal', title: 'Podíl uhlí', unit: '%', fmt: fmtPct1 },
  { key: 'ci', title: 'Emise na kWh výroby', unit: 'g CO₂/kWh', fmt: fmtInt('g') },
  { key: 'co2', title: 'Emise z výroby elektřiny', unit: 'Mt CO₂', fmt: fmtInt('Mt') },
  { key: 'pc', title: 'Spotřeba na obyvatele', unit: 'kWh za rok', fmt: fmtInt('kWh'), yearly: true },
];
const rowAt = (t, i) => Object.fromEntries(Object.entries(t).map(([k, arr]) => [k, arr[i]]));
const hasGen = (v) => FUELS().some((k) => v[k] != null);

/** Values summed over the given indexes (TWh fields), carbon intensity weighted by generation. */
function rowOver(t, idx) {
  const v = {};
  if (!idx.every((i) => hasGen(rowAt(t, i)))) return null;
  for (const k of [...FUELS(), 'demand', 'net_imports']) {
    if (!t[k]) continue;
    const vals = idx.map((i) => t[k][i]);
    v[k] = vals.every((x) => x != null) ? vals.reduce((a, x) => a + x, 0) : null;
  }
  let cw = 0, gw = 0;
  for (const i of idx) { const g = genAt(t, i); const c = t.ci?.[i]; if (c != null && g > 0) { cw += c * g; gw += g; } }
  v.ci = gw ? cw / gw : null;
  if (idx.length === 1) v.kwh_pc = t.kwh_pc?.[idx[0]] ?? null;
  return v;
}

async function renderWorldCompare(q) {
  const seq = ++renderSeq;
  await worldMeta();
  const all = CMP.map((x) => x.code).filter((c) => WE[c]);
  const want = (q.get('e') || CMP_DEFAULT.join(',')).split(',');
  let es = all.filter((c) => want.includes(c)); // fixed order
  if (!es.length) es = CMP_DEFAULT.filter((c) => all.includes(c));
  const g = q.get('g') === 'month' && es.every((c) => WE[c].m) ? 'month' : 'year';
  const params = (patch) => {
    const s = { es, g, ...patch };
    return { e: s.es.join(',') === CMP_DEFAULT.join(',') ? null : s.es.join(','), g: s.g === 'month' ? 'month' : null };
  };

  // controls
  $('#wc-entities').replaceChildren(...all.map((c) => {
    const b = document.createElement('button');
    const on = es.includes(c);
    b.className = 'chip' + (on ? ' on' : '');
    const i = document.createElement('i');
    if (on) i.style.background = cmpColor(c);
    b.append(i, cmpOf(c).short);
    b.title = WE[c].name;
    b.onclick = () => {
      const set = new Set(es);
      if (set.has(c)) { if (set.size > 1) set.delete(c); } else set.add(c);
      go('svet/srovnani', params({ es: all.filter((x) => set.has(x)) }), true);
    };
    return b;
  }));
  document.querySelectorAll('#wc-step button').forEach((b) => {
    b.classList.toggle('active', b.dataset.v === g);
    b.onclick = () => go('svet/srovnani', params({ g: b.dataset.v }), true);
  });

  // data: every selected entity + the world (for the share of world generation)
  let x;
  if (g === 'year') {
    x = [];
    for (let y = W.years[0]; y <= Math.max(...es.map((c) => WE[c].y[1])); y++) x.push(String(y));
  } else {
    const end = es.map((c) => WE[c].m[1]).sort().pop();
    x = D.months(addMonths(end, -59), end);
  }
  const codes = [...new Set([...es, 'world'])];
  const view = $('#view-svet-srovnani');
  view.classList.add('loading');
  const tabs = await Promise.all(codes.map((c) => wTable(c, g, x)));
  if (seq !== renderSeq) return;
  view.classList.remove('loading');
  const T = Object.fromEntries(codes.map((c, i) => [c, tabs[i]]));

  // period of the summary: newest year (or 12 months) that all of them - and the world - have
  let idx, label;
  if (g === 'year') {
    const y = String(Math.min(...codes.map((c) => WE[c].y[1])));
    idx = [x.indexOf(y)];
    label = `rok ${y}`;
  } else {
    const end = codes.map((c) => WE[c].m[1]).sort()[0];
    const i = x.indexOf(end);
    idx = Array.from({ length: 12 }, (_, k) => i - 11 + k).filter((k) => k >= 0);
    label = `${fmtYm(x[idx[0]])} – ${fmtYm(end)}`;
  }
  const rows = Object.fromEntries(codes.map((c) => [c, rowOver(T[c], idx)]));
  showNotice('#wc-notice', es.some((c) => !rows[c]) ? 'Pro část výběru nejsou za zvolené období data.' : '');
  $('#wc-period').textContent = label;
  $('#wc-mix-period').textContent = label;
  cmpTable(es, rows, g);
  cmpMix(es, rows);
  cmpTrends(es, T, x, g);
  $('#wc-hint').textContent = 'Evropa = celý kontinent podle Emberu včetně Ruska, Turecka, Ukrajiny a Běloruska '
    + '(Rusko je tedy v Evropě započítané i zvlášť); EU = 27 členských států. Podíly jsou z domácí výroby, emise jen z výroby elektřiny (bez dovozu). '
    + (g === 'month' ? 'Po měsících je vidět sezónnost (slunce v létě, vítr v zimě). ' : '')
    + 'Data: Ember.';
}

function cmpTable(es, rows, g) {
  const world = rows.world;
  // units live in the row labels so the cells stay narrow on a phone
  const num = (x, d = 0) => (x == null ? '–' : NF(d).format(x));
  const twh = (x) => num(x, x != null && Math.abs(x) < 100 ? 1 : 0);
  const lines = [
    ['Výroba, TWh', (v) => twh(CMP_VAL.gen(v))],
    ['podíl na světové výrobě', (v) => (world && CMP_VAL.gen(v) && CMP_VAL.gen(world) ? fmtPct1((CMP_VAL.gen(v) / CMP_VAL.gen(world)) * 100) : '–'), true],
    ['Spotřeba, TWh', (v) => twh(CMP_VAL.demand(v))],
    ...(g === 'year' ? [['na obyvatele, kWh', (v) => num(CMP_VAL.pc(v)), true]] : []),
    ['Podíl OZE', (v) => fmtPct1(CMP_VAL.ren(v))],
    ['z toho vítr a slunce', (v) => fmtPct1(CMP_VAL.ws(v)), true],
    ['Jádro', (v) => fmtPct1(CMP_VAL.nuclear(v))],
    ['Uhlí', (v) => fmtPct1(CMP_VAL.coal(v))],
    ['Plyn', (v) => fmtPct1(CMP_VAL.gas(v))],
    ['Emise, g CO₂/kWh', (v) => num(CMP_VAL.ci(v))],
    ['Emise celkem, Mt CO₂', (v) => num(CMP_VAL.co2(v))],
  ];
  $('#wc-table').innerHTML = `<thead><tr><th></th>${es.map((c) => `<th><i style="background:${cmpColor(c)}"></i>${esc(cmpOf(c).short)}</th>`).join('')}</tr></thead>
    <tbody>${lines.map(([name, f, sub]) => `<tr${sub ? ' class="sub"' : ''}><td>${esc(name)}</td>${es.map((c) => `<td>${rows[c] ? f(rows[c]) : '–'}</td>`).join('')}</tr>`).join('')}</tbody>`;
}

function cmpMix(es, rows) {
  const keys = FUELS().filter((k) => es.some((c) => rows[c]?.[k] > 0));
  $('#wc-mix-legend').innerHTML = keys.map((k) => `<span><i style="background:${WSRC[k].color}"></i>${esc(WSRC[k].name)}</span>`).join('');
  const list = es.filter((c) => rows[c]);
  const el = document.getElementById('chart-wc-mix');
  el.style.height = `${50 + 40 * list.length}px`;
  const c = chart('chart-wc-mix');
  c.resize();
  c.setOption({
    backgroundColor: 'transparent',
    textStyle: baseText(),
    grid: { left: 8, right: 14, top: 6, bottom: 6, containLabel: true },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'shadow' }, confine: true, ...tipCss(),
      formatter: (ps) => `<b>${esc(ps[0].name)}</b><br>` + ps.filter((p) => p.value > 0.0005).sort((a, b) => b.value - a.value)
        .map((p) => `${p.marker}${esc(p.seriesName)}: <b>${nf1.format(p.value * 100)} %</b>`).join('<br>'),
    },
    xAxis: { type: 'value', max: 1, ...axisCommon(), axisLabel: { ...axisCommon().axisLabel, formatter: (v) => nf0.format(v * 100) + ' %' } },
    yAxis: { type: 'category', inverse: true, data: list.map((x) => cmpOf(x).short), ...axisCommon(), axisTick: { show: false },
      axisLabel: { ...axisCommon().axisLabel, fontSize: 12.5, color: cssVar('--text'), fontWeight: 600 } },
    series: keys.map((k) => ({
      name: WSRC[k].name, type: 'bar', stack: 'mix', color: WSRC[k].color, barWidth: '60%',
      itemStyle: { borderColor: cssVar('--card'), borderWidth: 0.5 },
      data: list.map((x) => { const g = genOf(rows[x]); return g > 0 ? (rows[x][k] || 0) / g : 0; }),
    })),
  }, true);
}

function cmpTrends(es, T, x, g) {
  const box = $('#wc-trends');
  if (!box.childElementCount) {
    // cards are created once: chart instances are bound to their elements
    box.append(...CMP_TRENDS.map((m) => {
      const card = document.createElement('div');
      card.className = 'card';
      card.dataset.key = m.key;
      card.innerHTML = `<div class="card-head"><h2>${esc(m.title)}</h2><span class="muted">${esc(m.unit)}</span></div>
        <div id="chart-wc-${m.key}" class="chart small"></div>`;
      return card;
    }));
  }
  const label = (v) => (g === 'month' ? D.monthLabel(v) : v);
  for (const m of CMP_TRENDS) {
    const card = box.querySelector(`[data-key="${m.key}"]`);
    card.hidden = m.yearly && g !== 'year';
    if (card.hidden) continue;
    const c = chart(`chart-wc-${m.key}`);
    c.resize();
    const series = es.map((code) => {
      const t = T[code];
      const data = x.map((_, i) => { const v = rowAt(t, i); return hasGen(v) || m.key === 'pc' ? CMP_VAL[m.key](v) : null; });
      const ref = cmpOf(code).ref;
      return {
        name: cmpOf(code).short, type: 'line', data, color: cmpColor(code), symbol: 'none', connectNulls: false,
        lineStyle: { width: ref ? 1.6 : 2.2, type: ref ? 'dashed' : 'solid' },
        endLabel: { show: true, formatter: (p) => p.seriesName, color: cssVar('--text'), fontSize: 11.5, fontWeight: 600, distance: 4 },
        labelLayout: { moveOverlap: 'shiftY' },
        emphasis: { focus: 'series' },
      };
    });
    c.setOption({
      backgroundColor: 'transparent',
      textStyle: baseText(),
      animationDuration: 300,
      grid: { left: 8, right: 50, top: 12, bottom: 6, containLabel: true },
      tooltip: {
        trigger: 'axis', confine: true, ...tipCss(),
        formatter: (ps) => {
          const head = g === 'month' ? fmtYm(x[ps[0].dataIndex]) : x[ps[0].dataIndex];
          return `<div style="font-weight:600;margin-bottom:4px">${esc(head)}</div>` + ps.filter((p) => p.value != null)
            .sort((a, b) => b.value - a.value).map((p) => tipRow(p.marker + esc(p.seriesName), esc(m.fmt(p.value)))).join('');
        },
      },
      xAxis: { type: 'category', data: x, boundaryGap: false, ...axisCommon(), axisLabel: { ...axisCommon().axisLabel, formatter: label }, splitLine: { show: false } },
      yAxis: { type: 'value', min: 0, ...axisCommon(), axisLabel: { ...axisCommon().axisLabel, formatter: (v) => nf0.format(v) + (m.unit === '%' ? ' %' : '') } },
      series,
    }, true);
  }
}
