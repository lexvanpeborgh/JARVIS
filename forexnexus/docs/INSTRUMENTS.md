# Instrumentmetadata en rekeneenheden

Bron: `src/core/instruments.js`. Pips, ticks, punten en geld worden apart behandeld.

| Instrument | Soort | Pip | Tick/precisie | Geldwaarde | Feed |
|---|---|---|---|---|---|
| EUR/USD | Forex spot (brokerquote) | 0,0001 | 0,00001 (5 dec.) | pipwaarde = 0,0001 USD per eenheid, omgerekend naar rekeningvaluta met actuele koers | OANDA v20 |
| GBP/USD | Forex spot | 0,0001 | 0,00001 | idem | OANDA v20 |
| USD/JPY | Forex spot | 0,01 | 0,001 (3 dec.) | 0,01 JPY per eenheid → conversie via USD/JPY | OANDA v20 |
| MES | Futures, CME Globex | — | 0,25 punt | 5 USD/punt → 1,25 USD/tick/contract (*contractanker volgens opdracht, controleer bij CME*) | **niet gekoppeld** |
| ES | Futures, CME Globex | — | 0,25 punt | 50 USD/punt (niet afgeleid van MES; controleer bij CME) | **niet gekoppeld** |
| SPY | ETF, NYSE Arca | — | 0,01 | 1 USD/punt per aandeel | **niet gekoppeld** |
| S&P 500 | Index | — | 0,01 | niet verhandelbaar; alleen context | **niet gekoppeld** |

- Zonder beschikbare conversiekoers retourneert de pipwaarde `null`. Er wordt niets verzonnen.
- Niveaus worden afgerond op geldige ticks (SL weg van de entry, targets richting de entry), waarna afstanden, risico en RR opnieuw worden berekend.
- Futurescontract: front month volgens expliciet rolbeleid (8 kalenderdagen vóór de derde vrijdag van maart/juni/sept/dec). Op 8-11-2026: **MESZ6**. Dit is een configureerbaar beleid en vervangt geen beurskalender.
- Een S&P 500-indexkoers of SPY-koers wordt nooit als MES-quote gebruikt.
- Margin is een zekerheidsstelling, geen maximaal verlies. Margevereisten zijn niet ingevuld.

## Waarom MES niet live is

Voor uitvoerbare MES-quotes is een feed met CME-marktdatarechten nodig, via een
futuresbroker of een gelicentieerde dataprovider. Daar horen beursovereenkomsten
en (non-)professional entitlements bij. Zo'n account is niet aanwezig. De
adapter (`src/data/providers/futures.js`) meldt dat expliciet, en de testmatrix
toont MES/ES/SPY als GEBLOKKEERD. Kosten en voorwaarden verschillen per provider
en zijn niet gecontroleerd, omdat de hosts in deze bouwomgeving niet bereikbaar
waren.
