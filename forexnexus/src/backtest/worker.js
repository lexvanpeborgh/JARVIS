// Backtests draaien in een worker thread zodat de live engine niet blokkeert.
import { parentPort, workerData } from 'node:worker_threads';
import { runBacktest, sensitivity, SENSITIVITY_VARIANTS, SCENARIOS } from './engine.js';
import { getStrategy } from '../core/strategies/index.js';
import { getInstrument } from '../core/instruments.js';

const { candles, instrument, strategyId, opts } = workerData;
try {
  const inst = getInstrument(instrument);
  const strategy = getStrategy(strategyId);
  const base = { ...opts, candles, inst, strategy };
  const main = runBacktest({ ...base, scenario: 'baseline' });
  const scenarios = {};
  for (const k of Object.keys(SCENARIOS)) {
    const r = k === 'baseline' ? main : runBacktest({ ...base, scenario: k });
    scenarios[k] = { label: SCENARIOS[k].label, ...pickAll(r.metrics.all), skipped: r.skipped.length };
  }
  const sens = sensitivity({ ...base, scenario: 'baseline' }, SENSITIVITY_VARIANTS[strategyId] || []);
  parentPort.postMessage({ ok: true, result: { ...main, scenarios, sensitivity: sens } });
} catch (e) {
  parentPort.postMessage({ ok: false, error: e.message, stack: e.stack });
}

function pickAll(a) {
  return { trades: a.trades, winrate: a.winrate, expectancyR: a.expectancyR, expectancyGrossR: a.expectancyGrossR, netR: a.netR, grossR: a.grossR, profitFactor: a.profitFactor, maxDrawdownR: a.maxDrawdownR };
}
