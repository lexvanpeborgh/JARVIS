// Indicatoren — exact, causaal en reproduceerbaar.
//
// Elke waarde op index i hangt uitsluitend af van candles 0..i. Daarom leveren
// dezelfde candles in live analyse, replay en backtest dezelfde waarden op.
// Ontbrekende waarden zijn `null` (onvoldoende historie), nooit 0.
//
// EMA(n): seed = rekenkundig gemiddelde (SMA) van de eerste n closes, op index n-1.
//   Daarna EMA_i = close_i * k + EMA_{i-1} * (1-k), k = 2/(n+1).
//   Omdat de seed invloed blijft houden, eist de strategie een extra warm-up
//   (config.minHistory) voordat een signaal geldig mag zijn.
// RSI(n) — Wilder: verandering d_i = close_i - close_{i-1} voor i>=1.
//   Eerste avgGain/avgLoss = gemiddelde van d_1..d_n (gain = max(d,0), loss = max(-d,0)),
//   RSI gedefinieerd vanaf index n. Daarna avg = (avg_prev*(n-1) + x)/n.
//   Randgevallen: avgLoss=0 en avgGain>0 → 100; avgGain=0 en avgLoss>0 → 0;
//   beide 0 (vlakke koers) → 50.
// ATR(n) — Wilder: TR_i = max(H-L, |H-C_{i-1}|, |L-C_{i-1}|) voor i>=1
//   (index 0 heeft geen vorige close en telt niet mee).
//   Eerste ATR op index n = gemiddelde van TR_1..TR_n; daarna Wilder-smoothing.

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i += 1) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function rsiWilder(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let g = 0; let l = 0;
  for (let i = 1; i <= period; i += 1) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  let avgG = g / period; let avgL = l / period;
  out[period] = rsiFrom(avgG, avgL);
  for (let i = period + 1; i < closes.length; i += 1) {
    const d = closes[i] - closes[i - 1];
    const gain = d > 0 ? d : 0; const loss = d < 0 ? -d : 0;
    avgG = (avgG * (period - 1) + gain) / period;
    avgL = (avgL * (period - 1) + loss) / period;
    out[i] = rsiFrom(avgG, avgL);
  }
  return out;
}

function rsiFrom(avgG, avgL) {
  const eps = 1e-15;
  if (avgL <= eps && avgG <= eps) return 50;
  if (avgL <= eps) return 100;
  if (avgG <= eps) return 0;
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
}

export function trueRange(candles) {
  const out = new Array(candles.length).fill(null);
  for (let i = 1; i < candles.length; i += 1) {
    const c = candles[i]; const pc = candles[i - 1].c;
    out[i] = Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc));
  }
  return out;
}

export function atrWilder(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length < period + 1) return out;
  const tr = trueRange(candles);
  let sum = 0;
  for (let i = 1; i <= period; i += 1) sum += tr[i];
  let prev = sum / period;
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i += 1) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

export const INDICATOR_SPEC = Object.freeze({
  ema: 'EMA met SMA-seed over de eerste n closes; k = 2/(n+1).',
  rsi: 'RSI volgens Wilder; seed = gemiddelde winst/verlies van de eerste n veranderingen; vlak = 50.',
  atr: 'ATR volgens Wilder; True Range met vorige close; seed = gemiddelde TR_1..TR_n.',
  priceInput: 'Mid-close (gemiddelde van bid- en ask-close) wanneer bid/ask beschikbaar is.',
});

/** Bereken de standaardset op een reeks gesloten candles. */
export function computeIndicators(candles, p = { emaFast: 9, emaSlow: 21, rsi: 14, atr: 14 }) {
  const closes = candles.map(c => c.c);
  return {
    emaFast: ema(closes, p.emaFast),
    emaSlow: ema(closes, p.emaSlow),
    rsi: rsiWilder(closes, p.rsi),
    atr: atrWilder(candles, p.atr),
    params: { ...p },
  };
}

/** Incrementele uitbreiding: bereken opnieuw over de volledige reeks (deterministisch). */
export function indicatorsAt(ind, i) {
  return {
    emaFast: ind.emaFast[i] ?? null,
    emaSlow: ind.emaSlow[i] ?? null,
    rsi: ind.rsi[i] ?? null,
    atr: ind.atr[i] ?? null,
  };
}
