// Causale, event-driven backtestengine.
//
// Volgorde per candle j:
//   1. Een openstaande positie wordt beheerd met de range van candle j
//      (SL/TP-controle aan de juiste zijde: long sluit op bid, short op ask).
//   2. Bij de CLOSE van candle j wordt — als er geen positie is — dezelfde
//      evaluate() aangeroepen als in live analyse, met uitsluitend data 0..j.
//   3. Een BUY/SELL wordt uitgevoerd op de OPEN van de volgende candle
//      (+ optionele vertraging), met spread, slippage en commissie.
// Een signaal op candle j is dus nooit uitvoerbaar op een gunstige prijs binnen j.

import { prepareSeries, evaluate, DEFAULT_LIMITS } from '../core/evaluate.js';
import { DEFAULT_COSTS, unitSize, slippagePrice } from '../core/risk.js';
import { moneyPerUnit, ASSET } from '../core/instruments.js';
import { DEFAULT_SESSIONS, activeSessions } from '../core/sessions.js';
import { TF_MS, iso } from '../core/time.js';
import { computeMetrics } from './metrics.js';
import { mulberry32 } from '../data/providers/demo.js';

export const SCENARIOS = Object.freeze({
  baseline: { label: 'Baseline', spreadMult: 1, extraSlip: 0, delayBars: 0, missRate: 0 },
  adverse: { label: 'Ongunstig (spread ×1,5, +0,3 slippage)', spreadMult: 1.5, extraSlip: 0.3, delayBars: 0, missRate: 0 },
  severe: { label: 'Zwaar (spread ×2, +0,6 slippage, 1 candle vertraging)', spreadMult: 2, extraSlip: 0.6, delayBars: 1, missRate: 0 },
  missed20: { label: '20% gemiste entries (deterministisch)', spreadMult: 1, extraSlip: 0, delayBars: 0, missRate: 0.2 },
});

/** Uitvoerbare bid/ask op de open (of close) van een candle volgens het kostenmodel. */
function sidePrices(c, inst, costs, scen, at = 'o') {
  let bid; let ask;
  if (costs.spreadMode === 'bidask' && c.b && c.a) { bid = c.b[at]; ask = c.a[at]; }
  else {
    const sp = (costs.modelSpread?.[inst.id] ?? 1) * unitSize(inst);
    bid = c[at] - sp / 2; ask = c[at] + sp / 2;
  }
  const extraHalf = (ask - bid) * (scen.spreadMult - 1) / 2;
  return { bid: bid - extraHalf, ask: ask + extraHalf, mid: (bid + ask) / 2 };
}

function sideRange(c, inst, costs, scen) {
  // bid/ask high/low van de candle (voor SL/TP-detectie)
  if (costs.spreadMode === 'bidask' && c.b && c.a) {
    const extra = (c.a.c - c.b.c) * (scen.spreadMult - 1) / 2;
    return { bidH: c.b.h - extra, bidL: c.b.l - extra, askH: c.a.h + extra, askL: c.a.l + extra, bidO: c.b.o - extra, askO: c.a.o + extra };
  }
  const sp = (costs.modelSpread?.[inst.id] ?? 1) * unitSize(inst) * scen.spreadMult;
  return { bidH: c.h - sp / 2, bidL: c.l - sp / 2, askH: c.h + sp / 2, askL: c.l + sp / 2, bidO: c.o - sp / 2, askO: c.o + sp / 2 };
}

export function runBacktest(opts) {
  const {
    candles, inst, tf = 'M5', strategy, costs = DEFAULT_COSTS, scenario = 'baseline',
    newsMode = 'off', calendar = null, sessions = DEFAULT_SESSIONS, limits = {}, accountCcy = 'USD', rates = {},
    riskPerTrade = null, seed = 42, meta = {},
  } = opts;
  const scen = typeof scenario === 'string' ? { key: scenario, ...SCENARIOS[scenario] } : scenario;
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const effCosts = { ...costs, slippagePerSide: (costs.slippagePerSide || 0) + scen.extraSlip };
  const series = prepareSeries(candles, inst, tf, strategy, { sessions });
  const step = TF_MS[tf];
  const slip = slippagePrice(inst, effCosts);
  const rnd = mulberry32(seed);
  const trades = []; const skipped = []; const decisions = [];
  let pos = null; let lastSignalIndex = null; let barsInPos = 0; let evaluable = 0;
  const firstEval = strategy.minHistory - 1;
  const commPerSideMoney = inst.assetClass === ASSET.FUTURE ? (effCosts.commissionPerSidePerContract || 0) : (effCosts.commissionPerSidePerUnit || 0);

  const closeTrade = (j, px, reasonCode, extra = {}) => {
    const t = pos;
    const long = t.direction === 'LONG';
    const exitMid = extra.exitMid ?? px;
    const risk = Math.abs(t.entryFill - t.plan.sl);
    const pnlPrice = long ? px - t.entryFill : t.entryFill - px;
    const commMoney = commPerSideMoney * 2;
    const valPerPrice = moneyPerUnit(inst, 1, accountCcy, rates); // geld per 1.0 prijs per eenheid/contract
    const commPrice = valPerPrice ? commMoney / valPerPrice : 0;
    const grossPrice = long ? exitMid - t.entryMid : t.entryMid - exitMid;
    t.exitT = candles[j].t; t.exitIndex = j; t.exitPx = px; t.exitReason = reasonCode;
    t.status = extra.status || 'CLOSED';
    t.rNet = risk > 0 ? (pnlPrice - commPrice) / risk : null;
    t.rGross = risk > 0 ? grossPrice / risk : null;
    t.pnlPerUnit = valPerPrice ? (pnlPrice - commPrice) * valPerPrice : null;
    t.pnlMoney = riskPerTrade != null && t.rNet != null ? t.rNet * riskPerTrade : null;
    t.holdingMin = (candles[j].t + step - t.entryT) / 60_000;
    t.ambiguous = !!extra.ambiguous;
    if (extra.optimisticR != null) t.optimisticR = extra.optimisticR;
    t.mfeR = risk > 0 ? t.mfe / risk : null; t.maeR = risk > 0 ? t.mae / risk : null;
    trades.push(t);
    pos = null;
  };

  for (let j = 0; j < candles.length; j += 1) {
    const c = candles[j];
    // ---- 1. positiebeheer ----
    if (pos && j >= pos.entryIndex) {
      // datagat tijdens positie → uitkomst onbepaalbaar
      if (j > pos.entryIndex && series.gapAfter.has(j - 1)) {
        pos.gapNote = `Datagat na ${iso(candles[j - 1].t)}`;
        closeTrade(j, sidePrices(c, inst, effCosts, scen, 'o')[pos.direction === 'LONG' ? 'bid' : 'ask'], 'DATA_GAP', { status: 'UNDETERMINED' });
      } else {
        barsInPos += 1;
        const r = sideRange(c, inst, effCosts, scen);
        const long = pos.direction === 'LONG';
        const sl = pos.plan.sl; const tp = pos.plan[pos.plan.exitTarget];
        const midH = c.h; const midL = c.l;
        pos.mfe = Math.max(pos.mfe, long ? midH - pos.entryMid : pos.entryMid - midL);
        pos.mae = Math.max(pos.mae, long ? pos.entryMid - midL : midH - pos.entryMid);
        const openPx = long ? r.bidO : r.askO;
        const gapThroughStop = j > pos.entryIndex && (long ? openPx <= sl : openPx >= sl);
        const hitSL = long ? r.bidL <= sl : r.askH >= sl;
        const hitTP = tp != null && (long ? r.bidH >= tp : r.askL <= tp);
        if (gapThroughStop) {
          // gap voorbij de stop: bereikbare prijs = open, niet de stopprijs
          const px = long ? openPx - slip : openPx + slip;
          closeTrade(j, px, 'SL_GAP', { exitMid: c.o });
        } else if (hitSL && hitTP) {
          // volgorde binnen de candle onbekend → conservatief: SL eerst
          const px = long ? sl - slip : sl + slip;
          const risk = Math.abs(pos.entryFill - sl);
          const optimisticR = risk > 0 ? (long ? tp - pos.entryFill : pos.entryFill - tp) / risk : null;
          closeTrade(j, px, 'SL_AMBIGUOUS', { ambiguous: true, optimisticR, exitMid: sl });
        } else if (hitSL) {
          closeTrade(j, long ? sl - slip : sl + slip, 'SL', { exitMid: sl });
        } else if (hitTP) {
          closeTrade(j, tp, 'TP', { exitMid: tp });
        }
      }
    }
    if (j < firstEval) continue;
    evaluable += 1;
    if (pos || j >= candles.length - 1) continue;
    // ---- 2. evaluatie bij de close ----
    const qc = sidePrices(c, inst, effCosts, scen, 'c');
    const closeT = c.t + step;
    const d = evaluate(series, j, strategy, {
      mode: 'backtest', now: closeT,
      quote: { bid: qc.bid, ask: qc.ask, time: closeT, source: 'candle-close' },
      calendar, newsMode, sessions, limits: lim, costs: effCosts, accountCcy, rates,
      state: { lastSignalIndex },
    });
    if (d.state === 'BUY' || d.state === 'SELL' || d.state === 'NO_TRADE') decisions.push(compactDecision(d, j));
    if (d.state !== 'BUY' && d.state !== 'SELL') continue;
    lastSignalIndex = j;
    // ---- 3. uitvoering op de volgende open ----
    const k = j + 1 + (scen.delayBars || 0);
    const sig = { signalIndex: j, signalT: c.t, direction: d.direction, entryRef: d.entryRef, plan: d.plan, sessions: activeSessions(c.t, sessions), conditions: d.conditions.map(x => x.id) };
    if (k >= candles.length) { skipped.push({ ...sig, reason: 'END_OF_DATA' }); continue; }
    const nc = candles[k];
    const expectedT = closeT + (scen.delayBars || 0) * step;
    if (nc.t !== expectedT) { skipped.push({ ...sig, reason: 'TTL_EXPIRED', detail: 'Volgende candle niet direct beschikbaar (gat/weekend)' }); continue; }
    if (scen.missRate > 0 && rnd() < scen.missRate) { skipped.push({ ...sig, reason: 'MISSED_SCENARIO' }); continue; }
    const px = sidePrices(nc, inst, effCosts, scen, 'o');
    const long = d.direction === 'LONG';
    const fill = long ? px.ask + slip : px.bid - slip;
    const moved = long ? fill - d.entryRef : d.entryRef - fill;
    if (moved > d.plan.maxEntryDeviation) { skipped.push({ ...sig, reason: 'ENTRY_MISSED', detail: `afwijking ${moved.toFixed(inst.precision)}` }); continue; }
    if (long ? px.bid <= d.plan.sl : px.ask >= d.plan.sl) { skipped.push({ ...sig, reason: 'ENTRY_MISSED', detail: 'stop al geraakt op de open' }); continue; }
    pos = { ...sig, id: `${strategy.id}-${inst.id}-${c.t}`, entryIndex: k, entryT: nc.t, entryFill: fill, entryMid: px.mid, mfe: 0, mae: 0 };
  }
  if (pos) { const last = candles.length - 1; closeTrade(last, candles[last].c, 'OPEN_AT_END', { status: 'OPEN_AT_END' }); }

  const span = { from: candles[0]?.t ?? null, to: candles.at(-1)?.t ?? null };
  const splits = splitBounds(candles, firstEval);
  for (const t of trades) {
    t.split = t.signalT < splits.valFrom ? 'train' : t.signalT < splits.testFrom ? 'validation' : 'test';
    t.crossesBoundary = (t.signalT < splits.valFrom && t.exitT >= splits.valFrom) || (t.signalT < splits.testFrom && t.exitT >= splits.testFrom);
  }
  const metrics = computeMetrics(trades, { evaluable, barsInPos, step, span, seed, riskPerTrade, splits });
  return {
    meta: {
      ...meta, strategy: { id: strategy.id, version: strategy.version, params: strategy.params }, instrument: inst.id, timeframe: tf,
      scenario: scen, costs: effCosts, newsMode, executionModel: 'Candlemodel: uitvoering op de volgende beschikbare open met spread en slippage; SL eerst bij onbekende volgorde binnen een candle; gap voorbij stop vult op de open.',
      dataKind: series.kind, provider: series.provider, candles: candles.length, warmupBars: firstEval, evaluableBars: evaluable,
      gaps: series.gaps.length, missingCandles: series.gaps.reduce((s, g) => s + g.missing, 0), span: { from: iso(span.from), to: iso(span.to) },
      splits: { trainFrom: iso(span.from), valFrom: iso(splits.valFrom), testFrom: iso(splits.testFrom), to: iso(span.to) },
      limits: lim, accountCcy, riskPerTrade,
    },
    trades, skipped, decisions, metrics,
  };
}

function compactDecision(d, j) {
  return { index: j, t: d.candleTime, state: d.state, direction: d.direction, blockers: d.blockers.map(b => b.code), entryRef: d.entryRef, sl: d.plan?.sl ?? null, tp1: d.plan?.tp1 ?? null, tp2: d.plan?.tp2 ?? null };
}

export function splitBounds(candles, firstEval = 0) {
  const usable = candles.slice(firstEval);
  if (!usable.length) return { valFrom: Infinity, testFrom: Infinity };
  const a = usable[0].t; const b = usable.at(-1).t;
  return { valFrom: a + (b - a) * 0.6, testFrom: a + (b - a) * 0.8 };
}

/** Parametergevoeligheid: varianten op dezelfde data, NIET gebruikt voor selectie. */
export function sensitivity(baseOpts, variants) {
  return variants.map(v => {
    const strat = Object.create(baseOpts.strategy);
    strat.params = { ...baseOpts.strategy.params, ...v.params };
    const r = runBacktest({ ...baseOpts, strategy: strat });
    return { label: v.label, params: v.params, trades: r.metrics.all.trades, expectancyR: r.metrics.all.expectancyR, netR: r.metrics.all.netR, profitFactor: r.metrics.all.profitFactor, maxDrawdownR: r.metrics.all.maxDrawdownR };
  });
}

export const SENSITIVITY_VARIANTS = {
  EMA_RSI_WINDOW: [
    { label: 'RSI-venster 5', params: { rsiWindow: 5 } },
    { label: 'RSI-venster 20', params: { rsiWindow: 20 } },
    { label: 'RSI 25/75', params: { rsiBuyBelow: 25, rsiSellAbove: 75 } },
  ],
  LEGACY_EMA_RSI_VOL: [
    { label: 'RSI 25/75', params: { rsiBuyBelow: 25, rsiSellAbove: 75 } },
    { label: 'RSI 35/65', params: { rsiBuyBelow: 35, rsiSellAbove: 65 } },
    { label: 'SL 1,5 × ATR', params: { slAtr: 1.5 } },
  ],
  LEGACY_EMA_RSI_VOL_ATR4: [
    { label: 'RSI 25/75', params: { rsiBuyBelow: 25, rsiSellAbove: 75 } },
    { label: 'RSI 35/65', params: { rsiBuyBelow: 35, rsiSellAbove: 65 } },
  ],
  STRUCT_SWEEP_MSS: [
    { label: 'Displacement 0,6 × ATR', params: { displacementAtr: 0.6 } },
    { label: 'Displacement 1,0 × ATR', params: { displacementAtr: 1.0 } },
    { label: 'Min. RR 1,5', params: { minRR: 1.5 } },
    { label: 'Min. RR 2,5', params: { minRR: 2.5 } },
  ],
};
