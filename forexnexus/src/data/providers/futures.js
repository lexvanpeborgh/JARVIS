// Futures-adapter (MES/ES). Voor uitvoerbare MES-quotes is een feed met
// CME-beursrechten nodig (bijv. via een futuresbroker of een gelicentieerde
// marktdatadienst). Zo'n feed is niet gekoppeld. Deze adapter levert daarom
// expliciet NIET_GEKOPPELD en verzint geen koersen. Een S&P 500-indexkoers of
// SPY-koers wordt nooit als MES-quote doorgegeven.

export function createUnconfiguredFuturesProvider() {
  return {
    id: 'futures-none',
    kind: 'none',
    label: 'Geen futuresfeed gekoppeld',
    status() {
      return {
        configured: false,
        code: 'PROVIDER_NOT_CONFIGURED',
        text: 'MES/ES vereisen een futuresfeed met CME-marktdatarechten (non-professional of professional entitlement, afhankelijk van je status). Geen feed gekoppeld; er worden geen MES-koersen getoond.',
        needed: [
          'Een broker- of dataprovider-account met CME Globex-futuresdata (real-time of expliciet vertraagd).',
          'Ondertekende beursovereenkomsten voor marktdata (via de provider).',
          'Een API die concrete contracten (bijv. MESZ6) met bid/ask en beursvolume levert.',
        ],
      };
    },
    async fetchCandles() { throw new Error('PROVIDER_NOT_CONFIGURED'); },
  };
}
