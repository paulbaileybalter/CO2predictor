/* Balter CO2 Predictor — UI */
(function () {
  'use strict';
  const M = window.CO2, LBB = window.LBB;
  const KEY = 'balterCo2.v1';
  const DEFAULTS = { cap: 30, load: 20, maxFill: 90, floor: 15, lead: 2, dows: [1, 2, 3, 4, 5] };
  const Z = 1.28;                                   // ~90% band
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const $ = (s, el) => (el || document).querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ---------- today (override with ?today=YYYY-MM-DD for testing) ---------- */
  const qs = new URLSearchParams(location.search);
  const localISO = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`; };
  const TODAY = /^\d{4}-\d{2}-\d{2}$/.test(qs.get('today') || '') ? qs.get('today') : localISO();

  /* ---------- state ---------- */
  function load() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(KEY)); } catch (e) { s = null; }
    return normalise(s);
  }
  function normalise(s) {
    const seed = window.SEED || { board: {}, readings: [], version: '' };
    if (!s || typeof s !== 'object') {
      s = { seedVersion: seed.version, settings: {}, readings: seed.readings.map((r) => ({ ...r })), board: { ...seed.board }, overrides: {} };
    } else if (s.seedVersion !== seed.version) {          // site was redeployed with newer spreadsheet data: seed wins on shared dates
      const map = new Map((s.readings || []).map((r) => [r.d, r]));
      seed.readings.forEach((r) => map.set(r.d, { ...r }));
      s.readings = [...map.values()].sort((a, b) => (a.d < b.d ? -1 : 1));
      s.board = { ...(s.board || {}), ...seed.board };
      s.seedVersion = seed.version; s.invNeedsSeed = true;
    }
    const seedInv = window.INVOICES || [];
    if (!Array.isArray(s.invoices)) s.invoices = seedInv.map((x) => ({ ...x }));
    else if (s.invNeedsSeed) { const m = new Map(s.invoices.map((x) => [x.date + '|' + x.docket, x])); seedInv.forEach((x) => m.set(x.date + '|' + x.docket, { ...x })); s.invoices = [...m.values()]; }
    delete s.invNeedsSeed;
    const seedOrders = (window.SEED && window.SEED.orders) || [];
    if (!Array.isArray(s.orders)) s.orders = [];
    if (!Array.isArray(s.events)) s.events = [];
    ((window.SEED && window.SEED.events) || []).forEach((ev) => { if (!s.events.some((x) => x.id === ev.id) && !(s.removedEvents || []).includes(ev.id)) s.events.push({ ...ev }); });
    if (s.invNeedsSeed || !s.seededOrders) { seedOrders.forEach((o) => { if (!s.orders.some((x) => x.id === o.id)) s.orders.push({ ...o }); }); s.seededOrders = true; }
    s.settings = { ...DEFAULTS, ...(s.settings || {}) };
    s.overrides = s.overrides || {};
    return s;
  }
  let state = load();
  /* Saved in this browser AND (when the Worker's KV store is bound) shared with everyone who signs in. */
  let pushT = null, syncOK = null;
  function save() {
    state.updated = Date.now();
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* storage unavailable: keep working in memory */ }
    clearTimeout(pushT); pushT = setTimeout(push, 600);
  }
  async function push() {
    try {
      const r = await fetch('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state) });
      if (r.status === 401) { location.href = '/login'; return; }
      syncOK = r.ok; if (!r.ok) toast('Saved on this computer only — shared storage is not set up');
    } catch (e) { syncOK = false; }
  }
  async function pull() {
    try {
      const r = await fetch('/api/state', { cache: 'no-store' });
      if (r.status === 401) { location.href = '/login'; return; }
      if (!r.ok) { syncOK = false; return; }
      syncOK = true;
      const remote = await r.json();
      if (!remote) { push(); return; }                        // first use: publish what we have
      if ((remote.updated || 0) > (state.updated || 0)) {
        state = normalise(remote); state.updated = remote.updated;
        try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
        render();
      } else if ((remote.updated || 0) < (state.updated || 0)) push();
    } catch (e) { syncOK = false; }
  }

  /* ---------- formatting ---------- */
  const fmtD = (d) => { const [, m, day] = d.split('-').map(Number); return `${DOW[M.dow(d)]} ${day} ${MON[m - 1]}`; };
  const fmtS = (d) => { const [, m, day] = d.split('-').map(Number); return `${day} ${MON[m - 1]}`; };
  const S = () => state.settings;
  const tn = (pct) => (pct * S().cap / 100);
  const fT = (pct, dp) => tn(pct).toFixed(dp === undefined ? 1 : dp) + ' t';
  const fP = (pct, dp) => pct.toFixed(dp === undefined ? 1 : dp) + '%';
  const rel = (d) => { const n = M.diffDays(TODAY, d); return n === 0 ? 'today' : n === 1 ? 'tomorrow' : n === -1 ? 'yesterday' : n > 0 ? `in ${n} days` : `${-n} days ago`; };
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  /* ---------- derived numbers ---------- */
  let C = null;
  const cfgLoadPct = () => S().load / S().cap * 100;
  function compute() {
    const set = S();
    const q = M.observations(state.readings, state.board);
    const model = M.fit(q.obs);
    const rows = q.rows;
    const latest = rows[rows.length - 1];
    let startDate, startLevel, lastLabel, frac0 = 1;
    if (latest && latest.cur && latest.pm === null) {
      const h = +latest.cur.h.split(':')[0] + +latest.cur.h.split(':')[1] / 60;
      startDate = latest.d; startLevel = latest.cur.v; lastLabel = `${fmtS(latest.d)} ${latest.cur.h}`;
      frac0 = h < 6 ? 1 : Math.min(1, Math.max(0.05, (17 - h) / 11));     // working-day draw runs ~6am–5pm
    } else if (latest && latest.pm !== null) { startDate = M.addDays(latest.d, 1); startLevel = latest.pm; lastLabel = `${fmtS(latest.d)} evening`; }
    else if (latest && latest.am !== null) { startDate = latest.d; startLevel = latest.am; lastLabel = `${fmtS(latest.d)} morning`; }
    else { startDate = TODAY; startLevel = 50; lastLabel = 'no readings yet'; }

    const withTransfers = Object.keys(state.board).filter((d) => state.board[d][0] + state.board[d][1] + state.board[d][2] > 0).sort();
    const boardEnd = withTransfers.length ? withTransfers[withTransfers.length - 1] : null;
    const lastBoard = Object.keys(state.board).sort().pop() || null;
    let end = boardEnd && boardEnd > startDate ? boardEnd : M.addDays(startDate, 6);
    const recFor = (d) => {
      const base = state.board[d] || [0, 0, 0, 0, 0], ov = state.overrides[d];
      return base.map((v, i) => (ov && ov[i] !== null && ov[i] !== undefined ? ov[i] : v));
    };
    const days = M.range(startDate, end).map((d, i) => ({ d, rec: recFor(d), frac: i === 0 ? frac0 : 1 }));
    const cfg = { floor: set.floor, loadPct: set.load / set.cap * 100, maxFill: set.maxFill, lead: set.lead, allowedDows: set.dows, z: Z };
    const kgPt0 = set.cap * 10;
    const orderArr = (o) => (o.when === 'night' ? M.addDays(o.date, 1) : o.date);
    const orders = state.orders.map((o) => ({ i: days.findIndex((x) => x.d === orderArr(o)), pts: Math.max(0, o.t) * 1000 / kgPt0, ref: o })).filter((o) => o.i >= 0);
    const sim = M.simulate({ startLevel, days, model, cfg, orders });

    // deliveries already received: estimate size = observed rise + the use that happened over the same days
    const meanUse = model.perDayMean || 8.8;
    const amOn = {}; rows.forEach((r) => { if (r.am !== null) amOn[r.d] = r.am; });
    const pmOn = {}; rows.forEach((r) => { if (r.pm !== null) pmOn[r.d] = r.pm; });
    const past = q.deliveries.map((x) => {
      const before = pmOn[x.from];
      // morning reading already above last night's level = it was taken after the truck: size is read straight off the gauge
      const pts = amOn[x.d] !== undefined && amOn[x.d] > before + 3 ? amOn[x.d] - before : x.rise + x.days * meanUse;
      const full = cfgLoadPct(), short = pts < full * 0.85 && before + pts < set.maxFill - 5;   // a load that stopped at max fill is not "short"
      return { ...x, pts, t: tn(pts), before, short };
    });

    // history of single/multi-day observed use, for the fit chart
    const hist = q.obs.map((o, i) => ({ ...o, pred: model.ok ? model.pred[i] : null }));
    const last7 = hist.filter((o) => M.diffDays(o.d, startDate) <= 8);
    const act7 = last7.length ? last7.reduce((s, o) => s + o.use, 0) / last7.reduce((s, o) => s + o.n, 0) : null;
    C = { inv: null, frac0, q, model, rows, latest, startDate, startLevel, lastLabel, days, end, boardEnd, lastBoard, cfg, sim, past, hist, act7, recFor };
    C.inv = matchInvoices();
  }

  /* ---------- status of next delivery ---------- */
  function nextStatus() {
    const p = C.sim.planned[0];
    if (!p) return { st: 'ok', text: 'No delivery needed in the planning window', p: null };
    if (p.ordered) {
      const lo = p.lowBefore, nx = C.sim.planned.find((x) => !x.ordered);
      const more = nx ? ` Next load to order: ${fmtD(nx.d)} — order by ${fmtD(nx.orderBy)}.` : '';
      if (p.before < 0.5) return { st: 'risk', text: `Order placed, but the vessel is forecast to run dry before it arrives.${more}`, p };
      if (lo < 3 || C.sim.planned.some((x) => x.tooLate)) return { st: 'risk', text: `Order placed — but in a heavy-use case the vessel could be nearly empty (${fP(Math.max(0, lo), 0)}) when it arrives.${more}`, p };
      if (p.before < S().floor) return { st: 'watch', text: `Order placed — arrives with ≈${fP(p.before)} left, under your ${S().floor}% floor.${more}`, p };
      return { st: 'ok', text: `Order placed — arrives with ≈${fP(p.before, 0)} (${fT(p.before)}) left.${more}`, p };
    }
    const left = M.diffDays(TODAY, p.orderBy);
    if (left < 0) return { st: 'risk', text: `Order was due ${fmtD(p.orderBy)} — call the supplier now`, p };
    if (left === 0) return { st: 'order', text: 'Place the order today', p };
    if (left <= 2) return { st: 'watch', text: `Place the order ${left === 1 ? 'tomorrow' : 'in 2 days'} (${fmtD(p.orderBy)})`, p };
    return { st: 'ok', text: `Place the order by ${fmtD(p.orderBy)}`, p };
  }


  /* ---------- quick add ---------- */
  let quickType = null, quickDateTouched = false;
  const defaultType = () => { const h = new Date().getHours(); return h < 11 ? 'am' : h < 17 ? 'cur' : 'pm'; };
  const defaultDate = (t) => (t === 'pm' && new Date().getHours() < 12 ? M.addDays(TODAY, -1) : TODAY);
  function renderQuick() {
    const t = quickType || defaultType();
    const seg = (k, label) => `<button type="button" class="seg${t === k ? ' on' : ''}" data-act="qType" data-t="${k}">${label}</button>`;
    return `<div class="panel quick" id="quick">
      <div class="quick-in">
        <div><span class="eyebrow">Add a reading</span><div class="segs">${seg('am', 'Morning')}${seg('pm', 'Evening')}${seg('cur', 'Live now')}</div></div>
        <label class="fld"><span>Gauge level %</span><input type="number" id="qVal" step="0.1" min="0" max="100" inputmode="decimal" placeholder="e.g. 44.2"></label>
        <label class="fld"><span>Date</span><input type="date" id="qDate" value="${defaultDate(t)}"></label>
        <label class="fld" id="qTimeWrap" style="${t === 'cur' ? '' : 'display:none'}"><span>Time</span><input type="time" id="qTime" value="${nowHM()}"></label>
        <button class="btn teal" data-act="quickSave">Save reading</button>
      </div>
      <p class="muted" style="font-size:12px;margin:8px 0 0">Morning and evening are the handover levels. “Live now” is a mid-day check — the forecast then counts only the rest of today's use.</p>
    </div>`;
  }


  function renderUpdateRow() {
    const when = state.boardUpdated ? new Date(state.boardUpdated.at).toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : null;
    const status = C.lastBoard
      ? `Board covers <b>${fmtS(Object.keys(state.board).sort()[0])} → ${fmtD(C.lastBoard)}</b>; transfers planned to <b>${C.boardEnd ? fmtD(C.boardEnd) : 'none'}</b>.${when ? ' Last updated ' + when + '.' : ''}`
      : 'No board loaded yet.';
    return `<div class="updates">
      ${renderQuick()}
      <div class="panel drop" id="drop" tabindex="0" role="button" aria-label="Drop the Live Brewery Board spreadsheet here, or press Enter to choose a file">
        <span class="eyebrow">Update the plan</span>
        <div class="drop-title">Drop the latest Live Brewery Board here</div>
        <p class="muted" style="font-size:12.5px;margin:4px 0 0">or click to choose the .xlsx file. The forecast recalculates straight away. (A CO2 handover sheet dropped here is imported as readings.)</p>
        <p class="drop-status" style="font-size:12px;margin:10px 0 0">${status}</p>
      </div>
    </div>`;
  }

  /* ---------- hero ---------- */
  function vesselSVG(level) {
    const lv = Math.max(0, Math.min(100, level)), floor = S().floor;
    const yB = 214, yT = 40, h = yB - yT, yL = yB - lv / 100 * h, yF = yB - floor / 100 * h;
    const body = 'M30,74 Q30,28 80,28 Q130,28 130,74 L130,200 Q130,214 116,214 L44,214 Q30,214 30,200 Z';
    let bubbles = '';
    for (let i = 0; i < 9; i++) {
      const x = 42 + (i * 37) % 76, r = 2 + (i % 3), d = (i * 0.9).toFixed(1), y = yB - 6 - (i * 13) % 18;
      bubbles += `<circle class="vb" cx="${x}" cy="${y}" r="${r}" fill="#fff" fill-opacity=".7" style="animation-delay:${d}s;animation-duration:${4 + (i % 4)}s"/>`;
    }
    const wave = `M30,${yL} q12,-5 25,0 t25,0 t25,0 t25,0 V${yL + 9} H30 Z`;
    return `<svg class="vessel" viewBox="0 0 160 250" role="img" aria-label="Vessel level ${fP(lv)}">
      <defs><clipPath id="vclip"><path d="${body}"/></clipPath></defs>
      <path d="${body}" fill="#fff"/>
      <g clip-path="url(#vclip)">
        <rect x="30" y="${yL}" width="100" height="${yB - yL + 4}" fill="#FFD637"/>
        <path d="${wave}" fill="#F1EB9C"/>
        ${bubbles}
        <line x1="30" x2="130" y1="${yF}" y2="${yF}" stroke="#000" stroke-width="1.5" stroke-dasharray="5 4"/>
      </g>
      <path d="${body}" fill="none" stroke="#000" stroke-width="2.5"/>
      <line x1="46" y1="214" x2="40" y2="232" stroke="#000" stroke-width="2.5" stroke-linecap="round"/>
      <line x1="114" y1="214" x2="120" y2="232" stroke="#000" stroke-width="2.5" stroke-linecap="round"/>
      <text x="80" y="${Math.min(Math.max(yL + 36, 120), 190)}" text-anchor="middle" font-size="26" font-weight="700">${lv.toFixed(0)}%</text>
      <text x="80" y="${Math.min(Math.max(yL + 36, 120), 190) + 17}" text-anchor="middle" font-size="12" font-weight="500">${fT(lv)}</text>
      <text x="134" y="${yF - 4}" font-size="9.5" font-weight="600" fill="#000">floor ${floor}%</text>
    </svg>`;
  }

  function renderHero() {
    const ns = nextStatus(), p = ns.p, sim = C.sim, set = S();
    const stale = M.diffDays(C.latest ? (C.latest.pm !== null ? C.latest.d : C.latest.d) : TODAY, TODAY);
    let banners = '';
    if (!C.q.rows.length) banners += `<div class="banner"><span><b>No readings yet.</b> Add the latest CO2 level in the Readings section to start forecasting.</span></div>`;
    else if (stale >= 2) banners += `<div class="banner"><span><b>Latest reading is ${stale} days old (${esc(C.lastLabel)}).</b> The forecast runs from that reading — add recent levels for a tighter prediction.</span><a class="btn small" href="#readings">Add reading</a></div>`;
    if (!C.model.ok) banners += `<div class="banner"><span><b>Not enough clean readings to fit the model yet</b> (${C.model.n} usable days). Showing a plain average until more readings are added.</span></div>`;
    if (sim.unresolved) banners += `<div class="banner bad"><span><b>Heads up:</b> the vessel gets close to the floor before a delivery can land (weekend or already too late). Consider an earlier or extra load.</span></div>`;

    let when, relTxt, list;
    if (p) {
      when = fmtD(p.d); relTxt = rel(p.d);
      const ordLine = p.ordered ? `<li><b>Order</b><span>Placed ${p.order.placed ? fmtD(p.order.placed) : ''} for ${fmtD(p.order.date)} ${p.order.when === 'night' ? 'night' : 'early morning'} <span class="muted">(${(+p.order.t).toFixed(0)} t)</span></span></li>` : `<li><b>Order by</b><span>${fmtD(p.orderBy)} <span class="muted">(${plural(set.lead, 'day')} notice)</span></span></li>`;
      list = `
        ${ordLine}
        <li><b>Load</b><span>${fT(p.add)} <span class="muted">${p.partial ? '— only part of this load fits' : p.ordered ? '— all of it fits' : '— a full 20 t load fits'}</span></span></li>
        <li><b>Level on arrival</b><span>${fP(p.before)} <span class="muted">(${fT(p.before)}) → ${fP(p.after)}</span></span></li>
        <li><b>Hits ${set.floor}% floor</b><span>${sim.floorDate ? fmtD(sim.floorDate) : 'not in window'}${sim.floorDateLo && sim.floorDateLo < sim.floorDate ? ` <span class="muted">(as early as ${fmtD(sim.floorDateLo)})</span>` : ''}</span></li>
        <li><b>Runs dry if none</b><span>${sim.emptyDate ? fmtD(sim.emptyDate) : 'not in window'}</span></li>`;
    } else {
      when = 'None needed'; relTxt = `to ${fmtS(C.end)}`;
      list = `<li><b>Lowest level</b><span>${fP(Math.min(...sim.rows.map((r) => r.e)))} before ${fmtD(C.end)}</span></li>`;
    }
    const gauge = vesselSVG(C.startLevel);
    const next7 = sim.rows.slice(0, 7); const avg7 = next7.length ? next7.reduce((s, r) => s + r.use, 0) / next7.length : 0;
    const err = Math.max(0.6, C.model.sigma || C.model.loo || C.model.rmse);
    return `${banners}
    <section class="sec" id="plan">
      <div class="sec-head"><div><span class="eyebrow">Delivery plan</span><h2>When do we need CO2?</h2>
        <p>Forecast from the latest vessel reading and the Live Brewery Board. Transfers and packaging set the daily draw; deliveries are kept to your accepted days.</p></div></div>
      <div class="hero">
        <div class="next st-${ns.st}">
          <span class="eyebrow">${p && p.ordered ? 'Next delivery · ordered' : 'Next delivery'}</span>
          <div class="when">${when}</div>
          <span class="rel">${relTxt}</span>
          <ul>${list}</ul>
          <div class="ask">${esc(ns.text)}</div>
          ${p && !p.ordered ? `<div style="margin-top:10px"><button class="btn small" data-act="logOrder" data-d="${p.d}">I've placed this order</button></div>` : ''}
        </div>
        <div class="panel gauge-panel">
          <div>${gauge}</div>
          <div class="tiles">
            <div class="tile t-gold"><small>Vessel now</small><b>${fT(C.startLevel)} <span>${fP(C.startLevel)}</span></b><p>${esc(C.lastLabel)}</p></div>
            <div class="tile t-teal"><small>Forecast use / day</small><b>${fT(avg7)} <span>${fP(avg7)}</span></b><p>Average of the next 7 planned days</p></div>
            <div class="tile t-purple"><small>Actual use / day</small><b>${C.act7 === null ? '–' : fT(C.act7)} <span>${C.act7 === null ? '' : fP(C.act7)}</span></b><p>Measured over the last week</p></div>
            <div class="tile"><small>Typical miss</small><b>± ${fT(err)} <span>per day</span></b><p>Based on ${C.model.n} days of readings</p></div>
          </div>
        </div>
      </div>
      ${renderUpdateRow()}
      ${renderSchedule()}
      ${renderOrders()}
    </section>`;
  }

  function renderSchedule() {
    const pl = C.sim.planned;
    const rows = pl.map((x, i) => {
      const left = M.diffDays(TODAY, x.orderBy);
      const chip = x.ordered ? `<span class="chip st-ok"><i></i>Ordered</span>${x.before < S().floor ? ' <span class="chip st-watch"><i></i>Low on arrival</span>' : ''}` : x.tooLate ? '<span class="chip st-risk"><i></i>Needed before your order lands</span>' : left < 0 ? '<span class="chip st-risk"><i></i>Overdue</span>' : left === 0 ? '<span class="chip st-order"><i></i>Order today</span>' : left <= 2 ? '<span class="chip st-watch"><i></i>Soon</span>' : '<span class="chip st-ok"><i></i>On track</span>';
      return `<tr><td>${i + 1}</td><td class="sticky-col2"><b>${fmtD(x.d)}</b><small>${rel(x.d)}${x.ordered && x.order.when === 'night' ? ' · ordered for ' + fmtS(x.order.date) + ' night' : ''}</small></td><td>${x.ordered ? 'Placed' + (x.order.placed ? ' ' + fmtS(x.order.placed) : '') : fmtD(x.orderBy)}</td><td class="r num">${fP(x.before)}<small>${fT(x.before)}</small></td><td class="r num">${fP(x.after)}<small>${fT(x.after)}</small></td><td class="r num">${fT(x.add)}${x.partial ? '<small>part load</small>' : ''}</td><td>${chip}</td></tr>`;
    }).join('');
    return `<div class="panel" style="margin-top:14px">
      <div class="pad" style="padding-bottom:6px"><b>Delivery schedule to ${fmtD(C.end)}</b> <span class="muted" style="font-size:12px">· assumes each load lands on the day shown and the plan on the board is followed</span></div>
      ${pl.length ? `<div class="tbl-wrap"><table><thead><tr><th>#</th><th>Deliver on</th><th>Order by</th><th class="r">Level before</th><th class="r">Level after</th><th class="r">Load</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="pad muted" style="font-size:13px">No deliveries needed before ${fmtD(C.end)} — the vessel stays above the ${S().floor}% floor.</div>`}
      <div class="note" style="padding-top:10px">Where the board has no transfers entered yet (${C.boardEnd && C.lastBoard > C.boardEnd ? 'after ' + fmtS(C.boardEnd) : 'beyond the last planned week'}) the forecast stops, because transfers are the biggest swing in daily use.</div>
    </div>`;
  }


  /* ---------- orders ---------- */
  function renderOrders() {
    const set = S();
    const arr = (o) => (o.when === 'night' ? M.addDays(o.date, 1) : o.date);
    const list = state.orders.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).map((o) => {
      const gone = arr(o) < C.startDate;
      return `<tr class="${gone ? 'hist' : ''}"><td class="sticky-col">${fmtD(o.date)}</td><td>${o.when === 'night' ? 'Overnight (lands early ' + fmtS(M.addDays(o.date, 1)) + ')' : 'Early morning'}</td><td class="r num">${(+o.t).toFixed(1)} t</td><td>${o.placed ? fmtD(o.placed) : ''}</td><td>${esc(o.note || '')}</td><td>${gone ? '<span class="chip plain"><i></i>Should have arrived</span>' : '<span class="chip st-ok"><i></i>Counted in forecast</span>'}</td><td class="r"><button class="btn small x" data-act="delOrder" data-id="${esc(o.id)}" aria-label="Delete order">×</button></td></tr>`;
    }).join('');
    return `<div class="panel" style="margin-top:14px" id="orders">
      <div class="pad" style="padding-bottom:6px"><b>Orders placed with Supagas</b> <span class="muted" style="font-size:12px">· a logged order is treated as arriving; the forecast then plans the load after it</span></div>
      <div class="pad" style="padding-top:6px"><div class="form-row">
        <label class="fld"><span>Delivery date</span><input type="date" id="orDate"></label>
        <label class="fld"><span>Truck arrives</span><select id="orWhen"><option value="night">Overnight (lands early next morning)</option><option value="am">Early morning of that date</option></select></label>
        <label class="fld" style="min-width:90px"><span>Quantity (t)</span><input type="number" id="orT" step="0.1" min="1" value="${set.load}"></label>
        <label class="fld"><span>Order placed</span><input type="date" id="orPlaced" value="${TODAY}"></label>
        <label class="fld" style="flex:1;min-width:150px"><span>Note (optional)</span><input type="text" id="orNote" placeholder="PO / confirmation no."></label>
        <button class="btn teal" data-act="addOrder">Log order</button></div></div>
      ${list ? `<div class="tbl-wrap"><table><thead><tr><th>Delivery date</th><th>Arrival</th><th class="r">Quantity</th><th>Placed</th><th>Note</th><th>Status</th><th></th></tr></thead><tbody>${list}</tbody></table></div>` : '<div class="note" style="padding-top:0">No orders logged yet.</div>'}
    </div>`;
  }

  /* ---------- level chart ---------- */
  let tips = {};
  function levelChart() {
    const W = 960, H = 380, L = 46, R = 20, T = 20, B = 38;
    const first0 = M.addDays(C.startDate, -28), hist = C.q.rows.filter((r) => r.d >= first0), first = hist.length ? hist[0].d : C.startDate, last = C.end;
    const t0 = M.parse(first), t1 = M.parse(last) + 864e5;
    const x = (d, f) => L + ((M.parse(d) + f * 864e5) - t0) / (t1 - t0) * (W - L - R);
    const y = (v) => T + (1 - Math.max(0, Math.min(100, v)) / 100) * (H - T - B);
    const FA = 0.27, FP = 0.72;
    let g = '';
    // weekend wash + x labels
    const nDays = M.diffDays(first, last) + 1, step = nDays > 45 ? 7 : nDays > 24 ? 4 : 2;
    M.range(first, last).forEach((d, i) => {
      if ([0, 6].includes(M.dow(d))) g += `<rect x="${x(d, 0)}" y="${T}" width="${x(d, 1) - x(d, 0)}" height="${H - T - B}" fill="#FAFAF7"/>`;
      if (i % step === 0 || M.dow(d) === 1 && step > 2 && false) g += `<text class="ax" x="${x(d, 0.5)}" y="${H - 16}" text-anchor="middle">${fmtS(d)}</text><text class="ax" x="${x(d, 0.5)}" y="${H - 4}" text-anchor="middle">${DOW[M.dow(d)]}</text>`;
    });
    [0, 25, 50, 75, 100].forEach((v) => {
      g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#E7E5DE" stroke-width="1"/><text class="ax" x="${L - 7}" y="${y(v) + 3.5}" text-anchor="end">${v}%</text>`;
    });
    g += `<text class="ax" x="${L - 7}" y="${T - 7}" text-anchor="end">${(S().cap).toFixed(0)} t</text>`;
    // floor
    g += `<line x1="${L}" x2="${W - R}" y1="${y(S().floor)}" y2="${y(S().floor)}" stroke="#000" stroke-width="1.4" stroke-dasharray="6 5"/><text class="lbl" x="${W - R - 4}" y="${y(S().floor) - 6}" text-anchor="end">Reorder floor ${S().floor}%</text>`;
    // band
    const sim = C.sim;
    if (sim.rows.length) {
      const up = [`${x(C.startDate, FA)},${y(C.startLevel)}`], lo = [];
      sim.rows.forEach((r) => { up.push(`${x(r.d, FP)},${y(r.hi)}`); lo.unshift(`${x(r.d, FP)},${y(r.lo)}`); });
      lo.push(`${x(C.startDate, FA)},${y(C.startLevel)}`);
      g += `<polygon points="${up.concat(lo).join(' ')}" fill="#99D6EA" fill-opacity=".45"/>`;
    }
    // history line + dots
    const hp = [];
    hist.forEach((r) => { if (r.am !== null) hp.push([x(r.d, FA), y(r.am), r.d, 'AM', r.am]); if (r.pm !== null) hp.push([x(r.d, FP), y(r.pm), r.d, 'PM', r.pm]); });
    const liveCur = C.latest && C.latest.cur && C.latest.pm === null ? C.latest : null;
    if (liveCur) { const h = +liveCur.cur.h.split(':')[0] + +liveCur.cur.h.split(':')[1] / 60; hp.push([x(liveCur.d, Math.min(FP, Math.max(FA, FA + (h - 6.5) / 10.75 * (FP - FA)))), y(liveCur.cur.v), liveCur.d, 'NOW', liveCur.cur.v]); }
    if (hp.length) g += `<polyline points="${hp.map((p) => p[0] + ',' + p[1]).join(' ')}" fill="none" stroke="#000" stroke-width="2.2" stroke-linejoin="round"/>`;
    hp.forEach((p) => (g += `<circle cx="${p[0]}" cy="${p[1]}" r="2.8" fill="#fff" stroke="#000" stroke-width="1.6"/>`));
    // forecast line
    const fp = [];
    if (hp.length && C.latest && (C.latest.pm !== null || liveCur)) fp.push(hp[hp.length - 1].slice(0, 2));
    sim.rows.forEach((r, i) => { if (!(i === 0 && liveCur)) fp.push([x(r.d, FA), y(r.s)]); fp.push([x(r.d, FP), y(r.e)]); });
    if (fp.length) g += `<polyline points="${fp.map((p) => p[0] + ',' + p[1]).join(' ')}" fill="none" stroke="#7566A0" stroke-width="2.6" stroke-dasharray="7 5" stroke-linejoin="round"/>`;
    // deliveries received
    C.past.forEach((dv) => {
      const r = hist.find((h) => h.d === dv.d); if (!r) return;
      const v = r.am !== null ? r.am : r.pm, fr = r.am !== null ? FA : FP, cx = x(dv.d, fr), cy = y(v);
      g += `<path d="M${cx},${cy - 11} l7,12 h-14 z" fill="#47D7AC" stroke="#000" stroke-width="1.3"/>`;
    });
    // planned deliveries
    sim.planned.forEach((p) => {
      const cx = x(p.d, FA), cy = y(p.after);
      g += `<path d="M${cx},${cy - 9} l8,9 -8,9 -8,-9 z" fill="${p.ordered ? '#7566A0' : '#FDAA63'}" stroke="#000" stroke-width="1.5"/>`;
      const anchor = cx > W - 140 ? 'end' : 'start';
      g += `<text class="lbl" x="${cx + (anchor === 'end' ? -12 : 12)}" y="${cy - 12}" text-anchor="${anchor}">${p.ordered ? 'Ordered' : 'Deliver'} ${fmtD(p.d)}</text>`;
    });
    // today
    if (TODAY >= first && TODAY <= last) g += `<line x1="${x(TODAY, 0.5)}" x2="${x(TODAY, 0.5)}" y1="${T}" y2="${H - B}" stroke="#000" stroke-width="1"/><text class="lbl" x="${x(TODAY, 0.5) + 5}" y="${T + 9}">Today</text>`;
    // tooltips
    tips = {};
    hist.forEach((r) => { tips[r.d] = `<b>${fmtD(r.d)}</b><br>${r.cur && r.pm === null ? 'Now (' + r.cur.h + ') ' + fP(r.cur.v) + ' (' + fT(r.cur.v) + ')<br>' : ''}${r.am !== null ? 'Morning ' + fP(r.am) + ' (' + fT(r.am) + ')<br>' : ''}${r.pm !== null ? 'Evening ' + fP(r.pm) + ' (' + fT(r.pm) + ')' : ''}`; });
    C.past.forEach((dv) => { tips[dv.d] = (tips[dv.d] || '') + `<br><span style="color:#47D7AC">▲ Delivery received ≈ ${dv.t.toFixed(0)} t</span>`; });
    sim.rows.forEach((r) => { tips[r.d] = `<b>${fmtD(r.d)}</b> · forecast<br>Use ${fT(r.use)} (${fP(r.use)})<br>Start ${fP(r.s)} → end ${fP(r.e)} (${fT(r.e)})${r.add ? '<br><span style="color:#FDAA63">◆ Delivery +' + fT(r.add) + '</span>' : ''}<br><span style="opacity:.7">90% range at end ${fP(r.lo, 0)}–${fP(r.hi, 0)}</span>`; });
    const plotX = [x(first, 0), x(last, 1)];
    g += `<rect id="lvlHit" x="${plotX[0]}" y="${T}" width="${plotX[1] - plotX[0]}" height="${H - T - B}" fill="transparent"/>`;
    const svg = `<svg class="chart" id="lvlChart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Vessel level history and forecast" data-first="${first}" data-last="${last}" data-l="${L}" data-r="${R}" data-w="${W}">${g}</svg>`;
    return svg;
  }

  function renderForecast() {
    const set = S();
    const rowsHtml = C.sim.rows.map((r, i) => {
      const d = r.d, rec = C.days[i].rec, base = state.board[d] || [0, 0, 0, 0, 0], ov = state.overrides[d] || [];
      const cells = [0, 1, 2, 3, 4].map((k) => {
        const isOv = ov[k] !== null && ov[k] !== undefined && ov[k] !== base[k];
        return `<td class="r"><input type="number" class="plan${isOv ? ' ov' : ''}" min="0" step="${k === 3 ? 50 : 1}" value="${rec[k]}" data-d="${d}" data-k="${k}" aria-label="${M.FEATURES[k].label} on ${fmtD(d)}"></td>`;
      }).join('');
      const wk = [0, 6].includes(M.dow(d));
      const notes = [];
      if (i === 0 && C.frac0 < 1) notes.push('<span class="chip info"><i></i>Rest of today</span>');
      if (r.add) notes.push(`<span class="chip st-ok"><i></i>Delivery +${fT(r.add)}</span>`);
      if (r.e < set.floor && !r.add) notes.push('<span class="chip st-order"><i></i>Below floor</span>');
      if (!r.add && r.e < 0) notes.push('<span class="chip st-risk"><i></i>Empty</span>');
      return `<tr class="${r.add ? 'dlv' : wk ? 'wk' : ''}${r.e < set.floor && !r.add ? ' low' : ''}"><td class="sticky-col">${fmtD(d)}</td>${cells}<td class="r num"><b>${fT(r.use)}</b><small>${fP(r.use)}</small></td><td class="r num">${fP(r.s)} → <b>${fP(r.e)}</b><small>${fT(r.e)} left</small></td><td>${notes.join(' ')}</td></tr>`;
    }).join('');
    const nOv = Object.keys(state.overrides).filter((d) => (state.overrides[d] || []).some((v) => v !== null && v !== undefined)).length;
    return `<section class="sec" id="forecast">
      <div class="sec-head"><div><span class="eyebrow">Forecast</span><h2>Vessel level, day by day</h2>
        <p>Black line = readings, purple dashed = forecast with its 90% range (blue). Change any number in the table below to test a what-if; it recalculates straight away.</p></div></div>
      <div class="panel">
        <div class="chart-wrap" id="lvlWrap">${levelChart()}<div class="tip" id="tip"></div></div>
        <div class="legend"><span><i class="line"></i>Readings</span><span><i class="dash" style="border-top-color:#7566A0"></i>Forecast</span><span><i style="background:#99D6EA"></i>90% range</span><span><i style="background:#7566A0"></i>Ordered</span><span><i style="background:#FDAA63"></i>Suggested delivery</span><span><i style="background:#47D7AC"></i>Delivery received</span><span><i class="dash"></i>Reorder floor</span></div>
      </div>
      <div class="panel" style="margin-top:14px">
        <div class="pad" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:space-between"><div><b>Plan &amp; predicted use</b> <span class="muted" style="font-size:12px">· transfers counted per tank, cartons and kegs from the board</span></div>
          ${nOv ? `<button class="btn small" data-act="resetOv">Reset ${plural(nOv, 'changed day')}</button>` : ''}</div>
        <div class="tbl-wrap"><table><thead><tr><th>Date</th><th class="r">70HL</th><th class="r">300HL</th><th class="r">500HL</th><th class="r">Cartons</th><th class="r">Kegs</th><th class="r">Predicted use</th><th class="r">Level start → end</th><th></th></tr></thead><tbody>${rowsHtml}</tbody></table></div>
        <div class="note" style="padding-top:10px">Orange boxes are your what-if changes. Weekends are shaded. Level is shown as % of the ${set.cap} t vessel.</div>
      </div>
    </section>`;
  }

  /* ---------- drivers ---------- */
  function driversChart() {
    const W = 960, H = 330, L = 46, R = 20, T = 18, B = 38;
    const first = M.addDays(C.startDate, -28), last = C.end;
    const days = M.range(first, last), n = days.length, bw = (W - L - R) / n;
    const actual = {}; C.hist.forEach((o) => o.days.forEach((d) => (actual[d] = o.use / o.n)));
    const parts = (d) => {
      const rec = C.recFor(d), pd = M.predictDay(C.model, rec), p = pd.parts;
      return { base: p.base, tr: p.t70 + p.t300 + p.t500, ca: p.cartons, ke: p.kegs, total: pd.total };
    };
    let maxV = 12; days.forEach((d) => { maxV = Math.max(maxV, parts(d).total + 0.5, actual[d] || 0); });
    maxV = Math.ceil(maxV / 2) * 2;
    const y = (v) => T + (1 - v / maxV) * (H - T - B);
    let g = '';
    for (let v = 0; v <= maxV; v += 2) g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#E7E5DE"/><text class="ax" x="${L - 7}" y="${y(v) + 3.5}" text-anchor="end">${v}</text>`;
    g += `<text class="ax" x="${L - 7}" y="${T - 6}" text-anchor="end">% / day</text>`;
    const col = { base: '#99D6EA', tr: '#7566A0', ca: '#47D7AC', ke: '#FDAA63' };
    days.forEach((d, i) => {
      const x0 = L + i * bw + bw * 0.14, w = bw * 0.72, p = parts(d); let acc = 0;
      ['base', 'tr', 'ca', 'ke'].forEach((k) => { const h = (p[k] / maxV) * (H - T - B); g += `<rect x="${x0}" y="${y(acc + p[k])}" width="${w}" height="${h}" fill="${col[k]}"${[0, 6].includes(M.dow(d)) ? ' fill-opacity=".8"' : ''}/>`; acc += p[k]; });
      if (i % (n > 45 ? 7 : n > 24 ? 4 : 2) === 0) g += `<text class="ax" x="${x0 + w / 2}" y="${H - 16}" text-anchor="middle">${fmtS(d)}</text><text class="ax" x="${x0 + w / 2}" y="${H - 4}" text-anchor="middle">${DOW[M.dow(d)]}</text>`;
      if (actual[d] !== undefined) g += `<circle cx="${x0 + w / 2}" cy="${y(actual[d])}" r="4.2" fill="#000" stroke="#fff" stroke-width="1.5"/>`;
    });
    const ti = days.indexOf(TODAY);
    if (ti >= 0) g += `<line x1="${L + ti * bw + bw / 2}" x2="${L + ti * bw + bw / 2}" y1="${T}" y2="${H - B}" stroke="#000"/><text class="lbl" x="${L + ti * bw + bw / 2 + 5}" y="${T + 9}">Today</text>`;
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Predicted daily CO2 use by driver, with measured use">${g}</svg>`;
  }

  function renderDrivers() {
    const m = C.model, set = S(), unit = (k) => M.FEATURES[k];
    const effText = (k) => {
      const c = m.coef[k];
      if (!m.ok) return '';
      if (c < 0.02) return 'No measurable effect in the readings so far';
      const per = unit(k).unit;
      return `<b>+${c.toFixed(2)} pts</b> (${(c * set.cap / 100).toFixed(2)} t) ${per}`;
    };
    const drv = M.FEATURES.map((f, k) => {
      const r = m.ok ? m.corr[k] : 0;
      return `<div class="driver"><div class="nm">${f.label}<small>correlation with daily use</small></div>
        <div style="display:flex;gap:10px;align-items:center"><div class="rbar${r < 0 ? ' neg' : ''}" style="flex:1"><span style="width:${Math.min(100, Math.abs(r) * 100).toFixed(0)}%"></span></div><span class="num" style="font-size:12px;width:46px;text-align:right">r = ${r.toFixed(2)}</span></div>
        <div class="eff">${effText(k)}</div></div>`;
    }).join('');
    const strong = M.FEATURES.filter((f, k) => m.ok && m.corr[k] >= 0.25 && m.coef[k] > 0.02).map((f) => f.label.toLowerCase());
    const weak = M.FEATURES.filter((f, k) => m.ok && !(m.corr[k] >= 0.25 && m.coef[k] > 0.02)).map((f) => f.label.toLowerCase());
    const histRows = C.hist.slice().reverse().map((o) => {
      const d = o.use / o.n, p = o.pred / o.n, diff = d - p;
      return `<tr><td>${o.n > 1 ? fmtS(o.days[0]) + ' – ' + fmtS(o.d) : fmtD(o.d)}</td><td class="r num">${o.x.slice(0, 3).map((v) => v).join(' / ')}</td><td class="r num">${(o.x[3]).toFixed(1)}k</td><td class="r num">${Math.round(o.x[4] * 100)}</td><td class="r num">${d.toFixed(1)}</td><td class="r num">${p.toFixed(1)}</td><td class="r num" style="color:${Math.abs(diff) > 1.5 ? '#000' : 'var(--muted)'};font-weight:${Math.abs(diff) > 1.5 ? 700 : 400}">${diff > 0 ? '+' : ''}${diff.toFixed(1)}</td></tr>`;
    }).join('');
    return `<section class="sec" id="drivers">
      <div class="sec-head"><div><span class="eyebrow">The model</span><h2>What drives CO2 usage</h2>
        <p>Each day's measured draw (evening-to-evening) is matched to what the board shows for that day. The model learns how much each activity adds, on top of a base load.</p></div></div>
      <div class="drv">
        <div class="panel pad">
          <div style="margin-bottom:6px"><b>Daily use vs. board activity</b></div>
          ${drv}
          <div class="driver"><div class="nm">Base load<small>no transfers or packing</small></div><div class="eff" style="grid-column:2"><b>${m.base.toFixed(1)} pts/day</b> (${(m.base * set.cap / 100).toFixed(1)} t) — brite CIPs, tank purging, carbonation and anything else the board doesn't show</div></div>
        </div>
        <div class="panel">
          <div class="kpis" style="grid-template-columns:repeat(2,minmax(0,1fr))">
            <div class="kpi"><small>Fit (R²)</small><b>${m.ok ? m.r2.toFixed(2) : '–'}</b><p>Share of day-to-day swing explained by the board</p></div>
            <div class="kpi"><small>Typical miss</small><b>± ${m.ok ? m.sigma.toFixed(1) : '–'} pts</b><p>≈ ${m.ok ? (m.sigma * set.cap / 100).toFixed(1) : '–'} t a day, tested on days the model hadn't seen</p></div>
            <div class="kpi"><small>Days used</small><b>${m.n}</b><p>Observation periods with a clean reading at each end</p></div>
            <div class="kpi"><small>Average draw</small><b>${m.ok ? fT(m.perDayMean) : '–'}</b><p>${m.ok ? fP(m.perDayMean) + ' of the vessel per day' : ''}</p></div>
          </div>
          <div class="note" style="padding-top:0"><b>Reading this honestly:</b> ${strong.length ? strong.join(', ') + (strong.length > 1 ? ' are' : ' is') + ' the clearest signal' + (strong.length > 1 ? 's' : '') + '.' : 'No single driver stands out yet.'} ${weak.length ? weak.join(' and ') + ' show' + (weak.length > 1 ? '' : 's') + ' little effect so far — too small or too irregular to separate out.' : ''} Brite CIPs are not on the board, so they sit in the base load and are the main source of the ± above. A CO2 leak at the DAW Plant, likely running since at least February, was fixed on 30 Oct (size unknown, probably small). It has been in every reading used here, so it sits inside the base load; from 30 Oct actual use may run slightly under the prediction, and the base load will settle lower as new days come in. Fitted on ${m.n} periods since ${C.hist.length ? fmtS(C.hist[0].days[0]) : '–'}; a few odd days are down-weighted automatically and listed under Data checks.</div>
        </div>
      </div>
      <div class="panel" style="margin-top:14px">
        <div class="pad" style="padding-bottom:0"><b>Predicted daily use, by driver</b> <span class="muted" style="font-size:12px">· black dots are measured use</span></div>
        <div class="chart-wrap">${driversChart()}</div>
        <div class="legend"><span><i style="background:#99D6EA"></i>Base load</span><span><i style="background:#7566A0"></i>Transfers</span><span><i style="background:#47D7AC"></i>Packaging (cartons)</span><span><i style="background:#FDAA63"></i>Kegs</span><span><i class="dot"></i>Measured</span></div>
      </div>
      <details class="panel" style="margin-top:14px"><summary>Measured vs. predicted, day by day <small>${C.hist.length} periods</small></summary>
        <div class="tbl-wrap"><table><thead><tr><th>Date</th><th class="r">Transfers 70/300/500</th><th class="r">Cartons</th><th class="r">Kegs</th><th class="r">Measured pts/day</th><th class="r">Predicted</th><th class="r">Diff</th></tr></thead><tbody>${histRows}</tbody></table></div></details>
    </section>`;
  }


  /* ---------- invoices vs gauge ---------- */
  const RATE_RISE_OCT = 0.075;                       // Supagas notice: bulk liquids +7.5% from 1 Oct 2026
  function matchInvoices() {
    const set = S(), kgPt = set.cap * 10, rows = C.q.rows, R = {};
    rows.forEach((r) => (R[r.d] = r));
    const firstR = rows.length ? rows[0].d : null;
    const useSum = (a, b) => { let t = 0; for (let d = a; d <= b; d = M.addDays(d, 1)) t += M.predictDay(C.model, C.recFor(d)).total; return t; };
    const pmOnly = (d) => (R[d] && R[d].pm !== null ? R[d].pm : null);
    const endAny = (d) => (pmOnly(d) !== null ? pmOnly(d) : (R[M.addDays(d, 1)] && R[M.addDays(d, 1)].am !== null ? R[M.addDays(d, 1)].am : null));
    const list = state.invoices.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.docket < b.docket ? -1 : 1));
    const out = list.map((inv) => {
      const o = { ...inv, rate: inv.kg ? inv.ex / inv.kg : 0, pts: null, gaugeKg: null, diff: null, status: 'nodata', note: '', gdate: null, S: null };
      if (inv.kg < 1000) { o.status = 'tiny'; o.note = `Only ${inv.kg} kg — looks keyed in tonnes. Likely a duplicate of the real load on this date.`; return o; }
      if (!firstR || inv.date <= firstR) return o;
      for (const off of [0, -1, 1, -2, 2]) {
        const D = M.addDays(inv.date, off);
        let S0 = null, Sd = null;
        for (let k = 1; k <= 3 && S0 === null; k++) { const dd = M.addDays(D, -k); const v = pmOnly(dd) !== null ? pmOnly(dd) : (k > 1 && R[M.addDays(dd, 1)] && R[M.addDays(dd, 1)].am !== null ? R[M.addDays(dd, 1)].am : null); if (v !== null) { S0 = v; Sd = dd; } }
        if (S0 === null) continue;
        const r = R[D] || {};
        let pts, how, gap = M.diffDays(Sd, D) - 1;
        if (r.am !== null && r.am !== undefined && r.am > S0 + 3) { pts = r.am - S0 + (gap > 0 ? useSum(M.addDays(Sd, 1), M.addDays(D, -1)) : 0); how = 'morning'; }
        else {
          let Ed = D, E = endAny(D); if (E === null) { Ed = M.addDays(D, 1); E = endAny(Ed); }
          if (E === null) continue;
          pts = E - S0 + useSum(M.addDays(Sd, 1), Ed); how = 'evening'; gap += M.diffDays(D, Ed);
        }
        if (pts > 8) { o.pts = pts; o.S = S0; o.Sd = Sd; o.gdate = D; o.how = how; o.gap = gap; break; }
      }
      if (o.pts === null) { o.note = 'No clear rise on the gauge around this date (readings missing?).'; o.status = 'nogauge'; return o; }
      o.gaugeKg = o.pts * kgPt; o.diff = inv.kg - o.gaugeKg;
      const tol = Math.max(1500 + 600 * o.gap, 0.12 * inv.kg);
      const Seff = o.S - (M.diffDays(o.Sd, inv.date) > 1 ? useSum(M.addDays(o.Sd, 1), M.addDays(inv.date, -1)) : 0);   // level just before the truck
      if (Seff + inv.kg / kgPt > 105) { o.status = 'nofit'; o.note = `A ${(inv.kg / 1000).toFixed(1)} t load can't fit on top of the ≈${fP(Math.max(0, Seff))} the gauge implies just before it (${fmtS(o.Sd)} evening was ${fP(o.S)}). Check the readings around ${fmtS(inv.date)}.`; }
      else if (Math.abs(o.diff) <= tol) { o.status = 'ok'; }
      else if (o.diff > 0) { o.status = 'low'; o.note = `Invoiced ${(o.diff / 1000).toFixed(1)} t more than the gauge rose${o.gap > 0 ? ' (readings missing around it)' : ''}.`; }
      else { o.status = 'high'; o.note = `Gauge rose ${(-o.diff / 1000).toFixed(1)} t more than invoiced.`; }
      if (o.gdate !== inv.date) o.note = (o.note ? o.note + ' ' : '') + `Gauge shows it on ${fmtS(o.gdate)}.`;
      return o;
    });
    // gauge deliveries with no invoice
    const invDates = out.map((x) => x.date), lastInv = invDates.length ? invDates[invDates.length - 1] : '0000';
    const unmatched = C.past.filter((x) => x.pts > 8 && !invDates.some((d) => Math.abs(M.diffDays(d, x.d)) <= 2));
    const missing = unmatched.filter((x) => x.d <= lastInv), upcoming = unmatched.filter((x) => x.d > lastInv);
    // rate history
    const rates = []; out.forEach((x) => { if (x.kg >= 1000) { const r = +x.rate.toFixed(4), l = rates[rates.length - 1]; if (!l || l.rate !== r) rates.push({ date: x.date, rate: r }); } });
    const matched = out.filter((x) => x.gaugeKg !== null && x.status !== 'nofit');
    const ratios = matched.filter((x) => x.pts > 20).map((x) => x.kg / x.pts).sort((a, b) => a - b);
    const calib = ratios.length >= 3 ? ratios[Math.floor(ratios.length / 2)] : null;
    const lastRate = rates.length ? rates[rates.length - 1].rate : 0.75;
    return { out, missing, upcoming, rates, calib, lastRate, newRate: lastRate * (1 + RATE_RISE_OCT) };
  }

  const STATUS = {
    ok: ['st-ok', 'Matches gauge'], low: ['st-order', 'Invoiced more'], high: ['info', 'Gauge higher'], nofit: ['st-risk', "Doesn't fit"],
    tiny: ['st-risk', 'Odd line'], nogauge: ['st-watch', 'No gauge rise'], nodata: ['plain', 'Before readings']
  };
  const money = (v) => '$' + v.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function renderInvoices() {
    const I = C.inv, set = S(), kgPt = set.cap * 10;
    const rows = I.out;
    const real = rows.filter((x) => x.kg >= 1000);
    const totKg = real.reduce((s, x) => s + x.kg, 0), totEx = rows.reduce((s, x) => s + x.ex, 0);
    const flagged = rows.filter((x) => ['low', 'high', 'nofit', 'tiny', 'nogauge'].includes(x.status));
    const dup = rows.filter((x) => x.status === 'tiny');
    const part = real.filter((x) => x.kg < 12000);
    // months
    const mon = {}; rows.forEach((x) => { const k = x.date.slice(0, 7); (mon[k] = mon[k] || { n: 0, kg: 0, ex: 0 }); if (x.kg >= 1000) mon[k].n++; mon[k].kg += x.kg; mon[k].ex += x.ex; });
    const monRows = Object.keys(mon).sort().map((k) => { const m = mon[k], [y, mm] = k.split('-'); return `<tr><td class="sticky-col">${MON[+mm - 1]} ${y}</td><td class="r num">${m.n}</td><td class="r num">${(m.kg / 1000).toFixed(1)} t</td><td class="r num">${(m.kg / 1000 / (new Date(+y, +mm, 0).getDate()) * 1000 / 1000).toFixed(2)} t</td><td class="r num">${money(m.ex)}</td></tr>`; }).join('');
    const finds = [];
    dup.forEach((x) => finds.push(`<li><b>${fmtD(x.date)} — ${(x.kg).toFixed(2)} kg line (${money(x.ex * 1.1)} inc GST).</b> Docket ${esc(x.docket)} sits beside the real ${fmtD(x.date)} load (docket ${esc((rows.find((y) => y.date === x.date && y.kg >= 1000) || {}).docket || '–')}), whose docket number is one digit short — it looks like the same delivery entered twice, once in tonnes. Worth querying with Supagas for a credit.</li>`));
    rows.filter((x) => x.status === 'nofit').forEach((x) => finds.push(`<li><b>${fmtD(x.date)} — ${(x.kg / 1000).toFixed(1)} t invoiced.</b> ${esc(x.note)} Either the reading is off or the load size is.</li>`));
    rows.filter((x) => x.status === 'low' || x.status === 'high').forEach((x) => finds.push(`<li><b>${fmtD(x.date)} — ${(x.kg / 1000).toFixed(1)} t invoiced vs ≈${(x.gaugeKg / 1000).toFixed(1)} t on the gauge.</b> ${esc(x.note)}</li>`));
    rows.filter((x) => x.status === 'nogauge').forEach((x) => finds.push(`<li><b>${fmtD(x.date)} — ${(x.kg / 1000).toFixed(1)} t invoiced.</b> ${esc(x.note)}</li>`));
    I.missing.forEach((x) => finds.push(`<li><b>${fmtD(x.d)}</b> — the gauge rose about ${fT(x.pts)} but there is no invoice line within 2 days. Small top-up, or a reading error?</li>`));
    const ratesTxt = I.rates.length > 1 ? I.rates.map((r, i) => `${i ? '→ ' : ''}$${r.rate.toFixed(4)}/kg from ${fmtS(r.date)}`).join(' ') : '';
    const up = I.upcoming;
    const upKg = up.reduce((s, x) => s + x.pts * kgPt, 0);
    const calibTxt = I.calib ? `Across the matched loads, one gauge point works out to about <b>${I.calib.toFixed(0)} kg</b> invoiced (you've set ${kgPt}). ${Math.abs(I.calib - kgPt) / kgPt > 0.05 ? 'If that holds, the true vessel size is nearer ' + (I.calib / 10).toFixed(0) + ' t than ' + set.cap + ' t.' : 'That is in line with a ' + set.cap + ' t vessel.'}` : '';
    const body = rows.slice().reverse().map((x) => {
      const [cls, lbl] = STATUS[x.status];
      return `<tr class="${x.status === 'ok' || x.status === 'nodata' ? '' : 'wk'}"><td class="sticky-col">${fmtD(x.date)}</td><td>${esc(x.docket)}</td><td class="r num"><b>${x.kg >= 1000 ? (x.kg / 1000).toFixed(2) + ' t' : x.kg + ' kg'}</b></td><td class="r num">${money(x.ex)}</td><td class="r num">${x.kg ? '$' + x.rate.toFixed(4) : ''}</td><td class="r num">${x.gaugeKg === null ? '<span class="muted">–</span>' : (x.gaugeKg / 1000).toFixed(1) + ' t'}</td><td class="r num">${x.diff === null ? '' : (x.diff > 0 ? '+' : '') + (x.diff / 1000).toFixed(1) + ' t'}</td><td><span class="chip ${cls}"><i></i>${lbl}</span>${x.note ? `<small>${esc(x.note)}</small>` : ''}</td><td class="r"><button class="btn small x" data-act="delInvoice" data-key="${esc(x.date + '|' + x.docket)}" aria-label="Delete line">×</button></td></tr>`;
    }).join('');
    return `<section class="sec" id="invoices">
      <div class="sec-head"><div><span class="eyebrow">Supagas statements</span><h2>Bulk CO2 invoiced vs. recorded</h2>
        <p>Every “CO2 GAS BULK” line from the monthly statements, set against how far the vessel gauge rose that day (plus the use predicted for it). The gauge figure is an estimate — treat gaps of a couple of tonnes as noise and look at the big ones.</p></div>
        <div class="row"><button class="btn small" data-act="csv">Download CSV</button></div></div>
      <div class="panel"><div class="kpis" style="grid-template-columns:repeat(4,minmax(0,1fr))">
        <div class="kpi"><small>Delivered, Jan–Sep</small><b>${(totKg / 1000).toFixed(0)} t</b><p>${real.length} loads on the statements</p></div>
        <div class="kpi"><small>Billed (ex GST)</small><b>${money(totEx)}</b><p>bulk CO2 gas only, excl. tank rental</p></div>
        <div class="kpi"><small>Price per kg</small><b>$${I.lastRate.toFixed(4)}</b><p>${esc(ratesTxt)}${ratesTxt ? '. ' : ''}From 1 Oct: +7.5% ≈ $${I.newRate.toFixed(4)}</p></div>
        <div class="kpi"><small>Lines to query</small><b>${flagged.length + I.missing.length}</b><p>${part.length} part loads under 12 t are normal top-ups</p></div>
      </div>
      ${finds.length ? `<div class="banner bad" style="margin:0 18px 14px;display:block"><b>Differences worth checking</b><ul class="plain" style="margin-top:6px">${finds.join('')}</ul></div>` : ''}
      ${up.length ? `<div class="note" style="padding-top:0"><b>Expected on the October statement:</b> ${up.map((x) => fmtS(x.d)).join(', ')} — about ${(upKg / 1000).toFixed(0)} t by the gauge, roughly ${money(upKg * I.newRate)} ex GST at the new rate. Compare when it arrives.</div>` : ''}
      ${calibTxt ? `<div class="note" style="padding-top:0">${calibTxt}</div>` : ''}
      </div>
      <div class="drv" style="margin-top:14px;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr)">
        <div class="panel"><div class="tbl-wrap" style="max-height:520px;overflow:auto"><table><thead><tr><th>Invoice date</th><th>Docket</th><th class="r">Invoiced</th><th class="r">$ ex GST</th><th class="r">$/kg</th><th class="r">Gauge est.</th><th class="r">Diff</th><th>Check</th><th></th></tr></thead><tbody>${body}</tbody></table></div></div>
        <div class="panel"><div class="pad" style="padding-bottom:4px"><b>By month</b></div><div class="tbl-wrap"><table><thead><tr><th>Month</th><th class="r">Loads</th><th class="r">Delivered</th><th class="r">t / day</th><th class="r">$ ex GST</th></tr></thead><tbody>${monRows}</tbody></table></div></div>
      </div>
      <details class="panel" style="margin-top:14px"><summary>Add an invoice line <small>from next month's statement</small></summary><div class="pad"><div class="form-row">
        <label class="fld"><span>Date</span><input type="date" id="ivDate"></label>
        <label class="fld"><span>Docket</span><input type="text" id="ivDocket" placeholder="e.g. 1913290"></label>
        <label class="fld"><span>Quantity (kg)</span><input type="number" id="ivKg" step="1" min="0"></label>
        <label class="fld"><span>Line total ex GST ($)</span><input type="number" id="ivEx" step="0.01" min="0" placeholder="blank = qty × latest rate"></label>
        <button class="btn teal" data-act="addInvoice">Add line</button></div></div></details>
    </section>`;
  }

  /* ---------- readings ---------- */
  function renderReadings() {
    const set = S();
    const rows = state.readings.slice().sort((a, b) => (a.d < b.d ? 1 : -1));
    const dl = {}; C.past.forEach((x) => (dl[x.d] = x));
    // actual (evening-to-evening) vs what the board-based model predicts for that day; multi-day gaps show the per-day average
    const av = {}; C.hist.forEach((o) => o.days.forEach((d) => { if (o.pred !== null) av[d] = { a: o.use / o.n, p: o.pred / o.n, n: o.n }; }));
    const body = rows.map((r) => {
      const dv = dl[r.d], u = av[r.d], evs = state.events.filter((x) => x.d === r.d);
      const useCells = u ? (() => { const df = u.a - u.p, big = Math.abs(df) > 1.5; return `<td class="r num">${fT(u.a)}<small>${fP(u.a)}${u.n > 1 ? ' · avg of ' + u.n + ' days' : ''}</small></td><td class="r num">${fT(u.p)}<small>${fP(u.p)}</small></td><td class="r num" style="color:${big ? '#000' : 'var(--muted)'};font-weight:${big ? 700 : 400}">${df > 0 ? '+' : '−'}${fT(Math.abs(df))}<small>${df > 0 ? 'more than predicted' : 'less than predicted'}</small></td>`; })() : '<td class="r muted">–</td><td class="r muted">–</td><td class="r muted">–</td>';
      return `<tr><td class="sticky-col">${fmtD(r.d)}</td>
        <td class="r"><input type="number" class="rd" step="0.1" min="0" max="100" value="${r.am === null ? '' : r.am}" data-d="${r.d}" data-f="am" aria-label="Morning level ${r.d}"></td>
        <td class="r"><input type="number" class="rd" step="0.1" min="0" max="100" value="${r.pm === null ? '' : r.pm}" data-d="${r.d}" data-f="pm" aria-label="Evening level ${r.d}"></td>
        ${useCells}
        <td>${evs.map((x) => `<span class="chip st-watch" title="${esc(x.text)}"><i></i>${esc(x.text.length > 34 ? x.text.slice(0, 32) + '…' : x.text)}</span> `).join('')}${r.cur ? `<span class="chip info"><i></i>Now ${r.cur.v}% at ${r.cur.h}</span> ` : ''}${dv ? `<span class="chip ${dv.short ? 'st-order' : 'st-ok'}"><i></i>Delivery ≈ ${dv.t.toFixed(0)} t${dv.short ? ' — short load?' : ''}</span>` : ''}</td>
        <td class="r"><button class="btn small x" data-act="delReading" data-d="${r.d}" aria-label="Delete reading ${r.d}">×</button></td></tr>`;
    }).join('');
    const outNotes = C.model.outliers.map((o) => `<li><b>${o.days.length > 1 ? fmtS(o.days[0]) + '–' + fmtS(o.d) : fmtS(o.d)}:</b> measured ${o.use.toFixed(1)} pts/day but the board predicts ${o.pred.toFixed(1)} — worth checking that day's readings or whether the plan changed.</li>`).join('');
    const notes = outNotes + C.q.notes.map((n) => `<li><b>${fmtS(n.d)}:</b> ${esc(n.text)}</li>`).join('');
    const pastNotes = C.past.filter((x) => x.short).map((x) => `<li><b>${fmtS(x.d)}:</b> the level rose about ${fT(x.pts)} (${fP(x.before, 0)} → ${fP(x.before + x.pts, 0)}), well short of a ${set.load} t load that fits — was this a short delivery?</li>`).join('');
    const boardMsg = C.lastBoard ? `Board loaded to <b>${fmtD(C.lastBoard)}</b>; transfers planned to <b>${C.boardEnd ? fmtD(C.boardEnd) : 'none'}</b>.` : 'No board loaded.';
    return `<section class="sec" id="readings">
      <div class="sec-head"><div><span class="eyebrow">Data</span><h2>Daily readings</h2>
        <p>Enter the vessel level (% on the gauge) from the morning and evening handover. Use “Right now” for a mid-day check — the forecast then only counts the rest of today's use. A jump up is picked up automatically as a delivery. Actual use is measured evening-to-evening; predicted use is what the Live Brewery Board says that day should have drawn.</p></div>
        <div class="row"><button class="btn small" data-act="pickCo2">Import CO2 handover sheet</button><button class="btn small" data-act="pickLbb">Import Live Brewery Board</button></div></div>
      <div class="panel pad">
        <div class="form-row">
          <label class="fld"><span>Date</span><input type="date" id="rdDate" value="${TODAY}"></label>
          <label class="fld"><span>Morning %</span><input type="number" id="rdAm" step="0.1" min="0" max="100" placeholder="e.g. 64.5"></label>
          <label class="fld"><span>Evening %</span><input type="number" id="rdPm" step="0.1" min="0" max="100" placeholder="e.g. 59.5"></label>
          <label class="fld"><span>Right now %</span><input type="number" id="rdNow" step="0.1" min="0" max="100" placeholder="mid-day level"></label>
          <label class="fld"><span>Time</span><input type="time" id="rdTime" value="${nowHM()}"></label>
          <button class="btn teal" data-act="saveReading">Save reading</button>
        </div>
        <p class="muted" style="font-size:12px;margin-top:10px">${boardMsg} Upload a fresh board export whenever the plan changes.</p>
      </div>
      <div class="panel pad" style="margin-top:14px" id="events">
        <b>Site notes</b> <span class="muted" style="font-size:12px">· things that change CO2 use but are not on the board (leaks, equipment fixes). Shown against the day in the table below.</span>
        <ul class="plain" style="margin:8px 0">${state.events.slice().sort((a, b) => (a.d < b.d ? 1 : -1)).map((x) => `<li><b>${fmtD(x.d)}:</b> ${esc(x.text)} <button class="btn small x" data-act="delEvent" data-id="${esc(x.id)}" aria-label="Delete note">×</button></li>`).join('') || '<li class="muted">None yet.</li>'}</ul>
        <div class="form-row"><label class="fld"><span>Date</span><input type="date" id="evDate" value="${TODAY}"></label>
          <label class="fld" style="flex:1;min-width:200px"><span>Note</span><input type="text" id="evText" placeholder="e.g. Leak fixed at DAW Plant"></label>
          <button class="btn" data-act="addEvent">Add note</button></div>
      </div>
      ${notes || pastNotes ? `<div class="banner" style="margin:14px 0 0;display:block"><b>Data checks</b><ul class="plain" style="margin-top:4px">${pastNotes}${notes}</ul></div>` : ''}
      <div class="panel" style="margin-top:14px"><div class="tbl-wrap" style="max-height:420px;overflow:auto"><table><thead><tr><th>Date</th><th class="r">Morning %</th><th class="r">Evening %</th><th class="r">Actual use</th><th class="r">Predicted use</th><th class="r">Difference</th><th>Detected</th><th></th></tr></thead><tbody>${body || '<tr><td colspan="8" class="muted">No readings yet.</td></tr>'}</tbody></table></div></div>
    </section>`;
  }

  function renderSettings() {
    const s = S();
    const f = (k, label, hint, step, min, max) => `<label class="fld"><span>${label}</span><input type="number" class="set" data-k="${k}" value="${s[k]}" step="${step}" min="${min}" max="${max}"><small>${hint}</small></label>`;
    const dows = [1, 2, 3, 4, 5, 6, 0].map((d) => `<label><input type="checkbox" class="dow" value="${d}"${s.dows.includes(d) ? ' checked' : ''}>${DOW[d]}</label>`).join('');
    return `<section class="sec" id="settings">
      <div class="sec-head"><div><span class="eyebrow">Settings</span><h2>Vessel &amp; ordering rules</h2></div></div>
      <div class="panel">
        <div class="settings">
          ${f('cap', 'Vessel capacity (t)', 'Gauge % × this = tonnes', 1, 1, 200)}
          ${f('load', 'Delivery load (t)', 'Standard tanker load', 1, 1, 100)}
          ${f('maxFill', 'Max fill (%)', 'Level a delivery can fill to', 1, 50, 100)}
          ${f('floor', 'Reorder floor (%)', 'Never plan to go below this', 1, 0, 60)}
          ${f('lead', 'Order notice (days)', 'How far ahead you need to order', 1, 0, 14)}
          <div class="fld"><span>Delivery days accepted</span><div class="dows">${dows}</div><small>Deliveries are only placed on ticked days</small></div>
        </div>
        <div class="pad" style="border-top:1px solid var(--line)"><div class="row">
          <button class="btn small" data-act="export">Export data</button>
          <button class="btn small" data-act="import">Import data</button>
          <button class="btn small" data-act="defaults">Reset settings</button>
          <span class="muted" style="font-size:12px">Readings, board uploads and plan changes are shared with everyone who signs in. Export to keep a backup.</span></div></div>
      </div>
    </section>`;
  }

  /* ---------- render ---------- */
  function render() {
    const y = window.scrollY;
    compute();
    $('#app').innerHTML = renderHero() + renderForecast() + renderDrivers() + renderInvoices() + renderReadings() + renderSettings();
    window.scrollTo(0, y);
    bindChart();
  }

  function bindChart() {
    const svg = $('#lvlChart'), tip = $('#tip'), wrap = $('#lvlWrap');
    if (!svg) return;
    const first = svg.dataset.first, last = svg.dataset.last, L = +svg.dataset.l, R = +svg.dataset.r, W = +svg.dataset.w;
    const n = M.diffDays(first, last) + 1;
    svg.addEventListener('pointermove', (e) => {
      const b = svg.getBoundingClientRect(), px = (e.clientX - b.left) / b.width * W;
      const i = Math.floor((px - L) / (W - L - R) * n);
      const d = M.addDays(first, Math.max(0, Math.min(n - 1, i)));
      if (!tips[d]) { tip.classList.remove('show'); return; }
      tip.innerHTML = tips[d];
      const wb = wrap.getBoundingClientRect();
      tip.style.left = Math.max(80, Math.min(wb.width - 80, e.clientX - wb.left)) + 'px';
      tip.style.top = (e.clientY - wb.top - 12) + 'px';
      tip.classList.add('show');
    });
    svg.addEventListener('pointerleave', () => tip.classList.remove('show'));
  }

  /* ---------- actions ---------- */
  const toastEl = $('#toast'); let toastT;
  function toast(msg) { toastEl.textContent = msg; toastEl.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('show'), 3600); }
  const num = (v) => { if (v === '' || v === null || v === undefined) return null; const n = parseFloat(v); return isFinite(n) ? n : null; };

  const nowHM = () => { const n = new Date(); return String(n.getHours()).padStart(2, '0') + ':' + String(n.getMinutes()).padStart(2, '0'); };
  function setReading(d, field, val) {
    let r = state.readings.find((x) => x.d === d);
    if (!r) { r = { d, am: null, pm: null }; state.readings.push(r); }
    if (field === 'cur') { if (val) r.cur = val; else delete r.cur; } else r[field] = val;
    if (r.am === null && r.pm === null && !r.cur) state.readings = state.readings.filter((x) => x !== r);
    state.readings.sort((a, b) => (a.d < b.d ? -1 : 1));
  }

  function summaryText() {
    const ns = nextStatus(), p = ns.p, sim = C.sim;
    const lines = ['CO2 delivery request — Balter Brewing'];
    if (p) {
      lines.push(`Deliver: ${fmtD(p.d)} — 1 × ${fT(p.add, 0)} load${p.partial ? ' (part load fits)' : ''}`);
      lines.push(`Order by: ${fmtD(p.orderBy)}`);
      lines.push(`Expected level on arrival: ${fP(p.before)} (${fT(p.before)})`);
    } else lines.push(`No delivery needed before ${fmtD(C.end)}.`);
    lines.push(`Latest reading: ${fP(C.startLevel)} (${fT(C.startLevel)}), ${C.lastLabel}`);
    if (sim.floorDate) lines.push(`Reaches ${S().floor}% floor: ${fmtD(sim.floorDate)}`);
    if (sim.planned.length > 1) lines.push('Following loads: ' + sim.planned.slice(1).map((x) => fmtD(x.d)).join(', '));
    return lines.join('\n');
  }


  /* ---------- email version (inline-styled, table layout so it survives Outlook / Gmail paste) ---------- */
  function emailHTML() {
    const ns = nextStatus(), p = ns.p, sim = C.sim, set = S();
    const F = "font-family:Lexend,'Segoe UI',Arial,Helvetica,sans-serif;";
    const INK = '#000', MUTE = '#5b5b66', LINE = '#E6E3EE';
    const eyebrow = (t, c) => `<div style="${F}font-size:11px;letter-spacing:1.2px;text-transform:uppercase;font-weight:600;color:${c || '#7566A0'};margin:0 0 4px">${t}</div>`;
    const stCol = { ok: ['#E8FAF4', '#47D7AC'], watch: ['#FFF8D6', '#FFD637'], order: ['#FFF1E4', '#FDAA63'], risk: ['#FFF1E4', '#FDAA63'] }[ns.st] || ['#E8FAF4', '#47D7AC'];
    const kpi = (label, val, sub, col) => `<td width="25%" valign="top" style="padding:0 4px"><table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${LINE};border-top:4px solid ${col};border-radius:10px"><tr><td style="padding:10px 12px;${F}"><div style="font-size:10.5px;letter-spacing:1px;text-transform:uppercase;font-weight:600;color:${MUTE}">${label}</div><div style="font-size:20px;font-weight:700;color:${INK};padding-top:2px">${val}</div><div style="font-size:11.5px;color:${MUTE};padding-top:2px">${sub}</div></td></tr></table></td>`;
    const next7 = sim.rows.slice(0, 7), avg7 = next7.length ? next7.reduce((a, r) => a + r.use, 0) / next7.length : 0;
    const err = Math.max(0.6, C.model.sigma || C.model.loo || C.model.rmse);

    // next delivery card
    let card;
    if (p) {
      const li = (k, v) => `<tr><td valign="top" style="padding:3px 14px 3px 0;${F}font-size:13px;font-weight:600;color:${INK};white-space:nowrap">${k}</td><td style="padding:3px 0;${F}font-size:13px;color:${INK}">${v}</td></tr>`;
      const ordered = p.ordered ? li('Order', `Placed ${p.order.placed ? fmtD(p.order.placed) : ''} — truck ${p.order.when === 'night' ? 'overnight, landing early ' + fmtD(M.addDays(p.order.date, 1)) : 'early morning'} (${(+p.order.t).toFixed(0)} t)`) : li('Order by', `${fmtD(p.orderBy)} (${plural(set.lead, 'day')} notice)`);
      card = `${eyebrow(p.ordered ? 'Next delivery · ordered' : 'Next delivery')}
        <div style="${F}font-size:30px;font-weight:700;color:${INK};line-height:1.15">${fmtD(p.d)}</div>
        <div style="${F}font-size:12.5px;color:${MUTE};padding:2px 0 10px">${rel(p.d)}${p.ordered ? '' : ' · early-morning truck'}</div>
        <table cellpadding="0" cellspacing="0" border="0">${ordered}${li('Load', `${fT(p.add)} ${p.partial ? '— only part of this load fits' : p.ordered ? '— all of it fits' : '— a full load fits'}`)}${li('Level on arrival', `${fP(p.before)} (${fT(p.before)}) → ${fP(p.after)}`)}${li('Hits ' + set.floor + '% floor', sim.floorDate ? fmtD(sim.floorDate) : 'not in window')}${li('Runs dry if none', sim.emptyDate ? fmtD(sim.emptyDate) : 'not in window')}</table>
        <div style="${F}font-size:13px;font-weight:600;color:${INK};padding-top:10px">${esc(ns.text)}</div>`;
    } else card = `${eyebrow('Next delivery')}<div style="${F}font-size:26px;font-weight:700;color:${INK}">None needed</div><div style="${F}font-size:13px;color:${MUTE};padding-top:4px">The vessel stays above the ${set.floor}% floor to ${fmtD(C.end)}.</div>`;

    // forecast level chart — bars built from table cells
    const days = sim.rows.slice(0, 21), H = 120;
    const cols = days.map((r) => {
      const e = Math.max(0, Math.min(100, r.e)), h = Math.round(e / 100 * H), col = r.add ? '#FDAA63' : r.e < set.floor ? '#F5A08A' : '#FFD637';
      const dd = +r.d.slice(8);
      return `<td valign="bottom" align="center" style="padding:0 1px"><table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td height="${H - h}" style="font-size:1px;line-height:1px;height:${H - h}px">&nbsp;</td></tr><tr><td height="${h}" bgcolor="${col}" style="font-size:1px;line-height:1px;height:${h}px;background:${col};border-radius:3px 3px 0 0">&nbsp;</td></tr></table></td>`;
    }).join('');
    const pct = days.map((r) => `<td align="center" style="${F}font-size:9.5px;color:${INK};padding-top:3px;font-weight:600">${Math.round(r.e)}</td>`).join('');
    const lab = days.map((r) => `<td align="center" style="${F}font-size:9px;color:${MUTE};padding-top:1px;line-height:1.25">${DOW[M.dow(r.d)].charAt(0)}<br>${+r.d.slice(8)}${r.add ? '<br><span style="color:#E0782A;font-weight:700">▲</span>' : ''}</td>`).join('');
    const chart = days.length ? `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed"><tr>${cols}</tr><tr>${pct}</tr><tr>${lab}</tr></table>
      <div style="${F}font-size:11px;color:${MUTE};padding-top:8px">End-of-day vessel level (%), forecast. <span style="color:#E0782A;font-weight:700">▲</span> = delivery day (orange bar). Bars turn pink below the ${set.floor}% floor.</div>` : '';

    // schedule
    const th = (t, r) => `<th align="${r ? 'right' : 'left'}" style="${F}font-size:10.5px;letter-spacing:.8px;text-transform:uppercase;color:${MUTE};padding:6px 8px;border-bottom:2px solid ${LINE}">${t}</th>`;
    const td = (t, r, b) => `<td align="${r ? 'right' : 'left'}" style="${F}font-size:12.5px;color:${INK};padding:7px 8px;border-bottom:1px solid ${LINE};${b ? 'font-weight:600;' : ''}">${t}</td>`;
    const chipFor = (x) => { const left = M.diffDays(TODAY, x.orderBy); return x.ordered ? 'Ordered' + (x.before < set.floor ? ' · low on arrival' : '') : x.tooLate ? 'Needed before your order lands' : left < 0 ? 'Overdue' : left === 0 ? 'Order today' : left <= 2 ? 'Order soon' : 'On track'; };
    const sched = sim.planned.length ? `<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${th('#')}${th('Deliver on')}${th('Order by')}${th('Level before', 1)}${th('Level after', 1)}${th('Load', 1)}${th('Status')}</tr>${sim.planned.map((x, i) => `<tr>${td(i + 1)}${td(fmtD(x.d), 0, 1)}${td(x.ordered ? 'Placed' + (x.order.placed ? ' ' + fmtS(x.order.placed) : '') : fmtD(x.orderBy))}${td(fP(x.before) + ' <span style="color:' + MUTE + '">(' + fT(x.before) + ')</span>', 1)}${td(fP(x.after), 1)}${td(fT(x.add) + (x.partial ? ' part' : ''), 1)}${td(chipFor(x))}</tr>`).join('')}</table>` : `<div style="${F}font-size:13px;color:${MUTE}">No deliveries needed before ${fmtD(C.end)}.</div>`;

    // what's planned
    const use = sim.rows.slice(0, 10), tr = (r) => { const b = state.board[r.d] || [0, 0, 0, 0, 0]; const ov = state.overrides[r.d] || []; const v = (k) => (ov[k] !== null && ov[k] !== undefined ? ov[k] : b[k]); return [v(0), v(1), v(2), v(3), v(4)]; };
    const useTbl = `<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${th('Day')}${th('70HL', 1)}${th('300HL', 1)}${th('500HL', 1)}${th('Cartons', 1)}${th('Kegs', 1)}${th('Forecast use', 1)}${th('End level', 1)}</tr>${use.map((r) => { const q = tr(r); return `<tr>${td(fmtD(r.d), 0, 1)}${td(q[0] || '–', 1)}${td(q[1] || '–', 1)}${td(q[2] || '–', 1)}${td(q[3] ? q[3].toLocaleString('en-AU') : '–', 1)}${td(q[4] || '–', 1)}${td(fT(r.use) + ' <span style="color:' + MUTE + '">(' + fP(r.use) + ')</span>', 1)}${td(fP(r.e, 0) + (r.add ? ' <span style="color:#E0782A;font-weight:700">▲</span>' : ''), 1)}</tr>`; }).join('')}</table>`;

    const box = (inner, extra) => `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${LINE};border-radius:12px;margin-top:14px"><tr><td style="padding:14px 16px;${extra || ''}">${inner}</td></tr></table>`;
    const stamp = new Date().toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    return `<div style="max-width:760px;margin:0;background:#ffffff;${F}color:${INK}">
      <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td height="5" bgcolor="#47D7AC" width="25%" style="height:5px;font-size:1px;line-height:1px">&nbsp;</td><td bgcolor="#FDAA63" width="25%" style="font-size:1px;line-height:1px">&nbsp;</td><td bgcolor="#7566A0" width="25%" style="font-size:1px;line-height:1px">&nbsp;</td><td bgcolor="#99D6EA" width="25%" style="font-size:1px;line-height:1px">&nbsp;</td></tr></table>
      <table cellpadding="0" cellspacing="0" border="0" style="margin:14px 0 4px"><tr><td style="padding-right:12px"><table cellpadding="0" cellspacing="0" border="0"><tr><td width="40" height="40" align="center" bgcolor="#47D7AC" style="width:40px;height:40px;border-radius:8px;${F}font-size:22px;font-weight:700;color:#fff">B</td></tr></table></td><td>${eyebrow('Balter Brewing · Supply Planning')}<div style="${F}font-size:20px;font-weight:700;color:${INK}">CO2 Delivery Plan</div></td></tr></table>
      <div style="${F}font-size:12px;color:${MUTE};padding-bottom:10px">Prepared ${stamp} · ${esc(C.lastLabel)} · 30 t vessel, 20 t loads</div>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${stCol[1]};border-left:6px solid ${stCol[1]};border-radius:12px;background:${stCol[0]}" bgcolor="${stCol[0]}"><tr><td style="padding:16px 18px">${card}</td></tr></table>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:14px -4px 0"><tr>${kpi('Vessel now', fT(C.startLevel) + ' <span style="font-size:12px;color:' + MUTE + ';font-weight:600">' + fP(C.startLevel) + '</span>', esc(C.lastLabel), '#FFD637')}${kpi('Forecast use / day', fT(avg7), 'Next 7 planned days', '#47D7AC')}${kpi('Actual use / day', C.act7 === null ? '–' : fT(C.act7), 'Last week measured', '#7566A0')}${kpi('Typical miss', '± ' + fT(err), 'per day', '#99D6EA')}</tr></table>
      ${days.length ? box(eyebrow('Forecast') + `<div style="${F}font-size:15px;font-weight:700;padding-bottom:10px">Vessel level, day by day</div>` + chart) : ''}
      ${box(`<div style="${F}font-size:15px;font-weight:700;padding-bottom:6px">Delivery schedule to ${fmtD(C.end)}</div>` + sched + `<div style="${F}font-size:11px;color:${MUTE};padding-top:8px">Assumes each load lands early on the day shown, before that day's use, and the Live Brewery Board plan is followed.</div>`)}
      ${box(`<div style="${F}font-size:15px;font-weight:700;padding-bottom:6px">What's planned — next ${use.length} days</div>` + useTbl)}
      <div style="${F}font-size:11px;color:${MUTE};padding-top:12px;line-height:1.5">Forecast built from transfers (70/300/500 HL), packaging cartons and kegs on the Live Brewery Board, fitted to handover gauge readings. Brite CIPs are not tracked separately, so allow about ± ${fT(err)} per day.</div>
    </div>`;
  }

  function emailSubject() {
    const p = C.sim.planned[0];
    return p ? `CO2 delivery plan — ${p.ordered ? 'ordered ' : 'next load '}${fmtD(p.d)}` : 'CO2 delivery plan — no delivery needed';
  }

  async function copyRich(html, text) {
    try {
      if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
        await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
        return true;
      }
    } catch (_) { /* fall through to selection copy */ }
    const host = $('#emailBody'); if (!host) return false;
    const r = document.createRange(); r.selectNodeContents(host);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    let ok = false; try { ok = document.execCommand('copy'); } catch (_) { /* ignore */ }
    sel.removeAllRanges(); return ok;
  }

  function openEmail() {
    const html = emailHTML(), subj = emailSubject();
    let m = $('#emailModal'); if (m) m.remove();
    m = document.createElement('div'); m.id = 'emailModal'; m.className = 'modal';
    m.innerHTML = `<div class="modal-card" role="dialog" aria-label="Email version">
      <div class="modal-head"><div><span class="eyebrow">Email version</span><b>Preview — pastes into Outlook, Gmail or Teams</b></div>
        <div class="modal-actions"><button class="btn small" id="emSubj">Copy subject</button><button class="btn teal" id="emCopy">Copy email</button><button class="btn" id="emClose">Close</button></div></div>
      <div class="modal-subj"><span class="muted">Suggested subject:</span> ${esc(subj)}</div>
      <div class="modal-body"><div id="emailBody">${html}</div></div></div>`;
    document.body.appendChild(m);
    const doCopy = async () => { const ok = await copyRich(html, summaryText()); toast(ok ? 'Email copied — paste it into your message' : 'Copy blocked by the browser — select the preview and copy it'); };
    $('#emCopy').onclick = doCopy;
    $('#emSubj').onclick = async () => { try { await navigator.clipboard.writeText(subj); toast('Subject copied'); } catch (_) { toast(subj); } };
    const close = () => { m.remove(); document.removeEventListener('keydown', esc2); };
    const esc2 = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', esc2);
    $('#emClose').onclick = close; m.addEventListener('click', (e) => { if (e.target === m) close(); });
    doCopy();
  }

  async function readXlsx(file) {
    if (!window.XLSX) throw new Error('Spreadsheet reader did not load');
    return window.XLSX.read(await file.arrayBuffer(), { type: 'array' });
  }

  const app = $('#app');
  app.addEventListener('change', (e) => {
    const t = e.target;
    if (t.classList.contains('plan')) {
      const d = t.dataset.d, k = +t.dataset.k, v = num(t.value), base = (state.board[d] || [0, 0, 0, 0, 0])[k];
      const ov = state.overrides[d] || [null, null, null, null, null];
      ov[k] = v === null || v === base ? null : Math.max(0, v);
      if (ov.every((x) => x === null)) delete state.overrides[d]; else state.overrides[d] = ov;
      save(); render();
    } else if (t.classList.contains('rd')) {
      setReading(t.dataset.d, t.dataset.f, num(t.value)); save(); render();
    } else if (t.classList.contains('set')) {
      const v = num(t.value); if (v !== null) { state.settings[t.dataset.k] = v; save(); render(); }
    } else if (t.classList.contains('dow')) {
      state.settings.dows = [...app.querySelectorAll('.dow:checked')].map((c) => +c.value);
      if (!state.settings.dows.length) { state.settings.dows = [1, 2, 3, 4, 5]; toast('At least one delivery day is needed'); }
      save(); render();
    }
  });

  app.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.closest('#quick')) { e.preventDefault(); app.querySelector('[data-act=quickSave]').click(); } });
  app.addEventListener('input', (e) => { if (e.target.id === 'qDate') quickDateTouched = true; });
  app.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const a = b.dataset.act;
    if (a === 'saveReading') {
      const d = $('#rdDate').value, am = num($('#rdAm').value), pm = num($('#rdPm').value);
      if (!d) return toast('Pick a date');
      const now = num($('#rdNow').value), tm = $('#rdTime').value || nowHM();
      if (am === null && pm === null && now === null) return toast('Enter a morning, evening or right-now level');
      if ([am, pm, now].some((v) => v !== null && (v < 0 || v > 100))) return toast('Levels are a percentage between 0 and 100');
      if (now !== null) setReading(d, 'cur', { v: now, h: tm });
      if (am !== null) setReading(d, 'am', am);
      if (pm !== null) setReading(d, 'pm', pm);
      save(); render(); toast(`Saved ${fmtD(d)}`);
    } else if (a === 'delReading') { state.readings = state.readings.filter((r) => r.d !== b.dataset.d); save(); render(); }
    else if (a === 'delInvoice') { state.invoices = state.invoices.filter((x) => x.date + '|' + x.docket !== b.dataset.key); save(); render(); }
    else if (a === 'addInvoice') {
      const d = $('#ivDate').value, dk = $('#ivDocket').value.trim() || 'manual', kg = num($('#ivKg').value); let ex = num($('#ivEx').value);
      if (!d || !kg) return toast('Enter a date and a quantity in kg');
      if (ex === null) ex = Math.round(kg * C.inv.lastRate * 100) / 100;
      state.invoices.push({ date: d, docket: dk, kg, ex, stmt: 'manual' }); save(); render(); toast('Invoice line added');
    } else if (a === 'csv') {
      const head = ['Invoice date', 'Docket', 'Invoiced kg', '$ ex GST', '$/kg', 'Gauge estimate kg', 'Difference kg', 'Check', 'Note'];
      const q = (v) => '"' + String(v).replace(/"/g, '""') + '"';
      const lines = [head.join(',')].concat(C.inv.out.map((x) => [x.date, q(x.docket), x.kg, x.ex.toFixed(2), x.rate.toFixed(4), x.gaugeKg === null ? '' : Math.round(x.gaugeKg), x.diff === null ? '' : Math.round(x.diff), q(STATUS[x.status][1]), q(x.note)].join(',')));
      const el = document.createElement('a'); el.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })); el.download = 'balter-co2-invoices-vs-gauge.csv'; el.click(); setTimeout(() => URL.revokeObjectURL(el.href), 2000);
    }
    else if (a === 'qType') {
      quickType = b.dataset.t;
      app.querySelectorAll('#quick .seg').forEach((x) => x.classList.toggle('on', x === b));
      $('#qTimeWrap').style.display = quickType === 'cur' ? '' : 'none';
      if (!quickDateTouched) $('#qDate').value = defaultDate(quickType);
      $('#qVal').focus();
    } else if (a === 'quickSave') {
      const t = quickType || defaultType(), v = num($('#qVal').value), d = $('#qDate').value;
      if (!d) return toast('Pick a date');
      if (v === null || v < 0 || v > 100) return toast('Enter the gauge level as a percentage (0–100)');
      if (t === 'am') setReading(d, 'am', v); else if (t === 'pm') setReading(d, 'pm', v); else setReading(d, 'cur', { v, h: $('#qTime').value || nowHM() });
      quickDateTouched = false; save(); render();
      const p = nextStatus().p;
      toast(`Saved ${t === 'am' ? 'morning' : t === 'pm' ? 'evening' : 'live'} reading ${v}% for ${fmtD(d)}.${p ? ' Next delivery: ' + fmtD(p.d) + '.' : ' No delivery needed in the window.'}`);
    }
    else if (a === 'addOrder') {
      const d = $('#orDate').value, t = num($('#orT').value);
      if (!d) return toast('Pick the delivery date');
      if (!t || t <= 0) return toast('Enter the quantity in tonnes');
      state.orders.push({ id: 'o' + Date.now(), date: d, when: $('#orWhen').value, t, placed: $('#orPlaced').value || TODAY, note: $('#orNote').value.trim() });
      save(); render(); toast(`Order logged for ${fmtD(d)}`);
    } else if (a === 'logOrder') {
      state.orders.push({ id: 'o' + Date.now(), date: b.dataset.d, when: 'am', t: S().load, placed: TODAY, note: '' });
      save(); render(); toast(`Order logged for ${fmtD(b.dataset.d)}`);
    } else if (a === 'addEvent') {
      const d = $('#evDate').value, t = $('#evText').value.trim(); if (!d || !t) return toast('Enter a date and a short note');
      state.events.push({ id: 'ev' + Date.now(), d, text: t }); save(); render(); toast('Note added');
    } else if (a === 'delEvent') { state.events = state.events.filter((x) => x.id !== b.dataset.id); (state.removedEvents = state.removedEvents || []).push(b.dataset.id); save(); render();
    } else if (a === 'delOrder') { state.orders = state.orders.filter((o) => o.id !== b.dataset.id); save(); render(); }
    else if (a === 'resetOv') { state.overrides = {}; save(); render(); toast('Plan changes cleared'); }
    else if (a === 'pickCo2') $('#co2File').click();
    else if (a === 'pickLbb') $('#lbbFile').click();
    else if (a === 'defaults') { state.settings = { ...DEFAULTS }; save(); render(); toast('Settings reset'); }
    else if (a === 'import') $('#jsonFile').click();
    else if (a === 'export') {
      const blob = new Blob([JSON.stringify({ app: 'balter-co2', exported: new Date().toISOString(), ...state }, null, 1)], { type: 'application/json' });
      const el = document.createElement('a'); el.href = URL.createObjectURL(blob); el.download = `balter-co2-data-${TODAY}.json`; el.click(); setTimeout(() => URL.revokeObjectURL(el.href), 2000);
    }
  });

  $('#co2File').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      const rows = LBB.parseCo2Workbook(await readXlsx(f), window.XLSX, +TODAY.slice(0, 4));
      if (!rows.length) return toast('No readings found — expected Date, Morning, Evening in columns A–C');
      const map = new Map(state.readings.map((r) => [r.d, r])); rows.forEach((r) => map.set(r.d, r));
      state.readings = [...map.values()].sort((a, b) => (a.d < b.d ? -1 : 1)); save(); render();
      toast(`Imported ${rows.length} days of readings`);
    } catch (err) { toast('Could not read that file: ' + err.message); }
  });

  async function importSheet(f) {
    if (!/\.(xlsx|xlsm)$/i.test(f.name)) return toast(`${f.name}: please use an Excel file (.xlsx)`);
    toast(`Reading ${f.name} — this can take a few seconds…`);
    try {
      const wb = await readXlsx(f);
      const res = LBB.parseBoardWorkbook(wb, window.XLSX, { minDate: M.addDays(TODAY, -75) });
      const nd = Object.keys(res.days).length;
      if (nd) {
        Object.assign(state.board, res.days); state.boardUpdated = { at: Date.now(), name: f.name };
        save(); render();
        const wk = Object.keys(res.days).sort().pop();
        return toast(`Board updated from ${f.name}: ${nd} days, through ${fmtD(wk)}`);
      }
      const rows = LBB.parseCo2Workbook(wb, window.XLSX, +TODAY.slice(0, 4));
      if (rows.length) {
        const map = new Map(state.readings.map((r) => [r.d, r])); rows.forEach((r) => map.set(r.d, r));
        state.readings = [...map.values()].sort((a, b) => (a.d < b.d ? -1 : 1)); save(); render();
        return toast(`Imported ${rows.length} days of CO2 readings from ${f.name}`);
      }
      toast(`${f.name}: neither a Live Brewery Board nor a CO2 handover sheet that I recognise`);
    } catch (err) { toast('Could not read that file: ' + err.message); }
  }
  $('#lbbFile').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importSheet(f); });

  // drag and drop (the zone is re-created on every render, so listen on the page)
  const isFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  ['dragenter', 'dragover'].forEach((t) => window.addEventListener(t, (e) => {
    if (!isFiles(e)) return; e.preventDefault();
    const z = e.target.closest && e.target.closest('#drop'); const el = $('#drop'); if (el) el.classList.toggle('over', !!z);
  }));
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) { const el = $('#drop'); if (el) el.classList.remove('over'); } });
  window.addEventListener('drop', (e) => {
    if (!isFiles(e)) return; e.preventDefault();
    const el = $('#drop'); if (el) el.classList.remove('over');
    [...e.dataTransfer.files].forEach((f) => importSheet(f));          // anywhere on the page works, the zone just shows where
  });
  app.addEventListener('click', (e) => { if (e.target.closest('#drop')) $('#lbbFile').click(); });
  app.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.id === 'drop') { e.preventDefault(); $('#lbbFile').click(); } });

  $('#jsonFile').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      if (!Array.isArray(j.readings) || typeof j.board !== 'object') throw new Error('not a Balter CO2 export');
      state = { ...state, readings: j.readings, board: j.board, overrides: j.overrides || {}, orders: j.orders || [], events: j.events || [], invoices: j.invoices || state.invoices, settings: { ...DEFAULTS, ...(j.settings || {}) } };
      save(); render(); toast('Data imported');
    } catch (err) { toast('Could not import: ' + err.message); }
  });

  $('#copyBtn').addEventListener('click', async () => {
    const t = summaryText();
    try { await navigator.clipboard.writeText(t); toast('Order summary copied'); }
    catch (e) { const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); toast('Order summary copied'); } catch (_) { toast('Copy not available here'); } ta.remove(); }
  });
  $('#emailBtn').addEventListener('click', () => { if (!C) return; openEmail(); });
  $('#printBtn').addEventListener('click', () => window.print());

  /* bubbles */
  (function () {
    const host = $('#bubbles'); if (!host) return;
    for (let i = 0; i < 18; i++) {
      const s = document.createElement('span'), sz = 8 + Math.random() * 26;
      s.style.cssText = `left:${Math.random() * 100}%;width:${sz}px;height:${sz}px;animation-duration:${14 + Math.random() * 16}s;animation-delay:${-Math.random() * 24}s`;
      host.appendChild(s);
    }
  })();

  render();
  pull();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pull(); });
})();
