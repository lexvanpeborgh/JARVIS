// De ene gezaghebbende beslisfunctie. Live analyse, paper trading, replay en
// backtest roepen allemaal `evaluate(series, i, env)` aan op een GESLOTEN
// candle i. Alleen de omgevingsgegevens (quote, klok, kalender) verschillen per
// modus; de regels zijn identiek.

import { computeIndicators } from './indicators.js';
import { analyzeStructure } from './structure.js';
import { findGaps } from './quality.js';
import { marketStatus, inWindow, DEFAULT_SESSIONS, activeSessions } from './sessions.js';
import { newsCheck, DEFAULT_NEWS_POLICY } from './news.js';
import { buildPlan, DEFAULT_COSTS, unitSize } from './risk.js';
import { reason } from './reasons.js';
import { TF_MS, iso } from './time.js';
import { ASSET } from './instruments.js';

export const DEFAULT_LIMITS = Object.freeze({
  maxQuoteAgeSec: 5,
  maxEvalDelaySec: 45,
  entryTtlSec: 60,
  maxEntryDeviationAtr: 0.25, // maximale afwijking tussen entryreferentie en uitvoerbare prijs
  cooldownBars: 6,
  gapLookbackBars: 50,
});

/** Bereid een reeks voor: indicatoren, structuur en gaten — eenmalig en causaal. */
export function prepareSeries(candles, inst, tf, strategy, opts = {}) {
  const p = strategy.params;
  const ind = computeIndicators(candles, { emaFast: p.emaFast || 9, emaSlow: p.emaSlow || 21, rsi: p.rsi || 14, atr: p.atr || 14 });
  const series = { candles, inst, tf, ind, provider: opts.provider || candles[0]?.src || null, kind: opts.kind || candles[0]?.kind || 'real' };
  series.structure = strategy.needsStructure || opts.withStructure ? analyzeStructure(candles, ind.atr, { ...p, asianRange: opts.sessions?.asianRange }) : null;
  series.gaps = findGaps(candles, { inst, tf });
  series.gapAfter = new Set(series.gaps.map(g => g.afterIndex));
  return series;
}

function spreadOf(q) { return q && q.ask != null && q.bid != null ? q.ask - q.bid : null; }

/**
 * env:
 *   mode: 'live' | 'paper' | 'replay' | 'backtest' | 'demo'
 *   now: ms (live) — in replay/backtest het sluitmoment van candle i
 *   quote: { bid, ask, time, receivedAt } — in backtest afgeleid van de candle-close
 *   calendar, newsPolicy, sessions, limits, costs, accountCcy, rates
 *   state: { lastSignalIndex, lastSignalTime, existingKeys:Set }
 */
export function evaluate(series, i, strategy, env = {}) {
  const { candles, inst, tf, ind } = series;
  const limits = { ...DEFAULT_LIMITS, ...(env.limits || {}) };
  const sessions = env.sessions || DEFAULT_SESSIONS;
  const newsPolicy = env.newsPolicy || DEFAULT_NEWS_POLICY;
  const costs = env.costs || DEFAULT_COSTS;
  const c = candles[i];
  const closeTime = c.t + TF_MS[tf];
  const now = env.now ?? closeTime;
  const blockers = []; const missing = []; const info = [];
  const block = (code, detail) => blockers.push(reason(code, detail));

  const base = {
    strategy: { id: strategy.id, version: strategy.version, family: strategy.family, name: strategy.name },
    instrument: inst.id, timeframe: tf, mode: env.mode || 'live',
    candleTime: c.t, candleCloseTime: closeTime, evaluatedAt: now,
    candleIso: iso(c.t), dataKind: series.kind, provider: series.provider,
  };

  // --- omgevingspoorten ---
  const mkt = marketStatus(inst, now, env.marketCfg);
  if (!mkt.open) block('MARKET_CLOSED', mkt.text);
  if (i < 1 || i + 1 < strategy.minHistory) block('INSUFFICIENT_HISTORY', `${i + 1} van ${strategy.minHistory} vereiste candles`);
  if (c.complete === false) block('CANDLE_INCOMPLETE');
  const indOk = ind.atr[i] != null && ind.rsi[i] != null && ind.emaSlow[i] != null && ind.emaSlow[i - 1] != null;
  if (!indOk) block('INDICATORS_INVALID', 'Warm-up nog niet voltooid');
  for (let k = Math.max(0, i - limits.gapLookbackBars); k < i; k += 1) {
    if (series.gapAfter.has(k)) { block('DATA_GAP', `Gat na ${iso(candles[k].t)}`); break; }
  }
  if (strategy.requiresVolume && (c.v == null || !c.vType || c.vType === 'none')) block('VOLUME_UNAVAILABLE');
  if (env.expectedProvider && series.provider && env.expectedProvider !== series.provider) block('PROVIDER_MISMATCH', `${series.provider} ≠ ${env.expectedProvider}`);
  if (inst.assetClass === ASSET.FUTURE && env.contract && c.contract && env.contract !== c.contract) block('CONTRACT_MISMATCH', `${c.contract} ≠ ${env.contract}`);

  const q = env.quote || null;
  const live = ['live', 'paper', 'demo'].includes(base.mode);
  if (live) {
    if (!q || q.bid == null || q.ask == null) block('QUOTE_MISSING');
    else {
      const age = (now - q.time) / 1000;
      if (age > limits.maxQuoteAgeSec) block('QUOTE_STALE', `${age.toFixed(1)} s oud (max ${limits.maxQuoteAgeSec} s)`);
    }
    const delay = (now - closeTime) / 1000;
    if (delay > limits.maxEvalDelaySec) block('EVALUATION_LATE', `${delay.toFixed(0)} s na de close (max ${limits.maxEvalDelaySec} s)`);
  }
  const spread = spreadOf(q);
  const atr = ind.atr[i];
  if (spread != null) {
    if (inst.assetClass === ASSET.FX_SPOT) {
      const sp = spread / inst.pip;
      if (inst.limits.maxSpreadPips != null && sp > inst.limits.maxSpreadPips) block('SPREAD_TOO_WIDE_ABS', `${sp.toFixed(1)} pips > ${inst.limits.maxSpreadPips}`);
    } else if (inst.assetClass === ASSET.FUTURE) {
      const ticks = Math.round(spread / inst.tick);
      if (inst.limits.maxSpreadTicks != null && ticks > inst.limits.maxSpreadTicks) block('SPREAD_TOO_WIDE_ABS', `${ticks} ticks > ${inst.limits.maxSpreadTicks}`);
    }
    if (atr && inst.limits.maxSpreadAtrFrac != null && spread / atr > inst.limits.maxSpreadAtrFrac) block('SPREAD_TOO_WIDE_ATR', `spread = ${(spread / atr).toFixed(2)} × ATR > ${inst.limits.maxSpreadAtrFrac}`);
  }
  // sessie: de signaalcandle (openingstijd) moet in een toegestaan venster vallen
  const allowed = (env.allowedSessions || strategy.sessions || []);
  const sessOk = allowed.length === 0 || allowed.some(k => sessions[k] && inWindow(c.t, sessions[k]));
  if (!sessOk) block('SESSION_NOT_ALLOWED', `Toegestaan: ${allowed.map(k => sessions[k]?.label || k).join(', ')}`);
  // nieuws
  let news = null;
  if (env.newsMode !== 'off') {
    news = newsCheck(inst, now, env.calendar, newsPolicy);
    if (newsPolicy.required && !news.status.ok) block(news.status.code, news.status.text);
    if (news.active) block('NEWS_BLACKOUT', `${news.active.event.currency} ${news.active.event.title} om ${iso(news.active.event.time)} (${news.active.rule}: −${news.active.before}/+${news.active.after} min)`);
    else if (news.next) {
      const bos = news.next; // waarschuwing als blackout binnen TTL begint
      const startsIn = (bos.time - now) / 60_000;
      if (startsIn < (newsPolicy.highImpact.before + limits.entryTtlSec / 60)) info.push(`Volgend relevant nieuws over ${Math.round(startsIn)} min: ${bos.currency} ${bos.title}.`);
    }
  } else {
    missing.push('Nieuwsfilter staat uit voor deze evaluatie.');
  }
  // cooldown & duplicaat
  const st = env.state || {};
  if (st.lastSignalIndex != null && i - st.lastSignalIndex < limits.cooldownBars && i !== st.lastSignalIndex) block('COOLDOWN', `${i - st.lastSignalIndex} van ${limits.cooldownBars} candles`);
  if (st.lastSignalTime != null && st.lastSignalIndex == null && closeTime - st.lastSignalTime < limits.cooldownBars * TF_MS[tf] && closeTime !== st.lastSignalTime) block('COOLDOWN');

  // --- strategie ---
  let setup = { triggered: null, direction: null, conditions: [], preparing: false, against: [], levels: null, evidence: {} };
  if (indOk && i >= 1) setup = strategy.setup(series, i, env);
  const key = setup.triggered ? signalKey(strategy, inst.id, tf, c.t, setup.triggered) : null;
  if (key && st.existingKeys && st.existingKeys.has(key)) block('DUPLICATE_SIGNAL');

  let plan = null; let entryRef = null; let levelsMeta = null;
  if (setup.triggered && setup.levels && atr) {
    const long = setup.triggered === 'LONG';
    entryRef = q ? (long ? q.ask : q.bid) : null;
    if (entryRef == null) { block('QUOTE_MISSING', 'Geen uitvoerbare entryreferentie'); }
    else {
      levelsMeta = setup.levels(entryRef);
      if (levelsMeta.rrCheck) {
        if (!levelsMeta.rrCheck.hasTarget) block('NO_TARGET');
        else if (!levelsMeta.rrCheck.ok) block('RR_BELOW_MIN', `bruto RR ${levelsMeta.rrCheck.rr.toFixed(2)} < ${levelsMeta.rrCheck.min}`);
      }
      if (levelsMeta.sl != null && (levelsMeta.tp1 != null || levelsMeta.tp2 != null)) {
        plan = buildPlan({ inst, direction: setup.triggered, entry: entryRef, sl: levelsMeta.sl, tp1: levelsMeta.tp1, tp2: levelsMeta.tp2, costs, accountCcy: env.accountCcy || 'USD', rates: env.rates || {}, tp1Role: levelsMeta.tp1Role, exitTarget: levelsMeta.exitTarget });
        plan.tp1Name = levelsMeta.tp1Name || null; plan.tp2Name = levelsMeta.tp2Name || null;
        if (!plan.valid) block('INVALID_LEVELS', plan.errors.join(', '));
        plan.maxEntryDeviation = limits.maxEntryDeviationAtr * atr;
        plan.maxEntryDeviationUnits = Number((plan.maxEntryDeviation / unitSize(inst)).toFixed(1));
      }
    }
  }

  // --- toestand ---
  let state;
  if (setup.triggered) state = blockers.length ? 'NO_TRADE' : (setup.triggered === 'LONG' ? 'BUY' : 'SELL');
  else if (setup.preparing) state = 'WAIT';
  else state = 'NONE';
  const conditions = setup.conditions || [];
  const passed = conditions.filter(x => x.ok).length;
  const alertable = (state === 'BUY' || state === 'SELL') && series.kind === 'real' && ['live', 'paper'].includes(base.mode);
  if ((state === 'BUY' || state === 'SELL') && series.kind !== 'real') info.push('Synthetische data: geen live entrymelding.');
  if (base.mode === 'replay') info.push('Historische replay: geen live entrymelding.');

  const sessionsNow = activeSessions(c.t, sessions);
  return {
    ...base,
    state,
    direction: setup.triggered || setup.direction || null,
    actionLabel: actionLabel(state),
    key,
    alertable,
    conditions,
    ruleScore: { passed, total: conditions.length, meaning: 'Aantal expliciete regels dat klopt — geen winstkans.' },
    blockers,
    against: setup.against || [],
    awaiting: setup.awaiting || null,
    missing,
    info,
    plan,
    entryRef,
    entryType: plan ? `Market ${setup.triggered === 'LONG' ? 'buy (ask)' : 'sell (bid)'}` : null,
    invalidation: setup.invalidation || null,
    expiresAt: plan ? now + limits.entryTtlSec * 1000 : null,
    exitRule: strategy.exit?.text,
    snapshot: {
      candle: { t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v ?? null, vType: c.vType || null, complete: c.complete !== false },
      indicators: { emaFast: ind.emaFast[i], emaSlow: ind.emaSlow[i], rsi: ind.rsi[i], atr, emaFastPrev: ind.emaFast[i - 1] ?? null, emaSlowPrev: ind.emaSlow[i - 1] ?? null },
      evidence: setup.evidence || {},
      quote: q ? { bid: q.bid, ask: q.ask, time: q.time, receivedAt: q.receivedAt ?? null, ageSec: q.time != null ? Number(((now - q.time) / 1000).toFixed(1)) : null, source: q.source || series.provider } : null,
      spread: spread == null ? null : { price: spread, units: Number((spread / unitSize(inst)).toFixed(2)), unit: inst.assetClass === ASSET.FX_SPOT ? 'pips' : 'ticks', atrFrac: atr ? Number((spread / atr).toFixed(3)) : null },
      market: mkt,
      sessions: sessionsNow,
      sessionOk: sessOk,
      news: news ? { status: news.status, active: news.active ? { title: news.active.event.title, currency: news.active.event.currency, time: news.active.event.time, rule: news.active.rule } : null, next: news.next ? { title: news.next.title, currency: news.next.currency, time: news.next.time, impact: news.next.impact } : null, minutesToNext: news.minutesToNext } : null,
      params: strategy.params,
      limits,
      costs: { spreadMode: costs.spreadMode, slippagePerSide: costs.slippagePerSide },
    },
  };
}

export function signalKey(strategy, instId, tf, candleT, dir) {
  return `${strategy.id}@${strategy.version}|${instId}|${tf}|${candleT}|${dir}`;
}

export function actionLabel(state) {
  return {
    BUY: 'BUY — mogelijke longentry',
    SELL: 'SELL — mogelijke shortentry',
    WAIT: 'WAIT — voorbereiding, nog niet bevestigd',
    NO_TRADE: 'NO TRADE — entry geblokkeerd',
    NONE: 'GEEN SETUP',
  }[state];
}

/** Controle vlak vóór uitvoering of verzending: is de entry nog geldig? */
export function entryStillValid(signal, quote, now, limits = DEFAULT_LIMITS) {
  if (signal.expiresAt != null && now > signal.expiresAt) return reason('TTL_EXPIRED');
  if (!quote || quote.bid == null || quote.ask == null) return reason('QUOTE_MISSING');
  if ((now - quote.time) / 1000 > limits.maxQuoteAgeSec) return reason('QUOTE_STALE');
  const px = signal.direction === 'LONG' ? quote.ask : quote.bid;
  const dev = signal.plan.maxEntryDeviation;
  const moved = signal.direction === 'LONG' ? px - signal.entryRef : signal.entryRef - px;
  if (dev != null && moved > dev) return reason('ENTRY_MISSED', `koers ${moved.toFixed(6)} in de richting doorgelopen (max ${dev.toFixed(6)})`);
  // stop al geraakt vóór entry?
  if (signal.direction === 'LONG' ? quote.bid <= signal.plan.sl : quote.ask >= signal.plan.sl) return reason('ENTRY_MISSED', 'stop-loss al geraakt');
  return null;
}
