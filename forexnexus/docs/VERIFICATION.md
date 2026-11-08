# Verificatie: wat is werkelijk vastgesteld (8-11-2026)

## Uitgangssituatie (gecontroleerd bij de start)

- De bestaande app `forexnexus-alpha-lex.mmzr646k5b.chatgpt.site` was **niet bereikbaar** vanuit de bouwomgeving (proxy weigerde de host), en de broncode, database en deployment staan **niet** in deze repository. De repository bevat alleen JARVIS (Next.js/Vercel). De eerder gemelde toestand (engine bereikbaar, OANDA/Telegram niet geconfigureerd) kon daarom niet opnieuw worden gecontroleerd, en bestaande gegevens of privétoegang konden niet worden overgenomen.
- ForexNexus Alpha is daarom als zelfstandige service gebouwd in `forexnexus/`. JARVIS is niet aangeraakt.
- OANDA, Telegram, Dukascopy en de kalenderfeed waren eerst geblokkeerd. Na goedkeuring kwamen er een eigen omgeving en hosts bij. Dukascopy weigert geautomatiseerde downloads (429/reset); dat is niet omzeild. Het OANDA-token werd in deze sessie niet verstrekt.

## GEBOUWD

- De volledige service: providerlaag (OANDA v20 REST + stream, polling-fallback, DEMO, een expliciete NIET-GEKOPPELD-adapter voor futures), opslag (SQLite, migrations), indicatoren, sessies/DST, datakwaliteit, structuurmodule, drie versieerbare strategieën, één gedeelde `evaluate()`, risk engine, nieuwsfilter, signaalregister met lifecycle, Telegram-outbox, paper trading en dagboek, causale backtestengine met kostenscenario's, splits, bootstrap en gevoeligheid, replay, testmatrix, rapporten en exports, statusafleiding, lease, heartbeats, beveiliging, de PWA-interface (10 schermen) en de documentatie.

## TECHNISCH GETEST

`npm test`: **51/51 geslaagd** (`reports/test-results.txt`). Gedekt:

- Indicatorreferenties, warm-up, RSI-randgevallen (alleen winst, alleen verlies, vlak), ATR met vorige close.
- Pips/ticks (EUR/USD, USD/JPY, MES 1,25 USD/tick), pipwaarde zonder verzonnen conversie, tickafronding met herberekening, positiegrootte < 1 contract.
- Legacy RR 0,75/1,75, SELL-spiegeling, netto < bruto.
- Weekend, DST (VS/VK-verschilweek maart 2026), CME-onderhoud, MES-contractrol (MESZ6 → MESH7).
- Geen signaal op onvolledige candles, stale quote, late evaluatie, brede spread, blackout, ontbrekende/verouderde kalender, sessie, markt gesloten, duplicaat, cooldown, ontbrekend volume, gemiste entry, TTL.
- Structuurvariant wijst RR < 2,0 af; pivot pas bruikbaar na bevestiging.
- **Geen look-ahead:** beslissing op een afgekapte reeks = beslissing op de volledige reeks.
- Backtest: uitvoering op de volgende open, SL eerst bij ambigue candles, gap voorbij de stop, datagat → ONBEPAALD, ENTRY_MISSED, warm-up, splits.
- **Replay = backtest** (consistentiecontrole).
- Outbox: dedupe, 429/Retry-After, timeout → UNKNOWN zonder herhaling, herstart tijdens SENDING → UNKNOWN, verouderde entry → EXPIRED, geen token in foutmeldingen.
- Parallelle workers (lease), herhaalde candle, historische revisie.
- Secrets versleuteld, een leeg veld wist niets, geen secrets in API- of HTML-output.
- CSRF, auth, requestlimiet, strikte configvalidatie, CSP zonder `unsafe-inline` voor scripts.
- Worker-HMAC: geldig, verlopen, vervalst, gemanipuleerde body, replay.
- Gemiste heartbeat verandert de status; geen gemiste scans in het weekend.
- CSV met gaten → kwaliteitsrapport; dubbel bestand geweigerd.
- **End-to-end met gemockte OANDA/Telegram:** stream + candles → opslag → evaluatie → BUY → signaal → precies één Telegram-melding → zichtbaar in `/api/overview` en `/api/status`; een tweede scan maakt geen duplicaat.

Daarnaast:

- Schone productie-installatie (`npm ci --omit=dev`) start en serveert.
- In een headless browser zijn monitor, instrumentdetail, status, backtestlab, backtestrapport, replay, instellingen en macro bekeken op desktop (1440 px) en iPhone 14-emulatie, zonder JavaScript-fouten.

## MET ECHTE DATA GECONTROLEERD

- **Economische kalender:** de echte ForexFactory-weekfeed is opgehaald (116 events, dekking zo 1-11 – zo 8-11 ET). De status werd CALENDAR_OK en de echte USD-blackout van 6-11 verscheen op de grafiek.
- **OANDA:** **niet** gecontroleerd. Zonder token gaf de API HTTP 401 (bewijs dat de host bereikbaar is, niet dat de koppeling werkt). De mocktests zijn geen geslaagde brokerverbinding.
- **Telegram:** **niet** gecontroleerd met een echte bot (geen token).
- **MES/ES/SPY:** geen feed; terecht getoond als NIET GEKOPPELD.

## HISTORISCH GEËVALUEERD

- **Geen enkele strategie is met echte historische data geëvalueerd.** Alle runs in `reports/BACKTESTS.md` gebruiken synthetische softwarefixtures en zijn als zodanig gelabeld; het oordeel is overal ONVOLDOENDE BEWIJS.
- Inhoudelijke, data-onafhankelijke bevinding: de legacy-combinatie (RSI14 < 30 op dezelfde candle als een EMA9/21-kruising omhoog) vuurde **0 keer** in 3 × 37.416 synthetische M5-candles. De enige constructie die haar triggert, vereist een koersstap kleiner dan één tick. Verwacht op echte data dus vrijwel geen signalen.
- De structuurvariant gaf 127–160 kandidaten per paar, vrijwel allemaal geblokkeerd (vooral RR < 2,0, sessie en spread t.o.v. ATR).

## NOG NIET GEVERIFIEERD

- **Deployment en publieke URL:** er is geen hostingaccount beschikbaar, dus de app is niet online gezet. De Docker-image kon hier niet gebouwd worden (geen Docker-daemon).
- Zelfstandige cloudscans terwijl de browser dicht is: wel lokaal aangetoond (de engine draait server-side, schrijft heartbeats en plant op candlegrenzen), niet op een cloudhost.
- Echte OANDA-streamlatency en de quote-ouderdomsgrens van 5 s tegenover de werkelijke feed.
- De Gemini-uitleglaag (host niet toegestaan; alleen de validatielogica is getest).
- Fysieke iPhone en PWA-installatie (alleen emulatie).
- CME-feestdagen, verkorte dagen en de actuele MES/ES-contractspecificatie.
