// Datakwaliteit: volgorde, duplicaten, gaten, ongeldige waarden,
// high/low-consistentie, onmogelijke spreads en onvolledige candles.
// Er wordt NIETS stilzwijgend opgevuld met verzonnen prijzen of volume.

import { TF_MS, iso } from './time.js';
import { candleExpected } from './sessions.js';

export const ISSUE = Object.freeze({
  ORDER: 'ORDER',
  DUPLICATE: 'DUPLICATE',
  GAP: 'GAP',
  INVALID_VALUE: 'INVALID_VALUE',
  HL_INCONSISTENT: 'HL_INCONSISTENT',
  NEGATIVE_SPREAD: 'NEGATIVE_SPREAD',
  WIDE_SPREAD: 'WIDE_SPREAD',
  INCOMPLETE: 'INCOMPLETE',
  MISALIGNED: 'MISALIGNED',
});

const ISSUE_TEXT = {
  ORDER: 'Candle staat niet in chronologische volgorde',
  DUPLICATE: 'Dubbele candle met hetzelfde openingstijdstip',
  GAP: 'Ontbrekende candles tijdens verwachte marktopening',
  INVALID_VALUE: 'Ongeldige of niet-positieve prijswaarde',
  HL_INCONSISTENT: 'High/low niet consistent met open/close',
  NEGATIVE_SPREAD: 'Ask lager dan bid',
  WIDE_SPREAD: 'Spread onwaarschijnlijk breed',
  INCOMPLETE: 'Candle niet afgesloten',
  MISALIGNED: 'Openingstijd valt niet op de tijdframegrens',
};

function okNum(x) { return typeof x === 'number' && Number.isFinite(x) && x > 0; }

function checkOhlc(o, h, l, c) {
  if (![o, h, l, c].every(okNum)) return ISSUE.INVALID_VALUE;
  if (h < Math.max(o, c) - 1e-12 || l > Math.min(o, c) + 1e-12 || h < l) return ISSUE.HL_INCONSISTENT;
  return null;
}

/**
 * Valideer een reeks candles. Retourneert { clean, issues, report }.
 * `clean` bevat geldige, gesorteerde, ontdubbelde candles. Ongeldige candles
 * worden uitgesloten en gerapporteerd — niet gerepareerd.
 */
export function validateCandles(candles, { inst, tf, maxSpreadPrice = null, allowIncomplete = false } = {}) {
  const issues = [];
  const add = (type, t, detail = '') => issues.push({ type, t, at: iso(t), text: ISSUE_TEXT[type], detail });
  const step = TF_MS[tf];
  let prevT = -Infinity;
  for (const c of candles) {
    if (c.t < prevT) add(ISSUE.ORDER, c.t);
    prevT = Math.max(prevT, c.t);
  }
  const sorted = [...candles].sort((a, b) => a.t - b.t);
  const seen = new Map();
  const clean = [];
  for (const c of sorted) {
    if (seen.has(c.t)) {
      const prev = seen.get(c.t);
      const same = prev.o === c.o && prev.h === c.h && prev.l === c.l && prev.c === c.c;
      add(ISSUE.DUPLICATE, c.t, same ? 'identiek' : 'afwijkende waarden; eerste behouden');
      continue;
    }
    if (step && c.t % step !== 0) { add(ISSUE.MISALIGNED, c.t); continue; }
    const bad = checkOhlc(c.o, c.h, c.l, c.c);
    if (bad) { add(bad, c.t, `o=${c.o} h=${c.h} l=${c.l} c=${c.c}`); continue; }
    if (c.b && c.a) {
      const bb = checkOhlc(c.b.o, c.b.h, c.b.l, c.b.c); const ab = checkOhlc(c.a.o, c.a.h, c.a.l, c.a.c);
      if (bb || ab) { add(bb || ab, c.t, 'bid/ask-candle'); continue; }
      if (c.a.c < c.b.c - 1e-12 || c.a.o < c.b.o - 1e-12) { add(ISSUE.NEGATIVE_SPREAD, c.t); continue; }
      if (maxSpreadPrice != null && (c.a.c - c.b.c) > maxSpreadPrice) add(ISSUE.WIDE_SPREAD, c.t, `spread ${(c.a.c - c.b.c)}`);
    }
    if (c.v != null && (!Number.isFinite(c.v) || c.v < 0)) { add(ISSUE.INVALID_VALUE, c.t, 'volume'); continue; }
    if (c.complete === false && !allowIncomplete) { add(ISSUE.INCOMPLETE, c.t); continue; }
    seen.set(c.t, c);
    clean.push(c);
  }
  const gaps = findGaps(clean, { inst, tf });
  for (const g of gaps) add(ISSUE.GAP, g.from, `${g.missing} candle(s) ontbreken tot ${iso(g.to)}`);
  const counts = {};
  for (const i of issues) counts[i.type] = (counts[i.type] || 0) + 1;
  return {
    clean,
    issues,
    gaps,
    report: {
      input: candles.length,
      accepted: clean.length,
      rejected: candles.length - clean.length,
      from: clean.length ? iso(clean[0].t) : null,
      to: clean.length ? iso(clean[clean.length - 1].t) : null,
      counts,
      gapCount: gaps.length,
      missingCandles: gaps.reduce((s, g) => s + g.missing, 0),
      ok: issues.filter(i => i.type !== ISSUE.GAP && i.type !== ISSUE.WIDE_SPREAD).length === 0,
    },
  };
}

/** Gaten = ontbrekende candles op momenten waarop de markt open hoort te zijn. */
export function findGaps(candles, { inst, tf }) {
  const step = TF_MS[tf];
  const gaps = [];
  for (let i = 1; i < candles.length; i += 1) {
    const a = candles[i - 1].t; const b = candles[i].t;
    if (b - a <= step) continue;
    let missing = 0; let first = null;
    for (let t = a + step; t < b; t += step) {
      if (!inst || candleExpected(inst, t, tf)) { missing += 1; if (first == null) first = t; }
    }
    if (missing > 0) gaps.push({ from: first, to: b, missing, afterIndex: i - 1 });
  }
  return gaps;
}

/** Aggregeer M5 (of M1) naar een hoger tijdframe. Alleen volledige bronperioden. */
export function aggregate(candles, fromTf, toTf) {
  const src = TF_MS[fromTf]; const dst = TF_MS[toTf];
  if (dst < src || dst % src !== 0) throw new Error('Ongeldige aggregatie');
  if (dst === src) return candles;
  const buckets = new Map();
  for (const c of candles) {
    const k = Math.floor(c.t / dst) * dst;
    let b = buckets.get(k);
    if (!b) { b = { t: k, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v ?? null, vType: c.vType, n: 0, complete: true, src: c.src, kind: c.kind };
      if (c.b && c.a) { b.b = { ...c.b }; b.a = { ...c.a }; }
      buckets.set(k, b); }
    else {
      b.h = Math.max(b.h, c.h); b.l = Math.min(b.l, c.l); b.c = c.c;
      if (b.v != null && c.v != null) b.v += c.v; else b.v = null;
      if (b.b && c.b) { b.b.h = Math.max(b.b.h, c.b.h); b.b.l = Math.min(b.b.l, c.b.l); b.b.c = c.b.c; b.a.h = Math.max(b.a.h, c.a.h); b.a.l = Math.min(b.a.l, c.a.l); b.a.c = c.a.c; }
    }
    b.n += 1;
    if (c.complete === false) b.complete = false;
  }
  const out = [...buckets.values()].sort((a, b) => a.t - b.t);
  // De laatste bucket is pas compleet wanneer zijn eindtijd verstreken is en alle bronnen gesloten zijn;
  // een bucket met minder bronnen dan verwacht wordt als 'partial' gemarkeerd (kan door gaten/weekend).
  for (const b of out) b.partial = b.n < dst / src;
  return out;
}
