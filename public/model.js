/* Balter CO2 Predictor — model + delivery simulation (pure functions, no DOM). */
(function (root) {
  'use strict';

  const FEATURES = [
    { key: 't70',     label: '70HL transfers',  unit: 'per transfer',      scale: 1 },
    { key: 't300',    label: '300HL transfers', unit: 'per transfer',      scale: 1 },
    { key: 't500',    label: '500HL transfers', unit: 'per transfer',      scale: 1 },
    { key: 'cartons', label: 'Cartons packed',  unit: 'per 1,000 cartons', scale: 1000 },
    { key: 'kegs',    label: 'Kegs filled',     unit: 'per 100 kegs',      scale: 100 }
  ];
  const NF = FEATURES.length;

  /* ---------- dates ---------- */
  const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const addDays = (s, n) => iso(parse(s) + n * 864e5);
  const diffDays = (a, b) => Math.round((parse(b) - parse(a)) / 864e5);
  const dow = (s) => new Date(parse(s)).getUTCDay();            // 0 = Sun
  const range = (a, b) => { const o = []; for (let d = a; d <= b; d = addDays(d, 1)) o.push(d); return o; };

  /* ---------- features for a day (scaled to model units) ---------- */
  function featRow(rec) {
    const r = rec || [0, 0, 0, 0, 0];
    return FEATURES.map((f, i) => (r[i] || 0) / f.scale);
  }

  /* ---------- non-negative least squares (coordinate descent) ---------- */
  function nnls(X, y, sweeps) {
    const n = X.length, p = X[0].length, b = new Array(p).fill(0), r = y.slice();
    const nn = new Array(p).fill(0);
    for (let j = 0; j < p; j++) for (let i = 0; i < n; i++) nn[j] += X[i][j] * X[i][j];
    for (let s = 0; s < (sweeps || 4000); s++) {
      let moved = 0;
      for (let j = 0; j < p; j++) {
        if (!nn[j]) continue;
        let g = 0; for (let i = 0; i < n; i++) g += X[i][j] * r[i];
        const nb = Math.max(0, b[j] + g / nn[j]), d = nb - b[j];
        if (d) { for (let i = 0; i < n; i++) r[i] -= X[i][j] * d; b[j] = nb; moved = Math.max(moved, Math.abs(d)); }
      }
      if (moved < 1e-10) break;
    }
    return b;
  }

  /* ---------- turn readings into usage observations ----------
     Usage for a day is measured evening-to-evening (almost all CO2 is used in the working day; overnight loss is <1%).
     Gaps with a missing reading become one multi-day observation. A rise in level is a delivery and is excluded.        */
  function cleanReadings(readings) {
    const rows = readings.slice().sort((a, b) => (a.d < b.d ? -1 : 1)), keep = [], notes = [];
    rows.forEach((r) => {
      const p = keep[keep.length - 1];
      if (p && r.am !== null && r.pm !== null && r.am === p.am && r.pm === p.pm) {
        notes.push({ d: r.d, text: `Reading is identical to the previous day (${p.d}) — treated as a copy and ignored.` });
        return;
      }
      keep.push(r);
    });
    // a fall of more than 20 points in a day is not possible from use alone: treat that evening figure as a typo
    let prev = null;
    const rows2 = keep.map((r) => {
      if (r.pm !== null && prev && diffDays(prev.d, r.d) > 0 && (prev.pm - r.pm) / diffDays(prev.d, r.d) > 20) {
        notes.push({ d: r.d, text: `Evening level ${r.pm} is ${(prev.pm - r.pm).toFixed(0)} points below the previous evening — too big a drop for one day, so it is ignored (typo?).` });
        return { ...r, pm: null };
      }
      if (r.pm !== null) prev = r;
      return r;
    });
    return { rows: rows2, notes };
  }

  function observations(readings, board) {
    const { rows, notes } = cleanReadings(readings);
    // end-of-day level = evening reading, or (if missing) the next morning's reading, since overnight loss is tiny
    const endOf = {};
    rows.forEach((r) => { if (r.pm !== null) endOf[r.d] = r.pm; });
    const viaAm = {};
    rows.forEach((r) => { const prev = addDays(r.d, -1); if (r.am !== null && endOf[prev] === undefined) { endOf[prev] = r.am; viaAm[prev] = true; } });
    const pms = Object.keys(endOf).sort().map((d) => ({ d, pm: endOf[d], viaAm: !!viaAm[d] }));
    const obs = [], deliveries = [];
    for (let i = 1; i < pms.length; i++) {
      const a = pms[i - 1], b = pms[i], span = diffDays(a.d, b.d), drop = a.pm - b.pm;
      const days = range(addDays(a.d, 1), b.d);
      if (drop < -3) { deliveries.push({ d: b.viaAm ? addDays(b.d, 1) : b.d, from: a.d, rise: -drop, days: span }); continue; }
      if (span > 4) { notes.push({ d: b.d, text: `${span}-day gap in readings before this date — not used for fitting.` }); continue; }
      if (drop < 0.5) { notes.push({ d: b.d, text: `Level barely moved (${drop.toFixed(1)}) since ${a.d} — not used for fitting.` }); continue; }
      const x = new Array(NF).fill(0);
      days.forEach((d) => featRow(board[d]).forEach((v, k) => (x[k] += v)));
      obs.push({ d: b.d, days, n: span, use: drop, x });
    }
    return { obs, deliveries, notes, rows };
  }

  /* ---------- fit ----------
     Non-negative least squares, re-weighted (Huber) so a few bad readings or board changes don't drag the answer. */
  function median(a) { const b = a.slice().sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : 0; }
  function robustFit(obs) {
    const X = obs.map((o) => o.x.concat([o.n])), y = obs.map((o) => o.use);
    let w = obs.map(() => 1), b = null;
    for (let it = 0; it < 8; it++) {
      const sw = w.map(Math.sqrt);
      b = nnls(X.map((r, i) => r.map((v) => v * sw[i])), y.map((v, i) => v * sw[i]));
      const res = X.map((r, i) => (y[i] - r.reduce((s, v, j) => s + v * b[j], 0)) / obs[i].n);
      const k = 1.345 * Math.max(0.8, 1.4826 * median(res.map(Math.abs)));
      w = res.map((r) => (Math.abs(r) <= k ? 1 : k / Math.abs(r)));
    }
    return b;
  }
  const dot = (r, b) => r.reduce((s, v, j) => s + v * b[j], 0);

  function fit(obs) {
    const X = obs.map((o) => o.x.concat([o.n])), y = obs.map((o) => o.use);
    const n = obs.length;
    if (n < 4) return { ok: false, n, coef: new Array(NF).fill(0), base: 8.8, rmse: 1.5, loo: 1.5, sigma: 1.5, r2: 0, corr: [], pred: [], perDayMean: 8.8, outliers: [] };
    const b = robustFit(obs);
    const pred = X.map((row) => dot(row, b));
    const yd = y.map((v, i) => v / obs[i].n), pd = pred.map((v, i) => v / obs[i].n), mean = yd.reduce((s, v) => s + v, 0) / n;
    const sse = yd.reduce((s, v, i) => s + (v - pd[i]) ** 2, 0), sst = yd.reduce((s, v) => s + (v - mean) ** 2, 0);
    const looRes = [];
    for (let i = 0; i < n; i++) {
      const tr = obs.filter((_, k) => k !== i), bb = robustFit(tr);
      looRes.push((y[i] - dot(X[i], bb)) / obs[i].n);
    }
    const looAbs = looRes.map(Math.abs);
    const corr = FEATURES.map((f, k) => {
      const xs = obs.map((o) => o.x[k] / o.n), mx = xs.reduce((s, v) => s + v, 0) / n;
      let sxy = 0, sxx = 0, syy = 0;
      xs.forEach((v, i) => { sxy += (v - mx) * (yd[i] - mean); sxx += (v - mx) ** 2; syy += (yd[i] - mean) ** 2; });
      return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
    });
    const outliers = obs.map((o, i) => ({ o, i, res: yd[i] - pd[i] })).filter((q) => Math.abs(q.res) > 3.5)
      .sort((a, c) => Math.abs(c.res) - Math.abs(a.res)).slice(0, 6).map((q) => ({ d: q.o.d, days: q.o.days, use: yd[q.i], pred: pd[q.i] }));
    return { ok: true, n, coef: b.slice(0, NF), base: b[NF], rmse: Math.sqrt(sse / n), loo: median(looAbs), sigma: Math.max(0.8, 1.4826 * median(looAbs)),
             r2: sst ? 1 - sse / sst : 0, corr, pred, perDayMean: mean, outliers };
  }

  function predictDay(model, rec) {
    const x = featRow(rec), parts = { base: model.base };
    FEATURES.forEach((f, k) => (parts[f.key] = model.coef[k] * x[k]));
    const total = Object.values(parts).reduce((s, v) => s + v, 0);
    return { total: Math.max(0.5, total), parts };
  }

  /* ---------- delivery simulation ----------
     cfg: { floor, loadPct, maxFill, lead, allowedDows:[1..5], z }                                                   */
  function simulate(opts) {
    const { start, startLevel, days, model, cfg } = opts;     // days: [{ d, rec }]
    const sigma = Math.max(0.6, model.sigma || model.loo || model.rmse || 1);
    const use = days.map((x) => {
      const p = predictDay(model, x.rec);
      if (x.frac != null && x.frac < 1) p.total = Math.max(0.1, p.total * x.frac);   // day already part-way through
      return p;
    });
    const allowed = (d) => cfg.allowedDows.includes(dow(d));
    const del = new Map(), orderMap = new Map();
    (opts.orders || []).forEach((o) => { if (o.i >= 0 && o.i < days.length) { del.set(o.i, o.pts); orderMap.set(o.i, o); } });
    const run = (withDeliveries) => {
      let lvl = startLevel; const rows = [];
      days.forEach((x, i) => {
        let add = 0;
        if (withDeliveries && del.has(i)) add = Math.min(typeof del.get(i) === 'number' ? del.get(i) : cfg.loadPct, Math.max(0, cfg.maxFill - lvl));
        const s = lvl + add, e = s - use[i].total, k = i + 1;
        rows.push({ d: x.d, s, e, add, use: use[i].total, parts: use[i].parts,
                    lo: e - cfg.z * sigma * Math.sqrt(k), hi: Math.min(100, e + cfg.z * sigma * Math.sqrt(k)) });
        lvl = e;
      });
      return rows;
    };
    // Scenario with no delivery (for "when do we hit the floor")
    const bare = run(false);
    const firstBelow = (rows, key, lim) => rows.findIndex((r) => r[key] < lim);
    const iScale = firstBelow(bare, 'e', cfg.scale || 10), iHalt = firstBelow(bare, 'e', cfg.halt || 5), iFloor = firstBelow(bare, 'e', cfg.floor), iFloorLo = firstBelow(bare, 'lo', cfg.floor), iEmpty = firstBelow(bare, 'e', 0);
    const iFits = bare.findIndex((r) => r.s <= cfg.maxFill - cfg.loadPct + 1e-9);
    // Plan deliveries
    let guard = 0, rows = bare;
    while (guard++ < 12) {
      rows = run(true);
      const from = orderMap.size ? Math.min(...orderMap.keys()) : 0;      // days before the first placed order are covered by that order
      const i = rows.findIndex((r, k) => k >= from && r.e < cfg.floor);
      if (i < 0) break;
      let j = i; while (j >= 0 && !allowed(days[j].d)) j--;
      if (j < 0 || del.has(j)) { rows[i].short = true; break; }     // cannot be fixed within the horizon
      del.set(j, true);
    }
    const planned = [];
    rows.forEach((r, i) => {
      if (r.add > 0) {
        const nextNeed = rows.findIndex((q, k) => k >= i && q.e < cfg.floor + 0);
        const ord = orderMap.get(i);
        planned.push({ i, d: r.d, before: r.s - r.add, after: r.s, add: r.add, lowBefore: i > 0 ? rows[i - 1].lo : startLevel,
                       orderBy: addDays(r.d, -cfg.lead), partial: r.add < (ord ? ord.pts : cfg.loadPct) - 0.5, ordered: !!ord, order: ord ? ord.ref : null });
      }
    });
    const lastOrdered = planned.filter((x) => x.ordered).map((x) => x.d).sort().pop();
    planned.forEach((x) => { if (!x.ordered && lastOrdered && x.d < lastOrdered) x.tooLate = true; });   // a suggested load that has to land before an order already placed
    return { rows, bare, use, sigma, planned, iFloor, iFloorLo, iEmpty, iFits,
             floorDate: iFloor >= 0 ? days[iFloor].d : null, floorDateLo: iFloorLo >= 0 ? days[iFloorLo].d : null,
             scaleDate: iScale >= 0 ? days[iScale].d : null, haltDate: iHalt >= 0 ? days[iHalt].d : null,
             emptyDate: iEmpty >= 0 ? days[iEmpty].d : null, fitsDate: iFits >= 0 ? days[iFits].d : null,
             unresolved: rows.some((r) => r.short) };
  }

  const api = { FEATURES, NF, parse, iso, addDays, diffDays, dow, range, featRow, nnls, cleanReadings, observations, fit, predictDay, simulate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.CO2 = api;
})(typeof self !== 'undefined' ? self : this);
