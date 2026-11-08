// Reason codes met begrijpelijke Nederlandse tekst. Iedere blokkade wordt
// als code + tekst opgeslagen.

export const REASONS = Object.freeze({
  MARKET_CLOSED: 'Markt gesloten',
  INSUFFICIENT_HISTORY: 'Onvoldoende historie voor geldige indicatoren',
  CANDLE_INCOMPLETE: 'Laatste candle is nog niet afgesloten',
  CANDLE_NOT_AVAILABLE: 'Verwachte gesloten candle niet ontvangen',
  INDICATORS_INVALID: 'Indicatoren niet geldig',
  DATA_GAP: 'Ontbrekende candles in de vereiste historie',
  QUOTE_MISSING: 'Geen actuele quote',
  QUOTE_STALE: 'Quote te oud',
  EVALUATION_LATE: 'Candle te laat geëvalueerd',
  SPREAD_TOO_WIDE_ABS: 'Spread boven absolute grens',
  SPREAD_TOO_WIDE_ATR: 'Spread te groot ten opzichte van ATR',
  SESSION_NOT_ALLOWED: 'Buiten toegestane sessie',
  NEWS_BLACKOUT: 'Nieuwsblackout actief',
  CALENDAR_MISSING: 'Economische kalender ontbreekt',
  CALENDAR_STALE: 'Economische kalender verouderd',
  CALENDAR_NOT_COVERING: 'Kalender dekt periode niet',
  COOLDOWN: 'Cooldown na vorig signaal',
  DUPLICATE_SIGNAL: 'Signaal voor deze candle bestaat al',
  ENTRY_MISSED: 'Entry gemist: koers te ver doorgelopen',
  TTL_EXPIRED: 'Entryvenster verlopen',
  PROVIDER_MISMATCH: 'Andere provider dan de signaalhistorie',
  CONTRACT_MISMATCH: 'Verkeerd of verlopen futurescontract',
  VOLUME_UNAVAILABLE: 'Strategie vereist volume; feed levert geen volume',
  RR_BELOW_MIN: 'Risk/reward onder de ingestelde minimumgrens',
  NO_TARGET: 'Geen vooraf bekend target beschikbaar',
  SYNTHETIC_DATA: 'Synthetische demodata — geen live entry',
  REPLAY_MODE: 'Historische replay — geen live entry',
  INVALID_LEVELS: 'Ongeldige niveaus na afronding',
  PROVIDER_NOT_CONFIGURED: 'Marktdata-provider niet gekoppeld',
  FEED_DISCONNECTED: 'Koersfeed verbroken',
});

export function reason(code, detail = '') {
  return { code, text: REASONS[code] || code, detail };
}
