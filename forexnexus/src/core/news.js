// Economische kalender en nieuwsrisico. Blackoutvensters zijn een gekozen
// risicobeleid, geen bewezen universeel optimum.

export const DEFAULT_NEWS_POLICY = Object.freeze({
  required: true, // zonder geldige kalender worden nieuwe entries geblokkeerd
  highImpact: { before: 15, after: 30 },
  rateDecision: { before: 30, after: 60 },
  includeMedium: false,
  maxCalendarAgeMin: 12 * 60,
});

const CATS = [
  ['RATE_DECISION', /(rate decision|interest rate|cash rate|policy rate|bank rate|refinancing rate|deposit facility|fomc statement|federal funds|monetary policy (statement|summary|report)|boj policy|official bank rate)/i],
  ['PRESS_CONFERENCE', /(press conference|fomc press|ecb press)/i],
  ['FOMC_OTHER', /(fomc|fed chair|powell)/i],
  ['CPI', /\b(cpi|consumer price|inflation)\b/i],
  ['NFP', /(non-?farm|nfp|employment change|unemployment|jobless|average hourly earnings|jolts|adp)/i],
  ['PCE', /\bpce\b|personal consumption/i],
  ['GDP', /\bgdp\b|gross domestic/i],
  ['ACTIVITY', /(pmi|ism|retail sales|industrial production|durable goods|ifo|zew|sentiment|confidence)/i],
  ['CENTRAL_BANK_SPEECH', /(speaks|speech|testimony|lagarde|bailey|ueda|governor)/i],
];

export function classify(title) {
  for (const [cat, re] of CATS) if (re.test(title || '')) return cat;
  return 'OTHER';
}

export const CATEGORY_LABEL = {
  RATE_DECISION: 'Rentebesluit', PRESS_CONFERENCE: 'Persconferentie', FOMC_OTHER: 'FOMC/Fed',
  CPI: 'Inflatie (CPI)', NFP: 'Arbeidsmarkt', PCE: 'PCE', GDP: 'BBP', ACTIVITY: 'Activiteitscijfer',
  CENTRAL_BANK_SPEECH: 'Centrale bank (toespraak)', OTHER: 'Overig',
};

// Officiële primaire bronnen voor feitelijke besluiten en cijfers.
export const OFFICIAL_SOURCES = {
  USD: [
    { name: 'Federal Reserve — FOMC-kalender', url: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm' },
    { name: 'BLS — publicatieschema (CPI, werkgelegenheid)', url: 'https://www.bls.gov/schedule/news_release/' },
    { name: 'BEA — publicatieschema (GDP, PCE)', url: 'https://www.bea.gov/news/schedule' },
  ],
  EUR: [{ name: 'ECB — vergaderkalender', url: 'https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html' }],
  GBP: [{ name: 'Bank of England — MPC-data', url: 'https://www.bankofengland.co.uk/monetary-policy/upcoming-mpc-dates' }],
  JPY: [{ name: 'Bank of Japan — MPM-schema', url: 'https://www.boj.or.jp/en/mopo/mpmsche_minu/index.htm' }],
};

export function currenciesFor(inst) {
  if (inst.base && inst.quote) return [inst.base, inst.quote];
  return [inst.currency || 'USD'];
}

export function blackoutFor(ev, policy = DEFAULT_NEWS_POLICY) {
  const cat = ev.category || classify(ev.title);
  const heavy = ['RATE_DECISION', 'PRESS_CONFERENCE', 'FOMC_OTHER'].includes(cat) && (ev.impact === 'High' || cat !== 'FOMC_OTHER');
  if (heavy && ev.impact !== 'Low') return { ...policy.rateDecision, rule: 'Rentebesluit/FOMC/persconferentie' };
  if (ev.impact === 'High') return { ...policy.highImpact, rule: 'High-impact publicatie' };
  if (ev.impact === 'Medium' && policy.includeMedium) return { ...policy.highImpact, rule: 'Medium-impact (ingeschakeld)' };
  return null;
}

/** Bouw blackoutintervallen voor de relevante valuta. */
export function blackouts(events, currencies, policy = DEFAULT_NEWS_POLICY) {
  const out = [];
  for (const ev of events || []) {
    if (!currencies.includes(ev.currency)) continue;
    if (ev.allDay || ev.time == null) continue;
    const w = blackoutFor(ev, policy);
    if (!w) continue;
    out.push({ start: ev.time - w.before * 60_000, end: ev.time + w.after * 60_000, event: ev, rule: w.rule, before: w.before, after: w.after });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Kalenderstatus voor een moment. Een ontbrekende, verouderde of niet-dekkende
 * kalender is NIET veilig.
 */
export function calendarStatus(cal, now, policy = DEFAULT_NEWS_POLICY) {
  if (!cal || !cal.coverage) return { ok: false, code: 'CALENDAR_MISSING', text: 'Economische kalender niet geladen.' };
  const age = (now - cal.fetchedAt) / 60_000;
  if (age > policy.maxCalendarAgeMin) return { ok: false, code: 'CALENDAR_STALE', text: `Kalender is ${Math.round(age / 60)} uur oud (max ${Math.round(policy.maxCalendarAgeMin / 60)} uur).` };
  const lookahead = Math.max(policy.highImpact.before, policy.rateDecision.before) * 60_000;
  if (now < cal.coverage.from || now + lookahead > cal.coverage.to) return { ok: false, code: 'CALENDAR_NOT_COVERING', text: 'Kalender dekt de huidige handelsperiode niet volledig.' };
  return { ok: true, code: 'CALENDAR_OK', text: 'Kalender actueel en dekkend.' };
}

export function newsCheck(inst, now, cal, policy = DEFAULT_NEWS_POLICY) {
  const status = calendarStatus(cal, now, policy);
  const cur = currenciesFor(inst);
  const bos = status.code === 'CALENDAR_MISSING' ? [] : blackouts(cal.events, cur, policy);
  const active = bos.find(b => now >= b.start && now < b.end) || null;
  const next = (cal?.events || [])
    .filter(e => cur.includes(e.currency) && e.time != null && e.time > now && ['High', 'Medium'].includes(e.impact))
    .sort((a, b) => a.time - b.time)[0] || null;
  return { status, active, next, minutesToNext: next ? Math.round((next.time - now) / 60_000) : null, currencies: cur };
}

/** Conditionele interpretatie — geen automatische richtingsclaim. */
export function interpretation(ev) {
  const cat = ev.category || classify(ev.title);
  const ccy = ev.currency;
  const base = {
    CPI: `Een hogere inflatie-uitkomst dan verwacht kan renteverwachtingen voor ${ccy} verhogen en de valuta ondersteunen; de reactie hangt ook af van wat al was ingeprijsd.`,
    NFP: `Sterkere arbeidsmarktcijfers dan verwacht kunnen ${ccy} ondersteunen via renteverwachtingen; revisies van eerdere maanden kunnen het beeld veranderen.`,
    RATE_DECISION: `Het besluit zelf is vaak verwacht; de toon en vooruitblik kunnen voor ${ccy} zwaarder wegen dan het rentecijfer.`,
    PRESS_CONFERENCE: 'Uitspraken tijdens de persconferentie kunnen de eerste reactie op het besluit versterken of omkeren.',
    PCE: `PCE is een inflatiemaatstaf; een afwijking van de verwachting kan renteverwachtingen voor ${ccy} beïnvloeden.`,
    GDP: 'Een afwijking van de verwachting kan groei- en renteverwachtingen bijstellen; revisies zijn gebruikelijk.',
  }[cat];
  return base || 'Geen standaardinterpretatie; beoordeel de werkelijke koersreactie.';
}
