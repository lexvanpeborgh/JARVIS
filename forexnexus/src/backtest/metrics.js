// Backtestmetrics op R-basis. Afgeleide statistieken (Sharpe, Sortino, CAGR)
// worden bewust NIET berekend: daarvoor ontbreekt een kapitaalbasis en een
// passende returnserie. Rendement wordt in R en geld per eenheid/contract
// uitgedrukt; met een opgegeven risicobedrag per trade ook in geld.

import { zoned } from '../core/time.js';
import { mulberry32 } from '../data/providers/demo.js';
import { EVALUATION_CRITERIA } from '../core/strategies/index.js';

const r2 = (x, d = 3) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

export function summarize(trades, { evaluable = null, barsInPos = null, step = 300_000, riskPerTrade = null } = {}) {
  const t = trades.filter(x => x.status === 'CLOSED' && x.rNet != null);
  const n = t.length;
  const wins = t.filter(x => x.rNet > 0); const losses = t.filter(x => x.rNet <= 0);
  const sum = a => a.reduce((s, x) => s + x, 0);
  const netR = sum(t.map(x => x.rNet)); const grossR = sum(t.map(x => x.rGross ?? 0));
  const gw = sum(wins.map(x => x.rNet)); const gl = -sum(losses.map(x => x.rNet));
  // drawdown op cumulatieve R-curve
  let peak = 0; let eq = 0; let maxDD = 0; let ddStart = null; let maxDDdur = 0; let curStart = null;
  for (const x of t) {
    eq += x.rNet;
    if (eq >= peak) { if (curStart != null) maxDDdur = Math.max(maxDDdur, x.exitT - curStart); peak = eq; curStart = null; }
    else { if (curStart == null) curStart = x.exitT; maxDD = Math.max(maxDD, peak - eq); }
  }
  if (curStart != null && t.length) maxDDdur = Math.max(maxDDdur, t.at(-1).exitT - curStart);
  void ddStart;
  let streak = 0; let maxStreak = 0;
  for (const x of t) { if (x.rNet <= 0) { streak += 1; maxStreak = Math.max(maxStreak, streak); } else streak = 0; }
  const hold = t.map(x => x.holdingMin);
  const spanMs = n ? (t.at(-1).exitT - t[0].entryT) : 0;
  return {
    trades: n,
    undetermined: trades.filter(x => x.status === 'UNDETERMINED').length,
    openAtEnd: trades.filter(x => x.status === 'OPEN_AT_END').length,
    ambiguous: t.filter(x => x.ambiguous).length,
    winrate: n ? r2(wins.length / n, 4) : null,
    avgWinR: wins.length ? r2(gw / wins.length) : null,
    avgLossR: losses.length ? r2(-gl / losses.length) : null,
    expectancyR: n ? r2(netR / n, 4) : null,
    expectancyGrossR: n ? r2(grossR / n, 4) : null,
    expectancyMoney: n && riskPerTrade != null ? r2((netR / n) * riskPerTrade, 2) : null,
    profitFactor: gl > 0 ? r2(gw / gl) : (gw > 0 ? null : null),
    profitFactorNote: gl > 0 ? null : 'Niet gedefinieerd (geen verliezen of geen trades)',
    netR: r2(netR), grossR: r2(grossR),
    netMoney: riskPerTrade != null ? r2(netR * riskPerTrade, 2) : null,
    netPerUnit: n && t.every(x => x.pnlPerUnit != null) ? r2(sum(t.map(x => x.pnlPerUnit)), 6) : null,
    maxDrawdownR: r2(maxDD),
    maxDrawdownDays: r2(maxDDdur / 86_400_000, 1),
    longestLosingStreak: maxStreak,
    avgHoldingMin: n ? r2(sum(hold) / n, 1) : null,
    maxHoldingMin: n ? Math.max(...hold) : null,
    exposurePct: evaluable ? r2((barsInPos / evaluable) * 100, 2) : null,
    tradesPerMonth: spanMs > 0 ? r2(n / (spanMs / (30.44 * 86_400_000)), 2) : null,
    ambiguousOptimisticR: t.filter(x => x.ambiguous).length ? r2(sum(t.map(x => (x.ambiguous ? x.optimisticR : x.rNet))), 3) : null,
  };
}

function groupBy(trades, keyFn) {
  const m = new Map();
  for (const t of trades) { const k = keyFn(t); if (!m.has(k)) m.set(k, []); m.get(k).push(t); }
  return [...m.entries()].sort(([a], [b]) => String(a).localeCompare(String(b)));
}

/** Blokbootstrap van de expectancy (blokken van opeenvolgende trades i.v.m. afhankelijkheid). */
export function blockBootstrap(values, { iterations = 2000, seed = 42, alpha = 0.1 } = {}) {
  const n = values.length;
  if (n < 10) return null;
  const block = Math.max(2, Math.round(Math.sqrt(n)));
  const rnd = mulberry32(seed);
  const means = [];
  for (let it = 0; it < iterations; it += 1) {
    let s = 0; let k = 0;
    while (k < n) {
      const start = Math.floor(rnd() * n);
      for (let b = 0; b < block && k < n; b += 1, k += 1) s += values[(start + b) % n];
    }
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  return { lower: r2(means[Math.floor((alpha / 2) * iterations)], 4), upper: r2(means[Math.floor((1 - alpha / 2) * iterations) - 1], 4), level: 1 - alpha, block, iterations, method: 'Circulaire blokbootstrap op tradevolgorde' };
}

export function computeMetrics(trades, ctx = {}) {
  const closed = trades.filter(x => x.status === 'CLOSED');
  const all = summarize(trades, ctx);
  const bySplit = {};
  for (const s of ['train', 'validation', 'test']) bySplit[s] = summarize(trades.filter(t => t.split === s), {});
  const byYear = groupBy(closed, t => zoned(t.signalT, 'UTC').year).map(([k, v]) => ({ key: String(k), ...pick(summarize(v)) }));
  const byMonth = groupBy(closed, t => zoned(t.signalT, 'UTC').dateKey.slice(0, 7)).map(([k, v]) => ({ key: k, ...pick(summarize(v)) }));
  const bySession = groupBy(closed, t => (t.sessions || []).filter(s => s !== 'asianRange').join('+') || 'geen').map(([k, v]) => ({ key: k, ...pick(summarize(v)) }));
  const byDirection = groupBy(closed, t => t.direction).map(([k, v]) => ({ key: k, ...pick(summarize(v)) }));
  const ci = blockBootstrap(closed.map(t => t.rNet), { seed: ctx.seed });
  // concentratie: draagt één jaar of één trade het resultaat?
  const totalR = closed.reduce((s, t) => s + t.rNet, 0);
  const maxYear = byYear.reduce((m, y) => (Math.abs(y.netR) > Math.abs(m?.netR ?? 0) ? y : m), null);
  const best = closed.reduce((m, t) => (t.rNet > (m?.rNet ?? -Infinity) ? t : m), null);
  const withoutBest = best ? r2(totalR - best.rNet) : null;
  const test = bySplit.test;
  const verdicts = [];
  if (all.trades < EVALUATION_CRITERIA.minTradesTotal || test.trades < EVALUATION_CRITERIA.minTradesTest) verdicts.push({ code: 'INSUFFICIENT_EVIDENCE', text: `ONVOLDOENDE BEWIJS: ${all.trades} trades totaal (min ${EVALUATION_CRITERIA.minTradesTotal}), ${test.trades} in testperiode (min ${EVALUATION_CRITERIA.minTradesTest}).` });
  if (ci && ci.lower <= 0) verdicts.push({ code: 'CI_INCLUDES_ZERO', text: `90%-interval van de expectancy (${ci.lower} R … ${ci.upper} R) omvat nul of minder.` });
  if (test.expectancyR != null && test.expectancyR <= 0) verdicts.push({ code: 'TEST_NOT_POSITIVE', text: `Test-expectancy ${test.expectancyR} R is niet positief.` });
  if (maxYear && totalR > 0 && maxYear.netR / totalR > 0.5 && byYear.length > 1) verdicts.push({ code: 'YEAR_CONCENTRATION', text: `Jaar ${maxYear.key} draagt ${(100 * maxYear.netR / totalR).toFixed(0)}% van de netto R.` });
  if (best && totalR > 0 && withoutBest <= 0) verdicts.push({ code: 'OUTLIER_DEPENDENT', text: 'Zonder de beste trade is het resultaat niet positief.' });
  const passes = verdicts.length === 0;
  return {
    all, bySplit, byYear, byMonth, bySession, byDirection,
    bootstrap: ci,
    concentration: { bestTradeR: best ? r2(best.rNet) : null, netRWithoutBest: withoutBest, dominantYear: maxYear?.key ?? null },
    verdict: { passes, label: passes ? 'VOLDOET AAN VOORAF VASTGELEGDE CRITERIA' : (verdicts[0]?.code === 'INSUFFICIENT_EVIDENCE' ? 'ONVOLDOENDE BEWIJS' : 'VOLDOET NIET'), reasons: verdicts, criteria: EVALUATION_CRITERIA.acceptance },
    notComputed: ['Sharpe', 'Sortino', 'CAGR'].map(k => ({ metric: k, reason: 'Geen kapitaalbasis/returnserie met passende annualisatie; rapportage in R.' })),
  };
}

function pick(s) {
  return { trades: s.trades, winrate: s.winrate, expectancyR: s.expectancyR, netR: s.netR, profitFactor: s.profitFactor, maxDrawdownR: s.maxDrawdownR };
}
