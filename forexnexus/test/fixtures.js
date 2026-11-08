// Synthetische softwarefixtures — alleen voor technische tests.
import { TF_MS } from '../src/core/time.js';

/**
 * Reeks die de legacy-BUY exact op de laatste candle triggert. NIET realistisch:
 * met 5-decimale prijzen is de legacy-combinatie (RSI14 < 30 op dezelfde candle
 * als een EMA9/21-kruising omhoog) praktisch onbereikbaar. Deze fixture gebruikt
 * daarom een sterke daling (in het RSI-geheugen), 140 vlakke candles (EMA's
 * convergeren sneller dan het Wilder-geheugen vervaagt) en een stijging van
 * 0,00000032 — ~3% van een tick. Uitsluitend bedoeld om poorten te testen.
 * Signaalcandle: dinsdag 13-01-2026 09:55 UTC (binnen het Londen-venster).
 */
export const LEGACY_TRIGGER_JUMP = 3.1622776601683795e-7;

export function legacyBuySeries({ end = Date.UTC(2026, 0, 13, 9, 55), invert = false, pivot = 1.2 } = {}) {
  const raw = []; let p = 1.3;
  for (let k = 0; k < 100; k += 1) { const o = p; p -= 0.002; raw.push({ o, c: p, h: o + 0.0001, l: p - 0.0001, v: 100 }); }
  for (let k = 0; k < 140; k += 1) raw.push({ o: p, c: p, h: p + 0.0002, l: p - 0.0002, v: 100 });
  raw.push({ o: p, c: p + LEGACY_TRIGGER_JUMP, h: p + 0.0002, l: p - 0.0002, v: 150 });
  const step = TF_MS.M5; const start = end - (raw.length - 1) * step;
  return raw.map((x, k) => {
    let c = { ...x };
    if (invert) { const f = v => 2 * pivot - v; c = { ...c, o: f(x.o), c: f(x.c), h: f(x.l), l: f(x.h) }; }
    const half = 0.00004;
    return { t: start + k * step, ...c, vType: 'tick_count', complete: true, src: 'test', kind: 'real',
      b: { o: c.o - half, h: c.h - half, l: c.l - half, c: c.c - half }, a: { o: c.o + half, h: c.h + half, l: c.l + half, c: c.c + half } };
  });
}

export function freshCalendar(now, events = []) {
  return { source: 'test', fetchedAt: now - 60_000, coverage: { from: now - 3 * 86_400_000, to: now + 5 * 86_400_000 }, events };
}
