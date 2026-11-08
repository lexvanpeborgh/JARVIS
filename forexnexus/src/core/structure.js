// Marktstructuur als toetsbare algoritmes. Elke markering heeft een
// `index` (de candle waarop hij betrekking heeft) en een `knownAt`
// (de eerste gesloten candle waarop de informatie beschikbaar was).
// Strategieën mogen alleen markeringen gebruiken met knownAt <= huidige index.
//
// "Liquiditeit" betekent hier steeds een AFGELEID prijsniveau (bijv. vorige
// dag high). Er wordt geen zicht op echte stops of institutionele orders geclaimd.

import { fxTradingDayKey, DEFAULT_SESSIONS, inWindow } from './sessions.js';
import { zoned } from './time.js';

export const STRUCTURE_DEFAULTS = Object.freeze({
  pivotLeft: 2,
  pivotRight: 2,
  sweepMaxBarsToMss: 12,
  displacementAtr: 0.8,
  slBufferAtr: 0.1,
});

/**
 * Pivots: swing high op p als h[p] strikt hoger is dan de L candles links en
 * de R candles rechts. Bevestigd (knownAt) op p+R.
 */
export function pivots(candles, L = 2, R = 2) {
  const highs = []; const lows = [];
  for (let p = L; p < candles.length - R; p += 1) {
    let isH = true; let isL = true;
    for (let j = 1; j <= L; j += 1) {
      if (!(candles[p].h > candles[p - j].h)) isH = false;
      if (!(candles[p].l < candles[p - j].l)) isL = false;
    }
    for (let j = 1; j <= R; j += 1) {
      if (!(candles[p].h > candles[p + j].h)) isH = false;
      if (!(candles[p].l < candles[p + j].l)) isL = false;
    }
    if (isH) highs.push({ index: p, knownAt: p + R, price: candles[p].h, t: candles[p].t });
    if (isL) lows.push({ index: p, knownAt: p + R, price: candles[p].l, t: candles[p].t });
  }
  return { highs, lows };
}

/**
 * Referentieniveaus per index, uitsluitend uit eerdere, afgesloten informatie:
 * - PDH/PDL: high/low van de vorige FX-handelsdag (rol 17:00 New York),
 *   beschikbaar vanaf de eerste candle van de nieuwe handelsdag.
 * - Aziatische range: high/low van candles met open in het ingestelde venster
 *   (standaard 00:00–06:00 UTC), beschikbaar vanaf de eerste candle na het venster
 *   op dezelfde UTC-datum.
 */
export function referenceLevels(candles, asian = DEFAULT_SESSIONS.asianRange) {
  const n = candles.length;
  const out = new Array(n);
  const dayHL = new Map(); const order = [];
  let asianDate = null; let asianH = null; let asianL = null; let asianDone = null;
  let curDay = null; let prevDay = null;
  for (let i = 0; i < n; i += 1) {
    const c = candles[i];
    const day = fxTradingDayKey(c.t);
    if (day !== curDay) { if (curDay != null) prevDay = curDay; curDay = day; order.push(day); }
    const date = zoned(c.t, asian.tz).dateKey;
    if (date !== asianDate) { asianDate = date; asianH = null; asianL = null; asianDone = null; }
    const inAsian = inWindow(c.t, asian);
    // niveaus zoals bekend vóór deze candle meetelt
    const pd = prevDay ? dayHL.get(prevDay) : null;
    if (!inAsian && asianH != null && asianDone == null) asianDone = { h: asianH, l: asianL, date };
    out[i] = {
      pdh: pd ? pd.h : null, pdl: pd ? pd.l : null, prevDay,
      asianHigh: asianDone ? asianDone.h : null, asianLow: asianDone ? asianDone.l : null,
      asianDate: asianDone ? asianDone.date : null,
    };
    // update na de candle
    const d = dayHL.get(day) || { h: -Infinity, l: Infinity };
    d.h = Math.max(d.h, c.h); d.l = Math.min(d.l, c.l); dayHL.set(day, d);
    if (inAsian) { asianH = asianH == null ? c.h : Math.max(asianH, c.h); asianL = asianL == null ? c.l : Math.min(asianL, c.l); }
  }
  return out;
}

/** Laatste bevestigde pivot vóór of op `atIndex` (knownAt <= atIndex), met index < beforeIndex. */
export function lastConfirmed(list, atIndex, beforeIndex = Infinity) {
  let best = null;
  for (const p of list) {
    if (p.knownAt > atIndex) break; // lijsten zijn op index gesorteerd en knownAt = index+R
    if (p.index < beforeIndex) best = p;
  }
  return best;
}

/**
 * Sweep op candle i: high boven een vooraf bekend niveau met close terug eronder
 * (bearish sweep), of low eronder met close terug erboven (bullish sweep).
 */
export function sweepAt(c, lv) {
  const res = [];
  const levels = [['PDH', lv.pdh, 'up'], ['ASIA_H', lv.asianHigh, 'up'], ['PDL', lv.pdl, 'down'], ['ASIA_L', lv.asianLow, 'down']];
  for (const [name, price, side] of levels) {
    if (price == null) continue;
    if (side === 'up' && c.h > price && c.c < price) res.push({ type: 'SWEEP_HIGH', level: name, price, bias: 'SHORT' });
    if (side === 'down' && c.l < price && c.c > price) res.push({ type: 'SWEEP_LOW', level: name, price, bias: 'LONG' });
  }
  return res;
}

/** Fair Value Gaps (drie-candledefinitie), bekend op de derde candle. */
export function fairValueGaps(candles) {
  const out = [];
  for (let i = 2; i < candles.length; i += 1) {
    const a = candles[i - 2]; const c = candles[i];
    if (c.l > a.h) out.push({ type: 'FVG_UP', index: i - 1, knownAt: i, top: c.l, bottom: a.h, t: candles[i - 1].t });
    if (c.h < a.l) out.push({ type: 'FVG_DOWN', index: i - 1, knownAt: i, top: a.l, bottom: c.h, t: candles[i - 1].t });
  }
  // invalidatie: close voorbij de verre zijde
  for (const g of out) {
    for (let j = g.knownAt + 1; j < candles.length; j += 1) {
      const cl = candles[j].c;
      if ((g.type === 'FVG_UP' && cl < g.bottom) || (g.type === 'FVG_DOWN' && cl > g.top)) { g.invalidatedAt = j; break; }
    }
  }
  return out;
}

/**
 * Volledige structuuranalyse voor weergave én strategie.
 * Retourneert events met index/knownAt zodat replay kan tonen wanneer iets bekend werd.
 */
export function analyzeStructure(candles, atr, cfg = {}) {
  const p = { ...STRUCTURE_DEFAULTS, ...cfg };
  const pv = pivots(candles, p.pivotLeft, p.pivotRight);
  const levels = referenceLevels(candles, cfg.asianRange || DEFAULT_SESSIONS.asianRange);
  const events = [];
  const sweeps = [];
  for (let i = 0; i < candles.length; i += 1) {
    for (const s of sweepAt(candles[i], levels[i])) {
      const ev = { ...s, index: i, knownAt: i, t: candles[i].t };
      sweeps.push(ev); events.push(ev);
    }
  }
  // Break of structure / MSS: close voorbij de laatste bevestigde pivot.
  // MSS = break tegen de richting van een recente sweep in (sweep high → break van swing low).
  const breaks = [];
  let lastHighBroken = null; let lastLowBroken = null;
  for (let i = 1; i < candles.length; i += 1) {
    const ph = lastConfirmed(pv.highs, i - 1); const pl = lastConfirmed(pv.lows, i - 1);
    const c = candles[i];
    if (ph && c.c > ph.price && lastHighBroken !== ph.index) {
      lastHighBroken = ph.index;
      const recentSweep = sweeps.find(s => s.type === 'SWEEP_LOW' && s.index <= i && i - s.index <= p.sweepMaxBarsToMss && ph.index < s.index);
      const disp = atr[i] != null ? Math.abs(c.c - c.o) / atr[i] : null;
      breaks.push({ type: recentSweep ? 'MSS_UP' : 'BOS_UP', index: i, knownAt: i, t: c.t, level: ph.price, pivotIndex: ph.index, displacementAtr: disp, sweepIndex: recentSweep?.index ?? null });
    }
    if (pl && c.c < pl.price && lastLowBroken !== pl.index) {
      lastLowBroken = pl.index;
      const recentSweep = sweeps.find(s => s.type === 'SWEEP_HIGH' && s.index <= i && i - s.index <= p.sweepMaxBarsToMss && pl.index < s.index);
      const disp = atr[i] != null ? Math.abs(c.c - c.o) / atr[i] : null;
      breaks.push({ type: recentSweep ? 'MSS_DOWN' : 'BOS_DOWN', index: i, knownAt: i, t: c.t, level: pl.price, pivotIndex: pl.index, displacementAtr: disp, sweepIndex: recentSweep?.index ?? null });
    }
  }
  events.push(...breaks);
  // Orderblock: laatste tegengesteld gekleurde candle tussen sweep en MSS-candle.
  const orderBlocks = [];
  for (const b of breaks) {
    if (!b.type.startsWith('MSS')) continue;
    const up = b.type === 'MSS_UP';
    for (let j = b.index - 1; j >= (b.sweepIndex ?? b.index - 1); j -= 1) {
      const c = candles[j];
      if (up ? c.c < c.o : c.c > c.o) {
        const ob = { type: up ? 'OB_BULL' : 'OB_BEAR', index: j, knownAt: b.index, t: c.t, top: c.h, bottom: c.l };
        for (let k = b.index + 1; k < candles.length; k += 1) {
          if (up ? candles[k].c < ob.bottom : candles[k].c > ob.top) { ob.invalidatedAt = k; break; }
        }
        orderBlocks.push(ob);
        break;
      }
    }
  }
  return { pivots: pv, levels, sweeps, breaks, fvgs: fairValueGaps(candles), orderBlocks, events, params: p };
}

export const STRUCTURE_DEFINITIONS = {
  pivot: 'Swing high: high strikt hoger dan de L candles links en R candles rechts (standaard 2/2). Bevestigd R candles later.',
  sweep: 'High boven een vooraf bekend niveau (PDH of Aziatische high) met close terug eronder; spiegelbeeldig voor lows.',
  bos: 'Close voorbij de laatst bevestigde pivot zonder voorafgaande sweep in tegenrichting.',
  mss: 'Close voorbij de laatst bevestigde pivot, binnen N candles na een sweep in tegenrichting, met pivot van vóór de sweep.',
  fvg: 'Drie candles: low(3) > high(1) (bullish) of high(3) < low(1) (bearish). Ongeldig bij close voorbij de verre zijde.',
  orderBlock: 'Laatste tegengesteld gekleurde candle tussen sweep en MSS-candle. Ongeldig bij close voorbij de verre zijde.',
  displacement: 'Body van de breukcandle gedeeld door ATR14.',
};
