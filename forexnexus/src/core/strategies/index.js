// Strategieregister. Iedere strategie is versieerbaar; een regelwijziging is
// een nieuwe versie met een nieuwe backtest. Regels worden nooit stilzwijgend
// aangepast.

import { legacyLevels } from '../risk.js';
import { lastConfirmed } from '../structure.js';

const fmt = (x, d = 5) => (x == null ? '—' : Number(x).toFixed(d));

function legacyFactory({ id, version, tp2Mult, name }) {
  return {
    id, version, family: 'LEGACY_EMA_RSI_VOL', name,
    timeframes: ['M5'],
    instruments: ['EUR_USD', 'GBP_USD', 'USD_JPY'],
    requiresVolume: true,
    needsStructure: false,
    minHistory: 100,
    params: { emaFast: 9, emaSlow: 21, rsi: 14, atr: 14, rsiBuyBelow: 30, rsiSellAbove: 70, slAtr: 2, tp1Atr: 1.5, tp2Atr: tp2Mult },
    sessions: ['london', 'newyork'],
    exit: { target: 'tp2', tp1Role: 'observation', text: `Volledige exit op SL of TP2 (${tp2Mult} × ATR). TP1 (1,5 × ATR) is een observatieniveau; geen deeluitstap.` },
    hypothesis: 'Een EMA9/21-kruising op dezelfde gesloten candle waarop RSI14 extreem is en het (tick)volume stijgt, markeert een kortetermijnomslag.',
    rrPolicy: tp2Mult === 3.5
      ? 'Legacy: exact de oorspronkelijke ATR-formules. Nominale bruto RR = 0,75 (TP1) en 1,75 (TP2) vóór kosten. Geen globale RR≥2-filter.'
      : `ATR-variant: TP2 op ${tp2Mult} × ATR, nominale bruto RR TP2 = ${(tp2Mult / 2).toFixed(2)} vóór kosten. Afzonderlijke strategieversie.`,
    rules: {
      LONG: ['RSI14 < 30 op de gesloten signaalcandle', 'EMA9 ≤ EMA21 op de vorige gesloten candle', 'EMA9 > EMA21 op de signaalcandle', 'Volume (gekozen type) hoger dan op de vorige candle'],
      SHORT: ['RSI14 > 70 op de gesloten signaalcandle', 'EMA9 ≥ EMA21 op de vorige gesloten candle', 'EMA9 < EMA21 op de signaalcandle', 'Volume (gekozen type) hoger dan op de vorige candle'],
    },
    note: 'Dit is geen Market Structure Shift: er wordt geen structurele doorbraak vastgesteld.',

    setup(series, i) {
      const { candles, ind } = series; const p = this.params;
      const c = candles[i]; const pc = candles[i - 1];
      const rsi = ind.rsi[i]; const ef = ind.emaFast[i]; const es = ind.emaSlow[i];
      const efp = ind.emaFast[i - 1]; const esp = ind.emaSlow[i - 1];
      const dp = series.inst.precision;
      const volOk = c.v != null && pc?.v != null;
      const volChange = volOk && pc.v > 0 ? ((c.v - pc.v) / pc.v) * 100 : null;
      const dir = side => {
        const long = side === 'LONG';
        const conds = [
          { id: 'rsi', ok: rsi != null && (long ? rsi < p.rsiBuyBelow : rsi > p.rsiSellAbove), label: long ? `RSI14 < ${p.rsiBuyBelow}` : `RSI14 > ${p.rsiSellAbove}`, value: rsi == null ? null : Number(rsi.toFixed(2)), detail: `RSI14 op deze gesloten candle: ${fmt(rsi, 2)}` },
          { id: 'ema_prev', ok: efp != null && esp != null && (long ? efp <= esp : efp >= esp), label: long ? 'EMA9 ≤ EMA21 op vorige candle' : 'EMA9 ≥ EMA21 op vorige candle', value: efp == null ? null : [Number(efp.toFixed(dp + 1)), Number(esp.toFixed(dp + 1))], detail: `Vorige candle: EMA9 ${fmt(efp, dp + 1)} / EMA21 ${fmt(esp, dp + 1)}` },
          { id: 'ema_now', ok: ef != null && es != null && (long ? ef > es : ef < es), label: long ? 'EMA9 > EMA21 op signaalcandle' : 'EMA9 < EMA21 op signaalcandle', value: ef == null ? null : [Number(ef.toFixed(dp + 1)), Number(es.toFixed(dp + 1))], detail: `Signaalcandle: EMA9 ${fmt(ef, dp + 1)} / EMA21 ${fmt(es, dp + 1)}` },
          { id: 'volume', ok: volOk && c.v > pc.v, label: 'Volume stijgt t.o.v. vorige candle', value: volOk ? [pc.v, c.v] : null, detail: volOk ? `${volumeLabel(c.vType)}: ${pc.v} → ${c.v} (${volChange == null ? '—' : (volChange >= 0 ? '+' : '') + volChange.toFixed(1) + '%'})` : 'Geen volume beschikbaar' },
        ];
        return conds;
      };
      const L = dir('LONG'); const S = dir('SHORT');
      const passL = L.filter(x => x.ok).length; const passS = S.filter(x => x.ok).length;
      const triggered = passL === 4 ? 'LONG' : passS === 4 ? 'SHORT' : null;
      const focus = triggered || (passL >= passS ? 'LONG' : 'SHORT');
      const conditions = focus === 'LONG' ? L : S;
      let preparing = false; let awaiting = null;
      if (!triggered) {
        if (L[0].ok && efp != null && ef <= es) { preparing = true; awaiting = 'RSI14 < 30 en EMA9 nog onder EMA21: wacht op een gesloten candle waarop EMA9 boven EMA21 kruist met stijgend volume.'; }
        else if (S[0].ok && efp != null && ef >= es) { preparing = true; awaiting = 'RSI14 > 70 en EMA9 nog boven EMA21: wacht op een gesloten candle waarop EMA9 onder EMA21 kruist met stijgend volume.'; }
      }
      const against = [];
      const atr = ind.atr[i];
      if (atr != null && c.h - c.l > 2.5 * atr) against.push(`Signaalcandle-range is ${((c.h - c.l) / atr).toFixed(1)} × ATR: verhoogde volatiliteit.`);
      if (triggered === 'LONG' && ef != null && ind.emaSlow[i - 20] != null && es < ind.emaSlow[i - 20]) against.push('EMA21 daalt over de laatste 20 candles: kruising tegen de bredere kortetermijntrend.');
      if (triggered === 'SHORT' && ef != null && ind.emaSlow[i - 20] != null && es > ind.emaSlow[i - 20]) against.push('EMA21 stijgt over de laatste 20 candles: kruising tegen de bredere kortetermijntrend.');
      if (c.vType === 'tick_count') against.push('Volume is broker-tickvolume (aantal prijsupdates), geen verhandeld marktvolume.');
      return {
        triggered, direction: focus, conditions, preparing, awaiting, against,
        levels: entryRef => {
          const lv = legacyLevels(focus, entryRef, atr, p);
          return { ...lv, exitTarget: 'tp2', tp1Role: 'observation' };
        },
        invalidation: focus === 'LONG'
          ? 'Ongeldig wanneer de bid de stop-loss raakt, het entryvenster verloopt of de ask te ver boven de entryreferentie staat.'
          : 'Ongeldig wanneer de ask de stop-loss raakt, het entryvenster verloopt of de bid te ver onder de entryreferentie staat.',
        evidence: { rsi, emaFast: ef, emaSlow: es, emaFastPrev: efp, emaSlowPrev: esp, atr, volume: c.v, volumePrev: pc?.v ?? null, volumeType: c.vType, volumeChangePct: volChange },
      };
    },
  };
}

export function volumeLabel(t) {
  return {
    tick_count: 'Broker-tickvolume (aantal prijsupdates)',
    exchange: 'Beursvolume (verhandelde contracten)',
    synthetic: 'Synthetisch volume (demo)',
    proxy: 'Proxyvolume',
    none: 'Geen volume',
  }[t] || 'Onbekend volumetype';
}

const STRUCT = {
  id: 'STRUCT_SWEEP_MSS', version: '1.0.0', family: 'STRUCTURE_SWEEP', name: 'Liquidity sweep + MSS (structuur)',
  timeframes: ['M5'], instruments: ['EUR_USD', 'GBP_USD', 'USD_JPY'],
  requiresVolume: false, needsStructure: true, minHistory: 300,
  params: { pivotLeft: 2, pivotRight: 2, sweepMaxBarsToMss: 12, displacementAtr: 0.8, slBufferAtr: 0.1, minRR: 2.0, atr: 14, emaFast: 9, emaSlow: 21, rsi: 14, targetLookbackBars: 288 },
  sessions: ['london', 'newyork'],
  exit: { target: 'tp1', tp1Role: 'exit', text: 'Volledige exit op SL of op het eerste vooraf bekende liquiditeitsniveau (TP1). TP2 = volgend niveau, alleen ter observatie.' },
  hypothesis: 'Na een sweep van een vooraf bekend niveau (vorige dag high/low of Aziatische range) en een structurele breuk in tegenrichting, beweegt de prijs naar het eerstvolgende tegengestelde liquiditeitsniveau.',
  rrPolicy: 'Alleen een setup als het eerste vooraf bekende tegengestelde niveau minimaal RR 2,0 (bruto) oplevert. De stop staat voorbij het sweep-extreem + 0,1 × ATR en wordt nooit dichterbij gezet om de RR te halen.',
  rules: {
    LONG: ['Sweep: low onder PDL of Aziatische low, close terug erboven (≤ 12 candles geleden)', 'MSS: close boven de laatst bevestigde swing high van vóór de sweep', 'Displacement: body breukcandle ≥ 0,8 × ATR14', 'Geen close terug onder het gesweepte niveau', 'Eerste vooraf bekende target boven entry geeft RR ≥ 2,0'],
    SHORT: ['Sweep: high boven PDH of Aziatische high, close terug eronder (≤ 12 candles geleden)', 'MSS: close onder de laatst bevestigde swing low van vóór de sweep', 'Displacement: body breukcandle ≥ 0,8 × ATR14', 'Geen close terug boven het gesweepte niveau', 'Eerste vooraf bekende target onder entry geeft RR ≥ 2,0'],
  },
  note: 'Niveaus zijn afgeleide prijsniveaus; er wordt geen zicht op echte stops of orders geclaimd.',

  setup(series, i, ctx = {}) {
    const { candles, ind } = series; const st = series.structure; const p = this.params;
    const c = candles[i]; const atr = ind.atr[i];
    const brk = st.breaks.find(b => b.index === i && b.type.startsWith('MSS'));
    const recentSweeps = st.sweeps.filter(s => s.index <= i && i - s.index <= p.sweepMaxBarsToMss);
    const dp = series.inst.precision;
    if (!brk) {
      const s = recentSweeps[recentSweeps.length - 1];
      if (s) {
        const long = s.bias === 'LONG';
        const piv = lastConfirmed(long ? st.pivots.highs : st.pivots.lows, i, s.index);
        const stillValid = notClosedBack(candles, s, i, long);
        return {
          triggered: null, direction: s.bias, preparing: stillValid && !!piv,
          awaiting: piv ? `Sweep van ${levelName(s.level)} (${fmt(s.price, dp)}) ${i - s.index} candle(s) geleden. Wacht op een close ${long ? 'boven' : 'onder'} ${fmt(piv.price, dp)} (bevestigde swing ${long ? 'high' : 'low'}).` : `Sweep van ${levelName(s.level)} gezien; nog geen bevestigde swing om te breken.`,
          conditions: [
            { id: 'sweep', ok: true, label: 'Sweep van vooraf bekend niveau', value: s.price, detail: `${levelName(s.level)} ${fmt(s.price, dp)} op candle ${new Date(s.t).toISOString().slice(11, 16)} UTC` },
            { id: 'mss', ok: false, label: 'MSS-close voorbij bevestigde swing', value: piv?.price ?? null, detail: piv ? `Nog geen close voorbij ${fmt(piv.price, dp)}` : 'Geen bevestigde swing' },
            { id: 'displacement', ok: false, label: `Displacement ≥ ${p.displacementAtr} × ATR`, value: null, detail: 'Nog geen breukcandle' },
            { id: 'not_reswept', ok: stillValid, label: 'Geen close terug voorbij het gesweepte niveau', value: s.price, detail: stillValid ? 'Niveau sindsdien niet opnieuw gesloten voorbij' : 'Close terug voorbij het niveau: sweep ongeldig' },
            { id: 'rr', ok: false, label: `Target met RR ≥ ${p.minRR}`, value: null, detail: 'Wordt pas bij een breuk berekend' },
          ],
          against: [], levels: null, invalidation: `Setup vervalt na ${p.sweepMaxBarsToMss} candles zonder breuk of bij een nieuw extreem voorbij de sweep.`,
          evidence: { sweep: s, pivot: piv || null, atr },
        };
      }
      return { triggered: null, direction: null, preparing: false, awaiting: null, conditions: [], against: [], levels: null, evidence: { atr } };
    }
    const long = brk.type === 'MSS_UP';
    const sweep = st.sweeps.find(s => s.index === brk.sweepIndex && s.bias === (long ? 'LONG' : 'SHORT'));
    const ext = extremeSince(candles, brk.sweepIndex, i, long);
    const sl = long ? ext - p.slBufferAtr * atr : ext + p.slBufferAtr * atr;
    const disp = brk.displacementAtr;
    const notReswept = sweep ? notClosedBack(candles, sweep, i, long) : false;
    const targetsFor = entryRef => targetCandidates(series, i, long, entryRef, p);
    const conditions = [
      { id: 'sweep', ok: !!sweep, label: 'Sweep van vooraf bekend niveau', value: sweep?.price ?? null, detail: sweep ? `${levelName(sweep.level)} ${fmt(sweep.price, dp)} op ${new Date(sweep.t).toISOString().slice(11, 16)} UTC (${i - sweep.index} candle(s) vóór de breuk)` : '—' },
      { id: 'mss', ok: true, label: 'MSS-close voorbij bevestigde swing', value: brk.level, detail: `Close ${fmt(c.c, dp)} ${long ? 'boven' : 'onder'} swing ${fmt(brk.level, dp)}` },
      { id: 'displacement', ok: disp != null && disp >= p.displacementAtr, label: `Displacement ≥ ${p.displacementAtr} × ATR`, value: disp == null ? null : Number(disp.toFixed(2)), detail: `Body = ${disp == null ? '—' : disp.toFixed(2)} × ATR14` },
      { id: 'not_reswept', ok: notReswept, label: 'Geen close terug voorbij het gesweepte niveau', value: sweep?.price ?? null, detail: `Extreem sinds sweep (basis stop): ${fmt(ext, dp)}` },
    ];
    const rrCond = { id: 'rr', ok: false, label: `Target met RR ≥ ${p.minRR}`, value: null, detail: '' };
    conditions.push(rrCond);
    return {
      triggered: conditions.slice(0, 4).every(x => x.ok) ? (long ? 'LONG' : 'SHORT') : null,
      direction: long ? 'LONG' : 'SHORT',
      conditions, preparing: false, awaiting: null,
      against: disp != null && disp > 3 ? [`Zeer grote breukcandle (${disp.toFixed(1)} × ATR): entry ligt ver van de stop.`] : [],
      levels: entryRef => {
        const tg = targetsFor(entryRef);
        const risk = Math.abs(entryRef - sl);
        const tp1 = tg[0] || null; const tp2 = tg[1] || null;
        const rr = tp1 && risk > 0 ? Math.abs(tp1.price - entryRef) / risk : null;
        rrCond.value = rr == null ? null : Number(rr.toFixed(2));
        rrCond.ok = rr != null && rr >= p.minRR;
        rrCond.detail = tp1 ? `Eerste target ${tp1.name} ${fmt(tp1.price, dp)} → bruto RR ${rr.toFixed(2)}` : 'Geen vooraf bekend target';
        return { sl, tp1: tp1?.price ?? null, tp2: tp2?.price ?? null, tp1Name: tp1?.name, tp2Name: tp2?.name, exitTarget: 'tp1', tp1Role: 'exit', rrCheck: { rr, min: p.minRR, ok: rrCond.ok, hasTarget: !!tp1 } };
      },
      invalidation: `Ongeldig bij een ${long ? 'bid onder' : 'ask boven'} de stop (${fmt(sl, dp)}), na het entryvenster of bij te grote koersafwijking.`,
      evidence: { break: brk, sweep, extreme: ext, atr, displacementAtr: disp },
    };
  },
};

function levelName(k) { return { PDH: 'vorige dag high', PDL: 'vorige dag low', ASIA_H: 'Aziatische high', ASIA_L: 'Aziatische low' }[k] || k; }
function extremeSince(candles, from, to, long) {
  let x = long ? Infinity : -Infinity;
  for (let j = from; j <= to; j += 1) x = long ? Math.min(x, candles[j].l) : Math.max(x, candles[j].h);
  return x;
}
/** Sinds de sweep geen close terug voorbij het gesweepte niveau. */
function notClosedBack(candles, s, i, long) {
  for (let j = s.index + 1; j <= i; j += 1) if (long ? candles[j].c < s.price : candles[j].c > s.price) return false;
  return true;
}

/** Vooraf bekende targets: PDH/PDL, Aziatische range en bevestigde swings (knownAt ≤ i). */
function targetCandidates(series, i, long, entryRef, p) {
  const st = series.structure; const lv = st.levels[i];
  const cands = [];
  if (long) {
    if (lv.pdh != null) cands.push({ name: 'vorige dag high', price: lv.pdh });
    if (lv.asianHigh != null) cands.push({ name: 'Aziatische high', price: lv.asianHigh });
    for (const ph of st.pivots.highs) if (ph.knownAt <= i && ph.index >= i - p.targetLookbackBars) cands.push({ name: 'bevestigde swing high', price: ph.price });
    return cands.filter(c => c.price > entryRef).sort((a, b) => a.price - b.price);
  }
  if (lv.pdl != null) cands.push({ name: 'vorige dag low', price: lv.pdl });
  if (lv.asianLow != null) cands.push({ name: 'Aziatische low', price: lv.asianLow });
  for (const pl of st.pivots.lows) if (pl.knownAt <= i && pl.index >= i - p.targetLookbackBars) cands.push({ name: 'bevestigde swing low', price: pl.price });
  return cands.filter(c => c.price < entryRef).sort((a, b) => b.price - a.price);
}

export const STRATEGIES = {
  LEGACY_EMA_RSI_VOL: legacyFactory({ id: 'LEGACY_EMA_RSI_VOL', version: '1.0.0', tp2Mult: 3.5, name: 'Legacy EMA9/21 + RSI14 + volume' }),
  LEGACY_EMA_RSI_VOL_ATR4: legacyFactory({ id: 'LEGACY_EMA_RSI_VOL_ATR4', version: '1.0.0', tp2Mult: 4, name: 'Legacy-variant met TP2 op 4 × ATR' }),
  STRUCT_SWEEP_MSS: STRUCT,
};

export const DEFAULT_STRATEGY = 'LEGACY_EMA_RSI_VOL';

export function getStrategy(id) {
  const s = STRATEGIES[id];
  if (!s) throw new Error(`Onbekende strategie: ${id}`);
  return s;
}

export function strategyCard(s) {
  return {
    id: s.id, version: s.version, family: s.family, name: s.name, timeframes: s.timeframes, instruments: s.instruments,
    hypothesis: s.hypothesis, rules: s.rules, exit: s.exit, rrPolicy: s.rrPolicy, params: s.params, sessions: s.sessions,
    requiresVolume: s.requiresVolume, minHistory: s.minHistory, note: s.note,
    evaluation: EVALUATION_CRITERIA,
  };
}

// Vooraf vastgelegde evaluatiecriteria (gelden voor alle kandidaten).
export const EVALUATION_CRITERIA = Object.freeze({
  split: 'Chronologisch 60% train / 20% validatie / 20% test. Parameters zijn vooraf vastgelegd (geen optimalisatie in v1).',
  minTradesTest: 30,
  minTradesTotal: 100,
  acceptance: 'Een kandidaat komt alleen in aanmerking als standaard wanneer: test-expectancy na baselinekosten > 0 R, de ondergrens van het 90%-bootstrapinterval (blokbootstrap) van de expectancy > 0 R, minimaal 30 testtrades, en geen enkel jaar meer dan 50% van de totale netto R draagt.',
  insufficient: 'Minder dan 30 trades in de testperiode of minder dan 100 in totaal → ONVOLDOENDE BEWIJS.',
});
