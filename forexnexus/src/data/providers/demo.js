// DEMO-provider: duidelijk gemarkeerde SYNTHETISCHE data voor uitleg,
// interfacecontrole en technische tests. Nooit bewijs van handelsrendement.
// Elke candle krijgt kind='synthetic', src='demo', vType='synthetic'.

import { TF_MS, floorTf } from '../../core/time.js';
import { candleExpected } from '../../core/sessions.js';
import { getInstrument } from '../../core/instruments.js';

const START = { EUR_USD: 1.085, GBP_USD: 1.27, USD_JPY: 151.0 };
const VOL = { EUR_USD: 0.00018, GBP_USD: 0.00024, USD_JPY: 0.028 };

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rnd) {
  const u = Math.max(rnd(), 1e-12); const v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function seedFor(instId, t) {
  let h = 2166136261;
  for (const ch of `${instId}|${t}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * Deterministische synthetische M5-candles [from, to). Prijs is een
 * random walk met regimewisselingen; bid/ask met synthetische spread.
 * Dezelfde (instrument, tijd) levert altijd dezelfde candle.
 */
export function syntheticCandles(instId, tf, from, to, { seed = 7 } = {}) {
  const inst = getInstrument(instId);
  const step = TF_MS[tf];
  // Anker per week (zondag 00:00 UTC, markt gesloten) zodat elk venster
  // dezelfde candles oplevert voor dezelfde (instrument, tijd).
  const weekMs = 7 * 86_400_000;
  const sundayOffset = 3 * 86_400_000; // epoch 0 = donderdag; +3 dagen = zondag
  const out = [];
  const firstWeek = Math.floor((from - sundayOffset) / weekMs) * weekMs + sundayOffset;
  for (let w = firstWeek; w < to; w += weekMs) generateWeek(w);
  return out;

  function generateWeek(w) {
  const rnd = mulberry32(seedFor(instId, w) ^ seed);
  let price = START[instId] * (1 + (rnd() - 0.5) * 0.03);
  let drift = 0; let volMul = 1;
  for (let t = w; t < Math.min(w + weekMs, to); t += step) {
    if (!candleExpected(inst, t, tf)) continue;
    if (rnd() < 0.01) drift = (rnd() - 0.5) * 0.6;
    if (rnd() < 0.02) volMul = 0.6 + rnd() * 1.4;
    const sigma = VOL[instId] * Math.sqrt(step / TF_MS.M5) * volMul;
    const o = price;
    let h = o; let l = o; let p = o;
    for (let k = 0; k < 4; k += 1) {
      p += sigma * (gauss(rnd) * 0.5 + drift * 0.25);
      h = Math.max(h, p); l = Math.min(l, p);
    }
    const c = p;
    h = Math.max(h, o, c) + Math.abs(gauss(rnd)) * sigma * 0.2;
    l = Math.min(l, o, c) - Math.abs(gauss(rnd)) * sigma * 0.2;
    price = c;
    const spr = inst.pip * (0.7 + rnd() * 0.6) * (instId === 'GBP_USD' ? 1.4 : 1);
    const vol = Math.round(40 + rnd() * 160 * volMul);
    if (t < from) continue;
    const r = x => Number(x.toFixed(inst.precision));
    const mid = { o: r(o), h: r(h), l: r(l), c: r(c) };
    const half = spr / 2;
    out.push({
      t, ...mid,
      b: { o: r(o - half), h: r(h - half), l: r(l - half), c: r(c - half) },
      a: { o: r(o + half), h: r(h + half), l: r(l + half), c: r(c + half) },
      v: vol,
      vType: 'synthetic', complete: true, src: 'demo', kind: 'synthetic', priceType: 'BA',
    });
  }
  }
}

/** DEMO-provider-interface (zelfde vorm als echte providers). */
export function createDemoProvider() {
  const startedAt = Date.now();
  return {
    id: 'demo',
    kind: 'synthetic',
    label: 'DEMO — synthetische data',
    async fetchCandles(instId, tf, { count = 500, to = Date.now() } = {}) {
      const end = floorTf(to, tf); // alleen gesloten candles
      const from = end - count * TF_MS[tf] * 3; // extra ruimte voor weekends
      const all = syntheticCandles(instId, tf, from, end);
      return all.slice(-count);
    },
    /** Synthetische quote op basis van de laatste candle + kleine ruis. */
    quote(instId, now = Date.now()) {
      const inst = getInstrument(instId);
      const last = syntheticCandles(instId, 'M5', floorTf(now, 'M5') - 2 * 86_400_000, floorTf(now, 'M5')).at(-1);
      if (!last) return null;
      const rnd = mulberry32(seedFor(instId, Math.floor(now / 2000)));
      const mid = last.c + (rnd() - 0.5) * VOL[instId] * 0.5;
      const half = inst.pip * 0.45;
      return { instrument: instId, bid: Number((mid - half).toFixed(inst.precision)), ask: Number((mid + half).toFixed(inst.precision)), time: now, receivedAt: now, source: 'demo', kind: 'synthetic' };
    },
    startedAt,
  };
}
