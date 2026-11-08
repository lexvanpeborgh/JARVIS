# Strategiedefinities (versie-beheerd)

Een regelwijziging is altijd een **nieuwe versie** met een eigen backtest. De
code staat in `src/core/strategies/index.js`; live analyse, replay en backtest
roepen allemaal dezelfde `evaluate()` aan (`src/core/evaluate.js`).

## Gemeenschappelijke poorten (alle strategieën)

| Code | Regel (standaard, instelbaar) |
|---|---|
| `MARKET_CLOSED` | Forex: zo 17:00 – vr 17:00 New York, excl. 25-12 en 01-01 |
| `INSUFFICIENT_HISTORY` / `INDICATORS_INVALID` | Minimaal `minHistory` gesloten candles en geldige indicatoren |
| `CANDLE_INCOMPLETE` | Alleen gesloten candles tellen |
| `DATA_GAP` | Geen ontbrekende candles in de laatste 50 candles tijdens marktopening |
| `QUOTE_MISSING` / `QUOTE_STALE` | Quote bevestigd door de provider ≤ 5 s geleden (live) |
| `EVALUATION_LATE` | Evaluatie ≤ 45 s na de M5-close (live) |
| `SPREAD_TOO_WIDE_ABS` | EUR/USD 1,5 · GBP/USD 2,0 · USD/JPY 1,5 pips |
| `SPREAD_TOO_WIDE_ATR` | spread ≤ 0,25 × ATR14 |
| `SESSION_NOT_ALLOWED` | Openingstijd signaalcandle in Londen 08:00–12:00 (Europe/London) of New York 08:00–11:00 (America/New_York) |
| `NEWS_BLACKOUT` | High-impact −15/+30 min; rentebesluit/FOMC/persconferentie −30/+60 min |
| `CALENDAR_MISSING/STALE/NOT_COVERING` | Kalender verplicht; > 12 u oud of niet dekkend = blokkade |
| `COOLDOWN` / `DUPLICATE_SIGNAL` | 6 candles cooldown; unieke sleutel strategie@versie·instrument·tf·candle·richting |
| `ENTRY_MISSED` / `TTL_EXPIRED` | Entry ≤ 60 s geldig; uitvoerbare prijs ≤ 0,25 × ATR voorbij de entryreferentie |

Het blackoutbeleid en de sessievensters zijn **gekozen risicobeleid en
onderzoeksvensters**, geen bewezen optimum.

## LEGACY_EMA_RSI_VOL v1.0.0 — baseline

- **Hypothese:** een EMA9/21-kruising op dezelfde gesloten candle waarop RSI14 extreem is en het (tick)volume stijgt, markeert een kortetermijnomslag.
- **Instrumenten/tijdframe:** EUR/USD, GBP/USD, USD/JPY · M5.
- **BUY:** RSI14 < 30 · EMA9 ≤ EMA21 op de vorige gesloten candle · EMA9 > EMA21 op de signaalcandle · volume > vorige candle. Alle voorwaarden op **dezelfde** candle.
- **SELL:** gespiegeld (RSI14 > 70, EMA9 ≥ → <).
- **Entry:** actuele ask (BUY) / bid (SELL).
- **Niveaus:** SL = entry ∓ 2 × ATR14 · TP1 = entry ± 1,5 × ATR14 · TP2 = entry ± 3,5 × ATR14.
- **Exit:** volledige exit op SL of TP2. TP1 is een observatieniveau (geen deeluitstap).
- **RR:** nominaal bruto **0,75 (TP1) en 1,75 (TP2)** vóór kosten en tickafronding. Er is geen 1:2-minimum op deze variant.
- **Volume:** OANDA-volume = aantal prijsupdates (tickvolume). Ontbreekt volume, dan `VOLUME_UNAVAILABLE`.
- **Geen MSS:** er wordt geen structurele doorbraak vastgesteld.

### Bevinding: de baseline is praktisch onbereikbaar

Een EMA9-kruising omhoog vereist dat de prijs recent boven het gemiddelde
stijgt. Die winsten tillen RSI14 vrijwel altijd boven 30. Op 17.868
synthetische M5-candles: 268 EMA-kruisingen omhoog, 1.984 candles met RSI<30,
**0** keer beide op dezelfde candle (28 keer RSI<30 binnen de 10 candles
ervóór). De testfixture die de regel wél triggert, heeft een koersstap van
~0,0000003 nodig, minder dan één tick (`test/fixtures.js`). De RSI-voorwaarde
wordt **niet** stilzwijgend naar eerdere candles verschoven. Dat zou een nieuwe
strategieversie zijn met een eigen test.

## LEGACY_EMA_RSI_VOL_ATR4 v1.0.0

Identiek aan de baseline, maar TP2 = 4 × ATR14 (nominale bruto RR TP2 = 2,00).
Afzonderlijke versie en backtest.

## STRUCT_SWEEP_MSS v1.0.0 — structuurvariant

- **Hypothese:** na een sweep van een vooraf bekend niveau en een structurele breuk in tegenrichting beweegt de prijs naar het eerstvolgende tegengestelde liquiditeitsniveau.
- **Niveaus (afgeleid, geen zicht op echte orders):** vorige FX-handelsdag high/low (rol 17:00 New York, bekend vanaf de eerste candle van de nieuwe dag); Aziatische range 00:00–06:00 UTC (onderzoeksdefinitie; bekend na 06:00).
- **Pivot:** high strikt hoger dan 2 candles links en 2 rechts; bruikbaar vanaf `index + 2`.
- **Sweep:** high > niveau en close < niveau (bearish), of gespiegeld.
- **MSS:** binnen 12 candles na de sweep een close voorbij de laatst bevestigde swing van vóór de sweep, in tegenrichting.
- **Displacement:** body van de breukcandle ≥ 0,8 × ATR14.
- **Geldigheid:** sinds de sweep geen close terug voorbij het gesweepte niveau.
- **Entry:** actuele bid/ask; uitvoering op de volgende open (backtest).
- **SL:** voorbij het extreem sinds de sweep + 0,1 × ATR14. Nooit dichterbij gezet om RR te halen.
- **Target:** het **eerste** vooraf bekende tegengestelde niveau (vorige dag H/L, Aziatische H/L of bevestigde swing van de laatste 288 candles). TP2 = volgend niveau, alleen ter observatie.
- **RR-eis:** bruto RR(TP1) ≥ 2,0, anders `RR_BELOW_MIN` (of `NO_TARGET`).
- **Exit:** volledig op SL of TP1.

## Vooraf vastgelegde evaluatie

- Chronologisch 60% train / 20% validatie / 20% test; in v1 geen parameteroptimalisatie (purging/embargo daarom niet nodig; trades worden op signaaltijd toegewezen en grensoverschrijdingen gemarkeerd).
- **ONVOLDOENDE BEWIJS:** < 30 testtrades of < 100 trades totaal.
- **Standaard alleen als:** test-expectancy na baselinekosten > 0 R, ondergrens 90%-blokbootstrap > 0 R, ≥ 30 testtrades, en geen jaar > 50% van de netto R.
- Parametergevoeligheid wordt gerapporteerd, maar **niet** gebruikt voor selectie.
