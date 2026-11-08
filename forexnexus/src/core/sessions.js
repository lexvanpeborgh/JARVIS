// Sessies en handelskalender. Forex en futures hebben afzonderlijke regels.
// Alle vensters zijn configureerbare onderzoeksinstellingen, geen bewezen
// optimale handelsuren.

import { zoned, parseHHMM, localToUtc, TF_MS } from './time.js';

export const DEFAULT_SESSIONS = Object.freeze({
  london: { label: 'Londen', tz: 'Europe/London', start: '08:00', end: '12:00', tradeWindow: true },
  newyork: { label: 'New York', tz: 'America/New_York', start: '08:00', end: '11:00', tradeWindow: true },
  // Expliciete onderzoeksdefinitie: NIET de hele Aziatische sessie.
  asianRange: { label: 'Aziatische range', tz: 'UTC', start: '00:00', end: '06:00', tradeWindow: false },
});

// Volledige sluitingsdagen voor de Forex-weergave (MM-DD), configureerbaar.
// Liquiditeit rond feestdagen kan sterk afwijken; verkorte dagen worden niet
// automatisch gemodelleerd.
export const DEFAULT_FX_HOLIDAYS = ['12-25', '01-01'];

/** Is ms binnen een lokaal venster [start, end) in de opgegeven tijdzone? */
export function inWindow(ms, win) {
  const z = zoned(ms, win.tz);
  const s = parseHHMM(win.start); const e = parseHHMM(win.end);
  if (s <= e) return z.minuteOfDay >= s && z.minuteOfDay < e;
  return z.minuteOfDay >= s || z.minuteOfDay < e; // over middernacht
}

/** Forexmarkt: zondag 17:00 New York tot vrijdag 17:00 New York, excl. feestdagen. */
export function fxMarketStatus(ms, holidays = DEFAULT_FX_HOLIDAYS) {
  const ny = zoned(ms, 'America/New_York');
  const mmdd = `${String(ny.month).padStart(2, '0')}-${String(ny.day).padStart(2, '0')}`;
  if (holidays.includes(mmdd)) return { open: false, reason: 'HOLIDAY', text: 'Markt gesloten (feestdag volgens instelling)' };
  const wd = ny.weekday; const m = ny.minuteOfDay; const five = 17 * 60;
  if (wd === 6) return { open: false, reason: 'WEEKEND', text: 'Markt gesloten (weekend)' };
  if (wd === 5 && m >= five) return { open: false, reason: 'WEEKEND', text: 'Markt gesloten (weekend)' };
  if (wd === 0 && m < five) return { open: false, reason: 'WEEKEND', text: 'Markt gesloten (weekend)' };
  return { open: true, reason: 'OPEN', text: 'Markt open' };
}

/**
 * CME Globex aandelenindexfutures (vereenvoudigd profiel):
 * zondag 18:00 ET – vrijdag 17:00 ET, dagelijkse pauze 17:00–18:00 ET.
 * Beursfeestdagen en verkorte dagen zijn NIET geladen; dat wordt gemeld.
 */
export function cmeEquityStatus(ms) {
  const ny = zoned(ms, 'America/New_York');
  const wd = ny.weekday; const m = ny.minuteOfDay;
  const base = { calendarVerified: false, note: 'CME-feestdagen en verkorte dagen niet geladen' };
  if (wd === 6) return { ...base, open: false, reason: 'WEEKEND', text: 'Beurs gesloten (weekend)' };
  if (wd === 5 && m >= 17 * 60) return { ...base, open: false, reason: 'WEEKEND', text: 'Beurs gesloten (weekend)' };
  if (wd === 0 && m < 18 * 60) return { ...base, open: false, reason: 'WEEKEND', text: 'Beurs gesloten (weekend)' };
  if (m >= 17 * 60 && m < 18 * 60) return { ...base, open: false, reason: 'MAINTENANCE', text: 'Dagelijkse onderhoudspauze CME' };
  return { ...base, open: true, reason: 'OPEN', text: 'Beurs open' };
}

/** Amerikaanse aandelen reguliere sessie 09:30–16:00 ET, ma–vr (feestdagen niet geladen). */
export function usEquityStatus(ms) {
  const ny = zoned(ms, 'America/New_York');
  const base = { calendarVerified: false, note: 'NYSE-feestdagen niet geladen' };
  if (ny.weekday === 0 || ny.weekday === 6) return { ...base, open: false, reason: 'WEEKEND', text: 'Beurs gesloten (weekend)' };
  if (ny.minuteOfDay < 9 * 60 + 30 || ny.minuteOfDay >= 16 * 60) return { ...base, open: false, reason: 'CLOSED_HOURS', text: 'Buiten reguliere beursuren' };
  return { ...base, open: true, reason: 'OPEN', text: 'Reguliere sessie open' };
}

export function marketStatus(inst, ms, cfg = {}) {
  switch (inst.sessionProfile) {
    case 'FX': return fxMarketStatus(ms, cfg.fxHolidays || DEFAULT_FX_HOLIDAYS);
    case 'CME_EQUITY': return cmeEquityStatus(ms);
    case 'US_EQUITY': return usEquityStatus(ms);
    default: return { open: false, reason: 'UNKNOWN', text: 'Onbekend sessieprofiel' };
  }
}

/**
 * Verwacht de candle die op tOpen begint een gesloten-markt-interval te zijn?
 * Gebruikt om gaten te onderscheiden van weekends.
 */
export function candleExpected(inst, tOpen, tf, cfg = {}) {
  const st = marketStatus(inst, tOpen, cfg);
  if (st.open) return true;
  // candle die tijdens de opening start telt als verwacht
  const st2 = marketStatus(inst, tOpen + TF_MS[tf] - 1, cfg);
  return st2.open;
}

/** Forex-handelsdag: rolt om 17:00 New York (gangbare FX-conventie). */
export function fxTradingDayKey(ms) {
  // verschuif zodat 17:00 NY de daggrens wordt
  return zoned(ms + 7 * 3_600_000, 'America/New_York').dateKey;
}

/** Venstergrenzen (UTC) voor een lokale datum. */
export function windowBounds(win, year, month, day) {
  const s = parseHHMM(win.start); const e = parseHHMM(win.end);
  const start = localToUtc(year, month, day, Math.floor(s / 60), s % 60, win.tz);
  let end = localToUtc(year, month, day, Math.floor(e / 60), e % 60, win.tz);
  if (end <= start) end += 86_400_000;
  return { start, end };
}

/** Alle vensterintervallen die [from, to] overlappen — voor grafiekmarkering. */
export function windowIntervals(win, from, to) {
  const out = [];
  for (let t = from - 86_400_000; t <= to + 86_400_000; t += 86_400_000) {
    const z = zoned(t, win.tz);
    const b = windowBounds(win, z.year, z.month, z.day);
    if (b.end > from && b.start < to && !out.some(o => o.start === b.start)) out.push(b);
  }
  return out.sort((a, b) => a.start - b.start);
}

export function activeSessions(ms, sessions = DEFAULT_SESSIONS) {
  return Object.entries(sessions).filter(([, w]) => inWindow(ms, w)).map(([k]) => k);
}
