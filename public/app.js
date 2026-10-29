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
      s.seedVersion = seed.version;
    }
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
    const sim = M.simulate({ startLevel, days, model, cfg });

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
    C = { frac0, q, model, rows, latest, startDate, startLevel, lastLabel, days, end, boardEnd, lastBoard, cfg, sim, past, hist, act7, recFor };
  }

  /* ---------- status of next delivery ---------- */
  function nextStatus() {
    const p = C.sim.planned[0];
    if (!p) return { st: 'ok', text: 'No delivery needed in the planning window', p: null };
    const left = M.diffDays(TODAY, p.orderBy);
    if (left < 0) return { st: 'risk', text: `Order was due ${fmtD(p.orderBy)} — call the supplier now`, p };
    if (left === 0) return { st: 'order', text: 'Place the order today', p };
    if (left <= 2) return { st: 'watch', text: `Place the order ${left === 1 ? 'tomorrow' : 'in 2 days'} (${fmtD(p.orderBy)})`, p };
    return { st: 'ok', text: `Place the order by ${fmtD(p.orderBy)}`, p };
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
      list = `
        <li><b>Order by</b><span>${fmtD(p.orderBy)} <span class="muted">(${plural(set.lead, 'day')} notice)</span></span></li>
        <li><b>Load</b><span>${fT(p.add)} <span class="muted">${p.partial ? '— only part of a load fits' : '— a full 20 t load fits'}</span></span></li>
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
          <span class="eyebrow">Next delivery</span>
          <div class="when">${when}</div>
          <span class="rel">${relTxt}</span>
          <ul>${list}</ul>
          <div class="ask">${esc(ns.text)}</div>
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
      ${renderSchedule()}
    </section>`;
  }

  function renderSchedule() {
    const pl = C.sim.planned;
    const rows = pl.map((x, i) => {
      const left = M.diffDays(TODAY, x.orderBy);
      const chip = left < 0 ? '<span class="chip st-risk"><i></i>Overdue</span>' : left === 0 ? '<span class="chip st-order"><i></i>Order today</span>' : left <= 2 ? '<span class="chip st-watch"><i></i>Soon</span>' : '<span class="chip st-ok"><i></i>On track</span>';
      return `<tr><td>${i + 1}</td><td class="sticky-col2"><b>${fmtD(x.d)}</b><small>${rel(x.d)}</small></td><td>${fmtD(x.orderBy)}</td><td class="r num">${fP(x.before)}<small>${fT(x.before)}</small></td><td class="r num">${fP(x.after)}<small>${fT(x.after)}</small></td><td class="r num">${fT(x.add)}${x.partial ? '<small>part load</small>' : ''}</td><td>${chip}</td></tr>`;
    }).join('');
    return `<div class="panel" style="margin-top:14px">
      <div class="pad" style="padding-bottom:6px"><b>Delivery schedule to ${fmtD(C.end)}</b> <span class="muted" style="font-size:12px">· assumes each load lands on the day shown and the plan on the board is followed</span></div>
      ${pl.length ? `<div class="tbl-wrap"><table><thead><tr><th>#</th><th>Deliver on</th><th>Order by</th><th class="r">Level before</th><th class="r">Level after</th><th class="r">Load</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="pad muted" style="font-size:13px">No deliveries needed before ${fmtD(C.end)} — the vessel stays above the ${S().floor}% floor.</div>`}
      <div class="note" style="padding-top:10px">Where the board has no transfers entered yet (${C.boardEnd && C.lastBoard > C.boardEnd ? 'after ' + fmtS(C.boardEnd) : 'beyond the last planned week'}) the forecast stops, because transfers are the biggest swing in daily use.</div>
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
      g += `<path d="M${cx},${cy - 9} l8,9 -8,9 -8,-9 z" fill="#FDAA63" stroke="#000" stroke-width="1.5"/>`;
      const anchor = cx > W - 140 ? 'end' : 'start';
      g += `<text class="lbl" x="${cx + (anchor === 'end' ? -12 : 12)}" y="${cy - 12}" text-anchor="${anchor}">Deliver ${fmtD(p.d)}</text>`;
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
        <div class="legend"><span><i class="line"></i>Readings</span><span><i class="dash" style="border-top-color:#7566A0"></i>Forecast</span><span><i style="background:#99D6EA"></i>90% range</span><span><i style="background:#FDAA63"></i>Planned delivery</span><span><i style="background:#47D7AC"></i>Delivery received</span><span><i class="dash"></i>Reorder floor</span></div>
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
          <div class="note" style="padding-top:0"><b>Reading this honestly:</b> ${strong.length ? strong.join(', ') + (strong.length > 1 ? ' are' : ' is') + ' the clearest signal' + (strong.length > 1 ? 's' : '') + '.' : 'No single driver stands out yet.'} ${weak.length ? weak.join(' and ') + ' show' + (weak.length > 1 ? '' : 's') + ' little effect so far — too small or too irregular to separate out.' : ''} Brite CIPs are not on the board, so they sit in the base load and are the main source of the ± above. Fitted on ${m.n} periods since ${C.hist.length ? fmtS(C.hist[0].days[0]) : '–'}; a few odd days are down-weighted automatically and listed under Data checks.</div>
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

  /* ---------- readings ---------- */
  function renderReadings() {
    const set = S();
    const rows = state.readings.slice().sort((a, b) => (a.d < b.d ? 1 : -1));
    const dl = {}; C.past.forEach((x) => (dl[x.d] = x));
    const body = rows.map((r) => {
      const dv = dl[r.d];
      return `<tr><td class="sticky-col">${fmtD(r.d)}</td>
        <td class="r"><input type="number" class="rd" step="0.1" min="0" max="100" value="${r.am === null ? '' : r.am}" data-d="${r.d}" data-f="am" aria-label="Morning level ${r.d}"></td>
        <td class="r"><input type="number" class="rd" step="0.1" min="0" max="100" value="${r.pm === null ? '' : r.pm}" data-d="${r.d}" data-f="pm" aria-label="Evening level ${r.d}"></td>
        <td>${r.cur ? `<span class="chip info"><i></i>Now ${r.cur.v}% at ${r.cur.h}</span> ` : ''}${dv ? `<span class="chip ${dv.short ? 'st-order' : 'st-ok'}"><i></i>Delivery ≈ ${dv.t.toFixed(0)} t${dv.short ? ' — short load?' : ''}</span>` : ''}</td>
        <td class="r"><button class="btn small x" data-act="delReading" data-d="${r.d}" aria-label="Delete reading ${r.d}">×</button></td></tr>`;
    }).join('');
    const outNotes = C.model.outliers.map((o) => `<li><b>${o.days.length > 1 ? fmtS(o.days[0]) + '–' + fmtS(o.d) : fmtS(o.d)}:</b> measured ${o.use.toFixed(1)} pts/day but the board predicts ${o.pred.toFixed(1)} — worth checking that day's readings or whether the plan changed.</li>`).join('');
    const notes = outNotes + C.q.notes.map((n) => `<li><b>${fmtS(n.d)}:</b> ${esc(n.text)}</li>`).join('');
    const pastNotes = C.past.filter((x) => x.short).map((x) => `<li><b>${fmtS(x.d)}:</b> the level rose about ${fT(x.pts)} (${fP(x.before, 0)} → ${fP(x.before + x.pts, 0)}), well short of a ${set.load} t load that fits — was this a short delivery?</li>`).join('');
    const boardMsg = C.lastBoard ? `Board loaded to <b>${fmtD(C.lastBoard)}</b>; transfers planned to <b>${C.boardEnd ? fmtD(C.boardEnd) : 'none'}</b>.` : 'No board loaded.';
    return `<section class="sec" id="readings">
      <div class="sec-head"><div><span class="eyebrow">Data</span><h2>Daily readings</h2>
        <p>Enter the vessel level (% on the gauge) from the morning and evening handover. Use “Right now” for a mid-day check — the forecast then only counts the rest of today's use. A jump up is picked up automatically as a delivery.</p></div>
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
      ${notes || pastNotes ? `<div class="banner" style="margin:14px 0 0;display:block"><b>Data checks</b><ul class="plain" style="margin-top:4px">${pastNotes}${notes}</ul></div>` : ''}
      <div class="panel" style="margin-top:14px"><div class="tbl-wrap" style="max-height:420px;overflow:auto"><table><thead><tr><th>Date</th><th class="r">Morning %</th><th class="r">Evening %</th><th>Detected</th><th></th></tr></thead><tbody>${body || '<tr><td colspan="5" class="muted">No readings yet.</td></tr>'}</tbody></table></div></div>
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
    $('#app').innerHTML = renderHero() + renderForecast() + renderDrivers() + renderReadings() + renderSettings();
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

  $('#lbbFile').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    toast('Reading the board — this can take a few seconds…');
    try {
      const wb = await readXlsx(f);
      const res = LBB.parseBoardWorkbook(wb, window.XLSX, { minDate: M.addDays(TODAY, -75) });
      const nd = Object.keys(res.days).length;
      if (!nd) return toast('No weekly sheets recognised — expected the Live Brewery Board layout');
      Object.assign(state.board, res.days); save(); render();
      toast(`Board updated: ${nd} days from ${res.sheets.length} weekly sheets`);
    } catch (err) { toast('Could not read that file: ' + err.message); }
  });

  $('#jsonFile').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      if (!Array.isArray(j.readings) || typeof j.board !== 'object') throw new Error('not a Balter CO2 export');
      state = { ...state, readings: j.readings, board: j.board, overrides: j.overrides || {}, settings: { ...DEFAULTS, ...(j.settings || {}) } };
      save(); render(); toast('Data imported');
    } catch (err) { toast('Could not import: ' + err.message); }
  });

  $('#copyBtn').addEventListener('click', async () => {
    const t = summaryText();
    try { await navigator.clipboard.writeText(t); toast('Order summary copied'); }
    catch (e) { const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); toast('Order summary copied'); } catch (_) { toast('Copy not available here'); } ta.remove(); }
  });
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
