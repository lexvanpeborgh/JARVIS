# ForexNexus Alpha op Fly.io zetten (zonder computer)

Alles gebeurt via GitHub Actions; je hoeft niets te installeren. Controleer eerst de
actuele prijzen op fly.io/docs/about/pricing (een creditcard is vereist; de app draait
24/7 op één kleine machine met een volume van 1 GB).

1. **Fly-account**: maak een account op fly.io en voeg een betaalmethode toe.
2. **Token**: in het Fly-dashboard → *Tokens* → maak een token voor je organisatie
   (personal). Kopieer het.
3. **GitHub-instellingen** van de repository → *Settings → Secrets and variables → Actions*:
   - Secret `FLY_API_TOKEN` = het Fly-token
   - Secret `FNX_ACCESS_PASSWORD` = het wachtwoord waarmee je straks inlogt
   - Variable `FLY_APP_NAME` = een unieke naam, bijv. `forexnexus-alpha-lex`
4. **Workflow beschikbaar maken**: de workflow moet op de standaardbranch staan —
   merge de pull request van branch `claude/optimistic-hamilton-hfzhc1` naar `main`.
5. **Eerste installatie**: GitHub → *Actions* → *ForexNexus → Fly.io* → *Run workflow* →
   vink **Eerste installatie** aan → *Run*. De workflow test, maakt app + volume +
   versleutelingssleutel aan en deployt.
6. **Openen**: `https://<FLY_APP_NAME>.fly.dev` — op iPhone in Safari → Delen →
   *Zet op beginscherm*. Vul in de app bij Verbindingen ook *Publieke app-URL* in.

Latere wijzigingen in `forexnexus/` op `main` worden automatisch opnieuw gedeployd.
De OANDA- en Telegram-tokens vul je in de app zelf in (versleuteld op het volume),
niet in GitHub.
