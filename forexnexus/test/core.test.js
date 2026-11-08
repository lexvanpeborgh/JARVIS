import test from 'node:test';
import assert from 'node:assert/strict';
import { ema, rsiWilder, atrWilder, trueRange } from '../src/core/indicators.js';
import { getInstrument, roundToTick, distance, pipValuePerUnit, frontContract, moneyPerUnit } from '../src/core/instruments.js';
import { buildPlan, positionSize, legacyLevels } from '../src/core/risk.js';
import { fxMarketStatus, inWindow, DEFAULT_SESSIONS, windowBounds, cmeEquityStatus } from '../src/core/sessions.js';
import { validateCandles } from '../src/core/quality.js';
import { calendarStatus, blackouts, classify } from '../src/core/news.js';
import { parseCsv, rowsToCandles } from '../src/data/import.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);

test('EMA: SMA-seed op index n-1 en recursie', () => {
  const v = [1, 2, 3, 4, 5, 6];
  const e = ema(v, 3);
  assert.deepEqual(e.slice(0, 2), [null, null]);
  close(e[2], 2);
  close(e[3], 4 * 0.5 + 2 * 0.5);
  close(e[4], 5 * 0.5 + 3 * 0.5);
});

test('RSI Wilder: hand-berekende referentie', () => {
  // Afgeronde Wilder-voorbeeldreeks. Winsten d1..d14 = 3,34; verliezen = 1,40.
  // (StockCharts publiceert 70,53 op basis van niet-afgeronde brondata.)
  const c = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00];
  const r = rsiWilder(c, 14);
  assert.equal(r[13], null);
  close(r[14], 100 - 100 / (1 + 3.34 / 1.40), 1e-9);
  const g = (3.34 / 14) * 13 / 14; const l = ((1.40 / 14) * 13 + 0.28) / 14;
  close(r[15], 100 - 100 / (1 + g / l), 1e-9);
});

test('RSI-randgevallen: alleen winst, alleen verlies, vlak', () => {
  const up = Array.from({ length: 30 }, (_, i) => 1 + i * 0.01);
  const down = up.slice().reverse();
  const flat = Array(30).fill(1.2);
  assert.equal(rsiWilder(up)[29], 100);
  assert.equal(rsiWilder(down)[29], 0);
  assert.equal(rsiWilder(flat)[29], 50);
  assert.ok(rsiWilder(up.slice(0, 14)).every(x => x === null), 'onvoldoende historie → null');
});

test('ATR Wilder: True Range met vorige close en seed', () => {
  const cs = [{ h: 10, l: 9, c: 9.5 }, { h: 11, l: 9.8, c: 10.5 }, { h: 10.6, l: 10, c: 10.2 }, { h: 12, l: 10.1, c: 11.8 }];
  const tr = trueRange(cs);
  assert.equal(tr[0], null);
  close(tr[1], 1.5); close(tr[2], 0.6); close(tr[3], 1.9);
  const a = atrWilder(cs, 2);
  close(a[2], (1.5 + 0.6) / 2);
  close(a[3], (a[2] * 1 + 1.9) / 2);
});

test('pips en ticks per instrument', () => {
  const eu = getInstrument('EUR_USD'); const uj = getInstrument('USD_JPY'); const mes = getInstrument('MES');
  assert.equal(distance(eu, 1.1000, 1.0980).pips, 20);
  assert.equal(distance(uj, 150.00, 149.80).pips, 20);
  const d = distance(mes, 5000, 4998.75);
  assert.equal(d.ticks, 5);
  assert.equal(d.moneyPerContract, 6.25); // 5 ticks × 1,25 USD
  assert.equal(roundToTick(5000.12, mes), 5000); assert.equal(roundToTick(5000.13, mes), 5000.25);
  assert.equal(roundToTick(5000.13, mes, 'up'), 5000.25);
  assert.equal(roundToTick(1.123456, eu), 1.12346);
});

test('pipwaarde vereist een conversiekoers en verzint niets', () => {
  const uj = getInstrument('USD_JPY'); const eu = getInstrument('EUR_USD');
  close(pipValuePerUnit(eu, 'USD'), 0.0001);
  close(pipValuePerUnit(uj, 'USD', { USD_JPY: 150 }), 0.01 / 150);
  assert.equal(pipValuePerUnit(uj, 'USD', {}), null);
  close(pipValuePerUnit(eu, 'EUR', { EUR_USD: 1.25 }), 0.0001 / 1.25);
  assert.equal(moneyPerUnit(getInstrument('MES'), 1, 'USD'), 5);
});

test('legacy RR = 0,75 / 1,75 vóór kosten, SELL gespiegeld', () => {
  const eu = getInstrument('EUR_USD');
  const atr = 0.0010;
  for (const dir of ['LONG', 'SHORT']) {
    const lv = legacyLevels(dir, 1.10000, atr);
    const p = buildPlan({ inst: eu, direction: dir, entry: 1.10000, ...lv, costs: { spreadMode: 'bidask', slippagePerSide: 0 } });
    assert.equal(p.rr.tp1.gross, 0.75);
    assert.equal(p.rr.tp2.gross, 1.75);
    assert.equal(p.dist.sl.pips, 20);
    assert.ok(p.valid);
    if (dir === 'SHORT') { assert.ok(p.sl > p.entry && p.tp2 < p.entry); }
  }
});

test('netto RR is lager dan bruto bij slippage', () => {
  const eu = getInstrument('EUR_USD');
  const p = buildPlan({ inst: eu, direction: 'LONG', entry: 1.1, ...legacyLevels('LONG', 1.1, 0.001), costs: { spreadMode: 'bidask', slippagePerSide: 0.5 } });
  assert.ok(p.rr.tp2.net < p.rr.tp2.gross);
});

test('tickafronding van niveaus: stop weg van entry, daarna RR herberekend', () => {
  const mes = getInstrument('MES');
  const p = buildPlan({ inst: mes, direction: 'LONG', entry: 5000, sl: 4994.1, tp2: 5012.1 });
  assert.equal(p.sl, 4994); assert.equal(p.tp2, 5012);
  assert.equal(p.dist.sl.ticks, 24);
  assert.equal(p.rr.tp2.gross, 2);
});

test('positiegrootte: geen budget → geen berekening; < 1 contract wordt gemeld, niet naar boven afgerond', () => {
  const mes = getInstrument('MES');
  const plan = buildPlan({ inst: mes, direction: 'LONG', entry: 5000, sl: 4980, tp2: 5040, costs: { slippagePerSide: 0 } });
  assert.equal(positionSize({ inst: mes, plan }).ok, false);
  const r = positionSize({ inst: mes, plan, riskMoney: 50, costs: { slippagePerSide: 0 } }); // 1 contract = 100 USD
  assert.equal(r.size, 0);
  assert.match(r.warnings[0], /minder dan 1/);
  const ok = positionSize({ inst: mes, plan, riskMoney: 250, costs: { slippagePerSide: 0 } });
  assert.equal(ok.size, 2);
});

test('Forex weekend en DST: Londen/New York in UTC verschuiven correct', () => {
  // zaterdag gesloten, zondag 21:00 UTC (winter: 16:00 NY) gesloten, 22:30 UTC open
  assert.equal(fxMarketStatus(Date.UTC(2026, 0, 10, 12)).open, false);
  assert.equal(fxMarketStatus(Date.UTC(2026, 0, 11, 21)).open, false);
  assert.equal(fxMarketStatus(Date.UTC(2026, 0, 11, 22, 30)).open, true);
  assert.equal(fxMarketStatus(Date.UTC(2026, 0, 16, 22, 30)).open, false); // vrijdag na 17:00 NY
  // 10 maart 2026: VS al zomertijd (8 maart), VK nog niet (29 maart)
  assert.deepEqual(windowBounds(DEFAULT_SESSIONS.newyork, 2026, 3, 10).start, Date.UTC(2026, 2, 10, 12, 0));
  assert.deepEqual(windowBounds(DEFAULT_SESSIONS.london, 2026, 3, 10).start, Date.UTC(2026, 2, 10, 8, 0));
  // juli: beide zomertijd
  assert.deepEqual(windowBounds(DEFAULT_SESSIONS.london, 2026, 7, 10).start, Date.UTC(2026, 6, 10, 7, 0));
  assert.ok(inWindow(Date.UTC(2026, 6, 10, 7, 30), DEFAULT_SESSIONS.london));
  assert.ok(!inWindow(Date.UTC(2026, 0, 10, 7, 30), DEFAULT_SESSIONS.london));
  assert.equal(cmeEquityStatus(Date.UTC(2026, 0, 13, 22, 30)).reason, 'MAINTENANCE'); // 17:30 ET
});

test('MES-contract: expliciet rolbeleid, concrete maand', () => {
  const c = frontContract(getInstrument('MES'), Date.UTC(2026, 10, 8));
  assert.equal(c.symbol, 'MESZ6');
  const c2 = frontContract(getInstrument('MES'), Date.UTC(2026, 11, 14)); // < 8 dagen vóór 18-12
  assert.equal(c2.symbol, 'MESH7');
});

test('datakwaliteit: gaten, duplicaten, ongeldige waarden, onvolledig — niets opgevuld', () => {
  const eu = getInstrument('EUR_USD');
  const t0 = Date.UTC(2026, 0, 13, 9, 0); const s = 300_000;
  const c = (k, o = {}) => ({ t: t0 + k * s, o: 1.1, h: 1.101, l: 1.099, c: 1.1, v: 10, ...o });
  const input = [c(0), c(1), c(1), c(2, { h: 1.0 }), c(5), c(6, { complete: false }), c(7, { o: -1 })];
  const r = validateCandles(input, { inst: eu, tf: 'M5' });
  assert.equal(r.report.counts.DUPLICATE, 1);
  assert.equal(r.report.counts.HL_INCONSISTENT, 1);
  assert.equal(r.report.counts.INCOMPLETE, 1);
  assert.equal(r.report.counts.INVALID_VALUE, 1);
  assert.equal(r.clean.length, 3);
  assert.equal(r.gaps.length, 1);
  assert.equal(r.gaps[0].missing, 3);
  // weekend is geen gat
  const fri = Date.UTC(2026, 0, 16, 21, 55); const sun = Date.UTC(2026, 0, 18, 22, 0);
  assert.equal(validateCandles([{ t: fri, o: 1, h: 1, l: 1, c: 1 }, { t: sun, o: 1, h: 1, l: 1, c: 1 }], { inst: eu, tf: 'M5' }).gaps.length, 0);
});

test('CSV met gaten krijgt een kwaliteitsrapport', () => {
  const csv = 'time,open,high,low,close,volume\n2026-01-13T09:00:00Z,1.1,1.101,1.099,1.1,5\n2026-01-13T09:05:00Z,1.1,1.101,1.099,1.1,5\n2026-01-13T09:30:00Z,1.1,1.101,1.099,1.1,5\n';
  const { header, rows } = parseCsv(csv);
  const { candles } = rowsToCandles(header, rows, { volumeType: 'tick_count' });
  const r = validateCandles(candles, { inst: getInstrument('EUR_USD'), tf: 'M5' });
  assert.equal(r.report.gapCount, 1);
  assert.equal(r.report.missingCandles, 4);
});

test('kalender: ontbrekend, verouderd en niet-dekkend is niet veilig; blackoutvensters', () => {
  const now = Date.UTC(2026, 0, 13, 12);
  assert.equal(calendarStatus(null, now).code, 'CALENDAR_MISSING');
  assert.equal(calendarStatus({ fetchedAt: now - 13 * 3600_000, coverage: { from: now - 1, to: now + 1e9 } }, now).code, 'CALENDAR_STALE');
  assert.equal(calendarStatus({ fetchedAt: now, coverage: { from: now - 1e9, to: now + 60_000 } }, now).code, 'CALENDAR_NOT_COVERING');
  assert.equal(classify('FOMC Statement'), 'RATE_DECISION');
  assert.equal(classify('Non-Farm Employment Change'), 'NFP');
  const bo = blackouts([{ title: 'CPI m/m', currency: 'USD', impact: 'High', time: now }, { title: 'Federal Funds Rate', currency: 'USD', impact: 'High', time: now + 7200_000 }, { title: 'X', currency: 'AUD', impact: 'High', time: now }], ['EUR', 'USD']);
  assert.equal(bo.length, 2);
  assert.equal(bo[0].start, now - 15 * 60_000); assert.equal(bo[0].end, now + 30 * 60_000);
  assert.equal(bo[1].before, 30); assert.equal(bo[1].after, 60);
});
