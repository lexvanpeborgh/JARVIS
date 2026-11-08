// Instrumentmetadata. Pips, ticks, punten en geldbedragen worden afzonderlijk
// behandeld. Waarden met `verify` moeten bij de beurs/provider gecontroleerd
// worden; zij zijn hier opgenomen als expliciet contractanker, niet als
// live-geverifieerde specificatie.

import { localToUtc, zoned } from './time.js';

export const ASSET = Object.freeze({
  FX_SPOT: 'FX_SPOT', // OTC spot / broker-quote (bij OANDA: CFD/spot afhankelijk van entiteit)
  FUTURE: 'FUTURE',
  ETF: 'ETF',
  INDEX: 'INDEX',
});

export const ASSET_LABEL = {
  FX_SPOT: 'Forex spot (brokerquote)',
  FUTURE: 'Futurescontract',
  ETF: 'ETF',
  INDEX: 'Index (niet verhandelbaar)',
};

export const INSTRUMENTS = Object.freeze({
  EUR_USD: {
    id: 'EUR_USD', display: 'EUR/USD', assetClass: ASSET.FX_SPOT, base: 'EUR', quote: 'USD',
    pip: 0.0001, tick: 0.00001, precision: 5, unitStep: 1, minUnits: 1,
    sessionProfile: 'FX', tradable: true,
    providers: { oanda: 'EUR_USD', demo: 'EUR_USD' },
    limits: { maxSpreadPips: 1.5, maxSpreadAtrFrac: 0.25 },
  },
  GBP_USD: {
    id: 'GBP_USD', display: 'GBP/USD', assetClass: ASSET.FX_SPOT, base: 'GBP', quote: 'USD',
    pip: 0.0001, tick: 0.00001, precision: 5, unitStep: 1, minUnits: 1,
    sessionProfile: 'FX', tradable: true,
    providers: { oanda: 'GBP_USD', demo: 'GBP_USD' },
    limits: { maxSpreadPips: 2.0, maxSpreadAtrFrac: 0.25 },
  },
  USD_JPY: {
    id: 'USD_JPY', display: 'USD/JPY', assetClass: ASSET.FX_SPOT, base: 'USD', quote: 'JPY',
    pip: 0.01, tick: 0.001, precision: 3, unitStep: 1, minUnits: 1,
    sessionProfile: 'FX', tradable: true,
    providers: { oanda: 'USD_JPY', demo: 'USD_JPY' },
    limits: { maxSpreadPips: 1.5, maxSpreadAtrFrac: 0.25 },
  },
  MES: {
    id: 'MES', display: 'MES', name: 'Micro E-mini S&P 500', assetClass: ASSET.FUTURE,
    exchange: 'CME Globex', currency: 'USD', root: 'MES',
    tick: 0.25, pointValue: 5, tickValue: 1.25, precision: 2, unitStep: 1, minUnits: 1,
    contractCycle: ['H', 'M', 'U', 'Z'],
    sessionProfile: 'CME_EQUITY', tradable: true,
    verify: 'Contractanker volgens opdracht (5 USD/punt, tick 0,25 = 1,25 USD). Controleer de actuele CME-specificatie.',
    providers: {}, // geen gelicentieerde futuresfeed gekoppeld
    limits: { maxSpreadTicks: 2 },
  },
  ES: {
    id: 'ES', display: 'ES', name: 'E-mini S&P 500', assetClass: ASSET.FUTURE,
    exchange: 'CME Globex', currency: 'USD', root: 'ES',
    tick: 0.25, pointValue: 50, tickValue: 12.5, precision: 2, unitStep: 1, minUnits: 1,
    contractCycle: ['H', 'M', 'U', 'Z'],
    sessionProfile: 'CME_EQUITY', tradable: true,
    verify: 'ES-waarden zijn NIET afgeleid van MES; controleer de actuele CME-specificatie.',
    providers: {},
    limits: { maxSpreadTicks: 2 },
  },
  SPY: {
    id: 'SPY', display: 'SPY', name: 'SPDR S&P 500 ETF Trust', assetClass: ASSET.ETF,
    exchange: 'NYSE Arca', currency: 'USD', tick: 0.01, precision: 2, unitStep: 1, minUnits: 1,
    sessionProfile: 'US_EQUITY', tradable: true,
    providers: {},
    limits: {},
  },
  SPX: {
    id: 'SPX', display: 'S&P 500', name: 'S&P 500-index', assetClass: ASSET.INDEX,
    currency: 'USD', tick: 0.01, precision: 2,
    sessionProfile: 'US_EQUITY', tradable: false,
    note: 'Contextinstrument. Een indexkoers is geen uitvoerbare MES-quote.',
    providers: {},
    limits: {},
  },
});

export const DEFAULT_WATCHLIST = ['EUR_USD', 'GBP_USD', 'USD_JPY'];

export function getInstrument(id) {
  const inst = INSTRUMENTS[id];
  if (!inst) throw new Error(`Onbekend instrument: ${id}`);
  return inst;
}

// ---------- prijseenheden ----------

/** Rond een prijs af op een geldige tick (richting: 'nearest' | 'up' | 'down'). */
export function roundToTick(price, inst, mode = 'nearest') {
  if (price == null || !Number.isFinite(price)) return null;
  const t = inst.tick;
  const n = price / t;
  const k = mode === 'up' ? Math.ceil(n - 1e-9) : mode === 'down' ? Math.floor(n + 1e-9) : Math.round(n);
  return Number((k * t).toFixed(inst.precision));
}

/** Afstand uitgedrukt in de natuurlijke eenheden van het instrument. */
export function distance(inst, a, b) {
  const d = Math.abs(a - b);
  const out = { price: Number(d.toFixed(inst.precision + 2)) };
  if (inst.assetClass === ASSET.FX_SPOT) {
    out.pips = Number((d / inst.pip).toFixed(1));
    out.unit = 'pips';
    out.value = out.pips;
  } else if (inst.assetClass === ASSET.FUTURE) {
    out.ticks = Math.round(d / inst.tick);
    out.points = Number(d.toFixed(2));
    out.moneyPerContract = Number((out.points * inst.pointValue).toFixed(2));
    out.unit = 'ticks';
    out.value = out.ticks;
  } else {
    out.points = Number(d.toFixed(inst.precision));
    out.unit = 'punten';
    out.value = out.points;
  }
  return out;
}

export function fmtPrice(inst, p) {
  return p == null || !Number.isFinite(p) ? '—' : p.toFixed(inst.precision);
}

/**
 * Waarde van één pip per 1 eenheid basisvaluta, in rekeningvaluta.
 * `rates` bevat actuele mid-koersen zoals { EUR_USD: 1.08, USD_JPY: 151.2 }.
 * Retourneert null als een benodigde conversie ontbreekt (er wordt niets verzonnen).
 */
export function pipValuePerUnit(inst, accountCcy, rates = {}) {
  if (inst.assetClass !== ASSET.FX_SPOT) return null;
  const inQuoteCcy = inst.pip; // 1 eenheid × pipgrootte, uitgedrukt in quotevaluta
  return convert(inQuoteCcy, inst.quote, accountCcy, rates);
}

/** Converteer een bedrag tussen valuta met beschikbare paren. */
export function convert(amount, from, to, rates = {}) {
  if (from === to) return amount;
  const direct = rates[`${from}_${to}`];
  if (Number.isFinite(direct) && direct > 0) return amount * direct;
  const inverse = rates[`${to}_${from}`];
  if (Number.isFinite(inverse) && inverse > 0) return amount / inverse;
  // via USD
  if (from !== 'USD' && to !== 'USD') {
    const a = convert(amount, from, 'USD', rates);
    return a == null ? null : convert(a, 'USD', to, rates);
  }
  return null;
}

/** Geldwaarde van een prijsafstand per 1 eenheid/contract in rekeningvaluta. */
export function moneyPerUnit(inst, priceDistance, accountCcy, rates = {}) {
  if (inst.assetClass === ASSET.FX_SPOT) return convert(priceDistance, inst.quote, accountCcy, rates);
  if (inst.assetClass === ASSET.FUTURE) return convert(priceDistance * inst.pointValue, inst.currency, accountCcy, rates);
  if (inst.assetClass === ASSET.ETF) return convert(priceDistance, inst.currency, accountCcy, rates);
  return null;
}

// ---------- futurescontracten ----------

const MONTH_OF = { F: 1, G: 2, H: 3, J: 4, K: 5, M: 6, N: 7, Q: 8, U: 9, V: 10, X: 11, Z: 12 };

/** Derde vrijdag van een maand (UTC-datum). */
export function thirdFriday(year, month) {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const offset = (5 - first + 7) % 7;
  return 1 + offset + 14;
}

/**
 * Concreet contract volgens een expliciet rolbeleid: rol `rollDaysBefore`
 * kalenderdagen vóór de laatste handelsdag (derde vrijdag van de
 * contractmaand, 09:30 ET als vereenvoudigd expiratieanker).
 * Dit is een configureerbaar beleid; het vervangt geen beurskalender.
 */
export function frontContract(inst, ms, rollDaysBefore = 8) {
  if (inst.assetClass !== ASSET.FUTURE) return null;
  const z = zoned(ms, 'America/New_York');
  for (let add = 0; add < 8; add += 1) {
    const idx = add;
    const cand = nthQuarter(z.year, z.month, idx, inst.contractCycle);
    const expDay = thirdFriday(cand.year, cand.month);
    const expiry = localToUtc(cand.year, cand.month, expDay, 9, 30, 'America/New_York');
    const roll = expiry - rollDaysBefore * 86_400_000;
    if (ms < roll) {
      return {
        symbol: `${inst.root}${cand.letter}${String(cand.year).slice(-1)}`,
        longSymbol: `${inst.root} ${cand.letter}${cand.year}`,
        month: cand.month, year: cand.year, letter: cand.letter,
        expiry, rollAt: roll, exchange: inst.exchange,
        policy: `Rol ${rollDaysBefore} dagen vóór de derde vrijdag van de contractmaand`,
      };
    }
  }
  return null;
}

function nthQuarter(year, month, n, cycle) {
  const months = cycle.map(l => ({ letter: l, month: MONTH_OF[l] }));
  const list = [];
  for (let y = year; y <= year + 3; y += 1) for (const m of months) if (y > year || m.month >= month) list.push({ ...m, year: y });
  return list[n];
}
