// Centrale risk engine: niveaus, tickafronding, afstanden, kosten, RR en
// positiegrootte. Gebruikt door live analyse, paper trading, replay en backtest.

import { ASSET, roundToTick, distance, moneyPerUnit, pipValuePerUnit } from './instruments.js';

export const DEFAULT_COSTS = Object.freeze({
  // 'bidask' = fills op echte bid/ask uit de data; 'model' = mid ± modelSpread/2.
  // Nooit beide tegelijk: de spread wordt maar één keer geteld.
  spreadMode: 'bidask',
  modelSpread: { EUR_USD: 1.0, GBP_USD: 1.4, USD_JPY: 1.1 }, // pips, alleen bij 'model' of als bid/ask ontbreekt
  slippagePerSide: 0.2, // pips (FX) of ticks (futures) per marktuitvoering
  commissionPerSidePerUnit: 0, // in rekeningvaluta per eenheid (FX) — OANDA standaard: spread-only
  commissionPerSidePerContract: 0, // futures: broker + beurs + clearing, door gebruiker in te vullen
  financing: 'niet gemodelleerd', // swaps/financiering expliciet niet meegenomen
});

/** Prijsgrootte van één 'unit' (pip of tick) voor slippage en spreadmodellen. */
export function unitSize(inst) {
  return inst.assetClass === ASSET.FX_SPOT ? inst.pip : inst.tick;
}

export function slippagePrice(inst, costs = DEFAULT_COSTS) {
  return (costs.slippagePerSide || 0) * unitSize(inst);
}

/** Commissie per zijde omgerekend naar prijsafstand per eenheid (benadering voor RR). */
function commissionPrice(inst, costs, accountCcy, rates) {
  if (inst.assetClass === ASSET.FUTURE) {
    const c = costs.commissionPerSidePerContract || 0;
    return c ? c / inst.pointValue : 0;
  }
  const c = costs.commissionPerSidePerUnit || 0;
  if (!c) return 0;
  const perPrice = moneyPerUnit(inst, 1, accountCcy, rates); // geld per 1.0 prijsverschil per eenheid
  return perPrice ? c / perPrice : null;
}

/**
 * Bouw een risicoplan. Rondt SL weg van de entry en targets richting de entry af
 * (conservatief), en berekent daarna alle afstanden en RR opnieuw.
 */
export function buildPlan({ inst, direction, entry, sl, tp1 = null, tp2 = null, costs = DEFAULT_COSTS, accountCcy = 'USD', rates = {}, tp1Role = 'observation', exitTarget = 'tp2' }) {
  if (!['LONG', 'SHORT'].includes(direction)) throw new Error('direction moet LONG of SHORT zijn');
  const long = direction === 'LONG';
  const e = roundToTick(entry, inst, 'nearest');
  const s = roundToTick(sl, inst, long ? 'down' : 'up');
  const t1 = tp1 == null ? null : roundToTick(tp1, inst, long ? 'down' : 'up');
  const t2 = tp2 == null ? null : roundToTick(tp2, inst, long ? 'down' : 'up');
  const errors = [];
  if (long ? !(s < e) : !(s > e)) errors.push('STOP_WRONG_SIDE');
  for (const [k, t] of [['TP1', t1], ['TP2', t2]]) if (t != null && (long ? !(t > e) : !(t < e))) errors.push(`${k}_WRONG_SIDE`);
  const risk = Math.abs(e - s);
  const slip = slippagePrice(inst, costs);
  const comm = commissionPrice(inst, costs, accountCcy, rates);
  const commBoth = comm == null ? null : comm * 2;
  const rr = t => {
    if (t == null || risk <= 0) return { gross: null, net: null };
    const reward = Math.abs(t - e);
    const gross = reward / risk;
    // netto: stop is een marktorder (slippage), target een limiet (geen slippage aangenomen)
    const net = commBoth == null ? null : (reward - commBoth) / (risk + slip + commBoth);
    return { gross: round(gross, 3), net: net == null ? null : round(net, 3) };
  };
  const plan = {
    direction, entry: e, sl: s, tp1: t1, tp2: t2,
    tp1Role, exitTarget,
    dist: {
      sl: distance(inst, e, s),
      tp1: t1 == null ? null : distance(inst, e, t1),
      tp2: t2 == null ? null : distance(inst, e, t2),
    },
    rr: { tp1: rr(t1), tp2: rr(t2) },
    costs: {
      spreadMode: costs.spreadMode, slippagePerSide: costs.slippagePerSide,
      slippagePrice: slip, commissionRoundTripPrice: commBoth,
      note: 'Netto RR: stop met slippage, target als limiet; commissie heen en terug.',
    },
    valid: errors.length === 0, errors,
  };
  // geld per eenheid/contract
  const mpu = moneyPerUnit(inst, risk, accountCcy, rates);
  plan.money = {
    accountCcy,
    riskPerUnit: mpu == null ? null : round(mpu, 6),
    rewardTp2PerUnit: t2 == null ? null : moneyPerUnit(inst, Math.abs(t2 - e), accountCcy, rates),
    pipValuePerUnit: pipValuePerUnit(inst, accountCcy, rates),
  };
  return plan;
}

/**
 * Positiegrootte. Vereist door de gebruiker ingevulde gegevens; zonder saldo of
 * budget wordt er niets berekend (geen verzonnen accountsaldo).
 */
export function positionSize({ inst, plan, balance = null, riskMoney = null, riskPct = null, accountCcy = 'USD', rates = {}, costs = DEFAULT_COSTS, costBufferPct = 0 }) {
  const budget = riskMoney != null ? riskMoney : (balance != null && riskPct != null ? balance * riskPct / 100 : null);
  if (budget == null || !(budget > 0)) return { ok: false, reason: 'BUDGET_MISSING', text: 'Vul een saldo + risicopercentage of een risicobedrag in.' };
  const slip = slippagePrice(inst, costs);
  const riskPerUnit = moneyPerUnit(inst, Math.abs(plan.entry - plan.sl) + slip, accountCcy, rates);
  if (riskPerUnit == null) return { ok: false, reason: 'FX_CONVERSION_MISSING', text: `Geen koers beschikbaar om ${inst.quote || inst.currency} naar ${accountCcy} om te rekenen.` };
  const effBudget = budget * (1 - costBufferPct / 100);
  const raw = effBudget / riskPerUnit;
  const step = inst.unitStep || 1;
  let size = Math.floor(raw / step) * step;
  const out = { ok: true, budget: round(budget, 2), riskPerUnit: round(riskPerUnit, 6), raw: round(raw, 4), size, unit: inst.assetClass === ASSET.FUTURE ? 'contracten' : 'eenheden', warnings: [] };
  if (size < (inst.minUnits || 1)) {
    out.size = 0;
    out.warnings.push(inst.assetClass === ASSET.FUTURE
      ? `Berekend ${raw.toFixed(2)} contract: minder dan 1. Eén contract zou ${round(riskPerUnit, 2)} ${accountCcy} risico betekenen, meer dan het budget.`
      : 'Budget te klein voor de minimale positiegrootte.');
  }
  out.actualRisk = round(out.size * riskPerUnit, 2);
  if (inst.assetClass === ASSET.FUTURE) out.marginNote = 'Margin is een zekerheidsstelling, geen maximaal verlies. Margevereisten komen van de broker/beurs en zijn niet ingevuld.';
  out.stopNote = 'Een stop is een triggerniveau; bij snelle markten of gaps kan de uitvoering slechter zijn.';
  return out;
}

export function round(x, d = 2) {
  if (x == null || !Number.isFinite(x)) return null;
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

/** Legacy-ATR-niveaus exact volgens de oorspronkelijke formules. */
export function legacyLevels(direction, entry, atr, m = {}) {
  const sl = m.slAtr ?? 2; const t1 = m.tp1Atr ?? 1.5; const t2 = m.tp2Atr ?? 3.5;
  if (direction === 'LONG') return { sl: entry - sl * atr, tp1: entry + t1 * atr, tp2: entry + t2 * atr };
  return { sl: entry + sl * atr, tp1: entry - t1 * atr, tp2: entry - t2 * atr };
}
