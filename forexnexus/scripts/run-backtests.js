// Voert de vastgelegde backtestmatrix uit op beschikbare data en schrijft
// rapporten + trade-exports naar reports/. Echte historische data wordt
// gebruikt wanneer een CSV in data/history/<INSTRUMENT>_M5.csv staat;
// anders draait de run op SYNTHETISCHE softwarefixtures (geen bewijs).

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBacktest, sensitivity, SENSITIVITY_VARIANTS, SCENARIOS } from '../src/backtest/engine.js';
import { STRATEGIES } from '../src/core/strategies/index.js';
import { getInstrument } from '../src/core/instruments.js';
import { syntheticCandles } from '../src/data/providers/demo.js';
import { parseCsv, rowsToCandles } from '../src/data/import.js';
import { validateCandles } from '../src/core/quality.js';
import { reportHtml, tradesCsv } from '../src/server/services.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'reports', 'backtests');
mkdirSync(OUT, { recursive: true });
const rows = []; const quality = [];

for (const instId of ['EUR_USD', 'GBP_USD', 'USD_JPY']) {
  const inst = getInstrument(instId);
  const csv = join(ROOT, 'data', 'history', `${instId}_M5.csv`);
  let candles; let kind; let source;
  if (existsSync(csv)) {
    const { header, rows: r } = parseCsv(readFileSync(csv, 'utf8'));
    const v = validateCandles(rowsToCandles(header, r, { volumeType: 'tick_count' }).candles, { inst, tf: 'M5' });
    candles = v.clean; kind = 'real'; source = csv; quality.push({ instrument: instId, ...v.report });
  } else {
    candles = syntheticCandles(instId, 'M5', Date.UTC(2026, 0, 5), Date.UTC(2026, 6, 5));
    kind = 'synthetic'; source = 'syntheticCandles(seed 7) 2026-01-05 → 2026-07-05';
    quality.push({ instrument: instId, ...validateCandles(candles, { inst, tf: 'M5' }).report, note: 'synthetisch' });
  }
  for (const strategy of Object.values(STRATEGIES)) {
    const base = { candles, inst, strategy, meta: { datasetId: source, dataKind: kind, priceType: 'BA', volumeType: candles[0].vType } };
    const main = runBacktest({ ...base, scenario: 'baseline' });
    const scenarios = {};
    for (const k of Object.keys(SCENARIOS)) { const r = k === 'baseline' ? main : runBacktest({ ...base, scenario: k }); const a = r.metrics.all; scenarios[k] = { label: SCENARIOS[k].label, trades: a.trades, winrate: a.winrate, expectancyR: a.expectancyR, netR: a.netR, grossR: a.grossR, profitFactor: a.profitFactor, maxDrawdownR: a.maxDrawdownR }; }
    const sens = sensitivity({ ...base, scenario: 'baseline' }, SENSITIVITY_VARIANTS[strategy.id] || []);
    const id = `${kind}-${strategy.id}-${instId}`;
    const bt = { id, data_kind: kind, meta: { ...main.meta, scenarios, skippedReasons: count(main.skipped.map(s => s.reason)) }, metrics: main.metrics, sensitivity: sens,
      trades: main.trades.map((t, k) => ({ idx: k, ...t })), skipped: main.skipped.map((t, k) => ({ idx: 1_000_000 + k, ...t, status: 'SKIPPED' })) };
    writeFileSync(join(OUT, `${id}.html`), reportHtml(bt));
    writeFileSync(join(OUT, `${id}-trades.csv`), tradesCsv(bt));
    const blockers = count(main.decisions.flatMap(d => d.blockers));
    rows.push({ id, instrument: instId, strategy: `${strategy.id} v${strategy.version}`, kind, candles: candles.length, period: main.meta.span, trades: main.metrics.all.trades, skipped: main.skipped.length, decisions: main.decisions.length, expectancyR: main.metrics.all.expectancyR, netR: main.metrics.all.netR, verdict: main.metrics.verdict.label, blockers });
    console.log(`${id}: ${main.metrics.all.trades} trades, ${main.decisions.length} beslissingen, oordeel ${main.metrics.verdict.label}`);
  }
}

function count(a) { const o = {}; for (const x of a) o[x] = (o[x] || 0) + 1; return o; }

writeFileSync(join(ROOT, 'reports', 'backtest-summary.json'), JSON.stringify({ generatedAt: new Date().toISOString(), rows, quality }, null, 2));
const md = ['# Backtestoverzicht', '', `Gegenereerd: ${new Date().toISOString()}`, '',
  rows.some(r => r.kind === 'real') ? '' : '> **Alle runs hieronder gebruiken SYNTHETISCHE softwarefixtures.** Er was geen echte historische data beschikbaar (OANDA niet gekoppeld, geen CSV/Parquet aangeleverd). Deze cijfers bewijzen niets over handelsrendement; ze tonen alleen dat de engine werkt.', '',
  '| Instrument | Strategie | Data | Candles | Signalen (BUY/SELL/NO TRADE) | Trades | Expectancy R | Netto R | Oordeel | Meest voorkomende blokkades |', '|---|---|---|---|---|---|---|---|---|---|',
  ...rows.map(r => `| ${r.instrument} | ${r.strategy} | ${r.kind === 'real' ? 'ECHT' : 'SYNTHETISCH'} | ${r.candles} | ${r.decisions} | ${r.trades} | ${r.expectancyR ?? '—'} | ${r.netR} | ${r.verdict} | ${Object.entries(r.blockers).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${v}`).join(', ') || '—'} |`),
  '', 'Kostenscenario\'s, splits, jaar/maand/sessie en parametergevoeligheid: zie de HTML-rapporten in `reports/backtests/`.'];
writeFileSync(join(ROOT, 'reports', 'BACKTESTS.md'), md.join('\n'));
