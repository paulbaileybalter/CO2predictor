/* Balter CO2 Predictor — spreadsheet readers.
   Works in the browser (needs SheetJS as global XLSX) and in Node (pass XLSX in).
   1) parseBoardWorkbook : Live Brewery Board  -> { 'YYYY-MM-DD': [t70, t300, t500, cartons, kegs] }
   2) parseCo2Workbook   : CO2 daily handover  -> [{ d:'YYYY-MM-DD', am:number|null, pm:number|null }]   */
(function (root) {
  'use strict';

  // Day blocks on a board sheet: Mon..Sun, each three columns wide (AM / PM / NIGHT). 0-based first column.
  const DAY_COL0 = [1, 4, 7, 10, 13, 16, 19];
  // 0-based row ranges (inclusive) for each section of a weekly sheet
  const ROWS = { t70: [27, 30], t300: [31, 32], t500: [33, 34], cartons: [35, 38], kegs: [39, 42] };

  const serialToISO = (v) => new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 864e5).toISOString().slice(0, 10);
  const pad = (n) => String(n).padStart(2, '0');

  function cellVal(ws, XLSX, r, c) {
    const cell = ws[XLSX.utils.encode_cell({ r, c })];
    return cell ? cell.v : undefined;
  }

  function kegNumber(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const m = v.match(/^\s*(\d+)\s*-/);         // e.g. "150 - KEGSTAR KEGS"
      if (m) return +m[1];
    }
    return null;                                    // text such as "NZ EX 72" is not counted (matches the board's weekly keg total)
  }

  function parseBoardSheet(ws, XLSX) {
    const label = (r) => String(cellVal(ws, XLSX, r, 0) || '').toLowerCase();
    if (!label(27).includes('transfer 70') || !label(31).includes('transfer 300') ||
        !label(33).includes('transfer 500') || !label(35).includes('carton') || !label(39).includes('keg')) return null;
    const out = {};
    let weekTotals = null;
    const k = cellVal(ws, XLSX, 50, 1), c = cellVal(ws, XLSX, 51, 1);
    if (typeof k === 'number' && typeof c === 'number') weekTotals = { kegs: k, cartons: c };
    let sumK = 0, sumC = 0;
    for (let i = 0; i < 7; i++) {
      const c0 = DAY_COL0[i];
      const dv = cellVal(ws, XLSX, 1, c0);
      if (typeof dv !== 'number' || dv < 40000) return null;
      const iso = serialToISO(dv);
      const rec = [0, 0, 0, 0, 0];
      const scan = (range, fn) => {
        for (let r = range[0]; r <= range[1]; r++) for (let c = c0; c < c0 + 3; c++) fn(cellVal(ws, XLSX, r, c));
      };
      ['t70', 't300', 't500'].forEach((key, idx) =>
        scan(ROWS[key], (v) => { if (typeof v === 'string' && /^\s*FV\s*\d+/i.test(v)) rec[idx]++; }));   // one FV tank = one transfer
      scan(ROWS.cartons, (v) => { if (typeof v === 'number') rec[3] += v; });
      scan(ROWS.kegs, (v) => { const n = kegNumber(v); if (n !== null) rec[4] += n; });
      sumK += rec[4]; sumC += rec[3];
      out[iso] = rec;
    }
    return { days: out, weekTotals, parsedTotals: { kegs: sumK, cartons: sumC } };
  }

  function parseBoardWorkbook(wb, XLSX, opts) {
    opts = opts || {};
    const minDate = opts.minDate || '0000-00-00';
    const days = {}; const sheets = []; const mismatches = [];
    const empty = (r) => !r.some((x) => x);
    wb.SheetNames.forEach((name) => {
      if (/blank|copy|\bold\b|^og\b/i.test(name)) return;          // templates and archived copies
      const p = parseBoardSheet(wb.Sheets[name], XLSX);
      if (!p) return;
      const dates = Object.keys(p.days);
      if (dates[dates.length - 1] < minDate) return;
      dates.forEach((d) => { if (d >= minDate && !(days[d] && !empty(days[d]) && empty(p.days[d]))) days[d] = p.days[d]; });
      sheets.push(name);
      if (p.weekTotals && (Math.abs(p.weekTotals.cartons - p.parsedTotals.cartons) > 1 || Math.abs(p.weekTotals.kegs - p.parsedTotals.kegs) > 1))
        mismatches.push({ sheet: name, board: p.weekTotals, parsed: p.parsedTotals });
    });
    return { days, sheets, mismatches };
  }

  /* ---------- CO2 handover sheet ----------
     Column A = date, B = morning level, C = evening level (percent of vessel).
     Dates typed as 28/10 stay text (dd/mm). Dates typed as 12/10 were read by Excel as mm/dd (10 Dec) and stored as real dates,
     so for real date cells the day and month are swapped back.                                                             */
  function parseCo2Workbook(wb, XLSX, year) {
    year = year || new Date().getFullYear();
    const ws = wb.Sheets[wb.SheetNames[0]];
    const ref = XLSX.utils.decode_range(ws['!ref']);
    const rows = [];
    for (let r = ref.s.r; r <= ref.e.r; r++) {
      const a = cellVal(ws, XLSX, r, 0), am = cellVal(ws, XLSX, r, 1), pm = cellVal(ws, XLSX, r, 2);
      if (a === undefined || a === null) continue;
      let d = null;
      if (typeof a === 'number' && a > 40000) {
        const s = new Date(Date.UTC(1899, 11, 30) + Math.floor(a) * 864e5);
        const m = s.getUTCMonth() + 1, day = s.getUTCDate();
        d = `${year}-${pad(day)}-${pad(m)}`;            // swap: stored month is really the day
      } else if (typeof a === 'string') {
        const m = a.trim().match(/^(\d{1,2})[\/\-.](\d{1,2})/);
        if (m) d = `${year}-${pad(+m[2])}-${pad(+m[1])}`;
      }
      if (!d || isNaN(Date.parse(d))) continue;
      const n = (x) => (typeof x === 'number' ? x : null);
      if (n(am) === null && n(pm) === null) continue;
      rows.push({ d, am: n(am), pm: n(pm) });
    }
    rows.sort((x, y) => (x.d < y.d ? -1 : 1));
    return rows;
  }

  const api = { parseBoardSheet, parseBoardWorkbook, parseCo2Workbook };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.LBB = api;
})(typeof self !== 'undefined' ? self : this);
