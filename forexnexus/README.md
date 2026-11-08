# ForexNexus Alpha

Privéplatform voor realtime marktanalyse, verklaarbare BUY/SELL/WAIT/NO-TRADE-signalen,
risicoplannen, paper trading en causale backtests. **Plaatst nooit orders.**

> Status bij oplevering: de app is gebouwd en technisch getest, maar **nog niet online
> gezet** en **nog niet met echte marktdata gecontroleerd**. Zie
> [docs/VERIFICATION.md](docs/VERIFICATION.md) voor wat wel en niet is geverifieerd.

## Wat je ziet

- **Marktmonitor:** per paar de bid/ask, de actualiteit (LIVE · LIVE ongewijzigd · STALE · VERBROKEN · MARKT GESLOTEN) en de toestand per strategie. MES, ES, SPY en de S&P 500-index staan apart als **NIET GEKOPPELD**, met de reden.
- **Instrumentdetail:** de grafiek (M1–H4, standaard M5) met EMA 9/21, optioneel RSI14, volume, sessies, vorige dag H/L, de Aziatische range, structuurmarkeringen en nieuwsblackouts. Daarnaast:
  - **Signaal:** BUY = longentry, SELL = shortentry, WAIT, NO TRADE, of GEEN SETUP.
  - **Risicoplan:** entry, SL, TP1 en TP2 met afstand in pips of ticks, bruto/netto RR, geldigheid (aftellend) en de invalidatieregel. Rode en groene vakken op de grafiek.
  - **Waarom deze setup?:** elke regel met de berekende waarde, de regelmatchscore (geen winstkans), spread, quote-ouderdom en het volgende nieuwsbericht.
  - **Waarom nog geen entry?:** blokkades met reason code, tegenargumenten en annuleringsregels.
  - **Wat is er getest?:** de status uit de testmatrix.
- **Signalen:** register met lifecycle (EXPIRED, CANCELLED, ENTRY GEMIST, EXIT LONG/SHORT), Telegram-afleveringen, handmatige scenario's (de originele niveaus blijven ongewijzigd) en "Ik neem deze entry (paper)".
- **Macro & nieuws:** de kalender met blackoutvensters, conditionele interpretatie, bronlinks en de dekking.
- **Backtestlab:** CSV/Parquet/OANDA-import met kwaliteitsrapport, backtests met kostenscenario's, splits en gevoeligheid, HTML/CSV/JSON-export, en de testmatrix.
- **Replay:** candle voor candle, met verborgen toekomst, dezelfde beslisfunctie en een consistentiecontrole met de backtest.
- **Paper & dagboek:** posities, geaccepteerde en afgewezen entryverzoeken, notities met screenshot.
- **Engine & data:** status afgeleid uit opgeslagen heartbeats, het volgende scantijdstip, gemiste scans, latency en datakwaliteit.

## Windows-app

`ForexNexus-Alpha-Setup.exe` installeert per gebruiker, zonder beheerdersrechten, in `%LOCALAPPDATA%\Programs\ForexNexus`. Je krijgt snelkoppelingen op het bureaublad en in het Startmenu, optioneel automatisch starten, en verwijderen via Instellingen → Apps. De app draait alleen op 127.0.0.1. Op je eigen pc is geen wachtwoord nodig (lokale modus: alleen loopback, Host-controle tegen DNS-rebinding). Gegevens staan in `%LOCALAPPDATA%\ForexNexus`. Bouwen: `makensis -DSTAGE=<map> windows/installer.nsi` (zie `windows/`).

## Eerste installatie (gebruiker)

1. Open de app-URL en meld je aan met het wachtwoord.
2. De kaart **Eerste installatie** toont wat gekoppeld is. Zonder koppeling staat er **DEMO**: synthetische voorbeelddata, en er gaan geen live meldingen uit.
3. Ga naar **Verbindingen**. Kies OANDA, de practice- of live-dataomgeving en je account-ID. Plak je OANDA-token in het beveiligde veld (versleuteld opgeslagen; een leeg veld wist niets). Klik op **Verbinding testen**. Die test doet alleen leesrequests en plaatst geen order.
4. Zodra de stream draait, zie je echte koersen met bron en tijdstempels.
5. Telegram: maak een bot via @BotFather, plak het token, vul je chat-ID in, klik op **Bot & chat controleren** en daarna op **TEST-melding**.
6. Backtestlab: haal historie op via OANDA of importeer een CSV, en start een backtest.
7. iPhone: open de URL in Safari → Delen → **Zet op beginscherm**.

## Installatie en deploy (beheerder)

Vereist: Node ≥ 22.13 (gebruikt het ingebouwde `node:sqlite`) en een **langlopend
proces met persistent volume**. Serverless platforms zoals Vercel-functies zijn
ongeschikt: de koersstream en de M5-scheduler moeten blijven draaien als de browser
dicht is.

```bash
cd forexnexus
npm ci
FNX_ACCESS_PASSWORD='lang-wachtwoord' FNX_MASTER_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")" npm start
# http://localhost:8080
npm test                 # 56 tests
npm run backtest         # rapporten in reports/
```

Container: `Dockerfile` (volume `/data`). **Fly.io:** `fly.toml` + workflow `.github/workflows/forexnexus-fly.yml`; stappenplan in [docs/DEPLOY-FLY.md](docs/DEPLOY-FLY.md).
Optionele externe watchdog: `deploy/github-watchdog.yml.example`. Runtime secrets: zie
`.env.example`. Achter een uitgaande proxy zet je `NODE_USE_ENV_PROXY=1`.
Controleer actuele hostingprijzen voordat je een abonnement activeert.

## Architectuur in het kort

Eén Node-proces (`src/server/main.js`):

- `src/core/` — de enige strategie-implementatie: indicatoren, sessies, structuur, risk engine, nieuwsfilter en `evaluate()`. Gebruikt door live analyse, replay en backtest.
- `src/engine/` — QuoteHub, OANDA-stream met reconnect, back-off met jitter en polling-fallback, een M5-scheduler op candlegrenzen (zonder drift), lease tegen dubbele workers, heartbeats en paperbewaking.
- `src/notify/telegram.js` — duurzame outbox (PENDING, SENDING, SENT, RETRY_SCHEDULED, EXPIRED, CANCELLED, FAILED, UNKNOWN).
- `src/backtest/` — causale event-driven engine in een worker thread.
- `src/server/` — HTTP, SSE, sessies (HttpOnly/SameSite=Strict), CSRF, CSP met importmap-hash, versleutelde secrets (AES-256-GCM) en HMAC-workerauth met replaybescherming.
- `public/` — PWA (Preact + htm, zonder buildstap) en TradingView Lightweight Charts 5.2.1 (Apache-2.0, attributielogo zichtbaar).
- `migrations/001_init.sql` — databaseschema.

Documentatie: [strategieën](docs/STRATEGIES.md) · [instrumenten](docs/INSTRUMENTS.md) ·
[verificatie](docs/VERIFICATION.md) · [backtests](reports/BACKTESTS.md).
